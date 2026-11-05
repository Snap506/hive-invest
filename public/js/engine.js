/* Hive engine — pure decision code. No screen, no storage, no network.
   The same file runs in the browser (the app) and in the Cloudflare Worker (the daily check).
   Two accounts: a MAIN account built month by month and rebalanced, and a small TRADING account running one tested Bitcoin rule. */
export const VERSION = '2.3.0';
const fin = v => typeof v === 'number' && isFinite(v);
const roundTo = (v, s) => Math.round(v / s) * s;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ---------- the plan: what share of everything goes where ---------- */
export const BUCKETS = [
  { id: 'global', name: 'Global shares', risk: 'Growth', hold: 'An all-world or S&P 500 index fund', how: 'Bought every month, never sold on dips' },
  { id: 'sa', name: 'SA shares', risk: 'Growth', hold: 'A JSE Top 40 or All Share index fund', how: 'Bought every month' },
  { id: 'bonds', name: 'Bonds & cash', risk: 'Steady', hold: 'An SA bond fund or a money-market fund', how: 'The shock absorber; it buys the dips when you rebalance' },
  { id: 'crypto', name: 'Crypto (held)', risk: 'High', hold: 'Bitcoin, with a little Ether', how: 'Bought monthly and held; trimmed when it runs above target' },
  { id: 'trade', name: 'Trading account', risk: 'Rule-based', hold: 'Bitcoin or cash, by the 200-day rule', how: 'Half in Bitcoin above its 200-day average, none below' },
];
export const PRESETS = {
  balanced: { name: 'Balanced', targets: { global: .55, sa: .15, bonds: .15, crypto: .05, trade: .10 }, expect: 'about 11–13% a year over 5+ years', bad: 'a bad year could be −20%' },
  aggressive: { name: 'Aggressive', targets: { global: .50, sa: .10, bonds: .05, crypto: .20, trade: .15 }, expect: 'about 13–16% a year over 5+ years if crypto keeps growing', bad: 'a bad year could be −35% or worse' },
};
export const BAND = .05;                 // rebalance when a bucket drifts more than 5 points
export const REBALANCE_MIN_TOTAL = 20000; // ...and only once the main account holds this much
export const TFSA = { year: 46000, life: 500000 };

/* contributions: a monthly budget — `monthly` rand a month in year 1, `step` more each year (for `rises` years), plus any extra you add.
   Older plans were written in rand a day; they are converted. */
export function normPlan(plan = {}) {
  if (plan.monthly != null) return { monthly: Math.max(0, +plan.monthly || 0), step: Math.max(0, +plan.step || 0), rises: Math.max(1, Math.round(plan.rises ?? 50)), minBuy: Math.max(0, plan.minBuy ?? 500), began: plan.began };
  return { monthly: roundTo((plan.start ?? 100) * 365 / 12, 10), step: roundTo((plan.step ?? 0) * 365 / 12, 10), rises: Math.max(1, plan.rises ?? 5), minBuy: 500, began: plan.began };
}
export const monthlyIn = (plan, year) => { const p = normPlan(plan); return p.monthly + p.step * Math.min(Math.max(0, year), p.rises - 1); };
export const planYear = (began, now = Date.now()) => Math.max(0, Math.floor((now - Date.parse(began)) / (365.25 * 864e5)));
/* SA tax year runs 1 March – end February; the tax-free account allows R46,000 a year, R500,000 for life */
export const taxYear = (ms = Date.now()) => { const d = new Date(ms + 2 * 3600e3), y = d.getUTCFullYear(); return d.getUTCMonth() >= 2 ? y : y - 1; };
export function tfsaRoom(t = {}, ms = Date.now()) { const ty = taxYear(ms), used = t.year === ty ? t.used || 0 : 0; return { ty, used, life: t.life || 0, room: Math.max(0, Math.min(TFSA.year - used, TFSA.life - (t.life || 0))) }; }
export const TFSA_ORDER = ['global', 'sa', 'bonds'];   // fastest growers first: their gains are the most valuable to shelter

/* split new money: fill the buckets furthest below target first, then in proportion to target; whole R10 amounts that add up exactly.
   minBuy: no purchase smaller than this — the money goes to the buckets further behind, and the small one catches up next month. */
export function splitMonth({ targets, cur, amount, minBuy = 0 }) {
  const ids = Object.keys(targets), total = ids.reduce((t, k) => t + (cur[k] || 0), 0), after = total + amount;
  let live = ids.slice(), add;
  for (;;) {
    const tw = live.reduce((t, k) => t + targets[k], 0), gaps = live.map(k => Math.max(0, targets[k] * after - (cur[k] || 0))), gs = gaps.reduce((a, b) => a + b, 0);
    add = Object.fromEntries(ids.map(k => [k, 0]));
    live.forEach((k, i) => { add[k] = amount <= 0 ? 0 : gs >= amount ? amount * gaps[i] / gs : gaps[i] + (amount - gs) * targets[k] / tw; });
    const small = live.filter(k => add[k] > 0 && add[k] < minBuy);
    if (!small.length || live.filter(k => add[k] > 0).length <= 1) break;
    const drop = small.reduce((a, b) => (add[a] <= add[b] ? a : b)); live = live.filter(k => k !== drop);
  }
  let sum = 0; for (const k of ids) { add[k] = roundTo(add[k], 10); sum += add[k]; }
  const top = ids.reduce((a, b) => (add[a] >= add[b] ? a : b)); add[top] += amount - sum;
  return { total, after, add };
}
/* rebalance the main account: only when a bucket drifts more than `band`; `exclude` buckets follow their own rule */
export function rebalance({ targets, cur, band = BAND, minTrade = 200, exclude = [], minTotal = 0 }) {
  const ids = Object.keys(targets).filter(k => !exclude.includes(k)), tw = ids.reduce((t, k) => t + targets[k], 0);
  const total = ids.reduce((t, k) => t + (cur[k] || 0), 0);
  if (!(total > 0)) return { due: false, total, rows: [] };
  const rows = ids.map(k => { const now = cur[k] || 0, pct = now / total, tgt = targets[k] / tw; return { id: k, now, pct, target: tgt, drift: pct - tgt, move: roundTo(tgt * total - now, 10) }; });
  const due = total >= minTotal && rows.some(r => Math.abs(r.drift) > band);
  return { due, total, rows: rows.map(r => ({ ...r, move: due && Math.abs(r.move) >= minTrade ? r.move : 0 })) };
}

/* ---------- the trading account: one rule, tested on 8½ years of daily Bitcoin prices ----------
   Hold `weight` of the account in Bitcoin while the daily close is above its 200-day average (a `buffer` stops flip-flopping),
   none while below. Rebalance back to `weight` when it drifts more than `band`. Cash waits in a money-market fund. */
export const TREND = { days: 200, buffer: .02, weight: .5, band: .20, minTrade: 200 };
export const TESTED = {
  source: 'Bitstamp daily BTC/USD', from: '2018-03-15', to: '2026-11-04', cagr: .288, dd: .276, worstYear: -.014, upYears: '8 of 9', trades: 35,
  since2023: { cagr: .254, dd: .166 }, noYield: { cagr: .223, dd: .31 }, hold: { cagr: .297, dd: .767, worstYear: -.654 },
  costs: '0.15% fee and a 0.2% price gap per trade; cash earning 7% a year in a money-market fund',
};
export const sma = (a, n) => { const o = new Array(a.length).fill(NaN); let s = 0; for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= n) s -= a[i - n]; if (i >= n - 1) o[i] = s / n; } return o; };
/* closes: daily closes oldest→newest (completed days only); px: the price to judge (the last close, or a live price for display) */
export function trendSignal({ closes, daysPer = 1, px, wasOn = null, rules = TREND }) {
  const n = Math.max(2, Math.round(rules.days / daysPer)), C = (closes || []).filter(fin);
  if (C.length < n) return { ok: false, why: `needs ${rules.days} days of prices` };
  const avg = C.slice(-n).reduce((a, b) => a + b, 0) / n, p = fin(px) && px > 0 ? px : C[C.length - 1], gap = p / avg - 1;
  let on = wasOn; if (on === null || on === undefined) on = gap > 0;
  if (!on && gap > rules.buffer) on = true; else if (on && gap < -rules.buffer) on = false;
  return { ok: true, on, avg, px: p, gap, sellBelow: avg * (1 - rules.buffer), buyAbove: avg * (1 + rules.buffer), target: on ? rules.weight : 0 };
}
/* what to trade now. cash in rand, units of BTC, pxZar = rand price of one BTC */
export function trendAction({ target, cash, units, pxZar, rules = TREND, fee = .0015 }) {
  if (!fin(target)) return { side: 'none', why: 'Waiting for enough price history' };
  if (!fin(pxZar) || pxZar <= 0) return { side: 'none', why: 'Waiting for a live price' };
  const coin = units * pxZar, total = cash + coin;
  if (!(total > 0)) return { side: 'none', why: 'Add money to the trading account to start' };
  const w = coin / total, want = target * total, d = want - coin;
  const must = (target === 0 && coin > rules.minTrade) || (target > 0 && coin < rules.minTrade && cash > rules.minTrade) || Math.abs(w - target) > rules.band;
  if (!must || Math.abs(d) < rules.minTrade) return { side: 'none', w, total, why: target ? `Holding about ${Math.round(w * 100)}% in Bitcoin — the rule wants ${Math.round(target * 100)}%, close enough` : 'Out of Bitcoin until it climbs back above its 200-day average' };
  if (d > 0) {
    const amount = roundTo(Math.min(d, cash), 10), limit = pxZar * 1.003;
    return { side: 'buy', amount, units: amount / (1 + fee) / limit, limit, w, total, why: target && coin < rules.minTrade ? 'Bitcoin is above its 200-day average — the rule says hold half the account in it' : `Bitcoin has fallen to ${Math.round(w * 100)}% of the account — top it back up to ${Math.round(target * 100)}%` };
  }
  const u = Math.min(units, -d / pxZar), limit = pxZar * .997;
  return { side: 'sell', amount: roundTo(u * pxZar, 10), units: u, limit, frac: units > 0 ? u / units : 0, w, total, why: target === 0 ? 'Bitcoin closed more than 2% below its 200-day average — the rule says sell it all and wait in cash' : `Bitcoin has grown to ${Math.round(w * 100)}% of the account — take it back to ${Math.round(target * 100)}%` };
}
/* daily candles [{t (unix s), c}] → closes of COMPLETED days only (drops today's unfinished candle) */
export function completedCloses(candles, nowMs = Date.now()) {
  const today = Math.floor(nowMs / 864e5) * 86400;
  return candles.filter(b => b.t < today && fin(b.c)).sort((a, b) => a.t - b.t);
}
/* replay the rule over a series (shown as a check in the app and used by the tests) */
export function trendReplay({ closes, rules = TREND, cashYield = .07, fee = .0015, spread = .002 }) {
  const n = rules.days, C = closes; let cash = 10000, u = 0, on = null, trades = 0; const eq = [], dy = Math.pow(1 + cashYield, 1 / 365) - 1;
  for (let t = n; t < C.length; t++) {
    cash *= 1 + dy;
    const s = trendSignal({ closes: C.slice(0, t + 1), px: C[t], wasOn: on, rules }); on = s.on;
    const a = trendAction({ target: s.target, cash, units: u, pxZar: C[t], rules, fee });
    if (a.side === 'buy') { cash -= a.amount; u += a.amount / (1 + fee) / (C[t] * (1 + spread)); trades++; }
    else if (a.side === 'sell') { u -= a.units; cash += a.units * C[t] * (1 - spread) * (1 - fee); trades++; }
    eq.push(cash + u * C[t]);
  }
  return { eq, trades };
}
/* ---------- research: what is moving, filtered for things a careful plan could own ---------- */
export function screenTrending(coins, { maxRank = 200, pump = .5 } = {}) {
  return (coins || []).map(c => {
    const ch = (c.ch24 || 0) / 100, rank = c.rank || 9999, flag = rank > maxRank ? 'small' : Math.abs(ch) > pump ? 'pump' : null;
    return { id: c.id, sym: String(c.symbol || '').toUpperCase(), name: c.name, rank, px: c.priceUsd, ch, flag };
  }).sort((a, b) => (!!a.flag - !!b.flag) || a.rank - b.rank);
}
export function screenSectors(cats, { minCap = 5e8, top = 8 } = {}) {
  return (cats || []).filter(c => (c.cap || 0) >= minCap).sort((a, b) => b.ch - a.ch).slice(0, top);
}
export { clamp, roundTo };
