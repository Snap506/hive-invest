/* Hive Invest — the app. Live data from the Worker, decisions from engine.js, nothing simulated. */
import * as E from './engine.js';
import { api, auth, ApiError } from './api.js';
import { makeChart } from './chart.js';
import * as P from './patterns.js';
import { ASSUME } from './projection.js';
const P2ASSUME = ASSUME.text;

/* ---------- helpers ---------- */
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const zar = v => (v < 0 ? '−R' : 'R') + Math.abs(Math.round(Number(v) || 0)).toLocaleString('en-ZA');
const usd = v => '$' + Math.round(Number(v) || 0).toLocaleString('en-US');
const pct = (v, d = 1) => (v >= 0 ? '+' : '−') + Math.abs(v * 100).toFixed(d) + '%';
const pc0 = v => Math.round(Math.abs(v) * 100) + '%';
const rk = v => v >= 1e6 ? 'R' + (v / 1e6).toFixed(v >= 1e7 ? 0 : 1) + 'm' : v >= 1e3 ? 'R' + Math.round(v / 1e3) + 'k' : 'R' + Math.round(v);
const btc = v => (Number(v) || 0).toFixed(6).replace(/0+$/, '').replace(/\.$/, '') + ' BTC';
const ago = t => { if (!t) return '—'; const s = (Date.now() - t) / 1000; return s < 45 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' d ago'; };
const sast = () => new Date(Date.now() + 2 * 3600e3);
const today = () => sast().toISOString().slice(0, 10);
const monthKey = () => sast().toISOString().slice(0, 7);
const B = Object.fromEntries(E.BUCKETS.map(b => [b.id, b]));
function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3200); }

const SECTIONS = [
  { id: 'today', name: 'Today', title: 'Today', sub: 'Only what needs doing. Most days, nothing.' },
  { id: 'trade', name: 'Trading', title: 'Trading account', sub: 'One tested rule: half the account in Bitcoin while it is above its 200-day average, none while below.' },
  { id: 'main', name: 'Main', title: 'Main account', sub: 'The long-term build: money in every month, spread by plan, rebalanced when it drifts.' },
  { id: 'history', name: 'History', title: 'History & patterns', sub: 'Years of real prices for every bucket, in rand: how they grew, how far they fell, how they move together.' },
  { id: 'research', name: 'Research', title: 'Research', sub: 'What is moving in crypto right now, screened. To read, not to trade.' },
  { id: 'setup', name: 'Setup', title: 'Setup', sub: 'Your plan, the rules, and the live connections.' },
];

/* ---------- the app ---------- */
const App = {
  user: null, version: 0, server: {}, live: null, liveAt: 0, chart: null, chartData: null, chartDays: 730, research: null, researchAt: 0,
  tab: 'today', hLog: true, repFrom: 2018, hist: null, histAt: 0, html: {}, tk: null, poll: { timer: 0, fails: 0, busy: false }, saving: null, dirty: false, status: null,

  async start() {
    try { this.tab = localStorage.getItem('hive.tab') || 'today'; } catch {}
    if (!SECTIONS.some(s => s.id === this.tab)) this.tab = 'today';
    const h = await api('/health').catch(() => null);
    if (h && !h.passcodeSet) return this.fatal('The server has no passcode yet. Set the APP_TOKEN secret (DEPLOY.md, step 5), then reload.');
    if (!auth.has() || (h && !h.signedIn)) return this.signIn();
    try { await this.loadState(); } catch (e) { if (e.status === 401) return this.signIn(); return this.fatal(e.message + ' — reload to try again.'); }
    this.boot();
  },
  boot() {
    this.renderTabs(); this.go(this.tab); this.refreshLive(); this.loadChart();
    if (this.booted) return; this.booted = true;
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') this.refreshLive(); else { this.stopPoll(); if (this.dirty) this.flush(); } });
    addEventListener('online', () => this.refreshLive());
    addEventListener('offline', () => this.setPill());
    addEventListener('pagehide', () => { if (this.dirty) this.flush(); });
    document.addEventListener('click', e => this.onClick(e));
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && this.tk) this.closeTicket(); });
    setInterval(() => this.setPill(), 15000);
  },
  fatal(msg) { $('title').textContent = 'Hive Invest'; $('sub').textContent = ''; $('body').innerHTML = `<div class="banner bad">${esc(msg)}</div>`; },
  signIn(err) {
    $('tabs').innerHTML = ''; $('title').textContent = ''; $('sub').textContent = '';
    $('body').innerHTML = `<div class="signin"><div class="card"><h3>Sign in</h3><form id="si"><label>Passcode<input id="si-p" type="password" autocomplete="current-password" required></label>${err ? `<p class="note dn">${esc(err)}</p>` : ''}<div class="actions"><button class="primary big" type="submit">Open</button></div></form><p class="note">The passcode is the APP_TOKEN secret you set on Cloudflare. It stays on this device.</p></div></div>`;
    $('si').addEventListener('submit', async e => {
      e.preventDefault(); auth.set($('si-p').value.trim());
      try { await this.loadState(); this.boot(); }
      catch (er) { auth.clear(); this.signIn(er.status === 401 ? 'That passcode is not right.' : er.message); }
    });
    $('si-p').focus();
  },

  /* ---------- state: loaded once, saved half a second after the last change, never silently lost ---------- */
  async loadState() { const s = await api('/state'); this.user = s.user; this.version = s.version; this.server = s.server || {}; },
  save() { this.dirty = true; clearTimeout(this.saveT); this.saveT = setTimeout(() => this.flush(), 500); this.render(); },
  async flush() {
    if (this.saving) { await this.saving; if (!this.dirty) return; }
    this.dirty = false;
    this.saving = (async () => {
      try { const r = await api('/state', { method: 'PUT', body: { user: this.user, version: this.version } }); this.version = r.version; }
      catch (e) {
        if (e.status === 409 && e.body?.user) { this.user = e.body.user; this.version = e.body.version; toast('Updated from another device — showing the latest.'); this.html = {}; this.render(); }
        else { this.dirty = true; toast('Not saved: ' + e.message + '. Retrying…'); clearTimeout(this.saveT); this.saveT = setTimeout(() => this.flush(), 5000); }
      }
    })();
    await this.saving; this.saving = null;
  },

  /* ---------- live data: every 20 s while you're looking, backing off when the server is unreachable ---------- */
  stopPoll() { clearTimeout(this.poll.timer); this.poll.timer = 0; },
  async refreshLive() {
    this.stopPoll();
    if (document.visibilityState !== 'visible' || this.poll.busy) return;
    this.poll.busy = true;
    try {
      const l = await api('/live', { timeoutMs: 10000 });
      const newDay = this.live?.signal?.closeDate && l.signal?.closeDate !== this.live.signal.closeDate;
      this.live = l; this.liveAt = Date.now(); this.poll.fails = 0;
      if (newDay) { this.loadChart(); this.loadState().then(() => this.render()).catch(() => {}); }
      this.trackPeak();
    } catch (e) { this.poll.fails++; if (e.status === 401) { this.stopPoll(); return this.signIn('Signed out — enter the passcode again.'); } }
    finally { this.poll.busy = false; }
    this.setPill(); this.render();
    const wait = this.poll.fails ? Math.min(120, 20 * 2 ** (this.poll.fails - 1)) : (this.tk ? 10 : 20);
    if (document.visibilityState === 'visible') this.poll.timer = setTimeout(() => this.refreshLive(), wait * 1000);
  },
  async loadChart() { try { this.chartData = await api('/chart?days=1500'); this.drawChart(); } catch {} },
  setPill() {
    const p = $('live-pill'), m = this.live?.market, age = this.live ? Date.now() - (this.live.marketAt || this.liveAt) : Infinity;
    if (!navigator.onLine) { p.className = 'pill off'; p.textContent = 'Offline'; }
    else if (!this.live) { p.className = 'pill'; p.textContent = this.poll.fails ? 'Reconnecting…' : 'Connecting…'; }
    else if (this.poll.fails || this.live.marketStale || age > 90e3) { p.className = 'pill stale'; p.textContent = 'Delayed · ' + ago(this.live.marketAt); }
    else { p.className = 'pill live'; p.textContent = 'Live · ' + (m?.zar?.src || '—'); }
    $('px-pill').textContent = m?.zar?.px ? 'BTC ' + zar(m.zar.px) : '—';
    const banner = [];
    if (this.poll.fails >= 2) banner.push(['bad', 'Cannot reach the server — showing the last prices. Retrying automatically.']);
    if (m?.errors?.length && !this.poll.fails) banner.push(['', 'One price source is down (' + m.errors.map(esc).join('; ') + ') — using the other.']);
    if (this.live?.signal && !this.live.signal.ok) banner.push(['', 'Trend rule waiting: ' + esc(this.live.signal.why)]);
    if (this.live?.signal?.src && this.live.signal.src !== 'Bitstamp') banner.push(['', 'Price history is coming from the backup source (' + esc(this.live.signal.src) + ').']);
    if (this.user?.paused) banner.push(['', 'Paused — no trades are suggested. Switch it back on in Setup.']);
    this.set('banner', banner.map(([c, t]) => `<div class="banner ${c}">${t}</div>`).join(''));
  },

  /* ---------- derived numbers ---------- */
  px() { return this.live?.market?.zar?.px || null; },
  fx() { return this.live?.market?.fx?.rate || null; },
  sig() { return this.live?.signal || null; },
  fee() { return (this.user.settings?.fee ?? .15) / 100; },
  tradeValue() { const T = this.user.trade, p = this.px(); return (T.cash || 0) + (p ? (T.units || 0) * p : 0); },
  action() {
    if (this.user.paused) return { side: 'none', why: 'Paused' };
    const s = this.sig(); if (!s?.ok) return { side: 'none', why: s?.why || 'Waiting for prices' };
    return E.trendAction({ target: s.target, cash: this.user.trade.cash || 0, units: this.user.trade.units || 0, pxZar: this.px(), fee: this.fee() });
  },
  targets() { return E.PRESETS[this.user.preset]?.targets || E.PRESETS.balanced.targets; },
  cur() { return { ...this.user.main.cur, trade: this.tradeValue() }; },
  year() { return E.planYear(this.user.plan.began); },
  monthly() { return E.monthlyIn(this.user.plan, this.year()); },
  month() { // this month's split: worked out live until you tick something off or add extra, then frozen
    const rec = this.user.main.months[monthKey()];
    if (rec?.add) return { add: rec.add, paid: rec.paid || Object.fromEntries(Object.entries(rec.done || {}).filter(([, v]) => v).map(([k]) => [k, rec.add[k]])), base: rec.base ?? this.monthly(), extra: rec.extra || 0 };
    return { add: E.splitMonth({ targets: this.targets(), cur: this.cur(), amount: this.monthly(), minBuy: E.normPlan(this.user.plan).minBuy }).add, paid: {}, base: this.monthly(), extra: 0 };
  },
  ensureMonth() {
    const M = this.user.main.months, mk = monthKey(); let rec = M[mk];
    if (!rec?.add) { const m = this.month(); rec = M[mk] = { add: { ...m.add }, paid: {}, tfsa: {}, base: m.base, extra: 0 }; }
    if (!rec.paid) { rec.paid = {}; for (const [k, on] of Object.entries(rec.done || {})) if (on) rec.paid[k] = rec.add[k]; delete rec.done; }
    rec.tfsa = rec.tfsa || {};
    const keys = Object.keys(M).sort(); while (keys.length > 36) delete M[keys.shift()];
    return rec;
  },
  tfsa() { const t = this.user.tfsa || (this.user.tfsa = { year: E.taxYear(), used: 0, life: 0 }); if (t.year !== E.taxYear()) { t.year = E.taxYear(); t.used = 0; } return t; },
  tfsaPlan(m) { // where each unticked fund purchase should go: tax-free account first, in TFSA_ORDER
    let room = E.tfsaRoom(this.tfsa()).room; const out = {};
    for (const k of E.TFSA_ORDER) { const left = (m.add[k] || 0) - (m.paid[k] || 0); if (left > 0) { out[k] = Math.min(left, room); room -= out[k]; } }
    return out;
  },
  extraForm() { return `<div class="row" style="margin-top:12px;gap:8px"><input id="mx-amt" type="number" min="0" step="100" inputmode="decimal" placeholder="Extra this month (R)" style="flex:1 1 160px;width:auto"><button data-a="mextra">Add extra</button></div>`; },
  rebal() { return E.rebalance({ targets: this.targets(), cur: this.cur(), exclude: ['trade'], minTotal: E.REBALANCE_MIN_TOTAL }); },
  trackPeak() { const v = this.tradeValue(); if (this.user && v > (this.user.trade.peak || 0) * 1.01 + 1) { this.user.trade.peak = v; this.dirty = true; clearTimeout(this.saveT); this.saveT = setTimeout(() => this.flush(), 2000); } },
  levels() { const s = this.sig(), k = this.fx(); return s?.ok && k ? { sell: s.sellBelow * k, buy: s.buyAbove * k, avg: s.avg * k, close: s.px * k } : null; },
  sigLine() {
    const s = this.sig(), L = this.levels(), p = this.px();
    if (!s?.ok) return s?.why || 'Waiting for prices…';
    const liveGap = L && p ? p / L.avg - 1 : s.gap;
    return `Last daily close ${usd(s.px)} (${s.closeDate}) is ${pct(s.gap)} vs the 200-day average ${usd(s.avg)}. ${s.on ? `Holding since ${s.since || 'before the data starts'}; sells if a daily close falls below ${L ? zar(L.sell) : usd(s.sellBelow)}.` : `In cash since ${s.since || '—'}; buys back if a daily close climbs above ${L ? zar(L.buy) : usd(s.buyAbove)}.`} Live now: ${pct(liveGap)}.`;
  },

  /* ---------- rendering: build a tab once, then swap only the parts whose HTML changed ---------- */
  renderTabs() { $('tabs').innerHTML = SECTIONS.map(s => `<button role="tab" data-a="tab" data-k="${s.id}" aria-selected="${s.id === this.tab}">${s.name}</button>`).join(''); },
  go(id) {
    this.tab = id; try { localStorage.setItem('hive.tab', id); } catch {}
    const s = SECTIONS.find(x => x.id === id);
    $('title').textContent = s.title; $('sub').textContent = s.sub;
    [...$('tabs').children].forEach(b => b.setAttribute('aria-selected', b.dataset.k === id));
    this.html = {}; for (const c of ['chart', 'hChart', 'pChart']) { this[c]?.destroy(); this[c] = null; }
    $('body').innerHTML = this['tab_' + id]();
    if (id === 'trade') { this.chart = makeChart($('chart')); this.drawChart(); }
    if (id === 'research' && Date.now() - this.researchAt > 15 * 60e3) this.loadResearch();
    if (id === 'setup' && !this.status) this.loadStatus();
    if (id === 'history') { this.hChart = makeChart($('hchart')); this.pChart = makeChart($('pchart')); this.loadHistory(); }
    this.render(); scrollTo(0, 0);
  },
  set(id, h) { const el = $(id); if (el && this.html[id] !== h) { el.innerHTML = h; this.html[id] = h; } },
  render() {
    if (!this.user) return;
    const parts = this['live_' + this.tab]?.() || {};
    for (const [id, fn] of Object.entries(parts)) this.set(id, fn());
    if (this.tk) this.renderTicket();
  },
  tile(l, v, s, c) { return `<div class="tile" style="--c:${c}"><small>${l}</small><b class="num">${v}</b><span>${s}</span></div>`; },
  chip(t, c) { return `<span class="chip" style="color:${c}">${esc(t)}</span>`; },

  /* ===== Today ===== */
  tab_today() { return `<div id="td-strip"></div><div id="td-cards"></div><div id="td-run"></div>`; },
  live_today() { return {
    'td-strip': () => { const s = this.sig(), p = this.user.plan, y = this.year();
      return `<div class="strip"><span><small>Budget · year ${y + 1}</small><b>${zar(this.monthly())} a month</b></span><span><small>This month</small><b>${zar(this.month().base + this.month().extra)}</b>${this.month().extra ? ` <small>incl. ${zar(this.month().extra)} extra</small>` : ''}</span><span><small>Trading rule</small><b class="${s?.ok ? (s.on ? 'up' : 'warn') : 'dim'}">${s?.ok ? (s.on ? 'HOLD BITCOIN' : 'OUT · IN CASH') : '—'}</b></span><span><small>Bitcoin now</small><b class="num">${this.px() ? zar(this.px()) : '—'}</b> <small class="${(this.live?.market?.zar?.ch24 || 0) >= 0 ? 'up' : 'dn'}">${this.live?.market?.zar?.ch24 != null ? pct(this.live.market.zar.ch24 / 100) : ''}</small></span></div><p class="note" style="margin:-4px 0 12px">${esc(this.sigLine())}</p>`; },
    'td-cards': () => {
      const out = [], a = this.action(), s = this.sig(), L = this.levels(), m = this.month(), r = this.rebal();
      if (a.side === 'buy' || a.side === 'sell') {
        const buy = a.side === 'buy';
        out.push(`<div class="order ${a.side}">${this.chip('Trading account', buy ? 'var(--ok)' : 'var(--bad)')}<h4>${buy ? 'BUY' : 'SELL'} <b>${zar(a.amount)}</b> of Bitcoin</h4>
          <ol class="plan3"><li class="b"><small>1 · ${buy ? 'Buy' : 'Sell'} at</small><b class="num">${zar(a.limit)}</b><span>limit ${buy ? 'buy' : 'sell'} · ≈ ${btc(a.units)} · now ${zar(this.px())}</span></li>
          <li class="s"><small>2 · ${buy ? 'Exit (stop)' : 'Buys back above'}</small><b class="num">${L ? zar(buy ? L.sell : L.buy) : '—'}</b><span>${buy ? 'if a daily close falls below this, the rule sells it all — you get an alert' : 'the rule buys back if a daily close climbs above this'}</span></li>
          <li><small>3 · Take profit</small><b>${buy ? 'Let it run' : 'Wait in cash'}</b><span>${buy ? 'no fixed target — gains above 70% of the account are trimmed back to 50% automatically' : 'cash sits in a money-market fund earning interest'}</span></li></ol>
          <p class="why">${esc(a.why)}.</p><div class="actions"><button class="primary big" data-a="ticket">Open the ticket ›</button></div></div>`);
      }
      const ids = Object.entries(m.add).filter(([, v]) => v > 0), left = k => (m.add[k] || 0) - (m.paid[k] || 0), tf = this.tfsaPlan(m), T = E.tfsaRoom(this.tfsa());
      const dest = k => { if (k === 'trade') return 'to VALR as cash — the trading rule decides when it buys'; if (k === 'crypto') return 'on VALR — held, not traded';
        const l = left(k), t = tf[k] || 0; if (l <= 0) return ''; return t >= l ? '<b class="up">into your tax-free account</b>' : t > 0 ? `<b class="up">${zar(t)} tax-free</b>, ${zar(l - t)} in a normal account` : 'normal account — this year\'s tax-free limit is used'; };
      if (ids.some(([k]) => left(k) > 0)) out.push(`<div class="order month">${this.chip('Main account', 'var(--gold)')}<h4>THIS MONTH: invest <b>${zar(m.base + m.extra)}</b>${m.extra ? ` <small>(${zar(m.base)} budget + ${zar(m.extra)} extra)</small>` : ''}</h4>
        ${ids.map(([k, v]) => `<div class="mrow ${left(k) <= 0 ? 'done' : ''}"><b>${esc(B[k].name)}</b><b class="amt num">${zar(left(k) > 0 ? left(k) : v)}</b><button data-a="mdone" data-k="${k}" ${left(k) <= 0 ? 'aria-pressed="true"' : ''}>${left(k) <= 0 ? '✓ Done' : 'Done'}</button><span class="what">${esc(B[k].hold)} · ${dest(k) || 'done'}</span></div>`).join('')}
        ${this.extraForm()}
        <p class="why">Money goes to whatever is furthest below its target, at least ${zar(E.normPlan(this.user.plan).minBuy)} a purchase — a bucket that misses out catches up next month, so the mix stays balanced without selling. Tax-free account: ${zar(T.used)} of R${E.TFSA.year.toLocaleString('en-ZA')} used this tax year (from 1 March). “Done” adds it to your holdings here.</p></div>`);
      if (r.due) out.push(`<div class="order reb">${this.chip('Main account', 'var(--sky)')}<h4>REBALANCE</h4><p class="why" style="margin-top:0">Something has drifted more than ${Math.round(E.BAND * 100)} points from its target. Move it back:</p><table><tbody>${r.rows.filter(x => x.move).map(x => `<tr><td><b>${esc(B[x.id].name)}</b></td><td>${pc0(x.pct)} → ${pc0(x.target)}</td><td class="${x.move > 0 ? 'up' : 'dn'}"><b>${x.move > 0 ? 'Buy' : 'Sell'} ${zar(Math.abs(x.move))}</b></td></tr>`).join('')}</tbody></table><div class="actions"><button class="ok" data-a="rebdone">I've rebalanced</button></div></div>`);
      if (out.length) return out.join('');
      return `<div class="wait"><b>Nothing to do today.</b><br>${this.user.main.months[monthKey()]?.add ? 'This month’s money is in — have more to give? ' + this.extraForm() : ''}The trading rule is ${s?.ok ? (s.on ? 'holding Bitcoin' : 'waiting in cash') : 'waiting for prices'}. The server checks again tomorrow at 08:05.</div>`;
    },
    'td-run': () => { const r = this.server.lastRun; return `<p class="note">Daily check: ${r ? `last ran ${ago(r.at)} — ${r.alerts?.length ? r.alerts.length + ' alert(s)' + (r.notified?.sent ? ', sent to Telegram' : '') : 'no alerts'}` : 'has not run yet (first run tomorrow 08:05, or run it now in Setup)'}. Prices ${ago(this.live?.marketAt)}.</p>`; },
  }; },

  /* ===== Trading ===== */
  tab_trade() { const X = E.TESTED; return `<div id="tr-hero"></div>
    <div class="card"><div class="row" style="margin-bottom:8px"><h3 style="margin:0;flex:1">Bitcoin and its 200-day average</h3><div class="range">${[[365, '1Y'], [730, '2Y'], [1460, '4Y']].map(([d, l]) => `<button data-a="range" data-k="${d}" aria-pressed="${d === this.chartDays}">${l}</button>`).join('')}</div></div>
      <canvas id="chart" class="chart" aria-label="Bitcoin daily closes and the 200-day average"></canvas>
      <div class="legend"><span style="--lc:var(--btc)">Bitcoin daily close (US$)</span><span style="--lc:var(--avg)">200-day average</span><span style="--lc:rgba(232,121,249,.35)">±2% buffer</span></div>
      <p class="note">Judged in dollars on completed daily closes, exactly as tested. Traded in rand on VALR.</p></div>
    <div class="cols"><div>
      <div class="card"><h3>Your trading account</h3><div id="tr-acct"></div>
        <div class="form" style="margin-top:12px"><label>Cash waiting (R)<input id="tr-cash" type="number" min="0" step="100" inputmode="decimal"></label><label>Bitcoin held (BTC)<input id="tr-units" type="number" min="0" step="any" inputmode="decimal"></label></div>
        <div class="actions"><button data-a="trsave">Save</button><button data-a="valrsync" id="valr-btn">Read from VALR</button><small>Or log each trade on the ticket.</small></div></div>
      <div class="card"><h3>Ask Claude</h3><label>One short question about the current market<input id="ask-q" maxlength="400" placeholder="What could push it back below the average?"></label><div class="actions"><button data-a="ask">Ask</button><small id="ask-cost"></small></div><div id="ask-a"></div></div>
    </div><div>
      <div class="card"><h3>How the rule did on real prices</h3><table><thead><tr><th></th><th>The rule</th><th>Just holding</th></tr></thead><tbody>
        <tr><td>Yearly growth</td><td class="up"><b>${pct(X.cagr)}</b></td><td>${pct(X.hold.cagr)}</td></tr>
        <tr><td>Worst fall from a high</td><td><b>−${pc0(X.dd)}</b></td><td class="dn">−${pc0(X.hold.dd)}</td></tr>
        <tr><td>Worst calendar year</td><td><b>${pct(X.worstYear)}</b></td><td class="dn">${pct(X.hold.worstYear)}</td></tr>
        <tr><td>Years up</td><td><b>${X.upYears}</b></td><td>—</td></tr><tr><td>Trades</td><td>${X.trades} in 8½ years</td><td>1</td></tr></tbody></table>
        <p class="note">${esc(X.source)}, ${X.from} to ${X.to}, after ${esc(X.costs)}. Since 2023 alone: ${pct(X.since2023.cagr)} a year, worst fall −${pc0(X.since2023.dd)}. With cash earning nothing: ${pct(X.noYield.cagr)}. Expect less in future.</p></div>
      <div class="card"><h3>Guardrails</h3><ul style="margin:0;padding-left:18px;font-size:13px">
        <li><b>Bitcoin only</b> — no small coins, no leverage.</li><li><b>The rule trades, not you</b> — judged once a day on the completed close, with a 2% buffer.</li>
        <li><b>Cash earns</b> — while out, the cash sits in a money-market fund.</li><li><b>Review alarm</b> — a 25% fall from the account's best flags a review (worst in testing: 28%).</li>
        <li><b>Read-only keys</b> — the server can read VALR balances, never trade or withdraw.</li></ul></div>
    </div></div>`; },
  live_trade() { return {
    'tr-hero': () => { const s = this.sig(), a = this.action(); if (!s?.ok) return `<div class="wait">${esc(this.sigLine())}</div>`;
      return `<div class="hero ${s.on ? '' : 'out'}"><div class="lamp"></div><div class="tx"><b>${s.on ? 'HOLD · ABOVE THE AVERAGE' : 'OUT · BELOW THE AVERAGE'}</b><span>${esc(this.sigLine())}</span></div>${a.side !== 'none' ? `<button class="primary big" data-a="ticket">${a.side === 'buy' ? 'Buy' : 'Sell'} ${zar(a.amount)} ›</button>` : ''}</div>`; },
    'tr-acct': () => { const T = this.user.trade, p = this.px(), v = this.tradeValue(), a = this.action(), dd = T.peak > 0 ? 1 - v / T.peak : 0, s = this.sig();
      this.fillInputs();
      return `<div class="stats"><div><small>Worth</small><b class="num">${zar(v)}</b></div><div><small>In Bitcoin</small><b class="num">${p ? zar((T.units || 0) * p) : '—'}</b></div><div><small>Cash</small><b class="num">${zar(T.cash)}</b></div><div><small>Rule wants</small><b>${s?.ok ? Math.round(s.target * 100) + '% BTC' : '—'}</b></div></div>
        <p class="note">${esc(a.why || '')}.</p>${dd >= .25 ? `<p class="banner">Down ${pc0(dd)} from its best — time for a review. The rule's worst fall in testing was 28%.</p>` : ''}
        ${T.log?.length ? `<details style="margin-top:8px"><summary class="dim">Last ${Math.min(10, T.log.length)} trades</summary><table><tbody>${T.log.slice(0, 10).map(x => `<tr><td>${esc(x.d)}</td><td class="${x.side === 'buy' ? 'up' : 'dn'}">${x.side}</td><td class="num">${zar(x.amount)}</td><td class="num">${btc(x.units)} @ ${zar(x.pxZar)}</td></tr>`).join('')}</tbody></table></details>` : ''}`; },
  }; },
  fillInputs() { // only when the field isn't being typed in
    const c = $('tr-cash'), u = $('tr-units'), T = this.user.trade;
    if (c && document.activeElement !== c) c.value = T.cash ? Math.round(T.cash) : '';
    if (u && document.activeElement !== u) u.value = T.units ? +T.units.toFixed(8) : '';
  },
  drawChart() { if (!this.chart || !this.chartData) return; const d = this.chartData, n = d.c.length, from = Math.max(0, n - this.chartDays); this.chart.set({ t: d.t.slice(from), lines: [{ v: d.avg.slice(from), col: '--avg', label: 'avg' }, { v: d.c.slice(from), col: '--btc' }], band: { v: d.avg.slice(from), buffer: E.TREND.buffer }, fmt: (v, full) => full ? usd(v) : '$' + (v >= 1000 ? Math.round(v / 1000) + 'k' : Math.round(v)) }); },

  /* ===== Main ===== */
  tab_main() { const P = E.PRESETS, pr = this.user.preset, T = this.targets(), c = this.user.main.cur;
    return `<div class="presets">${Object.entries(P).map(([k, v]) => `<button data-a="preset" data-k="${k}" aria-pressed="${k === pr}"><b>${esc(v.name)}</b><small>${esc(v.expect)}; ${esc(v.bad)}</small></button>`).join('')}</div>
    <div class="card"><h3>Where every rand goes</h3><table><thead><tr><th>Bucket</th><th>Target</th><th>What goes in</th></tr></thead><tbody>${E.BUCKETS.map(b => `<tr><td><b>${esc(b.name)}</b><br><small>${esc(b.risk)}</small></td><td><b>${Math.round(T[b.id] * 100)}%</b></td><td>${esc(b.hold)}<br><small>${esc(b.how)}</small></td></tr>`).join('')}</tbody></table>
      <p class="note">Crypto in total: at most ${Math.round((T.crypto + T.trade * E.TREND.weight) * 100)}%. Keep 3–6 months of expenses as an emergency fund outside all of this. Information, not financial advice.</p></div>
    <div class="card"><h3>Where you are</h3><div id="mn-bars"></div>
      <div class="form" style="margin-top:12px">${['global', 'sa', 'bonds', 'crypto'].map(k => `<label>${esc(B[k].name)} now (R)<input id="mn-${k}" type="number" min="0" step="100" inputmode="decimal" value="${c[k] || ''}" placeholder="0"></label>`).join('')}</div>
      <div class="actions"><button class="primary" data-a="mnsave">Save values</button><small>Update from your statements once a month.</small></div></div>
    <div class="card"><h3>The money going in</h3><div id="mn-plan"></div></div>
    <div class="card"><h3>What it could grow to</h3><div id="mn-proj"><p class="empty">Working it out…</p></div></div>`; },
  projNow() { // re-run only when the plan or mix changes; off the main thread
    const args = { plan: E.normPlan(this.user.plan), targets: this.targets(), years: 10 }, key = JSON.stringify(args);
    if (this.projKey === key) return; this.projKey = key;
    const done = (k, r) => { if (this.projKey === k) { this.proj = r; this.render(); } };   // ignore answers for a plan that has since changed
    try { if (!this.pw) { this.pw = new Worker(new URL('./projection-worker.js', import.meta.url), { type: 'module' }); this.pw.onmessage = e => done(e.data.key, e.data.r); this.pw.onerror = () => { this.pw = null; this.projKey = null; }; } this.pw.postMessage({ key, args }); }
    catch { import('./projection.js').then(P2 => setTimeout(() => done(key, P2.project(args)), 30)); }
  },
  live_main() { return {
    'mn-bars': () => { const r = E.rebalance({ targets: this.targets(), cur: this.cur() }), rb = this.rebal();
      if (!(r.total > 0)) return '<p class="empty">Enter what you hold below, and tick off each month\'s money on Today.</p>';
      return `<small><span style="color:var(--core)">▮</span> target <span class="up">▬</span> now · total ${zar(r.total)}</small>${r.rows.map(x => `<div class="abar"><span><b>${esc(B[x.id].name)}</b><br><small class="num">${zar(x.now)}</small></span><span class="t"><i class="tg" style="width:${Math.min(100, x.target * 100)}%"></i><i class="nw" style="width:${Math.min(100, x.pct * 100)}%"></i></span><span class="n">${Math.round(x.pct * 100)}% <small>of ${Math.round(x.target * 100)}%</small></span></div>`).join('')}
        <p class="note">${rb.due ? '<b class="warn">Rebalance due</b> — see Today.' : rb.total < E.REBALANCE_MIN_TOTAL ? `Rebalancing starts once the main account holds ${zar(E.REBALANCE_MIN_TOTAL)}; until then each month's money keeps it in shape.` : `In balance — every bucket within ${Math.round(E.BAND * 100)} points.`} The trading account follows its own rule.${this.user.main.rebalancedAt ? ' Last rebalanced ' + ago(this.user.main.rebalancedAt) + '.' : ''}</p>`; },
    'mn-plan': () => { const p = this.user.plan, y = this.year(), T = E.tfsaRoom(this.tfsa()), yearAmt = this.monthly() * 12;
      return `<div class="tiles">${this.tile('This year (year ' + (y + 1) + ')', zar(this.monthly()) + ' a month', zar(yearAmt) + ' a year, plus any extra', 'var(--gold)') + this.tile('Next year', zar(E.monthlyIn(p, y + 1)) + ' a month', zar(E.monthlyIn(p, y + 1) * 12) + ' a year', 'var(--dim)') + this.tile('In 5 years', zar(E.monthlyIn(p, y + 5)) + ' a month', 'if it keeps rising', 'var(--dim)') + this.tile('Tax-free account', zar(T.used) + ' used', `of R${E.TFSA.year.toLocaleString('en-ZA')} this tax year · ${zar(T.life)} of R${E.TFSA.life.toLocaleString('en-ZA')} for life`, 'var(--ok)')}</div>
        <p class="note">${yearAmt * (1 - this.targets().crypto - this.targets().trade) > E.TFSA.year ? `This year the funds part (${zar(yearAmt * (1 - this.targets().crypto - this.targets().trade))}) is more than the tax-free limit, so the app sends global shares there first and the rest to a normal account.` : 'All of this year\'s fund money fits in the tax-free account.'} One debit order a month on payday is all it takes. Change the amounts in Setup.</p>`; },
    'mn-proj': () => { this.projNow(); const r = this.proj; if (!r) return '<p class="empty">Working it out…</p>';
      const at = y => r.rows[y - 1], show = [1, 3, 5, 10].filter(y => y <= r.years), f = at(5) || at(r.years);
      return `<div class="tiles">${this.tile('Paid in over 5 years', zar(f.paid), `${zar(r.flows[0])} → ${zar(r.flows[59] ?? r.flows.at(-1))} a month`, 'var(--dim)') + this.tile('Typical outcome', zar(f.p50), pct(f.irr) + ' a year on your money', 'var(--ok)') + this.tile('Bad case (1 in 10)', zar(f.p10), pc0(f.loss) + ' chance of ending below what you paid in', 'var(--warn)') + this.tile('Good case (1 in 10)', zar(f.p90), 'typical in today\'s money: ' + zar(f.today), 'var(--sky)')}</div>
        <div class="scroll" style="margin-top:10px"><table><thead><tr><th>After</th><th>Paid in</th><th>Bad case</th><th>Typical</th><th>Good case</th><th>Chance below paid in</th></tr></thead><tbody>${show.map(y => { const x = at(y); return `<tr><td><b>${y} year${y > 1 ? 's' : ''}</b></td><td class="num">${zar(x.paid)}</td><td class="num warn">${zar(x.p10)}</td><td class="num up"><b>${zar(x.p50)}</b></td><td class="num">${zar(x.p90)}</td><td>${pc0(x.loss)}</td></tr>`; }).join('')}</tbody></table></div>
        <p class="note">Your budget and your ${esc(E.PRESETS[this.user.preset]?.name)} mix, ${r.paths.toLocaleString('en-ZA')} simulated futures. Extra months you add come on top. ${esc(P2ASSUME)} A range, not a promise — the History tab shows how the same plan did on real prices.</p>`; },
  }; },

  /* ===== History & patterns ===== */
  tab_history() { return `<div id="hs-data"></div><div id="hs-over"></div>
    <div class="card"><div class="row" style="margin-bottom:8px"><h3 style="margin:0;flex:1">Price in rand</h3><button data-a="hlog" aria-pressed="${this.hLog}">Log scale</button></div><div class="range" id="hs-pick" style="flex-wrap:wrap;margin-bottom:8px"></div>
      <canvas id="hchart" class="chart" aria-label="Price history in rand"></canvas><p class="note" id="hs-pnote"></p></div>
    <div id="hs-fut"></div><div class="cols"><div id="hs-corr"></div><div id="hs-season"></div></div>
    <div class="card"><div class="row" style="margin-bottom:8px"><h3 style="margin:0;flex:1">Your plan on real prices</h3><div class="range">${[2015, 2018, 2021].map(y => `<button data-a="repfrom" data-k="${y}" aria-pressed="${y === this.repFrom}">from ${y}</button>`).join('')}</div></div><div id="hs-plan"><p class="empty">Needs the history first.</p></div><canvas id="pchart" class="chart" aria-label="Your plan replayed"></canvas>
      <div class="legend"><span style="--lc:var(--ok)">Worth</span><span style="--lc:var(--dim)">Paid in</span><span style="--lc:var(--sky)">Same money in a 7% deposit</span></div><p class="note" id="hs-pn"></p></div>`; },
  async loadHistory(force) {
    try { this.histStatus = (await api('/history/status')).series; } catch (e) { this.histStatus = { error: e.message }; }
    if (force || !this.hist || Date.now() - this.histAt > 3600e3) {
      try { const ids = (this.histStatus?.length ? this.histStatus : []).filter(x => x.rows).map(x => x.id), all = await Promise.all(ids.map(id => api('/history/series?id=' + id, { timeoutMs: 30000 }))); this.hist = Object.fromEntries(all.map(x => [x.id, x])); this.histAt = Date.now(); this.analyse(); } catch (e) { this.hist = null; this.histErr = e.message; }
    }
    this.render(); this.drawHistory();
  },
  analyse() {
    const Z = P.toZar(this.hist); this.Z = Z; this.ST = {}; for (const id of Object.keys(Z)) this.ST[id] = P.stats(Z[id]);
    this.corr = P.correlations(Z); this.rep = null; this.repKey = null;
    if (!this.hSel || !Z[this.hSel]) this.hSel = Object.keys(Z)[0];
  },
  replayNow() { // cached per plan + preset; ~20 ms, done after the page has painted
    const key = JSON.stringify([this.user.preset, this.user.plan, this.histAt, this.repFrom]);
    if (this.repKey === key || !this.Z) return; this.repKey = key;
    setTimeout(() => { this.rep = P.replay({ S: this.hist, Z: this.Z, plan: this.user.plan, targets: this.targets(), from: this.repFrom + '-01-01' }); this.render(); this.drawHistory(); }, 30);
  },
  drawHistory() {
    if (this.hChart && this.Z?.[this.hSel]) { const z = this.Z[this.hSel], fx = this.hSel === 'usdzar';
      this.hChart.set({ t: z.d.map(d => d * 86400), lines: [{ v: z.v, col: '--btc' }], log: this.hLog && !fx, fmt: (v, full) => fx ? 'R' + v.toFixed(2) : full ? zar(v) : rk(v) }); }
    else this.hChart?.set({ t: [], lines: [], empty: 'No history yet — fetch it above.' });
    const r = this.rep; if (this.pChart && r?.ok) this.pChart.set({ t: r.path.map(x => x.d * 86400), lines: [{ v: r.path.map(x => x.bank), col: '--sky', w: 1.2, dash: [4, 4], label: 'deposit' }, { v: r.path.map(x => x.paid), col: '--dim', w: 1.2, label: 'paid' }, { v: r.path.map(x => x.value), col: '--ok', label: 'worth' }], fmt: (v, full) => full ? zar(v) : rk(v) });
  },
  async fillHistory() {
    if (this.filling) return; this.filling = { id: null, n: 0, errors: [] }; this.render();
    for (const s of this.histStatus?.length ? this.histStatus : []) {
      this.filling.id = s.name;
      for (let i = 0; i < 40; i++) {
        try { const r = await api('/history/fill?series=' + s.id, { method: 'POST', timeoutMs: 30000 }); this.filling.n += r.added; this.filling.to = r.to; this.render(); if (r.done) break; }
        catch (e) { this.filling.errors.push(`${s.name}: ${e.message}`); break; }
      }
    }
    const errs = this.filling.errors; this.filling = null; toast(errs.length ? `Done, with ${errs.length} problem(s) — see the list` : 'History is up to date');
    await this.loadHistory(true);
  },
  live_history() { const H = this.histStatus, ST = this.ST || {}, Z = this.Z || {}, name = id => Z[id]?.name || id;
    if (this.tab === 'history') this.replayNow();
    return {
    'hs-data': () => { if (!H) return '<div class="skel"></div>'; if (H.error) return `<div class="banner bad">${esc(H.error)}</div>`;
      const F = this.filling, empty = H.every(x => !x.rows);
      return `<div class="card"><h3>The data</h3><ul class="checks">${H.map(x => `<li><span class="ic ${x.error ? 'n' : x.rows ? 'y' : 'o'}">${x.error ? '✕' : x.rows ? '✓' : '○'}</span><b>${esc(x.name)}</b><small class="num">${x.rows ? x.rows.toLocaleString('en-ZA') + ' days' : ''}</small><small>${x.rows ? `${esc(x.from)} → ${esc(x.to)} · ` : ''}${esc(x.note || x.source)}${x.error ? ` — <span class="dn">${esc(x.error)}</span>` : ''}</small></li>`).join('')}</ul>
        <div class="actions"><button class="${empty ? 'primary big' : ''}" data-a="hfill" ${F ? 'disabled' : ''}>${F ? `Fetching ${esc(F.id)}… ${F.n.toLocaleString('en-ZA')} days` : empty ? 'Fetch the history (about a minute)' : 'Check for new days'}</button><small>Kept up to date by the server every morning after that.</small></div>
        ${H.some(x => x.error) ? '<p class="note">A ✕ usually means that provider blocks Cloudflare\'s servers. Run <b>npm run backfill</b> from your PC once to fill it from your home internet (DEPLOY.md, step 12).</p>' : ''}</div>`; },
    'hs-over': () => { const ids = P.ITEMS.filter(id => ST[id]?.ok); if (!ids.length) return '';
      return `<div class="card"><h3>How each one has done, in rand</h3><div class="scroll"><table><thead><tr><th>Item</th><th>Growth / yr</th><th>Last 5 yrs</th><th>Worst fall</th><th>Now vs its high</th><th>Up years</th><th>Swings</th></tr></thead><tbody>${ids.map(id => { const s = ST[id];
        return `<tr><td><b>${esc(name(id))}</b><br><small>since ${s.from.slice(0, 4)}</small></td><td class="${s.cagr >= 0 ? 'up' : 'dn'}"><b>${pct(s.cagr)}</b></td><td>${s.cagr5 != null ? pct(s.cagr5) : '—'}</td><td class="dn">−${pc0(s.maxDD)}<br><small>${s.ddAt.slice(0, 7)}</small></td><td>${s.ddNow < .005 ? '<span class="up">at a high</span>' : '−' + pc0(s.ddNow)}</td><td>${s.upYears} of ${s.cal.length}</td><td>${pc0(s.vol)} a year</td></tr>`; }).join('')}</tbody></table></div>
        <p class="note">Growth includes dividends and interest for the funds. "Swings" is how much a typical year moves up or down (volatility). Rand per dollar going up means the rand got weaker, which lifts everything priced in dollars.</p></div>`; },
    'hs-pick': () => P.ITEMS.filter(id => Z[id]).map(id => `<button data-a="hsel" data-k="${id}" aria-pressed="${id === this.hSel}">${esc(name(id))}</button>`).join(''),
    'hs-pnote': () => { const s = ST[this.hSel]; if (!s?.ok) return ''; return `${esc(Z[this.hSel].note || name(this.hSel))}. ${s.from} to ${s.to}. ${s.gap200 != null ? `Now ${pct(s.gap200)} vs its 200-day average.` : ''} ${s.ytd != null ? `This year so far: ${pct(s.ytd)}.` : ''} Best year ${s.best ? s.best.y + ' ' + pct(s.best.r, 0) : '—'}, worst ${s.worst ? s.worst.y + ' ' + pct(s.worst.r, 0) : '—'}.`; },
    'hs-fut': () => { const ids = P.ITEMS.filter(id => ST[id]?.roll1 && id !== 'usdzar'); if (!ids.length) return '';
      const cell = r => r ? `<td class="dn">${pct(r.min, 0)}</td><td><b>${pct(r.med, 0)}</b></td><td class="up">${pct(r.max, 0)}</td><td>${pc0(r.neg)}</td>` : '<td colspan="4" class="dim">not enough years yet</td>';
      return `<div class="card"><h3>If the next years look like the past</h3><div class="scroll"><table><thead><tr><th rowspan="2">Item</th><th colspan="4">Any 12 months</th><th colspan="4">Any 5 years (per year)</th></tr><tr><th>Worst</th><th>Typical</th><th>Best</th><th>Lost money</th><th>Worst</th><th>Typical</th><th>Best</th><th>Lost money</th></tr></thead>
        <tbody>${ids.map(id => `<tr><td><b>${esc(name(id))}</b></td>${cell(ST[id].roll1)}${cell(ST[id].roll5)}</tr>`).join('')}</tbody></table></div>
        <p class="note">Every 12-month and 5-year stretch in the history, start month by start month. This is the honest way to use the past: not a forecast of what comes next, but the range you should be ready for. Notice how the chance of losing money shrinks as the holding period grows — that is why the main account is built to be held, not timed.</p></div>`; },
    'hs-corr': () => { const C = this.corr; if (!C?.ids?.length) return '';
      const col = r => r == null ? 'transparent' : r > 0 ? `rgba(255,107,125,${(r * .55).toFixed(2)})` : `rgba(93,255,176,${(-r * .55).toFixed(2)})`;
      return `<div class="card"><h3>How they move together</h3><div class="scroll"><table><thead><tr><th></th>${C.ids.map(id => `<th>${({ global: 'Global', sa: 'SA shares', bonds: 'Bonds', btc: 'BTC', eth: 'ETH', usdzar: 'Rand' })[id] || esc(id)}</th>`).join('')}</tr></thead><tbody>${C.ids.map((a, i) => `<tr><td><b>${esc(name(a))}</b></td>${C.m[i].map((r, j) => `<td class="num" style="background:${i === j ? 'transparent' : col(r)}">${i === j ? '—' : r == null ? '' : r.toFixed(2)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
        <p class="note">Monthly moves, in rand. 1 = always move together, 0 = unrelated, below 0 = tend to move opposite. Low numbers between buckets are what make the mix steadier than any one part — and a weak rand month often lifts global shares and crypto while SA assets fall.</p></div>`; },
    'hs-season': () => { const s = ST[this.hSel]; if (!s?.ok) return ''; const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], mx = Math.max(...s.months.map(m => Math.abs(m.avg || 0)), .001);
      return `<div class="card"><h3>Month by month · ${esc(name(this.hSel))}</h3>${s.months.map(m => `<div class="abar"><span>${M[m.m - 1]} <small>${m.n} yrs</small></span><span class="t"><i class="nw" style="width:${Math.abs(m.avg || 0) / mx * 100}%;background:${(m.avg || 0) >= 0 ? 'var(--ok)' : 'var(--bad)'}"></i></span><span class="n ${(m.avg || 0) >= 0 ? 'up' : 'dn'}">${m.avg == null ? '—' : pct(m.avg)} <small>${m.pos == null ? '' : pc0(m.pos) + ' up'}</small></span></div>`).join('')}
        <p class="note">Average move in each calendar month. With about ${s.months[0].n} samples per month this is mostly noise — interesting to know, not something to time money on. The plan invests every month regardless.</p></div>`; },
    'hs-plan': () => { const r = this.rep; if (!this.Z) return '<p class="empty">Needs the history first.</p>'; if (!r) return '<p class="empty">Replaying…</p>'; if (!r.ok) return `<p class="empty">${esc(r.why)}</p>`;
      return `<div class="tiles">${this.tile('Paid in', zar(r.paid), `${r.from} → ${r.to}`, 'var(--dim)') + this.tile('Worth at the end', zar(r.value), `${pct(r.value / r.paid - 1, 0)} on what you paid in`, 'var(--ok)') + this.tile('Yearly return on your money', r.irr != null ? pct(r.irr) : '—', `vs 7% deposit: ${zar(r.bank)}`, 'var(--sky)') + this.tile('Worst fall on the way', '−' + pc0(r.maxDD), `the trading rule made ${r.trades} trades`, 'var(--warn)')}</div>`; },
    'hs-pn': () => { const r = this.rep; return r?.ok ? `Your ${esc(E.PRESETS[this.user.preset]?.name)} plan — ${zar(E.normPlan(this.user.plan).monthly)} a month, rising ${zar(E.normPlan(this.user.plan).step)} a month each year — as if you had started on ${r.from}, using the real daily prices above. Includes fund fees (0.45% a year), crypto trading costs, rebalancing and the 200-day rule; before tax.${r.bondsFromCash ? ' Bond history starts later, so that bucket earned 7% cash until it begins.' : ''} One real path, not a forecast: the 5,000-path projection on the Main tab shows the range.` : ''; },
  }; },

  /* ===== Research ===== */
  tab_research() { return `<div id="rs-global"></div><div class="cols"><div class="card"><h3>Trending now</h3><div id="rs-trend"><p class="empty">Loading…</p></div></div><div class="card"><h3>Sectors moving most (24 h)</h3><div id="rs-sec"><p class="empty">Loading…</p></div></div></div><p class="note">From CoinGecko, refreshed every 15 minutes. <b>small</b> = outside the top 200, <b>pump</b> = moved more than 50% in a day — both are where most people lose money. Your plan only owns Bitcoin (and a little Ether) and index funds; this is to stay informed. <button data-a="research">Refresh</button></p>`; },
  async loadResearch() { try { this.research = await api('/research'); this.researchAt = Date.now(); } catch (e) { this.research = { error: e.message }; } this.render(); },
  live_research() { const R = this.research; return {
    'rs-global': () => { const g = R?.global; return g ? `<div class="tiles" style="margin-bottom:12px">${this.tile('All crypto', '$' + (g.mcapUsd / 1e12).toFixed(2) + 'tn', pct((g.ch24 || 0) / 100) + ' in 24 h', (g.ch24 || 0) >= 0 ? 'var(--ok)' : 'var(--bad)') + this.tile('Bitcoin share', (g.btcDom || 0).toFixed(1) + '%', 'of the whole market', 'var(--btc)') + this.tile('Updated', ago(R.at), R.stale ? 'source slow — last good data' : 'CoinGecko', 'var(--dim)')}</div>` : R?.error ? `<div class="banner">${esc(R.error)}</div>` : ''; },
    'rs-trend': () => !R ? '<p class="empty">Loading…</p>' : !R.trending?.length ? '<p class="empty">No data right now.</p>' : `<table><thead><tr><th>Coin</th><th>Rank</th><th>24 h</th></tr></thead><tbody>${R.trending.slice(0, 15).map(c => `<tr><td><b>${esc(c.sym)}</b> <small>${esc(c.name)}</small>${c.flag ? `<span class="flag">${c.flag}</span>` : ''}</td><td>${c.rank < 9999 ? '#' + c.rank : '—'}</td><td class="${c.ch >= 0 ? 'up' : 'dn'}">${pct(c.ch)}</td></tr>`).join('')}</tbody></table>`,
    'rs-sec': () => !R ? '<p class="empty">Loading…</p>' : !R.sectors?.length ? '<p class="empty">No data right now.</p>' : `<table><thead><tr><th>Sector</th><th>Size</th><th>24 h</th></tr></thead><tbody>${R.sectors.map(c => `<tr><td>${esc(c.name)}</td><td>$${(c.cap / 1e9).toFixed(1)}bn</td><td class="${c.ch >= 0 ? 'up' : 'dn'}">${pct(c.ch)}</td></tr>`).join('')}</tbody></table>`,
  }; },

  /* ===== Setup ===== */
  tab_setup() { const p = this.user.plan, s = this.user.settings;
    return `<div class="cols"><div>
      <div class="card"><h3>Your plan</h3><div class="form"><label>Monthly budget, year 1 (R)<input id="st-monthly" type="number" min="0" step="100" value="${E.normPlan(p).monthly}"></label><label>Added each year (R a month)<input id="st-step" type="number" min="0" step="100" value="${E.normPlan(p).step}"></label><label>Keeps rising for (years)<input id="st-rises" type="number" min="1" max="50" step="1" value="${E.normPlan(p).rises}"></label><label>Smallest purchase (R)<input id="st-minbuy" type="number" min="0" step="50" value="${E.normPlan(p).minBuy}"></label><label>Tax-free used this tax year (R)<input id="st-tfsa" type="number" min="0" step="100" value="${Math.round(E.tfsaRoom(this.user.tfsa).used)}"></label><label>Tax-free used, lifetime (R)<input id="st-tfsal" type="number" min="0" step="100" value="${Math.round(this.user.tfsa?.life || 0)}"></label><label>Plan started<input id="st-began" type="date" value="${esc(p.began)}"></label><label>VALR fee per trade (%)<input id="st-fee" type="number" min="0" max="2" step="0.01" value="${s.fee}"></label></div>
        <label class="check" style="margin-top:12px"><input id="st-valr" type="checkbox" ${s.tradeFromValr ? 'checked' : ''}> The daily check reads the trading account from VALR (needs the read-only key)</label>
        <div class="actions"><button class="primary" data-a="stsave">Save</button><button data-a="pause">${this.user.paused ? '▶ Resume suggestions' : '⏸ Pause all suggestions'}</button></div></div>
      <div class="card"><h3>Daily check</h3><p class="note" style="margin-top:0">Runs on the server every morning at 08:05 (South Africa) on the completed daily close, and messages you on Telegram only when there's something to do.</p><div class="actions"><button data-a="run">Run it now (no message)</button><button data-a="tg">Send test message</button></div><div id="st-run"></div></div>
    </div><div>
      <div class="card"><h3>Live connections</h3><div id="st-status"><p class="empty">Checking…</p></div><div class="actions"><button data-a="status">Test again</button></div></div>
      <div class="card"><h3>This device</h3><div class="actions" style="margin-top:0"><button data-a="export">Download my data</button><button data-a="signout">Sign out</button></div><p class="note">Engine ${E.VERSION}. Your data lives in your Cloudflare database; this device keeps only the passcode.</p></div>
    </div></div>`; },
  async loadStatus() { try { this.status = await api('/status', { timeoutMs: 25000 }); } catch (e) { this.status = { error: e.message }; } this.render(); },
  live_setup() { return {
    'st-status': () => { const S = this.status; if (!S) return '<p class="empty">Checking…</p>'; if (S.error) return `<div class="banner bad">${esc(S.error)}</div>`;
      return `<ul class="checks">${S.sources.map(x => `<li><span class="ic ${x.ok ? 'y' : x.ok === false ? 'n' : 'o'}">${x.ok ? '✓' : x.ok === false ? '✕' : '○'}</span><b>${esc(x.name)}</b><small class="num">${x.ms != null ? x.ms + ' ms' : ''}</small><small>${esc(x.info)}</small></li>`).join('')}</ul>`; },
    'st-run': () => { const r = this.runReport; if (!r) return ''; if (r.error) return `<p class="note dn">${esc(r.error)}</p>`;
      return `<table style="margin-top:10px"><tbody><tr><td>Rule</td><td>${r.signal?.ok ? (r.signal.on ? 'IN' : 'OUT') + ' · close ' + esc(r.signal.closeDate) + ' · ' + pct(r.signal.gap) : esc(r.signal?.why)}</td></tr><tr><td>Price</td><td>${zar(r.price?.zar)} (${esc(r.price?.src)})</td></tr><tr><td>Account</td><td>${zar(r.account?.cash)} cash + ${btc(r.account?.units)} (from ${esc(r.account?.src)})</td></tr><tr><td>Action</td><td>${r.action?.side === 'none' ? esc(r.action.why) : `<b>${r.action.side.toUpperCase()} ${zar(r.action.amount)}</b> at ${zar(r.action.limit)}`}</td></tr><tr><td>Would send</td><td>${r.alerts?.length ? r.alerts.map(esc).join('<br>') : 'nothing'}</td></tr></tbody></table>`; },
  }; },

  /* ---------- the ticket: frozen when opened, live price beside it, expires after 10 minutes ---------- */
  openTicket() { const a = this.action(); if (a.side === 'none') return toast('Nothing to trade right now'); this.tk = { a, at: Date.now(), L: this.levels() }; $('sheet').hidden = false; document.body.classList.add('locked'); this.html['sheet-body'] = null; this.renderTicket(); this.refreshLive(); },
  closeTicket() { this.tk = null; $('sheet').hidden = true; document.body.classList.remove('locked'); },
  renderTicket() {
    const tk = this.tk; if (!tk) return; const a = tk.a, buy = a.side === 'buy', p = this.px(), m = this.live?.market?.zar, age = Date.now() - (this.live?.marketAt || 0);
    const expired = Date.now() - tk.at > 10 * 60e3, beyond = p && (buy ? p > a.limit : p < a.limit), L = tk.L;
    this.set('sheet-body', `<header class="tk-h"><div>${this.chip('Trading account', buy ? 'var(--ok)' : 'var(--bad)')}<h2>${buy ? 'Buy' : 'Sell'} Bitcoin</h2></div><button class="tk-x" data-a="tkclose" aria-label="Close">✕</button></header>
      <div class="tk-price"><b class="num">${p ? zar(p) : '—'}</b><span>VALR BTC/ZAR · ${m?.bid ? `bid ${zar(m.bid)} · ask ${zar(m.ask)} · ` : ''}${age < 60e3 ? Math.round(age / 1000) + ' s ago' : ago(this.live?.marketAt)}</span></div>
      ${expired ? `<div class="banner" style="margin-top:10px">This ticket is over 10 minutes old. <button data-a="tkrenew">Refresh the ticket</button></div>` : beyond ? `<div class="banner" style="margin-top:10px">The price has moved ${buy ? 'above' : 'below'} your limit. Place the order anyway and let it wait, or <button data-a="tkrenew">refresh the ticket</button>.</div>` : ''}
      <section class="tk-sec"><h3>The order</h3><div class="grid3">
        <span>Amount</span><b class="num">${zar(a.amount)}</b><span>≈ ${btc(a.units)} after the ${(this.fee() * 100).toFixed(2)}% fee</span>
        <span>Limit price</span><b class="hl num">${zar(a.limit)}</b><span>${buy ? 'pay no more than this (0.3% above the price when the ticket opened)' : 'accept no less than this'}</span></div></section>
      <section class="tk-sec"><h3>After this</h3><div class="grid3">
        <span>${buy ? 'Exit' : 'Buys back'}</span><b class="num ${buy ? 'dn' : 'up'}">${L ? zar(buy ? L.sell : L.buy) : '—'}</b><span>${buy ? 'the rule sells everything if a daily close falls below this — you get an alert, no stop order needed' : 'the rule buys back if a daily close climbs above this'}</span>
        <span>Take profit</span><b>—</b><span>${buy ? 'none fixed: if Bitcoin grows past 70% of the account, the app tells you to trim back to 50%' : 'the cash waits in a money-market fund'}</span></div></section>
      <section class="tk-sec"><h3>On VALR</h3><ol class="steps"><li>Open <b>BTC/ZAR</b> → <b>${buy ? 'Buy' : 'Sell'}</b> → <b>Limit</b>.</li><li>Price <b>${zar(a.limit)}</b>, ${buy ? `amount <b>${zar(a.amount)}</b> (or ${btc(a.units)})` : `amount <b>${btc(a.units)}</b>`}. Choose “Post only” for the lower maker fee if you can wait.</li><li>${buy ? 'If the rand is in your money-market fund, move it to VALR first (ZAR deposits are free).' : 'Once it fills, move the rand to your money-market fund.'}</li><li>Come back and tap <b>I did it</b>.</li></ol></section>
      <section class="tk-sec"><h3>Done it?</h3><div class="form"><label>Price you got (R per BTC)<input id="tk-px" type="number" step="any" inputmode="decimal" placeholder="${Math.round(a.limit)}"></label><label>Rand ${buy ? 'spent' : 'received'}<input id="tk-amt" type="number" step="any" inputmode="decimal" placeholder="${Math.round(a.amount)}"></label></div>
        <div class="actions"><button class="ok big" data-a="tkdone">I did it</button></div><p class="note">Updates your trading account here. Nothing is sent to VALR.</p></section>
      <p class="note">${esc(a.why)}.</p>`);
  },
  logTrade() {
    const tk = this.tk; if (!tk) return; const a = tk.a, T = this.user.trade, fee = this.fee();
    const px = parseFloat($('tk-px').value) || a.limit, amt = parseFloat($('tk-amt').value) || a.amount;
    if (!(px > 0) || !(amt > 0)) return toast('Enter the price and amount');
    if (a.side === 'buy') { const spend = Math.min(T.cash || 0, amt), u = spend / (1 + fee) / px; if (spend <= 0) return toast('No cash in the trading account — add it first'); T.cash -= spend; T.units = (T.units || 0) + u; T.log = [{ d: today(), side: 'buy', amount: spend, units: u, pxZar: px }, ...(T.log || [])].slice(0, 100); }
    else { const u = Math.min(T.units || 0, amt / ((1 - fee) * px)), got = u * px * (1 - fee); T.units -= u; T.cash = (T.cash || 0) + got; T.log = [{ d: today(), side: 'sell', amount: got, units: u, pxZar: px }, ...(T.log || [])].slice(0, 100); }
    T.peak = Math.max(T.peak || 0, this.tradeValue()); this.closeTicket(); toast('Logged'); this.save();
  },

  /* ---------- clicks ---------- */
  async onClick(e) {
    if (e.target.id === 'sheet') return this.closeTicket();
    const el = e.target.closest('[data-a]'); if (!el) return;
    const a = el.dataset.a, k = el.dataset.k, U = this.user, num = id => Math.max(0, parseFloat($(id)?.value) || 0);
    switch (a) {
      case 'tab': return this.go(k);
      case 'ticket': return this.openTicket();
      case 'tkclose': return this.closeTicket();
      case 'tkrenew': this.closeTicket(); return this.openTicket();
      case 'tkdone': return this.logTrade();
      case 'range': this.chartDays = +k; [...el.parentNode.children].forEach(b => b.setAttribute('aria-pressed', b === el)); return this.drawChart();
      case 'mdone': { const rec = this.ensureMonth(), v = rec.add[k] || 0, paid = rec.paid[k] || 0, tf = this.tfsa();
        const bump = d => { if (k === 'trade') U.trade.cash = Math.max(0, (U.trade.cash || 0) + d); else U.main.cur[k] = Math.max(0, (U.main.cur[k] || 0) + d); };
        if (v - paid > 0) { const d = v - paid; rec.paid[k] = v; bump(d); if (E.TFSA_ORDER.includes(k)) { const t = Math.min(d, E.tfsaRoom(tf).room); tf.used += t; tf.life = (tf.life || 0) + t; rec.tfsa[k] = (rec.tfsa[k] || 0) + t; } }
        else { bump(-paid); rec.paid[k] = 0; const t = rec.tfsa[k] || 0; tf.used = Math.max(0, tf.used - t); tf.life = Math.max(0, (tf.life || 0) - t); rec.tfsa[k] = 0; }
        return this.save(); }
      case 'mextra': { const x = Math.round(num('mx-amt') / 10) * 10; if (x < 10) return toast('Enter the extra amount');
        const rec = this.ensureMonth(), cur = this.cur();
        for (const b of Object.keys(rec.add)) cur[b] = (cur[b] || 0) + Math.max(0, (rec.add[b] || 0) - (rec.paid[b] || 0));   // count what is already planned
        const { add } = E.splitMonth({ targets: this.targets(), cur, amount: x, minBuy: E.normPlan(U.plan).minBuy });
        for (const [b, v] of Object.entries(add)) rec.add[b] = (rec.add[b] || 0) + v; rec.extra = (rec.extra || 0) + x;
        toast(`${zar(x)} added and split`); return this.save(); }
      case 'rebdone': { const r = this.rebal(); for (const x of r.rows) if (x.move) U.main.cur[x.id] = Math.max(0, (U.main.cur[x.id] || 0) + x.move); U.main.rebalancedAt = Date.now(); toast('Rebalanced'); return this.save(); }
      case 'preset': U.preset = k; this.save(); return this.go('main');
      case 'mnsave': for (const b of ['global', 'sa', 'bonds', 'crypto']) U.main.cur[b] = num('mn-' + b); toast('Saved'); return this.save();
      case 'trsave': U.trade.cash = num('tr-cash'); U.trade.units = num('tr-units'); U.trade.peak = Math.max(U.trade.peak || 0, this.tradeValue()); toast('Saved'); return this.save();
      case 'valrsync': { el.disabled = true; try { const b = (await api('/balances')).balances; U.trade.cash = b.ZAR?.available || 0; U.trade.units = b.BTC?.total || 0; toast(`From VALR: ${zar(U.trade.cash)} + ${btc(U.trade.units)}`); this.save(); } catch (er) { toast(er.message); } el.disabled = false; return; }
      case 'ask': { const q = $('ask-q').value.trim(); if (!q) return; el.disabled = true; this.set('ask-a', '<p class="note">Thinking…</p>');
        try { const r = await api('/ask', { method: 'POST', body: { question: q }, timeoutMs: 30000 }); this.set('ask-a', `<div class="answer">${esc(r.answer)}</div>`); $('ask-cost').textContent = `$${r.cost.toFixed(4)} · $${r.usage.usd.toFixed(3)} of $${r.budget} this month`; }
        catch (er) { this.set('ask-a', `<p class="note dn">${esc(er.message)}</p>`); } el.disabled = false; return; }
      case 'hfill': return this.fillHistory();
      case 'hsel': this.hSel = k; this.render(); return this.drawHistory();
      case 'repfrom': this.repFrom = +k; [...el.parentNode.children].forEach(b => b.setAttribute('aria-pressed', b === el)); this.rep = null; this.render(); return;
      case 'hlog': this.hLog = !this.hLog; el.setAttribute('aria-pressed', this.hLog); return this.drawHistory();
      case 'research': this.research = null; this.render(); return this.loadResearch();
      case 'stsave': { const began = $('st-began').value, fee = Math.min(2, num('st-fee'));
        if (!/^\d{4}-\d{2}-\d{2}$/.test(began)) return toast('Pick the start date');
        U.plan = { monthly: num('st-monthly'), step: num('st-step'), rises: Math.max(1, Math.round(num('st-rises')) || 50), minBuy: num('st-minbuy'), began };
        const tf = this.tfsa(); tf.used = num('st-tfsa'); tf.life = Math.max(num('st-tfsal'), tf.used);
        const rec = U.main.months[monthKey()]; if (rec && !Object.values(rec.paid || rec.done || {}).some(Boolean)) delete U.main.months[monthKey()];   // nothing ticked yet: re-split with the new budget
        Object.assign(U.settings, { fee, tradeFromValr: $('st-valr').checked }); toast('Saved'); return this.save(); }
      case 'pause': U.paused = !U.paused; this.save(); this.setPill(); return this.go('setup');
      case 'status': this.status = null; this.render(); return this.loadStatus();
      case 'run': el.disabled = true; try { this.runReport = await api('/run', { method: 'POST', timeoutMs: 30000 }); } catch (er) { this.runReport = { error: er.message }; } el.disabled = false; return this.render();
      case 'tg': try { await api('/notify/test', { method: 'POST' }); toast('Sent — check Telegram'); } catch (er) { toast(er.message); } return;
      case 'export': { const blob = new Blob([JSON.stringify({ exported: new Date().toISOString(), user: U }, null, 2)], { type: 'application/json' }), url = URL.createObjectURL(blob), l = document.createElement('a'); l.href = url; l.download = `hive-invest-${today()}.json`; l.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); return; }
      case 'signout': await this.flush(); auth.clear(); location.reload(); return;
    }
  },
};

if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
window.App = App; // for the browser console and tests
App.start();
