# Trading Office

This fork keeps two trading floors, **Opening Bell** and **Back Office**, with market displays,
desk monitors, resident advisers, playbooks, risk controls, paper simulation and the opening bell.
Its wider room and custom boss-office slide are preserved alongside the upstream office features.

The upstream sync includes the Blender kitchen, plants, lounge and dog models, interactive telescope,
expandable office wing, drivable garage cars and scenic loop, rooftop darts and axe throwing, maps,
updated settings, and worker/provider improvements. The expandable wing adds desks 17–20; ordinary
hires and queued tasks keep the six resident-adviser desks reserved. The wing's desks sit left of
the trading floor's elevator approach. The new expandable room is separate from the **Back Office** floor.

The graphics controls still offer Battery saver and High quality. Battery saver preserves the world
behind the first-person hands while disabling outlines and shadows. The upstream sky cycles through
a day and night every hour, so compare lighting at the same sky time, weather and graphics quality.

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
