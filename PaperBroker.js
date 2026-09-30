/**
 * PaperBroker.gs — a live, simulated trading account.
 *
 * The backtest tells you what WOULD have happened. The paper account tells
 * you what IS happening, at real prices, in real time, with real costs —
 * without real money. Every signal from runMonitor() becomes a paper order
 * filled at the live ticker price plus slippage, minus a fee.
 *
 * After a few months, compare the paper account to the backtest over the
 * same period. The gap between them is your "live decay": slippage you
 * under-estimated, signals that fired at awkward times, data differences.
 * Every live system has some. Knowing yours is worth more than the backtest.
 *
 * Sheets: PaperTrades (fills), Equity (one snapshot per closed bar).
 */

const PAPER_TRADE_HEADERS = ['Time', 'Side', 'Signal', 'SignalBar', 'SignalPrice', 'FillPrice',
  'SlippageCost$', 'Units', 'Notional$', 'Fee$', 'Cash$', 'Equity$', 'P&L$', 'P&L%acct', 'Note'];
const EQUITY_HEADERS = ['Time', 'BarTime', 'Price', 'Cash$', 'PositionValue$', 'Equity$', 'Return%', 'Drawdown%', 'Position'];

/**
 * A "book" is one paper account: where its state and rows live. The live
 * strategy uses LIVE_BOOK (the default everywhere); the challenger has its own.
 */
const LIVE_BOOK = { stateKey: 'PAPER_STATE', tradesSheet: 'PaperTrades', equitySheet: 'Equity' };

function getPaper_(book) {
  const raw = PropertiesService.getScriptProperties().getProperty((book || LIVE_BOOK).stateKey);
  if (raw) return JSON.parse(raw);
  const start = CONFIG.PAPER.startingEquityUSD;
  return { cash: start, units: 0, entryFill: null, entryTime: null, entryCost: 0, entryFee: 0,
           equityAtEntry: null, peakEquity: start, feesPaid: 0, realizedPnl: 0,
           trades: 0, wins: 0, lastSnapshotBar: 0, startedAt: Date.now() };
}

function setPaper_(p, book) {
  PropertiesService.getScriptProperties().setProperty((book || LIVE_BOOK).stateKey, JSON.stringify(p));
}

/** Wipe the paper account. Menu-safe name (no trailing underscore). */
function resetPaperAccount() {
  PropertiesService.getScriptProperties().deleteProperty('PAPER_STATE');
  logLine_('INFO', 'Paper account reset to $' + CONFIG.PAPER.startingEquityUSD);
}

/**
 * Called by runMonitor() whenever the rules engine produces a signal.
 * `sig` is the object from decideAtBar_(). `book` and `riskPct` are only
 * passed by the challenger; the live account uses the defaults.
 */
function paperOnSignal_(sig, book, riskPct) {
  if (!CONFIG.PAPER.enabled) return null;
  const P = CONFIG.PAPER;
  const acct = getPaper_(book);
  const s = sheet_((book || LIVE_BOOK).tradesSheet, PAPER_TRADE_HEADERS);
  const risk = riskPct === undefined ? CONFIG.STRATEGY.riskPerTradePct : riskPct;

  let live;
  try { live = fetchTickerPrice_(); }
  catch (e) {
    live = sig.price;
    logLine_('WARN', 'Ticker fetch failed, paper fill uses signal close: ' + e.message);
  }

  const fee = P.feePct / 100, slip = P.slippagePct / 100;

  if (sig.type === 'ENTRY_LONG') {
    if (acct.units > 0) { logLine_('WARN', 'Paper: entry ignored, already long'); return null; }

    const fill = live * (1 + slip);
    const equity = acct.cash;
    const riskBudget = equity * (risk / 100);
    const perUnitRisk = fill - sig.stop;
    const byRisk = perUnitRisk > 0 ? riskBudget / perUnitRisk : 0;
    const byCap = equity * (P.maxExposurePct / 100) / fill;
    const byCash = acct.cash / (fill * (1 + fee));
    const units = Math.max(0, Math.min(byRisk, byCap, byCash));

    if (units <= 0) {
      s.appendRow([new Date(), 'BUY', sig.type, new Date(sig.barTime), sig.price, fill, 0, 0, 0, 0,
                   acct.cash, acct.cash, '', '', 'Skipped: price already at or below stop']);
      return null;
    }

    const notional = units * fill;
    const feeAmt = notional * fee;
    acct.cash -= notional + feeAmt;
    acct.units = units;
    acct.entryFill = fill;
    acct.entryTime = Date.now();
    acct.entryCost = notional;
    acct.entryFee = feeAmt;
    acct.equityAtEntry = equity;
    acct.feesPaid += feeAmt;

    s.appendRow([new Date(), 'BUY', sig.type, new Date(sig.barTime), sig.price, round_(fill),
                 round_((fill - live) * units), round_(units * 1e6) / 1e6, round_(notional), round_(feeAmt),
                 round_(acct.cash), round_(acct.cash + units * live), '', '',
                 'Stop ' + round_(sig.stop) + ', risking $' + round_(riskBudget)]);
    setPaper_(acct, book);
    return { side: 'BUY', fill: fill, units: units };
  }

  // Any EXIT_* signal
  if (acct.units <= 0) { logLine_('WARN', 'Paper: exit ignored, no position'); return null; }

  const fill = live * (1 - slip);
  const proceeds = acct.units * fill;
  const feeAmt = proceeds * fee;
  const pnl = (proceeds - feeAmt) - (acct.entryCost + acct.entryFee);

  acct.cash += proceeds - feeAmt;
  acct.feesPaid += feeAmt;
  acct.realizedPnl += pnl;
  acct.trades++;
  if (pnl > 0) acct.wins++;

  s.appendRow([new Date(), 'SELL', sig.type, new Date(sig.barTime), sig.price, round_(fill),
               round_((live - fill) * acct.units), round_(acct.units * 1e6) / 1e6, round_(proceeds), round_(feeAmt),
               round_(acct.cash), round_(acct.cash), round_(pnl),
               round_(pnl / acct.equityAtEntry * 100), 'Held ' + sig.barsHeld + ' bars']);

  acct.units = 0; acct.entryFill = null; acct.entryTime = null;
  acct.entryCost = 0; acct.entryFee = 0; acct.equityAtEntry = null;
  if (acct.cash > acct.peakEquity) acct.peakEquity = acct.cash;
  setPaper_(acct, book);
  return { side: 'SELL', fill: fill, pnl: pnl };
}

/** One equity row per closed bar. Called at the end of each runMonitor bar. */
function paperSnapshot_(barTime, price, book) {
  if (!CONFIG.PAPER.enabled) return;
  const acct = getPaper_(book);
  if (barTime <= acct.lastSnapshotBar) return;

  const posVal = acct.units * price;
  const equity = acct.cash + posVal;
  if (equity > acct.peakEquity) acct.peakEquity = equity;
  const dd = (acct.peakEquity - equity) / acct.peakEquity * 100;

  sheet_((book || LIVE_BOOK).equitySheet, EQUITY_HEADERS).appendRow([
    new Date(), new Date(barTime), round_(price), round_(acct.cash), round_(posVal), round_(equity),
    round_((equity / CONFIG.PAPER.startingEquityUSD - 1) * 100), round_(-dd),
    acct.units > 0 ? 'LONG' : 'FLAT'
  ]);

  acct.lastSnapshotBar = barTime;
  setPaper_(acct, book);
}

/** Current account view, used by the dashboard and the menu. */
function paperStatus_(livePrice, book) {
  const a = getPaper_(book);
  const price = livePrice || (a.units > 0 ? a.entryFill : 0);
  const posVal = a.units * price;
  const equity = a.cash + posVal;
  return {
    startingEquity: CONFIG.PAPER.startingEquityUSD,
    cash: a.cash,
    units: a.units,
    positionValue: posVal,
    equity: equity,
    returnPct: (equity / CONFIG.PAPER.startingEquityUSD - 1) * 100,
    openPnl: a.units > 0 ? posVal - a.entryCost - a.entryFee : 0,
    entryFill: a.entryFill,
    feesPaid: a.feesPaid,
    realizedPnl: a.realizedPnl,
    trades: a.trades,
    winRate: a.trades ? a.wins / a.trades * 100 : null,
    drawdownPct: a.peakEquity > 0 ? Math.max(0, (a.peakEquity - equity) / a.peakEquity * 100) : 0,
    startedAt: a.startedAt
  };
}

function showPaperAccount() {
  let price = null;
  try { price = fetchTickerPrice_(); } catch (e) {}
  const s = paperStatus_(price);
  const msg = 'Equity $' + round_(s.equity) + ' (' + round_(s.returnPct) + '% since start)\n' +
    'Cash $' + round_(s.cash) + '\n' +
    'Position ' + (s.units > 0 ? round_(s.units * 1e6) / 1e6 + ' units, open P&L $' + round_(s.openPnl) : 'none') + '\n' +
    'Fees paid $' + round_(s.feesPaid) + '\n' +
    s.trades + ' closed trades' + (s.winRate === null ? '' : ', ' + round_(s.winRate) + '% won');
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert('Paper account', msg, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) {}
}