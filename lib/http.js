/**
 * http.js
 * ---------------------------------------------------------------------------
 * Helpers HTTP genéricos usados por server.js: leer cuerpo JSON, responder
 * JSON/texto, servir archivos estáticos, generar CSV y hacer match de rutas
 * con parámetros (`/api/admin/licenses/:id`). Sin dependencias externas.
 * ---------------------------------------------------------------------------
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB, generoso para JSON de formularios

export function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Cuerpo de la petición demasiado grande.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
      } catch {
        reject(new Error('Cuerpo de la petición no es JSON válido.'));
      }
    });
    req.on('error', reject);
  });
}

export function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

export function sendText(res, status, text, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    ...extraHeaders,
  });
  res.end(text);
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.zip': 'application/zip',
  '.pdf': 'application/pdf',
};

/** Sirve un archivo estático si existe. @returns {Promise<boolean>} true si lo sirvió. */
export function serveStatic(res, filePath) {
  return new Promise((resolve) => {
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      resolve(false);
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    const stream = createReadStream(filePath);
    stream.on('error', () => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
      resolve(true);
    });
    stream.pipe(res);
    stream.on('end', () => resolve(true));
  });
}

/** Convierte un array de objetos planos a CSV (con BOM para que Excel detecte UTF-8 correctamente). */
export function toCsv(rows) {
  if (!rows || rows.length === 0) return '﻿';
  const headers = Object.keys(rows[0]);
  const escapeCell = (value) => {
    const str = String(value ?? '');
    if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
    return str;
  };
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => escapeCell(row[h])).join(','));
  }
  return '﻿' + lines.join('\n');
}

/**
 * Compara un pathname real contra un patrón de ruta con parámetros
 * (`/api/admin/licenses/:id`). @returns {Record<string,string>|null} los
 * parámetros extraídos, o null si no coincide.
 */
export function matchRoute(pattern, pathname) {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = pathname.split('/').filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;

  const params = {};
  for (let i = 0; i < patternParts.length; i++) {
    const p = patternParts[i];
    const actual = decodeURIComponent(pathParts[i]);
    if (p.startsWith(':')) {
      params[p.slice(1)] = actual;
    } else if (p !== actual) {
      return null;
    }
  }
  return params;
}
