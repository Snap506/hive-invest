/* Talking to the Worker: passcode, timeouts, and clear errors. */
const KEY = 'hive.token';
const store = { get() { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } }, set(v) { try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY); } catch {} } };
let token = store.get();

export class ApiError extends Error { constructor(msg, status, body) { super(msg); this.status = status; this.body = body; } }
export const auth = { has: () => !!token, set(v) { token = v; store.set(v); }, clear() { token = ''; store.set(''); } };

export async function api(path, { method = 'GET', body, timeoutMs = 12000 } = {}) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch('/api' + path, {
      method, signal: ctl.signal, cache: 'no-store', keepalive: method !== 'GET' && (body ? JSON.stringify(body).length < 60000 : true),
      headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new ApiError(data.error || `Server answered ${r.status}`, r.status, data);
    return data;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(e.name === 'AbortError' ? 'The server took too long to answer' : navigator.onLine === false ? 'You are offline' : 'Could not reach the server', 0);
  } finally { clearTimeout(t); }
}
