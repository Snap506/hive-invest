/* Pattern analysis on real price history — pure functions, run in your browser (no server CPU, no Claude tokens).
   Everything is measured in rand, because that is what you invest and spend. */
import * as E from './engine.js';
const DAY = 86400;
const isoDay = d => new Date(d * DAY * 1000).toISOString().slice(0, 10);
const median = a => { const s = [...a].sort((x, y) => x - y), n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN; };
export const ITEMS = ['global', 'sa', 'bonds', 'btc', 'eth', 'usdzar'];

/* USD series × rand-per-dollar on the same day (last known rate carried forward) */
export function toZar(S) {
  const fx = S.usdzar, fxAt = new Map(); if (fx) fx.d.forEach((d, i) => fxAt.set(d, fx.c[i]));
  const out = {};
  for (const id of ITEMS) {
    const s = S[id]; if (!s?.d?.length) continue;
    if (s.ccy !== 'USD') { out[id] = { id, name: s.name, note: s.note, d: s.d.slice(), v: s.c.slice() }; continue; }
    if (!fx?.d?.length) continue;
    const d = [], v = []; let j = 0, rate = null;
    for (let i = 0; i < s.d.length; i++) {
      while (j < fx.d.length && fx.d[j] <= s.d[i]) rate = fx.c[j++];
      if (rate) { d.push(s.d[i]); v.push(s.c[i] * rate); }
    }
    if (d.length) out[id] = { id, name: s.name, note: s.note, d, v };
  }
  return out;
}
/* last close of each calendar month */
export function monthly({ d, v }) {
  const out = []; let key = null;
  for (let i = 0; i < d.length; i++) { const k = isoDay(d[i]).slice(0, 7); if (k !== key) { out.push({ k, v: v[i] }); key = k; } else out[out.length - 1].v = v[i]; }
  return out;
}
const rangeOf = a => a.length ? { min: Math.min(...a), med: median(a), max: Math.max(...a), neg: a.filter(x => x < 0).length / a.length, n: a.length } : null;

export function stats(s) {
  const { d, v } = s, n = v.length; if (n < 30) return { ok: false, why: 'not enough history yet' };
  const years = (d[n - 1] - d[0]) / 365.25, cagr = Math.pow(v[n - 1] / v[0], 1 / years) - 1;
  let peak = v[0], maxDD = 0, ddAt = d[0];
  for (let i = 0; i < n; i++) { if (v[i] > peak) peak = v[i]; const dd = 1 - v[i] / peak; if (dd > maxDD) { maxDD = dd; ddAt = d[i]; } }
  const ddNow = 1 - v[n - 1] / peak;
  const i5 = d.findIndex(x => x >= d[n - 1] - 5 * 365.25), cagr5 = i5 > 0 && d[i5] - d[0] > 30 ? Math.pow(v[n - 1] / v[i5], 365.25 / (d[n - 1] - d[i5])) - 1 : null;
  const M = monthly(s), mr = M.slice(1).map((m, i) => ({ k: m.k, r: m.v / M[i].v - 1 }));
  const lr = mr.map(x => Math.log(1 + x.r)), mean = lr.reduce((a, b) => a + b, 0) / (lr.length || 1);
  const vol = Math.sqrt(lr.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, lr.length - 1) * 12);
  // calendar years: only full years (Dec close to Dec close); this year shown separately
  const yEnd = new Map(); M.forEach(m => yEnd.set(+m.k.slice(0, 4), m.v));
  const ys = [...yEnd.keys()].sort(), lastYear = +isoDay(d[n - 1]).slice(0, 4), cal = [];
  for (let i = 1; i < ys.length; i++) if (ys[i] < lastYear) cal.push({ y: ys[i], r: yEnd.get(ys[i]) / yEnd.get(ys[i - 1]) - 1 });
  const ytd = yEnd.has(lastYear - 1) ? v[n - 1] / yEnd.get(lastYear - 1) - 1 : null;
  const roll = k => M.slice(k).map((m, i) => Math.pow(m.v / M[i].v, 12 / k) - 1);
  const months = Array.from({ length: 12 }, (_, m) => { const r = mr.filter(x => +x.k.slice(5) === m + 1).map(x => x.r); return { m: m + 1, avg: r.length ? r.reduce((a, b) => a + b, 0) / r.length : null, pos: r.length ? r.filter(x => x > 0).length / r.length : null, n: r.length }; });
  const w = Math.min(200, n), avg = v.slice(-w).reduce((a, b) => a + b, 0) / w;
  return {
    ok: true, from: isoDay(d[0]), to: isoDay(d[n - 1]), years, last: v[n - 1], cagr, cagr5, vol, maxDD, ddAt: isoDay(ddAt), ddNow,
    cal, best: cal.length ? cal.reduce((a, b) => (b.r > a.r ? b : a)) : null, worst: cal.length ? cal.reduce((a, b) => (b.r < a.r ? b : a)) : null,
    upYears: cal.filter(x => x.r > 0).length, ytd, roll1: rangeOf(roll(12)), roll5: M.length > 61 ? rangeOf(roll(60)) : null, months, gap200: n >= 200 ? v[n - 1] / avg - 1 : null,
  };
}
/* how the buckets move together: correlation of monthly returns over the months they share */
export function correlations(Z, ids = ITEMS) {
  const R = {}; ids = ids.filter(id => Z[id]);
  for (const id of ids) { const M = monthly(Z[id]); R[id] = new Map(M.slice(1).map((m, i) => [m.k, m.v / M[i].v - 1])); }
  const corr = (a, b) => { const ks = [...R[a].keys()].filter(k => R[b].has(k)); if (ks.length < 12) return null;
    const x = ks.map(k => R[a].get(k)), y = ks.map(k => R[b].get(k)), mx = x.reduce((p, q) => p + q) / x.length, my = y.reduce((p, q) => p + q) / y.length;
    let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < x.length; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
    return sxy / Math.sqrt(sxx * syy); };
  return { ids, m: ids.map(a => ids.map(b => (a === b ? 1 : corr(a, b)))) };
}

/* ---------- your plan, replayed day by day on the real prices ----------
   Monthly money split by the plan, the main account rebalanced by its band, the trading account running the 200-day rule
   on real Bitcoin closes. Fund fees 0.45% a year, crypto trades 0.35% (fee + price gap), trading cash earning `cashYield`.
   Before tax. Bonds history missing → that bucket earns `cashYield`. */
export function replay({ S, Z, plan = { start: 200, step: 100 }, targets = E.PRESETS.balanced.targets, cashYield = .07, fundFee = .0045, cryptoCost = .0035, from = null }) {
  const need = ['global', 'sa', 'btc'].filter(id => !Z[id]);
  if (need.length) return { ok: false, why: 'needs history for ' + need.join(', ') };
  const ids = ['global', 'sa', 'bonds', 'btc', 'eth'].filter(id => Z[id]);
  let d0 = Math.max(...['global', 'sa', 'btc'].map(id => Z[id].d[0]), S.btc.d[0] + 200);
  if (from) d0 = Math.max(d0, Date.parse(from + 'T00:00:00Z') / 1000 / DAY);
  const dEnd = Math.min(...ids.map(id => Z[id].d[Z[id].d.length - 1]));
  if (dEnd - d0 < 400) return { ok: false, why: 'needs more overlapping history' };
  const P = {}, ptr = {}; ids.forEach(id => { ptr[id] = 0; P[id] = null; });
  const usd = S.btc, sumW = { s: 0, q: [] }; let ui = 0, on = null;
  const H = { global: 0, sa: 0, bonds: 0, bondsCash: 0, btc: 0, eth: 0, tc: 0, tu: 0 };
  let paid = 0, month = null, mIdx = -1, nav = 1, shares = 0, navPeak = 1, maxDD = 0, trades = 0, bank = 0;
  const flows = [], path = [], cashDay = Math.pow(1 + cashYield, 1 / 365) - 1, feeDay = fundFee / 365;
  const val = () => ({ global: H.global * P.global, sa: H.sa * P.sa, bonds: (P.bonds ? H.bonds * P.bonds : 0) + H.bondsCash, crypto: H.btc * P.btc + (P.eth ? H.eth * P.eth : 0), trade: H.tc + H.tu * P.btc });
  const total = v => Object.values(v).reduce((a, b) => a + b, 0);
  for (let day = d0; day <= dEnd; day++) {
    for (const id of ids) { const s = Z[id]; while (ptr[id] < s.d.length && s.d[ptr[id]] <= day) P[id] = s.v[ptr[id]++]; }
    if (P.bonds && H.bondsCash > 0) { H.bonds += H.bondsCash / P.bonds; H.bondsCash = 0; } // bond history starts: move the stand-in cash into it
    while (ui < usd.d.length && usd.d[ui] <= day) { sumW.q.push(usd.c[ui]); sumW.s += usd.c[ui]; if (sumW.q.length > 200) sumW.s -= sumW.q.shift(); ui++; }
    // daily growth: fund fees, cash interest
    H.global *= 1 - feeDay; H.sa *= 1 - feeDay; H.bonds *= 1 - feeDay; H.bondsCash *= 1 + cashDay; H.tc *= 1 + cashDay; bank *= 1 + cashDay;
    const before = total(val()); if (shares > 0) nav = before / shares;
    const k = isoDay(day).slice(0, 7);
    if (k !== month) { // a new month: money in, then rebalance if due
      month = k; mIdx++;
      const amount = E.monthlyIn(plan, Math.floor(mIdx / 12)), v = val();
      const { add } = E.splitMonth({ targets, cur: v, amount, minBuy: E.normPlan(plan).minBuy });
      H.global += add.global / P.global; H.sa += add.sa / P.sa;
      if (P.bonds) H.bonds += add.bonds / P.bonds; else H.bondsCash += add.bonds;
      const ce = add.crypto * (1 - cryptoCost); if (P.eth) { H.btc += ce * .8 / P.btc; H.eth += ce * .2 / P.eth; } else H.btc += ce / P.btc;
      H.tc += add.trade; paid += amount; bank += amount; flows.push(amount); shares += amount / nav;
      const r = E.rebalance({ targets, cur: val(), exclude: ['trade'], minTotal: E.REBALANCE_MIN_TOTAL });
      if (r.due) for (const x of r.rows) {
        if (!x.move) continue;
        if (x.id === 'global') H.global += x.move / P.global; else if (x.id === 'sa') H.sa += x.move / P.sa;
        else if (x.id === 'bonds') { if (P.bonds) H.bonds += x.move / P.bonds; else H.bondsCash += x.move; }
        else if (x.id === 'crypto') { const m = x.move * (1 - cryptoCost), cv = val().crypto || 1, wb = P.eth ? H.btc * P.btc / cv : 1; H.btc += m * wb / P.btc; if (P.eth) H.eth += m * (1 - wb) / P.eth; }
      }
    }
    // the trading rule on the latest completed Bitcoin close
    if (sumW.q.length === 200) {
      const s = E.trendSignal({ closes: sumW.q, px: sumW.q[199], wasOn: on }); on = s.on;
      const a = E.trendAction({ target: s.target, cash: H.tc, units: H.tu, pxZar: P.btc, fee: .0015 });
      if (a.side === 'buy') { H.tc -= a.amount; H.tu += a.amount * (1 - cryptoCost) / P.btc; trades++; }
      else if (a.side === 'sell') { H.tu -= a.units; H.tc += a.units * P.btc * (1 - cryptoCost); trades++; }
    }
    const now = total(val()); nav = shares > 0 ? now / shares : 1; navPeak = Math.max(navPeak, nav); maxDD = Math.max(maxDD, 1 - nav / navPeak);
    if ((day - d0) % 7 === 0 || day === dEnd) path.push({ d: day, paid, value: now, bank });
  }
  const value = total(val()), irr = irrMonthly(flows, value);
  const years = (dEnd - d0) / 365.25;
  return { ok: true, from: isoDay(d0), to: isoDay(dEnd), years, paid, value, bank, irr, twr: Math.pow(nav, 1 / years) - 1, maxDD, trades, parts: val(), path, bondsFromCash: !Z.bonds || Z.bonds.d[0] > d0 };
}
/* money-weighted yearly return: flows paid at the start of each month, value at the end */
export function irrMonthly(flows, value) {
  const n = flows.length; if (!n || !(value > 0)) return null;
  const fv = r => flows.reduce((a, f, i) => a + f * Math.pow(1 + r, n - i), 0) - value;
  let lo = -0.99, hi = 1; if (fv(lo) * fv(hi) > 0) return null;
  for (let i = 0; i < 80; i++) { const m = (lo + hi) / 2; fv(m) > 0 ? (hi = m) : (lo = m); }
  return Math.pow(1 + (lo + hi) / 2, 12) - 1;
}
