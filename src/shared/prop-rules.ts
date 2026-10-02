import { FUNDEDNEXT_RULESETS } from './fundednext-rules.js';
import type { PropRules } from './trading.js';

// Versioned prop-firm rules. A rule set is one firm's program at one size in one phase, as it was sold
// from a date (its cohort), with where each number came from. An account is opened on a rule set and
// keeps it: when a firm's website changes, a new cohort is added and existing accounts are left alone.
//
// Every number says how it is known:
//   verified   read on the firm's own page on `verifiedOn`
//   reported   from a public summary or a screenshot, not the firm's page
//   assumed    not published where it was looked for: a stand-in so the simulator can run
// and anything that isn't known at all is listed in `unknowns`. Unknown is not unlimited: a rule set
// with unknowns can be simulated as a labelled what-if, but it can never produce a verified pass, and
// nothing is promoted or automated on it.

export type Provenance = 'verified' | 'reported' | 'assumed';
export type Automation = 'allowed' | 'prohibited' | 'unknown';

export interface PayoutRule {
  /** Days in the cycle that each made at least `profitDayMin`. */
  profitDays: number;
  profitDayMin: number;
  /** Profit over the opening balance the account needs before a request. */
  minProfit: number;
  /** Required new profit since the last withdrawal, separate from retained balance. */
  minCycleProfit?: number;
  /** The least and the most one request may be (null: no cap). */
  minRequest: number;
  maxRequest: number | null;
  /** The share of the profit that may be withdrawn in one request. */
  withdrawShare: number;
  /** The owner's share of what is withdrawn. */
  split: number;
  /** The best day as a share of the cycle's profit may not exceed this (100: no rule). */
  consistencyPercent: number;
  /** When a payout is requested the floor moves to the opening balance plus this (null: it stays where it is). */
  floorOnRequest: number | null;
  /** What a paid account is afterwards: the same balance less the withdrawal, or a fresh account. */
  after: 'keep' | 'reset';
  /** Payouts an account may take before the firm moves it on (null: no limit known). */
  maxPayouts: number | null;
  /** Business days from the request to the money. */
  processingDays: number;
}

export interface RuleSet {
  /** `template:phase@cohort`. */
  id: string;
  /** The program and size, shared by its evaluation and funded rule sets: "lucidflex-25k". */
  template: string;
  firm: string;
  program: string;
  size: number;
  phase: 'eval' | 'funded';
  /** The rules as sold from this month (YYYY-MM). */
  cohort: string;
  /** The day the firm's own pages were last read for it (null: never). */
  verifiedOn: string | null;
  sources: { label: string; url: string }[];
  /** Profit that passes the evaluation (0 for a funded account). */
  profitTarget: number;
  drawdown: number;
  drawdownType: 'trailing-eod' | 'trailing-intraday' | 'static';
  /** The floor stops trailing at the opening balance plus this (null: it trails for ever). */
  lockProfit: number | null;
  /** A day's loss that stops trading for the day (null: none). */
  dailyLossLimit: number | null;
  /** The most micros the program allows at this size. */
  maxMicros: number;
  /** Funded accounts start below the ceiling: the micros allowed once the profit is at least each step. Set at the session's end. */
  scaling: { profit: number; micros: number }[] | null;
  /** The best day as a share of the profit may not exceed this to pass (100: no rule). */
  consistencyPercent: number;
  consistencyBasis: 'profitTarget' | 'totalProfit';
  minTradingDays: number;
  payout: PayoutRule | null;
  automation: Automation;
  /** What an attempt costs (null: not published where it was looked for; the owner sets it). */
  fee: number | null;
  activation: number;
  /** How each group of numbers is known; a group not listed is `basis`. */
  basis: Provenance;
  provenance: Partial<Record<'target' | 'drawdown' | 'limits' | 'scaling' | 'consistency' | 'days' | 'payout' | 'fee' | 'automation', Provenance>>;
  /** What isn't known. Not empty: every result on it is a what-if. */
  unknowns: string[];
  notes: string[];
}

const LUCID = (article: string, label: string) => ({ label, url: `https://support.lucidtrading.com/en/articles/${article}` });
const LUCID_SOURCES = [
  LUCID('12945790-lucidflex-evaluation-account', 'LucidFlex evaluation'),
  LUCID('12945795-lucidflex-funded-account', 'LucidFlex funded account'),
  LUCID('12945815-lucidflex-drawdown', 'LucidFlex drawdown'),
  LUCID('12945808-lucidflex-scaling-plan', 'LucidFlex scaling plan'),
  LUCID('12945796-lucidflex-payouts', 'LucidFlex payouts'),
  LUCID('11404728-other-trading-activities', 'Lucid permitted activities'),
];
const TOPONE_SOURCES = [
  { label: 'Top One maximum contracts', url: 'https://help.toponefutures.com/en/articles/10906950-maximum-contracts-explained' },
  { label: 'Top One prohibited practices', url: 'https://help.toponefutures.com/en/articles/11021584-prohibited-trading-practices' },
];
const COHORT = '2026-10';
const CHECKED = '2026-10-02';

function lucidEval(size: 25_000 | 50_000): RuleSet {
  const k = size / 25_000;
  return {
    id: `lucidflex-${size / 1000}k:eval@${COHORT}`, template: `lucidflex-${size / 1000}k`, firm: 'Lucid', program: `LucidFlex ${size / 1000}K`, size, phase: 'eval', cohort: COHORT, verifiedOn: CHECKED, sources: LUCID_SOURCES,
    profitTarget: size === 25_000 ? 1250 : 3000, drawdown: 1000 * k, drawdownType: 'trailing-eod', lockProfit: 100, dailyLossLimit: null, maxMicros: 20 * k, scaling: null,
    consistencyPercent: 50, consistencyBasis: 'totalProfit', minTradingDays: 2, payout: null, automation: 'allowed',
    fee: size === 25_000 ? 75 : null, activation: 0, basis: 'verified',
    provenance: { days: 'assumed', fee: size === 25_000 ? 'reported' : 'assumed' },
    unknowns: [],
    notes: ['The firm publishes no minimum number of days: two is what its 50% consistency rule makes the least possible.', size === 25_000 ? 'The $75 fee is from a public summary, not the firm’s page: set what you paid.' : 'The fee isn’t on the firm’s pages: set what you paid.', 'A daily loss limit is optional at purchase and is off here.'],
  };
}

function lucidFunded(size: 25_000 | 50_000): RuleSet {
  const k = size / 25_000;
  return {
    id: `lucidflex-${size / 1000}k:funded@${COHORT}`, template: `lucidflex-${size / 1000}k`, firm: 'Lucid', program: `LucidFlex ${size / 1000}K (funded)`, size, phase: 'funded', cohort: COHORT, verifiedOn: CHECKED, sources: LUCID_SOURCES,
    profitTarget: 0, drawdown: 1000 * k, drawdownType: 'trailing-eod', lockProfit: 100, dailyLossLimit: null, maxMicros: 20 * k,
    scaling: size === 25_000 ? [{ profit: 0, micros: 10 }, { profit: 1000, micros: 20 }] : [{ profit: 0, micros: 20 }, { profit: 1000, micros: 30 }, { profit: 2000, micros: 40 }],
    consistencyPercent: 100, consistencyBasis: 'totalProfit', minTradingDays: 0,
    payout: { profitDays: 5, profitDayMin: size === 25_000 ? 100 : 150, minProfit: 1000, minRequest: 500, maxRequest: 1000 * k, withdrawShare: 0.5, split: 0.9, consistencyPercent: 100, floorOnRequest: 100, after: 'keep', maxPayouts: 5, processingDays: 2 },
    automation: 'allowed', fee: null, activation: 0, basis: 'verified', provenance: {}, unknowns: [],
    notes: ['The contract limit starts below the ceiling and steps up with profit, at the session’s end. A payout lowers the balance, so it can lower the limit.', 'A request moves the floor to the opening balance plus $100, and half the profit (to a cap) is what can be taken.', 'After five payouts the firm moves the account to a live one: that is outside this simulation.'],
  };
}

/** Top One Elite: the contract limits and the ban on automation are the firm's; the rest wasn't on the pages read. */
function topOneElite(size: 25_000 | 50_000): RuleSet {
  const k = size / 25_000;
  return {
    id: `topone-elite-${size / 1000}k:eval@${COHORT}`, template: `topone-elite-${size / 1000}k`, firm: 'Top One', program: `Elite ${size / 1000}K`, size, phase: 'eval', cohort: COHORT, verifiedOn: CHECKED, sources: TOPONE_SOURCES,
    profitTarget: 1500 * k, drawdown: 1000 * k, drawdownType: 'trailing-eod', lockProfit: 0, dailyLossLimit: null, maxMicros: size === 25_000 ? 10 : 30, scaling: null,
    consistencyPercent: 50, consistencyBasis: 'totalProfit', minTradingDays: 1, payout: null, automation: 'prohibited',
    fee: null, activation: 0, basis: 'assumed', provenance: { limits: 'verified', automation: 'verified' },
    unknowns: ['The profit target', 'The drawdown and how it trails', 'The consistency rule', 'The minimum trading days', 'The fee'],
    notes: ['Top One prohibits bots and automated execution: this account can only ever be traded by hand, with the office advising.', 'Top One also disallows deliberately failing evaluations: rotation here means resting accounts, not sacrificing them.'],
  };
}

export const RULESETS: RuleSet[] = [lucidEval(25_000), lucidFunded(25_000), lucidEval(50_000), lucidFunded(50_000), topOneElite(25_000), topOneElite(50_000), ...FUNDEDNEXT_RULESETS];
const BY_ID = new Map(RULESETS.map((r) => [r.id, r]));

export const ruleSetById = (id: string): RuleSet | undefined => BY_ID.get(id);
/** The newest rule set for a template and phase. */
export function ruleSetFor(template: string, phase: 'eval' | 'funded'): RuleSet | undefined {
  return RULESETS.filter((r) => r.template === template && r.phase === phase).sort((a, b) => (a.cohort < b.cohort ? 1 : -1))[0];
}

/** How one group of a rule set's numbers is known. */
export const provenanceOf = (r: RuleSet, key: keyof RuleSet['provenance']): Provenance => r.provenance[key] ?? r.basis;

/** Whether results on this rule set may be called verified: every number that decides a pass or a payout is the firm's own. */
export function isVerified(r: RuleSet): boolean {
  if (r.unknowns.length || !r.verifiedOn) return false;
  return (['target', 'drawdown', 'limits', 'scaling', 'consistency', 'payout'] as const).every((k) => provenanceOf(r, k) === 'verified');
}

/** Why a rule set can't back a promotion or an automated account, in a line each (empty: it can). */
export function ruleIssues(r: RuleSet): string[] {
  const out: string[] = [];
  if (r.unknowns.length) out.push(`Not known: ${r.unknowns.join(', ').toLowerCase()}`);
  if (!r.verifiedOn) out.push('Never checked against the firm’s own pages');
  for (const k of ['target', 'drawdown', 'limits', 'scaling', 'consistency', 'payout'] as const) if (provenanceOf(r, k) !== 'verified' && !r.unknowns.length) out.push(`The ${k} ${k === 'limits' ? 'are' : 'is'} ${provenanceOf(r, k)}, not the firm’s own`);
  if (r.automation === 'prohibited') out.push('The firm prohibits automated execution: manual trading only');
  else if (r.automation === 'unknown') out.push('Whether the firm allows automation isn’t known');
  return out;
}

/** The micros allowed at this profit (a funded account's scaling step, or the ceiling). */
export function tierMicros(r: RuleSet, profit: number): number {
  if (!r.scaling?.length) return r.maxMicros;
  let micros = r.scaling[0]!.micros;
  for (const s of r.scaling) if (profit >= s.profit) micros = s.micros;
  return Math.min(micros, r.maxMicros);
}

/** Where the account fails, for the highest balance its floor has trailed from. */
export function floorFor(r: RuleSet, peak: number): number {
  return Math.min(peak - r.drawdown, r.lockProfit == null ? Infinity : r.size + r.lockProfit);
}

/** A rule set as the older simulators read an account (the eval simulator, the wall board). */
export function toPropRules(r: RuleSet): PropRules {
  const funded = r.phase === 'funded';
  return {
    id: funded ? `${r.template.replace(/-(\d+k)$/, '-funded-$1')}` : r.template, firm: r.firm, program: r.program, size: r.size,
    profitTarget: funded ? r.payout?.minProfit ?? 0 : r.profitTarget, drawdown: r.drawdown, drawdownType: r.drawdownType, lockProfit: r.lockProfit, dailyLossLimit: r.dailyLossLimit,
    maxMicros: funded ? tierMicros(r, 0) : r.maxMicros, consistencyPercent: funded ? r.payout?.consistencyPercent ?? 100 : r.consistencyPercent, consistencyBasis: r.consistencyBasis,
    minTradingDays: funded ? r.payout?.profitDays ?? 0 : r.minTradingDays, kind: funded ? 'funded' : 'eval',
  };
}

/**
 * An account from the older catalog as a rule set, for the programs whose pages haven't been read
 * (FundedNext, LucidDirect, Top One Ignite). Everything on it is `reported`.
 */
export function fromPropRules(p: PropRules, o: { template?: string; split?: number; payoutCap?: number | null; fee?: number | null; automation?: Automation; notes?: string[] } = {}): RuleSet {
  const funded = p.kind === 'funded';
  return {
    id: `${p.id}:${p.kind}@reported`, template: o.template ?? p.id, firm: p.firm, program: p.program, size: p.size, phase: funded ? 'funded' : 'eval', cohort: '2026-09', verifiedOn: null, sources: [],
    profitTarget: funded ? 0 : p.profitTarget, drawdown: p.drawdown, drawdownType: p.drawdownType, lockProfit: p.lockProfit, dailyLossLimit: p.dailyLossLimit, maxMicros: p.maxMicros, scaling: null,
    consistencyPercent: funded ? 100 : p.consistencyPercent, consistencyBasis: p.consistencyBasis, minTradingDays: funded ? 0 : p.minTradingDays,
    payout: funded ? { profitDays: p.minTradingDays, profitDayMin: 0, minProfit: p.profitTarget, minRequest: 0, maxRequest: o.payoutCap ?? null, withdrawShare: 1, split: o.split ?? 0.9, consistencyPercent: p.consistencyPercent, floorOnRequest: null, after: 'reset', maxPayouts: null, processingDays: 1 } : null,
    automation: o.automation ?? 'unknown', fee: o.fee ?? null, activation: 0, basis: 'reported', provenance: {}, unknowns: [],
    notes: o.notes ?? ['From public summaries, not the firm’s own pages: check every number with the firm.'],
  };
}

/** What a rule set says, a line a rule, for an account's sheet. */
export function describeRules(r: RuleSet): { label: string; value: string; how: Provenance }[] {
  const $ = (n: number) => `$${n.toLocaleString('en-US')}`;
  const rows: { label: string; value: string; how: Provenance }[] = [];
  if (r.phase === 'eval') rows.push({ label: 'Profit target', value: $(r.profitTarget), how: provenanceOf(r, 'target') });
  rows.push({ label: 'Max loss', value: `${$(r.drawdown)} · ${r.drawdownType === 'trailing-eod' ? 'trails at the close' : r.drawdownType === 'trailing-intraday' ? 'trails intraday' : 'fixed'}${r.lockProfit != null ? `, locks at ${$(r.size + r.lockProfit)}` : ''}`, how: provenanceOf(r, 'drawdown') });
  rows.push({ label: 'Contract limit', value: r.scaling ? r.scaling.map((s) => `${s.micros} micros from ${$(s.profit)}`).join(' · ') : `${r.maxMicros} micros`, how: provenanceOf(r, r.scaling ? 'scaling' : 'limits') });
  if (r.phase === 'eval') rows.push({ label: 'Consistency', value: r.consistencyPercent >= 100 ? 'None' : `Best day at most ${r.consistencyPercent}% of ${r.consistencyBasis === 'profitTarget' ? 'the target' : 'the profit'}`, how: provenanceOf(r, 'consistency') }, { label: 'Minimum days', value: String(r.minTradingDays), how: provenanceOf(r, 'days') });
  if (r.dailyLossLimit != null) rows.push({ label: 'Daily loss limit', value: $(r.dailyLossLimit), how: provenanceOf(r, 'limits') });
  const p = r.payout;
  if (p) {
    rows.push({ label: 'Payout needs', value: `${p.profitDays} day${p.profitDays === 1 ? '' : 's'}${p.profitDayMin ? ` of ${$(p.profitDayMin)}+` : ''} and ${$(p.minProfit)} of profit${p.consistencyPercent < 100 ? `, best day at most ${p.consistencyPercent}%` : ''}`, how: provenanceOf(r, 'payout') });
    rows.push({ label: 'Payout size', value: `${Math.round(p.withdrawShare * 100)}% of profit${p.maxRequest ? `, up to ${$(p.maxRequest)}` : ''}${p.minRequest ? `, at least ${$(p.minRequest)}` : ''} · you keep ${Math.round(p.split * 100)}%`, how: provenanceOf(r, 'payout') });
    rows.push({ label: 'After a payout', value: p.after === 'keep' ? `The balance drops by the withdrawal${p.floorOnRequest != null ? `; the floor moves to ${$(r.size + p.floorOnRequest)}` : ''}` : 'Starts again at its opening balance', how: provenanceOf(r, 'payout') });
  }
  rows.push({ label: 'Automation', value: r.automation === 'allowed' ? 'Permitted, within the firm’s rules' : r.automation === 'prohibited' ? 'Prohibited: manual only' : 'Not known', how: provenanceOf(r, 'automation') });
  rows.push({ label: 'Fee', value: r.fee == null ? 'Not published: set yours' : $(r.fee), how: provenanceOf(r, 'fee') });
  return rows;
}
