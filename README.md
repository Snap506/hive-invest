# Hive Invest

This app runs two accounts.

- **Main account:** money goes in every month and is spread across global shares, SA shares, bonds and cash, and some held crypto. It is rebalanced when a bucket drifts.
- **Trading account:** a small account that follows one tested Bitcoin rule. It holds half the account in Bitcoin while Bitcoin's daily close is above its 200-day average (with a 2% buffer), and stays in cash while it is below.

All prices are live and nothing in the app is simulated.

**To set it up, follow [DEPLOY.md](DEPLOY.md).**

## How it fits together

```
 your phone / PC ──►  Cloudflare Worker (src/worker.js)
   (public/ app)        │  /api/live      prices + rule, cached 15 s for every device
                        │  /api/chart     daily history (Bitstamp, CoinGecko backup), cached 30 min
                        │  /api/state     your data, versioned so two devices never overwrite each other
                        │  /api/research  CoinGecko trending / sectors, cached 15 min
                        │  /api/history/* years of daily prices per bucket, filled in small pages
                        │  /api/status    tests every live connection
                        │  cron 08:05 SA  daily check → Telegram only when there is something to do
                        ▼
                    D1 database: your data, server notes, cache, event log
```

| Data | Source | Fallback |
|---|---|---|
| Rand price (what you trade at) | VALR BTC/ZAR | Bitstamp × rand rate |
| Dollar price and daily history (what the rule is judged on) | Bitstamp BTC/USD | CoinGecko daily |
| Rand per dollar | VALR ÷ Bitstamp | ECB (Frankfurter), then the setting in `wrangler.toml` |
| Research | CoinGecko | Last good answer |
| History: crypto / funds / rand | Bitstamp / Yahoo / ECB | Fill from your PC (`npm run backfill`) |

## Files

| Path | What it is |
|---|---|
| `public/js/engine.js` | All decision logic. Pure functions, shared by the app and the server. |
| `public/js/app.js` | The app: tabs, ticket, polling, saving |
| `public/js/patterns.js` | Pattern analysis in rand: growth, worst falls, ranges for 1 and 5 years, how the buckets move together, month-by-month moves, and your plan replayed on real prices. Runs in the browser. |
| `src/lib/history.js` | The history store, plus fetchers shared with `scripts/backfill.mjs` |
| `public/js/chart.js` | A canvas chart that redraws only when its data or size changes |
| `src/worker.js` | The API routes and the daily check |
| `src/lib/sources.js` | Provider calls, each with a timeout and one retry |
| `src/lib/store.js` | D1 storage: versioned documents, cache with stale fallback, event log |
| `src/lib/valr.js` | Read-only VALR requests, signed with HMAC-SHA512 |
| `src/lib/notify.js` | Telegram messages and the budget-capped Claude calls |
| `tests/` | Tests run with `npm test`. `node tests/serve.mjs` runs the whole app locally with fake providers. |

## Why it stays smooth

- **No heavy visual effects.** There is no blur and nothing animates constantly.
- **Updates touch only what changed.** Each section rebuilds only the parts whose content changed.
- **The chart redraws only when needed,** when its data or size changes, and its pixel ratio is capped at 2.
- **Polling pauses when you can't see it.** It stops when the tab is hidden and slows down (20 s → 2 min) when the server is unreachable.
- **Provider calls are shared.** The server caches prices, so many open devices still make one call per provider every 15 seconds.

## Safety

- **Passcode on everything.** Every API route needs the passcode, compared in constant time. Cloudflare Access can be added on top.
- **Strict page rules.** The site sends a strict Content-Security-Policy and refuses to be framed.
- **The VALR key is View-only.** The server cannot trade or withdraw.
- **Claude stays inside its budget.** It has a hard monthly cap and never makes trading decisions.
- **One pause switch** stops every suggestion.

This is information, not financial advice.
