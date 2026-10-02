import type { Symbol } from './trading.js';
import { INSTRUMENTS } from './trading.js';
import { COSTS, riskPerMicro, type CostModel } from './fills.js';
import type { RuleSet } from './prop-rules.js';

// The risk governor. Every order, from any strategy, deterministic or agent-judged, is sized here and
// nowhere else. The size is the smallest of three things:
//
//   the cap that was asked for       (a research setting: "up to 20 micros on evaluations")
//   what the firm still allows       (its contract limit now, less what's already held or resting)
//   what the dollar budgets can carry (the cushion, less a reserve, less risk already open; the day's
//                                      loss allowance; the farm's allowance across accounts)
//
// and it says which of them decided, in words, so an account can always answer "why this quantity?" and
// "why no trade?". A cap is an upper bound to experiment with, never an order size: the same 20-micro
// cap is 20 micros on a tight stop and 6 on a wide one. If not even one micro fits, the trade is skipped.

export interface RiskPolicy {
  id: string;
  name: string;
  /** The most micros to ask for on one trade. */
  cap: number;
  /** The share of the cushion (after the reserve) one trade may risk: 0.1 is the Law of 10, 1 is all of it. */
  cushionShare: number;
  /** Drawdown kept back and never risked, in dollars. */
  reserve: number;
  /** The most the account may lose in a day before it stops, as a share of the cushion at the open (null: no day budget). */
  dayShare: number | null;
}

/** The baseline: a tenth of the cushion a trade, a fifth a day, up to the firm's limit. */
export const CUSHION_BASELINE: RiskPolicy = { id: 'cushion', name: 'Cushion-based', cap: Infinity, cushionShare: 0.1, reserve: 0, dayShare: 0.2 };

/** A fixed cap: ask for this many micros every time, as far as the cushion can carry them. */
export const capPolicy = (cap: number): RiskPolicy => ({ id: `cap-${cap}`, name: `Up to ${cap} micros`, cap, cushionShare: 1, reserve: 0, dayShare: null });

/** The caps the plan asks to compare, by phase. */
export const EXPERIMENT_CAPS = { eval: [5, 10, 15, 20], funded: [3, 5] } as const;

/** Why a size came out as it did. */
export type LimitName = 'cap' | 'firm' | 'cushion' | 'day' | 'portfolio';

export interface SizeInput {
  symbol: Symbol;
  /** The stop's distance from the entry, in points. */
  stopPoints: number;
  policy: RiskPolicy;
  cost?: CostModel;
  /** The firm's limit now (a funded account's scaling step), and what's already held or resting. */
  allowedMicros: number;
  openMicros?: number;
  pendingMicros?: number;
  /** Drawdown left, and dollars already at risk on open and resting orders. */
  cushion: number;
  openRisk?: number;
  /** The cushion at today's open and what the day has lost so far (a positive number), for the day budget. */
  dayStartCushion?: number;
  dayLoss?: number;
  /** The firm's own daily loss limit, when the account has one. */
  dailyLossLimit?: number | null;
  /** The farm's allowance across all accounts, and what's already at risk across them. */
  portfolio?: { limit: number; openRisk: number } | null;
}

export interface SizeDecision {
  micros: number;
  /** What one micro can lose at the stop, fees and slippage included. */
  perMicro: number;
  /** What the trade risks at this size. */
  risk: number;
  /** Each limit and the micros it would allow. */
  limits: { name: LimitName; micros: number; detail: string }[];
  /** The limit that decided. */
  binding: LimitName;
  /** The answer in a sentence: why this many, or why none. */
  why: string;
  /** A short code for the ledger: `sized:cap`, `skip:cushion`. */
  code: string;
}

const $ = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;

/** How many micros this trade gets on this account, and why. */
export function sizeTrade(i: SizeInput): SizeDecision {
  const cost = i.cost ?? COSTS.base;
  const perMicro = riskPerMicro(i.symbol, i.stopPoints, cost);
  const micro = INSTRUMENTS[i.symbol].micro;
  const fit = (budget: number) => (perMicro > 0 ? Math.max(0, Math.floor((budget + 1e-9) / perMicro)) : 0);
  const openRisk = i.openRisk ?? 0;
  const held = (i.openMicros ?? 0) + (i.pendingMicros ?? 0);
  const limits: SizeDecision['limits'] = [];
  limits.push({ name: 'cap', micros: Number.isFinite(i.policy.cap) ? Math.max(0, Math.floor(i.policy.cap)) : Infinity, detail: Number.isFinite(i.policy.cap) ? `the cap asked for is ${i.policy.cap}` : 'no cap asked for' });
  limits.push({ name: 'firm', micros: Math.max(0, i.allowedMicros - held), detail: held ? `the firm allows ${i.allowedMicros} and ${held} are already held or resting` : `the firm allows ${i.allowedMicros}` });
  const usable = Math.max(0, i.cushion - i.policy.reserve);
  const cushionBudget = Math.max(0, usable * i.policy.cushionShare - openRisk);
  limits.push({ name: 'cushion', micros: fit(cushionBudget), detail: `${$(cushionBudget)} of the ${$(i.cushion)} cushion may be risked${i.policy.reserve ? ` (${$(i.policy.reserve)} is held back)` : ''}${openRisk ? `, with ${$(openRisk)} already at risk` : ''}, and one ${micro} risks ${$(perMicro)}` });
  const dayBudgets: number[] = [];
  if (i.policy.dayShare != null) dayBudgets.push((i.dayStartCushion ?? i.cushion) * i.policy.dayShare);
  if (i.dailyLossLimit != null) dayBudgets.push(i.dailyLossLimit);
  if (dayBudgets.length) {
    const left = Math.max(0, Math.min(...dayBudgets) - (i.dayLoss ?? 0) - openRisk);
    limits.push({ name: 'day', micros: fit(left), detail: `${$(left)} of today's loss allowance is left` });
  }
  if (i.portfolio) {
    const left = Math.max(0, i.portfolio.limit - i.portfolio.openRisk);
    limits.push({ name: 'portfolio', micros: fit(left), detail: `${$(left)} of the farm's ${$(i.portfolio.limit)} allowance across accounts is left` });
  }
  // The tightest limit decides; on a tie, the one listed first (the cap, then the firm, then the budgets).
  const binding = limits.reduce((a, b) => (b.micros < a.micros ? b : a));
  const micros = Number.isFinite(binding.micros) ? binding.micros : 0;
  const risk = Math.round(micros * perMicro * 100) / 100;
  if (micros < 1) {
    return { micros: 0, perMicro, risk: 0, limits, binding: binding.name, code: `skip:${binding.name}`, why: `No trade: ${binding.detail}, so not even one ${micro} fits.` };
  }
  return { micros, perMicro, risk, limits, binding: binding.name, code: `sized:${binding.name}`, why: `${micros} ${micro}, risking ${$(risk)}: ${binding.detail}.` };
}

/** Why a policy can't be run on a rule set at all (null: it can). An illegal request is refused, not quietly shrunk. */
export function policyProblem(policy: RiskPolicy, rules: RuleSet): string | null {
  if (!(policy.cap >= 1)) return 'The cap must be at least one micro';
  if (Number.isFinite(policy.cap) && policy.cap > rules.maxMicros) return `${rules.firm} ${rules.program} allows ${rules.maxMicros} micros at most: a cap of ${policy.cap} can't be run on it`;
  if (!(policy.cushionShare > 0 && policy.cushionShare <= 1)) return 'The share of the cushion to risk must be between 0 and 100%';
  if (policy.reserve < 0 || policy.reserve >= rules.drawdown) return `The reserve must be less than the ${$(rules.drawdown)} drawdown`;
  return null;
}

/** What a stop loses at each size, before and after costs: the plan's risk table, for any market. */
export function riskTable(symbol: Symbol, micros: number[], stops: number[], cost: CostModel = COSTS.gross): { micros: number; stops: { points: number; loss: number }[] }[] {
  return micros.map((n) => ({ micros: n, stops: stops.map((points) => ({ points, loss: Math.round(n * riskPerMicro(symbol, points, cost) * 100) / 100 })) }));
}

/**
 * Opposite positions on one market across the owner's accounts are prohibited by the firms: a new one that
 * would make a pair is refused. On the same account it would close what is held rather than open a trade,
 * so that is refused too.
 */
export function crossAccountConflict(symbol: Symbol, side: 'long' | 'short', held: { account: string; symbol: Symbol; side: 'long' | 'short' }[], forAccount: string): string | null {
  const other = held.find((h) => h.symbol === symbol && h.side !== side && h.account !== forAccount);
  if (other) return `${other.account} is ${other.side} ${symbol}: an opposite position on another of your accounts is prohibited`;
  const own = held.find((h) => h.symbol === symbol && h.side !== side);
  return own ? `${own.account} is already ${own.side} ${symbol}: an opposite order would close that trade, not open one` : null;
}
