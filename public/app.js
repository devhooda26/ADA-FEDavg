'use strict';
const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const f3 = (v) => (v == null ? '—' : Number(v).toFixed(3));
const pct = (v) => (v == null ? '—' : (v * 100).toFixed(1) + '%');
const when = (t) => (t ? new Date(t).toLocaleString() : '—');
const PAL = ['#64748B', '#0891B2', '#7C3AED', '#DB2777', '#B45309', '#059669', '#2563EB', '#E11D48', '#0D9488', '#6366F1', '#EA580C', '#65A30D'];
const ACTIVE = ['queued', 'preparing', 'training', 'aggregating', 'evaluating'];
const CLS = ['benign', 'dos', 'probe', 'r2l', 'u2r'], CCOL = ['#64748B', '#0891B2', '#7C3AED', '#DB2777', '#B45309'];
let user = null, flash = '', timer = null;

async function api(path, o = {}) {
  const r = await fetch('/api' + path, { credentials: 'include', method: o.method || 'GET', headers: { 'Content-Type': o.raw ? 'application/octet-stream' : 'application/json' }, body: o.raw ? o.raw : o.body === undefined ? undefined : JSON.stringify(o.body) }).catch(() => { throw new Error('Cannot reach the server. Check that it is running.'); });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401 && user && !path.startsWith('/auth/')) { user = null; flash = 'Your session has expired. Please sign in again.'; go('/login'); }
    const e = new Error(j.details?.join(' ') || j.error || 'Request failed'); e.status = r.status; e.code = j.code; throw e;
  }
  return j;
}
const say = (m, silent) => { $('#live').textContent = ''; setTimeout(() => ($('#live').textContent = m), 30); if (!silent) toast(m); };
const label = (t) => `<div class="label small-caps">${t}</div>`;
const isRunner = () => user && ['admin', 'researcher'].includes(user.role);

// ---------- preferences: theme, motion, text size (saved on this device) ----------
const root = document.documentElement;
const getPref = (k, d) => { try { return localStorage.getItem('ada_' + k) || d; } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem('ada_' + k, v); } catch { /* private mode: keep going */ } };
const motionOn = () => root.dataset.motion !== 'reduced';
function applyTheme(p) {
  setPref('theme', p);
  const dark = p === 'dark' || (p === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  if (motionOn()) { root.classList.add('theming'); setTimeout(() => root.classList.remove('theming'), 450); }
  root.dataset.theme = dark ? 'dark' : 'light';
}
function applyMotion(p) {
  setPref('motion', p);
  root.dataset.motion = p === 'reduced' || (p === 'system' && matchMedia('(prefers-reduced-motion: reduce)').matches) ? 'reduced' : 'full';
}
function applySize(p) { setPref('size', p); root.dataset.size = p; }
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => getPref('theme', 'system') === 'system' && applyTheme('system'));
matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => { if (getPref('motion', 'system') === 'system') { applyMotion('system'); renderNav(); } });
const svg = (inner) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const ICONS = {
  light: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  dark: svg('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'),
  system: svg('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>'),
  motionOn: svg('<path d="M3 12c2-6 4-6 6 0s4 6 6 0 4-6 6 0"/>'),
  motionOff: svg('<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>'),
};
// segmented radio group (keyboard accessible: arrow keys move the selection, Tab leaves the group)
const seg = (name, legendText, opts, cur) => `<fieldset class="seg" data-pref="${name}"><legend class="small-caps">${legendText}</legend><div class="segrow">${opts.map(([v, l, d]) =>
  `<label class="segopt"><input type="radio" name="${name}" value="${v}" ${v === cur ? 'checked' : ''}><span><b>${l}</b>${d ? `<small>${d}</small>` : ''}</span></label>`).join('')}</div></fieldset>`;

// ---------- toasts, loading states, route bar ----------
function toast(msg) {
  const box = $('#toasts'); if (!box) return;
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; box.append(t);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, 3800);
}
const skeleton = () => '<div class="sk-wrap" aria-busy="true" aria-label="Loading"><div class="sk sk-h"></div><div class="sk-row"><div class="sk sk-c"></div><div class="sk sk-c"></div><div class="sk sk-c"></div></div><div class="sk sk-t"></div><div class="sk sk-t"></div><div class="sk sk-t short"></div></div>';
let barT;
const barStart = () => { const b = $('#rbar'); if (!b) return; clearTimeout(barT); b.classList.remove('done'); b.style.width = '12%'; barT = setTimeout(() => (b.style.width = '70%'), 120); };
const barDone = () => { const b = $('#rbar'); if (!b) return; clearTimeout(barT); b.style.width = '100%'; b.classList.add('done'); barT = setTimeout(() => (b.style.width = '0'), 450); };
let quiet = false; // true while a background refresh re-renders, so animations do not replay every few seconds

// scroll reveal + count-up (both skipped when motion is reduced, and on background refreshes)
function countUp(scope) {
  scope.querySelectorAll('.big, .stat b').forEach((el) => {
    if (el.dataset.counted) return; el.dataset.counted = '1';
    const txt = el.textContent, m = txt.match(/-?\d+(\.\d+)?/); if (!m) return;
    const end = parseFloat(m[0]), dec = m[1] ? m[1].length - 1 : 0, pre = txt.slice(0, m.index), post = txt.slice(m.index + m[0].length), t0 = performance.now();
    const step = (t) => { const k = Math.min(1, (t - t0) / 900), e = 1 - Math.pow(1 - k, 3); el.textContent = k < 1 ? pre + (end * e).toFixed(dec) + post : txt; if (k < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  });
}
function afterRender() {
  const main = $('#main'), q = main.classList.contains('quiet'), els = main.querySelectorAll('[data-reveal]:not(.in)');
  if (q || !motionOn() || !('IntersectionObserver' in window)) els.forEach((e) => e.classList.add('in'));
  else {
    const io = new IntersectionObserver((ents) => ents.forEach((en) => { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } }), { threshold: 0.12 });
    els.forEach((e) => io.observe(e)); setTimeout(() => els.forEach((e) => e.classList.add('in')), 2500); // safety net
  }
  if (!q && motionOn()) countUp(main);
}

function confirmDlg(msg) {
  return new Promise((res) => {
    const d = document.createElement('dialog');
    d.innerHTML = `<form method="dialog"><p>${esc(msg)}</p><div class="cta" style="justify-content:flex-end"><button class="btn btn-s" value="no">Cancel</button><button class="btn btn-p" value="yes">Confirm</button></div></form>`;
    document.body.append(d); d.showModal();
    d.addEventListener('close', () => { res(d.returnValue === 'yes'); d.remove(); });
  });
}

function renderNav() {
  const nav = $('#nav'), th = getPref('theme', 'system'), nextTh = { light: 'dark', dark: 'system', system: 'light' }[th], on = motionOn();
  nav.innerHTML = `<button class="btn btn-g iconbtn" id="tt" aria-label="Theme: ${th}. Switch to ${nextTh}." title="Theme: ${th}">${ICONS[th]}<span class="tl small-caps">${th}</span></button>
    <button class="btn btn-g iconbtn" id="mt" aria-pressed="${on}" aria-label="Animations ${on ? 'on' : 'off'}. Press to turn ${on ? 'off' : 'on'}." title="Animations ${on ? 'on' : 'off'}">${on ? ICONS.motionOn : ICONS.motionOff}<span class="tl small-caps">motion ${on ? 'on' : 'off'}</span></button>
    ${user ? `<a class="btn btn-g" href="/app">Dashboard</a><button class="btn btn-g" id="out">Sign out</button>` : `<a class="btn btn-g" href="/login">Sign in</a><a class="btn btn-p" href="/register">Create account</a>`}`;
  $('#tt').onclick = () => { applyTheme(nextTh); renderNav(); say('Theme: ' + nextTh, true); $('#tt').focus(); };
  $('#mt').onclick = () => { applyMotion(on ? 'reduced' : 'full'); renderNav(); say('Animations ' + (on ? 'off' : 'on'), true); $('#mt').focus(); };
  if ($('#out')) $('#out').onclick = async () => { await api('/auth/logout', { method: 'POST', body: {} }); user = null; go('/'); };
}
$('#burger').onclick = () => { const o = $('#nav').classList.toggle('open'); $('#burger').setAttribute('aria-expanded', o); };

// ---------- charts ----------
function groupedBars(groups, series, max = 0.7) {
  const W = 640, H = 280, base = 240, top = 30, bw = 36, gw = 200;
  let o = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Macro-F1 by method and skew level; exact values are in the table"><line x1="30" x2="${W}" y1="${base}" y2="${base}" stroke="var(--border)"/>`;
  groups.forEach((g, gi) => {
    series.forEach((s, i) => {
      const v = s.vals[gi]; if (v == null) return;
      const h = (v / max) * (base - top), x = 40 + gi * gw + i * (bw + 6);
      o += `<rect class="bar" style="--i:${gi * series.length + i}" x="${x}" y="${base - h}" width="${bw}" height="${h}" fill="${s.color}"/><text class="v" x="${x + bw / 2}" y="${base - h - 6}" text-anchor="middle">${v.toFixed(2)}</text>`;
    });
    o += `<text x="${40 + gi * gw + (series.length * (bw + 6)) / 2}" y="${base + 20}" text-anchor="middle">${g.toUpperCase()}</text>`;
  });
  return o + `</svg><p class="small-caps legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</p>`;
}
function lineChart(hist) {
  if (!hist?.length) return '<p class="muted">No rounds recorded yet.</p>';
  const W = 640, H = 240, L = 44, B = 200, T = 16, n = hist.length;
  const X = (i) => L + (n === 1 ? 0 : (i / (n - 1)) * (W - L - 16)), Y = (v) => B - v * (B - T);
  const pts = hist.map((h, i) => `${X(i)},${Y(h.val_macro_f1)}`).join(' ');
  let g = ''; [0, .25, .5, .75, 1].forEach((t) => (g += `<line x1="${L}" x2="${W - 16}" y1="${Y(t)}" y2="${Y(t)}" stroke="var(--border)"/><text x="${L - 6}" y="${Y(t) + 4}" text-anchor="end">${t.toFixed(2)}</text>`));
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Validation macro-F1 per round, from ${hist[0].val_macro_f1.toFixed(3)} to ${hist[n - 1].val_macro_f1.toFixed(3)}">${g}<polyline class="ln" pathLength="1" fill="none" stroke="var(--accent)" stroke-width="2" points="${pts}"/>${hist.map((h, i) => `<circle class="dot" cx="${X(i)}" cy="${Y(h.val_macro_f1)}" r="3" fill="var(--accent)"><title>Round ${h.round}: ${h.val_macro_f1.toFixed(3)}</title></circle>`).join('')}<text x="${W / 2}" y="${H - 6}" text-anchor="middle">COMMUNICATION ROUND (1–${hist[n - 1].round})</text></svg>`;
}
const table = (cap, head, rows) => `<div class="tw"><table><caption class="small-caps">${cap}</caption><thead><tr>${head.map((h) => `<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
const stack = (d, cl = CLS) => `<div class="stack" role="img" aria-label="${cl.map((c, i) => `${c} ${(d[i] * 100).toFixed(0)}%`).join(', ')}">${d.map((v, i) => `<span style="width:${v * 100}%;background:${PAL[i % PAL.length]}"></span>`).join('')}</div>`;
const legend = (cl = CLS) => `<p class="small-caps legend">${cl.map((c, i) => `<span><i style="background:${PAL[i % PAL.length]}"></i>${esc(c)}</span>`).join('')}</p>`;
const badge = (s) => `<span class="badge st-${s}">${s}</span>`;

// ---------- public pages ----------
let wi = 0;
const words = (t) => t.split(' ').map((w) => `<span class="w" style="--i:${wi++}">${esc(w)}</span>`).join(' ');
// ---------- illustrations (hand-built SVG; colours come from CSS tokens so both themes work) ----------
const grads = (p) => `<defs><linearGradient id="${p}1" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#06B6D4"/><stop offset="1" stop-color="#8B5CF6"/></linearGradient>
  <linearGradient id="${p}2" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#8B5CF6"/><stop offset="1" stop-color="#EC4899"/></linearGradient>
  <radialGradient id="${p}3" cx=".35" cy=".3" r=".9"><stop offset="0" stop-color="#A5F3FC"/><stop offset=".45" stop-color="#6366F1"/><stop offset="1" stop-color="#7C3AED"/></radialGradient>
  <radialGradient id="${p}4"><stop offset="0" stop-color="#8B5CF6" stop-opacity=".55"/><stop offset="1" stop-color="#8B5CF6" stop-opacity="0"/></radialGradient></defs>`;
const DIST = [[.9, .05, .03, .02, 0], [.85, .08, .04, .02, .01], [.2, .7, .07, .02, .01], [.3, .6, .05, .03, .02], [.3, .1, .1, .4, .1], [.25, .08, .12, .45, .1]];
const miniBars = (d, x, y, w, h) => { const bw = w / d.length - 3; return d.map((v, i) => `<rect x="${x + i * (bw + 3)}" y="${y + h - Math.max(2, v * h)}" width="${bw}" height="${Math.max(2, v * h)}" rx="2" fill="${CCOL[i]}"/>`).join(''); };
const heroArt = () => {
  const ys = [28, 92, 156, 220, 284, 348], hubs = [[300, 84], [300, 200], [300, 316]], grp = [0, 0, 1, 1, 2, 2], O = [498, 200];
  return `<svg class="hero-art" viewBox="0 0 580 420" role="img" aria-label="Diagram: six clients, each with its own mix of attack classes, are grouped by similarity into three clusters, and the clusters feed one global model">${grads('hg')}
    ${ys.map((y, i) => `<path class="base" d="M128 ${y + 22} C220 ${y + 22} 210 ${hubs[grp[i]][1]} ${hubs[grp[i]][0]} ${hubs[grp[i]][1]}"/><path class="flow" d="M128 ${y + 22} C220 ${y + 22} 210 ${hubs[grp[i]][1]} ${hubs[grp[i]][0]} ${hubs[grp[i]][1]}"/>`).join('')}
    ${hubs.map((h) => `<path class="base" d="M${h[0]} ${h[1]} C400 ${h[1]} 400 ${O[1]} ${O[0] - 36} ${O[1]}"/><path class="flow f2" d="M${h[0]} ${h[1]} C400 ${h[1]} 400 ${O[1]} ${O[0] - 36} ${O[1]}"/>`).join('')}
    ${ys.map((y, i) => `<g class="float" style="--d:${-i * 0.7}s"><rect class="gcard" x="12" y="${y}" width="116" height="46" rx="12"/><text x="24" y="${y + 17}" style="font-size:8px">C${i + 1}</text>${miniBars(DIST[i], 52, y + 8, 64, 30)}</g>`).join('')}
    ${hubs.map((h, i) => `<rect class="hub" style="--d:${i * 200}ms" x="${h[0] - 17}" y="${h[1] - 17}" width="34" height="34" rx="10" transform="rotate(45 ${h[0]} ${h[1]})"/><text class="tag" x="${h[0]}" y="${h[1] + 4}" text-anchor="middle" style="font-size:10px">${i + 1}</text>`).join('')}
    <circle class="halo" cx="${O[0]}" cy="${O[1]}" r="82"/><circle class="ring" cx="${O[0]}" cy="${O[1]}" r="36"/><circle class="ring r2" cx="${O[0]}" cy="${O[1]}" r="36"/><circle class="orb" cx="${O[0]}" cy="${O[1]}" r="34"/>
    <path d="M${O[0] - 13} ${O[1] + 2} l9 9 l17 -19" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="70" y="412" text-anchor="middle">CLIENTS</text><text x="300" y="412" text-anchor="middle">CLUSTERS</text><text x="${O[0]}" y="412" text-anchor="middle">GLOBAL MODEL</text></svg>`;
};
const authArt = () => `<svg class="auth-art" viewBox="0 0 84 84" aria-hidden="true">${grads('au')}<circle cx="42" cy="42" r="40" fill="url(#au4)"/><circle cx="42" cy="42" r="22" fill="url(#au3)"/><g fill="none" stroke="url(#au1)" stroke-width="2.4" stroke-linecap="round"><circle cx="42" cy="42" r="32" stroke-dasharray="2 7"/></g><circle cx="12" cy="30" r="3.5" fill="#06B6D4"/><circle cx="72" cy="26" r="3" fill="#EC4899"/><circle cx="60" cy="70" r="3.5" fill="#8B5CF6"/><path d="M33 43l7 7 12-14" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const stepArt = [
  () => `<svg class="ill" viewBox="0 0 240 130" role="img" aria-label="Three clients, each summarised by a small histogram of attack classes">${[0, 2, 4].map((k, i) => `<rect class="glassf" x="${10 + i * 76}" y="14" width="68" height="84" rx="12"/><text x="${22 + i * 76}" y="32" style="fill:var(--mfg)">C${i + 1}</text>${miniBars(DIST[k], 22 + i * 76, 42, 44, 44)}`).join('')}<text x="120" y="120" text-anchor="middle" style="fill:var(--mfg)">LOCAL CLASS MIX</text></svg>`,
  () => `<svg class="ill" viewBox="0 0 240 130" role="img" aria-label="Clients plotted as points and grouped into three clusters by distribution similarity">${grads('sc')}
    <ellipse cx="62" cy="52" rx="42" ry="30" fill="#06B6D4" opacity=".16"/><ellipse cx="148" cy="40" rx="40" ry="26" fill="#8B5CF6" opacity=".16"/><ellipse cx="156" cy="92" rx="42" ry="26" fill="#EC4899" opacity=".16"/>
    ${[[48, 44], [68, 60], [58, 38], [140, 34], [160, 48], [150, 28], [146, 92], [168, 100], [166, 84]].map(([x, y], i) => `<circle cx="${x}" cy="${y}" r="6" fill="${['#06B6D4', '#8B5CF6', '#EC4899'][Math.floor(i / 3)]}"/>`).join('')}
    <path class="ln2" d="M80 52 L120 44" stroke-dasharray="3 4"/><path class="ln2" d="M110 70 L140 84" stroke-dasharray="3 4"/><text x="120" y="122" text-anchor="middle" style="fill:var(--mfg)">JS DIVERGENCE</text></svg>`,
  () => `<svg class="ill" viewBox="0 0 240 130" role="img" aria-label="Cluster models are averaged inside each cluster, then combined with equal weight into one global model">${grads('ag')}
    ${[[44, 30, '#06B6D4'], [44, 65, '#8B5CF6'], [44, 100, '#EC4899']].map(([x, y, c]) => `<circle cx="${x}" cy="${y - 4}" r="12" fill="${c}" opacity=".9"/><path d="M${x + 14} ${y - 4} C110 ${y - 4} 120 56 168 56" fill="none" stroke="url(#ag1)" stroke-width="2" stroke-dasharray="3 6"/>`).join('')}
    <circle cx="190" cy="56" r="30" fill="url(#ag4)"/><circle cx="190" cy="56" r="20" fill="url(#ag3)"/><path d="M182 57l6 6 11-12" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><text x="120" y="124" text-anchor="middle" style="fill:var(--mfg)">EQUAL CLUSTER WEIGHT</text></svg>`];
const donut = (vals, cols, id, centre) => { const R = 52, C = 2 * Math.PI * R, tot = vals.reduce((a, b) => a + b, 0); let off = 0;
  return `<svg class="ill" viewBox="0 0 160 160" style="max-width:15rem" role="img" aria-label="${esc(id)}"><circle cx="80" cy="80" r="${R}" fill="none" stroke="var(--muted)" stroke-width="22"/>${vals.map((v, i) => { const len = v / tot * C, el = `<circle cx="80" cy="80" r="${R}" fill="none" stroke="${cols[i]}" stroke-width="22" stroke-dasharray="${len - 2} ${C - len + 2}" stroke-dashoffset="${-off}" transform="rotate(-90 80 80)"/>`; off += len; return el; }).join('')}<text x="80" y="84" text-anchor="middle" style="fill:var(--fg);font-size:13px">${centre}</text></svg>`; };
const formatsArt = () => { const F = [['CSV', '#06B6D4'], ['JSON', '#8B5CF6'], ['XLSX', '#10B981'], ['ARFF', '#F59E0B'], ['ZIP', '#EC4899']];
  return `<svg class="ill" viewBox="0 0 560 170" role="img" aria-label="Files in many formats are read into one table, which trains the model">${grads('fm')}
    ${F.map(([t, c], i) => `<g class="float" style="--d:${-i * 0.6}s"><rect class="glassf" x="14" y="${12 + i * 31}" width="112" height="26" rx="9"/><rect x="14" y="${12 + i * 31}" width="6" height="26" rx="3" fill="${c}"/><text x="32" y="${29 + i * 31}" style="fill:var(--fg);font-size:11px">.${t.toLowerCase()}</text></g>`).join('')}
    <path d="M134 85 C180 85 190 85 222 85" fill="none" stroke="url(#fm1)" stroke-width="2.5" stroke-dasharray="3 7" stroke-linecap="round"/>
    <rect class="glassf" x="226" y="28" width="150" height="114" rx="14"/>${[0, 1, 2, 3].map((r) => [0, 1, 2].map((c) => `<rect x="${238 + c * 44}" y="${42 + r * 24}" width="36" height="14" rx="4" fill="${r === 0 ? 'url(#fm1)' : 'var(--muted)'}" ${r ? 'stroke="var(--border)"' : ''}/>`).join('')).join('')}
    <path d="M382 85 C410 85 414 85 440 85" fill="none" stroke="url(#fm2)" stroke-width="2.5" stroke-dasharray="3 7" stroke-linecap="round"/>
    <circle cx="492" cy="85" r="56" fill="url(#fm4)"/><circle cx="492" cy="85" r="36" fill="url(#fm3)"/><path d="M478 86l10 10 20-22" fill="none" stroke="#fff" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="301" y="162" text-anchor="middle">ONE TABLE</text><text x="492" y="162" text-anchor="middle">TRAINED MODEL</text><text x="70" y="166" text-anchor="middle">YOUR FILES</text></svg>`; };

async function landing() {
  wi = 0;
  const s = await api('/paper/summary').catch(() => null);
  const imp = s?.macroF1ImprovementOverFedAvgPct || {}, c = s?.config || {};
  $('#main').innerHTML = `<div class="wrap">
  <section class="hero hero-grid"><div>${label('Research Platform')}<h1 class="hl">${words('Federated Intelligence.')}<br><em>${words('Without Centralizing the Data.')}</em></h1>
    <p class="lead" data-reveal style="--d:500ms">Train an intrusion-detection model across many sites without moving their data. ADA-FedAvg groups clients by their attack-class mix, then merges them in two stages so rare attacks are not drowned out.</p>
    <div class="cta left" data-reveal style="--d:650ms">${user ? '<a class="btn btn-p" href="/app/detect">Analyze your data</a><a class="btn btn-s" href="/app">Open dashboard</a>' : '<a class="btn btn-p" href="/register">Get started</a><a class="btn btn-s" href="/login">Sign in</a>'}</div>
    <div class="fmts" data-reveal style="--d:800ms" aria-label="Accepted data formats">${[['CSV', '#06B6D4'], ['JSON', '#8B5CF6'], ['XLSX', '#10B981'], ['ARFF', '#F59E0B'], ['JSONL', '#EC4899'], ['ZIP', '#64748B']].map(([t, col]) => `<span style="--c:${col}">${t}</span>`).join('')}</div></div>
    <div class="art-wrap" data-reveal style="--d:300ms">${heroArt()}</div></section>
  <section data-reveal>${label('Macro-F1 gain over FedAvg')}<div class="stats">${['mild', 'moderate', 'extreme'].map((k) => `<div class="stat"><b>${imp[k] != null ? '+' + imp[k].toFixed(1) + '%' : ''}</b><span class="small-caps">${k} skew</span></div>`).join('')}</div>
    <p class="small-caps muted" style="margin-top:1.75rem"><span class="badge">Paper-reported</span> ${esc(c.clients)} clients · ${esc(c.rounds)} rounds · K=${esc(c.clusters)} clusters · NSL-KDD</p>
    <p class="muted small" style="max-width:40rem">These are the paper’s single-seed figures without confidence intervals. Treat them as claims to test, not established results; <a href="/review">see how this platform tests them</a>.</p></section>
  <section>${label('How it works')}<div class="steps">
    <div data-reveal style="--d:0ms">${stepArt[0]()}<span class="small-caps">01</span><h3>Summarise</h3><p class="muted">Each client reports its local attack-class distribution (benign, DoS, probe, R2L, U2R), never its records.</p></div>
    <div data-reveal style="--d:120ms">${stepArt[1]()}<span class="small-caps">02</span><h3>Cluster</h3><p class="muted">Jensen–Shannon divergence between distributions drives agglomerative clustering of similar clients.</p></div>
    <div data-reveal style="--d:240ms">${stepArt[2]()}<span class="small-caps">03</span><h3>Aggregate</h3><p class="muted">Sample-weighted averaging inside each cluster, then equal weight across clusters.</p></div></div></section>
  <section data-reveal>${label('The Problem')}<div class="grid2 even"><div><h2>Non-IID data hides rare attacks.</h2><p class="muted">When one client holds mostly benign traffic and another sees rare R2L activity, size-weighted averaging lets the large client bury the signal. Equal cluster weights give rare-attack clients a voice.</p>
    <p class="muted small">Illustrative weights, not measured results.</p></div>
    <div class="card top"><div class="cmp"><figure>${donut([70, 18, 8, 4], ['#64748B', '#0891B2', '#7C3AED', '#DB2777'], 'Size-weighted FedAvg: one large benign client holds 70 percent of the weight', 'FedAvg')}<figcaption><b>Size-weighted</b>the largest client dominates</figcaption></figure>
    <figure>${donut([1, 1, 1], ['#0891B2', '#7C3AED', '#DB2777'], 'ADA-FedAvg: three clusters each hold one third of the weight', 'ADA')}<figcaption><b>Equal clusters</b>each group gets a say</figcaption></figure></div></div></div></section>
  <section data-reveal>${label('Bring your own data')}<div class="grid2 even"><div><h2>Any table, in the format you already have.</h2><p class="muted">Drop a CSV, TSV, JSON, JSONL, Excel, ARFF or zipped file. The platform reads it, profiles every column, scales skewed values, and trains on it. Raw packet captures and images are not supported; export flow records first.</p>
    <div class="cta left"><a class="btn btn-p" href="/${user ? 'app/datasets' : 'register'}">${user ? 'Upload a dataset' : 'Create an account'}</a></div></div>
    <div class="card top">${formatsArt()}</div></div></section>
  <section data-reveal><div class="cta-card card top"><div>${label('Put it to work')}<h2 style="font-size:clamp(1.5rem,3vw,2.1rem)">Score your own network records.</h2><p class="muted" style="margin:.5rem 0 0">Train a model here, then analyze records by form, paste or file. Records are scored on the server and not stored.</p></div>
    <a class="btn btn-p" href="/${user ? 'app/detect' : 'login'}">${user ? 'Open Detect' : 'Sign in to start'}</a></div>
    <p class="muted small" style="max-width:44rem">Distribution summaries and model updates can still leak information. This platform makes no formal privacy guarantee. <a href="/app/privacy">Read the limitations</a>.</p></section>
  </div>`;
  afterRender();
}

function authPage(mode) {
  const reg = mode === 'register';
  $('#main').innerHTML = `<div class="wrap"><div class="auth card top">${authArt()}${label('ADA-FedAvg')}<h2>${reg ? 'Create account' : 'Secure access'}</h2>
    <p class="muted">${reg ? 'New accounts start as viewers. An administrator can grant more access.' : 'Sign in to open the research dashboard.'}</p>
    ${flash ? `<p class="notice" role="status">${esc(flash)}</p>` : ''}
    <form id="f" novalidate>${reg ? '<label for="name">Name</label><input id="name" autocomplete="name" required>' : ''}
      <label for="email">Email address</label><input id="email" type="email" autocomplete="email" required>
      <label for="pw">Password</label><div class="pw"><input id="pw" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}" required><button type="button" class="btn btn-g" id="tg" aria-pressed="false">Show</button></div>
      ${reg ? '<p class="muted small">At least 10 characters.</p>' : ''}<p class="err" id="err" role="alert"></p>
      <button class="btn btn-p" style="width:100%" type="submit">${reg ? 'Create account' : 'Sign in'}</button></form>
    <p class="small">${reg ? 'Have an account? <a href="/login">Sign in</a>' : '<a href="/forgot">Forgot password?</a> · <a href="/register">Create an account</a>'}</p></div></div>`;
  flash = ''; $('#email').focus();
  $('#tg').onclick = () => { const p = $('#pw'), s = p.type === 'password'; p.type = s ? 'text' : 'password'; $('#tg').textContent = s ? 'Hide' : 'Show'; $('#tg').setAttribute('aria-pressed', s); };
  $('#f').onsubmit = async (e) => {
    e.preventDefault(); const body = { email: $('#email').value, password: $('#pw').value }; if (reg) body.name = $('#name').value;
    try {
      const r = await api(reg ? '/auth/register' : '/auth/login', { method: 'POST', body });
      if (reg && r.verificationRequired) { $('#main').innerHTML = `<div class="wrap"><div class="auth card top"><h2>Check your email</h2><p class="muted">${r.emailDelivery === 'smtp' ? 'We sent a verification link to your address.' : 'Email delivery is not configured on this server, so the link was written to the server console. Ask the administrator for it.'}</p><a class="btn btn-s" href="/login">Back to sign in</a></div></div>`; return; }
      user = r.user; go('/app');
    } catch (x) { $('#err').textContent = x.code === 'unverified' ? 'Please verify your email first. Using “Forgot password” also confirms your address.' : x.message; }
  };
}
function forgotPage() {
  $('#main').innerHTML = `<div class="wrap"><div class="auth card top">${authArt()}${label('Recovery')}<h2>Forgot password</h2><p class="muted">Enter your email and we will send a reset link.</p>
    <form id="f"><label for="email">Email address</label><input id="email" type="email" autocomplete="email" required><p class="err" id="err" role="alert"></p><button class="btn btn-p" style="width:100%">Send reset link</button></form><p class="small"><a href="/login">Back to sign in</a></p></div></div>`;
  $('#f').onsubmit = async (e) => { e.preventDefault(); try { const r = await api('/auth/forgot', { method: 'POST', body: { email: $('#email').value } });
    $('#f').outerHTML = `<p role="status">If an account exists for that address, a reset link has been sent.${r.emailDelivery === 'outbox' ? ' <span class="muted">(Email is not configured on this server; the link was written to the server console and the admin outbox.)</span>' : ''}</p>`; } catch (x) { $('#err').textContent = x.message; } };
}
function resetPage(q) {
  $('#main').innerHTML = `<div class="wrap"><div class="auth card top">${label('Recovery')}<h2>Choose a new password</h2>
    <form id="f"><label for="pw">New password</label><input id="pw" type="password" autocomplete="new-password" minlength="10" required>
    <label for="pw2">Confirm password</label><input id="pw2" type="password" autocomplete="new-password" required><p class="err" id="err" role="alert"></p><button class="btn btn-p" style="width:100%">Reset password</button></form></div></div>`;
  $('#f').onsubmit = async (e) => { e.preventDefault(); if ($('#pw').value !== $('#pw2').value) return ($('#err').textContent = 'Passwords do not match');
    try { await api('/auth/reset', { method: 'POST', body: { token: q.token || '', password: $('#pw').value } }); flash = 'Password updated. Please sign in.'; go('/login'); } catch (x) { $('#err').textContent = x.message; } };
}
async function verifyPage(q) {
  $('#main').innerHTML = `<div class="wrap"><div class="auth card top"><h2>Verifying…</h2></div></div>`;
  try { await api('/auth/verify', { method: 'POST', body: { token: q.token || '' } }); if (user) user.emailVerified = true;
    $('#main').innerHTML = `<div class="wrap"><div class="auth card top"><h2>Email verified</h2><p class="muted">Thank you. You can now sign in.</p><a class="btn btn-p" href="/login">Continue</a></div></div>`;
  } catch (x) { $('#main').innerHTML = `<div class="wrap"><div class="auth card top"><h2>Link not valid</h2><p class="muted">${esc(x.message)}</p><a class="btn btn-s" href="/login">Back to sign in</a></div></div>`; }
}
const denied = () => ($('#main').innerHTML = `<div class="wrap"><div class="auth card top"><h2>Access denied</h2><p class="muted">Your role does not permit this page.</p><a class="btn btn-s" href="/app">Back to dashboard</a></div></div>`);

// ---------- dashboard ----------
const TABS = [['', 'Overview'], ['detect', 'Detect'], ['experiments', 'Experiments'], ['studies', 'Studies'], ['datasets', 'Datasets'], ['compare', 'Compare'], ['paper', 'Paper results'], ['review', 'Review'], ['privacy', 'Privacy'], ['settings', 'Settings']];
const ADMIN = [['users', 'Users'], ['audit', 'Audit log'], ['outbox', 'Outbox']];
function shell(active, inner) {
  const q = quiet; quiet = false;
  const tabs = TABS.filter(([k]) => k !== 'datasets' || isRunner()).concat(user.role === 'admin' ? ADMIN : []);
  $('#main').innerHTML = `<div class="wrap"><section class="dash"><h1 class="h1s">Research dashboard</h1>
    ${user.emailVerified ? '' : '<p class="notice" role="status">Your email address is not verified. <button class="btn btn-g" id="resend">Resend link</button></p>'}
    <nav class="tabs" aria-label="Dashboard">${tabs.map(([k, t]) => `<a href="/app${k ? '/' + k : ''}" ${active === k ? 'aria-current="page"' : ''}>${t}</a>`).join('')}</nav><div id="panel">${inner}</div></section></div>`;
  $('#main').classList.toggle('quiet', q); afterRender();
  $('#main .tabs [aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'center' }); // keep the active tab visible on narrow screens
  if ($('#resend')) $('#resend').onclick = async () => { const r = await api('/auth/resend-verification', { method: 'POST', body: {} }); say(r.emailDelivery === 'smtp' ? 'Verification email sent' : 'Email is not configured; link written to server console'); };
}
const poll = (fn, ms = 3000) => { clearInterval(timer); timer = setInterval(() => { quiet = true; fn(); }, ms); };

async function overview() {
  const o = await api('/overview'), ex = await api('/experiments?limit=5&scope=standalone'), m = o.latest?.metrics;
  shell('', `<div class="cards">
    <div class="card top"><span class="small-caps">Experiments</span><b class="big">${o.experiments.total}</b><span class="muted small">${Object.entries(o.experiments.byStatus).map(([k, v]) => `${v} ${k}`).join(' · ') || 'none yet'}</span></div>
    <div class="card"><span class="small-caps">Latest macro-F1</span><b class="big">${m ? f3(m.macroF1) : '—'}</b><span class="muted small">${o.latest ? esc(o.latest.name) : 'No completed experiment'}</span></div>
    <div class="card"><span class="small-caps">Accuracy · Weighted-F1</span><b class="big">${m ? f3(m.accuracy) : '—'}</b><span class="muted small">${m ? 'W-F1 ' + f3(m.weightedF1) + (m.commMB != null ? ' · ' + m.commMB.toFixed(1) + ' MB comm.' : '') : ''}</span></div>
    ${o.users != null ? `<div class="card"><span class="small-caps">Registered users</span><b class="big">${o.users}</b></div>` : ''}</div>
    <p class="muted small"><span class="badge">Generated</span> Figures above come from experiments run on this server. Paper-reported figures are on the Paper results tab.</p>
    ${o.dataset.train && o.dataset.test ? '' : `<p class="notice" role="status">NSL-KDD dataset not installed. On the server run <code>npm run dataset</code> before starting experiments.</p>`}
    ${o.emailMode === 'outbox' ? '<p class="notice small">Email is not configured (SMTP_URL). Verification and reset emails go to the server console and the admin outbox.</p>' : ''}
    <div class="card top cta-card"><div><h3>Analyze your own data</h3><p class="muted" style="margin:.25rem 0 0">Enter records by form, paste or CSV and see how a trained model classifies them.</p></div><a class="btn btn-p" href="/app/detect">Open Detect</a></div>
    <h2 class="h2s">Recent experiments</h2>${expTable(ex.experiments, false)}<p><a href="/app/experiments">All experiments →</a></p>`);
  poll(() => { if (location.pathname === '/app') overview(); }, 5000);
}
function expTable(list, actions) {
  if (!list.length) return `<div class="empty"><p>No experiments yet.</p>${isRunner() ? '<a class="btn btn-p" href="/app/experiments">Create one</a>' : '<p class="muted small">Researchers can create experiments.</p>'}</div>`;
  return table('Experiments', ['#', 'Name', 'Method', 'Skew', 'Status', 'Progress', 'Macro-F1', 'Owner', ...(actions ? ['Actions'] : [])], list.map((e) => `<tr><td>${e.id}</td><td><a href="/app/experiments/${e.id}">${esc(e.name)}</a></td><td>${esc(e.config.method)}</td><td>${esc(e.config.skew ?? '—')}</td><td>${badge(e.status)}</td>
    <td>${ACTIVE.includes(e.status) ? `<progress max="1" value="${e.progress}" aria-label="Progress"></progress>` : e.status === 'completed' ? '100%' : '—'}</td><td class="n">${f3(e.metrics?.macroF1)}</td><td>${esc(e.owner)}</td>
    ${actions ? `<td>${can(e) ? (ACTIVE.includes(e.status) ? `<button class="btn btn-g" data-cancel="${e.id}">Cancel</button>` : `<button class="btn btn-g" data-del="${e.id}">Delete</button>`) : ''}</td>` : ''}</tr>`));
}
const can = (e) => user && (user.role === 'admin' || (user.role === 'researcher' && e.ownerId === user.id));

let page = 0;
async function experiments() {
  const dsList = isRunner() ? (await api('/datasets').catch(() => ({ datasets: [] }))).datasets.filter((x) => x.status === 'ready') : [];
  const LIM = 10, d = await api(`/experiments?limit=${LIM}&offset=${page * LIM}&scope=standalone`);
  const form = isRunner() ? `<details class="card top" ${d.total ? '' : 'open'}><summary class="small-caps">New experiment</summary><form id="nf" class="fgrid">
    <div><label for="n">Name</label><input id="n" required maxlength="100" value="My experiment"></div>
    <div><label for="m">Method</label><select id="m" class="full"><option value="ada">ADA-FedAvg</option><option value="fedavg">FedAvg</option><option value="fedprox">FedProx</option><option value="ifca">IFCA (clustered baseline)</option><option value="centralized">Centralized</option></select></div>
    <div><label for="ds">Dataset</label><select id="ds" class="full"><option value="">NSL-KDD (built-in)</option>${dsList.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select></div>
    <div><label for="s">Skew</label><select id="s" class="full"><option value="mild">Mild (α=1.0)</option><option value="moderate" selected>Moderate (α=0.5)</option><option value="extreme">Extreme (α=0.1)</option></select></div>
    <div><label for="ef">Training effort</label><select id="ef" class="full"><option value="quick">Quick (30 rounds, 1 local epoch)</option><option value="balanced">Balanced (60 rounds, 2 epochs)</option><option value="thorough">Thorough (100 rounds, 3 epochs)</option><option value="custom">Custom</option></select>
      <p class="muted small" id="efn" style="margin:.35rem 0 0"></p></div>
    <div><label for="r">Rounds</label><input id="r" type="number" min="1" max="100" value="30"></div>
    <div><label for="c">Clients</label><input id="c" type="number" min="2" max="50" value="8"></div>
    <div><label for="k">Clusters (ADA / IFCA)</label><input id="k" type="number" min="2" max="12" value="3"></div>
    <div><label for="sd">Seed</label><input id="sd" type="number" min="0" value="42"></div>
    <details class="fa"><summary class="small-caps">Advanced options (ablations, heterogeneity, robustness)</summary><div class="fgrid">
      <div><label for="lw">Loss weighting</label><select id="lw" class="full"><option value="none">None</option><option value="local">Local class-weighted</option><option value="global">Global class-balanced</option></select></div>
      <div><label for="cwp">Weight power (0.5 = sqrt-balanced)</label><input id="cwp" type="number" step="0.1" min="0.1" max="1" value="0.5"></div>
      <div><label for="cm">Cluster membership (ADA)</label><select id="cm" class="full"><option value="agglom">Agglomerative (paper)</option><option value="random">Random, same sizes</option><option value="singleton">Singleton (uniform client weights)</option></select></div>
      <div><label for="di">Clustering distance (ADA)</label><select id="di" class="full"><option value="jsd">JS on proportions (paper)</option><option value="jsd-invfreq">JS, inverse-frequency weighted</option><option value="jsd-log">JS, log-scaled</option></select></div>
      <div><label for="bl">Cluster-weight blend (0 = paper, 1 = FedAvg)</label><input id="bl" type="number" step="0.1" min="0" max="1" value="0"></div>
      <div><label for="pm">FedProx μ</label><input id="pm" type="number" step="0.01" min="0" max="10" value="0.01"></div>
      <div><label for="le">Local epochs</label><input id="le" type="number" min="1" max="5" value="1"></div>
      <div><label for="ps">Partition seed (blank = seed)</label><input id="ps" type="number" min="0"></div>
      <div><label for="fs">Feature shift σ</label><input id="fs" type="number" step="0.1" min="0" max="2" value="0.5"></div>
      <div><label for="qa">Quantity skew α</label><input id="qa" type="number" step="0.1" min="0.1" max="10" value="0.5"></div>
      <div><span class="small-caps">Heterogeneity</span><label style="font-weight:400"><input type="checkbox" id="h1" checked disabled style="width:auto;height:auto"> label skew</label><label style="font-weight:400"><input type="checkbox" id="h2" style="width:auto;height:auto"> quantity skew</label><label style="font-weight:400"><input type="checkbox" id="h3" style="width:auto;height:auto"> feature shift</label></div>
      <div><span class="small-caps">Robustness</span><label style="font-weight:400"><input type="checkbox" id="sy" style="width:auto;height:auto"> one Sybil client (flips labels, fake histogram)</label></div></div></details>
    <div class="fa"><p class="err" id="err" role="alert"></p><button class="btn btn-p">Start experiment</button> <button type="button" class="btn btn-s" id="suite">Run full reproduction (7 runs)</button></div></form></details>` : '<p class="muted small">Your role can view experiments but not create them.</p>';
  shell('experiments', `${form}<h2 class="h2s">All experiments</h2><div id="list">${expTable(d.experiments, true)}</div>
    <div class="pager"><button class="btn btn-s" id="pv" ${page ? '' : 'disabled'}>Previous</button><span class="small-caps">Page ${page + 1} of ${Math.max(1, Math.ceil(d.total / LIM))}</span><button class="btn btn-s" id="nx" ${(page + 1) * LIM >= d.total ? 'disabled' : ''}>Next</button></div>`);
  $('#pv').onclick = () => { page--; experiments(); }; $('#nx').onclick = () => { page++; experiments(); };
  document.querySelectorAll('[data-cancel]').forEach((b) => (b.onclick = async () => { if (await confirmDlg('Cancel this experiment?')) { await api(`/experiments/${b.dataset.cancel}/cancel`, { method: 'POST', body: {} }).catch((x) => say(x.message)); experiments(); } }));
  document.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => { if (await confirmDlg('Permanently delete this experiment and its results?')) { await api(`/experiments/${b.dataset.del}`, { method: 'DELETE' }).catch((x) => say(x.message)); experiments(); } }));
  if ($('#nf')) {
    const EFFORT = { quick: [30, 1, 'Fastest. Fine for a first look; under-trains harder data.'], balanced: [60, 2, 'About 4x the compute of Quick. On three benchmark datasets with label-skewed clients, average macro-F1 rose from 0.68 to 0.77.'], thorough: [100, 3, 'About 10x the compute of Quick; average macro-F1 0.79 on the same benchmark. With an uploaded dataset the best round (by validation score) is kept.'] };
    const effort = () => { const e = EFFORT[$('#ef').value]; if (e) { $('#r').value = e[0]; $('#le').value = e[1]; } $('#efn').textContent = e ? e[2] : 'You set rounds and local epochs yourself.'; };
    $('#ef').onchange = effort; ['#r', '#le'].forEach((q) => ($(q).oninput = () => { const hit = Object.entries(EFFORT).find(([, v]) => v[0] === +$('#r').value && v[1] === +$('#le').value); $('#ef').value = hit ? hit[0] : 'custom'; $('#efn').textContent = hit ? hit[1][2] : 'You set rounds and local epochs yourself.'; })); effort();
    $('#m').onchange = () => { $('#s').disabled = $('#m').value === 'centralized'; $('#k').disabled = !['ada', 'ifca'].includes($('#m').value); }; $('#m').onchange();
    $('#nf').onsubmit = async (e) => { e.preventDefault(); try { const r = await api('/experiments', { method: 'POST', body: { name: $('#n').value, method: $('#m').value, skew: $('#s').value, rounds: +$('#r').value, clients: +$('#c').value, clusters: +$('#k').value, seed: +$('#sd').value, lossWeights: $('#lw').value, cwPower: +$('#cwp').value, clusterMode: $('#cm').value, distance: $('#di').value, blend: +$('#bl').value, proxMu: +$('#pm').value, localEpochs: +$('#le').value, featureShift: +$('#fs').value, quantityAlpha: +$('#qa').value, sybil: $('#sy').checked, hetero: ['label', ...($('#h2').checked ? ['quantity'] : []), ...($('#h3').checked ? ['feature'] : [])], ...($('#ps').value !== '' ? { partitionSeed: +$('#ps').value } : {}), ...($('#ds').value ? { datasetId: +$('#ds').value } : {}) } }); go(`/app/experiments/${r.id}`); } catch (x) { $('#err').textContent = x.message; } };
    $('#suite').onclick = async () => { if (!(await confirmDlg('Queue 7 runs: centralized plus FedAvg and ADA-FedAvg at three skew levels (30 rounds, 8 clients)?'))) return; try { await api('/experiments/suite', { method: 'POST', body: {} }); experiments(); } catch (x) { $('#err').textContent = x.message; } };
  }
  poll(() => { if (location.pathname === '/app/experiments' && !document.querySelector('details[open] :focus') && !document.activeElement?.closest?.('form')) api(`/experiments?limit=${LIM}&offset=${page * LIM}&scope=standalone`).then((n) => { if ($('#list')) { $('#list').innerHTML = expTable(n.experiments, true); } }).catch(() => {}); });
}

const cfgExtras = (c) => [c.lossWeights && c.lossWeights !== 'none' ? 'loss ' + c.lossWeights : '', c.method === 'ada' && c.clusterMode && c.clusterMode !== 'agglom' ? c.clusterMode + ' clusters' : '', c.method === 'ada' && c.distance && c.distance !== 'jsd' ? c.distance : '',
  c.blend ? 'blend ' + c.blend : '', c.sybil ? 'Sybil client' : '', c.hetero && c.hetero.join() !== 'label' ? c.hetero.join('+') : ''].filter(Boolean).map((x) => ' · ' + esc(x)).join('');
async function detail(id) {
  const e = await api('/experiments/' + id), r = e.result, live = e.live || {};
  const hist = r?.history?.length ? r.history : live.history || [], clients = r?.clients || live.clients, c = e.config, t = r?.test;
  const cls = r?.classes || live.classes || CLS, gen = r?.generalization, cs = r?.cluster_stats;
  const rows = clients ? clients.map((k) => `<tr><td>${k.id}</td><td class="n">${k.samples}</td><td style="min-width:10rem">${stack(k.distribution, cls)}</td>${k.distribution.map((v) => `<td class="n">${pct(v)}</td>`).join('')}<td>${k.cluster == null ? '—' : k.cluster}</td></tr>`) : [];
  let cl = '';
  if (clients && c.method === 'ada') { const g = {}; clients.forEach((k) => ((g[k.cluster] ||= []).push(k))); cl = table('Cluster summary', ['Cluster', 'Clients', 'Members', 'Samples'], Object.entries(g).map(([k, v]) => `<tr><td>${k}</td><td>${v.length}</td><td>${v.map((x) => x.id).join(', ')}</td><td class="n">${v.reduce((a, b) => a + b.samples, 0)}</td></tr>`)); }
  const jsd = r?.jsd ? table('Jensen–Shannon divergence between clients (bits)', ['', ...r.jsd.map((_, i) => 'C' + i)], r.jsd.map((row, i) => `<tr><th scope="row">C${i}</th>${row.map((v) => `<td class="n" style="background:color-mix(in srgb,var(--accent) ${Math.round(v * 100)}%,transparent)">${v.toFixed(2)}</td>`).join('')}</tr>`)) : '';
  const genHtml = gen ? `<h3 class="h2s">Generalisation (NSL-KDD test views)</h3>${table('Held-out subsets', ['Subset', 'Records', 'Accuracy', 'Macro-F1', 'Attack detection'], [
    `<tr><td>KDDTest-21 (harder records)</td><td class="n">${gen.test21.n}</td><td class="n">${f3(gen.test21.accuracy)}</td><td class="n">${f3(gen.test21.macro_f1)}</td><td>—</td></tr>`,
    `<tr><td>Known attack types (seen in training)</td><td class="n">${gen.known_attacks.n}</td><td>—</td><td>—</td><td class="n">${pct(gen.known_attacks.detection_rate)}</td></tr>`,
    `<tr><td>Novel attack types (unseen in training)</td><td class="n">${gen.novel_attacks.n}</td><td>—</td><td>—</td><td class="n">${pct(gen.novel_attacks.detection_rate)}</td></tr>`])}<p class="muted small">Low R2L recall on KDDTest+ is largely explained by novel attack types that never appear in training. These rows separate that effect.</p>` : '';
  const csHtml = cs ? `<h3 class="h2s">What the clusters contain</h3>${table('Cluster membership and true class mix (shares of training samples)', ['Cluster', 'Clients', 'Samples', ...cls], cs.map((x) => `<tr><td>${x.cluster}</td><td>${x.clients.join(', ')}</td><td class="n">${x.samples}</td>${x.class_share.map((v) => `<td class="n">${pct(v)}</td>`).join('')}</tr>`))}<p class="muted small">If clusters differ mostly in benign and DoS shares, the clustering signal is not tracking rare-attack presence. Compare with the inverse-frequency and log-scaled distances in a study.</p>` : '';
  shell('experiments', `<p><a href="/app/experiments">← All experiments</a></p><h2 class="h2s" style="margin-top:0">${esc(e.name)} ${badge(e.status)}</h2>
    <p class="small-caps muted">${esc(c.method)}${c.skew ? ' · ' + esc(c.skew) + ' skew' : ''} · ${c.rounds} ${c.method === 'centralized' ? 'epochs' : 'rounds'}${c.method !== 'centralized' ? ' · ' + c.clients + ' clients' : ''}${c.method === 'ada' ? ' · K=' + c.clusters : ''} · seed ${c.seed}${c.partitionSeed != null ? '/' + c.partitionSeed : ''}${c.datasetName ? ' · dataset ' + esc(c.datasetName) : ''}${cfgExtras(c)} · by ${esc(e.owner)}${e.result?.selected_round ? ` · model from round ${e.result.selected_round} of ${e.result.rounds_run} (best validation score)` : ''}</p>
    ${ACTIVE.includes(e.status) ? `<p><progress max="1" value="${e.progress}" style="width:100%" aria-label="Progress"></progress><span class="small-caps muted">${e.status} · ${(e.progress * 100).toFixed(0)}%</span></p>` : ''}
    ${e.status === 'failed' ? `<p class="err" role="alert">Failed: ${esc(e.message)}</p>` : ''}${e.status === 'cancelled' ? '<p class="muted">Cancelled.</p>' : ''}
    ${t ? `<div class="cards"><div class="card top"><span class="small-caps">Macro-F1</span><b class="big">${f3(t.macro_f1)}</b></div><div class="card"><span class="small-caps">Accuracy</span><b class="big">${f3(t.accuracy)}</b></div><div class="card"><span class="small-caps">Weighted-F1</span><b class="big">${f3(t.weighted_f1)}</b></div>${t.false_alarm_rate != null ? `<div class="card"><span class="small-caps">False-alarm rate</span><b class="big">${pct(t.false_alarm_rate)}</b><span class="muted small">benign flagged as attack</span></div><div class="card"><span class="small-caps">Attack detection</span><b class="big">${pct(t.attack_detection_rate)}</b><span class="muted small">attacks not called benign</span></div>` : ''}<div class="card"><span class="small-caps">Comm. · Time</span><b class="big">${r.comm_mb != null ? r.comm_mb.toFixed(1) + ' MB' : 'N/A'}</b><span class="muted small">${r.duration_s}s on ${r.test_samples} test records</span></div></div><p class="small-caps muted"><span class="badge">Generated</span> held-out KDDTest+ metrics from this run</p>` : ''}
    ${genHtml}${csHtml}
    <h3 class="h2s">Validation macro-F1 by round</h3><div class="card">${lineChart(hist)}</div>
    ${hist.length ? `<details><summary>Round data (table)</summary>${table('Rounds', ['Round', 'Val macro-F1', 'Val accuracy', 'Loss'], hist.map((h) => `<tr><td>${h.round}</td><td class="n">${f3(h.val_macro_f1)}</td><td class="n">${f3(h.val_accuracy)}</td><td class="n">${f3(h.loss)}</td></tr>`))}</details>` : ''}
    ${clients ? `<h3 class="h2s">Client distributions</h3>${legend(cls)}${table('Local class distribution per client', ['Client', 'Samples', 'Mix', ...cls, 'Cluster'], rows)}${cl}${jsd}` : ''}
    ${t ? `<h3 class="h2s">Per-class results (test)</h3>${table('Per-class precision, recall and F1', ['Class', 'Precision', 'Recall', 'F1', 'Support'], t.per_class.map((p) => `<tr><td>${p.class}</td><td class="n">${f3(p.precision)}</td><td class="n">${f3(p.recall)}</td><td class="n">${f3(p.f1)}</td><td class="n">${p.support}</td></tr>`))}
      ${table('Confusion matrix (rows = actual, columns = predicted)', ['Actual \\ Pred', ...cls], t.confusion.map((row, i) => { const s = row.reduce((a, b) => a + b, 0) || 1; return `<tr><th scope="row">${esc(cls[i])}</th>${row.map((v) => `<td class="n" style="background:color-mix(in srgb,var(--accent) ${Math.round((v / s) * 70)}%,transparent)">${v}</td>`).join('')}</tr>`; }))}` : ''}`);
  if (ACTIVE.includes(e.status)) poll(() => { if (location.pathname === `/app/experiments/${id}`) detail(id); }, 2500); else clearInterval(timer);
}


// ---------- datasets (upload your own CSV) ----------
const KIND_NOTE = { identifier: 'ignored (looks like a row id)', constant: 'ignored (constant)', text: 'ignored (free text, >100 values)', numeric: 'used', categorical: 'used (one-hot)' };
async function datasets() {
  const d = await api('/datasets');
  shell('datasets', `<p class="muted">Bring your own table: one column holds the label, the rest are features. Files stay on this server, are visible only to you and administrators, are never executed, and can be deleted at any time.</p>
    <form id="uf" class="card top upl" novalidate>
      <label class="drop" id="drop" for="uf2">
        <input id="uf2" class="sr" type="file" accept=".csv,.tsv,.txt,.dat,.json,.jsonl,.ndjson,.xlsx,.xlsm,.arff,.parquet,.gz,.zip">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V4m0 0 4 4m-4-4L8 8"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>
        <span class="drop-t"><b>Drop a data file here</b> or <u>browse</u></span>
        <span class="muted small">Up to ${d.maxUploadMB} MB, at least 200 rows</span>
        <ul class="chips" aria-label="Accepted formats"><li>CSV</li><li>TSV</li><li>TXT</li><li>JSON</li><li>JSONL</li><li>XLSX</li><li>ARFF</li><li>ZIP / GZ</li></ul>
      </label>
      <div id="picked" class="picked" hidden><span id="pk-n" class="pk-n"></span><span id="pk-s" class="muted small"></span><button type="button" class="btn btn-g" id="pk-x" aria-label="Remove selected file">Remove</button></div>
      <div class="upl-row"><div><label for="un">Dataset name</label><input id="un" maxlength="100" required autocomplete="off"></div>
        <button class="btn btn-p" id="ub" disabled>Upload and profile</button></div>
      <p class="err" id="err" role="alert"></p><p class="muted small" id="ust" role="status" aria-live="polite"></p>
    </form>
    <h2 class="h2s">Your datasets</h2>
    ${d.datasets.length ? table('Datasets', ['Name', 'Rows', 'Size', 'Status', 'Classes', 'Owner', ''], d.datasets.map((x) => `<tr><td><a href="/app/datasets/${x.id}">${esc(x.name)}</a></td><td class="n">${x.rows}</td><td class="n">${(x.bytes / 1048576).toFixed(1)} MB</td><td>${badge(x.status === 'ready' ? 'completed' : 'queued').replace('completed', 'ready').replace('queued', 'needs setup')}</td><td>${esc(x.classes.join(', ') || '—')}</td><td>${esc(x.owner)}</td><td><button class="btn btn-g" data-del="${x.id}">Delete</button></td></tr>`)) : '<div class="empty"><p>No datasets yet. Drop a file above to get started.</p></div>'}
    <p class="muted small">Tip: CIC-IDS2017, UNSW-NB15 and similar CSVs work if you map their attack labels to classes in the next step. Very large files should be sampled first.</p>`);
  const fin = $('#uf2'), drop = $('#drop'), fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
  let nameEdited = false; $('#un').oninput = () => { nameEdited = true; };   // an auto-filled name follows the file until the user types their own
  const pick = () => {
    const f = fin.files[0]; $('#err').textContent = '';
    $('#picked').hidden = !f; $('#ub').disabled = !f; drop.classList.toggle('has-file', !!f);
    if (!f) return;
    $('#pk-n').textContent = f.name; $('#pk-s').textContent = fmtSize(f.size);
    if (!nameEdited || !$('#un').value.trim()) { nameEdited = false; $('#un').value = f.name.replace(/\.(gz|zip)$/i, '').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').slice(0, 100); }
    if (f.size > d.maxUploadMB * 1048576) { $('#err').textContent = `This file is ${fmtSize(f.size)}; the limit is ${d.maxUploadMB} MB. Sample it or compress it first.`; $('#ub').disabled = true; }
  };
  fin.onchange = pick;
  $('#pk-x').onclick = () => { fin.value = ''; pick(); fin.focus(); };
  ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => { if (e.dataTransfer?.files?.length) { fin.files = e.dataTransfer.files; pick(); } });
  $('#uf').onsubmit = async (e) => {
    e.preventDefault(); const f = fin.files[0]; $('#err').textContent = '';
    if (!f) return ($('#err').textContent = 'Choose a data file first.');
    if (!$('#un').value.trim()) { $('#un').focus(); return ($('#err').textContent = 'Give the dataset a name.'); }
    if (f.size > d.maxUploadMB * 1048576) return;
    $('#ub').disabled = true; $('#ub').textContent = 'Uploading'; $('#ust').textContent = `Uploading ${f.name} and reading it. Large files can take a minute.`;
    try { const r = await api('/datasets?name=' + encodeURIComponent($('#un').value.trim()) + '&filename=' + encodeURIComponent(f.name), { method: 'POST', raw: f }); go(`/app/datasets/${r.id}`); }
    catch (x) { $('#err').textContent = x.message; $('#ust').textContent = ''; $('#ub').disabled = false; $('#ub').textContent = 'Upload and profile'; }
  };
  document.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => { if (await confirmDlg('Delete this dataset and its file from the server?')) { await api('/datasets/' + b.dataset.del, { method: 'DELETE' }).catch((x) => say(x.message)); datasets(); } }));
}
async function datasetDetail(id) {
  const d = await api('/datasets/' + id), p = d.profile, cols = p.columns.map((c) => c.name);
  shell('datasets', `<p><a href="/app/datasets">← All datasets</a></p><h2 class="h2s" style="margin-top:0">${esc(d.name)}</h2>
    <p class="small-caps muted">${d.rows} rows · ${cols.length} columns${p.ragged ? ` · ${p.ragged} malformed rows skipped` : ''}${p.source ? ` · read as ${esc(p.source.format)}` : ''} · ${d.status === 'ready' ? 'ready to use' : 'needs setup'}</p>
    ${p.source?.notes?.length ? `<details class="readnote"><summary>How we read your file (${p.source.notes.length})</summary><ul>${p.source.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></details>` : ''}
    <h3 class="h2s">1. Check the columns</h3>${table('Columns', ['Column', 'Type', 'Distinct', 'Missing', 'Use'], p.columns.map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.kind)}</td><td class="n">${c.unique}</td><td class="n">${c.missing}</td><td>${esc(KIND_NOTE[c.kind])}</td></tr>`))}
    <details><summary>Preview first rows</summary><div class="tw"><table><tbody>${p.preview.map((r) => `<tr>${cols.map((c) => `<td>${esc(r[c])}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details>
    <h3 class="h2s">2. Choose the label and map classes</h3>
    <form id="cf"><div class="fgrid"><div><label for="lc">Label column</label><select id="lc" class="full">${(p.labelCandidates.length ? p.labelCandidates : cols).map((c) => `<option ${c === d.labelCol ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>
    <div><label for="tf">Test fraction</label><input id="tf" type="number" step="0.05" min="0.1" max="0.5" value="${d.testFrac}"></div>
    <div><label for="mr">Max rows used</label><input id="mr" type="number" min="1000" max="500000" value="${d.maxRows}"></div></div>
    <p class="muted small">Give each label value a class name. Use the same name for several values to merge them (for example all DoS attacks into “dos”). Leave a name empty to exclude those rows. Every class needs at least 50 rows.</p>
    <div id="map" aria-live="polite">Loading label values…</div><p class="err" id="err" role="alert"></p><button class="btn btn-p">Save and mark ready</button></form>
    ${d.status === 'ready' ? '<p class="notice" role="status">Ready. Choose it in <a href="/app/experiments">Experiments</a> or <a href="/app/studies">Studies</a>. Metrics here come from a random stratified split of your file, which is usually easier than a separate official test set.</p>' : ''}`);
  const loadMap = async () => {
    const col = $('#lc')?.value; if (!col) return;
    try {
      const { labels } = await api(`/datasets/${id}/labels?col=${encodeURIComponent(col)}`), prev = col === d.labelCol && d.classMap ? d.classMap : null;
      if (!$('#map')) return; // user navigated away while loading
      $('#map').innerHTML = table('Label values', ['Value', 'Rows', 'Class name'], labels.map((l, i) => `<tr><td>${esc(l.value)}</td><td class="n">${l.count}</td><td><input data-v="${esc(l.value)}" aria-label="Class for ${esc(l.value)}" value="${esc(prev ? prev[l.value] ?? '' : l.value)}" style="height:40px"></td></tr>`));
    } catch (x) { if ($('#map')) $('#map').innerHTML = `<p class="err">${esc(x.message)}</p>`; }
  };
  $('#lc').onchange = loadMap; loadMap();
  $('#cf').onsubmit = async (e) => {
    e.preventDefault(); const classMap = {};
    document.querySelectorAll('#map input[data-v]').forEach((i) => { if (i.value.trim()) classMap[i.dataset.v] = i.value.trim(); });
    try { const r = await api(`/datasets/${id}/config`, { method: 'PUT', body: { labelCol: $('#lc').value, classMap, testFrac: +$('#tf').value, maxRows: +$('#mr').value } }); say('Dataset ready: ' + Object.entries(r.classes).map(([k, v]) => `${k} ${v}`).join(', ')); datasetDetail(id); } catch (x) { $('#err').textContent = x.message; }
  };
}

// ---------- studies (many seeds, confidence intervals, ablations) ----------
const pm = (s, d = 3) => (!s || s.mean == null ? '—' : s.sd == null ? s.mean.toFixed(d) : `${s.mean.toFixed(d)} ± ${s.sd.toFixed(d)}`);
const ci = (s, d = 3) => (s?.ci ? `[${s.ci[0].toFixed(d)}, ${s.ci[1].toFixed(d)}]` : '');
const dlt = (s, d = 3) => (!s || s.mean == null ? '—' : `${s.mean >= 0 ? '+' : ''}${s.mean.toFixed(d)} ${ci(s, d)}`);
const verdict = (s) => (s?.excludesZero == null ? 'n/a (need 2+ seeds)' : s.excludesZero ? 'Yes' : 'No');
async function studies() {
  const [d, pr, ds] = await Promise.all([api('/studies'), api('/studies/presets'), isRunner() ? api('/datasets') : { datasets: [] }]);
  const form = isRunner() ? `<details class="card top" ${d.studies.length ? '' : 'open'}><summary class="small-caps">New study</summary><form id="sf" class="fgrid">
    <div><label for="sn">Name</label><input id="sn" required maxlength="100" value="Study"></div>
    <div><label for="sp">Preset</label><select id="sp" class="full">${pr.presets.map((p) => `<option value="${p.key}">${esc(p.title)}</option>`).join('')}</select></div>
    <div><label for="ss">Skew</label><select id="ss" class="full"><option value="mild">Mild (α=1.0)</option><option value="moderate" selected>Moderate (α=0.5)</option><option value="extreme">Extreme (α=0.1)</option></select></div>
    <div><label for="sd">Seeds</label><input id="sd" type="number" min="2" max="20" value="5"></div>
    <div><label for="sr">Rounds</label><input id="sr" type="number" min="1" max="100" value="30"></div>
    <div><label for="sc">Clients</label><input id="sc" type="number" min="2" max="50" value="8"></div>
    <div><label for="sds">Dataset</label><select id="sds" class="full"><option value="">NSL-KDD (built-in)</option>${ds.datasets.filter((x) => x.status === 'ready').map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select></div>
    <div class="fa"><p class="muted small" id="note"></p><p class="err" id="err" role="alert"></p><button class="btn btn-p">Start study</button></div></form></details>` : '<p class="muted small">Your role can view studies but not create them.</p>';
  shell('studies', `<p class="muted">A study runs every variant with several seeds (the seed changes both the data partition and the model initialisation) and reports mean ± standard deviation, 95% confidence intervals and paired differences against FedAvg.</p>${form}
    <h2 class="h2s">Studies</h2>${d.studies.length ? table('Studies', ['Name', 'Preset', 'Completed', 'Status', 'Owner'], d.studies.map((s) => { const c = s.counts, tot = Object.values(c).reduce((a, b) => a + b, 0), done = c.completed || 0, act = ['queued', 'preparing', 'training', 'aggregating', 'evaluating'].reduce((a, k) => a + (c[k] || 0), 0);
      return `<tr><td><a href="/app/studies/${s.id}">${esc(s.name)}</a></td><td>${esc(s.preset)}</td><td class="n">${done} / ${tot}</td><td>${act ? badge('training') : c.failed ? badge('failed') : badge('completed')}</td><td>${esc(s.owner)}</td></tr>`; })) : '<div class="empty"><p>No studies yet.</p></div>'}`);
  if ($('#sf')) {
    const upd = () => { const p = pr.presets.find((x) => x.key === $('#sp').value), n = p.variants.length * +$('#sd').value; $('#note').textContent = `${p.note} ${p.variants.length} variants × ${$('#sd').value} seeds = ${n} runs, roughly ${Math.ceil((n * pr.secondsPerRun) / 60)} minutes at 30 rounds on a typical single-core server.`; };
    $('#sp').onchange = upd; $('#sd').oninput = upd; upd();
    $('#sf').onsubmit = async (e) => { e.preventDefault(); try { const r = await api('/studies', { method: 'POST', body: { name: $('#sn').value, preset: $('#sp').value, skew: $('#ss').value, seeds: +$('#sd').value, rounds: +$('#sr').value, clients: +$('#sc').value, ...($('#sds').value ? { datasetId: +$('#sds').value } : {}) } }); go(`/app/studies/${r.id}`); } catch (x) { $('#err').textContent = x.message; } };
  }
  poll(() => { if (location.pathname === '/app/studies' && !document.activeElement?.closest?.('form')) studies(); }, 8000);
}
const SPAL = ['#0891B2', '#7C3AED', '#DB2777', '#B45309', '#059669', '#2563EB', '#E11D48', '#64748B'];
let curveSel = null;
async function studyDetail(id, target) {
  const q = target != null && target !== '' ? `?target=${encodeURIComponent(target)}` : '';
  const d = await api('/studies/' + id + q), S = d.stats, c = d.counts, tot = Object.values(c).reduce((a, b) => a + b, 0), done = c.completed || 0;
  const act = ['queued', 'preparing', 'training', 'aggregating', 'evaluating'].reduce((a, k) => a + (c[k] || 0), 0), V = S.variants;
  if (!curveSel) curveSel = new Set(V.slice(0, 4).map((v) => v.label));
  const mine = user && (user.role === 'admin' || (user.role === 'researcher' && d.ownerId === user.id));
  const chart = () => { const sel = V.filter((v) => curveSel.has(v.label) && v.curve.length); if (!sel.length) return '<p class="muted">Select variants with completed runs.</p>';
    const n = Math.max(...sel.map((v) => v.curve.length)), W = 640, H = 260, L = 44, B = 215, T = 12, X = (i) => L + (n === 1 ? 0 : (i / (n - 1)) * (W - L - 16)), Y = (v) => B - Math.max(0, Math.min(1, v)) * (B - T);
    let g = ''; [0, .25, .5, .75, 1].forEach((t) => (g += `<line x1="${L}" x2="${W - 16}" y1="${Y(t)}" y2="${Y(t)}" stroke="var(--border)"/><text x="${L - 6}" y="${Y(t) + 4}" text-anchor="end">${t.toFixed(2)}</text>`));
    sel.forEach((v) => { const col = SPAL[V.indexOf(v) % SPAL.length]; const up = v.curve.map((p, i) => `${X(i)},${Y(p.mean + (p.sd || 0))}`), lo = v.curve.map((p, i) => `${X(i)},${Y(p.mean - (p.sd || 0))}`).reverse();
      g += `<polygon points="${up.concat(lo).join(' ')}" fill="${col}" opacity=".15"/><polyline fill="none" stroke="${col}" stroke-width="2" points="${v.curve.map((p, i) => `${X(i)},${Y(p.mean)}`).join(' ')}"/>`; });
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Mean validation macro-F1 per round with one standard deviation band, for ${sel.map((v) => v.label).join(', ')}">${g}<text x="${W / 2}" y="${H - 6}" text-anchor="middle">COMMUNICATION ROUND / EPOCH</text></svg><p class="small-caps legend">${sel.map((v) => `<span><i style="background:${SPAL[V.indexOf(v) % SPAL.length]}"></i>${esc(v.label)}</span>`).join('')}</p>`; };
  const rare = S.classes.length ? S.classes[S.classes.length - 1] : null;
  shell('studies', `<p><a href="/app/studies">← All studies</a></p><h2 class="h2s" style="margin-top:0">${esc(d.name)}</h2>
    <p class="small-caps muted">${esc(d.preset)} · ${d.seeds} seeds · ${d.config.skew} skew · ${d.config.rounds} rounds · ${d.config.clients} clients${d.config.datasetName ? ' · ' + esc(d.config.datasetName) : ' · NSL-KDD'} · by ${esc(d.owner)}</p>
    <p class="muted">${esc(d.note || '')}</p>
    <p><progress max="${tot || 1}" value="${done}" style="width:100%" aria-label="Completed runs"></progress><span class="small-caps muted">${done} of ${tot} runs completed${c.failed ? ` · ${c.failed} failed` : ''}${c.cancelled ? ` · ${c.cancelled} cancelled` : ''}${act ? ' · running' : ''}</span></p>
    ${mine ? `<p>${act ? '<button class="btn btn-s" id="sc">Cancel remaining runs</button>' : '<button class="btn btn-s" id="sdel">Delete study</button>'}</p>` : ''}
    <div class="cta" style="justify-content:flex-start;margin:1rem 0"><button class="btn btn-s" id="csv">Download CSV</button><button class="btn btn-s" id="tex">Copy LaTeX table</button></div>
    <p><span class="badge">Generated</span> <span class="muted small">Mean ± sample standard deviation; brackets are 95% t-intervals over seeds. Differences are paired by seed. No correction for multiple comparisons.</span></p>
    ${table('Test-set results by variant', ['Variant', 'Runs', 'Macro-F1', 'Accuracy', 'False-alarm rate', 'Attack detection', 'Test-21 macro-F1', 'Novel-attack detection', 'Rounds to target'],
      V.map((v) => `<tr><td>${esc(v.label)}</td><td class="n">${v.n}/${v.planned}</td><td class="n">${pm(v.metrics.macroF1)}<br><span class="muted small">${ci(v.metrics.macroF1)}</span></td><td class="n">${pm(v.metrics.accuracy)}</td><td class="n">${pm(v.metrics.falseAlarmRate)}</td><td class="n">${pm(v.metrics.detectionRate)}</td><td class="n">${pm(v.metrics.test21MacroF1)}</td><td class="n">${pm(v.metrics.novelDetection)}</td><td class="n">${v.roundsToTarget.mean == null ? '—' : v.roundsToTarget.mean.toFixed(1)} (${v.roundsToTarget.reached}/${v.n})</td></tr>`))}
    <form id="tg" class="small" style="margin:.5rem 0"><label for="tv" style="display:inline">Target validation macro-F1 for “rounds to target”:</label> <input id="tv" type="number" step="0.001" min="0" max="1" value="${S.target ?? ''}" style="width:7rem;height:40px"> <button class="btn btn-s">Apply</button> <span class="muted">default: 90% of the best mean</span></form>
    <h3 class="h2s">Difference from ${esc(S.reference)} (paired by seed)</h3>
    ${table('Paired differences', ['Variant', 'Δ macro-F1 [95% CI]', 'CI excludes 0?', 'Δ false-alarm', 'Δ attack detection', 'Δ Test-21 macro-F1', 'Δ novel detection'],
      V.filter((v) => v.pairedVsReference).map((v) => { const p = v.pairedVsReference; return `<tr><td>${esc(v.label)}</td><td class="n">${dlt(p.macroF1)}</td><td>${verdict(p.macroF1)}</td><td class="n">${dlt(p.falseAlarmRate)}</td><td class="n">${dlt(p.detectionRate)}</td><td class="n">${dlt(p.test21MacroF1)}</td><td class="n">${dlt(p.novelDetection)}</td></tr>`; }))}
    ${rare ? `<h3 class="h2s">Per-class F1 (mean ± sd)</h3>${table('Per-class F1 by variant', ['Variant', ...S.classes], V.map((v) => `<tr><td>${esc(v.label)}</td>${S.classes.map((k) => `<td class="n">${pm(v.perClass[k], 2)}</td>`).join('')}</tr>`))}<p class="muted small">Macro-F1 averages the classes equally, so a rare class (here “${esc(rare)}”, very few test rows) moves it as much as a common one. Check this table before reading anything into macro-F1.</p>` : ''}
    <h3 class="h2s">Convergence</h3><fieldset class="card"><legend class="small-caps">Variants shown</legend>${V.map((v) => `<label style="display:inline-flex;gap:.4rem;margin:.25rem 1rem .25rem 0;font-weight:400"><input type="checkbox" data-v="${esc(v.label)}" ${curveSel.has(v.label) ? 'checked' : ''} style="width:auto;height:auto"> ${esc(v.label)}</label>`).join('')}<div id="ch">${chart()}</div></fieldset>`);
  document.querySelectorAll('input[data-v]').forEach((i) => (i.onchange = () => { i.checked ? curveSel.add(i.dataset.v) : curveSel.delete(i.dataset.v); $('#ch').innerHTML = chart(); }));
  $('#tg').onsubmit = (e) => { e.preventDefault(); studyDetail(id, $('#tv').value); };
  if ($('#sc')) $('#sc').onclick = async () => { if (await confirmDlg('Cancel all queued and running runs of this study?')) { await api(`/studies/${id}/cancel`, { method: 'POST', body: {} }).catch((x) => say(x.message)); studyDetail(id, target); } };
  if ($('#sdel')) $('#sdel').onclick = async () => { if (await confirmDlg('Delete this study and all of its runs?')) { await api('/studies/' + id, { method: 'DELETE' }).catch((x) => say(x.message)); go('/app/studies'); } };
  const rows = () => V.map((v) => [v.label, v.n, ...['macroF1', 'accuracy', 'falseAlarmRate', 'detectionRate', 'test21MacroF1', 'novelDetection'].flatMap((m) => [v.metrics[m].mean, v.metrics[m].sd, v.metrics[m].ci?.[0], v.metrics[m].ci?.[1]])]);
  $('#csv').onclick = () => { const head = ['variant', 'runs', ...['macroF1', 'accuracy', 'falseAlarmRate', 'detectionRate', 'test21MacroF1', 'novelDetection'].flatMap((m) => [m + '_mean', m + '_sd', m + '_ci_lo', m + '_ci_hi'])];
    const csv = [head, ...rows()].map((r) => r.map((x) => (typeof x === 'number' ? x.toFixed(5) : x == null ? '' : `"${String(x).replace(/"/g, '""')}"`)).join(',')).join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = `study-${id}.csv`; a.click(); };
  $('#tex').onclick = async () => { const tx = (s) => (s?.mean == null ? '--' : s.sd == null ? s.mean.toFixed(3) : `${s.mean.toFixed(3)} $\\pm$ ${s.sd.toFixed(3)}`), esc2 = (t) => t.replace(/[&%#_]/g, (m) => '\\' + m);
    const t = `\\begin{tabular}{lrcccc}\n\\hline\nVariant & Runs & Macro-F1 & Accuracy & False-alarm & Detection \\\\\n\\hline\n${V.map((v) => `${esc2(v.label)} & ${v.n} & ${tx(v.metrics.macroF1)} & ${tx(v.metrics.accuracy)} & ${tx(v.metrics.falseAlarmRate)} & ${tx(v.metrics.detectionRate)} \\\\`).join('\n')}\n\\hline\n\\end{tabular}`;
    try { await navigator.clipboard.writeText(t); say('LaTeX table copied'); } catch { say('Copy failed; use the CSV instead'); } };
  if (act) poll(() => { if (location.pathname === `/app/studies/${id}` && !document.activeElement?.closest?.('form, fieldset')) studyDetail(id, target); }, 6000); else clearInterval(timer);
}


// ---------- detect: enter your own records and score them ----------
const NSL_GROUPS = [['Connection', ['duration', 'protocol_type', 'service', 'flag', 'src_bytes', 'dst_bytes', 'land', 'wrong_fragment', 'urgent']],
  ['Content', ['hot', 'num_failed_logins', 'logged_in', 'num_compromised', 'root_shell', 'su_attempted', 'num_root', 'num_file_creations', 'num_shells', 'num_access_files', 'num_outbound_cmds', 'is_host_login', 'is_guest_login']],
  ['Traffic in the last two seconds', ['count', 'srv_count', 'serror_rate', 'srv_serror_rate', 'rerror_rate', 'srv_rerror_rate', 'same_srv_rate', 'diff_srv_rate', 'srv_diff_host_rate']],
  ['Destination host statistics', ['dst_host_count', 'dst_host_srv_count', 'dst_host_same_srv_rate', 'dst_host_diff_srv_rate', 'dst_host_same_src_port_rate', 'dst_host_srv_diff_host_rate', 'dst_host_serror_rate', 'dst_host_srv_serror_rate', 'dst_host_rerror_rate', 'dst_host_srv_rerror_rate']]];
const HINT = { duration: 'Connection length in seconds', protocol_type: 'tcp, udp or icmp', service: 'Destination service, e.g. http', flag: 'Connection status; SF is a normal finish', src_bytes: 'Bytes sent by the source', dst_bytes: 'Bytes sent back',
  logged_in: '1 if login succeeded', count: 'Connections to the same host recently', serror_rate: 'Share with SYN errors (0 to 1)', rerror_rate: 'Share with REJ errors (0 to 1)', same_srv_rate: 'Share to the same service (0 to 1)' };
const det = { schema: null, batch: [], mode: 'form' };

// minimal CSV/TSV parser (quotes supported); first row must be column names
function parseTable(text, schema) {
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim()); if (lines.length < 2) throw new Error('Add a header row of column names followed by at least one data row.');
  const delim = lines[0].includes('\t') ? '\t' : ',';
  const cells = (l) => { const o = []; let cur = '', q = false; for (let i = 0; i < l.length; i++) { const ch = l[i]; if (q) { if (ch === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; } else if (ch === '"') q = true; else if (ch === delim) { o.push(cur.trim()); cur = ''; } else cur += ch; } o.push(cur.trim()); return o; };
  const head = cells(lines[0]), known = new Set([...schema.numeric.map((f) => f.name), ...schema.categorical.map((f) => f.name)]), hit = head.filter((h) => known.has(h)).length;
  if (hit < Math.min(3, known.size)) throw new Error(`Only ${hit} of the model's ${known.size} columns were found in the header (at least ${Math.min(3, known.size)} are needed). Names must match exactly, for example: ${[...known].slice(0, 4).join(', ')}…`);
  return lines.slice(1).map((l) => { const c = cells(l), r = {}; head.forEach((h, i) => { if (known.has(h) && c[i] !== undefined) r[h] = c[i]; }); return r; });
}
const fmtPct = (v) => `${(v * 100).toFixed(1)}%`;
async function detect() {
  const [{ models }, { history }] = await Promise.all([api('/models'), api('/detect/history')]);
  if (!models.length) return shell('detect', `<div class="empty"><h3>No trained model yet</h3><p>Detect scores records with a model trained on this server.${isRunner() ? ' Run an experiment first, then come back.' : ' Ask a researcher to run an experiment.'}</p>${isRunner() ? '<a class="btn btn-p" href="/app/experiments">Train a model</a>' : ''}</div>`);
  const cur = det.schema && models.some((m) => m.id === det.schema.id) ? det.schema.id : models[0].id;
  shell('detect', `<p class="muted">Enter network records, one at a time, pasted, or from a CSV file, and see how a trained model classifies each one.</p>
    <p class="notice small" role="note"><b>Research model.</b> Predictions come from a model trained on public research data and are not a replacement for a production intrusion-detection system. Records you enter are scored on this server and are not stored; only counts appear in your history.</p>
    <h2 class="h2s">1. Choose a model</h2>
    <div class="fgrid"><div><label for="dm">Trained model</label><select id="dm" class="full">${models.map((m) => `<option value="${m.id}" ${m.id === cur ? 'selected' : ''}>#${m.id} ${esc(m.name)} (${esc(m.method)}, ${esc(m.dataset)})</option>`).join('')}</select></div></div>
    <p class="muted small" id="minfo"></p>
    <h2 class="h2s">2. Enter data</h2><div id="entry"><div class="sk sk-t"></div></div>
    <h2 class="h2s">3. Results</h2><div id="out" aria-live="polite"><div class="empty"><p>Results appear here after you analyze a batch.</p></div></div>
    <h2 class="h2s">Recent analyses</h2>${history.length ? table('Your recent analyses', ['When', 'Model', 'Records', 'Alerts', 'Errors'], history.map((h) => `<tr><td>${esc(when(h.createdAt))}</td><td>#${h.modelId} ${esc(h.model)}</td><td class="n">${h.records}</td><td class="n">${h.summary.alerts ?? '—'}</td><td class="n">${h.errors}</td></tr>`)) : '<p class="muted small">Nothing yet.</p>'}`);
  const pick = async () => {
    const id = +$('#dm').value; $('#entry').innerHTML = '<div class="sk sk-t"></div>';
    try { det.schema = await api(`/models/${id}/schema`); } catch (x) { $('#entry').innerHTML = `<p class="err">${esc(x.message)}</p>`; return; }
    det.batch = []; $('#out').innerHTML = '<div class="empty"><p>Results appear here after you analyze a batch.</p></div>';
    const m = models.find((x) => x.id === id); $('#minfo').textContent = `Classes: ${det.schema.classes.join(', ')} · ${det.schema.numeric.length + det.schema.categorical.length} input fields · validation macro-F1 on its test set ${f3(m.macroF1)}`;
    entryUI();
  };
  $('#dm').onchange = pick; await pick();
}
function fieldHtml(f, kind) {
  const hint = HINT[f.name] ? `<span class="muted small">${esc(HINT[f.name])}</span>` : '';
  return kind === 'num' ? `<div><label for="f_${esc(f.name)}">${esc(f.name)}</label><input id="f_${esc(f.name)}" data-f="${esc(f.name)}" type="number" step="any" inputmode="decimal" placeholder="avg ${Math.abs(f.mean) >= 100 ? Math.round(f.mean) : f.mean.toFixed(2)}">${hint}</div>`
    : `<div><label for="f_${esc(f.name)}">${esc(f.name)}</label><select id="f_${esc(f.name)}" data-f="${esc(f.name)}" class="full"><option value="">—</option>${f.values.map((v) => `<option>${esc(v)}</option>`).join('')}</select>${hint}</div>`;
}
function entryUI() {
  const S = det.schema, nm = new Map(S.numeric.map((f) => [f.name, f])), cm = new Map(S.categorical.map((f) => [f.name, f]));
  const groups = S.dataset === 'nsl-kdd' ? NSL_GROUPS : [['Fields', [...S.numeric.map((f) => f.name), ...S.categorical.map((f) => f.name)]]];
  const modes = [['form', 'Single record'], ['paste', 'Paste rows'], ['file', 'Upload CSV']];
  $('#entry').innerHTML = `<div class="tabs" role="tablist" aria-label="How to enter data" style="margin-top:0">${modes.map(([k, t]) => `<button role="tab" aria-selected="${det.mode === k}" data-m="${k}" class="tabbtn">${t}</button>`).join('')}</div>
    <div id="mode"></div>
    <div class="card batch" id="batchbox"><div id="bsum"></div><div class="cta" style="justify-content:flex-start;margin-top:1rem"><button class="btn btn-p" id="go">Analyze batch</button><button class="btn btn-s" id="clr">Clear batch</button></div><p class="err" id="err" role="alert"></p></div>`;
  const drawMode = () => {
    document.querySelectorAll('[data-m]').forEach((b) => b.setAttribute('aria-selected', b.dataset.m === det.mode));
    const el = $('#mode');
    if (det.mode === 'form') {
      el.innerHTML = `<form id="rf" class="card top">${S.examples.length ? `<div class="fgrid"><div><label for="ex">Start from an example</label><select id="ex" class="full"><option value="">Choose…</option>${S.examples.map((e, i) => `<option value="${i}">${esc(e.label)}</option>`).join('')}</select><span class="muted small">First matching row of the training file for that class. Examples are only for trying the form; the model may not classify each one correctly.</span></div></div>` : ''}
        ${groups.map(([g, names], gi) => `<details ${gi === 0 ? 'open' : ''}><summary class="small-caps">${esc(g)}</summary><div class="fgrid">${names.map((n) => (nm.has(n) ? fieldHtml(nm.get(n), 'num') : cm.has(n) ? fieldHtml(cm.get(n), 'cat') : '')).join('')}</div></details>`).join('')}
        <p class="muted small">Empty numeric fields use the model’s training average. Unknown categories are flagged in the results.</p>
        <div class="cta" style="justify-content:flex-start"><button class="btn btn-p" type="submit">Add to batch</button><button class="btn btn-s" type="button" id="avg">Fill averages</button><button class="btn btn-g" type="button" id="rst">Reset</button></div></form>`;
      if ($('#ex')) $('#ex').onchange = (e) => { const x = S.examples[e.target.value]; if (!x) return; document.querySelectorAll('#rf [data-f]').forEach((i) => { i.value = x.record[i.dataset.f] ?? ''; }); say('Loaded example: ' + x.label, true); };
      $('#avg').onclick = () => document.querySelectorAll('#rf input[data-f]').forEach((i) => { const f = nm.get(i.dataset.f); if (f) i.value = +f.mean.toFixed(4); });
      $('#rst').onclick = () => $('#rf').reset();
      $('#rf').onsubmit = (e) => { e.preventDefault(); const r = {}; document.querySelectorAll('#rf [data-f]').forEach((i) => { if (i.value !== '') r[i.dataset.f] = i.value; }); if (!Object.keys(r).length) return ($('#err').textContent = 'Fill in at least one field, or choose an example.'); addBatch([r]); };
    } else if (det.mode === 'paste') {
      el.innerHTML = `<form id="pf2" class="card top"><label for="pt">Paste rows (comma or tab separated)</label><textarea id="pt" rows="8" spellcheck="false" placeholder="${esc([...nm.keys(), ...cm.keys()].slice(0, 5).join(',') + ',…')}"></textarea>
        <p class="muted small">The first line must be column names that match the model’s fields (any order; extra columns are ignored). Up to 1000 rows per analysis.</p><button class="btn btn-p">Add rows to batch</button></form>`;
      $('#pf2').onsubmit = (e) => { e.preventDefault(); try { addBatch(parseTable($('#pt').value, S)); $('#pt').value = ''; } catch (x) { $('#err').textContent = x.message; } };
    } else {
      el.innerHTML = `<form id="uf3" class="card top"><label for="cf">CSV file (up to 5 MB, 1000 rows used)</label><input id="cf" type="file" accept=".csv,.tsv,text/csv,text/plain"><p class="muted small">Needs a header row with the model’s column names. The file is read in your browser; only the rows you analyze are sent to the server.</p><button class="btn btn-p">Add file to batch</button></form>`;
      $('#uf3').onsubmit = async (e) => { e.preventDefault(); const f = $('#cf').files[0]; if (!f) return ($('#err').textContent = 'Choose a file first.'); if (f.size > 5 * 1048576) return ($('#err').textContent = 'File is larger than 5 MB.');
        try { addBatch(parseTable(await f.text(), S)); } catch (x) { $('#err').textContent = x.message; } };
    }
  };
  const drawBatch = () => { $('#bsum').innerHTML = det.batch.length ? `<b>${det.batch.length}</b> record${det.batch.length === 1 ? '' : 's'} in the batch${det.batch.length >= 1000 ? ' (limit reached)' : ''}. <span class="muted small">Latest: ${esc(Object.entries(det.batch.at(-1)).slice(0, 4).map(([k, v]) => `${k}=${v}`).join(', '))}…</span>` : '<span class="muted">The batch is empty. Add a record above.</span>'; $('#go').disabled = !det.batch.length; $('#clr').disabled = !det.batch.length; };
  const addBatch = (rows) => { $('#err').textContent = ''; const room = 1000 - det.batch.length; det.batch.push(...rows.slice(0, room)); if (rows.length > room) $('#err').textContent = `Only ${room} more row(s) fit; the rest were skipped.`; drawBatch(); say(`${Math.min(rows.length, room)} record(s) added to the batch`); };
  document.querySelectorAll('[data-m]').forEach((b) => (b.onclick = () => { det.mode = b.dataset.m; drawMode(); }));
  $('#clr').onclick = () => { det.batch = []; drawBatch(); };
  $('#go').onclick = async () => {
    const btn = $('#go'); btn.disabled = true; btn.classList.add('busy'); $('#err').textContent = '';
    try { const r = await api('/detect', { method: 'POST', body: { modelId: det.schema.id, records: det.batch } }); showResults(r); say(`Analyzed ${r.summary.total} record(s): ${r.summary.alerts ?? '—'} flagged`); }
    catch (x) { $('#err').textContent = x.message; } finally { btn.classList.remove('busy'); drawBatch(); }
  };
  drawMode(); drawBatch();
}
function showResults(r) {
  const S = r.summary, cls = r.classes, ok = r.results.filter((x) => !x.error), top = Object.entries(S.byClass).sort((a, b) => b[1] - a[1])[0];
  const rows = r.results.slice(0, 200).map((x) => { const att = S.benign && x.class !== S.benign;
    return x.error ? `<tr><td>${x.index + 1}</td><td><span class="badge warn">Error</span></td><td colspan="3">${esc(x.error)}</td></tr>`
      : `<tr><td>${x.index + 1}</td><td><span class="badge ${att ? 'alert' : 'st-completed'}">${att ? '⚠ Alert' : '✓ OK'}</span></td><td>${esc(x.class)}</td><td class="n">${fmtPct(x.confidence)}</td><td style="min-width:10rem">${stack(cls.map((c) => x.probabilities[c]), cls)}${x.warnings.length ? `<span class="muted small">${esc(x.warnings.join('; '))}</span>` : ''}</td></tr>`; });
  $('#out').innerHTML = `<div class="cards"><div class="card top"><span class="small-caps">Scored</span><b class="big">${S.scored}</b><span class="muted small">of ${S.total} records${S.errors ? `, ${S.errors} with errors` : ''}</span></div>
    ${S.alerts != null ? `<div class="card"><span class="small-caps">Flagged as attack</span><b class="big">${S.alerts}</b><span class="muted small">${S.scored ? fmtPct(S.alerts / S.scored) : '—'} of scored records</span></div>` : ''}
    <div class="card"><span class="small-caps">Most common class</span><b class="big" style="font-size:1.75rem">${esc(top ? top[0] : '—')}</b><span class="muted small">${top ? top[1] : 0} record(s)</span></div></div>
    ${legend(cls)}${table(`Results${r.results.length > 200 ? ' (first 200 shown; download for all)' : ''}`, ['#', 'Verdict', 'Class', 'Confidence', 'Class probabilities'], rows)}
    <div class="cta" style="justify-content:flex-start;margin-top:1rem"><button class="btn btn-s" id="dl">Download results (CSV)</button></div>
    <p class="muted small">Confidence is the model’s probability for its top class, not a guarantee of correctness.</p>`;
  $('#dl').onclick = () => { const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`, head = ['record', 'verdict', 'class', 'confidence', ...cls.map((c) => 'p_' + c), 'notes'];
    const csv = [head.join(','), ...r.results.map((x) => x.error ? [x.index + 1, 'error', '', '', ...cls.map(() => ''), q(x.error)].join(',') : [x.index + 1, S.benign && x.class !== S.benign ? 'alert' : 'ok', q(x.class), x.confidence.toFixed(4), ...cls.map((c) => x.probabilities[c].toFixed(4)), q(x.warnings.join('; '))].join(','))].join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = 'detection-results.csv'; a.click(); };
  if (motionOn()) $('#out').querySelectorAll('.stack span').forEach((s, i) => s.style.setProperty('--i', i % 8));
  countUp($('#out'));
  $('#out').scrollIntoView({ behavior: motionOn() ? 'smooth' : 'auto', block: 'nearest' });
}

async function compare() {
  const [g, p] = await Promise.all([api('/experiments/compare'), api('/paper/results')]);
  const find = (m, s) => g.runs.find((r) => r.config.method === m && (m === 'centralized' || r.config.skew === s));
  const SK = ['mild', 'moderate', 'extreme'], pv = (m, s) => p.comparison.find((r) => r.method === (m === 'ada' ? 'ADA-FedAvg' : m === 'fedavg' ? 'FedAvg' : 'Centralized') && (m === 'centralized' || r.skew === s));
  const rows = [['centralized', null], ...SK.flatMap((s) => [['fedavg', s], ['ada', s]])].map(([m, s]) => { const a = pv(m, s), b = find(m, s)?.metrics;
    return `<tr><td>${m === 'ada' ? 'ADA-FedAvg' : m === 'fedavg' ? 'FedAvg' : 'Centralized'}</td><td>${s ?? '—'}</td><td class="n">${f3(a?.macroF1)}</td><td class="n">${f3(b?.macroF1)}</td><td class="n">${b ? (b.macroF1 - a.macroF1 >= 0 ? '+' : '') + (b.macroF1 - a.macroF1).toFixed(3) : '—'}</td><td class="n">${f3(a?.accuracy)}</td><td class="n">${f3(b?.accuracy)}</td></tr>`; });
  const val = (m) => SK.map((s) => find(m, s)?.metrics?.macroF1 ?? null);
  shell('compare', `<p class="muted">Paper-reported values side by side with the latest completed run of each configuration on this server (default settings reproduce the paper's setup; results can differ).</p>
    <div class="card top">${groupedBars(SK, [{ name: 'Paper FedAvg', color: 'var(--mfg)', vals: SK.map((s) => pv('fedavg', s).macroF1) }, { name: 'Paper ADA-FedAvg', color: 'var(--accent)', vals: SK.map((s) => pv('ada', s).macroF1) }, { name: 'Generated FedAvg', color: '#6b8e9b', vals: val('fedavg') }, { name: 'Generated ADA-FedAvg', color: '#a0522d', vals: val('ada') }])}</div>
    ${table('Paper-reported vs generated', ['Method', 'Skew', 'Macro-F1 paper', 'Macro-F1 generated', 'Δ', 'Acc. paper', 'Acc. generated'], rows)}
    <p class="muted small">“—” means no completed run yet. No statistical significance is claimed: each cell is a single run with one seed.</p>`);
}
async function paperTab() {
  const d = await api('/paper/results'), SK = ['mild', 'moderate', 'extreme'], g = (m, s) => d.comparison.find((r) => r.method === m && r.skew === s).macroF1;
  shell('paper', `<p><span class="badge">Paper-reported</span> <span class="muted">${esc(d.note)}</span></p>
    <div class="card top">${groupedBars(SK, [{ name: 'Centralized', color: 'var(--fg)', vals: SK.map(() => d.comparison[0].macroF1) }, { name: 'FedAvg', color: 'var(--mfg)', vals: SK.map((s) => g('FedAvg', s)) }, { name: 'ADA-FedAvg', color: 'var(--accent)', vals: SK.map((s) => g('ADA-FedAvg', s)) }])}</div>
    ${table('Centralized vs FedAvg vs ADA-FedAvg', ['Method', 'Skew', 'Acc.', 'Macro-F1', 'W-F1', 'Comm. MB'], d.comparison.map((r) => `<tr><td>${esc(r.method)}</td><td>${esc(r.skew ?? '—')}</td><td class="n">${f3(r.accuracy)}</td><td class="n">${f3(r.macroF1)}</td><td class="n">${f3(r.weightedF1)}</td><td class="n">${r.commMB ?? 'N/A'}</td></tr>`))}
    ${table('Centralized baseline, per-class test results', ['Class', 'Precision', 'Recall', 'F1', 'Support'], d.centralizedPerClass.map((r) => `<tr><td>${esc(r.class)}</td><td class="n">${f3(r.precision)}</td><td class="n">${f3(r.recall)}</td><td class="n">${f3(r.f1)}</td><td class="n">${r.support}</td></tr>`))}
    <p class="muted small">Configuration: ${esc(d.config.model)}; ${d.config.clients} clients, ${d.config.rounds} rounds, K=${d.config.clusters}; Dirichlet α = ${Object.entries(d.config.skewAlpha).map(([k, v]) => k + ' ' + v).join(', ')}.</p>`);
}
function privacy() {
  shell('privacy', `<div class="prose"><p class="muted">Federated learning reduces the need to centralise raw data. It does not remove privacy risk, and this platform makes no formal privacy claim.</p>
  <h3>How experiments run here</h3><p>Training is a <b>single-machine simulation</b>: the server’s worker holds the NSL-KDD data and partitions it across simulated clients. No real client devices send data to this server.</p>
  <h3>What a client shares (in the method)</h3><p>Its model update every round, plus a class-distribution histogram sent once before training (about 4 bytes per class per client; reported as “summary bytes”, so ADA-FedAvg’s extra cost is small but not zero). Histograms are not differentially private and can reveal that a client sees an unusual attack mix.</p><h3>Robustness</h3><p>A client that reports a distinctive histogram can form its own cluster and receive up to 1/K of the global model’s weight. The Robustness study measures this with a simulated Sybil client, and the “blend” option bounds cluster weights.</p>
  <h3>What stays local</h3><p>Raw records. Model updates and summaries can still leak information through inference attacks; no secure aggregation or differential privacy is implemented.</p>
  <h3>Access and retention</h3><p>Accounts use server-side sessions, role-based permissions enforced on the server (viewer, researcher, admin), lockout after repeated failures and an audit log. Experiment results are kept until their owner or an administrator deletes them; uploaded datasets are not accepted.</p>
  <h3>Known limitations</h3><p>Results come from single seeds. Poisoning and malicious-client robustness are not evaluated. Email delivery needs SMTP configuration; otherwise messages go to a development outbox.</p></div>`);
}
function settings() {
  shell('settings', `<div class="grid2s"><form class="card top" id="pf"><h3>Profile</h3><label for="nm">Name</label><input id="nm" value="${esc(user.name)}" maxlength="80" required>
    <p class="muted small">${esc(user.email)} · role: ${esc(user.role)}</p><p class="err" id="e1" role="alert"></p><button class="btn btn-p">Save</button></form>
    <form class="card" id="pw"><h3>Change password</h3><label for="cp">Current password</label><input id="cp" type="password" autocomplete="current-password" required>
    <label for="np">New password (10+ characters)</label><input id="np" type="password" autocomplete="new-password" minlength="10" required><p class="err" id="e2" role="alert"></p><button class="btn btn-p">Update password</button></form></div>
    <div class="card" id="appearance"><h3>Appearance and motion</h3><p class="muted small">Saved on this device only. The quick toggles in the header change the same settings.</p>
      ${seg('theme', 'Theme', [['light', 'Light', 'Ivory and ink'], ['dark', 'Dark', 'Warm charcoal'], ['system', 'System', 'Follow your device']], getPref('theme', 'system'))}
      ${seg('motion', 'Motion', [['system', 'System', 'Follow your device'], ['full', 'Full', 'Animated charts and numbers'], ['reduced', 'Reduced', 'No animation']], getPref('motion', 'system'))}
      ${seg('size', 'Text size', [['normal', 'Normal', ''], ['large', 'Large', 'About 12% bigger']], getPref('size', 'normal'))}
      <div class="motion-preview" aria-hidden="true"><span class="small-caps muted">Motion preview</span><div class="mp-track"><i class="mp-dot"></i></div><div class="mp-bar"><i></i></div></div>
      <p class="muted small">“Reduced” turns off page transitions, count-up numbers, animated charts and the hero illustration. “System” follows your device’s reduce-motion setting.</p></div>`);
  document.querySelectorAll('.seg').forEach((g) => g.addEventListener('change', (e) => { const k = g.dataset.pref, v = e.target.value; (k === 'theme' ? applyTheme : k === 'motion' ? applyMotion : applySize)(v); renderNav(); say(`${k[0].toUpperCase() + k.slice(1)}: ${v}`, true); }));
  $('#pf').onsubmit = async (e) => { e.preventDefault(); try { await api('/auth/profile', { method: 'PATCH', body: { name: $('#nm').value } }); user.name = $('#nm').value; say('Profile saved'); } catch (x) { $('#e1').textContent = x.message; } };
  $('#pw').onsubmit = async (e) => { e.preventDefault(); try { await api('/auth/change-password', { method: 'POST', body: { currentPassword: $('#cp').value, newPassword: $('#np').value } }); $('#pw').reset(); say('Password updated; other sessions were signed out'); $('#e2').textContent = ''; } catch (x) { $('#e2').textContent = x.message; } };
}
async function users() {
  const { users: u } = await api('/admin/users');
  shell('users', `${table('Users', ['Name', 'Email', 'Role', ''], u.map((x) => `<tr><td>${esc(x.name)}</td><td>${esc(x.email)}</td><td>${x.id === user.id ? esc(x.role) : `<select data-id="${x.id}" aria-label="Role for ${esc(x.email)}">${['viewer', 'researcher', 'admin'].map((r) => `<option ${r === x.role ? 'selected' : ''}>${r}</option>`).join('')}</select>`}</td><td>${x.id === user.id ? '' : `<button class="btn btn-g" data-del="${x.id}">Delete</button>`}</td></tr>`))}<p class="err" id="err" role="alert"></p>`);
  document.querySelectorAll('select[data-id]').forEach((s) => (s.onchange = async () => { try { await api(`/admin/users/${s.dataset.id}/role`, { method: 'PATCH', body: { role: s.value } }); say('Role updated'); } catch (x) { $('#err').textContent = x.message; } }));
  document.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => { if (await confirmDlg('Delete this user and their experiments?')) { await api('/admin/users/' + b.dataset.del, { method: 'DELETE' }).catch((x) => say(x.message)); users(); } }));
}
async function audit() {
  const { events } = await api('/admin/audit?limit=100');
  shell('audit', table('Audit log (latest 100)', ['Time', 'Event', 'User', 'Detail', 'IP'], events.map((e) => `<tr><td>${esc(when(e.created_at))}</td><td>${esc(e.event)}</td><td>${esc(e.user_id ?? '—')}</td><td>${esc(e.detail ?? '')}</td><td>${esc(e.ip)}</td></tr>`)));
}
async function outbox() {
  const d = await api('/admin/outbox').catch(() => null);
  shell('outbox', !d ? '<p class="muted">SMTP is configured; the development outbox is not in use.</p>' : `<p class="notice small">Development outbox: emails the server could not send because SMTP is not configured. Links expire and are purged after 24 hours.</p>${d.emails.length ? d.emails.map((m) => `<div class="card"><p class="small-caps">${esc(when(m.created_at))} · to ${esc(m.to_email)}</p><h3>${esc(m.subject)}</h3><pre>${esc(m.body)}</pre></div>`).join('') : '<div class="empty"><p>Outbox is empty.</p></div>'}`);
}


// ---------- review response (static content from /review.json) ----------
let reviewData = null;
async function reviewBody() {
  if (!reviewData) reviewData = await fetch('/review.json').then((r) => { if (!r.ok) throw new Error('Could not load the review page'); return r.json(); });
  const d = reviewData, inApp = !!user;
  const link = (it) => (it.route && inApp ? ` <a href="/app/${it.route}">Open →</a>` : '');
  return `<div class="prose"><p class="muted">${esc(d.intro)}</p></div>
    <div class="rv">${d.items.map((it, i) => `<article class="card${it.authors ? ' top' : ''}"><h3><span class="small-caps">${String(i + 1).padStart(2, '0')}</span>${esc(it.title)}</h3>
      <dl>${it.provides.length ? `<dt>What the platform provides</dt><dd><ul>${it.provides.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></dd>` : ''}
      <dt>${it.authors ? '<span class="badge warn">Needs the authors</span>' : 'Limits'}</dt><dd>${esc(it.limits)}${link(it)}</dd></dl></article>`).join('')}</div>
    <h2 class="h2s">Protocol for a defensible comparison</h2><ol class="prose">${d.protocol.map((p) => `<li>${esc(p)}</li>`).join('')}</ol>
    <p class="notice small"><b>Indicative only.</b> ${esc(d.caveat)}</p>`;
}
async function reviewPage() {
  const body = await reviewBody();
  if (user) return shell('review', `<h2 class="h2s" style="margin-top:0">Response to the methodological review</h2>${body}`);
  $('#main').innerHTML = `<div class="wrap"><section class="dash">${label('Review response')}<h1 class="h1s">Response to the methodological review</h1>${body}
    <p><a class="btn btn-p" href="/login">Sign in to run studies</a></p></section></div>`;
}
const notFound = () => ($('#main').innerHTML = `<div class="wrap"><section class="nf"><div class="code" aria-hidden="true">404</div><h2>Page not found</h2><p class="muted">That address does not exist.</p><div class="cta"><a class="btn btn-p" href="/">Home</a>${user ? '<a class="btn btn-s" href="/app">Dashboard</a>' : '<a class="btn btn-s" href="/login">Sign in</a>'}</div></section></div>`);

// footer server status (version, database, dataset)
async function showStatus() {
  const el = $('#status'); if (!el) return;
  try {
    const r = await fetch('/api/health'), h = await r.json();
    const state = !h.ok ? 'off' : (h.dataset?.train && h.dataset?.test ? '' : 'warn');
    el.innerHTML = `<i class="status-dot ${state}"></i>v${esc(h.version)}`;
    el.title = !h.ok ? 'Server reports a problem' : state === 'warn' ? 'Running, but the NSL-KDD dataset is not installed (npm run dataset)' : `Healthy · ${h.env} · up ${Math.round(h.uptimeS / 60)} min · email: ${h.email}`;
  } catch { el.innerHTML = '<i class="status-dot off"></i>offline'; el.title = 'Cannot reach the server'; }
}

// ---------- router ----------
async function route() {
  clearInterval(timer); quiet = false; barStart(); $('#main').classList.remove('quiet'); renderNav(); $('#nav').classList.remove('open'); $('#burger').setAttribute('aria-expanded', 'false');
  const q = Object.fromEntries(new URLSearchParams(location.search)), seg = location.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  try {
    if (seg[0] === 'app' || seg[0] === 'dashboard') {
      if (!user) { flash = flash || 'Please sign in to continue.'; return (go('/login', true)); }
      const t = seg[1] || '';
      { const sk = skeleton(); if ($('#panel')) $('#panel').innerHTML = sk; else $('#main').innerHTML = `<div class="wrap"><section class="dash">${sk}</section></div>`; }
      if (['users', 'audit', 'outbox'].includes(t) && user.role !== 'admin') denied();
      else if (t === 'detect') await detect(); else if (t === '') await overview(); else if (t === 'experiments') await (seg[2] ? detail(seg[2]) : experiments());
      else if (t === 'studies') await (seg[2] ? studyDetail(seg[2]) : studies()); else if (t === 'datasets') await (seg[2] ? datasetDetail(seg[2]) : datasets());
      else if (t === 'compare') await compare(); else if (t === 'paper') await paperTab(); else if (t === 'review') await reviewPage(); else if (t === 'privacy') privacy(); else if (t === 'settings') settings();
      else if (t === 'users') await users(); else if (t === 'audit') await audit(); else if (t === 'outbox') await outbox(); else notFound();
    } else if (seg[0] === 'login' || seg[0] === 'register') { if (user) return (go('/app', true)); authPage(seg[0]); }
    else if (seg[0] === 'review') await reviewPage();
    else if (seg[0] === 'forgot') forgotPage(); else if (seg[0] === 'reset') resetPage(q); else if (seg[0] === 'verify') await verifyPage(q);
    else if (!seg.length) await landing();
    else notFound();
  } catch (x) { if (x.status === 403) denied(); else if (x.status !== 401) $('#main').innerHTML = `<div class="wrap"><section><p class="err" role="alert">${esc(x.message)}</p></section></div>`; }
  setTitle(seg); renderNav(); window.scrollTo(0, 0); $('#main').focus({ preventScroll: true }); afterRender(); barDone();
}
// ---------- real page URLs (History API) ----------
// Every page has its own address (/login, /app/experiments, /app/experiments/12 ...). The server returns the app shell for these
// paths, so refresh, bookmarks, shared links and the Back button all work.
function go(url, replace) {
  if (url !== location.pathname + location.search) history[replace ? 'replaceState' : 'pushState'](null, '', url);
  setTimeout(route, 0);
}
const PAGE_TITLES = { '': 'Federated intelligence for intrusion detection', login: 'Sign in', register: 'Create account', forgot: 'Forgot password', reset: 'Choose a new password', verify: 'Verify your email', review: 'Review response' };
function setTitle(seg) {
  let t = PAGE_TITLES[seg[0] || ''];
  if (seg[0] === 'app' || seg[0] === 'dashboard') { const tab = TABS.concat(ADMIN).find(([k]) => k === (seg[1] || '')); t = (tab ? tab[1] : seg[1] === 'privacy' ? 'Privacy & limitations' : seg[1] === 'settings' ? 'Settings' : seg[1] === 'detect' ? 'Detect' : 'Dashboard') + (seg[2] ? ` #${seg[2]}` : ''); }
  document.title = (t ? t + ' · ' : '') + 'ADA-FedAvg';
}
document.addEventListener('click', (e) => {
  if (e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest && e.target.closest('a[href]');
  if (!a || a.target || a.hasAttribute('download') || (a.getAttribute('href') || '').startsWith('#')) return;
  const u = new URL(a.href, location.href);
  if (u.origin !== location.origin || u.pathname.startsWith('/api/') || /\.[a-z0-9]{2,5}$/i.test(u.pathname)) return; // other sites, API downloads and static files load normally
  e.preventDefault(); go(u.pathname + u.search);
});
addEventListener('popstate', route);
if (location.hash.startsWith('#/')) history.replaceState(null, '', location.hash.slice(1)); // old bookmarks and emailed links like /#/verify?token=...
addEventListener('scroll', () => document.querySelector('.nav')?.classList.toggle('scrolled', scrollY > 8), { passive: true });
api('/auth/me').then((r) => (user = r.user)).catch(() => {}).finally(() => { route(); showStatus(); setInterval(showStatus, 60000); });
