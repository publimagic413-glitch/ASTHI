/**
 * server.js
 * ---------------------------------------------------------------------------
 * Servidor único de WaMaster Asthi Web: sirve la landing page, el checkout
 * de compra, el panel de administrador, el panel de cliente y la API de
 * licencias/pagos. Escrito solo con módulos nativos de Node (http, fs,
 * crypto) — sin Express, sin dependencias de npm — para que `node server.js`
 * funcione en cualquier máquina con Node 18+ sin paso de instalación.
 *
 * Rutas:
 *   Auth de la extensión (CORS habilitado, correo+contraseña):
 *     POST /v1/auth/login       { email, password, installationId, deviceName } -> { token, expiresAt, license }
 *     POST /v1/auth/logout      Authorization: Bearer <token>, { installationId? }
 *     POST /v1/licenses/session Authorization: Bearer <token>, { installationId? } -> revalida y refresca la sesión
 *   Legado (CORS habilitado, compatibilidad con builds de la extensión
 *   anteriores a v1.4.0 que activaban por clave):
 *     POST /v1/licenses/activate | /v1/licenses/validate | /v1/licenses/deactivate
 *   Pagos (Mercado Pago, Checkout Pro — pago único por período, sin cobro recurrente):
 *     GET  /api/plans                     Planes comprables y sus precios (público)
 *     POST /api/payments/checkout         Crea una preferencia de pago y devuelve la URL de checkout
 *     POST /api/payments/webhook          Mercado Pago notifica aquí; el servidor reconfirma contra su API
 *     GET  /api/payments/status/:id       El checkout hace polling aquí tras el pago
 *     GET  /api/admin/payments            Historial de pagos (requiere sesión admin)
 *   Panel de cliente (público, solo necesita la clave de licencia):
 *     POST /api/client/lookup
 *   Panel de administrador (requiere sesión, ver lib/auth.js):
 *     POST /api/admin/login | /api/admin/logout
 *     GET  /api/admin/me | /api/admin/plans | /api/admin/licenses | /api/admin/licenses/export.csv
 *     POST /api/admin/licenses
 *     PATCH  /api/admin/licenses/:id
 *     DELETE /api/admin/licenses/:id
 *     POST /api/admin/customers/:id/reset-password
 *   Estáticos: / (landing), /comprar, /admin, /cliente, /descargar
 *
 * IMPORTANTE (arquitectura de seguridad): la extensión NUNCA accede a
 * data/db.json ni a ningún motor de base de datos directamente. Toda
 * validación de licencia pasa por estas rutas HTTP; el frontend de la
 * extensión solo conserva un token de sesión de corta vida (ver
 * licensing.js), nunca la contraseña del cliente ni ningún secreto capaz de
 * "fabricar" una licencia válida por su cuenta.
 * ---------------------------------------------------------------------------
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

import { load, withDb, newId, seedIfEmpty, PLAN_DEFAULTS, CURRENCY } from './lib/db.js';
import {
  hashPassword,
  verifyPassword,
  generateTemporaryPassword,
  createSession,
  getSession,
  touchSession,
  destroySession,
  parseCookie,
  parseBearerToken,
  checkLoginRateLimit,
  registerFailedLogin,
  clearLoginAttempts,
} from './lib/auth.js';
import { generateLicenseKey } from './lib/licenseKey.js';
import { readJsonBody, sendJson, sendText, serveStatic, toCsv, matchRoute } from './lib/http.js';
import {
  computeStatus,
  findLicenseByKey,
  findCustomer,
  findCustomerByEmail,
  primaryLicenseForCustomer,
  devicesForLicense,
  planLabel,
  maxActivationsFor,
  serializeForAdmin,
  serializeForClient,
  extendOrCreateLicenseForPayment,
} from './lib/licenses.js';
import { createPreference, getPayment } from './lib/mercadopago.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
// Render y Railway inyectan PORT por variable de entorno; en local cae a 4000.
const PORT = Number(process.env.PORT) || 4000;
// URL pública donde vive este servidor (sin slash final). Necesaria para
// construir las back_urls y el notification_url que se le pasan a Mercado
// Pago — ESAS URLs tienen que ser alcanzables desde internet, no
// "localhost". En producción (Render/Railway) defínela con tu dominio real;
// en desarrollo local, Mercado Pago no podrá llamar a tu webhook a menos que
// uses un túnel (ngrok, etc.) — ver docs/PAGOS.md.
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const SESSION_COOKIE = 'wamaster_session';
/** TTL de la sesión de cliente/extensión: mucho más larga que la de admin (12h) a propósito — ver auth.js. */
const CUSTOMER_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 días, con sliding expiration

// ---------------------------------------------------------------------------
// Helpers de sesión de admin (cookie httpOnly)
// ---------------------------------------------------------------------------
function getRequestSession(req) {
  const token = parseCookie(req.headers.cookie, SESSION_COOKIE);
  const session = getSession(token);
  return session ? { token, ...session } : null;
}

function requireAdmin(req, res) {
  const session = getRequestSession(req);
  if (!session || session.type !== 'admin') {
    sendJson(res, 401, { error: 'No autenticado. Inicia sesión de nuevo.' });
    return null;
  }
  return session;
}

// ---------------------------------------------------------------------------
// Helper de sesión de cliente/extensión (Authorization: Bearer <token>)
// ---------------------------------------------------------------------------
function requireCustomer(req, res) {
  const token = parseBearerToken(req.headers.authorization);
  const session = getSession(token);
  if (!session || session.type !== 'customer') {
    sendJson(res, 401, { valid: false, message: 'Sesión expirada o inválida. Inicia sesión de nuevo con tu correo y contraseña.' });
    return null;
  }
  return { token, ...session };
}

// ---------------------------------------------------------------------------
// Helper compartido: registra/renueva un dispositivo contra una licencia,
// respetando el máximo de activaciones del plan.
// @returns {{ok: true} | {ok: false, message: string}}
// ---------------------------------------------------------------------------
function activateDeviceForLicense(db, license, installationId, deviceName) {
  if (!installationId) return { ok: true };
  const devices = devicesForLicense(db, license.id);
  const existing = devices.find((d) => d.installationId === installationId);
  if (existing) {
    existing.lastSeenAt = Date.now();
    if (deviceName) existing.deviceName = deviceName;
    return { ok: true };
  }
  const max = maxActivationsFor(license.planId);
  if (devices.length >= max) {
    return {
      ok: false,
      message: `Esta licencia ya alcanzó el máximo de activaciones (${max}) para el plan ${planLabel(license.planId)}. Desactívala en otro dispositivo primero o contacta a soporte.`,
    };
  }
  db.devices.push({
    id: newId('dev'),
    licenseId: license.id,
    installationId,
    deviceName: deviceName || '',
    activatedAt: Date.now(),
    lastSeenAt: Date.now(),
  });
  return { ok: true };
}

function licenseStatusMessage(status) {
  return { suspended: 'Esta licencia está suspendida.', expired: 'Esta licencia venció.' }[status] || 'Licencia no utilizable.';
}

// ---------------------------------------------------------------------------
// Handlers: auth de la extensión por correo + contraseña
// ---------------------------------------------------------------------------
async function handleCustomerLogin(req, res) {
  const body = await readJsonBody(req);
  const { email, password, installationId, deviceName } = body;

  if (!email || !password) {
    return sendJson(res, 400, { valid: false, message: 'Ingresa tu correo y tu contraseña.' });
  }
  if (!installationId) {
    return sendJson(res, 400, { valid: false, message: 'Falta el identificador de instalación.' });
  }

  const { blocked, retryAfterMs } = checkLoginRateLimit(email);
  if (blocked) {
    const minutes = Math.ceil(retryAfterMs / 60000);
    return sendJson(res, 429, {
      valid: false,
      message: `Demasiados intentos fallidos. Vuelve a intentar en ${minutes} minuto${minutes === 1 ? '' : 's'}.`,
    });
  }

  const db = await load();
  const customer = findCustomerByEmail(db, email);
  const genericError = 'Correo o contraseña incorrectos.';

  if (!customer || !customer.passwordHash) {
    registerFailedLogin(email);
    return sendJson(res, 401, { valid: false, message: genericError });
  }
  if (!verifyPassword(password, customer.passwordSalt, customer.passwordHash)) {
    registerFailedLogin(email);
    return sendJson(res, 401, { valid: false, message: genericError });
  }

  clearLoginAttempts(email);

  const license = primaryLicenseForCustomer(db, customer.id);
  if (!license) {
    return sendJson(res, 200, { valid: false, message: 'Tu cuenta no tiene ninguna licencia asociada todavía. Compra un plan en /comprar o contacta a soporte.' });
  }

  const status = computeStatus(license);
  if (status !== 'active') {
    return sendJson(res, 200, { valid: false, message: licenseStatusMessage(status) });
  }

  const result = await withDb(async (freshDb) => {
    const freshLicense = findLicenseByKey(freshDb, license.key);
    return activateDeviceForLicense(freshDb, freshLicense, installationId, deviceName);
  });
  if (!result.ok) {
    return sendJson(res, 200, { valid: false, message: result.message });
  }

  const token = createSession(customer.id, 'customer', CUSTOMER_SESSION_TTL_MS);
  const session = getSession(token);

  return sendJson(res, 200, {
    valid: true,
    token,
    expiresAt: session.expiresAt,
    license: serializeForClient(db, license),
  });
}

async function handleCustomerSession(req, res) {
  const session = requireCustomer(req, res);
  if (!session) return;

  const body = await readJsonBody(req).catch(() => ({}));
  const { installationId, deviceName } = body;

  const db = await load();
  const customer = findCustomer(db, session.subjectId);
  if (!customer) {
    destroySession(session.token);
    return sendJson(res, 401, { valid: false, message: 'Tu cuenta ya no existe. Contacta a soporte.' });
  }

  const license = primaryLicenseForCustomer(db, customer.id);
  if (!license) {
    return sendJson(res, 200, { valid: false, message: 'Tu cuenta no tiene ninguna licencia asociada todavía. Contacta a soporte.' });
  }

  const status = computeStatus(license);
  if (status !== 'active') {
    return sendJson(res, 200, { valid: false, message: licenseStatusMessage(status) });
  }

  if (installationId) {
    await withDb(async (freshDb) => {
      const freshLicense = findLicenseByKey(freshDb, license.key);
      activateDeviceForLicense(freshDb, freshLicense, installationId, deviceName);
    });
  }

  touchSession(session.token);
  return sendJson(res, 200, {
    valid: true,
    expiresAt: getSession(session.token).expiresAt,
    license: serializeForClient(db, license),
  });
}

async function handleCustomerLogout(req, res) {
  const token = parseBearerToken(req.headers.authorization);
  const session = getSession(token);

  if (session && session.type === 'customer') {
    const body = await readJsonBody(req).catch(() => ({}));
    if (body.installationId) {
      await withDb(async (db) => {
        const customer = findCustomer(db, session.subjectId);
        const license = customer ? primaryLicenseForCustomer(db, customer.id) : null;
        if (license) {
          db.devices = db.devices.filter((d) => !(d.licenseId === license.id && d.installationId === body.installationId));
        }
      });
    }
    destroySession(token);
  }

  return sendJson(res, 200, { ok: true });
}

// ---------------------------------------------------------------------------
// Handlers: API legada por clave de licencia
// ---------------------------------------------------------------------------
async function handleActivate(req, res) {
  const body = await readJsonBody(req);
  const { key, installationId } = body;
  if (!key || !installationId) {
    return sendJson(res, 400, { valid: false, message: 'Falta la clave o el identificador de instalación.' });
  }

  await withDb(async (db) => {
    const license = findLicenseByKey(db, key);
    if (!license) {
      return sendJson(res, 200, { valid: false, message: 'La clave de licencia no existe.' });
    }
    const status = computeStatus(license);
    if (status !== 'active') {
      return sendJson(res, 200, { valid: false, message: licenseStatusMessage(status) });
    }

    const devices = devicesForLicense(db, license.id);
    const alreadyActivated = devices.find((d) => d.installationId === installationId);
    if (!alreadyActivated) {
      const max = maxActivationsFor(license.planId);
      if (devices.length >= max) {
        return sendJson(res, 200, {
          valid: false,
          message: `Esta licencia ya alcanzó el máximo de activaciones (${max}) para el plan ${planLabel(license.planId)}.`,
        });
      }
      db.devices.push({ id: newId('dev'), licenseId: license.id, installationId, activatedAt: Date.now(), lastSeenAt: Date.now() });
    } else {
      alreadyActivated.lastSeenAt = Date.now();
    }

    return sendJson(res, 200, { valid: true, planId: license.planId, planLabel: planLabel(license.planId), expiresAt: license.expiresAt });
  });
}

async function handleValidate(req, res) {
  const body = await readJsonBody(req);
  const { key, installationId } = body;
  if (!key) return sendJson(res, 400, { valid: false, message: 'Falta la clave.' });

  const db = await load();
  const license = findLicenseByKey(db, key);
  if (!license) return sendJson(res, 200, { valid: false, message: 'La clave de licencia no existe.' });

  const status = computeStatus(license);
  if (status !== 'active') {
    return sendJson(res, 200, { valid: false, message: licenseStatusMessage(status) });
  }

  if (installationId) {
    await withDb(async (freshDb) => {
      const freshLicense = findLicenseByKey(freshDb, key);
      const device = freshDb.devices.find((d) => d.licenseId === freshLicense.id && d.installationId === installationId);
      if (device) device.lastSeenAt = Date.now();
    });
  }

  return sendJson(res, 200, { valid: true, planId: license.planId, planLabel: planLabel(license.planId), expiresAt: license.expiresAt });
}

async function handleDeactivate(req, res) {
  const body = await readJsonBody(req);
  const { key, installationId } = body;
  if (!key || !installationId) return sendJson(res, 400, { ok: false, message: 'Falta la clave o el identificador de instalación.' });

  await withDb(async (db) => {
    const license = findLicenseByKey(db, key);
    if (license) {
      db.devices = db.devices.filter((d) => !(d.licenseId === license.id && d.installationId === installationId));
    }
  });
  return sendJson(res, 200, { ok: true });
}

// ---------------------------------------------------------------------------
// Handlers: panel de cliente
// ---------------------------------------------------------------------------
async function handleClientLookup(req, res) {
  const body = await readJsonBody(req);
  const { key } = body;
  if (!key) return sendJson(res, 400, { error: 'Ingresa tu clave de licencia.' });

  const db = await load();
  const license = findLicenseByKey(db, key.trim());
  if (!license) return sendJson(res, 404, { error: 'No encontramos ninguna licencia con esa clave.' });

  return sendJson(res, 200, { license: serializeForClient(db, license) });
}

// ---------------------------------------------------------------------------
// Handlers: planes públicos y pagos (Mercado Pago)
// ---------------------------------------------------------------------------

/** Planes con precio (excluye `trial`, que no se compra). */
function purchasablePlans() {
  return Object.entries(PLAN_DEFAULTS)
    .filter(([, plan]) => plan.priceMonthly != null)
    .map(([planId, plan]) => ({
      planId,
      label: plan.label,
      maxActivations: plan.maxActivations,
      currency: CURRENCY,
      priceMonthly: plan.priceMonthly,
      priceYearly: plan.priceYearly,
    }));
}

async function handlePlansPublic(req, res) {
  sendJson(res, 200, { plans: purchasablePlans(), currency: CURRENCY });
}

/**
 * POST /api/payments/checkout — crea una preferencia de pago de Mercado Pago
 * (Checkout Pro) para un plan y período dados, y devuelve la URL a la que
 * hay que redirigir al comprador. No requiere que el comprador ya tenga
 * cuenta: si es nuevo, la cuenta y la licencia se crean cuando el webhook
 * confirme el pago (ver handlePaymentsWebhook).
 */
async function handlePaymentsCheckout(req, res) {
  const body = await readJsonBody(req);
  const { name, email, planId, period } = body;

  if (!name || !email) return sendJson(res, 400, { error: 'Nombre y correo son obligatorios.' });
  if (!PLAN_DEFAULTS[planId] || PLAN_DEFAULTS[planId].priceMonthly == null) {
    return sendJson(res, 400, { error: 'Plan inválido.' });
  }
  if (period !== 'monthly' && period !== 'yearly') {
    return sendJson(res, 400, { error: 'Período inválido (debe ser "monthly" o "yearly").' });
  }

  const plan = PLAN_DEFAULTS[planId];
  const unitPrice = period === 'yearly' ? plan.priceYearly : plan.priceMonthly;
  const periodDays = period === 'yearly' ? 365 : 30;

  const payment = {
    id: newId('pay'),
    name,
    email,
    planId,
    period,
    periodDays,
    amount: unitPrice,
    currency: CURRENCY,
    status: 'pending',
    createdAt: Date.now(),
    mpPreferenceId: null,
    mpPaymentId: null,
    processedAt: null,
    temporaryPassword: null,
  };

  await withDb(async (db) => {
    db.payments.push(payment);
  });

  try {
    const preference = await createPreference({
      title: `WaMaster Asthi — Plan ${plan.label} (${period === 'yearly' ? '1 año' : '1 mes'})`,
      quantity: 1,
      unitPrice,
      currency: CURRENCY,
      externalReference: payment.id,
      payerEmail: email,
      successUrl: `${PUBLIC_BASE_URL}/comprar/gracias.html?pago=${payment.id}`,
      failureUrl: `${PUBLIC_BASE_URL}/comprar/index.html?error=1`,
      pendingUrl: `${PUBLIC_BASE_URL}/comprar/gracias.html?pago=${payment.id}`,
      notificationUrl: `${PUBLIC_BASE_URL}/api/payments/webhook`,
    });

    await withDb(async (db) => {
      const p = db.payments.find((x) => x.id === payment.id);
      if (p) p.mpPreferenceId = preference.id;
    });

    return sendJson(res, 200, { paymentId: payment.id, checkoutUrl: preference.initPoint });
  } catch (err) {
    await withDb(async (db) => {
      const p = db.payments.find((x) => x.id === payment.id);
      if (p) p.status = 'error_creando_preferencia';
    });
    console.error('[payments] Error creando preferencia de Mercado Pago:', err);
    return sendJson(res, 502, { error: `No se pudo iniciar el pago con Mercado Pago: ${err.message}` });
  }
}

/**
 * POST /api/payments/webhook — Mercado Pago llama aquí cuando cambia el
 * estado de un pago. El payload del webhook solo dice "algo pasó con el
 * pago X" — SIEMPRE se vuelve a consultar el estado real vía getPayment()
 * antes de activar nada. Idempotente: si el pago ya se procesó
 * (`processedAt` ya tiene valor), no se vuelve a crear/extender la licencia
 * aunque Mercado Pago reintente la notificación.
 */
async function handlePaymentsWebhook(req, res, params, url) {
  const body = await readJsonBody(req).catch(() => ({}));
  const type = url.searchParams.get('type') || url.searchParams.get('topic') || body.type;
  const paymentId = url.searchParams.get('data.id') || body?.data?.id || url.searchParams.get('id');

  if (type !== 'payment' || !paymentId) {
    // Otros tipos de notificación (merchant_order, etc.) no nos interesan.
    return sendJson(res, 200, { ok: true });
  }

  try {
    const mpPayment = await getPayment(paymentId);
    const db = await load();
    const payment = db.payments.find((p) => p.id === mpPayment.externalReference);
    if (!payment) {
      // Pago de otra referencia (ej. prueba manual en el dashboard de MP) — no es un error nuestro.
      return sendJson(res, 200, { ok: true });
    }

    await withDb(async (freshDb) => {
      const p = freshDb.payments.find((x) => x.id === payment.id);
      if (!p) return;
      p.status = mpPayment.status;
      p.mpPaymentId = mpPayment.id;

      if (mpPayment.status === 'approved' && !p.processedAt) {
        let customer = findCustomerByEmail(freshDb, p.email);
        let temporaryPassword = null;
        if (!customer) {
          customer = { id: newId('cus'), name: p.name, email: p.email, createdAt: Date.now() };
          freshDb.customers.push(customer);
        }
        if (!customer.passwordHash) {
          temporaryPassword = generateTemporaryPassword();
          const { hash, salt } = hashPassword(temporaryPassword);
          customer.passwordHash = hash;
          customer.passwordSalt = salt;
        }

        const license = extendOrCreateLicenseForPayment(freshDb, {
          customerId: customer.id,
          planId: p.planId,
          periodDays: p.periodDays,
          generateKey: generateLicenseKey,
        });

        p.processedAt = Date.now();
        p.temporaryPassword = temporaryPassword; // se entrega una sola vez vía /api/payments/status/:id
        p.licenseId = license.id;
      }
    });

    return sendJson(res, 200, { ok: true });
  } catch (err) {
    console.error('[payments] Error procesando webhook de Mercado Pago:', err);
    // 500 a propósito: así Mercado Pago reintenta la notificación más tarde
    // en vez de darla por entregada cuando en realidad falló.
    return sendJson(res, 500, { ok: false });
  }
}

/**
 * GET /api/payments/status/:id — la página de "gracias por tu compra" hace
 * polling aquí hasta que el webhook haya confirmado el pago (puede tardar
 * unos segundos). Devuelve la contraseña temporal UNA SOLA VEZ.
 */
async function handlePaymentsStatus(req, res, params) {
  const result = await withDb(async (db) => {
    const payment = db.payments.find((p) => p.id === params.id);
    if (!payment) return null;

    const out = {
      status: payment.status,
      planId: payment.planId,
      period: payment.period,
      email: payment.email,
      temporaryPassword: payment.temporaryPassword || null,
    };
    if (payment.temporaryPassword) payment.temporaryPassword = null; // una sola vez

    if (payment.licenseId) {
      const license = db.licenses.find((l) => l.id === payment.licenseId);
      if (license) out.license = serializeForClient(db, license);
    }
    return out;
  });

  if (!result) return sendJson(res, 404, { error: 'Pago no encontrado.' });
  return sendJson(res, 200, result);
}

async function handleAdminListPayments(req, res) {
  if (!requireAdmin(req, res)) return;
  const db = await load();
  const payments = db.payments
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((p) => ({ ...p, temporaryPassword: undefined })); // nunca exponer la contraseña temporal desde este endpoint
  sendJson(res, 200, { payments });
}

// ---------------------------------------------------------------------------
// Handlers: panel de administrador
// ---------------------------------------------------------------------------
async function handleAdminLogin(req, res) {
  const body = await readJsonBody(req);
  const { email, password } = body;
  const db = await load();
  const admin = db.admins.find((a) => a.email.toLowerCase() === String(email || '').toLowerCase());
  if (!admin || !verifyPassword(password || '', admin.passwordSalt, admin.passwordHash)) {
    return sendJson(res, 401, { error: 'Correo o contraseña incorrectos.' });
  }
  const token = createSession(admin.id);
  // Detrás de un proxy TLS (Render/Railway) la conexión a este proceso es
  // HTTP plano; el proxy indica el protocolo original del cliente en este
  // header. Sin él, marcar la cookie Secure siempre rompería el login en
  // localhost (HTTP), y no marcarla nunca sería inseguro en producción.
  const isSecureRequest = req.headers['x-forwarded-proto'] === 'https' || IS_PRODUCTION;
  const secureFlag = isSecureRequest ? '; Secure' : '';
  sendJson(res, 200, { ok: true, email: admin.email }, {
    'Set-Cookie': `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=43200${secureFlag}`,
  });
}

async function handleAdminLogout(req, res) {
  const session = getRequestSession(req);
  if (session) destroySession(session.token);
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0` });
}

async function handleAdminMe(req, res) {
  const session = requireAdmin(req, res);
  if (!session) return;
  const db = await load();
  const admin = db.admins.find((a) => a.id === session.subjectId);
  sendJson(res, 200, { email: admin?.email || null });
}

async function handleAdminPlans(req, res) {
  if (!requireAdmin(req, res)) return;
  sendJson(res, 200, { plans: PLAN_DEFAULTS });
}

async function handleAdminListLicenses(req, res) {
  if (!requireAdmin(req, res)) return;
  const db = await load();
  const licenses = db.licenses.slice().sort((a, b) => b.createdAt - a.createdAt).map((l) => serializeForAdmin(db, l));
  sendJson(res, 200, { licenses });
}

async function handleAdminCreateLicense(req, res) {
  if (!requireAdmin(req, res)) return;
  const body = await readJsonBody(req);
  const { customerName, customerEmail, customerPassword, planId, expiresAt, notes } = body;

  if (!customerName || !customerEmail) return sendJson(res, 400, { error: 'Nombre y correo del cliente son obligatorios.' });
  if (!PLAN_DEFAULTS[planId]) return sendJson(res, 400, { error: 'Plan inválido.' });

  let generatedPassword = null;

  const result = await withDb(async (db) => {
    let customer = db.customers.find((c) => c.email.toLowerCase() === customerEmail.toLowerCase());
    if (!customer) {
      customer = { id: newId('cus'), name: customerName, email: customerEmail, createdAt: Date.now() };
      db.customers.push(customer);
    } else {
      customer.name = customerName;
    }

    if (customerPassword || !customer.passwordHash) {
      const plain = customerPassword || generateTemporaryPassword();
      const { hash, salt } = hashPassword(plain);
      customer.passwordHash = hash;
      customer.passwordSalt = salt;
      generatedPassword = plain;
    }

    const license = {
      id: newId('lic'),
      key: generateLicenseKey(),
      customerId: customer.id,
      planId,
      status: 'active',
      createdAt: Date.now(),
      expiresAt: expiresAt ? Number(expiresAt) : null,
      notes: notes || '',
    };
    db.licenses.push(license);
    return serializeForAdmin(db, license);
  });

  sendJson(res, 201, { license: result, temporaryPassword: generatedPassword });
}

async function handleAdminResetCustomerPassword(req, res, params) {
  if (!requireAdmin(req, res)) return;
  const result = await withDb(async (db) => {
    const customer = findCustomer(db, params.id);
    if (!customer) return null;
    const plain = generateTemporaryPassword();
    const { hash, salt } = hashPassword(plain);
    customer.passwordHash = hash;
    customer.passwordSalt = salt;
    return plain;
  });
  if (result === null) return sendJson(res, 404, { error: 'Cliente no encontrado.' });
  sendJson(res, 200, { temporaryPassword: result });
}

async function handleAdminUpdateLicense(req, res, params) {
  if (!requireAdmin(req, res)) return;
  const body = await readJsonBody(req);
  const result = await withDb(async (db) => {
    const license = db.licenses.find((l) => l.id === params.id);
    if (!license) return null;
    if (body.status && ['active', 'suspended'].includes(body.status)) license.status = body.status;
    if (body.planId && PLAN_DEFAULTS[body.planId]) license.planId = body.planId;
    if (body.expiresAt !== undefined) license.expiresAt = body.expiresAt ? Number(body.expiresAt) : null;
    if (body.notes !== undefined) license.notes = body.notes;
    return serializeForAdmin(db, license);
  });
  if (!result) return sendJson(res, 404, { error: 'Licencia no encontrada.' });
  sendJson(res, 200, { license: result });
}

async function handleAdminDeleteLicense(req, res, params) {
  if (!requireAdmin(req, res)) return;
  const found = await withDb(async (db) => {
    const before = db.licenses.length;
    db.licenses = db.licenses.filter((l) => l.id !== params.id);
    db.devices = db.devices.filter((d) => d.licenseId !== params.id);
    return db.licenses.length < before;
  });
  if (!found) return sendJson(res, 404, { error: 'Licencia no encontrada.' });
  sendJson(res, 200, { ok: true });
}

async function handleAdminExportCsv(req, res) {
  if (!requireAdmin(req, res)) return;
  const db = await load();
  const rows = db.licenses
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((l) => {
      const s = serializeForAdmin(db, l);
      return {
        Clave: s.key,
        Cliente: s.customer?.name || '',
        Correo: s.customer?.email || '',
        Plan: s.planLabel,
        Estado: s.status,
        'Creada el': new Date(s.createdAt).toLocaleString('es-MX'),
        'Vence el': s.expiresAt ? new Date(s.expiresAt).toLocaleString('es-MX') : 'Sin vencimiento',
        Dispositivos: `${s.devicesCount}/${s.maxActivations}`,
        Notas: s.notes,
      };
    });
  const csv = toCsv(rows);
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="wamaster_licencias_${Date.now()}.csv"`,
  });
  res.end(csv);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
const PUBLIC_CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const ROUTES = [
  // Auth de la extensión por correo + contraseña
  { method: 'POST', pattern: '/v1/auth/login', handler: handleCustomerLogin, cors: true },
  { method: 'POST', pattern: '/v1/auth/logout', handler: handleCustomerLogout, cors: true },
  { method: 'POST', pattern: '/v1/licenses/session', handler: handleCustomerSession, cors: true },

  // Legado por clave de licencia (compatibilidad hacia atrás)
  { method: 'POST', pattern: '/v1/licenses/activate', handler: handleActivate, cors: true },
  { method: 'POST', pattern: '/v1/licenses/validate', handler: handleValidate, cors: true },
  { method: 'POST', pattern: '/v1/licenses/deactivate', handler: handleDeactivate, cors: true },

  { method: 'POST', pattern: '/api/client/lookup', handler: handleClientLookup },

  // Planes y pagos
  { method: 'GET', pattern: '/api/plans', handler: handlePlansPublic },
  { method: 'POST', pattern: '/api/payments/checkout', handler: handlePaymentsCheckout },
  { method: 'POST', pattern: '/api/payments/webhook', handler: handlePaymentsWebhook, needsUrl: true },
  { method: 'GET', pattern: '/api/payments/status/:id', handler: handlePaymentsStatus },
  { method: 'GET', pattern: '/api/admin/payments', handler: handleAdminListPayments },

  { method: 'POST', pattern: '/api/admin/login', handler: handleAdminLogin },
  { method: 'POST', pattern: '/api/admin/logout', handler: handleAdminLogout },
  { method: 'GET', pattern: '/api/admin/me', handler: handleAdminMe },
  { method: 'GET', pattern: '/api/admin/plans', handler: handleAdminPlans },
  { method: 'GET', pattern: '/api/admin/licenses', handler: handleAdminListLicenses },
  { method: 'POST', pattern: '/api/admin/licenses', handler: handleAdminCreateLicense },
  { method: 'PATCH', pattern: '/api/admin/licenses/:id', handler: handleAdminUpdateLicense },
  { method: 'DELETE', pattern: '/api/admin/licenses/:id', handler: handleAdminDeleteLicense },
  { method: 'POST', pattern: '/api/admin/customers/:id/reset-password', handler: handleAdminResetCustomerPassword },
  { method: 'GET', pattern: '/api/admin/licenses/export.csv', handler: handleAdminExportCsv },
];

const STATIC_ROUTE_ALIASES = {
  '/': '/index.html',
  '/comprar': '/comprar/index.html',
  '/comprar/': '/comprar/index.html',
  '/admin': '/admin/index.html',
  '/admin/': '/admin/index.html',
  '/cliente': '/cliente/index.html',
  '/cliente/': '/cliente/index.html',
  '/descargar': '/assets/wamaster-asthi-v1.5.0.zip',
};

async function handleStatic(req, res, pathname) {
  const aliased = STATIC_ROUTE_ALIASES[pathname] || pathname;
  const safePath = path.normalize(aliased).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, 'Prohibido.');
    return;
  }
  const served = await serveStatic(res, filePath);
  if (!served) {
    if (pathname.startsWith('/admin')) {
      await serveStatic(res, path.join(PUBLIC_DIR, 'admin', 'index.html'));
      return;
    }
    if (pathname.startsWith('/cliente')) {
      await serveStatic(res, path.join(PUBLIC_DIR, 'cliente', 'index.html'));
      return;
    }
    if (pathname.startsWith('/comprar')) {
      await serveStatic(res, path.join(PUBLIC_DIR, 'comprar', 'index.html'));
      return;
    }
    sendText(res, 404, 'No encontrado.');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    if (req.method === 'OPTIONS' && (pathname.startsWith('/v1/licenses/') || pathname.startsWith('/v1/auth/'))) {
      res.writeHead(204, PUBLIC_CORS_HEADERS);
      res.end();
      return;
    }

    for (const route of ROUTES) {
      if (route.method !== req.method) continue;
      const params = matchRoute(route.pattern, pathname);
      if (!params) continue;
      if (route.cors) {
        Object.entries(PUBLIC_CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
      }
      await route.handler(req, res, params, url);
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      await handleStatic(req, res, pathname);
      return;
    }

    sendText(res, 404, 'No encontrado.');
  } catch (err) {
    console.error('[server] Error no manejado:', err);
    if (!res.headersSent) sendJson(res, 500, { error: 'Error interno del servidor.' });
  }
});

seedIfEmpty({ hashPassword }).then(() => {
  // 0.0.0.0 explícito porque Render y Railway enrutan tráfico externo hacia
  // la IP del contenedor, no hacia 127.0.0.1.
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`WaMaster Asthi Web escuchando en el puerto ${PORT} (0.0.0.0)`);
    console.log(`  Landing:        http://localhost:${PORT}/`);
    console.log(`  Comprar:        http://localhost:${PORT}/comprar`);
    console.log(`  Panel admin:    http://localhost:${PORT}/admin`);
    console.log(`  Panel cliente:  http://localhost:${PORT}/cliente`);
    console.log(`  URL pública configurada (PUBLIC_BASE_URL): ${PUBLIC_BASE_URL}`);
    console.log(`  Datos (DATA_DIR): ${process.env.DATA_DIR ? process.env.DATA_DIR : '(por defecto, junto al código — no persiste en redeploys sin volumen)'}`);
    if (!process.env.MP_ACCESS_TOKEN) {
      console.log('  (!) MP_ACCESS_TOKEN no está configurado — /api/payments/checkout fallará hasta que lo definas. Ver docs/PAGOS.md.');
    }
    if (!existsSync(path.join(PUBLIC_DIR, 'assets', 'wamaster-asthi-v1.5.0.zip'))) {
      console.log('  (!) No se encontró public/assets/wamaster-asthi-v1.5.0.zip — copia ahí el .zip de la extensión para que /descargar funcione.');
    }
  });
});
