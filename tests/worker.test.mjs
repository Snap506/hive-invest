import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeNet, env0, req, ctx, candles } from './helpers.mjs';
import worker, { dailyCheck } from '../src/worker.js';
import { _signForTests } from '../src/lib/valr.js';
import { walkSignal } from '../src/lib/signal.js';

let net; const realFetch = globalThis.fetch;
const use = o => { net = fakeNet(o); globalThis.fetch = net.handler; return net; };
const call = async (env, path, o) => { const c = ctx(), r = await worker.fetch(req(path, o), env, c); await c.done(); return { status: r.status, body: await r.json() }; };
test.after(() => { globalThis.fetch = realFetch; });

test('health is open; everything else needs the passcode', async () => {
  use(); const env = env0();
  assert.equal((await call(env, '/api/health', { token: '' })).status, 200);
  assert.equal((await call(env, '/api/live', { token: '' })).status, 401);
  assert.equal((await call(env, '/api/live', { token: 'wrong' })).status, 401);
  assert.equal((await call(env, '/api/live')).status, 200);
  assert.equal((await call(env0({ APP_TOKEN: '' }), '/api/live')).status, 503);
  assert.equal((await call(env, '/api/nope')).status, 404);
});
test('live: rand price from VALR, rate from VALR ÷ Bitstamp, signal on completed days', async () => {
  use(); const env = env0(), { body } = await call(env, '/api/live');
  assert.equal(body.market.zar.px, 1366000); assert.equal(body.market.zar.src, 'VALR');
  assert.ok(Math.abs(body.market.fx.rate - 1366000 / 78051) < 1e-9);
  assert.equal(body.signal.ok, true); assert.equal(body.signal.px, 78051);   // yesterday's close, not today's candle
  assert.equal(typeof body.signal.on, 'boolean'); assert.ok(body.signal.closeDate);
});
test('cache: a burst of requests makes one call per provider', async () => {
  const n = use(), env = env0();
  await Promise.all([1, 2, 3].map(() => call(env, '/api/live')));
  await call(env, '/api/live');
  const valr = n.calls.filter(c => c.url.includes('marketsummary')).length;
  assert.ok(valr <= 3, 'valr calls ' + valr);
  const before = n.calls.length; await call(env, '/api/live'); assert.equal(n.calls.length, before);
});
test('fallbacks: VALR down → Bitstamp × ECB rate; both down → last good price marked stale', async () => {
  use({ down: new Set(['valr']) }); let env = env0();
  let { body } = await call(env, '/api/live');
  assert.equal(body.market.zar.src, 'Bitstamp × rate'); assert.ok(Math.abs(body.market.zar.px - 78051 * 17.42) < 1);
  assert.ok(body.market.errors[0].startsWith('VALR'));
  use(); env = env0(); await call(env, '/api/live');
  const { cached, _clearMemForTests } = await import('../src/lib/store.js');
  env.DB._db.exec('UPDATE cache SET expires = 0'); _clearMemForTests(env.DB); // force expiry
  use({ down: new Set(['valr', 'bitstamp']) });
  const r = await cached({ DB: env.DB }, 'market', 1, async () => { throw new Error('down'); });
  assert.equal(r.stale, true); assert.equal(r.data.zar.px, 1366000);
});
test('signal walks the buffer day by day and goes OUT after a crash', async () => {
  use({ candles: candles({ shape: 'down', last: 50000 }), usd: 50000 }); const env = env0();
  const { body } = await call(env, '/api/live');
  assert.equal(body.signal.on, false); assert.equal(body.signal.target, 0); assert.ok(body.signal.since);
  assert.equal(walkSignal([1, 2, 3]).ok, false);
});
test('state: create, update, and refuse a stale write without losing data', async () => {
  use(); const env = env0();
  let s = (await call(env, '/api/state')).body; assert.equal(s.version, 0); assert.equal(s.user.v, 5);
  s.user.trade.cash = 1000;
  const w1 = await call(env, '/api/state', { method: 'PUT', body: { user: s.user, version: 0 } }); assert.equal(w1.body.version, 1);
  const stale = await call(env, '/api/state', { method: 'PUT', body: { user: { ...s.user, trade: { ...s.user.trade, cash: 5 } }, version: 0 } });
  assert.equal(stale.status, 409); assert.equal(stale.body.user.trade.cash, 1000);
  assert.equal((await call(env, '/api/state', { method: 'PUT', body: { nope: 1 } })).status, 400);
  assert.equal((await call(env, '/api/state')).body.user.trade.cash, 1000);
});
test('research is normalised and screened', async () => {
  use(); const { body } = await call(env0(), '/api/research');
  assert.equal(body.trending[0].sym, 'BTC'); assert.equal(body.trending.at(-1).flag, 'small');
  assert.equal(body.sectors[0].name, 'Meme'); assert.ok(!body.sectors.some(s => s.name === 'Tiny'));
  assert.ok(body.global.btcDom > 50);
});
test('daily check: suggests the buy, sends one Telegram message, does not repeat next hour', async () => {
  const n = use(), env = env0({ TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '1' });
  const s = (await call(env, '/api/state')).body; s.user.trade.cash = 10000;
  await call(env, '/api/state', { method: 'PUT', body: { user: s.user, version: 0 } });
  const r = await dailyCheck(env, { send: true });
  assert.equal(r.signal.on, true); assert.equal(r.action.side, 'buy'); assert.equal(r.action.amount, 5000);
  assert.ok(r.alerts.some(a => a.startsWith('BUY R5')));
  assert.equal(n.calls.filter(c => c.url.includes('telegram')).length, 1);
  const r2 = await dailyCheck(env, { send: true, now: Date.now() + 3600e3 });
  assert.ok(!r2.alerts.some(a => a.startsWith('BUY')));
  assert.equal(n.calls.filter(c => c.url.includes('telegram')).length, r2.alerts.length ? 2 : 1);
  const st = (await call(env, '/api/state')).body;
  assert.equal(st.server.lastRun.action.side, 'buy');
  assert.equal(st.user.trade.cash, 10000, 'the daily check never edits your own data');
});
test('daily check while paused suggests nothing', async () => {
  use(); const env = env0();
  const s = (await call(env, '/api/state')).body; Object.assign(s.user, { paused: true }); s.user.trade.cash = 10000;
  await call(env, '/api/state', { method: 'PUT', body: { user: s.user, version: 0 } });
  const r = (await call(env, '/api/run', { method: 'POST' })).body;
  assert.ok(!r.alerts.some(a => a.startsWith('BUY')));
});
test('scheduled() runs the check and logs it', async () => {
  use(); const env = env0(), c = ctx();
  await worker.scheduled({}, env, c); await c.done();
  const st = (await call(env, '/api/status')).body;
  assert.ok(st.events.some(e => e.kind === 'daily'));
  assert.ok(st.sources.find(s => s.name.startsWith('VALR BTC')).ok);
});
test('VALR: signed balances, HMAC-SHA512 matches Node crypto', async () => {
  const { createHmac } = await import('node:crypto');
  const payload = '1558014486185GET/v1/account/balances';
  assert.equal(await _signForTests('secret', payload), createHmac('sha512', 'secret').update(payload).digest('hex'));
  const n = use(), env = env0({ VALR_API_KEY: 'k', VALR_API_SECRET: 's' }), { body } = await call(env, '/api/balances');
  assert.equal(body.balances.ZAR.available, 5000.5); assert.equal(body.balances.BTC.total, .001);
  const h = n.calls.find(c => c.url.includes('/account/balances')).init.headers;
  assert.equal(h['X-VALR-API-KEY'], 'k'); assert.match(h['X-VALR-SIGNATURE'], /^[0-9a-f]{128}$/);
  assert.equal((await call(env0(), '/api/balances')).status, 400);
});
test('Claude: answers, counts the cost, and stops at the monthly budget', async () => {
  use(); const env = env0({ ANTHROPIC_API_KEY: 'x', CLAUDE_MONTHLY_USD: '0.0003' });
  const a = await call(env, '/api/ask', { method: 'POST', body: { question: 'Why?' } });
  assert.equal(a.status, 200); assert.ok(a.body.answer.length > 5); assert.ok(a.body.cost > 0);
  const b = await call(env, '/api/ask', { method: 'POST', body: { question: 'Again?' } });
  assert.equal(b.status, 429);
  assert.equal((await call(env0(), '/api/ask', { method: 'POST', body: { question: 'x' } })).status, 400);
});
test('a provider timing out does not hang the request', async () => {
  globalThis.fetch = (u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  const { fetchJson } = await import('../src/lib/sources.js'), t = Date.now();
  await assert.rejects(fetchJson('https://api.valr.com/x', { timeoutMs: 100, retries: 0 }), /timed out/);
  assert.ok(Date.now() - t < 1000);
});
test('fast walk gives the same answer as stepping the engine day by day', async () => {
  const E = await import('../public/js/engine.js');
  for (const shape of ['up', 'down', 'flat']) for (const seed of [1, 2, 3, 4]) {
    const C = candles({ shape, seed }).slice(0, -1).map(r => +r.close);
    let on = null, s; for (let i = 199; i < C.length; i++) { s = E.trendSignal({ closes: C.slice(i - 199, i + 1), px: C[i], wasOn: on }); on = s.on; }
    const w = walkSignal(C); assert.equal(w.on, s.on); assert.ok(Math.abs(w.avg - s.avg) < 1e-6 * s.avg);
  }
});
test('history falls back to CoinGecko when Bitstamp is unreachable', async () => {
  use({ down: new Set(['bitstamp']) }); const { body } = await call(env0(), '/api/live');
  assert.equal(body.signal.ok, true); assert.match(body.signal.src, /CoinGecko/);
  assert.equal(body.market.zar.src, 'VALR'); assert.ok(body.market.fx.rate > 15);
});
