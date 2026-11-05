/* Local harness: serves public/ and runs the Worker in Node with the fake providers. Usage: node tests/serve.mjs [port] */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fakeNet, env0 } from './helpers.mjs';
import worker from '../src/worker.js';
const net = fakeNet({ zar: 1366000 }); globalThis.fetch = net.handler;
const env = env0({ TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '1', ANTHROPIC_API_KEY: 'x', VALR_API_KEY: 'k', VALR_API_SECRET: 's' });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
env.ASSETS = { fetch: async r => { let p = new URL(r.url).pathname; if (p === '/') p = '/index.html';
  try { return new Response(await readFile(join('public', p)), { headers: { 'content-type': types[extname(p)] || 'text/plain' } }); } catch { return new Response('nf', { status: 404 }); } } };
let tick = 0; setInterval(() => { net.o.zar = 1366000 + Math.round(Math.sin(++tick / 3) * 4000); }, 2000).unref?.();
http.createServer(async (q, s) => {
  const body = ['GET', 'HEAD'].includes(q.method) ? undefined : await new Promise(r => { let d = ''; q.on('data', c => d += c); q.on('end', () => r(d || undefined)); });
  const r = await worker.fetch(new Request('http://x' + q.url, { method: q.method, headers: q.headers, body }), env, { waitUntil() {} });
  s.writeHead(r.status, Object.fromEntries(r.headers)); s.end(Buffer.from(await r.arrayBuffer()));
}).listen(+process.argv[2] || 8787, () => console.log('ready'));
