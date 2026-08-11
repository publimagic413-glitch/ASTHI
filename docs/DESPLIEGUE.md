# Desplegar wamaster-web en producción (Render o Railway)

Esta guía asume que ya corriste el backend en local (`node server.js`) y funciona. Cubre Render y Railway porque ambas detectan Node.js automáticamente, no requieren tarjeta para empezar, e inyectan la variable `PORT` que `server.js` ya lee.

## 0. Qué ya está listo en el código

- `server.js` escucha en `process.env.PORT` (fallback `4000` local) y en `0.0.0.0` explícito.
- `lib/db.js` lee la carpeta de datos de `process.env.DATA_DIR` si está definida; si no, usa `data/` junto al código (solo desarrollo).
- La cookie de sesión del panel admin agrega `Secure` automáticamente cuando detecta HTTPS (`X-Forwarded-Proto` o `NODE_ENV=production`).

## 1. Antes de desplegar

1. Sube el contenido de esta carpeta a un repositorio de GitHub.
2. Verifica que `public/assets/wamaster-asthi-v1.5.0.zip` esté incluido (si tu `.gitignore` excluye `.zip`, haz una excepción para ese archivo).
3. Consigue tu Access Token de Mercado Pago — ver `docs/PAGOS.md`.

## 2. Variables de entorno (ambas plataformas)

| Variable | Valor |
|---|---|
| `ADMIN_EMAIL` | tu correo de admin real |
| `ADMIN_PASSWORD` | una contraseña fuerte |
| `NODE_ENV` | `production` |
| `MP_ACCESS_TOKEN` | tu Access Token de Mercado Pago (prueba o producción) |
| `MP_CURRENCY` | `MXN` (u otra según tu país) |
| `PUBLIC_BASE_URL` | tu URL pública final (ej. `https://wamaster-asthi-web.onrender.com`) |
| `DATA_DIR` | `/data` (una vez que agregues el disco/volumen persistente) |

`PORT` no lo definas a mano: ambas plataformas lo inyectan solas.

## 3. Render

1. [render.com](https://render.com) → **New** → **Web Service** → conecta tu repo.
2. **Build Command**: vacío. **Start Command**: `node server.js`.
3. Agrega las variables de entorno de la tabla de arriba en **Environment**.
4. **Almacenamiento persistente**: el plan Free borra `data/db.json` en cada redeploy. Para conservarlo, en **Disks** → **Add Disk** → Mount Path `/data` (requiere plan `Starter` en adelante), y agrega `DATA_DIR=/data`.
5. **Create Web Service**. Tu URL pública queda como `https://tu-servicio.onrender.com` — cópiala en `PUBLIC_BASE_URL` y vuelve a desplegar (o edítala en Environment y Render redepliega solo).

## 4. Railway

1. [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**.
2. Railway detecta Node.js solo (usa el `"start": "node server.js"` de `package.json`).
3. Agrega las variables de entorno en **Variables**.
4. **Volumes** (disponible desde el plan Hobby, más simple que en Render): **New Volume** → Mount Path `/data`, y agrega `DATA_DIR=/data`.
5. **Settings → Networking → Generate Domain** para obtener tu URL pública — cópiala en `PUBLIC_BASE_URL`.

## 5. Después de desplegar

1. Prueba el flujo de compra completo en `https://tu-backend-publico/comprar` con una tarjeta de prueba de Mercado Pago si usaste credenciales de prueba.
2. Verifica que el webhook llegue: revisa los logs del servicio tras un pago de prueba — deberías ver la licencia creada en el panel admin.
3. Prueba el login de la extensión contra el backend público:
   ```bash
   curl -X POST https://tu-backend-publico/v1/auth/login \
     -H "Content-Type: application/json" \
     -d '{"email":"cliente@ejemplo.com","password":"claveSegura123","installationId":"prueba-1"}'
   ```
4. Cambia `DEFAULT_API_BASE` en la extensión (`src/modules/licensing.js`) o configúralo en "Opciones avanzadas" para que apunte a tu URL pública en vez de `localhost:4000`, y agrega tu dominio a `manifest.json` → `host_permissions` si vas a distribuir esa build.
