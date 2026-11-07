/**
 * Chart of research/stress_lab.js: the whole book's balance week by week (base costs, live-like fills,
 * high-pressure fills), its drawdown from the peak, gold's monthly candles, and the drawdown table.
 *
 *   node research/stress_lab.js && node research/stress_chart.js     -> data/reports/stress_chart.html (git-ignored)
 *
 * One self-contained page, no outside scripts or services. Research only.
 */
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'data', 'reports');
const D = JSON.parse(fs.readFileSync(path.join(dir, 'stress.json'), 'utf8'));
const pick = ['ALL base costs', 'ALL slip +$0.25', 'ALL spread x2, +$0.50'];
const data = {
  account: D.account, from: D.from, to: D.to,
  series: pick.map((k, i) => ({ name: ['Research costs', 'Fills like the live demo (+$0.25 a side)', 'High pressure (spread x2, +$0.50 a side)'][i], pts: D.curves[k] })),
  gold: D.gold, table: D.table, scenarios: D.scenarios, volatileDays: D.volatileDays, days: D.days
};

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gold Book Stress</title>
<style>
:root { color-scheme: light; --surface: #fcfcfb; --raised: #ffffff; --text: #0b0b0b; --text2: #52514e; --muted: #8a8984; --grid: #e7e6e2;
  --s1: #2a78d6; --s2: #eb6834; --s3: #1baf7a; --dd: #e34948; --up: #52514e; --down: #0b0b0b; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { color-scheme: dark; --surface: #1a1a19; --raised: #222221; --text: #f0efec; --text2: #c3c2b7;
  --muted: #8f8e88; --grid: #33332f; --s1: #3987e5; --s2: #d95926; --s3: #199e70; --dd: #e66767; --up: #c3c2b7; --down: #f0efec; } }
:root[data-theme="dark"] { color-scheme: dark; --surface: #1a1a19; --raised: #222221; --text: #f0efec; --text2: #c3c2b7; --muted: #8f8e88; --grid: #33332f;
  --s1: #3987e5; --s2: #d95926; --s3: #199e70; --dd: #e66767; --up: #c3c2b7; --down: #f0efec; }
body { margin: 0; background: var(--surface); color: var(--text); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 16px; margin: 28px 0 4px; }
p.sub { color: var(--text2); margin: 0 0 12px; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 18px; color: var(--text2); font-size: 13px; margin: 6px 0; }
.legend i { display: inline-block; width: 14px; height: 3px; border-radius: 2px; vertical-align: middle; margin-right: 6px; }
.chart { position: relative; }
svg { display: block; width: 100%; height: auto; overflow: visible; }
.tip { position: absolute; pointer-events: none; background: var(--raised); border: 1px solid var(--grid); border-radius: 6px; padding: 6px 8px;
  font-size: 12px; color: var(--text); box-shadow: 0 2px 8px rgba(0,0,0,.12); display: none; white-space: nowrap; }
.tip b { font-weight: 600; } .tip .k { color: var(--text2); }
table { border-collapse: collapse; width: 100%; font-size: 13px; font-variant-numeric: tabular-nums; }
.scroll { overflow-x: auto; }
th, td { padding: 6px 8px; border-bottom: 1px solid var(--grid); text-align: right; white-space: nowrap; }
th { color: var(--text2); font-weight: 600; } td:first-child, th:first-child { text-align: left; }
tr.total td { font-weight: 600; }
.neg { color: var(--dd); }
.note { color: var(--text2); font-size: 13px; max-width: 760px; }
</style></head><body><main>
<h1>Gold strategies: balance, drawdown and stress</h1>
<p class="sub" id="sub"></p>
<div class="legend" id="legend"></div>
<div class="chart" id="bal"></div>
<h2>Drawdown from the last peak</h2>
<p class="sub">Research costs. The shaded dip is how far the balance sat below its best point so far.</p>
<div class="chart" id="dd"></div>
<h2>Gold, monthly candles</h2>
<p class="sub">Broker's XAUUSD.sml prices (Bid). Hollow = month closed up, filled = closed down.</p>
<div class="chart" id="gold"></div>
<h2>Worst drawdown per strategy</h2>
<p class="sub">Closed trades, research costs, $ at 0.01 lots on a $10,000 account. MC 95% / 99%: the drawdown that 5% / 1% of 5,000 reshuffles of the same days exceed.</p>
<div class="scroll"><table id="t1"></table></div>
<h2>Net profit / worst drawdown when fills are worse</h2>
<div class="scroll"><table id="t2"></table></div>
<p class="note" id="foot"></p>
</main>
<script>
const D = ${JSON.stringify(data)};
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const COL = ['--s1', '--s2', '--s3'];
const money = v => (v < 0 ? '-$' : '$') + Math.abs(Math.round(v)).toLocaleString('en-US');
const T = s => Date.parse(s.length === 7 ? s + '-15' : s);
const t0 = T(D.from), t1 = T(D.to);
document.getElementById('sub').textContent = D.from + ' to ' + D.to + ', fixed 0.01 lots, starting balance ' + money(D.account) + '. Every strategy at once, as both EAs trade now.';
document.getElementById('legend').innerHTML = D.series.map((s, i) => '<span><i style="background:var(' + COL[i] + ')"></i>' + s.name + '</span>').join('');

function frame(el, h, yMin, yMax, fmt) {
  const W = el.clientWidth || 900, m = { l: 64, r: 70, t: 10, b: 26 };
  const x = t => m.l + (t - t0) / (t1 - t0) * (W - m.l - m.r), y = v => m.t + (yMax - v) / (yMax - yMin) * (h - m.t - m.b);
  let g = '';
  const step = niceStep((yMax - yMin) / 5);
  for (let v = Math.ceil(yMin / step) * step; v <= yMax; v += step)
    g += '<line x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + y(v) + '" y2="' + y(v) + '" stroke="' + css('--grid') + '"/>' +
         '<text x="' + (m.l - 8) + '" y="' + (y(v) + 4) + '" text-anchor="end" font-size="11" fill="' + css('--muted') + '">' + fmt(v) + '</text>';
  for (let yr = new Date(t0).getUTCFullYear() + 1; yr <= new Date(t1).getUTCFullYear(); yr++) {
    const t = Date.UTC(yr, 0, 1);
    g += '<line x1="' + x(t) + '" x2="' + x(t) + '" y1="' + m.t + '" y2="' + (h - m.b) + '" stroke="' + css('--grid') + '"/>' +
         '<text x="' + (x(t) + 4) + '" y="' + (h - 8) + '" font-size="11" fill="' + css('--muted') + '">' + yr + '</text>';
  }
  return { W, h, m, x, y, g };
}
function niceStep(r) { const p = Math.pow(10, Math.floor(Math.log10(r))); const n = r / p; return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * p; }
function hover(el, f, onX) {
  const tip = document.createElement('div'); tip.className = 'tip'; el.appendChild(tip);
  const svg = el.querySelector('svg'), cross = svg.querySelector('.cross');
  svg.addEventListener('pointermove', e => {
    const r = svg.getBoundingClientRect(), px = (e.clientX - r.left) * f.W / r.width;
    const t = t0 + (px - f.m.l) / (f.W - f.m.l - f.m.r) * (t1 - t0);
    if (t < t0 || t > t1) { tip.style.display = 'none'; cross.setAttribute('opacity', 0); return; }
    const res = onX(t); if (!res) return;
    cross.setAttribute('x1', f.x(res.t)); cross.setAttribute('x2', f.x(res.t)); cross.setAttribute('opacity', 1);
    tip.innerHTML = res.html; tip.style.display = 'block';
    const left = (f.x(res.t) / f.W) * r.width; tip.style.left = Math.min(left + 12, r.width - tip.offsetWidth - 4) + 'px'; tip.style.top = '8px';
  });
  svg.addEventListener('pointerleave', () => { tip.style.display = 'none'; cross.setAttribute('opacity', 0); });
}
const near = (pts, t) => { let b = 0; for (let i = 0; i < pts.length; i++) if (Math.abs(T(pts[i][0]) - t) < Math.abs(T(pts[b][0]) - t)) b = i; return b; };

function draw() {
  // balance
  const el = document.getElementById('bal'); el.innerHTML = '';
  const all = D.series.flatMap(s => s.pts.map(p => D.account + p[1]));
  const f = frame(el, 340, Math.min(D.account, ...all) - 200, Math.max(...all) + 200, v => '$' + Math.round(v / 1000) + 'k');
  let s = f.g + '<line x1="' + f.m.l + '" x2="' + (f.W - f.m.r) + '" y1="' + f.y(D.account) + '" y2="' + f.y(D.account) + '" stroke="' + css('--muted') + '" stroke-dasharray="3 3"/>';
  D.series.slice().reverse().forEach((ser, ri) => { const i = D.series.length - 1 - ri;
    s += '<polyline fill="none" stroke="' + css(COL[i]) + '" stroke-width="2" stroke-linejoin="round" points="' + ser.pts.map(p => f.x(T(p[0])) + ',' + f.y(D.account + p[1])).join(' ') + '"/>';
    const last = ser.pts[ser.pts.length - 1];
    s += '<text x="' + (f.W - f.m.r + 6) + '" y="' + (f.y(D.account + last[1]) + 4) + '" text-anchor="start" font-size="12" fill="' + css('--text') + '">' + money(D.account + last[1]) + '</text>';
  });
  s += '<line class="cross" y1="' + f.m.t + '" y2="' + (f.h - f.m.b) + '" stroke="' + css('--muted') + '" opacity="0"/>';
  el.innerHTML = '<svg viewBox="0 0 ' + f.W + ' ' + f.h + '" role="img" aria-label="Balance over time for three cost levels">' + s + '</svg>';
  hover(el, f, t => { const i = near(D.series[0].pts, t); const p0 = D.series[0].pts[i];
    return { t: T(p0[0]), html: '<b>Week of ' + p0[0] + '</b><br>' + D.series.map((x, j) => '<span class="k">' + x.name.split(' (')[0] + ':</span> ' + money(D.account + x.pts[i][1])).join('<br>') }; });

  // drawdown
  const ed = document.getElementById('dd'); ed.innerHTML = '';
  let pk = 0; const dd = D.series[0].pts.map(p => { pk = Math.max(pk, p[1]); return [p[0], p[1] - pk]; });
  const fd = frame(ed, 160, Math.min(...dd.map(p => p[1])) - 50, 0, v => money(v));
  let a = fd.g + '<path fill="' + css('--dd') + '" fill-opacity=".25" stroke="' + css('--dd') + '" stroke-width="2" d="M' + fd.x(T(dd[0][0])) + ',' + fd.y(0) + ' ' +
          dd.map(p => 'L' + fd.x(T(p[0])) + ',' + fd.y(p[1])).join(' ') + ' L' + fd.x(T(dd[dd.length - 1][0])) + ',' + fd.y(0) + 'Z"/>';
  a += '<line class="cross" y1="' + fd.m.t + '" y2="' + (fd.h - fd.m.b) + '" stroke="' + css('--muted') + '" opacity="0"/>';
  ed.innerHTML = '<svg viewBox="0 0 ' + fd.W + ' ' + fd.h + '" role="img" aria-label="Drawdown from the peak">' + a + '</svg>';
  hover(ed, fd, t => { const i = near(dd, t); return { t: T(dd[i][0]), html: '<b>Week of ' + dd[i][0] + '</b><br>' + money(dd[i][1]) + ' below the peak (' + (dd[i][1] / D.account * 100).toFixed(1) + '% of $10k)' }; });

  // gold candles
  const eg = document.getElementById('gold'); eg.innerHTML = '';
  const fg = frame(eg, 220, Math.min(...D.gold.map(c => c[3])) * 0.97, Math.max(...D.gold.map(c => c[2])) * 1.02, v => '$' + Math.round(v).toLocaleString('en-US'));
  const bw = Math.max(3, (fg.W - fg.m.l - fg.m.r) / D.gold.length * 0.6);
  let c = fg.g;
  D.gold.forEach(k => { const [m, o, h, l, cl] = k, x = fg.x(T(m)), up = cl >= o, col = css(up ? '--up' : '--down');
    c += '<line x1="' + x + '" x2="' + x + '" y1="' + fg.y(h) + '" y2="' + fg.y(l) + '" stroke="' + col + '"/>' +
         '<rect x="' + (x - bw / 2) + '" y="' + fg.y(Math.max(o, cl)) + '" width="' + bw + '" height="' + Math.max(1, Math.abs(fg.y(o) - fg.y(cl))) + '" rx="1" fill="' + (up ? css('--surface') : col) + '" stroke="' + col + '"/>'; });
  c += '<line class="cross" y1="' + fg.m.t + '" y2="' + (fg.h - fg.m.b) + '" stroke="' + css('--muted') + '" opacity="0"/>';
  eg.innerHTML = '<svg viewBox="0 0 ' + fg.W + ' ' + fg.h + '" role="img" aria-label="Gold monthly candles">' + c + '</svg>';
  hover(eg, fg, t => { const i = near(D.gold, t), k = D.gold[i]; return { t: T(k[0]), html: '<b>' + k[0] + '</b><br>open ' + k[1] + ' high ' + k[2] + '<br>low ' + k[3] + ' close ' + k[4] }; });
}

// tables
const n0 = v => '<td' + (v < 0 ? ' class="neg"' : '') + '>' + money(v) + '</td>';
document.getElementById('t1').innerHTML = '<tr><th>Strategy</th><th>Trades</th><th>Win %</th><th>PF</th><th>Net</th><th>Worst drawdown</th><th>% of $10k</th><th>Peak → bottom</th><th>Back to peak</th><th>MC 95%</th><th>MC 99%</th><th>Worst day</th><th>Worst month</th><th>Losing run</th><th>Volatile days net</th></tr>' +
  D.table.map(r => '<tr' + (r.id === 'ALL' ? ' class="total"' : '') + '><td>' + (r.id === 'ALL' ? 'All seven' : r.id) + '</td><td>' + r.n + '</td><td>' + r.win.toFixed(0) + '</td><td>' + r.pf.toFixed(2) + '</td>' + n0(r.net) +
    '<td class="neg">' + money(-r.dd) + '</td><td>' + r.ddPct.toFixed(1) + '%</td><td>' + r.ddFrom + ' → ' + r.ddTo + '</td><td>' + r.recovered + '</td><td>' + money(-r.mc95) + '</td><td>' + money(-r.mc99) + '</td>' +
    n0(r.worstDay) + n0(r.worstMonth) + '<td>' + r.lossRun + ' (' + money(r.lossRunUsd) + ')</td>' + n0(r.volNet) + '</tr>').join('');
document.getElementById('t2').innerHTML = '<tr><th>Strategy</th>' + D.scenarios.map(s => '<th>' + s + '</th>').join('') + '</tr>' +
  D.table.map(r => '<tr' + (r.id === 'ALL' ? ' class="total"' : '') + '><td>' + (r.id === 'ALL' ? 'All seven' : r.id) + '</td>' + r.stress.map(s => '<td' + (s.net < 0 ? ' class="neg"' : '') + '>' + money(s.net) + ' / ' + money(-s.dd) + '</td>').join('') + '</tr>').join('');
document.getElementById('foot').textContent = 'Research costs: bar spread + $0.05 a side (intraday), + 0.01% a side (H4). Live demo stop-order entries 12 Oct - 5 Nov 2026 slipped $0.29 on average (10 fills). ' +
  'Volatile day: range over 1.5x the median of the previous 60 days (' + D.volatileDays + ' of ' + D.days + ' days). H4 shown as installed now (1.06, no trailing stop). Made by research/stress_lab.js; research only, not a promise of future results.';
draw(); addEventListener('resize', draw);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', draw);
</script></body></html>`;
fs.writeFileSync(path.join(dir, 'stress_chart.html'), html);
console.log('Wrote data/reports/stress_chart.html');
