/**
 * Fresh untouched period: the book run once on the bars nobody had studied (9 Oct - 6 Nov 2026), and the live demo's
 * trades against the research for the same days (research queue item 4, 13 Nov 2026).
 *
 *   node research/fresh_lab.js [runs] [--intraday <GoldIntraday_journal.csv>] [--h4 <DonchianGold_journal.csv>]
 *
 * Questions: (A) with realistic fills, did the book do in the fresh four weeks what its 2023-26 history says a stretch of
 * that length can do? (B) forward parity: did the demo trade where the research trades?
 * Nothing is picked or tuned here: there are no choices to select, only two checks. Fixed before running:
 *
 * A. The book on the fresh period
 *   - book     as realism_lab.js: I.portfolio default (ASIAN_NARROW, DUAL_THRUST, R_BREAKER, MOM_16) + H4 with the trail
 *              (DonchianGold 1.08), every trade $50 a 1 R (0.5%), not compounded. Asian's half risk (1.17) is not modelled,
 *              as in the other labs.
 *   - data     R.load(file, { fresh: true }); the fresh window = trades ENTERED from 2026-10-09 00:00 server time to the
 *              last bar (6 Nov). An H4 trade still open at the last 4-hour bar is closed at that bar's open (WINDOW_END)
 *              and counted, flagged. History = trades entered 2023-04-03 to 2026-10-08.
 *   - fills    realism_lab.js model (live demo draws, x3 within 30 min of US news, 2% late +$3), 200 runs, seeds 1000+k;
 *              reported: research costs, then worst 5%, median, best 5% over the runs.
 *   - yardstick  W = the number of server days with bars in the fresh window. In every run, every stretch of W trading
 *              days in the history gives a total R (trades by entry day); all stretches of all runs are pooled.
 *   - rule     CONSISTENT if the fresh period's median total R is at or above the 5th percentile of the pooled history
 *              stretches; FLAG (worse than 95% of history) if below. For information: its rank among 2025-26 stretches
 *              only, each strategy's R, and the result at research costs. One month cannot prove or kill a strategy.
 *   - self-check  the trades closed before 9 Oct must be the same with and without the fresh bars (research costs).
 *
 * B. Forward parity with the live demo
 *   - live trades  from the EAs' live journals when given (--intraday / --h4), from 9 Oct. Without them (the journals sit
 *              in the MetaQuotes folder): the trades the daily reviews of 6, 7 and 12 Nov 2026 copied from those journals,
 *              which list every trade entered from 30 Oct in full; the comparison then covers 30 Oct - 6 Nov only.
 *   - research "as the builds were": the EAs changed during the month, so the research is run as each build traded and a
 *              trade is taken from the run whose build was live when it was entered: before 30 Oct no take-profits and no
 *              cap; 30 Oct 00:00 to 4 Nov 17:26 take-profits (DESIGN 17), no cap; from 4 Nov 17:26 the $150 cap (DESIGN 19).
 *              All six intraday strategies (NY_ORB and MOM_20 were live all month) and H4 without the trail (1.08 went on
 *              the chart on 7 Nov). Research costs (I.COSTS.real; H4 0.01%), no random draw: this is a trade-by-trade match.
 *              30 Oct 00:00 is an approximation (the build was swapped during that day).
 *   - match    same strategy, side and entry bar (M15 bar of the fill; H4: the 4-hour bar) = identical entry. Same
 *              strategy, side and server day but another bar = "same day, other bar" (a difference). Then the exit: same
 *              reason (and same exit bar when the live exit time is known) = identical; a trade open at the end of the
 *              bars, or left open by a stopped EA, is "exit not comparable".
 *   - rule     entry parity = identical entries / max(live trades, research trades) in the compared window. PASS at 80% or
 *              more. With fewer than 20 live trades the figure is reported but the verdict is TOO FEW TO JUDGE.
 *   - for information: each matched trade's live R against the research R, the live fill against the research fill
 *              (the slippage the research does not charge), Dual Thrust's stop width on the days the live cap skipped it,
 *              the live trade count of 12-16 Oct against the research, and the same match against today's book.
 * Research only: nothing here trades, and nothing is built from it.
 *
 * Results (13 Nov 2026, one run, 200 runs of random fills; the journals could not be read, so B used the daily reviews' copy):
 *   Self-check   1,400 trades closed before 9 Oct, identical with and without the fresh bars.
 *   A. Fresh period 9 Oct - 6 Nov (21 trading days, 26 trades): research costs +7.8 R ($390); random fills worst 5% +7.3 R,
 *      median +7.5 R ($376), best 5% +7.8 R; above 0 in 200 of 200 runs. Median R per strategy: ASIAN_NARROW -0.5 (3 trades),
 *      DUAL_THRUST +2.4 (6), R_BREAKER +1.9 (3), MOM_16 +2.1 (10), H4 +1.6 (4, one open at the last bar at -0.11 R).
 *      History, every 21-day stretch (177,800 pooled): 5% -9.0 R, median +2.4 R, 95% +10.1 R, 31% below 0; 2025-26 only:
 *      -7.1 / +2.9 / +9.8. The fresh median is above 85% of all stretches (87% of 2025-26's).  Rule A: CONSISTENT.
 *   B. Forward parity, 30 Oct - 6 Nov, research as the builds were: live 13 trades, research 14; identical entry 10 (exit the
 *      same 8, different 0, not comparable 2), same day other bar 2, live only 1, research only 2; entry parity 71.4%.
 *      Rule B: TOO FEW TO JUDGE (13 live trades, 20 needed).
 *      Every difference starts on 30 Oct, the day the fixed-lot / take-profit build was put on: R_BREAKER live 17:15 against
 *      16:45, NY_ORB 17:45 against 17:00, MOM_16's 16:00 short missing live (research +1.5 R), and H4's short entered live
 *      on 2 Nov 01:05 (-1.31 R) where the research entered on 30 Oct 16:00 (-0.72 R). From 3 Nov: 8 of 8 entries identical.
 *      Matched trades: live R minus research R -0.06 on average (n 8); live fills $0.22 worse than the research's (n 9) on top
 *      of its $0.05: about $0.27 a fill against the $0.29 the fill model draws from (partly the same fills, so no new test).
 *      Dual Thrust stop width, research (live): 4 Nov $193.84 ($194.26), 5 Nov $195.38 ($195), 6 Nov $216.56 ($216.57).
 *      12-16 Oct: 10 live trades against 15 in the research (no list to match; the EA was down part of 14-15 Oct).
 *      Today's book against the same live trades: 23% (not a fault: the live builds had six strategies and no trail).
 *   Reading (after the run, no rule changed): the fresh month is an ordinary good month, inside history, and it cannot prove
 *   an edge. Where the EA was running undisturbed it traded the research's bars, sides, exits and stop widths. The 30 Oct
 *   differences need the journals (was the EA off between 16:00 and 17:15?), and so does 9-29 Oct: run this again with
 *   --intraday and --h4 once the live journals can be read; part A will not change. Nothing built, nothing changed.
 */
const fs = require('fs');
const I = require('./intraday.js');
const R = require('./daytrade.js');
const { findCalendar, loadReleases, firstFrom } = require('./calendar');

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const RUNS = Number(args[0]) > 0 ? Number(args[0]) : 200;
const DAY = 86400000, MIN = 60000, M15 = 15 * MIN, H4MS = 240 * MIN;
const FROM = Date.UTC(2023, 3, 3), FRESH = R.FRESH_FROM, RISK_USD = 50;
const LIVE = [0.03, 0.03, 0.58, 0.16, 0.02, 0.378, 0.085, 1.085, 0.422, 0.11];
const NEWS_X = 3, NEWS_WIN = 30 * MIN, LATE_P = 0.02, LATE_USD = 3;
const T_TP = Date.UTC(2026, 9, 30), T_CAP = Date.UTC(2026, 10, 4, 17, 26);
const dayOf = t => Math.floor(t / DAY);
const d = ms => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
const f = (v, n) => (v === undefined || v === null || !isFinite(v)) ? '-' : v.toFixed(n === undefined ? 1 : n);
const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };

const cal = loadReleases(findCalendar(), null), news = cal.times;
const nearNews = t => { const i = firstFrom(news, t - NEWS_WIN); return i < news.length && news[i] <= t + NEWS_WIN; };
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

const m15 = R.load('XAUUSD.sml_M15.csv', { fresh: true }), h4 = R.toH4(R.load('XAUUSD.sml_H1.csv', { fresh: true }));
const END = h4[h4.length - 1].t, LAST = m15[m15.length - 1].t;
const H4_BASE = { dir: 'both', N: 20, M: 10, k: 2, ema: 100, maxBars: 60, barMin: 240, flat: false, swapLong: -5.92, swapShort: 3.67,
                  hardK: 4, firstEntryMin: 0, lastEntryMin: 24 * 60, flatMin: Infinity, from: -Infinity, to: END };
const H4_NOW = Object.assign({}, H4_BASE, { targetR: 1.5, targetWait: true, maxStop: I.MAX_STOP, trail: { at: 1, dist: 0.5, broker: true } });

/* ------------------------------ A. the book on the fresh period ------------------------------ */
const P = I.portfolio(m15);
const IDS = Object.keys(P).concat(['H4']);
function book(bars15, bars4, cfg4, slipFn) {
  const PP = bars15 === m15 ? P : I.portfolio(bars15), tr = [];
  Object.keys(PP).forEach(id => I.backtest(bars15, PP[id], { slip: I.COSTS.real.slip, slipFn }).forEach(t => tr.push({ id, t: t.t, x: t.exitT, r: t.r, side: t.side, why: t.why, entry: t.entry })));
  R.simulate(bars4, Object.assign({}, cfg4, { slipFn })).forEach(t => tr.push({ id: 'H4', t: t.t, x: t.exitT, r: t.r, side: t.side, why: t.why }));
  return tr.filter(t => t.t >= FROM).sort((a, b) => a.x - b.x);
}
const days = [...new Set(m15.filter(b => b.t >= FROM).map(b => dayOf(b.t)))].sort((a, b) => a - b);
const dayIx = new Map(days.map((x, i) => [x, i]));
const nHist = days.filter(x => x < dayOf(FRESH)).length, W = days.length - nHist, split = days.findIndex(x => x >= dayOf(I.SPLIT));
let lost = 0;
function measure(tr) {
  const per = new Array(days.length).fill(0), by = {};
  let total = 0;
  tr.forEach(t => {
    const i = dayIx.get(dayOf(t.t));
    if (i === undefined) { lost++; return; }
    per[i] += t.r;
    if (t.t >= FRESH) { total += t.r; by[t.id] = (by[t.id] || 0) + t.r; }
  });
  const win = [], win25 = [];
  let s = 0;
  for (let i = 0; i < nHist; i++) {
    s += per[i]; if (i >= W) s -= per[i - W];
    if (i >= W - 1) { win.push(s); if (i - W + 1 >= split) win25.push(s); }
  }
  return { total, by, win, win25, n: tr.filter(t => t.t >= FRESH).length };
}

console.log('Fresh period: ' + d(FRESH) + ' to ' + d(LAST) + ' server time, ' + W + ' trading days; history ' + nHist + ' trading days from 2023-04-03.');

// Self-check: the fresh bars change nothing before 9 Oct.
const old15 = R.load('XAUUSD.sml_M15.csv'), old4 = R.toH4(R.load('XAUUSD.sml_H1.csv'));
const base = book(m15, h4, H4_NOW, null);
const before = book(old15, old4, Object.assign({}, H4_NOW, { to: Infinity }), null);
const sig = tr => tr.filter(t => t.x < FRESH).map(t => t.id + '|' + t.t + '|' + t.x + '|' + t.r.toFixed(6)).sort().join('\n');
const same = sig(base) === sig(before);
console.log('Self-check: trades closed before 9 Oct with and without the fresh bars: ' + base.filter(t => t.x < FRESH).length + ' / ' + before.filter(t => t.x < FRESH).length +
            (same ? ', identical' : ', DIFFERENT (stop: find out why before reading on)'));

const mb = measure(base), runs = [];
let pool = [], pool25 = [];
for (let k = 0; k < RUNS; k++) {
  const rand = rng(1000 + k);
  const slipFn = t => { let x = LIVE[Math.floor(rand() * LIVE.length)]; if (nearNews(t)) x *= NEWS_X; if (rand() < LATE_P) x += LATE_USD; return x; };
  const m = measure(book(m15, h4, H4_NOW, slipFn));
  runs.push(m); pool = pool.concat(m.win); pool25 = pool25.concat(m.win25);
}
const tot = runs.map(r => r.total), med = pct(tot, 50);
const rank = (a, v) => a.filter(x => x < v).length / a.length * 100;
console.log('\nA. The book (' + IDS.join(', ') + '), $' + RISK_USD + ' a 1 R, ' + RUNS + ' runs with random fills');
console.log('                         research costs |  random fills: worst 5%   median   best 5%');
console.log('  fresh total R        ' + f(mb.total).padStart(12) + '   |' + f(pct(tot, 5)).padStart(22) + f(med).padStart(9) + f(pct(tot, 95)).padStart(10));
console.log('  fresh net $          ' + f(mb.total * RISK_USD, 0).padStart(12) + '   |' + f(pct(tot, 5) * RISK_USD, 0).padStart(22) + f(med * RISK_USD, 0).padStart(9) + f(pct(tot, 95) * RISK_USD, 0).padStart(10));
console.log('  trades in the fresh period: ' + mb.n + ' (research costs); runs above 0: ' + tot.filter(x => x > 0).length + ' of ' + RUNS);
IDS.forEach(id => {
  const v = runs.map(r => r.by[id] || 0);
  console.log('  ' + id.padEnd(20) + f(mb.by[id] || 0).padStart(14) + '   |' + f(pct(v, 5)).padStart(22) + f(pct(v, 50)).padStart(9) + f(pct(v, 95)).padStart(10) +
              '   trades ' + base.filter(t => t.id === id && t.t >= FRESH).length);
});
console.log('  History, every stretch of ' + W + ' trading days (pooled over the runs, ' + pool.length + ' stretches): 5% ' + f(pct(pool, 5)) + ' R, median ' + f(pct(pool, 50)) +
            ' R, 95% ' + f(pct(pool, 95)) + ' R; stretches below 0: ' + f(rank(pool, 0), 0) + '%');
console.log('  2025-26 stretches only (' + pool25.length + '): 5% ' + f(pct(pool25, 5)) + ' R, median ' + f(pct(pool25, 50)) + ' R, 95% ' + f(pct(pool25, 95)) + ' R');
console.log('  The fresh median (' + f(med) + ' R) is above ' + f(rank(pool, med), 0) + '% of all history stretches and ' + f(rank(pool25, med), 0) + '% of the 2025-26 ones.');
const openH4 = base.filter(t => t.id === 'H4' && t.why === 'WINDOW_END');
if (openH4.length) console.log('  H4 trade open at the last bar, counted at that bar\'s open: entered ' + d(openH4[0].t) + ', ' + f(openH4[0].r, 2) + ' R at research costs.');
if (lost) console.log('  NOTE: ' + lost + ' trade(s) entered on a day without M15 bars were left out of the day sums.');
const passA = med >= pct(pool, 5);
console.log('  Rule A (fresh median at or above the 5th percentile of history, ' + f(pct(pool, 5)) + ' R): ' + (passA ? 'CONSISTENT' : 'FLAG: worse than 95% of history'));

/* ------------------------------ B. forward parity with the live demo ------------------------------ */
// Copied from the daily reviews of 6, 7 and 12 Nov 2026 (data/reports/daily/), which read the live journals. Server time.
const TABLE = [
  ['DUAL_THRUST', '2026-10-30 10:49', -1, 3977.755, 4067.238, 3883.905, 'SESSION'],
  ['R_BREAKER',   '2026-10-30 17:15', -1, 3905.155, 3941.431, 3883.815, 'SESSION'],
  ['NY_ORB',      '2026-10-30 17:45', -1, 3915.525, 3946.660, 3883.815, 'SESSION'],
  ['MOM_20',      '2026-10-30 20:00', -1, 3896.245, 3932.351, 3883.785, 'SESSION'],
  ['H4',          '2026-11-02 01:05', -1, 3874.495, 3938.562, 3958.165, 'STOP'],
  ['NY_ORB',      '2026-11-03 17:00', -1, 3941.065, 3949.170, 3921.575, 'SESSION'],
  ['MOM_20',      '2026-11-03 20:00', -1, 3932.685, 3972.313, 3921.575, 'SESSION'],
  ['DUAL_THRUST', '2026-11-04 10:05',  1, 4029.915, 3835.658, 4063.875, 'SESSION'],
  ['NY_ORB',      '2026-11-04 17:07', -1, 4032.435, 4051.845, 4051.985, 'STOP'],
  ['H4',          '2026-11-04 20:00',  1, 4066.415, 3989.718, null,     'OPEN'],     // closed 11 Nov, after the bars end
  ['MOM_16',      '2026-11-05 16:00',  1, 4126.155, 4084.050, 4083.345, 'STOP'],
  ['MOM_20',      '2026-11-05 20:00',  1, 4104.725, 4062.730, 4099.115, 'SESSION'],
  ['MOM_20',      '2026-11-06 20:00', -1, 4060.165, 4102.208, null,     'OPEN']      // MT5 was closed before the session end
];
const parseT = s => Date.parse(s.trim().replace(/\./g, '-').replace(' ', 'T') + 'Z');
const num = (re, s) => { const m = re.exec(s); return m ? +m[1] : null; };
const mk = (id, t, side, entry, stop, exit, why, exitT) => ({ id, t, side, entry, stop, exit, why, exitT: exitT || null,
  r: exit !== null && entry && stop ? (exit - entry) * side / Math.abs(entry - stop) : null });

// Live journals (the same rows research/parity_intraday.js and parity_mt5.js read from the tester's journals).
function readJournal(file, isH4) {
  const out = [], open = {};
  fs.readFileSync(file, 'latin1').trim().split(/\r?\n/).slice(1).forEach(l => {
    const p = l.split(','), t = parseT(p[0]);
    const id = isH4 ? 'H4' : p[1].trim(), ev = p[isH4 ? 1 : 2].trim(), detail = p.slice(isH4 ? 3 : 4).join(',');
    if (!(t >= FRESH)) return;
    if (ev === 'ENTRY_LONG' || ev === 'ENTRY_SHORT') {
      const opened = /opened (\d{4}\.\d\d\.\d\d \d\d:\d\d:\d\d)/.exec(detail);
      open[id] = { t: opened ? parseT(opened[1]) : t, side: ev === 'ENTRY_LONG' ? 1 : -1, entry: num(/lots at ([\d.]+)/, detail),
                   stop: num(/strategy stop ([\d.]+)/, detail) || num(/stop ([\d.]+)/, detail) };
    } else if ((/^EXIT_/.test(ev) || ev === 'KILL_SWITCH') && open[id]) {
      const o = open[id], deal = /deal time (\d{4}\.\d\d\.\d\d \d\d:\d\d:\d\d)/.exec(detail);
      out.push(mk(id, o.t, o.side, o.entry, o.stop, num(/closed (?:ticket \d+ )?at ([\d.]+)/, detail), ev.replace('EXIT_', ''), deal ? parseT(deal[1]) : t));
      delete open[id];
    }
  });
  Object.keys(open).forEach(id => out.push(mk(id, open[id].t, open[id].side, open[id].entry, open[id].stop, null, 'OPEN')));
  return out;
}
const jI = opt('--intraday'), jH = opt('--h4');
let live, CMP_FROM, source;
if (jI && jH) { live = readJournal(jI, false).concat(readJournal(jH, true)); CMP_FROM = FRESH; source = 'the live journals'; }
else { live = TABLE.map(x => mk(x[0], parseT(x[1]), x[2], x[3], x[4], x[5], x[6])); CMP_FROM = T_TP; source = 'the daily reviews\' copy of the journals (trades entered from 30 Oct)'; }
live = live.filter(t => t.t >= CMP_FROM && t.t <= LAST + M15).sort((a, b) => a.t - b.t);

// The research as each build traded.
function plain(bars) {                           // the six without take-profits or the cap (the builds before 30 Oct)
  const trend = I.h4Trend(bars), S0 = I.strategies(bars);
  const all = S0.concat(S0.filter(s => s.family !== 'mean reversion').map(s => I.withTrend(s, trend)));
  const out = {};
  Object.keys(I.PORTFOLIO).forEach(id => { out[id] = Object.assign({}, all.find(s => s.name === I.PORTFOLIO[id]), { maxStop: 0 }); });
  return out;
}
const phase = t => t < T_TP ? 0 : t < T_CAP ? 1 : 2;
const BUILDS = [plain(m15), I.portfolio(m15, { maxStop: 0, retired: true }), I.portfolio(m15, { retired: true })];
const H4_BUILDS = [Object.assign({}, H4_BASE), Object.assign({}, H4_BASE, { targetR: 1.5, targetWait: true }),
                   Object.assign({}, H4_BASE, { targetR: 1.5, targetWait: true, maxStop: I.MAX_STOP })];
const asLive = [];
BUILDS.forEach((B, ph) => Object.keys(B).forEach(id => I.backtest(m15, B[id], I.COSTS.real).forEach(t => {
  if (phase(t.t) === ph) asLive.push({ id, t: t.t, x: t.exitT, side: t.side, r: t.r, why: t.why, entry: t.entry, risk: t.risk });
})));
H4_BUILDS.forEach((c, ph) => R.simulate(h4, c).forEach(t => { if (phase(t.t) === ph) asLive.push({ id: 'H4', t: t.t, x: t.exitT, side: t.side, r: t.r, why: t.why, risk: t.risk }); }));

const barOf = (id, t) => id === 'H4' ? Math.floor(t / H4MS) * H4MS : Math.floor(t / M15) * M15;
function compare(res, label, verbose) {
  const R0 = res.filter(t => t.t >= CMP_FROM);
  const used = new Set();
  let ident = 0, otherBar = 0, liveOnly = 0, exitSame = 0, exitDiff = 0, exitNa = 0;
  const lines = [], dR = [], dPx = [];
  live.forEach(L => {
    const side = L.side === 1 ? 'long ' : 'short';
    let r = R0.find(t => !used.has(t) && t.id === L.id && t.side === L.side && t.t === barOf(L.id, L.t));
    if (!r) {
      const o = R0.find(t => !used.has(t) && t.id === L.id && t.side === L.side && dayOf(t.t) === dayOf(L.t));
      if (o) { used.add(o); otherBar++; lines.push('  same day, other bar ' + L.id.padEnd(13) + side + ' live ' + d(L.t) + '  research ' + d(o.t)); }
      else { liveOnly++; lines.push('  LIVE ONLY           ' + L.id.padEnd(13) + side + ' live ' + d(L.t)); }
      return;
    }
    used.add(r); ident++;
    let ex;
    if (L.why === 'OPEN' || r.why === 'WINDOW_END') { exitNa++; ex = 'exit not comparable (live ' + L.why + ', research ' + r.why + ')'; }
    else if (L.why === r.why && (!L.exitT || barOf(L.id, L.exitT) === r.x)) { exitSame++; ex = 'exit ' + r.why; }
    else { exitDiff++; ex = 'EXIT DIFFERS: live ' + L.why + (L.exitT ? ' ' + d(L.exitT) : '') + ', research ' + r.why + ' ' + d(r.x); }
    if (L.r !== null && r.why !== 'WINDOW_END') dR.push(L.r - r.r);
    if (r.entry !== undefined) dPx.push((L.entry - r.entry) * L.side);
    lines.push('  identical entry     ' + L.id.padEnd(13) + side + ' ' + d(L.t) + '  R live ' + f(L.r, 2).padStart(6) + ' research ' + f(r.r, 2).padStart(6) +
               (r.entry !== undefined ? '  fill live ' + f(L.entry, 3) + ' research ' + f(r.entry, 3) : '') + '  ' + ex);
  });
  const resOnly = R0.filter(t => !used.has(t) && t.t <= LAST);
  resOnly.forEach(t => lines.push('  RESEARCH ONLY       ' + t.id.padEnd(13) + (t.side === 1 ? 'long ' : 'short') + ' ' + d(t.t) + ' -> ' + d(t.x) + ' ' + t.why + ' ' + f(t.r, 2) + ' R'));
  const nRes = R0.filter(t => t.t <= LAST).length, parity = ident / Math.max(live.length, nRes, 1) * 100;
  console.log('\n' + label + ': live ' + live.length + ', research ' + nRes + ' | identical entry ' + ident + ' (exit same ' + exitSame + ', differs ' + exitDiff +
              ', not comparable ' + exitNa + ') | same day other bar ' + otherBar + ' | live only ' + liveOnly + ' | research only ' + resOnly.length +
              ' | entry parity ' + f(parity) + '%');
  if (verbose) {
    lines.forEach(l => console.log(l));
    const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
    console.log('  matched trades with both exits: live R minus research R, mean ' + f(mean(dR), 2) + ' (n ' + dR.length + '); live fill worse than the research fill by $' +
                f(mean(dPx), 3) + ' on average (n ' + dPx.length + ', intraday; the research already charges $0.05)');
  }
  return parity;
}
console.log('\nB. Forward parity, ' + d(CMP_FROM) + ' to ' + d(LAST) + ', live trades from ' + source);
const parity = compare(asLive, 'Research as the builds were (six intraday + H4 without the trail)', true);
compare(base, 'For information, today\'s book (four intraday + H4 with the trail; NY_ORB and MOM_20 live trades have no partner)', false);

// Dual Thrust's stop width (trigger to trigger) on the days around the cap; live: 4 Nov from its fill, 5 and 6 Nov the SKIP rows.
const DT = BUILDS[1].DUAL_THRUST, liveW = { '2026-11-04': 194.26, '2026-11-05': 195, '2026-11-06': 216.57 };
console.log('\n  Dual Thrust stop width, research (live):');
Object.keys(liveW).forEach(day => {
  const i = m15.findIndex(b => dayOf(b.t) === dayOf(Date.parse(day + 'T00:00:00Z')));
  const o = i >= 0 && DT.onDay(i).orders;
  console.log('    ' + day + '  $' + (o ? f(Math.abs(o[0].level - o[0].stop), 2) : '-') + '  ($' + f(liveW[day], 2) + ')' + (o && Math.abs(o[0].level - o[0].stop) > I.MAX_STOP ? '  over the $150 cap' : ''));
});
const wk = asLive.filter(t => t.t >= Date.UTC(2026, 9, 12) && t.t < Date.UTC(2026, 9, 17));
console.log('  12-16 Oct: the live EAs made 10 trades (daily review, 6 Nov; no list); the research as the builds were makes ' + wk.length + '.');
console.log('  Rule B (entry parity >= 80%, at least 20 live trades): ' + (live.length < 20 ? 'TOO FEW TO JUDGE (' + live.length + ' live trades), ' + f(parity) + '%' : parity >= 80 ? 'PASS' : 'FAIL'));
