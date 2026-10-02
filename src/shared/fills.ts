import type { Symbol } from './trading.js';
import { INSTRUMENTS } from './trading.js';

// How a simulated order is filled, and what it costs. One policy, written down, used by the playbook
// engine, the Pine replay, the account ledger and the farm, so their results can be compared.
//
// Two policies:
//   realistic    the stop is looked at before the target when one bar touches both; a bar that opens
//                past the stop fills at the open, which is worse than the stop; a target is never filled
//                better than its price.
//   pine-parity  what the owner's Pine script does on TradingView: the target is looked at first, and a
//                stop fills at its own price. It exists to check the office's replay against the chart,
//                not to judge a strategy.
//
// Minute bars can't say which of two prices inside one bar traded first. A fill that depended on that
// guess is marked `ambiguous`, so a result can say how much of it rests on the guess.
//
// Costs are kept apart from fills: the engine records gross fills, and a cost model is applied on top,
// so the same trades can be read gross, at an ordinary cost and at a stressed one.

export type FillPolicyId = 'realistic' | 'pine-parity';

export interface FillPolicy {
  id: FillPolicyId;
  name: string;
  /** Which is taken when one bar touches both the stop and the target. */
  sameBar: 'stop-first' | 'target-first';
  /** A bar that opens beyond the stop: filled at that open (worse), or at the stop's own price. */
  gaps: 'adverse-open' | 'at-level';
  what: string;
}

export const REALISTIC: FillPolicy = { id: 'realistic', name: 'Realistic', sameBar: 'stop-first', gaps: 'adverse-open', what: 'Stop before target inside one bar; a gap through the stop fills at the open; a target never fills better than its price.' };
export const PINE_PARITY: FillPolicy = { id: 'pine-parity', name: 'Pine parity', sameBar: 'target-first', gaps: 'at-level', what: 'As the Pine script counts it on the chart: target before stop inside one bar, and a stop fills at its own price. For checking the replay against TradingView only.' };
export const FILL_POLICIES: Record<FillPolicyId, FillPolicy> = { realistic: REALISTIC, 'pine-parity': PINE_PARITY };

export interface ExitFill {
  price: number;
  outcome: 'win' | 'loss';
  /** The bar touched both the stop and the target: which came first is the policy's guess. */
  ambiguous: boolean;
  /** The bar opened beyond the stop, so the fill is worse than the stop. */
  gapped: boolean;
}

/** Whether a resting stop or target is filled on this bar, and where. `target` null: only a stop is working. */
export function exitOnBar(side: 'long' | 'short', stop: number, target: number | null, bar: { open: number; high: number; low: number }, policy: FillPolicy = REALISTIC): ExitFill | null {
  const long = side === 'long';
  const hitStop = long ? bar.low <= stop : bar.high >= stop;
  const hitTarget = target != null && (long ? bar.high >= target : bar.low <= target);
  if (!hitStop && !hitTarget) return null;
  const opensPastStop = long ? bar.open <= stop : bar.open >= stop;
  const opensPastTarget = target != null && (long ? bar.open >= target : bar.open <= target);
  const stopFill = (ambiguous: boolean): ExitFill => {
    const gapped = policy.gaps === 'adverse-open' && opensPastStop && bar.open !== stop;
    return { price: gapped ? bar.open : stop, outcome: 'loss', ambiguous, gapped };
  };
  const targetFill = (ambiguous: boolean): ExitFill => ({ price: target!, outcome: 'win', ambiguous, gapped: false });
  if (hitStop && hitTarget) {
    // The open settles it when the bar opened already through one of them: that one traded first.
    if (opensPastStop) return stopFill(false);
    if (opensPastTarget) return targetFill(false);
    return policy.sameBar === 'stop-first' ? stopFill(true) : targetFill(true);
  }
  return hitStop ? stopFill(false) : targetFill(false);
}

/** When a bar is complete and a decision made on it can be acted on: its close, not its open. */
export const barCloseAt = (bar: { ts: number }, minutes = 1) => bar.ts + minutes * 60_000;

export interface Receipt {
  /** When the bar closed at the exchange. */
  closedAt: number;
  receivedAt: number;
  /** How long after its close the office had it. */
  delayMs: number;
  /** Too late to call a live decision: the feed is delayed, or the office was catching up. */
  late: boolean;
}

/** How late a bar reached the office. Past `lateAfterMs` a decision on it is a delayed replay, not a live one. */
export function receipt(bar: { ts: number }, receivedAt: number, lateAfterMs = 90_000, minutes = 1): Receipt {
  const closedAt = barCloseAt(bar, minutes);
  const delayMs = Math.max(0, receivedAt - closedAt);
  return { closedAt, receivedAt, delayMs, late: delayMs > lateAfterMs };
}

/** Minutes missing from a run of one-minute bars: [first missing bar's time, how many]. */
export function barGaps(bars: { ts: number }[], minutes = 1): { at: number; missing: number }[] {
  const out: { at: number; missing: number }[] = [];
  const step = minutes * 60_000;
  for (let i = 1; i < bars.length; i++) {
    const gap = Math.round((bars[i]!.ts - bars[i - 1]!.ts) / step) - 1;
    if (gap > 0) out.push({ at: bars[i - 1]!.ts + step, missing: gap });
  }
  return out;
}

// ---- Costs ---------------------------------------------------------------------------------------------

export type CostId = 'gross' | 'base' | 'stressed';

export interface CostModel {
  id: CostId;
  name: string;
  /** Commission and exchange fees for one micro, one side, in dollars. */
  perSide: number;
  /** Ticks given up on a market or stop entry, and on a stop or a flat-at-the-close exit. A target is a resting limit: none. */
  entryTicks: number;
  stopTicks: number;
  what: string;
}

/**
 * The fee is an assumption (firms and data plans differ, and it is the owner's to set): about what a
 * micro costs all-in at a retail futures broker. Stressed doubles the slippage and raises the fee.
 */
export const COSTS: Record<CostId, CostModel> = {
  gross: { id: 'gross', name: 'No costs', perSide: 0, entryTicks: 0, stopTicks: 0, what: 'Gross: no fees, no slippage. Only for comparing with a chart.' },
  base: { id: 'base', name: 'Ordinary', perSide: 0.62, entryTicks: 1, stopTicks: 1, what: '$0.62 a side per micro (assumed), one tick lost getting in and one on a stop.' },
  stressed: { id: 'stressed', name: 'Stressed', perSide: 1, entryTicks: 2, stopTicks: 3, what: '$1.00 a side per micro, two ticks lost getting in and three on a stop: a fast market.' },
};
export const COST_IDS: CostId[] = ['gross', 'base', 'stressed'];

/** What one tick of a market's micro is worth. */
export const tickValue = (symbol: Symbol) => INSTRUMENTS[symbol].tick * INSTRUMENTS[symbol].microPointValue;

/** The round trip's cost for one micro, by how the trade ended. */
export function costPerMicro(symbol: Symbol, outcome: 'win' | 'loss' | 'time' | 'open', cost: CostModel): number {
  const exitTicks = outcome === 'win' ? 0 : cost.stopTicks;
  return Math.round((2 * cost.perSide + (cost.entryTicks + exitTicks) * tickValue(symbol)) * 100) / 100;
}

/** The most one micro can lose at its stop, with the round trip's fees and the slippage allowed for. */
export function riskPerMicro(symbol: Symbol, stopPoints: number, cost: CostModel): number {
  return Math.round((Math.abs(stopPoints) * INSTRUMENTS[symbol].microPointValue + costPerMicro(symbol, 'loss', cost)) * 100) / 100;
}

/** A trade's result for one micro after costs. */
export function netDollars(t: { symbol: Symbol; outcome: 'win' | 'loss' | 'time' | 'open'; dollars: number }, cost: CostModel): number {
  return Math.round((t.dollars - costPerMicro(t.symbol, t.outcome, cost)) * 100) / 100;
}

/** The same trades with their dollars (and R, against the first risk) after costs. */
export function withCosts<T extends { symbol: Symbol; outcome: 'win' | 'loss' | 'time' | 'open'; dollars: number; r: number; entry: number; stop: number }>(trades: T[], cost: CostModel): T[] {
  if (cost.id === 'gross') return trades;
  return trades.map((t) => {
    if (t.outcome === 'open') return t;
    const dollars = netDollars(t, cost);
    const risk = Math.abs(t.entry - t.stop) * INSTRUMENTS[t.symbol].microPointValue;
    return { ...t, dollars, r: risk > 0 ? Math.round((dollars / risk) * 1000) / 1000 : t.r };
  });
}
