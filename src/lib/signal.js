/* Builds everything the app and the daily check need from live data, using the same engine the app uses. */
import * as E from '../../public/js/engine.js';
import { valrSummary, bitstampTicker, bitstampDaily, cgDaily, frankfurterUsdZar, cgTrending, cgGlobal, cgCategories } from './sources.js';
import { cached } from './store.js';

const settle = async p => { try { return { ok: true, v: await p }; } catch (e) { return { ok: false, e: String(e.message || e) }; } };

/* live prices: refreshed at most every 15 s however many devices are open */
export async function market(env) {
  return cached(env, 'market', 15_000, async () => {
    const [z, u] = await Promise.all([settle(valrSummary('BTCZAR')), settle(bitstampTicker('btcusd'))]);
    if (!z.ok && !u.ok) throw new Error(`No live price: ${z.e}; ${u.e}`);
    let fx = null;
    if (z.ok && u.ok) fx = { rate: z.v.px / u.v.px, src: 'VALR ÷ Bitstamp' };
    else {
      const f = await settle(cached(env, 'fx', 6 * 3600_000, frankfurterUsdZar).then(r => r.data));
      fx = f.ok ? { rate: f.v.rate, src: f.v.src } : env.USDZAR_FALLBACK ? { rate: parseFloat(env.USDZAR_FALLBACK), src: 'fallback setting' } : null;
    }
    const zar = z.ok ? z.v : u.ok && fx ? { px: u.v.px * fx.rate, ch24: u.v.ch24, at: u.v.at, src: 'Bitstamp × rate' } : null;
    return { zar, usd: u.ok ? u.v : null, fx, errors: [z.ok ? null : 'VALR: ' + z.e, u.ok ? null : 'Bitstamp: ' + u.e].filter(Boolean) };
  });
}

/* daily history: completed days only, so it changes once a day; cached 30 min */
export async function history(env) {
  return cached(env, 'history', 30 * 60_000, async () => {
    let rows, src = 'Bitstamp';
    try { rows = E.completedCloses(await bitstampDaily('btcusd', 600)); }
    catch (e) { rows = E.completedCloses(await cgDaily(env, 365)); src = 'CoinGecko (backup: ' + String(e.message || e) + ')'; }
    return { t: rows.map(r => r.t), c: rows.map(r => r.c), src };
  });
}

/* the rule, walked forward day by day so the 2% buffer behaves exactly as it did in the test.
   One pass with a running average (fast enough for the free plan's 10 ms CPU limit); the last day uses the engine itself. */
export function walkSignal(closes, rules = E.TREND) {
  const n = rules.days, avg = E.sma(closes, n), flips = [];
  if (closes.length < n) return { ok: false, why: `needs ${n} days of prices, has ${closes.length}` };
  let on = null;
  for (let i = n - 1; i < closes.length - 1; i++) {
    const gap = closes[i] / avg[i] - 1, prev = on;
    if (on === null) on = gap > 0; if (!on && gap > rules.buffer) on = true; else if (on && gap < -rules.buffer) on = false;
    if (prev !== null && prev !== on) flips.push(i);
  }
  const prev = on, s = E.trendSignal({ closes: closes.slice(-n), px: closes[closes.length - 1], wasOn: on, rules });
  if (prev !== null && prev !== s.on) flips.push(closes.length - 1);
  return { ...s, flips };
}
export async function signal(env) {
  const h = await history(env), C = h.data.c, T = h.data.t, s = walkSignal(C);
  const lastFlip = s.flips?.length ? s.flips[s.flips.length - 1] : null;
  return {
    ...s, flips: undefined, closeDate: T.length ? new Date(T[T.length - 1] * 1000).toISOString().slice(0, 10) : null,
    since: lastFlip !== null ? new Date(T[lastFlip] * 1000).toISOString().slice(0, 10) : null,
    stale: !!h.stale, at: h.at, src: h.data.src || 'Bitstamp',
  };
}

/* chart series: last `days` closes with the 200-day average, decimated to keep the payload small */
export async function chart(env, days = 730) {
  const h = await history(env), C = h.data.c, T = h.data.t, avg = E.sma(C, E.TREND.days), from = Math.max(0, C.length - days);
  return { t: T.slice(from), c: C.slice(from), avg: avg.slice(from).map(v => (isFinite(v) ? +v.toFixed(2) : null)), at: h.at };
}

export async function research(env) {
  return cached(env, 'research', 15 * 60_000, async () => {
    const [t, g, c] = await Promise.all([settle(cgTrending(env)), settle(cgGlobal(env)), settle(cgCategories(env))]);
    if (!t.ok && !g.ok && !c.ok) throw new Error('CoinGecko unreachable: ' + t.e);
    return { trending: t.ok ? E.screenTrending(t.v) : [], global: g.ok ? g.v : null, sectors: c.ok ? E.screenSectors(c.v) : [], errors: [t, g, c].filter(x => !x.ok).map(x => x.e) };
  });
}
