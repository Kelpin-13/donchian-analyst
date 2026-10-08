/**
 * Test suite. Run from the project folder:   node tests/run.js
 * Optional: compare the live strategy against an older commit as well:
 *                                            node tests/run.js --against HEAD
 * Every check prints PASS or FAIL; the exit code is the number of failures.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { world, makeMarkets, H, VALID_KEYS } = require('./harness');

let failures = 0;
function ok(cond, msg) { console.log((cond ? 'PASS  ' : 'FAIL  ') + msg); if (!cond) failures++; }
function section(name) { console.log('\n== ' + name); }
/** google.script.run can't return Date objects: find any, however deep. */
function hasDate(v) {   // instanceof fails across sandboxes, so check the internal type
  return Object.prototype.toString.call(v) === '[object Date]' || (v !== null && typeof v === 'object' && Object.keys(v).some(k => hasDate(v[k])));
}

const T0 = Date.UTC(2026, 0, 1);
const WARM_H = 1700;                  // enough hourly history for 400 x 4h bars
const DAYS = 90;
const MARKETS = makeMarkets(T0, WARM_H + DAYS * 24 + 48);
const STEP = 15 * 60 * 1000;          // the triggers' 15-minute cadence

/** Drive the triggers through the replay window, like Apps Script would. */
function replay(w, { challenger }) {
  const from = T0 + WARM_H * H, to = from + DAYS * 24 * H;
  for (let t = from; t <= to; t += STEP) {
    w.setNow(t + 90 * 1000);          // triggers fire a little after the quarter hour
    w.run('runMonitor()');
    if (challenger) w.run('runChallenger()');
  }
}
const rowsOf = (w, name) => (w.sheets[name] ? w.sheets[name].rows.slice(1) : []);
const liveSignals = w => rowsOf(w, 'Signals').map(r => r[2] + '@' + new Date(r[1]).getTime());
const strip = s => JSON.stringify(rowsOf(s.w, s.sheet).map(r => r.slice(1).map(String)));   // drop wall-clock column

/* ---------------------------------------------------------------- */
section('Live strategy is isolated from the challenger');
const A = world({ markets: MARKETS });
A.run('CONFIG.CHALLENGER.enabled = false');
replay(A, { challenger: false });

// Every listed market on, plus an OANDA market so that adapter stays covered.
const ALL_ON = `CONFIG.CHALLENGER.markets.forEach(m => { m.enabled = true; });
  CONFIG.CHALLENGER.markets.push({ id: 'XAUOANDA', provider: 'oanda', symbol: 'XAU_USD', enabled: true, feePct: 0, slippagePct: 0.02 });`;
const KEYS = VALID_KEYS;
const B = world({ markets: MARKETS, props: KEYS });
B.run(ALL_ON);
replay(B, { challenger: true });

ok(liveSignals(A).length > 0, 'live strategy produced ' + liveSignals(A).length + ' signals on test data');
ok(JSON.stringify(liveSignals(A)) === JSON.stringify(liveSignals(B)), 'live signals identical with the challenger on or off');
ok(A.props.BOT_STATE === B.props.BOT_STATE, 'live position state identical');
ok(A.props.PAPER_STATE.replace(/"startedAt":\d+,?/, '') === B.props.PAPER_STATE.replace(/"startedAt":\d+,?/, ''), 'live paper account identical');
ok(strip({ w: A, sheet: 'PaperTrades' }) === strip({ w: B, sheet: 'PaperTrades' }), 'every live paper fill identical');
ok(strip({ w: A, sheet: 'Equity' }) === strip({ w: B, sheet: 'Equity' }), 'every live equity snapshot identical');

/* ---------------------------------------------------------------- */
section('Challenger books');
const markets = B.run('CONFIG.CHALLENGER.markets.map(m => m.id)');
const trades = rowsOf(B, 'MM_Trades'), equity = rowsOf(B, 'MM_Equity');
let traded = 0, booksOk = true, fillsOk = true, snapsOk = true;
markets.forEach(id => {
  const mine = trades.filter(r => r[0] === id);
  const sides = mine.map(r => r[2]).join(',');
  const book = JSON.parse(B.props['CH_PAPER_' + id] || 'null');
  const state = JSON.parse(B.props['CH_STATE_' + id] || 'null');
  if (!book || !state) { booksOk = false; console.log('      ' + id + ': no book or state'); return; }
  if (mine.length) traded++;
  if (/BUY,BUY|SELL,SELL/.test(sides) || sides.indexOf('SELL') === 0) { booksOk = false; console.log('      ' + id + ' sides ' + sides); }
  if (book.trades !== mine.filter(r => r[2] === 'SELL').length) booksOk = false;
  if ((state.position === 'LONG') !== (book.units > 0)) booksOk = false;
  mine.forEach(r => { if (Math.abs(r[6] / r[5] - 1) > 0.05) fillsOk = false; });       // FillPrice vs SignalPrice
  const snaps = equity.filter(r => r[0] === id);
  const last = snaps[snaps.length - 1];
  // the sheet stores prices rounded to cents, so allow units x half a cent
  if (!last || Math.abs(Number(last[6]) - (book.cash + book.units * Number(last[3]))) > 0.02 + book.units * 0.005) booksOk = false;
  if (new Set(snaps.map(r => String(r[2]))).size !== snaps.length) snapsOk = false;
});
ok(traded >= 4, traded + ' of ' + markets.length + ' markets traded during the replay');
ok(booksOk, 'every book: buys and sells alternate, trade counts and positions agree, equity reconciles');
ok(fillsOk, 'every fill used its own market\'s price (not BTC\'s)');
ok(snapsOk, 'one equity snapshot per market per bar, no duplicates');
const fx = B.run("CONFIG.CHALLENGER.markets.filter(m => m.provider !== 'coinbase').map(m => m.id)");
const fxSat = equity.filter(r => fx.indexOf(r[0]) !== -1 && new Date(r[2]).getUTCDay() === 6).length;
const goldBars = equity.filter(r => r[0] === 'XAUUSD').length;
ok(goldBars > 0 && fxSat === 0, 'gold has ' + goldBars + ' bars; no gold or forex bar falls on a Saturday (24/5 markets)');
// Costs: gold & FX use their own spread-only costs, crypto the PAPER defaults.
const fee = r => Number(r[10]);
ok(trades.filter(r => fx.indexOf(r[0]) !== -1).length > 0 && trades.filter(r => fx.indexOf(r[0]) !== -1).every(r => fee(r) === 0) &&
   trades.filter(r => fx.indexOf(r[0]) === -1).every(r => fee(r) > 0), 'gold & forex fills pay no commission (spread only); crypto fills pay the exchange fee');
const goldBuy = trades.filter(r => r[0] === 'XAUUSD' && r[2] === 'BUY')[0];
ok(!!goldBuy && Math.abs(goldBuy[6] / goldBuy[5] - 1) < 0.0006, 'a gold buy fills about 0.02% above its signal price (its own slippage setting)');
// No look-ahead: a bar may only be acted on after it has closed (bar open + 4h <= the moment it was used).
const early = equity.filter(r => new Date(r[2]).getTime() + 4 * H > new Date(r[1]).getTime())
  .concat(rowsOf(B, 'Equity').filter(r => new Date(r[1]).getTime() + 4 * H > new Date(r[0]).getTime()));
ok(equity.length > 0 && early.length === 0, 'no look-ahead: every bar used by live and challenger had already closed');
// Gold & FX are closed on Saturdays: the 30-minute back-off keeps polling to at most 2 calls an hour per market.
const isCandles = u => /twelvedata\.com\/time_series|oanda\.com.*\/candles\?.*H4/.test(u);
const satCalls = B.calls.filter((u, i) => isCandles(u) && new Date(B.callTimes[i]).getUTCDay() === 6).length;
const saturdays = new Set(B.callTimes.filter(t => new Date(t).getUTCDay() === 6).map(t => new Date(t).toISOString().slice(0, 10))).size;
ok(saturdays > 0 && satCalls <= saturdays * 24 * 2 * fx.length + fx.length, 'gold & forex back off on weekends (' + satCalls + ' candle calls for ' + fx.length + ' markets over ' + saturdays + ' Saturdays)');
const signalLogs = rowsOf(B, 'Log').filter(r => /^CHALLENGER /.test(r[2])).length;
ok(signalLogs === trades.length, 'every challenger signal became exactly one fill (' + trades.length + ')');

const cmp = B.run('challengerCompare_(null)');
ok(JSON.stringify(cmp) === JSON.stringify(JSON.parse(JSON.stringify(cmp))) && !/"\d{4}-\d\d-\d\dT/.test(JSON.stringify(cmp)), 'dashboard payload has no Date objects');
const avg = cmp.markets.reduce((a, x) => a + x.returnPct, 0) / cmp.markets.length;
ok(Math.abs(cmp.total.returnPct - avg) < 1e-9, 'total return is the equal-weighted average of the markets');

/* ---------------------------------------------------------------- */
section('Challenger lifecycle');
const C = world({ markets: MARKETS });                                   // everything enabled, no keys yet
C.run(ALL_ON);
const from = T0 + WARM_H * H;
for (let t = from; t <= from + 5 * 24 * H; t += STEP) { C.setNow(t + 90000); C.run('runChallenger()'); }
ok(!C.calls.some(u => /oanda|twelvedata/.test(u)), 'no Twelve Data or OANDA calls while their keys are missing');
ok(C.run('challengerCompare_(null)').markets.filter(x => x.id === 'XAUUSD')[0].note === 'needs TWELVEDATA_API_KEY', 'gold shows "needs TWELVEDATA_API_KEY" on the dashboard');
const startBefore = C.props.CH_START, btcBefore = C.props.CH_PAPER_BTC;
Object.assign(C.props, KEYS);                                            // owner adds the keys
for (let t = from + 5 * 24 * H; t <= from + 8 * 24 * H; t += STEP) { C.setNow(t + 90000); C.run('runChallenger()'); }
ok(C.props.CH_START === startBefore, 'adding gold later does not restart the comparison');
ok(!!C.props.CH_START_XAUUSD && !!C.props.CH_STATE_XAUUSD, 'gold got its own start point and state once the key existed');
const W = world({ markets: MARKETS, props: { TWELVEDATA_API_KEY: 'wrong' } });
W.run("CONFIG.CHALLENGER.markets.forEach(m => { m.enabled = m.id === 'XAUUSD' || m.id === 'ETH'; })");
W.setNow(from + 90000); W.run('runChallenger()');
const wl = rowsOf(W, 'Log').map(r => r[1] + ' ' + r[2]).join('\n');
ok(/ERROR Challenger XAUUSD: Twelve Data 401/.test(wl) && !!W.props.CH_STATE_ETH, 'a wrong Twelve Data key logs a clear error and the other markets carry on');
ok(JSON.parse(C.props.CH_PAPER_BTC).startedAt === JSON.parse(btcBefore).startedAt, 'existing books kept running');
C.run('CONFIG.CHALLENGER.name = "something else"');
C.setNow(C.now + STEP); C.run('runChallenger()');
ok(C.props.CH_START !== startBefore && (!C.props.CH_PAPER_BTC || JSON.parse(C.props.CH_PAPER_BTC).trades === 0), 'renaming the challenger starts a new comparison');
const old = world({ markets: MARKETS, props: { CH_STATE: '{}', CH_PAPER_STATE: '{}', CH_START: '{"at":1}' } });
old.run("CONFIG.CHALLENGER.markets.forEach(m => { m.enabled = m.id === 'ETH'; })");
old.setNow(from + 90000); old.run('runChallenger()');
ok(!('CH_PAPER_STATE' in old.props) && JSON.parse(old.props.CH_START).at !== 1, 'leftovers from the old 1h challenger are cleared');

/* ---------------------------------------------------------------- */
section('AI gate (shadow)');
const G = world({ markets: MARKETS });
G.run('CONFIG.CHALLENGER.enabled = false; CONFIG.GATE.mode = "shadow"');   // Claude answers 500 in tests
replay(G, { challenger: false });
ok(JSON.stringify(liveSignals(G)) === JSON.stringify(liveSignals(A)), 'gate on (and failing) leaves live signals unchanged');
const gate = rowsOf(G, 'Gate');
ok(gate.length > 0 && gate.every(r => r[8] === 'NO_VERDICT' && /500/.test(r[14])), 'API failures are logged as NO_VERDICT rows (' + gate.length + ')');
ok(G.run(`gateWouldDo_({ action: 'buy', conviction: 1.2, riskFlag: 0.2 }, 'FLAT', CONFIG.GATE)`) === 'ALLOW_ENTRY', 'thresholds: buy / 1.2 / 0.2 → allow');
ok(G.run(`gateWouldDo_({ action: 'buy', conviction: 1.5, riskFlag: 0.5 }, 'FLAT', CONFIG.GATE)`) === 'BLOCK_ENTRY', 'thresholds: risk at the limit → block');
ok(G.run(`gateWouldDo_({ action: 'sell', conviction: 1, riskFlag: 0.8 }, 'LONG', CONFIG.GATE)`) === 'EXIT_EARLY', 'thresholds: sell with high risk in a trade → exit early');

/* ---------------------------------------------------------------- */
section('History');
const Hs = world({ markets: MARKETS });
Hs.run('CONFIG.BACKTEST.historyDays = 30');
Hs.setNow(from + 3 * H + 120000);
const first = Hs.run('updateHistory()');
const n1 = rowsOf(Hs, 'History').length;
ok(first.added === n1 && n1 > 150, 'empty sheet → full build (' + n1 + ' bars)');
Hs.setNow(Hs.now + 3 * 24 * H);
ok(Hs.run('updateHistory()').added === 18, '3 days later → 18 new 4h bars');
ok(Hs.run('updateHistory()').added === 0, 'running again adds nothing');
const ts = rowsOf(Hs, 'History').map(r => r[0]);
ok(new Set(ts).size === ts.length && ts.every((t, i) => !i || t - ts[i - 1] === 4 * H), 'no duplicates, no gaps');

/* ---------------------------------------------------------------- */
section('Dashboard: gold on the Live tab');
const D = world({ markets: MARKETS, props: Object.assign({ DASHBOARD_KEY: 'dk' }, KEYS) });   // default config: XAUUSD on
const monday = (() => { let t = from + 2 * 24 * H; while (new Date(t).getUTCDay() !== 1) t += H; return t + 10 * H + 5 * 60000; })();
D.setNow(monday);
const liveView = D.run("getDashboardData('dk')");
ok(liveView.role === 'live' && liveView.markets.map(x => x.id).join() === 'LIVE,XAUUSD', 'switcher lists the live strategy and gold (' + liveView.markets.map(x => x.label).join(', ') + ')');
const before = D.calls.length;
const g = D.run("getDashboardData('dk', 'XAUUSD')");
ok(g.role === 'paper' && g.symbol === 'XAU/USD' && [g.price, g.upper, g.lower, g.ema, g.atr].every(Number.isFinite) && g.chart.close.length === 120,
   'gold view: price, channel, EMA, ATR and a 120-bar chart');
ok(!hasDate(g), 'gold view has no Date objects (google.script.run can\'t send them)');
ok(!g.closed, 'gold shows open on a Monday');
const tdCalls = since => D.calls.slice(since).filter(u => /twelvedata/.test(u));
ok(tdCalls(before).length === 2, 'first view costs 2 Twelve Data requests (candles + price)');
let mark = D.calls.length;
for (let k = 1; k <= 4; k++) { D.setNow(monday + k * 60000); D.run("getDashboardData('dk', 'XAUUSD')"); }
ok(tdCalls(mark).length === 0, 'refreshing every minute for 4 minutes costs no requests (cached)');
mark = D.calls.length; D.setNow(monday + 6 * 60000); D.run("getDashboardData('dk', 'XAUUSD')");
ok(tdCalls(mark).length === 1 && /\/price/.test(tdCalls(mark)[0]), 'after 5 minutes only the price is fetched again');
mark = D.calls.length; D.setNow(monday + 4 * H); D.run("getDashboardData('dk', 'XAUUSD')");
ok(tdCalls(mark).some(u => /time_series/.test(u)), 'a new 4h bar fetches fresh candles');
let perDay = D.calls.length;
for (let t = monday + 5 * H; t < monday + 29 * H; t += 60000) { D.setNow(t); D.run("getDashboardData('dk', 'XAUUSD')"); }
perDay = D.calls.slice(perDay).filter(u => /twelvedata/.test(u)).length;
ok(perDay <= 300, 'page left open for 24 hours, refreshing every minute: ' + perDay + ' Twelve Data requests (free plan: 800/day)');
let sat = monday; while (new Date(sat).getUTCDay() !== 6) sat += H;
D.setNow(sat + 12 * H);
ok(D.run("getDashboardData('dk', 'XAUUSD')").closed === true, 'gold shows "market closed" on a Saturday');
let threw = '';
try { D.run("getDashboardData('dk', 'EURUSD')"); } catch (e) { threw = e.message; }
ok(/Unknown or disabled market/.test(threw), 'a switched-off market is refused (EURUSD)');
threw = '';
try { D.run("getDashboardData('wrong', 'XAUUSD')"); } catch (e) { threw = e.message; }
ok(threw === 'Locked', 'the wrong dashboard key is refused');

/* ---------------------------------------------------------------- */
section('Web app links');
const L = world({ markets: MARKETS });
const dev = 'https://script.google.com/macros/s/AKfycbxHgYce_x-1/dev';
const link = v => { L.props.DASHBOARD_URL = v; return L.run('webAppUrl_("DASHBOARD_URL")'); };
ok(link(dev + '?k=secret').url === dev, 'strips ?k= from a pasted link');
ok(link('https://script.google.com/a/macros/example.com/s/AKfy_1/exec').url, 'accepts Workspace links');
ok(!!link('https://evil.example.com/macros/s/x/dev').error && !!link('').error, 'rejects other sites and empty values');

/* ---------------------------------------------------------------- */
section('Backtest each market');
const BT_MARKETS = makeMarkets(Date.UTC(2023, 0, 1), 3.3 * 365 * 24);
const E = world({ markets: BT_MARKETS, props: KEYS });
E.run("CONFIG.CHALLENGER.markets.push({ id: 'XAUOANDA', provider: 'oanda', symbol: 'XAU_USD', enabled: false })");
const listed = E.run('CONFIG.CHALLENGER.markets.length');
E.setNow(Date.UTC(2023, 0, 1) + 3.3 * 365 * 24 * H);
E.run('challengerBacktest()');
const bt = rowsOf(E, 'MM_Backtest');
const enabledIds = E.run('CONFIG.CHALLENGER.markets.filter(m => m.enabled).map(m => m.id)');
ok(bt.length === listed && bt.every(r => r[14] === (enabledIds.indexOf(r[1]) !== -1 ? '' : 'not in the challenger yet')),
   'one clean row per listed market, noted in / not in the challenger (' + bt.map(r => r[1]).join(' ') + ')');
ok(bt.filter(r => r[1] === 'XAUUSD')[0][16] === 0.02 && bt.filter(r => r[1] === 'BTC')[0][16] === 0.15, 'each market is tested with its own costs (gold 0.02% per side, crypto 0.15%)');
ok(bt.every(r => r[5] > 0), 'every market traded in the 3-year test');

section('Walk-forward per market');
const F = world({ markets: BT_MARKETS, props: KEYS });                    // default config: XAUUSD on
F.setNow(E.now);
const wfLines = F.run('challengerWalkForward()');
const wfRow = rowsOf(F, 'MM_WalkForward').filter(r => r[1] === 'XAUUSD')[0];
ok(!!wfRow && wfRow[3] >= 4 && ['HOLDS UP', 'FAILS ON NEW DATA', 'FRAGILE'].indexOf(wfRow[9]) !== -1,
   'gold walk-forward: ' + (wfRow ? wfRow[3] + ' folds, verdict ' + wfRow[9] : 'no row'));
ok(rowsOf(F, 'WF_XAUUSD').length >= wfRow[3], 'fold-by-fold detail written to WF_XAUUSD');
const goldCosts = F.run("walkForward_(chHistory_(CONFIG.CHALLENGER.markets[0], 240, challengerParams_()), { sheet: 'tmp1', feePct: 0, slippagePct: 0.02 }).fixedReturnPct");
const cryptoCosts = F.run("walkForward_(chHistory_(CONFIG.CHALLENGER.markets[0], 240, challengerParams_()), { sheet: 'tmp2' }).fixedReturnPct");
ok(Math.abs(wfRow[5] - goldCosts) < 0.01 && goldCosts > cryptoCosts, 'gold is judged with its own spread costs, not crypto fees (' + goldCosts.toFixed(2) + '% vs ' + cryptoCosts.toFixed(2) + '%)');
const F2 = world({ markets: BT_MARKETS });
F2.setNow(E.now);
ok(/XAUUSD: skipped, add TWELVEDATA_API_KEY/.test(F2.run('challengerWalkForward()').join('\n')), 'without a key the walk-forward says what is missing');

const E2 = world({ markets: BT_MARKETS });
E2.setNow(E.now);
E2.run('challengerBacktest()');
ok(/TWELVEDATA_API_KEY/.test(rowsOf(E2, 'MM_Backtest').filter(r => r[1] === 'XAUUSD')[0][14]), 'without a key, gold is skipped with a clear note');

/* ---------------------------------------------------------------- */
const ai = process.argv.indexOf('--against');
if (ai !== -1) {
  const ref = process.argv[ai + 1] || 'HEAD';
  section('Live strategy vs ' + ref);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'da-'));
  execSync('git ls-tree --name-only ' + ref, { cwd: path.join(__dirname, '..') }).toString().split('\n')
    .filter(f => f.endsWith('.js'))
    .forEach(f => fs.writeFileSync(path.join(tmp, f), execSync('git show ' + ref + ':' + f, { cwd: path.join(__dirname, '..') })));
  const O = world({ markets: MARKETS, dir: tmp });
  O.run('if (CONFIG.CHALLENGER) CONFIG.CHALLENGER.enabled = false');
  replay(O, { challenger: false });
  ok(JSON.stringify(liveSignals(O)) === JSON.stringify(liveSignals(A)), 'live signals identical to ' + ref);
  ok(strip({ w: O, sheet: 'PaperTrades' }) === strip({ w: A, sheet: 'PaperTrades' }), 'live paper fills identical to ' + ref);
  ok(strip({ w: O, sheet: 'Equity' }) === strip({ w: A, sheet: 'Equity' }), 'live equity snapshots identical to ' + ref);
  // The weekly backtest's walk-forward on BTC history must be unchanged by any refactor.
  const wfOf = dir => {
    const w = world({ markets: BT_MARKETS, dir: dir });
    w.setNow(E.now);
    w.run('CONFIG.BACKTEST.historyDays = 1095; buildHistory();');
    const r = w.run('runWalkForward()');
    return { r: JSON.stringify(r), sheet: JSON.stringify(w.sheets.BT_WalkForward.rows) };
  };
  const wNew = wfOf(undefined), wOld = wfOf(tmp);
  ok(wNew.r === wOld.r && wNew.sheet === wOld.sheet, 'live walk-forward (BTC history) identical to ' + ref + ', every fold');
}

console.log('\n' + (failures ? failures + ' FAILED' : 'ALL PASSED'));
process.exitCode = failures;
