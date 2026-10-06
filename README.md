# BigBooks Forecast & Scenarios

A static app over the BigBooks forward-looking endpoints. Like the other BigBooks samples,
it's plain HTML, CSS and ES modules with no build step and no backend. Sign-in is
OAuth 2.0 Authorization Code + PKCE in the browser.

| Tab | What it shows | Endpoints |
| --- | --- | --- |
| **Cash forecast** | Net position day by day, each account's low point, floor breaches and the top-up that prevents them, with or without everyday spending. **What if…** adds one-off flows for a single run and saves nothing. | `GET /v1/forecast`, `POST /v1/forecast` |
| **Upcoming** | Expected charges, deposits and loan payments; **planned transactions** you know are coming (a tax bill, a bonus); **declared recurring charges** the calendar can't detect yet; and the subscription audit | `GET /v1/upcoming`, `GET/POST/PUT/DELETE /v1/planning/transactions`, `GET /v1/recurrences`, `GET/POST/DELETE /v1/recurrences/declarations`, `GET /v1/recurrences/audit` |
| **This month** | Where each budget category ends the month: posted so far, known streams still to come, the everyday run-rate, against the budget | `GET /v1/budgeting/projection` |
| **Scenarios** | List, create, edit, copy and archive scenarios. Each one covers flows, calendar overrides, hypothetical accounts and exclusions. A run reports funding (short or funded, the extra saving needed, or how much later withdrawals can start), a market-shock stress test, targets, household cash flow, and a per-account ledger trace. **How sure is it?** runs a Monte Carlo simulation: the odds each withdrawal is funded and each target met, and a 10th–90th percentile fan of net position, repeatable by seed. Scenarios carry an income-tax rate on IRA/401(k) withdrawals, a volatility, RMD flows and dated calendar overrides. | `GET/POST /v1/scenarios`, `GET/PUT/DELETE /v1/scenarios/{id}`, `POST …/{id}/copy`, `GET …/{id}/forecast`, `GET …/{id}/forecast/ledger`, `GET …/{id}/forecast/simulation` |
| **Compare** | Scenarios side by side under alternative return, inflation or income-growth rates, with differences from the first. Rates can include income tax. **Run together** and **Simulate together** combine several scenarios into one plan. | `GET /v1/scenarios/compare`, `GET /v1/scenarios/forecast`, `GET /v1/scenarios/simulation` |
| **Debt payoff** | Minimums vs. avalanche vs. snowball for an extra monthly amount, with debts left out for missing terms | `GET /v1/debts/payoff` |
| **Planning** | Default rates (including income tax and market volatility), and the people scenarios can be dated by (for example, "retire at 62") | `GET/PUT /v1/planning/assumptions`, `GET/POST /v1/planning/persons`, `PUT/DELETE /v1/planning/persons/{id}` |

The **Just me / Household** toggle sends `perspective=SINGLETON|COMPOSITE`. The currency picker sends `unit_type`.

## Run it

```bash
python3 -m http.server 5174 --directory public
```

- `http://localhost:5174/#demo` uses a synthetic household. An in-page simulation answers
  every route in the spec's response shapes, so no account is needed. Its simulations compute at most 25 paths.
- For live data, set `CLIENT_ID`, `API` and `ISSUER` in [`public/config.js`](public/config.js). The client
  must be a public OAuth client (PKCE) with `http://localhost:5174/` as a redirect URI and the
  `openid` scope.
- With `ALLOW_PASTED_TOKEN` on in `config.js`, the sign-in card also accepts a pasted access
  token and party id for local development.

## Layout

```
public/
  index.html     markup for the seven tabs
  styles.css     light/dark tokens, layout
  config.js      client id, API and issuer
  api.js         PKCE, token/session, fetch with If-Match / ETag and error bodies
  endpoints.js   one wrapper per operation in the spec
  charts.js      SVG line and percentile-band charts with crosshair tooltip
  app.js         the views
  demo.js        demo backend (#demo only)
openapi.json     the BigBooks API spec the app was built from, for reference
.claude/
  launch.json    serves public/ on :5174 for Claude Code previews
```

## See also

[networth-dashboard-sample](https://github.com/BigBooksApp/networth-dashboard-sample) and
[envelope-budgeting-sample](https://github.com/BigBooksApp/envelope-budgeting-sample): the same
static-app pattern over balance sheets and budgeting.

## Questions

Ask in the [BigBooks Developers Discord](https://discord.gg/DTwq2Ukuty).
