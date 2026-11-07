//+------------------------------------------------------------------+
//| DonchianGold.mq5                                                 |
//| Donchian breakout on gold, H4, long and short. DEMO ACCOUNTS ONLY.|
//|                                                                  |
//| The rules mirror research/daytrade.js ("H4, hold overnight, both")|
//| exactly: decisions on closed bars only, channels exclude the     |
//| current bar, EMA seeded with an SMA, Wilder ATR, stop checked on |
//| the close, exits stop > channel > time. Parity is checked with   |
//| the MT5 Strategy Tester against that script.                     |
//|                                                                  |
//| Safety (CLAUDE.md rule 1): refuses to run on a non-demo account, |
//| every order carries a broker stop loss and take-profit (set      |
//| again from the real fill, so the reward is exactly InpTpR x the  |
//| strategy stop), no entry whose stop would cost over $150, one    |
//| position at a time, a broker stop that trails 0.5 x the strategy |
//| stop behind the best price once a trade is 1 x it in profit      |
//| (research/trail_lab.js),                                         |
//| no averaging down, no martingale, daily loss limit, kill switch. |
//|                                                                  |
//| Gold closes for about an hour at server midnight and for the     |
//| weekend, so orders can meet "market closed": an entry stays      |
//| pending until its bar ends, an exit until it is done, and nothing|
//| is sent again until gold has a newer quote. An entry later than  |
//| 15 minutes into its bar is skipped, never chased; exits always   |
//| go. After a start or an outage no bar is decided for a minute,   |
//| so MT5 can fill its history. A position closed by anything but   |
//| this EA (broker stop, stop-out, a human) is journaled as such.   |
//+------------------------------------------------------------------+
#property copyright   "Donchian Analyst (personal research)"
#property version     "1.08"
#property description "Donchian breakout on gold, long and short. Demo accounts only."

#include <Trade\Trade.mqh>
#include "SheetSync.mqh"
#include "AccountGuard.mqh"

input group "Strategy (must match research/daytrade.js)"
input ENUM_TIMEFRAMES InpTimeframe  = PERIOD_H4; // Bar size the rules run on
input int             InpBreakout   = 20;        // Entry channel: prior N bars
input int             InpExit       = 10;        // Exit channel: prior M bars
input int             InpAtrPeriod  = 14;        // ATR period (Wilder)
input double          InpStopAtr    = 2.0;       // Strategy stop, ATRs from the fill (checked on the close)
input int             InpEmaPeriod  = 100;       // Trend filter EMA
input int             InpMaxBars    = 60;        // Time exit, bars in trade
input bool            InpAllowLong  = true;      // Take long breakouts
input bool            InpAllowShort = true;      // Take short breakdowns

input group "Risk limits"
input double InpFixedLots    = 0;    // Every trade's size in lots; 0 = size by the risk % below (owner, 6 Nov 2026)
input double InpRiskPct      = 0.5;  // % of equity lost if the strategy stop is hit (only when the fixed size is 0)
input double InpMaxLeverage  = 2.0;  // Position value capped at equity x this
input double InpHardStopAtr  = 4.0;  // Broker stop loss, ATRs from the fill (catastrophe stop)
input double InpTpR          = 1.5;  // Take-profit at the broker, x the strategy stop from the fill; 0 = none (must match research/parity_mt5.js)
input double InpMaxStopUsd   = 150.0; // Skip an entry whose strategy stop would cost more than this many dollars at its size; 0 = no cap (must match research/parity_mt5.js)
input double InpTrailAtR     = 1.0;  // Trailing stop: starts once the trade is this many strategy stops in profit; 0 = off (must match research/parity_mt5.js)
input double InpTrailDistR   = 0.5;  // Trailing stop: the broker stop follows this many strategy stops behind the best price since the fill
input double InpDailyLossPct = 3.0;  // No new entries after equity falls this % in a server day
input int    InpMaxTradesDay = 2;    // Max entries per server day
input double InpMaxDrawdownPct = 15.0; // Account stop: close and stop both EAs when equity falls this % below its peak (DG_PEAK); 0 = off

input group "Housekeeping"
input long   InpMagic        = 20261009; // Identifies this EA's positions
input int    InpCalcBars     = 1000;     // Closed bars used for the indicators
input int    InpDeviationPts = 50;       // Max price deviation for market orders, points

CTrade trade;
string GVP;                    // global-variable prefix, per magic number
const string JOURNAL = "DonchianGold_journal.csv";
// Exit reasons, stored by index while an exit waits to be retried (0 = none pending). New ones go at the end, so a
// pending exit saved by an older build keeps its meaning.
string EXIT_NAMES[] = { "", "EXIT_STOP", "EXIT_CHANNEL", "EXIT_TIME", "KILL_SWITCH", "EXIT_RETRY", "EXIT_TRAIL" };
const int EXIT_RETRY_CODE = 5;
// Later than this into its bar an entry was missed, not delayed (PC off, connection lost): the research only measures
// entries at the bar's first price. The longest genuine wait in 2023-2026 is 2 minutes (quotes at 01:03, orders at 01:05).
const int ENTRY_LATE_MIN = 15;
// How long nothing that reads bars runs after a start, a sleep or a lost connection, and the most that can stretch to.
const int HISTORY_SETTLE_SEC = 60;
const int HISTORY_SETTLE_MAX_SEC = 300;
// Set at start-up and on a "market closed" reply: nothing is sent until gold has a quote newer than this one
// (its time in ms; -1 = not waiting).
long   g_waitQuote = -1;
bool   g_waitSaid  = true;     // the journal already says why orders wait
datetime g_dealWaitFrom = 0;   // when a position was first seen gone with its closing deal not in the history yet
datetime g_settleFrom = 0;     // the last start, sleep or lost connection: MT5 has been catching up on bars since then
datetime g_lastRun = 0;        // the timer runs Run() every 30 seconds, so a long pause here means the PC slept
ulong  g_tpFixed = 0;          // the position whose take-profit is settled: exact, moved, or refused for good
uint   g_tpErr = 0;            // the last take-profit failure journaled
double g_trailRefused = 0;     // a trailing-stop level the broker refused for good: not sent again
uint   g_trailErr = 0;         // the last trailing-stop failure journaled

//--- persistent state: terminal global variables survive restarts --------
double GVGet(const string name, const double def) { string k = GVP + name; return GlobalVariableCheck(k) ? GlobalVariableGet(k) : def; }
void   GVSet(const string name, const double v)   { GlobalVariableSet(GVP + name, v); }
void   GVDel(const string name)                   { GlobalVariableDel(GVP + name); }

//--- demo guard: the strategy tester counts as safe, everything else must be demo
bool IsDemo()
  {
   if(MQLInfoInteger(MQL_TESTER)) return true;
   return AccountInfoInteger(ACCOUNT_TRADE_MODE) == ACCOUNT_TRADE_MODE_DEMO;
  }

bool TradingSwitchedOn()
  {
   return TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) && MQLInfoInteger(MQL_TRADE_ALLOWED);
  }

// Failures caused by the market or the connection, not by the order: worth sending again.
bool Transient(const uint rc)
  {
   return rc == TRADE_RETCODE_MARKET_CLOSED || rc == TRADE_RETCODE_REQUOTE || rc == TRADE_RETCODE_PRICE_CHANGED ||
          rc == TRADE_RETCODE_PRICE_OFF || rc == TRADE_RETCODE_TIMEOUT || rc == TRADE_RETCODE_CONNECTION ||
          rc == TRADE_RETCODE_TOO_MANY_REQUESTS || rc == TRADE_RETCODE_REJECT || rc == 0;
  }

int ExitCode(const string why)
  {
   for(int i = 1; i < ArraySize(EXIT_NAMES); i++) if(EXIT_NAMES[i] == why) return i;
   return EXIT_RETRY_CODE;
  }

string ExitName(const int code) { return code > 0 && code < ArraySize(EXIT_NAMES) ? EXIT_NAMES[code] : "EXIT_RETRY"; }

//--- journal: one CSV row per decision, readable by the rest of the project
void Journal(const string event, const string detail)
  {
   int h = FileOpen(JOURNAL, FILE_READ | FILE_WRITE | FILE_CSV | FILE_ANSI | FILE_SHARE_READ, ',');
   if(h == INVALID_HANDLE) { Print("DonchianGold: journal not writable, error ", GetLastError()); return; }
   if(FileSize(h) == 0) FileWrite(h, "server_time", "event", "equity", "detail");
   FileSeek(h, 0, SEEK_END);
   FileWrite(h, TimeToString(TimeCurrent(), TIME_DATE | TIME_SECONDS), event,
             DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY), 2), detail);
   FileClose(h);
   Print("DonchianGold ", event, ": ", detail);
  }

//--- market closed: nothing goes out until gold's own quote moves on ------
// No new quote means no new bar, so a pending order would be resent on every timer event for the whole
// weekend, priced from the last quote before the close. TimeCurrent() can't tell: it stands still at Friday's
// last tick over a weekend, so a session check on it reads "open"; nor does the session table know holidays.
long LastQuoteMs() { MqlTick q; return SymbolInfoTick(_Symbol, q) ? q.time_msc : 0; }

bool WaitingForQuote()
  {
   if(g_waitQuote < 0) return false;
   if(LastQuoteMs() > g_waitQuote) { g_waitQuote = -1; return false; }
   if(!g_waitSaid)
     {
      g_waitSaid = true;
      Journal("WAIT", "no new price yet (market closed, or the EA has just started): orders wait for the next one");
     }
   return true;
  }

void NoteRefusal(const uint rc)
  {
   if(rc != TRADE_RETCODE_MARKET_CLOSED) return;
   g_waitQuote = LastQuoteMs();
   g_waitSaid = true;                                              // its ERROR row says so
  }

//--- history: MT5 needs a moment to catch up after an outage -------------
// Bars decided at once can use a history with holes in it, and an order or an exit can follow from the wrong numbers.
// Of 18 live decisions checked against the full history 3 did: 2 in the very second the EA started (29 Oct 2026, after
// 13 days off: channel low 4015.9, really 3988.9) and 1 straight after a sleep. Those 13 days were filled within 18
// seconds. MT5's own flag can't be the only check: it can read true with data still missing.
void NoteOutage()
  {
   datetime now = TimeLocal();
   if(now - g_lastRun > 90 || !TerminalInfoInteger(TERMINAL_CONNECTED)) g_settleFrom = now;
   g_lastRun = now;
  }

// True while nothing that reads bars should run. Capped, so a flag that never clears can't leave the EA quiet.
bool HistorySettling()
  {
   if(MQLInfoInteger(MQL_TESTER)) return false;                   // the tester has no restarts and a complete history
   long since = TimeLocal() - g_settleFrom;
   return since < HISTORY_SETTLE_SEC || (since < HISTORY_SETTLE_MAX_SEC && !SeriesInfoInteger(_Symbol, InpTimeframe, SERIES_SYNCHRONIZED));
  }

//--- indicators, identical to Indicator.js -------------------------------
double TrueRange(const MqlRates &r[], const int i)
  {
   if(i == 0) return r[0].high - r[0].low;
   double pc = r[i - 1].close;
   return MathMax(r[i].high - r[i].low, MathMax(MathAbs(r[i].high - pc), MathAbs(r[i].low - pc)));
  }

// EMA seeded with the SMA of the first `period` closes; value at the last bar.
double EmaLast(const MqlRates &r[], const int n, const int period)
  {
   double sum = 0;
   for(int i = 0; i < period; i++) sum += r[i].close;
   double prev = sum / period, k = 2.0 / (period + 1);
   for(int i = period; i < n; i++) prev = r[i].close * k + prev * (1 - k);
   return prev;
  }

// Wilder ATR: seed = average TR of bars 1..period, then (prev*(p-1)+TR)/p.
double AtrLast(const MqlRates &r[], const int n, const int period)
  {
   double sum = 0;
   for(int i = 1; i <= period; i++) sum += TrueRange(r, i);
   double prev = sum / period;
   for(int i = period + 1; i < n; i++) prev = (prev * (period - 1) + TrueRange(r, i)) / period;
   return prev;
  }

// Donchian channel for the last bar, EXCLUDING it: bars [last-period .. last-1].
void Channel(const MqlRates &r[], const int n, const int period, double &hi, double &lo)
  {
   hi = -DBL_MAX; lo = DBL_MAX;
   for(int j = n - 1 - period; j < n - 1; j++) { hi = MathMax(hi, r[j].high); lo = MathMin(lo, r[j].low); }
  }

//--- our position (by symbol + magic) -----------------------------------
bool FindPosition(ulong &ticket, int &side, double &openPrice)
  {
   int found = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong t = PositionGetTicket(i);
      if(t == 0 || !PositionSelectByTicket(t)) continue;
      if(PositionGetString(POSITION_SYMBOL) != _Symbol || PositionGetInteger(POSITION_MAGIC) != InpMagic) continue;
      if(found == 0)
        {
         ticket = t;
         side = PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY ? 1 : -1;
         openPrice = PositionGetDouble(POSITION_PRICE_OPEN);
         // Remember what we hold, so a close we didn't make (broker stop, human) can be reported.
         if(GVGet("side", 0) != side) GVSet("side", side);
         if(GVGet("posid", 0) == 0) GVSet("posid", (double)PositionGetInteger(POSITION_IDENTIFIER));
        }
      found++;
     }
   if(found > 1) Journal("WARN", IntegerToString(found) + " positions with this magic number; managing one");
   return found > 0;
  }

void ClearTradeState()
  {
   GVDel("stop"); GVDel("sigbar"); GVDel("side"); GVDel("posid"); GVDel("trailed");
   GVDel("exit_pending"); GVDel("exit_tries"); GVDel("exit_err");
   GlobalVariablesFlush();
  }

void ClosePosition(const ulong ticket, const string why)
  {
   if(WaitingForQuote()) { GVSet("exit_pending", ExitCode(why)); return; }
   if(trade.PositionClose(ticket, InpDeviationPts) && trade.ResultRetcode() == TRADE_RETCODE_DONE)
     {
      int tries = (int)GVGet("exit_tries", 0);
      Journal(why, "closed ticket " + IntegerToString((long)ticket) + " at " + DoubleToString(trade.ResultPrice(), _Digits) +
              (tries > 0 ? " after " + IntegerToString(tries) + " failed attempts" : "") +
              ", profit " + DoubleToString(PositionPnl(ticket), 2));
      ClearTradeState();
      return;
     }
   // Keep trying on every tick until the position is gone: an exit is never skipped.
   // One journal row per new problem, not one per attempt.
   uint rc = trade.ResultRetcode();
   NoteRefusal(rc);
   GVSet("exit_pending", ExitCode(why));
   GVSet("exit_tries", GVGet("exit_tries", 0) + 1);
   if(GVGet("exit_err", -1) != rc)
     {
      GVSet("exit_err", rc);
      Journal("ERROR", why + " close failed, retcode " + IntegerToString((int)rc) +
              " (" + trade.ResultRetcodeDescription() + "); will retry");
     }
  }

// Our position is gone but this EA didn't close it: say who did, from the closing deal. Returns false while that
// deal may still be on its way to the terminal: a take-profit's wait depends on seeing it.
bool ReportOutsideClose(const int pendingExit)
  {
   ulong posid = (ulong)GVGet("posid", 0);
   string ev = "EXIT_EXTERNAL", detail = "position closed outside the EA; closing deal not found";
   bool found = false;
   if(posid > 0 && HistorySelectByPosition(posid))
      for(int i = HistoryDealsTotal() - 1; i >= 0; i--)
        {
         ulong d = HistoryDealGetTicket(i);
         long entry = HistoryDealGetInteger(d, DEAL_ENTRY);
         if(d == 0 || (entry != DEAL_ENTRY_OUT && entry != DEAL_ENTRY_OUT_BY)) continue;
         long reason = HistoryDealGetInteger(d, DEAL_REASON);
         if(reason == DEAL_REASON_SL) ev = GVGet("trailed", 0) != 0 ? "EXIT_TRAIL" : "EXIT_HARDSTOP";
         else if(reason == DEAL_REASON_TP) { ev = "EXIT_TARGET"; GVSet("tp_wait", GVGet("side", 0)); }
         else if(reason == DEAL_REASON_SO) ev = "EXIT_STOPOUT";
         else if(reason == DEAL_REASON_CLIENT || reason == DEAL_REASON_MOBILE || reason == DEAL_REASON_WEB) ev = "EXIT_MANUAL";
         else if(reason == DEAL_REASON_EXPERT && pendingExit > 0) ev = ExitName(pendingExit);   // our retried close went through
         detail = "ticket " + IntegerToString((long)posid) + " closed at " + DoubleToString(HistoryDealGetDouble(d, DEAL_PRICE), _Digits) +
                  ", deal time " + TimeToString((datetime)HistoryDealGetInteger(d, DEAL_TIME), TIME_DATE | TIME_SECONDS);
         found = true;
         break;
        }
   if(!found && posid > 0)
     {
      if(g_dealWaitFrom == 0) g_dealWaitFrom = TimeLocal();
      if(TimeLocal() - g_dealWaitFrom < 60) return false;
     }
   g_dealWaitFrom = 0;
   if(posid > 0) detail += ", profit " + DoubleToString(PositionPnl(posid), 2);
   Journal(ev, detail);
   ClearTradeState();
   return true;
  }

//--- entry limits: daily loss, trades per day ---------------------------
bool EntryAllowed(string &reason)
  {
   double eq = AccountInfoDouble(ACCOUNT_EQUITY);
   double day = (double)(long)(TimeCurrent() / 86400);           // server day
   if(GVGet("day", -1) != day) { GVSet("day", day); GVSet("dayeq", eq); GVSet("daytrades", 0); }
   if(eq < GVGet("dayeq", eq) * (1 - InpDailyLossPct / 100)) { reason = "daily loss limit reached"; return false; }
   if(GVGet("daytrades", 0) >= InpMaxTradesDay) { reason = "max entries for today reached"; return false; }
   if(!TradingSwitchedOn()) { reason = "Algo Trading is switched off in MT5"; return false; }
   return true;
  }

// Minutes since the bar in progress had its first price. Not since its open time: gold's first price of a day comes
// about an hour after the 00:00 bar opens, later after a holiday. 0 if MT5 can't say: the entry goes, as it always did.
int MinutesIntoBar()
  {
   long quote = LastQuoteMs() / 1000;
   MqlRates m[];
   ArraySetAsSeries(m, false);                                    // oldest first
   if(CopyRates(_Symbol, PERIOD_M1, iTime(_Symbol, InpTimeframe, 0), (datetime)quote, m) < 1) return 0;
   return (int)((quote - m[0].time) / 60);
  }

// Sends the entry. Returns true when it should be sent again on the next tick
// (market closed, requote, connection); false when done or given up.
bool OpenPosition(const int dir, const double atr, const datetime sigBar)
  {
   if(!IsDemo()) { Alert("DonchianGold: not a demo account. No order sent."); ExpertRemove(); return false; }
   if(WaitingForQuote()) return true;                              // it stays pending; its stops come from the new quote
   int late = MinutesIntoBar();
   if(late > ENTRY_LATE_MIN)
     {
      Journal("SKIP", (dir == 1 ? "long" : "short") + " entry missed: its bar began " + IntegerToString(late) + " minutes ago");
      return false;
     }
   double eq = AccountInfoDouble(ACCOUNT_EQUITY);
   double stopDist = InpStopAtr * atr;
   double tickSize = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   double tickVal = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
   double contract = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_CONTRACT_SIZE);
   double price = dir == 1 ? SymbolInfoDouble(_Symbol, SYMBOL_ASK) : SymbolInfoDouble(_Symbol, SYMBOL_BID);
   if(tickSize <= 0 || tickVal <= 0 || contract <= 0 || price <= 0 || stopDist <= 0)
      return true;                                                 // symbol data not ready yet

   double step = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   double lots;
   if(InpFixedLots > 0)                                            // the fixed size; over the leverage cap it is not traded, not cut
     {
      lots = MathRound(InpFixedLots / step) * step;
      if(lots * price * contract > eq * InpMaxLeverage) { Journal("SKIP", "fixed size above the leverage cap"); return false; }
     }
   else
     {
      lots = eq * InpRiskPct / 100.0 / (stopDist / tickSize * tickVal);          // 1% of equity to the strategy stop
      lots = MathFloor(MathMin(lots, eq * InpMaxLeverage / (price * contract)) / step) * step;   // leverage cap
     }
   lots = MathMin(lots, SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX));
   if(lots < SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN)) { Journal("SKIP", "position size below the minimum volume"); return false; }
   double cost = NormalizeDouble(0.01 * stopDist / tickSize * tickVal, 2);   // the stop's cost at 0.01 lots (1 oz): a width cap, as in the research
   if(InpMaxStopUsd > 0 && cost > InpMaxStopUsd)
     {
      Journal("SKIP", (dir == 1 ? "long" : "short") + " entry: its stop would cost $" + DoubleToString(cost, 2) + " at 0.01 lots, over the $" +
              DoubleToString(InpMaxStopUsd, 0) + " cap");
      return false;
     }

   double margin = 0;
   ENUM_ORDER_TYPE type = dir == 1 ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
   if(OrderCalcMargin(type, _Symbol, lots, price, margin) && margin > AccountInfoDouble(ACCOUNT_MARGIN_FREE))
     { Journal("SKIP", "not enough free margin for " + DoubleToString(lots, 3) + " lots"); return false; }

   // Every order carries a broker-side stop loss, wider than the close-based strategy stop.
   double minStop = (double)SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL) * _Point;
   double hard = MathMax(InpHardStopAtr * atr, minStop + 10 * _Point);
   double sl = NormalizeDouble(dir == 1 ? price - hard : price + hard, _Digits);
   double tp = InpTpR > 0 ? NormalizeDouble(price + dir * InpTpR * stopDist, _Digits) : 0;

   bool ok = dir == 1 ? trade.Buy(lots, _Symbol, 0, sl, tp, "DG long") : trade.Sell(lots, _Symbol, 0, sl, tp, "DG short");
   if(!ok || trade.ResultRetcode() != TRADE_RETCODE_DONE)
     {
      uint rc = trade.ResultRetcode();
      bool retry = Transient(rc);
      NoteRefusal(rc);
      if(GVGet("entry_err", -1) != rc)                             // one journal row per new problem
        {
         GVSet("entry_err", rc);
         Journal("ERROR", (dir == 1 ? "buy" : "sell") + " failed, retcode " + IntegerToString((int)rc) +
                 " (" + trade.ResultRetcodeDescription() + ")" + (retry ? "; will retry until this bar ends" : "; entry skipped"));
        }
      return retry;
     }
   double fill = trade.ResultPrice() > 0 ? trade.ResultPrice() : price;
   GVSet("stop", fill - dir * stopDist);
   GVSet("sigbar", (double)sigBar);
   GVSet("side", dir);
   GVSet("posid", (double)trade.ResultOrder());                     // a position's id is its opening order's ticket
   GVSet("daytrades", GVGet("daytrades", 0) + 1);
   GVDel("entry_err");
   GlobalVariablesFlush();                                         // on disk now, in case the PC loses power
   Journal(dir == 1 ? "ENTRY_LONG" : "ENTRY_SHORT",
           DoubleToString(lots, 3) + " lots at " + DoubleToString(fill, _Digits) +
           ", strategy stop " + DoubleToString(fill - dir * stopDist, _Digits) +
           ", broker stop " + DoubleToString(sl, _Digits) + ", risk " +
           (InpFixedLots > 0 ? "$" + DoubleToString(lots * stopDist / tickSize * tickVal, 2) : DoubleToString(InpRiskPct, 2) + "%") +
           (tp > 0 ? ", take-profit " + DoubleToString(tp, _Digits) : ""));
   return false;
  }

void ClearEntry() { GVDel("entry_dir"); GVDel("entry_bar"); GVDel("entry_atr"); GVDel("entry_err"); }

// Every tick with a position: its take-profit sits exactly InpTpR x the strategy stop from the real fill, as in the
// research. The order goes out with it measured from the price it was sent at, so a fill a few cents away is put right
// here. Refused for good: the order's own one stays.
void FixTarget(const ulong ticket, const double openPrice)
  {
   if(InpTpR <= 0 || !PositionSelectByTicket(ticket)) return;
   ulong id = (ulong)PositionGetInteger(POSITION_IDENTIFIER);
   double stop = GVGet("stop", 0);
   if(g_tpFixed == id || stop == 0) return;                       // a missing strategy stop is rebuilt at the next bar first
   double sl = PositionGetDouble(POSITION_SL), tp = PositionGetDouble(POSITION_TP);
   double want = NormalizeDouble(openPrice + InpTpR * (openPrice - stop), _Digits);
   if(MathAbs(tp - want) < _Point / 2) { g_tpFixed = id; return; }
   if(WaitingForQuote()) return;
   if(trade.PositionModify(ticket, sl, want) && trade.ResultRetcode() == TRADE_RETCODE_DONE)
     {
      g_tpFixed = id;
      g_tpErr = 0;
      Journal("TARGET", "take-profit moved from " + DoubleToString(tp, _Digits) + " to " + DoubleToString(want, _Digits) + ": " +
              DoubleToString(InpTpR, 1) + " x the strategy stop from the fill at " + DoubleToString(openPrice, _Digits));
      return;
     }
   uint rc = trade.ResultRetcode();
   NoteRefusal(rc);
   if(!Transient(rc)) g_tpFixed = id;                             // refused for good (say, the price is already past it)
   if(g_tpErr != rc)
     {
      g_tpErr = rc;
      Journal("ERROR", "take-profit move to " + DoubleToString(want, _Digits) + " failed, retcode " + IntegerToString((int)rc) +
              " (" + trade.ResultRetcodeDescription() + ")" + (Transient(rc) ? "; will retry" : "; it stays at " + DoubleToString(tp, _Digits)));
     }
  }

// Trailing stop (research/trail_lab.js: chosen on 2023-2024, passed on 2025-2026). Once the best price since the fill
// (a closed bar's high, or low for a short) is InpTrailAtR x the strategy stop in profit, the broker stop follows
// InpTrailDistR x it behind that price. Read from closed bars only, after the newest one has been decided, so a move
// counts from the next bar, as in research/daytrade.js. It only ever tightens and the take-profit stays where it is.
// Worked out afresh each time from the bars, so a restart loses nothing. Price already beyond it (a gap): closed now.
void TrailStop(const ulong ticket, const int side, const double openPrice)
  {
   if(InpTrailAtR <= 0 || !PositionSelectByTicket(ticket)) return;
   double stop = GVGet("stop", 0);
   if(stop == 0) return;                                          // a missing strategy stop is rebuilt at the next bar first
   double risk = MathAbs(openPrice - stop);
   int shift = iBarShift(_Symbol, InpTimeframe, (datetime)PositionGetInteger(POSITION_TIME));   // the bar it was filled in
   if(shift < 1 || risk <= 0) return;                             // that bar has not closed yet
   MqlRates r[];
   if(CopyRates(_Symbol, InpTimeframe, 1, shift, r) != shift) return;   // the closed bars since the fill; history not ready: next tick
   double best = side == 1 ? -DBL_MAX : DBL_MAX;
   for(int i = 0; i < shift; i++) best = side == 1 ? MathMax(best, r[i].high) : MathMin(best, r[i].low);
   if((best - openPrice) * side < InpTrailAtR * risk) return;
   double want = NormalizeDouble(best - side * InpTrailDistR * risk, _Digits);
   double sl = PositionGetDouble(POSITION_SL), tp = PositionGetDouble(POSITION_TP);
   if(sl > 0 && (want - sl) * side < _Point / 2) return;          // only ever tightens
   if(MathAbs(want - g_trailRefused) < _Point / 2) return;        // refused for good at this level
   if(WaitingForQuote()) return;
   double px = side == 1 ? SymbolInfoDouble(_Symbol, SYMBOL_BID) : SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   if(px > 0 && (px - want) * side <= 0) { ClosePosition(ticket, "EXIT_TRAIL"); return; }
   if(trade.PositionModify(ticket, want, tp) && trade.ResultRetcode() == TRADE_RETCODE_DONE)
     {
      GVSet("trailed", 1);
      GlobalVariablesFlush();
      g_trailErr = 0;
      Journal("TRAIL", "stop moved from " + DoubleToString(sl, _Digits) + " to " + DoubleToString(want, _Digits) + ": " +
              DoubleToString(InpTrailDistR, 1) + " x the strategy stop behind the best price " + DoubleToString(best, _Digits));
      return;
     }
   uint rc = trade.ResultRetcode();
   NoteRefusal(rc);
   if(!Transient(rc)) g_trailRefused = want;
   if(g_trailErr != rc)
     {
      g_trailErr = rc;
      Journal("ERROR", "stop move to " + DoubleToString(want, _Digits) + " failed, retcode " + IntegerToString((int)rc) +
              " (" + trade.ResultRetcodeDescription() + ")" + (Transient(rc) ? "; will retry" : "; it stays at " + DoubleToString(sl, _Digits)));
     }
  }

//--- the bar-by-bar decision -------------------------------------------
void Run()
  {
   if(!IsDemo()) { Alert("DonchianGold: not a demo account. Removing the EA."); ExpertRemove(); return; }
   NoteOutage();

   ulong ticket = 0; int side = 0; double openPrice = 0;
   bool has = FindPosition(ticket, side, openPrice);

   string stopWhy = DrawdownStop(InpMaxDrawdownPct);              // sets DG_KILL when the account is too far below its peak
   if(stopWhy != "") Journal("KILL_SWITCH", stopWhy);
   // Kill switch: set global variable DG_KILL = 1 (F3 in MT5) to close and stop.
   if(GlobalVariableCheck("DG_KILL") && GlobalVariableGet("DG_KILL") == 1)
     {
      ClearEntry();
      if(has) ClosePosition(ticket, "KILL_SWITCH");
      return;
     }
   int pendingExit = (int)GVGet("exit_pending", 0);
   if(has && pendingExit > 0) { ClosePosition(ticket, ExitName(pendingExit)); return; }
   if(!has && GVGet("side", 0) != 0 && !ReportOutsideClose(pendingExit)) return;
   if(has) FixTarget(ticket, openPrice);
   if(HistorySettling()) return;                                  // everything above needs no bars, so it never waits

   datetime closed = iTime(_Symbol, InpTimeframe, 1);             // newest CLOSED bar
   if(closed == 0) return;

   // An entry the market refused at the bar's open (closed for the daily break, requote, connection)
   // is sent again on every tick until it goes through or its bar ends.
   int entryDir = (int)GVGet("entry_dir", 0);
   if(entryDir != 0)
     {
      if(has) ClearEntry();                                        // it went through after all
      else if((datetime)GVGet("entry_bar", 0) == closed)
        {
         if(!OpenPosition(entryDir, GVGet("entry_atr", 0), closed)) ClearEntry();
         return;
        }
      else
        {
         Journal("SKIP", (entryDir == 1 ? "long" : "short") + " entry not filled before its bar ended");
         ClearEntry();
        }
     }
   // First start with nothing to manage: that bar's open, where the rules enter, has already passed.
   if(!has && !GlobalVariableCheck(GVP + "lastbar"))
     {
      GVSet("lastbar", (double)closed);
      Journal("WAIT", "first start: acting from the next closed bar, not the " + TimeToString(closed, TIME_DATE | TIME_MINUTES));
      return;
     }
   if((datetime)GVGet("lastbar", 0) == closed)
     {
      if(has) TrailStop(ticket, side, openPrice);                  // only once its newest bar is decided
      return;
     }

   MqlRates r[];
   ArraySetAsSeries(r, false);                                    // oldest first, like the JS arrays
   int n = CopyRates(_Symbol, InpTimeframe, 1, InpCalcBars, r);
   if(n < InpEmaPeriod + InpBreakout + 5 || r[n - 1].time != closed) return;   // history not ready: retry
   GVSet("lastbar", (double)closed);                              // decide once per closed bar
   GlobalVariablesFlush();                                        // on disk now: a crash must not decide this bar again

   double c = r[n - 1].close;
   double ema = EmaLast(r, n, InpEmaPeriod);
   double atr = AtrLast(r, n, InpAtrPeriod);
   double hi, lo, xhi, xlo;
   Channel(r, n, InpBreakout, hi, lo);
   Channel(r, n, InpExit, xhi, xlo);
   string bar = TimeToString(closed, TIME_DATE | TIME_MINUTES) + " close " + DoubleToString(c, _Digits) +
                " ema " + DoubleToString(ema, _Digits) + " atr " + DoubleToString(atr, _Digits) +
                " ch " + DoubleToString(lo, _Digits) + "-" + DoubleToString(hi, _Digits) +
                " exit " + DoubleToString(xlo, _Digits) + "-" + DoubleToString(xhi, _Digits);

   // After a take-profit that side waits for a close back inside the entry channel: the same breakout is not a new one.
   int wait = (int)GVGet("tp_wait", 0);
   if((wait == 1 && c <= hi) || (wait == -1 && c >= lo)) { GVDel("tp_wait"); wait = 0; }

   if(has)
     {
      // State lost (crash before it was saved, new PC): rebuild it from the position itself.
      datetime sig = (datetime)GVGet("sigbar", 0);
      double stop = GVGet("stop", 0);
      if((sig == 0 || stop == 0) && PositionSelectByTicket(ticket))
        {
         if(sig == 0)
           {
            // Bars are counted from the entry bar, so the signal bar is "just before" it.
            datetime opened = (datetime)PositionGetInteger(POSITION_TIME);
            sig = iTime(_Symbol, InpTimeframe, iBarShift(_Symbol, InpTimeframe, opened)) - 1;
            GVSet("sigbar", (double)sig);
            Journal("WARN", "signal bar was missing, rebuilt from the open time " + TimeToString(opened, TIME_DATE | TIME_MINUTES));
           }
         if(stop == 0)
           {
            // The broker stop sits InpHardStopAtr ATRs out and the strategy stop InpStopAtr: scale it back. With the
            // trailing stop on, the broker stop may have moved, so the signal bar's ATR is used instead.
            double sl = PositionGetDouble(POSITION_SL);
            int j = -1;
            for(int i = 0; i < n; i++) if(r[i].time <= sig) j = i;   // the signal bar
            if(InpTrailAtR > 0 && j > InpAtrPeriod) stop = openPrice - side * InpStopAtr * AtrLast(r, j + 1, InpAtrPeriod);
            else stop = sl > 0 ? openPrice - (openPrice - sl) * InpStopAtr / InpHardStopAtr : openPrice - side * InpStopAtr * atr;
            GVSet("stop", stop);
            Journal("WARN", "strategy stop was missing, rebuilt at " + DoubleToString(stop, _Digits));
           }
         GlobalVariablesFlush();
        }
      int bars = 0;
      for(int i = 0; i < n; i++) if(r[i].time > sig) bars++;
      string why = "";
      if(side == 1)
        { if(c <= stop) why = "EXIT_STOP"; else if(c < xlo) why = "EXIT_CHANNEL"; else if(bars >= InpMaxBars) why = "EXIT_TIME"; }
      else
        { if(c >= stop) why = "EXIT_STOP"; else if(c > xhi) why = "EXIT_CHANNEL"; else if(bars >= InpMaxBars) why = "EXIT_TIME"; }
      Journal("BAR", bar + " | " + (side == 1 ? "LONG" : "SHORT") + " bars " + IntegerToString(bars) +
              " stop " + DoubleToString(stop, _Digits) + (why == "" ? " | hold" : " | " + why));
      if(why != "") ClosePosition(ticket, why);
      else TrailStop(ticket, side, openPrice);
      return;
     }

   int dir = 0;
   if(InpAllowLong && c > hi && c > ema && wait != 1) dir = 1;
   else if(InpAllowShort && c < lo && c < ema && wait != -1) dir = -1;
   Journal("BAR", bar + " | FLAT" + (dir == 1 ? " | long signal" : dir == -1 ? " | short signal" : "") + (wait != 0 ? " | waiting after a take-profit" : ""));
   if(dir == 0) return;

   string reason = "";
   if(!EntryAllowed(reason)) { Journal("SKIP", reason); return; }
   if(OpenPosition(dir, atr, closed)) { GVSet("entry_dir", dir); GVSet("entry_bar", (double)closed); GVSet("entry_atr", atr); GlobalVariablesFlush(); }
  }

//--- MT5 events ---------------------------------------------------------
int OnInit()
  {
   GVP = "DG_" + IntegerToString(InpMagic) + "_";
   if(!IsDemo())
     {
      Alert("DonchianGold refuses to run: this is not a demo account.");
      return INIT_FAILED;
     }
   if(StringFind(_Symbol, "XAU") != 0)
     {
      Alert("DonchianGold trades gold only; it is attached to " + _Symbol + ". Attach it to an XAUUSD chart.");
      return INIT_FAILED;
     }
   if(InpFixedLots != 0 && InpFixedLots < 0.01)
      return INIT_PARAMETERS_INCORRECT;                            // a fixed size is never below 0.01 lots
   if(InpTpR < 0 || InpMaxStopUsd < 0 || InpTrailAtR < 0 || (InpTrailAtR > 0 && InpTrailDistR <= 0)) return INIT_PARAMETERS_INCORRECT;
   if(InpBreakout < 2 || InpExit < 1 || InpEmaPeriod < 2 || InpAtrPeriod < 1 ||
      InpCalcBars < InpEmaPeriod + InpBreakout + 10 || InpRiskPct <= 0 || InpRiskPct > 2 || InpStopAtr <= 0 || InpMaxDrawdownPct < 0 || InpMaxDrawdownPct > 50)
      return INIT_PARAMETERS_INCORRECT;                            // risk above 2% is refused outright
   trade.SetExpertMagicNumber(InpMagic);
   trade.SetDeviationInPoints(InpDeviationPts);
   trade.SetTypeFillingBySymbol(_Symbol);
   trade.LogLevel(LOG_LEVEL_NO);                                   // the journal records every failure once
   GVDel("entry_err"); GVDel("exit_err");                           // report a problem that is still there after a restart
   g_waitQuote = LastQuoteMs();                                     // a pending order waits for a quote from after this start
   g_waitSaid = false;
   g_settleFrom = g_lastRun = TimeLocal();                          // MT5 may still be catching up on bars
   EventSetTimer(30);
   Journal("START", _Symbol + " " + EnumToString(InpTimeframe) + ", long " + (InpAllowLong ? "on" : "off") +
           ", short " + (InpAllowShort ? "on" : "off") + (InpFixedLots > 0 ? ", fixed " + DoubleToString(InpFixedLots, 3) + " lots" : ", risk " + DoubleToString(InpRiskPct, 2) + "%") + ", take-profit " + DoubleToString(InpTpR, 1) + "R from the fill" +
           (InpMaxStopUsd > 0 ? ", no stop over $" + DoubleToString(InpMaxStopUsd, 0) : "") +
           (InpTrailAtR > 0 ? ", stop trails " + DoubleToString(InpTrailDistR, 1) + "R behind from +" + DoubleToString(InpTrailAtR, 1) + "R" : "") +
           (InpMaxDrawdownPct > 0 ? ", account stop " + DoubleToString(InpMaxDrawdownPct, 0) + "% below the peak" : "") +
           ", demo account " + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)));
   return INIT_SUCCEEDED;
  }

void OnDeinit(const int reason) { EventKillTimer(); Journal("STOP", "reason " + IntegerToString(reason)); }
void OnTick()  { Run(); }
void OnTimer()
  {
   Run();
   string problem = SheetSync("DonchianGold", JOURNAL, InpMagic, InpMagic);     // results to the Google Sheet
   if(problem != "") Journal("WARN", problem);
  }
//+------------------------------------------------------------------+
