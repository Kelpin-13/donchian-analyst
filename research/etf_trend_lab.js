/**
 * Long-term trend rules on the US stock indices, for a paper portfolio of US ETFs (owner, 19 Nov 2026: "we should move
 * to stocks, long term investment"; "paper first, US ETFs"). Rules fixed before the index data was exported.
 *
 *   node research/etf_trend_lab.js
 *
 * Data: the broker's daily index CFD bars from mt5/ExportBars.mq5 1.21 (data/<symbol>_D1_2008.csv), standing in for the
 * ETF that tracks each index: S&P 500 = SPY, Nasdaq 100 = QQQ, Dow 30 = DIA, Russell 2000 = IWM. Symbols are matched by
 * name (SPX|US500|SP500; NAS|US100|USTEC|NDX; US30|DJ|WS30; US2000|RUSS|RTY|US2K). Index CFD prices carry no dividends,
 * so a held index earns an assumed dividend yield a day (S&P 1.9%, Nasdaq 1.0%, Dow 2.2%, Russell 1.4% a year,
 * approximate 2008-2026 averages); cash earns the yearly average 3-month US T-bill rate (table below, approximate).
 * Dates follow the S&P file; another index missing a day keeps its last close.
 *
 *   decision  on the last trading day of each month, at its close; traded at the next day's open
 *   cost      0.05% of the amount switched (ETF spread + slippage at a commission-free broker)
 *   BH        benchmark: hold the S&P 500 (SPY) all the time
 *   A         S&P 500 above its 200-day average at the month's last close: hold it; below: cash
 *   B         rotation: the index of the four with the best 12-month (252-day) return; if that return is not above 0,
 *             cash
 *   C         the same, the best two at half each (each needs its 12-month return above 0, else its half is cash)
 *   start     the first month-end where every index has 253 days of history, so all four run over the same days
 *   measure   CAGR, worst peak-to-trough drawdown of the daily value, MAR = CAGR / worst drawdown; each half measured
 *             on its own (positions carried across the split)
 *   pick      on the design half (start to 2016-12-31): the best MAR of A, B, C; it must beat BH's MAR there, else FAIL
 *   pass      judged once on 2017-01-01 to the end: the pick's MAR beats BH's AND its CAGR is at least 90% of BH's.
 *             A pass goes into the paper portfolio, not real money.
 *   also shown, deciding nothing: cash at 0%, costs x3, and the decision day moved 1-20 trading days before month-end
 *             (the range of results shows how much the monthly timing alone matters); the largest daily moves of each
 *             file, to check the data for broker roll gaps.
 * Results (19 Nov 2026, one run): FAIL, and it tells us little. OANDA's US100 history starts on 15 Sep 2014, so the
 *   common start is 30 Sep 2015 and the design half is only 15 months (BH MAR 1.23, A 1.13, B 0.08, C 0.28; A picked,
 *   does not beat BH -> FAIL). US100 also has a +45.1% "day" on 2021-01-04, a broker data break, which distorts B and C.
 *   Test half for information: BH 15.0% / 34.3% DD; A 8.5% / 23.8%; B 12.3% / 23.3%; C 11.2% / 21.5%. Not re-run with
 *   other settings (that would be choosing after seeing). research/etf_rotation_lab.js answers the same question on
 *   real ETF prices from 1999 and is the result to use.
 * Research only: nothing here trades.
 */
const fs = require('fs');
const path = require('path');
const DATA = path.join(__dirname, '..', 'data');
const DAY = 86400000, SPLIT = Date.UTC(2017, 0, 1), COST = 0.0005;
const TBILL = { 2008: 1.37, 2009: 0.15, 2010: 0.14, 2011: 0.05, 2012: 0.09, 2013: 0.06, 2014: 0.03, 2015: 0.05, 2016: 0.32,
                2017: 0.93, 2018: 1.94, 2019: 2.06, 2020: 0.36, 2021: 0.05, 2022: 2.02, 2023: 5.07, 2024: 4.97, 2025: 4.2, 2026: 3.8 };
const IDX = [
  { key: 'SPX', etf: 'SPY', re: /SPX|US500|SP500/i, div: 1.9 },
  { key: 'NAS', etf: 'QQQ', re: /NAS|US100|USTEC|NDX/i, div: 1.0 },
  { key: 'DOW', etf: 'DIA', re: /US30|DJ|WS30/i, div: 2.2 },
  { key: 'RUT', etf: 'IWM', re: /US2000|RUSS|RTY|US2K/i, div: 1.4 },
];

function load(file) {
  return fs.readFileSync(path.join(DATA, file), 'utf8').trim().split(/\r?\n/).slice(1).map(line => {
    const [d, , o, h, l, c] = line.split('\t');
    return { t: Date.parse(d.replace(/\./g, '-') + 'T00:00:00Z'), o: +o, h: +h, l: +l, c: +c };
  }).filter(b => b.c > 0);
}
const files = fs.readdirSync(DATA).filter(f => /_D1_2008\.csv$/.test(f) && !/^XAU/i.test(f));
IDX.forEach(x => {
  const f = files.filter(n => x.re.test(n.replace(/_D1_2008\.csv$/, '')));
  if (f.length !== 1) { console.log('need exactly one file for ' + x.key + ', found: ' + (f.join(', ') || 'none')); process.exit(1); }
  x.file = f[0]; x.bars = load(f[0]);
});

// Data check: the largest daily moves (close to close) per file.
console.log('Data: ' + IDX.map(x => x.key + ' = ' + x.file + ' (' + x.bars.length + ' days from ' + new Date(x.bars[0].t).toISOString().slice(0, 10) + ')').join('; '));
IDX.forEach(x => {
  const mv = x.bars.slice(1).map((b, i) => ({ t: b.t, m: b.c / x.bars[i].c - 1 })).sort((a, b) => Math.abs(b.m) - Math.abs(a.m)).slice(0, 5);
  console.log('  largest daily moves ' + x.key + ': ' + mv.map(v => new Date(v.t).toISOString().slice(0, 10) + ' ' + (v.m * 100).toFixed(1) + '%').join(', '));
});

// Align on the S&P dates; others keep their last bar.
const dates = IDX[0].bars.map(b => b.t);
IDX.forEach(x => {
  const by = new Map(x.bars.map(b => [b.t, b])); let last = null;
  x.al = dates.map(t => { const b = by.get(t); if (b) last = b; return b ? b : last ? { t, o: last.c, h: last.c, l: last.c, c: last.c } : null; });
  x.first = x.al.findIndex(b => b);
});
const N = dates.length;
const monthEnd = dates.map((t, i) => i === N - 1 || new Date(dates[i + 1]).getUTCMonth() !== new Date(t).getUTCMonth());
const firstOk = Math.max(...IDX.map(x => x.first)) + 253;

/** Target weights per index (array of 4) decided at day i's close. */
function decide(rule, i) {
  const w = [0, 0, 0, 0];
  if (rule === 'BH') { w[0] = 1; return w; }
  if (rule === 'A') {
    let s = 0; for (let j = i - 199; j <= i; j++) s += IDX[0].al[j].c;
    if (IDX[0].al[i].c > s / 200) w[0] = 1;
    return w;
  }
  const mom = IDX.map((x, k) => ({ k, r: x.al[i].c / x.al[i - 252].c - 1 })).sort((a, b) => b.r - a.r);
  if (rule === 'B') { if (mom[0].r > 0) w[mom[0].k] = 1; return w; }
  if (rule === 'C') { mom.slice(0, 2).forEach(m => { if (m.r > 0) w[m.k] = 0.5; }); return w; }
}

/** Daily value series for a rule. opts: { cash0, costX, offset } (offset = trading days before month-end). */
function run(rule, opts) {
  const o = opts || {}, costRate = COST * (o.costX || 1);
  const isDecision = i => { const j = i + (o.offset || 0); return j < N && monthEnd[j]; };
  let start = firstOk; while (start < N && !isDecision(start)) start++;
  let w = decide(rule, start), v = 1;
  const out = [{ t: dates[start], v }];
  for (let i = start + 1; i < N; i++) {
    const yr = new Date(dates[i]).getUTCFullYear(), cashD = o.cash0 ? 0 : (TBILL[yr] !== undefined ? TBILL[yr] : 3.8) / 100 / 252;
    const pending = isDecision(i - 1) ? decide(rule, i - 1) : null;   // decided at yesterday's close, traded at today's open
    // overnight: yesterday's close to today's open, old weights
    let g = 0, wsum = 0;
    w.forEach((wk, k) => { if (wk) { g += wk * (IDX[k].al[i].o / IDX[k].al[i - 1].c - 1); wsum += wk; } });
    v *= 1 + g;
    if (pending) {
      const turn = pending.reduce((s, p, k) => s + Math.abs(p - w[k]), 0);
      v *= 1 - turn * costRate; w = pending;
    }
    // the day: open to close, new weights; dividends and cash interest for the day
    g = 0; wsum = 0;
    w.forEach((wk, k) => { if (wk) { g += wk * (IDX[k].al[i].c / IDX[k].al[i].o - 1 + IDX[k].div / 100 / 252); wsum += wk; } });
    g += (1 - wsum) * cashD;
    v *= 1 + g;
    out.push({ t: dates[i], v });
  }
  return out;
}
function stats(series, from, to) {
  const s = series.filter(p => p.t >= from && p.t < to);
  if (s.length < 2) return null;
  const yrs = (s[s.length - 1].t - s[0].t) / (365.25 * DAY), cagr = Math.pow(s[s.length - 1].v / s[0].v, 1 / yrs) - 1;
  let pk = 0, dd = 0; s.forEach(p => { pk = Math.max(pk, p.v); dd = Math.max(dd, 1 - p.v / pk); });
  return { cagr, dd, mar: dd ? cagr / dd : Infinity, from: s[0].t, to: s[s.length - 1].t };
}
const pc = v => (v * 100).toFixed(1).padStart(6) + '%';
const halves = [['design', -Infinity, SPLIT], ['test', SPLIT, Infinity]];
const RULES = ['BH', 'A', 'B', 'C'];
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
const a0 = main.BH.a, b0 = main.BH.b;
console.log('  design ' + new Date(a0.from).toISOString().slice(0, 10) + ' to ' + new Date(a0.to).toISOString().slice(0, 10) + ', test ' +
            new Date(b0.from).toISOString().slice(0, 10) + ' to ' + new Date(b0.to).toISOString().slice(0, 10));
let pick = 'A'; ['B', 'C'].forEach(r => { if (main[r].a.mar > main[pick].a.mar) pick = r; });
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
