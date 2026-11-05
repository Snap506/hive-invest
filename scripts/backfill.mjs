/* Fill the price history from YOUR computer and send it to your app.
   Use this if Setup → History shows a ✕ for a source (some providers block Cloudflare's servers but not home internet).
     Windows (PowerShell):  $env:APP_TOKEN="your-passcode"; npm run backfill -- https://hive-invest.<you>.workers.dev
     Mac / Linux:           APP_TOKEN=your-passcode npm run backfill -- https://hive-invest.<you>.workers.dev
   Add series names to do only some, e.g.  ... workers.dev sa bonds  */
import { SERIES, fetchChunk } from '../src/lib/history.js';
const [base, ...only] = process.argv.slice(2), token = process.env.APP_TOKEN;
if (!base || !token) { console.error('Usage: APP_TOKEN=... npm run backfill -- https://your-app.workers.dev [series...]'); process.exit(1); }
const call = async (path, body) => {
  const r = await fetch(base.replace(/\/$/, '') + path, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || r.status); return d;
};
const status = Object.fromEntries((await call('/api/history/status')).series.map(s => [s.id, s]));
for (const id of only.length ? only : Object.keys(SERIES)) {
  let start = status[id]?.to ? Date.parse(status[id].to + 'T00:00:00Z') / 1000 + 86400 : Date.parse(SERIES[id].from + 'T00:00:00Z') / 1000, total = 0;
  try {
    for (let guard = 0; guard < 40; guard++) {
      const { bars, done, next } = await fetchChunk(id, start);
      for (let i = 0; i < bars.length; i += 5000) total += (await call('/api/history/import', { series: id, bars: bars.slice(i, i + 5000), source: SERIES[id].src + ' (from PC)' })).added;
      if (done || (!bars.length && !next)) break;
      start = next || bars[bars.length - 1][0] + 86400; await new Promise(r => setTimeout(r, 600));
    }
    console.log(`✓ ${SERIES[id].name}: ${total} days added`);
  } catch (e) { console.log(`✕ ${SERIES[id].name}: ${e.message}`); }
}
