/**
 * Monthly trend and sector-rotation rules on real US ETFs (Yahoo daily prices with dividends), for the paper portfolio
 * (owner, 19 Nov 2026: "yes to Yahoo, ETFs first"). Rules fixed before the first run; the index test
 * (research/etf_trend_lab.js) had not been run when this was written.
 *
 *   node research/fetch_yahoo.js SPY XLB XLE XLF XLI XLK XLP XLU XLV XLY   (once)
 *   node research/etf_rotation_lab.js
 *
 * Data: data/yahoo/<T>.csv, adjusted close (dividends reinvested). The nine original sector SPDRs (XLB materials,
 * XLE energy, XLF financials, XLI industrials, XLK technology, XLP staples, XLU utilities, XLV health care,
 * XLY consumer discretionary) exist since Dec 1998, so the universe has no survivorship problem. Cash earns the yearly
 * average 3-month US T-bill rate (table below, approximate).
 *
 *   decision  on the last trading day of each month, at its adjusted close; traded at that close (Yahoo's adjusted
 *             series has no adjusted open), so the day after the decision is the first day of the new holding
 *   cost      0.05% of the amount switched
 *   BH        benchmark: hold SPY all the time
 *   S1        SPY above its 200-day average: hold SPY; below: cash
 *   S2        the 3 sectors with the best 12-month (252-day) return, a third each; a sector whose 12-month return is
 *             not above 0 leaves its third in cash
 *   S3        S2, but everything in cash while SPY is below its 200-day average
 *   start     the first month-end with 253 days of every series (Dec 1999)
 *   measure   CAGR, worst peak-to-trough drawdown of the daily value, MAR = CAGR / worst drawdown; each half measured
 *             on its own (positions carried across the split)
 *   pick      on the design half (start to 2012-12-31, which holds 2000-02 and 2008): best MAR of S1, S2, S3; it must
 *             beat BH's MAR there, else FAIL
 *   pass      judged once on 2013-01-01 to the end: the pick's MAR beats BH's AND its CAGR is at least 90% of BH's.
 *             A pass goes into the paper portfolio, not real money.
 *   also shown, deciding nothing: cash at 0%, costs x3, the decision day moved 0-20 trading days before month-end.
 * Research only: nothing here trades.
 */
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..', 'data', 'yahoo');
const DAY = 86400000, SPLIT = Date.UTC(2013, 0, 1), COST = 0.0005;
const TBILL = { 1999: 4.64, 2000: 5.82, 2001: 3.39, 2002: 1.60, 2003: 1.01, 2004: 1.37, 2005: 3.15, 2006: 4.73, 2007: 4.36,
                2008: 1.37, 2009: 0.15, 2010: 0.14, 2011: 0.05, 2012: 0.09, 2013: 0.06, 2014: 0.03, 2015: 0.05, 2016: 0.32,
                2017: 0.93, 2018: 1.94, 2019: 2.06, 2020: 0.36, 2021: 0.05, 2022: 2.02, 2023: 5.07, 2024: 4.97, 2025: 4.2, 2026: 3.8 };
const SECTORS = ['XLB', 'XLE', 'XLF', 'XLI', 'XLK', 'XLP', 'XLU', 'XLV', 'XLY'];
const load = t => fs.readFileSync(path.join(DIR, t + '.csv'), 'utf8').trim().split(/\r?\n/).slice(1)
  .map(l => { const p = l.split(','); return { t: Date.parse(p[0] + 'T00:00:00Z'), c: +p[5] }; }).filter(b => b.c > 0);

const spy = load('SPY'), dates = spy.map(b => b.t), N = dates.length;
const align = bars => { const m = new Map(bars.map(b => [b.t, b.c])); let last = null; return dates.map(t => { if (m.has(t)) last = m.get(t); return last; }); };
const SPY = align(spy), SEC = SECTORS.map(t => align(load(t)));
const firstIdx = a => a.findIndex(v => v !== null);
const firstOk = Math.max(firstIdx(SPY), ...SEC.map(firstIdx)) + 253;
const monthEnd = dates.map((t, i) => i === N - 1 || new Date(dates[i + 1]).getUTCMonth() !== new Date(t).getUTCMonth());
const sma200 = (a, i) => { let s = 0; for (let j = i - 199; j <= i; j++) s += a[j]; return s / 200; };
const ASSETS = [SPY].concat(SEC);   // weights: index 0 = SPY, 1..9 = sectors

function decide(rule, i) {
  const w = new Array(ASSETS.length).fill(0);
  if (rule === 'BH') { w[0] = 1; return w; }
  if (rule === 'S1') { if (SPY[i] > sma200(SPY, i)) w[0] = 1; return w; }
  if (rule === 'S3' && !(SPY[i] > sma200(SPY, i))) return w;
  SEC.map((a, k) => ({ k, r: a[i] / a[i - 252] - 1 })).sort((x, y) => y.r - x.r).slice(0, 3)
    .forEach(m => { if (m.r > 0) w[m.k + 1] = 1 / 3; });
  return w;
}
function run(rule, opts) {
  const o = opts || {}, costRate = COST * (o.costX || 1);
  const isDecision = i => { const j = i + (o.offset || 0); return j < N && monthEnd[j]; };
  let start = firstOk; while (start < N && !isDecision(start)) start++;
  let w = decide(rule, start), v = 1;
  const out = [{ t: dates[start], v }];
  for (let i = start + 1; i < N; i++) {
    const yr = new Date(dates[i]).getUTCFullYear(), cashD = o.cash0 ? 0 : (TBILL[yr] !== undefined ? TBILL[yr] : 3.8) / 100 / 252;
    let g = 0, ws = 0;
    w.forEach((wk, k) => { if (wk) { g += wk * (ASSETS[k][i] / ASSETS[k][i - 1] - 1); ws += wk; } });
    v *= 1 + g + (1 - ws) * cashD;
    if (isDecision(i)) {
      const nw = decide(rule, i), turn = nw.reduce((s, p, k) => s + Math.abs(p - w[k]), 0);
      v *= 1 - turn * costRate; w = nw;
    }
    out.push({ t: dates[i], v });
  }
  return out;
}
function stats(series, from, to) {
  const s = series.filter(p => p.t >= from && p.t < to);
  const yrs = (s[s.length - 1].t - s[0].t) / (365.25 * DAY), cagr = Math.pow(s[s.length - 1].v / s[0].v, 1 / yrs) - 1;
  let pk = 0, dd = 0; s.forEach(p => { pk = Math.max(pk, p.v); dd = Math.max(dd, 1 - p.v / pk); });
  return { cagr, dd, mar: dd ? cagr / dd : Infinity, from: s[0].t, to: s[s.length - 1].t };
}
const pc = v => (v * 100).toFixed(1).padStart(6) + '%';
const RULES = ['BH', 'S1', 'S2', 'S3'];
function table(title, opts) {
  console.log(title);
  console.log('  rule | design: CAGR  worst DD   MAR | test: CAGR  worst DD   MAR');
  const res = {};
  RULES.forEach(r => {
    const sr = run(r, opts), a = stats(sr, -Infinity, SPLIT), b = stats(sr, SPLIT, Infinity);
    res[r] = { a, b };
    console.log('  ' + r.padEnd(4) + ' |' + pc(a.cagr).padStart(13) + pc(a.dd).padStart(10) + a.mar.toFixed(2).padStart(6) +
                ' |' + pc(b.cagr).padStart(11) + pc(b.dd).padStart(10) + b.mar.toFixed(2).padStart(6));
  });
  return res;
}
const main = table('Main (month-end, costs 0.05%, T-bill cash):');
const a0 = main.BH.a, b0 = main.BH.b, iso = t => new Date(t).toISOString().slice(0, 10);
console.log('  design ' + iso(a0.from) + ' to ' + iso(a0.to) + ', test ' + iso(b0.from) + ' to ' + iso(b0.to));
let pick = 'S1'; ['S2', 'S3'].forEach(r => { if (main[r].a.mar > main[pick].a.mar) pick = r; });
if (!(main[pick].a.mar > a0.mar)) console.log('  picked on design: ' + pick + ', MAR ' + main[pick].a.mar.toFixed(2) + ' does not beat BH ' + a0.mar.toFixed(2) + ' -> FAIL');
else {
  const p = main[pick].b, pass = p.mar > b0.mar && p.cagr >= 0.9 * b0.cagr;
  console.log('  picked on design: ' + pick + ' -> test MAR ' + p.mar.toFixed(2) + ' vs BH ' + b0.mar.toFixed(2) + ', CAGR ' + pc(p.cagr).trim() +
              ' vs BH ' + pc(b0.cagr).trim() + ' (needs ' + pc(0.9 * b0.cagr).trim() + ') -> ' + (pass ? 'PASS (paper portfolio)' : 'FAIL'));
}
console.log('');
table('Information only: cash at 0%', { cash0: true });
table('Information only: costs x3', { costX: 3 });
console.log('Information only: decision day moved 0-20 trading days before month-end, test half, min / median / max');
RULES.forEach(r => {
  const c = [], m = [], d = [];
  for (let off = 0; off <= 20; off++) { const b = stats(run(r, { offset: off }), SPLIT, Infinity); c.push(b.cagr); m.push(b.mar); d.push(b.dd); }
  const q = a => { const s = a.slice().sort((x, y) => x - y); return [s[0], s[10], s[20]]; };
  console.log('  ' + r.padEnd(4) + ' CAGR ' + q(c).map(pc).join(' /') + ' | worst DD ' + q(d).map(pc).join(' /') + ' | MAR ' + q(m).map(x => x.toFixed(2)).join(' / '));
});
