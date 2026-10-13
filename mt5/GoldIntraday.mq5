//+------------------------------------------------------------------+
//| GoldIntraday.mq5                                                 |
//| Six intraday gold strategies on M15, every trade flat before the |
//| daily rollover. DEMO ACCOUNTS ONLY.                               |
//|                                                                  |
//| The portfolio mirrors research/intraday.js (chosen on 2023-2024  |
//| data only): New York opening-range breakout, Asian range         |
//| breakout on narrow nights, Dual Thrust, R-Breaker and two        |
//| intraday-momentum entries. The ORB, R-Breaker and momentum ones  |
//| only trade with the H4 trend.                                    |
//|                                                                  |
//| Breakout entries rest at the broker as stop orders, so they      |
//| trigger on the server without this PC's network delay; Dual      |
//| Thrust's stop-and-reverse is the opposite stop order at its stop.|
//| The other entries are market orders at a bar's open.             |
//|                                                                  |
//| Each strategy has its own magic number (base + 1..6) and at most |
//| one position. Every order carries its stop loss at the broker;  |
//| 0.25% risk per trade, no averaging down, no martingale, daily    |
//| loss limit, kill switch (global variable DG_KILL = 1, shared    |
//| with DonchianGold). Everything it needs is rebuilt from prices   |
//| and the account on a restart.                                    |
//|                                                                  |
//| Parity: research/parity_intraday.js after a Strategy Tester run  |
//| (M15, 1 minute OHLC).                                            |
//+------------------------------------------------------------------+
#property copyright   "Donchian Analyst (personal research)"
#property version     "1.10"
#property description "Six intraday gold strategies, flat before the rollover. Demo accounts only."

#include <Trade\Trade.mqh>
#include "SheetSync.mqh"

input group "Portfolio (must match research/intraday.js)"
input bool   InpNyOrb      = true;     // 1 New York ORB 16:30-17:00, with the H4 trend
input bool   InpAsian      = true;     // 2 Asian range breakout, narrow nights only
input bool   InpDualThrust = true;     // 3 Dual Thrust (4 days, k 0.5), stop and reverse
input bool   InpRBreaker   = true;     // 4 R-Breaker, with the H4 trend
input bool   InpMom16      = true;     // 5 Intraday momentum at 16:00, with the H4 trend
input bool   InpMom20      = true;     // 6 Intraday momentum at 20:00, with the H4 trend
input double InpNarrow     = 0.345104; // Narrow night: Asian range / daily ATR below this (2023-2024 median)

input group "Risk limits"
input double InpRiskPct      = 0.25;   // % of equity lost if a trade's stop is hit
input double InpMaxLeverage  = 3.0;    // One position's value capped at equity x this
input double InpDailyLossPct = 2.0;    // No new entries after equity falls this % in a server day

input group "Risk per strategy (x the risk above; 1 = the same, 0.5 = half)"
input double InpWNyOrb      = 1.0;     // 1 New York ORB
input double InpWAsian      = 1.0;     // 2 Asian range breakout
input double InpWDualThrust = 1.0;     // 3 Dual Thrust
input double InpWRBreaker   = 1.0;     // 4 R-Breaker
input double InpWMom16      = 1.0;     // 5 Momentum at 16:00
input double InpWMom20      = 1.0;     // 6 Momentum at 20:00

input group "Housekeeping"
input long   InpMagicBase    = 20261013; // Strategy k trades with magic number base + k
input int    InpDeviationPts = 50;       // Max price deviation for market orders, points

#define NS 7                                        // strategies 1..6; index 0 = the EA itself
string NAMES[NS]  = { "ALL", "NY_ORB", "ASIAN_NARROW", "DUAL_THRUST", "R_BREAKER", "MOM_16", "MOM_20" };
int    MAXDAY[NS] = { 0, 1, 1, 3, 2, 1, 1 };       // entries per server day, as in the research
const int FLAT = 23 * 60;                           // flat from 23:00 server time, an hour before the rollover
string JOURNAL = "GoldIntraday_journal.csv";        // in the tester: one file per run, named by its start date

CTrade trade;
string GVP;

//--- today's levels, rebuilt from the daily bars ---------------------------
struct DayInfo
  {
   long   day;
   bool   ok, dtOk;
   double open, atrPrev, pH, pL, pC, dtUp, dtDn;
  };
DayInfo g_day;

// A breakout entry the strategy wants in place (index [k][0] buy, [k][1] sell), set each M15 bar.
// It rests at the broker as a stop order; `placed` = it is (or was) there, so if it disappears it filled or
// lapsed; `watch` = the broker refused it, so the EA watches the level itself.
struct Want
  {
   bool   on, placed, watch;
   bool   chase;                                    // a level already passed may be taken at market: only on the
                                                    // bar that first sets the order (the research's gap fill)
   double level, sl;                                // on the broker's price grid
   int    until;                                    // minute of the day it lapses
   int    sends;                                    // orders sent for it (a guard against a resend loop)
  };
Want     g_want[NS][2];

int      g_trades[NS];                 // entries today, per strategy (from the deal history)
long     g_tradesDay = -1;
// A market entry decided at a bar's open and still to be sent (retried until that bar ends).
int      g_qDir[NS];
double   g_qSl[NS], g_qDist[NS];
datetime g_qBar[NS];
string   g_qWhy[NS];
string   g_exitWhy[NS];                // an exit the EA is still trying to make ("" = none)
uint     g_lastErr[NS];                // last failure journaled, per strategy (one row per new problem)
long     g_skipDay[NS];                // last day a "too small to trade" skip was journaled
ulong    g_posId[NS];                  // the position each strategy holds (mirrored in global variables)
int      g_side[NS];
long     g_flatDay = -1;
int      g_flatMin = 23 * 60;
bool     g_armed = false;              // the wants are set for the bar in progress (false right after a start)
bool     g_noChase = false;            // armed mid-bar after a start: a level already passed is not chased

//--- small helpers ----------------------------------------------------------
double GVGet(const string name, const double def) { string k = GVP + name; return GlobalVariableCheck(k) ? GlobalVariableGet(k) : def; }
void   GVSet(const string name, const double v)   { GlobalVariableSet(GVP + name, v); }
void   GVDel(const string name)                   { GlobalVariableDel(GVP + name); }
int    MinOfDay(const datetime t) { return (int)(((long)t % 86400) / 60); }
long   DayOf(const datetime t)    { return (long)t / 86400; }
long   Magic(const int k)         { return InpMagicBase + k; }
string Px(const double p)         { return DoubleToString(p, _Digits); }
string Hm(const int m)            { return StringFormat("%02d:%02d", m / 60, m % 60); }

// Strategy k's share of InpRiskPct.
double Weight(const int k)
  {
   switch(k)
     {
      case 1: return InpWNyOrb;
      case 2: return InpWAsian;
      case 3: return InpWDualThrust;
      case 4: return InpWRBreaker;
      case 5: return InpWMom16;
      case 6: return InpWMom20;
     }
   return 1;
  }
string RiskText(const int k) { return DoubleToString(InpRiskPct * Weight(k), 3) + "%"; }

bool IsDemo()
  {
   if(MQLInfoInteger(MQL_TESTER)) return true;
   return AccountInfoInteger(ACCOUNT_TRADE_MODE) == ACCOUNT_TRADE_MODE_DEMO;
  }

bool TradingSwitchedOn() { return TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) && MQLInfoInteger(MQL_TRADE_ALLOWED); }

// Failures caused by the market or the connection, not by the order: worth sending again.
bool Transient(const uint rc)
  {
   return rc == TRADE_RETCODE_MARKET_CLOSED || rc == TRADE_RETCODE_REQUOTE || rc == TRADE_RETCODE_PRICE_CHANGED ||
          rc == TRADE_RETCODE_PRICE_OFF || rc == TRADE_RETCODE_TIMEOUT || rc == TRADE_RETCODE_CONNECTION ||
          rc == TRADE_RETCODE_TOO_MANY_REQUESTS || rc == TRADE_RETCODE_REJECT || rc == 0;
  }

// One CSV row per decision: server_time, strategy, event, equity, detail.
void Journal(const int k, const string event, const string detail)
  {
   int h = FileOpen(JOURNAL, FILE_READ | FILE_WRITE | FILE_CSV | FILE_ANSI | FILE_SHARE_READ, ',');
   if(h == INVALID_HANDLE) { Print("GoldIntraday: journal not writable, error ", GetLastError()); return; }
   if(FileSize(h) == 0) FileWrite(h, "server_time", "strategy", "event", "equity", "detail");
   FileSeek(h, 0, SEEK_END);
   FileWrite(h, TimeToString(TimeCurrent(), TIME_DATE | TIME_SECONDS), NAMES[k], event,
             DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY), 2), detail);
   FileClose(h);
   Print("GoldIntraday ", NAMES[k], " ", event, ": ", detail);
  }

void JournalFailure(const int k, const string what)
  {
   uint rc = trade.ResultRetcode();
   if(g_lastErr[k] == rc) return;
   g_lastErr[k] = rc;
   Journal(k, "ERROR", what + " failed, retcode " + IntegerToString((int)rc) + " (" + trade.ResultRetcodeDescription() + ")" +
           (Transient(rc) ? "; will retry" : ""));
  }

//--- indicators, identical to research/intraday.js ---------------------------
double TrueRange(const MqlRates &r[], const int i)
  {
   if(i == 0) return r[0].high - r[0].low;
   double pc = r[i - 1].close;
   return MathMax(r[i].high - r[i].low, MathMax(MathAbs(r[i].high - pc), MathAbs(r[i].low - pc)));
  }

// EMA seeded with the SMA of the first `period` closes; value at bar n-1.
double EmaLast(const MqlRates &r[], const int n, const int period)
  {
   double sum = 0;
   for(int i = 0; i < period; i++) sum += r[i].close;
   double prev = sum / period, k = 2.0 / (period + 1);
   for(int i = period; i < n; i++) prev = r[i].close * k + prev * (1 - k);
   return prev;
  }

// Wilder ATR: seed = average TR of bars 1..period, then (prev*(p-1)+TR)/p; value at bar n-1.
double AtrLast(const MqlRates &r[], const int n, const int period)
  {
   double sum = 0;
   for(int i = 1; i <= period; i++) sum += TrueRange(r, i);
   double prev = sum / period;
   for(int i = period + 1; i < n; i++) prev = (prev * (period - 1) + TrueRange(r, i)) / period;
   return prev;
  }

// The proven H4 trend at an M15 bar: the H4 bar BEFORE the one holding it, close vs EMA100 (+1 up, -1 down).
int TrendAt(const datetime barTime)
  {
   datetime h4 = barTime - (datetime)((long)barTime % (4 * 3600));
   int sh = iBarShift(_Symbol, PERIOD_H4, h4, false);
   if(sh < 0) return 0;
   MqlRates r[];
   ArraySetAsSeries(r, false);
   int n = CopyRates(_Symbol, PERIOD_H4, sh + 1, 600, r);
   if(n < 101) return 0;
   return r[n - 1].close > EmaLast(r, n, 100) ? 1 : -1;
  }

// Today's levels from the daily bars: open, ATR(14) of the days before, yesterday's H/L/C, Dual Thrust triggers.
bool LoadDay(const long day)
  {
   if(g_day.day == day && g_day.ok) return true;
   MqlRates d[];
   ArraySetAsSeries(d, false);
   int n = CopyRates(_Symbol, PERIOD_D1, 0, 400, d);
   if(n < 30 || DayOf(d[n - 1].time) != day) return false;     // today's daily bar not there yet
   g_day.day = day;
   g_day.open = d[n - 1].open;
   g_day.atrPrev = AtrLast(d, n - 1, 14);
   g_day.pH = d[n - 2].high; g_day.pL = d[n - 2].low; g_day.pC = d[n - 2].close;
   double HH = -DBL_MAX, LL = DBL_MAX, HC = -DBL_MAX, LC = DBL_MAX;
   for(int j = n - 5; j <= n - 2; j++)
     { HH = MathMax(HH, d[j].high); LL = MathMin(LL, d[j].low); HC = MathMax(HC, d[j].close); LC = MathMin(LC, d[j].close); }
   double range = MathMax(HH - LC, HC - LL);
   g_day.dtUp = g_day.open + 0.5 * range;
   g_day.dtDn = g_day.open - 0.5 * range;
   g_day.dtOk = range > 0;
   g_day.ok = true;
   Journal(0, "DAY", "open " + Px(g_day.open) + ", daily ATR " + Px(g_day.atrPrev) + ", Dual Thrust " + Px(g_day.dtDn) + "-" + Px(g_day.dtUp) +
           ", yesterday H/L/C " + Px(g_day.pH) + "/" + Px(g_day.pL) + "/" + Px(g_day.pC));
   return true;
  }

// High and low of today's closed M15 bars from minute `from` (inclusive) to `to` (exclusive); returns the bar count.
// lastSeen: whether the bar starting at to-15 is among them (the research decides on that bar's close).
int RangeOf(const long day, const int from, const int to, double &hi, double &lo, bool &lastSeen)
  {
   MqlRates r[];
   ArraySetAsSeries(r, false);
   int n = CopyRates(_Symbol, PERIOD_M15, 1, 100, r), cnt = 0;
   hi = -DBL_MAX; lo = DBL_MAX; lastSeen = false;
   for(int i = 0; i < n; i++)
     {
      int m = MinOfDay(r[i].time);
      if(DayOf(r[i].time) != day || m < from || m >= to) continue;
      hi = MathMax(hi, r[i].high); lo = MathMin(lo, r[i].low); cnt++;
      if(m == to - 15) lastSeen = true;
     }
   return cnt;
  }

//--- positions and orders, by strategy ----------------------------------------
bool FindPos(const int k, ulong &ticket, int &side, datetime &opened)
  {
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong t = PositionGetTicket(i);
      if(t == 0 || !PositionSelectByTicket(t)) continue;
      if(PositionGetString(POSITION_SYMBOL) != _Symbol || PositionGetInteger(POSITION_MAGIC) != Magic(k)) continue;
      ticket = t;
      side = PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY ? 1 : -1;
      opened = (datetime)PositionGetInteger(POSITION_TIME);
      return true;
     }
   return false;
  }
bool HasPos(const int k) { ulong t; int s; datetime o; return FindPos(k, t, s, o); }

bool PosOpen(const ulong id)
  {
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong t = PositionGetTicket(i);
      if(t != 0 && PositionSelectByTicket(t) && (ulong)PositionGetInteger(POSITION_IDENTIFIER) == id) return true;
     }
   return false;
  }

// Strategy k's resting stop order on one side (0 buy, 1 sell); 0 if none.
ulong FindOrder(const int k, const int s, double &price, double &sl)
  {
   ENUM_ORDER_TYPE want = s == 0 ? ORDER_TYPE_BUY_STOP : ORDER_TYPE_SELL_STOP;
   for(int i = OrdersTotal() - 1; i >= 0; i--)
     {
      ulong t = OrderGetTicket(i);
      if(t == 0 || OrderGetString(ORDER_SYMBOL) != _Symbol || OrderGetInteger(ORDER_MAGIC) != Magic(k)) continue;
      if((ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE) != want) continue;
      price = OrderGetDouble(ORDER_PRICE_OPEN); sl = OrderGetDouble(ORDER_SL);
      return t;
     }
   return 0;
  }

void DeleteOrders(const int k)
  {
   for(int s = 0; s < 2; s++)
     {
      double p, sl;
      ulong t = FindOrder(k, s, p, sl);
      if(t != 0 && !trade.OrderDelete(t)) JournalFailure(k, "cancel order");
     }
  }

// Entries today per strategy, counted from the deal history (survives restarts).
void CountTrades()
  {
   long today = DayOf(TimeCurrent());
   g_tradesDay = today;
   ArrayInitialize(g_trades, 0);
   if(!HistorySelect((datetime)(today * 86400), TimeCurrent() + 86400)) return;
   for(int i = HistoryDealsTotal() - 1; i >= 0; i--)
     {
      ulong d = HistoryDealGetTicket(i);
      if(HistoryDealGetString(d, DEAL_SYMBOL) != _Symbol || HistoryDealGetInteger(d, DEAL_ENTRY) != DEAL_ENTRY_IN) continue;
      long k = HistoryDealGetInteger(d, DEAL_MAGIC) - InpMagicBase;
      if(k >= 1 && k < NS) g_trades[(int)k]++;
     }
  }

bool EntryAllowed(string &reason)
  {
   double eq = AccountInfoDouble(ACCOUNT_EQUITY);
   double day = (double)DayOf(TimeCurrent());
   if(GVGet("day", -1) != day) { GVSet("day", day); GVSet("dayeq", eq); }
   if(eq < GVGet("dayeq", eq) * (1 - InpDailyLossPct / 100)) { reason = "daily loss limit reached"; return false; }
   if(!TradingSwitchedOn()) { reason = "Algo Trading is switched off in MT5"; return false; }
   return true;
  }

// Lots so that strategy k's stop costs its share of InpRiskPct, capped by leverage and the broker's volume limits.
double LotsFor(const int k, const double dist, const double price, string &reason)
  {
   double tickSize = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   double tickVal = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
   double contract = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_CONTRACT_SIZE);
   if(tickSize <= 0 || tickVal <= 0 || contract <= 0 || price <= 0 || dist <= 0) { reason = "symbol data not ready"; return 0; }
   double eq = AccountInfoDouble(ACCOUNT_EQUITY);
   double lots = eq * InpRiskPct * Weight(k) / 100.0 / (dist / tickSize * tickVal);
   lots = MathMin(lots, eq * InpMaxLeverage / (price * contract));
   double step = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   lots = MathMin(MathFloor(lots / step) * step, SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX));
   if(lots < SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN)) { reason = "position size below the minimum volume"; return 0; }
   return lots;
  }

void Remember(const int k, const ulong id, const int dir)
  {
   g_posId[k] = id;
   g_side[k] = dir;
   GVSet("pos" + IntegerToString(k), (double)id);
   GVSet("side" + IntegerToString(k), dir);
   GlobalVariablesFlush();
  }

// Market entry for strategy k with its stop at slAbs, or stopDist from the price when slAbs is 0.
// Returns true when it should be sent again on the next tick (market closed, requote, connection).
bool Enter(const int k, const int dir, const double slAbs, const double stopDist, const string why)
  {
   if(!IsDemo()) { Alert("GoldIntraday: not a demo account. No order sent."); ExpertRemove(); return false; }
   string reason = "";
   if(!EntryAllowed(reason)) { Journal(k, "SKIP", reason); return false; }
   double price = dir == 1 ? SymbolInfoDouble(_Symbol, SYMBOL_ASK) : SymbolInfoDouble(_Symbol, SYMBOL_BID);
   if(price <= 0) return true;
   double sl = NormalizeDouble(slAbs > 0 ? slAbs : price - dir * stopDist, _Digits);
   double dist = (price - sl) * dir;
   double minStop = (double)SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL) * _Point;
   if(dist <= minStop) { Journal(k, "SKIP", "price " + Px(price) + " already at or beyond the stop " + Px(sl)); return false; }
   double lots = LotsFor(k, dist, price, reason);
   if(lots <= 0) { if(reason == "symbol data not ready") return true; Journal(k, "SKIP", reason); return false; }
   double margin = 0;
   if(OrderCalcMargin(dir == 1 ? ORDER_TYPE_BUY : ORDER_TYPE_SELL, _Symbol, lots, price, margin) && margin > AccountInfoDouble(ACCOUNT_MARGIN_FREE))
     { Journal(k, "SKIP", "not enough free margin for " + DoubleToString(lots, 3) + " lots"); return false; }

   trade.SetExpertMagicNumber(Magic(k));
   bool ok = dir == 1 ? trade.Buy(lots, _Symbol, 0, sl, 0, NAMES[k]) : trade.Sell(lots, _Symbol, 0, sl, 0, NAMES[k]);
   if(!ok || trade.ResultRetcode() != TRADE_RETCODE_DONE)
     {
      JournalFailure(k, dir == 1 ? "buy" : "sell");
      return Transient(trade.ResultRetcode());
     }
   double fill = trade.ResultPrice() > 0 ? trade.ResultPrice() : price;
   g_trades[k]++;
   g_lastErr[k] = 0;
   Remember(k, trade.ResultOrder(), dir);                         // a position's id is its opening order's ticket
   Journal(k, dir == 1 ? "ENTRY_LONG" : "ENTRY_SHORT", why + ": " + DoubleToString(lots, 3) + " lots at " + Px(fill) +
           ", stop " + Px(sl) + ", risk " + RiskText(k));
   return false;
  }

// A stop order resting at the broker. Returns 0 placed, 1 no trade (skip), 2 refused (watch it here
// instead), 3 failed for a passing reason (try again next tick).
int PlaceStop(const int k, const int s, const Want &w)
  {
   if(!IsDemo()) { Alert("GoldIntraday: not a demo account. No order sent."); ExpertRemove(); return 1; }
   int dir = s == 0 ? 1 : -1;
   string reason = "";
   double lots = LotsFor(k, MathAbs(w.level - w.sl), w.level, reason);
   if(lots <= 0)
     {
      long today = DayOf(TimeCurrent());                          // asked again every bar: say it once a day
      if(g_skipDay[k] != today) { g_skipDay[k] = today; Journal(k, "SKIP", reason + " (stop " + Px(MathAbs(w.level - w.sl)) + " away)"); }
      return 1;
     }
   double level = w.level, sl = w.sl;
   // Let the broker cancel it at `until` too, unless that is too close to be accepted (the EA cancels it anyway).
   datetime exp = (datetime)(DayOf(TimeCurrent()) * 86400 + w.until * 60);
   bool timed = (SymbolInfoInteger(_Symbol, SYMBOL_EXPIRATION_MODE) & SYMBOL_EXPIRATION_SPECIFIED) != 0 && exp - TimeCurrent() > 300;
   trade.SetExpertMagicNumber(Magic(k));
   bool ok = dir == 1 ? trade.BuyStop(lots, level, _Symbol, sl, 0, timed ? ORDER_TIME_SPECIFIED : ORDER_TIME_GTC, timed ? exp : 0, NAMES[k])
                      : trade.SellStop(lots, level, _Symbol, sl, 0, timed ? ORDER_TIME_SPECIFIED : ORDER_TIME_GTC, timed ? exp : 0, NAMES[k]);
   uint rc = trade.ResultRetcode();
   if(ok && (rc == TRADE_RETCODE_DONE || rc == TRADE_RETCODE_PLACED))
     {
      g_lastErr[k] = 0;
      Journal(k, "ORDER", (dir == 1 ? "buy" : "sell") + " stop at " + Px(level) + ", stop loss " + Px(sl) + ", " +
              DoubleToString(lots, 3) + " lots, until " + Hm(w.until));
      return 0;
     }
   if(rc != TRADE_RETCODE_MARKET_CLOSED) JournalFailure(k, (dir == 1 ? "buy" : "sell") + " stop order");   // closed: the 01:00 open, expected
   return Transient(rc) ? 3 : 2;
  }

// Closes strategy k's position. On failure the exit is retried on every tick: an exit is never skipped.
void CloseStrat(const int k, const string why)
  {
   ulong t; int s; datetime o;
   if(!FindPos(k, t, s, o)) { g_exitWhy[k] = ""; return; }
   trade.SetExpertMagicNumber(Magic(k));
   if(trade.PositionClose(t, InpDeviationPts) && trade.ResultRetcode() == TRADE_RETCODE_DONE)
     {
      Journal(k, "EXIT_" + why, "closed at " + Px(trade.ResultPrice()) + ", deal time " + TimeToString(TimeCurrent(), TIME_DATE | TIME_SECONDS) +
              ", profit " + DoubleToString(PositionPnl(t), 2));
      g_posId[k] = 0;
      GVDel("pos" + IntegerToString(k));
      GlobalVariablesFlush();
      g_exitWhy[k] = "";
      g_lastErr[k] = 0;
      return;
     }
   g_exitWhy[k] = why;
   JournalFailure(k, "EXIT_" + why + " close");
  }

void Queue(const int k, const int dir, const double slAbs, const double stopDist, const datetime bar, const string why)
  { g_qDir[k] = dir; g_qSl[k] = slAbs; g_qDist[k] = stopDist; g_qBar[k] = bar; g_qWhy[k] = why; }

// Positions closed by something other than this EA (normally the broker stop) are journaled from their
// closing deal.
void Reconcile()
  {
   for(int k = 1; k < NS; k++)
     {
      ulong posid = g_posId[k];
      if(posid == 0 || PosOpen(posid)) continue;
      string ev = "EXIT_EXTERNAL", detail = "closing deal not found";
      if(HistorySelectByPosition(posid))
         for(int i = HistoryDealsTotal() - 1; i >= 0; i--)
           {
            ulong d = HistoryDealGetTicket(i);
            long entry = HistoryDealGetInteger(d, DEAL_ENTRY);
            if(entry != DEAL_ENTRY_OUT && entry != DEAL_ENTRY_OUT_BY) continue;
            long reason = HistoryDealGetInteger(d, DEAL_REASON);
            if(reason == DEAL_REASON_SL) ev = "EXIT_STOP";
            else if(reason == DEAL_REASON_SO) ev = "EXIT_STOPOUT";
            else if(reason == DEAL_REASON_CLIENT || reason == DEAL_REASON_MOBILE || reason == DEAL_REASON_WEB) ev = "EXIT_MANUAL";
            else if(reason == DEAL_REASON_EXPERT && g_exitWhy[k] != "") ev = "EXIT_" + g_exitWhy[k];
            detail = "closed at " + Px(HistoryDealGetDouble(d, DEAL_PRICE)) + ", deal time " +
                     TimeToString((datetime)HistoryDealGetInteger(d, DEAL_TIME), TIME_DATE | TIME_SECONDS);
            break;
           }
      detail += ", profit " + DoubleToString(PositionPnl(posid), 2);
      Journal(k, ev, detail);
      g_posId[k] = 0;
      GVDel("pos" + IntegerToString(k));
      g_exitWhy[k] = "";
     }
  }

// A position that appeared without Enter(): one of our stop orders filled at the broker.
void TrackFills()
  {
   for(int k = 1; k <= 3; k++)
     {
      ulong t; int side; datetime o;
      if(!FindPos(k, t, side, o)) continue;
      ulong id = (ulong)PositionGetInteger(POSITION_IDENTIFIER);
      if(id == g_posId[k]) continue;
      CountTrades();
      Remember(k, id, side);
      g_lastErr[k] = 0;
      Journal(k, side == 1 ? "ENTRY_LONG" : "ENTRY_SHORT", "stop order filled: " + DoubleToString(PositionGetDouble(POSITION_VOLUME), 3) +
              " lots at " + Px(PositionGetDouble(POSITION_PRICE_OPEN)) + ", stop " + Px(PositionGetDouble(POSITION_SL)) +
              ", risk " + RiskText(k) + ", opened " + TimeToString(o, TIME_DATE | TIME_SECONDS));
      if(k == 3) WantDualThrust(MinOfDay(TimeCurrent()));        // its stop-and-reverse order
     }
  }

//--- the strategies' decisions ------------------------------------------------
void SetWant(const int k, const int s, const double level, const double sl, const int until, const bool chase)
  {
   g_want[k][s].chase = chase;
   // The broker stores prices on its grid; compare like with like, or the order looks changed every tick.
   double level0 = NormalizeDouble(level, _Digits), sl0 = NormalizeDouble(sl, _Digits);
   Want w = g_want[k][s];
   if(w.on && MathAbs(w.level - level0) < _Point / 2 && MathAbs(w.sl - sl0) < _Point / 2 && w.until == until) return;   // unchanged
   g_want[k][s].on = true; g_want[k][s].placed = false; g_want[k][s].watch = false; g_want[k][s].sends = 0;
   g_want[k][s].level = level0; g_want[k][s].sl = sl0; g_want[k][s].until = until;
  }
void ClearWant(const int k) { g_want[k][0].on = false; g_want[k][1].on = false; }

// 3  Dual Thrust (Chalek): the day's first entry at open +/- half the 4-day range; then, while in a trade,
//    the opposite stop order at its stop level is the stop-and-reverse. All until 20:00, 3 entries a day.
void WantDualThrust(const int m)
  {
   ClearWant(3);
   if(!InpDualThrust || !g_day.ok || !g_day.dtOk || m >= 20 * 60 || g_trades[3] >= MAXDAY[3]) return;
   ulong t; int side; datetime o;
   bool has = FindPos(3, t, side, o);
   if(!has && g_trades[3] == 0)
     {
      bool opening = m < 75;                                        // the day's first bars: where its orders are set
      SetWant(3, 0, g_day.dtUp, g_day.dtDn, 20 * 60, opening); SetWant(3, 1, g_day.dtDn, g_day.dtUp, 20 * 60, opening);
     }
   else if(has && side == 1) SetWant(3, 1, g_day.dtDn, g_day.dtUp, 20 * 60, true);    // the reversal, at its stop
   else if(has && side == -1) SetWant(3, 0, g_day.dtUp, g_day.dtDn, 20 * 60, true);
  }

// At each new M15 bar, on the bar that just closed: R-Breaker and the two momentum entries (market orders now).
void Decide(const datetime closed, const datetime cur)
  {
   MqlRates b[];
   if(CopyRates(_Symbol, PERIOD_M15, 1, 1, b) != 1 || b[0].time != closed) return;
   double c = b[0].close;
   int mc = MinOfDay(closed);

   // 4  R-Breaker (Saidenberg): six levels from yesterday; trend entries beyond the breakout levels,
   //    reversal entries after an overshoot of a setup level comes back through its enter level.
   if(InpRBreaker && g_day.atrPrev > 0 && mc < 20 * 60)
     {
      double hi, lo; bool seen;
      if(RangeOf(g_day.day, 0, mc + 1, hi, lo, seen) > 0)
        {
         double H = g_day.pH, L = g_day.pL, C = g_day.pC, P = (H + L + C) / 3;
         double bBreak = H + 2 * (P - L), sSetup = P + (H - L), sEnter = 2 * P - L;
         double bEnter = 2 * P - H, bSetup = P - (H - L), sBreak = L - 2 * (H - P);
         double stopDist = 0.5 * g_day.atrPrev;
         bool revShort = hi > sSetup && c < sEnter, revLong = lo < bSetup && c > bEnter;
         int trend = TrendAt(closed);
         ulong t; int side; datetime o;
         if(!FindPos(4, t, side, o))
           {
            int dir = (c > bBreak || revLong) ? 1 : (c < sBreak || revShort) ? -1 : 0;
            if(dir != 0 && dir == trend && g_trades[4] < MAXDAY[4])
               Queue(4, dir, 0, stopDist, cur, dir == 1 ? (c > bBreak ? "breakout above " + Px(bBreak) : "reversal up through " + Px(bEnter))
                                                        : (c < sBreak ? "breakdown below " + Px(sBreak) : "reversal down through " + Px(sEnter)));
           }
         else if((side == 1 && revShort) || (side == -1 && revLong))
           {
            CloseStrat(4, "REVERSE");
            if(-side == trend && g_trades[4] < MAXDAY[4]) Queue(4, -side, 0, stopDist, cur, "reversal");
           }
        }
     }

   // 5, 6  Intraday momentum: the day's direction since the open, at 16:00 / 20:00, with the H4 trend.
   for(int k = 5; k <= 6; k++)
     {
      if(!(k == 5 ? InpMom16 : InpMom20) || mc != (k == 5 ? 15 * 60 + 45 : 19 * 60 + 45)) continue;
      if(HasPos(k) || g_day.atrPrev <= 0 || c == g_day.open || g_trades[k] >= MAXDAY[k]) continue;
      int dir = c > g_day.open ? 1 : -1;
      if(dir == TrendAt(closed))
         Queue(k, dir, 0, 0.5 * g_day.atrPrev, cur, "gold " + (dir == 1 ? "up" : "down") + " since the open (" + Px(g_day.open) + "), with the H4 trend");
     }
  }

// At each new M15 bar: the breakout stop orders each strategy wants in place during this bar.
void Arm(const datetime cur)
  {
   int m = MinOfDay(cur);
   long day = DayOf(cur);
   double hi, lo; bool seen;
   ClearWant(1); ClearWant(2);

   // 1  New York ORB: the 16:30-17:00 range; only the H4 trend's side (trend at the 16:45 bar); until 20:00.
   if(InpNyOrb && m >= 17 * 60 && m < 20 * 60 && g_trades[1] < MAXDAY[1] && !HasPos(1) &&
      RangeOf(day, 16 * 60 + 30, 17 * 60, hi, lo, seen) >= 2 && seen)
     {
      int trend = TrendAt((datetime)(day * 86400 + (16 * 60 + 45) * 60));
      if(trend == 1)  SetWant(1, 0, hi, lo, 20 * 60, m == 17 * 60);
      if(trend == -1) SetWant(1, 1, lo, hi, 20 * 60, m == 17 * 60);
     }
   // 2  Asian range breakout (Crabel): the 01:00-09:00 range, only on narrow nights; both sides until 15:00.
   if(InpAsian && m >= 9 * 60 && m < 15 * 60 && g_trades[2] < MAXDAY[2] && !HasPos(2) && g_day.atrPrev > 0 &&
      RangeOf(day, 60, 9 * 60, hi, lo, seen) >= 24 && seen && (hi - lo) / g_day.atrPrev < InpNarrow)
     { SetWant(2, 0, hi, lo, 15 * 60, m == 9 * 60); SetWant(2, 1, lo, hi, 15 * 60, m == 9 * 60); }
   // 3  Dual Thrust
   WantDualThrust(m);
  }

// Every tick: make the broker's stop orders match what the strategies want. A level already reached
// becomes a market order (as the research fills at the open); a refused order is watched here instead.
void SyncOrders()
  {
   int m = MinOfDay(TimeCurrent());
   string reason = "";
   bool allowed = EntryAllowed(reason);
   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK), bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   for(int k = 1; k <= 3; k++)
     {
      bool oneDone = k <= 2 && HasPos(k);                         // ORB and Asian: one trade, the other side cancels
      for(int s = 0; s < 2; s++)
        {
         double price = 0, sl = 0;
         ulong ord = FindOrder(k, s, price, sl);
         bool live = g_want[k][s].on && m < g_want[k][s].until && allowed && !oneDone && g_trades[k] < MAXDAY[k];
         if(!live)
           {
            if(ord != 0 && !trade.OrderDelete(ord)) JournalFailure(k, "cancel order");
            if(g_want[k][s].on && (m >= g_want[k][s].until || oneDone || g_trades[k] >= MAXDAY[k])) g_want[k][s].on = false;
            continue;
           }
         int dir = s == 0 ? 1 : -1;
         double level = g_want[k][s].level;
         bool reached = dir == 1 ? ask >= level : bid <= level;
         if(ord != 0)
           {
            if(MathAbs(price - level) > _Point / 2 || MathAbs(sl - g_want[k][s].sl) > _Point / 2)
              {
               if(trade.OrderDelete(ord)) g_want[k][s].placed = false;            // replaced next tick
               else JournalFailure(k, "cancel order");
              }
            else g_want[k][s].placed = true;
            continue;
           }
         // Our order is gone: it filled (TrackFills picks the position up) or lapsed. Never enter twice.
         if(g_want[k][s].placed) { g_want[k][s].on = false; continue; }
         // A level passed with no order resting (the EA was asleep or restarting) is never chased at a worse price.
         if(reached && !g_want[k][s].watch && (g_noChase || !g_want[k][s].chase)) { g_want[k][s].on = false; continue; }
         if(g_want[k][s].watch || reached)
           {
            if(!reached) continue;
            ulong t; int side; datetime o;
            if(FindPos(k, t, side, o) && side == dir) { g_want[k][s].on = false; continue; }
            string why = (dir == 1 ? "break above " : "break below ") + Px(level);
            if(!Enter(k, dir, g_want[k][s].sl, 0, why)) g_want[k][s].on = false;
            continue;
           }
         if(g_want[k][s].sends >= 3)
           {
            // Placed three times already and it keeps going away: stop resending, watch the level here instead.
            g_want[k][s].watch = true;
            Journal(k, "WARN", (dir == 1 ? "buy" : "sell") + " stop at " + Px(level) + " placed 3 times; the EA watches the level itself now");
            continue;
           }
         int placed = PlaceStop(k, s, g_want[k][s]);
         if(placed == 0) { g_want[k][s].placed = true; g_want[k][s].sends++; }
         if(placed == 1) g_want[k][s].on = false;
         if(placed == 2) g_want[k][s].watch = true;
        }
     }
  }

// Every tick: send the queued market entries (retried until their bar ends).
void SendQueued(const datetime cur)
  {
   for(int k = 1; k < NS; k++)
     {
      if(g_qDir[k] == 0) continue;
      if(g_qBar[k] != cur) { Journal(k, "SKIP", "entry not filled before its bar ended"); g_qDir[k] = 0; continue; }
      if(HasPos(k)) continue;                                  // a reversal waits for its close to go through
      if(!Enter(k, g_qDir[k], g_qSl[k], g_qDist[k], g_qWhy[k])) g_qDir[k] = 0;
     }
  }

// 23:00, or 2 minutes before today's trading session ends if that is earlier.
int FlatMinute()
  {
   long today = DayOf(TimeCurrent());
   if(g_flatDay == today) return g_flatMin;
   MqlDateTime t;
   TimeToStruct(TimeCurrent(), t);
   datetime from, to;
   int end = -1;
   for(uint s = 0; SymbolInfoSessionTrade(_Symbol, (ENUM_DAY_OF_WEEK)t.day_of_week, s, from, to); s++)
      end = MathMax(end, (int)((long)to / 60));
   g_flatDay = today;
   g_flatMin = end > 0 ? MathMin(FLAT, end - 2) : FLAT;
   return g_flatMin;
  }

void StandDown()
  {
   for(int k = 1; k < NS; k++) { ClearWant(k); g_qDir[k] = 0; if(k <= 3) DeleteOrders(k); }
  }

//--- the main loop -------------------------------------------------------------
void Run()
  {
   if(!IsDemo()) { Alert("GoldIntraday: not a demo account. Removing the EA."); ExpertRemove(); return; }
   datetime now = TimeCurrent();
   if(now == 0) return;
   if(g_tradesDay != DayOf(now)) CountTrades();

   // Kill switch: global variable DG_KILL = 1 (F3 in MT5) closes everything and stops new trades.
   if(GlobalVariableCheck("DG_KILL") && GlobalVariableGet("DG_KILL") == 1)
     {
      StandDown();
      for(int k = 1; k < NS; k++) if(HasPos(k)) CloseStrat(k, "KILL_SWITCH");
      return;
     }
   Reconcile();
   TrackFills();

   // Flat by the session end; a position left from an earlier day (a holiday's early close) goes now.
   int m = MinOfDay(now), flat = FlatMinute();
   for(int k = 1; k < NS; k++)
     {
      ulong t; int s; datetime opened;
      if(!FindPos(k, t, s, opened)) continue;
      if(m >= flat || DayOf(opened) != DayOf(now)) CloseStrat(k, "SESSION");
      else if(g_exitWhy[k] != "") CloseStrat(k, g_exitWhy[k]);
     }
   if(m >= flat) { StandDown(); return; }

   // A new M15 bar: decide on the bar that just closed, then set this bar's breakout orders.
   datetime cur = iTime(_Symbol, PERIOD_M15, 0);
   if(cur == 0) return;
   if((datetime)GVGet("lastbar", 0) != cur)
     {
      if(!LoadDay(DayOf(cur))) return;                         // daily history not ready: try again next tick
      bool first = !GlobalVariableCheck(GVP + "lastbar");
      GVSet("lastbar", (double)cur);
      if(first || now - cur > 300)
        {
         // The rules act at a bar's open; this one started before the EA was watching.
         Journal(0, "WAIT", (first ? "first start" : "restarted mid-bar") + ": acting from the next M15 bar");
         return;
        }
      CountTrades();                                           // includes any trade that opened and closed between ticks
      datetime closed = iTime(_Symbol, PERIOD_M15, 1);
      if(DayOf(closed) == DayOf(cur) && MinOfDay(closed) < FLAT) Decide(closed, cur);
      Arm(cur);
      g_armed = true;
      g_noChase = false;
     }
   if(!g_armed)
     {
      // Just (re)started inside a bar: rebuild what the strategies want now, so the stop orders already resting
      // at the broker are kept, not cancelled. A level passed while the EA was away is not chased.
      if(!LoadDay(DayOf(cur))) return;
      CountTrades();
      Arm(cur);
      g_armed = true;
      g_noChase = true;
     }
   SendQueued(cur);
   SyncOrders();
  }

//--- MT5 events ----------------------------------------------------------------
int OnInit()
  {
   GVP = "GI_" + IntegerToString(InpMagicBase) + "_";
   if(!IsDemo())
     {
      Alert("GoldIntraday refuses to run: this is not a demo account.");
      return INIT_FAILED;
     }
   if(StringFind(_Symbol, "XAU") != 0)
     {
      Alert("GoldIntraday trades gold only; it is attached to " + _Symbol + ". Attach it to an XAUUSD chart.");
      return INIT_FAILED;
     }
   if(InpRiskPct <= 0 || InpRiskPct > 1 || InpNarrow <= 0 || InpDailyLossPct <= 0)
      return INIT_PARAMETERS_INCORRECT;                        // more than 1% a trade is refused outright
   for(int k = 1; k < NS; k++)
      if(Weight(k) <= 0 || Weight(k) > 2 || InpRiskPct * Weight(k) > 1)
         return INIT_PARAMETERS_INCORRECT;                     // a weight between 0 and 2, and never above 1% a trade
   if(MQLInfoInteger(MQL_TESTER))                              // one journal per test run, so several runs can be compared
      JOURNAL = "GoldIntraday_journal_" + TimeToString(TimeCurrent(), TIME_DATE) + ".csv";
   trade.SetDeviationInPoints(InpDeviationPts);
   trade.SetTypeFillingBySymbol(_Symbol);
   trade.LogLevel(LOG_LEVEL_NO);                               // the journal records every failure once
   ArrayInitialize(g_qDir, 0);
   ArrayInitialize(g_lastErr, 0);
   ArrayInitialize(g_skipDay, -1);
   for(int k = 0; k < NS; k++)
     {
      g_exitWhy[k] = "";                                       // an unset string is NULL, not "": set them
      g_qWhy[k] = "";
      g_want[k][0].on = false; g_want[k][1].on = false;
      g_posId[k] = k > 0 ? (ulong)GVGet("pos" + IntegerToString(k), 0) : 0;   // what we held before a restart
      g_side[k] = k > 0 ? (int)GVGet("side" + IntegerToString(k), 0) : 0;
     }
   g_day.day = -1; g_day.ok = false;
   g_armed = false; g_noChase = false;
   EventSetTimer(10);
   Journal(0, "START", _Symbol + ", risk " + DoubleToString(InpRiskPct, 2) + "% a trade, strategies" +
           (InpNyOrb ? " NY_ORB" : "") + (InpAsian ? " ASIAN_NARROW" : "") + (InpDualThrust ? " DUAL_THRUST" : "") +
           (InpRBreaker ? " R_BREAKER" : "") + (InpMom16 ? " MOM_16" : "") + (InpMom20 ? " MOM_20" : "") +
           ", weights " + DoubleToString(InpWNyOrb, 2) + "/" + DoubleToString(InpWAsian, 2) + "/" + DoubleToString(InpWDualThrust, 2) + "/" +
           DoubleToString(InpWRBreaker, 2) + "/" + DoubleToString(InpWMom16, 2) + "/" + DoubleToString(InpWMom20, 2) +
           ", demo account " + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)));
   return INIT_SUCCEEDED;
  }

void OnDeinit(const int reason) { EventKillTimer(); Journal(0, "STOP", "reason " + IntegerToString(reason)); }
void OnTick()  { Run(); }
void OnTimer()
  {
   Run();
   string problem = SheetSync("GoldIntraday", JOURNAL, InpMagicBase + 1, InpMagicBase + NS - 1);   // results to the Google Sheet
   if(problem != "") Journal(0, "WARN", problem);
  }
//+------------------------------------------------------------------+
