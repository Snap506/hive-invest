/* Live market data. Every call has a timeout, one retry on a temporary failure, and defensive parsing.
   Prices:   VALR public market summary (BTC/ZAR, the price you actually trade at in South Africa)
   History:  Bitstamp daily candles (BTC/USD) — the series the 200-day rule was tested on
   Rand/USD: implied from VALR ÷ Bitstamp (your exchange's real rate); fallback: Frankfurter (ECB) daily rate
   Research: CoinGecko (trending coins, global market, sectors); a free Demo key raises its limits */
const UA = { 'user-agent': 'hive-invest/2 (+cloudflare-worker)', accept: 'application/json' };
const num = v => { const n = typeof v === 'string' ? parseFloat(v) : v; return typeof n === 'number' && isFinite(n) ? n : null; };

export async function fetchJson(url, { headers = {}, timeoutMs = 8000, retries = 1, method = 'GET', body } = {}) {
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { method, headers: { ...UA, ...headers }, body, signal: ctl.signal });
      clearTimeout(timer);
      if (r.ok) return await r.json();
      last = new Error(`${new URL(url).host} answered ${r.status}`); last.status = r.status;
      if (r.status !== 429 && r.status < 500) break;           // a real refusal: don't retry
    } catch (e) { clearTimeout(timer); last = e.name === 'AbortError' ? new Error(`${new URL(url).host} timed out`) : e; }
    if (attempt < retries) await new Promise(res => setTimeout(res, 400 + Math.random() * 600));
  }
  throw last;
}

/* ---------- VALR ---------- */
export async function valrSummary(pair = 'BTCZAR') {
  const d = await fetchJson(`https://api.valr.com/v1/public/${pair}/marketsummary`);
  const px = num(d.lastTradedPrice);
  if (!px) throw new Error('VALR returned no price');
  return { px, bid: num(d.bidPrice), ask: num(d.askPrice), ch24: num(d.changeFromPrevious), high: num(d.highPrice), low: num(d.lowPrice), at: Date.parse(d.created) || Date.now(), src: 'VALR' };
}
/* ---------- Bitstamp ---------- */
export async function bitstampTicker(pair = 'btcusd') {
  const d = await fetchJson(`https://www.bitstamp.net/api/v2/ticker/${pair}/`);
  const px = num(d.last);
  if (!px) throw new Error('Bitstamp returned no price');
  return { px, ch24: num(d.percent_change_24), at: (num(d.timestamp) || Date.now() / 1000) * 1000, src: 'Bitstamp' };
}
export async function bitstampDaily(pair = 'btcusd', limit = 420) {
  const d = await fetchJson(`https://www.bitstamp.net/api/v2/ohlc/${pair}/?step=86400&limit=${limit}`, { timeoutMs: 10000 });
  const rows = (d?.data?.ohlc || []).map(b => ({ t: num(b.timestamp), o: num(b.open), h: num(b.high), l: num(b.low), c: num(b.close) })).filter(b => b.t && b.c);
  if (rows.length < 210) throw new Error(`Bitstamp returned only ${rows.length} days`);
  return rows.sort((a, b) => a.t - b.t);
}
/* ---------- rand per dollar ---------- */
export async function frankfurterUsdZar() {
  const d = await fetchJson('https://api.frankfurter.app/latest?from=USD&to=ZAR');
  const r = num(d?.rates?.ZAR);
  if (!r) throw new Error('Frankfurter returned no rate');
  return { rate: r, date: d.date, src: 'Frankfurter (ECB)' };
}
/* ---------- CoinGecko ---------- */
const cg = (env, path) => fetchJson(`https://api.coingecko.com/api/v3${path}`, { headers: env.COINGECKO_API_KEY ? { 'x-cg-demo-api-key': env.COINGECKO_API_KEY } : {} });
export async function cgTrending(env) {
  const d = await cg(env, '/search/trending');
  return (d?.coins || []).map(x => x.item || x).map(i => ({ id: i.id, symbol: i.symbol, name: i.name, rank: num(i.market_cap_rank), priceUsd: num(i.data?.price), ch24: num(i.data?.price_change_percentage_24h?.usd) }));
}
export async function cgGlobal(env) {
  const d = (await cg(env, '/global'))?.data || {};
  return { mcapUsd: num(d.total_market_cap?.usd), ch24: num(d.market_cap_change_percentage_24h_usd), btcDom: num(d.market_cap_percentage?.btc) };
}
export async function cgCategories(env) {
  const d = await cg(env, '/coins/categories');
  return (Array.isArray(d) ? d : []).map(c => ({ id: c.id, name: c.name, cap: num(c.market_cap), ch: (num(c.market_cap_change_24h) || 0) / 100 }));
}
/* backup daily history: CoinGecko's midnight (UTC) prices, each counted as the previous day's close */
export async function cgDaily(env, days = 365) {
  const d = await cg(env, `/coins/bitcoin/market_chart?vs_currency=usd&days=${days}&interval=daily`);
  const rows = (d?.prices || []).map(([ms, c]) => ({ t: Math.floor(ms / 864e5) * 86400 - 86400, c: num(c) })).filter(b => b.c);
  const seen = new Map(); for (const r of rows) seen.set(r.t, r);   // one point per day
  const out = [...seen.values()].sort((a, b) => a.t - b.t);
  if (out.length < 210) throw new Error(`CoinGecko returned only ${out.length} days`);
  return out;
}
