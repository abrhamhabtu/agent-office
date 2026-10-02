> Current expansion: [Prop Farm expansion](prop-farm-expansion.md). The list below records the
> Claude implementation baseline at `75ad323`; later work is recorded in that guide.

# Prop Farm: where the build stands

A handoff note for whoever picks this up. The plan is [prop-farm-plan.md](prop-farm-plan.md); this says
which of its slices are built, how to see them, and what is still owed. Written 2026-10-02 on branch
`claude/profarm-implementation-finish-c58a64`.

## How to see it

Press **Y** in the office, open **🌾 Prop farm** from the ☰ menu, walk up to the fourth wall display on
Back Office, or go straight to `/#farm` (`/#farm=research`, `compare`, `forward`, `payouts`, `battle`).

`npm run typecheck`, `npm test` (609 tests) and `npm run build` all pass at this commit.

## What is built, by slice of the plan

| Slice | State | Where |
| --- | --- | --- |
| 0. Reconcile the Back Office | Done: `claude-prop-farm` (which carries `backoffice-consoles` at `2ebebaa`) is merged in | merge commit `0d47943` |
| 1. Versioned rules, 25K/50K instances | Done. LucidFlex 25K/50K evaluation and funded read on the firm's pages on 2026-10-02; Top One Elite as a what-if with its unknowns listed | `shared/prop-rules.ts`, `server/trading/accounts.ts` |
| 2. Comparable fills and costs | Done. One fill policy (stop first, gap fills at the open), Pine parity kept and labelled, three cost settings | `shared/fills.ts`, `engine.ts`, `pine-sim.ts` |
| 3. Account event replay | Done. Intratrade equity, overlapping trades, trailing and daily limits, consistency, payout cycle | `shared/account-ledger.ts` |
| 4. Evaluation versus funded sizing | Done. The governor sizes every order and says which limit decided; illegal caps are refused | `shared/risk-policy.ts`, `shared/farm.ts` |
| 5. Durable experiment jobs | Done. One worker, bounded, seeded, resumable across restarts | `server/trading/jobs.ts` |
| 6. Honest strategy selection | Done. Train / validation / locked holdout, search-count hurdle, cost stress, leak check. The tuner and the mixes are no longer judged on the holdout days | `shared/validation.ts` |
| 7. Farm Overview and research controls | Done. Six views in one console | `client/trading/farm*.ts`, `farm.css` |
| 8. Multiple forward paper runs | Done. Decisions written before outcomes, late ones marked, pinned settings | `server/trading/forward.ts` |
| 9. Payout ledger and rotation | Done. Eligible / requested / received kept apart; parked accounts take no trades | `server/trading/payouts.ts` |
| 10. Adaptive agent shadow lane | Built, lightly tested. Statistical regime model by default; an agent through `AGENT_OFFICE_ADAPTIVE_CMD` | `shared/research-decision.ts`, `server/trading/research-agent.ts` |
| 11. Broker feasibility and sandbox | Built, **not yet tested**. Order manager and a misbehaving sandbox broker; no live adapter exists | `server/trading/broker.ts` |

## Still owed

1. **Tests** for `shared/research-decision.ts` and `server/trading/research-agent.ts` (malformed response,
   unavailable model, late answer, a feature from the future, a response that tries to set a size; replay
   reads the record), for `server/trading/broker.ts` (partial fill, reject, timeout that arrived and one
   that didn't, reconnect, duplicate event, missing bracket, stale account state), and for
   `server/trading/propfarm.ts` (`act`, `view`, the migration of the old single live farm). The plan lists
   these under slices 10 and 11.
2. **A test for the "spent" rule** in `shared/farm.ts`: an account with a quarter of its drawdown left that
   can no longer size one micro is retired and counted as lost (`SPENT_SHARE`).
3. **Docs**: `README.md` and `docs/trading-office.md` still describe the earlier single-farm console.
   They need the six views, the Y key, the `/#farm` link and `AGENT_OFFICE_ADAPTIVE_CMD`. `docs/controls.md`
   needs the Y key.
4. **The simulated accounts' rows on the Payouts view** are rebuilt from each run's last day rather than
   from the ledger's own `payoutCheck`, so their checklist is shorter than a tracked account's. Carrying
   the `Account` objects out of `runFarm` would make them identical.
5. **The 50K forward run in a by-day mix takes nothing when the paper trades have no indicator readings**
   (older paper books). It shows zero taken with no explanation: it should say why.
6. **Pull request**: not opened. Trading-floor work targets `trading-office` on `abrhamhabtu/agent-office`.

## What it is not

Nothing here places an order, buys an account or requests a payout. Fees are not on the firms' pages and
are the owner's to set; commission and slippage are assumptions with three settings to compare. About a
month of one-minute bars is all the history there is, so every ranking is a lead to test forward, not a
forecast.
