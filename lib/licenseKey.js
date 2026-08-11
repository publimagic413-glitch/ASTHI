/**
 * licenseKey.js
 * ---------------------------------------------------------------------------
 * Generador de claves de licencia legibles, formato `WAM-XXXX-XXXX-XXXX`.
 * Ya no es el mecanismo principal de autenticación (desde v1.4.0 la
 * extensión usa correo+contraseña), pero se conserva como identificador de
 * referencia visible en el panel admin y el portal de clientes.
 * ---------------------------------------------------------------------------
 */
import crypto from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sin 0/O, 1/I/L para evitar confusión al transcribir

function randomGroup(length) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export function generateLicenseKey() {
  return `WAM-${randomGroup(4)}-${randomGroup(4)}-${randomGroup(4)}`;
}
