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
//| every order carries a broker stop loss, one position at a time,  |
//| no averaging down, no martingale, daily loss limit, kill switch. |
//+------------------------------------------------------------------+
#property copyright   "Donchian Analyst (personal research)"
#property version     "1.00"
#property description "Donchian breakout on gold, long and short. Demo accounts only."

#include <Trade\Trade.mqh>

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
input double InpRiskPct      = 1.0;  // % of equity lost if the strategy stop is hit
input double InpMaxLeverage  = 2.0;  // Position value capped at equity x this
input double InpHardStopAtr  = 4.0;  // Broker stop loss, ATRs from the fill (catastrophe stop)
input double InpDailyLossPct = 3.0;  // No new entries after equity falls this % in a server day
input int    InpMaxTradesDay = 2;    // Max entries per server day

input group "Housekeeping"
input long   InpMagic        = 20261009; // Identifies this EA's positions
input int    InpCalcBars     = 1000;     // Closed bars used for the indicators
input int    InpDeviationPts = 50;       // Max price deviation for market orders, points

CTrade trade;
string GVP;                    // global-variable prefix, per magic number
const string JOURNAL = "DonchianGold_journal.csv";

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
        }
      found++;
     }
   if(found > 1) Journal("WARN", IntegerToString(found) + " positions with this magic number; managing one");
   return found > 0;
  }

void ClosePosition(const ulong ticket, const string why)
  {
   if(trade.PositionClose(ticket, InpDeviationPts) && trade.ResultRetcode() == TRADE_RETCODE_DONE)
     {
      Journal(why, "closed ticket " + IntegerToString((long)ticket) + " at " + DoubleToString(trade.ResultPrice(), _Digits));
      GVDel("stop"); GVDel("sigbar"); GVDel("side"); GVDel("exit_pending");
     }
   else
     {
      // Keep trying on every tick until the position is gone: an exit is never skipped.
      GVSet("exit_pending", 1);
      Journal("ERROR", why + " close failed, retcode " + IntegerToString((int)trade.ResultRetcode()) +
              " (" + trade.ResultRetcodeDescription() + "); will retry");
     }
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

void OpenPosition(const int dir, const double atr, const datetime sigBar)
  {
   if(!IsDemo()) { Alert("DonchianGold: not a demo account. No order sent."); ExpertRemove(); return; }
   double eq = AccountInfoDouble(ACCOUNT_EQUITY);
   double stopDist = InpStopAtr * atr;
   double tickSize = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   double tickVal = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
   double contract = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_CONTRACT_SIZE);
   double price = dir == 1 ? SymbolInfoDouble(_Symbol, SYMBOL_ASK) : SymbolInfoDouble(_Symbol, SYMBOL_BID);
   if(tickSize <= 0 || tickVal <= 0 || contract <= 0 || price <= 0 || stopDist <= 0)
     { Journal("SKIP", "symbol data not ready"); return; }

   double lots = eq * InpRiskPct / 100.0 / (stopDist / tickSize * tickVal);    // 1% of equity to the strategy stop
   lots = MathMin(lots, eq * InpMaxLeverage / (price * contract));              // leverage cap
   double step = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   lots = MathMin(MathFloor(lots / step) * step, SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX));
   if(lots < SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN)) { Journal("SKIP", "position size below the minimum volume"); return; }

   double margin = 0;
   ENUM_ORDER_TYPE type = dir == 1 ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
   if(OrderCalcMargin(type, _Symbol, lots, price, margin) && margin > AccountInfoDouble(ACCOUNT_MARGIN_FREE))
     { Journal("SKIP", "not enough free margin for " + DoubleToString(lots, 3) + " lots"); return; }

   // Every order carries a broker-side stop loss, wider than the close-based strategy stop.
   double minStop = (double)SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL) * _Point;
   double hard = MathMax(InpHardStopAtr * atr, minStop + 10 * _Point);
   double sl = NormalizeDouble(dir == 1 ? price - hard : price + hard, _Digits);

   bool ok = dir == 1 ? trade.Buy(lots, _Symbol, 0, sl, 0, "DG long") : trade.Sell(lots, _Symbol, 0, sl, 0, "DG short");
   if(!ok || trade.ResultRetcode() != TRADE_RETCODE_DONE)
     {
      Journal("ERROR", (dir == 1 ? "buy" : "sell") + " failed, retcode " + IntegerToString((int)trade.ResultRetcode()) +
              " (" + trade.ResultRetcodeDescription() + ")");
      return;
     }
   double fill = trade.ResultPrice() > 0 ? trade.ResultPrice() : price;
   GVSet("stop", fill - dir * stopDist);
   GVSet("sigbar", (double)sigBar);
   GVSet("side", dir);
   GVSet("daytrades", GVGet("daytrades", 0) + 1);
   Journal(dir == 1 ? "ENTRY_LONG" : "ENTRY_SHORT",
           DoubleToString(lots, 3) + " lots at " + DoubleToString(fill, _Digits) +
           ", strategy stop " + DoubleToString(fill - dir * stopDist, _Digits) +
           ", broker stop " + DoubleToString(sl, _Digits) + ", risk " + DoubleToString(InpRiskPct, 2) + "%");
  }

//--- the bar-by-bar decision -------------------------------------------
void Run()
  {
   if(!IsDemo()) { Alert("DonchianGold: not a demo account. Removing the EA."); ExpertRemove(); return; }

   ulong ticket = 0; int side = 0; double openPrice = 0;
   bool has = FindPosition(ticket, side, openPrice);

   // Kill switch: set global variable DG_KILL = 1 (F3 in MT5) to close and stop.
   if(GlobalVariableCheck("DG_KILL") && GlobalVariableGet("DG_KILL") == 1)
     {
      if(has) ClosePosition(ticket, "KILL_SWITCH");
      return;
     }
   if(has && GVGet("exit_pending", 0) == 1) { ClosePosition(ticket, "EXIT_RETRY"); return; }
   if(!has && GVGet("exit_pending", 0) == 1) GVDel("exit_pending");

   datetime closed = iTime(_Symbol, InpTimeframe, 1);             // newest CLOSED bar
   if(closed == 0 || (datetime)GVGet("lastbar", 0) == closed) return;

   MqlRates r[];
   ArraySetAsSeries(r, false);                                    // oldest first, like the JS arrays
   int n = CopyRates(_Symbol, InpTimeframe, 1, InpCalcBars, r);
   if(n < InpEmaPeriod + InpBreakout + 5 || r[n - 1].time != closed) return;   // history not ready: retry
   GVSet("lastbar", (double)closed);                              // decide once per closed bar

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

   if(has)
     {
      int bars = 0;
      datetime sig = (datetime)GVGet("sigbar", 0);
      for(int i = 0; i < n; i++) if(r[i].time > sig) bars++;
      double stop = GVGet("stop", 0);
      if(stop == 0)
        {
         stop = openPrice - side * InpStopAtr * atr;               // state lost (e.g. new PC): rebuild
         GVSet("stop", stop);
         Journal("WARN", "strategy stop was missing, rebuilt at " + DoubleToString(stop, _Digits));
        }
      string why = "";
      if(side == 1)
        { if(c <= stop) why = "EXIT_STOP"; else if(c < xlo) why = "EXIT_CHANNEL"; else if(bars >= InpMaxBars) why = "EXIT_TIME"; }
      else
        { if(c >= stop) why = "EXIT_STOP"; else if(c > xhi) why = "EXIT_CHANNEL"; else if(bars >= InpMaxBars) why = "EXIT_TIME"; }
      Journal("BAR", bar + " | " + (side == 1 ? "LONG" : "SHORT") + " bars " + IntegerToString(bars) +
              " stop " + DoubleToString(stop, _Digits) + (why == "" ? " | hold" : " | " + why));
      if(why != "") ClosePosition(ticket, why);
      return;
     }

   int dir = 0;
   if(InpAllowLong && c > hi && c > ema) dir = 1;
   else if(InpAllowShort && c < lo && c < ema) dir = -1;
   Journal("BAR", bar + " | FLAT" + (dir == 1 ? " | long signal" : dir == -1 ? " | short signal" : ""));
   if(dir == 0) return;

   string reason = "";
   if(!EntryAllowed(reason)) { Journal("SKIP", reason); return; }
   OpenPosition(dir, atr, closed);
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
   if(InpBreakout < 2 || InpExit < 1 || InpEmaPeriod < 2 || InpAtrPeriod < 1 ||
      InpCalcBars < InpEmaPeriod + InpBreakout + 10 || InpRiskPct <= 0 || InpRiskPct > 2 || InpStopAtr <= 0)
      return INIT_PARAMETERS_INCORRECT;                            // risk above 2% is refused outright
   trade.SetExpertMagicNumber(InpMagic);
   trade.SetDeviationInPoints(InpDeviationPts);
   trade.SetTypeFillingBySymbol(_Symbol);
   EventSetTimer(30);
   Journal("START", _Symbol + " " + EnumToString(InpTimeframe) + ", long " + (InpAllowLong ? "on" : "off") +
           ", short " + (InpAllowShort ? "on" : "off") + ", risk " + DoubleToString(InpRiskPct, 2) +
           "%, demo account " + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)));
   return INIT_SUCCEEDED;
  }

void OnDeinit(const int reason) { EventKillTimer(); Journal("STOP", "reason " + IntegerToString(reason)); }
void OnTick()  { Run(); }
void OnTimer() { Run(); }
//+------------------------------------------------------------------+
