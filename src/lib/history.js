/* Price history for every bucket, stored in D1 so pattern analysis never depends on a provider being up.
   Filled in small pages (one provider call per request) to stay inside the free plan's limits; topped up by the daily check.
   The same fetchers run from your PC (scripts/backfill.mjs) if a provider blocks Cloudflare's servers. */
import { fetchJson } from './sources.js';

export const SERIES = {
  btc:    { name: 'Bitcoin', bucket: 'crypto', ccy: 'USD', from: '2014-01-01', src: 'Bitstamp', pair: 'btcusd' },
  eth:    { name: 'Ether', bucket: 'crypto', ccy: 'USD', from: '2017-08-17', src: 'Bitstamp', pair: 'ethusd' },
  global: { name: 'Global shares', note: 'Vanguard Total World (VT), dividends included', bucket: 'global', ccy: 'USD', from: '2014-01-01', src: 'Yahoo', sym: 'VT' },
  sa:     { name: 'SA shares', note: 'Satrix 40 (STX40), dividends included', bucket: 'sa', ccy: 'ZAR', from: '2014-01-01', src: 'Yahoo', sym: 'STX40.JO' },
  bonds:  { name: 'SA bonds', note: 'Satrix SA Bond (STXGOV), interest included', bucket: 'bonds', ccy: 'ZAR', from: '2014-01-01', src: 'Yahoo', sym: 'STXGOV.JO' },
  usdzar: { name: 'Rand per dollar', ccy: 'ZAR', from: '2014-01-01', src: 'ECB (Frankfurter)' },
};
const DAY = 86400, dayOf = s => Math.floor(s / DAY) * DAY, iso = s => new Date(s * 1000).toISOString().slice(0, 10);
const todayStart = (now = Date.now()) => dayOf(now / 1000);
const BROWSER_UA = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' };

/* ---------- fetchers: each returns { bars: [[t, close], ...] (completed days, oldest first), done } ---------- */
async function bitstampPage(pair, start, now) {
  const d = await fetchJson(`https://www.bitstamp.net/api/v2/ohlc/${pair}/?step=86400&limit=1000&start=${start}`, { timeoutMs: 12000 });
  const today = todayStart(now), bars = (d?.data?.ohlc || []).map(b => [dayOf(+b.timestamp), +b.close]).filter(([t, c]) => t >= start && t < today && c > 0);
  return { bars, done: bars.length < 999 || bars[bars.length - 1][0] >= today - DAY };
}
async function yahooRange(sym, start, now) {
  const p2 = Math.min(Math.floor(now / 1000), start + 400 * DAY);   // a year or so per call keeps each request light
  const d = await fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=${start}&period2=${p2}&interval=1d&events=div%2Csplits&includeAdjustedClose=true`, { headers: BROWSER_UA, timeoutMs: 15000 });
  const r = d?.chart?.result?.[0];
  if (!r) { if (/exist|no data|not found/i.test(d?.chart?.error?.description || '')) return { bars: [], done: p2 >= Math.floor(now / 1000) - DAY, next: p2 }; throw new Error('Yahoo: ' + (d?.chart?.error?.description || 'no data for ' + sym)); }
  const ts = r.timestamp || [], adj = r.indicators?.adjclose?.[0]?.adjclose, close = r.indicators?.quote?.[0]?.close || [];
  const div = /ZAc|GBp|ILA/.test(r.meta?.currency || '') ? 100 : 1, today = todayStart(now), out = new Map();   // JSE prices come in cents
  ts.forEach((s, i) => { const c = (adj?.[i] ?? close[i]); const t = dayOf(s); if (c > 0 && t >= start && t < today) out.set(t, c / div); });
  return { bars: [...out.entries()].sort((a, b) => a[0] - b[0]), done: p2 >= Math.floor(now / 1000) - DAY, next: p2 };
}
async function frankfurterYear(start, now) {
  const today = todayStart(now), end = Math.min(start + 366 * DAY, today - DAY);
  if (end < start) return { bars: [], done: true };
  const d = await fetchJson(`https://api.frankfurter.app/${iso(start)}..${iso(end)}?from=USD&to=ZAR`, { timeoutMs: 12000 });
  const bars = Object.entries(d?.rates || {}).map(([k, v]) => [Date.parse(k + 'T00:00:00Z') / 1000, +v.ZAR]).filter(([t, c]) => c > 0 && t >= start).sort((a, b) => a[0] - b[0]);
  return { bars, done: end >= today - DAY };
}
export async function fetchChunk(id, start, now = Date.now()) {
  const s = SERIES[id]; if (!s) throw Object.assign(new Error('Unknown series ' + id), { status: 400 });
  if (s.src === 'Bitstamp') return bitstampPage(s.pair, start, now);
  if (s.src === 'Yahoo') return yahooRange(s.sym, start, now);
  return frankfurterYear(start, now);
}

/* ---------- storage ---------- */
export async function saveBars(env, id, bars) {
  const ok = bars.filter(([t, c]) => Number.isInteger(t) && t % DAY === 0 && Number.isFinite(c) && c > 0);
  const stmts = [];
  for (let i = 0; i < ok.length; i += 30) {   // D1 allows 100 bound values per statement
    const part = ok.slice(i, i + 30);
    stmts.push(env.DB.prepare(`INSERT OR REPLACE INTO bars (series, t, c) VALUES ${part.map(() => '(?, ?, ?)').join(', ')}`).bind(...part.flatMap(([t, c]) => [id, t, c])));
  }
  if (stmts.length) await (env.DB.batch ? env.DB.batch(stmts) : Promise.all(stmts.map(s => s.run())));
  return ok.length;
}
async function setMeta(env, id, source, error, cursor = null) {
  await env.DB.prepare('INSERT INTO hist_meta (series, source, error, updated_at, cursor) VALUES (?, ?, ?, ?, ?) ON CONFLICT(series) DO UPDATE SET source = excluded.source, error = excluded.error, updated_at = excluded.updated_at, cursor = COALESCE(excluded.cursor, hist_meta.cursor)').bind(id, source, error, Date.now(), cursor).run();
}
const dropSeriesCache = (env, id) => env.DB.prepare('DELETE FROM cache WHERE key = ?').bind('hist:' + id).run().catch(() => {});

/* fetch the next missing piece of one series and store it */
export async function fillOne(env, id, now = Date.now()) {
  const s = SERIES[id]; if (!s) throw Object.assign(new Error('Unknown series ' + id), { status: 400 });
  const [lr, mr] = await Promise.all([env.DB.prepare('SELECT MAX(t) AS t FROM bars WHERE series = ?').bind(id).first(), env.DB.prepare('SELECT cursor FROM hist_meta WHERE series = ?').bind(id).first()]);
  const last = lr?.t, start = Math.max(last ? last + DAY : Date.parse(s.from + 'T00:00:00Z') / 1000, mr?.cursor || 0);
  if (start >= todayStart(now)) return { id, added: 0, done: true, to: last ? iso(last) : null };
  try {
    const { bars, done, next } = await fetchChunk(id, start, now), added = await saveBars(env, id, bars);
    await setMeta(env, id, s.src, null, next && !done ? next : null); if (added) await dropSeriesCache(env, id);   // the cursor skips windows with no trading (before a fund listed)
    return { id, added, done: done || (!added && !next), to: bars.length ? iso(bars[bars.length - 1][0]) : last ? iso(last) : null };
  } catch (e) { await setMeta(env, id, s.src, String(e.message || e)); throw e; }
}
/* bars sent from your PC by scripts/backfill.mjs */
export async function importBars(env, id, bars, source) {
  if (!SERIES[id]) throw Object.assign(new Error('Unknown series ' + id), { status: 400 });
  if (!Array.isArray(bars) || bars.length > 6000) throw Object.assign(new Error('Send up to 6,000 [t, close] pairs'), { status: 400 });
  const added = await saveBars(env, id, bars.map(([t, c]) => [dayOf(+t), +c]));
  await setMeta(env, id, String(source || 'import').slice(0, 60), null); await dropSeriesCache(env, id);
  return { id, added };
}
export async function historyStatus(env) {
  const [rows, meta] = await Promise.all([
    env.DB.prepare('SELECT series, COUNT(*) AS n, MIN(t) AS a, MAX(t) AS b FROM bars GROUP BY series').all(),
    env.DB.prepare('SELECT series, source, error, updated_at FROM hist_meta').all(),
  ]);
  const R = Object.fromEntries((rows.results || []).map(r => [r.series, r])), M = Object.fromEntries((meta.results || []).map(r => [r.series, r]));
  return Object.entries(SERIES).map(([id, s]) => ({ id, name: s.name, note: s.note, ccy: s.ccy, wanted: s.from, rows: R[id]?.n || 0, from: R[id] ? iso(R[id].a) : null, to: R[id] ? iso(R[id].b) : null, source: M[id]?.source || s.src, error: M[id]?.error || null, updatedAt: M[id]?.updated_at || null }));
}
/* one series as compact arrays (day numbers + closes); the JSON is cached as-is so a read costs almost no CPU */
export async function seriesJson(env, id) {
  const s = SERIES[id]; if (!s) throw Object.assign(new Error('Unknown series ' + id), { status: 400 });
  const hit = await env.DB.prepare('SELECT value FROM cache WHERE key = ? AND expires > ?').bind('hist:' + id, Date.now()).first().catch(() => null);
  if (hit) return hit.value;
  const st = env.DB.prepare('SELECT t, c FROM bars WHERE series = ? ORDER BY t').bind(id);
  const rows = st.raw ? await st.raw() : (await st.all()).results.map(r => [r.t, r.c]);
  const d = new Array(rows.length), c = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) { d[i] = rows[i][0] / DAY; c[i] = +rows[i][1].toPrecision(7); }
  const json = JSON.stringify({ id, ...s, d, c });
  await env.DB.prepare('INSERT INTO cache (key, value, expires) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires = excluded.expires').bind('hist:' + id, json, Date.now() + 12 * 3600e3).run().catch(() => {});
  return json;
}
/* daily top-up: one call per series, errors recorded but never fatal */
export async function topUp(env, now = Date.now()) {
  const out = [];
  for (const id of Object.keys(SERIES)) { try { out.push(await fillOne(env, id, now)); } catch (e) { out.push({ id, error: String(e.message || e) }); } }
  return out;
}
