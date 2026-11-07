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
const dev = 'https://script.google.com/macros/s/AKfycbTEST_x-1/dev';
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
const ups = F.run("walkForward_(chHistory_(CONFIG.CHALLENGER.markets[0], 240, challengerParams_()), { sheet: 'tmp0', feePct: 0, slippagePct: 0.02 }).fixedFoldReturns").filter(x => x > 0).length;
ok(wfRow[9] !== 'HOLDS UP' || new RegExp(ups + ' of ' + wfRow[3] + ' unseen stretches positive').test(wfRow[10]), 'the summary states how many unseen stretches were positive (' + ups + ' of ' + wfRow[3] + ')');
const goldCosts = F.run("walkForward_(chHistory_(CONFIG.CHALLENGER.markets[0], 240, challengerParams_()), Object.assign({ sheet: 'tmp1' }, chCostOpts_(CONFIG.CHALLENGER.markets[0]))).fixedReturnPct");
const cryptoCosts = F.run("walkForward_(chHistory_(CONFIG.CHALLENGER.markets[0], 240, challengerParams_()), { sheet: 'tmp2' }).fixedReturnPct");
ok(Math.abs(wfRow[5] - goldCosts) < 0.01 && goldCosts > cryptoCosts, 'gold is judged with its own costs and swap, not crypto fees (' + goldCosts.toFixed(2) + '% vs ' + cryptoCosts.toFixed(2) + '%)');

section('Overnight swap');
// Run the engine on gold with and without swap, then recount every charge by hand.
F.run(`var __g = chHistory_(CONFIG.CHALLENGER.markets[0], 240, challengerParams_());
       var __P = challengerParams_();
       var __with = simulate_(__g, __P, chCostOpts_(CONFIG.CHALLENGER.markets[0]));
       var __none = simulate_(__g, __P, Object.assign(chCostOpts_(CONFIG.CHALLENGER.markets[0]), { swapLongPctYear: 0 }));`);
const sw = F.run('__with'), none = F.run('__none'), goldBarsAll = F.run('__g');
ok(sw.trades.length === none.trades.length && sw.trades.length > 0 && sw.totalSwap < 0, 'gold pays swap on longs (' + sw.trades.length + ' trades, $' + sw.totalSwap.toFixed(2) + ' total)');
// Expected: for every bar a trade was held through (filled at its open, exit at a later open),
// if the bar holds 21:00 UTC on Mon-Fri, charge units x close x -5.92% / 360.
let expected = 0, chargedOk = true;
sw.trades.forEach(tr => {
  goldBarsAll.forEach(k => {
    if (k.t < tr.entryTime || k.t >= tr.exitTime) return;
    const d = new Date(k.t), rollInBar = d.getUTCHours() === 20, wd = d.getUTCDay();
    if (rollInBar && wd >= 1 && wd <= 5) expected += tr.units * k.c * -5.92 / 100 / 360;
  });
});
const closedSwap = sw.trades.reduce((a, t) => a + t.swap, 0);
ok(Math.abs(closedSwap - expected) < 1e-6, 'every charge recounted by hand: once per held weeknight at 21:00 UTC, none at weekends ($' + expected.toFixed(4) + ')');
ok(sw.trades.every(t => Math.abs(t.units * (t.exitPrice - t.entryPrice) - t.fees + t.swap - t.pnl) < 1e-6) && sw.trades.some(t => t.swap < 0),
   "each trade's P&L = units x (exit - entry) - fees + its own swap");
ok(F.run('simulate_(__g, __P, Object.assign(chCostOpts_(CONFIG.CHALLENGER.markets[0]), { swapDays: [] })).totalSwap') === 0, 'no charged days → no swap');
const bookGold = JSON.parse(B.props.CH_PAPER_XAUUSD), bookEth = JSON.parse(B.props.CH_PAPER_ETH);
ok(bookGold.swapPaid < 0 && !bookEth.swapPaid, 'paper: the gold book paid swap ($' + bookGold.swapPaid.toFixed(2) + '), crypto books paid none');
const F2 = world({ markets: BT_MARKETS });
F2.setNow(E.now);
ok(/XAUUSD: skipped, add TWELVEDATA_API_KEY/.test(F2.run('challengerWalkForward()').join('\n')), 'without a key the walk-forward says what is missing');

const E2 = world({ markets: BT_MARKETS });
E2.setNow(E.now);
E2.run('challengerBacktest()');
ok(/TWELVEDATA_API_KEY/.test(rowsOf(E2, 'MM_Backtest').filter(r => r[1] === 'XAUUSD')[0][14]), 'without a key, gold is skipped with a clear note');

/* ---------------------------------------------------------------- */
section('MT5 results sheet');
const M = world({ markets: MARKETS, props: { MT5_KEY: 'mk' } });
M.setNow(Date.UTC(2026, 9, 12, 21));
const post = body => M.run('doPost(' + JSON.stringify({ postData: { contents: JSON.stringify(body) } }) + ').getContent()');
// Journal lines exactly as the two EAs write them (server time = UTC+3).
const intradayLines = ['server_time,strategy,event,equity,detail',
  '1970.01.01 00:00:00,ALL,START,0.00,tester init check',
  '2026.10.12 01:05:00,ALL,START,10000.00,XAUUSD.sml, risk 0.25% a trade, strategies NY_ORB MOM_16, demo account 1',
  '2026.10.12 16:00:01,MOM_16,ENTRY_SHORT,10000.00,gold down since the open (4160.000), with the H4 trend: 0.100 lots at 4155.000, stop 4180.000, risk 0.25%',
  '2026.10.12 17:00:00,NY_ORB,ORDER,10000.00,buy stop at 4150.000, stop loss 4140.000, 0.250 lots, until 20:00',
  '2026.10.12 17:10:00,MOM_16,EXIT_STOP,9750.00,closed at 4180.000, deal time 2026.10.12 17:10:00, profit -250.00',
  '2026.10.12 17:20:03,NY_ORB,ENTRY_LONG,9750.00,stop order filled: 0.250 lots at 4150.300, stop 4140.000, risk 0.25%, opened 2026.10.12 17:20:02',
  '2026.10.12 23:00:00,NY_ORB,EXIT_SESSION,10265.00,closed at 4170.900, deal time 2026.10.12 23:00:00, profit 515.00'];
const h4Lines = ['server_time,event,equity,detail',
  '2026.10.12 04:00:01,ENTRY_LONG,10000.00,0.040 lots at 4150.000, strategy stop 4100.000, broker stop 4050.000, risk 1.00%',
  '2026.10.12 20:00:00,EXIT_CHANNEL,10365.00,closed ticket 7 at 4175.000 after 2 failed attempts, profit 100.00'];
const base = { source: 'mt5', key: 'mk', offset: 10800, equity: 10365, balance: 10365, open: 0, floating: 0, from: 1 };
ok(post(Object.assign({}, base, { key: 'wrong', ea: 'GoldIntraday', lines: intradayLines })) === 'rejected' && !M.sheets['MT5 Log'], 'a wrong key is rejected and nothing is stored');
ok(post(Object.assign({}, base, { ea: 'Other', lines: intradayLines })) === 'rejected', 'an unknown EA is rejected');
ok(post(Object.assign({}, base, { ea: 'GoldIntraday', lines: intradayLines })) === 'stored 6', 'intraday journal stored: 6 lines (header and the tester\'s 1970 line skipped)');
ok(post(Object.assign({}, base, { ea: 'GoldIntraday', lines: intradayLines })) === 'stored 0', 'a resend after an EA restart stores nothing twice');
ok(post(Object.assign({}, base, { ea: 'DonchianGold', lines: h4Lines })) === 'stored 2', 'H4 journal stored alongside');
const logRows = rowsOf(M, 'MT5 Log');
ok(logRows.some(r => r[1] === '2026.10.12 17:00:00' && new Date(r[0]).getTime() === Date.UTC(2026, 9, 12, 14)), 'server time 17:00 (UTC+3) is stored as 14:00 UTC');

const tradeRows = rowsOf(M, 'MT5 Trades');
const byName = n => tradeRows.filter(r => r[2] === n)[0] || [];
ok(tradeRows.length === 3, 'three trades paired from entries and exits');
ok(byName('New York opening range')[9] === 2 && byName('New York opening range')[10] === 515 && byName('New York opening range')[11] === 0.3,
   'stop-order trade: +2R, +$515, filled $0.30 past its level');
ok(byName('Momentum at 16:00')[9] === -1 && byName('Momentum at 16:00')[3] === 'SELL' && byName('Momentum at 16:00')[8] === 'Stop loss', 'short stopped out: -1R, plain-English reason');
ok(byName('H4 swing breakout')[9] === 0.5 && byName('H4 swing breakout')[8] === 'Trend ended (10-bar channel)', 'H4 trade: +0.5R against its strategy stop');

const sumRows = rowsOf(M, 'MT5 Summary');
const sumRow = label => sumRows.filter(r => r && r[0] === label)[0] || [];
ok(sumRow('All strategies')[1] === 3 && sumRow('All strategies')[7] === 365, 'summary totals: 3 trades, +$365');
ok(sumRow('Profit / loss')[1] === 365 && sumRow('Closed trades')[1] === 3, 'account block agrees with the trades');
ok(post(Object.assign({}, base, { ea: 'DonchianGold', lines: [], equity: 10400 })) === 'stored 0' && sumRow('Equity now')[1] === 10400 &&
   Object.keys(JSON.parse(M.props.MT5_STATUS)).length === 2, 'a heartbeat refreshes equity and each EA\'s last contact');

const stratRows = rowsOf(M, 'MT5 Strategies');
const glanceRow = name => stratRows.filter(r => r && r[0] === name)[0] || [];
const cards = stratRows.filter(r => r && /^  \d+   /.test(String(r[0]))).length;
ok(glanceRow('Momentum at 16:00')[2] === '21:00' && !glanceRow('New York opening range').length && !glanceRow('Momentum at 20:00').length,
   'strategy times shown in the owner\'s clock (broker 16:00 → 21:00 at UTC+8); the retired NY ORB and momentum at 20:00 are not listed');
ok(sumRow('New York opening range (retired 6 Nov 2026)')[1] === 1 && sumRow('New York opening range (retired 6 Nov 2026)')[8] === '',
   'the summary keeps a retired strategy\'s past trades, labelled, with no trades expected');
ok(cards === 5 && stratRows.some(r => r && /closed by 04:00 \(broker 23:00\)/.test(String(r[1]))), 'one card per strategy still trading (5), with both clocks in the details');
ok(M.run('MT5_STRATEGIES').every(st => st.name && st.idea && st.entry && st.stop && st.exit && st.trades > 0 && st.eras.length === 3),
   'every strategy is fully described, with its 18-year record in three eras');
ok(glanceRow('Dual Thrust')[4] === '$126' && glanceRow('Dual Thrust')[6] === 93 && glanceRow('Dual Thrust')[7] === '3 of 3',
   'at a glance: what each stop usually costs at the fixed size, 18-year result and eras positive');
const FX = world({ markets: MARKETS, props: { MT5_KEY: 'mk' } });
FX.run('doPost(' + JSON.stringify({ postData: { contents: JSON.stringify(Object.assign({}, base, { ea: 'GoldIntraday', lines: [
  '2026.11.02 01:05:00,ALL,START,10000.00,XAUUSD.sml, fixed 0.010 lots a trade, strategies DUAL_THRUST, demo account 1',
  '2026.11.02 10:49:02,DUAL_THRUST,ENTRY_SHORT,10000.00,stop order filled: 0.010 lots at 3977.755, stop 4067.238, risk $89.48, opened 2026.11.02 10:49:02',
  '2026.11.02 23:00:00,DUAL_THRUST,EXIT_SESSION,10008.95,closed at 3968.807, deal time 2026.11.02 23:00:00, profit 8.95'] })) } }) + ')');
const fxTrade = JSON.parse(FX.run('JSON.stringify(mt5BuildTrades_(mt5ReadLog_()).trades)'))[0];
ok(fxTrade && fxTrade.lots === 0.01 && fxTrade.entry === 3977.755 && fxTrade.stop === 4067.238 && fxTrade.r === 0.1 && fxTrade.pnl === 8.95,
   'a fixed-size journal line (risk in dollars) still gives the right lots, entry, stop, R and profit');
const TP = world({ markets: MARKETS, props: { MT5_KEY: 'mk' } });
TP.run('doPost(' + JSON.stringify({ postData: { contents: JSON.stringify(Object.assign({}, base, { ea: 'GoldIntraday', lines: [
  '2026.11.02 10:49:02,DUAL_THRUST,ENTRY_SHORT,10000.00,stop order filled: 0.010 lots at 4000.000, stop 4100.000, risk $100.00, opened 2026.11.02 10:49:02, take-profit 3850.000',
  '2026.11.02 15:00:00,DUAL_THRUST,EXIT_TARGET,10150.00,closed at 3850.000, deal time 2026.11.02 15:00:00, profit 150.00'] })) } }) + ')');
const tpTrade = JSON.parse(TP.run('JSON.stringify(mt5BuildTrades_(mt5ReadLog_()).trades)'))[0];
ok(tpTrade && tpTrade.stop === 4100 && tpTrade.r === 1.5 && tpTrade.pnl === 150 && tpTrade.reason === 'Take-profit',
   'a take-profit exit reads as one, and the take-profit price is not mistaken for the stop or the profit');
const targets = require('../research/intraday.js').TARGETS, gi = fs.readFileSync(path.join(__dirname, '..', 'mt5', 'GoldIntraday.mq5'), 'utf8');
const eaTp = name => +(new RegExp('input double ' + name + '\\s*=\\s*([\\d.]+)').exec(gi) || [])[1];
ok(eaTp('InpTpNyOrb') === targets.NY_ORB && eaTp('InpTpAsian') === targets.ASIAN_NARROW && eaTp('InpTpDualThrust') === targets.DUAL_THRUST &&
   eaTp('InpTpRBreaker') === targets.R_BREAKER && eaTp('InpTpMom16') === targets.MOM_16 && eaTp('InpTpMom20') === targets.MOM_20,
   'the intraday EA\'s take-profit inputs match the research');
ok(/input double InpTpR\s*=\s*1\.5;/.test(fs.readFileSync(path.join(__dirname, '..', 'mt5', 'DonchianGold.mq5'), 'utf8')) &&
   /targetR: 1\.5, targetWait: true/.test(fs.readFileSync(path.join(__dirname, '..', 'research', 'parity_mt5.js'), 'utf8')),
   'the H4 EA\'s take-profit input matches the parity check');

section('Switching the old system off');
const O2 = world({ markets: MARKETS, props: { MT5_KEY: 'mk' }, triggers: ['runMonitor', 'runChallenger', 'runDailyBrief'] });
O2.setNow(Date.UTC(2026, 9, 12, 21));
O2.run('ensureSheets_(); logLine_("INFO", "old system was here")');
O2.run('oldSystemOff()');
const visible = Object.keys(O2.sheets).filter(n => !O2.sheets[n].isSheetHidden()).sort();
ok(O2.triggers.length === 0 && !!O2.props.OLD_SYSTEM_OFF, 'every timer deleted and the switch recorded');
ok(JSON.stringify(visible) === JSON.stringify(['MT5 Strategies', 'MT5 Summary', 'MT5 Trades']) && O2.sheets.Signals && O2.sheets.Signals.rows.length > 0,
   'only the MT5 tabs stay visible; old tabs are hidden with their data intact (' + visible.join(', ') + ')');
ok(O2.run("post0 = doPost({ postData: { contents: JSON.stringify({ source: 'mt5', key: 'mk', ea: 'GoldIntraday', from: 1, offset: 10800, " +
          "lines: ['2026.10.12 15:01:06,ALL,START,10000.00,XAUUSD.sml'] }) } }).getContent()") === 'stored 1',
   'with the old system off, the MT5 receiver still stores what the EAs send');

section('MT5 Sheet link off');
// MQL5 can't run here: the order of its checks is read from the source, and its message goes through the real receiver.
const readMt5 = f => fs.readFileSync(path.join(__dirname, '..', 'mt5', f), 'utf8');
const syncSrc = readMt5('SheetSync.mqh');
const blankCode = /string SheetSync\([^)]*\)\s*\{\s*if\(MQLInfoInteger\(MQL_TESTER\)\) return "";\s*if\(InpSheetUrl == "" \|\| InpSheetKey == ""\)\s*return SyncProblem\(([^;]*)\);/.exec(syncSrc);
ok(!!blankCode, 'SheetSync checks for the tester first, so a blank URL or key stays silent there');
const blankWarn = blankCode ? blankCode[1].match(/"[^"]*"/g).map(s => s.slice(1, -1)).join('') : '';
ok(/Sheet URL or key input is blank/.test(blankWarn) && blankWarn.includes('Trading Agent -> MT5 gold EAs -> Connect MT5') &&
   blankWarn.includes('Trading Agent -> Connect MT5') && /^[\x20-\x7e]+$/.test(blankWarn),
   'the warning says the URL or key is blank and names the fix in both menus, in plain ASCII for the ANSI journal');
ok(/string SyncProblem\(const string problem\)\s*\{\s*if\(problem == g_syncWarned\) return "";\s*g_syncWarned = problem;\s*return problem;/.test(syncSrc) &&
   /return SyncProblem\(problem\);/.test(syncSrc), 'every Sheet problem goes through the one once-only check (g_syncWarned)');
ok(['GoldIntraday.mq5', 'DonchianGold.mq5'].every(f => /string problem = SheetSync\([^\n]*\n\s*if\(problem != ""\) Journal\((0, )?"WARN", problem\);/.test(readMt5(f))),
   'both EAs journal what SheetSync returns as a WARN row');
const LO = world({ markets: MARKETS, props: { MT5_KEY: 'mk' } });
LO.setNow(Date.UTC(2026, 9, 12, 21));
const loPost = body => LO.run('doPost(' + JSON.stringify({ postData: { contents: JSON.stringify(Object.assign({}, base, body)) } }) + ').getContent()');
const withWarn = (lines, i, row) => lines.slice(0, i).concat(row, lines.slice(i));
ok(loPost({ ea: 'GoldIntraday', lines: withWarn(intradayLines, 4, '2026.10.12 16:30:30,ALL,WARN,10000.00,' + blankWarn) }) === 'stored 7' &&
   loPost({ ea: 'DonchianGold', lines: withWarn(h4Lines, 2, '2026.10.12 16:30:30,WARN,10000.00,' + blankWarn) }) === 'stored 3',
   'the warning row is stored once per EA, also while a trade is open');
const loWarn = rowsOf(LO, 'MT5 Log').filter(r => r[4] === 'WARN');
ok(loWarn.length === 2 && loWarn[0][3] === 'ALL' && loWarn[1][3] === 'H4' && loWarn.every(r => r[5] === 10000 && r[6] === blankWarn),
   'its columns land right in both journal formats, the whole message in Detail');
ok(JSON.stringify(rowsOf(LO, 'MT5 Trades')) === JSON.stringify(tradeRows), 'the warning row changes nothing in MT5 Trades, even between an entry and its exit');

section('MT5 market closed');
// The EAs' own functions, run by tests/mql.js against a fake broker, through the timelines that went wrong.
{   // a block: its short names are taken at the top level of this file
const { loadEa, fakeBroker, loadDonchianGold, functionsOf, RETCODES } = require('./mql');
const srv = (mo, d, h, mi = 0, se = 0) => Date.UTC(2026, mo - 1, d, h, mi, se) / 1000;
const goldOpen = t => { const d = new Date(t * 1000), m = d.getUTCHours() * 60 + d.getUTCMinutes(); return d.getUTCDay() >= 1 && d.getUTCDay() <= 5 && m >= 65; };   // from 01:05 server
const FRI_LAST = srv(10, 30, 23, 58, 59), SAT_ATTACH = srv(10, 31, 8, 5, 18), MON_OPEN = srv(11, 2, 1, 5), FRI_BAR = srv(10, 30, 20), MON_BAR = srv(11, 2, 0);
const DG_GV = 'DG_20261009_';
/** Falling H4 bars up to the bar in progress at `last`; the newest closed bar breaks the 20-bar low: a short signal. */
function fallingBars(last) {
  const bars = [];
  for (let i = 300; i >= 0; i--) { const px = 4000 + i * 0.5; bars.push({ time: last - i * 14400, open: px + 0.2, high: px + 1, low: px - 1, close: px - 0.2 }); }
  Object.assign(bars[bars.length - 2], { low: 3989, close: 3990 });
  return bars;
}
/** DonchianGold started at server time `clock` with Friday's last quote: TimeCurrent() shows it, however late it is. */
function dgAttach(clock, seed) {
  const b = fakeBroker({ magic: 20261009, open: goldOpen });
  b.bars = fallingBars(FRI_BAR);
  b.tick(FRI_LAST, 3896.525);
  b.clock = clock;
  b.gv.set(DG_GV + 'lastbar', FRI_BAR - 3 * 14400);               // not a first start: this bar has not been decided yet
  if (seed) seed(b);
  const ea = loadDonchianGold(b);
  ea.OnInit();
  return { b, ea };
}
const timers = (b, ea, from, to, step) => { let n = 0; for (let t = from; t < to; t += step) { b.clock = t; ea.Run(); n++; } return n; };
const rowsNamed = (b, ev) => b.rows.filter(r => r.ev === ev);

// Attached on Saturday with a short signal pending (31 Oct 2026, 13:05 local).
const W = dgAttach(SAT_ATTACH);
const satTimers = timers(W.b, W.ea, SAT_ATTACH + 30, MON_OPEN, 30);
ok(satTimers > 4900 && W.b.sends.length === 0, 'attached on a Saturday: ' + satTimers + ' timer events until Monday, not one order sent');
ok(rowsNamed(W.b, 'BAR').length === 1 && /short signal/.test(rowsNamed(W.b, 'BAR')[0].detail) && rowsNamed(W.b, 'WAIT').length === 1 && rowsNamed(W.b, 'ERROR').length === 0,
   'the signal is journaled once, with one row saying why it waits');
ok(W.b.gv.get(DG_GV + 'entry_dir') === -1 && W.b.gv.get(DG_GV + 'entry_bar') === FRI_BAR - 14400, 'the entry stays pending for the bar it belongs to');
timers(W.b, W.ea, MON_OPEN, MON_OPEN + 60, 30);
ok(W.b.sends.length === 0, 'the market reopens and the timer fires before the first new tick: still nothing sent on Friday\'s price');
// The first Monday tick: the old signal goes, the newest closed bar is decided afresh.
W.b.bars.push({ time: MON_BAR, open: 3990, high: 3990, low: 3990, close: 3990 });
W.b.tick(MON_OPEN + 61, 3990);
W.ea.Run();
ok(rowsNamed(W.b, 'SKIP').length === 1 && /^short entry not filled before its bar ended/.test(rowsNamed(W.b, 'SKIP')[0].detail) && !W.b.gv.has(DG_GV + 'entry_dir'),
   'first Monday tick: the old signal is dropped with a SKIP row');
const monBar = rowsNamed(W.b, 'BAR')[1];
ok(monBar && monBar.detail.startsWith('2026.10.30 20:00') && /FLAT$/.test(monBar.detail) && W.b.sends.length === 0, 'and the newest closed bar is decided afresh, here with no signal');
// The same Monday with a fresh signal: its stop and target come from Monday's quote.
const F = dgAttach(SAT_ATTACH);
timers(F.b, F.ea, SAT_ATTACH + 30, SAT_ATTACH + 300, 30);
Object.assign(F.b.bars[F.b.bars.length - 1], { low: 3979, close: 3980 });
F.b.bars.push({ time: MON_BAR, open: 3975, high: 3975, low: 3975, close: 3975 });
F.b.tick(MON_OPEN + 1, 3975);
F.ea.Run();
const fSend = F.b.sends[0];
ok(F.b.sends.length === 1 && fSend.kind === 'sell' && rowsNamed(F.b, 'SKIP').length === 1 && rowsNamed(F.b, 'ENTRY_SHORT').length === 1, 'a fresh signal on Monday fills on that first tick');
ok(Math.abs((fSend.sl - 3975) / (3975 - fSend.tp) - 4 / 3) < 0.001, 'its stop loss and take-profit are worked out from Monday\'s quote, not Friday\'s');
// Already running when the market shut: one refusal, then quiet.
const R = dgAttach(FRI_LAST);
R.b.tick(FRI_LAST + 1, 3896.6);
R.b.clock = srv(10, 31, 0, 0, 5);
R.ea.Run();
const refusedOnce = R.b.sends.length === 1 && R.b.sends[0].rc === RETCODES.TRADE_RETCODE_MARKET_CLOSED;
timers(R.b, R.ea, R.b.clock + 30, MON_OPEN + 60, 30);
ok(refusedOnce && R.b.sends.length === 1 && rowsNamed(R.b, 'ERROR').length === 1 && R.b.gv.get(DG_GV + 'entry_dir') === -1,
   'running when the market shuts: one "market closed" reply, one ERROR row, no resend all weekend, the entry still pending');

// The tester's daily break: quotes from 01:03, orders from 01:05, ticks at :00 :20 :40 :59, the timer on :00 and :30.
[['tick first', true], ['timer first', false]].forEach(([order, tickFirst]) => {
  const D = dgAttach(FRI_LAST);
  const DAY0 = srv(11, 3, 0);
  D.b.bars.push({ time: DAY0, open: 3990, high: 3990, low: 3990, close: 3990 });
  Object.assign(D.b.bars[D.b.bars.length - 2], { low: 3979, close: 3980 });
  const start = srv(11, 3, 1, 3), quotes = new Map();
  for (let m = 0; m < 3; m++) [0, 20, 40, 59].forEach((s, i) => quotes.set(start + m * 60 + s, 3970 - m - i / 10));
  for (let t = start; t <= start + 120 && !D.b.position; t++) {
    const isTick = quotes.has(t), isTimer = t % 30 === 0;
    const onTick = () => { if (isTick) { D.b.tick(t, quotes.get(t)); D.ea.Run(); } };
    const onTimer = () => { if (isTimer) { D.b.now = D.b.clock = t; D.ea.Run(); } };
    if (tickFirst) { onTick(); onTimer(); } else { if (isTick) D.b.quote = { ms: t * 1000, bid: quotes.get(t), ask: quotes.get(t) + 0.3 }; onTimer(); onTick(); }
  }
  const filled = D.b.sends[D.b.sends.length - 1], fill = rowsNamed(D.b, 'ENTRY_SHORT')[0];
  const refused = D.b.sends.filter(s => s.rc === RETCODES.TRADE_RETCODE_MARKET_CLOSED);
  ok(fill && fill.t === start + 120 && filled.at === start + 120 && D.b.position && D.b.position.price === quotes.get(start + 120),
     'daily break (' + order + '): the 01:03 entry fills at 01:05:00, in the same bar, at that tick\'s price');
  ok(refused.length === 8 && new Set(refused.map(s => s.at)).size === 8 && refused.every(s => quotes.has(s.at)) && rowsNamed(D.b, 'ERROR').length === 1,
     'daily break (' + order + '): a refused entry is resent once per new quote, never by the timer alone, and journaled once');
  ok(!rowsNamed(D.b, 'SKIP').length, 'daily break (' + order + '): nothing skipped');
});

// Exits: never dropped, never resent into a closed market.
const withLong = b => {
  b.position = { ticket: 7, dir: 1, lots: 0.01, sl: 3500, tp: 0, price: 4100, time: FRI_BAR - 100 * 14400, magic: 20261009 };
  b.gv.set(DG_GV + 'side', 1); b.gv.set(DG_GV + 'posid', 7); b.gv.set(DG_GV + 'stop', 4050); b.gv.set(DG_GV + 'sigbar', FRI_BAR - 20 * 14400);
};
const X = dgAttach(SAT_ATTACH, withLong);
timers(X.b, X.ea, SAT_ATTACH + 30, MON_OPEN + 60, 30);
ok(X.b.sends.length === 0 && X.b.position && X.b.gv.get(DG_GV + 'exit_pending') === 1, 'an exit decided on a Saturday: nothing sent, it stays pending through the reopening');
X.b.tick(MON_OPEN + 61, 3990);
X.ea.Run();
ok(X.b.sends.length === 1 && !X.b.position && rowsNamed(X.b, 'EXIT_STOP').length === 1 && !X.b.gv.has(DG_GV + 'exit_pending'), 'it closes on the first new tick, before anything else');
const K = dgAttach(SAT_ATTACH, b => { withLong(b); b.gv.set('DG_KILL', 1); });
timers(K.b, K.ea, SAT_ATTACH + 30, SAT_ATTACH + 3600, 30);
ok(K.b.sends.length === 0, 'the kill switch on a Saturday sends nothing either');
K.b.tick(MON_OPEN + 1, 3990);
K.ea.Run();
ok(!K.b.position && rowsNamed(K.b, 'KILL_SWITCH').length === 1, 'and closes on the first new tick');
// A crash must not decide the same bar again.
const Cr = dgAttach(SAT_ATTACH);
timers(Cr.b, Cr.ea, SAT_ATTACH + 30, SAT_ATTACH + 60, 30);
ok(Cr.b.onDisk && Cr.b.onDisk.get(DG_GV + 'lastbar') === FRI_BAR - 14400 && Cr.b.onDisk.get(DG_GV + 'entry_dir') === -1, 'the decided bar and a pending entry are on disk at once');
// A take-profit's closing deal can reach the terminal just after the position has gone.
const Tp = dgAttach(FRI_LAST, b => { withLong(b); b.gv.set(DG_GV + 'side', -1); });   // a short, and the newest closed bar is still below the channel
Tp.b.tick(FRI_LAST + 1, 3896.6);
Tp.b.position = null;
Tp.ea.Run();
ok(!Tp.b.rows.some(r => /^EXIT_/.test(r.ev)) && Tp.b.gv.get(DG_GV + 'side') === -1 && Tp.b.sends.length === 0, 'position gone, deal not there yet: it waits, and trades nothing meanwhile');
Tp.b.deals.push({ ticket: 7, price: 4200, time: FRI_LAST + 2, reason: 'DEAL_REASON_TP' });
Tp.b.clock += 5;
Tp.ea.Run();
ok(rowsNamed(Tp.b, 'EXIT_TARGET').length === 1 && Tp.b.gv.get(DG_GV + 'tp_wait') === -1 && Tp.b.sends.length === 0 && /waiting after a take-profit/.test(rowsNamed(Tp.b, 'BAR')[0].detail),
   'the deal arrives: journaled as a take-profit, and the same breakout is not sold again');
const Lost = dgAttach(FRI_LAST, withLong);
Lost.b.tick(FRI_LAST + 1, 3896.6);
Lost.b.position = null;
Lost.ea.Run();
Lost.b.clock += 61;
Lost.ea.Run();
ok(rowsNamed(Lost.b, 'EXIT_EXTERNAL').length === 1 && !Lost.b.gv.has(DG_GV + 'side'), 'a deal that never comes: after a minute it is reported as closed outside the EA');
// Only "market closed" waits: any other failure is sent again as before.
const Q = dgAttach(FRI_LAST);
Q.b.tick(FRI_LAST + 1, 3896.6);
Q.b.refuseWith = RETCODES.TRADE_RETCODE_REQUOTE;
Q.ea.Run(); Q.ea.Run();
ok(Q.b.sends.length === 2, 'a requote is still resent straight away');

section('MT5 missed entries');
// Off when its bar began, an entry is dropped, not chased. "Began" is the bar's first price, not its open time.
const WED_BAR = srv(10, 28, 8);
/** The bar before WED_BAR gave a short signal; the EA comes back and gets a new quote `mins` minutes after WED_BAR's first price. */
function dgBack(mins, seed) {
  const b = fakeBroker({ magic: 20261009, open: goldOpen });
  b.bars = fallingBars(WED_BAR);
  b.gv.set(DG_GV + 'lastbar', WED_BAR - 2 * 14400);
  b.tick(WED_BAR, 3900);
  if (seed) seed(b);
  const ea = loadDonchianGold(b);
  ea.OnInit();
  ea.Run();                                                       // decided at start-up; nothing goes before a newer quote
  b.tick(WED_BAR + mins * 60, 3895);
  ea.Run();
  return { b, ea };
}
const Late = dgBack(180);
ok(Late.b.sends.length === 0 && rowsNamed(Late.b, 'ENTRY_SHORT').length === 0, 'back three hours into the bar: no order for the signal it missed');
ok(/short signal/.test(rowsNamed(Late.b, 'BAR')[0].detail) && rowsNamed(Late.b, 'SKIP').length === 1 && /^short entry missed: its bar began 180 minutes ago/.test(rowsNamed(Late.b, 'SKIP')[0].detail),
   'the signal is journaled, then one SKIP row says how late it was');
ok(!Late.b.gv.has(DG_GV + 'entry_dir') && Late.b.gv.get(DG_GV + 'lastbar') === WED_BAR - 14400, 'nothing stays pending, and that bar is not decided again');
Late.b.tick(WED_BAR + 181 * 60, 3894);
Late.ea.Run();
ok(Late.b.sends.length === 0 && rowsNamed(Late.b, 'SKIP').length === 1 && rowsNamed(Late.b, 'BAR').length === 1, 'the next tick changes nothing');
// It costs that one entry, nothing more: the next bar's own signal trades on its first price.
Object.assign(Late.b.bars[Late.b.bars.length - 1], { low: 3979, close: 3980 });
Late.b.bars.push({ time: WED_BAR + 14400, open: 3978, high: 3978, low: 3978, close: 3978 });
Late.b.tick(WED_BAR + 14400, 3978);
Late.ea.Run();
ok(Late.b.sends.length === 1 && rowsNamed(Late.b, 'ENTRY_SHORT').length === 1, 'the next bar\'s own signal still trades');

const Limit = dgBack(15), Past = dgBack(16);
ok(Limit.b.sends.length === 1 && rowsNamed(Limit.b, 'ENTRY_SHORT').length === 1 && !rowsNamed(Limit.b, 'SKIP').length, 'back within 15 minutes of the first price: the entry still goes');
ok(Past.b.sends.length === 0 && rowsNamed(Past.b, 'SKIP').length === 1, 'at 16 minutes it is skipped');

// A late open is not a late entry: the 00:00 bar's first price can come hours after its open time.
const Hol = fakeBroker({ magic: 20261009, open: goldOpen }), THU_BAR = srv(10, 29, 0);
Hol.bars = fallingBars(THU_BAR - 14400);
Hol.gv.set(DG_GV + 'lastbar', THU_BAR - 2 * 14400);
Hol.tick(THU_BAR - 120, 3900);
const HolEa = loadDonchianGold(Hol);
HolEa.OnInit();
Hol.tick(THU_BAR - 60, 3900);
HolEa.Run();
Object.assign(Hol.bars[Hol.bars.length - 1], { low: 3979, close: 3980 });
Hol.bars.push({ time: THU_BAR, open: 3975, high: 3975, low: 3975, close: 3975 });
Hol.tick(THU_BAR + 190 * 60, 3975);
HolEa.Run();
ok(Hol.sends.length === 1 && rowsNamed(Hol, 'ENTRY_SHORT').length === 1 && !rowsNamed(Hol, 'SKIP').length, 'a bar whose first price comes 3 hours after its open time trades on that price');

// A retry stops at the same limit.
const Rq = dgBack(1, b => { b.refuseWith = RETCODES.TRADE_RETCODE_REQUOTE; });
ok(Rq.b.sends.length === 1 && Rq.b.gv.get(DG_GV + 'entry_dir') === -1, 'a refused entry stays pending');
Rq.b.tick(WED_BAR + 10 * 60, 3895);
Rq.ea.Run();
const rqAt10 = Rq.b.sends.length;
Rq.b.tick(WED_BAR + 16 * 60, 3895);
Rq.ea.Run();
ok(rqAt10 === 2 && Rq.b.sends.length === 2 && rowsNamed(Rq.b, 'SKIP').length === 1 && !Rq.b.gv.has(DG_GV + 'entry_dir'), 'it is resent at 10 minutes and dropped at 16');

// Exits are never skipped, however late.
const LateExit = dgBack(180, withLong);
ok(!LateExit.b.position && rowsNamed(LateExit.b, 'EXIT_STOP').length === 1 && !rowsNamed(LateExit.b, 'SKIP').length, 'an exit three hours into the bar still goes');
// If MT5 can't say when the bar began, the entry goes as it always did.
const NoM1 = dgBack(180, b => { const real = b.env.CopyRates; b.env.CopyRates = (s, tf, ...a) => (tf === 'PERIOD_M1' ? -1 : real(s, tf, ...a)); });
ok(NoM1.b.sends.length === 1 && rowsNamed(NoM1.b, 'ENTRY_SHORT').length === 1, 'no M1 history to read: the entry goes');
const dgFns = functionsOf(readMt5('DonchianGold.mq5'));
ok(dgFns.OpenPosition.body.indexOf('WaitingForQuote()') < dgFns.OpenPosition.body.indexOf('MinutesIntoBar()') && !/MinutesIntoBar/.test(dgFns.ClosePosition.body),
   'a closed market is asked about first, so Monday\'s SKIP row is unchanged; ClosePosition never asks how late it is');
ok(!/TimeCurrent/.test(dgFns.MinutesIntoBar.body), 'lateness is read from gold\'s own quote time');

section('MT5 history catching up');
// Live, not the tester: straight after an outage MT5 is still filling the holes in its history.
const THU_0830 = srv(10, 29, 8, 30);
/** Live DonchianGold back at 08:30 on a Thursday, holding the bars it had before: its channel looks broken and its newest closed bar looks like a short signal. */
function dgLive(seed) {
  const b = fakeBroker({ magic: 20261009, open: goldOpen });
  b.live = true;
  b.bars = fallingBars(srv(10, 29, 8));
  b.gv.set(DG_GV + 'lastbar', srv(10, 28, 20));
  b.tick(THU_0830 - 1, 3900);
  if (seed) seed(b);
  const ea = loadDonchianGold(b);
  ea.OnInit();
  return { b, ea };
}
const decided = b => rowsNamed(b, 'BAR').length;
const H0 = dgLive();
H0.ea.Run();
H0.b.tick(THU_0830 + 18, 3899);
H0.ea.Run();
ok(decided(H0.b) === 0 && H0.b.sends.length === 0 && H0.b.gv.get(DG_GV + 'lastbar') === srv(10, 28, 20), 'in the first minute after a start no bar is decided, even with new quotes');
// The holes fill: the true bars show this was no breakout at all.
H0.b.bars.slice(-22, -2).forEach(r => { r.low = 3980; });
H0.b.tick(THU_0830 + 60, 3899);
H0.ea.Run();
ok(decided(H0.b) === 1 && /\| FLAT$/.test(rowsNamed(H0.b, 'BAR')[0].detail) && H0.b.sends.length === 0, 'after a minute it decides on the full history: the false signal never traded');
const H1 = dgLive();
H1.b.synced = false;
H1.b.tick(THU_0830 + 61, 3899);
H1.ea.Run();
const notDone = decided(H1.b);
H1.b.synced = true;
H1.b.tick(THU_0830 + 62, 3899);
H1.ea.Run();
ok(notDone === 0 && decided(H1.b) === 1, 'after that minute it still waits if MT5 says it isn\'t done');
const H2 = dgLive();
H2.b.synced = false;
timers(H2.b, H2.ea, THU_0830 - 1 + 30, THU_0830 - 1 + 299, 30);        // the timer keeps running: no outage, just a slow flag
H2.b.tick(THU_0830 - 1 + 299, 3899);
H2.ea.Run();
const at299 = decided(H2.b);
H2.b.tick(THU_0830 - 1 + 300, 3899);
H2.ea.Run();
ok(at299 === 0 && decided(H2.b) === 1, 'but never past five minutes: a flag that never clears can\'t leave the EA quiet');

// What needs no bars never waits.
const H3 = dgLive(b => { withLong(b); b.gv.set(DG_GV + 'exit_pending', 1); });
H3.b.tick(THU_0830 + 1, 3899);
H3.ea.Run();
ok(!H3.b.position && rowsNamed(H3.b, 'EXIT_STOP').length === 1, 'an exit already decided goes straight away');
const H4 = dgLive(b => { withLong(b); b.gv.set('DG_KILL', 1); });
H4.b.tick(THU_0830 + 1, 3899);
H4.ea.Run();
ok(!H4.b.position && rowsNamed(H4.b, 'KILL_SWITCH').length === 1, 'so does the kill switch');
const H5 = dgLive(withLong);
H5.b.tick(THU_0830 + 1, 3899);
H5.ea.Run();
ok(H5.b.position && decided(H5.b) === 0, 'an exit that still needs a bar\'s numbers waits for them, with the broker\'s stop in place');
H5.b.tick(THU_0830 + 60, 3899);
H5.ea.Run();
ok(!H5.b.position && rowsNamed(H5.b, 'EXIT_STOP').length === 1, 'and goes after the minute');
// A pending entry reads bars too, and is measured only when they can be trusted.
const H6 = dgLive(b => { b.gv.set(DG_GV + 'entry_dir', -1); b.gv.set(DG_GV + 'entry_bar', srv(10, 29, 4)); b.gv.set(DG_GV + 'entry_atr', 20); });
H6.b.tick(THU_0830 + 1, 3899);
H6.ea.Run();
ok(H6.b.sends.length === 0 && H6.b.gv.get(DG_GV + 'entry_dir') === -1, 'a pending entry waits too');
H6.b.tick(THU_0830 + 60, 3899);
H6.ea.Run();
ok(H6.b.sends.length === 1 && rowsNamed(H6.b, 'ENTRY_SHORT').length === 1, 'and goes once the minute is up');

// A sleep or a lost connection with the EA still running: its bars have holes just the same.
const H7 = dgLive();
timers(H7.b, H7.ea, THU_0830 + 60, THU_0830 + 120, 30);
const seenBefore = decided(H7.b);
H7.b.bars.push({ time: srv(10, 29, 20), open: 3895, high: 3895, low: 3895, close: 3895 });
H7.b.tick(srv(10, 29, 20, 34), 3895);
H7.ea.Run();
const atWake = decided(H7.b);
H7.b.tick(srv(10, 29, 20, 35), 3895);
H7.ea.Run();
ok(seenBefore === 1 && atWake === 1 && decided(H7.b) === 2, 'back from a sleep: the first tick waits, and the bar is decided a minute later');
const H8 = dgLive();
timers(H8.b, H8.ea, THU_0830 + 60, THU_0830 + 120, 30);
H8.b.offline = true;
H8.b.clock = THU_0830 + 150;
H8.ea.Run();
H8.b.offline = false;
H8.b.bars.push({ time: srv(10, 29, 12), open: 3895, high: 3895, low: 3895, close: 3895 });
H8.b.tick(THU_0830 + 180, 3895);
H8.ea.Run();
const atBack = decided(H8.b);
H8.b.tick(THU_0830 + 210, 3895);
H8.ea.Run();
ok(atBack === 1 && decided(H8.b) === 2, 'a lost connection: the minute runs from when it was last seen down');
// Running normally nothing waits: not at a new bar, and not on Monday after a weekend of quiet timers.
const H9 = dgLive();
timers(H9.b, H9.ea, THU_0830 + 60, srv(10, 29, 12), 30);
H9.b.bars.push({ time: srv(10, 29, 12), open: 3895, high: 3895, low: 3895, close: 3895 });
H9.b.tick(srv(10, 29, 12), 3895);
H9.ea.Run();
ok(decided(H9.b) === 2, 'running normally, a new bar is decided on its first tick');
const HW = dgAttach(SAT_ATTACH);
HW.b.live = true;
timers(HW.b, HW.ea, SAT_ATTACH + 30, MON_OPEN + 60, 30);
const satSkips = rowsNamed(HW.b, 'SKIP').length, satSends = HW.b.sends.length;
HW.b.bars.push({ time: MON_BAR, open: 3990, high: 3990, low: 3990, close: 3990 });
HW.b.tick(MON_OPEN + 61, 3990);
HW.ea.Run();
ok(satSkips === 0 && satSends === 0 && rowsNamed(HW.b, 'SKIP').length === 1 && rowsNamed(HW.b, 'BAR').length === 2, 'live over a weekend: Monday\'s first tick still drops the old signal and decides afresh, with no wait');
const InTester = dgLive();
InTester.b.live = false;
InTester.b.synced = false;
InTester.ea.Run();
ok(decided(InTester.b) === 1, 'the tester never waits, so its results can\'t move');
const runBody = dgFns.Run.body;
ok(runBody.indexOf('pendingExit > 0') < runBody.indexOf('HistorySettling()') && runBody.indexOf('HistorySettling()') < runBody.indexOf('iTime('), 'Run asks after what needs no bars and before reading any');
ok(/^\s*if\(MQLInfoInteger\(MQL_TESTER\)\) return false;/m.test(dgFns.HistorySettling.body), 'the first thing HistorySettling does is rule out the tester');

section('MT5 market closed: GoldIntraday and the rule itself');
// GoldIntraday: its own send paths, on the same broker.
const giLoad = () => {
  const b = fakeBroker({ magic: 20261013 + 3, open: goldOpen });
  b.tick(FRI_LAST, 3896.525);
  const env = Object.assign(b.env, { FindPos: () => !!b.position, HasPos: () => !!b.position, FindOrder: () => 77, EntryAllowed: () => true, LotsFor: () => 0.01,
    DayOf: t => Math.floor(t / 86400), Magic: k => 20261013 + k, Px: p => (+p).toFixed(3), Hm: m => String(m) });
  const ea = loadEa('GoldIntraday.mq5', { env, lift: ['IsDemo', 'Transient', 'LastQuoteMs', 'WaitingForQuote', 'NoteRefusal', 'JournalFailure', 'CancelOrder', 'DeleteOrders', 'Enter', 'PlaceStop', 'CloseStrat', 'TpPrice', 'RiskText', 'Weight', 'Remember', 'GVSet', 'GVGet', 'GVDel'] });
  return { b, ea };
};
const started = g => { g.ea.set('g_waitQuote', g.ea.LastQuoteMs()); g.ea.set('g_waitSaid', false); };     // what OnInit does (checked below)
const G = giLoad();
started(G);
G.b.position = { ticket: 9, dir: -1, lots: 0.01, sl: 3950, tp: 0, price: 3930, time: FRI_BAR, magic: 20261016 };
let giTimers = 0;
for (let t = SAT_ATTACH; t < MON_OPEN + 60; t += 10) { G.b.clock = t; G.ea.CloseStrat(3, 'SESSION'); giTimers++; }
ok(G.b.sends.length === 0 && G.b.position && G.ea.get('g_exitWhy')[3] === 'SESSION' && rowsNamed(G.b, 'WAIT').length === 1,
   'GoldIntraday restarted on a weekend holding a position: ' + giTimers + ' timer events, no close sent, the exit stays pending');
G.b.tick(MON_OPEN + 61, 3990);
G.ea.CloseStrat(3, 'SESSION');
ok(!G.b.position && rowsNamed(G.b, 'EXIT_SESSION').length === 1 && G.ea.get('g_exitWhy')[3] === '', 'it closes on the first new tick');
const G2 = giLoad();
G2.b.clock = srv(10, 31, 0, 0, 5);
G2.b.position = { ticket: 9, dir: -1, lots: 0.01, sl: 3950, tp: 0, price: 3930, time: FRI_BAR, magic: 20261016 };
for (let i = 0; i < 50; i++) G2.ea.CloseStrat(3, 'SESSION');
ok(G2.b.sends.length === 1 && rowsNamed(G2.b, 'ERROR').length === 1, 'a close refused as "market closed" is not resent until there is a new quote');
const pending = [G2.ea.Enter(5, -1, 0, 20, 'x'), G2.ea.PlaceStop(1, 1, { level: 3800, sl: 3900, until: 1200 }), G2.ea.CancelOrder(1, 77)];
G2.ea.DeleteOrders(1);
ok(pending[0] === true && pending[1] === 3 && pending[2] === false && G2.b.sends.length === 1, 'nor is anything else: an entry stays queued, a stop order is tried again later, a cancel waits');
G2.b.position = null;
G2.b.tick(MON_OPEN + 1, 3990);
ok(G2.ea.Enter(5, -1, 0, 20, 'x') === false && G2.b.sends.length === 2 && Math.abs(G2.b.sends[1].sl - 4010) < 1e-9, 'with a new quote the entry goes, its stop worked out from that quote');
const G3 = giLoad();
G3.b.tick(FRI_LAST + 1, 3896.6);
G3.b.refuseWith = RETCODES.TRADE_RETCODE_REQUOTE;
ok(G3.ea.Enter(5, -1, 0, 20, 'x') && G3.ea.Enter(5, -1, 0, 20, 'x') && G3.b.sends.length === 2, 'a requote is still resent straight away');

// The rule only works if nothing goes around it.
const SENDS = /\btrade\.(Buy|Sell|BuyStop|SellStop|PositionClose|PositionModify|OrderDelete)\(/;
[['DonchianGold.mq5', ['ClosePosition', 'FixTarget', 'OpenPosition', 'TrailStop']], ['GoldIntraday.mq5', ['CancelOrder', 'CloseStrat', 'Enter', 'FixTargets', 'PlaceStop']]].forEach(([file, gated]) => {
  const fns = functionsOf(readMt5(file));
  ok(JSON.stringify(Object.keys(fns).filter(n => SENDS.test(fns[n].body)).sort()) === JSON.stringify(gated), file + ': only ' + gated.join(', ') + ' send orders');
  ok(gated.every(n => { const s = fns[n].body, at = s.search(SENDS); return s.indexOf('WaitingForQuote()') >= 0 && s.indexOf('WaitingForQuote()') < at && s.indexOf('NoteRefusal(', at) > at; }),
     file + ': each asks WaitingForQuote() before sending and reports the reply to NoteRefusal()');
  ok(/g_waitQuote = LastQuoteMs\(\);[^\n]*\n\s*g_waitSaid = false;/.test(fns.OnInit.body), file + ': OnInit starts by waiting for a quote newer than the last one seen');
  ok(/rc == TRADE_RETCODE_MARKET_CLOSED/.test(fns.Transient.body), file + ': "market closed" stays a reason to try again, not to give up');
  ok(!/TimeCurrent|TimeTradeServer|SymbolInfoSession/.test(fns.WaitingForQuote.body + fns.LastQuoteMs.body), file + ': the wait reads gold\'s own quote time, not a clock that stands still over a weekend');
});

section('MT5 history catching up: GoldIntraday');
// It works out a day's levels once and keeps them all day, so a hole at that moment would last until the next day.
const GI_NOW = srv(11, 3, 9, 1);                                  // a Tuesday, a minute into the 09:00 bar
/** Daily bars up to today; with `hole` the 13 days before today are missing, as on 29 Oct. */
const dailyBars = (today, hole) => {
  const out = [];
  for (let i = 60; i >= 0; i--) {
    if (hole && i >= 1 && i <= 13) continue;
    const px = 4200 - (60 - i) * 3;
    out.push({ time: (Math.floor(today / 86400) - i) * 86400, open: px, high: px + 20 + i % 7, low: px - 20 - i % 5, close: px - 1 });
  }
  return out;
};
/** GoldIntraday's real Run and LoadDay, live and just started at `now`; what they hand on to the strategies is only recorded. */
function giRun(now, seed) {
  const b = fakeBroker({ magic: 20261016, open: goldOpen });
  b.live = true;
  b.daily = dailyBars(now, true);
  b.held = {};                                                    // strategy -> when its position opened
  const calls = [], call = n => () => { calls.push(n); };
  Object.assign(b.env, {
    NS: 7, g_day: { day: -1, ok: false, dtOk: false },
    DayOf: t => Math.floor(t / 86400), MinOfDay: t => Math.floor((t % 86400) / 60), Px: p => (+p).toFixed(3),
    CountTrades: call('CountTrades'), Reconcile: call('Reconcile'), TrackFills: call('TrackFills'), FixTargets: call('FixTargets'), StandDown: call('StandDown'),
    Decide: call('Decide'), Arm: call('Arm'), SendQueued: call('SendQueued'), SyncOrders: call('SyncOrders'),
    FlatMinute: () => 23 * 60,
    HasPos: k => k in b.held, FindPos: k => k in b.held, openedAt: k => b.held[k],
    CloseStrat: (k, why) => { calls.push('close ' + why); delete b.held[k]; },
    iTime: (s, tf, shift) => Math.floor(b.now / 900) * 900 - shift * 900,
    CopyRates: (s, tf, start, count, r) => { r.length = 0; b.daily.forEach(x => r.push(x)); return r.length; }
  });
  b.gv.set('GI_lastbar', Math.floor(now / 900) * 900 - 900);      // not a first start: this bar has not been decided yet
  b.tick(now, 3900);
  if (seed) seed(b);
  const ea = loadEa('GoldIntraday.mq5', {
    env: b.env,
    lift: ['IsDemo', 'Run', 'LoadDay', 'AtrLast', 'TrueRange', 'NoteOutage', 'HistorySettling', 'GVSet', 'GVGet', 'GVDel'],
    patches: [['if(!FindPos(k, t, s, opened)) continue;', 'if(!FindPos(k)) continue; opened = openedAt(k);']]
  });
  ea.set('GVP', 'GI_');
  ea.set('g_settleFrom', now); ea.set('g_lastRun', now);          // what OnInit does (checked below)
  for (let k = 0; k < 7; k++) ea.get('g_exitWhy')[k] = '';
  return { b, ea, calls };
}
const giDay = g => { const r = rowsNamed(g.b, 'DAY')[0]; return r ? r.detail : null; };
const barsRead = g => ['Decide', 'Arm', 'SendQueued', 'SyncOrders'].some(n => g.calls.includes(n));
const count = (g, n) => g.calls.filter(c => c === n).length;

const Full = giRun(GI_NOW, b => { b.live = false; b.daily = dailyBars(GI_NOW, false); });
Full.ea.Run();
const Holed = giRun(GI_NOW, b => { b.live = false; b.synced = false; });
Holed.ea.Run();
ok(giDay(Full) && giDay(Holed) && giDay(Full) !== giDay(Holed), 'the tester never waits, and shows the danger: a history with holes gives other Dual Thrust levels');
const Gi0 = giRun(GI_NOW);
Gi0.ea.Run();
Gi0.b.tick(GI_NOW + 18, 3899);
Gi0.ea.Run();
ok(!giDay(Gi0) && !barsRead(Gi0) && Gi0.b.gv.get('GI_lastbar') === Math.floor(GI_NOW / 900) * 900 - 900, 'in the first minute after a start no levels are worked out and no bar is decided, even with new quotes');
ok(!Gi0.b.sends.length && !Gi0.calls.includes('StandDown'), 'and the orders resting at the broker are left alone');
ok(count(Gi0, 'Reconcile') === 2 && count(Gi0, 'TrackFills') === 2, 'but a stop order that filled or a position that closed while it was off is reported at once');
// The holes fill: the levels now come from the whole history, and stay right for the day.
Gi0.b.daily = dailyBars(GI_NOW, false);
Gi0.b.tick(GI_NOW + 60, 3899);
Gi0.ea.Run();
ok(giDay(Gi0) === giDay(Full) && count(Gi0, 'Decide') === 1 && count(Gi0, 'Arm') === 1, 'after a minute the day\'s levels come from the whole history, and the bar is decided');
const Gi1 = giRun(GI_NOW);
Gi1.b.synced = false;
timers(Gi1.b, Gi1.ea, GI_NOW + 10, GI_NOW + 300, 10);             // the timer keeps running: no outage, just a slow flag
ok(!giDay(Gi1) && !barsRead(Gi1), 'after that minute it still waits if MT5 says it isn\'t done');
Gi1.b.clock = GI_NOW + 300;
Gi1.ea.Run();
ok(giDay(Gi1) && barsRead(Gi1), 'but never past five minutes');

// What needs no bars never waits.
const Gi2 = giRun(GI_NOW, b => { b.held[3] = GI_NOW - 86400; });
Gi2.ea.Run();
ok(Gi2.calls.includes('close SESSION') && !giDay(Gi2), 'a position left from an earlier day closes straight away');
const Gi3 = giRun(GI_NOW, b => { b.held[3] = GI_NOW - 60; b.gv.set('DG_KILL', 1); });
Gi3.ea.Run();
ok(Gi3.calls.includes('close KILL_SWITCH') && Gi3.calls.includes('StandDown'), 'so does the kill switch');
const Gi4 = giRun(GI_NOW, b => { b.held[4] = GI_NOW - 60; });
Gi4.ea.get('g_exitWhy')[4] = 'REVERSE';
Gi4.ea.Run();
ok(Gi4.calls.includes('close REVERSE') && !barsRead(Gi4), 'so does an exit already decided');
const Gi5 = giRun(srv(11, 3, 23, 1), b => { b.held[1] = srv(11, 3, 17, 0); });
Gi5.ea.Run();
ok(Gi5.calls.includes('close SESSION') && Gi5.calls.includes('StandDown'), 'and flat at 23:00 still means flat');
// A restart inside the bar: the stop orders' levels are rebuilt only after the minute, and a passed level isn't chased.
const Gi6 = giRun(GI_NOW, b => { b.gv.set('GI_lastbar', Math.floor(GI_NOW / 900) * 900); });
Gi6.ea.Run();
const armedTooSoon = barsRead(Gi6);
Gi6.b.clock = GI_NOW + 60;
Gi6.ea.Run();
ok(!armedTooSoon && count(Gi6, 'Arm') === 1 && !Gi6.calls.includes('Decide') && Gi6.ea.get('g_noChase') === true, 'restarted inside a bar: orders are rebuilt after the minute, with no chasing');

// A sleep or a lost connection with the EA still running.
const Gi7 = giRun(GI_NOW);
timers(Gi7.b, Gi7.ea, GI_NOW + 60, GI_NOW + 120, 10);
const decidedOnce = count(Gi7, 'Decide');
Gi7.b.tick(srv(11, 3, 11, 0), 3899);
Gi7.ea.Run();
const atWakeGi = count(Gi7, 'Decide');
Gi7.b.tick(srv(11, 3, 11, 1), 3899);
Gi7.ea.Run();
ok(decidedOnce === 1 && atWakeGi === 1 && count(Gi7, 'Decide') === 2, 'back from a sleep: the first tick waits, and the bar is decided a minute later');
const Gi8 = giRun(GI_NOW);
timers(Gi8.b, Gi8.ea, GI_NOW + 60, srv(11, 3, 9, 14, 30), 10);
Gi8.b.offline = true;
Gi8.b.clock = srv(11, 3, 9, 14, 30);
Gi8.ea.Run();
Gi8.b.offline = false;
Gi8.b.tick(srv(11, 3, 9, 15), 3899);
Gi8.ea.Run();
const atBackGi = count(Gi8, 'Decide');
Gi8.b.tick(srv(11, 3, 9, 15, 30), 3899);
Gi8.ea.Run();
ok(atBackGi === 1 && count(Gi8, 'Decide') === 2, 'a lost connection: the minute runs from when it was last seen down');
// Running normally nothing waits: not at a new bar, and not on Monday after a weekend of quiet timers.
const Gi9 = giRun(GI_NOW);
timers(Gi9.b, Gi9.ea, GI_NOW + 60, srv(11, 3, 9, 15), 10);
Gi9.b.tick(srv(11, 3, 9, 15), 3899);
Gi9.ea.Run();
ok(count(Gi9, 'Decide') === 2, 'running normally, a new bar is decided on its first tick');
const GiW = giRun(FRI_LAST, b => { b.daily = dailyBars(srv(11, 2, 1, 3), false); });
timers(GiW.b, GiW.ea, FRI_LAST + 60, srv(11, 2, 1, 2, 30), 60);
GiW.b.tick(srv(11, 2, 1, 3), 3990);
GiW.ea.Run();
ok(giDay(GiW) && GiW.calls.includes('Decide'), 'live over a weekend: Monday\'s first tick works out the levels and decides, with no wait');

[['DonchianGold.mq5', 'pendingExit > 0'], ['GoldIntraday.mq5', 'm >= flat) { StandDown']].forEach(([file, last]) => {
  const fns = functionsOf(readMt5(file)), body = fns.Run.body, at = body.indexOf('HistorySettling()');
  ok(body.indexOf('NoteOutage()') > 0 && body.indexOf('NoteOutage()') < body.indexOf(last) && body.indexOf(last) < at, file + ': Run notes an outage first, and waits only after what needs no bars');
  ok(!/iTime|CopyRates|LoadDay|Decide|Arm\(/.test(body.slice(0, at)), file + ': nothing before the wait reads a bar');
  ok(/^\s*if\(MQLInfoInteger\(MQL_TESTER\)\) return false;/m.test(fns.HistorySettling.body), file + ': the first thing the wait does is rule out the tester');
  ok(/g_settleFrom = g_lastRun = TimeLocal\(\);/.test(fns.OnInit.body), file + ': OnInit starts the minute');
});

section('MT5 $150 stop cap and the take-profit from the fill');
// Owner decisions of 4 Nov 2026: no trade whose stop would cost over $150 at its size; every take-profit exactly its
// strategy's multiple of the risk from the real fill (on 3 Nov a $1.09 slip turned New York's 1:4 into 1:3.3).
const I = require('../research/intraday.js'), DTR = require('../research/daytrade.js');
const capIn = (src, name) => +(new RegExp('input double ' + name + '\\s*=\\s*([\\d.]+)').exec(src) || [])[1];
ok(I.MAX_STOP === 150 && capIn(readMt5('GoldIntraday.mq5'), 'InpMaxStopUsd') === I.MAX_STOP && capIn(readMt5('DonchianGold.mq5'), 'InpMaxStopUsd') === I.MAX_STOP &&
   /maxStop: 150,/.test(fs.readFileSync(path.join(__dirname, '..', 'research', 'parity_mt5.js'), 'utf8')),
   'both EAs\' cap inputs match the research and the H4 parity check: $150');
// Research, intraday engine: a rising Monday on M15.
const capDay = Date.UTC(2026, 10, 2), capM15 = [];
for (let i = 4; i < 92; i++) { const px = 2000 + (i - 4) * 2; capM15.push({ t: capDay + i * 900000, o: px, h: px + 1, l: px - 1, c: px + 0.5, sp: 0.3 }); }
const capRun = (S, cap) => I.backtest(capM15, Object.assign({ name: 'test', flatMin: 23 * 60, maxPerDay: 1 }, S, { maxStop: cap }), I.COSTS.real);
const restingS = dist => ({ onDay: () => ({ orders: [{ side: 1, level: 2050, stop: 2050 - dist, targetR: 2, until: 22 * 60 }] }) });
const marketS = dist => ({ onClose: (i, pos) => (!pos && i === 10 ? { enter: { side: 1, stopDist: dist, targetR: 1.5 } } : null) });
ok(capRun(restingS(149), 150).length === 1 && capRun(restingS(151), 150).length === 0 && capRun(restingS(151), 0).length === 1,
   'research: a resting order whose stop would cost over $150 at 0.01 lots never fills; a cap of 0 is none');
ok(capRun(marketS(149), 150).length === 1 && capRun(marketS(151), 150).length === 0 && capRun(marketS(151), undefined).length === 1,
   'research: so is a market entry, measured from its stop distance; a strategy without the cap trades as before');
// Research, H4 engine: a quiet range, then one bar closes above it; the stop is 2 x ATR, so the range sets its cost.
const capH4 = range => {
  const bars = [], t0 = Date.UTC(2026, 0, 5);
  for (let i = 0; i < 260; i++) bars.push({ t: t0 + i * 14400000, o: 3000, h: 3000 + range / 2, l: 3000 - range / 2, c: 3000, sp: 0.3, v: 1 });
  bars.push({ t: t0 + 260 * 14400000, o: 3000, h: 3000 + range * 1.2, l: 2995, c: 3000 + range, sp: 0.3, v: 1 });
  for (let i = 261; i < 300; i++) bars.push({ t: t0 + i * 14400000, o: 3000 + range, h: 3000 + range * 1.1, l: 3000 + range * 0.9, c: 3000 + range, sp: 0.3, v: 1 });
  return bars;
};
const capCfg = cap => ({ dir: 'both', N: 20, M: 10, k: 2, ema: 100, maxBars: 60, barMin: 240, flat: false, swapLong: -5.92, swapShort: 3.67, hardK: 4,
  targetR: 1.5, targetWait: true, maxStop: cap, firstEntryMin: 0, lastEntryMin: 24 * 60, flatMin: Infinity, from: -Infinity,
  to: Date.UTC(2026, 0, 5) + 299 * 14400000 });                  // the last bar closes what is still open, so it counts
const h4Narrow = DTR.simulate(capH4(60), capCfg(150)), h4Wide = DTR.simulate(capH4(80), capCfg(150)), h4Off = DTR.simulate(capH4(80), capCfg(0));
ok(h4Narrow.length === 1 && h4Narrow[0].risk < 150 && h4Wide.length === 0 && h4Off.length === 1 && h4Off[0].risk > 150,
   'research: the H4 breakout with a $' + (h4Off[0] ? h4Off[0].risk.toFixed(0) : '?') + ' stop is dropped under the cap and taken without it');
ok(/target: cfg\.targetR \? fill \+ side \* cfg\.targetR \* sig\.stopDist/.test(fs.readFileSync(path.join(__dirname, '..', 'research', 'daytrade.js'), 'utf8')) &&
   /target: spec\.targetR \? fill \+ side \* spec\.targetR \* risk/.test(fs.readFileSync(path.join(__dirname, '..', 'research', 'intraday.js'), 'utf8')),
   'research: both engines measure the take-profit from the fill, which is what the EAs now match');

// GoldIntraday: its real LotsFor, PlaceStop, Enter and FixTargets on the fake broker.
const giCap = () => {
  const b = fakeBroker({ magic: 20261014, open: goldOpen });
  b.tick(srv(11, 3, 17, 0), 3942.5);
  const env = Object.assign(b.env, { NS: 7, FindPos: k => !!b.position && b.position.magic === 20261013 + k, HasPos: () => !!b.position, FindOrder: () => 0,
    EntryAllowed: () => true, DayOf: t => Math.floor(t / 86400), Magic: k => 20261013 + k, Px: p => (+p).toFixed(3), Hm: m => String(m), lotsWhy: { v: '' } });
  // LotsFor hands its reason back by reference, which JS can't: the patches carry it through env.lotsWhy.
  const ea = loadEa('GoldIntraday.mq5', { env, lift: ['IsDemo', 'Transient', 'LastQuoteMs', 'WaitingForQuote', 'NoteRefusal', 'JournalFailure', 'Enter', 'PlaceStop',
    'LotsFor', 'FixTargets', 'TpPrice', 'RiskText', 'Weight', 'Remember', 'GVSet', 'GVGet', 'GVDel'], patches: [
    ['{ reason = "its stop would cost $"', '{ reason = lotsWhy.v = "its stop would cost $"'],
    ['Journal(k, "SKIP", reason + " (stop "', 'Journal(k, "SKIP", (reason || lotsWhy.v) + " (stop "'],
    ['if(reason == "symbol data not ready") return true; Journal(k, "SKIP", reason);', 'if(reason == "symbol data not ready") return true; Journal(k, "SKIP", reason || lotsWhy.v);']] });
  return { b, ea };
};
const Cap = giCap();
ok(Cap.ea.LotsFor(3, 150, 4000, '') === 0.003 && Cap.ea.LotsFor(3, 150.004, 4000, '') === 0.003 && Cap.ea.LotsFor(3, 150.01, 4000, '') === 0,
   'GoldIntraday: a stop costing exactly $150.00 at 0.01 lots is traded (at 0.5% of $10,000: 0.003 lots); $150.01 is not');
ok(Cap.ea.LotsFor(3, 25, 4000, '') === 0.02 && Cap.ea.LotsFor(3, 40, 4000, '') === 0.012,
   'GoldIntraday sizes by 0.5% of equity: a $25 stop gets 0.02 lots ($50), a $40 stop 0.012 lots ($48), rounded down to the 0.001 step');
Cap.ea.set('InpFixedLots', 0.01);
ok(Cap.ea.LotsFor(3, 150, 4000, '') === 0.01 && Cap.ea.LotsFor(3, 150.01, 4000, '') === 0, 'at a fixed 0.01 lots the same cap applies');
Cap.ea.set('InpFixedLots', 0);
ok(Cap.ea.PlaceStop(3, 0, { level: 4100, sl: 3900, until: 1200 }) === 1 && Cap.ea.PlaceStop(3, 1, { level: 3900, sl: 4100, until: 1200 }) === 1 && Cap.b.sends.length === 0,
   'a Dual Thrust day with a $200 range: neither stop order is sent');
const capSkips = rowsNamed(Cap.b, 'SKIP');
ok(capSkips.length === 1 && capSkips[0].detail === 'its stop would cost $200.00 at 0.01 lots, over the $150 cap (stop 200.000 away)', 'one SKIP row a day says why: ' + (capSkips[0] || {}).detail);
ok(Cap.ea.Enter(4, -1, 0, 160, 'breakdown') === false && Cap.b.sends.length === 0 && rowsNamed(Cap.b, 'SKIP')[1].detail === 'its stop would cost $160.00 at 0.01 lots, over the $150 cap' &&
   Cap.ea.Enter(4, -1, 0, 36, 'breakdown') === false && Cap.b.sends.length === 1 && rowsNamed(Cap.b, 'ENTRY_SHORT').length === 1,
   'a market entry over the cap is skipped too; one under it goes');
Cap.ea.set('InpMaxStopUsd', 0);
ok(Cap.ea.LotsFor(3, 400, 4000, '') === 0.001, 'a cap of 0 turns it off');

// The 3 Nov New York trade: a sell stop at 3942.150, filled $1.085 lower; its take-profit was set from the level.
const ny = () => ({ ticket: 44516201, dir: -1, lots: 0.01, sl: 3949.17, tp: 3914.07, price: 3941.065, time: srv(11, 3, 17, 0, 1), magic: 20261014 });
const Fx = giCap();
Fx.b.position = ny();
Fx.ea.FixTargets();
const fxMove = Fx.b.sends[0], fxRow = rowsNamed(Fx.b, 'TARGET')[0];
ok(Fx.b.sends.length === 1 && fxMove.kind === 'modify' && fxMove.tp === 3908.645 && fxMove.sl === 3949.17 && Fx.b.position.tp === 3908.645,
   'GoldIntraday: the filled position\'s take-profit moves to exactly 4 x the risk from the fill (3908.645, was 3914.070); the stop stays');
ok(fxRow && fxRow.detail === 'take-profit moved from 3914.070 to 3908.645: 4.00 x the risk from the fill at 3941.065', 'one TARGET row says so: ' + (fxRow || {}).detail);
for (let i = 0; i < 20; i++) Fx.ea.FixTargets();
ok(Fx.b.sends.length === 1, 'and it is not sent again');
const Ex = giCap();
Ex.b.position = Object.assign(ny(), { price: 3942.15 });
Ex.ea.FixTargets(); Ex.ea.FixTargets();
ok(Ex.b.sends.length === 0 && !rowsNamed(Ex.b, 'TARGET').length, 'filled right at its level: already exact, nothing sent');
const Rf = giCap();
Rf.b.position = ny();
Rf.b.refuseWith = 10016;                                          // invalid stops: the price is already past it
for (let i = 0; i < 5; i++) Rf.ea.FixTargets();
ok(Rf.b.sends.length === 1 && rowsNamed(Rf.b, 'ERROR').length === 1 && /failed, retcode 10016 .*; it stays at 3914\.070$/.test(rowsNamed(Rf.b, 'ERROR')[0].detail) && Rf.b.position.tp === 3914.07,
   'refused for good: one try, one ERROR row, and the order\'s own take-profit stays');
const Mc = giCap();
Mc.b.position = ny();
Mc.b.clock = srv(11, 4, 0, 30);                                   // gold's daily break: orders are refused as "market closed"
for (let i = 0; i < 5; i++) Mc.ea.FixTargets();
const mcClosed = Mc.b.sends.length;
Mc.b.tick(srv(11, 4, 1, 6), 3930);
Mc.ea.FixTargets();
ok(mcClosed === 1 && Mc.b.sends.length === 2 && Mc.b.position.tp === 3908.645, '"market closed": not resent until a new quote, then it goes');
const Nt = giCap();
Nt.b.position = Object.assign(ny(), { magic: 20261019, sl: 3972.313, tp: 3873.243, price: 3932.685 });   // 3 Nov Momentum at 20:00: filled at its price
Nt.ea.FixTargets();
ok(Nt.b.sends.length === 0, 'a market entry filled at the price it was sent at is left alone');

// DonchianGold: a short like 2 Nov's (strategy stop 64.068 above the fill), then the same filled 49.5 cents from its quote.
const dgFix = (fill, tp) => {
  const D = dgAttach(FRI_LAST, b => {
    b.position = { ticket: 44417258, dir: -1, lots: 0.01, sl: 4002.63, tp, price: fill, time: FRI_BAR, magic: 20261009 };
    b.gv.set(DG_GV + 'side', -1); b.gv.set(DG_GV + 'posid', 44417258); b.gv.set(DG_GV + 'stop', fill + 64.068);
  });
  D.b.tick(FRI_LAST + 1, 3896.6);
  return D;
};
const Df = dgFix(3874.495, 3778.393);
for (let i = 0; i < 5; i++) Df.ea.FixTarget(44417258, 3874.495);
ok(Df.b.sends.length === 0, 'DonchianGold: filled at its quote, the take-profit is already 1.5 x the strategy stop: nothing sent');
const Ds = dgFix(3874.0, 3778.393);
for (let i = 0; i < 5; i++) Ds.ea.FixTarget(44417258, 3874.0);
ok(Ds.b.sends.length === 1 && Ds.b.sends[0].kind === 'modify' && Ds.b.sends[0].tp === 3777.898 && Ds.b.sends[0].sl === 4002.63 &&
   (rowsNamed(Ds.b, 'TARGET')[0] || {}).detail === 'take-profit moved from 3778.393 to 3777.898: 1.5 x the strategy stop from the fill at 3874.000',
   'filled away from its quote: the take-profit moves once to 1.5 x the strategy stop from the fill, the broker stop stays');
const Dr = dgFix(3874.0, 3778.393);
Dr.b.refuseWith = 10016;
for (let i = 0; i < 5; i++) Dr.ea.FixTarget(44417258, 3874.0);
ok(Dr.b.sends.length === 1 && rowsNamed(Dr.b, 'ERROR').length === 1, 'refused for good: tried once, journaled once');
const giRunBody = functionsOf(readMt5('GoldIntraday.mq5')).Run.body;
ok(giRunBody.indexOf('FixTargets();') > giRunBody.indexOf('m >= flat) { StandDown') && giRunBody.indexOf('FixTargets();') < giRunBody.indexOf('HistorySettling()') &&
   count(Gi0, 'FixTargets') === count(Gi0, 'Reconcile') && count(Gi0, 'FixTargets') === 3 && !Gi5.calls.includes('FixTargets'),
   'GoldIntraday: Run fixes take-profits on every tick, even in the minute after a start, and not once it is flat for the day');
ok(dgFns.Run.body.indexOf('FixTarget(ticket, openPrice)') > dgFns.Run.body.indexOf('ReportOutsideClose') &&
   dgFns.Run.body.indexOf('FixTarget(ticket, openPrice)') < dgFns.Run.body.indexOf('HistorySettling()'),
   'DonchianGold: Run fixes the take-profit after what closes a position and before the history wait');
const DgCap = dgAttach(FRI_LAST);
DgCap.b.tick(FRI_LAST + 1, 3896.6);
ok(DgCap.ea.OpenPosition(-1, 80, FRI_BAR - 14400) === false && DgCap.b.sends.length === 0 &&
   /^short entry: its stop would cost \$160\.00 at 0\.01 lots, over the \$150 cap$/.test((rowsNamed(DgCap.b, 'SKIP')[0] || {}).detail),
   'DonchianGold: a breakout whose 2 x ATR stop would cost $160 is skipped with a SKIP row');
ok(DgCap.ea.OpenPosition(-1, 70, FRI_BAR - 14400) === false && DgCap.b.sends.length === 1 && rowsNamed(DgCap.b, 'ENTRY_SHORT').length === 1,
   'and one costing $140 goes');

section('MT5 account stop (15% below the peak)');
{
  const A = fakeBroker({ magic: 20261009, open: () => true });
  const stop = A.env.DrawdownStop;
  A.equity = 10000;
  ok(stop(15) === '' && A.gv.get('DG_PEAK') === 10000, 'the first look records the peak');
  A.equity = 10600; stop(15);
  A.equity = 9011; const a1 = stop(15);
  ok(a1 === '' && A.gv.get('DG_PEAK') === 10600 && !A.gv.has('DG_KILL'), 'a new high raises the peak; 14.99% below it is still inside the limit');
  A.equity = 9009; const a2 = stop(15);
  ok(A.gv.get('DG_KILL') === 1 && /^account stop: equity 9009\.00 is 15\.0% below its peak of 10600\.00 \(limit 15\.0%\)/.test(a2) && A.onDisk && A.onDisk.get('DG_KILL') === 1,
     'over 15% below the peak: DG_KILL is set and saved to disk at once');
  ok(stop(15) === '' && stop(15) === '', 'once stopped it says so only once');
  A.gv.set('DG_KILL', 0); A.equity = 9009;
  ok(stop(15) !== '' && A.gv.get('DG_KILL') === 1, 'switched back on while still too far down: it stops again');
  A.gv.delete('DG_KILL'); A.gv.delete('DG_PEAK'); A.equity = 9009;
  ok(stop(15) === '' && A.gv.get('DG_PEAK') === 9009, 'with DG_PEAK deleted it counts from today\'s equity');
  A.equity = 0;
  ok(stop(15) === '' && stop(0) === '', 'no account data yet (equity 0), or a limit of 0: nothing happens');
  const dgRun = functionsOf(readMt5('DonchianGold.mq5')).Run.body, giRun = functionsOf(readMt5('GoldIntraday.mq5')).Run.body;
  ok(dgRun.indexOf('DrawdownStop(InpMaxDrawdownPct)') > 0 && dgRun.indexOf('DrawdownStop(InpMaxDrawdownPct)') < dgRun.indexOf('GlobalVariableGet("DG_KILL")') &&
     giRun.indexOf('DrawdownStop(InpMaxDrawdownPct)') > 0 && giRun.indexOf('DrawdownStop(InpMaxDrawdownPct)') < giRun.indexOf('GlobalVariableGet("DG_KILL")'),
     'both EAs check the account stop on every run, just before the kill switch that closes and stops');
  ok(['DonchianGold.mq5', 'GoldIntraday.mq5'].every(f => /#include "AccountGuard\.mqh"/.test(readMt5(f)) && /input double InpMaxDrawdownPct = 15\.0;/.test(readMt5(f)) &&
     /input double InpFixedLots\s*= 0;/.test(readMt5(f)) && /input double InpRiskPct\s*= 0\.5;/.test(readMt5(f))),
     'both EAs: 0.5% risk a trade and the 15% account stop by default (owner, 6 Nov 2026)');
}

section('MT5 H4 trailing stop');
const dgSrc = readMt5('DonchianGold.mq5'), parSrc = fs.readFileSync(path.join(__dirname, '..', 'research', 'parity_mt5.js'), 'utf8');
const inputOf = (src, name) => { const m = src.match(new RegExp('input double ' + name + '\\s*=\\s*([0-9.]+);')); return m ? +m[1] : NaN; };
ok(inputOf(dgSrc, 'InpTrailAtR') === 1 && inputOf(dgSrc, 'InpTrailDistR') === 0.5 && /trail: \{ at: 1, dist: 0\.5, broker: true \}/.test(parSrc),
   'DonchianGold trails from +1R at 0.5R behind, the setting research/trail_lab.js chose, and research/parity_mt5.js runs the same');
ok(!/trail/.test(readMt5('GoldIntraday.mq5').replace(/\/\/[^\n]*/g, '')), 'GoldIntraday has no trailing stop: none of the seven tried beat its current exits on 2023-2024');
// Research: a long that runs to +1.2R and falls back is stopped 0.5R behind its best price; without the trail it is still open.
const trailBars = () => {
  const bars = [], t0 = Date.UTC(2026, 0, 5), at = i => t0 + i * 14400000;
  for (let i = 0; i < 260; i++) bars.push({ t: at(i), o: 3000, h: 3030, l: 2970, c: 3000, sp: 0.3, v: 1 });
  bars.push({ t: at(260), o: 3000, h: 3062, l: 2995, c: 3060, sp: 0.3, v: 1 });          // breakout close: long from the next open
  bars.push({ t: at(261), o: 3060, h: 3204, l: 3055, c: 3200, sp: 0.3, v: 1 });          // +1.2R: the stop moves to 3204 - 0.5R
  bars.push({ t: at(262), o: 3200, h: 3200, l: 3100, c: 3110, sp: 0.3, v: 1 });          // falls through it
  for (let i = 263; i < 300; i++) bars.push({ t: at(i), o: 3110, h: 3115, l: 3105, c: 3110, sp: 0.3, v: 1 });
  return bars;
};
const trCfg = trail => Object.assign(capCfg(150), { trail });
const trOn = DTR.simulate(trailBars(), trCfg({ at: 1, dist: 0.5, broker: true })), trOff = DTR.simulate(trailBars(), trCfg(undefined));
const trStop = trOn[0] ? 3204 - 0.5 * trOn[0].risk : NaN;
ok(trOn.length === 1 && trOn[0].why === 'TRAIL' && trOn[0].exitT === Date.UTC(2026, 0, 5) + 262 * 14400000 &&
   Math.abs(trOn[0].r * trOn[0].risk - (trStop * (1 - 0.0001) - (3060 + 0.3) * (1 + 0.0001))) < 0.01 &&
   trOff.length === 1 && trOff[0].why !== 'TRAIL' && trOff[0].exitT > trOn[0].exitT,
   'research: the long that reached +1.2R is stopped at ' + trStop.toFixed(2) + ', 0.5R behind its best price, on the next bar; without the trail it stays open');
const trLate = DTR.simulate(trailBars().map((k, i) => (i === 261 ? Object.assign(k, { h: 3170, c: 3160 }) : i === 262 ? Object.assign(k, { o: 3160, h: 3165 }) : k)),
                            trCfg({ at: 1, dist: 0.5, broker: true }));
ok(trLate.length === 1 && trLate[0].why !== 'TRAIL', 'research: a trade that never got 1R ahead keeps its own stops');

/** DonchianGold holding a position filled 5 s into a bar, with `extremes` as the closed bars' highs (lows for a short) since then. */
const dgTrail = (dir, extremes, quote) => {
  const b = fakeBroker({ magic: 20261009, open: goldOpen });
  const T = srv(11, 2, 4), at = i => T + i * 14400;
  for (let i = -30; i < 0; i++) b.bars.push({ time: at(i), open: 4000, high: 4010, low: 3990, close: 4000 });
  extremes.forEach((x, i) => b.bars.push({ time: at(i), open: 4000, high: dir === 1 ? x : 4005, low: dir === 1 ? 3995 : x, close: 4000 }));
  b.bars.push({ time: at(extremes.length), open: 4000, high: 4000, low: 4000, close: 4000 });   // the bar in progress
  b.tick(at(extremes.length) + 30, quote);
  b.position = { ticket: 51, dir, lots: 0.01, sl: 4000 - dir * 120, tp: 4000 + dir * 90, price: 4000, time: T + 5, magic: 20261009 };
  b.gv.set(DG_GV + 'side', dir); b.gv.set(DG_GV + 'posid', 51); b.gv.set(DG_GV + 'stop', 4000 - dir * 60);
  const ea = loadDonchianGold(b);
  ea.OnInit();
  b.tick(at(extremes.length) + 60, quote);
  return { b, ea };
};
const Tn = dgTrail(1, [4040, 4055], 4045);
Tn.ea.TrailStop(51, 1, 4000);
ok(Tn.b.sends.length === 0, 'EA: best price $55 up on a $60 strategy stop (under 1R): the broker stop stays');
const Tm = dgTrail(1, [4040, 4072, 4050], 4060);
for (let i = 0; i < 4; i++) Tm.ea.TrailStop(51, 1, 4000);
ok(Tm.b.sends.length === 1 && Tm.b.sends[0].kind === 'modify' && Tm.b.sends[0].sl === 4042 && Tm.b.sends[0].tp === 4090 &&
   Tm.b.gv.get(DG_GV + 'trailed') === 1 &&
   (rowsNamed(Tm.b, 'TRAIL')[0] || {}).detail === 'stop moved from 3880.000 to 4042.000: 0.5 x the strategy stop behind the best price 4072.000',
   'EA: best price 4072 (+1.2R): the broker stop moves once to 4042, 0.5R behind it, the take-profit stays');
Tm.b.bars.splice(-1, 0, { time: Tm.b.bars[Tm.b.bars.length - 1].time, open: 4050, high: 4060, low: 4040, close: 4045 });
Tm.b.bars[Tm.b.bars.length - 1].time += 14400;
Tm.ea.TrailStop(51, 1, 4000);
ok(Tm.b.sends.length === 1, 'EA: a lower bar after that never loosens it');
const Ts = dgTrail(-1, [3950, 3928], 3940);
Ts.ea.TrailStop(51, -1, 4000);
ok(Ts.b.sends.length === 1 && Ts.b.sends[0].sl === 3958 && Ts.b.sends[0].tp === 3910, 'EA: a short trails above its lowest low the same way (3928 + 30 = 3958)');
const Tg = dgTrail(1, [4072], 4035);
Tg.ea.TrailStop(51, 1, 4000);
ok(!Tg.b.position && Tg.b.sends.length === 1 && Tg.b.sends[0].kind === 'close' && rowsNamed(Tg.b, 'EXIT_TRAIL').length === 1,
   'EA: price already below the new level (a gap): closed at market as EXIT_TRAIL, as the research fills it at the open');
const T0b = dgTrail(1, [], 4080);
T0b.ea.TrailStop(51, 1, 4000);
ok(T0b.b.sends.length === 0, 'EA: the bar it was filled in has not closed yet: nothing to read, nothing sent');
const Tr = dgTrail(1, [4072], 4060);
Tr.b.refuseWith = 10016;
for (let i = 0; i < 5; i++) Tr.ea.TrailStop(51, 1, 4000);
ok(Tr.b.sends.length === 1 && rowsNamed(Tr.b, 'ERROR').length === 1 && /it stays at 3880\.000$/.test(rowsNamed(Tr.b, 'ERROR')[0].detail),
   'EA: refused for good: tried once, journaled once, the old stop stays');
const Tc = dgTrail(1, [4072], 4060);
Tc.b.refuseWith = RETCODES.TRADE_RETCODE_MARKET_CLOSED;
Tc.ea.TrailStop(51, 1, 4000);
Tc.b.refuseWith = null;
Tc.ea.TrailStop(51, 1, 4000);
const tcHeld = Tc.b.sends.length;
Tc.b.tick(Tc.b.now + 30, 4060);
Tc.ea.TrailStop(51, 1, 4000);
ok(tcHeld === 1 && Tc.b.sends.length === 2 && Tc.b.position.sl === 4042, 'EA: "market closed": nothing resent until a new quote, then it moves');
const To = dgTrail(1, [4072], 4060);
To.ea.TrailStop(51, 1, 4000);
To.b.closeAt(4042, 'DEAL_REASON_SL');
To.ea.ReportOutsideClose(0);
const Th = dgTrail(1, [4040], 4045);
Th.b.closeAt(3880, 'DEAL_REASON_SL');
Th.ea.ReportOutsideClose(0);
ok(rowsNamed(To.b, 'EXIT_TRAIL').length === 1 && rowsNamed(Th.b, 'EXIT_HARDSTOP').length === 1 && !To.b.gv.has(DG_GV + 'trailed'),
   'EA: a broker-stop close after a move is journaled EXIT_TRAIL (research TRAIL), one that never moved stays EXIT_HARDSTOP');
const dgEx = dgFns.Run.body;
ok(/if\(\(datetime\)GVGet\("lastbar", 0\) == closed\)\s*\{\s*if\(has\) TrailStop\(ticket, side, openPrice\);/.test(dgEx) &&
   /if\(why != ""\) ClosePosition\(ticket, why\);\s*else TrailStop\(ticket, side, openPrice\);/.test(dgEx) &&
   dgEx.indexOf('TrailStop(') > dgEx.indexOf('HistorySettling()'),
   'Run trails only after the history wait and after the newest bar is decided, so an exit on that bar comes first');
ok(/EXIT_NAMES\[\] = \{ "", "EXIT_STOP", "EXIT_CHANNEL", "EXIT_TIME", "KILL_SWITCH", "EXIT_RETRY", "EXIT_TRAIL" \}/.test(dgSrc) &&
   /return EXIT_RETRY_CODE;/.test(dgFns.ExitCode.body) && /EXIT_RETRY_CODE = 5;/.test(dgSrc),
   'EXIT_TRAIL is added at the end, so a pending exit saved by the old build keeps its meaning');
}

section('MT5 watchdog');
{
  const W = world({ markets: MARKETS, props: { MT5_KEY: 'mk' } });
  // Thursday 5 Nov 2026 12:00 UTC = 14:00 broker time (offset +2 h): gold trades.
  const now = Date.UTC(2026, 10, 5, 12, 0), off = 7200;
  const row = (min, ea, strat, ev, detail) => ({ time: new Date(now - min * 60000), ea, strat, ev, eq: 10000, detail });
  const okStarts = [row(600, 'DonchianGold', 'H4', 'START', 'XAUUSD.sml PERIOD_H4, risk 0.50%, account stop 15% below the peak, demo account 1'),
                    row(600, 'GoldIntraday', 'ALL', 'START', 'XAUUSD.sml, risk 0.50% a trade, account stop 15% below the peak, demo account 1')];
  okStarts.forEach(r => { r.time = new Date(Date.UTC(2026, 10, 6, 1)); });
  const status = (dgMin, giMin, equity) => ({ DonchianGold: { seen: now - dgMin * 60000, equity, offset: off }, GoldIntraday: { seen: now - giMin * 60000, equity, offset: off } });
  W.ctx.__in = { now, st: status(5, 8, 10000), log: okStarts, built: { trades: [], open: [] }, state: {} };
  const run = () => W.run('watchdogCheck_(__in.now, __in.st, __in.log, __in.built, __in.state)');
  let r = run();
  ok(r.level === 'OK' && r.problems.length === 0 && r.state.peak === 10000 && r.state.seen === 2, 'watchdog: fresh heartbeats, new settings, no rows to worry about: OK, and it records the peak');
  W.ctx.__in.st = status(40, 8, 10000); W.ctx.__in.state = r.state;
  r = run();
  ok(r.level === 'WARN' && /DonchianGold: silent for 40 minutes while gold trades/.test(r.problems[0].text), 'an EA silent for 40 minutes while gold trades is a WARN');
  W.ctx.__in.now = Date.UTC(2026, 10, 7, 12, 0);
  r = run();
  ok(!r.problems.some(p => /silent/.test(p.text)), 'on a Saturday silence is normal');
  W.ctx.__in.now = now; W.ctx.__in.st = status(5, 5, 8900); W.ctx.__in.state = { peak: 10000, seen: 2 };
  r = run();
  ok(r.level === 'WARN' && /11\.0% below its peak 10000\.00/.test(r.problems[0].text), '11% below the peak: WARN, the account stop is at 15%');
  W.ctx.__in.st = status(5, 5, 8400);
  r = run();
  ok(r.level === 'ALERT' && /16\.0% below its peak/.test(r.problems[0].text), '16% below the peak: ALERT, the account stop should have fired');
  W.ctx.__in.st = status(5, 5, 10000); W.ctx.__in.state = { peak: 10000, seen: 2 };
  W.ctx.__in.log = okStarts.concat([row(20, 'GoldIntraday', 'NY_ORB', 'ENTRY_SHORT', 'stop order filled: 0.012 lots at 4000.000, stop 4010.000'),
                                     row(10, 'GoldIntraday', 'DUAL_THRUST', 'ERROR', 'buy stop failed, retcode 10018 (market closed); will retry'),
                                     row(5, 'DonchianGold', 'H4', 'KILL_SWITCH', 'account stop: equity 8500.00 is 15.0% below its peak')]);
  W.ctx.__in.log.slice(2).forEach(x => { x.time = new Date(Date.UTC(2026, 10, 6, 2)); });
  r = run();
  const texts = r.problems.map(p => p.level + ' ' + p.text).join(' | ');
  ok(r.level === 'ALERT' && /ALERT DonchianGold kill switch/.test(texts) && /WARN 1 ERROR row, latest DUAL_THRUST/.test(texts) && /retired strategy NY_ORB still trading/.test(texts),
     'new rows: a kill switch is an ALERT; an error row and a retired strategy trading are WARNs: ' + texts);
  W.ctx.__in.state = r.state;
  r = run();
  ok(r.level === 'OK', 'each row is reported once: the next check is OK again');
  W.ctx.__in.log = [row(60, 'GoldIntraday', 'ALL', 'START', 'XAUUSD.sml, fixed 0.010 lots a trade, demo account 1')];
  W.ctx.__in.log[0].time = new Date(Date.UTC(2026, 10, 6, 3)); W.ctx.__in.state = {};
  r = run();
  ok(r.problems.some(p => /GoldIntraday started without 0\.5% risk/.test(p.text)) && r.problems.some(p => /without the 15% account stop/.test(p.text)) &&
     !r.problems.some(p => /demo account/.test(p.text)), 'an EA restarted on the old settings is a WARN, and the START row (account number) is never copied');
  W.ctx.__in.log = okStarts; W.ctx.__in.state = {};
  W.ctx.__in.built = { trades: [0.9, 0.7, 0.8, 0.6, 0.75].map(x => ({ slip: x })), open: [{ strat: 'MOM_16', stop: null, slip: null }] };
  r = run();
  ok(r.problems.some(p => p.level === 'ALERT' && /MOM_16 position open without a stop/.test(p.text)) && r.problems.some(p => /slipped \$0\.75 on average over the last 5 fills/.test(p.text)),
     'a position without a stop is an ALERT; stop orders slipping $0.75 on average is a WARN');
  W.run('watchdogEnsure_(); watchdogEnsure_();');
  ok(W.run('ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === "runWatchdog").length') === 1, 'the watchdog installs its 15-minute timer once');
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'Main.js'), 'utf8');
  ok(mainSrc.split("!['runMorningMap', 'runWatchdog'].includes(t.getHandlerFunction())").length === 3,
     'setup() and switching the old system off both keep the watchdog timer');
  W.ctx.__in.built = { trades: [], open: [] };
  W.run('watchdogWrite_(watchdogCheck_(__in.now, __in.st, __in.log, __in.built, {}))');
  const wRows = rowsOf(W, 'MT5 Watchdog');
  ok(wRows[0] && wRows[0][0] === 'Now: OK' && wRows[3] && wRows[3][1] === 'OK', 'the MT5 Watchdog tab shows the status line and a history row');
}

section('Web app: Telegram messages');
const T = world({ markets: MARKETS });
const tg = (chat, text) => T.run('doPost(' + JSON.stringify({ postData: { contents: JSON.stringify(
  { update_id: Math.floor(Math.random() * 1e9), message: { text, chat: chat === undefined ? undefined : { id: chat } } }) } }) + ').getContent()');
tg('', 'forged, empty chat');
tg(undefined, 'forged, no chat');
ok(!T.props.TG_QUEUE, 'Telegram off (no chat ID set): forged updates, even with an empty chat ID, are ignored');
T.run('CONFIG.ALERTS.telegramChatId = "42"');
tg(43, 'a stranger');
ok(!T.props.TG_QUEUE, 'with a chat ID set, other chats are ignored');
tg(42, 'status please');
ok(/status please/.test(T.props.TG_QUEUE || ''), 'the owner\'s chat is queued for an answer');
const T2 = world({ markets: MARKETS, props: { TELEGRAM_CHAT_ID: '42' } });
T2.run('doPost(' + JSON.stringify({ postData: { contents: JSON.stringify({ update_id: 5, message: { text: 'a stranger again', chat: { id: 43 } } }) } }) + ')');
T2.run('doPost(' + JSON.stringify({ postData: { contents: JSON.stringify({ update_id: 6, message: { text: 'owner via property', chat: { id: 42 } } }) } }) + ')');
ok(/owner via property/.test(T2.props.TG_QUEUE || '') && !/a stranger again/.test(T2.props.TG_QUEUE || ''),
   'the chat ID saved by Connect Telegram (Script Property) is the owner too; other chats stay ignored');

section('Morning map (Telegram)');
const tgHello = [{ update_id: 1, message: { text: 'hi', chat: { id: 777, type: 'private', first_name: 'Owner' } } }];
const noBot = world({ markets: MARKETS, props: KEYS });
ok(/BotFather/.test(noBot.run('telegramConnect_().text')) && !noBot.props.TELEGRAM_CHAT_ID, 'without a bot token, Connect Telegram explains how to make one and saves nothing');
const MM = world({ markets: MARKETS, props: Object.assign({ TELEGRAM_BOT_TOKEN: 'tg', MT5_KEY: 'mk' }, KEYS), telegramUpdates: tgHello });
let wed = T0 + 140 * 24 * H;
while (new Date(wed).getUTCDay() !== 3) wed += 24 * H;
const wedMorning = wed + 23 * H + 30 * 60000;                  // Wednesday 23:30 UTC = Thursday 07:30 in Singapore
MM.setNow(wedMorning);
const conn = MM.run('telegramConnect_()');
ok(conn.ok && MM.props.TELEGRAM_CHAT_ID === '777' && MM.triggers.filter(t => t.getHandlerFunction() === 'runMorningMap').length === 1 &&
   MM.telegram.some(c => c.method === 'sendMessage' && String(c.payload.chat_id) === '777'),
   'Connect Telegram saves the chat ID from the message the owner sent, starts the 07:30 timer and confirms in the chat');
MM.run('telegramConnect_()');
ok(MM.triggers.filter(t => t.getHandlerFunction() === 'runMorningMap').length === 1, 'connecting again leaves one timer, not two');
const fmtServer = ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' ').replace(/-/g, '.');
MM.run("doPost({ postData: { contents: JSON.stringify({ source: 'mt5', key: 'mk', ea: 'GoldIntraday', from: 1, offset: 10800, equity: 10000, balance: 10000, " +
       "lines: ['" + fmtServer(wedMorning - 60 * 60000 + 3 * H) + ",ALL,DAY,10000.00,open 4065.660, daily ATR 72.670, Dual Thrust 4019.820-4111.500, yesterday H/L/C 1/2/3'] }) } })");
// The 07:30 timer now sends the MT5 daily report (owner, 6 Nov 2026); the map itself is still built and sent on demand.
const repBefore = MM.telegram.length;
MM.run('runMorningMap()');
const repMsg = MM.telegram.slice(repBefore).filter(c => c.method === 'sendMessage')[0];
ok(repMsg && String(repMsg.payload.chat_id) === '777' && /^<b>MT5 daily report<\/b>/.test(repMsg.payload.text) && /Status: <b>WARN<\/b>/.test(repMsg.payload.text) &&
   /Closed in the last 24 h: 0/.test(repMsg.payload.text) && /DonchianGold: no heartbeat on record/.test(repMsg.payload.text) && !/<pre>/.test(repMsg.payload.text),
   'on a weekday morning the 07:30 timer sends the MT5 daily report, not the map: status, trades, open positions, the watchdog\'s findings');
ok(MM.triggers.filter(t => t.getHandlerFunction() === 'runWatchdog').length === 1, 'and it installs the watchdog\'s timer');
const mmBefore = MM.telegram.length;
MM.run('morningMapRun_("777")');
const sent = MM.telegram.slice(mmBefore), msg = sent.filter(c => c.method === 'sendMessage')[0];
ok(msg && String(msg.payload.chat_id) === '777' && msg.payload.parse_mode === 'HTML' && /4-hour zones/.test(msg.payload.text) && /<pre>/.test(msg.payload.text),
   'on a weekday morning the map goes to the owner\'s chat: zones in a fixed-width block');
ok(msg && /buy stop 4111\.50, sell stop 4019\.82/.test(msg.payload.text), 'it carries today\'s Dual Thrust levels from the intraday EA\'s DAY line');
ok(msg && /MT5 not heard from: DonchianGold/.test(msg.payload.text) && !/GoldIntraday \(/.test(msg.payload.text),
   'it warns when an EA has gone quiet (here the H4 EA never reported) and not about the one that just did');
ok(msg && /not passed our backtests/.test(msg.payload.text), 'the zones are labelled as a map, not as signals');
const zoneRows = msg ? (/<pre>([\s\S]*)<\/pre>/.exec(msg.payload.text)[1].split('\n').filter(r => /DEMAND|SUPPLY/.test(r))) : [];
ok(zoneRows.length >= 1 && zoneRows.length <= 6 + 2, 'it lists the nearest zones only (' + zoneRows.length + ' rows)');
ok(!rowsOf(MM, 'Log').some(r => /ERROR/.test(r[1]) && /Morning/.test(r[2])), 'no errors logged (the picture is skipped where Google Charts is missing)');
let satDay = wed;
while (new Date(satDay).getUTCDay() !== 6) satDay += 24 * H;
MM.setNow(satDay + 23 * H + 30 * 60000);                          // Saturday 23:30 UTC = Sunday 07:30: gold closed
const satBefore = MM.telegram.length;
MM.run('morningMapRun_("777")');
ok(MM.telegram.length === satBefore, 'nothing is sent while gold is closed');
MM.run('runMorningMap()');
ok(MM.telegram.length === satBefore, 'no MT5 daily report on Sunday morning: Saturday was no trading day');
// Twelve Data also sends flat bars while gold is shut: pad the feed with them, as it does.
const padded = [];
MARKETS['XAU/USD'].forEach((k, i, a) => {
  padded.push(k);
  for (let t = k.t + H; a[i + 1] && t < a[i + 1].t; t += H) padded.push({ t, o: k.c, h: k.c, l: k.c, c: k.c, v: 0 });
});
const MF = world({ markets: Object.assign({}, MARKETS, { 'XAU/USD': padded }), props: Object.assign({ TELEGRAM_BOT_TOKEN: 'tg', TELEGRAM_CHAT_ID: '777' }, KEYS) });
MF.setNow(satDay + 23 * H + 30 * 60000);
MF.run('morningMapRun_("777")');
ok(MF.telegram.length === 0 && padded.length > MARKETS['XAU/USD'].length, 'flat weekend bars from Twelve Data do not count as trading: Saturday stays silent');
MF.setNow(wedMorning);
MM.setNow(wedMorning);
const last60 = w => JSON.stringify(JSON.parse(w.run('JSON.stringify(morningBuild_().c4.slice(-60))')).map(x => [x.b, x.o, x.h, x.l, x.c]));
const weekendCandles = JSON.parse(MF.run('JSON.stringify(morningBuild_().c4.filter(x => [0, 6].indexOf(new Date(x.b).getUTCDay()) !== -1).length)'));
ok(last60(MF) === last60(MM) && weekendCandles === 0, 'with the padded feed the 4-hour bars are the same as with a clean one, and none falls on a weekend');
ok(MM.run("morningServerMs_(Date.UTC(2026, 6, 1, 12)) - Date.UTC(2026, 6, 1, 12)") === 3 * H &&
   MM.run("morningServerMs_(Date.UTC(2026, 11, 1, 12)) - Date.UTC(2026, 11, 1, 12)") === 2 * H &&
   MM.run("morningServerMs_(Date.UTC(2026, 10, 1, 5, 59)) - Date.UTC(2026, 10, 1, 5, 59)") === 3 * H &&
   MM.run("morningServerMs_(Date.UTC(2026, 10, 1, 6, 0)) - Date.UTC(2026, 10, 1, 6, 0)") === 2 * H,
   'broker clock: UTC+3 in US summer time, UTC+2 from 02:00 New York time on 1 Nov 2026');
MM.setNow(wedMorning);
const c4 = JSON.parse(MM.run('JSON.stringify(morningH4_(twelveCandles_("XAU/USD", 60, 2000)).filter(x => x.done))'));
const research = require(path.join(__dirname, '..', 'research', 'sd_lab.js'));
const rz = research.orderBlocks(c4.map((k, i) => Object.assign({}, k, { last: i })), 3, 50).map(z => [z.side, z.near, z.far, z.formed]);
const az = JSON.parse(MM.run('JSON.stringify(morningOrderBlocks_(' + JSON.stringify(c4) + ', 3, 50))')).map(z => [z.side, z.near, z.far, z.at]);
ok(rz.length > 10 && JSON.stringify(rz) === JSON.stringify(az), 'the morning map finds the same order blocks as research/sd_lab.js (' + az.length + ' on test data)');
MM.ctx.__res = { problems: [{ level: 'ALERT', text: 'DonchianGold kill switch: account stop: equity 8500.00 is 15.0% below its peak', key: 'kill:1' }, { level: 'WARN', text: 'x', key: 'x' }], state: {} };
const alBefore = MM.telegram.length;
const al1 = MM.run('watchdogAlert_(__res, [])'), al2 = MM.run('watchdogAlert_(__res, __res.state.alerted)');
const alMsg = MM.telegram.slice(alBefore).filter(c => c.method === 'sendMessage');
ok(al1 === 1 && al2 === 0 && alMsg.length === 1 && /^MT5 ALERT/.test(alMsg[0].payload.text) && /account stop: equity 8500\.00/.test(alMsg[0].payload.text) &&
   /Nothing restarts until we decide together/.test(alMsg[0].payload.text) && !/\bx\b/.test(alMsg[0].payload.text.split('\n')[2] || ''),
   'an ALERT goes to Telegram once (not the WARNs), saying nothing restarts until the owner and Claude decide');
MM.run('morningMapOff()');
ok(MM.triggers.filter(t => t.getHandlerFunction() === 'runMorningMap').length === 0, 'Morning map: stop removes the timer');
const O3 = world({ markets: MARKETS, props: { MT5_KEY: 'mk' }, triggers: ['runMonitor', 'runMorningMap'] });
O3.run('oldSystemOff()');
ok(O3.triggers.length === 1 && O3.triggers[0].getHandlerFunction() === 'runMorningMap', 'switching the old system off keeps the morning map\'s timer');

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
    delete r.fixedFoldReturns;                                // new field; everything else must match
    return { r: JSON.stringify(r), sheet: JSON.stringify(w.sheets.BT_WalkForward.rows) };
  };
  const wNew = wfOf(undefined), wOld = wfOf(tmp);
  ok(wNew.r === wOld.r && wNew.sheet === wOld.sheet, 'live walk-forward (BTC history) identical to ' + ref + ', every fold');
}

console.log('\n' + (failures ? failures + ' FAILED' : 'ALL PASSED'));
process.exitCode = failures;
