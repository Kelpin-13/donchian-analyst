/**
 * Lab.gs — the research lab. How the strategy improves without fooling you.
 *
 * THE PROBLEM IT SOLVES
 * Try enough variations on the same data and one will always look great,
 * even on random prices. So "run it many times and keep the best" is the
 * fastest way to build a strategy that only works in the past.
 *
 * THE RULES IT FOLLOWS
 *  1. The most recent year of history is LOCKED (the holdout). Experiments
 *     never see it. It's used once, when you consider promoting a winner.
 *  2. The rest (the research period) is cut into time blocks. A candidate
 *     has to beat the current strategy in most blocks, not just in total —
 *     one lucky month can't carry it.
 *  3. If it changes a number, the numbers either side of it must also work.
 *     A setting that only works at exactly 27 is a coincidence.
 *  4. Nothing goes live without you. Promotion is a menu action with a
 *     yes/no dialog, and Revert undoes it.
 *  5. Every experiment is logged, including the failures, so you always
 *     know how many tries it took to find a "winner".
 *
 * SHEETS
 *  Lab_Queue — experiments waiting to run. Add your own rows. Claude's
 *              suggestions arrive as PROPOSED and only run once you set
 *              the Status to QUEUED.
 *  Lab_Log   — one row per finished experiment, never overwritten.
 */

const LAB_QUEUE_HEADERS = ['ID', 'Name', 'Overrides (JSON)', 'Why', 'Status', 'Verdict', 'Finished at'];
const LAB_LOG_HEADERS = [
  'ID', 'Run at', 'Name', 'Overrides', 'Verdict', 'Reasons',
  'Base trades', 'Cand trades', 'Base return %', 'Cand return %', 'Base max DD %', 'Cand max DD %',
  'Base score', 'Cand score', 'Blocks won', 'Neighbours OK', 'Experiments tried so far',
  'Holdout: base %', 'Holdout: cand %', 'Holdout verdict', 'Promoted'
];

/** Keys an experiment may change, with sane limits. Anything else is rejected. */
const LAB_ALLOWED = {
  breakoutLookback:   { type: 'int',   min: 5,   max: 100 },
  exitLookback:       { type: 'int',   min: 3,   max: 60 },
  atrPeriod:          { type: 'int',   min: 5,   max: 50 },
  stopAtrMult:        { type: 'num',   min: 0.5, max: 5 },
  trendEmaPeriod:     { type: 'int',   min: 20,  max: 300 },
  maxBarsInTrade:     { type: 'int',   min: 10,  max: 200 },
  skipWeekendEntries: { type: 'bool' },
  minVolumeRatio:     { type: 'num',   min: 0,   max: 3 },
  minAtrPct:          { type: 'num',   min: 0,   max: 10 },
  maxAtrPct:          { type: 'num',   min: 0,   max: 20 }
};

const LAB_BUDGET_MS = 4.5 * 60 * 1000;

/* =========================== VALIDATION =========================== */

function labValidate_(overrides) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new Error('Overrides must be a JSON object, e.g. {"breakoutLookback": 30}');
  }
  const keys = Object.keys(overrides);
  if (!keys.length) throw new Error('Overrides are empty');
  const clean = {};
  keys.forEach(k => {
    const rule = LAB_ALLOWED[k];
    if (!rule) throw new Error('"' + k + '" is not a setting the lab may change');
    const v = overrides[k];
    if (rule.type === 'bool') {
      if (typeof v !== 'boolean') throw new Error(k + ' must be true or false');
      clean[k] = v;
      return;
    }
    const n = Number(v);
    if (!isFinite(n)) throw new Error(k + ' must be a number');
    if (rule.type === 'int' && Math.round(n) !== n) throw new Error(k + ' must be a whole number');
    if (n < rule.min || n > rule.max) throw new Error(k + ' must be between ' + rule.min + ' and ' + rule.max);
    clean[k] = n;
  });
  return clean;
}

function labKey_(overrides) {
  return JSON.stringify(Object.keys(overrides).sort().reduce((o, k) => { o[k] = overrides[k]; return o; }, {}));
}

/* =========================== DATA SPLIT =========================== */

function labSplit_(candles) {
  const L = CONFIG.LAB;
  const cut = candles[candles.length - 1].t - L.holdoutDays * 86400000;
  let researchEnd = -1;
  for (let i = candles.length - 1; i >= 0; i--) { if (candles[i].t < cut) { researchEnd = i; break; } }
  const warm = warmupBars_(Object.assign({}, CONFIG.STRATEGY, { breakoutLookback: 100, trendEmaPeriod: 300 }));
  if (researchEnd < warm + 1000) {
    throw new Error('Not enough history for the lab: need about ' +
      Math.ceil((warm + 1000) * CONFIG.MARKET.intervalMinutes / 1440 + L.holdoutDays) +
      ' days. Set BACKTEST.historyDays to at least 1095 and run Backtesting → 1. Build history.');
  }
  return { researchStart: warm, researchEnd: researchEnd, holdoutStart: researchEnd + 1, last: candles.length - 1 };
}

/* =========================== EVALUATION =========================== */

function labScore_(m) {
  return m.totalReturnPct / Math.max(m.maxDrawdownPct, 1);   // return per unit of pain
}

/** Run one parameter set over [from..to]. Returns metrics plus the equity path for block scoring. */
function labRun_(candles, params, from, to) {
  const r = simulate_(candles, params, { startIndex: from, endIndex: to, closeAtEnd: true });
  const m = metrics_(r, candles);
  return { r: r, m: m, score: labScore_(m) };
}

/** Per-block return from one equity path — no extra simulations needed. */
function labBlockReturns_(run, blocks) {
  const eq = run.r.equity, n = eq.length, size = Math.floor(n / blocks), out = [];
  for (let b = 0; b < blocks; b++) {
    const a = b * size, z = (b === blocks - 1) ? n - 1 : (b + 1) * size - 1;
    out.push(eq[z] / eq[a] - 1);
  }
  return out;
}

/** The numbers either side of each changed numeric setting. */
function labNeighbours_(overrides) {
  const out = [];
  Object.keys(overrides).forEach(k => {
    const rule = LAB_ALLOWED[k];
    if (rule.type === 'bool') return;
    const v = overrides[k];
    if (v === 0) return;                                   // 0 means "filter off": no neighbours
    const step = rule.type === 'int' ? Math.max(1, Math.round(v * 0.2)) : Math.max(0.1, Math.round(v * 0.2 * 10) / 10);
    [v - step, v + step].forEach(x => {
      x = rule.type === 'int' ? Math.round(x) : Math.round(x * 100) / 100;
      if (x >= rule.min && x <= rule.max && x !== v) out.push(Object.assign({}, overrides, { [k]: x }));
    });
  });
  return out;
}

function labEvaluate_(candles, split, base, overrides) {
  const L = CONFIG.LAB;
  const candParams = Object.assign({}, CONFIG.STRATEGY, overrides);
  const cand = labRun_(candles, candParams, split.researchStart, split.researchEnd);

  const bb = labBlockReturns_(base, L.blocks), cb = labBlockReturns_(cand, L.blocks);
  let wins = 0;
  for (let i = 0; i < L.blocks; i++) if (cb[i] > bb[i]) wins++;

  const nbs = labNeighbours_(overrides);
  let nbOk = 0;
  nbs.forEach(o => {
    const s = labRun_(candles, Object.assign({}, CONFIG.STRATEGY, o), split.researchStart, split.researchEnd).score;
    if (s > base.score) nbOk++;              // neighbours must genuinely beat it, not just tie
  });

  const reasons = [];
  const needWins = Math.ceil(L.blocks * L.minBlockWinsPct / 100);
  const better = cand.score > base.score * (1 + L.minImprovementPct / 100) ||
                 (base.score <= 0 && cand.score > base.score + 0.1);
  const worse = cand.score < base.score * (1 - L.minImprovementPct / 100);
  const robust = !nbs.length || nbOk >= Math.ceil(nbs.length * 2 / 3);

  let verdict;
  if (cand.m.trades < L.minTrades) {
    verdict = 'TOO FEW TRADES';
    reasons.push(cand.m.trades + ' trades in the research period (need ' + L.minTrades + ')');
  } else if (better && wins >= needWins && robust) {
    verdict = 'IMPROVES';
    reasons.push('score ' + fmt_(base.score) + ' → ' + fmt_(cand.score), 'won ' + wins + '/' + L.blocks + ' blocks');
    if (nbs.length) reasons.push(nbOk + '/' + nbs.length + ' neighbouring settings also beat the current strategy');
  } else if (better) {
    verdict = 'FRAGILE';
    reasons.push('better overall (' + fmt_(base.score) + ' → ' + fmt_(cand.score) + ')');
    if (wins < needWins) reasons.push('but only won ' + wins + '/' + L.blocks + ' blocks — carried by a few periods');
    if (!robust) reasons.push('but only ' + nbOk + '/' + nbs.length + ' neighbouring settings hold up — a spike');
  } else if (worse) {
    verdict = 'WORSE';
    reasons.push('score ' + fmt_(base.score) + ' → ' + fmt_(cand.score));
  } else {
    verdict = 'NO BETTER';
    reasons.push('score ' + fmt_(base.score) + ' → ' + fmt_(cand.score) + ', within ' + L.minImprovementPct + '%');
  }

  return { cand: cand, wins: wins, nbOk: nbOk, nbTotal: nbs.length, verdict: verdict, reasons: reasons };
}

/* =========================== QUEUE RUNNER =========================== */

/**
 * Runs queued experiments until the queue is empty or the time budget is
 * used. Nightly by trigger; also on the menu. Safe to run any time.
 */
function runLab() {
  const t0 = Date.now();
  const q = sheet_('Lab_Queue', LAB_QUEUE_HEADERS);
  if (q.getLastRow() < 2) { Logger.log('Lab queue is empty. Use Lab → Add starter experiments.'); return 0; }

  const rows = q.getRange(2, 1, q.getLastRow() - 1, LAB_QUEUE_HEADERS.length).getValues();
  const pending = rows.map((r, i) => ({ r: r, row: i + 2 })).filter(x => String(x.r[4]).toUpperCase() === 'QUEUED');
  if (!pending.length) { Logger.log('Nothing QUEUED. PROPOSED rows need you to change their Status to QUEUED.'); return 0; }

  const candles = loadHistory_();
  const split = labSplit_(candles);
  const base = labRun_(candles, CONFIG.STRATEGY, split.researchStart, split.researchEnd);
  const log = sheet_('Lab_Log', LAB_LOG_HEADERS);
  const props = PropertiesService.getScriptProperties();
  let tried = Number(props.getProperty('LAB_TRIED') || 0);
  let done = 0;

  for (let p = 0; p < pending.length; p++) {
    if (Date.now() - t0 > LAB_BUDGET_MS) break;
    const x = pending[p];
    const id = x.r[0] || ('E' + x.row);
    try {
      q.getRange(x.row, 5).setValue('RUNNING');
      const overrides = labValidate_(JSON.parse(String(x.r[2])));
      const ev = labEvaluate_(candles, split, base, overrides);
      tried++;
      log.appendRow([
        id, new Date(), x.r[1], labKey_(overrides), ev.verdict, ev.reasons.join('; '),
        base.m.trades, ev.cand.m.trades, fmt_(base.m.totalReturnPct), fmt_(ev.cand.m.totalReturnPct),
        fmt_(base.m.maxDrawdownPct), fmt_(ev.cand.m.maxDrawdownPct), fmt_(base.score), fmt_(ev.cand.score),
        ev.wins + '/' + CONFIG.LAB.blocks, ev.nbTotal ? ev.nbOk + '/' + ev.nbTotal : 'n/a', tried,
        '', '', '', ''
      ]);
      labColour_(log, log.getLastRow(), ev.verdict);
      q.getRange(x.row, 5, 1, 3).setValues([['DONE', ev.verdict, new Date()]]);
      done++;
    } catch (e) {
      q.getRange(x.row, 5, 1, 3).setValues([['ERROR', e.message.slice(0, 200), new Date()]]);
    }
  }
  props.setProperty('LAB_TRIED', String(tried));

  const winners = log.getLastRow() > 1
    ? log.getRange(Math.max(2, log.getLastRow() - done + 1), 5, done, 1).getValues().filter(v => v[0] === 'IMPROVES').length
    : 0;
  if (done) {
    logLine_('INFO', 'Lab: ran ' + done + ' experiment(s), ' + winners + ' improved');
    if (winners) sendAlert_('🔬 Lab: ' + winners + ' of ' + done + ' experiments beat the current strategy on the research period.\n\n' +
      'Nothing has changed yet. Open Lab_Log, then Trading Agent → Lab → Promote an experiment to run the locked holdout test.');
  }
  Logger.log('Lab: %s done, %s improved, %s tried in total, %s still queued.', done, winners, tried, pending.length - done);
  return done;
}

function labColour_(s, row, verdict) {
  const c = { 'IMPROVES': '#C9E4D4', 'FRAGILE': '#F7E3B5', 'NO BETTER': '#E8E8E8',
              'WORSE': '#F2C4C4', 'TOO FEW TRADES': '#E8E8E8', 'PROMOTED': '#9FD3B6' }[verdict];
  if (c) s.getRange(row, 5).setBackground(c).setFontWeight('bold');
}

/* =========================== STARTER SET =========================== */

/** One change at a time, each testing a single idea. Adds only ones not already queued or logged. */
function labSeedExperiments() {
  const seeds = [
    ['Faster breakout (15)', { breakoutLookback: 15 }, 'More signals, earlier entries — more false starts?'],
    ['Slower breakout (30)', { breakoutLookback: 30 }, 'Fewer, stronger breakouts'],
    ['Classic turtle breakout (55)', { breakoutLookback: 55 }, 'The long-term turtle system entry'],
    ['Tighter exit (5)', { exitLookback: 5 }, 'Lock in profit sooner'],
    ['Looser exit (20)', { exitLookback: 20 }, 'Let winners run longer'],
    ['Tighter stop (1.5 ATR)', { stopAtrMult: 1.5 }, 'Smaller losses, more stop-outs'],
    ['Wider stop (3 ATR)', { stopAtrMult: 3.0 }, 'Fewer stop-outs, bigger losses'],
    ['Faster trend filter (EMA 50)', { trendEmaPeriod: 50 }, 'Re-enter uptrends sooner'],
    ['Slower trend filter (EMA 200)', { trendEmaPeriod: 200 }, 'Only trade the major trend'],
    ['Skip weekend entries', { skipWeekendEntries: true }, 'Weekend crypto is thinner — are those breakouts worse?'],
    ['Volume confirmation (1.2x)', { minVolumeRatio: 1.2 }, 'Only breakouts on above-average volume'],
    ['Strong volume confirmation (1.5x)', { minVolumeRatio: 1.5 }, 'Only breakouts on clearly heavy volume'],
    ['Skip quiet markets (ATR < 1%)', { minAtrPct: 1.0 }, 'Breakouts in dead markets may fizzle'],
    ['Skip wild markets (ATR > 4%)', { maxAtrPct: 4.0 }, 'Breakouts in chaos may reverse'],
    ['Shorter time stop (30 bars)', { maxBarsInTrade: 30 }, 'Free up capital from stalled trades'],
    ['Longer time stop (120 bars)', { maxBarsInTrade: 120 }, 'Let long trends play out']
  ];
  const added = labAddExperiments_(seeds.map(s => ({ name: s[0], overrides: s[1], why: s[2] })), 'QUEUED');
  Logger.log('Added %s starter experiment(s).', added);
  try { SpreadsheetApp.getUi().alert('Lab', added + ' experiment(s) queued. They run tonight at ' +
        CONFIG.LAB.runHour + ':00, or now via Lab → Run queued experiments now.', SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) {}
  return added;
}

function labAddExperiments_(list, status) {
  const q = sheet_('Lab_Queue', LAB_QUEUE_HEADERS);
  const seen = {};
  if (q.getLastRow() > 1) {
    q.getRange(2, 3, q.getLastRow() - 1, 1).getValues().forEach(r => {
      try { seen[labKey_(JSON.parse(String(r[0])))] = true; } catch (e) {}
    });
  }
  const live = labKey_(CONFIG.STRATEGY);
  let n = 0, next = q.getLastRow();
  list.forEach(x => {
    let o;
    try { o = labValidate_(x.overrides); } catch (e) { logLine_('WARN', 'Lab: rejected "' + x.name + '": ' + e.message); return; }
    const key = labKey_(o);
    const noChange = Object.keys(o).every(k => CONFIG.STRATEGY[k] === o[k]);
    if (seen[key] || noChange || key === live) return;
    seen[key] = true;
    q.appendRow(['E' + next, String(x.name).slice(0, 80), key, String(x.why || '').slice(0, 300), status, '', '']);
    next++; n++;
  });
  return n;
}

/* ====================== CLAUDE PROPOSES, YOU DECIDE ====================== */

/**
 * Claude reads the latest backtest verdict, the grader's lessons, and every
 * past lab result, then suggests up to two NEW experiments. They land as
 * PROPOSED — nothing runs until you change the Status to QUEUED.
 */
function labProposeWithClaude() {
  const lessons = [];
  const sig = ss_().getSheetByName(CONFIG.SHEETS.signals);
  if (sig && sig.getLastRow() > 1) {
    sig.getRange(2, 1, sig.getLastRow() - 1, SIGNAL_HEADERS.length).getValues()
      .filter(r => r[17]).slice(-10).forEach(r => lessons.push(r[16] + ': ' + r[17]));
  }
  const past = [];
  const log = ss_().getSheetByName('Lab_Log');
  if (log && log.getLastRow() > 1) {
    log.getRange(2, 1, log.getLastRow() - 1, 6).getValues().slice(-30)
      .forEach(r => past.push(r[3] + ' → ' + r[4]));
  }
  let bt = 'none yet';
  const btl = ss_().getSheetByName('BT_Log');
  if (btl && btl.getLastRow() > 1) {
    const v = btl.getRange(btl.getLastRow(), 1, 1, 3).getValues()[0];
    bt = v[1] + ' — ' + v[2];
  }

  const allowed = Object.keys(LAB_ALLOWED).map(k => {
    const r = LAB_ALLOWED[k];
    return k + (r.type === 'bool' ? ' (true/false)' : ' (' + r.type + ', ' + r.min + '–' + r.max + ')');
  }).join('\n');

  const prompt =
    'You are proposing experiments for a rule-based BTC trading research lab. A strict tester will judge them; ' +
    'most ideas fail and that is fine. Propose at most 2 NEW single-idea experiments.\n\n' +
    'Current strategy settings:\n' + JSON.stringify(CONFIG.STRATEGY) + '\n\n' +
    'Latest weekly backtest verdict: ' + bt + '\n\n' +
    'Recent lessons from graded live signals:\n' + (lessons.join('\n') || 'none yet') + '\n\n' +
    'Experiments already tried (do NOT repeat these):\n' + (past.join('\n') || 'none yet') + '\n\n' +
    'Settings you may change, with limits:\n' + allowed + '\n\n' +
    'Rules: change ONE or TWO settings per experiment; each must test a clear hypothesis grounded in the lessons ' +
    'or results above; never propose tuning to squeeze extra return from a result that already passed.\n' +
    'Return ONLY JSON: {"experiments":[{"name":"short name","overrides":{"key":value},"why":"one sentence hypothesis"}]}';

  const res = callClaudeJson_(
    'You design falsifiable experiments. Output raw JSON only.', prompt, { experiments: [] });
  const list = (res.experiments || []).slice(0, 2);
  const added = labAddExperiments_(list, 'PROPOSED');
  if (added) {
    sendAlert_('🔬 Claude proposed ' + added + ' lab experiment(s):\n\n' +
      list.map(x => '• ' + x.name + ' — ' + x.why).join('\n') +
      '\n\nThey will not run until you set their Status to QUEUED in Lab_Queue.');
  }
  Logger.log('Claude proposed %s experiment(s); %s added as PROPOSED.', list.length, added);
  return added;
}

/* =========================== PROMOTE / REVERT =========================== */

/**
 * The one-time exam on the locked holdout year, for one experiment.
 * Returns the numbers; promoting is a separate, confirmed step.
 */
function labHoldoutTest_(id) {
  const log = sheet_('Lab_Log', LAB_LOG_HEADERS);
  if (log.getLastRow() < 2) throw new Error('Lab_Log is empty.');
  const v = log.getRange(2, 1, log.getLastRow() - 1, LAB_LOG_HEADERS.length).getValues();
  const idx = v.findIndex(r => String(r[0]) === String(id));
  if (idx === -1) throw new Error('No experiment ' + id + ' in Lab_Log.');
  const row = v[idx];
  const overrides = labValidate_(JSON.parse(String(row[3])));

  const candles = loadHistory_();
  const split = labSplit_(candles);
  const base = labRun_(candles, CONFIG.STRATEGY, split.holdoutStart, split.last);
  const cand = labRun_(candles, Object.assign({}, CONFIG.STRATEGY, overrides), split.holdoutStart, split.last);

  const props = PropertiesService.getScriptProperties();
  const uses = Number(props.getProperty('LAB_HOLDOUT_USES') || 0) + 1;
  props.setProperty('LAB_HOLDOUT_USES', String(uses));

  const verdict = cand.m.trades < 5 ? 'TOO FEW TRADES TO TELL'
    : cand.score >= base.score ? 'HOLDS UP' : 'FAILS ON NEW DATA';
  log.getRange(idx + 2, 18, 1, 3).setValues([[fmt_(base.m.totalReturnPct), fmt_(cand.m.totalReturnPct), verdict]]);

  return { id: id, name: row[2], overrides: overrides, labVerdict: row[4], base: base.m, cand: cand.m,
           verdict: verdict, uses: uses, row: idx + 2 };
}

/** Menu: holdout test, then an explicit yes/no before anything goes live. */
function labPromote() {
  const ui = SpreadsheetApp.getUi();
  const ask = ui.prompt('Promote an experiment',
    'Experiment ID from Lab_Log (e.g. E7). This runs the one-time test on the locked holdout year.',
    ui.ButtonSet.OK_CANCEL);
  if (ask.getSelectedButton() !== ui.Button.OK) return;

  let h;
  try { h = labHoldoutTest_(ask.getResponseText().trim()); }
  catch (e) { ui.alert('Lab', e.message, ui.ButtonSet.OK); return; }

  const warn = [];
  if (h.labVerdict !== 'IMPROVES') warn.push('Its lab verdict was ' + h.labVerdict + ', not IMPROVES.');
  if (h.verdict !== 'HOLDS UP') warn.push('It did not hold up on the holdout year.');
  if (h.uses > 3) warn.push('The holdout year has now been used ' + h.uses + ' times. Each look makes it less of a fair test.');
  const pineNeeded = ['skipWeekendEntries', 'minVolumeRatio', 'minAtrPct', 'maxAtrPct'].some(k => k in h.overrides);

  const msg =
    h.name + '\n' + JSON.stringify(h.overrides) + '\n\n' +
    'Locked holdout year (never seen by the lab):\n' +
    '  Current strategy: ' + h.base.trades + ' trades, ' + fmt_(h.base.totalReturnPct) + '%, max DD ' + fmt_(h.base.maxDrawdownPct) + '%\n' +
    '  This experiment:  ' + h.cand.trades + ' trades, ' + fmt_(h.cand.totalReturnPct) + '%, max DD ' + fmt_(h.cand.maxDrawdownPct) + '%\n' +
    '  Verdict: ' + h.verdict + '\n\n' +
    (warn.length ? '⚠ ' + warn.join('\n⚠ ') + '\n\n' : '') +
    'Make this the live strategy? The paper account keeps running with the new rules.' +
    (pineNeeded ? '\nThe TradingView Pine script does not have this filter, so the cross-check will disagree until it is updated.'
                : '\nUpdate the matching input in the TradingView Pine script too, or the cross-check will disagree.');

  if (ui.alert('Holdout result', msg, ui.ButtonSet.YES_NO) !== ui.Button.YES) {
    ui.alert('Lab', 'Nothing changed. The holdout result is saved in Lab_Log.', ui.ButtonSet.OK);
    return;
  }
  labApply_(h.overrides, h.id + ' ' + h.name);
  const log = sheet_('Lab_Log', LAB_LOG_HEADERS);
  log.getRange(h.row, 21).setValue(new Date());
  labColour_(log, h.row, 'PROMOTED');
  ui.alert('Lab', 'Promoted. The next monitor run uses the new settings. Trading Agent → Lab → Revert undoes it.', ui.ButtonSet.OK);
}

function labApply_(overrides, label) {
  const props = PropertiesService.getScriptProperties();
  const current = JSON.parse(props.getProperty('LIVE_STRATEGY') || '{}');
  const next = Object.assign(current, overrides);
  props.setProperty('LIVE_STRATEGY', JSON.stringify(next));
  Object.assign(CONFIG.STRATEGY, overrides);
  sheet_(CONFIG.SHEETS.journal, ['Date', 'Event', 'Detail'])
    .appendRow([new Date(), 'STRATEGY CHANGED', label + ' → live overrides now ' + JSON.stringify(next)]);
  logLine_('INFO', 'Strategy promoted: ' + label);
  sendAlert_('🔧 Strategy changed: ' + label + '\nLive overrides: ' + JSON.stringify(next));
}

/** Back to the Config.gs defaults. */
function labRevert() {
  const props = PropertiesService.getScriptProperties();
  const was = props.getProperty('LIVE_STRATEGY');
  props.deleteProperty('LIVE_STRATEGY');
  sheet_(CONFIG.SHEETS.journal, ['Date', 'Event', 'Detail'])
    .appendRow([new Date(), 'STRATEGY REVERTED', 'Removed overrides ' + (was || '{}') + '; back to Config.gs']);
  logLine_('INFO', 'Strategy reverted to Config.gs defaults');
  try { SpreadsheetApp.getUi().alert('Lab', was ? 'Reverted. Removed: ' + was : 'Nothing to revert — already on Config.gs defaults.',
        SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) {}
}

function labShowLive() {
  const o = PropertiesService.getScriptProperties().getProperty('LIVE_STRATEGY') || '{} (none — Config.gs defaults)';
  const tried = PropertiesService.getScriptProperties().getProperty('LAB_TRIED') || 0;
  const uses = PropertiesService.getScriptProperties().getProperty('LAB_HOLDOUT_USES') || 0;
  const msg = 'Live overrides: ' + o + '\n\nFull live settings:\n' + JSON.stringify(CONFIG.STRATEGY, null, 1) +
    '\n\nExperiments tried so far: ' + tried + '\nHoldout year used: ' + uses + ' time(s)';
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert('Live strategy', msg, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) {}
}