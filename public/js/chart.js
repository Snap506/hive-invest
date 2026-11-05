/* A small, fast line chart on canvas. Redraws only when the data or the size changes; pixel ratio capped at 2.
   set({ t: [unix s], lines: [{ v: [...], col: '--btc', w: 1.6 }], band: { v: [...], buffer: .02 }, fmt: v => '…', log: false }) */
export function makeChart(canvas) {
  let data = null, w = 0, h = 0, raf = 0, hover = -1;
  const ctx = canvas.getContext('2d');
  const css = n => n.startsWith('--') ? getComputedStyle(document.documentElement).getPropertyValue(n).trim() : n;
  const draw = () => {
    raf = 0;
    const r = canvas.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
    if (!r.width) return;
    if (r.width !== w || r.height !== h) { w = r.width; h = r.height; canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
    if (!data || data.t.length < 2) { ctx.fillStyle = css('--dim'); ctx.font = '13px system-ui'; ctx.fillText(data?.empty || 'Loading prices…', 12, 24); return; }
    const { t, lines, band, log } = data, fmt = data.fmt || (v => '$' + (v >= 1000 ? Math.round(v / 1000) + 'k' : Math.round(v))), n = t.length, L = 50, R = 8, T = 10, B = 22;
    const f = log ? Math.log : x => x, inv = log ? Math.exp : x => x;
    let lo = Infinity, hi = -Infinity;
    const scan = v => { if (v != null && v > (log ? 0 : -Infinity)) { const y = f(v); if (y < lo) lo = y; if (y > hi) hi = y; } };
    for (const l of lines) for (let i = 0; i < n; i++) scan(l.v[i]);
    if (band) for (let i = 0; i < n; i++) if (band.v[i] != null) { scan(band.v[i] * (1 + band.buffer)); scan(band.v[i] * (1 - band.buffer)); }
    if (!(hi > lo)) { hi = lo + 1; }
    const pad = (hi - lo) * .06, floor = lo; lo -= pad; hi += pad; if (!log && floor >= 0) lo = Math.max(0, lo);
    const X = i => L + (i / (n - 1)) * (w - L - R), Y = v => T + (1 - (f(v) - lo) / (hi - lo)) * (h - T - B);
    ctx.strokeStyle = 'rgba(140,165,255,.09)'; ctx.fillStyle = css('--dim'); ctx.font = '11px system-ui'; ctx.lineWidth = 1;
    for (let k = 0; k <= 4; k++) { const v = inv(lo + (hi - lo) * k / 4), y = Y(v); ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(w - R, y); ctx.stroke(); ctx.fillText(fmt(v), 2, y + 4); }
    // year labels, thinned to fit
    const yrs = []; let py = null; for (let i = 0; i < n; i++) { const y = new Date(t[i] * 1000).getUTCFullYear(); if (py !== null && y !== py) yrs.push([i, y]); py = y; }
    const every = Math.max(1, Math.ceil(yrs.length * 40 / (w - L))); ctx.textAlign = 'center';
    yrs.forEach(([i, y], j) => { if (j % every === 0) ctx.fillText(y, X(i), h - 6); }); ctx.textAlign = 'left';
    if (band) {
      ctx.fillStyle = 'rgba(232,121,249,.10)'; ctx.beginPath(); let s = false;
      for (let i = 0; i < n; i++) if (band.v[i] != null) { const y = Y(band.v[i] * (1 + band.buffer)); s ? ctx.lineTo(X(i), y) : (ctx.moveTo(X(i), y), s = true); }
      for (let i = n - 1; i >= 0; i--) if (band.v[i] != null) ctx.lineTo(X(i), Y(band.v[i] * (1 - band.buffer)));
      ctx.closePath(); ctx.fill();
    }
    for (const l of lines) { ctx.strokeStyle = css(l.col); ctx.lineWidth = l.w || 1.6; ctx.setLineDash(l.dash || []); ctx.beginPath(); let s = false; for (let i = 0; i < n; i++) { const v = l.v[i]; if (v == null || (log && v <= 0)) { s = false; continue; } s ? ctx.lineTo(X(i), Y(v)) : (ctx.moveTo(X(i), Y(v)), s = true); } ctx.stroke(); }
    ctx.setLineDash([]);
    if (hover >= 0 && hover < n) {
      const x = X(hover); ctx.strokeStyle = 'rgba(230,235,255,.35)'; ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, h - B); ctx.stroke();
      const txt = new Date(t[hover] * 1000).toISOString().slice(0, 10) + '  ' + lines.filter(l => l.v[hover] != null).map(l => (l.label ? l.label + ' ' : '') + fmt(l.v[hover], true)).join('  ');
      ctx.font = '12px system-ui'; const tw = ctx.measureText(txt).width + 12, bx = Math.min(Math.max(L, x - tw / 2), w - R - tw);
      ctx.fillStyle = 'rgba(10,15,34,.95)'; ctx.fillRect(bx, T, tw, 20); ctx.fillStyle = css('--ink'); ctx.fillText(txt, bx + 6, T + 14);
    }
  };
  const soon = () => { if (!raf) raf = requestAnimationFrame(draw); };
  const ro = new ResizeObserver(soon); ro.observe(canvas);
  canvas.addEventListener('pointermove', e => { if (!data) return; const r = canvas.getBoundingClientRect(), i = Math.round((e.clientX - r.left - 50) / (r.width - 58) * (data.t.length - 1)); if (i !== hover) { hover = i; soon(); } });
  canvas.addEventListener('pointerleave', () => { hover = -1; soon(); });
  return { set(d) { data = d; hover = -1; soon(); }, redraw: soon, destroy() { ro.disconnect(); } };
}
