//+------------------------------------------------------------------+
//| ExportBars.mq5                                                   |
//| Writes gold's 1-minute bars (XAUUSD.sml, 2023 onwards) to        |
//| MQL5/Files/XAUUSD.sml_M1.csv in MT5's own Bars-export format,    |
//| for research/supply_demand.js. Run it once on any chart: it only |
//| reads price history and places no orders.                        |
//+------------------------------------------------------------------+
#property copyright "Donchian Analyst"
#property version   "1.00"
#property description "Exports gold M1 bars for the research. Places no orders."

const string          SYMBOL = "XAUUSD.sml";
const ENUM_TIMEFRAMES PERIOD = PERIOD_M1;
const datetime        FROM   = D'2023.01.01';
const string          FILE   = "XAUUSD.sml_M1.csv";

// One month of bars; the terminal may still be loading history, so a few retries.
int CopyMonth(const datetime from, const datetime to, MqlRates &rates[])
  {
   for(int attempt = 0; attempt < 10; attempt++)
     {
      ResetLastError();
      int n = CopyRates(SYMBOL, PERIOD, from, to, rates);
      if(n > 0) return n;
      if(IsStopped()) return -1;
      Sleep(1000);
     }
   return 0;
  }

void OnStart()
  {
   if(!SymbolSelect(SYMBOL, true)) { Alert("ExportBars: symbol ", SYMBOL, " not found (error ", GetLastError(), ")"); return; }
   int digits = (int)SymbolInfoInteger(SYMBOL, SYMBOL_DIGITS);
   int h = FileOpen(FILE, FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE) { Alert("ExportBars: cannot write ", FILE, " (error ", GetLastError(), ")"); return; }
   FileWriteString(h, "<DATE>\t<TIME>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>\t<VOL>\t<SPREAD>\r\n");
   long total = 0;
   datetime first = 0, last = 0, now = TimeTradeServer();
   MqlDateTime m;
   TimeToStruct(FROM, m);
   while(!IsStopped())
     {
      m.day = 1; m.hour = 0; m.min = 0; m.sec = 0;
      datetime from = StructToTime(m);
      if(from > now) break;
      MqlDateTime n = m;
      if(++n.mon > 12) { n.mon = 1; n.year++; }
      datetime to = StructToTime(n) - 1;
      MqlRates rates[];
      int count = CopyMonth(from, to, rates);
      for(int i = 0; i < count; i++)
        {
         FileWriteString(h, TimeToString(rates[i].time, TIME_DATE) + "\t" + TimeToString(rates[i].time, TIME_SECONDS) + "\t" +
                         DoubleToString(rates[i].open, digits) + "\t" + DoubleToString(rates[i].high, digits) + "\t" +
                         DoubleToString(rates[i].low, digits) + "\t" + DoubleToString(rates[i].close, digits) + "\t" +
                         IntegerToString(rates[i].tick_volume) + "\t" + IntegerToString(rates[i].real_volume) + "\t" +
                         IntegerToString(rates[i].spread) + "\r\n");
         if(first == 0) first = rates[i].time;
         last = rates[i].time;
        }
      total += MathMax(count, 0);
      Print("ExportBars: ", TimeToString(from, TIME_DATE), " ", MathMax(count, 0), " bars");
      m = n;
     }
   FileClose(h);
   string msg = "ExportBars: " + IntegerToString(total) + " M1 bars of " + SYMBOL + " from " + TimeToString(first, TIME_DATE) +
                " to " + TimeToString(last, TIME_DATE) + " written to MQL5\\Files\\" + FILE;
   Print(msg);
   Alert(msg);
  }
