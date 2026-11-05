/* Sign-in: one passcode you choose, stored as the Cloudflare secret APP_TOKEN. The app sends it as a Bearer token.
   For stronger protection put Cloudflare Access in front of the whole site as well (see DEPLOY.md, step 7). */
const enc = new TextEncoder();
async function same(a, b) { // constant-time compare of two strings via their hashes
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const u = new Uint8Array(x), v = new Uint8Array(y); let d = 0; for (let i = 0; i < u.length; i++) d |= u[i] ^ v[i]; return d === 0;
}
export async function checkAuth(request, env) {
  if (!env.APP_TOKEN) return env.ALLOW_OPEN === '1' ? null : { status: 503, error: 'Set the APP_TOKEN secret first (DEPLOY.md, step 5).' };
  const h = request.headers.get('authorization') || '', tok = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (tok && await same(tok, env.APP_TOKEN)) return null;
  return { status: 401, error: 'Sign in with your passcode.' };
}
