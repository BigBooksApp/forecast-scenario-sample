// Demo backend: answers the same routes as the API, in the spec's response
// shapes, from a small day-by-day simulation of a synthetic household. It lets
// the UI be previewed (#demo) without an account. Figures are illustrative only.

export const DEMO_PARTY = '00000000-0000-4000-8000-000000000001';
const uid = () => crypto.randomUUID();
const TODAY = new Date().toISOString().slice(0, 10);
const d2ms = (iso) => Date.parse(iso + 'T00:00:00Z');
const ms2d = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (iso, n) => ms2d(d2ms(iso) + n * 86400000);
const addMonths = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return ms2d(d.getTime()); };
const dayOf = (iso) => Number(iso.slice(8, 10));
const monthsBetween = (a, b) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7));
const round2 = (n) => Math.round(n * 100) / 100;
const pmt = (bal, apr, n) => { const r = apr / 1200; return r ? (bal * r) / (1 - (1 + r) ** -n) : bal / n; };

// ------------------------------------------------------------------ books
const A = (name, accountType, opening, extra = {}) => ({ id: uid(), name, accountType, unitType: 'USD', opening, ...extra });
const acct = {
  chk: A('Everyday Checking', 'ASSET', 3100, { minimumBalance: 2500, cash: true, assetType: 'CHECKING' }),
  sav: A('High-Yield Savings', 'ASSET', 24500, { cash: true, rate: 4.1, assetType: 'SAVINGS' }),
  brk: A('Brokerage', 'ASSET', 86000, { invest: true, assetType: 'BROKERAGE' }),
  k401: A('401(k)', 'ASSET', 212000, { invest: true, assetType: '_401K' }),
  roth: A('Roth IRA', 'ASSET', 64000, { invest: true, assetType: 'ROTH' }),
  home: A('Home', 'ASSET', 540000, { appreciation: 3, assetType: 'FIXED_ASSET' }),
  mort: A('Mortgage', 'LIABILITY', 318000, { apr: 6.25, term: 324, from: 'chk', liabilityType: 'MORTGAGE', escrow: 480 }),
  auto: A('Auto Loan', 'LIABILITY', 14200, { apr: 5.9, term: 34, from: 'chk', liabilityType: 'AUTO' }),
  student: A('Student Loan', 'LIABILITY', 9800, { apr: 4.5, term: 60, from: 'chk', liabilityType: 'STUDENT' }),
  card: A('Sapphire Card', 'LIABILITY', 1240, { apr: 22.9, minPay: 40, liabilityType: 'CREDIT_CARD', cash: true }),
  store: A('Store Card', 'LIABILITY', 610, { liabilityType: 'CREDIT_CARD' }),
};
const cats = {
  groceries: { id: uid(), name: 'Groceries', accountType: 'EXPENSE' },
  dining: { id: uid(), name: 'Dining Out', accountType: 'EXPENSE' },
  travel: { id: uid(), name: 'Travel', accountType: 'EXPENSE' },
  salary: { id: uid(), name: 'Salary', accountType: 'REVENUE' },
};
const byKey = (k) => acct[k];
// The spec's tax-deferred asset types (ScenarioBody.taxRate).
const TAX_DEFERRED = new Set(['IRA', 'SEP_IRA', 'SIMPLE_IRA', 'SARSEP', 'KEOGH', '_401A', '_401K', '_403B', '_457B', 'PROFIT_SHARING_PLAN', 'PENSION', 'RETIREMENT',
  'RRSP', 'RRIF', 'LIRA', 'LRSP', 'LIF', 'LRIF', 'RLIF', 'PRIF', 'SIPP', 'FIXED_ANNUITY', 'VARIABLE_ANNUITY', 'OTHER_ANNUITY']);
for (const a of Object.values(acct)) a.taxDeferred = TAX_DEFERRED.has(a.assetType);
// RMDs: required age by birth year, and the IRS uniform lifetime divisor by age at the year's end.
// assetTypes whose WITHDRAWAL before the owner is 59½ carries the 10% early-withdrawal penalty.
const US_RETIREMENT = new Set(['IRA', 'SEP_IRA', 'SIMPLE_IRA', 'SARSEP', 'KEOGH', '_401A', '_401K', '_403B', 'PROFIT_SHARING_PLAN', 'PENSION', 'RETIREMENT', 'FIXED_ANNUITY', 'VARIABLE_ANNUITY', 'OTHER_ANNUITY', 'ROTH', 'ROTH_401K']);
const rmdStartAge = (birthDate) => { const y = Number(birthDate.slice(0, 4)); return y < 1951 ? 72 : y < 1960 ? 73 : 75; };
const UNIFORM = { 72: 27.4, 73: 26.5, 74: 25.5, 75: 24.6, 76: 23.7, 77: 22.9, 78: 22.0, 79: 21.1, 80: 20.2, 81: 19.4, 82: 18.5, 83: 17.7, 84: 16.8, 85: 16.0, 86: 15.2, 87: 14.4, 88: 13.7, 89: 12.9, 90: 12.2, 91: 11.5, 92: 10.8, 93: 10.1, 94: 9.5, 95: 8.9, 96: 8.4, 97: 7.8, 98: 7.3, 99: 6.8, 100: 6.4 };
const uniformDivisor = (age) => UNIFORM[age] ?? (age < 72 ? 27.4 : Math.max(2, 6.4 - (age - 100) * 0.4));
const books = Object.values(acct);
const bookById = new Map(books.map((a) => [a.id, a]));
for (const a of books) if (a.apr && a.term) a.payment = round2(pmt(a.opening, a.apr, a.term));

// Recurring streams the calendar knows about.
// UpcomingItemResponse.cadenceDays: the declared frequency's nominal gap.
const GAP = { WEEKLY: 7, BIWEEKLY: 14, BIMONTHLY: 60.88, MONTHLY: 30.44, QUARTERLY: 91.31, SEMIANNUAL: 182.62, ANNUAL: 365.25 };
const STREAMS = [
  { key: 'chk', merchant: 'Acme Corp Payroll', amount: 3900, every: 14, first: nextWeekday(TODAY, 5), recurrence: 'RECURRING', frequency: 'BIWEEKLY', income: true },
  { key: 'chk', merchant: 'Metro Electric', amount: -142.5, dom: 20, recurrence: 'RECURRING', frequency: 'MONTHLY' },
  { key: 'chk', merchant: 'Iron Gym', amount: -49, dom: 3, recurrence: 'SUBSCRIPTION', frequency: 'MONTHLY' },
  { key: 'chk', merchant: 'State Farm', amount: -1840, yearly: shiftToFuture('11-08'), recurrence: 'RECURRING', frequency: 'ANNUAL' },
  { key: 'chk', merchant: 'County Property Tax', amount: -3260, yearly: shiftToFuture('11-15'), recurrence: 'RECURRING', frequency: 'SEMIANNUAL', every6: true },
  { key: 'card', merchant: 'Netflix', amount: 24.99, dom: 12, recurrence: 'SUBSCRIPTION', frequency: 'MONTHLY' },
  { key: 'card', merchant: 'Spotify', amount: 11.99, dom: 5, recurrence: 'SUBSCRIPTION', frequency: 'MONTHLY' },
  { key: 'card', merchant: 'Verizon', amount: 86, dom: 8, recurrence: 'RECURRING', frequency: 'MONTHLY' },
  { key: 'chk', merchant: 'Sapphire Card Payment', amount: -1310, dom: 18, recurrence: 'RECURRING', frequency: 'MONTHLY', pays: 'card' },
];
function nextWeekday(iso, wd) { let d = iso; while (new Date(d + 'T00:00:00Z').getUTCDay() !== wd) d = addDays(d, 1); return d; }
function shiftToFuture(md) { const y = Number(TODAY.slice(0, 4)); const d = `${y}-${md}`; return d >= TODAY ? d : `${y + 1}-${md}`; }
for (const s of STREAMS) { if (s.every) s.firstMs = d2ms(s.first); if (s.every6) s.half = addMonths(s.yearly, 6).slice(5); }
function streamFires(s, date, nowMs) {
  if (s.every) return nowMs >= s.firstMs && Math.round((nowMs - s.firstMs) / 86400000) % s.every === 0;
  if (s.yearly) return date.slice(5) === s.yearly.slice(5) || (s.every6 && date.slice(5) === s.half);
  return dayOf(date) === s.dom;
}
function plannedFires(p, date) {
  if (date < TODAY || date < p.date || (p.endDate && date > p.endDate)) return false;
  if (!p.cadenceMonths) return date === p.date;
  return dayOf(date) === Math.min(dayOf(p.date), 28) && monthsBetween(p.date, date) % p.cadenceMonths === 0;
}
// Everyday baseline (non-recurring activity), replayed on the 1st of each month.
const BASELINE = [{ key: 'chk', monthlyNet: -1400 }, { key: 'card', monthlyNet: 1180 }];

// ------------------------------------------------------------------ state
const persons = [
  { id: uid(), name: 'Alex', birthDate: '1982-04-12', version: 0 },
  { id: uid(), name: 'Sam', birthDate: '1984-09-03', version: 0 },
];
const ageOf = (p, on = TODAY) => { const [by, bm, bd] = p.birthDate.split('-').map(Number); const [y, m, d] = on.split('-').map(Number); return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0); };
const dateAtAge = (pid, age) => { const p = persons.find((x) => x.id === pid); return p ? `${Number(p.birthDate.slice(0, 4)) + age}${p.birthDate.slice(4)}` : null; };
let assumptions = null; // { inflationRate, returnRate, incomeGrowthRate, version }
const DEFAULTS = { inflation: 3, investmentReturn: 6, incomeGrowth: 2.5, incomeTax: 0, volatility: 12 };
const planned = []; // planned transactions
const declarations = [];
const scenarios = [];

function seedScenarios() {
  const alex = persons[0].id;
  const retire = (name, age) => {
    const b = {
      name, horizonPersonId: alex, horizonAge: 95, scenarioFlows: [
        { key: 'c401', scenarioFlowType: 'CONTRIBUTION', accountId: acct.k401.id, targetAccountId: acct.chk.id, label: '401(k) contributions', amount: 900, cadenceMonths: 1, startDate: TODAY, personId: alex, endAge: age - 1, rate: 2.5 },
        { key: 'match', scenarioFlowType: 'CONTRIBUTION', accountId: acct.k401.id, label: 'Employer match', percent: 50, ceilingAmount: 450, matchOf: 'c401' },
        { key: 'draw', scenarioFlowType: 'WITHDRAWAL', accountId: acct.brk.id, targetAccountId: acct.chk.id, label: 'Retirement living expenses', amount: 3600, cadenceMonths: 1, personId: alex, startAge: age, fallbackAccountIds: [acct.k401.id, acct.roth.id] },
        { key: 'ef', scenarioFlowType: 'TARGET', accountId: acct.sav.id, label: 'Emergency fund', amount: 45000, startDate: addMonths(TODAY, 30) },
        { key: 'save', scenarioFlowType: 'TRANSFER', accountId: acct.chk.id, targetAccountId: acct.sav.id, label: 'Monthly savings sweep', amount: 250, cadenceMonths: 1, startDate: addDays(TODAY, 10) },
      ],
      scenarioStreamOverrides: [{ accountId: acct.chk.id, merchantName: 'Acme Corp Payroll', excluded: false, personId: alex, endAge: age }],
      excludedAccountIds: [], memberScenarioIds: [], scenarioAccounts: [],
    };
    return saveScenario(null, b);
  };
  retire('Retire at 62', 62);
  retire('Retire at 57', 57);
  saveScenario(null, {
    name: 'Buy the lake house', horizonYears: 25, returnRate: 6.5, scenarioFlows: [
      { key: 'shock', scenarioFlowType: 'SHOCK', accountId: acct.brk.id, label: 'Correction', rate: -18, startDate: addMonths(TODAY, 14) },
      { key: 'extra', scenarioFlowType: 'CONTRIBUTION', hypotheticalAccount: 'lm', targetAccountId: acct.chk.id, label: 'Extra principal', amount: 300, cadenceMonths: 1, startDate: addMonths(TODAY, 10) },
    ],
    scenarioStreamOverrides: [{ accountId: acct.card.id, merchantName: 'Netflix', excluded: true }],
    excludedAccountIds: [], memberScenarioIds: [],
    scenarioAccounts: [
      { key: 'house', name: 'Lake house', accountType: 'ASSET', unitType: 'USD', openingBalance: 420000, openDate: addMonths(TODAY, 9), fundedFromAccountId: acct.brk.id, fundedAmount: 84000, appreciationRate: 2.5 },
      { key: 'lm', name: 'Lake house mortgage', accountType: 'LIABILITY', unitType: 'USD', openingBalance: 336000, openDate: addMonths(TODAY, 9), apr: 6.5, termMonths: 360, paymentFromAccountId: acct.chk.id, collateral: 'house', escrow: 390 },
    ],
  });
}

function validate(b) {
  const errs = [];
  if (!b.name) errs.push('name: must not be blank');
  if (b.horizonYears != null && (b.horizonYears < 1 || b.horizonYears > 60)) errs.push('horizonYears: must be between 1 and 60');
  const known = new Set([...books.map((a) => a.id), ...Object.values(cats).map((c) => c.id)]);
  const keys = new Set((b.scenarioAccounts || []).map((a) => a.key));
  (b.scenarioFlows || []).forEach((f, i) => {
    if (!f.scenarioFlowType) errs.push(`scenarioFlows[${i}].scenarioFlowType: must not be null`);
    if (!!f.accountId === !!f.hypotheticalAccount) errs.push(`scenarioFlows[${i}]: give accountId or hypotheticalAccount, one of them`);
    else if (f.accountId && !known.has(f.accountId)) errs.push(`scenarioFlows[${i}].accountId: unknown account`);
    else if (f.hypotheticalAccount && !keys.has(f.hypotheticalAccount)) errs.push(`scenarioFlows[${i}].hypotheticalAccount: no account with key ${f.hypotheticalAccount} in this body`);
    if (['SPENDING', 'DISPOSE'].includes(f.scenarioFlowType) && (f.hypotheticalAccount || f.hypotheticalTargetAccount)) errs.push(`scenarioFlows[${i}]: ${f.scenarioFlowType} names book accounts only`);
    if (f.scenarioFlowType === 'TRANSFER' && !f.targetAccountId && !f.hypotheticalTargetAccount) errs.push(`scenarioFlows[${i}].targetAccountId: required for TRANSFER`);
    if (['SPENDING', 'DISPOSE'].includes(f.scenarioFlowType) && !f.targetAccountId) errs.push(`scenarioFlows[${i}].targetAccountId: required for ${f.scenarioFlowType}`);
    if ((f.startDate && f.startAge != null) || (f.endDate && f.endAge != null)) errs.push(`scenarioFlows[${i}]: a date or an age, never both`);
    if (f.scenarioFlowType === 'WITHDRAWAL') {
      const types = [f.accountId, ...(f.fallbackAccountIds || [])].map((id) => bookById.get(id)?.assetType)
        .concat(f.hypotheticalAccount ? [(b.scenarioAccounts || []).find((a) => a.key === f.hypotheticalAccount)?.assetType] : []);
      if (!f.personId && types.some((t) => US_RETIREMENT.has(t))) errs.push(`scenarioFlows[${i}].personId: required for a WITHDRAWAL drawing on a US retirement account — its owner`);
      if (f.withdrawalPurpose === 'RULE_OF_55' && !types.some((t) => ['_401K', '_401A', '_403B', 'PROFIT_SHARING_PLAN', 'ROTH_401K'].includes(t))) errs.push(`scenarioFlows[${i}].withdrawalPurpose: RULE_OF_55 needs a 401(k) or 403(b) to draw on`);
      if (['NON_QUALIFIED', 'SCHOLARSHIP'].includes(f.withdrawalPurpose) && !types.some((t) => ['_529', 'EDUCATION_SAVINGS_ACCOUNT'].includes(t))) errs.push(`scenarioFlows[${i}].withdrawalPurpose: ${f.withdrawalPurpose} needs a 529 to draw on`);
    }
    if (f.scenarioFlowType === 'RMD') {
      if (!f.personId) errs.push(`scenarioFlows[${i}].personId: required for an RMD`);
      const stated = ['amount', 'percent', 'rate', 'cadenceMonths', 'startDate', 'endDate', 'startAge', 'endAge'].filter((k) => f[k] != null);
      if (stated.length) errs.push(`scenarioFlows[${i}]: an RMD states no ${stated.join(', ')}`);
      const td = f.accountId ? bookById.get(f.accountId)?.taxDeferred : TAX_DEFERRED.has((b.scenarioAccounts || []).find((a) => a.key === f.hypotheticalAccount)?.assetType);
      if (!td) errs.push(`scenarioFlows[${i}].accountId: an RMD needs a tax-deferred account`);
    }
  });
  if (errs.length) throw { status: 400, body: { code: 'validation_failed', errors: errs } };
}

function saveScenario(existing, b) {
  validate(b);
  const now = new Date().toISOString();
  const name = (id) => bookById.get(id)?.name || Object.values(cats).find((c) => c.id === id)?.name || '?';
  const pname = (id) => persons.find((p) => p.id === id)?.name ?? null;
  const flowIds = new Map((b.scenarioFlows || []).map((f) => [f.key || uid(), uid()]));
  const acctIds = new Map((b.scenarioAccounts || []).map((a) => [a.key || uid(), uid()]));
  const acctName = new Map((b.scenarioAccounts || []).map((a) => [a.key, a.name]));
  const resolve = (date, pid, age) => (pid && age != null ? dateAtAge(pid, age) : date ?? null);
  const s = {
    id: existing?.id || uid(), name: b.name, version: existing ? existing.version + 1 : 0, partyId: DEMO_PARTY,
    horizonYears: b.horizonYears ?? 30, horizonPersonId: b.horizonPersonId ?? null, horizonPersonName: pname(b.horizonPersonId),
    horizonAge: b.horizonPersonId ? b.horizonAge ?? 95 : null,
    inflationRate: b.inflationRate ?? null, returnRate: b.returnRate ?? null, incomeGrowthRate: b.incomeGrowthRate ?? null,
    taxRate: b.taxRate ?? null, volatility: b.volatility ?? null,
    scenarioFlows: (b.scenarioFlows || []).map((f) => ({
      id: flowIds.get(f.key) || uid(), scenarioFlowType: f.scenarioFlowType, complete: true,
      accountId: f.accountId ?? null, hypotheticalAccountId: f.hypotheticalAccount ? acctIds.get(f.hypotheticalAccount) : null,
      accountName: f.accountId ? name(f.accountId) : acctName.get(f.hypotheticalAccount),
      targetAccountId: f.targetAccountId ?? null, hypotheticalTargetAccountId: f.hypotheticalTargetAccount ? acctIds.get(f.hypotheticalTargetAccount) : null,
      targetAccountName: f.targetAccountId ? name(f.targetAccountId) : f.hypotheticalTargetAccount ? acctName.get(f.hypotheticalTargetAccount) : null,
      label: f.label ?? null, amount: f.amount ?? null,
      startDate: f.startDate ?? null, endDate: f.endDate ?? null,
      resolvedStartDate: resolve(f.startDate, f.personId, f.startAge), resolvedEndDate: resolve(f.endDate, f.personId, f.endAge),
      cadenceMonths: f.cadenceMonths ?? null, rate: f.rate ?? null, percent: f.percent ?? null,
      floorAmount: f.floorAmount ?? null, ceilingAmount: f.ceilingAmount ?? null,
      scenarioFallbackAccounts: (f.fallbackAccountIds || []).map((id) => ({ id, name: name(id) })),
      personId: f.personId ?? null, personName: pname(f.personId), startAge: f.startAge ?? null, endAge: f.endAge ?? null,
      matchOfFlowId: f.matchOf ? flowIds.get(f.matchOf) ?? null : null, withdrawalPurpose: f.withdrawalPurpose ?? null,
    })),
    scenarioStreamOverrides: (b.scenarioStreamOverrides || []).map((o) => ({
      id: uid(), accountId: o.accountId, accountName: name(o.accountId), merchantName: o.merchantName ?? null, excluded: !!o.excluded,
      startDate: o.startDate ?? null, startAge: o.startAge ?? null, resolvedStartDate: resolve(o.startDate, o.personId, o.startAge),
      endDate: o.endDate ?? null, resolvedEndDate: resolve(o.endDate, o.personId, o.endAge),
      amount: o.amount ?? null, rate: o.rate ?? null, personId: o.personId ?? null, personName: pname(o.personId), endAge: o.endAge ?? null, streamAmount: o.merchantName ? o.streamAmount ?? null : null,
    })),
    scenarioExcludedAccounts: (b.excludedAccountIds || []).map((id) => ({ id, name: name(id) })),
    scenarioAccounts: (b.scenarioAccounts || []).map((a) => ({
      id: acctIds.get(a.key) || uid(), name: a.name, accountType: a.accountType, assetType: a.assetType ?? null, unitType: a.unitType || 'USD', openingBalance: a.openingBalance, openDate: a.openDate,
      fundedFromAccountId: a.fundedFromAccountId ?? null, fundedFromAccountName: a.fundedFromAccountId ? name(a.fundedFromAccountId) : null, fundedAmount: a.fundedAmount ?? null,
      appreciationRate: a.appreciationRate ?? null, apr: a.apr ?? null, termMonths: a.termMonths ?? null,
      payment: a.apr != null && a.termMonths ? round2(pmt(a.openingBalance, a.apr, a.termMonths)) : null, escrow: a.escrow ?? null,
      paymentFromAccountId: a.paymentFromAccountId ?? null, paymentFromAccountName: a.paymentFromAccountId ? name(a.paymentFromAccountId) : null,
      disposedOn: a.disposedOn ?? null, proceedsToAccountId: a.proceedsToAccountId ?? null, proceedsToAccountName: a.proceedsToAccountId ? name(a.proceedsToAccountId) : null,
      collateralId: a.collateral ? acctIds.get(a.collateral) ?? null : null, collateralAccountId: a.collateralAccountId ?? null,
      collateralAccountName: a.collateralAccountId ? name(a.collateralAccountId) : null,
    })),
    scenarioMembers: [], createdDate: existing?.createdDate || now, updatedDate: now,
  };
  for (const f of s.scenarioFlows.filter((x) => x.scenarioFlowType === 'RMD' && x.personId)) { const bd = persons.find((p) => p.id === f.personId)?.birthDate; f.resolvedStartDate = bd ? `${Number(bd.slice(0, 4)) + rmdStartAge(bd)}-01-01` : null; }
  for (const f of s.scenarioFlows.filter((x) => x.matchOfFlowId)) { const m = s.scenarioFlows.find((x) => x.id === f.matchOfFlowId); f.resolvedStartDate = m?.resolvedStartDate ?? null; f.resolvedEndDate = m?.resolvedEndDate ?? null; }
  if (existing) scenarios[scenarios.indexOf(existing)] = s; else scenarios.push(s);
  return s;
}

// ------------------------------------------------------------- simulation
function rates(s, variant) {
  const pick = (own, party, def, v) => (v != null ? { rate: v, source: 'VARIANT' } : own != null ? { rate: own, source: 'SCENARIO' } : party != null ? { rate: party, source: 'PARTY' } : { rate: def, source: 'DEFAULT' });
  return {
    inflation: pick(s?.inflationRate, assumptions?.inflationRate, DEFAULTS.inflation, variant?.inflationRate),
    investmentReturn: pick(s?.returnRate, assumptions?.returnRate, DEFAULTS.investmentReturn, variant?.returnRate),
    incomeGrowth: pick(s?.incomeGrowthRate, assumptions?.incomeGrowthRate, DEFAULTS.incomeGrowth, variant?.incomeGrowthRate),
    incomeTax: pick(s?.taxRate, assumptions?.taxRate, DEFAULTS.incomeTax, variant?.taxRate),
    volatility: pick(s?.volatility, assumptions?.volatility, DEFAULTS.volatility, variant?.volatility),
  };
}

// Runs the books from `from` for `days`. Balances: assets positive, liabilities as the amount owed.
// `market(monthIndex)` is that month's random move as a daily log return, added to every investment account's growth.
// `dailyBaseline` spreads each month's everyday baseline over its days instead of landing it on the 1st.
function simulate({ from = TODAY, days, step, scenarioList = [], extraFlows = [], calendar = true, baseline = true, variant, stressAt, stressPct, market, dailyBaseline = false }) {
  const s0 = scenarioList[0];
  const R = rates(s0, variant);
  const flows = [...scenarioList.flatMap((s) => s.scenarioFlows.filter((f) => f.complete).map((f) => ({
    ...f, startDate: f.resolvedStartDate, endDate: f.resolvedEndDate,
    accountId: f.accountId ?? f.hypotheticalAccountId, targetAccountId: f.targetAccountId ?? f.hypotheticalTargetAccountId,
  }))), ...extraFlows.map((f, i) => ({ id: uid(), accountName: bookById.get(f.accountId)?.name, scenarioFallbackAccounts: (f.fallbackAccountIds || []).map((id) => ({ id })), ...f, key: f.key || `x${i}` }))];
  const overrides = scenarioList.flatMap((s) => s.scenarioStreamOverrides);
  const excluded = new Set(scenarioList.flatMap((s) => s.scenarioExcludedAccounts.map((a) => a.id)));
  const hypo = scenarioList.flatMap((s) => s.scenarioAccounts);
  const accts = [...books.filter((a) => !excluded.has(a.id)).map((a) => ({ ...a })), ...hypo.map((h) => ({
    id: h.id, name: h.name, accountType: h.accountType, unitType: h.unitType, opening: 0, hypo: h,
    apr: h.apr, payment: h.payment, from: null, fromId: h.paymentFromAccountId, appreciation: h.appreciationRate, escrow: h.escrow,
    invest: h.appreciationRate == null && ['BROKERAGE', 'IRA', 'ROTH', '_401K', 'ROTH_401K', 'RETIREMENT'].includes(h.assetType),
    taxDeferred: TAX_DEFERRED.has(h.assetType),
  }))];
  const byId = new Map(accts.map((a) => [a.id, a]));
  // Money moves through a hypothetical account only while it exists.
  const live = (id, date) => { const h = byId.get(id)?.hypo; if (!h) return true; const open = h.openDate < from ? from : h.openDate; return date >= open && (!h.disposedOn || date <= h.disposedOn); };
  const bal = new Map(accts.map((a) => [a.id, a.opening]));
  const isLiab = (id) => byId.get(id)?.accountType === 'LIABILITY';
  const tax = R.incomeTax.rate / 100;
  // Several overrides may stack on one stream; the one in force is the latest started by `date`.
  const overrideFor = (accountId, merchant, date) => overrides
    .filter((o) => o.accountId === accountId && (o.merchantName ?? null) === merchant && (!o.resolvedStartDate || o.resolvedStartDate <= date))
    .sort((a, b) => (a.resolvedStartDate || '').localeCompare(b.resolvedStartDate || '')).at(-1);
  const events = new Map(accts.map((a) => [a.id, []]));
  const post = (id, amt, date, kind, label, sourceId = null) => {
    if (!byId.has(id) || !amt) return;
    const nb = round2(bal.get(id) + amt); bal.set(id, nb);
    events.get(id).push({ date, amount: round2(amt), kind, sourceId, label, balance: nb });
  };
  // moving `amt` of cash into an account: an asset rises, a liability's owed amount falls.
  // A payment into a loan never takes it past zero owed.
  const cashIn = (id, amt, date, kind, label, src) => post(id, isLiab(id) ? -Math.min(amt, Math.max(0, bal.get(id) ?? 0)) : amt, date, kind, label, src);
  const growthOverride = (id, date) => growthFlows.find((f) => f.scenarioFlowType === 'GROWTH' && f.accountId === id && (!f.startDate || f.startDate <= date) && (!f.endDate || f.endDate >= date));
  const withdrawals = flows.filter((f) => f.scenarioFlowType === 'WITHDRAWAL');
  const fundingAccts = [...new Set(withdrawals.map((f) => f.accountId))];
  const drawn = new Map(); const chainMin = new Map(); const taxBy = new Map(); const penaltyBy = new Map();
  const targetsOut = [];
  const series = new Map(accts.map((a) => [a.id, []]));
  const low = new Map(accts.map((a) => [a.id, { date: from, balance: a.opening }]));
  const firstNeg = new Map(), firstBelow = new Map();
  const cash = new Map();
  const to = addDays(from, days - 1);
  const occurs = (f, date) => {
    if (!f.startDate && f.scenarioFlowType !== 'WITHDRAWAL') return f.cadenceMonths ? dayOf(date) === 1 : false;
    const start = f.startDate || from;
    if (date < start || (f.endDate && date > f.endDate)) return false;
    if (dayOf(date) !== Math.min(dayOf(start), 28)) return false;
    return monthsBetween(start, date) % (f.cadenceMonths || 1) === 0;
  };
  const cf = (date) => { const k = date.slice(0, 4); if (!cash.has(k)) cash.set(k, { fromDate: `${k}-01-01` < from ? from : `${k}-01-01`, toDate: `${k}-12-31` > to ? to : `${k}-12-31`, in: 0, out: 0, sources: new Map() }); return cash.get(k); };
  const cashTouch = (id, amt, date, label) => { if (!byId.get(id)?.cash || byId.get(id)?.accountType !== 'ASSET') return; const c = cf(date); if (amt >= 0) c.in += amt; else c.out -= amt; c.sources.set(label, (c.sources.get(label) || 0) + amt); };

  const cursor = new Date(from + 'T00:00:00Z');
  const growthFlows = flows.filter((f) => f.scenarioFlowType === 'GROWTH');
  for (let i = 0; i < days; i++, cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const date = cursor.toISOString().slice(0, 10);
    const nowMs = cursor.getTime();
    const yr = Math.floor(i / 365.25);
    // hypothetical accounts appear
    for (const a of accts.filter((x) => x.hypo && (x.hypo.openDate <= from ? date === from : x.hypo.openDate === date))) {
      post(a.id, a.hypo.openingBalance, date, 'HYPOTHETICAL', 'Opened');
      if (a.hypo.fundedFromAccountId && a.hypo.fundedAmount) { post(a.hypo.fundedFromAccountId, -a.hypo.fundedAmount, date, 'HYPOTHETICAL', `Down payment · ${a.name}`); cashTouch(a.hypo.fundedFromAccountId, -a.hypo.fundedAmount, date, `Down payment · ${a.name}`); }
    }
    // calendar
    if (calendar) {
      for (const st of STREAMS) {
        const id = acct[st.key].id;
        if (!byId.has(id) || !streamFires(st, date, nowMs)) continue;
        const ov = overrideFor(id, st.merchant, date);
        if (ov?.excluded || (ov?.resolvedEndDate && date > ov.resolvedEndDate)) continue;
        const g = st.income ? R.incomeGrowth.rate : R.inflation.rate;
        // the card payment clears the statement in full
        const amt = st.pays ? -Math.max(0, bal.get(acct[st.pays].id) || 0) : (ov?.amount ?? st.amount) * (1 + (ov?.rate ?? g) / 100) ** yr;
        post(id, amt, date, 'RECURRENCE', st.merchant);
        cashTouch(id, amt, date, st.merchant);
        if (st.pays) post(acct[st.pays].id, amt, date, 'RECURRENCE', st.merchant);
      }
      for (const a of accts.filter((x) => x.accountType === 'LIABILITY' && x.payment && bal.get(x.id) > 0.005)) {
        const payDay = a.hypo ? dayOf(a.hypo.openDate) : 1;
        if (dayOf(date) !== Math.min(payDay, 28) || (a.hypo && date <= a.hypo.openDate)) continue;
        const ov = overrideFor(a.id, null, date);
        if (ov?.excluded || (ov?.resolvedEndDate && date > ov.resolvedEndDate)) continue;
        const interest = bal.get(a.id) * a.apr / 1200;
        const principal = Math.min(bal.get(a.id), a.payment - interest);
        post(a.id, -principal, date, 'LOAN_PAYMENT', `${a.name} principal`);
        const src = a.fromId || (a.from && acct[a.from].id);
        const total = principal + interest + (a.escrow || 0);
        post(src, -total, date, 'LOAN_PAYMENT', `${a.name} payment`);
        cashTouch(src, -total, date, `${a.name} payment`);
      }
    }
    // planned transactions on their dates
    if (calendar) {
      for (const p of planned) {
        if (!plannedFires(p, date)) continue;
        if (p.fromAccountId && byId.has(p.fromAccountId)) { const amt = isLiab(p.fromAccountId) ? p.amount : -p.amount; post(p.fromAccountId, amt, date, 'PLANNED', p.label, p.id); cashTouch(p.fromAccountId, amt, date, p.label); }
        if (p.toAccountId && byId.has(p.toAccountId)) { cashIn(p.toAccountId, p.amount, date, 'PLANNED', p.label, p.id); cashTouch(p.toAccountId, p.amount, date, p.label); }
      }
    }
    // everyday baseline: on the 1st, or a slice a day
    const dim = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0)).getUTCDate();
    if (baseline && (dailyBaseline || dayOf(date) === 1)) {
      for (const b of BASELINE) {
        const id = acct[b.key].id; if (!byId.has(id)) continue;
        const amt = b.monthlyNet * (1 + R.inflation.rate / 100) ** yr / (dailyBaseline ? dim : 1);
        post(id, amt, date, 'BASELINE', 'Everyday spending');
        cashTouch(id, amt, date, 'Everyday spending');
      }
    }
    // flows
    for (const f of flows) {
      if (f.matchOfFlowId || f.matchOf) continue;
      if (f.scenarioFlowType !== 'TARGET' && (!live(f.accountId, date) || (f.targetAccountId && !live(f.targetAccountId, date)))) continue;
      const grow = (base) => base * (1 + (f.rate ?? (f.scenarioFlowType === 'CONTRIBUTION' ? 0 : R.inflation.rate)) / 100) ** yr;
      if (f.scenarioFlowType === 'ONE_TIME' && f.startDate === date) { post(f.accountId, f.amount, date, 'FLOW', f.label || 'One-off'); cashTouch(f.accountId, f.amount, date, f.label || 'One-off'); if (f.targetAccountId) post(f.targetAccountId, -f.amount, date, 'FLOW', f.label); }
      if (f.scenarioFlowType === 'SHOCK' && (f.startDate === date || (f.startDate < from && date === from))) post(f.accountId, bal.get(f.accountId) * f.rate / 100, date, 'FLOW', f.label || 'Shock', f.id);
      if (f.scenarioFlowType === 'DISPOSE' && (f.startDate === date)) { const v = f.amount ?? bal.get(f.accountId); post(f.accountId, -bal.get(f.accountId), date, 'FLOW', f.label || 'Sold'); cashIn(f.targetAccountId, isLiab(f.accountId) ? -v : v, date, 'FLOW', f.label || 'Proceeds'); }
      if (f.scenarioFlowType === 'TARGET' && (f.startDate === date || (date === to && f.startDate > to))) targetsOut.push({ f, projected: bal.get(f.accountId) });
      // RMD: each January 1 from the year the owner reaches the required age, the opening balance over the
      // uniform lifetime divisor at their age at the year's end, received less income tax.
      const owner = f.scenarioFlowType === 'RMD' ? persons.find((p) => p.id === f.personId) : null;
      const rmdAge = owner ? Number(date.slice(0, 4)) - Number(owner.birthDate.slice(0, 4)) : null;
      if (owner && rmdAge >= rmdStartAge(owner.birthDate) && date.slice(5) === '01-01' && bal.get(f.accountId) > 0) {
        const divisor = uniformDivisor(rmdAge);
        const amt = bal.get(f.accountId) / divisor;
        post(f.accountId, -amt, date, 'FLOW', f.label || 'RMD', f.id);
        if (f.targetAccountId) {
          cashIn(f.targetAccountId, amt, date, 'FLOW', f.label || 'RMD', f.id); cashTouch(f.targetAccountId, amt, date, f.label || 'RMD');
          if (tax) { post(f.targetAccountId, -amt * tax, date, 'TAX', `Income tax · ${f.label || 'RMD'}`, f.id); cashTouch(f.targetAccountId, -amt * tax, date, 'Income tax'); }
        }
      }
      if (!['CONTRIBUTION', 'WITHDRAWAL', 'TRANSFER', 'SPENDING'].includes(f.scenarioFlowType) || !occurs(f, date)) continue;
      if (f.scenarioFlowType === 'CONTRIBUTION') {
        const amt = isLiab(f.accountId) ? Math.min(grow(f.amount || 0), Math.max(0, bal.get(f.accountId))) : grow(f.amount || 0);
        if (!amt) continue;
        cashIn(f.accountId, amt, date, 'FLOW', f.label || 'Contribution', f.id);
        if (f.targetAccountId) { post(f.targetAccountId, -amt, date, 'FLOW', f.label || 'Contribution', f.id); cashTouch(f.targetAccountId, -amt, date, f.label || 'Contribution'); }
        for (const m of flows.filter((x) => (x.matchOfFlowId && x.matchOfFlowId === f.id) || (x.matchOf && x.matchOf === f.key))) {
          cashIn(m.accountId, Math.min(amt * (m.percent || 0) / 100, m.ceilingAmount ?? Infinity), date, 'FLOW', m.label || 'Match', m.id);
        }
      } else if (f.scenarioFlowType === 'TRANSFER') {
        const amt = grow(f.amount || 0);
        post(f.accountId, -amt, date, 'FLOW', f.label || 'Transfer', f.id); cashIn(f.targetAccountId, amt, date, 'FLOW', f.label || 'Transfer', f.id);
        // From a tax-deferred account the tax is drawn on top of the amount.
        if (tax && byId.get(f.accountId)?.taxDeferred) post(f.accountId, -amt * tax / (1 - tax), date, 'TAX', `Income tax · ${f.label || 'Transfer'}`, f.id);
      } else if (f.scenarioFlowType === 'SPENDING') {
        const amt = grow(f.amount || 0);
        post(f.targetAccountId, -amt, date, 'SPENDING', f.label || 'Spending', f.id); cashTouch(f.targetAccountId, -amt, date, f.label || 'Spending');
      } else if (f.scenarioFlowType === 'WITHDRAWAL') {
        let need = f.percent != null ? bal.get(f.accountId) * f.percent / 100 / (12 / (f.cadenceMonths || 1)) : grow(f.amount || 0);
        const chain = [f.accountId, ...f.scenarioFallbackAccounts.map((a) => a.id)].filter((id) => byId.has(id));
        chain.forEach((id, k) => {
          if (need <= 0.005) return;
          const take = k === chain.length - 1 ? need : Math.max(0, Math.min(need, bal.get(id)));
          if (take > 0) {
            post(id, -take, date, 'FLOW', f.label || 'Withdrawal', f.id); need -= take; const key = `${f.accountId}|${id}`; drawn.set(key, (drawn.get(key) || 0) + take);
            const a = byId.get(id);
            if (tax && a?.taxDeferred) { const t = take * tax / (1 - tax); post(id, -t, date, 'TAX', `Income tax · ${f.label || 'Withdrawal'}`, f.id); taxBy.set(f.accountId, (taxBy.get(f.accountId) || 0) + t); }
            // Early-withdrawal penalty: 10% before the owner is 59½, waived under the Rule of 55 from a 401(k) after 55.
            // (The demo penalizes tax-deferred draws only; a Roth's contributions come out first.)
            const owner = persons.find((p) => p.id === f.personId);
            const ageNow = owner ? (d2ms(date) - d2ms(owner.birthDate)) / (365.25 * 86400000) : null;
            const ruleOf55 = f.withdrawalPurpose === 'RULE_OF_55' && ageNow >= 55 && ['_401K', '_401A', '_403B', 'PROFIT_SHARING_PLAN'].includes(a?.assetType);
            if (a?.taxDeferred && US_RETIREMENT.has(a.assetType) && ageNow != null && ageNow < 59.5 && !ruleOf55) {
              const pen = take / (1 - tax) * 0.1; post(id, -pen, date, 'PENALTY', `Early-withdrawal penalty · ${f.label || 'Withdrawal'}`, f.id); penaltyBy.set(f.accountId, (penaltyBy.get(f.accountId) || 0) + pen);
            }
          }
        });
        const last = chain[chain.length - 1];
        const lb = bal.get(last);
        if (lb < (chainMin.get(f.accountId)?.balance ?? 0)) chainMin.set(f.accountId, { balance: lb, date: chainMin.get(f.accountId)?.date || date });
        if (f.targetAccountId) { const amt = f.percent != null ? 0 : grow(f.amount || 0); cashIn(f.targetAccountId, amt, date, 'FLOW', f.label || 'Withdrawal'); cashTouch(f.targetAccountId, amt, date, f.label || 'Withdrawal'); }
      }
    }
    // stress shock
    if (stressAt && date === stressAt) for (const a of accts.filter((x) => x.invest)) post(a.id, bal.get(a.id) * stressPct / 100, date, 'STRESS', `Market shock ${stressPct}%`);
    // growth, compounded daily
    for (const a of accts) {
      if (a.hypo && date < a.hypo.openDate) continue;
      const g = growthOverride(a.id, date);
      const r = g ? g.rate : a.invest ? R.investmentReturn.rate : a.appreciation ?? a.rate ?? 0;
      const mk = market && a.invest && !g ? market(monthsBetween(from, date)) : 0;
      if ((r || mk) && bal.get(a.id) > 0) { const amt = bal.get(a.id) * ((1 + r / 100) ** (1 / 365) * Math.exp(mk) - 1); bal.set(a.id, bal.get(a.id) + amt); const ev = events.get(a.id); const lastEv = ev[ev.length - 1]; if (lastEv && lastEv.kind === 'ASSUMED_RETURN' && lastEv.date.slice(0, 7) === date.slice(0, 7)) { lastEv.amount = round2(lastEv.amount + amt); lastEv.balance = round2(bal.get(a.id)); lastEv.date = date; } else ev.push({ date, amount: round2(amt), kind: g ? 'FLOW' : 'ASSUMED_RETURN', sourceId: null, label: g ? g.label || 'Growth' : 'Assumed return', balance: round2(bal.get(a.id)) }); }
    }
    // bookkeeping
    for (const a of accts) {
      const b = round2(bal.get(a.id));
      if (b < low.get(a.id).balance) low.set(a.id, { date, balance: b });
      if (a.accountType === 'ASSET' && b < 0 && !firstNeg.has(a.id)) firstNeg.set(a.id, date);
      if (a.minimumBalance != null && b < a.minimumBalance && !firstBelow.has(a.id)) firstBelow.set(a.id, date);
      if (i % step === 0 || i === days - 1) series.get(a.id).push({ date, balance: b });
    }
  }

  const accounts = accts.map((a) => ({
    id: a.id, name: a.name, accountType: a.accountType, hypothetical: !!a.hypo, unitType: 'USD', opening: a.opening, closing: round2(bal.get(a.id)),
    low: low.get(a.id), firstNegativeDate: firstNeg.get(a.id) ?? null, minimumBalance: a.minimumBalance ?? null,
    firstBelowMinimumDate: firstBelow.get(a.id) ?? null,
    topUpRequired: firstBelow.has(a.id) ? round2(a.minimumBalance - low.get(a.id).balance) : null,
    points: series.get(a.id),
  }));
  const dates = accounts[0].points.map((p) => p.date);
  const netPoints = dates.map((date, k) => ({ date, balance: round2(accounts.reduce((s, a) => s + (a.accountType === 'LIABILITY' ? -1 : 1) * a.points[k].balance, 0)) }));
  const funding = fundingAccts.map((id) => {
    const ws = withdrawals.filter((f) => f.accountId === id);
    const m = chainMin.get(id);
    const firstStart = ws.map((f) => f.startDate || from).sort()[0];
    const monthsToStart = Math.max(0, monthsBetween(from, firstStart));
    return {
      accountId: id, accountName: byId.get(id)?.name, unitType: 'USD', withdrawals: ws.map((f) => f.label || 'Withdrawal'),
      drawnFrom: [...drawn].filter(([k]) => k.startsWith(`${id}|`)).map(([k, v]) => ({ accountId: k.split('|')[1], accountName: byId.get(k.split('|')[1])?.name, amount: round2(v) })),
      tax: round2(taxBy.get(id) || 0), penalty: round2(penaltyBy.get(id) || 0),
      funded: !m, shortDate: m?.date ?? null, shortfall: m ? round2(m.balance) : null,
      requiredMonthlyContribution: m && monthsToStart > 0 ? round2(-m.balance / monthsToStart / (1 + R.investmentReturn.rate / 100) ** (monthsToStart / 24)) : null,
      contributionAccountId: m && monthsToStart > 0 ? id : null,
      firstStart,
    };
  });
  return { R, accounts, netPoints, funding, targets: targetsOut, events, cash, from, to, flows };
}

function scenarioRun(list, { step = 30, stress = -30, calendar = true, baseline = true, date = TODAY, variant, unitType = 'USD', until } = {}) {
  const s0 = list[0];
  const horizonEnd = until || (s0?.horizonPersonId ? dateAtAge(s0.horizonPersonId, s0.horizonAge) : addMonths(date, 12 * (s0?.horizonYears ?? 30)));
  const days = Math.max(30, Math.round((d2ms(horizonEnd) - d2ms(date)) / 86400000));
  const base = simulate({ from: date, days, step, scenarioList: list, calendar, baseline, variant });
  const firstDraw = base.funding.map((f) => f.firstStart).sort()[0];
  const stressAt = firstDraw && firstDraw > date ? firstDraw : date;
  const stressed = base.funding.length ? simulate({ from: date, days, step, scenarioList: list, calendar, baseline, variant, stressAt, stressPct: stress }) : null;
  // For short accounts: find the smallest delay (whole months) that funds them.
  for (const f of base.funding.filter((x) => !x.funded)) {
    for (let m = 12; m <= 144; m += 12) {
      const shifted = list.map((s) => ({ ...s, scenarioFlows: s.scenarioFlows.map((fl) => (fl.scenarioFlowType === 'WITHDRAWAL' && fl.accountId === f.accountId ? { ...fl, resolvedStartDate: addMonths(fl.resolvedStartDate || date, m), resolvedEndDate: fl.resolvedEndDate ? addMonths(fl.resolvedEndDate, m) : null } : fl)) }));
      const r = simulate({ from: date, days, step: 3650, scenarioList: shifted, calendar, baseline, variant });
      if (r.funding.find((x) => x.accountId === f.accountId)?.funded) { f.delayMonths = m; f.earliestFundedStart = addMonths(f.firstStart, m); break; }
    }
  }
  return { base, stressed, stressAt, stressPct: stress, horizonEnd, unitType };
}

const converted = (points, unitType = 'USD') => ({ unitType, rates: unitType === 'USD' ? [] : [{ rate: 0.92, unitType: 'USD', asOfDate: TODAY, forexSource: 'ECB' }], unconvertedUnitTypes: [], points: unitType === 'USD' ? points : points.map((p) => ({ date: p.date, balance: round2(p.balance * 0.92) })) });

function toForecastResponse(run, list) {
  const { base, stressed } = run;
  const R = base.R;
  const cleanF = (fs) => fs.map(({ firstStart, ...rest }) => ({ delayMonths: null, earliestFundedStart: null, ...rest }));
  return {
    fromDate: base.from, toDate: base.to, stepDays: base.accounts[0].points.length > 1 ? Math.round((d2ms(base.accounts[0].points[1].date) - d2ms(base.from)) / 86400000) : 1,
    scenarios: list,
    unreachableAccountIds: [],
    assumptions: [{ partyId: DEMO_PARTY, assumptions: R }],
    assumedReturnAccountIds: books.filter((a) => a.invest && !base.flows.some((f) => f.scenarioFlowType === 'GROWTH' && !f.startDate && f.accountId === a.id)).map((a) => a.id),
    baselines: BASELINE.map((b) => ({ accountId: acct[b.key].id, accountName: acct[b.key].name, unitType: 'USD', monthlyNet: b.monthlyNet, monthsOfHistory: 12, rate: R.inflation.rate })),
    spending: base.flows.filter((f) => f.scenarioFlowType === 'SPENDING').map((f) => ({ flowId: f.id, label: f.label, categoryId: f.accountId, categoryName: f.accountName, accountId: f.targetAccountId, accountName: f.targetAccountName, baselineMonthly: -420, monthly: f.amount, monthsOfHistory: 12 })),
    accounts: base.accounts,
    netPositions: [{ unitType: 'USD', points: base.netPoints }],
    convertedNetPosition: converted(base.netPoints, run.unitType),
    funding: cleanF(base.funding),
    targets: base.targets.map(({ f, projected }) => {
      const onTrack = projected >= f.amount; const months = Math.max(1, monthsBetween(base.from, f.startDate));
      return { flowId: f.id, label: f.label, accountId: f.accountId, accountName: f.accountName, unitType: 'USD', target: f.amount, date: f.startDate, projected: round2(projected), onTrack, gap: onTrack ? null : round2(f.amount - projected), requiredMonthlyContribution: onTrack ? null : round2((f.amount - projected) / months), contributionAccountId: onTrack ? null : f.accountId, plannedOpenDate: null };
    }),
    stress: stressed ? { percent: run.stressPct, appliedOn: run.stressAt, funding: cleanF(stressed.funding).map(({ tax, penalty, ...rest }) => rest) } : null,
    drawdowns: [{ accountId: acct.brk.id, accountName: acct.brk.name, maxDrawdownPercent: -24.6 }, { accountId: acct.k401.id, accountName: acct.k401.name, maxDrawdownPercent: -19.8 }, { accountId: acct.roth.id, accountName: acct.roth.name, maxDrawdownPercent: -22.1 }],
    attribution: [],
    cashFlow: [...base.cash.values()].map((c) => ({ fromDate: c.fromDate, toDate: c.toDate, unitType: 'USD', moneyIn: round2(c.in), moneyOut: round2(c.out), net: round2(c.in - c.out), sources: [...c.sources].map(([label, amount]) => ({ kind: 'RECURRENCE', id: null, label, amount: round2(amount) })) })),
  };
}

// ----------------------------------------------------------------- routes
const ok = (data, etag) => ({ data: structuredClone(data), etag: etag != null ? String(etag) : null });
const notFound = (path) => { throw { status: 404, body: { code: 'not_found', errors: [`${path} not found`] } }; };
const checkVersion = (entity, ifMatch) => {
  if (ifMatch == null) throw { status: 400, body: { code: 'missing_header', errors: ['If-Match header is required'] } };
  if (Number(ifMatch) !== entity.version) throw { status: 409, body: { code: 'conflict', errors: ['Stale version'] } };
};
const personOut = (p) => ({ ...p, age: ageOf(p), partyId: DEMO_PARTY, createdDate: '2026-01-10T12:00:00Z', updatedDate: '2026-01-10T12:00:00Z' });

function route(method, path, { query = {}, body, ifMatch }) {
  const q = (k) => query[k];
  const qa = (k) => [].concat(query[k] ?? []).filter((x) => x !== '' && x != null);
  let m;
  if (method === 'GET' && path === '/v1/accounts') return ok({ paging: null, accounts: [...books.map(({ id, name, accountType, assetType }) => ({ id, name, accountType, assetType: assetType ?? null })), ...Object.values(cats)] });

  if (path === '/v1/forecast') {
    if ((body?.flows || []).some((f) => f.hypotheticalAccount || f.hypotheticalTargetAccount)) throw { status: 400, body: { code: 'validation_failed', errors: ['A what-if has no hypothetical accounts'] } };
    const days = Number(q('days') || 90), step = Number(q('step') || 1);
    const withBaseline = method === 'GET' ? q('baseline') !== false && q('baseline') !== 'false' : body?.includeBaseline ?? false;
    const r = simulate({ days, step, extraFlows: body?.flows || [], calendar: body?.includeCalendar ?? true, baseline: withBaseline, dailyBaseline: method === 'GET', scenarioList: (body?.scenarioIds || []).map((id) => scenarios.find((s) => s.id === id)).filter(Boolean) });
    if (method === 'GET') {
      return ok({ fromDate: r.from, toDate: r.to, stepDays: step, accounts: r.accounts, netPositions: [{ unitType: 'USD', points: r.netPoints }],
        convertedNetPosition: converted(r.netPoints, q('unit_type') || 'USD'),
        baselines: withBaseline ? BASELINE.filter((b) => acct[b.key].cash).map((b) => ({ accountId: acct[b.key].id, accountName: acct[b.key].name, unitType: 'USD', monthlyNet: b.monthlyNet, monthsOfHistory: 12, rate: DEFAULTS.inflation })) : [] });
    }
    return ok(toForecastResponse({ base: r, stressed: null, unitType: q('unit_type') || 'USD' }, []));
  }
  if (method === 'GET' && path === '/v1/upcoming') {
    const days = Number(q('days') || 30); const items = [];
    for (let i = 0; i < days; i++) {
      const date = addDays(TODAY, i);
      for (const st of STREAMS) if (streamFires(st, date, d2ms(date))) items.push({ date, kind: 'RECURRENCE', accountId: acct[st.key].id, accountName: acct[st.key].name, unitType: 'USD', amount: st.key === 'card' ? st.amount : st.amount, merchantName: st.merchant, recurrence: st.recurrence, frequency: st.frequency, cadenceDays: GAP[st.frequency] ?? null, source: 'MODEL', confidence: 0.86 + (st.merchant.length % 10) / 100, windowDays: st.every ? 1 : 2.5, interest: null, escrow: null, paymentDue: null });
      for (const a of books.filter((x) => x.payment) ) if (dayOf(date) === 1) { const interest = round2(a.opening * a.apr / 1200); items.push({ date, kind: 'LOAN_PAYMENT', accountId: a.id, accountName: a.name, unitType: 'USD', amount: -round2(a.payment - interest), merchantName: null, recurrence: null, frequency: 'MONTHLY', cadenceDays: null, source: null, confidence: null, windowDays: null, interest, escrow: a.escrow ?? null, paymentDue: round2(a.payment + (a.escrow || 0)) }); }
    }
    for (let i = 0; i < days; i++) {
      const date = addDays(TODAY, i);
      for (const p of planned.filter((x) => plannedFires(x, date))) {
        const side = (accountId, amount) => ({ date, kind: 'PLANNED', accountId, accountName: bookById.get(accountId).name, unitType: 'USD', amount, label: p.label, plannedTransactionId: p.id, merchantName: null, recurrence: null, frequency: null, cadenceDays: null, source: null, confidence: null, windowDays: null, interest: null, escrow: null, paymentDue: null });
        if (p.fromAccountId) items.push(side(p.fromAccountId, bookById.get(p.fromAccountId).accountType === 'LIABILITY' ? p.amount : -p.amount));
        if (p.toAccountId) items.push(side(p.toAccountId, bookById.get(p.toAccountId).accountType === 'LIABILITY' ? -p.amount : p.amount));
      }
    }
    for (const d of declarations) {
      const next = addMonths(TODAY, 0).slice(0, 8) + '27';
      if (next < addDays(TODAY, days)) items.push({ date: next, kind: 'RECURRENCE', accountId: d.accountId, accountName: d.accountName, unitType: 'USD', amount: -(d.amount ?? 50) * (bookById.get(d.accountId).accountType === 'LIABILITY' ? -1 : 1), merchantName: d.merchantName, recurrence: 'RECURRING', frequency: d.frequency, cadenceDays: GAP[d.frequency] ?? null, source: 'DECLARED', confidence: null, windowDays: null, interest: null, escrow: null, paymentDue: null });
    }
    items.unshift({ date: addDays(TODAY, -2), kind: 'RECURRENCE', accountId: acct.card.id, accountName: acct.card.name, unitType: 'USD', amount: 14.99, merchantName: 'Cloud Storage+', recurrence: 'SUBSCRIPTION', frequency: 'MONTHLY', cadenceDays: 31, source: 'HEURISTIC', confidence: null, windowDays: 3, interest: null, escrow: null, paymentDue: null });
    return ok({ fromDate: TODAY, toDate: addDays(TODAY, days - 1), items });
  }
  if (method === 'GET' && path === '/v1/recurrences/audit') {
    return ok({ findings: [
      { kind: 'PRICE_CHANGE', merchantName: 'Netflix', accountId: acct.card.id, accountName: acct.card.name, unitType: 'USD', recurrence: 'SUBSCRIPTION', frequency: 'MONTHLY', amount: 24.99, lastSeen: addDays(TODAY, -17), previousAmount: 22.99, changePercent: 8.7, changedOn: addDays(TODAY, -78), expectedOn: null, accounts: null },
      { kind: 'LAPSED', merchantName: 'Headspace', accountId: acct.card.id, accountName: acct.card.name, unitType: 'USD', recurrence: 'SUBSCRIPTION', frequency: 'MONTHLY', amount: 12.99, lastSeen: addDays(TODAY, -64), previousAmount: null, changePercent: null, changedOn: null, expectedOn: addDays(TODAY, -34), accounts: null },
      { kind: 'DUPLICATE', merchantName: 'Spotify', accountId: acct.card.id, accountName: acct.card.name, unitType: 'USD', recurrence: 'SUBSCRIPTION', frequency: 'MONTHLY', amount: 11.99, lastSeen: addDays(TODAY, -24), previousAmount: null, changePercent: null, changedOn: null, expectedOn: null,
        accounts: [{ accountId: acct.card.id, accountName: acct.card.name, unitType: 'USD', amount: 11.99, lastSeen: addDays(TODAY, -24) }, { accountId: acct.chk.id, accountName: acct.chk.name, unitType: 'USD', amount: 11.99, lastSeen: addDays(TODAY, -21) }] },
    ] });
  }
  if (method === 'GET' && path === '/v1/debts/payoff') return ok(debtPayoff(Number(q('extra') || 0)));

  // ---- recurrences: detected streams and declarations
  if (method === 'GET' && path === '/v1/recurrences') {
    return ok({ paging: null, recurrences: STREAMS.filter((st) => !st.pays).map((st, i) => ({ accountId: acct[st.key].id, unitType: 'USD', merchantName: st.merchant, streamNo: i, recurrence: st.recurrence, frequency: st.frequency, cadenceDays: GAP[st.frequency] ?? null, source: 'MODEL', confidence: 0.9, declarationId: null, active: true, nextExpectedDate: null, transactionCount: 12, firstSeen: '2025-10-01', lastSeen: addDays(TODAY, -10), minAmount: Math.abs(st.amount), maxAmount: Math.abs(st.amount), meanAmount: Math.abs(st.amount), medianGapDays: 30, gapStddev: 1 }))
      .concat(declarations.map((d) => ({ accountId: d.accountId, unitType: 'USD', merchantName: d.merchantName, recurrence: 'RECURRING', frequency: d.frequency, cadenceDays: GAP[d.frequency] ?? null, source: 'DECLARED', confidence: null, declarationId: d.id, active: true }))) });
  }
  if (method === 'GET' && path === '/v1/recurrences/declarations') return ok({ declarations });
  if (method === 'POST' && path === '/v1/recurrences/declarations') {
    const a = bookById.get(body.accountId);
    if (!a) throw { status: 400, body: { code: 'validation_failed', errors: ['accountId: must be a bank or card account in your books'] } };
    const known = ['Annual Car Insurance', 'Costco Membership', 'Amazon', ...STREAMS.map((x) => x.merchant)];
    const spelled = known.find((k) => k.toLowerCase() === body.merchantName.toLowerCase());
    if (!spelled) throw { status: 400, body: { code: 'validation_failed', errors: [`merchantName: "${body.merchantName}" has no posted transaction on ${a.name} (demo knows: ${known.slice(0, 3).join(', ')}…)`] } };
    const d = { id: uid(), accountId: a.id, accountName: a.name, unitType: 'USD', merchantName: spelled, amount: body.amount ?? null, frequency: body.frequency, version: 0, partyId: DEMO_PARTY, createdDate: new Date().toISOString(), updatedDate: new Date().toISOString() };
    declarations.push(d); return ok(d, 0);
  }
  if ((m = path.match(/^\/v1\/recurrences\/declarations\/([^/]+)$/)) && method === 'DELETE') {
    const d = declarations.find((x) => x.id === m[1]) || notFound(path); checkVersion(d, ifMatch);
    declarations.splice(declarations.indexOf(d), 1); return ok(d);
  }

  // ---- planned transactions
  if (path === '/v1/planning/transactions' && method === 'GET') return ok({ plannedTransactions: [...planned].sort((a, b) => a.date.localeCompare(b.date)) });
  const plannedOut = (b, prev) => {
    if (!b.fromAccountId && !b.toAccountId) throw { status: 400, body: { code: 'validation_failed', errors: ['Give fromAccountId, toAccountId or both'] } };
    if (b.fromAccountId && b.fromAccountId === b.toAccountId) throw { status: 400, body: { code: 'validation_failed', errors: ['The same account on both sides'] } };
    if (b.endDate && !b.cadenceMonths) throw { status: 400, body: { code: 'validation_failed', errors: ['endDate needs cadenceMonths'] } };
    const now = new Date().toISOString();
    return { id: prev?.id || uid(), fromAccountId: b.fromAccountId ?? null, fromAccountName: bookById.get(b.fromAccountId)?.name ?? null, toAccountId: b.toAccountId ?? null, toAccountName: bookById.get(b.toAccountId)?.name ?? null,
      unitType: 'USD', amount: b.amount, date: b.date, cadenceMonths: b.cadenceMonths ?? null, endDate: b.endDate ?? null, label: b.label, version: prev ? prev.version + 1 : 0, partyId: DEMO_PARTY, createdDate: prev?.createdDate || now, updatedDate: now };
  };
  if (path === '/v1/planning/transactions' && method === 'POST') { const p = plannedOut(body); planned.push(p); return ok(p, 0); }
  if ((m = path.match(/^\/v1\/planning\/transactions\/([^/]+)$/))) {
    const p = planned.find((x) => x.id === m[1]) || notFound(path);
    if (method === 'GET') return ok(p, p.version);
    checkVersion(p, ifMatch);
    if (method === 'PUT') { const n = plannedOut(body, p); planned[planned.indexOf(p)] = n; return ok(n, n.version); }
    if (method === 'DELETE') { planned.splice(planned.indexOf(p), 1); return ok(p); }
  }

  // ---- month-end budget projection
  if (method === 'GET' && path === '/v1/budgeting/projection') return ok(monthEnd(q('date') || TODAY));

  // ---- planning
  if (path === '/v1/planning/assumptions') {
    if (method === 'PUT') {
      if (assumptions) checkVersion(assumptions, ifMatch); else if (ifMatch != null) throw { status: 409, body: { code: 'conflict', errors: ['No assumptions to match'] } };
      assumptions = { ...body, version: assumptions ? assumptions.version + 1 : 0 };
    }
    const r = rates(null);
    for (const k of Object.keys(r)) if (r[k].source !== 'PARTY') r[k].source = 'DEFAULT';
    return ok({ partyId: DEMO_PARTY, assumptions: r, updatedDate: assumptions ? new Date().toISOString() : null, version: assumptions?.version ?? null }, assumptions?.version);
  }
  if (method === 'GET' && path === '/v1/planning/persons') return ok({ persons: persons.map(personOut) });
  if (method === 'POST' && path === '/v1/planning/persons') { const p = { id: uid(), name: body.name, birthDate: body.birthDate, version: 0 }; persons.push(p); return ok(personOut(p), 0); }
  if ((m = path.match(/^\/v1\/planning\/persons\/([^/]+)$/))) {
    const p = persons.find((x) => x.id === m[1]) || notFound(path);
    if (method === 'PUT') { checkVersion(p, ifMatch); Object.assign(p, { name: body.name, birthDate: body.birthDate, version: p.version + 1 }); }
    if (method === 'DELETE') {
      checkVersion(p, ifMatch);
      if (scenarios.some((s) => s.horizonPersonId === p.id || s.scenarioFlows.some((f) => f.personId === p.id) || s.scenarioStreamOverrides.some((o) => o.personId === p.id))) throw { status: 409, body: { code: 'in_use', errors: [`${p.name} dates a scenario and cannot be removed`] } };
      persons.splice(persons.indexOf(p), 1);
    }
    return ok(personOut(p), p.version);
  }

  // ---- scenarios
  if (method === 'GET' && path === '/v1/scenarios') return ok({ paging: { pageSize: 200, pageIndex: 0, totalPages: 1, totalElements: scenarios.length, isLastPage: true, nextPage: null, previousPage: null }, scenarios });
  if (method === 'POST' && path === '/v1/scenarios') { const s = saveScenario(null, body); return ok(s, s.version); }
  if (method === 'GET' && path === '/v1/scenarios/forecast') {
    const list = qa('scenario').map((id) => scenarios.find((s) => s.id === id) || notFound(`scenario ${id}`));
    return ok(toForecastResponse(scenarioRun(list, { step: Number(q('step') || 30), stress: Number(q('stress') || -30), unitType: q('unit_type') || 'USD' }), list));
  }
  if (method === 'GET' && path === '/v1/scenarios/simulation') {
    const list = qa('scenario').map((id) => scenarios.find((s) => s.id === id) || notFound(`scenario ${id}`));
    return ok(simulation(list, query));
  }
  if (method === 'GET' && path === '/v1/scenarios/compare') {
    const list = qa('scenario').map((id) => scenarios.find((s) => s.id === id) || notFound(`scenario ${id}`));
    const variants = [null, ...qa('return_rate').map((v) => ({ returnRate: Number(v), label: `return ${v}%` })), ...qa('inflation_rate').map((v) => ({ inflationRate: Number(v), label: `inflation ${v}%` })), ...qa('income_growth_rate').map((v) => ({ incomeGrowthRate: Number(v), label: `income growth ${v}%` })), ...qa('tax_rate').map((v) => ({ taxRate: Number(v), label: `tax ${v}%` }))];
    if (list.length * variants.length > 12) throw { status: 400, body: { code: 'bad_request', errors: [`${list.length * variants.length} runs requested; at most 12`] } };
    // Every run shares the first scenario's horizon.
    const until = list[0].horizonPersonId ? dateAtAge(list[0].horizonPersonId, list[0].horizonAge) : addMonths(TODAY, 12 * list[0].horizonYears);
    const runs = list.flatMap((s) => variants.map((v) => ({ s, v, r: toForecastResponse(scenarioRun([s], { step: Number(q('step') || 30), variant: v, unitType: q('unit_type') || 'USD', until }), [s]) })));
    // Every run shares the first run's horizon.
    const comparisons = runs.map(({ s, v, r }) => ({
      key: v ? `${s.name} · ${v.label}` : s.name, scenarioIds: [s.id], variant: v ? { returnRate: v.returnRate ?? null, inflationRate: v.inflationRate ?? null, incomeGrowthRate: v.incomeGrowthRate ?? null, taxRate: v.taxRate ?? null, volatility: null, label: v.label } : null,
      unreachableAccountIds: [], assumptions: r.assumptions, netPositions: r.netPositions, convertedNetPosition: r.convertedNetPosition,
      accounts: r.accounts.map((a) => ({ accountId: a.id, accountName: a.name, unitType: a.unitType, hypothetical: a.hypothetical, closing: a.closing, low: a.low })),
      funding: r.funding, targets: r.targets,
    }));
    const first = comparisons[0];
    const deltas = comparisons.slice(1).map((c) => ({
      key: c.key,
      netPositions: c.netPositions.map((np) => ({ unitType: np.unitType, points: np.points.map((p, i) => ({ date: p.date, balance: round2(p.balance - (first.netPositions[0].points[i]?.balance ?? first.netPositions[0].points.at(-1).balance)) })) })),
      convertedNetPosition: { ...c.convertedNetPosition, points: c.convertedNetPosition.points.map((p, i) => ({ date: p.date, balance: round2(p.balance - (first.convertedNetPosition.points[i]?.balance ?? first.convertedNetPosition.points.at(-1).balance)) })) },
      accounts: c.accounts.map((a) => ({ accountId: a.accountId, accountName: a.accountName, unitType: a.unitType, hypothetical: a.hypothetical, delta: round2(a.closing - (first.accounts.find((x) => (a.hypothetical ? x.hypothetical && x.accountName === a.accountName : x.accountId === a.accountId))?.closing ?? 0)) })),
    }));
    const r0 = runs[0].r;
    return ok({ fromDate: r0.fromDate, toDate: r0.toDate, stepDays: r0.stepDays, comparisons, deltas });
  }
  if ((m = path.match(/^\/v1\/scenarios\/([^/]+)(\/copy|\/forecast|\/forecast\/ledger|\/forecast\/simulation)?$/))) {
    const s = scenarios.find((x) => x.id === m[1]) || notFound(path);
    if (m[2] === '/copy') { const c = { ...structuredClone(s), id: uid(), name: q('name') || `${s.name} (copy)`, version: 0, createdDate: new Date().toISOString() }; c.scenarioFlows = c.scenarioFlows.filter((f) => f.complete); scenarios.push(c); return ok(c, 0); }
    if (m[2] === '/forecast/simulation') return ok(simulation([s], query));
    if (m[2] === '/forecast') return ok(toForecastResponse(scenarioRun([s], { step: Number(q('step') || 30), stress: Number(q('stress') || -30), baseline: q('baseline') !== 'false', unitType: q('unit_type') || 'USD' }), [s]));
    if (m[2] === '/forecast/ledger') {
      const after = q('after_date') || TODAY, before = q('before_date') || addDays(after, 90);
      const r = scenarioRun([s], { step: 3650, stress: -30, baseline: q('baseline') !== 'false' }).base;
      const evs = r.events.get(q('account')) || notFound(`account ${q('account')}`);
      const a = r.accounts.find((x) => x.id === q('account'));
      const prior = evs.filter((e) => e.date < after).at(-1);
      const inWin = evs.filter((e) => e.date >= after && e.date <= before);
      return ok({ fromDate: r.from, afterDate: after, beforeDate: before, accountId: a.id, accountName: a.name, unitType: 'USD', hypothetical: a.hypothetical, opening: prior?.balance ?? a.opening, closing: inWin.at(-1)?.balance ?? prior?.balance ?? a.opening, events: inWin });
    }
    if (method === 'GET') return ok(s, s.version);
    if (method === 'PUT') { checkVersion(s, ifMatch); const n = saveScenario(s, body); return ok(n, n.version); }
    if (method === 'DELETE') { checkVersion(s, ifMatch); scenarios.splice(scenarios.indexOf(s), 1); return ok(s, s.version); }
  }
  throw { status: 404, body: null };
}

function debtPayoff(extra) {
  const debts = books.filter((a) => a.accountType === 'LIABILITY' && a.apr && (a.payment || a.minPay));
  const skipped = books.filter((a) => a.accountType === 'LIABILITY' && !debts.includes(a)).map((a) => ({ accountId: a.id, accountName: a.name, liabilityType: a.liabilityType, reason: 'No APR on the account' }));
  const plan = (strategy) => {
    const bal = new Map(debts.map((d) => [d.id, d.opening])); const interest = new Map(debts.map((d) => [d.id, 0])); const paidOff = new Map();
    const balances = []; let totalInterest = 0, totalPaid = 0, month = 0;
    while ([...bal.values()].some((b) => b > 0.005) && month < 600) {
      month++;
      const date = addMonths(TODAY.slice(0, 8) + '01', month);
      let pool = strategy === 'MINIMUM' ? 0 : extra;
      for (const d of debts) {
        const b = bal.get(d.id); if (b <= 0.005) { if (strategy !== 'MINIMUM') pool += d.payment || d.minPay; continue; }
        const i = b * d.apr / 1200; interest.set(d.id, interest.get(d.id) + i); totalInterest += i;
        const pay = Math.min(b + i, d.payment || d.minPay); bal.set(d.id, b + i - pay); totalPaid += pay;
        if (bal.get(d.id) <= 0.005 && !paidOff.has(d.id)) paidOff.set(d.id, date);
      }
      const order = debts.filter((d) => bal.get(d.id) > 0.005).sort((a, b) => (strategy === 'AVALANCHE' ? b.apr - a.apr : bal.get(a.id) - bal.get(b.id)));
      for (const d of order) { if (pool <= 0) break; const p = Math.min(pool, bal.get(d.id)); bal.set(d.id, bal.get(d.id) - p); pool -= p; totalPaid += p; if (bal.get(d.id) <= 0.005 && !paidOff.has(d.id)) paidOff.set(d.id, date); }
      balances.push({ date, balance: round2([...bal.values()].reduce((s, b) => s + Math.max(0, b), 0)) });
    }
    return { strategy, months: month, payoffDate: balances.at(-1)?.date ?? null, totalInterest: round2(totalInterest), totalPaid: round2(totalPaid), interestSaved: 0, monthsSaved: 0,
      payoffs: [...paidOff].map(([id, date]) => ({ accountId: id, accountName: bookById.get(id).name, payoffDate: date, interestPaid: round2(interest.get(id)) })), balances };
  };
  const strategies = ['MINIMUM', 'AVALANCHE', 'SNOWBALL'].map(plan);
  for (const s of strategies.slice(1)) { s.interestSaved = round2(strategies[0].totalInterest - s.totalInterest); s.monthsSaved = strategies[0].months - s.months; }
  return { fromDate: TODAY, unitType: 'USD', extraPayment: extra, debts: debts.map((d) => ({ accountId: d.id, accountName: d.name, liabilityType: d.liabilityType, balance: d.opening, apr: d.apr, minimumPayment: round2(d.payment || d.minPay) })), skipped, strategies };
}

// ---- Monte Carlo: the scenario run over random market paths, banded at the 10th/50th/90th percentile.
// The demo computes at most DEMO_MAX_PATHS paths (each is a full day-by-day run) and reports the count it ran.
const DEMO_MAX_PATHS = 25;
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function simulation(list, query) {
  const n = (k) => (query[k] == null || query[k] === '' ? undefined : Number(query[k]));
  const requested = n('paths') ?? 500;
  if (requested < 10 || requested > 2000) throw { status: 400, body: { code: 'bad_request', errors: ['paths: 10 to 2000'] } };
  const seed = n('seed') ?? Math.floor(Math.random() * 2 ** 31);
  const variant = { returnRate: n('return_rate'), inflationRate: n('inflation_rate'), incomeGrowthRate: n('income_growth_rate'), taxRate: n('tax_rate'), volatility: n('volatility') };
  const R = rates(list[0], variant);
  const s0 = list[0];
  const horizonEnd = s0.horizonPersonId ? dateAtAge(s0.horizonPersonId, s0.horizonAge) : addMonths(TODAY, 12 * s0.horizonYears);
  const days = Math.round((d2ms(horizonEnd) - d2ms(TODAY)) / 86400000);
  const step = n('step') ?? 30;
  const rnd = mulberry32(seed);
  const gauss = () => { const u = 1 - rnd(), v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const count = Math.min(requested, DEMO_MAX_PATHS);
  const runs = [];
  for (let i = 0; i < count; i++) {
    const z = Array.from({ length: Math.ceil(days / 28) + 2 }, gauss);
    // One draw a month for every investment account: a log-normal monthly deviation of sd σ/√12,
    // spread over the month's days, less the drift correction so the median path keeps the assumed return.
    const sd = R.volatility.rate / 100 / Math.sqrt(12);
    runs.push(simulate({ from: TODAY, days, step, scenarioList: list, variant, market: (m) => (sd * z[m] - sd * sd / 2) / 30.44 }));
  }
  const pctl = (vals, q) => { const v = [...vals].sort((x, y) => x - y); const i = (v.length - 1) * q; const lo = Math.floor(i); return round2(v[lo] + (v[Math.ceil(i)] - v[lo]) * (i - lo)); };
  const band = (vals) => ({ low: pctl(vals, 0.1), median: pctl(vals, 0.5), high: pctl(vals, 0.9) });
  const first = runs[0];
  const share = (k) => round2((100 * k) / count);
  const funding = first.funding.map((f0) => {
    const per = runs.map((r) => r.funding.find((f) => f.accountId === f0.accountId));
    const short = per.filter((f) => !f.funded);
    return { accountId: f0.accountId, accountName: f0.accountName, unitType: 'USD', withdrawals: f0.withdrawals, fundedPercent: share(count - short.length),
      medianShortDate: short.length ? [...short.map((f) => f.shortDate)].sort()[Math.floor(short.length / 2)] : null,
      medianShortfall: short.length ? pctl(short.map((f) => f.shortfall ?? 0), 0.5) : null };
  });
  const allFunded = runs.filter((r) => r.funding.every((f) => f.funded)).length;
  return {
    fromDate: first.from, toDate: first.to, stepDays: step, paths: count, seed, scenarios: list, unreachableAccountIds: [],
    assumptions: [{ partyId: DEMO_PARTY, assumptions: R }],
    marketAccountIds: books.filter((a) => a.invest).map((a) => a.id),
    successPercent: first.funding.length ? share(allFunded) : null,
    funding,
    targets: first.targets.map(({ f }) => {
      const proj = runs.map((r) => r.targets.find((t) => t.f.id === f.id)?.projected ?? 0);
      return { flowId: f.id, label: f.label, accountId: f.accountId, accountName: f.accountName, unitType: 'USD', target: f.amount, date: f.startDate, onTrackPercent: share(proj.filter((v) => v >= f.amount).length), projected: band(proj), plannedOpenDate: null };
    }),
    accounts: first.accounts.map((a, k) => ({ id: a.id, name: a.name, accountType: a.accountType, unitType: 'USD', hypothetical: a.hypothetical, opening: a.opening,
      belowZeroPercent: share(runs.filter((r) => r.accounts[k].low.balance < 0).length),
      points: a.points.map((p, j) => ({ date: p.date, ...band(runs.map((r) => r.accounts[k].points[j]?.balance ?? 0)) })) })),
    netPositions: [{ unitType: 'USD', points: first.netPoints.map((p, j) => ({ date: p.date, ...band(runs.map((r) => r.netPoints[j]?.balance ?? 0)) })) }],
  };
}

// ---- month-end projection for a category budget
function monthEnd(date) {
  const month = date.slice(0, 8) + '01';
  const end = addDays(addMonths(month, 1), -1);
  const current = TODAY >= month && TODAY <= end, past = TODAY > end;
  const dim = Number(end.slice(8)), dayNo = current ? dayOf(TODAY) : past ? dim : 0;
  const left = (dim - dayNo) / dim;
  const rows = [
    { c: cats.salary, actual: 3900 * (2 - Math.round(2 * left)), known: 3900 * Math.round(2 * left), everyday: 0, budget: 7800 },
    { c: cats.groceries, actual: 820 * (dayNo / dim), known: 0, everyday: 820 * left, budget: 750 },
    { c: cats.dining, actual: 410 * (dayNo / dim), known: 0, everyday: 410 * left, budget: 400 },
    { c: cats.travel, actual: past || current ? 1260 : 0, known: 0, everyday: 90 * left, budget: null },
  ];
  const categories = rows.map(({ c, actual, known, everyday, budget }) => {
    const projected = round2(actual + known + everyday);
    return { accountId: c.id, accountName: c.name, accountType: c.accountType, unitType: 'USD', actualToDate: round2(actual), remainingKnown: round2(known), remainingEveryday: round2(everyday), projected, budgeted: budget, variance: budget == null ? null : round2(budget - projected) };
  });
  const totals = ['REVENUE', 'EXPENSE'].map((t) => {
    const rs = categories.filter((c) => c.accountType === t), sum = (k) => round2(rs.reduce((x, c) => x + (c[k] ?? 0), 0));
    return { unitType: 'USD', accountType: t, actualToDate: sum('actualToDate'), remainingKnown: sum('remainingKnown'), remainingEveryday: sum('remainingEveryday'), projected: sum('projected'), budgeted: rs.some((c) => c.budgeted != null) ? sum('budgeted') : null };
  });
  return { month, monthEnd: end, postedThrough: current ? TODAY : past ? end : null, daysRemaining: dim - dayNo, monthsOfHistory: 12, categories, totals };
}

seedScenarios();
// A known-coming bill and bonus, carried by every forecast.
planned.push(
  { id: uid(), fromAccountId: acct.chk.id, fromAccountName: acct.chk.name, toAccountId: null, toAccountName: null, unitType: 'USD', amount: 2400, date: addDays(TODAY, 45), cadenceMonths: null, endDate: null, label: 'Estimated tax payment', version: 0, partyId: DEMO_PARTY, createdDate: TODAY + 'T00:00:00Z', updatedDate: TODAY + 'T00:00:00Z' },
  { id: uid(), fromAccountId: null, fromAccountName: null, toAccountId: acct.chk.id, toAccountName: acct.chk.name, unitType: 'USD', amount: 5000, date: addDays(TODAY, 70), cadenceMonths: 12, endDate: null, label: 'Annual bonus', version: 0, partyId: DEMO_PARTY, createdDate: TODAY + 'T00:00:00Z', updatedDate: TODAY + 'T00:00:00Z' },
);

export async function demoSend(method, path, opts = {}) {
  await new Promise((r) => setTimeout(r, 120));
  try { return route(method, path, opts); } catch (e) {
    if (e && e.status) {
      const { ApiError } = await import('./api.js');
      throw new ApiError(e.status, e.body?.code || null, e.body?.errors || [], `${method} ${path}`);
    }
    throw e;
  }
}
