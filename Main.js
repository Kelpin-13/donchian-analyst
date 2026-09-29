/**
 * Main.gs — entry points and orchestration.
 *
 * THIS BOT PLACES NO ORDERS. It has no exchange keys and no trade endpoint.
 * It watches, it reasons, it journals, it grades itself. Any real order is
 * something you place yourself, deliberately, after reading the note.
 */

/** ---------- ONE-TIME SETUP ---------- */
function setup() {
  ensureSheets_();

  // Clear any old triggers from this project first.
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));

  // Monitor: every 15 min. ~96 runs/day at ~3s each = ~5 min of the 90 min quota.
  ScriptApp.newTrigger('runMonitor').timeBased().everyMinutes(15).create();

  // Daily regime brief.
  ScriptApp.newTrigger('runDailyBrief').timeBased()
    .atHour(CONFIG.ANALYST.dailyBriefHour).everyDays(1)
    .inTimezone(CONFIG.TZ).create();

  // Daily grading pass, a few hours later so notes have settled.
  ScriptApp.newTrigger('runGrader').timeBased()
    .atHour((CONFIG.ANALYST.dailyBriefHour + 3) % 24).everyDays(1)
    .inTimezone(CONFIG.TZ).create();

  // Weekly automatic backtest, logged to BT_Log.
  if (CONFIG.BACKTEST.autoEnabled) {
    ScriptApp.newTrigger('runAutoBacktest').timeBased()
      .onWeekDay(ScriptApp.WeekDay[CONFIG.BACKTEST.autoWeekday])
      .atHour(CONFIG.BACKTEST.autoHour)
      .inTimezone(CONFIG.TZ).create();
  }

  // Nightly research lab: runs whatever is QUEUED in Lab_Queue.
  if (CONFIG.LAB.autoEnabled) {
    ScriptApp.newTrigger('runLab').timeBased()
      .atHour(CONFIG.LAB.runHour).everyDays(1)
      .inTimezone(CONFIG.TZ).create();
  }

  logLine_('INFO', 'Setup complete. Triggers installed.');
  Logger.log('Setup done. Now run testFeed(), then backtest(), before trusting anything.');
}

/** ---------- THE MONITOR LOOP ---------- */
function runMonitor() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;   // a previous run is still going

  try {
    const props = PropertiesService.getScriptProperties();
    props.setProperty('LAST_MONITOR_RUN', String(Date.now()));

    // Cheap early exit: if the next candle can't have closed yet, don't even
    // fetch. Cuts API calls from ~96/day to ~6/day on 4h candles.
    const ivMs = CONFIG.MARKET.intervalMinutes * 60 * 1000;
    const pre = getState_();
    if (pre.lastBarProcessed && Date.now() < pre.lastBarProcessed + 2 * ivMs) return;

    const candles = fetchCandles_();
    const last = candles[candles.length - 1];
    const state = getState_();

    // Only act once per closed candle. This is the guard that stops the bot
    // firing the same signal every 15 minutes.
    if (last.t <= state.lastBarProcessed) return;

    const series = computeSeries_(candles);
    const i = candles.length - 1;

    if (state.position === 'LONG') state.barsInTrade++;

    const sig = decideAtBar_(candles, series, i, state);
    const before = {                     // position BEFORE this bar's signal, for the AI gate
      position: state.position, entryPrice: state.entryPrice, stop: state.stop,
      barsInTrade: state.barsInTrade, entryTime: state.entryTime
    };

    if (sig) {
      // 1. Commit the decision FIRST. If anything below crashes, the next
      //    run won't re-fire the same signal.
      applySignal_(state, sig);
      state.lastBarProcessed = last.t;
      setState_(state);
      logLine_('SIGNAL', sig.type + ' @ ' + sig.price);

      // 2. Fast, time-sensitive steps: record for the TradingView cross-check,
      //    and fill the paper order at the live price before it drifts.
      recordCrosscheck_('APPS_SCRIPT', sig.type, sig.barTime, sig.price, '');
      paperOnSignal_(sig);

      // 3. Slow steps last. The AI gate is shadow-only: it logs a verdict and
      //    changes nothing above. Then the agent writes its note (falls back
      //    to the one-shot analyst by itself if it errors).
      let gateLine = '';
      if (sig.type === 'ENTRY_LONG') gateLine = gateOnBar_(candles, series, i, before, sig, sig.barTime);
      else gateCloseTrade_(before.entryTime, sig.rMultiple);

      const ctx = marketContext_(candles, series, i);
      const note = sig.type === 'ENTRY_LONG'
        ? agentPreTradeNote_(sig, ctx)
        : { setup: sig.reason, invalidation: '', watch: '', confidence: 'n/a' };

      appendSignal_(sig, note);
      sendAlert_(formatAlert_(sig, note, ctx) + gateLine);
    } else {
      state.lastBarProcessed = last.t;
      setState_(state);
      if (state.position === 'LONG') gateOnBar_(candles, series, i, before, null, before.entryTime);
    }

    paperSnapshot_(last.t, last.c);

  } catch (e) {
    logLine_('ERROR', 'runMonitor: ' + e.message);
    throw e;   // surface it in the Apps Script executions dashboard too
  } finally {
    lock.releaseLock();
  }
}

/** ---------- DAILY REGIME BRIEF ---------- */
function runDailyBrief() {
  try {
    const candles = fetchCandles_();
    const series = computeSeries_(candles);
    const ctx = marketContext_(candles, series, candles.length - 1);
    const state = getState_();
    const brief = writeRegimeBrief_(candles, series);

    appendRegime_(brief, ctx, state.position);
    sendAlert_(
      '📊 ' + CONFIG.MARKET.symbol + ' daily brief — ' + brief.regime + '\n\n' +
      brief.summary + '\n\nFit: ' + brief.strategyFit +
      '\nRisk: ' + brief.riskNote +
      '\n\nPosition: ' + state.position +
      (state.position === 'LONG'
        ? ' (entry ' + round_(state.entryPrice) + ', stop ' + round_(state.stop) + ')'
        : '')
    );
  } catch (e) {
    logLine_('ERROR', 'runDailyBrief: ' + e.message);
  }
}

/** ---------- DAILY GRADING PASS ---------- */
function runGrader() {
  try {
    gradePendingSignals_();
    reconcileCrosscheck_();
  } catch (e) {
    logLine_('ERROR', 'runGrader: ' + e.message);
  }
}

/** ---------- ALERTS ---------- */
function formatAlert_(sig, note, ctx) {
  const head = sig.type === 'ENTRY_LONG' ? '🟢 ENTRY SIGNAL' : '🔴 EXIT SIGNAL';
  let msg = head + ' — ' + CONFIG.MARKET.symbol + ' @ ' + round_(sig.price) + '\n\n' +
            'Rule: ' + sig.reason + '\n';

  if (sig.type === 'ENTRY_LONG') {
    msg += 'Stop: ' + round_(sig.stop) + '  (' + round_(pctChange_(sig.price, sig.stop)) + '%)\n' +
           'Paper size: ' + sig.units.toFixed(5) + ' units @ ' +
           CONFIG.STRATEGY.riskPerTradePct + '% risk\n\n' +
           'Setup: ' + note.setup + '\n' +
           'Invalidation: ' + note.invalidation + '\n' +
           'Watch: ' + note.watch + '\n' +
           'Pattern match: ' + note.confidence + '\n';
  } else {
    msg += 'P&L: ' + round_(sig.pnlPct) + '%  (' + round_(sig.rMultiple) + 'R) over ' +
           sig.barsHeld + ' bars\n';
  }

  msg += '\nATR ' + ctx.atrPctOfPrice + '% of price | vol ' + ctx.annualisedVolPct + '% ann.' +
         '\n\nNo order was placed. This is a research note.';
  return msg;
}

function sendAlert_(text) {
  if (CONFIG.ALERTS.email) {
    try {
      MailApp.sendEmail(CONFIG.ALERTS.email,
        CONFIG.MARKET.symbol + ' — trading agent', text);
    } catch (e) {
      logLine_('ERROR', 'email: ' + e.message);
    }
  }

  if (CONFIG.ALERTS.telegramChatId) {
    try {
      const token = secret_('TELEGRAM_BOT_TOKEN', true);
      UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
        method: 'post',
        muteHttpExceptions: true,
        payload: { chat_id: CONFIG.ALERTS.telegramChatId, text: text }
      });
    } catch (e) {
      logLine_('ERROR', 'telegram: ' + e.message);
    }
  }
}

/** ---------- SHEET MENU ---------- */
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('Trading Agent')
    .addItem('Check installation', 'checkInstall')
    .addSeparator()
    .addItem('Test data feed', 'testFeed')
    .addItem('Test live price', 'testTicker')
    .addItem('Dump indicators to Debug sheet', 'dumpIndicators')
    .addSeparator()
    .addSubMenu(ui.createMenu('Backtesting')
      .addItem('1. Build history (Coinbase)', 'buildHistory')
      .addItem('1b. Import TradingView CSV (TV_Import sheet)', 'importTradingViewCsv')
      .addSeparator()
      .addItem('Quick backtest (no costs)', 'backtest')
      .addItem('2. Detailed backtest', 'runDetailedBacktest')
      .addItem('3. Parameter sweep', 'runSweep')
      .addItem('4. Walk-forward test', 'runWalkForward')
      .addItem('5. Monte Carlo', 'runMonteCarlo')
      .addItem('6. Compare with TradingView trades', 'compareTvTrades')
      .addItem('7. Paper account vs backtest (live decay)', 'compareLiveVsBacktest')
      .addSeparator()
      .addItem('Update history (new bars only)', 'updateHistory')
      .addItem('Run the full automatic backtest now', 'runAutoBacktest'))
    .addSubMenu(ui.createMenu('Lab')
      .addItem('Add starter experiments', 'labSeedExperiments')
      .addItem('Run queued experiments now', 'runLab')
      .addItem('Ask Claude to propose experiments', 'labProposeWithClaude')
      .addSeparator()
      .addItem('Promote an experiment (holdout test)', 'labPromote')
      .addItem('Show live strategy', 'labShowLive')
      .addItem('Revert to Config.gs defaults', 'labRevert'))
    .addSubMenu(ui.createMenu('Live')
      .addItem('Check now (manual)', 'runMonitor')
      .addItem('Daily brief now', 'runDailyBrief')
      .addItem('Grade pending signals', 'runGrader')
      .addItem('Ask the agent', 'askAgentPrompt')
      .addItem('Show paper account', 'showPaperAccount')
      .addItem('AI gate report (shadow)', 'showGateReport')
      .addItem('Show dashboard URL', 'showDashboardUrl'))
    .addSubMenu(ui.createMenu('TradingView')
      .addItem('Send a test webhook', 'testTradingViewWebhook'))
    .addSeparator()
    .addItem('Show scorecard', 'showScorecard')
    .addSubMenu(ui.createMenu('Reset')
      .addItem('Reset position state', 'resetBotState')
      .addItem('Reset paper account', 'resetPaperAccount'))
    .addToUi();
}

/**
 * Menu-callable wrapper. Apps Script menus can't call functions whose names
 * end in an underscore (those are private), so the menu needs this.
 */
function resetBotState() {
  resetState_();
  logLine_('INFO', 'Position state reset to FLAT');
}

/**
 * Write the last 60 bars with their indicator values to a Debug sheet, so you
 * can verify the math by hand in Sheets. Do this once before trusting signals.
 *
 *   Chan20High on row N should equal MAX() of the 20 High values ABOVE it,
 *   not including its own. If it includes its own, you have look-ahead bias.
 */
function dumpIndicators() {
  const candles = fetchCandles_();
  const series = computeSeries_(candles);
  const rows = [['Time', 'Open', 'High', 'Low', 'Close',
                 'EMA' + CONFIG.STRATEGY.trendEmaPeriod,
                 'ATR' + CONFIG.STRATEGY.atrPeriod,
                 'Chan' + CONFIG.STRATEGY.breakoutLookback + 'High',
                 'Chan' + CONFIG.STRATEGY.exitLookback + 'Low']];

  for (let i = Math.max(0, candles.length - 60); i < candles.length; i++) {
    const k = candles[i];
    rows.push([
      Utilities.formatDate(new Date(k.t), CONFIG.TZ, 'yyyy-MM-dd HH:mm'),
      k.o, k.h, k.l, k.c,
      series.ema[i], series.atr[i],
      series.entry.upper[i], series.exit.lower[i]
    ]);
  }

  const s = sheet_('Debug', null);
  s.clear();
  s.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
  s.getRange(1, 1, 1, rows[0].length).setFontWeight('bold');
  Logger.log('Wrote %s rows to the Debug sheet.', rows.length - 1);
}

/** Dry run: prints what the current bar would do, writes nothing. */
function dryRun() {
  const candles = fetchCandles_();
  const series = computeSeries_(candles);
  const i = candles.length - 1;
  const state = getState_();
  const sig = decideAtBar_(candles, series, i, state);

  Logger.log('Bar: %s  Close: %s',
    Utilities.formatDate(new Date(candles[i].t), CONFIG.TZ, 'yyyy-MM-dd HH:mm'),
    candles[i].c);
  Logger.log('State: %s', JSON.stringify(state));
  Logger.log('Context: %s', JSON.stringify(marketContext_(candles, series, i), null, 2));
  Logger.log('Signal: %s', sig ? JSON.stringify(sig, null, 2) : 'none');
}

/**
 * CHECK INSTALLATION — run after every install step. Prints PASS / TODO / FAIL
 * for each piece, so you know exactly what's left.
 *
 * It also catches the most common upgrade mistake: an OLD version of a file
 * left in the project. Each check below looks for a function that exists only
 * in the current version of that file.
 */
function checkInstall() {
  const lines = installChecks_(false);
  const fails = lines.filter(l => l.indexOf('FAIL') === 0).length;
  const todos = lines.filter(l => l.indexOf('TODO') === 0).length;
  const summary = fails ? fails + ' problem(s). Fix the first FAIL, then run this again.'
                : todos ? 'No problems. ' + todos + ' step(s) still to do.' : 'Everything installed.';
  Logger.log('\n' + lines.join('\n') + '\n\n' + summary);
  try {
    SpreadsheetApp.getUi().alert('Installation check', lines.join('\n') + '\n\n' + summary,
      SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (e) { /* run from the editor: the log is enough */ }
}

/** The checks themselves. skipApi = true avoids the paid Claude call (used by the panel). */
function installChecks_(skipApi) {
  const lines = [];
  const check = (name, fn) => {
    try {
      const r = fn();
      if (r && r.todo) lines.push('TODO  ' + name + ' — ' + r.todo);
      else lines.push('PASS  ' + name + (r ? ' — ' + r : ''));
    } catch (e) {
      lines.push('FAIL  ' + name + ' — ' + e.message);
    }
  };
  const need = (ok, file) => { if (!ok) throw new Error(file + ' is missing or an old version. Replace its whole contents.'); };

  // 1. Every file present, and the current version
  check('Config.gs', () => need(typeof CONFIG !== 'undefined' && CONFIG.PAPER && CONFIG.AGENT && CONFIG.BACKTEST, 'Config.gs'));
  check('Data.gs', () => need(typeof fetchTickerPrice_ === 'function' && typeof fetchCoinbase_ === 'function', 'Data.gs'));
  check('Indicators.gs', () => need(typeof realisedVolPct_ === 'function', 'Indicators.gs'));
  check('Strategy.gs', () => need(typeof decideAtBar_ === 'function' && decideAtBar_.length === 5, 'Strategy.gs'));
  check('History.gs', () => need(typeof loadHistory_ === 'function', 'History.gs'));
  check('Backtest.gs', () => need(typeof compareLiveVsBacktest === 'function', 'Backtest.gs'));
  check('PaperBroker.gs', () => need(typeof paperOnSignal_ === 'function', 'PaperBroker.gs'));
  check('Analyst.gs', () => need(typeof callClaude_ === 'function', 'Analyst.gs'));
  check('Agent.gs', () => need(typeof handleTelegram_ === 'function', 'Agent.gs'));
  check('Journal.gs', () => need(typeof gradePendingSignals_ === 'function', 'Journal.gs'));
  check('Webhook.gs', () => need(typeof reconcileCrosscheck_ === 'function', 'Webhook.gs'));
  check('Dashboard.gs', () => need(typeof getDashboardData === 'function', 'Dashboard.gs'));
  check('Lab.gs', () => need(typeof runLab === 'function' && typeof entryBlockedBy_ === 'function' &&
                             CONFIG.LAB !== undefined, 'Lab.gs (and Strategy.gs, Config.gs)'));
  check('AutoBacktest.gs', () => need(typeof runAutoBacktest === 'function', 'AutoBacktest.gs'));
  check('AiGate.gs', () => {
    need(typeof gateOnBar_ === 'function' && CONFIG.GATE !== undefined, 'AiGate.gs (and Config.gs)');
    return 'mode ' + CONFIG.GATE.mode + ', model ' + CONFIG.GATE.model;
  });
  check('History.gs is current', () => need(typeof updateHistory === 'function', 'History.gs'));
  check('Config.gs is current', () => need(CONFIG.BACKTEST.minTrades !== undefined && CONFIG.LAB !== undefined, 'Config.gs'));
  check('DashboardPage.html', () => { HtmlService.createTemplateFromFile('DashboardPage'); });
  check('No leftover old doPost', () => {
    if (String(doPost).indexOf('handleTradingView_') === -1) {
      throw new Error('doPost comes from an old file. Delete any old copy of Agent.gs (or other leftovers).');
    }
  });

  // 2. Secrets
  check('ANTHROPIC_API_KEY', () => { if (!secret_('ANTHROPIC_API_KEY', false)) throw new Error('missing from Script Properties'); });
  check('DASHBOARD_KEY', () => secret_('DASHBOARD_KEY', false) ? '' : { todo: 'add to Script Properties before deploying the dashboard' });
  check('TV_WEBHOOK_SECRET', () => {
    if (!CONFIG.TRADINGVIEW.enabled) return { todo: 'only needed if you turn TradingView on' };
    if (!secret_('TV_WEBHOOK_SECRET', false)) throw new Error('TRADINGVIEW.enabled is true but the secret is missing');
  });
  check('Telegram', () => {
    if (!CONFIG.ALERTS.telegramChatId) return { todo: 'optional — alerts go by email only' };
    if (!secret_('TELEGRAM_BOT_TOKEN', false)) throw new Error('telegramChatId is set but TELEGRAM_BOT_TOKEN is missing');
  });
  check('Email alerts', () => CONFIG.ALERTS.email ? CONFIG.ALERTS.email : { todo: 'set ALERTS.email in Config.gs to get signal emails' });

  // 3. Live connections
  check('Market data', () => {
    const c = fetchCandles_();
    return c.length + ' closed ' + CONFIG.MARKET.intervalMinutes + 'm candles from ' + CONFIG.MARKET.provider +
           ', last ' + utc_(c[c.length - 1].t) + ' UTC';
  });
  check('Live price', () => CONFIG.MARKET.symbol + ' $' + fetchTickerPrice_());
  if (skipApi) lines.push('SKIP  Claude API — not called from the panel, to save cost. Use the sheet menu to test it.');
  else check('Claude API', () => 'model ' + CONFIG.ANALYST.model + ' replied "' +
        callClaude_('Reply with exactly: OK', 'Connection test.').slice(0, 20) + '"');
  check('Sheets', () => { ensureSheets_(); return 'Signals, Journal, Regime, Log ready'; });

  // 4. Things you switch on later
  check('Price history', () => {
    const s = ss_().getSheetByName(CONFIG.BACKTEST.historySheet);
    return s && s.getLastRow() > 1000 ? (s.getLastRow() - 1) + ' bars stored'
                                       : { todo: 'run Backtesting → 1. Build history' };
  });
  check('Triggers', () => {
    const t = ScriptApp.getProjectTriggers().map(x => x.getHandlerFunction());
    if (t.indexOf('runMonitor') === -1) return { todo: 'run setup() when you are ready to go live' };
    if (CONFIG.BACKTEST.autoEnabled && t.indexOf('runAutoBacktest') === -1) {
      return { todo: 'run setup() again to add the weekly automatic backtest' };
    }
    if (CONFIG.LAB.autoEnabled && t.indexOf('runLab') === -1) {
      return { todo: 'run setup() again to add the nightly research lab' };
    }
    return t.join(', ');
  });
  check('Web app', () => {
    const u = ScriptApp.getService().getUrl();
    return u ? u : { todo: 'Deploy → New deployment → Web app' };
  });

  return lines;
}