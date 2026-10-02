# Prop Farm expansion

Built on `origin/claude/profarm-implementation-finish-c58a64` at `75ad323`.

## Account catalog

The Farm now offers current FundedNext Rapid Pro 25K/50K/100K and Flex 50K/100K/150K scenarios.
The source links and verification date are embedded in each rule sheet. Historical Rapid IDs remain
unchanged so saved runs keep their original assumptions. Fees are editable estimates, not quotes.
Current-cycle profit is checked separately from profit retained after earlier payouts.

These are numerical research models. Withdrawal scheduling, inactivity and sub-ten-second profit
deductions still require review and are explicitly listed on each FundedNext rule sheet. They do not
qualify as fully verified automated-trading rules. The detailed FundedNext loss-limit page takes
precedence over its shorter general summary for the $100 floor-lock offset.

## Sizing and strategies

Battle test now offers a strategy-recipe dropdown with existing executable playbooks and VWAP/levels,
trend/range and fallback combinations. Market selection is independent. Recipes are hypotheses to
compare, not promises of profitability. Missing ADX causes regime combinations to abstain.

Choose **Phase-aware** sizing for separate evaluation (5–75%) and funded (1–25%) shares of usable
cushion. It reserves 10% of the starting drawdown and limits daily loss. Payout protection progressively
reduces funded per-trade risk to a quarter of its initial share as the cycle's profit/consistency goal
approaches. The contract cap and firm limits always apply. An account paused by this policy is not
retired merely because its policy budget cannot carry a micro. Older saved cap/cushion runs retain their
behavior. A lower risk budget can take longer to reach benchmark days; compare outcomes in the test.

## TradingView sign-in tomorrow

1. Start this branch's office locally and open **Session Desk → Data connections**.
2. In **TradingView · official MCP research**, choose **Connect TradingView**, then follow the
   **Continue to TradingView sign-in** link. Authorize your paid TradingView account.
3. Return to the office and choose **Check connection**. Run **Find a futures symbol** with `MNQ`,
   then select the returned exchange-qualified symbol and **Last 100 minute bars**.
4. Check the provider's market timestamps and any delay metadata. Saved credentials alone do not prove
   live CME access. Responses are research snapshots; they do not replace the office's trading feed.

Official endpoint: `https://mcp.tradingview.com/mcp`. TradingView's [official documentation](https://www.tradingview.com/mcp/docs)
states Essential and above, excluding trials, use OAuth 2.1. Four read-only tools are enabled here:
symbol search, 100 one-minute OHLCV bars, technical readings and the high-impact US calendar.
The office requests read scope and never exposes arbitrary MCP write calls. Requests are on demand,
with a three-second cooldown; there is no background polling. Authorization is per signed-in office
account (shared-password offices share one connection), available only through the local server.

Tokens stay in `.agent-office/tradingview-mcp-<owner-hash>.json`, mode `0600`, never in browser storage,
source control or status responses. Changing the callback port requires reconnecting. A sign-in link
expires after ten minutes and cannot be replayed. Disconnect deletes local credentials; revoke the app
in TradingView as well if needed. Access from a remote hosted office is not enabled by this connector.

For Claude Code itself, TradingView documents:
`claude mcp add --transport http mcp-tradingview https://mcp.tradingview.com/mcp`, then `/mcp` to sign in.
For Codex: `codex mcp add tradingview --url https://mcp.tradingview.com/mcp`, then authorize.
Those assistant connections are separate from the office's own connection.

For your exact Pine indicators, use the existing Strategy Desk and manual TradingView alert/webhook
setup. MCP does not expose Pine Strategy Tester execution, indicator alert creation or webhook creation.
The connector does not establish a brokerage order route. A successful sign-in still needs a real
symbol request to verify your account's entitlements; that final check needs you tomorrow.

## Performance and evidence fixes

Battle comparisons run in a cancellable Web Worker, only while Battle test is visible. Comparisons
cover the selected firm's programs; results from an old setup cannot replace newer results. Holdout
days stay excluded. Strategy controls are available before the historical replay has finished.

Simulated payout rows now carry the ledger's full checklist, including cycle profit, consistency and
payout counts. The adaptive shadow lane rejects malformed or future features and risk overrides; a late
answer remains an abstention when replayed. Its timeout timers are cleaned up after completed decisions.
The statistical filter is deterministic; an external agent may be nondeterministic, but it remains
recorded shadow research and cannot change order size or account limits.

## Handoff and remaining work

- Base: `origin/claude/profarm-implementation-finish-c58a64` (`75ad323`). Working branch:
  `codex/prop-farm-expansion`. Changes preserve prior account and strategy IDs.
- OAuth discovery was checked against TradingView's real public metadata. The authorization exchange,
  PKCE, state replay protection, owner isolation and private persistence are tested with a fake provider.
  User authorization and real entitled futures responses have not been tested.
- FundedNext withdrawal-day scheduling, inactivity and microscalping adjustments remain explicit
  unknowns, so the source-checked numerical templates are marked partial, not fully verified.
- Brokerage remains sandbox-only. Broker fault-path integration coverage and the historical-paper-book
  missing-indicator explanation from the original status file are still follow-up work.
- The existing candle webhook is the separate route for Pine bar-close data. Authenticated MCP results
  are not automatically imported into strategy outcomes or labeled live.
- Existing Excalidraw/diagram dependency audit findings remain; the MCP SDK introduced no reported
  vulnerable package in the inspected audit. No broad dependency downgrade was attempted.

Validation: the full 622-test suite, TypeScript checks and production build passed; two additional
feed-readiness regressions and the 22-test focused suite passed after the final status correction.
Browser checks covered the FundedNext catalog, combined recipe selection, phase controls, completed
worker comparisons and disconnected TradingView status. No browser console errors appeared.
The real TradingView service accepted dynamic client registration; user authorization remains pending.

The readiness check now requires recent, non-delayed data for every market selected by active runs
(or NQ/ES/GC before a run exists). Fresh BTC data cannot turn the CME gate green. The sandbox gate
also remains blocked until the still-missing fault-path integration evidence exists.
