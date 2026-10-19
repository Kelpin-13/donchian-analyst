/**
 * Agent.gs — the actual agent loop.
 *
 * Analyst.gs makes one API call and gets one answer back. This file gives
 * Claude a set of tools and lets it decide what to look at, in what order,
 * until it has enough to write the note.
 *
 * SECURITY MODEL: every tool here is READ-ONLY. There is no tool to place an
 * order, edit CONFIG, write to the Signals sheet, or override a signal. The
 * tool list is the permission boundary — if a capability isn't in TOOL_IMPL,
 * no prompt can talk the agent into it. Design your tool list as if the model
 * were an untrusted intern with your spreadsheet open.
 *
 * Add this to CONFIG in Config.gs:
 *
 *   AGENT: {
 *     enabled: true,
 *     maxTurns: 6,          // hard cap on loop iterations
 *     maxTokens: 1500,
 *     webSearch: false,     // Anthropic server-side search; costs extra
 *     traceSheet: 'Trace'   // every tool call gets logged here
 *   },
 */

/** ---------------- TOOL DEFINITIONS (what Claude sees) ---------------- */

const AGENT_TOOLS = [
  {
    name: 'get_market_snapshot',
    description: 'Indicator snapshot for this symbol at a given candle size. ' +
      'Use a larger interval than the trading timeframe to check whether the ' +
      'higher timeframe agrees with the setup.',
    input_schema: {
      type: 'object',
      properties: {
        interval_minutes: {
          type: 'integer',
          description: 'Candle size. Allowed: 60, 240, 1440, 10080.'
        }
      },
      required: ['interval_minutes']
    }
  },
  {
    name: 'get_price_history',
    description: 'Recent closed candles as compact OHLC rows, newest last. ' +
      'Use when you need to see the actual shape of the move rather than summary stats.',
    input_schema: {
      type: 'object',
      properties: {
        bars: { type: 'integer', description: 'How many recent bars, 5 to 60.' },
        interval_minutes: { type: 'integer', description: 'Candle size. Default 240.' }
      },
      required: ['bars']
    }
  },
  {
    name: 'find_past_signals',
    description: 'Search the journal for previous signals and how they were graded. ' +
      'This is your memory of what this strategy has actually done. Use it before ' +
      'claiming a setup looks strong or weak.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: "'ENTRY_LONG', 'EXIT_STOP', 'EXIT_CHANNEL', or 'any'." },
        graded_only: { type: 'boolean', description: 'Only return signals with a known outcome.' },
        limit: { type: 'integer', description: 'Max rows, 1 to 15.' }
      },
      required: ['type']
    }
  },
  {
    name: 'get_recent_lessons',
    description: 'The most recent one-line lessons the grader produced from comparing ' +
      'earlier notes to real outcomes. Read these to avoid repeating a known mistake.',
    input_schema: {
      type: 'object',
      properties: { limit: { type: 'integer', description: 'How many lessons, 1 to 10.' } },
      required: []
    }
  },
  {
    name: 'get_position_state',
    description: 'Current paper position: flat or long, entry price, stop level, bars held.',
    input_schema: { type: 'object', properties: {}, required: [] }
  }
];

/** ---------------- TOOL IMPLEMENTATIONS (what actually runs) ---------------- */

const TOOL_IMPL = {

  get_market_snapshot: function (input) {
    const iv = clampInterval_(input.interval_minutes);
    const candles = agentCandles_(iv);
    const series = computeSeries_(candles);
    const i = candles.length - 1;
    const snap = marketContext_(candles, series, i);
    snap.candle = iv + 'm';
    snap.aboveEma = candles[i].c > series.ema[i];
    snap.distanceToChannelHighPct =
      round_(pctChange_(candles[i].c, series.entry.upper[i]));
    return snap;
  },

  get_price_history: function (input) {
    const iv = clampInterval_(input.interval_minutes || 240);
    const n = Math.max(5, Math.min(60, input.bars || 20));
    const candles = agentCandles_(iv);
    return {
      interval: iv + 'm',
      note: 'oldest first; time is candle open in ' + CONFIG.TZ,
      rows: candles.slice(-n).map(k => ({
        t: Utilities.formatDate(new Date(k.t), CONFIG.TZ, 'MM-dd HH:mm'),
        o: round_(k.o), h: round_(k.h), l: round_(k.l), c: round_(k.c),
        v: round_(k.v)
      }))
    };
  },

  find_past_signals: function (input) {
    const s = ss_().getSheetByName(CONFIG.SHEETS.signals);
    if (!s || s.getLastRow() < 2) return { count: 0, signals: [], note: 'Journal is empty.' };

    const rows = s.getRange(2, 1, s.getLastRow() - 1, SIGNAL_HEADERS.length).getValues();
    const limit = Math.max(1, Math.min(15, input.limit || 5));

    let out = rows;
    if (input.type && input.type !== 'any') out = out.filter(r => r[2] === input.type);
    if (input.graded_only) out = out.filter(r => r[16]);

    out = out.slice(-limit).map(r => ({
      barTime: Utilities.formatDate(new Date(r[1]), CONFIG.TZ, 'yyyy-MM-dd HH:mm'),
      type: r[2],
      price: r[3],
      confidenceAtTime: r[11],
      setup: String(r[8]).slice(0, 200),
      outcomePct: r[13] === '' ? null : r[13],
      maxUpPct: r[14] === '' ? null : r[14],
      maxDownPct: r[15] === '' ? null : r[15],
      verdict: r[16] || 'not yet graded',
      lesson: r[17] || ''
    }));

    return { count: out.length, signals: out };
  },

  get_recent_lessons: function (input) {
    const s = ss_().getSheetByName(CONFIG.SHEETS.signals);
    if (!s || s.getLastRow() < 2) return { lessons: [], note: 'No graded history yet.' };

    const rows = s.getRange(2, 1, s.getLastRow() - 1, SIGNAL_HEADERS.length).getValues();
    const limit = Math.max(1, Math.min(10, input.limit || 5));

    const lessons = rows
      .filter(r => r[17])
      .slice(-limit)
      .map(r => ({
        date: Utilities.formatDate(new Date(r[1]), CONFIG.TZ, 'yyyy-MM-dd'),
        verdict: r[16],
        lesson: r[17],
        missed: r[18] || ''
      }));

    return { count: lessons.length, lessons: lessons };
  },

  get_position_state: function () {
    const st = getState_();
    if (st.position === 'FLAT') return { position: 'FLAT' };
    return {
      position: 'LONG',
      entryPrice: round_(st.entryPrice),
      entryTime: Utilities.formatDate(new Date(st.entryTime), CONFIG.TZ, 'yyyy-MM-dd HH:mm'),
      stop: round_(st.stop),
      barsInTrade: st.barsInTrade,
      distanceToStopPct: round_(pctChange_(st.entryPrice, st.stop))
    };
  }
};

/** ---------------- HELPERS ---------------- */

function clampInterval_(iv) {
  const allowed = [60, 240, 1440, 10080];
  return allowed.indexOf(Number(iv)) === -1 ? 240 : Number(iv);
}

/**
 * Fetch candles at an arbitrary interval, cached for the life of this execution.
 *
 * The CONFIG swap is a shim: fetchCandles_ reads the interval from CONFIG rather
 * than taking a parameter. Safe here because Apps Script runs single-threaded per
 * execution and the monitor holds a lock. The clean fix is to parameterise
 * fetchCandles_ — worth doing when you add a second symbol.
 */
const _candleCache = {};

function agentCandles_(intervalMinutes) {
  if (_candleCache[intervalMinutes]) return _candleCache[intervalMinutes];

  const original = CONFIG.MARKET.intervalMinutes;
  try {
    CONFIG.MARKET.intervalMinutes = intervalMinutes;
    const c = fetchCandles_();
    _candleCache[intervalMinutes] = c;
    return c;
  } finally {
    CONFIG.MARKET.intervalMinutes = original;
  }
}

function traceSheet_() {
  return sheet_(CONFIG.AGENT.traceSheet || 'Trace',
    ['Time', 'RunId', 'Turn', 'Tool', 'Input', 'ResultPreview', 'Ms']);
}

/** ---------------- THE LOOP ---------------- */

/**
 * Run the agent. Returns the final text.
 *
 * Every tool call is timed and written to the Trace sheet. When the agent does
 * something stupid you need the trace, not a guess.
 */
function runAgentLoop_(systemPrompt, userPrompt, runId) {
  const cfg = CONFIG.AGENT;
  const key = secret_('ANTHROPIC_API_KEY', true);
  const trace = traceSheet_();

  const tools = AGENT_TOOLS.slice();
  if (cfg.webSearch) {
    tools.push({ type: 'web_search_20250305', name: 'web_search', max_uses: 2 });
  }

  const messages = [{ role: 'user', content: userPrompt }];

  for (let turn = 1; turn <= cfg.maxTurns; turn++) {

    const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      contentType: 'application/json',
      muteHttpExceptions: true,
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      payload: JSON.stringify({
        model: CONFIG.ANALYST.model,
        max_tokens: cfg.maxTokens,
        system: systemPrompt,
        tools: tools,
        messages: messages
      })
    });

    if (res.getResponseCode() !== 200) {
      throw new Error('Anthropic API ' + res.getResponseCode() + ': ' +
                      res.getContentText().slice(0, 300));
    }

    const body = JSON.parse(res.getContentText());
    messages.push({ role: 'assistant', content: body.content });

    // Done thinking — hand back the text.
    if (body.stop_reason !== 'tool_use') {
      return body.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    }

    // Run every tool the model asked for. Server-side tools (web_search) are
    // already resolved by the API and must NOT get a tool_result from us.
    const results = [];
    body.content.forEach(block => {
      if (block.type !== 'tool_use') return;

      const impl = TOOL_IMPL[block.name];
      const t0 = Date.now();
      let output;

      if (!impl) {
        output = { error: 'No such tool: ' + block.name };
      } else {
        try {
          output = impl(block.input || {});
        } catch (e) {
          output = { error: e.message };   // hand errors back, don't crash the loop
        }
      }

      const text = JSON.stringify(output).slice(0, 4000);
      trace.appendRow([new Date(), runId, turn, block.name,
                       JSON.stringify(block.input || {}).slice(0, 300),
                       text.slice(0, 400), Date.now() - t0]);

      results.push({ type: 'tool_result', tool_use_id: block.id, content: text });
    });

    if (!results.length) {
      return body.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    }

    messages.push({ role: 'user', content: results });
  }

  logLine_('WARN', 'Agent hit maxTurns (' + cfg.maxTurns + ') on run ' + runId);
  return '(Agent reached its turn limit without finishing. Raise AGENT.maxTurns ' +
         'or narrow the question.)';
}

const AGENT_SYSTEM =
  'You are a market research agent inside a rule-based trading tool.\n\n' +
  'THE SIGNAL IS ALREADY DECIDED by deterministic code before you are called. ' +
  'You cannot approve, reject, or trigger a trade, and you have no tool that ' +
  'could. Do not phrase anything as a recommendation to buy or sell.\n\n' +
  'Your job is to investigate, then write. Before you write:\n' +
  '- check at least one higher timeframe than the trading timeframe\n' +
  '- look up how similar past signals were graded\n' +
  '- read the recent lessons and do not repeat a mistake they name\n\n' +
  'Then write plainly. Specific numbers, no hype, no price targets. If the ' +
  'tools give you thin evidence, say the evidence is thin — a vague note that ' +
  'cannot be proven wrong is worse than no note, and the grader will mark it ' +
  '"unfalsifiable".\n\n' +
  '"confidence" = how cleanly this matches the strategy pattern. It is NOT a ' +
  'probability of profit.';

/** ---------------- ENTRY POINTS ---------------- */

/**
 * Agent version of writePreTradeNote_.
 * To use it, change one line in Main.gs runMonitor():
 *   const note = writePreTradeNote_(sig, ctx);
 *   ->  const note = agentPreTradeNote_(sig, ctx);
 */
function agentPreTradeNote_(sig, ctx) {
  if (!CONFIG.AGENT || !CONFIG.AGENT.enabled) return writePreTradeNote_(sig, ctx);

  const runId = 'SIG-' + Utilities.formatDate(new Date(sig.barTime), CONFIG.TZ, 'MMdd-HHmm');

  const prompt =
    'A ' + sig.type + ' signal just fired on ' + CONFIG.MARKET.symbol + ' ' +
    CONFIG.MARKET.intervalMinutes + 'm candles.\n\n' +
    'Rules engine reason: ' + sig.reason + '\n' +
    'Snapshot at the signal bar:\n' + JSON.stringify(ctx, null, 2) + '\n\n' +
    'Investigate using your tools, then return ONLY raw JSON:\n' +
    '{"setup": "2-3 sentences on this breakout in context, citing what you found",\n' +
    ' "invalidation": "specific price behaviour that would show the setup failed",\n' +
    ' "watch": "one concrete thing to watch over the next few bars",\n' +
    ' "confidence": "low|medium|high",\n' +
    ' "priorEvidence": "one sentence on what past graded signals suggest, or ' +
    '\'no comparable history\'"}';

  try {
    const raw = runAgentLoop_(AGENT_SYSTEM, prompt, runId);
    const clean = raw.replace(/```json/g, '').replace(/```/g, '').trim();
    const a = clean.indexOf('{'), b = clean.lastIndexOf('}');
    const note = JSON.parse(clean.substring(a, b + 1));
    if (note.priorEvidence) note.setup += ' [History: ' + note.priorEvidence + ']';
    return note;
  } catch (e) {
    logLine_('ERROR', 'agentPreTradeNote_: ' + e.message);
    return writePreTradeNote_(sig, ctx);   // fall back to the one-shot call
  }
}

/**
 * Ask the agent anything about the current market or your own history.
 * Run from the editor, the sheet menu, or a Telegram message.
 *
 *   askAgent('why are we still long?')
 *   askAgent('has this strategy ever worked in high volatility?')
 */
function askAgent(question) {
  const q = question || 'Summarise the current state of the market and the position.';
  const runId = 'ASK-' + Date.now();

  const answer = runAgentLoop_(
    AGENT_SYSTEM + '\n\nAnswer the question in plain prose. No JSON.',
    q, runId);

  sheet_(CONFIG.SHEETS.journal, ['Date', 'Event', 'Detail'])
    .appendRow([new Date(), 'ASK: ' + q, answer]);

  Logger.log(answer);
  return answer;
}

/** Menu-friendly prompt box version. */
function askAgentPrompt() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('Ask the agent', 'e.g. why are we still long?', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  ui.alert('Agent', askAgent(r.getResponseText()), ui.ButtonSet.OK);
}

/**
 * Telegram two-way. doPost() in Webhook.gs routes Telegram updates here.
 *
 * Deploy as a web app (Execute as: me, Access: anyone), then register:
 *   https://api.telegram.org/bot<TOKEN>/setWebhook?url=<YOUR_EXEC_URL>
 *
 * Two traps this handles:
 *  1. Apps Script answers POSTs with a 302 redirect. Telegram can treat that
 *     as a failure and resend the same update, so we de-duplicate on update_id.
 *  2. An agent run takes 20-40 seconds — far longer than a webhook sender
 *     should be kept waiting. So we only QUEUE the question here and answer
 *     it from a one-off trigger a second later.
 *
 * Only your own chat ID is answered — otherwise anyone who finds the URL is
 * spending your API credits.
 */
function handleTelegram_(update) {
  const msg = update.message;
  if (!msg || !msg.text) return;

  // No chat ID configured means Telegram is off: answer nobody (a forged update could carry an empty ID).
  const owner = String(CONFIG.ALERTS.telegramChatId || '');
  const from = msg.chat && msg.chat.id !== undefined && msg.chat.id !== null ? String(msg.chat.id) : '';
  if (!owner || from !== owner) {
    logLine_('WARN', 'Ignored Telegram message from chat ' + (from || '(none)').slice(0, 40));
    return;
  }

  const cache = CacheService.getScriptCache();
  const seenKey = 'tg_' + update.update_id;
  if (cache.get(seenKey)) return;          // duplicate delivery
  cache.put(seenKey, '1', 21600);

  const props = PropertiesService.getScriptProperties();
  const queue = JSON.parse(props.getProperty('TG_QUEUE') || '[]');
  queue.push(msg.text.slice(0, 500));
  props.setProperty('TG_QUEUE', JSON.stringify(queue.slice(-5)));

  scheduleOnce_('processTelegramQueue');
}

/** Answers queued Telegram questions. Runs from a one-off trigger. */
function processTelegramQueue() {
  clearTriggersFor_('processTelegramQueue');
  const props = PropertiesService.getScriptProperties();
  const queue = JSON.parse(props.getProperty('TG_QUEUE') || '[]');
  props.deleteProperty('TG_QUEUE');
  queue.forEach(q => {
    try { sendAlert_(askAgent(q)); }
    catch (e) { logLine_('ERROR', 'processTelegramQueue: ' + e.message); }
  });
}

/** Create a one-off trigger ~1s from now, unless one is already pending. */
function scheduleOnce_(fnName) {
  const pending = ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === fnName);
  if (!pending) ScriptApp.newTrigger(fnName).timeBased().after(1000).create();
}

function clearTriggersFor_(fnName) {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === fnName)
    .forEach(t => ScriptApp.deleteTrigger(t));
}

/** Smoke test: proves the loop runs and tools fire. Check the Trace sheet after. */
function testAgent() {
  Logger.log(askAgent(
    'What is the current state of ' + CONFIG.MARKET.symbol + '? Check the 4h and ' +
    'daily timeframes and tell me how far price is from the 20-bar breakout level.'));
}