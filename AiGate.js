/**
 * AiGate.gs — a fast three-field AI verdict, run in SHADOW mode.
 *
 * Idea: a rule-based strategy with one "thinking if" — buy only when the
 * rules fire AND the AI says buy with enough conviction and low enough risk.
 * Rules still manage the money: stop, channel exit and time exit are unchanged.
 *
 * Why shadow only: an LLM veto can't be backtested honestly. The model has
 * seen BTC's price history, so replaying old bars through it leaks the future.
 * The only clean evidence is forward: log what the gate WOULD have done, let
 * the rules trade as usual, then compare with each trade's real result
 * (showGateReport). Changing trades is a separate decision for the owner,
 * made after that evidence exists — it is not implemented here.
 *
 * The gate never places orders and never changes BOT_STATE or the paper account.
 * Any failure is logged and ignored: the monitor carries on without it.
 */

const GATE_HEADERS = [
  'LoggedAt', 'BarTime', 'Mode', 'Position', 'RuleSignal',
  'Action', 'Conviction', 'RiskFlag', 'WouldDo', 'OpenR',
  'Model', 'Ms', 'TradeEntry', 'FinalR', 'Error'
];

const GATE_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['buy', 'sell', 'hold'] },
    conviction: { type: 'number' },
    risk_flag: { type: 'number' }
  },
  required: ['action', 'conviction', 'risk_flag'],
  additionalProperties: false
};

const GATE_SYSTEM =
  'You are a fast market-state classifier inside a rule-based BTC research tool. ' +
  'You receive closed-candle numbers and the current paper position. Judge only from ' +
  'that data. Return three fields:\n' +
  '- action: "buy" if conditions favour holding a long from here, "sell" if they favour ' +
  'being out, "hold" if there is no clear lean.\n' +
  '- conviction: 0 to 2. 0 = no edge, 1 = moderate, 2 = strong.\n' +
  '- risk_flag: 0 to 1. How exposed a long is to a sharp adverse move over the next few ' +
  'bars. 0 = calm, 1 = extreme.\n' +
  'Your answer is logged and graded against what actually happens. It places no orders.';

/**
 * Ask the gate about bar i. `pos` describes the position BEFORE any rule signal
 * on this bar: {position:'FLAT'} or {position:'LONG', entryPrice, stop, barsInTrade}.
 * `ruleSig` is the rule signal on this bar, or null.
 * Returns one line for the alert ('' when the gate is off or failed).
 */
function gateOnBar_(candles, series, i, pos, ruleSig, tradeEntry) {
  const G = CONFIG.GATE;
  if (!G || G.mode !== 'shadow') return '';

  const k = candles[i];
  const openR = pos.position === 'LONG' && pos.entryPrice > pos.stop
    ? (k.c - pos.entryPrice) / (pos.entryPrice - pos.stop) : '';
  const row = {
    barTime: k.t, position: pos.position, ruleSignal: ruleSig ? ruleSig.type : '',
    openR: openR === '' ? '' : round_(openR), tradeEntry: tradeEntry || ''
  };

  try {
    const v = askGate_(gateSnapshot_(candles, series, i, pos, ruleSig, openR));
    row.verdict = v;
    row.wouldDo = gateWouldDo_(v, pos.position, G);
    logGate_(row);
    return '\nAI gate (shadow): ' + v.action + ', conviction ' + v.conviction +
           ', risk ' + v.riskFlag + ' → would ' + row.wouldDo.toLowerCase().replace('_', ' ');
  } catch (e) {
    row.wouldDo = 'NO_VERDICT';
    row.error = e.message;
    logGate_(row);
    logLine_('WARN', 'AI gate: ' + e.message);
    return '';
  }
}

/** What the gate would have done. Pure: thresholds only, no API. */
function gateWouldDo_(v, position, G) {
  if (position === 'FLAT') {
    const ok = v.action === 'buy' && v.conviction >= G.minConviction && v.riskFlag < G.maxRisk;
    return ok ? 'ALLOW_ENTRY' : 'BLOCK_ENTRY';
  }
  return v.action === 'sell' && v.riskFlag >= G.exitRisk ? 'EXIT_EARLY' : 'STAY';
}

/**
 * Plain numbers only, no dates: the recent bars, the indicator context the
 * analyst already uses, and the position.
 */
function gateSnapshot_(candles, series, i, pos, ruleSig, openR) {
  const ctx = marketContext_(candles, series, i);
  delete ctx.barTime;
  const from = Math.max(0, i - CONFIG.GATE.barsInPrompt + 1);
  const bars = candles.slice(from, i + 1).map(k => [round_(k.o), round_(k.h), round_(k.l), round_(k.c), round_(k.v)]);
  return {
    context: ctx,
    recentBars: { columns: ['open', 'high', 'low', 'close', 'volume'], oldestFirst: bars },
    position: pos.position === 'LONG'
      ? { side: 'LONG', entry: round_(pos.entryPrice), stop: round_(pos.stop),
          barsInTrade: pos.barsInTrade, openR: round_(openR) }
      : { side: 'FLAT' },
    ruleSignalThisBar: ruleSig ? ruleSig.type + ': ' + ruleSig.reason : 'none'
  };
}

/** One structured-output call. Throws on any problem; the caller logs it. */
function askGate_(snapshot) {
  const G = CONFIG.GATE;
  const t0 = Date.now();
  const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: {
      'x-api-key': secret_('ANTHROPIC_API_KEY', true),
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'server-side-fallback-2026-07-01'
    },
    payload: JSON.stringify({
      model: G.model,
      max_tokens: G.maxTokens,
      fallbacks: 'default',   // if a safety classifier declines, the API retries on a fallback model
      output_config: {
        effort: G.effort,
        format: { type: 'json_schema', schema: GATE_SCHEMA }
      },
      system: GATE_SYSTEM,
      messages: [{ role: 'user', content: JSON.stringify(snapshot) }]
    })
  });

  if (res.getResponseCode() !== 200) {
    throw new Error('Anthropic API ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  }
  const body = JSON.parse(res.getContentText());
  if (body.stop_reason === 'refusal') throw new Error('model declined (refusal)');
  if (body.stop_reason === 'max_tokens') throw new Error('reply cut off — raise GATE.maxTokens');

  const text = body.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const out = JSON.parse(text);
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, Number(x) || 0));
  return {
    action: out.action,
    conviction: round_(clamp(out.conviction, 0, 2)),
    riskFlag: round_(clamp(out.risk_flag, 0, 1)),
    model: body.model,
    ms: Date.now() - t0
  };
}

function logGate_(row) {
  const v = row.verdict || {};
  sheet_('Gate', GATE_HEADERS).appendRow([
    new Date(), new Date(row.barTime), CONFIG.GATE.mode, row.position, row.ruleSignal,
    v.action || '', v.conviction === undefined ? '' : v.conviction,
    v.riskFlag === undefined ? '' : v.riskFlag, row.wouldDo, row.openR,
    v.model || '', v.ms || '', row.tradeEntry, '', row.error || ''
  ]);
}

/** When a trade closes, write its real R onto every gate row of that trade. */
function gateCloseTrade_(tradeEntry, finalR) {
  try {
    const s = ss_().getSheetByName('Gate');
    if (!s || s.getLastRow() < 2 || !tradeEntry) return;
    const col = h => GATE_HEADERS.indexOf(h);
    const from = Math.max(2, s.getLastRow() - 1000);
    const n = s.getLastRow() - from + 1;
    const v = s.getRange(from, 1, n, GATE_HEADERS.length).getValues();
    v.forEach((r, j) => {
      if (Number(r[col('TradeEntry')]) === Number(tradeEntry) && r[col('FinalR')] === '') {
        s.getRange(from + j, col('FinalR') + 1).setValue(round_(finalR));
      }
    });
  } catch (e) {
    logLine_('WARN', 'AI gate outcome: ' + e.message);
  }
}

/**
 * The evidence. Were the entries the gate would have blocked actually worse?
 * Would its early exits have saved R? Menu: Live → AI gate report.
 */
function showGateReport() {
  const s = ss_().getSheetByName('Gate');
  const rows = s && s.getLastRow() > 1
    ? s.getRange(2, 1, s.getLastRow() - 1, GATE_HEADERS.length).getValues() : [];
  const col = h => GATE_HEADERS.indexOf(h);
  const closed = rows.filter(r => r[col('FinalR')] !== '');

  const entries = closed.filter(r => r[col('RuleSignal')] === 'ENTRY_LONG');
  const group = w => entries.filter(r => r[col('WouldDo')] === w).map(r => Number(r[col('FinalR')]));
  const describe = (name, rs) => rs.length
    ? name + ': ' + rs.length + ' trades, avg ' + round_(rs.reduce((a, x) => a + x, 0) / rs.length) +
      'R, win rate ' + Math.round(rs.filter(x => x > 0).length / rs.length * 100) + '%'
    : name + ': no closed trades yet';
  const allowed = group('ALLOW_ENTRY');
  const blocked = group('BLOCK_ENTRY');

  // Early exit: first EXIT_EARLY flag in each closed trade vs where the trade really ended.
  const firstFlag = {};
  closed.forEach(r => {
    const t = String(r[col('TradeEntry')]);
    if (r[col('WouldDo')] === 'EXIT_EARLY' && !(t in firstFlag)) {
      firstFlag[t] = { atFlag: Number(r[col('OpenR')]), final: Number(r[col('FinalR')]) };
    }
  });
  const flags = Object.keys(firstFlag).map(t => firstFlag[t]);
  const saved = flags.reduce((a, f) => a + (f.atFlag - f.final), 0);

  const trades = allowed.length + blocked.length;
  const lines = [
    'AI gate — shadow results (mode: ' + CONFIG.GATE.mode + ', model ' + CONFIG.GATE.model + ')',
    '',
    'ENTRIES (rules fired; would the gate have let them through?)',
    '  ' + describe('Would allow', allowed),
    '  ' + describe('Would block', blocked),
    '',
    'EARLY EXITS (gate said sell with high risk while in a trade)',
    flags.length
      ? '  ' + flags.length + ' trades flagged. Exiting at the first flag instead of the rule exit: ' +
        (saved >= 0 ? '+' : '') + round_(saved) + 'R in total.'
      : '  none flagged in a closed trade yet',
    '',
    trades < CONFIG.GATE.minTradesToJudge
      ? 'Only ' + trades + ' closed trade(s). Need ' + CONFIG.GATE.minTradesToJudge +
        '+ before this says anything. Keep it in shadow.'
      : 'Enough trades to look at. The gate earns a vote only if blocked trades are clearly worse ' +
        'than allowed ones AND the gain survives fees and missed winners. Decide before looking again.'
  ];
  Logger.log(lines.join('\n'));
  try {
    SpreadsheetApp.getUi().alert('AI gate report', lines.join('\n'), SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (e) { /* run from the editor: the log is enough */ }
}
