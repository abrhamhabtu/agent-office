# Prop Farm: the plan

A plan for turning the Back Office into a prop-account farm: agents that backtest, a farm that runs
many evaluations and funded accounts on paper day by day, and, last and only when you arm it, real
orders. It starts from what the "Bot Farmer" screenshots show, checks that idea against this office's
own month of real bars, and lays out what to build in what order.

This is engineering and evidence, not financial advice. Every number below is paper evidence from one
month (21 trading days, September 2026, 541 trades on NQ, ES and GC), with no fees or slippage.

## 1. What he is doing

Read off the five screenshots (the reel itself has no transcript, and its comments call it a LARP, so
none of his results can be checked):

| What the screen shows | What it means |
| --- | --- |
| `LIVE-EVAL-7 PASSED`, `LONG 20 MNQZ6`, `TARGET +38 pts`, `+$1,502.00`, balance `$26,502` against a `$26,500` target | A $25K evaluation passed by **one trade**: 20 micro Nasdaq at $40 a point, 38 points to the target. The drawdown on that account is $1,000, which at 20 micros is a 25-point stop. So each eval is one bet: about +$1,500 or the account is gone. |
| `LIVE-EVAL-2 … 1 trade … LONG 8 target +$1,500.80` | Same thing on other evals, same day: several evaluations each take one all-in trade. |
| `FUNDED — ROTATION`, `LIVE-FUNDED-4 … SHORT 5 target +$240.50` | Funded accounts trade small: 5 micros, about $240 a winning day, and take turns ("rotation") rather than all taking the same trade. |
| `PAYOUT READY … 3/3 winning days … $721.50 profit (min $500) … best day 33% of profit (max 40%)` | The funded size is chosen so three equal winning days clear the payout rule exactly: over $500, and no day above 40%. |
| `PARKED — NO TRADES UNTIL PAID … Request it on FundedNext` | Once payout-ready the account stops trading until the withdrawal shows, then rejoins the rotation. |
| Discord `Bot Farmer` messages, `add its id to [live.real] funded_accounts` | A config file lists the real accounts; a bot posts every fill, pass and payout. |

So the system is four parts: **a signal** (deterministic), **a stage machine** per account (eval →
passed → funded → payout-ready → parked → paid), **a sizing policy per stage** (all-in on evals, small
on funded), and **a notifier**. The edge is not the signal. It is the arithmetic: an evaluation's real
cost is its fee, not the $1,000 drawdown, so a coin-flip trade that pays a funded account is worth
taking many times, as long as funded accounts actually pay.

The firm is FundedNext Futures. Its public rule summaries say: bots are allowed; copying between your
own accounts is allowed; **reverse hedging across accounts** (long on one, short on another) and
**account rolling** (deliberately blowing challenges) are prohibited; up to five accounts a person.
A farm of one-trade evals sits close to "account rolling", which is the main rule risk in copying him.
The summaries also disagree with the screenshots on the 25K contract limit (10 micros against the 20
he traded), so the firm's own page has to be read before any of this is relied on.

## 2. What this office's month says

The same idea run on the playbooks here, with the new fixed-contract sizing (pass / bust within 20
trading days, 2,000 redraws of the real days):

**Evaluation, FundedNext Rapid 25K (+$1,500 target, −$1,000 max loss)**

| What is traded | 5 micros | 10 micros | 20 micros |
| --- | --- | --- | --- |
| Support & Resistance when trending, VWAP Pullback when ranging | 66% / 34% | 57% / 43% | 51% / 49% |
| Support & Resistance, NQ only | 67% / 33% | 49% / 51% | 40% / 60% |
| Support & Resistance | 56% / 44% | 42% / 58% | 31% / 69% |
| Failed Auction | 50% / 50% | 35% / 65% | 34% / 66% |
| VWAP Pullback | 29% / 71% | 31% / 69% | 29% / 71% |
| Double Break | 19% / 81% | 28% / 72% | 27% / 73% |

**Funded, 25K (payout at $500+, three trading days, best day ≤ 40%, −$1,000 max loss), 30 days**

| What is traded | 2 micros | 3 micros | 5 micros |
| --- | --- | --- | --- |
| Support & Resistance when trending, VWAP Pullback when ranging | 94% / 6% | 86% / 14% | 69% / 31% |
| Support & Resistance, NQ only | 93% / 6% | 84% / 16% | 69% / 31% |
| Support & Resistance | 85% / 13% | 73% / 25% | 56% / 43% |
| Failed Auction | 24% / 30% | 23% / 57% | 19% / 76% |

Three things this says, on this month:

1. **Twenty contracts makes the evals worse here, not better.** The playbooks' stops are wide (a
   typical trade risks about $50 a micro), so 20 micros is the whole drawdown on one trade. Five
   micros passes more often and takes a day or two longer. His 38-point target with a 25-point stop
   is a much tighter trade than these playbooks take.
2. **Funded accounts want to be smaller still.** Two or three micros reaches a payout far more often
   than five.
3. **The playbook matters more than the size.** Support & Resistance carries it; VWAP Pullback and
   Double Break alone lose the eval most of the time.

The mix at the top was the best of many tried on the same 21 days, so it is flattered. Treat the
ranking as a lead to test forward, which is what the farm is for.

**The arithmetic to fill in.** With `F` the eval fee, `p` the chance an eval passes, `q` the chance a
funded account reaches a payout before it busts, and `P` what a payout pays after the split:

- cost of one funded account ≈ `F / p`
- payouts per funded account ≈ `q / (1 − q)` (it keeps going until it busts)
- value of one eval attempt ≈ `p × P × q / (1 − q) − F`

At the screenshots' $721.50 payout and an 80% split `P` is about $577. The farm console will carry
this calculator with your real fees, so the answer is yours rather than his.

## 3. What to build

### 3.1 Where it lives

Start inside the **Back Office**: a third console, **The Farm**, and the Live eval wall display grown
into a farm board (rows of accounts by stage, like his). Give it its own floor, **Prop Farm**, when
there are real accounts on it: a floor's role already comes from its name, so that is a small change,
and it keeps the proving ground and the live operation apart.

### 3.2 The pieces

| Piece | What it does | Built on |
| --- | --- | --- |
| **Account registry** | Every account in the farm: firm, program, size, stage, real account id once there is one, fees paid, payouts received. One file, `farm.json`, edited from the console. | The account catalog (now with 25K sizes and FundedNext) |
| **Stage machine** | `eval → passed → funded → payout-ready → parked → paid → funded`, and `busted`. Each move is a rule checked after every closed trade. | The eval simulator's rule engine |
| **Policy per stage** | Evaluation: aggressive, a fixed contract count up to the account's limit, a set number of "bullets". Funded: a small fixed size, one trade a day, stop for the day at the day's target, stop for good at payout-ready. | Fixed-contract sizing (in this branch), game plans, one-and-done |
| **Consistency guard** | Works out the largest day a funded account may have before it breaks the 40% rule, and sizes the day's target to stay under it. | The consistency check already in the simulator |
| **Rotation** | One signal goes to one account at a time. Never two of your accounts on opposite sides; a cap on how many share a trade. | New |
| **Strategy slots** | Each account is assigned a strategy: a playbook version, a mix, a management style. | Tuner versions, game plans, trade management |
| **Deterministic and judged strategies** | See 3.3. | Desk agents |
| **Research agents** | Agents at the Back Office desks run backtest and tuner jobs from the task queue and write up what held. | The queue and the stations that exist |
| **Notifier** | Every fill, pass, bust and payout-ready as a message: office toast and chat, and a Discord webhook if you give one. | The alert path that exists |
| **Farm calculator** | The arithmetic above with your fees, per firm and program, from the simulator's odds. | New |
| **Execution adapter** | See 3.4. | New |

### 3.3 Two kinds of strategy

- **Deterministic.** The playbooks as code: same bars in, same trade out. Versioned by the tuner,
  testable on any history, and the only kind that can be backtested honestly. This is the baseline
  every account can run.
- **Judged.** A desk agent that sees the deterministic signals plus what code can't weigh (the
  calendar, the news wire, how the day has gone) and may only do three things: **skip** a signal,
  **pick** between two, or **cut size**. It can't invent a trade or raise size, and every call is
  logged with its reason. Because an agent's judgment can't be replayed over old bars, it is tested
  forward only: the farm runs the same account twice on paper, once with the agent and once without,
  and the board shows which is ahead. If the agent doesn't beat the plain rules over enough days, it
  stays off real accounts.

### 3.4 From paper to real orders

One interface, three adapters, switched per account:

1. **Paper** (now). The farm takes the playbooks' paper trades as its fills. Nothing leaves the office.
2. **Practice.** The same orders sent to a simulated account at the broker, to prove the plumbing:
   sizes, brackets, rejections, partial fills, the flat-by-close rule.
3. **Real.** The same again on a real evaluation or funded account.

How orders reach a prop account depends on the firm's platform. FundedNext, Lucid and Apex run on
Tradovate or Rithmic; Topstep runs on ProjectX, which the office already connects to for reading. Two
routes, cheapest first:

- **A webhook bridge** (TradersPost or PickMyTrade, both listed as supported for these firms). The
  office posts a JSON order to the bridge and the bridge places it. No broker code to write, and it
  is the same shape as the TradingView alerts and the Trade Pilot forwarding the office already has.
  Your Pine scripts can use the same bridge, so a script and the office can be compared like for like.
- **The broker's own API** (ProjectX for Topstep, Tradovate's for the rest). More work, fewer moving
  parts, no monthly bridge fee.

**The guards, built before any adapter that can send an order:**

- Off by default. Each account is armed by you, in the console, one at a time, and can be disarmed
  with one click; a kill switch flattens and disarms everything.
- Hard limits the adapter enforces itself, whatever the strategy asks: contracts per stage, one
  position per account, a daily loss cap, no new trade inside the news window or after the last-entry
  time, flat by 13:00 PT.
- Every order carries its stop and target as a bracket at the broker, so a crash can't leave a naked
  position.
- The farm stops an account itself at payout-ready and at any rule it is one trade from breaking.
- An audit log of every decision and order, and a daily reconciliation of the office's view against
  the broker's.

### 3.5 The order of work

| Phase | What ships | Proves |
| --- | --- | --- |
| **0. Foundations** (built) | 25K accounts and FundedNext in the catalog; fixed-contract sizing with a contracts ladder; this plan. | The idea can be simulated with your own trades. |
| **1. The farm on paper** (built: registry of slots, stage machine, sizes by stage, rotation, the console, the wall display, Discord notices; still to do: a per-account strategy and the consistency guard) | Registry, stage machine, per-stage policy, consistency guard, rotation, the farm board and console, the calculator. Runs forward on the paper book every day. | Whether a farm of your playbooks passes evals and reaches payouts, day by day. |
| **2. Research agents and the judged strategy** | Queue jobs for backtests and tuner runs; the agent filter with its paired paper accounts; Discord notices. | Whether an agent's judgment beats the plain rules. |
| **3. More history** | Months of bars instead of one. | Whether any of the above holds outside September. |
| **4. Practice orders** | The adapter, the guards, the bridge or API route, on a simulated account. | The plumbing, with no money. |
| **5. Real orders** | One evaluation account, armed by you. More only after it has matched the paper farm. | The whole loop. |

Phases 1 and 2 need nothing from outside. Phase 3 needs a data source. Phases 4 and 5 need the
decisions below.

### 3.6 The firms you mean to use

None of this needs an account yet: the farm runs on paper for all three. What their public pages and
summaries say about running it for real (each to be checked with the firm before any money goes in):

| Firm | Automation | Across your own accounts | What it means for the farm |
| --- | --- | --- | --- |
| **Lucid** | Automated systems and trade copiers are permitted on evaluation and funded accounts. High-frequency trading, microscalping and hedging across accounts are not. | Copying across your own accounts is allowed; up to five funded accounts. | Fits. LucidFlex needs five profit days a payout; LucidDirect has a 20% consistency rule. |
| **Top One Futures** | Varies by account type: some may restrict a bot being attached or require manual trading. | Copying between your own accounts is allowed; opposing positions across accounts are not. | Ask support about Ignite before automating it. On paper, its 15% consistency rule makes it the hardest of the three. |
| **FundedNext Futures** | Bots and fully automated strategies are permitted on challenge and funded accounts. | Copying between your own accounts is allowed; reverse hedging and account rolling are not. | Fits, with the account-rolling rule as the thing to stay clear of. |

On the month here, three accounts trading Support & Resistance at 5 micros in the evaluation and 2 funded
typically net, over 60 days of redraws: LucidFlex 25K about +$6,900, FundedNext Rapid 25K about +$4,400,
LucidDirect 25K about +$1,900, and Top One Ignite 25K about −$190. Those figures lean on one good month
for that playbook and on the payout assumption in section 5, so they rank the programs more reliably than
they price them.

### 3.7 TradingView

There is no official TradingView connector, and TradingView has no API for running its Strategy Tester
from outside. Three ways to bring your real TradingView strategies in, in the order they are worth doing:

1. **Alerts into the farm** (next to build). Your Pine strategies already can post to the office's
   webhook. Each alert that carries an entry, a stop and a target becomes a paper trade, followed on the
   office's bars to its stop or target, and that stream of trades becomes a strategy the farm can run
   beside the office's own playbooks. This is live testing of exactly what your chart does, with nothing
   re-implemented.
2. **Your scripts in the Strategy Desk.** Added there, a script's exact rules are replayed by the office
   so it can be backtested and tuned on history, as the VWAP Double Break Suite already is.
3. **Driving TradingView itself.** Community tools exist that run Pine backtests outside TradingView or
   operate its desktop app. None is official, and each would have to be vetted before it is trusted with
   your account, so this comes last.

## 4. What is needed from you

- **Which program first** among Lucid, Top One and FundedNext. The Farm's battle test is there to help
  choose.
- **The real fees** for the evals and any activation, for the calculator.
- **A Discord webhook URL**, if you want the notices there.
- **A bridge account or API access** for phase 4: TradersPost or PickMyTrade, or TopstepX API access.
- **More history**: TopstepX API access can supply it; otherwise a paid data feed.
- **Your Pine scripts** for VWAP Pullback, Support & Resistance and Failed Auction, added at the
  Strategy Desk, so the office's replay follows your exact rules.

## 5. What could go wrong

- **One month of data.** Everything in section 2 could be September. Phase 3 exists for this.
- **The firm's rules.** One-trade evals in bulk can be read as account rolling; opposite positions on
  two accounts is banned outright; payouts can be refused. The farm's rotation and guards are built
  around these, and the firm's own rule page is the authority, not a summary.
- **Paper is kinder than real.** No fees, no slippage, and a fill on the signal candle's close.
  Twenty micros will fill; the price it fills at will be a little worse.
- **His results are unverified.** The screenshots show a dashboard, not a broker statement.
- **Automation fails in ways a person doesn't.** That is what the bracket orders, the hard limits,
  the kill switch and the daily reconciliation are for, and why practice orders come before real ones.

Real money is your switch to throw, per account. The office can build and test every step up to it.
