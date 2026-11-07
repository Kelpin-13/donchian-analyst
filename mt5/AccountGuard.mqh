//+------------------------------------------------------------------+
//| AccountGuard.mqh: the account drawdown stop, shared by both EAs. |
//|                                                                  |
//| The highest equity either EA has seen is kept in the terminal    |
//| global variable DG_PEAK. When equity falls the given % below it, |
//| DG_KILL is set to 1: both EAs then close their trades and send   |
//| nothing new (their existing kill switch), until the owner sets   |
//| DG_KILL back to 0 in F3. To count from today's equity again,     |
//| delete DG_PEAK there too. Owner decision 6 Nov 2026: 15%.        |
//+------------------------------------------------------------------+

// "" while the account is inside the limit; otherwise what happened, for one KILL_SWITCH journal row.
// Already stopped (DG_KILL = 1) or a 0 limit: nothing to do. Equity 0 means MT5 has no account data yet.
string DrawdownStop(const double maxPct)
  {
   if(maxPct <= 0) return "";
   if(GlobalVariableCheck("DG_KILL") && GlobalVariableGet("DG_KILL") == 1) return "";
   double eq = AccountInfoDouble(ACCOUNT_EQUITY);
   if(eq <= 0) return "";
   double peak = GlobalVariableCheck("DG_PEAK") ? GlobalVariableGet("DG_PEAK") : 0;
   if(eq > peak) { GlobalVariableSet("DG_PEAK", eq); return ""; }
   if(eq >= peak * (1 - maxPct / 100)) return "";
   GlobalVariableSet("DG_KILL", 1);
   GlobalVariablesFlush();
   return "account stop: equity " + DoubleToString(eq, 2) + " is " + DoubleToString((1 - eq / peak) * 100, 1) +
          "% below its peak of " + DoubleToString(peak, 2) + " (limit " + DoubleToString(maxPct, 1) +
          "%). Both EAs close and stop; set DG_KILL to 0 in F3 to start again";
  }
