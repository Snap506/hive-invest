/* Optional helpers: Telegram messages and short Claude answers, each switched on by its own secret. */
import { fetchJson } from './sources.js';

export async function telegram(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return { sent: false, why: 'Telegram not set up (DEPLOY.md, step 8)' };
  await fetchJson(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, retries: 1,
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
  });
  return { sent: true };
}

/* Claude: quick model only, inside a monthly dollar budget you set (CLAUDE_MONTHLY_USD, default $2) */
const MODEL = 'claude-haiku-4-5-20251001', PRICE = { in: 1 / 1e6, out: 5 / 1e6 };
export async function askClaude(env, usage, prompt) {
  if (!env.ANTHROPIC_API_KEY) throw Object.assign(new Error('Claude not set up (DEPLOY.md, step 9)'), { status: 400 });
  const month = new Date().toISOString().slice(0, 7), budget = parseFloat(env.CLAUDE_MONTHLY_USD || '2');
  if (usage.month !== month) Object.assign(usage, { month, usd: 0, calls: 0 });
  if (usage.usd >= budget) throw Object.assign(new Error(`This month's Claude budget of $${budget} is used up`), { status: 429 });
  const d = await fetchJson('https://api.anthropic.com/v1/messages', {
    method: 'POST', retries: 1, timeoutMs: 25000,
    headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 300, messages: [{ role: 'user', content: prompt }] }),
  });
  const text = (d.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
  const cost = (d.usage?.input_tokens || 0) * PRICE.in + (d.usage?.output_tokens || 0) * PRICE.out;
  usage.usd = +(usage.usd + cost).toFixed(6); usage.calls++;
  return { text, cost, usage };
}
