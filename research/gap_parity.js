// Parity check: replays Stocks.js (the Sheet's own code) day by day on data/yahoo, 2017-2026, and compares its gap
// signals with the rule in research/gap_lab.js. node research/gap_parity.js  (19 Nov 2026: 189 of 192 the same; the 3
// differences are MU days where the $10,000 paper account cannot buy one share inside 0.5% risk).
const fs = require('fs'), path = require('path'), vm = require('vm');
const R = path.join(__dirname, '..') + '/';
const DIR = R + 'data/yahoo/';
const ctx = { Utilities: { formatDate: (d) => new Date(d).toISOString().slice(0, 10) }, console };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(R + 'Stocks.js', 'utf8') + '\nthis.STOCKS=STOCKS;this.stocksRow_=stocksRow_;this.stocksMarketOk_=stocksMarketOk_;this.stocksGapSignal_=stocksGapSignal_;', ctx);
const read = t => fs.readFileSync(DIR + t + '.csv', 'utf8').trim().split(/\r?\n/).slice(1).map(l => {
  const p = l.split(','); return { t: Date.parse(p[0] + 'T00:00:00Z'), o: +p[1], h: +p[2], l: +p[3], c: +p[4], v: +p[6] };
}).filter(b => b.c > 0 && b.o > 0 && b.h > 0 && b.l > 0);
const spy = read('SPY'); const spyIdx = new Map(spy.map((b, i) => [b.t, i]));
const tickers = ctx.STOCKS.defaults.filter(t => t !== 'SPY' && fs.existsSync(DIR + t + '.csv'));
const FROM = Date.UTC(2017, 0, 1);
let sheet = new Set(), lab = new Set();
const c200 = [];
for (const tk of tickers) {
  const bars = read(tk);
  // gap_lab: aligned to SPY dates, age >= 252 consecutive aligned bars, SMA over aligned bars
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].t < FROM) continue;
    const si = spyIdx.get(bars[i].t); if (si === undefined || si < 201) continue;
    // Sheet: last ~2 years of bars up to day i, SPY up to the same day
    const win = bars.slice(Math.max(0, i - 503), i + 1);
    const row = ctx.stocksRow_(tk, win);
    const mk = ctx.stocksMarketOk_(spy.slice(Math.max(0, si - 503), si + 1));
    if (row && ctx.stocksGapSignal_(row, mk, 10000)) sheet.add(tk + ' ' + new Date(bars[i].t).toISOString().slice(0, 10));
    // lab rule
    if (i < 253) continue;
    let s = 0; for (let k = si - 200; k < si; k++) s += spy[k].c;
    if (!(spy[si - 1].c > s / 200)) continue;
    const b = bars[i], p = bars[i - 1];
    let dv = 0; for (let k = i - 20; k < i; k++) dv += bars[k].c * bars[k].v; dv /= 20;
    let atr = 0; for (let k = i - 14; k < i; k++) atr += Math.max(bars[k].h - bars[k].l, Math.abs(bars[k].h - bars[k - 1].c), Math.abs(bars[k].l - bars[k - 1].c)); atr /= 14;
    if (!(dv >= 50e6) || !(b.o >= p.c * 1.06) || !(b.c >= b.o) || !(b.c > b.l) || b.c - b.l > 2 * atr) continue;
    lab.add(tk + ' ' + new Date(b.t).toISOString().slice(0, 10));
  }
}
const onlySheet = [...sheet].filter(x => !lab.has(x)), onlyLab = [...lab].filter(x => !sheet.has(x));
console.log('tickers', tickers.length, '| sheet signals', sheet.size, '| lab signals', lab.size, '| both', [...sheet].filter(x => lab.has(x)).length);
console.log('only sheet:', onlySheet.slice(0, 20).join(', '));
console.log('only lab:', onlyLab.slice(0, 20).join(', '));
const byMonth = {}; [...sheet].forEach(x => { const m = x.split(' ')[1].slice(0, 7); byMonth[m] = (byMonth[m] || 0) + 1; });
const months = (Date.UTC(2026, 10, 1) - FROM) / (30.44 * 86400000);
console.log('signals per month (sheet, 2017-2026):', (sheet.size / months).toFixed(2), '| months with none:', Math.round(months - Object.keys(byMonth).length), 'of', Math.round(months));
console.log('last 8:', [...sheet].sort((a, b) => a.split(' ')[1] < b.split(' ')[1] ? -1 : 1).slice(-8).join(', '));
fs.writeFileSync(R + 'data/reports/gap_parity.json', JSON.stringify({ tickers: tickers.length, sheet: sheet.size, lab: lab.size, both: [...sheet].filter(x => lab.has(x)).length, onlySheet, onlyLab, perMonth: sheet.size / months }));
