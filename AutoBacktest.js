/**
 * AutoBacktest.gs — the whole backtest pipeline, on a schedule, with a memory.
 *
 * Every week (Sunday 09:00 Kuala Lumpur time by default) this:
 *   1. adds the newest bars to History
 *   2. runs the detailed backtest, sweep, walk-forward, Monte Carlo,
 *      and the paper-vs-backtest comparison
 *   3. scores the strategy against the decision rules from Part 4
 *   4. appends ONE row to the BT_Log sheet — which is never overwritten
 *   5. sends you a short summary by email / Telegram
 *
 * The BT_* sheets show the latest run in detail. BT_Log is the record over
 * time: if the verdict changes from week to week, you'll see exactly when.
 *
 * TradingView's Strategy Tester can't be automated (it has no API), so the
 * trade-by-trade TradingView comparison stays a manual job. The live
 * cross-check (Crosscheck sheet) is automatic once the alert exists.
 */

const BT_LOG_HEADERS = [
  'Run at', 'Verdict', 'Reasons', 'History bars', 'From (UTC)', 'To (UTC)',
  'Trades', 'Return %', 'Buy & hold %', 'CAGR %', 'Max DD %', 'Profit factor', 'Sharpe',
  'Win rate %', 'Avg R', 'Fees $',
  'Sweep: current %', 'Sweep: neighbours %', 'Plateau?',
  'WF folds', 'WF re-optimised %', 'WF fixed %', 'WF buy & hold %', 'WFE %',
  'MC 95th pct DD %', 'MC loss chance %',
  'Paper days', 'Paper trades', 'Paper return %', 'Same-period backtest %', 'Live decay pts',
  'Breakout', 'Stop x ATR', 'Fee %', 'Slippage %', 'Seconds', 'Errors', 'Promoted lab settings'
];

/** Apps Script stops a run at 6 minutes. Leave room to write the log row. */
const AUTO_BT_BUDGET_MS = 4.5 * 60 * 1000;

function runAutoBacktest() {
  const t0 = Date.now();
  const errors = [];
  const out = { history: null, m: null, sweep: null, wf: null, mc: null, live: null };

  const stage = (name, fn) => {
    if (Date.now() - t0 > AUTO_BT_BUDGET_MS) { errors.push(name + ': skipped, out of time'); return null; }
    try { return fn(); }
    catch (e) { errors.push(name + ': ' + e.message); logLine_('WARN', 'AutoBacktest ' + name + ': ' + e.message); return null; }
  };

  stage('history', () => { out.history = updateHistory(); });
  out.m     = stage('detailed', () => runDetailedBacktest());
  out.sweep = stage('sweep', () => runSweep());
  out.wf    = stage('walk-forward', () => runWalkForward());
  out.mc    = stage('monte-carlo', () => runMonteCarlo());
  out.live  = stage('paper-vs-backtest', () => compareLiveVsBacktest());

  const v = autoVerdict_(out);
  const m = out.m || {}, sw = out.sweep || {}, wf = out.wf || {}, mc = out.mc || {}, lv = out.live || {};
  const P = CONFIG.STRATEGY, B = CONFIG.BACKTEST;
  const n = x => (x === null || x === undefined || !isFinite(x)) ? '' : Math.round(x * 100) / 100;

  const row = [
    new Date(), v.verdict, v.reasons.join('; '),
    m.bars || '', m.fromUtc || '', m.toUtc || '',
    m.trades === undefined ? '' : m.trades, n(m.totalReturnPct), n(m.buyHoldPct), n(m.cagrPct),
    n(m.maxDrawdownPct), n(m.profitFactor), n(m.sharpe), n(m.winRatePct), n(m.avgR), n(m.totalFeesUSD),
    n(sw.current), n(sw.neighbours), sw.plateau === null || sw.plateau === undefined ? '' : (sw.plateau ? 'plateau' : 'SPIKE'),
    wf.folds || '', n(wf.oosReturnPct), n(wf.fixedReturnPct), n(wf.buyHoldPct), n(wf.wfePct),
    n(mc.dd95), n(mc.lossChancePct),
    n(lv.days), lv.paperTrades === undefined ? '' : lv.paperTrades, n(lv.paperReturnPct), n(lv.btReturnPct), n(lv.decayPts),
    P.breakoutLookback, P.stopAtrMult, B.feePct, B.slippagePct,
    Math.round((Date.now() - t0) / 1000), errors.join('; '),
    PropertiesService.getScriptProperties().getProperty('LIVE_STRATEGY') || ''
  ];

  const s = sheet_('BT_Log', BT_LOG_HEADERS);
  if (s.getLastColumn() < BT_LOG_HEADERS.length) {       // sheet made by an older version
    s.getRange(1, 1, 1, BT_LOG_HEADERS.length).setValues([BT_LOG_HEADERS]).setFontWeight('bold');
  }
  s.appendRow(row);
  colourVerdict_(s, s.getLastRow(), v.verdict);

  sendAlert_('🧪 Weekly backtest — ' + v.verdict + '\n\n' +
    (m.trades !== undefined
      ? m.trades + ' trades over ' + n(m.years) + ' yrs | return ' + n(m.totalReturnPct) + '% vs buy & hold ' +
        n(m.buyHoldPct) + '% | max DD ' + n(m.maxDrawdownPct) + '% | PF ' + n(m.profitFactor) + '\n'
      : '') +
    (wf.folds ? 'Walk-forward: unseen-data return ' + n(wf.fixedReturnPct) + '% (fixed settings), WFE ' + n(wf.wfePct) + '%\n' : '') +
    (mc.dd95 !== undefined ? 'Plan for a drawdown of ~' + n(mc.dd95) + '% (95th pct)\n' : '') +
    (lv.days ? 'Paper: ' + lv.paperTrades + ' trades, ' + n(lv.paperReturnPct) + '% in ' + n(lv.days) + ' days\n' : '') +
    '\nWhy: ' + v.reasons.join('; ') +
    (errors.length ? '\n\nProblems: ' + errors.join('; ') : '') +
    '\n\nFull history of results: BT_Log sheet.');

  // Weekly: let Claude suggest the next experiments (they wait for your approval).
  if (CONFIG.LAB && CONFIG.LAB.proposeWithClaude && Date.now() - t0 < AUTO_BT_BUDGET_MS) {
    try { labProposeWithClaude(); } catch (e) { logLine_('WARN', 'Lab proposals: ' + e.message); }
  }

  Logger.log('Auto backtest: %s — %s (%ss)', v.verdict, v.reasons.join('; '), Math.round((Date.now() - t0) / 1000));
  return v;
}

/**
 * The Part 4 decision table, applied automatically. Thresholds are rules of
 * thumb and live in CONFIG.BACKTEST so you can set your own — but set them
 * BEFORE looking at results, not after.
 */
function autoVerdict_(o) {
  const B = CONFIG.BACKTEST;
  const fails = [], warns = [], waits = [], goods = [];
  const m = o.m, sw = o.sweep, wf = o.wf, mc = o.mc;

  if (!m) { return { verdict: 'ERROR', reasons: ['detailed backtest did not run'] }; }

  if (m.years < B.minYearsHistory) waits.push('only ' + m.years.toFixed(1) + ' years of history');
  if (m.trades < B.minTrades) waits.push('only ' + m.trades + ' trades (need ' + B.minTrades + ')');

  if (m.profitFactor !== null && m.profitFactor < 1) fails.push('loses money after costs (PF ' + m.profitFactor.toFixed(2) + ')');
  else if (m.profitFactor !== null) goods.push('PF ' + (m.profitFactor === Infinity ? '∞' : m.profitFactor.toFixed(2)));

  if (m.totalReturnPct < m.buyHoldPct && (m.marRatio === null || m.marRatio < 0.5)) {
    warns.push('trails buy & hold without a strong risk-adjusted edge');
  }

  if (sw && sw.plateau === false) warns.push('current setting is a spike in the sweep');

  if (wf) {
    if (wf.fixedReturnPct < 0) fails.push('loses money on unseen data (walk-forward)');
    if (wf.wfePct !== null && wf.wfePct < B.minWfePct) fails.push('walk-forward efficiency ' + Math.round(wf.wfePct) + '% — likely curve-fit');
    if (wf.fixedReturnPct >= 0 && (wf.wfePct === null || wf.wfePct >= B.minWfePct)) goods.push('holds up on unseen data');
  } else {
    waits.push('walk-forward did not run');
  }

  if (mc && mc.dd95 > B.maxTolerableDrawdownPct) {
    warns.push('95th pct drawdown ' + Math.round(mc.dd95) + '% exceeds your ' + B.maxTolerableDrawdownPct + '% limit — lower risk per trade');
  }

  let verdict;
  if (fails.length) verdict = 'FAILS';
  else if (waits.length) verdict = 'CAN\'T JUDGE YET';
  else if (warns.length) verdict = 'PASSES WITH WARNINGS';
  else verdict = 'PASSES SO FAR';

  const reasons = fails.concat(waits, warns);
  if (!reasons.length) reasons.push(goods.join(', ') || 'all checks passed');
  return { verdict: verdict, reasons: reasons };
}

function colourVerdict_(s, row, verdict) {
  const colour = { 'FAILS': '#F2C4C4', 'CAN\'T JUDGE YET': '#E8E8E8',
                   'PASSES WITH WARNINGS': '#F7E3B5', 'PASSES SO FAR': '#C9E4D4', 'ERROR': '#F2C4C4' }[verdict];
  if (colour) s.getRange(row, 2).setBackground(colour).setFontWeight('bold');
}