/**
 * auth.js
 * ---------------------------------------------------------------------------
 * Hash de contraseñas, sesiones (admin y cliente/extensión) y límite de
 * intentos de login fallidos. Todo con módulos nativos de Node (`crypto`),
 * sin dependencias externas.
 *
 * Dos tipos de sesión, mismo almacén en memoria (`sessions`), distinguidos
 * por `type`:
 *   - 'admin': cookie HttpOnly, TTL corto (12h) — panel de administrador.
 *   - 'customer': Authorization: Bearer <token>, TTL largo (30 días) con
 *     sliding expiration — la extensión de Chrome.
 *
 * Nota: las sesiones viven en memoria del proceso, no en `data/db.json`. Si
 * el servidor se reinicia, todas las sesiones activas se invalidan (los
 * clientes vuelven a iniciar sesión automáticamente la siguiente vez que la
 * extensión revalide). Para producción con más de un proceso/instancia,
 * esto tendría que moverse a un almacén compartido (Redis, etc.) — no es
 * necesario para el volumen que este proyecto está pensado para manejar.
 * ---------------------------------------------------------------------------
 */

import crypto from 'node:crypto';

const SCRYPT_KEYLEN = 64;

/** Hashea una contraseña con scrypt + salt aleatorio. */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN).toString('hex');
  return { hash, salt };
}

/** Compara una contraseña en texto plano contra un hash+salt guardados, con comparación de tiempo constante. */
export function verifyPassword(password, salt, expectedHash) {
  if (!salt || !expectedHash) return false;
  try {
    const actual = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN);
    const expected = Buffer.from(expectedHash, 'hex');
    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** Alfabeto sin caracteres confundibles (0/O, 1/l/I) para contraseñas temporales generadas. */
const TEMP_PASSWORD_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
export function generateTemporaryPassword(length = 10) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += TEMP_PASSWORD_ALPHABET[bytes[i] % TEMP_PASSWORD_ALPHABET.length];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sesiones
// ---------------------------------------------------------------------------
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 horas

/** @type {Map<string, {type: 'admin'|'customer', subjectId: string, ttlMs: number, expiresAt: number}>} */
const sessions = new Map();

export function createSession(subjectId, type = 'admin', ttlMs = ADMIN_SESSION_TTL_MS) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { type, subjectId, ttlMs, expiresAt: Date.now() + ttlMs });
  return token;
}

export function getSession(token) {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    return null;
  }
  return session;
}

/** Renueva la expiración de una sesión (sliding expiration) — se llama en cada revalidación exitosa. */
export function touchSession(token) {
  const session = sessions.get(token);
  if (!session) return;
  session.expiresAt = Date.now() + session.ttlMs;
}

export function destroySession(token) {
  if (token) sessions.delete(token);
}

/** Extrae el valor de una cookie por nombre del header `Cookie` crudo. */
export function parseCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(';').map((p) => p.trim());
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq) === name) return decodeURIComponent(part.slice(eq + 1));
  }
  return null;
}

/** Extrae el token de un header `Authorization: Bearer <token>`. */
export function parseBearerToken(authorizationHeader) {
  if (!authorizationHeader) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Límite de intentos de login fallidos (por correo, en memoria)
// ---------------------------------------------------------------------------
export const LOGIN_MAX_ATTEMPTS = 5;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutos

/** @type {Map<string, number[]>} correo normalizado -> timestamps de intentos fallidos recientes */
const failedAttempts = new Map();

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

/** @returns {{blocked: boolean, retryAfterMs: number}} */
export function checkLoginRateLimit(email) {
  const key = normalizeEmail(email);
  const attempts = (failedAttempts.get(key) || []).filter((t) => Date.now() - t < LOGIN_WINDOW_MS);
  failedAttempts.set(key, attempts);
  if (attempts.length >= LOGIN_MAX_ATTEMPTS) {
    const oldestRelevant = attempts[0];
    const retryAfterMs = LOGIN_WINDOW_MS - (Date.now() - oldestRelevant);
    return { blocked: true, retryAfterMs: Math.max(retryAfterMs, 0) };
  }
  return { blocked: false, retryAfterMs: 0 };
}

export function registerFailedLogin(email) {
  const key = normalizeEmail(email);
  const attempts = (failedAttempts.get(key) || []).filter((t) => Date.now() - t < LOGIN_WINDOW_MS);
  attempts.push(Date.now());
  failedAttempts.set(key, attempts);
}

export function clearLoginAttempts(email) {
  failedAttempts.delete(normalizeEmail(email));
}
