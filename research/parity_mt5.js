/**
 * Parity check: does the MT5 Expert Advisor trade exactly like the research?
 *
 *   node research/parity_mt5.js [path to DonchianGold_journal.csv]
 *
 * Reads the journal the EA writes during a Strategy Tester run (H4, open prices
 * only) and compares every trade's entry bar, side, exit bar and exit reason
 * with research/daytrade.js ("H4, hold overnight, both") on data/XAUUSD.sml_H1.csv.
 * Without a path it finds the newest tester journal under %APPDATA%\MetaQuotes\Tester.
 */
const fs = require('fs');
const path = require('path');
const R = require('./daytrade.js');

function findJournal() {
  const root = path.join(process.env.APPDATA || '', 'MetaQuotes', 'Tester');
  const hits = [];
  const walk = (d, depth) => {
    if (depth > 6 || !fs.existsSync(d)) return;
    fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name === 'DonchianGold_journal.csv') hits.push({ p, t: fs.statSync(p).mtimeMs });
    });
  };
  walk(root, 0);
  hits.sort((a, b) => b.t - a.t);
  return hits.length ? hits[0].p : null;
}

const file = process.argv[2] || findJournal();
if (!file) { console.log('No tester journal found. Run the EA in the MT5 Strategy Tester first.'); process.exit(1); }
console.log('EA journal: ' + file);

// FILE_ANSI csv: server_time,event,equity,detail
const parseT = s => Date.parse(s.trim().replace(/\./g, '-').replace(' ', 'T') + 'Z');
const rows = fs.readFileSync(file, 'latin1').trim().split(/\r?\n/).slice(1).map(l => {
  const [t, ev, eq, ...rest] = l.split(',');
  return { t: parseT(t), ev: ev.trim(), eq: +eq, detail: rest.join(',') };
});
const ea = [];
let open = null;
rows.forEach(r => {
  if (r.ev === 'ENTRY_LONG' || r.ev === 'ENTRY_SHORT') open = { t: r.t, side: r.ev === 'ENTRY_LONG' ? 1 : -1 };
  else if (/^EXIT_(STOP|CHANNEL|TIME)$/.test(r.ev) && open) {
    ea.push(Object.assign(open, { exitT: r.t, why: r.ev.replace('EXIT_', '') }));
    open = null;
  }
});
if (!ea.length) { console.log('The journal has no completed trades.'); process.exit(1); }

const bars = R.toH4(R.load('XAUUSD.sml_H1.csv'));
const cfg = { dir: 'both', N: 20, M: 10, k: 2, ema: 100, maxBars: 60, barMin: 240, flat: false,
              swapLong: -5.92, swapShort: 3.67, firstEntryMin: 0, lastEntryMin: 24 * 60, flatMin: Infinity,
              from: -Infinity, to: Infinity };
// Compare from 3 months after the EA's first decision: before that, the EMA seeds differ
// (the tester has older history than the exported file).
const from = ea[0].t + 90 * 86400000, to = ea[ea.length - 1].exitT;
const res = R.simulate(bars, cfg).filter(t => t.t >= from && t.exitT <= to);
const eaIn = ea.filter(t => t.t >= from && t.exitT <= to);

const key = t => t.t + '|' + t.side;
const resMap = new Map(res.map(t => [key(t), t]));
let same = 0, exitDiff = [], onlyEa = [], matched = new Set();
eaIn.forEach(t => {
  const r = resMap.get(key(t));
  if (!r) { onlyEa.push(t); return; }
  matched.add(key(t));
  if (r.exitT === t.exitT && r.why === t.why) same++; else exitDiff.push({ ea: t, res: r });
});
const onlyRes = res.filter(t => !matched.has(key(t)));
const d = ms => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
const side = s => (s === 1 ? 'long ' : 'short');

console.log('\nCompared ' + d(from) + ' → ' + d(to) + ' (server time)');
console.log('EA trades: ' + eaIn.length + ' | research trades: ' + res.length);
console.log('Identical (same entry bar, side, exit bar and reason): ' + same);
console.log('Same entry, different exit: ' + exitDiff.length);
console.log('EA only: ' + onlyEa.length + ' | research only: ' + onlyRes.length);
exitDiff.slice(0, 8).forEach(x => console.log('  exit differs  ' + side(x.ea.side) + ' ' + d(x.ea.t) + '  EA ' + d(x.ea.exitT) + ' ' + x.ea.why + '  vs research ' + d(x.res.exitT) + ' ' + x.res.why));
onlyEa.slice(0, 8).forEach(t => console.log('  EA only       ' + side(t.side) + ' ' + d(t.t)));
onlyRes.slice(0, 8).forEach(t => console.log('  research only ' + side(t.side) + ' ' + d(t.t)));
const pct = eaIn.length ? same / Math.max(eaIn.length, res.length) * 100 : 0;
console.log('\nParity: ' + pct.toFixed(1) + '% of trades identical' + (pct >= 95 ? ' → PASS' : ' → investigate the differences above'));
