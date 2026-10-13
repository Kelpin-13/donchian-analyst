/**
 * Do GoldIntraday's trades around US news releases make or lose money? Tags every trade of the
 * Strategy Tester runs (one journal per era) against MT5's economic calendar.
 *
 *   node research/news_windows.js [--calendar path] [--before 30] [--after 30] [--only names] [journal ...]
 *
 * Calendar: exported by mt5/ExportCalendar.mq5 (data/calendar_events.csv, else the terminal's
 * MQL5/Files/calendar_events.csv). Releases = US, high importance, with a set time; --only keeps the
 * events whose name matches (a regular expression, whole name), e.g. --only top for the big four:
 * the jobs report, CPI, the Fed's decision and its press conference.
 * Journals: every GoldIntraday tester journal (the last run in each), or the paths given.
 *
 * A trade is "near" a release when it entered from --before minutes before to --after minutes after
 * one; "across" when it was already open (entered earlier) and still open when one came out.
 * The tester fills stop orders at exactly their price, so near-release fills are optimistic here;
 * section 5 says how much worse a real fill could be before they stop paying.
 * Section 6 replays "close before the release" on the M15 prices in data/ (2023 onwards only).
 * All times are broker server time (New York + 7 h all year), stored as if UTC.
 */
const fs = require('fs');
const path = require('path');
const { testerJournals, readRun, stats, money, f } = require('./journal_stats');

const MIN = 60000, BAR = 15 * MIN, DAY = 86400000;

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i === -1 ? def : args[i + 1]; };
const BEFORE = Number(opt('--before', 30)) * MIN, AFTER = Number(opt('--after', 30)) * MIN;
const given = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));

function findCalendar() {
  const local = path.join(__dirname, '..', 'data', 'calendar_events.csv');
  if (fs.existsSync(local)) return local;
  const root = path.join(process.env.APPDATA || '', 'MetaQuotes', 'Terminal');
  if (!fs.existsSync(root)) return null;
  const hits = fs.readdirSync(root).map(d => path.join(root, d, 'MQL5', 'Files', 'calendar_events.csv')).filter(p => fs.existsSync(p));
  hits.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return hits[0] || null;
}

const calFile = opt('--calendar', null) || findCalendar();
if (!calFile) { console.log('No calendar_events.csv found. Run mt5/ExportCalendar.mq5 in MT5 first.'); process.exit(1); }
const parseT = s => Date.parse(s.trim().replace(/\./g, '-').replace(' ', 'T') + 'Z');
const events = fs.readFileSync(calFile, 'latin1').trim().split(/\r?\n/).slice(1).map(l => {
  const p = l.split(',');
  return { t: parseT(p[0]), country: p[1], importance: p[3], mode: p[4], name: p[7] };
}).filter(e => e.t > 0);

// US daylight saving (rules since 2007): second Sunday of March to first Sunday of November.
function usDst(ms) {
  const y = new Date(ms).getUTCFullYear();
  const sunday = (m, n) => { const first = new Date(Date.UTC(y, m, 1)).getUTCDay(); return Date.UTC(y, m, 1 + (7 - first) % 7 + 7 * (n - 1)); };
  return ms >= sunday(2, 2) && ms < sunday(10, 1);
}

// Time check: US jobs data comes out at 8:30 New York = 15:30 server. If the calendar's clock differs
// (say, one fixed offset for all history), shift every event by the usual difference, summer and winter apart.
const minuteOf = ms => ((ms % DAY) + DAY) % DAY / MIN;
const nfp = events.filter(e => e.country === 'US' && e.mode === 'time' && /nonfarm payrolls/i.test(e.name) && !/private|adp/i.test(e.name));
const shift = {};
[true, false].forEach(summer => {
  const counts = {};
  nfp.filter(e => usDst(e.t) === summer).forEach(e => { const d = minuteOf(e.t) - (15 * 60 + 30); counts[d] = (counts[d] || 0) + 1; });
  const best = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  const n = Object.values(counts).reduce((a, b) => a + b, 0);
  shift[summer] = { min: best === undefined ? 0 : Number(best), agree: best === undefined ? 0 : counts[best], n };
});
const TOP = 'Nonfarm Payrolls|CPI m/m|Fed Interest Rate Decision|FOMC Press Conference';
const only = opt('--only', null), onlyRe = only ? new RegExp('^(' + (only === 'top' ? TOP : only) + ')$', 'i') : null;
const releases = events.filter(e => e.country === 'US' && e.importance === 'high' && e.mode === 'time' && (!onlyRe || onlyRe.test(e.name)))
  .map(e => ({ t: e.t - shift[usDst(e.t)].min * MIN, name: e.name }))
  .sort((a, b) => a.t - b.t);
const relTimes = releases.map(e => e.t);
const newsDays = new Set(relTimes.map(t => Math.floor(t / DAY)));

// First release at or after t (binary search).
function firstFrom(t) {
  let lo = 0, hi = relTimes.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (relTimes[mid] < t) lo = mid + 1; else hi = mid; }
  return lo;
}
function tag(tr, before, after) {
  const i = firstFrom(tr.t - after);
  if (i < relTimes.length && relTimes[i] <= tr.t + before) return 'near';
  const j = firstFrom(tr.t + before + 1);
  if (j < relTimes.length && relTimes[j] < tr.exitT) return 'across';
  return 'clear';
}

// The tester runs, one per era.
const files = given.length ? given : testerJournals(/^GoldIntraday_journal_.*\.csv$/);
const runs = files.map(readRun).filter(r => r.trades.length).sort((a, b) => a.rows[0].t - b.rows[0].t);
if (!runs.length) { console.log('No GoldIntraday tester journal with trades found.'); process.exit(1); }
runs.forEach(r => {
  r.era = new Date(r.rows[0].t).getUTCFullYear() + '-' + String(new Date(r.rows[r.rows.length - 1].t).getUTCFullYear()).slice(2);
  r.trades.forEach(t => { t.era = r.era; t.tag = tag(t, BEFORE, AFTER); t.newsDay = newsDays.has(Math.floor(t.t / DAY)); });
});
const trades = [].concat(...runs.map(r => r.trades));
const strats = ['NY_ORB', 'ASIAN_NARROW', 'DUAL_THRUST', 'R_BREAKER', 'MOM_16', 'MOM_20'].filter(id => trades.some(t => t.strat === id));
const groups = strats.concat(['ALL']);
const of = (id, ts) => (id === 'ALL' ? ts : ts.filter(t => t.strat === id));
const sumR = ts => ts.reduce((a, t) => a + t.r, 0);
const avgR = ts => (ts.length ? sumR(ts) / ts.length : NaN);
function welch(a, b) {
  if (a.length < 2 || b.length < 2) return NaN;
  const m = x => x.reduce((s, v) => s + v, 0) / x.length;
  const v = x => { const mu = m(x); return x.reduce((s, y) => s + (y - mu) * (y - mu), 0) / (x.length - 1); };
  return (m(a) - m(b)) / Math.sqrt(v(a) / a.length + v(b) / b.length);
}
const pad = (s, n) => String(s).padStart(n);
const range = ms => new Date(ms).toISOString().slice(0, 10);

console.log('News windows: GoldIntraday tester runs vs the economic calendar');
console.log('Calendar: ' + calFile + ' (' + events.length + ' events)');
console.log('US high-importance releases with a set time' + (onlyRe ? ', only ' + onlyRe.source.slice(2, -2) : '') + ': ' + releases.length + ', ' + range(relTimes[0]) + ' to ' + range(relTimes[relTimes.length - 1]));
['summer', 'winter'].forEach((s, i) => {
  const x = shift[i === 0];
  console.log('Time check, US ' + s + ': jobs report at 15:30 server ' + (x.min === 0 ? '' : 'after a ' + (x.min > 0 ? '-' : '+') + Math.abs(x.min) + ' min shift ') +
              'in ' + x.agree + ' of ' + x.n);
});
const names = {};
releases.forEach(e => { names[e.name] = (names[e.name] || 0) + 1; });
console.log('Most frequent: ' + Object.keys(names).sort((a, b) => names[b] - names[a]).slice(0, 14).map(n => n + ' ' + names[n]).join(', '));
console.log('Runs: ' + runs.map(r => r.era + ' (' + r.trades.length + ' trades)').join(', '));
console.log('Window: entered from ' + BEFORE / MIN + ' min before to ' + AFTER / MIN + ' min after a release = "near"; already open when one came out = "across".');

console.log('\n1) Trades that entered near a release vs all the others (R per trade; t = how sure the difference is, |t| > 2 is fairly sure)');
console.log('strategy        all: n   avg R | near: n   avg R  total R    PF | others: avg R |     t');
groups.forEach(id => {
  const ts = of(id, trades), near = ts.filter(t => t.tag === 'near'), rest = ts.filter(t => t.tag !== 'near');
  console.log(id.padEnd(14) + pad(ts.length, 7) + pad(f(avgR(ts), 3), 8) + ' |' + pad(near.length, 7) + pad(f(avgR(near), 3), 8) +
              pad(f(sumR(near), 1), 9) + pad(near.length ? f(stats(near).pf, 2) : '-', 6) + ' |' + pad(f(avgR(rest), 3), 14) + ' |' +
              pad(f(welch(near.map(t => t.r), rest.map(t => t.r)), 1), 6));
});
console.log('Near-release entries, total R by era: ' + runs.map(r => r.era).join(' / '));
groups.forEach(id => console.log('  ' + id.padEnd(14) + runs.map(r => pad(f(sumR(of(id, r.trades).filter(t => t.tag === 'near')), 1), 8)).join('')));

console.log('\n2) Trades already open when a release came out (flattering: a trade still open hours later has usually not hit its stop; section 6 is the fair test)');
console.log('strategy      across: n   avg R  total R | by era (total R)');
groups.forEach(id => {
  const ts = of(id, trades).filter(t => t.tag === 'across');
  console.log(id.padEnd(14) + pad(ts.length, 9) + pad(f(avgR(ts), 3), 8) + pad(f(sumR(ts), 1), 9) + ' |' +
              runs.map(r => pad(f(sumR(of(id, r.trades).filter(t => t.tag === 'across')), 1), 8)).join(''));
});

console.log('\n3) Days with a US high-importance release vs days without (any entry time)');
console.log('strategy     news days: n   avg R | quiet days: n   avg R |     t');
groups.forEach(id => {
  const ts = of(id, trades), a = ts.filter(t => t.newsDay), b = ts.filter(t => !t.newsDay);
  console.log(id.padEnd(14) + pad(a.length, 12) + pad(f(avgR(a), 3), 8) + ' |' + pad(b.length, 14) + pad(f(avgR(b), 3), 8) + ' |' +
              pad(f(welch(a.map(t => t.r), b.map(t => t.r)), 1), 6));
});

console.log('\n4) If the EA had skipped every entry near a release (money on closed trades, the run\'s own risk weights)');
console.log('window (before/after)   ' + runs.map(r => pad(r.era + ' growth / DD', 22)).join('') + pad('all eras growth / DD', 24));
const said = m => pad(f(m.growth, 1) + '% / ' + f(m.dd, 1) + '%', 22);
// All eras: growth compounded run after run, drawdown = the worst era's.
const whole = ms => pad(f((ms.reduce((g, m) => g * (1 + m.growth / 100), 1) - 1) * 100, 0) + '% / ' + f(Math.max(...ms.map(m => m.dd)), 1) + '%', 24);
const asRun = runs.map(r => money(r, r.trades, () => 1));
console.log('as run                  ' + asRun.map(said).join('') + whole(asRun));
[[15, 15], [30, 30], [60, 60], [15, 120]].forEach(([b, a]) => {
  const keep = r => r.trades.filter(t => tag(t, b * MIN, a * MIN) !== 'near'), ms = runs.map(r => money(r, keep(r), () => 1));
  console.log(('skip ' + b + '/' + a + ' min').padEnd(24) + ms.map(said).join('') + whole(ms) +
              '   R removed: ' + strats.map(id => id + ' ' + f(sumR(of(id, trades).filter(t => tag(t, b * MIN, a * MIN) === 'near')), 0)).join(', '));
});

console.log('\n5) Fill price: average result per ounce of gold traded (the tester fills at exactly the order price)');
console.log('strategy       near: $ per oz | others: $ per oz');
const perOz = ts => (ts.length ? ts.reduce((a, t) => a + (t.exit - t.entry) * t.side, 0) / ts.length : NaN);
groups.forEach(id => {
  const ts = of(id, trades);
  console.log(id.padEnd(14) + pad(f(perOz(ts.filter(t => t.tag === 'near')), 2), 16) + ' |' + pad(f(perOz(ts.filter(t => t.tag !== 'near')), 2), 17));
});
console.log('If a real fill near a release is worse than the "near" figure, those trades lose money.');

// 6) Replay "close just before the release" on M15 prices (data/ covers 2023 onwards).
const m15 = path.join(__dirname, '..', 'data', 'XAUUSD.sml_M15.csv');
if (fs.existsSync(m15)) {
  const bars = new Map();
  fs.readFileSync(m15, 'latin1').trim().split(/\r?\n/).slice(1).forEach(l => {
    const p = l.split('\t');
    bars.set(parseT(p[0] + ' ' + p[1]), { close: +p[5], spread: +p[8] * 0.001 });
  });
  const first = Math.min(...bars.keys());
  console.log('\n6) If trades open at a release had been closed just before it (M15 prices, ' + range(first) + ' onwards)');
  console.log('strategy      across: n  actual R  closed-before R   change');
  groups.forEach(id => {
    let n = 0, actual = 0, flat = 0;
    of(id, trades).filter(t => t.tag === 'across' && t.t >= first).forEach(t => {
      const e = relTimes[firstFrom(t.t + BEFORE + 1)];
      const start = Math.floor(e / BAR) * BAR - BAR, bar = bars.get(start);
      if (!bar || start + BAR <= t.t) return;
      const px = t.side === 1 ? bar.close : bar.close + bar.spread;    // a short buys back at the ask
      n++; actual += t.r; flat += (px - t.entry) * t.side / t.risk;
    });
    console.log(id.padEnd(14) + pad(n, 9) + pad(f(actual, 1), 10) + pad(f(flat, 1), 17) + pad(f(flat - actual, 1), 9));
  });
}
