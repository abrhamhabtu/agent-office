import type { PaperTrade, PlaybookId } from './trading.js';
import { PLAYBOOK_BY_ID } from './trading.js';
import { labStats, type LabStats } from './backtest-lab.js';

// Game plans: ways of trading more than one playbook in a day that aren't just "take everything".
//
//   every      take every setup the chosen playbooks call
//   fallback   one playbook goes first; the next only gets its turn once the one before has failed today
//   by-day     one playbook for a trending market, another for a ranging one
//
// and two rules about when to stop: one and done (a winner ends the day), and a cap on trades a day.
// A plan is applied to the backtest's trades after the fact, in the order they were entered, using only
// what was known at each entry: whether an earlier trade had already closed, and what ADX read on the
// entry bar. So it answers "what if I had traded the month this way" without re-running anything.

export type PlanMode = 'every' | 'fallback' | 'by-day';

export interface DayPlan {
  mode: PlanMode;
  /** fallback: the playbooks in the order they get their turn. by-day: [when trending, when ranging]. every: the set. */
  order: PlaybookId[];
  /** A winner ends the day. */
  oneAndDone: boolean;
  /** At most this many trades a day (0: no cap). */
  maxTrades: number;
}

/** A playbook that hasn't set up by 08:00 PT has had its chance: the fallback gets its turn. */
export const FALLBACK_AFTER = 480;
/** ADX at or above this on the entry bar is a trending market; below it, a ranging one. */
export const TREND_ADX = 20;

const short = (p: PlaybookId) => PLAYBOOK_BY_ID[p].name;

/** A plan in a line: "VWAP Pullback first, Failed Auction if it fails". */
export function planLabel(p: DayPlan): string {
  const [a, b, ...rest] = p.order;
  let s: string;
  if (!a) s = 'Nothing picked';
  else if (p.mode === 'fallback' && b) s = `${short(a)} first, then ${[b, ...rest].map(short).join(', then ')} if it fails`;
  else if (p.mode === 'by-day' && b) s = `${short(a)} when it’s trending, ${short(b)} when it’s ranging`;
  else s = p.order.length === 1 ? short(a) : p.order.length === 2 ? `${short(a)} and ${short(b!)}, every setup` : `${p.order.length} playbooks, every setup`;
  if (p.oneAndDone) s += ' · one and done';
  if (p.maxTrades) s += ` · ${p.maxTrades} a day at most`;
  return s;
}

/** The trades a plan would have taken, in the order they were entered. */
export function applyPlan(trades: PaperTrade[], plan: DayPlan): PaperTrade[] {
  const rank = new Map(plan.order.map((p, i) => [p, i]));
  const byDay = new Map<string, PaperTrade[]>();
  for (const t of trades) {
    if (t.outcome === 'open' || !rank.has(t.playbook)) continue;
    byDay.set(t.day, [...(byDay.get(t.day) ?? []), t]);
  }
  const out: PaperTrade[] = [];
  for (const day of [...byDay.keys()].sort()) {
    const list = byDay.get(day)!.sort((a, b) => a.entryAt - b.entryAt);
    const taken: PaperTrade[] = [];
    const closedBy = (t: PaperTrade, at: number) => t.exitAt != null && t.exitAt <= at;
    for (const t of list) {
      const at = t.entryAt;
      if (plan.maxTrades && taken.length >= plan.maxTrades) break;
      if (plan.oneAndDone && taken.some((x) => x.r > 0 && closedBy(x, at))) break;
      const k = rank.get(t.playbook)!;
      if (plan.mode === 'by-day') {
        const adx = t.ind?.adx;
        if (adx == null) continue;
        // With only one playbook picked there is no other side to wait for: it trades trending markets.
        if (k !== (adx >= TREND_ADX ? 0 : Math.min(1, plan.order.length - 1))) continue;
      } else if (plan.mode === 'fallback' && k > 0) {
        // Its turn only comes once every playbook ahead of it has failed: lost today without a winner,
        // or never set up by the cutoff. One still in a trade hasn't failed yet.
        const failed = plan.order.slice(0, k).every((p) => {
          const theirs = taken.filter((x) => x.playbook === p);
          if (!theirs.length) return (t.ind?.m ?? 0) >= FALLBACK_AFTER;
          return theirs.every((x) => closedBy(x, at)) && !theirs.some((x) => x.r > 0);
        });
        if (!failed) continue;
      }
      taken.push(t);
    }
    out.push(...taken);
  }
  return out;
}

export interface RankedPlan {
  plan: DayPlan;
  label: string;
  stats: LabStats;
  /** The later third of the days, which a mix isn't picked on. */
  laterAvgR: number;
}

/** Every way of mixing two of `playbooks` (each order of a fallback, each split by kind of day), each one alone, and all together. */
export function plansOf(playbooks: PlaybookId[]): DayPlan[] {
  const base = { oneAndDone: false, maxTrades: 0 };
  const out: DayPlan[] = playbooks.map((p) => ({ mode: 'every' as const, order: [p], ...base }));
  if (playbooks.length > 1) out.push({ mode: 'every', order: [...playbooks], ...base });
  for (const a of playbooks)
    for (const b of playbooks) {
      if (a === b) continue;
      out.push({ mode: 'fallback', order: [a, b], ...base }, { mode: 'by-day', order: [a, b], ...base });
    }
  return out;
}

/** How each plan did, best per trade first. A plan with too few trades to mean anything goes to the bottom. */
export function rankPlans(trades: PaperTrade[], playbooks: PlaybookId[], days: string[], minTrades = 20): RankedPlan[] {
  const later = new Set(days.slice(Math.ceil((days.length * 2) / 3)));
  return plansOf(playbooks)
    .map((plan) => {
      const taken = applyPlan(trades, plan);
      return { plan, label: planLabel(plan), stats: labStats(taken), laterAvgR: labStats(taken.filter((t) => later.has(t.day))).avgR };
    })
    .sort((a, b) => Number(b.stats.trades >= minTrades) - Number(a.stats.trades >= minTrades) || b.stats.avgR - a.stats.avgR);
}
