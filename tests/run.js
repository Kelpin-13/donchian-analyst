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
ok(glanceRow('New York opening range')[2] === '22:00–01:00' && glanceRow('Momentum at 16:00')[2] === '21:00',
   'strategy times shown in the owner\'s clock (broker 17:00-20:00 → 22:00–01:00 at UTC+8)');
ok(cards === 7 && stratRows.some(r => r && /closed by 04:00 \(broker 23:00\)/.test(String(r[1]))), 'one card per strategy (7), with both clocks in the details');
ok(M.run('MT5_STRATEGIES').every(st => st.name && st.idea && st.entry && st.stop && st.exit && st.trades > 0 && st.eras.length === 3),
   'every strategy is fully described, with its 18-year record in three eras');
ok(glanceRow('New York opening range')[4] === '$20' && glanceRow('Dual Thrust')[4] === '$126' && glanceRow('Dual Thrust')[6] === 93 && glanceRow('Dual Thrust')[7] === '3 of 3',
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
const mmBefore = MM.telegram.length;
MM.run('runMorningMap()');
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
MM.run('runMorningMap()');
ok(MM.telegram.length === satBefore, 'nothing is sent while gold is closed');
// Twelve Data also sends flat bars while gold is shut: pad the feed with them, as it does.
const padded = [];
MARKETS['XAU/USD'].forEach((k, i, a) => {
  padded.push(k);
  for (let t = k.t + H; a[i + 1] && t < a[i + 1].t; t += H) padded.push({ t, o: k.c, h: k.c, l: k.c, c: k.c, v: 0 });
});
const MF = world({ markets: Object.assign({}, MARKETS, { 'XAU/USD': padded }), props: Object.assign({ TELEGRAM_BOT_TOKEN: 'tg', TELEGRAM_CHAT_ID: '777' }, KEYS) });
MF.setNow(satDay + 23 * H + 30 * 60000);
MF.run('runMorningMap()');
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
