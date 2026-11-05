/* D1 storage.
   kv:     two documents — 'user' (what you edit in the app) and 'server' (the daily signal, usage, last checks) — so the
           daily check never overwrites your edits. Each write carries a version; a stale write is refused, not lost.
   cache:  market data with an expiry, so a burst of requests never hammers the providers, and a provider outage can
           fall back to the last good answer.
   events: an append-only log of every decision and outside call worth keeping. */
const now = () => Date.now();

export async function getDoc(env, key) {
  const r = await env.DB.prepare('SELECT value, version, updated_at FROM kv WHERE key = ?').bind(key).first();
  return r ? { value: JSON.parse(r.value), version: r.version, updatedAt: r.updated_at } : { value: null, version: 0, updatedAt: 0 };
}
/* write with optimistic concurrency: ifVersion must match the stored version (0 = create) */
export async function putDoc(env, key, value, ifVersion) {
  const json = JSON.stringify(value);
  if (json.length > 900_000) throw Object.assign(new Error('Document too large'), { status: 413 });
  if (ifVersion === 0) {
    const r = await env.DB.prepare('INSERT INTO kv (key, value, version, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT(key) DO NOTHING').bind(key, json, now()).run();
    if (!r.meta?.changes) throw Object.assign(new Error('Changed elsewhere'), { status: 409 });
    return 1;
  }
  const r = await env.DB.prepare('UPDATE kv SET value = ?, version = version + 1, updated_at = ? WHERE key = ? AND version = ?').bind(json, now(), key, ifVersion).run();
  if (!r.meta?.changes) throw Object.assign(new Error('Changed elsewhere'), { status: 409 });
  return ifVersion + 1;
}
/* read-modify-write for server-owned documents, retried on a version clash */
export async function updateDoc(env, key, fn, fallback = {}) {
  for (let i = 0; i < 4; i++) {
    const d = await getDoc(env, key), next = fn(structuredClone(d.value ?? fallback));
    try { await putDoc(env, key, next, d.version); return next; } catch (e) { if (e.status !== 409) throw e; }
  }
  throw new Error(`Could not update ${key}`);
}

/* ---------- cache with stale fallback ---------- */
const mems = new WeakMap(); // per-isolate, per-database: the fastest path
export async function cached(env, key, ttlMs, loader) {
  let mem = mems.get(env.DB); if (!mem) mems.set(env.DB, mem = new Map());
  const m = mem.get(key);
  if (m && m.exp > now()) return { ...m.val, cached: true };
  let row = null;
  try { row = await env.DB.prepare('SELECT value, expires FROM cache WHERE key = ?').bind(key).first(); } catch { /* table missing: run the migration */ }
  if (row && row.expires > now()) { const val = JSON.parse(row.value); mem.set(key, { val, exp: row.expires }); return { ...val, cached: true }; }
  try {
    const data = await loader(), val = { data, at: now() }, exp = now() + ttlMs;
    mem.set(key, { val, exp });
    try { await env.DB.prepare('INSERT INTO cache (key, value, expires) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires = excluded.expires').bind(key, JSON.stringify(val), exp).run(); } catch {}
    return val;
  } catch (e) {
    if (row) return { ...JSON.parse(row.value), stale: true, error: String(e.message || e) };   // last good answer
    if (m) return { ...m.val, stale: true, error: String(e.message || e) };
    throw e;
  }
}
export async function logEvent(env, kind, data) {
  try {
    await env.DB.prepare('INSERT INTO events (ts, kind, data) VALUES (?, ?, ?)').bind(now(), kind, JSON.stringify(data ?? null)).run();
    await env.DB.prepare('DELETE FROM events WHERE id IN (SELECT id FROM events ORDER BY id DESC LIMIT -1 OFFSET 2000)').run();
  } catch {}
}
export async function recentEvents(env, limit = 50) {
  const r = await env.DB.prepare('SELECT ts, kind, data FROM events ORDER BY id DESC LIMIT ?').bind(limit).all();
  return (r.results || []).map(x => ({ ts: x.ts, kind: x.kind, data: JSON.parse(x.data) }));
}
export const _clearMemForTests = db => mems.delete(db);
