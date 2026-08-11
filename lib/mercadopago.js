/**
 * mercadopago.js
 * ---------------------------------------------------------------------------
 * Integración con la API REST de Mercado Pago (Checkout Pro) usando
 * `fetch` nativo — sin el SDK oficial de npm, para mantener el proyecto sin
 * dependencias externas. Dos llamadas nada más:
 *
 *   1. createPreference() — crea una "preferencia de pago" (un checkout
 *      hospedado por Mercado Pago) para un plan/período/cliente concreto.
 *      Devuelve la URL a la que hay que redirigir al comprador.
 *   2. getPayment() — consulta el estado real de un pago por su ID. SIEMPRE
 *      se usa para confirmar un pago (nunca se confía ciegamente en el
 *      contenido del webhook, que solo avisa "algo pasó con el pago X" — hay
 *      que ir a preguntarle a Mercado Pago qué fue exactamente).
 *
 * Modelo de cobro: pago único por período (30 o 365 días), NO suscripción
 * recurrente de Mercado Pago (Preapproval). El cliente paga una vez, la
 * licencia se activa/extiende esa cantidad de días, y debe volver a pagar
 * manualmente cuando esté por vencer — ver docs/PAGOS.md.
 * ---------------------------------------------------------------------------
 */

const MP_API_BASE = 'https://api.mercadopago.com';

function getAccessToken() {
  const token = process.env.MP_ACCESS_TOKEN;
  if (!token) {
    throw new Error(
      'Falta configurar la variable de entorno MP_ACCESS_TOKEN con tu Access Token de Mercado Pago. Ver docs/PAGOS.md.'
    );
  }
  return token;
}

/**
 * Crea una preferencia de pago (Checkout Pro).
 * @param {{
 *   title: string,
 *   quantity: number,
 *   unitPrice: number,
 *   currency: string,
 *   externalReference: string,
 *   payerEmail: string,
 *   successUrl: string,
 *   failureUrl: string,
 *   pendingUrl: string,
 *   notificationUrl: string,
 * }} params
 * @returns {Promise<{id: string, initPoint: string}>}
 */
export async function createPreference(params) {
  const {
    title, quantity, unitPrice, currency, externalReference,
    payerEmail, successUrl, failureUrl, pendingUrl, notificationUrl,
  } = params;

  const body = {
    items: [
      {
        title,
        quantity,
        unit_price: unitPrice,
        currency_id: currency,
      },
    ],
    payer: payerEmail ? { email: payerEmail } : undefined,
    external_reference: externalReference,
    back_urls: {
      success: successUrl,
      failure: failureUrl,
      pending: pendingUrl,
    },
    auto_return: 'approved',
    notification_url: notificationUrl,
  };

  const res = await fetch(`${MP_API_BASE}/checkout/preferences`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getAccessToken()}`,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data?.message || data?.error || `Mercado Pago respondió ${res.status} al crear la preferencia.`;
    throw new Error(message);
  }

  return { id: data.id, initPoint: data.init_point };
}

/**
 * Consulta el estado real de un pago por su ID (nunca confiar solo en el
 * payload del webhook — siempre reconfirmar contra la API).
 * @param {string} paymentId
 * @returns {Promise<{id: string, status: string, externalReference: string, transactionAmount: number, payerEmail: string}>}
 */
export async function getPayment(paymentId) {
  const res = await fetch(`${MP_API_BASE}/v1/payments/${encodeURIComponent(paymentId)}`, {
    headers: { Authorization: `Bearer ${getAccessToken()}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data?.message || `Mercado Pago respondió ${res.status} al consultar el pago ${paymentId}.`;
    throw new Error(message);
  }
  return {
    id: String(data.id),
    status: data.status, // 'approved' | 'pending' | 'rejected' | 'cancelled' | 'refunded' | ...
    externalReference: data.external_reference,
    transactionAmount: data.transaction_amount,
    payerEmail: data.payer?.email || null,
  };
}
