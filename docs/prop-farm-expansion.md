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
