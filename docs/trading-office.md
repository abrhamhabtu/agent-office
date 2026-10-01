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

### Real-time candles from TradingView alerts

TradingView has no data API, but a Pine script can post each closed one-minute candle to the office's webhook. Open **Session Desk → Data connections** and find **TradingView → real-time candles**: it has the script (Copy Pine script) and the steps. In short: add the script to a **1-minute** chart of NQ1!, ES1!, GC1! or BTCUSD, create an alert with Condition **Agent Office feed → Any alert() function call** and **Webhook URL** set to the URL shown under *TradingView → the office*, and repeat for each market. (Without Pine, an ordinary alert on Once Per Bar Close with the JSON message shown in the same card works too.)

While candles keep arriving (none older than four minutes) they are laid over Yahoo's history, the newest one is the market's price, and the freshness labels read **TradingView**. If they stop, the desk falls back to Yahoo and says it is delayed again. Candles are checked before use (known market, 1-minute interval, a high and low that contain the open and close, a sensible time) and refused with a reason otherwise. It is only as real-time as your TradingView data: CME futures need TradingView's CME subscription, and alerts need a plan with webhooks. It steps once a minute; for tick-by-tick futures use ProjectX above. Bitcoin already has real-time candles straight from Coinbase without any setup.

### The Strategy agent and the Strategy Desk

**Strategy** is a permanent resident (desk 12 on both floors). It keeps your Pine scripts: every version dated, with a changelog, where it came from and a fingerprint of its exact source. Click it (or use the **Strategy** button, or ⌘K → Strategy Desk) to open the **Strategy Desk**: the live version with a one-tap **Copy for TradingView**, every version with its test results and a line-by-line "Changes from vX", and the lab's latest news. Nothing is typed: copy, paste into TradingView's Pine Editor, save, add to chart.

The **test lab** replays the live version of the VWAP Double Break Suite on real 1-minute history (NQ, GC, ES), as the script itself plays it on 5-minute bars (NY VWAP, the opening range, the window, the stop and 2R target, one DB2 re-entry), then tries its settings one at a time. A change is called **better** only if it beats the live version overall, holds up on the later third of the days it was not judged on, keeps most of the trades and does not deepen the drawdown, and it gets a **confidence** (low, medium, high) from how big the gap is against the noise in that many trades. It runs after every close and with **Run tests now**. When something holds up it saves a new **candidate** version (marked new, never live on its own), the Strategy agent jumps and you get a notice. Only you make a version live, and the live version is never edited. History is about a month of 1-minute bars, so most results are paper evidence on few trades: the desk says so and never promises anything. Versions live as plain files in `<data>/trading/pine/<script>/` (`manifest.json` and `v<version>.pine`).

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
