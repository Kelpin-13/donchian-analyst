//+------------------------------------------------------------------+
//| SheetSync.mqh                                                    |
//| Sends an EA's journal to the Google Sheet (the project's Apps    |
//| Script web app: doPost in Webhook.gs -> handleMt5_ in Mt5.gs).   |
//|                                                                  |
//| New journal lines go about every half minute (150 at most), with |
//| a heartbeat every 10 minutes so the sheet can tell when the PC   |
//| is off. The sheet ignores lines it already has, so after each    |
//| start the whole journal is sent again, harmlessly. Never in the  |
//| tester, and never in the first minute of an M15 bar, when the    |
//| EAs place their orders: a slow reply can't delay a trade.        |
//|                                                                  |
//| MT5 must allow the address: Tools -> Options -> Expert Advisors  |
//| -> Allow WebRequest for listed URL: https://script.google.com    |
//| and https://script.googleusercontent.com                         |
//+------------------------------------------------------------------+
input group "Google Sheet (results)"
input string InpSheetUrl = "";         // Sheet URL: from the sheet's menu MT5 gold EAs -> Connect MT5
input string InpSheetKey = "";         // Sheet key: from the same dialog

long     g_syncPos  = 0;               // bytes of the journal the sheet has
int      g_syncLine = 1;               // the line number at that point (1 = the header)
datetime g_syncTry  = 0, g_syncBeat = 0;
string   g_syncWarned = "";            // the problem last reported, so it is reported once

string JsonEsc(const string s)
  {
   string out = s;
   StringReplace(out, "\\", "\\\\");
   StringReplace(out, "\"", "\\\"");
   StringReplace(out, "\r", "");
   StringReplace(out, "\n", " ");
   StringReplace(out, "\t", " ");
   return out;
  }

// Call from OnTimer. Returns a problem worth journaling (once), or "".
// ea: "DonchianGold" or "GoldIntraday"; file: its journal; magicFrom..magicTo: its positions.
string SheetSync(const string ea, const string file, const long magicFrom, const long magicTo)
  {
   if(InpSheetUrl == "" || InpSheetKey == "" || MQLInfoInteger(MQL_TESTER)) return "";
   datetime wall = TimeLocal();
   if(wall - g_syncTry < 30) return "";
   if((long)TimeTradeServer() % 900 < 60) return "";               // the first minute of a bar is for orders
   g_syncTry = wall;

   // The journal lines the sheet doesn't have yet.
   string lines[];
   int n = 0, first = g_syncLine;
   long endPos = g_syncPos;
   int h = FileOpen(file, FILE_READ | FILE_TXT | FILE_ANSI | FILE_SHARE_READ | FILE_SHARE_WRITE);
   if(h != INVALID_HANDLE)
     {
      if((long)FileSize(h) < g_syncPos) { g_syncPos = 0; g_syncLine = 1; first = 1; }   // a new file: start over
      FileSeek(h, g_syncPos, SEEK_SET);
      while(n < 150 && !FileIsEnding(h))
        {
         string l = FileReadString(h);
         ArrayResize(lines, n + 1);
         lines[n++] = l;
        }
      endPos = (long)FileTell(h);
      FileClose(h);
     }
   bool beat = wall - g_syncBeat >= 600;
   if(n == 0 && !beat) return "";

   int open = 0;
   double floating = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong t = PositionGetTicket(i);
      if(t == 0 || !PositionSelectByTicket(t) || PositionGetString(POSITION_SYMBOL) != _Symbol) continue;
      long mg = PositionGetInteger(POSITION_MAGIC);
      if(mg < magicFrom || mg > magicTo) continue;
      open++;
      floating += PositionGetDouble(POSITION_PROFIT) + PositionGetDouble(POSITION_SWAP);
     }

   string json = "{\"source\":\"mt5\",\"key\":\"" + JsonEsc(InpSheetKey) + "\",\"ea\":\"" + ea + "\"" +
                 ",\"offset\":" + IntegerToString((long)(TimeTradeServer() - TimeGMT())) +
                 ",\"equity\":" + DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY), 2) +
                 ",\"balance\":" + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2) +
                 ",\"open\":" + IntegerToString(open) + ",\"floating\":" + DoubleToString(floating, 2) +
                 ",\"from\":" + IntegerToString(first) + ",\"lines\":[";
   for(int i = 0; i < n; i++) json += (i > 0 ? "," : "") + "\"" + JsonEsc(lines[i]) + "\"";
   json += "]}";

   char data[], result[];
   string replyHeaders;
   int len = StringToCharArray(json, data, 0, WHOLE_ARRAY, CP_UTF8);
   ArrayResize(data, MathMax(len - 1, 0));                          // without the terminating zero
   ResetLastError();
   int code = WebRequest("POST", InpSheetUrl, "Content-Type: application/json\r\n", 8000, data, result, replyHeaders);
   int err = GetLastError();
   string reply = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);

   string problem = "";
   if(code == -1 && err == 4014)
      problem = "Google Sheet: MT5 blocks the request. Tools -> Options -> Expert Advisors -> Allow WebRequest for listed URL: " +
                "add https://script.google.com and https://script.googleusercontent.com";
   else if(StringFind(reply, "rejected") == 0)
      problem = "Google Sheet: the sheet rejected the key. Copy it again from the sheet's menu MT5 gold EAs -> Connect MT5";
   else if((code == 200 && StringFind(reply, "stored") == 0) || code == 302)
     {
      // Delivered (302: Apps Script ran and redirected to its reply). The sheet ignores repeats anyway.
      g_syncPos = endPos;
      g_syncLine = first + n;
      g_syncBeat = wall;
      g_syncWarned = "";
      return "";
     }
   else
     {
      Print(ea, " sheet sync: no confirmation (HTTP ", code, ", error ", err, "); retrying in 30 s");
      return "";
     }
   if(problem == g_syncWarned) return "";
   g_syncWarned = problem;
   return problem;
  }

// What a closed position made or lost in account money: profit + swap + commission + fees of its deals.
// Journaled with every exit, so the sheet shows real P&L.
double PositionPnl(const ulong id)
  {
   double p = 0;
   if(!HistorySelectByPosition(id)) return 0;
   for(int i = HistoryDealsTotal() - 1; i >= 0; i--)
     {
      ulong d = HistoryDealGetTicket(i);
      p += HistoryDealGetDouble(d, DEAL_PROFIT) + HistoryDealGetDouble(d, DEAL_SWAP) +
           HistoryDealGetDouble(d, DEAL_COMMISSION) + HistoryDealGetDouble(d, DEAL_FEE);
     }
   return p;
  }
//+------------------------------------------------------------------+
