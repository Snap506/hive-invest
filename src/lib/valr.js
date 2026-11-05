/* VALR read-only link. Uses an API key with VIEW permission only — never Trade, Transfer or Withdraw.
   Signature: HMAC-SHA512 (hex) of  timestamp + METHOD + path + body + subaccountId  with your API secret. */
import { fetchJson } from './sources.js';
const enc = new TextEncoder();
async function sign(secret, payload) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export async function valrSigned(env, method, path, body = '') {
  if (!env.VALR_API_KEY || !env.VALR_API_SECRET) throw Object.assign(new Error('VALR key not set (DEPLOY.md, step 10)'), { status: 400 });
  const ts = Date.now().toString(), sub = env.VALR_SUBACCOUNT_ID || '';
  const headers = { 'X-VALR-API-KEY': env.VALR_API_KEY, 'X-VALR-SIGNATURE': await sign(env.VALR_API_SECRET, ts + method.toUpperCase() + path + body + sub), 'X-VALR-TIMESTAMP': ts };
  if (sub) headers['X-VALR-SUB-ACCOUNT-ID'] = sub;
  return fetchJson('https://api.valr.com' + path, { method, headers, body: body || undefined, retries: 0 });
}
/* balances of the (sub)account the key belongs to → { ZAR: {available,total}, BTC: {...}, ... } */
export async function valrBalances(env) {
  const list = await valrSigned(env, 'GET', '/v1/account/balances');
  const out = {};
  for (const b of Array.isArray(list) ? list : []) {
    const f = v => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
    out[b.currency] = { available: f(b.available), reserved: f(b.reserved), total: f(b.total ?? (f(b.available) + f(b.reserved))) };
  }
  return out;
}
export { sign as _signForTests };
