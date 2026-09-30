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

Charts and proposals show the quote source and source timestamp, plus the Yahoo bar timestamp
used for the chart or proposal replay. All timestamps include the Pacific date and time.
**DELAYED** always identifies Yahoo-sourced quotes, even after a successful refresh. **CURRENT**
means the quote source timestamp is recent, without promising exchange real-time delivery.
**DELAYED BARS** identifies a recent Coinbase quote displayed alongside Yahoo bars; quote and bar
statuses are separate, so the chart never inherits the quote’s live-feed label. **STALE**
means the source reported stale quotes, or quotes/bars exceeded their freshness window (15 minutes
for Yahoo quotes, 2 minutes for Coinbase quotes; 15 minutes for bars alongside Yahoo quotes,
3 minutes alongside Coinbase quotes). Missing timestamps show **TIMESTAMP UNKNOWN**; missing
quotes show **NO DATA**. Refresh time never replaces an absent source timestamp. A fresh Coinbase
BTC price does not make old Yahoo chart/proposal bars fresh. Labels continue aging after failed
refreshes, and Session Desk indicates when office snapshots stop arriving. Manual account balances
are explicitly labeled as manual.

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
