/**
 * Parity check: does the intraday EA trade like the research?
 *
 *   node research/parity_intraday.js [path to GoldIntraday_journal.csv]
 *
 * Reads the journal mt5/GoldIntraday.mq5 writes during a Strategy Tester run (M15, 1 minute OHLC) and
 * compares each strategy's trades with research/intraday.js on data/XAUUSD.sml_M15.csv: entry bar, side,
 * exit bar and exit reason, plus each side's total R. Without a path it finds the newest tester journal
 * under %APPDATA%\MetaQuotes\Tester.
 *
 * The research fills orders from M15 bars and assumes the worst when one bar touches both a level and a
 * stop; the tester walks 1-minute prices. Small differences on such bars are expected.
 */
const fs = require('fs');
const path = require('path');
const { load } = require('./daytrade.js');
const I = require('./intraday.js');

function findJournal() {
  const root = path.join(process.env.APPDATA || '', 'MetaQuotes', 'Tester');
  const hits = [];
  const walk = (d, depth) => {
    if (depth > 6 || !fs.existsSync(d)) return;
    fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name === 'GoldIntraday_journal.csv') hits.push({ p, t: fs.statSync(p).mtimeMs });
    });
  };
  walk(root, 0);
  hits.sort((a, b) => b.t - a.t);
  return hits.length ? hits[0].p : null;
}

const file = process.argv[2] || findJournal();
if (!file) { console.log('No tester journal found. Run GoldIntraday in the MT5 Strategy Tester first.'); process.exit(1); }
console.log('EA journal: ' + file);

const M15 = 15 * 60000;
const parseT = s => Date.parse(s.trim().replace(/\./g, '-').replace(' ', 'T') + 'Z');
const barOf = t => Math.floor(t / M15) * M15;
const num = (re, s) => { const m = re.exec(s); return m ? +m[1] : null; };

// FILE_ANSI csv: server_time,strategy,event,equity,detail
const allRows = fs.readFileSync(file, 'latin1').trim().split(/\r?\n/).slice(1).map(l => {
  const [t, strat, ev, eq, ...rest] = l.split(',');
  return { t: parseT(t), strat: strat.trim(), ev: ev.trim(), detail: rest.join(',') };
});
// The tester appends each run to the same file: use the last run only (it starts with a START row
// that has a real date; the 1970 one is the tester's own init check).
const starts = allRows.map((r, i) => (r.ev === 'START' && r.t > 0 ? i : -1)).filter(i => i >= 0);
const rows = allRows.slice(starts.length ? starts[starts.length - 1] : 0);
const ea = {}, open = {};
rows.forEach(r => {
  if (r.ev === 'ENTRY_LONG' || r.ev === 'ENTRY_SHORT') {
    // A broker stop order is journaled on the next tick; "opened" says when it filled.
    const opened = /opened (\d{4}\.\d\d\.\d\d \d\d:\d\d:\d\d)/.exec(r.detail);
    open[r.strat] = { t: barOf(opened ? parseT(opened[1]) : r.t), side: r.ev === 'ENTRY_LONG' ? 1 : -1,
                      entry: num(/lots at ([\d.]+)/, r.detail), stop: num(/stop ([\d.]+)/, r.detail) };
  } else if (/^EXIT_/.test(r.ev) && open[r.strat]) {
    const o = open[r.strat], deal = /deal time (\d{4}\.\d\d\.\d\d \d\d:\d\d:\d\d)/.exec(r.detail);
    const px = num(/closed at ([\d.]+)/, r.detail);
    o.exitT = barOf(deal ? parseT(deal[1]) : r.t);
    o.why = r.ev.replace('EXIT_', '');
    o.r = px !== null && o.entry && o.stop ? (px - o.entry) * o.side / ((o.entry - o.stop) * o.side) : 0;
    (ea[r.strat] = ea[r.strat] || []).push(o);
    delete open[r.strat];
  }
});
const all = [].concat(...Object.values(ea));
if (!all.length) { console.log('The journal has no completed trades.'); process.exit(1); }

const bars = load('XAUUSD.sml_M15.csv');
const P = I.portfolio(bars);
// Compare from a month after the EA's first trade (its indicators start from shorter history) to its last exit.
const from = Math.min(...all.map(t => t.t)) + 30 * 86400000, to = Math.max(...all.map(t => t.exitT));
const d = ms => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
console.log('Compared ' + d(from) + ' to ' + d(to) + ' (server time)\n');
console.log('strategy        EA  research  identical  exit differs  EA only  research only |  EA R  research R');

let sumSame = 0, sumMax = 0;
const notes = [];
Object.keys(I.PORTFOLIO).forEach(id => {
  const e = (ea[id] || []).filter(t => t.t >= from && t.exitT <= to);
  const res = I.backtest(bars, P[id], I.COSTS.real).filter(t => t.t >= from && t.exitT <= to);
  const key = t => t.t + '|' + t.side;
  const rm = new Map(res.map(t => [key(t), t])), matched = new Set();
  let same = 0, exitDiff = 0, onlyEa = 0;
  e.forEach(t => {
    const r = rm.get(key(t));
    if (!r) { onlyEa++; if (notes.length < 25) notes.push(id + '  EA only        ' + (t.side > 0 ? 'long ' : 'short') + ' ' + d(t.t) + ' -> ' + d(t.exitT) + ' ' + t.why); return; }
    matched.add(key(t));
    if (r.exitT === t.exitT && r.why === t.why) same++;
    else { exitDiff++; if (notes.length < 25) notes.push(id + '  exit differs   ' + (t.side > 0 ? 'long ' : 'short') + ' ' + d(t.t) + '  EA ' + d(t.exitT) + ' ' + t.why + '  vs research ' + d(r.exitT) + ' ' + r.why); }
  });
  const onlyRes = res.filter(t => !matched.has(key(t)));
  onlyRes.slice(0, 3).forEach(t => { if (notes.length < 25) notes.push(id + '  research only  ' + (t.side > 0 ? 'long ' : 'short') + ' ' + d(t.t) + ' -> ' + d(t.exitT) + ' ' + t.why); });
  const eaR = e.reduce((a, t) => a + t.r, 0), resR = res.reduce((a, t) => a + t.r, 0);
  console.log(id.padEnd(13) + String(e.length).padStart(5) + String(res.length).padStart(10) + String(same).padStart(11) +
              String(exitDiff).padStart(14) + String(onlyEa).padStart(9) + String(onlyRes.length).padStart(15) + ' |' +
              eaR.toFixed(1).padStart(6) + resR.toFixed(1).padStart(12));
  sumSame += same; sumMax += Math.max(e.length, res.length);
});
const count = re => rows.filter(r => re.test(r.ev)).length;
console.log('\nJournal: ' + count(/^ERROR$/) + ' error rows, ' + count(/^SKIP$/) + ' skipped entries, ' +
            count(/^EXIT_(MANUAL|EXTERNAL|STOPOUT)$/) + ' closes from outside the EA');
if (notes.length) { console.log('\nFirst differences:'); notes.forEach(n => console.log('  ' + n)); }
const pct = sumMax ? sumSame / sumMax * 100 : 0;
console.log('\nParity: ' + pct.toFixed(1) + '% of trades identical' + (pct >= 90 ? ' -> PASS' : ' -> investigate the differences above'));
