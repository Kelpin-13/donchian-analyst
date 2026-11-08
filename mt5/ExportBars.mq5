//+------------------------------------------------------------------+
//| ExportBars.mq5                                                   |
//| Writes gold's 1-minute, 15-minute and 1-hour bars (XAUUSD.sml,   |
//| 2023 onwards) to MQL5/Files/XAUUSD.sml_M1.csv, _M15.csv and      |
//| _H1.csv, plus daily and 1-hour bars from 2008 to _D1_2008.csv    |
//| and _H1_2008.csv; then the same daily and 1-hour files for every |
//| stock index the broker lists, and symbols.csv (every symbol the  |
//| broker lists, with its folder), in MT5's own Bars-export format, |
//| for research/ (copy the files to data/). Run it once on any      |
//| chart: it only reads price history and places no orders.         |
//+------------------------------------------------------------------+
#property copyright "Donchian Analyst"
#property version   "1.21"
#property description "Exports gold bars (M1, M15, H1 from 2023; D1, H1 from 2008) and stock-index bars (D1, H1 from 2008) for the research. Places no orders."

const string          SYMBOL    = "XAUUSD.sml";
const ENUM_TIMEFRAMES PERIODS[] = { PERIOD_M1, PERIOD_M15, PERIOD_H1, PERIOD_D1, PERIOD_H1 };
const string          NAMES[]   = { "M1", "M15", "H1", "D1_2008", "H1_2008" };
const datetime        FROMS[]   = { D'2023.01.01', D'2023.01.01', D'2023.01.01', D'2008.01.01', D'2008.01.01' };
const int             MAX_INDICES = 30;

// One month of bars; the terminal may still be loading history, so a few retries.
int CopyMonth(const string symbol, const ENUM_TIMEFRAMES period, const datetime from, const datetime to, MqlRates &rates[])
  {
   for(int attempt = 0; attempt < 10; attempt++)
     {
      ResetLastError();
      int n = CopyRates(symbol, period, from, to, rates);
      if(n > 0) return n;
      if(IsStopped()) return -1;
      Sleep(1000);
     }
   return 0;
  }

// The broker's first date for a symbol (0 if it will not say), so years before it are not waited on month by month.
datetime ServerFirstDate(const string symbol)
  {
   for(int attempt = 0; attempt < 10; attempt++)
     {
      long first = 0;
      if(SeriesInfoInteger(symbol, PERIOD_M1, SERIES_SERVER_FIRSTDATE, first) && first > 0) return (datetime)first;
      if(IsStopped()) return 0;
      Sleep(500);
     }
   return 0;
  }

// One symbol and timeframe to one file. Returns a line for the summary, or "" if it could not write.
string ExportOne(const string symbol, const ENUM_TIMEFRAMES period, const string name, const datetime fromDate, const int digits)
  {
   string safe = symbol;
   StringReplace(safe, "/", "_");
   StringReplace(safe, "\\", "_");
   string file = safe + "_" + name + ".csv";
   int h = FileOpen(file, FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE) { Alert("ExportBars: cannot write ", file, " (error ", GetLastError(), ")"); return ""; }
   FileWriteString(h, "<DATE>\t<TIME>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>\t<VOL>\t<SPREAD>\r\n");
   long total = 0;
   datetime first = 0, last = 0, now = TimeTradeServer(), start = fromDate, server = ServerFirstDate(symbol);
   if(server > start) start = server;
   MqlDateTime m;
   TimeToStruct(start, m);
   while(!IsStopped())
     {
      m.day = 1; m.hour = 0; m.min = 0; m.sec = 0;
      datetime from = StructToTime(m);
      if(from > now) break;
      MqlDateTime n = m;
      if(++n.mon > 12) { n.mon = 1; n.year++; }
      datetime to = StructToTime(n) - 1;
      MqlRates rates[];
      int count = CopyMonth(symbol, period, from, to, rates);
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
      Print("ExportBars ", symbol, " ", name, ": ", TimeToString(from, TIME_DATE), " ", MathMax(count, 0), " bars");
      m = n;
     }
   FileClose(h);
   return symbol + " " + IntegerToString(total) + " " + name + " bars from " + TimeToString(first, TIME_DATE) + " to " + TimeToString(last, TIME_DATE);
  }

// A stock index by the broker's own folder or description (OANDA files them under an "Indices" folder).
bool IsIndex(const string symbol)
  {
   string path = SymbolInfoString(symbol, SYMBOL_PATH), desc = SymbolInfoString(symbol, SYMBOL_DESCRIPTION);
   StringToLower(path);
   StringToLower(desc);
   return StringFind(path, "indic") >= 0 || StringFind(path, "index") >= 0 || StringFind(desc, "index") >= 0;
  }

// Every symbol the broker lists, with its folder and description, so the research can see what else there is.
bool WriteSymbols(int &indices)
  {
   indices = 0;
   int h = FileOpen("symbols.csv", FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE) { Alert("ExportBars: cannot write symbols.csv (error ", GetLastError(), ")"); return false; }
   FileWriteString(h, "symbol\tpath\tdescription\tindex\r\n");
   int total = SymbolsTotal(false);
   for(int i = 0; i < total; i++)
     {
      string s = SymbolName(i, false);
      bool idx = IsIndex(s);
      if(idx) indices++;
      FileWriteString(h, s + "\t" + SymbolInfoString(s, SYMBOL_PATH) + "\t" + SymbolInfoString(s, SYMBOL_DESCRIPTION) + "\t" + (idx ? "1" : "0") + "\r\n");
     }
   FileClose(h);
   return true;
  }

void OnStart()
  {
   if(!SymbolSelect(SYMBOL, true)) { Alert("ExportBars: symbol ", SYMBOL, " not found (error ", GetLastError(), ")"); return; }
   int digits = (int)SymbolInfoInteger(SYMBOL, SYMBOL_DIGITS);
   string msg = "ExportBars: " + SYMBOL;
   for(int k = 0; k < ArraySize(PERIODS) && !IsStopped(); k++)
     {
      string line = ExportOne(SYMBOL, PERIODS[k], NAMES[k], FROMS[k], digits);
      if(line == "") return;
      msg += "\n" + line;
     }
   int indices = 0;
   if(WriteSymbols(indices)) msg += "\nsymbols.csv: " + IntegerToString(SymbolsTotal(false)) + " symbols, " + IntegerToString(indices) + " stock indices";
   int done = 0, total = SymbolsTotal(false);
   for(int i = 0; i < total && done < MAX_INDICES && !IsStopped(); i++)
     {
      string s = SymbolName(i, false);
      if(!IsIndex(s)) continue;
      bool wasSelected = (bool)SymbolInfoInteger(s, SYMBOL_SELECT);
      if(!SymbolSelect(s, true)) { msg += "\n" + s + ": cannot select it, skipped"; continue; }
      int d = (int)SymbolInfoInteger(s, SYMBOL_DIGITS);
      string a = ExportOne(s, PERIOD_D1, "D1_2008", D'2008.01.01', d);
      string b = ExportOne(s, PERIOD_H1, "H1_2008", D'2008.01.01', d);
      if(a != "") msg += "\n" + a;
      if(b != "") msg += "\n" + b;
      if(!wasSelected) SymbolSelect(s, false);   // leave Market Watch as it was
      done++;
     }
   msg += "\nwritten to MQL5\\Files. Copy them to data/ in the repo.";
   Print(msg);
   Alert(msg);
  }
