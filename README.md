# WaMaster Asthi Web — con pagos por Mercado Pago

Centro de licencias, ventas y soporte para WaMaster Asthi. Incluye:

- **Landing page** (`/`) — presentación del producto y planes.
- **Checkout** (`/comprar`) — el visitante paga con Mercado Pago (Checkout Pro) y su licencia se activa automáticamente al confirmarse el pago. Pago único por período (30/365 días), sin cobro recurrente — ver `docs/PAGOS.md`.
- **Panel administrador** (`/admin`) — crear/suspender/reactivar/eliminar licencias a mano, restablecer contraseñas, ver historial de pagos, exportar licencias a CSV.
- **Portal de clientes** (`/cliente`) — el cliente consulta el estado de su licencia con su clave.
- **API de autenticación de la extensión** (`/v1/auth/*`, `/v1/licenses/session`) — la extensión inicia sesión con **correo + contraseña**, nunca con la clave de licencia. Ver sección 4.
- **API legada por clave** (`/v1/licenses/activate|validate|deactivate`) — compatibilidad con builds de la extensión anteriores a v1.4.0.

Backend en Node.js puro (sin Express, sin dependencias de npm) + una base de datos en archivo JSON (`data/db.json`).

## 1. Requisitos

- Node.js 18 o superior (usa solo módulos nativos: `http`, `crypto`, `fs`). Nada que instalar.
- Una cuenta de Mercado Pago con Access Token (para que `/comprar` funcione) — ver `docs/PAGOS.md`. Sin esto, el resto del sitio funciona igual (admin, cliente, extensión); solo el checkout automático fallará.

## 2. Cómo correrlo

```bash
cd wamaster-web
node server.js
```

La primera vez, crea un admin (`ADMIN_EMAIL`/`ADMIN_PASSWORD` si los defines, o `admin@wamaster.local` / `wamaster123` por defecto — cámbiala después de entrar).

Para probar el flujo de pago en local necesitas un túnel público (Mercado Pago no puede llamarte a `localhost`) — ver `docs/PAGOS.md`, sección 3.3:

```bash
MP_ACCESS_TOKEN=TEST-tu-token PUBLIC_BASE_URL=https://tu-tunel.ngrok-free.app node server.js
```

## 3. Flujo típico de venta

1. Un visitante entra a `/comprar`, elige plan y período, paga con Mercado Pago.
2. Al confirmarse el pago (unos segundos), su licencia se crea o extiende sola, y ve su correo + contraseña temporal en pantalla (una sola vez).
3. Descarga la extensión desde `/descargar` e inicia sesión con esas credenciales.
4. Cuando su licencia esté por vencer, vuelve a `/comprar` y paga de nuevo — no hay cobro automático.
5. Desde `/admin` puedes ver el historial de pagos, crear licencias a mano (ej. cortesías, planes especiales), suspender o restablecer contraseñas en cualquier momento.

## 4. Cómo la extensión se autentica

```bash
# Login
curl -X POST http://localhost:4000/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"cliente@ejemplo.com","password":"claveSegura123","installationId":"uuid-de-ejemplo"}'

# Revalidar sesión (cada 12h mientras el panel esté abierto)
curl -X POST http://localhost:4000/v1/licenses/session \
  -H "Content-Type: application/json" -H "Authorization: Bearer <token>" \
  -d '{"installationId":"uuid-de-ejemplo"}'

# Logout
curl -X POST http://localhost:4000/v1/auth/logout \
  -H "Content-Type: application/json" -H "Authorization: Bearer <token>" \
  -d '{"installationId":"uuid-de-ejemplo"}'
```

Ver `docs/LICENSE_BACKEND.md` (en el proyecto de la extensión) para el contrato completo.

## 5. Estructura del proyecto

```
wamaster-web/
├── server.js               Servidor HTTP único (rutas públicas + admin + pagos + estáticos)
├── lib/
│   ├── db.js                Lectura/escritura de data/db.json, planes y precios
│   ├── auth.js               Hash de contraseñas + sesiones + rate limiting de login
│   ├── licenseKey.js          Generador de claves de licencia
│   ├── licenses.js            Reglas de negocio (estado, serialización, extensión por pago)
│   ├── mercadopago.js         Llamadas a la API de Mercado Pago (crear preferencia, consultar pago)
│   └── http.js                 Helpers HTTP (JSON, estáticos, CSV, enrutador)
├── data/db.json              "Base de datos" (se crea sola al primer arranque)
├── public/
│   ├── index.html + styles.css   Landing
│   ├── comprar/                  Checkout + página de confirmación
│   ├── admin/                    Panel administrador
│   ├── cliente/                  Portal de clientes
│   └── assets/                   .zip de la extensión para descarga
└── package.json
```

## 6. Modelo de datos (data/db.json)

```
{
  "admins":    [{ id, email, passwordHash, passwordSalt, createdAt }],
  "customers": [{ id, name, email, createdAt, passwordHash?, passwordSalt? }],
  "licenses":  [{ id, key, customerId, planId, status, createdAt, expiresAt, notes }],
  "devices":   [{ id, licenseId, installationId, deviceName, activatedAt, lastSeenAt }],
  "payments":  [{ id, name, email, planId, period, periodDays, amount, currency, status, createdAt, mpPreferenceId, mpPaymentId, processedAt, licenseId, temporaryPassword }]
}
```

Los planes (`trial`/`basic`/`pro`/`agency`, límites de dispositivos y precios) están en `lib/db.js` → `PLAN_DEFAULTS`.

## 7. Seguridad

- Contraseñas de admin y clientes con `scrypt` + salt, comparación de tiempo constante.
- Sesiones de admin: cookie `HttpOnly` + `Secure` en producción. Sesiones de cliente/extensión: `Authorization: Bearer <token>`.
- Rate limiting de login (5 intentos / 15 min por correo).
- El webhook de pagos nunca confía en su propio payload: siempre reconsulta el pago contra la API de Mercado Pago antes de activar una licencia (ver `docs/PAGOS.md`, sección 5). Procesamiento idempotente (a prueba de reintentos del webhook).
- `DATA_DIR` configurable para usar un disco/volumen persistente en producción (Render/Railway) — ver `docs/DESPLIEGUE.md`.

## 8. Desplegar en producción

Ver `docs/DESPLIEGUE.md` (Render y Railway) y `docs/PAGOS.md` (configurar Mercado Pago).

## 9. Fases siguientes (fuera de alcance a propósito)

1. Cobro recurrente automático (Mercado Pago "Preapproval") si en algún momento prefieres suscripciones con cargo automático en vez de pago manual por período.
2. Notificaciones por correo/WhatsApp cuando una licencia esté por vencer.
3. Multi-admin con roles.
4. Migración de `data/db.json` a PostgreSQL/SQLite cuando el volumen lo justifique.
