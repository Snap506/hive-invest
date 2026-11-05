/* What your plan could grow to: 2,000 simulated futures, month by month, for YOUR budget and mix.
   Runs in the browser in a few milliseconds and re-runs whenever you change the plan. Before tax. */
import * as E from './engine.js';

/* yearly assumptions in rand, before costs (arithmetic averages) — deliberately modest; the trading account gets no credit for its rule */
export const ASSUME = {
  ids: ['global', 'sa', 'bonds', 'crypto', 'trade'],
  mu: { global: .115, sa: .105, bonds: .08, crypto: .30, trade: .185 },
  vol: { global: .16, sa: .18, bonds: .07, crypto: .75, trade: .38 },
  corr: [ // global, sa, bonds, crypto, trade
    [1, .55, .15, .30, .25], [.55, 1, .35, .20, .15], [.15, .35, 1, 0, .05], [.30, .20, 0, 1, .70], [.25, .15, .05, .70, 1]],
  fundFee: .0045, cryptoCost: .003, inflation: .04,
  text: 'Yearly averages in rand before costs: global shares 11.5%, SA shares 10.5%, bonds 8%, crypto 30% with very large swings, the trading account as half crypto and half cash with no credit for its rule. Fund fees 0.45% a year, crypto costs 0.3% per purchase, rebalanced once a year when a bucket drifts more than 5 points, 4% inflation. Before tax — most of the first R46,000 a year sits in your tax-free account.',
};
function cholesky(A) {
  const n = A.length, L = A.map(() => new Array(n).fill(0));
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) { let s = A[i][j]; for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k]; L[i][j] = i === j ? Math.sqrt(Math.max(s, 1e-12)) : s / L[j][j]; }
  return L;
}
const rng = seed => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };

export function project({ plan, targets = E.PRESETS.balanced.targets, years = 10, paths = 2000, seed = 42, A = ASSUME, extraPerYear = 0 } = {}) {
  const ids = A.ids, n = ids.length, L = cholesky(A.corr), R = rng(seed), M = years * 12;
  const drift = ids.map(k => Math.log(1 + A.mu[k]) / 12 - A.vol[k] ** 2 / 24), sd = ids.map(k => A.vol[k] / Math.sqrt(12));
  const fee = ids.map(k => (k === 'crypto' || k === 'trade' ? 0 : A.fundFee / 12)), cost = ids.map(k => (k === 'crypto' ? A.cryptoCost : 0));
  const tw = ids.map(k => targets[k] || 0), flows = [];
  for (let m = 0; m < M; m++) flows.push(E.monthlyIn(plan, Math.floor(m / 12)) + extraPerYear / 12);
  const atYear = Array.from({ length: years }, () => new Float64Array(paths)), paid = [];
  let p = 0; for (let y = 0; y < years; y++) { for (let m = 0; m < 12; m++) p += flows[y * 12 + m]; paid.push(p); }
  const z = new Float64Array(n), H = new Float64Array(n);
  for (let path = 0; path < paths; path++) {
    H.fill(0);
    for (let m = 0; m < M; m++) {
      for (let i = 0; i < n; i++) H[i] += flows[m] * tw[i] * (1 - cost[i]);                       // money in, split by plan
      for (let i = 0; i < n; i += 2) { const u1 = R() || 1e-12, u2 = R(), r = Math.sqrt(-2 * Math.log(u1)); z[i] = r * Math.cos(6.283185307 * u2); if (i + 1 < n) z[i + 1] = r * Math.sin(6.283185307 * u2); }
      for (let i = 0; i < n; i++) { let e = 0; for (let k = 0; k <= i; k++) e += L[i][k] * z[k]; H[i] *= Math.exp(drift[i] + sd[i] * e) * (1 - fee[i]); }
      if (m % 12 === 11) {                                                                          // once a year: rebalance the main account if it drifted
        let tot = 0, tm = 0; for (let i = 0; i < n; i++) { tot += H[i]; if (ids[i] !== 'trade') tm += tw[i]; }
        const main = tot - H[ids.indexOf('trade')];
        if (main > E.REBALANCE_MIN_TOTAL && ids.some((k, i) => k !== 'trade' && Math.abs(H[i] / main - tw[i] / tm) > E.BAND))
          for (let i = 0; i < n; i++) if (ids[i] !== 'trade') { const want = main * tw[i] / tm; H[i] = want - (want > H[i] ? (want - H[i]) * cost[i] : 0); }
        atYear[(m + 1) / 12 - 1][path] = H.reduce((a, b) => a + b, 0);
      }
    }
  }
  const q = (a, f) => { const s = Float64Array.from(a).sort(); return s[Math.min(s.length - 1, Math.floor(f * s.length))]; };
  const rows = atYear.map((a, y) => {
    const p50 = q(a, .5), infl = Math.pow(1 + A.inflation, y + 1);
    return { year: y + 1, paid: paid[y], p10: q(a, .1), p50, p90: q(a, .9), today: p50 / infl, loss: a.filter(v => v < paid[y]).length / a.length, irr: irr(flows.slice(0, (y + 1) * 12), p50) };
  });
  return { rows, flows, years, paths };
}
/* money-weighted yearly return: flows at the start of each month, value at the end */
export function irr(flows, value) {
  const n = flows.length; if (!n || !(value > 0)) return null;
  const fv = r => flows.reduce((a, f, i) => a + f * Math.pow(1 + r, n - i), 0) - value;
  let lo = -0.99, hi = 1; if (fv(lo) * fv(hi) > 0) return null;
  for (let i = 0; i < 80; i++) { const m = (lo + hi) / 2; fv(m) > 0 ? (hi = m) : (lo = m); }
  return Math.pow(1 + (lo + hi) / 2, 12) - 1;
}
