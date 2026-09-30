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
one centered keyboard-and-mouse set with raised keys, legends, a palm rest, mouse buttons and a scroll wheel. These sit on the desk, so hiring or replacing an agent keeps the input set in place. The left monitor shows the hired worker's live terminal, with a persistent provider
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

## News pages and proposal overview

The News & calendar wall display has two full-width pages: **Calendar** and **Headlines**. Click the
wall screen and choose the page above its close-up; that page remains on the wall as the feed updates.
Open full details to read the same page. Calendar details offer **Upcoming**, **Today** and **This week**,
with releases grouped by Pacific date and separate Actual, Expected and Previous columns. Actual
values remain blank until provided by the source. Headlines have a market filter, source links and
pages of eight items. Feed fetch time and an unavailable-source notice stay visible.

The Trade proposals wall now shows one priority setup for each tracked market: active paper trades,
then setups at entry, then waiting setups. It identifies these as **paper simulation**, with source
times shown for every proposal. Multiple active paper trades are counted so they are not mistaken
for a single position. Open full details for **Overview** or **All setups**; a local market filter only
changes what you read. Checks, account sizing and decision records are inside **Checks, risk and actions**.
Expanded rows stay open during updates. **Record that I took it**, **Skip setup** and **Undo record**
only record a decision; they do not place orders. **Tracked markets** changes the shared evaluation
watchlist and is separate from the reading filter. Completed, skipped and off-hours setups remain
available in All setups.
