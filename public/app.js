import { CONFIG } from './config.js';
import { http, getToken, setToken, clearToken, beginLogin, completeRedirect, resolveParty, AuthExpired, ApiError } from './api.js';
import { endpoints } from './endpoints.js';
import { lineChart, SERIES } from './charts.js';

// ---------------------------------------------------------------- helpers
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtCache = {};
const nf = (unit, digits) => {
  const k = unit + digits;
  if (!fmtCache[k]) {
    try { fmtCache[k] = new Intl.NumberFormat('en-US', { style: 'currency', currency: unit, maximumFractionDigits: digits, minimumFractionDigits: digits }); }
    catch { fmtCache[k] = { format: (n) => `${n.toFixed(digits)} ${unit}` }; }
  }
  return fmtCache[k];
};
const money = (n, unit = state.unit) => (n == null ? '—' : nf(unit, Math.abs(n) >= 1000 ? 0 : 2).format(n));
const compactMoney = (unit = state.unit) => (v) => {
  const a = Math.abs(v);
  const s = a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${(a / 1e3).toFixed(0)}k` : a.toFixed(0);
  return (v < 0 ? '−' : '') + nf(unit, 0).format(0).replace(/0/, s);
};
const signed = (n, unit) => (n == null ? '—' : `<span class="${n >= 0 ? 'pos' : 'neg'}">${n >= 0 ? '+' : '−'}${money(Math.abs(n), unit)}</span>`);
const pct = (n) => (n == null ? '—' : `${Number(n).toFixed(1).replace(/\.0$/, '')}%`);
const fmtDate = (iso, o = { month: 'short', day: 'numeric', year: 'numeric' }) => (iso ? new Date(iso + 'T00:00:00').toLocaleDateString('en-US', o) : '—');
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (iso, d) => { const x = new Date(iso + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + d); return x.toISOString().slice(0, 10); };
const pretty = (t) => String(t ?? '').replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
// Tax-deferred asset types, as the spec lists them under taxRate; only these are taxed on the way out and carry an RMD.
const TAX_DEFERRED = new Set(['IRA', 'SEP_IRA', 'SIMPLE_IRA', 'SARSEP', 'KEOGH', '_401A', '_401K', '_403B', '_457B', 'PROFIT_SHARING_PLAN', 'PENSION', 'RETIREMENT',
  'RRSP', 'RRIF', 'LIRA', 'LRSP', 'LIF', 'LRIF', 'RLIF', 'PRIF', 'SIPP', 'FIXED_ANNUITY', 'VARIABLE_ANNUITY', 'OTHER_ANNUITY']);
// RMDs begin at 72 if born before 1951, 73 if born before 1960, 75 after.
const rmdAge = (birthDate) => { const y = Number(birthDate.slice(0, 4)); return y < 1951 ? 72 : y < 1960 ? 73 : 75; };
const flowLabel = (t) => (t === 'RMD' ? 'RMD' : pretty(t));
const numOrNull = (v) => (v === '' || v == null ? null : Number(v));
const parseList = (s) => String(s || '').split(/[,\s]+/).filter(Boolean).map(Number).filter((n) => !Number.isNaN(n));

function describeError(e) {
  if (e instanceof ApiError) {
    const hint = {
      conflict: 'It changed since it was loaded — it has been reloaded; try again.',
      in_use: 'Change the scenarios that depend on it first.',
      forbidden: 'That belongs to a party outside your hierarchy.',
      validation_failed: 'The API rejected the input.',
    }[e.code];
    return `<strong>${esc(e.path)}</strong> → ${e.status}${e.code ? ` <code>${esc(e.code)}</code>` : ''}<br>${e.messages.map(esc).join('<br>') || 'No details in the response.'}${hint ? `<br><span class="muted">${hint}</span>` : ''}`;
  }
  return esc(e.message || String(e));
}
function showErr(scope, e) {
  const box = scope.classList?.contains('error') ? scope : $(':scope > .error', scope) || $('.error', scope);
  if (e instanceof AuthExpired) return showConnect('Your session expired. Please sign in again.');
  console.error(e);
  box.innerHTML = describeError(e); box.hidden = false;
}
const clearErr = (scope) => { $$(':scope > .error, .card > .error', scope).forEach((b) => { b.hidden = true; }); };

// ------------------------------------------------------------------ state
const state = {
  party: null, perspective: 'SINGLETON', unit: 'USD', tab: 'forecast',
  accounts: [], accountsById: new Map(), scenarios: [], persons: [], merchants: [], recurrences: [], planned: [],
  selectedScenario: null, comparePicks: [], loaded: new Set(),
  lastForecast: null,
};
let api;
const accountName = (id) => state.accountsById.get(id)?.name || id?.slice(0, 8) || '—';
const cashAndInvestment = () => state.accounts.filter((a) => a.accountType === 'ASSET' || a.accountType === 'LIABILITY');

// ============================================================ Cash forecast
async function loadForecast() {
  const tab = $('#tab-forecast'); clearErr(tab);
  const days = Number($('#fc-days').value);
  const step = days <= 90 ? 1 : 7;
  $('#fc-chart').innerHTML = '<div class="placeholder">Projecting…</div>';
  try {
    const fc = await api.forecast({ days, step, unitType: state.unit, baseline: $('#fc-baseline').checked });
    state.lastForecast = fc;
    renderForecast(fc);
  } catch (e) { $('#fc-chart').innerHTML = ''; showErr(tab, e); }
}

function netSeries(fc) {
  if (fc.convertedNetPosition?.points?.length) return { unit: fc.convertedNetPosition.unitType, points: fc.convertedNetPosition.points };
  const np = fc.netPositions.find((n) => n.unitType === state.unit) || fc.netPositions[0];
  return np ? { unit: np.unitType, points: np.points } : { unit: state.unit, points: [] };
}

function renderForecast(fc) {
  $('#fc-range').textContent = `${fmtDate(fc.fromDate)} → ${fmtDate(fc.toDate)} · sampled every ${fc.stepDays} day${fc.stepDays > 1 ? 's' : ''}`;
  const net = netSeries(fc);
  const first = net.points[0], last = net.points[net.points.length - 1];
  const low = net.points.reduce((m, p) => (p.balance < m.balance ? p : m), first || { balance: 0 });
  const alerts = fc.accounts.filter((a) => a.firstBelowMinimumDate || (a.accountType === 'ASSET' && a.firstNegativeDate));
  const topUp = fc.accounts.reduce((s, a) => s + (a.topUpRequired || 0), 0);
  $('#fc-tiles').innerHTML = [
    tile('Net position today', money(first?.balance, net.unit)),
    tile(`On ${fmtDate(fc.toDate, { month: 'short', day: 'numeric' })}`, money(last?.balance, net.unit), first && last ? signed(last.balance - first.balance, net.unit) : ''),
    tile('Lowest point', money(low?.balance, net.unit), low ? fmtDate(low.date) : ''),
    tile('Accounts at risk', String(alerts.length), alerts.length ? `top-ups needed: ${money(topUp)}` : 'every floor holds'),
  ].join('');

  const unconverted = fc.convertedNetPosition?.unconvertedUnitTypes || [];
  lineChart($('#fc-chart'), [{ name: 'Net position', points: net.points }], {
    fmt: (v) => money(v, net.unit), compact: compactMoney(net.unit), zeroLine: true,
    markers: alerts.map((a) => ({ date: a.firstBelowMinimumDate || a.firstNegativeDate, label: a.name })).slice(0, 4),
  });
  if (unconverted.length) $('#fc-chart').insertAdjacentHTML('beforeend', `<p class="muted">No exchange rate for ${unconverted.map(esc).join(', ')} — those balances are left out of this line.</p>`);
  if (fc.baselines?.length) $('#fc-chart').insertAdjacentHTML('beforeend', `<p class="muted">Includes everyday spending spread across each month: ${fc.baselines.map((b) => `${esc(b.accountName)} ${signed(b.monthlyNet, b.unitType)}/mo`).join(' · ')}</p>`);

  const rows = [...fc.accounts].sort((a, b) => (a.accountType === b.accountType ? Math.abs(b.opening) - Math.abs(a.opening) : a.accountType === 'ASSET' ? -1 : 1));
  $('#fc-accounts').innerHTML = `<thead><tr><th>Account</th><th class="num">Today</th><th class="num">${fmtDate(fc.toDate, { month: 'short', day: 'numeric' })}</th><th class="num">Low</th><th>Watch</th></tr></thead><tbody>` +
    rows.map((a) => `<tr class="clickable" data-id="${a.id}"><td>${esc(a.name)}<div class="sub">${pretty(a.accountType)} · ${a.unitType}${a.accountType === 'LIABILITY' ? ' · owed' : ''}</div></td>` +
      `<td class="num">${money(a.opening, a.unitType)}</td><td class="num">${money(a.closing, a.unitType)}</td>` +
      `<td class="num">${money(a.low?.balance, a.unitType)}<div class="sub">${fmtDate(a.low?.date, { month: 'short', day: 'numeric' })}</div></td>` +
      `<td>${accountAlert(a)}</td></tr>`).join('') + '</tbody>';
  $$('#fc-accounts tr.clickable').forEach((tr) => tr.addEventListener('click', () => {
    $$('#fc-accounts tr').forEach((r) => r.classList.toggle('is-selected', r === tr));
    const a = fc.accounts.find((x) => x.id === tr.dataset.id);
    const host = $('#fc-account-chart'); host.hidden = false;
    lineChart(host, [{ name: a.name, points: a.points }], {
      fmt: (v) => money(v, a.unitType), compact: compactMoney(a.unitType), height: 200, zeroLine: true, includeZero: a.accountType === 'ASSET' && a.low?.balance < 0,
      markers: a.firstBelowMinimumDate ? [{ date: a.firstBelowMinimumDate, label: `below ${money(a.minimumBalance, a.unitType)} floor` }] : [],
    });
  }));
  if (!$('#wi-rows').children.length) addWhatIfRow();
}

function accountAlert(a) {
  if (a.firstBelowMinimumDate) {
    return `<span class="badge bad">Below floor ${fmtDate(a.firstBelowMinimumDate, { month: 'short', day: 'numeric' })}</span>` +
      (a.topUpRequired != null ? `<div class="sub">move in ${money(a.topUpRequired, a.unitType)} before then to stay above ${money(a.minimumBalance, a.unitType)}</div>` : '');
  }
  if (a.firstNegativeDate) return a.accountType === 'ASSET'
    ? `<span class="badge bad">Overdrawn ${fmtDate(a.firstNegativeDate, { month: 'short', day: 'numeric' })}</span>`
    : `<span class="badge plain">Credit balance ${fmtDate(a.firstNegativeDate, { month: 'short', day: 'numeric' })}</span>`;
  if (a.minimumBalance != null) return `<span class="badge good">Floor holds</span><div class="sub">min ${money(a.minimumBalance, a.unitType)}</div>`;
  return '';
}
const tile = (k, v, sub = '') => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="sub">${sub}</div></div>`;

function accountOptions(selected, { types = ['ASSET', 'LIABILITY'], blank = null, filter = () => true } = {}) {
  const groups = types.map((t) => {
    const opts = state.accounts.filter((a) => a.accountType === t && (filter(a) || a.id === selected))
      .map((a) => `<option value="${a.id}"${a.id === selected ? ' selected' : ''}>${esc(a.name)}</option>`).join('');
    return opts ? `<optgroup label="${pretty(t)}">${opts}</optgroup>` : '';
  }).join('');
  return (blank != null ? `<option value="">${esc(blank)}</option>` : '') + groups;
}

function addWhatIfRow() {
  const d = document.createElement('div');
  d.className = 'form-grid wi-row';
  d.innerHTML = `<label>What <input name="label" placeholder="New laptop" /></label>
    <label>Account <select name="accountId">${accountOptions(null)}</select></label>
    <label>Amount (− is money out) <input name="amount" type="number" step="0.01" value="-1500" /></label>
    <label>On <input name="startDate" type="date" value="${addDays(today(), 7)}" /></label>
    <div class="row-actions"><button type="button" class="link-btn sm">Remove</button></div>`;
  $('button', d).addEventListener('click', () => d.remove());
  $('#wi-rows').appendChild(d);
}

async function runWhatIf() {
  const card = $('#wi-run').closest('.card'); clearErr(card);
  const flows = $$('.wi-row').map((r) => ({
    flowType: 'ONE_TIME',
    accountId: $('[name=accountId]', r).value,
    label: $('[name=label]', r).value || null,
    amount: numOrNull($('[name=amount]', r).value),
    startDate: $('[name=startDate]', r).value || null,
    fallbackAccountIds: [],
  })).filter((f) => f.accountId && f.amount != null);
  if (!flows.length) return;
  const days = Number($('#fc-days').value), step = days <= 90 ? 1 : 7;
  $('#wi-result').innerHTML = '<div class="placeholder">Running…</div>';
  try {
    const [base, wi] = await Promise.all([
      state.lastForecast ? Promise.resolve(state.lastForecast) : api.forecast({ days, step, unitType: state.unit, baseline: $('#fc-baseline').checked }),
      api.forecastWhatIf({ days, step, flows, unitType: state.unit }),
    ]);
    const baseNet = netSeries(base), wiNet = netSeries(wi);
    const touched = new Set(flows.map((f) => f.accountId));
    const rows = wi.accounts.filter((a) => touched.has(a.id) || a.firstBelowMinimumDate || (a.accountType === 'ASSET' && a.firstNegativeDate));
    const baseById = new Map(base.accounts.map((a) => [a.id, a]));
    $('#wi-result').innerHTML = `<h3>Net position (${esc(wiNet.unit)})</h3><figure class="chart" id="wi-chart"></figure>
      <h3>Accounts affected</h3><div class="table-scroll"><table class="data"><thead><tr><th>Account</th><th class="num">Low before</th><th class="num">Low after</th><th>Watch after</th></tr></thead><tbody>${
      rows.map((a) => { const b = baseById.get(a.id); return `<tr><td>${esc(a.name)}</td><td class="num">${money(b?.low?.balance, a.unitType)}</td><td class="num">${money(a.low?.balance, a.unitType)}<div class="sub">${fmtDate(a.low?.date, { month: 'short', day: 'numeric' })}</div></td><td>${accountAlert(a) || '<span class="badge good">OK</span>'}</td></tr>`; }).join('') || '<tr><td colspan="4" class="muted">No account changes.</td></tr>'
    }</tbody></table></div>`;
    lineChart($('#wi-chart'), [
      { name: 'As things stand', points: baseNet.points, dashed: true, color: 'var(--text-muted)' },
      { name: 'With these flows', points: wiNet.points },
    ], { fmt: (v) => money(v, wiNet.unit), compact: compactMoney(wiNet.unit), height: 220, zeroLine: true });
  } catch (e) { $('#wi-result').innerHTML = ''; showErr(card, e); }
}

// ============================================================ Upcoming
async function loadUpcoming() {
  const tab = $('#tab-upcoming'); clearErr(tab);
  $('#up-table').innerHTML = '<tr><td class="placeholder">Loading…</td></tr>';
  const [up, audit, planned, decl, recs] = await Promise.allSettled([
    api.upcoming({ days: Number($('#up-days').value) }), api.audit(), api.plannedTransactions(), api.declarations(), api.recurrences(),
  ]);
  if (up.status === 'fulfilled') renderUpcoming(up.value); else { $('#up-table').innerHTML = ''; showErr(tab, up.reason); }
  if (audit.status === 'fulfilled') renderAudit(audit.value); else { $('#audit').innerHTML = `<div class="error">${describeError(audit.reason)}</div>`; }
  if (planned.status === 'fulfilled') renderPlanned(planned.value.plannedTransactions); else $('#planned').innerHTML = `<tbody><tr><td><div class="error">${describeError(planned.reason)}</div></td></tr></tbody>`;
  if (decl.status === 'fulfilled') renderDeclarations(decl.value.declarations); else $('#declarations').innerHTML = `<tbody><tr><td><div class="error">${describeError(decl.reason)}</div></td></tr></tbody>`;
  if (recs.status === 'fulfilled') state.recurrences = recs.value.recurrences || [];
  fillDeclareForm();
}

function renderUpcoming(up) {
  const items = [...up.items].sort((a, b) => a.date.localeCompare(b.date));
  state.merchants = [...new Set(items.map((i) => i.merchantName).filter(Boolean))];
  $('#up-summary').innerHTML = `${items.length} items · ${fmtDate(up.fromDate)} → ${fmtDate(up.toDate)}`;
  let lastDate = null;
  $('#up-table').innerHTML = items.length ? `<thead><tr><th>What</th><th>Account</th><th class="num">Amount</th><th>Detail</th></tr></thead><tbody>` + items.map((i) => {
    const head = i.date !== lastDate ? `<tr class="group"><td colspan="4">${fmtDate(i.date, { weekday: 'short', month: 'short', day: 'numeric' })}${i.date < today() ? ' · <span class="badge warn">expected, not seen yet</span>' : ''}</td></tr>` : '';
    lastDate = i.date;
    const detail = i.kind === 'LOAN_PAYMENT'
      ? `payment due ${money(i.paymentDue, i.unitType)} · interest ${money(i.interest, i.unitType)}${i.escrow ? ` · escrow ${money(i.escrow, i.unitType)}` : ''}`
      : i.kind === 'PLANNED' ? '<span class="badge plain">planned</span>'
      : [pretty(i.frequency), i.recurrence && pretty(i.recurrence), i.source === 'DECLARED' ? '<span class="badge plain">declared</span>' : null, i.windowDays != null && `±${Math.round(i.windowDays)}d`, i.confidence != null && `${Math.round(i.confidence * 100)}% confident`].filter(Boolean).join(' · ');
    return `${head}<tr><td>${esc(i.label || i.merchantName || (i.kind === 'LOAN_PAYMENT' ? 'Loan payment' : '—'))}</td><td>${esc(i.accountName)}</td><td class="num">${signed(cashDirection(i), i.unitType)}</td><td class="sub">${detail}</td></tr>`;
  }).join('') + '</tbody>' : '<tr><td class="muted">Nothing expected in this window.</td></tr>';
}

// Upcoming amounts are in the account's own sign convention (positive = more held in an asset or
// more owed on a liability), and a loan payment's amount is its principal alone. Show what leaves
// or reaches the household instead: the full payment due as money out, a card charge as money out.
function cashDirection(i) {
  if (i.kind === 'LOAN_PAYMENT') return -(i.paymentDue ?? Math.abs(i.amount));
  return state.accountsById.get(i.accountId)?.accountType === 'LIABILITY' ? -i.amount : i.amount;
}

// ---- planned transactions: known future money movements every forecast carries
let editingPlanned = null;
function renderPlanned(list) {
  state.planned = list;
  const repeat = (p) => (p.cadenceMonths ? `${cadence(p.cadenceMonths)}${p.endDate ? ` until ${fmtDate(p.endDate)}` : ''}` : 'once');
  $('#planned').innerHTML = list.length
    ? `<thead><tr><th>What</th><th>From → To</th><th class="num">Amount</th><th>When</th><th></th></tr></thead><tbody>${list.map((p) =>
      `<tr data-id="${p.id}"><td>${esc(p.label)}</td><td>${esc(p.fromAccountName || 'outside the books')} → ${esc(p.toAccountName || 'outside the books')}</td><td class="num">${money(p.amount, p.unitType)}</td>
       <td>${fmtDate(p.date)}<div class="sub">${repeat(p)}${p.date < today() && !p.cadenceMonths ? ' · in the past, not projected' : ''}</div></td>
       <td class="num"><button class="link-btn sm" data-act="edit">Edit</button> · <button class="link-btn sm" data-act="del">Remove</button></td></tr>`).join('')}</tbody>`
    : '<tbody><tr><td class="muted">Nothing planned. Add a bill, bonus or transfer you know is coming.</td></tr></tbody>';
  $$('#planned tr[data-id]').forEach((tr) => {
    const p = list.find((x) => x.id === tr.dataset.id);
    $('[data-act=edit]', tr).addEventListener('click', () => editPlanned(p));
    $('[data-act=del]', tr).addEventListener('click', async () => {
      if (!confirm(`Remove “${p.label}”? Forecasts will stop carrying it.`)) return;
      try { await api.deletePlanned(p.id, p.version); state.loaded.delete('forecast'); state.lastForecast = null; loadUpcoming(); } catch (e) { showErr($('#tab-upcoming'), e); }
    });
  });
  fillPlannedForm();
}
function fillPlannedForm() {
  const f = $('#planned-form');
  for (const n of ['fromAccountId', 'toAccountId']) {
    const cur = f[n].value;
    f[n].innerHTML = accountOptions(null, { blank: 'Outside the books' });
    f[n].value = cur;
  }
  if (!f.date.value) f.date.value = addDays(today(), 14);
}
function editPlanned(p) {
  const f = $('#planned-form');
  editingPlanned = p;
  f.label.value = p.label; f.fromAccountId.value = p.fromAccountId || ''; f.toAccountId.value = p.toAccountId || '';
  f.amount.value = p.amount; f.date.value = p.date; f.cadenceMonths.value = p.cadenceMonths || ''; f.endDate.value = p.endDate || '';
  $('button[type=submit]', f).textContent = 'Save changes'; $('#planned-cancel').hidden = false;
  f.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function resetPlannedForm() {
  const f = $('#planned-form'); editingPlanned = null; f.reset(); fillPlannedForm();
  $('button[type=submit]', f).textContent = 'Add'; $('#planned-cancel').hidden = true;
}
async function savePlanned(e) {
  e.preventDefault();
  const f = e.target, tab = $('#tab-upcoming'); clearErr(tab);
  const body = {
    label: f.label.value.trim(), fromAccountId: f.fromAccountId.value || null, toAccountId: f.toAccountId.value || null,
    amount: Number(f.amount.value), date: f.date.value, cadenceMonths: numOrNull(f.cadenceMonths.value),
    endDate: f.cadenceMonths.value ? f.endDate.value || null : null,
  };
  if (!body.fromAccountId && !body.toAccountId) return showErr(tab, new Error('Choose at least one account: where the money leaves from, arrives in, or both.'));
  try {
    if (editingPlanned) await api.updatePlanned(editingPlanned.id, editingPlanned.version, body); else await api.createPlanned(body);
    resetPlannedForm(); state.loaded.delete('forecast'); state.lastForecast = null; loadUpcoming();
  } catch (err) { showErr(tab, err); if (err.code === 'conflict') { resetPlannedForm(); loadUpcoming(); } }
}

// ---- declared recurrences: the party's word that a merchant recurs
function renderDeclarations(list) {
  $('#declarations').innerHTML = list.length
    ? `<thead><tr><th>Merchant</th><th>Account</th><th>Every</th><th class="num">Amount</th><th></th></tr></thead><tbody>${list.map((d) =>
      `<tr data-id="${d.id}"><td>${esc(d.merchantName)}</td><td>${esc(d.accountName)}</td><td>${pretty(d.frequency)}</td><td class="num">${d.amount != null ? money(d.amount, d.unitType) : '<span class="muted">every charge</span>'}</td>
       <td class="num"><button class="link-btn sm">Withdraw</button></td></tr>`).join('')}</tbody>`
    : '<tbody><tr><td class="muted">No declarations — the calendar goes by what it detects.</td></tr></tbody>';
  $$('#declarations tr[data-id]').forEach((tr) => $('button', tr).addEventListener('click', async () => {
    const d = list.find((x) => x.id === tr.dataset.id);
    if (!confirm(`Withdraw the declaration for ${d.merchantName}? The calendar goes back to what it detects.`)) return;
    try { await api.withdrawDeclaration(d.id, d.version); loadUpcoming(); } catch (e) { showErr($('#tab-upcoming'), e); }
  }));
}
function fillDeclareForm() {
  const f = $('#declare-form');
  const cur = f.accountId.value;
  f.accountId.innerHTML = accountOptions(null, { blank: 'Choose…' }); f.accountId.value = cur;
  const merchants = [...new Set([...(state.recurrences || []).filter((r) => !f.accountId.value || r.accountId === f.accountId.value).map((r) => r.merchantName), ...state.merchants].filter(Boolean))];
  $('#declare-merchants').innerHTML = merchants.map((m) => `<option value="${esc(m)}">`).join('');
}
async function saveDeclaration(e) {
  e.preventDefault();
  const f = e.target, tab = $('#tab-upcoming'); clearErr(tab);
  try {
    await api.declare({ accountId: f.accountId.value, merchantName: f.merchantName.value.trim(), amount: numOrNull(f.amount.value), frequency: f.frequency.value });
    f.merchantName.value = ''; f.amount.value = ''; loadUpcoming();
  } catch (err) { showErr(tab, err); }
}

// ============================================================ This month
async function loadMonthEnd() {
  const tab = $('#tab-month'); clearErr(tab);
  if (!$('#me-month').value) $('#me-month').value = today().slice(0, 7);
  $('#me-table').innerHTML = '<tbody><tr><td class="placeholder">Projecting the month…</td></tr></tbody>';
  try { renderMonthEnd(await api.monthEnd({ date: `${$('#me-month').value}-01` })); } catch (e) { $('#me-table').innerHTML = ''; showErr(tab, e); }
}
function renderMonthEnd(m) {
  const state3 = m.postedThrough == null ? 'not begun — all projection' : m.daysRemaining === 0 ? 'over — actuals only' : `posted through ${fmtDate(m.postedThrough, { month: 'short', day: 'numeric' })}, ${m.daysRemaining} day${m.daysRemaining === 1 ? '' : 's'} to go`;
  $('#me-summary').textContent = `${fmtDate(m.month, { month: 'long', year: 'numeric' })} · ${state3} · run-rate over ${Math.round(m.monthsOfHistory)} months`;
  const tot = (type) => m.totals.filter((t) => t.accountType === type);
  const spend = tot('EXPENSE'), income = tot('REVENUE');
  $('#me-tiles').innerHTML = [
    ...income.map((t) => tile(`Income · ${t.unitType}`, money(t.projected, t.unitType), t.budgeted != null ? `budget ${money(t.budgeted, t.unitType)}` : `${money(t.actualToDate, t.unitType)} so far`)),
    ...spend.map((t) => {
      // A total's budget sums only the categories that have one, so judge over/under on those alone.
      const v = m.categories.filter((c) => c.accountType === 'EXPENSE' && c.unitType === t.unitType && c.variance != null).reduce((x, c) => x + c.variance, 0);
      return tile(`Spending · ${t.unitType}`, money(t.projected, t.unitType), t.budgeted != null ? `budgeted categories ${v >= 0 ? 'under' : 'over'} by ${money(Math.abs(v), t.unitType)}` : `${money(t.actualToDate, t.unitType)} so far`);
    }),
  ].join('');
  const rows = [...m.categories].sort((a, b) => (a.accountType === b.accountType ? b.projected - a.projected : a.accountType === 'REVENUE' ? -1 : 1));
  // variance = budgeted − projected, both positive: on an expense + is money left unspent and − overspending;
  // on a revenue + is income still short of the budget and − income beyond it.
  const varCell = (c) => {
    if (c.variance == null) return '<span class="muted">no budget</span>';
    if (Math.abs(c.variance) < 0.005) return '<span class="muted">on budget</span>';
    const good = c.accountType === 'EXPENSE' ? c.variance > 0 : c.variance < 0;
    const word = c.accountType === 'EXPENSE' ? (c.variance > 0 ? 'under' : 'over') : (c.variance > 0 ? 'short' : 'ahead');
    return `<span class="${good ? 'pos' : 'neg'}">${word} ${money(Math.abs(c.variance), c.unitType)}</span>`;
  };
  let lastType = null;
  $('#me-table').innerHTML = rows.length ? `<thead><tr><th>Category</th><th class="num">So far</th><th class="num">Known still to come</th><th class="num">Everyday rest</th><th class="num">Month end</th><th class="num">Budget</th><th>Variance</th></tr></thead><tbody>${rows.map((c) => {
    const head = c.accountType !== lastType ? `<tr class="group"><td colspan="7">${c.accountType === 'REVENUE' ? 'Income' : 'Spending'}</td></tr>` : '';
    lastType = c.accountType;
    return `${head}<tr><td>${esc(c.accountName)}${c.unitType !== state.unit ? ` <span class="sub">${c.unitType}</span>` : ''}</td><td class="num">${money(c.actualToDate, c.unitType)}</td><td class="num">${money(c.remainingKnown, c.unitType)}</td><td class="num">${money(c.remainingEveryday, c.unitType)}</td><td class="num"><b>${money(c.projected, c.unitType)}</b></td><td class="num">${c.budgeted != null ? money(c.budgeted, c.unitType) : '—'}</td><td>${varCell(c)}</td></tr>`;
  }).join('')}</tbody>` : '<tbody><tr><td class="muted">Nothing posted, coming or budgeted this month.</td></tr></tbody>';
}

function renderAudit(a) {
  if (!a.findings.length) { $('#audit').innerHTML = '<p class="muted">No findings — every subscription looks steady.</p>'; return; }
  const badge = { PRICE_CHANGE: 'warn', LAPSED: 'plain', DUPLICATE: 'bad' };
  $('#audit').innerHTML = `<div class="cards">${a.findings.map((f) => `<div class="mini"><div class="title">${esc(f.merchantName)} <span class="badge ${badge[f.kind]}">${pretty(f.kind)}</span></div>
    <div class="muted">${esc(f.accountName)} · ${pretty(f.frequency) || 'recurring'}</div><dl>
    ${f.kind === 'PRICE_CHANGE' ? `<dt>Was</dt><dd>${money(f.previousAmount, f.unitType)}</dd><dt>Now</dt><dd>${money(f.amount, f.unitType)} (${f.changePercent > 0 ? '+' : ''}${pct(f.changePercent)})</dd><dt>Since</dt><dd>${fmtDate(f.changedOn)}</dd>` : ''}
    ${f.kind === 'LAPSED' ? `<dt>Amount</dt><dd>${money(f.amount, f.unitType)}</dd><dt>Expected</dt><dd>${fmtDate(f.expectedOn)}</dd><dt>Last seen</dt><dd>${fmtDate(f.lastSeen)}</dd>` : ''}
    ${f.kind === 'DUPLICATE' ? (f.accounts || []).map((x) => `<dt>${esc(x.accountName)}</dt><dd>${money(x.amount, x.unitType)}</dd>`).join('') : ''}
    </dl></div>`).join('')}</div>`;
}

// ============================================================ Scenarios
async function loadScenarios() {
  const tab = $('#tab-scenarios'); clearErr(tab);
  try {
    const [sc, ps] = await Promise.all([api.scenarios(), api.persons()]);
    state.scenarios = sc.scenarios;
    state.persons = ps.persons;
    renderScenarioList();
    renderComparePicks();
    if (state.selectedScenario && !state.scenarios.some((s) => s.id === state.selectedScenario)) state.selectedScenario = null;
    if (state.selectedScenario) selectScenario(state.selectedScenario);
  } catch (e) { showErr(tab, e); }
}

function renderScenarioList() {
  $('#sc-list').innerHTML = state.scenarios.map((s) => `<li data-id="${s.id}" class="${s.id === state.selectedScenario ? 'is-selected' : ''}">${esc(s.name)}
    <span class="sub">${horizonText(s)} · ${s.flows.length} flow${s.flows.length === 1 ? '' : 's'}${s.partyId !== state.party ? ' · member' : ''}</span></li>`).join('') ||
    '<li class="muted">No scenarios yet.</li>';
  $$('#sc-list li[data-id]').forEach((li) => li.addEventListener('click', () => selectScenario(li.dataset.id)));
}
const horizonText = (s) => (s.horizonPersonId ? `to ${s.horizonPersonName || 'person'}'s age ${s.horizonAge}` : `${s.horizonYears} yr`);

const nm = (n) => (n ? esc(n) : '<i>removed account</i>');
const FLOW_TEXT = {
  GROWTH: (f) => `${nm(f.accountName)} grows ${pct(f.rate)} / yr`,
  CONTRIBUTION: (f) => (f.matchOfFlowId ? `Match ${pct(f.percent)} into ${nm(f.accountName)}${f.ceilingAmount ? `, up to ${money(f.ceilingAmount)}` : ''}` : `${money(f.amount)} into ${nm(f.accountName)}${f.targetAccountName ? ` from ${nm(f.targetAccountName)}` : ''}`),
  WITHDRAWAL: (f) => `${f.percent != null ? `${pct(f.percent)} / yr` : money(f.amount)} from ${nm(f.accountName)}${f.targetAccountName ? ` to ${nm(f.targetAccountName)}` : ''}${f.fallbackAccounts.length ? `, then ${f.fallbackAccounts.map((a) => esc(a.name)).join(' → ')}` : ''}`,
  TRANSFER: (f) => `${money(f.amount)} ${nm(f.accountName)} → ${nm(f.targetAccountName)}`,
  ONE_TIME: (f) => `${money(f.amount)} ${f.amount >= 0 ? 'into' : 'out of'} ${nm(f.accountName)}`,
  SPENDING: (f) => `${nm(f.accountName)} at ${money(f.amount)} / mo from ${nm(f.targetAccountName)}`,
  SHOCK: (f) => `${nm(f.accountName)} ${pct(f.rate)}`,
  TARGET: (f) => `${nm(f.accountName)} reaches ${money(f.amount)}`,
  RMD: (f) => `Required minimum distributions from ${nm(f.accountName)}${f.targetAccountName ? ` into ${nm(f.targetAccountName)}` : ''}${f.personName ? `, by ${esc(f.personName)}'s age` : ''}`,
  DISPOSE: (f) => `Sell / pay off ${nm(f.accountName)}${f.amount != null ? ` for ${money(f.amount)}` : ''} → ${nm(f.targetAccountName)}`,
};
const cadence = (m) => (m == null ? '' : m === 1 ? 'monthly' : m === 12 ? 'yearly' : m === 3 ? 'quarterly' : `every ${m} mo`);
function flowWhen(f) {
  if (f.matchOfFlowId) return 'with the contribution it matches';
  if (f.flowType === 'RMD') {
    const p = state.persons.find((x) => x.id === f.personId);
    return `each January 1${f.resolvedStartDate ? ` from ${fmtDate(f.resolvedStartDate, { year: 'numeric' })}` : p ? ` from ${Number(p.birthDate.slice(0, 4)) + rmdAge(p.birthDate)}` : ''}${p ? ` (${esc(p.name)} at ${rmdAge(p.birthDate)})` : ''}`;
  }
  const my = (d) => fmtDate(d, { month: 'short', year: 'numeric' });
  // A flow is dated by a date or by an age, never both; resolved* is the day it actually runs on.
  const age = (a, resolved) => (a != null ? `${esc(f.personName || 'person')} ${a}${resolved ? ` (${my(resolved)})` : ''}` : null);
  const start = age(f.startAge, f.resolvedStartDate) || my(f.startDate || f.resolvedStartDate);
  const end = age(f.endAge, f.resolvedEndDate) || (f.endDate ? my(f.endDate) : null);
  if (['ONE_TIME', 'SHOCK', 'DISPOSE', 'TARGET'].includes(f.flowType)) return f.flowType === 'TARGET' ? `by ${start}` : `on ${start}`;
  if (!f.startDate && f.startAge == null && !f.endDate && f.endAge == null) return f.flowType === 'GROWTH' ? 'whole run' : cadence(f.cadenceMonths);
  return [cadence(f.cadenceMonths), `${start}${end ? ` – ${end}` : ' onward'}`, f.rate != null && f.flowType !== 'GROWTH' && f.flowType !== 'SHOCK' ? `grows ${pct(f.rate)}` : null].filter(Boolean).join(' · ');
}

async function selectScenario(id) {
  state.selectedScenario = id;
  renderScenarioList();
  const host = $('#sc-detail');
  const tab = $('#tab-scenarios'); clearErr(tab);
  let s;
  try { ({ data: s } = await api.scenario(id)); } catch (e) { return showErr(tab, e); }
  const rate = (v) => (v == null ? '<span class="muted">inherits</span>' : pct(v));
  host.innerHTML = `<div class="card">
    <div class="card-head"><h2>${esc(s.name)}</h2><div class="row-actions" style="margin:0">
      <button class="ghost-btn sm" data-act="edit">Edit</button><button class="ghost-btn sm" data-act="copy">Copy</button><button class="ghost-btn sm danger" data-act="archive">Archive</button></div></div>
    <div class="muted">Horizon ${horizonText(s)} · inflation ${rate(s.inflationRate)} · return ${rate(s.returnRate)} · income growth ${rate(s.incomeGrowthRate)} · income tax ${rate(s.taxRate)} · volatility ${rate(s.volatility)} · v${s.version}</div>
    ${s.flows.length ? `<h3>Flows</h3><table class="data"><tbody>${s.flows.map((f) => `<tr><td><span class="badge plain">${flowLabel(f.flowType)}</span>${f.complete ? '' : '<div><span class="badge warn" title="It lost an account it needs; runs leave it out and a save drops it">incomplete</span></div>'}</td><td>${f.label ? `<b>${esc(f.label)}</b><div class="sub">` : '<div>'}${(FLOW_TEXT[f.flowType] || (() => ''))(f)}</div></td><td class="sub">${flowWhen(f)}</td></tr>`).join('')}</tbody></table>` : '<p class="note">No flows yet — the run projects the calendar and baseline as they are. Edit to add contributions, withdrawals, targets…</p>'}
    ${s.streamOverrides.length ? `<h3>Calendar overrides</h3><ul class="sub">${s.streamOverrides.map((o) => `<li>${esc(o.merchantName || 'Loan schedule')} on ${esc(o.accountName)}${o.resolvedStartDate ? ` from ${o.startAge != null ? `${esc(o.personName)} ${o.startAge} (${fmtDate(o.resolvedStartDate)})` : fmtDate(o.startDate)}` : ''}: ${o.excluded ? 'dropped' : [(o.endDate || o.resolvedEndDate) && `ends ${o.endAge != null ? `at ${esc(o.personName)} ${o.endAge} (${fmtDate(o.resolvedEndDate)})` : fmtDate(o.endDate)}`, o.amount != null && `re-priced to ${money(o.amount)}`, o.rate != null && `grows ${pct(o.rate)}`].filter(Boolean).join(', ')}</li>`).join('')}</ul>` : ''}
    ${s.accounts.length ? `<h3>Hypothetical accounts</h3><ul class="sub">${s.accounts.map((a) => `<li>${esc(a.name)} (${pretty(a.assetType || a.accountType)}) ${money(a.openingBalance, a.unitType)} from ${fmtDate(a.openDate)}${a.payment ? ` · ${money(a.payment, a.unitType)}/mo` : ''}${a.disposedOn ? ` · until ${fmtDate(a.disposedOn)}` : ''}</li>`).join('')}</ul>` : ''}
    ${s.excludedAccounts.length ? `<p class="sub">Left out: ${s.excludedAccounts.map((a) => esc(a.name)).join(', ')}</p>` : ''}
    ${s.members.length ? `<p class="sub">Runs with: ${s.members.map((m) => esc(m.name)).join(', ')}</p>` : ''}
    <div class="toolbar" style="margin:14px 0 0">
      <label>Market shock <select id="run-stress">${[-10, -20, -30, -40, -50].map((v) => `<option${v === -30 ? ' selected' : ''}>${v}</option>`).join('')}</select>%</label>
      <label>Cash flow by <select id="run-period"><option value="YEAR">year</option><option value="MONTH">month</option></select></label>
      <label class="inline"><input type="checkbox" id="run-baseline" checked /> everyday spending baseline</label>
      <button class="primary-btn" id="run-btn">Run forecast</button>
    </div></div>
    <div class="card"><div class="card-head"><h2>How sure is it?</h2><span class="muted">Monte Carlo: the plan run over many random market paths around the assumed return</span></div>
      <div class="toolbar" style="margin:0">
        <label>Paths <select id="sim-paths"><option>250</option><option selected>500</option><option>1000</option><option>2000</option></select></label>
        <label>Volatility % <input id="sim-vol" type="number" min="0" max="100" step="0.5" style="width:90px" placeholder="assumed" /></label>
        <label>Return % <input id="sim-return" type="number" step="0.1" style="width:90px" placeholder="assumed" /></label>
        <label class="inline" title="Re-draw the exact same market paths as the last simulation, to see what one change does"><input type="checkbox" id="sim-same" disabled /> same paths as last time</label>
        <button class="primary-btn" id="sim-btn">Simulate</button>
      </div>
      <div id="sc-sim"></div>
    </div>
    <div id="sc-run"></div>`;
  $('[data-act=edit]', host).addEventListener('click', () => openEditor(s));
  $('#sim-btn').addEventListener('click', () => simulateScenario(s));
  $('[data-act=copy]', host).addEventListener('click', () => copyScenario(s));
  $('[data-act=archive]', host).addEventListener('click', () => archiveScenario(s));
  $('#run-btn').addEventListener('click', () => runScenario(s));
  runScenario(s);
}

async function runScenario(s) {
  const out = $('#sc-run');
  out.innerHTML = '<div class="card placeholder">Running the scenario through its horizon…</div>';
  try {
    const run = await api.runScenario(s.id, {
      step: 30, stress: Number($('#run-stress').value), period: $('#run-period').value, baseline: $('#run-baseline').checked, unitType: state.unit,
    });
    renderRun(out, run, { scenarioId: s.id });
  } catch (e) { out.innerHTML = ''; showErr($('#tab-scenarios'), e); }
}

// Renders a GetScenarioForecastResponse (single scenario, or several run together).
function renderRun(out, run, { scenarioId } = {}) {
  const funding = run.funding || [];
  const stressById = new Map((run.stress?.funding || []).map((f) => [f.accountId, f]));
  const net = netSeries(run);
  const names = new Map(run.accounts.map((a) => [a.id, a.name]));
  const firstPt = net.points[0], lastPt = net.points[net.points.length - 1];
  const shortCount = funding.filter((f) => !f.funded).length;
  const stressShort = (run.stress?.funding || []).filter((f) => !f.funded).length;
  const offTrack = run.targets.filter((t) => !t.onTrack).length;

  const assumptionChips = run.assumptions.map((pa) => {
    const a = pa.assumptions;
    const chip = (label, r) => `<span class="badge plain" title="source: ${pretty(r.source)}">${label} ${pct(r.rate)} · ${pretty(r.source)}</span>`;
    return `${run.assumptions.length > 1 ? `<span class="sub">${esc(pa.partyId.slice(0, 8))}</span> ` : ''}${chip('Inflation', a.inflation)} ${chip('Return', a.investmentReturn)} ${chip('Income growth', a.incomeGrowth)}${a.incomeTax ? ` ${chip('Income tax', a.incomeTax)}` : ''}${a.volatility ? ` ${chip('Volatility', a.volatility)}` : ''}`;
  }).join('<br>');
  const warnings = [
    run.unreachableAccountIds.length && `${run.unreachableAccountIds.length} account(s) named by the scenario are no longer reachable and were left out: ${run.unreachableAccountIds.map((id) => esc(names.get(id) || accountName(id))).join(', ')}.`,
    run.assumedReturnAccountIds.length && `The assumed return was applied to ${run.assumedReturnAccountIds.map((id) => esc(names.get(id) || accountName(id))).join(', ')} (no GROWTH flow of their own).`,
  ].filter(Boolean);

  out.innerHTML = `
    <div class="tiles">
      ${tile('Net position now', money(firstPt?.balance, net.unit))}
      ${tile(`At horizon · ${fmtDate(run.toDate, { month: 'short', year: 'numeric' })}`, money(lastPt?.balance, net.unit), firstPt && lastPt ? signed(lastPt.balance - firstPt.balance, net.unit) : '')}
      ${tile('Withdrawals funded', funding.length ? `${funding.length - shortCount} / ${funding.length}` : '—', run.stress ? `${funding.length - stressShort} / ${funding.length} after a ${pct(run.stress.percent)} shock` : '')}
      ${tile('Targets on track', run.targets.length ? `${run.targets.length - offTrack} / ${run.targets.length}` : '—')}
    </div>
    <div class="card"><div class="card-head"><h2>Net position through the horizon</h2><span class="muted">${fmtDate(run.fromDate)} → ${fmtDate(run.toDate)}</span></div>
      <div>${assumptionChips}</div>${warnings.map((w) => `<p class="note">${w}</p>`).join('')}
      <figure class="chart" id="run-chart"></figure></div>
    ${funding.length ? `<div class="card"><div class="card-head"><h2>Can the accounts fund their withdrawals?</h2>${run.stress ? `<span class="muted">stress: ${pct(run.stress.percent)} on ${fmtDate(run.stress.appliedOn)}</span>` : ''}</div>
      <div class="cards">${funding.map((f) => fundingCard(f, stressById.get(f.accountId), names)).join('')}</div></div>` : ''}
    ${run.targets.length ? `<div class="card"><div class="card-head"><h2>Targets</h2></div><table class="data"><thead><tr><th>Goal</th><th class="num">Target</th><th class="num">Projected</th><th>Status</th></tr></thead><tbody>${run.targets.map((t) =>
      `<tr><td>${esc(t.label || t.accountName)}<div class="sub">${esc(t.accountName)} by ${fmtDate(t.date)}</div></td><td class="num">${money(t.target, t.unitType)}</td><td class="num">${money(t.projected, t.unitType)}</td><td>${t.onTrack ? '<span class="badge good">✓ On track</span>' : `<span class="badge bad">✗ ${t.gap != null ? `Short ${money(t.gap, t.unitType)}` : 'Not met'}</span>${t.requiredMonthlyContribution != null ? `<div class="sub">add ${money(t.requiredMonthlyContribution, t.unitType)}/mo${t.contributionAccountId && t.contributionAccountId !== t.accountId ? ` into ${esc(names.get(t.contributionAccountId) || accountName(t.contributionAccountId))}` : ''} to get there</div>` : ''}`}${t.plannedOpenDate ? `<div class="sub">the account only opens ${fmtDate(t.plannedOpenDate)}</div>` : ''}</td></tr>`).join('')}</tbody></table></div>` : ''}
    ${run.cashFlow.length ? `<div class="card"><div class="card-head"><h2>Household cash flow</h2><span class="muted">money into and out of the cash accounts</span></div><div class="table-scroll"><table class="data"><thead><tr><th>Period</th><th class="num">In</th><th class="num">Out</th><th class="num">Surplus</th><th>Biggest sources</th></tr></thead><tbody>${run.cashFlow.map((c) =>
      `<tr><td>${periodLabel(c)}${c.unitType !== state.unit ? ` <span class="sub">${c.unitType}</span>` : ''}</td><td class="num">${money(c.moneyIn, c.unitType)}</td><td class="num">${money(c.moneyOut, c.unitType)}</td><td class="num">${signed(c.net, c.unitType)}</td><td class="sub">${[...c.sources].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)).slice(0, 3).map((s) => `${esc(s.label || pretty(s.kind))} ${signed(s.amount, c.unitType)}`).join(' · ')}</td></tr>`).join('')}</tbody></table></div></div>` : ''}
    <div class="card"><div class="card-head"><h2>Accounts</h2>${scenarioId ? '<span class="muted">trace an account to see the events behind its projection</span>' : ''}</div><div class="table-scroll"><table class="data"><thead><tr><th>Account</th><th class="num">Now</th><th class="num">Horizon</th><th class="num">Low</th><th>Watch</th>${scenarioId ? '<th></th>' : ''}</tr></thead><tbody>${run.accounts.map((a) => {
      const dd = run.drawdowns.find((d) => d.accountId === a.id);
      return `<tr><td>${esc(a.name)}${a.hypothetical ? ' <span class="badge plain">planned</span>' : ''}<div class="sub">${pretty(a.accountType)}${a.accountType === 'LIABILITY' ? ' · owed' : ''}${dd?.maxDrawdownPercent != null ? ` · worst historical drawdown ${pct(dd.maxDrawdownPercent)}` : ''}</div></td><td class="num">${money(a.opening, a.unitType)}</td><td class="num">${money(a.closing, a.unitType)}</td><td class="num">${money(a.low?.balance, a.unitType)}<div class="sub">${fmtDate(a.low?.date, { month: 'short', year: 'numeric' })}</div></td><td>${accountAlert(a)}</td>${scenarioId ? `<td><button class="link-btn sm" data-trace="${a.id}">Trace</button></td>` : ''}</tr>`;
    }).join('')}</tbody></table></div><div id="ledger"></div></div>
    ${run.baselines.length ? `<div class="card"><div class="card-head"><h2>Everyday baseline</h2><span class="muted">non-recurring activity the calendar can't see, replayed monthly</span></div><table class="data"><tbody>${run.baselines.map((b) =>
      `<tr><td>${esc(b.accountName)}</td><td class="num">${signed(b.monthlyNet, b.unitType)} / mo</td><td class="sub">over ${Math.round(b.monthsOfHistory)} months · grows ${pct(b.rate)}</td></tr>`).join('')}</tbody></table>${run.spending.length ? `<h3>Spending plans replacing part of it</h3><table class="data"><tbody>${run.spending.map((sp) => `<tr><td>${esc(sp.label || sp.categoryName)}<div class="sub">${esc(sp.categoryName)} from ${esc(sp.accountName)}</div></td><td class="num">was ${money(Math.abs(sp.baselineMonthly))}/mo</td><td class="num">plan ${money(sp.monthly)}/mo</td></tr>`).join('')}</tbody></table>` : ''}</div>` : ''}`;

  const markers = funding.filter((f) => !f.funded && f.shortDate).map((f) => ({ date: f.shortDate, label: `${f.accountName} short` }));
  if (run.stress?.appliedOn) markers.push({ date: run.stress.appliedOn, label: `${pct(run.stress.percent)} shock` });
  const lines = run.convertedNetPosition?.points?.length
    ? [{ name: `Net position (${net.unit})`, points: net.points }]
    : run.netPositions.map((n) => ({ name: `Net position (${n.unitType})`, points: n.points }));
  lineChart($('#run-chart', out), lines, { fmt: (v) => money(v, net.unit), compact: compactMoney(net.unit), zeroLine: true, markers: markers.slice(0, 4) });
  const unconverted = run.convertedNetPosition?.unconvertedUnitTypes || [];
  if (unconverted.length) $('#run-chart', out).insertAdjacentHTML('beforeend', `<p class="muted">No exchange rate for ${unconverted.map(esc).join(', ')} — left out of this line.</p>`);
  $$('[data-trace]', out).forEach((b) => b.addEventListener('click', () => traceAccount(scenarioId, b.dataset.trace, run.fromDate)));
}

const periodLabel = (p) => ((Date.parse(p.toDate) - Date.parse(p.fromDate)) / 864e5 > 40 ? p.toDate.slice(0, 4) : fmtDate(p.fromDate, { month: 'short', year: 'numeric' }));

function fundingCard(f, stressed, names = new Map()) {
  const into = (x) => (x.contributionAccountId && x.contributionAccountId !== x.accountId ? ` into ${esc(names.get(x.contributionAccountId) || accountName(x.contributionAccountId))}` : '');
  const status = (x) => (x.funded ? '<span class="badge good">✓ Funded</span>' : `<span class="badge bad">✗ Short ${fmtDate(x.shortDate, { month: 'short', year: 'numeric' })}</span>`);
  return `<div class="mini"><div class="title">${esc(f.accountName)} ${status(f)}</div>
    <div class="sub">${f.withdrawals.map(esc).join(', ')}</div><dl>
    ${f.funded ? '' : `<dt>Shortfall</dt><dd class="neg">${money(f.shortfall, f.unitType)}</dd>`}
    ${f.requiredMonthlyContribution != null ? `<dt>…or save extra</dt><dd>${money(f.requiredMonthlyContribution, f.unitType)}/mo${into(f)}</dd>` : ''}
    ${f.delayMonths != null ? `<dt>…or start later</dt><dd>${f.delayMonths} mo · ${fmtDate(f.earliestFundedStart, { month: 'short', year: 'numeric' })}</dd>` : ''}
    ${f.drawnFrom.map((d) => `<dt>drawn from ${esc(d.accountName)}</dt><dd>${money(d.amount, f.unitType)}</dd>`).join('')}
    ${stressed ? `<dt>After the shock</dt><dd>${stressed.funded ? '<span class="pos">still funded</span>' : `<span class="neg">short ${fmtDate(stressed.shortDate, { month: 'short', year: 'numeric' })}</span>`}</dd>` : ''}
    ${stressed && !stressed.funded && stressed.requiredMonthlyContribution != null ? `<dt>…to survive it</dt><dd>${money(stressed.requiredMonthlyContribution, f.unitType)}/mo${into(stressed)}</dd>` : ''}
    </dl></div>`;
}

async function traceAccount(scenarioId, accountId, fromDate) {
  const host = $('#ledger');
  const render = async (after, before) => {
    host.innerHTML = '<div class="placeholder">Loading events…</div>';
    try {
      const l = await api.ledger(scenarioId, { account: accountId, afterDate: after, beforeDate: before });
      host.innerHTML = `<h3>${esc(l.accountName)} · ${fmtDate(l.afterDate)} → ${fmtDate(l.beforeDate)}</h3>
        <div class="toolbar"><label>From <input type="date" id="lg-after" value="${l.afterDate}"></label><label>To <input type="date" id="lg-before" value="${l.beforeDate}"></label><button class="ghost-btn sm" id="lg-go">Update</button><span class="muted">window up to 366 days</span></div>
        <div class="table-scroll"><table class="data"><thead><tr><th>Date</th><th>Event</th><th class="num">Change</th><th class="num">Balance</th></tr></thead><tbody>
        <tr><td>${fmtDate(l.afterDate)}</td><td class="sub">Opening</td><td></td><td class="num">${money(l.opening, l.unitType)}</td></tr>
        ${l.events.map((ev) => `<tr><td>${fmtDate(ev.date)}</td><td>${esc(ev.label || '—')} <span class="badge plain">${pretty(ev.kind)}</span></td><td class="num">${signed(ev.amount, l.unitType)}</td><td class="num">${money(ev.balance, l.unitType)}</td></tr>`).join('')}
        <tr><td>${fmtDate(l.beforeDate)}</td><td class="sub">Closing</td><td></td><td class="num"><b>${money(l.closing, l.unitType)}</b></td></tr></tbody></table></div>`;
      $('#lg-go').addEventListener('click', () => render($('#lg-after').value, $('#lg-before').value));
    } catch (e) { host.innerHTML = `<div class="error">${describeError(e)}</div>`; }
  };
  render(fromDate, addDays(fromDate, 90));
  host.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function copyScenario(s) {
  const name = prompt('Name for the copy', `${s.name} (copy)`);
  if (name == null) return;
  try {
    const { data } = await api.copyScenario(s.id, name || undefined);
    state.selectedScenario = data.id;
    await loadScenarios();
  } catch (e) { showErr($('#tab-scenarios'), e); }
}

async function archiveScenario(s) {
  if (!confirm(`Archive “${s.name}”? It will no longer appear in the list.`)) return;
  try {
    await api.archiveScenario(s.id, s.version);
    state.selectedScenario = null;
    $('#sc-detail').innerHTML = '<div class="card placeholder">Scenario archived.</div>';
    await loadScenarios();
  } catch (e) {
    showErr($('#tab-scenarios'), e);
    if (e.code === 'conflict') selectScenario(s.id);
  }
}

// ------------------------------------------------------ scenario editor
// Which ScenarioFlowBody fields each flow type uses (from the field descriptions in the spec).
const FLOW_FIELDS = {
  GROWTH: ['accountId', 'rate', 'startDate', 'endDate'],
  CONTRIBUTION: ['accountId', 'targetAccountId', 'amount', 'cadenceMonths', 'startDate', 'endDate', 'rate', 'person'],
  WITHDRAWAL: ['accountId', 'targetAccountId', 'amount', 'percent', 'cadenceMonths', 'startDate', 'endDate', 'rate', 'person', 'fallbackAccountIds'],
  TRANSFER: ['accountId', 'targetAccountId', 'amount', 'cadenceMonths', 'startDate', 'endDate', 'rate', 'person'],
  ONE_TIME: ['accountId', 'targetAccountId', 'amount', 'startDate', 'person'],
  SPENDING: ['accountId', 'targetAccountId', 'amount', 'startDate', 'endDate', 'rate'],
  SHOCK: ['accountId', 'rate', 'startDate'],
  TARGET: ['accountId', 'amount', 'startDate', 'person'],
  DISPOSE: ['accountId', 'targetAccountId', 'amount', 'startDate'],
  // An RMD names a tax-deferred account, its owner (required) and optionally where the money lands; the rule
  // sets the rest. It states no amount, percent, rate, cadence, dates or ages — any of them is a 400.
  RMD: ['accountId', 'targetAccountId', 'rmdPerson'],
};
const FLOW_LABELS = {
  GROWTH: { accountId: 'Account that grows', rate: 'Return % / yr', startDate: 'From (blank = whole run)', endDate: 'Until' },
  CONTRIBUTION: { accountId: 'Into', targetAccountId: 'From (optional)', amount: 'Amount each time', rate: 'Grows % / yr' },
  WITHDRAWAL: { accountId: 'Draw from', targetAccountId: 'Pay into (optional)', amount: 'Amount each time', percent: '…or % of balance / yr', rate: 'Grows % / yr (blank = inflation)', fallbackAccountIds: 'Then draw on (in order)' },
  TRANSFER: { accountId: 'From', targetAccountId: 'To', amount: 'Amount each time', rate: 'Grows % / yr' },
  ONE_TIME: { accountId: 'Account', targetAccountId: 'Other side (optional)', amount: 'Amount (− is out)', startDate: 'On' },
  SPENDING: { accountId: 'Category', targetAccountId: 'Paid from', amount: 'New monthly amount', startDate: 'First month', rate: 'Grows % / yr (blank = inflation)' },
  SHOCK: { accountId: 'Account', rate: 'Change % (−30 = a 30% fall)', startDate: 'On' },
  TARGET: { accountId: 'Account', amount: 'Balance to reach', startDate: 'By' },
  RMD: { accountId: 'Tax-deferred account', targetAccountId: 'Lands in (blank = leaves the household)' },
  DISPOSE: { accountId: 'Asset to sell / loan to pay off', targetAccountId: 'Proceeds to / payoff from', amount: 'Sale price (blank = projected value)', startDate: 'On' },
};

// ScenarioResponse → ScenarioBody, as the spec says to resend a saved scenario: each flow's and
// hypothetical account's id is its key; matchOfFlowId → matchOf, collateralId → collateral, and
// hypothetical*Id → hypothetical* (that account's key). Dates and ages go back exactly as stated
// (a flow has one or the other), and flows that lost an account (complete: false) are left out, as a copy does.
function scenarioToBody(s) {
  return {
    name: s.name,
    horizonYears: s.horizonYears,
    horizonPersonId: s.horizonPersonId ?? null,
    horizonAge: s.horizonAge ?? null,
    inflationRate: s.inflationRate ?? null,
    returnRate: s.returnRate ?? null,
    incomeGrowthRate: s.incomeGrowthRate ?? null,
    taxRate: s.taxRate ?? null,
    volatility: s.volatility ?? null,
    flows: s.flows.filter((f) => f.complete).map((f) => ({
      key: f.id, flowType: f.flowType,
      accountId: f.accountId ?? null, hypotheticalAccount: f.hypotheticalAccountId ?? null,
      targetAccountId: f.targetAccountId ?? null, hypotheticalTargetAccount: f.hypotheticalTargetAccountId ?? null,
      label: f.label ?? null, amount: f.amount ?? null,
      startDate: f.startDate ?? null, endDate: f.endDate ?? null,
      cadenceMonths: f.cadenceMonths ?? null, rate: f.rate ?? null, percent: f.percent ?? null,
      floorAmount: f.floorAmount ?? null, ceilingAmount: f.ceilingAmount ?? null,
      fallbackAccountIds: f.fallbackAccounts.map((a) => a.id),
      personId: f.personId ?? null, startAge: f.startAge ?? null, endAge: f.endAge ?? null,
      matchOf: f.matchOfFlowId ?? null,
    })),
    streamOverrides: s.streamOverrides.map((o) => ({
      accountId: o.accountId, merchantName: o.merchantName ?? null, excluded: o.excluded,
      startDate: o.startDate ?? null, startAge: o.startAge ?? null,
      endDate: o.endDate ?? null, amount: o.amount ?? null, rate: o.rate ?? null,
      personId: o.personId ?? null, endAge: o.endAge ?? null,
    })),
    excludedAccountIds: s.excludedAccounts.map((a) => a.id),
    memberScenarioIds: s.members.map((m) => m.id),
    accounts: s.accounts.map((a) => ({
      key: a.id, name: a.name, accountType: a.accountType, assetType: a.assetType ?? null, unitType: a.unitType,
      openingBalance: a.openingBalance, openDate: a.openDate,
      fundedFromAccountId: a.fundedFromAccountId ?? null, fundedAmount: a.fundedAmount ?? null, appreciationRate: a.appreciationRate ?? null,
      apr: a.apr ?? null, termMonths: a.termMonths ?? null, escrow: a.escrow ?? null, paymentFromAccountId: a.paymentFromAccountId ?? null,
      disposedOn: a.disposedOn ?? null, proceedsToAccountId: a.proceedsToAccountId ?? null,
      collateral: a.collateralId ?? null, collateralAccountId: a.collateralAccountId ?? null,
    })),
  };
}
// A picker value is a book account id, or "hypo:<key>" for an account planned in the body.
const accountRef = (val, bookField, hypoField) => (val.startsWith('hypo:')
  ? { [bookField]: null, [hypoField]: val.slice(5) }
  : { [bookField]: val || null, [hypoField]: null });

const EMPTY_BODY = { name: '', horizonYears: 30, horizonPersonId: null, horizonAge: null, inflationRate: null, returnRate: null, incomeGrowthRate: null, taxRate: null, volatility: null, flows: [], streamOverrides: [], excludedAccountIds: [], memberScenarioIds: [], accounts: [] };

function personOptions(sel) {
  return `<option value="">—</option>` + state.persons.map((p) => `<option value="${p.id}"${p.id === sel ? ' selected' : ''}>${esc(p.name)} (${p.age})</option>`).join('');
}

function openEditor(existing) {
  const body = existing ? scenarioToBody(existing) : structuredClone(EMPTY_BODY);
  const dlg = $('#editor');
  const byAge = !!body.horizonPersonId;
  dlg.innerHTML = `<form method="dialog" id="ed-form">
    <div class="dlg-head"><h2>${existing ? `Edit “${esc(existing.name)}”` : 'New scenario'}</h2><button class="ghost-btn sm" value="cancel" formnovalidate>✕</button></div>
    <div class="dlg-body">
      <div class="form-grid">
        <label style="grid-column: span 2">Name <input name="scenarioName" required value="${esc(body.name)}" placeholder="Retire at 62" /></label>
        <label>Horizon <select name="horizonMode"><option value="years">Number of years</option><option value="age"${byAge ? ' selected' : ''}${state.persons.length ? '' : ' disabled'}>To a person's age</option></select></label>
        <label data-h="years">Years (1–60) <input name="horizonYears" type="number" min="1" max="60" value="${body.horizonYears ?? 30}" /></label>
        <label data-h="age">Person <select name="horizonPersonId">${personOptions(body.horizonPersonId)}</select></label>
        <label data-h="age">Age <input name="horizonAge" type="number" min="1" max="120" value="${body.horizonAge ?? 95}" /></label>
      </div>
      <h3>Rates <span class="src">(blank inherits your planning assumptions)</span></h3>
      <div class="form-grid">
        <label>Inflation % <input name="inflationRate" type="number" step="0.1" value="${body.inflationRate ?? ''}" /></label>
        <label>Investment return % <input name="returnRate" type="number" step="0.1" value="${body.returnRate ?? ''}" /></label>
        <label>Income growth % <input name="incomeGrowthRate" type="number" step="0.1" value="${body.incomeGrowthRate ?? ''}" /></label>
        <label title="Effective rate on money leaving an IRA or 401(k); 0 taxes nothing">Income tax % <input name="taxRate" type="number" step="0.1" min="0" max="99" value="${body.taxRate ?? ''}" /></label>
        <label title="Only used by simulations: how widely the market's yearly return swings">Volatility % <input name="volatility" type="number" step="0.1" min="0" max="100" value="${body.volatility ?? ''}" /></label>
      </div>
      <h3>Flows</h3>${existing && existing.flows.some((f) => !f.complete) ? `<p class="note">${existing.flows.filter((f) => !f.complete).length} incomplete flow(s) lost an account they need and will be dropped on save.</p>` : ''}<div id="ed-flows" class="stack"></div>
      <div class="row-actions"><select id="ed-flow-type">${Object.keys(FLOW_FIELDS).map((t) => `<option value="${t}">${flowLabel(t)}</option>`).join('')}</select><button type="button" class="ghost-btn sm" id="ed-add-flow">+ Add flow</button></div>
      <h3>Calendar overrides <span class="src">(end a paycheck at retirement, drop or re-price a subscription)</span></h3><div id="ed-overrides" class="stack"></div>
      <div class="row-actions"><button type="button" class="ghost-btn sm" id="ed-add-ov">+ Add override</button></div>
      <h3>Hypothetical accounts <span class="src">(a house not yet bought, its mortgage)</span></h3><div id="ed-accounts" class="stack"></div>
      <div class="row-actions"><button type="button" class="ghost-btn sm" id="ed-add-acct">+ Add account</button></div>
      <h3>Leave out of the run</h3>
      <div class="chips" id="ed-excluded">${cashAndInvestment().map((a) => `<label class="chip${body.excludedAccountIds.includes(a.id) ? ' is-on' : ''}"><input type="checkbox" hidden value="${a.id}"${body.excludedAccountIds.includes(a.id) ? ' checked' : ''}/>${esc(a.name)}</label>`).join('')}</div>
      ${body.memberScenarioIds.length ? `<p class="note">Keeps ${body.memberScenarioIds.length} member scenario(s) run together with this one.</p>` : ''}
      <datalist id="merchant-list">${state.merchants.map((m) => `<option value="${esc(m)}">`).join('')}</datalist>
      <div class="error" hidden></div>
    </div>
    <div class="dlg-foot"><span class="muted">${existing ? `version ${existing.version}` : ''}</span><div class="row-actions" style="margin:0"><button class="ghost-btn" value="cancel" formnovalidate>Cancel</button><button class="primary-btn" value="save" id="ed-save">Save</button></div></div>
  </form>`;

  const form = $('#ed-form', dlg);
  const syncHorizon = () => $$('[data-h]', form).forEach((el) => { el.hidden = el.dataset.h !== form.horizonMode.value; });
  form.horizonMode.addEventListener('change', syncHorizon); syncHorizon();
  $$('#ed-excluded .chip', dlg).forEach((c) => $('input', c).addEventListener('change', (e) => c.classList.toggle('is-on', e.target.checked)));

  body.accounts.forEach((a) => addAccountEditor(a));
  body.flows.forEach((f) => addFlowEditor(f));
  body.streamOverrides.forEach((o) => addOverrideEditor(o));
  $('#ed-add-flow', dlg).addEventListener('click', () => addFlowEditor({ key: `new-${crypto.randomUUID()}`, flowType: $('#ed-flow-type').value, fallbackAccountIds: [], cadenceMonths: 1 }));
  $('#ed-add-ov', dlg).addEventListener('click', () => addOverrideEditor({ excluded: false }));
  $('#ed-add-acct', dlg).addEventListener('click', () => addAccountEditor({ key: `new-${crypto.randomUUID()}`, accountType: 'ASSET', openDate: addDays(today(), 180), unitType: state.unit }));

  function addFlowEditor(f) {
    const fields = FLOW_FIELDS[f.flowType] || [];
    const L = { amount: 'Amount', rate: 'Rate %', startDate: 'Start', endDate: 'End (blank = horizon)', cadenceMonths: 'Every (months)', percent: 'Percent', ...(FLOW_LABELS[f.flowType] || {}) };
    const spendingCats = f.flowType === 'SPENDING';
    // SPENDING and DISPOSE name book accounts only; every other flow may act on a hypothetical account.
    const bookOnly = spendingCats || f.flowType === 'DISPOSE';
    const isRmd = f.flowType === 'RMD';
    const el = document.createElement('div');
    el.className = 'flow-row'; el._flow = f;
    const input = (name, type = 'number', extra = '') => fields.includes(name) ? `<label>${L[name]} <input name="${name}" type="${type}" step="any" value="${f[name] ?? ''}" ${extra}/></label>` : '';
    el.innerHTML = `<div class="head"><span><span class="badge plain">${flowLabel(f.flowType)}</span>${f.matchOf ? ' <span class="sub">employer match</span>' : ''}</span><button type="button" class="link-btn sm">Remove</button></div>
      <div class="form-grid">
        <label>Label <input name="label" value="${esc(f.label ?? '')}" placeholder="What is it?" /></label>
        <label>${L.accountId || 'Account'} <select name="accountId" required data-hypo="${bookOnly ? '' : 'yes'}"${isRmd ? ' data-taxdeferred' : ''}>${accountOptions(f.accountId, { types: spendingCats ? ['EXPENSE', 'REVENUE'] : isRmd ? ['ASSET'] : ['ASSET', 'LIABILITY'], blank: 'Choose…', filter: isRmd ? (a) => TAX_DEFERRED.has(a.assetType) : undefined })}${bookOnly ? '' : hypoOptions(f.hypotheticalAccount, isRmd)}</select></label>
        ${fields.includes('targetAccountId') ? `<label>${L.targetAccountId} <select name="targetAccountId"${['TRANSFER', 'SPENDING', 'DISPOSE'].includes(f.flowType) ? ' required' : ''} data-hypo="${bookOnly ? '' : 'yes'}">${accountOptions(f.targetAccountId, { blank: '—' })}${bookOnly ? '' : hypoOptions(f.hypotheticalTargetAccount)}</select></label>` : ''}
        ${f.matchOf ? `<label>Match % of their contribution <input name="percent" type="number" step="any" value="${f.percent ?? ''}"/></label><label>Cap per occurrence <input name="ceilingAmount" type="number" step="any" value="${f.ceilingAmount ?? ''}"/></label>` : `${input('amount')}${input('percent')}`}
        ${!f.matchOf && fields.includes('cadenceMonths') ? `<label>${L.cadenceMonths} <select name="cadenceMonths">${[[1, 'Monthly'], [3, 'Quarterly'], [6, 'Twice a year'], [12, 'Yearly']].map(([v, t]) => `<option value="${v}"${Number(f.cadenceMonths ?? 1) === v ? ' selected' : ''}>${t}</option>`).join('')}</select></label>` : ''}
        ${f.matchOf ? '' : input('startDate', 'date') + input('endDate', 'date')}
        ${input('rate')}
        ${fields.includes('rmdPerson') ? `<label>Account owner <select name="personId" required>${personOptions(f.personId)}</select></label><p class="sub" style="grid-column: span 2; margin:0">Each January 1 from the year the owner turns 72, 73 or 75 (by birth year), the IRS minimum leaves the account, received less the income tax rate.</p>` : ''}
        ${!f.matchOf && fields.includes('person') && state.persons.length ? `<label>…or by age of <select name="personId">${personOptions(f.personId)}</select></label>${fields.includes('endDate') || f.flowType === 'ONE_TIME' || f.flowType === 'TARGET' ? `<label>From age <input name="startAge" type="number" value="${f.startAge ?? ''}"/></label>` : ''}${fields.includes('endDate') ? `<label>Until age <input name="endAge" type="number" value="${f.endAge ?? ''}"/></label>` : ''}` : ''}
        ${fields.includes('fallbackAccountIds') ? `<label style="grid-column: span 2">${L.fallbackAccountIds} <select name="fallbackAccountIds" multiple size="3">${accountOptions(null, { types: ['ASSET'] }).replace(/value="([^"]+)"/g, (m, id) => `${m}${(f.fallbackAccountIds || []).includes(id) ? ' selected' : ''}`)}</select></label>` : ''}
      </div>
      ${f.flowType === 'CONTRIBUTION' && !f.matchOf ? '<div class="row-actions"><button type="button" class="link-btn sm" data-add-match>+ Add employer match</button></div>' : ''}`;
    $('.head .link-btn', el).addEventListener('click', () => el.remove());
    // Refresh the hypothetical choices when opened: accounts may have been added or renamed since.
    $$('select[data-hypo=yes]', el).forEach((sel) => sel.addEventListener('focus', () => {
      const cur = sel.value;
      sel.querySelector('optgroup[data-hypo]')?.remove();
      sel.insertAdjacentHTML('beforeend', hypoOptions(cur.startsWith('hypo:') ? cur.slice(5) : null, sel.hasAttribute('data-taxdeferred')));
      sel.value = cur;
    }));
    $('[data-add-match]', el)?.addEventListener('click', () => addFlowEditor({ key: `new-${crypto.randomUUID()}`, flowType: 'CONTRIBUTION', matchOf: f.key, accountId: f.accountId, hypotheticalAccount: f.hypotheticalAccount ?? null, label: 'Employer match', percent: 50, fallbackAccountIds: [] }));
    $('#ed-flows', dlg).appendChild(el);
  }

  function hypoOptions(selectedKey, taxDeferredOnly = false) {
    const opts = $$('.acct-row', dlg).filter((r) => !taxDeferredOnly || TAX_DEFERRED.has($('[name=assetType]', r)?.value)).map((r) => `<option value="hypo:${r._acct.key}"${r._acct.key === selectedKey ? ' selected' : ''}>${esc($('[name=name]', r).value || 'new account')}</option>`).join('');
    return opts ? `<optgroup label="Planned in this scenario" data-hypo>${opts}</optgroup>` : '';
  }

  function addOverrideEditor(o) {
    const el = document.createElement('div');
    el.className = 'flow-row ov-row'; el._ov = o;
    el.innerHTML = `<div class="head"><span class="badge plain">Override</span><button type="button" class="link-btn sm">Remove</button></div><div class="form-grid">
      <label>Account <select name="accountId" required>${accountOptions(o.accountId, { blank: 'Choose…' })}</select></label>
      <label>Merchant (blank = the loan schedule) <input name="merchantName" list="merchant-list" value="${esc(o.merchantName ?? '')}"/></label>
      <label class="inline"><input type="checkbox" name="excluded"${o.excluded ? ' checked' : ''}/> drop it entirely</label>
      <label>From (blank = run start) <input name="startDate" type="date" value="${o.startDate ?? ''}"/></label>
      <label>Last day <input name="endDate" type="date" value="${o.endDate ?? ''}"/></label>
      ${state.persons.length ? `<label>…or by age of <select name="personId">${personOptions(o.personId)}</select></label><label>from age <input name="startAge" type="number" value="${o.startAge ?? ''}"/></label><label>until age <input name="endAge" type="number" value="${o.endAge ?? ''}"/></label>` : ''}
      <label>New amount <input name="amount" type="number" step="any" value="${o.amount ?? ''}"/></label>
      <label>Own growth % <input name="rate" type="number" step="any" value="${o.rate ?? ''}"/></label></div>`;
    $('.link-btn', el).addEventListener('click', () => el.remove());
    $('#ed-overrides', dlg).appendChild(el);
  }

  function addAccountEditor(a) {
    const el = document.createElement('div');
    el.className = 'flow-row acct-row'; el._acct = a;
    const others = () => $$('.acct-row', dlg).filter((r) => r !== el && $('[name=accountType]', r)?.value === 'ASSET').map((r) => r._acct);
    el.innerHTML = `<div class="head"><span class="badge plain">Hypothetical</span><button type="button" class="link-btn sm">Remove</button></div><div class="form-grid">
      <label>Name <input name="name" required value="${esc(a.name ?? '')}" placeholder="Lake house"/></label>
      <label>Type <select name="accountType"><option value="ASSET"${a.accountType === 'ASSET' ? ' selected' : ''}>Asset</option><option value="LIABILITY"${a.accountType === 'LIABILITY' ? ' selected' : ''}>Loan</option></select></label>
      <label>Value / principal <input name="openingBalance" type="number" step="any" required value="${a.openingBalance ?? ''}"/></label>
      <label>Appears on <input name="openDate" type="date" required value="${a.openDate ?? ''}"/></label>
      <label data-t="ASSET">Kind <select name="assetType">${[['', '—'], ['FIXED_ASSET', 'Property / vehicle'], ['BROKERAGE', 'Brokerage'], ['IRA', 'IRA'], ['ROTH', 'Roth IRA'], ['_401K', '401(k)'], ['SAVINGS', 'Savings'], ['CHECKING', 'Checking'], ['OTHER_ASSET', 'Other']].concat(a.assetType && !['FIXED_ASSET', 'BROKERAGE', 'IRA', 'ROTH', '_401K', 'SAVINGS', 'CHECKING', 'OTHER_ASSET'].includes(a.assetType) ? [[a.assetType, pretty(a.assetType)]] : []).map(([val, t]) => `<option value="${val}"${(a.assetType || '') === val ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
      <label data-t="ASSET">Down payment <input name="fundedAmount" type="number" step="any" value="${a.fundedAmount ?? ''}"/></label>
      <label data-t="ASSET">…from <select name="fundedFromAccountId">${accountOptions(a.fundedFromAccountId, { types: ['ASSET'], blank: '—' })}</select></label>
      <label data-t="ASSET">Appreciation % / yr <input name="appreciationRate" type="number" step="any" value="${a.appreciationRate ?? ''}"/></label>
      <label data-t="LIABILITY">APR % <input name="apr" type="number" step="any" value="${a.apr ?? ''}"/></label>
      <label data-t="LIABILITY">Term (months) <input name="termMonths" type="number" value="${a.termMonths ?? ''}"/></label>
      <label data-t="LIABILITY">Escrow / mo <input name="escrow" type="number" step="any" value="${a.escrow ?? ''}"/></label>
      <label data-t="LIABILITY">Paid from <select name="paymentFromAccountId">${accountOptions(a.paymentFromAccountId, { types: ['ASSET'], blank: '—' })}</select></label>
      <label data-t="LIABILITY">Secured by <select name="collateral"></select></label>
      <label>Sold / paid off on <input name="disposedOn" type="date" value="${a.disposedOn ?? ''}"/></label>
      <label>Proceeds to <select name="proceedsToAccountId">${accountOptions(a.proceedsToAccountId, { types: ['ASSET'], blank: '—' })}</select></label></div>`;
    const sync = () => {
      const t = $('[name=accountType]', el).value;
      $$('[data-t]', el).forEach((l) => { l.hidden = l.dataset.t !== t; });
      const cur = $('[name=collateral]', el).value || a.collateral || (a.collateralAccountId ? `book:${a.collateralAccountId}` : '');
      $('[name=collateral]', el).innerHTML = `<option value="">—</option>` +
        others().map((o) => `<option value="${o.key}"${o.key === cur ? ' selected' : ''}>${esc($('[name=name]', $$('.acct-row', dlg).find((r) => r._acct === o)).value || 'new asset')}</option>`).join('') +
        state.accounts.filter((x) => x.accountType === 'ASSET').map((x) => `<option value="book:${x.id}"${`book:${x.id}` === cur ? ' selected' : ''}>${esc(x.name)}</option>`).join('');
    };
    $('[name=accountType]', el).addEventListener('change', sync);
    el.addEventListener('focusin', (e) => { if (e.target.name === 'collateral') sync(); });
    $('.link-btn', el).addEventListener('click', () => el.remove());
    $('#ed-accounts', dlg).appendChild(el);
    sync();
  }

  form.addEventListener('submit', async (e) => {
    if (e.submitter?.value !== 'save') return;
    e.preventDefault();
    const v = (root, n) => $(`[name="${n}"]`, root)?.value ?? '';
    const out = {
      ...body,
      name: form.scenarioName.value.trim(),
      horizonYears: form.horizonMode.value === 'years' ? numOrNull(form.horizonYears.value) : body.horizonYears,
      horizonPersonId: form.horizonMode.value === 'age' ? form.horizonPersonId.value || null : null,
      horizonAge: form.horizonMode.value === 'age' ? numOrNull(form.horizonAge.value) : null,
      inflationRate: numOrNull(form.inflationRate.value),
      returnRate: numOrNull(form.returnRate.value),
      incomeGrowthRate: numOrNull(form.incomeGrowthRate.value),
      taxRate: numOrNull(form.taxRate.value),
      volatility: numOrNull(form.volatility.value),
      flows: $$('.flow-row', $('#ed-flows', dlg)).map((r) => {
        const f = r._flow;
        const personId = v(r, 'personId') || null;
        const startAge = personId ? numOrNull(v(r, 'startAge')) : null;
        const endAge = personId ? numOrNull(v(r, 'endAge')) : null;
        return {
          ...f,
          label: v(r, 'label') || null,
          ...accountRef(v(r, 'accountId'), 'accountId', 'hypotheticalAccount'),
          ...($('[name=targetAccountId]', r) ? accountRef(v(r, 'targetAccountId'), 'targetAccountId', 'hypotheticalTargetAccount') : {}),
          amount: $('[name=amount]', r) ? numOrNull(v(r, 'amount')) : f.amount ?? null,
          percent: $('[name=percent]', r) ? numOrNull(v(r, 'percent')) : f.percent ?? null,
          ceilingAmount: $('[name=ceilingAmount]', r) ? numOrNull(v(r, 'ceilingAmount')) : f.ceilingAmount ?? null,
          rate: $('[name=rate]', r) ? numOrNull(v(r, 'rate')) : f.rate ?? null,
          cadenceMonths: f.matchOf ? null : $('[name=cadenceMonths]', r) ? numOrNull(v(r, 'cadenceMonths')) : null,
          startDate: startAge != null ? null : $('[name=startDate]', r) ? v(r, 'startDate') || null : f.startDate ?? null,
          endDate: endAge != null ? null : $('[name=endDate]', r) ? v(r, 'endDate') || null : f.endDate ?? null,
          ...(f.flowType === 'RMD' ? { amount: null, percent: null, rate: null, cadenceMonths: null, startDate: null, endDate: null, startAge: null, endAge: null } : {}),
          // An RMD is dated by its person alone; every other flow names a person only with an age.
          personId: f.flowType === 'RMD' ? personId : startAge != null || endAge != null ? personId : null,
          startAge, endAge,
          fallbackAccountIds: $('[name=fallbackAccountIds]', r) ? [...$('[name=fallbackAccountIds]', r).selectedOptions].map((o) => o.value) : f.fallbackAccountIds || [],
        };
      }),
      streamOverrides: $$('.ov-row', dlg).map((r) => {
        const personId = v(r, 'personId') || null;
        const endAge = personId ? numOrNull(v(r, 'endAge')) : null;
        const startAge = personId ? numOrNull(v(r, 'startAge')) : null;
        return {
          accountId: v(r, 'accountId'), merchantName: v(r, 'merchantName').trim() || null, excluded: $('[name=excluded]', r).checked,
          startDate: startAge != null ? null : v(r, 'startDate') || null, startAge,
          endDate: endAge != null ? null : v(r, 'endDate') || null, personId: endAge != null || startAge != null ? personId : null, endAge,
          amount: numOrNull(v(r, 'amount')), rate: numOrNull(v(r, 'rate')),
        };
      }),
      accounts: $$('.acct-row', dlg).map((r) => {
        const t = v(r, 'accountType'), coll = v(r, 'collateral');
        const onlyFor = (type, x) => (t === type ? x : null);
        return {
          ...r._acct, name: v(r, 'name'), accountType: t, openingBalance: numOrNull(v(r, 'openingBalance')), openDate: v(r, 'openDate') || null,
          assetType: onlyFor('ASSET', v(r, 'assetType') || null),
          fundedAmount: onlyFor('ASSET', numOrNull(v(r, 'fundedAmount'))), fundedFromAccountId: onlyFor('ASSET', v(r, 'fundedFromAccountId') || null),
          appreciationRate: onlyFor('ASSET', numOrNull(v(r, 'appreciationRate'))),
          apr: onlyFor('LIABILITY', numOrNull(v(r, 'apr'))), termMonths: onlyFor('LIABILITY', numOrNull(v(r, 'termMonths'))),
          escrow: onlyFor('LIABILITY', numOrNull(v(r, 'escrow'))), paymentFromAccountId: onlyFor('LIABILITY', v(r, 'paymentFromAccountId') || null),
          collateral: t === 'LIABILITY' && coll && !coll.startsWith('book:') ? coll : null,
          collateralAccountId: t === 'LIABILITY' && coll.startsWith('book:') ? coll.slice(5) : null,
          disposedOn: v(r, 'disposedOn') || null, proceedsToAccountId: v(r, 'proceedsToAccountId') || null,
        };
      }),
      excludedAccountIds: $$('#ed-excluded input:checked', dlg).map((i) => i.value),
    };
    // A match whose matched contribution was removed has nothing to follow, and a flow
    // can't name a hypothetical account that was removed.
    const keys = new Set(out.flows.map((f) => f.key));
    const acctKeys = new Set(out.accounts.map((a) => a.key));
    out.flows = out.flows.filter((f) => (!f.matchOf || keys.has(f.matchOf)) && (!f.hypotheticalAccount || acctKeys.has(f.hypotheticalAccount)));
    out.flows.forEach((f) => { if (f.hypotheticalTargetAccount && !acctKeys.has(f.hypotheticalTargetAccount)) f.hypotheticalTargetAccount = null; });
    const errBox = $('.dlg-body > .error', dlg); errBox.hidden = true;
    $('#ed-save', dlg).disabled = true;
    try {
      const { data } = existing ? await api.updateScenario(existing.id, existing.version, out) : await api.createScenario(out);
      dlg.close();
      state.selectedScenario = data.id;
      await loadScenarios();
    } catch (err) {
      showErr(errBox, err);
      if (err.code === 'conflict') { dlg.close(); selectScenario(existing.id); }
    } finally { $('#ed-save', dlg).disabled = false; }
  });
  dlg.showModal();
}

// ============================================================ Compare
function renderComparePicks() {
  state.comparePicks = state.comparePicks.filter((id) => state.scenarios.some((s) => s.id === id));
  $('#cmp-picks').innerHTML = state.scenarios.map((s) => {
    const i = state.comparePicks.indexOf(s.id);
    return `<button type="button" class="chip${i >= 0 ? ' is-on' : ''}" data-id="${s.id}">${i >= 0 ? `<span class="ord">${i === 0 ? 'BASE' : i + 1}</span>` : ''}${esc(s.name)}</button>`;
  }).join('') || '<span class="muted">Create a scenario first.</span>';
  $$('#cmp-picks .chip').forEach((c) => c.addEventListener('click', () => {
    const i = state.comparePicks.indexOf(c.dataset.id);
    if (i >= 0) state.comparePicks.splice(i, 1); else state.comparePicks.push(c.dataset.id);
    renderComparePicks();
  }));
}

async function runCompare() {
  const tab = $('#tab-compare'); clearErr(tab);
  if (!state.comparePicks.length) return showErr(tab, new Error('Tick at least one scenario.'));
  const rates = { returnRates: parseList($('#cmp-return').value), inflationRates: parseList($('#cmp-inflation').value), incomeGrowthRates: parseList($('#cmp-income').value), taxRates: parseList($('#cmp-tax').value) };
  // Each rate is a variant of its own; runs = scenarios × (1 + variants), at most 12.
  const runs = state.comparePicks.length * (1 + rates.returnRates.length + rates.inflationRates.length + rates.incomeGrowthRates.length + rates.taxRates.length);
  if (runs > 12) return showErr(tab, new Error(`That's ${runs} runs (each scenario once, plus once per rate); the API allows at most 12. Untick a scenario or drop a rate.`));
  const out = $('#cmp-result');
  out.innerHTML = `<div class="card placeholder">Running ${runs} run${runs > 1 ? 's' : ''}…</div>`;
  try {
    renderCompare(out, await api.compare(state.comparePicks, { ...rates, step: 30, unitType: state.unit }));
  } catch (e) { out.innerHTML = ''; showErr(tab, e); }
}

function renderCompare(out, c) {
  const base = c.comparisons[0];
  const lastOf = (series) => series.points[series.points.length - 1]?.balance;
  const deltaByKey = new Map(c.deltas.map((d) => [d.key, d]));
  const shown = c.comparisons.slice(0, 8);
  // A hypothetical account has a different id in every scenario; the API matches it to the
  // first run's by name and unit type, so rows do the same.
  const rowKey = (a) => (a.hypothetical ? `hypo:${a.accountName}|${a.unitType}` : a.accountId);
  const rows = new Map();
  for (const d of c.deltas) for (const a of d.accounts) {
    const k = rowKey(a);
    if (!rows.has(k)) rows.set(k, { name: a.accountName, hypo: a.hypothetical, byKey: new Map(), max: 0 });
    const row = rows.get(k); row.byKey.set(d.key, a); row.max = Math.max(row.max, Math.abs(a.delta));
  }
  const topRows = [...rows.values()].filter((r) => r.max > 0.5).sort((a, b) => b.max - a.max).slice(0, 10);
  const baseNet = netSeries(base);

  out.innerHTML = `<div class="card"><div class="card-head"><h2>Net position by run</h2><span class="muted">${fmtDate(c.fromDate)} → ${fmtDate(c.toDate)}</span></div>
    <figure class="chart" id="cmp-chart"></figure>${c.comparisons.length > 8 ? `<p class="muted">Plotting the first 8 of ${c.comparisons.length} runs; all are in the table.</p>` : ''}</div>
    <div class="card"><div class="card-head"><h2>Side by side</h2><span class="muted">differences are against “${esc(base.key)}”</span></div><div class="table-scroll"><table class="data">
      <thead><tr><th>Run</th><th class="num">Net position at horizon</th><th class="num">vs baseline</th><th>Withdrawals funded</th><th>Targets on track</th></tr></thead><tbody>
      ${c.comparisons.map((r, i) => { const n = netSeries(r); const d = deltaByKey.get(r.key); const dn = d && netSeries(d); const short = r.funding.filter((x) => !x.funded).length;
        return `<tr><td>${i < 8 ? `<i style="display:inline-block;width:10px;height:3px;border-radius:2px;vertical-align:middle;margin-right:6px;background:${SERIES[i]}"></i>` : ''}${esc(r.key)}</td>
          <td class="num">${money(lastOf(n), n.unit)}</td><td class="num">${i === 0 ? '<span class="muted">baseline</span>' : signed(dn && lastOf(dn), dn?.unit)}</td>
          <td>${r.funding.length ? (short ? `<span class="badge bad">${short} short</span>` : '<span class="badge good">all funded</span>') : '<span class="muted">—</span>'}</td>
          <td>${r.targets.length ? `${r.targets.filter((t) => t.onTrack).length} / ${r.targets.length}` : '<span class="muted">—</span>'}</td></tr>`; }).join('')}
      </tbody></table></div></div>
    ${topRows.length ? `<div class="card"><div class="card-head"><h2>Where the difference lands</h2><span class="muted">closing balance vs baseline</span></div><div class="table-scroll"><table class="data">
      <thead><tr><th>Account</th>${c.deltas.map((d) => `<th class="num">${esc(d.key)}</th>`).join('')}</tr></thead><tbody>
      ${topRows.map((row) => `<tr><td>${esc(row.name)}${row.hypo ? ' <span class="badge plain">planned</span>' : ''}</td>${c.deltas.map((d) => { const x = row.byKey.get(d.key); return `<td class="num">${x ? signed(x.delta, x.unitType) : '—'}</td>`; }).join('')}</tr>`).join('')}
      </tbody></table></div></div>` : ''}`;
  lineChart($('#cmp-chart', out), shown.map((r) => ({ name: r.key, points: netSeries(r).points })), {
    fmt: (v) => money(v, baseNet.unit), compact: compactMoney(baseNet.unit), zeroLine: true,
  });
}

// ============================================================ Monte Carlo
const lastSeed = new Map(); // scenario id (or ids joined) → seed of the last simulation
async function simulateScenario(s) {
  const out = $('#sc-sim');
  const same = $('#sim-same').checked && lastSeed.has(s.id);
  out.innerHTML = '<div class="placeholder">Running the market paths…</div>';
  try {
    const sim = await api.simulate(s.id, {
      paths: Number($('#sim-paths').value), seed: same ? lastSeed.get(s.id) : undefined,
      volatility: numOrNull($('#sim-vol').value), returnRate: numOrNull($('#sim-return').value),
    });
    lastSeed.set(s.id, sim.seed);
    $('#sim-same').disabled = false;
    renderSimulation(out, sim, Number($('#sim-paths').value));
  } catch (e) { out.innerHTML = `<div class="error">${describeError(e)}</div>`; }
}

async function simulateTogether() {
  const tab = $('#tab-compare'); clearErr(tab);
  if (!state.comparePicks.length) return showErr(tab, new Error('Tick the scenarios to simulate together.'));
  const out = $('#cmp-result');
  out.innerHTML = '<div class="card placeholder">Running the scenarios together over the market paths…</div>';
  try {
    const sim = await api.simulateTogether(state.comparePicks, { paths: 500 });
    const names = state.comparePicks.map((id) => state.scenarios.find((x) => x.id === id)?.name).map(esc).join(' + ');
    out.innerHTML = `<div class="banner">Simulated together: <b>${names}</b></div><div class="card" id="sim-together"></div>`;
    renderSimulation($('#sim-together'), sim, 500);
  } catch (e) { out.innerHTML = ''; showErr(tab, e); }
}

// Renders a SimulateScenariosResponse: success rate, net position band, funding and targets odds.
function renderSimulation(out, sim, requested) {
  const pctTxt = (n) => `${Math.round(n)}%`;
  const odds = (n) => `<span class="badge ${n >= 85 ? 'good' : n >= 60 ? 'warn' : 'bad'}">${pctTxt(n)}</span>`;
  const band = sim.netPositions.find((n) => n.unitType === state.unit) || sim.netPositions[0];
  const end = band?.points[band.points.length - 1];
  const vol = sim.assumptions[0]?.assumptions.volatility;
  const market = sim.marketAccountIds.map((id) => sim.accounts.find((a) => a.id === id)?.name || accountName(id));
  const risky = sim.accounts.filter((a) => a.belowZeroPercent > 0).sort((a, b) => b.belowZeroPercent - a.belowZeroPercent);
  out.innerHTML = `<div class="tiles" style="margin-top:12px">
      ${tile('Plan succeeds', sim.successPercent != null ? pctTxt(sim.successPercent) : '—', sim.successPercent != null ? 'of paths fund every withdrawal' : 'no withdrawals to fund')}
      ${tile(`Net position at horizon (${band?.unitType || ''})`, money(end?.median, band?.unitType), end ? `${money(end.low, band.unitType)} – ${money(end.high, band.unitType)} (10th–90th)` : '')}
      ${tile('Paths', String(sim.paths), `seed ${sim.seed}${requested && requested !== sim.paths ? ` · ${requested} requested` : ''}`)}
      ${tile('Volatility', vol ? pct(vol.rate) : '—', vol ? pretty(vol.source) : '')}
    </div>
    <figure class="chart sim-chart"></figure>
    ${sim.netPositions.length > 1 ? `<p class="muted">Other currencies, shown unconverted: ${sim.netPositions.filter((n) => n !== band).map((n) => `${n.unitType} median ${money(n.points.at(-1)?.median, n.unitType)}`).join(' · ')}</p>` : ''}
    <p class="muted">The market moved ${market.length ? market.map(esc).join(', ') : 'no accounts'}; every other account grows as stated on every path.</p>
    ${sim.funding.length ? `<h3>Withdrawals</h3><table class="data"><thead><tr><th>Funding account</th><th>Funded on</th><th>When it falls short</th></tr></thead><tbody>${sim.funding.map((f) =>
      `<tr><td>${esc(f.accountName)}<div class="sub">${f.withdrawals.map(esc).join(', ')}</div></td><td>${odds(f.fundedPercent)} of paths</td><td class="sub">${f.medianShortDate ? `typically ${fmtDate(f.medianShortDate, { month: 'short', year: 'numeric' })}, short ${money(f.medianShortfall, f.unitType)}` : 'never'}</td></tr>`).join('')}</tbody></table>` : ''}
    ${sim.targets.length ? `<h3>Targets</h3><table class="data"><thead><tr><th>Goal</th><th class="num">Target</th><th>Reached on</th><th class="num">Projected (10th · median · 90th)</th></tr></thead><tbody>${sim.targets.map((t) =>
      `<tr><td>${esc(t.label || t.accountName)}<div class="sub">${esc(t.accountName)} by ${fmtDate(t.date)}${t.plannedOpenDate ? ` · opens only ${fmtDate(t.plannedOpenDate)}` : ''}</div></td><td class="num">${money(t.target, t.unitType)}</td><td>${odds(t.onTrackPercent)} of paths</td><td class="num">${money(t.projected.low, t.unitType)} · <b>${money(t.projected.median, t.unitType)}</b> · ${money(t.projected.high, t.unitType)}</td></tr>`).join('')}</tbody></table>` : ''}
    ${risky.length ? `<h3>Accounts that dip below zero</h3><ul class="sub">${risky.map((a) => `<li>${esc(a.name)}${a.hypothetical ? ' (planned)' : ''}: on ${pctTxt(a.belowZeroPercent)} of paths${a.accountType === 'LIABILITY' ? ' (a credit balance)' : ''}</li>`).join('')}</ul>` : ''}`;
  if (band) lineChart($('.sim-chart', out), [{ name: `Net position (${band.unitType})`, band: true, points: band.points }], {
    fmt: (v) => money(v, band.unitType), compact: compactMoney(band.unitType), zeroLine: true,
  });
}

async function runTogether() {
  const tab = $('#tab-compare'); clearErr(tab);
  if (!state.comparePicks.length) return showErr(tab, new Error('Tick the scenarios to run together.'));
  const out = $('#cmp-result');
  out.innerHTML = '<div class="card placeholder">Running the scenarios as one plan…</div>';
  try {
    const run = await api.runTogether(state.comparePicks, { step: 30, stress: -30, period: 'YEAR', unitType: state.unit });
    const names = state.comparePicks.map((id) => state.scenarios.find((s) => s.id === id)?.name).map(esc).join(' + ');
    out.innerHTML = `<div class="banner">Combined run: <b>${names}</b></div><div id="together"></div>`;
    renderRun($('#together'), run);
  } catch (e) { out.innerHTML = ''; showErr(tab, e); }
}

// ============================================================ Debt payoff
let debtTimer;
async function loadDebt() {
  const tab = $('#tab-debt'); clearErr(tab);
  const extra = Number($('#debt-extra').value) || 0;
  $$('#debt-quick button').forEach((b) => b.classList.toggle('is-active', Number(b.dataset.v) === extra));
  try { renderDebt(await api.debtPayoff({ extra, unitType: state.unit })); } catch (e) { $('#debt-result').innerHTML = ''; showErr(tab, e); }
}

function renderDebt(d) {
  const out = $('#debt-result');
  const u = d.unitType;
  if (!d.debts.length) {
    out.innerHTML = `<div class="card placeholder">No ${u} debts with enough terms to plan.${d.skipped.length ? '' : ' Nothing is owed.'}</div>` + skippedHtml(d);
    return;
  }
  const order = ['MINIMUM', 'AVALANCHE', 'SNOWBALL'];
  const strategies = order.map((k) => d.strategies.find((s) => s.strategy === k)).filter(Boolean);
  const best = strategies.filter((s) => s.strategy !== 'MINIMUM').sort((a, b) => a.totalInterest - b.totalInterest)[0];
  const blurb = { MINIMUM: 'Minimums only', AVALANCHE: 'Avalanche — highest APR first', SNOWBALL: 'Snowball — smallest balance first' };
  out.innerHTML = `<div class="cards" style="margin-bottom:16px">${strategies.map((s, i) => `<div class="mini"><div class="title"><span><i style="display:inline-block;width:10px;height:3px;border-radius:2px;vertical-align:middle;margin-right:6px;background:${SERIES[i]}"></i>${blurb[s.strategy]}</span>${s === best ? '<span class="badge good">least interest</span>' : ''}</div><dl>
      <dt>Debt-free</dt><dd>${s.payoffDate ? fmtDate(s.payoffDate, { month: 'short', year: 'numeric' }) : '<span class="neg">not within 50 years</span>'}</dd>
      <dt>Months</dt><dd>${s.months ?? '—'}${s.monthsSaved ? ` <span class="pos">(${s.monthsSaved} sooner)</span>` : ''}</dd>
      <dt>Total interest</dt><dd>${money(s.totalInterest, u)}</dd>
      ${s.strategy !== 'MINIMUM' ? `<dt>Interest saved</dt><dd class="pos">${money(s.interestSaved, u)}</dd>` : ''}
      <dt>Total paid</dt><dd>${money(s.totalPaid, u)}</dd></dl>
      <div class="sub" style="margin-top:6px">Order: ${s.payoffs.map((p) => esc(p.accountName)).join(' → ')}</div></div>`).join('')}</div>
    <div class="card"><div class="card-head"><h2>Total owed, month by month</h2><span class="muted">with ${money(d.extraPayment, u)} extra a month from ${fmtDate(d.fromDate, { month: 'short', year: 'numeric' })}</span></div><figure class="chart" id="debt-chart"></figure></div>
    <div class="card"><div class="card-head"><h2>Debts</h2></div><div class="table-scroll"><table class="data"><thead><tr><th>Debt</th><th class="num">Balance</th><th class="num">APR</th><th class="num">Minimum</th>${strategies.map((s) => `<th class="num">${pretty(s.strategy)} payoff</th>`).join('')}</tr></thead><tbody>
      ${d.debts.map((x) => `<tr><td>${esc(x.accountName)}<div class="sub">${pretty(x.liabilityType)}</div></td><td class="num">${money(x.balance, u)}</td><td class="num">${pct(x.apr)}</td><td class="num">${money(x.minimumPayment, u)}</td>${strategies.map((s) => { const p = s.payoffs.find((y) => y.accountId === x.accountId); return `<td class="num">${fmtDate(p?.payoffDate, { month: 'short', year: 'numeric' })}<div class="sub">${money(p?.interestPaid, u)} interest</div></td>`; }).join('')}</tr>`).join('')}
    </tbody></table></div></div>${skippedHtml(d)}`;
  lineChart($('#debt-chart'), strategies.map((s) => ({ name: pretty(s.strategy), points: s.balances })), { fmt: (v) => money(v, u), compact: compactMoney(u) });
}
const skippedHtml = (d) => (d.skipped.length ? `<div class="card"><div class="card-head"><h2>Left out of the plan</h2><span class="muted">add the missing loan terms to include them</span></div><table class="data"><tbody>${d.skipped.map((s) => `<tr><td>${esc(s.accountName)}<div class="sub">${pretty(s.liabilityType)}</div></td><td>${esc(s.reason)}</td></tr>`).join('')}</tbody></table></div>` : '');

// ============================================================ Planning
let assumptionsVersion = null;
async function loadPlanning() {
  const tab = $('#tab-planning'); clearErr(tab);
  try {
    const [{ data: a, etag }, ps] = await Promise.all([api.assumptions(), api.persons()]);
    assumptionsVersion = a.version ?? etag ?? null;
    const f = $('#assump-form');
    const own = a.version != null;
    for (const [field, key] of [['inflationRate', 'inflation'], ['returnRate', 'investmentReturn'], ['incomeGrowthRate', 'incomeGrowth'], ['taxRate', 'incomeTax'], ['volatility', 'volatility']]) {
      const r = a.assumptions[key];
      if (!r) continue;
      f[field].value = own && r.source === 'PARTY' ? r.rate : '';
      f[field].placeholder = `${r.rate}`;
      $(`[data-src=${key}]`, f).textContent = r.source === 'PARTY' ? 'yours' : `default ${pct(r.rate)}`;
    }
    state.persons = ps.persons;
    renderPersons();
  } catch (e) { showErr(tab, e); }
}

async function saveAssumptions(e) {
  e.preventDefault();
  const tab = $('#tab-planning'); clearErr(tab);
  const f = e.target;
  try {
    await api.saveAssumptions(assumptionsVersion, {
      inflationRate: numOrNull(f.inflationRate.value), returnRate: numOrNull(f.returnRate.value), incomeGrowthRate: numOrNull(f.incomeGrowthRate.value),
      taxRate: numOrNull(f.taxRate.value), volatility: numOrNull(f.volatility.value),
    });
    flash('Assumptions saved — scenarios without their own rates pick them up on their next run.');
    await loadPlanning();
  } catch (err) { showErr(tab, err); if (err.code === 'conflict') loadPlanning(); }
}

function renderPersons() {
  $('#persons').innerHTML = state.persons.length
    ? `<thead><tr><th>Name</th><th>Born</th><th class="num">Age</th><th></th></tr></thead><tbody>${state.persons.map((p) =>
      `<tr data-id="${p.id}"><td>${esc(p.name)}</td><td>${fmtDate(p.birthDate)}</td><td class="num">${p.age}</td><td class="num"><button class="link-btn sm" data-act="edit">Edit</button> · <button class="link-btn sm" data-act="del">Remove</button></td></tr>`).join('')}</tbody>`
    : '<tbody><tr><td class="muted">No one yet. Add the people your plans are dated by.</td></tr></tbody>';
  $$('#persons tr[data-id]').forEach((tr) => {
    const p = state.persons.find((x) => x.id === tr.dataset.id);
    $('[data-act=edit]', tr).addEventListener('click', () => editPerson(tr, p));
    $('[data-act=del]', tr).addEventListener('click', async () => {
      if (!confirm(`Remove ${p.name}? Only possible while no scenario is dated by their age.`)) return;
      try { await api.deletePerson(p.id, p.version); await loadPlanning(); } catch (e) { showErr($('#tab-planning'), e); }
    });
  });
}

function editPerson(tr, p) {
  tr.innerHTML = `<td><input name="name" value="${esc(p.name)}"/></td><td><input name="birthDate" type="date" value="${p.birthDate}"/></td><td></td><td class="num"><button class="primary-btn" data-act="save">Save</button> <button class="link-btn sm" data-act="cancel">Cancel</button></td>`;
  $('[data-act=cancel]', tr).addEventListener('click', renderPersons);
  $('[data-act=save]', tr).addEventListener('click', async () => {
    try {
      await api.updatePerson(p.id, p.version, { name: $('[name=name]', tr).value, birthDate: $('[name=birthDate]', tr).value });
      await loadPlanning();
    } catch (e) { showErr($('#tab-planning'), e); if (e.code === 'conflict') loadPlanning(); }
  });
}

async function addPerson(e) {
  e.preventDefault();
  const f = e.target;
  try {
    await api.createPerson({ name: f.name.value.trim(), birthDate: f.birthDate.value });
    f.reset();
    await loadPlanning();
  } catch (err) { showErr($('#tab-planning'), err); }
}

// ============================================================ shell
const LOADERS = { forecast: loadForecast, upcoming: loadUpcoming, month: loadMonthEnd, scenarios: loadScenarios, compare: loadScenarios, debt: loadDebt, planning: loadPlanning };

function showTab(name, force = false) {
  state.tab = name;
  $$('.tabs button').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === name));
  $$('section.tab').forEach((s) => { s.hidden = s.id !== `tab-${name}`; });
  if (force || !state.loaded.has(name)) { state.loaded.add(name); LOADERS[name](); }
}

function reloadAll() { state.loaded.clear(); state.lastForecast = null; loadAccounts().then(() => showTab(state.tab, true)); }

async function loadAccounts() {
  try {
    const r = await api.accounts();
    state.accounts = (r.accounts || []).map((a) => ({ id: a.id, name: a.name, accountType: a.accountType, assetType: a.assetType ?? null }));
    state.accountsById = new Map(state.accounts.map((a) => [a.id, a]));
  } catch (e) { console.warn('accounts', e); }
  // Merchant names for override suggestions; best effort.
  api.upcoming({ days: 90 }).then((u) => { state.merchants = [...new Set(u.items.map((i) => i.merchantName).filter(Boolean))]; }).catch(() => {});
}

// ============================================================ Plaid Link
// POST /v1/plaid/public/token → Plaid.create({ token }) → the user picks a bank → onSuccess →
// POST /v1/plaid/access/token, which exchanges the public token server-side and imports the item.
// No Plaid credential ever reaches the browser: BigBooks calls Plaid with the client id and
// secret stored on the account (see the README's "Bring your own Plaid credentials").
let linking = false;
function setLinkBusy(busy) {
  linking = busy;
  for (const el of [$('#link-btn'), $('#empty-link-btn')]) { el.disabled = busy; el.textContent = busy ? 'Opening Plaid…' : el.dataset.label; }
}
async function openPlaidLink() {
  if (linking) return;
  if (state.demo) return flash('Demo mode — linking is disabled.');
  if (!window.Plaid) return showBanner('Plaid Link failed to load — check your network or ad blocker, then reload.');
  setLinkBusy(true);
  try {
    const { token } = await api.plaidLinkToken({ clientName: 'BigBooks Forecast', language: 'en', countryCodes: ['US'], clientUserId: state.party });
    window.Plaid.create({
      token,
      onSuccess: async (publicToken, metadata) => {
        try {
          const inst = metadata.institution || {};
          // PlaidAccessTokenBody takes exactly these fields; the Link metadata's accounts aren't one of them.
          await api.plaidExchange({
            publicToken, party: state.party, linkSessionId: metadata.link_session_id,
            // The API's own webhook endpoint, the one it registers when minting the link token.
            webhook: `${CONFIG.API}/v1/plaid/webhook`,
            institution: inst.institution_id ? { id: inst.institution_id, name: inst.name } : null,
          });
          flash('Account linked — importing balances and transactions…');
          $('#empty').hidden = true;
          reloadAll();
        } catch (e) {
          if (e instanceof AuthExpired) return showConnect('Your session expired. Please sign in again.');
          showBanner(`Linking failed: ${describeError(e)}`);
        } finally { setLinkBusy(false); }
      },
      onExit: (err) => {
        setLinkBusy(false);
        if (err) showBanner(`Plaid Link: ${esc(err.display_message || err.error_message || err.error_code || 'exited before finishing.')}`);
      },
    }).open();
  } catch (e) {
    setLinkBusy(false);
    if (e instanceof AuthExpired) return showConnect('Your session expired. Please sign in again.');
    showBanner(`Could not start Plaid Link: ${describeError(e)}${e.code === 'internal_error' ? '<br><span class="muted">If it says the Plaid secret could not be resolved, store your Plaid client id and secret on your BigBooks account first.</span>' : ''}`);
  }
}
// Nothing linked means nothing to project: say so up front instead of showing empty charts.
async function checkLinkedAccounts() {
  try { $('#empty').hidden = (await api.plaidItems()).items.some((i) => i.itemStatus !== 'REMOVED'); } catch (e) { console.warn('plaid items', e); }
}
function showBanner(html) { $('#banner').innerHTML = html; $('#banner').hidden = false; }

let toastTimer;
function flash(msg) {
  let t = $('#toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'banner'; t.style.cssText = 'position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:40;box-shadow:var(--shadow)'; document.body.appendChild(t); }
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
}

function showConnect(msg) {
  $('#app').hidden = true; $('#global-controls').hidden = true; $('#connect').hidden = false;
  if (msg) $('#connect-msg').textContent = msg;
  $('#connect-btn').disabled = !CONFIG.CLIENT_ID;
  if (!CONFIG.CLIENT_ID) $('#connect-btn').title = 'Set CLIENT_ID in forecast/config.js';
  $('#paste-token').hidden = !CONFIG.ALLOW_PASTED_TOKEN;
}

async function startApp(send, banner) {
  api = endpoints(send, state);
  $('#connect').hidden = true; $('#app').hidden = false; $('#global-controls').hidden = false;
  if (banner) showBanner(banner);
  if (!state.demo) checkLinkedAccounts();
  await loadAccounts();
  showTab('forecast');
}

function wireUi() {
  $('#link-btn').addEventListener('click', openPlaidLink);
  $('#empty-link-btn').addEventListener('click', openPlaidLink);
  // Demo mode is read once at start-up, so toggling #demo has to reload rather than leave a
  // signed-out page sitting behind a hash it never looked at again.
  window.addEventListener('hashchange', () => window.location.reload());
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  $$('[data-perspective]').forEach((b) => b.addEventListener('click', () => {
    $$('[data-perspective]').forEach((x) => x.classList.toggle('is-active', x === b));
    state.perspective = b.dataset.perspective; reloadAll();
  }));
  $('#unit').addEventListener('change', (e) => { state.unit = e.target.value; reloadAll(); });
  $('#signout').addEventListener('click', () => { clearToken(); location.hash = ''; location.reload(); });
  $('#connect-btn').addEventListener('click', () => beginLogin());
  $('#paste-form').addEventListener('submit', (e) => {
    e.preventDefault();
    setToken({ access_token: e.target.token.value.trim(), expires_in: 3600 }, e.target.party.value.trim());
    location.reload();
  });
  $('#fc-days').addEventListener('change', loadForecast);
  $('#fc-baseline').addEventListener('change', () => { state.lastForecast = null; loadForecast(); });
  $('#planned-form').addEventListener('submit', savePlanned);
  $('#planned-cancel').addEventListener('click', resetPlannedForm);
  $('#declare-form').addEventListener('submit', saveDeclaration);
  $('#declare-form').accountId.addEventListener('change', fillDeclareForm);
  $('#me-month').addEventListener('change', loadMonthEnd);
  $('#cmp-sim-together').addEventListener('click', simulateTogether);
  $('#wi-add').addEventListener('click', addWhatIfRow);
  $('#wi-run').addEventListener('click', runWhatIf);
  $('#up-days').addEventListener('change', loadUpcoming);
  $('#sc-new').addEventListener('click', () => openEditor(null));
  $('#cmp-run').addEventListener('click', runCompare);
  $('#cmp-together').addEventListener('click', runTogether);
  $('#debt-extra').addEventListener('input', () => { clearTimeout(debtTimer); debtTimer = setTimeout(loadDebt, 350); });
  $$('#debt-quick button').forEach((b) => b.addEventListener('click', () => { $('#debt-extra').value = b.dataset.v; loadDebt(); }));
  $('#assump-form').addEventListener('submit', saveAssumptions);
  $('#person-form').addEventListener('submit', addPerson);
}

async function init() {
  wireUi();
  if (location.hash.includes('demo')) {
    const { demoSend, DEMO_PARTY } = await import('./demo.js');
    state.party = DEMO_PARTY;
    state.demo = true;
    return startApp(demoSend, '<strong>Demo data</strong> — a synthetic household answering in the API\'s response shapes. Remove <code>#demo</code> from the URL and sign in for your own books.');
  }
  try { await completeRedirect(); } catch (e) { showConnect(); $('#connect-msg').textContent = e.message; return; }
  if (!getToken()) return showConnect();
  try { state.party = await resolveParty(); } catch (e) { showConnect(e.message); return; }
  startApp(http);
}

init();
