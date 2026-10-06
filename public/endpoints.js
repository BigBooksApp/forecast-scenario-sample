// Thin wrappers over the forward-looking BigBooks endpoints, one per operation
// in the OpenAPI spec. `send` is the transport (the real `http` from api.js, or
// the demo backend); `ctx` carries the acting party and the perspective.

export function endpoints(send, ctx) {
  const party = () => ctx.party;
  const perspective = () => ctx.perspective;
  const get = (path, query, withParty = true) => send('GET', path, { query, party: withParty ? party() : undefined }).then((r) => r.data);

  return {
    // ---- supporting lookups
    accounts: () => get('/v1/accounts', {
      page_size: 2048, page_number: 0, perspective: perspective(),
      account_types: ['ASSET', 'LIABILITY', 'EXPENSE', 'REVENUE'],
    }),

    // ---- cash forecast
    forecast: ({ days, step, unitType, baseline = true }) => get('/v1/forecast', { days, step, unit_type: unitType, baseline, perspective: perspective() }),
    forecastWhatIf: ({ days, step, flows, unitType, scenarioIds = [] }) =>
      send('POST', '/v1/forecast', {
        party: party(),
        query: { days, step, unit_type: unitType, perspective: perspective() },
        body: { flows, scenarioIds, includeCalendar: true, includeBaseline: false, includeAttribution: true, period: 'MONTH' },
      }).then((r) => r.data),
    upcoming: ({ days }) => get('/v1/upcoming', { days, perspective: perspective() }),
    monthEnd: ({ date } = {}) => get('/v1/budgeting/projection', { date }),
    recurrences: () => get('/v1/recurrences', { page_size: 500, page_number: 0, active: true }),
    declarations: () => get('/v1/recurrences/declarations'),
    declare: (body) => send('POST', '/v1/recurrences/declarations', { party: party(), body }),
    withdrawDeclaration: (id, version) => send('DELETE', `/v1/recurrences/declarations/${id}`, { ifMatch: version }),
    audit: () => get('/v1/recurrences/audit', { perspective: perspective() }),
    debtPayoff: ({ extra, unitType }) => get('/v1/debts/payoff', { extra, unit_type: unitType, perspective: perspective() }),

    // ---- scenarios
    scenarios: () => get('/v1/scenarios', { page_size: 200, page_number: 0, perspective: perspective() }),
    scenario: (id) => send('GET', `/v1/scenarios/${id}`),
    createScenario: (body) => send('POST', '/v1/scenarios', { party: party(), body }),
    updateScenario: (id, version, body) => send('PUT', `/v1/scenarios/${id}`, { ifMatch: version, body }),
    archiveScenario: (id, version) => send('DELETE', `/v1/scenarios/${id}`, { ifMatch: version }),
    copyScenario: (id, name) => send('POST', `/v1/scenarios/${id}/copy`, { query: { name } }),
    // The scenario decides the scope of its own run: no perspective, no acting party.
    runScenario: (id, opts) => get(`/v1/scenarios/${id}/forecast`, runQuery(opts), false),
    ledger: (id, { account, afterDate, beforeDate }) =>
      get(`/v1/scenarios/${id}/forecast/ledger`, { account, after_date: afterDate, before_date: beforeDate }, false),
    runTogether: (ids, opts) => get('/v1/scenarios/forecast', { scenario: ids, ...runQuery(opts), perspective: perspective() }),
    // Monte Carlo: many market paths around the assumed return, as wide as the volatility.
    simulate: (id, opts) => get(`/v1/scenarios/${id}/forecast/simulation`, simQuery(opts), false),
    simulateTogether: (ids, opts) => get('/v1/scenarios/simulation', { scenario: ids, ...simQuery(opts), perspective: perspective() }),
    compare: (ids, { returnRates, inflationRates, incomeGrowthRates, taxRates, step, unitType }) => get('/v1/scenarios/compare', {
      scenario: ids, return_rate: returnRates, inflation_rate: inflationRates,
      income_growth_rate: incomeGrowthRates, tax_rate: taxRates, step, unit_type: unitType, perspective: perspective(),
    }),

    // ---- planning
    assumptions: () => send('GET', '/v1/planning/assumptions', { party: party() }),
    saveAssumptions: (version, body) => send('PUT', '/v1/planning/assumptions', { party: party(), ifMatch: version, body }),
    persons: () => get('/v1/planning/persons'),
    createPerson: (body) => send('POST', '/v1/planning/persons', { party: party(), body }),
    updatePerson: (id, version, body) => send('PUT', `/v1/planning/persons/${id}`, { ifMatch: version, body }),
    deletePerson: (id, version) => send('DELETE', `/v1/planning/persons/${id}`, { ifMatch: version }),
    plannedTransactions: () => get('/v1/planning/transactions'),
    createPlanned: (body) => send('POST', '/v1/planning/transactions', { party: party(), body }),
    updatePlanned: (id, version, body) => send('PUT', `/v1/planning/transactions/${id}`, { ifMatch: version, body }),
    deletePlanned: (id, version) => send('DELETE', `/v1/planning/transactions/${id}`, { ifMatch: version }),
  };
}

const runQuery = ({ step, stress, period, calendar, baseline, unitType } = {}) =>
  ({ step, stress, period, calendar, baseline, attribution: true, unit_type: unitType });

const simQuery = ({ paths, seed, step = 30, volatility, returnRate, inflationRate, incomeGrowthRate, taxRate } = {}) => ({
  paths, seed, step, volatility, return_rate: returnRate, inflation_rate: inflationRate,
  income_growth_rate: incomeGrowthRate, tax_rate: taxRate,
});
