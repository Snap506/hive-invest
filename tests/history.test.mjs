import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeNet, env0, req, ctx } from './helpers.mjs';
import worker from '../src/worker.js';
import * as P from '../public/js/patterns.js';
import * as E from '../public/js/engine.js';

const realFetch = globalThis.fetch; let net;
const use = o => { net = fakeNet(o); globalThis.fetch = net.handler; return net; };
const call = async (env, path, o) => { const c = ctx(), r = await worker.fetch(req(path, o), env, c); await c.done(); return { status: r.status, body: await r.json() }; };
test.after(() => { globalThis.fetch = realFetch; });

async function fillAll(env) {
  const st = (await call(env, '/api/history/status')).body.series; let calls = 0;
  for (const s of st) for (let i = 0; i < 40; i++) { const r = await call(env, '/api/history/fill?series=' + s.id, { method: 'POST' }); calls++; assert.equal(r.status, 200, JSON.stringify(r.body)); if (r.body.done) break; }
  return calls;
}
test('fills every series in small pages, then stays put', async () => {
  use(); const env = env0(), calls = await fillAll(env);
  const st = (await call(env, '/api/history/status')).body.series, by = Object.fromEntries(st.map(s => [s.id, s]));
  assert.ok(by.btc.rows > 4000, 'btc ' + by.btc.rows); assert.equal(by.btc.from, '2014-01-01');
  assert.ok(by.sa.rows > 2500 && by.usdzar.rows > 2500 && by.global.rows > 2500);
  assert.ok(calls < 40, 'calls ' + calls);
  const again = (await call(env, '/api/history/fill?series=btc', { method: 'POST' })).body; assert.equal(again.added, 0); assert.equal(again.done, true);
  const S = {}; for (const id of ['btc', 'sa']) S[id] = (await call(env, '/api/history/series?id=' + id)).body;
  assert.ok(S.sa.c.at(-1) < 1000, 'JSE cents converted to rand: ' + S.sa.c.at(-1));
  assert.equal(S.btc.d.length, by.btc.rows); assert.ok(Number.isInteger(S.btc.d[0]));
  assert.ok(S.btc.d.at(-1) < Math.floor(Date.now() / 864e5), "never stores today's unfinished day");
});
test('a blocked provider is recorded, not fatal; the PC import fills it', async () => {
  use({ down: new Set(['yahoo-block']) }); const env = env0();
  assert.equal((await call(env, '/api/history/fill?series=sa', { method: 'POST' })).status, 429);
  const st = (await call(env, '/api/history/status')).body.series.find(s => s.id === 'sa'); assert.match(st.error, /429|Too Many/);
  const day = Math.floor(Date.now() / 864e5) * 86400, bars = Array.from({ length: 300 }, (_, i) => [day - (300 - i) * 86400, 40 + i / 10]);
  const imp = await call(env, '/api/history/import', { method: 'POST', body: { series: 'sa', bars, source: 'Yahoo (from PC)' } });
  assert.equal(imp.body.added, 300);
  const st2 = (await call(env, '/api/history/status')).body.series.find(s => s.id === 'sa'); assert.equal(st2.error, null); assert.equal(st2.rows, 300);
  assert.equal((await call(env, '/api/history/import', { method: 'POST', body: { series: 'nope', bars } })).status, 400);
  assert.equal((await call(env, '/api/history/status', { token: '' })).status, 401);
});
test('the daily schedule tops history up', async () => {
  use(); const env = env0(), c = ctx(); await worker.scheduled({}, env, c); await c.done();
  const st = (await call(env, '/api/history/status')).body.series; assert.ok(st.every(s => s.rows > 0), JSON.stringify(st.map(s => [s.id, s.rows, s.error])));
});
test('patterns: rand conversion, growth, falls, rolling ranges, correlations', () => {
  const d = Array.from({ length: 3653 }, (_, i) => 16071 + i);           // 10 years of days from 2014
  const v = d.map((_, i) => 100 * Math.pow(2, i / 3652.5));                // doubles in 10 years
  v.forEach((_, i) => { if (i > 1000 && i < 1100) v[i] *= .5; });         // a 50% crash in the middle
  const S = { btc: { name: 'B', ccy: 'USD', d, c: v }, usdzar: { ccy: 'ZAR', d, c: d.map(() => 10) }, sa: { ccy: 'ZAR', name: 'S', d, c: v.map(x => x * 2) } };
  const Z = P.toZar(S); assert.equal(Z.btc.v[0], 1000);
  const s = P.stats(Z.btc); assert.ok(Math.abs(s.cagr - (Math.SQRT2 ** (1 / 5) - 1)) < .002, s.cagr);
  assert.ok(Math.abs(s.maxDD - .5) < .01); assert.ok(s.roll1.min < -.3); assert.ok(s.roll5.n > 50);
  assert.equal(s.months.length, 12); assert.ok(s.cal.length >= 9);
  const C = P.correlations(Z); assert.ok(C.m[C.ids.indexOf('sa')][C.ids.indexOf('btc')] > .99);
});
test('patterns: money-weighted return matches a known case', () => {
  const r = P.irrMonthly(Array(12).fill(1000), 12000 * Math.pow(1.01, 6.5)); assert.ok(r > .1 && r < .14, r);
  assert.equal(P.irrMonthly([], 1), null);
});
test('replay: flat prices, no costs → worth equals what was paid in', () => {
  const d = Array.from({ length: 1500 }, (_, i) => 18000 + i), flat = d.map(() => 100);
  const S = {}; for (const id of ['global', 'sa', 'bonds', 'btc', 'eth']) S[id] = { ccy: 'ZAR', d, c: flat };
  S.btc.ccy = 'ZAR'; const Z = P.toZar({ ...S, usdzar: { ccy: 'ZAR', d, c: d.map(() => 1) } });
  const r = P.replay({ S, Z, cashYield: 0, fundFee: 0, cryptoCost: 0 });
  assert.equal(r.ok, true); assert.ok(Math.abs(r.value - r.paid) < 1e-6 * r.paid, r.value + ' vs ' + r.paid);
});
test('replay on the fake history runs and stays sane', async () => {
  use(); const env = env0(); await fillAll(env);
  const S = {}; for (const id of ['btc', 'eth', 'global', 'sa', 'bonds', 'usdzar']) S[id] = (await call(env, '/api/history/series?id=' + id)).body;
  const Z = P.toZar(S), t = performance.now();
  const r = P.replay({ S, Z }), ms = performance.now() - t;
  assert.equal(r.ok, true); assert.ok(r.value > r.paid * .5 && r.value < r.paid * 10); assert.ok(r.trades > 0); assert.ok(ms < 300, ms + ' ms');
  for (const id of Object.keys(Z)) assert.equal(P.stats(Z[id]).ok, true, id);
});
test('a fund that listed years after the start date is walked through, not looped on', async () => {
  const n = use(), base = n.handler; let calls = 0;
  globalThis.fetch = async (u, i) => { const url = String(u); if (url.includes('STXGOV')) { calls++; const p1 = +new URL(url).searchParams.get('period1'); if (p1 < Date.parse('2018-06-01') / 1000) return new Response(JSON.stringify({ chart: { result: [{ meta: { currency: 'ZAc' }, timestamp: [], indicators: { quote: [{ close: [] }] } }], error: null } }), { status: 200 }); } return base(u, i); };
  const env = env0(); let r;
  for (let i = 0; i < 30; i++) { r = (await call(env, '/api/history/fill?series=bonds', { method: 'POST' })).body; if (r.done) break; }
  assert.equal(r.done, true); assert.ok(calls < 20, 'calls ' + calls);
  const st = (await call(env, '/api/history/status')).body.series.find(s => s.id === 'bonds');
  assert.ok(st.rows > 1000 && st.from >= '2018-06-01', JSON.stringify(st));
});
