/* Test helpers: a D1 database backed by Node's built-in SQLite, and a fake internet that answers like the real
   providers (same field names and string-typed numbers as their documented responses). */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

export function makeD1() {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()) db.exec(readFileSync(new URL('../migrations/' + f, import.meta.url), 'utf8'));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    async first() { return db.prepare(sql).get(...args) ?? null; },
    async all() { return { results: db.prepare(sql).all(...args) }; },
    async raw() { return db.prepare(sql).all(...args).map(r => Object.values(r)); },
    async run() { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
  });
  return { prepare: sql => stmt(sql), _db: db };
}

/* daily candles: a gentle uptrend with noise, ending yesterday at about `last` dollars */
export function candles({ days = 600, last = 78051, now = Date.now(), seed = 7, shape = 'up' } = {}) {
  let s = seed; const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) + .5) / 4294967296;
  const today = Math.floor(now / 864e5) * 86400, closes = [];
  let p = 1;
  for (let i = 0; i < days; i++) { const drift = shape === 'up' ? .0012 : shape === 'down' ? (i > days - 120 ? -.004 : .002) : 0; p *= 1 + drift + (rnd() - .5) * .04; closes.push(p); }
  const k = last / closes[closes.length - 1];
  const rows = closes.map((c, i) => { const t = today - (days - i) * 86400, cc = c * k; return { timestamp: String(t), open: (cc * .995).toFixed(2), high: (cc * 1.01).toFixed(2), low: (cc * .99).toFixed(2), close: cc.toFixed(2), volume: '1234.5' }; });
  rows.push({ timestamp: String(today), open: rows.at(-1).close, high: '1', low: '1', close: String(last * 1.5), volume: '1' }); // today's unfinished candle (must be ignored)
  return rows;
}

/* Bitstamp-shaped daily candles from 2014-01-01 to yesterday */
export function longCandles(last = 78051) { const now = Date.now(), days = Math.floor((now - Date.parse('2014-01-01T00:00:00Z')) / 864e5); return candles({ days, last, now, seed: 11 }).slice(0, -1); }
export function fakeNet(opts = {}) {
  const o = { usd: 78051, zar: 1366000, down: new Set(), ...opts }, calls = [];
  const json = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
  const handler = async (input, init = {}) => {
    const url = String(input?.url ?? input), u = new URL(url); calls.push({ url, init });
    for (const d of o.down) if (u.host.includes(d)) return json({ error: 'down' }, 503);
    if (u.host === 'api.valr.com' && u.pathname.endsWith('/marketsummary')) return json({ currencyPair: 'BTCZAR', askPrice: String(o.zar + 500), bidPrice: String(o.zar - 500), lastTradedPrice: String(o.zar), previousClosePrice: String(o.zar * .99), baseVolume: '12.3', quoteVolume: '16800000', highPrice: String(o.zar * 1.02), lowPrice: String(o.zar * .98), created: new Date().toISOString(), changeFromPrevious: '1.01' });
    if (u.host === 'api.valr.com' && u.pathname === '/v1/account/balances') {
      if (!init.headers?.['X-VALR-SIGNATURE']) return json({ code: -11252, message: 'missing signature' }, 401);
      return json([{ currency: 'ZAR', available: '5000.50', reserved: '0', total: '5000.50' }, { currency: 'BTC', available: '0.001', reserved: '0', total: '0.001' }]);
    }
    if (u.host === 'www.bitstamp.net' && u.pathname === '/api/v2/ticker/btcusd/') return json({ last: String(o.usd), high: '79000', low: '77000', open: '77500', timestamp: String(Math.floor(Date.now() / 1000)), percent_change_24: '0.71' });
    if (u.host === 'www.bitstamp.net' && u.pathname.startsWith('/api/v2/ohlc/')) {
      const start = +u.searchParams.get('start') || 0, limit = +u.searchParams.get('limit') || 1000;
      const all = o.candles || (start ? longCandles(u.pathname.includes('eth') ? 3000 : o.usd) : candles({ last: o.usd }));
      return json({ data: { pair: 'BTC/USD', ohlc: all.filter(r => +r.timestamp >= start).slice(0, limit) } });
    }
    if (u.host === 'query1.finance.yahoo.com') {
      if (o.down.has('yahoo-block')) return json({ chart: { result: null, error: { description: 'Too Many Requests' } } }, 429);
      const sym = decodeURIComponent(u.pathname.split('/').pop()), p1 = +u.searchParams.get('period1'), jo = sym.endsWith('.JO');
      const ts = [], adj = [], cl = []; let v = sym === 'VT' ? 55 : sym.includes('GOV') ? 4000 : 4500;
      for (let t = Math.floor(p1 / 86400) * 86400; t < Date.now() / 1000 - 86400; t += 86400) { const wd = new Date(t * 1000).getUTCDay(); if (wd === 0 || wd === 6) continue; v *= 1 + (sym.includes('GOV') ? .0003 : .0004) + Math.sin(t / 9e5) * .004; ts.push(t + 14 * 3600 + 1800); adj.push(v); cl.push(v * .97); }
      return json({ chart: { result: [{ meta: { currency: jo ? 'ZAc' : 'USD', symbol: sym }, timestamp: ts, indicators: { quote: [{ close: cl }], adjclose: [{ adjclose: adj }] } }], error: null } });
    }
    if (u.host === 'api.frankfurter.app' && u.pathname.includes('..')) {
      const [a, b] = u.pathname.slice(1).split('..'), rates = {};
      for (let t = Date.parse(a + 'T00:00:00Z'); t <= Date.parse(b + 'T00:00:00Z'); t += 864e5) { const wd = new Date(t).getUTCDay(); if (wd && wd < 6) rates[new Date(t).toISOString().slice(0, 10)] = { ZAR: +(10 + (t - 1.388e12) / 3.15e10 * .6).toFixed(4) }; }
      return json({ amount: 1, base: 'USD', start_date: a, end_date: b, rates });
    }
    if (u.host === 'api.coingecko.com' && u.pathname.endsWith('/market_chart')) { const rows = (o.candles || candles({ last: o.usd })).map(r => [(+r.timestamp + 86400) * 1000, +r.close]); return json({ prices: rows.slice(-366) }); }
    if (u.host === 'api.frankfurter.app') return json({ amount: 1, base: 'USD', date: '2026-11-03', rates: { ZAR: 17.42 } });
    if (u.host === 'api.coingecko.com' && u.pathname.endsWith('/search/trending')) return json({ coins: [
      { item: { id: 'bitcoin', name: 'Bitcoin', symbol: 'BTC', market_cap_rank: 1, data: { price: o.usd, price_change_percentage_24h: { usd: 0.7 } } } },
      { item: { id: 'pumpy', name: 'Pumpy', symbol: 'PMP', market_cap_rank: 812, data: { price: 0.001, price_change_percentage_24h: { usd: 140 } } } },
      { item: { id: 'solana', name: 'Solana', symbol: 'SOL', market_cap_rank: 6, data: { price: 180, price_change_percentage_24h: { usd: -2.1 } } } }] });
    if (u.host === 'api.coingecko.com' && u.pathname.endsWith('/global')) return json({ data: { total_market_cap: { usd: 2.71e12 }, market_cap_change_percentage_24h_usd: 0.9, market_cap_percentage: { btc: 57.2 } } });
    if (u.host === 'api.coingecko.com' && u.pathname.endsWith('/coins/categories')) return json([{ id: 'layer-1', name: 'Layer 1', market_cap: 2.1e12, market_cap_change_24h: 1.2 }, { id: 'meme', name: 'Meme', market_cap: 6e10, market_cap_change_24h: 4.5 }, { id: 'tiny', name: 'Tiny', market_cap: 1e8, market_cap_change_24h: 30 }]);
    if (u.host === 'api.telegram.org') return json({ ok: true, result: { message_id: 1 } });
    if (u.host === 'api.anthropic.com') return json({ content: [{ type: 'text', text: 'The average sits about 7% below the price.' }], usage: { input_tokens: 200, output_tokens: 40 } });
    return json({ error: 'unexpected ' + url }, 404);
  };
  return { handler, calls, o };
}

export const env0 = (extra = {}) => ({ DB: makeD1(), APP_TOKEN: 'test-pass', CLAUDE_MONTHLY_USD: '2', USDZAR_FALLBACK: '17.5', ...extra });
export const req = (path, { method = 'GET', body, token = 'test-pass' } = {}) => new Request('https://hive.test' + path, { method, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
export const ctx = () => { const p = []; return { waitUntil: x => p.push(x), done: () => Promise.all(p) }; };
