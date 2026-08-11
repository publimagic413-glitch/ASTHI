/**
 * admin.js — lógica del panel de administrador. Sin frameworks, DOM directo.
 */

const loginView = document.getElementById('loginView');
const appView = document.getElementById('appView');
const loginForm = document.getElementById('loginForm');
const loginError = document.getElementById('loginError');
const adminEmailLabel = document.getElementById('adminEmailLabel');
const btnLogout = document.getElementById('btnLogout');

const licensesTableBody = document.getElementById('licensesTableBody');
const paymentsTableBody = document.getElementById('paymentsTableBody');

const modalBackdrop = document.getElementById('modalBackdrop');
const modalTitle = document.getElementById('modalTitle');
const licenseForm = document.getElementById('licenseForm');
const modalError = document.getElementById('modalError');
const planIdSelect = document.getElementById('planId');
const customerPasswordField = document.getElementById('customerPasswordField');

let plans = {};

async function api(path, options = {}) {
  const res = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

// ---------------------------------------------------------------------------
// Sesión
// ---------------------------------------------------------------------------
async function checkSession() {
  try {
    const data = await api('/api/admin/me');
    if (!data.email) throw new Error('no autenticado');
    showApp(data.email);
  } catch {
    showLogin();
  }
}

function showLogin() {
  loginView.style.display = 'block';
  appView.style.display = 'none';
  btnLogout.style.display = 'none';
}

async function showApp(email) {
  loginView.style.display = 'none';
  appView.style.display = 'block';
  btnLogout.style.display = 'inline-block';
  adminEmailLabel.textContent = email;
  await loadPlans();
  await loadLicenses();
  await loadPayments();
}

loginForm.addEventListener('submit', async (evt) => {
  evt.preventDefault();
  loginError.style.display = 'none';
  try {
    const data = await api('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({
        email: document.getElementById('loginEmail').value,
        password: document.getElementById('loginPassword').value,
      }),
    });
    showApp(data.email);
  } catch (err) {
    loginError.textContent = err.message;
    loginError.style.display = 'block';
  }
});

btnLogout.addEventListener('click', async () => {
  await api('/api/admin/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

// ---------------------------------------------------------------------------
// Pestañas
// ---------------------------------------------------------------------------
document.querySelectorAll('.admin-tabs button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.admin-tabs button').forEach((b) => b.classList.toggle('is-active', b === btn));
    document.querySelectorAll('.admin-panel').forEach((p) => p.classList.toggle('is-active', p.id === `panel${btn.dataset.panel[0].toUpperCase()}${btn.dataset.panel.slice(1)}`));
  });
});

// ---------------------------------------------------------------------------
// Licencias
// ---------------------------------------------------------------------------
async function loadPlans() {
  const data = await api('/api/admin/plans');
  plans = data.plans;
  planIdSelect.innerHTML = Object.entries(plans).map(([id, p]) => `<option value="${id}">${p.label}</option>`).join('');
}

const statusLabelMap = { active: 'Activa', suspended: 'Suspendida', expired: 'Vencida' };

async function loadLicenses() {
  const data = await api('/api/admin/licenses');
  licensesTableBody.innerHTML = data.licenses.map((l) => `
    <tr>
      <td><code>${l.key}</code></td>
      <td>${escapeHtml(l.customer?.name || '—')}</td>
      <td>${escapeHtml(l.customer?.email || '—')}</td>
      <td>${l.planLabel}</td>
      <td><span class="badge badge--${l.status}">${statusLabelMap[l.status] || l.status}</span></td>
      <td>${l.expiresAt ? new Date(l.expiresAt).toLocaleDateString('es-MX') : 'Sin vencimiento'}</td>
      <td>${l.devicesCount}/${l.maxActivations}</td>
      <td class="table-actions">
        <button type="button" class="btn btn-secondary" data-action="edit" data-id="${l.id}">Editar</button>
        <button type="button" class="btn btn-secondary" data-action="toggle" data-id="${l.id}" data-status="${l.status}">${l.status === 'suspended' ? 'Reactivar' : 'Suspender'}</button>
        <button type="button" class="btn btn-secondary" data-action="reset-password" data-customer="${l.customer?.id || ''}">Restablecer contraseña</button>
        <button type="button" class="btn btn-secondary" data-action="delete" data-id="${l.id}">Eliminar</button>
      </td>
    </tr>`).join('') || '<tr><td colspan="8" class="muted">Sin licencias todavía.</td></tr>';

  licensesTableBody.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => handleRowAction(btn.dataset.action, btn.dataset, data.licenses));
  });
}

async function handleRowAction(action, dataset, licenses) {
  if (action === 'edit') {
    const license = licenses.find((l) => l.id === dataset.id);
    openModal(license);
  } else if (action === 'toggle') {
    const newStatus = dataset.status === 'suspended' ? 'active' : 'suspended';
    await api(`/api/admin/licenses/${dataset.id}`, { method: 'PATCH', body: JSON.stringify({ status: newStatus }) });
    await loadLicenses();
  } else if (action === 'delete') {
    if (!confirm('¿Eliminar esta licencia? No se puede deshacer.')) return;
    await api(`/api/admin/licenses/${dataset.id}`, { method: 'DELETE' });
    await loadLicenses();
  } else if (action === 'reset-password') {
    if (!dataset.customer) return alert('Este cliente no tiene id válido.');
    if (!confirm('¿Restablecer la contraseña de este cliente? La anterior dejará de funcionar de inmediato.')) return;
    const data = await api(`/api/admin/customers/${dataset.customer}/reset-password`, { method: 'POST' });
    alert(`Nueva contraseña temporal: ${data.temporaryPassword}\n\nCópiala ahora, no se volverá a mostrar.`);
  }
}

function openModal(license) {
  modalError.style.display = 'none';
  licenseForm.reset();
  document.getElementById('editLicenseId').value = license ? license.id : '';
  modalTitle.textContent = license ? 'Editar licencia' : 'Nueva licencia';
  customerPasswordField.style.display = license ? 'none' : 'flex';

  if (license) {
    document.getElementById('customerName').value = license.customer?.name || '';
    document.getElementById('customerEmail').value = license.customer?.email || '';
    document.getElementById('customerName').disabled = true;
    document.getElementById('customerEmail').disabled = true;
    document.getElementById('planId').value = license.planId;
    document.getElementById('expiresAt').value = license.expiresAt ? new Date(license.expiresAt).toISOString().slice(0, 10) : '';
    document.getElementById('notes').value = license.notes || '';
  } else {
    document.getElementById('customerName').disabled = false;
    document.getElementById('customerEmail').disabled = false;
  }
  modalBackdrop.classList.add('is-open');
}

document.getElementById('btnNewLicense').addEventListener('click', () => openModal(null));
document.getElementById('btnCancelModal').addEventListener('click', () => modalBackdrop.classList.remove('is-open'));

licenseForm.addEventListener('submit', async (evt) => {
  evt.preventDefault();
  modalError.style.display = 'none';
  const editId = document.getElementById('editLicenseId').value;
  const expiresAtRaw = document.getElementById('expiresAt').value;
  const expiresAt = expiresAtRaw ? new Date(expiresAtRaw + 'T00:00:00').getTime() : null;

  try {
    if (editId) {
      await api(`/api/admin/licenses/${editId}`, {
        method: 'PATCH',
        body: JSON.stringify({ planId: planIdSelect.value, expiresAt, notes: document.getElementById('notes').value }),
      });
    } else {
      const data = await api('/api/admin/licenses', {
        method: 'POST',
        body: JSON.stringify({
          customerName: document.getElementById('customerName').value,
          customerEmail: document.getElementById('customerEmail').value,
          customerPassword: document.getElementById('customerPassword').value || undefined,
          planId: planIdSelect.value,
          expiresAt,
          notes: document.getElementById('notes').value,
        }),
      });
      if (data.temporaryPassword) {
        alert(`Contraseña del cliente: ${data.temporaryPassword}\n\nCópiala ahora y compártesela — no se volverá a mostrar.`);
      }
    }
    modalBackdrop.classList.remove('is-open');
    await loadLicenses();
  } catch (err) {
    modalError.textContent = err.message;
    modalError.style.display = 'block';
  }
});

// ---------------------------------------------------------------------------
// Pagos
// ---------------------------------------------------------------------------
const paymentStatusLabel = { approved: 'Aprobado', pending: 'Pendiente', in_process: 'En proceso', rejected: 'Rechazado', cancelled: 'Cancelado' };

async function loadPayments() {
  try {
    const data = await api('/api/admin/payments');
    paymentsTableBody.innerHTML = data.payments.map((p) => `
      <tr>
        <td>${new Date(p.createdAt).toLocaleString('es-MX')}</td>
        <td>${escapeHtml(p.name)} (${escapeHtml(p.email)})</td>
        <td>${plans[p.planId]?.label || p.planId}</td>
        <td>${p.period === 'yearly' ? '1 año' : '1 mes'}</td>
        <td>$${p.amount} ${p.currency}</td>
        <td><span class="badge ${p.status === 'approved' ? 'badge--active' : 'badge--pending'}">${paymentStatusLabel[p.status] || p.status}</span></td>
      </tr>`).join('') || '<tr><td colspan="6" class="muted">Sin pagos todavía.</td></tr>';
  } catch {
    paymentsTableBody.innerHTML = '<tr><td colspan="6" class="muted">No se pudo cargar el historial de pagos.</td></tr>';
  }
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

checkSession();
