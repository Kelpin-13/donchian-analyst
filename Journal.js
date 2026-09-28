/**
 * Journal.gs — everything that touches the spreadsheet.
 *
 * The Signals sheet is append-only for columns A-L. Once a note is written it
 * is never edited, because the whole point is comparing what you thought at
 * the time against what happened. Columns M-Q are filled in later by the grader.
 */

const SIGNAL_HEADERS = [
  'LoggedAt', 'BarTime', 'Type', 'Price', 'Stop', 'ATR', 'Units', 'RuleReason',
  'Setup', 'Invalidation', 'Watch', 'Confidence',
  'GradedAt', 'Outcome%', 'MaxUp%', 'MaxDown%', 'Verdict', 'Lesson', 'MissedFactor'
];

function ss_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function sheet_(name, headers) {
  const s = ss_().getSheetByName(name) || ss_().insertSheet(name);
  if (headers && s.getLastRow() === 0) {
    s.appendRow(headers);
    s.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    s.setFrozenRows(1);
  }
  return s;
}

function ensureSheets_() {
  sheet_(CONFIG.SHEETS.signals, SIGNAL_HEADERS);
  sheet_(CONFIG.SHEETS.regime,
    ['Date', 'Regime', 'Close', 'EMA100', 'ATR%', 'Vol%', 'Position', 'Summary', 'StrategyFit', 'RiskNote']);
  sheet_(CONFIG.SHEETS.journal,
    ['Date', 'Event', 'Detail']);
  sheet_(CONFIG.SHEETS.log,
    ['Time', 'Level', 'Message']);
}

function logLine_(level, message) {
  try {
    const s = sheet_(CONFIG.SHEETS.log, ['Time', 'Level', 'Message']);
    s.appendRow([new Date(), level, String(message).slice(0, 900)]);
    // Keep the log from growing forever.
    const max = 2000;
    if (s.getLastRow() > max) s.deleteRows(2, s.getLastRow() - max);
  } catch (e) {
    Logger.log('logLine_ failed: ' + e.message);
  }
}

function appendSignal_(sig, note) {
  const s = sheet_(CONFIG.SHEETS.signals, SIGNAL_HEADERS);
  s.appendRow([
    new Date(),
    new Date(sig.barTime),
    sig.type,
    sig.price,
    sig.stop || '',
    sig.atr || '',
    sig.units ? Number(sig.units.toFixed(6)) : '',
    sig.reason,
    note.setup || '',
    note.invalidation || '',
    note.watch || '',
    note.confidence || '',
    '', '', '', '', '', '', ''
  ]);
}

function appendRegime_(brief, ctx, position) {
  const s = sheet_(CONFIG.SHEETS.regime, null);
  s.appendRow([
    new Date(), brief.regime, ctx.close, ctx.ema100, ctx.atrPctOfPrice,
    ctx.annualisedVolPct, position,
    brief.summary, brief.strategyFit, brief.riskNote
  ]);
}

/**
 * Walk the Signals sheet, find notes old enough to grade, look up what
 * actually happened, and write the verdict back.
 *
 * Runs once a day. Skips rows already graded. Safe to run repeatedly.
 */
function gradePendingSignals_() {
  const s = sheet_(CONFIG.SHEETS.signals, SIGNAL_HEADERS);
  const lastRow = s.getLastRow();
  if (lastRow < 2) return 0;

  const values = s.getRange(2, 1, lastRow - 1, SIGNAL_HEADERS.length).getValues();
  const candles = fetchCandles_();
  const intervalMs = CONFIG.MARKET.intervalMinutes * 60 * 1000;
  const horizonMs = CONFIG.ANALYST.gradeAfterBars * intervalMs;
  const newestBar = candles[candles.length - 1].t;

  let graded = 0;

  for (let r = 0; r < values.length; r++) {
    const row = values[r];
    const verdict = row[16];
    if (verdict) continue;                       // already graded

    const barTime = new Date(row[1]).getTime();
    const signalPrice = Number(row[3]);
    if (!barTime || !signalPrice) continue;

    const dueAt = barTime + horizonMs;
    if (newestBar < dueAt) continue;             // not ripe yet

    const window = candles.filter(k => k.t > barTime && k.t <= dueAt);
    if (window.length < 2) continue;

    const endPrice = window[window.length - 1].c;
    const maxUp = Math.max.apply(null, window.map(k => k.h));
    const maxDown = Math.min.apply(null, window.map(k => k.l));

    const outcome = {
      barsElapsed: window.length,
      priceAtSignal: round_(signalPrice),
      priceNow: round_(endPrice),
      changePct: round_(pctChange_(signalPrice, endPrice)),
      maxFavourablePct: round_(pctChange_(signalPrice, maxUp)),
      maxAdversePct: round_(pctChange_(signalPrice, maxDown))
    };

    const grade = CONFIG.ANALYST.enabled
      ? gradeNote_({
          time: Utilities.formatDate(new Date(barTime), CONFIG.TZ, 'yyyy-MM-dd HH:mm'),
          setup: row[8], invalidation: row[9], watch: row[10], confidence: row[11]
        }, outcome)
      : { verdict: 'ungraded', lesson: '', missedFactor: '' };

    s.getRange(r + 2, 13, 1, 7).setValues([[
      new Date(),
      outcome.changePct,
      outcome.maxFavourablePct,
      outcome.maxAdversePct,
      grade.verdict,
      grade.lesson,
      grade.missedFactor
    ]]);

    graded++;
    Utilities.sleep(500);   // be polite to the API
  }

  if (graded) logLine_('INFO', 'Graded ' + graded + ' signal(s)');
  return graded;
}

/**
 * Roll up your own track record. Run it whenever you want the honest number.
 */
function showScorecard() {
  const s = sheet_(CONFIG.SHEETS.signals, SIGNAL_HEADERS);
  if (s.getLastRow() < 2) { Logger.log('No signals yet.'); return; }

  const rows = s.getRange(2, 1, s.getLastRow() - 1, SIGNAL_HEADERS.length).getValues();
  const gradedRows = rows.filter(r => r[16]);
  if (!gradedRows.length) { Logger.log('No graded signals yet.'); return; }

  const counts = {};
  gradedRows.forEach(r => { counts[r[16]] = (counts[r[16]] || 0) + 1; });

  const moves = gradedRows.map(r => Number(r[13])).filter(n => !isNaN(n));
  const avgMove = moves.reduce((a, b) => a + b, 0) / moves.length;
  const positive = moves.filter(m => m > 0).length;

  Logger.log('=== SCORECARD (%s graded signals) ===', gradedRows.length);
  Logger.log('Analyst verdicts: %s', JSON.stringify(counts));
  Logger.log('Signals green after %s bars: %s/%s (%s%%)',
    CONFIG.ANALYST.gradeAfterBars, positive, moves.length,
    ((positive / moves.length) * 100).toFixed(1));
  Logger.log('Average move: %s%%', avgMove.toFixed(2));
  Logger.log('If "unfalsifiable" is your most common verdict, your prompts are too vague.');
}