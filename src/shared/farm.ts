import type { PaperTrade, PlaybookId, PropRules, Symbol } from './trading.js';
import { DAILY_STOP, PLAYBOOK_BY_ID } from './trading.js';
import { applyPlan, planLabel, type PlanMode } from './dayplan.js';
import { MANAGE_BY_ID, managed, type ManageId } from './manage.js';
import { ACCOUNT_CATALOG } from './prop-catalog.js';

// The prop farm. A farm is a few account slots run through one firm's program: buy an evaluation, pass
// it, trade the funded account small until it's ready for a payout, park it, get paid, go again; and when
// an account busts, buy the next one. The same run does two jobs: the battle test replays it over the
// backtest's month (and over redraws of that month, for the odds), and the live farm runs it forward a
// day at a time on what the playbooks really take on paper.
//
// It is a model. What it leaves out is listed in FARM_CAVEATS, and the fees and payout terms are the
// firms' public ones, to be checked before any money is spent on them.

/** One firm's route from paying a fee to being paid. */
export interface FarmProgram {
  id: string;
  firm: string;
  name: string;
  /** The evaluation's rules, or null when the program is straight to funded. */
  evalId: string | null;
  fundedId: string;
  /** What an attempt costs, and what turning a pass into a funded account costs. */
  fee: number;
  activation: number;
  /** The owner's share of a payout. */
  split: number;
  /** The most one payout may be (null: no cap). */
  payoutCap: number | null;
  /** What to know about it, in a line. */
  note: string;
  /** The fee is a guess, not a published price: the owner should set it. */
  feeEstimated?: boolean;
}

export const FARM_PROGRAMS: FarmProgram[] = [
  { id: 'lucidflex-25k', firm: 'Lucid', name: 'LucidFlex 25K', evalId: 'lucidflex-25k', fundedId: 'lucidflex-funded-25k', fee: 75, activation: 0, split: 0.9, payoutCap: 1000, note: 'Evaluation with a 50% consistency rule, then five profit days a payout.' },
  { id: 'lucidflex-50k', firm: 'Lucid', name: 'LucidFlex 50K', evalId: 'lucidflex-50k', fundedId: 'lucidflex-funded-50k', fee: 130, activation: 0, split: 0.9, payoutCap: 2000, note: 'The same, twice the size.', feeEstimated: true },
  { id: 'luciddirect-25k', firm: 'Lucid', name: 'LucidDirect 25K', evalId: null, fundedId: 'luciddirect-25k', fee: 199, activation: 0, split: 0.9, payoutCap: 1000, note: 'Straight to funded. A 20% consistency rule, so a payout takes at least five even days.' },
  { id: 'tof-ignite-25k', firm: 'Top One', name: 'Ignite 25K', evalId: null, fundedId: 'tof-25k', fee: 218, activation: 0, split: 0.9, payoutCap: 500, note: 'Straight to funded. A 15% consistency rule, the strictest here: seven even days or more.' },
  { id: 'tof-ignite-50k', firm: 'Top One', name: 'Ignite 50K', evalId: null, fundedId: 'tof-50k', fee: 398, activation: 0, split: 0.9, payoutCap: 1000, note: 'Straight to funded, the size you already follow.' },
  { id: 'fundednext-rapid-25k', firm: 'FundedNext', name: 'Rapid 25K', evalId: 'fundednext-rapid-25k', fundedId: 'fundednext-funded-25k', fee: 80, activation: 0, split: 0.9, payoutCap: 800, note: 'No consistency rule or minimum days in the challenge: one trade can pass it. The one in the screenshots.' },
  { id: 'fundednext-rapid-50k', firm: 'FundedNext', name: 'Rapid 50K', evalId: 'fundednext-rapid-50k', fundedId: 'fundednext-funded-50k', fee: 150, activation: 0, split: 0.9, payoutCap: 1500, note: 'The same, twice the size.', feeEstimated: true },
];
export const FARM_PROGRAM_BY_ID = Object.fromEntries(FARM_PROGRAMS.map((p) => [p.id, p])) as Record<string, FarmProgram>;

/** What the model leaves out. */
export const FARM_CAVEATS = [
  'After a payout the account starts again at its opening balance with its full drawdown. Firms differ on what cushion a withdrawal leaves, and some are stricter.',
  'Fees, splits and payout caps are from public summaries (September 2026). The LucidFlex 50K and FundedNext 50K fees are guesses: set your real ones.',
  'A program’s limit on how many payouts an account may take, and its move to a live account after them, isn’t modelled.',
  'Paper fills: no commissions or slippage, and a floor that trails intraday is checked when a trade closes.',
  'Firms prohibit opposite positions across your accounts and deliberately blowing evaluations. Rotation avoids the first; the second is a judgment the firm makes.',
];

/** What every account in the farm trades, and how. */
export interface FarmStrategy {
  playbooks: PlaybookId[];
  mode: PlanMode;
  manage: ManageId;
  markets: Symbol[];
}

export interface FarmSetup {
  programId: string;
  /** The fee, when the owner has set their own. */
  fee: number | null;
  /** How many accounts run side by side. */
  slots: number;
  /** Micros on every trade, by stage. */
  evalMicros: number;
  fundedMicros: number;
  strategy: FarmStrategy;
  /** Rotate: each signal goes to the next account in turn. Copy: every account takes every signal. */
  share: 'rotate' | 'copy';
  /** A funded account stops for the day at its first winner. */
  fundedOneAndDone: boolean;
  /** Buy the next attempt when one busts, up to this many attempts in all. */
  maxAttempts: number;
}

export const FARM_DEFAULTS: FarmSetup = {
  programId: 'lucidflex-25k',
  fee: null,
  slots: 3,
  evalMicros: 5,
  fundedMicros: 2,
  strategy: { playbooks: ['support-resistance'], mode: 'every', manage: 'written', markets: ['NQ', 'ES', 'GC'] },
  share: 'rotate',
  fundedOneAndDone: true,
  maxAttempts: 12,
};

export function strategyLabel(s: FarmStrategy): string {
  const plan = planLabel({ mode: s.playbooks.length > 1 ? s.mode : 'every', order: s.playbooks, oneAndDone: false, maxTrades: 0 });
  return `${plan}${s.manage === 'written' ? '' : ` · ${MANAGE_BY_ID[s.manage].short.replace(/^./, (c) => c.toLowerCase())}`}`;
}

/** A setup from anywhere (the browser, a saved file) made safe to run. */
export function cleanSetup(raw: unknown): FarmSetup {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const s = (r.strategy && typeof r.strategy === 'object' ? r.strategy : {}) as Record<string, unknown>;
  const int = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : d);
  const playbooks = (Array.isArray(s.playbooks) ? s.playbooks : []).filter((p): p is PlaybookId => typeof p === 'string' && p in PLAYBOOK_BY_ID);
  const markets = (['NQ', 'ES', 'GC'] as Symbol[]).filter((m) => !Array.isArray(s.markets) || s.markets.includes(m));
  return {
    programId: typeof r.programId === 'string' && r.programId in FARM_PROGRAM_BY_ID ? r.programId : FARM_DEFAULTS.programId,
    fee: typeof r.fee === 'number' && r.fee >= 0 && r.fee < 1e5 ? Math.round(r.fee) : null,
    slots: int(r.slots, 1, 10, FARM_DEFAULTS.slots),
    evalMicros: int(r.evalMicros, 1, 200, FARM_DEFAULTS.evalMicros),
    fundedMicros: int(r.fundedMicros, 1, 200, FARM_DEFAULTS.fundedMicros),
    strategy: {
      playbooks: playbooks.length ? [...new Set(playbooks)] : [...FARM_DEFAULTS.strategy.playbooks],
      mode: s.mode === 'fallback' || s.mode === 'by-day' ? s.mode : 'every',
      manage: typeof s.manage === 'string' && s.manage in MANAGE_BY_ID ? (s.manage as ManageId) : 'written',
      markets: markets.length ? markets : ['NQ', 'ES', 'GC'],
    },
    share: r.share === 'copy' ? 'copy' : 'rotate',
    fundedOneAndDone: r.fundedOneAndDone !== false,
    maxAttempts: int(r.maxAttempts, 1, 200, FARM_DEFAULTS.maxAttempts),
  };
}

// ---- The run ---------------------------------------------------------------------------------------------

export type FarmStage = 'empty' | 'eval' | 'funded' | 'parked' | 'busted';
export type FarmEventKind = 'bought' | 'passed' | 'busted' | 'payout-ready' | 'paid' | 'trade';

export interface FarmEvent {
  /** Index into the run's days. */
  day: number;
  slot: number;
  kind: FarmEventKind;
  /** The account it happened to: "EVAL-3", "FUNDED-3". */
  account: string;
  /** The line to show. */
  text: string;
  /** Money in (a payout) or out (a fee), or a trade's result. */
  amount: number;
}

/** One slot at the end of one day. */
export interface FarmCell {
  stage: FarmStage;
  account: string;
  balance: number;
  /** Where it started this account, where it fails, and what it's aiming for. */
  size: number;
  floor: number;
  target: number;
  /** Today's result and trades. */
  pnl: number;
  trades: number;
  /** The most recent trade it took, in a line. */
  last: string;
  /** Days traded and best day share on this account, for its payout or pass rule. */
  tradingDays: number;
  bestShare: number | null;
}

export interface FarmRun {
  days: string[];
  /** cells[day][slot]. */
  cells: FarmCell[][];
  events: FarmEvent[];
  /** Net cash after each day: payouts received less fees paid. */
  cash: number[];
  fees: number;
  payouts: number;
  attempts: number;
  passed: number;
  evalBusts: number;
  fundedBusts: number;
  payoutCount: number;
}

interface Slot {
  stage: FarmStage;
  rules: PropRules | null;
  no: number;
  balance: number;
  peak: number;
  bestDay: number;
  tradingDays: number;
  last: string;
  /** Becomes funded at the next open. */
  promote: boolean;
}

const rulesOf = (id: string | null) => (id ? (ACCOUNT_CATALOG.find((a) => a.id === id) ?? null) : null);
const money = (n: number) => `${n < 0 ? '−' : ''}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`;
const floorOf = (s: Slot) => (s.rules ? Math.min(s.peak - s.rules.drawdown, s.rules.lockProfit == null ? Infinity : s.rules.size + s.rules.lockProfit) : 0);
const tag = (s: Slot) => `${s.stage === 'eval' ? 'EVAL' : 'FUNDED'}-${s.no}`;

/** The trades the strategy takes on a day, out of everything the playbooks called. */
export function farmTrades(trades: PaperTrade[], s: FarmStrategy): PaperTrade[] {
  const mine = trades.filter((t) => t.outcome !== 'open' && s.playbooks.includes(t.playbook) && s.markets.includes(t.symbol));
  return managed(applyPlan(mine, { mode: s.playbooks.length > 1 ? s.mode : 'every', order: s.playbooks, oneAndDone: false, maxTrades: 0 }), s.manage);
}

/**
 * Runs the farm over `dayLists` (one list of the strategy's trades a day, in order). `labels` names the
 * days. Deterministic: the same days in give the same farm out.
 */
export function runFarm(dayLists: PaperTrade[][], setup: FarmSetup, labels?: string[]): FarmRun {
  const program = FARM_PROGRAM_BY_ID[setup.programId] ?? FARM_PROGRAMS[0]!;
  const evalRules = rulesOf(program.evalId);
  const fundedRules = rulesOf(program.fundedId)!;
  const fee = setup.fee ?? program.fee;
  const slots: Slot[] = Array.from({ length: setup.slots }, () => ({ stage: 'empty' as FarmStage, rules: null, no: 0, balance: 0, peak: 0, bestDay: 0, tradingDays: 0, last: '', promote: false }));
  const run: FarmRun = { days: labels ?? dayLists.map((_, i) => String(i + 1)), cells: [], events: [], cash: [], fees: 0, payouts: 0, attempts: 0, passed: 0, evalBusts: 0, fundedBusts: 0, payoutCount: 0 };
  let cash = 0;
  let turn = 0;
  const open = (s: Slot, rules: PropRules, stage: FarmStage) => {
    s.stage = stage;
    s.rules = rules;
    s.balance = rules.size;
    s.peak = rules.size;
    s.bestDay = 0;
    s.tradingDays = 0;
    s.last = '';
  };
  const steady = (s: Slot) => {
    const r = s.rules!;
    const profit = s.balance - r.size;
    if (r.consistencyPercent >= 100) return true;
    const base = r.consistencyBasis === 'profitTarget' ? r.profitTarget : profit;
    return base > 0 && s.bestDay / base <= r.consistencyPercent / 100 + 1e-9;
  };

  for (let d = 0; d < dayLists.length; d++) {
    const event = (slot: number, kind: FarmEventKind, text: string, amount = 0) => run.events.push({ day: d, slot, kind, account: slots[slot]!.stage === 'empty' ? '' : tag(slots[slot]!), text, amount });
    // The open: payouts land, passes become funded accounts, empty slots buy their next attempt.
    /** Paid today: back in the rotation tomorrow. */
    const resting = new Set<number>();
    slots.forEach((s, i) => {
      if (s.stage === 'parked') {
        const profit = s.balance - s.rules!.size;
        const paid = Math.round(Math.min(profit, program.payoutCap ?? Infinity) * program.split);
        cash += paid;
        run.payouts += paid;
        run.payoutCount++;
        s.stage = 'funded';
        event(i, 'paid', `Paid ${money(paid)} (${Math.round(program.split * 100)}% of ${money(Math.min(profit, program.payoutCap ?? Infinity))}). Back in the rotation tomorrow.`, paid);
        open(s, s.rules!, 'funded');
        resting.add(i);
      } else if (s.promote) {
        s.promote = false;
        cash -= program.activation;
        run.fees += program.activation;
        open(s, fundedRules, 'funded');
        event(i, 'bought', `Funded account opened${program.activation ? ` (${money(program.activation)} activation)` : ''}.`, -program.activation);
      } else if ((s.stage === 'empty' || s.stage === 'busted') && run.attempts < setup.maxAttempts) {
        run.attempts++;
        s.no = run.attempts;
        cash -= fee;
        run.fees += fee;
        open(s, evalRules ?? fundedRules, evalRules ? 'eval' : 'funded');
        event(i, 'bought', `${evalRules ? 'Evaluation' : 'Funded account'} bought for ${money(fee)}.`, -fee);
      }
    });

    // The session: each signal goes to the next account in turn, or to all of them.
    const active = slots.map((s, i) => ({ s, i })).filter((x) => !resting.has(x.i) && (x.s.stage === 'eval' || x.s.stage === 'funded'));
    const dayPnl = new Map<number, number>();
    const dayTrades = new Map<number, number>();
    const losses = new Map<number, number>();
    const done = new Set<number>();
    const take = (x: { s: Slot; i: number }, t: PaperTrade) => {
      const { s, i } = x;
      if (done.has(i) || (s.stage !== 'eval' && s.stage !== 'funded')) return;
      const r = s.rules!;
      const n = Math.min(s.stage === 'eval' ? setup.evalMicros : setup.fundedMicros, r.maxMicros);
      const pnl = Math.round(n * t.dollars * 100) / 100;
      s.balance += pnl;
      dayPnl.set(i, (dayPnl.get(i) ?? 0) + pnl);
      dayTrades.set(i, (dayTrades.get(i) ?? 0) + 1);
      s.last = `${t.side === 'long' ? 'LONG' : 'SHORT'} ${n} ${t.symbol} · ${pnl >= 0 ? '+' : '−'}$${Math.abs(Math.round(pnl))}`;
      event(i, 'trade', `${t.side === 'long' ? 'Long' : 'Short'} ${n} micro ${t.symbol} (${PLAYBOOK_BY_ID[t.playbook].short}): ${pnl >= 0 ? '+' : '−'}$${Math.abs(Math.round(pnl))}`, pnl);
      if (r.drawdownType === 'trailing-intraday') s.peak = Math.max(s.peak, s.balance);
      if (s.balance <= floorOf(s)) {
        if (s.stage === 'eval') run.evalBusts++;
        else run.fundedBusts++;
        event(i, 'busted', `Hit the drawdown floor at ${money(s.balance)}.`, 0);
        s.stage = 'busted';
        done.add(i);
        return;
      }
      if (pnl < 0) losses.set(i, (losses.get(i) ?? 0) + 1);
      const today = dayPnl.get(i)!;
      if ((losses.get(i) ?? 0) >= DAILY_STOP.losses || (r.dailyLossLimit != null && today <= -r.dailyLossLimit) || (s.stage === 'funded' && setup.fundedOneAndDone && pnl > 0)) done.add(i);
    };
    for (const t of dayLists[d]!) {
      const ready = active.filter((x) => !done.has(x.i) && (x.s.stage === 'eval' || x.s.stage === 'funded'));
      if (!ready.length) break;
      if (setup.share === 'copy') ready.forEach((x) => take(x, t));
      else take(ready[turn++ % ready.length]!, t);
    }

    // The close: the floor trails, and each account is checked against its pass or payout rule.
    slots.forEach((s, i) => {
      if (s.stage !== 'eval' && s.stage !== 'funded') return;
      const r = s.rules!;
      const today = dayPnl.get(i) ?? 0;
      if (dayTrades.get(i)) s.tradingDays++;
      s.bestDay = Math.max(s.bestDay, today);
      if (r.drawdownType === 'trailing-eod') s.peak = Math.max(s.peak, s.balance);
      const profit = s.balance - r.size;
      if (profit >= r.profitTarget && s.tradingDays >= r.minTradingDays && steady(s)) {
        if (s.stage === 'eval') {
          run.passed++;
          s.promote = true;
          event(i, 'passed', `Passed: ${money(s.balance)} is at or above the ${money(r.size + r.profitTarget)} target.`, 0);
        } else {
          event(i, 'payout-ready', `Payout ready: ${money(profit)} of profit over ${s.tradingDays} days. Parked until paid.`, 0);
          s.stage = 'parked';
        }
      }
    });
    run.cells.push(slots.map((s, i) => {
      const r = s.rules;
      const profit = r ? s.balance - r.size : 0;
      const base = r ? (r.consistencyBasis === 'profitTarget' ? r.profitTarget : profit) : 0;
      return { stage: s.stage, account: s.stage === 'empty' ? '' : s.stage === 'busted' ? `#${s.no}` : `${s.promote || s.stage === 'eval' ? 'EVAL' : 'FUNDED'}-${s.no}`, balance: Math.round(s.balance), size: r?.size ?? 0, floor: r ? Math.round(floorOf(s)) : 0, target: r ? r.size + r.profitTarget : 0, pnl: Math.round(dayPnl.get(i) ?? 0), trades: dayTrades.get(i) ?? 0, last: s.last, tradingDays: s.tradingDays, bestShare: base > 0 ? s.bestDay / base : null };
    }));
    run.cash.push(Math.round(cash));
  }
  return run;
}

/** The strategy's trades grouped by day, with the quiet days kept. */
export function farmDays(trades: PaperTrade[], strategy: FarmStrategy, days: string[]): PaperTrade[][] {
  const by = new Map<string, PaperTrade[]>(days.map((d) => [d, []]));
  for (const t of farmTrades(trades, strategy)) by.get(t.day)?.push(t);
  return days.map((d) => by.get(d)!.sort((a, b) => a.entryAt - b.entryAt));
}

export interface FarmOdds {
  runs: number;
  horizon: number;
  /** Net cash at the end across the runs. */
  p10: number;
  p50: number;
  p90: number;
  /** The share of runs that ended with more paid out than spent on fees. */
  ahead: number;
  /** Averages over the runs. */
  attempts: number;
  passed: number;
  payouts: number;
  fees: number;
  paid: number;
  /** Of the attempts made, the share that passed (or, straight to funded, reached a payout). */
  passRate: number;
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The same farm over many redraws of the real days: what it nets, and how often it ends ahead. */
export function farmOdds(dayLists: PaperTrade[][], setup: FarmSetup, cfg: { runs?: number; horizon?: number; seed?: number } = {}): FarmOdds {
  const runs = cfg.runs ?? 300;
  const horizon = cfg.horizon ?? 60;
  const empty: FarmOdds = { runs: 0, horizon, p10: 0, p50: 0, p90: 0, ahead: 0, attempts: 0, passed: 0, payouts: 0, fees: 0, paid: 0, passRate: 0 };
  if (!dayLists.length || !dayLists.some((l) => l.length)) return empty;
  const rand = rng(cfg.seed ?? 11);
  const nets: number[] = [];
  const sum = { attempts: 0, passed: 0, payouts: 0, fees: 0, paid: 0 };
  const straight = !FARM_PROGRAM_BY_ID[setup.programId]?.evalId;
  for (let r = 0; r < runs; r++) {
    const draw = Array.from({ length: horizon }, () => dayLists[Math.floor(rand() * dayLists.length)]!);
    const f = runFarm(draw, setup);
    nets.push(f.cash[f.cash.length - 1] ?? 0);
    sum.attempts += f.attempts;
    sum.passed += straight ? Math.min(f.attempts, f.payoutCount) : f.passed;
    sum.payouts += f.payoutCount;
    sum.fees += f.fees;
    sum.paid += f.payouts;
  }
  nets.sort((a, b) => a - b);
  const at = (q: number) => nets[Math.min(nets.length - 1, Math.floor(q * nets.length))]!;
  return { runs, horizon, p10: at(0.1), p50: at(0.5), p90: at(0.9), ahead: nets.filter((n) => n > 0).length / runs, attempts: sum.attempts / runs, passed: sum.passed / runs, payouts: sum.payouts / runs, fees: sum.fees / runs, paid: sum.paid / runs, passRate: sum.attempts ? sum.passed / sum.attempts : 0 };
}

/** The live farm as the boards show it: the setup, when it started, and the run so far on the paper book. */
export interface FarmView {
  setup: FarmSetup;
  startDay: string;
  run: FarmRun;
  /** Whether notices also go to a Discord webhook. */
  discord: boolean;
}
