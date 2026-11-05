import { fakeNet, env0, req } from './helpers.mjs';
import worker from '../src/worker.js';
import { _clearMemForTests } from '../src/lib/store.js';
globalThis.fetch = fakeNet().handler; const env = env0();
for (const p of ['/api/live', '/api/chart?days=1500', '/api/state']) {
  const ts = [];
  for (let i = 0; i < 8; i++) { env.DB._db.exec('DELETE FROM cache'); _clearMemForTests(env.DB); const a = performance.now(); await worker.fetch(req(p), env, { waitUntil() {} }); ts.push(performance.now() - a); }
  ts.sort((a, b) => a - b); console.log(p, 'uncached median', ts[4].toFixed(1), 'ms (includes fake network + SQLite)');
}
const t = performance.now(); for (let i = 0; i < 50; i++) await worker.fetch(req('/api/live'), env, { waitUntil() {} }); console.log('/api/live cached', ((performance.now() - t) / 50).toFixed(2), 'ms');
