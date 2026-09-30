/**
 * Challenger.gs — a second paper account for a different rule setting.
 *
 * Why: one month of live results says little about a strategy, but running
 * two settings side by side over the SAME month at least compares them under
 * the same market. The live strategy is untouched: the challenger has its own
 * position state (CH_STATE), its own paper book (CH_PAPER_STATE, Ch_Trades,
 * Ch_Equity) and its own trigger.
 *
 * Same rules, different inputs: it calls decideAtBar_() with
 * CONFIG.STRATEGY + CONFIG.CHALLENGER.overrides on CONFIG.CHALLENGER.intervalMinutes
 * candles. No second copy of the rules exists. No agent notes, no AI gate,
 * no alerts — it only trades paper and logs.
 *
 * Making the challenger the live strategy is the owner's decision, after the
 * comparison, and should go through a backtest on full history first.
 */

const CHALLENGER_BOOK = { stateKey: 'CH_PAPER_STATE', tradesSheet: 'Ch_Trades', equitySheet: 'Ch_Equity' };

function challengerParams_() {
  return Object.assign({}, CONFIG.STRATEGY, CONFIG.CHALLENGER.overrides || {});
}

/** Closed Coinbase candles at any interval, newest last. Same rules as fetchCoinbase_(). */
function fetchCandlesAt_(intervalMinutes, count, params) {
  if (CONFIG.MARKET.provider !== 'coinbase') throw new Error('The challenger needs MARKET.provider = "coinbase"');
  const gran = coinbaseBaseGran_(intervalMinutes);
  const size = intervalMinutes * 60 * 1000;
  const endMs = Date.now();
  const startMs = Math.floor((endMs - (count + 2) * size) / size) * size;   // bucket-aligned start

  const raw = fetchCoinbaseRange_(CONFIG.MARKET.symbol, gran, startMs, endMs);
  const candles = ((gran === intervalMinutes * 60) ? raw : aggregateCandles_(raw, intervalMinutes))
    .filter(k => Number.isFinite(k.c) && k.c > 0 && k.t + size <= Date.now())   // closed bars only
    .sort((a, b) => a.t - b.t)
    .slice(-count);

  const need = params.trendEmaPeriod + params.breakoutLookback + 5;
  if (candles.length < need) throw new Error('Challenger: only ' + candles.length + ' closed candles, need ' + need);
  return candles;
}

function getChState_() {
  const raw = PropertiesService.getScriptProperties().getProperty('CH_STATE');
  if (raw) return JSON.parse(raw);
  const s = freshState_();
  s.lastBarProcessed = 0;
  return s;
}

function setChState_(s) {
  PropertiesService.getScriptProperties().setProperty('CH_STATE', JSON.stringify(s));
}

/** On the first run, remember where the live account and BTC stood, so both start level. */
function challengerStart_(price) {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('CH_START')) return;
  props.setProperty('CH_START', JSON.stringify({
    at: Date.now(), btc: price, liveEquity: paperStatus_(price).equity
  }));
  logLine_('INFO', 'Challenger started: ' + CONFIG.CHALLENGER.name + ', BTC ' + round_(price));
}

/** Trigger: every 15 min. Acts once per closed challenger candle. */
function runChallenger() {
  const C = CONFIG.CHALLENGER;
  if (!C || !C.enabled) return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;   // the live monitor is running; try again next time

  try {
    const ivMs = C.intervalMinutes * 60 * 1000;
    const state = getChState_();
    if (state.lastBarProcessed && Date.now() < state.lastBarProcessed + 2 * ivMs) return;   // no new bar yet

    const P = challengerParams_();
    const candles = fetchCandlesAt_(C.intervalMinutes, C.candlesToFetch, P);
    const i = candles.length - 1;
    const last = candles[i];
    if (last.t <= state.lastBarProcessed) return;

    challengerStart_(last.c);
    const series = computeSeries_(candles, P);
    if (state.position === 'LONG') state.barsInTrade++;

    const sig = decideAtBar_(candles, series, i, state, P);
    if (sig) applySignal_(state, sig);
    state.lastBarProcessed = last.t;
    setChState_(state);   // commit before the paper fill, same order as the live monitor

    if (sig) {
      logLine_('SIGNAL', 'CHALLENGER ' + sig.type + ' @ ' + round_(sig.price));
      paperOnSignal_(sig, CHALLENGER_BOOK, P.riskPerTradePct);
    }
    paperSnapshot_(last.t, last.c, CHALLENGER_BOOK);
  } catch (e) {
    logLine_('ERROR', 'runChallenger: ' + e.message);
    throw e;
  } finally {
    lock.releaseLock();
  }
}

/** Both accounts measured from the challenger's start, plus buy & hold. */
function challengerCompare_(price) {
  const C = CONFIG.CHALLENGER;
  const raw = PropertiesService.getScriptProperties().getProperty('CH_START');
  if (!C || !C.enabled || !raw) return null;
  const start = JSON.parse(raw);
  const px = price || start.btc;
  const live = paperStatus_(px);
  const ch = paperStatus_(px, CHALLENGER_BOOK);
  const chState = getChState_();
  return {
    name: C.name,
    days: (Date.now() - start.at) / 86400000,
    startedAt: start.at,
    live: {
      label: 'Current (' + CONFIG.MARKET.intervalMinutes / 60 + 'h, ' +
             CONFIG.STRATEGY.breakoutLookback + '/' + CONFIG.STRATEGY.exitLookback + ')',
      returnPct: start.liveEquity ? (live.equity / start.liveEquity - 1) * 100 : null,
      position: getState_().position
    },
    challenger: {
      label: 'Challenger (' + C.name + ')',
      returnPct: ch.returnPct, equity: ch.equity, trades: ch.trades, winRate: ch.winRate,
      drawdownPct: ch.drawdownPct, fees: ch.feesPaid, position: chState.position
    },
    buyHoldPct: start.btc ? (px / start.btc - 1) * 100 : null
  };
}

/** Menu: Live → Challenger vs current. */
function showChallengerReport() {
  let price = null;
  try { price = fetchTickerPrice_(); } catch (e) {}
  const r = challengerCompare_(price);
  const pctStr = v => v === null || v === undefined ? '—' : (v >= 0 ? '+' : '') + round_(v) + '%';
  const msg = !r
    ? 'The challenger hasn\'t run yet. Run setup() once to install its trigger (or run runChallenger by hand).'
    : 'Running for ' + round_(r.days) + ' days, since ' +
      Utilities.formatDate(new Date(r.startedAt), CONFIG.TZ, 'dd MMM yyyy HH:mm') + '\n\n' +
      r.live.label + ': ' + pctStr(r.live.returnPct) + '  (now ' + r.live.position + ')\n' +
      r.challenger.label + ': ' + pctStr(r.challenger.returnPct) + '  (now ' + r.challenger.position + ')\n' +
      '   ' + r.challenger.trades + ' closed trades' +
      (r.challenger.winRate === null ? '' : ', ' + round_(r.challenger.winRate) + '% won') +
      ', worst drop ' + round_(r.challenger.drawdownPct) + '%, fees $' + round_(r.challenger.fees) + '\n' +
      'Buy & hold BTC: ' + pctStr(r.buyHoldPct) + '\n\n' +
      'One month is a small sample: a single trend (or its absence) decides it. ' +
      'Before switching, backtest the challenger on full history.';
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert('Challenger vs current', msg, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) {}
}

/** Menu: Reset → Challenger. Starts the comparison over. */
function resetChallenger() {
  const p = PropertiesService.getScriptProperties();
  ['CH_STATE', 'CH_PAPER_STATE', 'CH_START'].forEach(k => p.deleteProperty(k));
  logLine_('INFO', 'Challenger reset');
}
