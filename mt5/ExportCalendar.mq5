//+------------------------------------------------------------------+
//| ExportCalendar.mq5                                               |
//| Writes MT5's economic calendar (moderate and high importance,    |
//| every country, since 2007) to MQL5/Files/calendar_events.csv for |
//| research/news_windows.js. Run it once on any chart: it only      |
//| reads the calendar and places no orders.                         |
//| Times are as MT5's calendar gives them (trade server time).     |
//+------------------------------------------------------------------+
#property copyright "Donchian Analyst"
#property version   "1.00"
#property description "Exports the economic calendar for the news research. Places no orders."

const string   FILE = "calendar_events.csv";
const datetime FROM = D'2007.01.01';

string Clean(string s)
  {
   StringReplace(s, ",", " ");
   StringReplace(s, "\"", "");
   return s;
  }

string Value(const long v, const uint digits)
  {
   if(v == LONG_MIN) return "";
   return DoubleToString(v / 1000000.0, (int)digits);
  }

string ModeName(const ENUM_CALENDAR_EVENT_TIMEMODE m)
  {
   switch(m)
     {
      case CALENDAR_TIMEMODE_DATETIME:  return "time";
      case CALENDAR_TIMEMODE_DATE:      return "all day";
      case CALENDAR_TIMEMODE_NOTIME:    return "no time";
      case CALENDAR_TIMEMODE_TENTATIVE: return "tentative";
     }
   return "unknown";
  }

void OnStart()
  {
   MqlCalendarCountry countries[];
   CalendarCountries(countries);
   int nc = ArraySize(countries);
   if(nc == 0) { Alert("ExportCalendar: MT5 gave no calendar data (error ", GetLastError(), "). Does the Calendar tab in the Toolbox show events?"); return; }
   int h = FileOpen(FILE, FILE_WRITE | FILE_CSV | FILE_ANSI, ',');
   if(h == INVALID_HANDLE) { Alert("ExportCalendar: cannot write ", FILE, " (error ", GetLastError(), ")"); return; }
   FileWrite(h, "server_time", "country", "currency", "importance", "time_mode", "event_id", "event_code", "name", "actual", "forecast", "previous");
   datetime to = TimeTradeServer() + 60 * 86400;
   int rows = 0;
   datetime first = 0, last = 0;
   for(int c = 0; c < nc; c++)
     {
      MqlCalendarEvent events[];
      CalendarEventByCountry(countries[c].code, events);
      for(int i = 0; i < ArraySize(events); i++)
        {
         if(events[i].importance != CALENDAR_IMPORTANCE_HIGH && events[i].importance != CALENDAR_IMPORTANCE_MODERATE) continue;
         MqlCalendarValue v[];
         CalendarValueHistoryByEvent(events[i].id, v, FROM, to);
         for(int j = 0; j < ArraySize(v); j++)
           {
            FileWrite(h, TimeToString(v[j].time, TIME_DATE | TIME_MINUTES), countries[c].code, countries[c].currency,
                      events[i].importance == CALENDAR_IMPORTANCE_HIGH ? "high" : "moderate", ModeName(events[i].time_mode),
                      IntegerToString((long)events[i].id), events[i].event_code, Clean(events[i].name),
                      Value(v[j].actual_value, events[i].digits), Value(v[j].forecast_value, events[i].digits),
                      Value(v[j].prev_value, events[i].digits));
            rows++;
            if(first == 0 || v[j].time < first) first = v[j].time;
            if(v[j].time > last) last = v[j].time;
           }
        }
     }
   FileClose(h);
   string msg = "ExportCalendar: " + IntegerToString(rows) + " events from " + TimeToString(first, TIME_DATE) + " to " +
                TimeToString(last, TIME_DATE) + " written to MQL5\\Files\\" + FILE + " (server offset now " +
                IntegerToString((long)(TimeTradeServer() - TimeGMT()) / 3600) + " h)";
   Print(msg);
   Alert(msg);
  }
