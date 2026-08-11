/**
 * licenses.js
 * ---------------------------------------------------------------------------
 * Reglas de negocio compartidas sobre licencias/clientes/dispositivos:
 * calcular el estado real de una licencia, buscarlas, y serializarlas para
 * el panel admin o para el cliente/extensión (con distinto nivel de detalle
 * expuesto en cada caso).
 * ---------------------------------------------------------------------------
 */

import { PLAN_DEFAULTS } from './db.js';

/** @returns {'active'|'suspended'|'expired'} el estado REAL de una licencia (no el que quedó guardado, si venció). */
export function computeStatus(license) {
  if (!license) return 'expired';
  if (license.status === 'suspended') return 'suspended';
  if (license.expiresAt && Date.now() > license.expiresAt) return 'expired';
  return 'active';
}

export function isUsable(license) {
  return computeStatus(license) === 'active';
}

export function findLicenseByKey(db, key) {
  const normalized = String(key || '').trim().toUpperCase();
  return db.licenses.find((l) => l.key.toUpperCase() === normalized) || null;
}

export function findCustomer(db, id) {
  return db.customers.find((c) => c.id === id) || null;
}

/** Búsqueda de cliente por correo, insensible a mayúsculas/minúsculas. */
export function findCustomerByEmail(db, email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return null;
  return db.customers.find((c) => String(c.email || '').toLowerCase() === normalized) || null;
}

/**
 * La licencia "principal" de un cliente: prefiere una activa (según
 * computeStatus, no solo el campo `status` guardado); si no hay ninguna
 * activa, cae a la más reciente por `createdAt`. Un cliente con varias
 * licencias históricas (ej. renovó comprando una nueva en vez de extender la
 * vieja) siempre resuelve a "la que importa ahora mismo".
 */
export function primaryLicenseForCustomer(db, customerId) {
  const licenses = db.licenses.filter((l) => l.customerId === customerId);
  if (licenses.length === 0) return null;
  const active = licenses.filter((l) => computeStatus(l) === 'active').sort((a, b) => b.createdAt - a.createdAt);
  if (active.length > 0) return active[0];
  return licenses.slice().sort((a, b) => b.createdAt - a.createdAt)[0];
}

export function devicesForLicense(db, licenseId) {
  return db.devices.filter((d) => d.licenseId === licenseId);
}

export function planLabel(planId) {
  return PLAN_DEFAULTS[planId]?.label || planId;
}

export function maxActivationsFor(planId) {
  return PLAN_DEFAULTS[planId]?.maxActivations ?? 1;
}

/** Serialización completa para el panel de administrador (incluye datos del cliente y conteo de dispositivos). */
export function serializeForAdmin(db, license) {
  const customer = findCustomer(db, license.customerId);
  const devices = devicesForLicense(db, license.id);
  return {
    id: license.id,
    key: license.key,
    status: computeStatus(license),
    rawStatus: license.status,
    planId: license.planId,
    planLabel: planLabel(license.planId),
    createdAt: license.createdAt,
    expiresAt: license.expiresAt,
    notes: license.notes || '',
    devicesCount: devices.length,
    maxActivations: maxActivationsFor(license.planId),
    customer: customer ? { id: customer.id, name: customer.name, email: customer.email, hasPassword: Boolean(customer.passwordHash) } : null,
  };
}

/** Serialización reducida para el cliente/extensión: solo lo necesario para decidir si puede operar. */
export function serializeForClient(db, license) {
  return {
    key: license.key,
    status: computeStatus(license),
    planId: license.planId,
    planLabel: planLabel(license.planId),
    expiresAt: license.expiresAt,
  };
}

/**
 * Crea o extiende la licencia de un cliente tras un pago confirmado. Si el
 * cliente ya tiene una licencia utilizable del mismo plan, extiende su
 * `expiresAt` a partir de max(ahora, expiresAt actual) — así pagar antes de
 * que venza "acumula" días en vez de perderlos. Si no tiene ninguna licencia
 * utilizable (nueva cuenta, o la anterior venció/fue de otro plan), crea una
 * licencia nueva.
 *
 * Debe llamarse SIEMPRE dentro de withDb() (server.js lo hace así) para que
 * la lectura-modificación-escritura sea atómica respecto a otras peticiones.
 *
 * @param {object} db
 * @param {{customerId: string, planId: string, periodDays: number, key?: string}} params
 * @returns {object} la licencia creada o extendida
 */
export function extendOrCreateLicenseForPayment(db, { customerId, planId, periodDays, generateKey }) {
  const existing = db.licenses
    .filter((l) => l.customerId === customerId && l.planId === planId && computeStatus(l) === 'active')
    .sort((a, b) => b.createdAt - a.createdAt)[0];

  const periodMs = periodDays * 24 * 60 * 60 * 1000;

  if (existing) {
    const base = existing.expiresAt && existing.expiresAt > Date.now() ? existing.expiresAt : Date.now();
    existing.expiresAt = base + periodMs;
    existing.status = 'active'; // un pago nuevo reactiva una licencia que el admin hubiera suspendido
    return existing;
  }

  const license = {
    id: `lic_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    key: generateKey(),
    customerId,
    planId,
    status: 'active',
    createdAt: Date.now(),
    expiresAt: Date.now() + periodMs,
    notes: 'Creada automáticamente por pago confirmado (Mercado Pago).',
  };
  db.licenses.push(license);
  return license;
}
