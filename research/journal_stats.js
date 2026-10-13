/**
 * Results of an EA Strategy Tester run, per strategy and per year, straight from its journal.
 *
 *   node research/journal_stats.js [journal path] [--as 1,1,1,1,1,1]
 *
 * --as: also show the money result as if GoldIntraday's per-strategy risk weights (NY_ORB, ASIAN_NARROW,
 * DUAL_THRUST, R_BREAKER, MOM_16, MOM_20) had been these instead of the run's own (read from its START row);
 * each trade's dollars scale with its weight, so one run answers both versions.
 *
 * Use it for periods the research data in data/ doesn't cover (e.g. gold since 2015): run the EA in the
 * MT5 Strategy Tester over those years, then read its journal here. Without a path it takes the newest
 * tester journal of either EA under %APPDATA%\MetaQuotes\Tester, and only the last run in it.
 * R per trade = (exit - entry) x side / |entry - strategy stop|; $ from the "profit" the EA journals.
 * readRun() is shared with research/news_windows.js.
 */
const fs = require('fs');
const path = require('path');

const IDS = ['NY_ORB', 'ASIAN_NARROW', 'DUAL_THRUST', 'R_BREAKER', 'MOM_16', 'MOM_20'];

// Every tester journal of either EA (or only those whose name matches `only`), newest first.
function testerJournals(only) {
  const root = path.join(process.env.APPDATA || '', 'MetaQuotes', 'Tester');
  const hits = [];
  const walk = (d, depth) => {
    if (depth > 6 || !fs.existsSync(d)) return;
    fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if ((only || /^(GoldIntraday|DonchianGold)_journal.*\.csv$/).test(e.name)) hits.push({ p, t: fs.statSync(p).mtimeMs });
    });
  };
  walk(root, 0);
  hits.sort((a, b) => b.t - a.t);
  return hits.map(h => h.p);
}

const parseT = s => Date.parse(s.trim().replace(/\./g, '-').replace(' ', 'T') + 'Z');
const num = (re, s) => { const m = re.exec(s); return m ? Number(m[1]) : null; };

// The last run in a journal: its rows, its completed trades and (GoldIntraday) its risk weights.
// Times stay in broker server time, stored as if UTC.
function readRun(file) {
  const intraday = /GoldIntraday/.test(path.basename(file));
  const allRows = fs.readFileSync(file, 'latin1').trim().split(/\r?\n/).slice(1).map(l => {
    const p = l.split(',');
    return intraday ? { t: parseT(p[0]), strat: p[1], ev: p[2], eq: +p[3], detail: p.slice(4).join(',') }
                    : { t: parseT(p[0]), strat: 'H4', ev: p[1], eq: +p[2], detail: p.slice(3).join(',') };
  });
  const starts = allRows.map((r, i) => (r.ev === 'START' && r.t > 0 ? i : -1)).filter(i => i >= 0);
  const rows = allRows.slice(starts.length ? starts[starts.length - 1] : 0);

  const open = {}, trades = [];
  rows.forEach(r => {
    if (r.ev === 'ENTRY_LONG' || r.ev === 'ENTRY_SHORT') {
      open[r.strat] = { t: r.t, side: r.ev === 'ENTRY_LONG' ? 1 : -1, entry: num(/lots at ([\d.]+)/, r.detail), stop: num(/stop ([\d.]+)/, r.detail) };
    } else if ((/^EXIT_/.test(r.ev) || r.ev === 'KILL_SWITCH') && open[r.strat]) {
      const o = open[r.strat];
      delete open[r.strat];
      const exit = num(/closed (?:ticket \d+ )?at ([\d.]+)/, r.detail);
      const risk = Math.abs(o.entry - o.stop);
      if (!exit || !risk) return;
      trades.push({ strat: r.strat, t: o.t, exitT: r.t, side: o.side, entry: o.entry, exit, risk,
                    r: (exit - o.entry) * o.side / risk, usd: num(/profit (-?[\d.]+)/, r.detail), why: r.ev });
    }
  });

  const wm = rows.length ? /weights ([\d.]+)\/([\d.]+)\/([\d.]+)\/([\d.]+)\/([\d.]+)\/([\d.]+)/.exec(rows[0].detail || '') : null;
  const runW = {};
  IDS.forEach((id, i) => { runW[id] = wm ? Number(wm[i + 1]) : 1; });
  return { file, intraday, rows, trades, runW };
}

const f = (v, d) => (v === null || v === undefined || !isFinite(v)) ? '-' : v.toFixed(d);

function stats(ts) {
  const rs = ts.map(t => t.r), sum = rs.reduce((a, b) => a + b, 0);
  const gw = rs.filter(r => r > 0).reduce((a, b) => a + b, 0), gl = -rs.filter(r => r <= 0).reduce((a, b) => a + b, 0);
  let c = 0, peak = 0, dd = 0;
  rs.forEach(r => { c += r; peak = Math.max(peak, c); dd = Math.max(dd, peak - c); });
  return { n: ts.length, win: ts.filter(t => t.r > 0).length / ts.length * 100, pf: gl ? gw / gl : Infinity, avg: sum / ts.length, sum, dd };
}

// Money on closed trades from the run's starting equity: growth and worst drawdown, each trade's $ x scale(strategy).
function money(run, trades, scale) {
  const start = run.rows[0].eq || 10000;
  let eq = start, peak = start, dd = 0;
  trades.filter(t => t.usd !== null).sort((a, b) => a.exitT - b.exitT).forEach(t => {
    eq += t.usd * scale(t.strat); peak = Math.max(peak, eq); dd = Math.max(dd, (peak - eq) / peak);
  });
  return { growth: (eq / start - 1) * 100, dd: dd * 100 };
}

function main() {
  const args = process.argv.slice(2);
  const asAt = args.indexOf('--as');
  const asWeights = asAt !== -1 ? args[asAt + 1].split(',').map(Number) : null;
  const file = args.filter((a, i) => !a.startsWith('--') && (asAt === -1 || i !== asAt + 1))[0] || testerJournals()[0];
  if (!file) { console.log('No tester journal found. Run an EA in the MT5 Strategy Tester first.'); process.exit(1); }
  const run = readRun(file), { rows, trades, intraday, runW } = run;
  if (!rows.length) { console.log('The journal is empty.'); process.exit(1); }
  if (!trades.length) { console.log('No completed trades in the last run.'); process.exit(1); }

  const t0 = rows[0].t, t1 = rows[rows.length - 1].t, weeks = (t1 - t0) / (7 * 86400000);
  const years = [...new Set(trades.map(t => new Date(t.t).getUTCFullYear()))].sort();
  console.log('EA journal: ' + file);
  console.log((intraday ? 'GoldIntraday' : 'DonchianGold') + ' tester run ' + new Date(t0).toISOString().slice(0, 10) + ' to ' +
              new Date(t1).toISOString().slice(0, 10) + ' (' + f(weeks / 52.18, 1) + ' years), equity ' + f(rows[0].eq, 2) + ' -> ' + f(rows[rows.length - 1].eq, 2));
  console.log('\nstrategy        trades  /week  win%    PF   avg R  total R  worst DD R | ' + years.map(y => String(y).padStart(6)).join(''));
  const strats = [...new Set(trades.map(t => t.strat))];
  strats.concat(strats.length > 1 ? ['ALL'] : []).forEach(id => {
    const ts = id === 'ALL' ? trades : trades.filter(t => t.strat === id);
    const s = stats(ts);
    const yr = years.map(y => f(ts.filter(t => new Date(t.t).getUTCFullYear() === y).reduce((a, t) => a + t.r, 0), 0).padStart(6));
    console.log(id.padEnd(14) + String(s.n).padStart(8) + f(s.n / weeks, 1).padStart(7) + f(s.win, 0).padStart(6) + f(s.pf, 2).padStart(6) +
                f(s.avg, 3).padStart(8) + f(s.sum, 1).padStart(9) + f(s.dd, 1).padStart(12) + ' |' + yr.join(''));
  });
  const usd = trades.map(t => t.usd).filter(v => v !== null);
  if (usd.length) console.log('\nP&L in dollars (from the EA): ' + (usd.reduce((a, b) => a + b, 0) >= 0 ? '+' : '') + f(usd.reduce((a, b) => a + b, 0), 2));

  // Money on closed trades: growth and worst drawdown, as run and (with --as) as if weighted differently.
  const said = m => 'growth ' + f(m.growth, 1) + '%, worst drawdown ' + f(m.dd, 1) + '%';
  if (usd.length) {
    console.log('Money, closed trades, as run' + (intraday ? ' (weights ' + IDS.map(id => runW[id]).join('/') + ')' : '') + ': ' + said(money(run, trades, () => 1)));
    if (asWeights && intraday) console.log('Money as if weights were ' + asWeights.join('/') + ': ' +
      said(money(run, trades, id => (IDS.indexOf(id) === -1 ? 1 : asWeights[IDS.indexOf(id)] / (runW[id] || 1)))));
  }
}

if (require.main === module) main();

module.exports = { IDS, testerJournals, readRun, stats, money, f };
