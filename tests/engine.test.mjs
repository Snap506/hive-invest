import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../public/js/engine.js';

test('monthly split adds up exactly and favours the furthest-behind bucket', () => {
  const T = E.PRESETS.balanced.targets, r = E.splitMonth({ targets: T, cur: { global: 0, sa: 0, bonds: 0, crypto: 0, trade: 0 }, amount: 6080 });
  assert.equal(Object.values(r.add).reduce((a, b) => a + b, 0), 6080);
  const r2 = E.splitMonth({ targets: T, cur: { global: 0, sa: 5000, bonds: 5000, crypto: 0, trade: 0 }, amount: 6080 });
  assert.ok(r2.add.global > r2.add.sa);
  for (const v of Object.values(r2.add)) assert.equal(v % 10, 0);
});
test('monthly budget: R3,000, +R3,000 a month each year; old daily plans convert', () => {
  const p = { monthly: 3000, step: 3000 };
  assert.deepEqual([0, 1, 2, 9].map(y => E.monthlyIn(p, y)), [3000, 6000, 9000, 30000]);
  assert.equal(E.monthlyIn({ ...p, rises: 3 }, 9), 9000);
  assert.equal(E.monthlyIn({ start: 200, step: 100, rises: 5 }, 0), 6080);
  assert.equal(E.monthlyIn({ start: 200, step: 100, rises: 5 }, 9), 18240);
  assert.equal(E.planYear('2025-11-01', Date.parse('2026-11-04')), 1);
});
test('smallest purchase: no buy under R500, nothing lost, and every bucket stays near target', () => {
  const T = E.PRESETS.balanced.targets, cur = { global: 0, sa: 0, bonds: 0, crypto: 0, trade: 0 };
  for (let m = 0; m < 24; m++) {
    const { add } = E.splitMonth({ targets: T, cur, amount: 3000, minBuy: 500 });
    assert.equal(Object.values(add).reduce((a, b) => a + b, 0), 3000);
    for (const v of Object.values(add)) assert.ok(v === 0 || v >= 500, 'buy of ' + v);
    for (const k in add) cur[k] += add[k];
  }
  const tot = Object.values(cur).reduce((a, b) => a + b, 0);
  for (const k in T) assert.ok(Math.abs(cur[k] / tot - T[k]) < .03, k + ' ' + (cur[k] / tot).toFixed(3));
  assert.ok(cur.crypto > 0 && cur.trade > 0, 'small buckets still get money');
  const tiny = E.splitMonth({ targets: T, cur: { global: 0, sa: 0, bonds: 0, crypto: 0, trade: 0 }, amount: 400, minBuy: 500 }).add;
  assert.equal(Object.values(tiny).filter(v => v > 0).length, 1); assert.equal(tiny.global, 400);
});
test('tax-free account: tax year starts 1 March; room never above R46,000 a year or R500,000 for life', () => {
  assert.equal(E.taxYear(Date.parse('2027-02-27T12:00:00Z')), 2026); assert.equal(E.taxYear(Date.parse('2027-03-01T08:00:00Z')), 2027);
  const now = Date.parse('2026-11-04T10:00:00Z');
  assert.equal(E.tfsaRoom({ year: 2026, used: 40000, life: 40000 }, now).room, 6000);
  assert.equal(E.tfsaRoom({ year: 2025, used: 46000, life: 100000 }, now).room, 46000);  // a new tax year resets the yearly room
  assert.equal(E.tfsaRoom({ year: 2026, used: 0, life: 490000 }, now).room, 10000);
});
test('rebalance waits for the minimum and ignores the trading account', () => {
  const T = E.PRESETS.balanced.targets;
  assert.equal(E.rebalance({ targets: T, cur: { global: 1000, sa: 0, bonds: 0, crypto: 0, trade: 0 }, exclude: ['trade'], minTotal: 20000 }).due, false);
  const r = E.rebalance({ targets: T, cur: { global: 30000, sa: 0, bonds: 0, crypto: 0, trade: 99999 }, exclude: ['trade'], minTotal: 20000 });
  assert.equal(r.due, true); assert.ok(!r.rows.some(x => x.id === 'trade'));
  assert.equal(r.rows.reduce((a, x) => a + x.move, 0), 0);
});
test('trend signal: buffer stops flip-flopping', () => {
  const C = Array(200).fill(100);
  assert.equal(E.trendSignal({ closes: C, px: 101, wasOn: false }).on, false);  // +1%: inside the buffer, stays out
  assert.equal(E.trendSignal({ closes: C, px: 103, wasOn: false }).on, true);   // +3%: in
  assert.equal(E.trendSignal({ closes: C, px: 99, wasOn: true }).on, true);     // −1%: stays in
  assert.equal(E.trendSignal({ closes: C, px: 97, wasOn: true }).on, false);    // −3%: out
  assert.equal(E.trendSignal({ closes: C.slice(0, 50) }).ok, false);
});
test('trend action: buy half, trim above 70%, sell all when out', () => {
  const buy = E.trendAction({ target: .5, cash: 10000, units: 0, pxZar: 1e6 });
  assert.equal(buy.side, 'buy'); assert.equal(buy.amount, 5000); assert.ok(Math.abs(buy.limit - 1.003e6) < 1);
  assert.equal(E.trendAction({ target: .5, cash: 5000, units: .005, pxZar: 1e6 }).side, 'none');
  const trim = E.trendAction({ target: .5, cash: 2000, units: .008, pxZar: 1e6 });
  assert.equal(trim.side, 'sell'); assert.ok(trim.units < .008 && trim.units > 0);
  const out = E.trendAction({ target: 0, cash: 0, units: .01, pxZar: 1e6 });
  assert.equal(out.side, 'sell'); assert.equal(out.units, .01);
  assert.equal(E.trendAction({ target: .5, cash: 0, units: 0, pxZar: 1e6 }).side, 'none');
  assert.equal(E.trendAction({ target: .5, cash: 1000, units: 0, pxZar: null }).side, 'none');
});
test("completed closes drop today's unfinished candle", () => {
  const now = Date.parse('2026-11-04T09:00:00Z'), t0 = Date.parse('2026-11-04T00:00:00Z') / 1000;
  const r = E.completedCloses([{ t: t0 - 86400, c: 1 }, { t: t0, c: 2 }], now);
  assert.equal(r.length, 1); assert.equal(r[0].c, 1);
});
test('research screens flag tiny and pumping coins and sort them last', () => {
  const r = E.screenTrending([{ id: 'a', symbol: 'a', rank: 900, ch24: 3 }, { id: 'b', symbol: 'b', rank: 5, ch24: 80 }, { id: 'c', symbol: 'c', rank: 10, ch24: 2 }]);
  assert.equal(r[0].id, 'c'); assert.equal(r.find(x => x.id === 'a').flag, 'small'); assert.equal(r.find(x => x.id === 'b').flag, 'pump');
});
test('replay conserves money with no costs on a flat market', () => {
  const { eq } = E.trendReplay({ closes: Array(400).fill(100), cashYield: 0, fee: 0, spread: 0 });
  assert.ok(Math.abs(eq.at(-1) - 10000) < 1e-6);
});
test('projection: paid-in matches the budget, ordered outcomes, same answer every time', async () => {
  const { project } = await import('../public/js/projection.js');
  const plan = { monthly: 3000, step: 3000 }, a = project({ plan, years: 5, paths: 500 }), b = project({ plan, years: 5, paths: 500 });
  assert.equal(a.rows[0].paid, 36000); assert.equal(a.rows[4].paid, 540000);
  for (const r of a.rows) assert.ok(r.p10 < r.p50 && r.p50 < r.p90);
  assert.equal(a.rows[4].p50, b.rows[4].p50);
  assert.ok(a.rows[4].irr > .05 && a.rows[4].irr < .2, a.rows[4].irr);
});
