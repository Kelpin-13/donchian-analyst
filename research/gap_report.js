/**
 * Builds the shareable backtest report of the gap rule (research/gap_lab.js) as one self-contained HTML page.
 *
 *   node research/gap_lab.js 100 --export data/reports/gap_A.json
 *   node research/gap_lab.js 100 --list B --export data/reports/gap_B.json
 *   node research/gap_lab.js 100 --next-open --export data/reports/gap_A_open.json
 *   node research/gap_lab.js 100 --next-open --list B --export data/reports/gap_B_open.json
 *   node research/gap_report.js            -> data/reports/gap_report.html
 *
 * Every number on the page is computed here from those exports (no number is typed by hand), and the page states
 * the study's failures and limits next to its passes. Research only: nothing here trades.
 */
const fs = require('fs'), path = require('path');
const D = path.join(__dirname, '..', 'data', 'reports');
const load = f => JSON.parse(fs.readFileSync(path.join(D, f), 'utf8'));
const A = load('gap_A.json'), B = load('gap_B.json'), AO = load('gap_A_open.json'), BO = load('gap_B_open.json');

function series(eq) {
  const yearly = {}; let prev = eq[0][1];
  const lastOfYear = {}; eq.forEach(([d, v]) => { lastOfYear[d.slice(0, 4)] = v; });
  Object.keys(lastOfYear).sort().forEach(y => { yearly[y] = lastOfYear[y] / prev - 1; prev = lastOfYear[y]; });
  let pk = 0; const dd = eq.map(([d, v]) => { pk = Math.max(pk, v); return [d, v / pk - 1]; });
  const rets = eq.slice(1).map((x, i) => x[1] / eq[i][1] - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const vol = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length * 252);
  const yrs = (Date.parse(eq[eq.length - 1][0]) - Date.parse(eq[0][0])) / (365.25 * 86400000);
  return { yearly, dd, rets, vol, cagr: Math.pow(eq[eq.length - 1][1] / eq[0][1], 1 / yrs) - 1, maxDd: -Math.min(...dd.map(x => x[1])) };
}
function corr(a, b) {
  const n = Math.min(a.length, b.length), x = a.slice(-n), y = b.slice(-n);
  const mx = x.reduce((s, v) => s + v, 0) / n, my = y.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sx = 0, sy = 0; for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sx += (x[i] - mx) ** 2; sy += (y[i] - my) ** 2; }
  return sxy / Math.sqrt(sx * sy);
}
function tradeStats(x) {
  const eqAt = new Map(x.eq); let last = 1; const eqOn = d => (eqAt.has(d) ? (last = eqAt.get(d)) : last);
  const sorted = x.trades.slice().sort((a, b) => a[0] < b[0] ? -1 : 1);
  const R = sorted.map(([d, , p]) => p / (0.005 * eqOn(d)));
  const wins = R.filter(r => r > 0), losses = R.filter(r => r <= 0);
  const perYear = {}; sorted.forEach(([d]) => { perYear[d.slice(0, 4)] = (perYear[d.slice(0, 4)] || 0) + 1; });
  const tickers = {}; sorted.forEach(([, t]) => { tickers[t] = (tickers[t] || 0) + 1; });
  return {
    n: R.length, win: wins.length / R.length, avgWin: wins.reduce((a, b) => a + b, 0) / wins.length,
    avgLoss: losses.reduce((a, b) => a + b, 0) / losses.length, avgR: R.reduce((a, b) => a + b, 0) / R.length,
    best: Math.max(...R), worst: Math.min(...R), perYear, names: Object.keys(tickers).length,
    recent: sorted.slice(-8).reverse().map(([d, t], i, arr) => [d, t, +(R[R.length - 1 - i]).toFixed(2)])
  };
}
const weekly = eq => eq.filter((x, i) => i % 5 === 0 || i === eq.length - 1);
const pctl = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };
const pack = x => {
  const s = series(x.eq);
  return {
    list: x.list, stocks: x.stocks.length, design: x.design, test: x.test, pass: x.pass, cagr: s.cagr, maxDd: s.maxDd, vol: s.vol,
    yearly: s.yearly, eq: weekly(x.eq), dd: weekly(s.dd), random: x.randomCagr, p50: pctl(x.randomCagr, 50), p95: pctl(x.randomCagr, 95),
    trades: tradeStats(x), rets: s.rets
  };
};
const spyS = series(A.spyEq);
const data = {
  built: new Date().toISOString().slice(0, 10), split: A.split, from: A.eq[0][0], to: A.eq[A.eq.length - 1][0],
  A: pack(A), B: pack(B),
  open: { A: { test: AO.test, p95: pctl(AO.randomCagr, 95), pass: AO.pass }, B: { test: BO.test, p95: pctl(BO.randomCagr, 95), pass: BO.pass } },
  spy: { design: A.spy[0], test: A.spy[1], cagr: spyS.cagr, maxDd: spyS.maxDd, vol: spyS.vol, yearly: spyS.yearly, eq: weekly(A.spyEq), dd: weekly(spyS.dd) },
  listA: A.stocks, listB: B.stocks
};
data.A.corr = corr(data.A.rets, spyS.rets); data.B.corr = corr(data.B.rets, spyS.rets);
delete data.A.rets; delete data.B.rets;
const round = (k, v) => typeof v === 'number' ? +v.toFixed(5) : v;
const tpl = fs.readFileSync(path.join(__dirname, 'gap_report.html'), 'utf8');
const out = tpl.replace('/*DATA*/null', JSON.stringify(data, round));
fs.writeFileSync(path.join(D, 'gap_report.html'), out);
console.log('wrote data/reports/gap_report.html (' + Math.round(out.length / 1024) + ' KB)');
console.log('A: CAGR', (data.A.cagr * 100).toFixed(1), 'DD', (data.A.maxDd * 100).toFixed(1), 'vol', (data.A.vol * 100).toFixed(1), 'corr', data.A.corr.toFixed(2), 'trades', data.A.trades.n, 'win', data.A.trades.win.toFixed(2), 'avgR', data.A.trades.avgR.toFixed(2), 'names', data.A.trades.names);
console.log('B: CAGR', (data.B.cagr * 100).toFixed(1), 'DD', (data.B.maxDd * 100).toFixed(1), 'corr', data.B.corr.toFixed(2), 'trades', data.B.trades.n, 'avgR', data.B.trades.avgR.toFixed(2));
console.log('SPY: CAGR', (data.spy.cagr * 100).toFixed(1), 'DD', (data.spy.maxDd * 100).toFixed(1), 'vol', (data.spy.vol * 100).toFixed(1));
console.log('A yearly', Object.entries(data.A.yearly).map(([y, v]) => y.slice(2) + ':' + (v * 100).toFixed(1)).join(' '));
