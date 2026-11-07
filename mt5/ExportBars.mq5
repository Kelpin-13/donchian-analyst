//+------------------------------------------------------------------+
//| ExportBars.mq5                                                   |
//| Writes gold's 1-minute, 15-minute and 1-hour bars (XAUUSD.sml,   |
//| 2023 onwards) to MQL5/Files/XAUUSD.sml_M1.csv, _M15.csv and      |
//| _H1.csv, plus daily and 1-hour bars from 2008 to _D1_2008.csv    |
//| and _H1_2008.csv, in MT5's own Bars-export format, for research/ |
//| (copy the files to data/). Run it once on any chart: it only     |
//| reads price history and places no orders.                        |
//+------------------------------------------------------------------+
#property copyright "Donchian Analyst"
#property version   "1.20"
#property description "Exports gold bars for the research (M1, M15, H1 from 2023; D1, H1 from 2008). Places no orders."

const string          SYMBOL    = "XAUUSD.sml";
const ENUM_TIMEFRAMES PERIODS[] = { PERIOD_M1, PERIOD_M15, PERIOD_H1, PERIOD_D1, PERIOD_H1 };
const string          NAMES[]   = { "M1", "M15", "H1", "D1_2008", "H1_2008" };
const datetime        FROMS[]   = { D'2023.01.01', D'2023.01.01', D'2023.01.01', D'2008.01.01', D'2008.01.01' };

// One month of bars; the terminal may still be loading history, so a few retries.
int CopyMonth(const ENUM_TIMEFRAMES period, const datetime from, const datetime to, MqlRates &rates[])
  {
   for(int attempt = 0; attempt < 10; attempt++)
     {
      ResetLastError();
      int n = CopyRates(SYMBOL, period, from, to, rates);
      if(n > 0) return n;
      if(IsStopped()) return -1;
      Sleep(1000);
     }
   return 0;
  }

// One timeframe to one file. Returns a line for the summary, or "" if it could not write.
string ExportOne(const ENUM_TIMEFRAMES period, const string name, const datetime fromDate, const int digits)
  {
   string file = SYMBOL + "_" + name + ".csv";
   int h = FileOpen(file, FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE) { Alert("ExportBars: cannot write ", file, " (error ", GetLastError(), ")"); return ""; }
   FileWriteString(h, "<DATE>\t<TIME>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>\t<VOL>\t<SPREAD>\r\n");
   long total = 0;
   datetime first = 0, last = 0, now = TimeTradeServer();
   MqlDateTime m;
   TimeToStruct(fromDate, m);
   while(!IsStopped())
     {
      m.day = 1; m.hour = 0; m.min = 0; m.sec = 0;
      datetime from = StructToTime(m);
      if(from > now) break;
      MqlDateTime n = m;
      if(++n.mon > 12) { n.mon = 1; n.year++; }
      datetime to = StructToTime(n) - 1;
      MqlRates rates[];
      int count = CopyMonth(period, from, to, rates);
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
      Print("ExportBars ", name, ": ", TimeToString(from, TIME_DATE), " ", MathMax(count, 0), " bars");
      m = n;
     }
   FileClose(h);
   return IntegerToString(total) + " " + name + " bars from " + TimeToString(first, TIME_DATE) + " to " + TimeToString(last, TIME_DATE);
  }

void OnStart()
  {
   if(!SymbolSelect(SYMBOL, true)) { Alert("ExportBars: symbol ", SYMBOL, " not found (error ", GetLastError(), ")"); return; }
   int digits = (int)SymbolInfoInteger(SYMBOL, SYMBOL_DIGITS);
   string msg = "ExportBars: " + SYMBOL;
   for(int k = 0; k < ArraySize(PERIODS) && !IsStopped(); k++)
     {
      string line = ExportOne(PERIODS[k], NAMES[k], FROMS[k], digits);
      if(line == "") return;
      msg += "\n" + line;
     }
   msg += "\nwritten to MQL5\\Files. Copy them to data/ in the repo.";
   Print(msg);
   Alert(msg);
  }
