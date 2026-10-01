# Trading Office

This fork keeps two trading floors, **Opening Bell** and **Back Office**, with market displays,
desk monitors, resident advisers, playbooks, risk controls, paper simulation and the opening bell.
Its wider room and custom boss-office slide are preserved alongside the upstream office features.

The upstream sync includes the Blender kitchen, plants, lounge and dog models, interactive telescope,
expandable office wing, drivable garage cars and scenic loop, rooftop darts and axe throwing, maps,
updated settings, and worker/provider improvements. The expandable wing adds desks 17–20; ordinary
hires and queued tasks keep the six resident-adviser desks reserved. The wing's desks are centered in
the bay. The new expandable room is separate from the **Back Office** floor.

The elevator uses the upstream position between the trading displays and opening bell, with the
same shaft location on every office floor, the roof and the garage. The displays and their advisers
sit slightly farther left to clear it; the corner whiteboard stays in place. The existing wider north
wall fits this arrangement without extending the room, and the right-side wing entrance stays clear.

The graphics controls still offer Battery saver and High quality. Battery saver preserves the world
behind the first-person hands while disabling outlines and shadows. The upstream sky cycles through
a day and night every hour, so compare lighting at the same sky time, weather and graphics quality.

## Backtest Lab and prop eval simulator

On the **Back Office** floor, click the **🧪 Backtest lab** or **🏦 Prop eval simulator** wall display
(or press **E** at it, or find either in the ☰ menu and the command palette). Each opens its own
console, and each has a **How it works** button that walks through its steps with the real numbers
from the last run. Close with ✕ or Esc to resume looking around.

**Backtest Lab.** Pick a playbook on the left and a market above the chart. The headline says in one
sentence what it did on the real month of one-minute bars; the six numbers beside it are what a trade
makes on average (in R, where 1R is what the trade risked), the win rate, the total, the worst dip,
won ÷ lost and the trade count. Run the pointer along the equity curve to see each trade and why it
was taken. **Where the edge is** shows every playbook on every market; click a cell to open it.

**Add an indicator** tries extra rules on those trades. The backtest keeps what each indicator read on
every entry bar (9/21 and 50 EMA, MACD, RSI, ADX, the 5-minute ATR, NY and overnight VWAP, relative
volume, the time), so a filter simply skips the trades where that reading was against you. Each chip
shows what it would change per trade before you click it; point at one to read what the indicator is.
A filter is **recommended** only when the trades it keeps do better per trade, it keeps enough of them
(12 or more, and at least 35% of the trades), and it still helps on the later third of the days, which
the choice was not made on. Longs-only and shorts-only are never recommended: one month's direction is
the market's. Stacking filters on a month of history fits the past, so treat every result as paper evidence.

**Prop eval simulator.** Pick an account on the left (LucidFlex 50K and 100K, Topstep Combine 50K,
Top One Ignite 50K straight to funded, Apex 4.0 50K), then what to trade on it: one playbook or
several together, on NQ, ES and GC. **Test this on a prop account →** in the Backtest Lab carries the
playbook and its filters across. The backtest's trades are played through the account's rules in order:
each trade is sized off the drawdown left (the risk dial; a tenth is the Law of 10, or set a fixed
dollar risk), the floor trails the way that firm trails it, and the run ends when the account passes or
busts. A pass needs the profit target, the minimum trading days and the consistency rule; the daily stop
(three losses or two risks down) and the consistency rule can be switched off to see what they cost.
The chart shows the balance against the target and the floor day by day, and the ledger lists each day.

**The odds** redraw the same real days at random, with repeats, into 500 imagined stretches of 30, 60
or 90 trading days and play each through the account: the share that pass, bust, or are still going.
The bar on each account and each playbook is those odds, so the easier account and the better-fitting
playbook are visible at a glance, and **What the simulator suggests** says them in words. Any rule on the
account's sheet can be edited to try another size or a rule change (kept in this browser only);
**Start from my real account** begins from the balance in the Risk guard. The wall board now applies
the same rules, so a playbook shows **PASSED** only once consistency and the minimum days are met.
Rules are the ones Trade Pilot keeps: firms change them, so check before buying an account. No fees
or slippage are taken off, and an intraday-trailing floor is checked when a trade closes, not tick by tick.

## Session Desk and cleaner desks

Press **J**, click **Session Desk** in the top bar, or search for it in the command palette.
The window combines an active chart, key levels, a selected playbook's setup checks, the next
scheduled calendar event and account status. Market and playbook selections are remembered in this
browser. Morning checklist items use the same saved checklist as the wall board; automatic items
remain read-only. The floor stays visible behind the window. Close with ✕ or Esc to resume looking
around. The shortcut stays out of text fields and worker terminals.

Every trading desk, including desks 17–20 in the expandable wing, has two matching monitors and
one keyboard. The left monitor shows the hired worker's live terminal, with a persistent provider
header and status, model and task footer. The right monitor keeps the desk's market or job view.
The provider is read from the saved worker, so changing the floor's default does not relabel an
existing worker. Vacant desks show an available terminal; resident advisers show their role until
hired. Clicking a worker opens its full terminal; clicking the right monitor opens its live close-up.

Charts and proposals show separate source names and exchange timestamps for quotes and candles.
Proposals retain the timestamp and provider of the closed candle used in their calculation, even
when the displayed quote comes from a different provider. All times include the Pacific date and time.
**DELAYED** identifies Yahoo quotes; **DELAYED BARS** identifies current quotes paired with Yahoo
candles. **CURRENT** means source times are recent. **STALE** means a source reported a loss of
connection or its timestamps exceeded the freshness window: 15 minutes for Yahoo, 2 minutes for
ProjectX/Coinbase quotes, and 3 minutes for ProjectX candles. Missing source times show
**TIMESTAMP UNKNOWN**. Refresh time never replaces an exchange timestamp. Manual account balances
are explicitly labeled as manual.

### Optional real-time futures

The default public futures feed is delayed. To use exchange quotes and candles for NQ, ES and GC:

1. Activate [TopstepX API access](https://help.topstep.com/en/articles/11187768-topstepx-api-access)
   and generate your API key in the platform. API access is separate from the platform subscription.
2. Open **Session Desk → Data connections**, enter your ProjectX platform username and API key
   locally, leave the default TopstepX gateway, and connect.
3. Click **Enable real-time futures**. Watch the data status and each chart's source and timestamp.
   Enabling a connector alone does not establish that data is current.

The server uses the official ProjectX market hub for streaming quotes and discovers each available
active full-size contract. It fetches that contract's closed one-minute candles every 20 seconds;
proposals evaluate completed candles, so they do not react to an unfinished minute. A five-day initial
history provides prior-session levels. The connector uses TopstepX's **simulation data subscription**
(`live: false` in ProjectX's REST API), which is distinct from Yahoo's delayed feed. No orders are sent.
Available contracts depend on account entitlement. An unavailable contract keeps its existing public
source label. An interrupted stream retains its last actual values and becomes stale; disabling it
explicitly returns the futures charts to Yahoo. The setting persists across server restarts and is
off by default for existing connections. Credentials remain server-side in an owner-readable file.
Other ProjectX gateways continue to support account/journal sync; this market connector supports
TopstepX only. BTC quotes remain Coinbase, BTC candles remain Yahoo, and historical backtests
continue using Yahoo history. These sources are not relabeled as exchange real-time data.

## Trying an upstream integration separately

Use a branch and worktree based on `trading-office`. Merge `upstream/main` there and resolve conflicts
so both sets of behavior survive. Keep the existing trading preview running while reviewing the result.

Build the candidate with `npm run build`, then start it with a separate home, separate floor checkouts
and an unused port:

```bash
node bin/agent-office.js --home /path/to/trial-home --projects /path/to/trial-home/floors --port 4602 --no-open
```

Create trial floors in that isolated home or copy floor definitions with every `dir` changed to a trial
checkout. Each floor keeps its own `.agent-office` data in its checkout: a separate `--home` alone
does not isolate floor state. Keep backups of building/floor data, and do not copy live worker sessions,
provider sign-ins or external trading connection credentials into the trial. Reconnect services only
when intentionally testing them. Paper simulation uses the candidate's own state.

Verify `npm run typecheck`, `npm test`, `npm run build` and the browser preview before adopting the
candidate. Merge the accepted branch back into `trading-office`; the merge ancestry lets later upstream
updates use the new shared base.

The **Session Desk kiosk** beside the lounge opens the dashboard with **E** when you walk up to it. **J** still opens it anywhere on the office floor. Find “Session Desk” in the command palette and use **Shift+Enter** to walk to the kiosk.
