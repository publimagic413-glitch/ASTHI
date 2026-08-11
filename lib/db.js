/**
 * db.js
 * ---------------------------------------------------------------------------
 * "Base de datos" de WaMaster Asthi Web: un archivo JSON en disco
 * (data/db.json). Es deliberadamente simple: para el volumen de un negocio
 * vendiendo licencias (decenas o cientos de clientes) es más que suficiente,
 * no requiere instalar ni administrar un motor de base de datos aparte, y el
 * archivo se puede leer/editar a mano si hace falta.
 *
 * Camino de actualización futuro (documentado, no implementado): cuando el
 * volumen lo justifique, reemplazar este archivo por un cliente de
 * PostgreSQL/SQLite manteniendo exactamente las mismas funciones exportadas
 * (load/save/collections), para que server.js no tenga que cambiar.
 *
 * Concurrencia: todas las escrituras pasan por una cola en memoria
 * (`writeQueue`) para evitar que dos peticiones simultáneas se pisen al
 * escribir el archivo (condición de carrera clásica de "leer todo, modificar,
 * escribir todo" sobre un solo archivo).
 * ---------------------------------------------------------------------------
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/**
 * En local, la carpeta data/ vive junto al código. En producción (Render/
 * Railway) conviene apuntarla a un disco/volumen persistente montado aparte
 * del código (que se redepliega en cada push y borraría data/ si viviera
 * ahí) — para eso se puede definir la variable de entorno DATA_DIR (ej.
 * DATA_DIR=/data en Render con un Persistent Disk montado en /data, o
 * DATA_DIR=/data en Railway con un Volume montado en /data).
 */
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');

/**
 * Moneda en la que se cobran los planes vía Mercado Pago. Debe coincidir con
 * el país de la cuenta de Mercado Pago que uses (MXN, ARS, COP, CLP, PEN,
 * UYU, BRL, etc.) — ver docs/PAGOS.md. Los precios de PLAN_DEFAULTS están en
 * esta moneda.
 */
export const CURRENCY = process.env.MP_CURRENCY || 'MXN';

/**
 * Planes disponibles, sus límites y sus precios de referencia (editable aquí,
 * sin tocar el resto del código). `priceMonthly`/`priceYearly` son los montos
 * que se cobran vía Mercado Pago por 30 y 365 días respectivamente; `trial`
 * no tiene precio porque no se compra (lo asigna el admin a mano).
 */
export const PLAN_DEFAULTS = {
  trial: { label: 'Trial', maxActivations: 1, defaultDurationDays: 7, priceMonthly: null, priceYearly: null },
  basic: { label: 'Basic', maxActivations: 1, defaultDurationDays: 30, priceMonthly: 199, priceYearly: 1990 },
  pro: { label: 'Pro', maxActivations: 3, defaultDurationDays: 30, priceMonthly: 399, priceYearly: 3990 },
  agency: { label: 'Agency', maxActivations: 10, defaultDurationDays: 30, priceMonthly: 799, priceYearly: 7990 },
};

function emptyDb() {
  return {
    admins: [],
    customers: [],
    licenses: [],
    devices: [],
    // Registro de pagos de Mercado Pago (ver lib/mercadopago.js y
    // handlePaymentsCheckout/handlePaymentsWebhook en server.js).
    payments: [],
  };
}

async function ensureDbFile() {
  if (!existsSync(DATA_DIR)) {
    await mkdir(DATA_DIR, { recursive: true });
  }
  if (!existsSync(DB_PATH)) {
    await writeFile(DB_PATH, JSON.stringify(emptyDb(), null, 2), 'utf-8');
  }
}

let writeQueue = Promise.resolve();

/** Lee el estado completo de la base de datos. */
export async function load() {
  await ensureDbFile();
  const raw = await readFile(DB_PATH, 'utf-8');
  const db = JSON.parse(raw);
  // Compatibilidad con bases de datos creadas antes de que existiera `payments`.
  if (!Array.isArray(db.payments)) db.payments = [];
  return db;
}

/** Guarda el estado completo (encolado para evitar escrituras concurrentes corruptas). */
export function save(data) {
  writeQueue = writeQueue.then(() => writeFile(DB_PATH, JSON.stringify(data, null, 2), 'utf-8'));
  return writeQueue;
}

/**
 * Ejecuta `mutator(db)` con el estado actual, guarda el resultado y lo
 * devuelve. Encapsula el patrón leer-modificar-guardar para que las rutas de
 * la API no tengan que repetirlo.
 * @param {(db: any) => any} mutator - puede modificar `db` in-place y/o devolver un valor
 */
export async function withDb(mutator) {
  const db = await load();
  const result = await mutator(db);
  await save(db);
  return result;
}

export function newId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

/** Sembrado inicial: un admin por defecto (ver ADMIN_EMAIL/ADMIN_PASSWORD en README) si no existe ninguno. */
export async function seedIfEmpty({ hashPassword }) {
  const db = await load();
  if (db.admins.length === 0) {
    const email = process.env.ADMIN_EMAIL || 'admin@wamaster.local';
    const password = process.env.ADMIN_PASSWORD || 'wamaster123';
    const { hash, salt } = hashPassword(password);
    db.admins.push({
      id: newId('admin'),
      email,
      passwordHash: hash,
      passwordSalt: salt,
      createdAt: Date.now(),
    });
    await save(db);
    console.log(`[seed] Admin creado: ${email} / ${password} (cámbialo después de iniciar sesión).`);
  }
}
