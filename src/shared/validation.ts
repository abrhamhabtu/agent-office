import type { PaperTrade } from './trading.js';
import { COSTS, withCosts, type CostId } from './fills.js';
import { farmOdds, type FarmOdds, type FarmSetup } from './farm.js';

// Honest strategy selection. A candidate is compared with its baseline on the same days and the same
// costs, in three stretches of the history that are kept apart:
//
//   training      the earlier days: where ideas come from
//   validation    the next days: where a candidate is judged, and may be looked at as often as you like
//   holdout       the last days: quarantined. It is opened once, for one chosen candidate, and the
//                 result is frozen. A period that has been consulted again and again is not
//                 out-of-sample proof, so every opening is counted and shown.
//
// Trying many variants and keeping the best finds luck as easily as it finds an edge, so the number of
// variants tried in the family is carried along, and the gap a candidate has to show grows with it.
// The account outcomes are redrawn in blocks of whole days, so what carries from one day to the next is
// kept. Every number here is a conditional scenario on paper, never a promised pass rate.

export interface Split {
  train: string[];
  validation: string[];
  holdout: string[];
}

/** The days in order, split half, a quarter and a quarter: the last quarter is the holdout. */
export function splitDays(days: string[], share: { train: number; validation: number } = { train: 0.5, validation: 0.25 }): Split {
  const sorted = [...new Set(days)].sort();
  const a = Math.round(sorted.length * share.train);
  const b = Math.round(sorted.length * (share.train + share.validation));
  return { train: sorted.slice(0, a), validation: sorted.slice(a, b), holdout: sorted.slice(b) };
}

export interface SliceStats {
  days: number;
  trades: number;
  winRate: number;
  /** After costs, in R of each trade's first risk. */
  avgR: number;
  totalR: number;
  stdR: number;
  maxDrawdownR: number;
  /** After costs, for one micro. */
  dollars: number;
}

const round = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

/** How a set of trades did on some of the days, after a cost model. */
export function sliceStats(trades: PaperTrade[], days: string[], cost: CostId = 'base'): SliceStats {
  const on = new Set(days);
  const list = withCosts(trades.filter((t) => t.outcome !== 'open' && on.has(t.day)), COSTS[cost]).sort((a, b) => a.entryAt - b.entryAt);
  const n = list.length;
  const total = list.reduce((a, t) => a + t.r, 0);
  const mean = n ? total / n : 0;
  let run = 0;
  let peak = 0;
  let dd = 0;
  for (const t of list) {
    run += t.r;
    peak = Math.max(peak, run);
    dd = Math.max(dd, peak - run);
  }
  return {
    days: days.length, trades: n, winRate: n ? round(list.filter((t) => t.r > 0).length / n) : 0, avgR: round(mean), totalR: round(total, 2),
    stdR: n > 1 ? round(Math.sqrt(list.reduce((a, t) => a + (t.r - mean) ** 2, 0) / (n - 1))) : 0, maxDrawdownR: round(dd, 2), dollars: Math.round(list.reduce((a, t) => a + t.dollars, 0)),
  };
}

/** A short, stable fingerprint of anything that can be written as JSON. */
export function fingerprint(value: unknown): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = (Math.imul(b ^ (c + i), 0x85ebca6b) + a) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/** The fingerprint of a set of trades as a dataset: which days, and what was taken on them. */
export function datasetHash(days: string[], trades: PaperTrade[]): string {
  return fingerprint([days, trades.length, trades.reduce((a, t) => a + Math.round(t.dollars * 100), 0), trades[0]?.id ?? '', trades[trades.length - 1]?.id ?? '']);
}

export interface Candidate {
  id: string;
  name: string;
  /** What it is a variant of: candidates in one family were searched for together. */
  family: string;
  trades: PaperTrade[];
  /** The days that were looked at when it was picked, when that's known. */
  selectedOn?: string[];
}

/**
 * Signs that a candidate saw something it couldn't have: a trade that ends before it starts, the same
 * trade twice, a trade on a day outside the data, timestamps that don't run in the order of their days
 * (a shuffled set), or a candidate that was picked on days inside the holdout.
 */
export function leakCheck(c: Candidate, days: string[], split: Split): string[] {
  const out: string[] = [];
  const known = new Set(days);
  const seen = new Set<string>();
  let dup = 0;
  let backwards = 0;
  let outside = 0;
  for (const t of c.trades) {
    if (seen.has(t.id)) dup++;
    seen.add(t.id);
    if (t.exitAt != null && t.exitAt < t.entryAt) backwards++;
    if (!known.has(t.day)) outside++;
  }
  if (dup) out.push(`${dup} trade${dup === 1 ? ' is' : 's are'} counted twice`);
  if (backwards) out.push(`${backwards} trade${backwards === 1 ? ' ends' : 's end'} before ${backwards === 1 ? 'it starts' : 'they start'}`);
  if (outside) out.push(`${outside} trade${outside === 1 ? ' is' : 's are'} on days that aren’t in the data`);
  // In order of time, the days must never go backwards: if they do, trades have been moved between days.
  const byTime = [...c.trades].sort((a, b) => a.entryAt - b.entryAt);
  let moved = 0;
  for (let i = 1; i < byTime.length; i++) if (byTime[i]!.day < byTime[i - 1]!.day) moved++;
  if (moved) out.push(`${moved} trade${moved === 1 ? '' : 's'} sit${moved === 1 ? 's' : ''} on a day earlier than a trade that happened before ${moved === 1 ? 'it' : 'them'}: the days have been shuffled`);
  const held = new Set(split.holdout);
  const peeked = (c.selectedOn ?? []).filter((d) => held.has(d)).length;
  if (peeked) out.push(`It was picked using ${peeked} of the holdout’s ${split.holdout.length} days, so the holdout can’t test it`);
  return out;
}

export type Verdict = 'promising' | 'inconclusive' | 'rejected' | 'leaky' | 'held' | 'failed-holdout';

export const VERDICT_WORD: Record<Verdict, string> = {
  promising: 'Promising: ready for its one look at the holdout', inconclusive: 'Inconclusive', rejected: 'Rejected', leaky: 'Not testable: it leaks', held: 'Held up on the holdout', 'failed-holdout': 'Failed on the holdout',
};

export interface ValidationReport {
  /** The fingerprint of everything that went in: the same data and settings give the same report. */
  id: string;
  dataset: string;
  candidate: { id: string; name: string; family: string };
  baseline: { id: string; name: string };
  cost: CostId;
  split: { train: number; validation: number; holdout: number; from: string; to: string; holdoutFrom: string };
  /** Variants tried in this family, this candidate included. */
  searchCount: number;
  train: { base: SliceStats; cand: SliceStats };
  validation: { base: SliceStats; cand: SliceStats };
  /** Null until the holdout is opened for this candidate. */
  holdout: { base: SliceStats; cand: SliceStats } | null;
  /** The candidate's edge over the baseline on the validation days, against the noise in that many trades. */
  z: number;
  /** The z a candidate needs: what the best of `searchCount` lucky tries would show. */
  hurdle: number;
  /** The same comparison at each cost setting, on the training and validation days together. */
  stress: { cost: CostId; base: number; cand: number }[];
  /** What a farm of each would have done over redraws of the training and validation days. */
  account: { base: FarmOdds; cand: FarmOdds } | null;
  leaks: string[];
  verdict: Verdict;
  reasons: string[];
}

export interface ValidateOptions {
  days: string[];
  searchCount: number;
  cost?: CostId;
  /** Open the holdout for this candidate. Do it once, for the one that was chosen. */
  openHoldout?: boolean;
  /** Fewer trades than this on a stretch and it can't be judged. */
  minTrades?: number;
  /** The farm to play both through for the account outcomes (none: skip them). */
  farm?: FarmSetup | null;
  seed?: number;
  runs?: number;
}

const lists = (trades: PaperTrade[], days: string[]) => {
  const by = new Map<string, PaperTrade[]>(days.map((d) => [d, []]));
  for (const t of trades) if (t.outcome !== 'open') by.get(t.day)?.push(t);
  return days.map((d) => by.get(d)!.sort((a, b) => a.entryAt - b.entryAt));
};

/** Judges a candidate against its baseline. Deterministic: the same inputs give the same report. */
export function validate(candidate: Candidate, baseline: Candidate, o: ValidateOptions): ValidationReport {
  const cost = o.cost ?? 'base';
  const minTrades = o.minTrades ?? 20;
  const split = splitDays(o.days);
  const searchCount = Math.max(1, Math.round(o.searchCount));
  const leaks = leakCheck(candidate, o.days, split);
  const pair = (days: string[]) => ({ base: sliceStats(baseline.trades, days, cost), cand: sliceStats(candidate.trades, days, cost) });
  const train = pair(split.train);
  const validation = pair(split.validation);
  const seen = [...split.train, ...split.validation];
  const se = Math.sqrt(validation.base.stdR ** 2 / Math.max(1, validation.base.trades) + validation.cand.stdR ** 2 / Math.max(1, validation.cand.trades));
  const z = se > 0 ? round((validation.cand.avgR - validation.base.avgR) / se, 2) : 0;
  // The best of N tries on pure noise sits about sqrt(2 ln N) noise-widths out; one honest try still has to clear 1.
  const hurdle = round(Math.max(1, Math.sqrt(2 * Math.log(searchCount))), 2);
  const stress = (['gross', 'base', 'stressed'] as CostId[]).map((c) => ({ cost: c, base: sliceStats(baseline.trades, seen, c).avgR, cand: sliceStats(candidate.trades, seen, c).avgR }));
  const account = o.farm ? { base: farmOdds(lists(baseline.trades, seen), o.farm, { runs: o.runs ?? 150, horizon: 60, seed: o.seed ?? 11, block: 3 }), cand: farmOdds(lists(candidate.trades, seen), o.farm, { runs: o.runs ?? 150, horizon: 60, seed: o.seed ?? 11, block: 3 }) } : null;
  const holdout = o.openHoldout && !leaks.length ? pair(split.holdout) : null;

  const reasons: string[] = [];
  let verdict: Verdict;
  const f = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}R`;
  if (leaks.length) {
    verdict = 'leaky';
    reasons.push(...leaks);
  } else if (validation.cand.trades < minTrades || validation.base.trades < minTrades) {
    verdict = 'inconclusive';
    reasons.push(`Only ${Math.min(validation.cand.trades, validation.base.trades)} trades on the validation days: ${minTrades} are needed to say anything`);
  } else if (validation.cand.avgR <= validation.base.avgR) {
    verdict = 'rejected';
    reasons.push(`No better than the baseline on the validation days (${f(validation.cand.avgR)} against ${f(validation.base.avgR)} a trade)`);
  } else if (stress[2]!.cand <= 0) {
    verdict = 'rejected';
    reasons.push(`Under stressed costs it loses money (${f(stress[2]!.cand)} a trade): the edge is thinner than the costs`);
  } else if (train.cand.avgR < train.base.avgR - 0.02) {
    verdict = 'inconclusive';
    reasons.push(`Better on the validation days but worse on the training days (${f(train.cand.avgR)} against ${f(train.base.avgR)}): it may be one stretch’s luck`);
  } else if (z < hurdle) {
    verdict = 'inconclusive';
    reasons.push(`${f(validation.cand.avgR - validation.base.avgR)} a trade better on the validation days, which is ${z} noise-widths; with ${searchCount} variant${searchCount === 1 ? '' : 's'} tried, luck alone reaches ${hurdle}`);
  } else {
    verdict = 'promising';
    reasons.push(`${f(validation.cand.avgR - validation.base.avgR)} a trade better on the validation days (${z} noise-widths against a hurdle of ${hurdle} for ${searchCount} variant${searchCount === 1 ? '' : 's'}), no worse on the training days, and still positive under stressed costs`);
  }
  if (holdout && (verdict === 'promising' || verdict === 'inconclusive')) {
    const was = verdict;
    if (holdout.cand.trades < Math.max(5, Math.floor(minTrades / 4))) {
      verdict = 'inconclusive';
      reasons.push(`The holdout has only ${holdout.cand.trades} trades: not enough to confirm or refute it`);
    } else if (holdout.cand.avgR > holdout.base.avgR && holdout.cand.avgR > 0 && was === 'promising') {
      verdict = 'held';
      reasons.push(`On the untouched holdout it made ${f(holdout.cand.avgR)} a trade against the baseline’s ${f(holdout.base.avgR)}`);
    } else {
      verdict = 'failed-holdout';
      reasons.push(`On the untouched holdout it made ${f(holdout.cand.avgR)} a trade against the baseline’s ${f(holdout.base.avgR)}: what it showed before did not carry`);
    }
  }
  const sorted = [...new Set(o.days)].sort();
  const body = {
    dataset: datasetHash(sorted, baseline.trades), candidate: { id: candidate.id, name: candidate.name, family: candidate.family }, baseline: { id: baseline.id, name: baseline.name }, cost,
    split: { train: split.train.length, validation: split.validation.length, holdout: split.holdout.length, from: sorted[0] ?? '', to: sorted[sorted.length - 1] ?? '', holdoutFrom: split.holdout[0] ?? '' },
    searchCount, train, validation, holdout, z, hurdle, stress, account, leaks, verdict, reasons,
  };
  return { id: fingerprint([body.dataset, candidate.id, datasetHash(sorted, candidate.trades), baseline.id, cost, searchCount, !!o.openHoldout, minTrades, o.farm ?? null, o.seed ?? 11, o.runs ?? 150]), ...body };
}

/** The gate a forward run has to clear before anything is promoted: planning thresholds, not proof. */
export const RELEASE_GATE = { sessions: 30, trades: 100 } as const;
