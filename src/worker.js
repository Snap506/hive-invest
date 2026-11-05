/* Hive Invest — Cloudflare Worker.
   Serves the app (public/), answers /api/*, and runs the daily check on a schedule (wrangler.toml → crons). */
import * as E from '../public/js/engine.js';
import { checkAuth } from './lib/auth.js';
import { getDoc, putDoc, updateDoc, logEvent, recentEvents } from './lib/store.js';
import { market, signal, chart, research } from './lib/signal.js';
import { valrBalances } from './lib/valr.js';
import { telegram, askClaude } from './lib/notify.js';
import { historyStatus, fillOne, importBars, seriesJson, topUp } from './lib/history.js';
import { valrSummary, bitstampTicker, bitstampDaily, frankfurterUsdZar, cgGlobal } from './lib/sources.js';

const J = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra } });
const fail = (e, status) => J({ error: String(e?.message || e) }, status || e?.status || 500);
const zar = v => 'R' + String(Math.round(v || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const SAST = ms => new Date(ms + 2 * 3600_000); // South Africa has no daylight saving

export const DEFAULT_USER = () => ({
  v: 5, preset: 'balanced', paused: false,
  plan: { monthly: 3000, step: 3000, rises: 50, minBuy: 500, began: new Date().toISOString().slice(0, 10) },
  settings: { fee: 0.15, tradeFromValr: false },
  main: { cur: { global: 0, sa: 0, bonds: 0, crypto: 0 }, months: {}, rebalancedAt: null },
  trade: { cash: 0, units: 0, log: [], peak: 0 },
  tfsa: { year: E.taxYear(), used: 0, life: 0 },
});

/* the trading account as the server sees it: from VALR (if you allowed it) or from what you logged in the app */
async function tradeAccount(env, user) {
  if (user?.settings?.tradeFromValr && env.VALR_API_KEY) {
    try { const b = await valrBalances(env); return { cash: b.ZAR?.available || 0, units: b.BTC?.total || 0, src: 'VALR' }; } catch (e) { /* fall through */ }
  }
  return { cash: user?.trade?.cash || 0, units: user?.trade?.units || 0, src: 'app' };
}

/* ---------- the daily check (also runnable from the app: POST /api/run) ---------- */
export async function dailyCheck(env, { send = true, now = Date.now() } = {}) {
  const [u, sv] = await Promise.all([getDoc(env, 'user'), getDoc(env, 'server')]);
  const D = DEFAULT_USER(), uv = u.value || {}, user = { ...D, ...uv, plan: { ...D.plan, ...uv.plan }, settings: { ...D.settings, ...uv.settings }, main: { ...D.main, ...uv.main }, trade: { ...D.trade, ...uv.trade } }, prev = sv.value || {};
  const [sig, mk] = await Promise.all([signal(env), market(env)]);
  const m = mk.data, pxZar = m.zar?.px, fx = m.fx?.rate;
  const acct = await tradeAccount(env, user);
  const act = sig.ok ? E.trendAction({ target: sig.target, cash: acct.cash, units: acct.units, pxZar, fee: (user.settings?.fee ?? .15) / 100 }) : { side: 'none', why: sig.why };

  const d = SAST(now), monthKey = d.toISOString().slice(0, 7), dayKey = d.toISOString().slice(0, 10);
  const targets = E.PRESETS[user.preset]?.targets || E.PRESETS.balanced.targets;
  const year = E.planYear(user.plan.began, now), monthly = E.monthlyIn(user.plan, year);
  const cur = { ...user.main.cur, trade: acct.cash + acct.units * (pxZar || 0) };
  const rec = user.main.months?.[monthKey], split = rec?.add ? { add: rec.add } : E.splitMonth({ targets, cur, amount: monthly, minBuy: E.normPlan(user.plan).minBuy });
  const paid = rec?.paid || Object.fromEntries(Object.entries(rec?.done || {}).filter(([, v]) => v).map(([k]) => [k, rec.add[k]]));
  const left = Object.entries(split.add).map(([k, v]) => [k, v - (paid[k] || 0)]).filter(([, v]) => v > 0), monthOpen = left.length > 0;
  const reb = E.rebalance({ targets, cur, exclude: ['trade'], minTotal: E.REBALANCE_MIN_TOTAL });

  const alerts = [], sent = { ...(prev.sent || {}) };
  const once = (key, everyDays, text) => { const last = sent[key]; if (!last || now - last >= everyDays * 864e5 - 3600_000) { alerts.push(text); sent[key] = now; } };
  if (sig.ok && prev.signal && prev.signal.on !== sig.on) once('flip:' + sig.closeDate, 99, sig.on ? `Bitcoin closed above its 200-day average + 2% (${zar(sig.px * fx)}). The rule is back IN.` : `Bitcoin closed below its 200-day average − 2% (${zar(sig.px * fx)}). The rule is OUT.`);
  if (!user.paused && act.side !== 'none') once(`act:${act.side}:${sig.on}`, 2, `${act.side === 'buy' ? 'BUY' : 'SELL'} ${zar(act.amount)} of Bitcoin, limit ${zar(act.limit)}. ${act.why}. Open the app for the ticket.`);
  if (user.paused && act.side !== 'none') once('paused', 7, 'The app is paused, so no trade is suggested — but the rule would ' + act.side + ' now.');
  if (monthOpen && d.getUTCDate() <= 5) once('month:' + monthKey, 2, `New month: invest ${zar(left.reduce((a, [, v]) => a + v, 0))} — ${left.map(([k, v]) => `${E.BUCKETS.find(b => b.id === k)?.name} ${zar(v)}`).join(', ')}.`);
  if (reb.due) once('rebalance', 7, 'The main account has drifted more than 5 points from its plan. Open the app to rebalance.');

  let notified = { sent: false };
  if (send && alerts.length) { try { notified = await telegram(env, '🐝 Hive · ' + dayKey + '\n\n' + alerts.join('\n\n')); } catch (e) { notified = { sent: false, why: String(e.message || e) }; } }
  const report = { at: now, day: dayKey, signal: sig, price: { zar: pxZar, fx, src: m.zar?.src, errors: m.errors }, account: acct, action: act, month: { key: monthKey, monthly, open: monthOpen }, rebalanceDue: reb.due, alerts, notified };
  if (send) {
    await updateDoc(env, 'server', s => ({ ...s, signal: sig.ok ? { on: sig.on, closeDate: sig.closeDate, avg: sig.avg, px: sig.px, target: sig.target } : s.signal, sent: notified.sent || !alerts.length ? sent : prev.sent || {}, lastRun: report }));
    await logEvent(env, 'daily', { day: dayKey, on: sig.on, gap: sig.gap, side: act.side, amount: act.amount, alerts: alerts.length, notified: notified.sent });
  }
  return report;
}

/* ---------- live-connection test: every source, one by one ---------- */
async function checkSources(env) {
  const t = async (name, p, show) => { const a = Date.now(); try { const v = await p; return { name, ok: true, ms: Date.now() - a, info: show(v) }; } catch (e) { return { name, ok: false, ms: Date.now() - a, info: String(e.message || e) }; } };
  const list = await Promise.all([
    t('VALR BTC/ZAR price', valrSummary('BTCZAR'), v => zar(v.px)),
    t('Bitstamp BTC/USD price', bitstampTicker('btcusd'), v => '$' + Math.round(v.px).toLocaleString('en-US')),
    t('Bitstamp daily history', bitstampDaily('btcusd', 600).then(v => E.completedCloses(v)), v => `${v.length} complete days, last ${new Date(v[v.length - 1].t * 1000).toISOString().slice(0, 10)}`),
    t('Rand per dollar (ECB)', frankfurterUsdZar(), v => `R${v.rate.toFixed(3)} on ${v.date}`),
    t('CoinGecko research', cgGlobal(env), v => `market $${(v.mcapUsd / 1e12).toFixed(2)}tn`),
    env.VALR_API_KEY ? t('VALR account (read-only)', valrBalances(env), v => Object.keys(v).length + ' balances') : { name: 'VALR account (read-only)', ok: null, info: 'not set up — optional' },
    { name: 'Telegram alerts', ok: env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID ? true : null, info: env.TELEGRAM_BOT_TOKEN ? 'set — use “Send test message”' : 'not set up — optional' },
    { name: 'Claude', ok: env.ANTHROPIC_API_KEY ? true : null, info: env.ANTHROPIC_API_KEY ? `set — budget $${env.CLAUDE_MONTHLY_USD || 2} a month` : 'not set up — optional' },
  ]);
  return list;
}

const ROUTES = {
  'GET /api/health': async (req, env) => J({ ok: true, app: 'hive-invest', engine: E.VERSION, time: Date.now(), signedIn: !(await checkAuth(req, env)), passcodeSet: !!env.APP_TOKEN }),
  'GET /api/live': async (req, env) => {
    const [mk, sg] = await Promise.all([market(env), signal(env).catch(e => ({ ok: false, why: String(e.message || e) }))]);
    return J({ market: mk.data, marketAt: mk.at, marketStale: !!mk.stale, signal: sg, now: Date.now() });
  },
  'GET /api/chart': async (req, env) => J(await chart(env, Math.min(1500, parseInt(new URL(req.url).searchParams.get('days') || '730', 10) || 730))),
  'GET /api/research': async (req, env) => { const r = await research(env); return J({ ...r.data, at: r.at, stale: !!r.stale }); },
  'GET /api/state': async (req, env) => {
    const [u, s] = await Promise.all([getDoc(env, 'user'), getDoc(env, 'server')]);
    return J({ user: u.value || DEFAULT_USER(), version: u.version, server: s.value || {} });
  },
  'PUT /api/state': async (req, env) => {
    const b = await req.json().catch(() => null);
    if (!b || typeof b.user !== 'object' || !Number.isInteger(b.version)) return J({ error: 'Send {user, version}' }, 400);
    if (b.user.v !== 5) return J({ error: 'Unknown state version' }, 400);
    try { return J({ version: await putDoc(env, 'user', b.user, b.version) }); }
    catch (e) { if (e.status === 409) { const u = await getDoc(env, 'user'); return J({ error: 'Changed on another device', user: u.value, version: u.version }, 409); } throw e; }
  },
  'GET /api/balances': async (req, env) => J({ balances: await valrBalances(env), at: Date.now() }),
  'POST /api/ask': async (req, env) => {
    const b = await req.json().catch(() => ({})), q = String(b.question || '').slice(0, 400).trim();
    if (!q) return J({ error: 'Ask a question' }, 400);
    const [sg, mk, sv] = await Promise.all([signal(env).catch(() => null), market(env).catch(() => null), getDoc(env, 'server')]);
    const ctx = sg?.ok ? `Bitcoin daily close $${Math.round(sg.px)}, 200-day average $${Math.round(sg.avg)} (${(sg.gap * 100).toFixed(1)}%), rule is ${sg.on ? 'IN (holding half the trading account in BTC)' : 'OUT (cash)'}. Live price ${zar(mk?.data?.zar?.px)}.` : '';
    const usage = sv.value?.claude || {};
    const r = await askClaude(env, usage, `You help a careful long-term investor in South Africa. They follow a fixed, tested rule and never trade on tips. ${ctx}\nAnswer in under 120 words, plainly, no hype, no instructions to trade outside the rule. Question: ${q}`);
    await updateDoc(env, 'server', s => ({ ...s, claude: r.usage }));
    return J({ answer: r.text, cost: r.cost, usage: r.usage, budget: parseFloat(env.CLAUDE_MONTHLY_USD || '2') });
  },
  'POST /api/run': async (req, env) => J(await dailyCheck(env, { send: new URL(req.url).searchParams.get('send') === '1' })),
  'POST /api/notify/test': async (req, env) => { const r = await telegram(env, '🐝 Hive test message — alerts are working.'); return J(r, r.sent ? 200 : 400); },
  'GET /api/history/status': async (req, env) => J({ series: await historyStatus(env) }),
  'POST /api/history/fill': async (req, env) => J(await fillOne(env, new URL(req.url).searchParams.get('series'))),
  'POST /api/history/import': async (req, env) => { const b = await req.json().catch(() => ({})); return J(await importBars(env, b.series, b.bars, b.source)); },
  'GET /api/history/series': async (req, env) => new Response(await seriesJson(env, new URL(req.url).searchParams.get('id')), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, max-age=300' } }),
  'GET /api/status': async (req, env) => J({ sources: await checkSources(env), events: await recentEvents(env, 20).catch(() => []), dbOk: true }),
};

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS ? env.ASSETS.fetch(req) : new Response('Not found', { status: 404 });
    const key = `${req.method} ${url.pathname}`, h = ROUTES[key];
    if (!h) return J({ error: 'No such endpoint' }, 404);
    if (key !== 'GET /api/health') { const a = await checkAuth(req, env); if (a) return J({ error: a.error }, a.status); }
    try { return await h(req, env, ctx); }
    catch (e) { if (!e.status || e.status >= 500) ctx.waitUntil(logEvent(env, 'error', { at: key, error: String(e.message || e) })); return fail(e); }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      await dailyCheck(env, { send: true }).catch(e => logEvent(env, 'error', { at: 'cron', error: String(e.message || e) }));
      const h = await topUp(env).catch(e => [{ error: String(e.message || e) }]);
      await logEvent(env, 'history', h.map(x => x.error ? `${x.id}: ${x.error}` : `${x.id} +${x.added}`).join(', '));
    })());
  },
};
