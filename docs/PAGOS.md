# Pagos y suscripciones con Mercado Pago

## 1. Modelo de cobro

**Pago único por período, renovación manual** — no es una suscripción con cobro automático recurrente. El cliente paga una vez por 30 días (mensual) o 365 días (anual); cuando esté por vencer, tiene que volver a pagar manualmente desde `/comprar`. La licencia se activa o se extiende automáticamente en cuanto Mercado Pago confirma el pago — el admin no tiene que hacer nada a mano para eso.

Si más adelante quieres cobro automático recurrente, Mercado Pago lo ofrece como "Preapproval" (suscripciones), que es una integración distinta a la de este documento — no está implementada aquí a propósito, porque no fue lo que se pidió.

## 2. Cómo funciona (flujo completo)

1. El visitante entra a `/comprar`, llena su nombre, correo, elige plan y período (mensual/anual).
2. El frontend llama a `POST /api/payments/checkout`. El servidor:
   - Guarda un registro de pago en estado `pending` (`data/db.json` → `payments`).
   - Le pide a Mercado Pago una "preferencia" de Checkout Pro (`lib/mercadopago.js` → `createPreference()`), con `external_reference` = el id del pago local, y `notification_url` apuntando a `/api/payments/webhook` de este mismo servidor.
   - Devuelve la URL del checkout hospedado por Mercado Pago (`init_point`), y el navegador redirige ahí.
3. El cliente paga en la interfaz de Mercado Pago (tarjeta, OXXO, transferencia, etc., según lo que tengas habilitado en tu cuenta).
4. Mercado Pago redirige de vuelta a `/comprar/gracias.html?pago=<id>`, que hace **polling** a `GET /api/payments/status/:id` cada pocos segundos hasta ver `status: "approved"`.
5. En paralelo (normalmente unos segundos antes o después de que el cliente vuelva), Mercado Pago llama a `POST /api/payments/webhook`. El servidor:
   - Vuelve a consultar el pago **directamente contra la API de Mercado Pago** (`getPayment()`) — nunca confía en el contenido del webhook a ciegas, porque cualquiera podría intentar llamar a esa URL con un payload falso.
   - Si el estado real es `approved`: busca o crea el cliente por correo, genera una contraseña si es nuevo, y crea o extiende la licencia (`extendOrCreateLicenseForPayment()` en `lib/licenses.js`) por 30 o 365 días.
   - Es **idempotente**: si Mercado Pago reintenta la notificación (les pasa seguido), el pago ya tiene `processedAt` marcado y no se duplica la licencia ni se regenera la contraseña.
6. La página de "gracias" muestra la licencia activa y, si es una cuenta nueva, la contraseña temporal **una sola vez** (igual que cuando el admin crea una licencia a mano).

## 3. Configuración necesaria

### 3.1 Obtener credenciales de Mercado Pago

1. Crea una cuenta de Mercado Pago (o usa la de tu negocio) en [mercadopago.com](https://www.mercadopago.com.mx) (el dominio depende de tu país).
2. Entra a tu [panel de desarrolladores](https://www.mercadopago.com.mx/developers/panel) → **Tus integraciones** → crea una aplicación.
3. En **Credenciales de producción**, copia el **Access Token** (empieza con `APP_USR-...`). Para pruebas, usa las **Credenciales de prueba** (empiezan igual pero son de sandbox) mientras no estés listo para cobrar de verdad.

### 3.2 Variables de entorno

| Variable | Obligatoria | Descripción |
|---|---|---|
| `MP_ACCESS_TOKEN` | Sí | Access Token de Mercado Pago (prueba o producción). |
| `MP_CURRENCY` | No (default `MXN`) | Debe coincidir con el país de tu cuenta de Mercado Pago: `MXN`, `ARS`, `COP`, `CLP`, `PEN`, `UYU`, `BRL`, etc. |
| `PUBLIC_BASE_URL` | Sí en producción | URL pública de este servidor (ej. `https://wamaster-asthi-web.onrender.com`), sin slash final. Se usa para las `back_urls` y el `notification_url` que se le pasan a Mercado Pago — **tienen que ser alcanzables desde internet**, no `localhost`. |

### 3.3 Probar en local

Mercado Pago no puede llamar a `http://localhost:4000/api/payments/webhook` desde sus servidores. Para probar el flujo completo en tu máquina, usa un túnel público, por ejemplo [ngrok](https://ngrok.com):

```bash
ngrok http 4000
```

Copia la URL `https://algo.ngrok-free.app` que te da, y arranca el servidor con:

```bash
MP_ACCESS_TOKEN=TEST-... PUBLIC_BASE_URL=https://algo.ngrok-free.app node server.js
```

Usa las [tarjetas de prueba de Mercado Pago](https://www.mercadopago.com.mx/developers/es/docs/checkout-pro/additional-content/your-integrations/test/cards) para simular pagos aprobados/rechazados sin cobrar de verdad.

### 3.4 Ajustar los precios de los planes

Los precios viven en `lib/db.js` → `PLAN_DEFAULTS` (`priceMonthly`/`priceYearly` por plan, en la moneda de `MP_CURRENCY`). Edítalos ahí directamente — no hay panel de administración para precios en esta versión, a propósito (cambian poco, y así evitas exponer esa edición como superficie de ataque).

## 4. Qué NO hace este sistema (a propósito)

- No guarda datos de tarjetas: eso lo maneja Mercado Pago en su propio checkout hospedado, este servidor nunca ve el número de tarjeta.
- No cobra automáticamente al vencer — el cliente vuelve a `/comprar` cuando quiera renovar.
- No emite facturas fiscales — si las necesitas, Mercado Pago las genera desde su propio panel según tu configuración fiscal.

## 5. Seguridad del webhook

- El webhook nunca activa una licencia basándose solo en lo que llega en el `body`/query del POST — siempre reconsulta el pago contra la API de Mercado Pago con tu `MP_ACCESS_TOKEN`, que un atacante no tiene.
- Si `getPayment()` falla (red, credenciales, Mercado Pago caído) el endpoint responde `500` a propósito, para que Mercado Pago reintente la notificación más tarde en vez de darla por perdida.
- El procesamiento es idempotente (`payment.processedAt`), así que reintentos del webhook nunca duplican una licencia ni generan una segunda contraseña temporal.
