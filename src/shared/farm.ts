import type { PaperTrade, PlaybookId, Symbol } from './trading.js';
import { DAILY_STOP, PLAYBOOK_BY_ID } from './trading.js';
import { applyPlan, planLabel, type PlanMode } from './dayplan.js';
import { MANAGE_BY_ID, managed, type ManageId } from './manage.js';
import { ACCOUNT_CATALOG } from './prop-catalog.js';
import { COSTS, type CostId } from './fills.js';
import { FUNDEDNEXT_RULESETS } from './fundednext-rules.js';
import { fromPropRules, isVerified, ruleSetFor, type RuleSet } from './prop-rules.js';
import { canTrade, confirmPass, cushionOf, DaySession, fillOf, floorOf, openAccount, payoutCheck, requestPayout, settlePayout, type Account, type AccountStatus } from './account-ledger.js';
import { capPolicy, crossAccountConflict, CUSHION_BASELINE, policyProblem, sizeTrade, type RiskPolicy } from './risk-policy.js';

// The prop farm. A farm is a few account slots run through one firm's program: buy an evaluation, pass
// it, trade the funded account small until it's ready for a payout, park it, get paid, go again; and when
// an account is breached, buy the next one. The same run does two jobs: the battle test replays it over
// the backtest's month (and over redraws of that month, for the odds), and a forward run plays it a day
// at a time on what the playbooks really take on paper.
//
// Each account is a ledger of its own (shared/account-ledger.ts): its equity is followed through every
// trade against the firm's rules as that rule set states them (shared/prop-rules.ts), every order is
// sized by the risk governor (shared/risk-policy.ts), and every fill pays costs (shared/fills.ts).
//
// It is a model. What it leaves out is listed in FARM_CAVEATS.

/** One firm's route from paying a fee to being paid. */
export interface FarmProgram {
  id: string;
  firm: string;
  name: string;
  /** The evaluation's rules, or null when the program is straight to funded. */
  evalRules: RuleSet | null;
  fundedRules: RuleSet;
  /** What an attempt costs. */
  fee: number;
  /** The fee is a guess, not a published price: the owner should set it. */
  feeEstimated?: boolean;
  /** What to know about it, in a line. */
  note: string;
}

const catalog = (id: string) => ACCOUNT_CATALOG.find((a) => a.id === id)!;
const lucid = (size: '25k' | '50k', fee: number, feeEstimated: boolean, note: string): FarmProgram => ({ id: `lucidflex-${size}`, firm: 'Lucid', name: `LucidFlex ${size.toUpperCase()}`, evalRules: ruleSetFor(`lucidflex-${size}`, 'eval')!, fundedRules: ruleSetFor(`lucidflex-${size}`, 'funded')!, fee, feeEstimated, note });
const reported = (id: string, firm: string, name: string, evalId: string | null, fundedId: string, fee: number, payoutCap: number, note: string, o: { feeEstimated?: boolean; automation?: 'allowed' | 'prohibited' | 'unknown' } = {}): FarmProgram => ({
  id, firm, name, fee, note, feeEstimated: o.feeEstimated ?? true,
  evalRules: evalId ? fromPropRules(catalog(evalId), { template: id, automation: o.automation, fee }) : null,
  fundedRules: fromPropRules(catalog(fundedId), { template: id, payoutCap, automation: o.automation, fee: evalId ? null : fee }),
});

export const FARM_PROGRAMS: FarmProgram[] = [
  ...FUNDEDNEXT_RULESETS.filter(r => r.phase === 'eval').map(r => ({
    id: r.template, firm: r.firm, name: r.program, evalRules: r,
    fundedRules: FUNDEDNEXT_RULESETS.find(f => f.template === r.template && f.phase === 'funded')!,
    fee: r.size === 25000 ? 80 : r.size === 50000 ? 150 : r.size === 100000 ? 280 : 484,
    feeEstimated: true, note: `${r.size / 1000}K · ${r.maxMicros} micros · current source-checked numbers; execution conditions still need review.`,
  })),
  lucid('25k', 75, true, 'A 50% consistency rule in the evaluation. Funded starts at 10 micros; a payout takes five $100 days and $1,000 of profit, and half of it can be taken.'),
  lucid('50k', 130, true, 'The same, twice the size. Funded starts at 20 micros and steps to 40.'),
  reported('luciddirect-25k', 'Lucid', 'LucidDirect 25K', null, 'luciddirect-25k', 199, 1000, 'Straight to funded. A 20% consistency rule, so a payout takes at least five even days.'),
  reported('tof-ignite-25k', 'Top One', 'Ignite 25K', null, 'tof-25k', 218, 500, 'Straight to funded. A 15% consistency rule, the strictest here. Top One prohibits bots: manual only.', { automation: 'prohibited' }),
  reported('tof-ignite-50k', 'Top One', 'Ignite 50K', null, 'tof-50k', 398, 1000, 'Straight to funded, the size you already follow. Manual only.', { automation: 'prohibited' }),
  reported('fundednext-rapid-25k', 'FundedNext', 'Rapid 25K (legacy scenario)', 'fundednext-rapid-25k', 'fundednext-funded-25k', 80, 800, 'No consistency rule or minimum days in the challenge: one trade can pass it. The one in the screenshots.'),
  reported('fundednext-rapid-50k', 'FundedNext', 'Rapid 50K (legacy scenario)', 'fundednext-rapid-50k', 'fundednext-funded-50k', 150, 1500, 'The same, twice the size.', { feeEstimated: true }),
];
export const FARM_PROGRAM_BY_ID = Object.fromEntries(FARM_PROGRAMS.map((p) => [p.id, p])) as Record<string, FarmProgram>;

/** Whether a program's numbers are the firm's own, checked on its pages (the rest are from public summaries). */
export const programVerified = (p: FarmProgram) => isVerified(p.fundedRules) && (!p.evalRules || isVerified(p.evalRules));

/** What the model leaves out. */
export const FARM_CAVEATS = [
  'Minute bars can’t say which price inside a bar came first. A trade’s worst and best prices are marked on the bars they happened on; a result that rests on a guess inside one bar is counted, and the stop is always taken first.',
  'LucidFlex and current FundedNext numerical rules have official sources. FundedNext execution-specific gaps and older reported programs remain labeled research scenarios; inspect the rule sheet before comparing.',
  'Fees are not on the firms’ pages: set what you actually pay. Commission and slippage are assumptions too, which is why there are three cost settings to compare.',
  'A pass is confirmed and a payout arrives on schedule here. In life the firm reviews both, and can refuse.',
  'An account that isn’t breached but has too little cushion left to carry one micro is counted as lost: the farm retires it and buys the next attempt, as a trader would.',
  'After its last allowed payout a funded account is moved to a live one by the firm: that is outside this simulation, and the slot buys a new attempt.',
  'Firms prohibit opposite positions across your accounts and deliberately failing evaluations. The farm refuses the first; the second is a judgment the firm makes.',
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
  /** The most micros to ask for on a trade, by stage: a cap, not an order size. */
  evalMicros: number;
  fundedMicros: number;
  /** `cap`: ask for the cap every time, as far as the cushion carries it. `cushion`: a tenth of the cushion a trade (the Law of 10), up to the cap. */
  sizing: 'cap' | 'cushion' | 'phase';
  /** Optional for compatibility with pinned older runs. */
  evalRiskPercent?: number;
  fundedRiskPercent?: number;
  protectPayout?: boolean;
  /** What every fill pays (see shared/fills.ts). */
  cost: CostId;
  strategy: FarmStrategy;
  /** Rotate: each signal goes to the next account in turn. Copy: every account takes every signal. */
  share: 'rotate' | 'copy';
  /** A funded account stops for the day at its first winner. */
  fundedOneAndDone: boolean;
  /** Buy the next attempt when one is breached, up to this many attempts in all. */
  maxAttempts: number;
}

export const FARM_DEFAULTS: FarmSetup = {
  programId: 'lucidflex-25k',
  fee: null,
  slots: 3,
  evalMicros: 5,
  fundedMicros: 3,
  sizing: 'cap',
  cost: 'base',
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
    sizing: r.sizing === 'phase' ? 'phase' : r.sizing === 'cushion' ? 'cushion' : 'cap',
    evalRiskPercent: int(r.evalRiskPercent, 5, 75, 35),
    fundedRiskPercent: int(r.fundedRiskPercent, 1, 25, 10),
    protectPayout: r.protectPayout !== false,
    cost: r.cost === 'gross' || r.cost === 'stressed' ? r.cost : 'base',
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

/** The risk policy a setup runs a stage on. */
export function policyOf(setup: FarmSetup, phase: 'eval' | 'funded', context?: { profit: number; goal: number; drawdown: number }): RiskPolicy {
  const cap = phase === 'eval' ? setup.evalMicros : setup.fundedMicros;
  if (setup.sizing === 'phase') {
    const share = (phase === 'eval' ? setup.evalRiskPercent ?? 35 : setup.fundedRiskPercent ?? 10) / 100;
    const progress = context && context.goal > 0 ? Math.max(0, Math.min(1, context.profit / context.goal)) : 0;
    const taper = phase === 'funded' && setup.protectPayout !== false ? 1 - 0.75 * progress : 1;
    return { id: `phase-${phase}`, name: `${phase === 'eval' ? 'Evaluation pace' : 'Payout protection'} (${Math.round(share * taper * 100)}% risk)`, cap,
      cushionShare: share * taper, reserve: (context?.drawdown ?? 0) * 0.1, dayShare: Math.min(0.75, share * 2) };
  }
  return setup.sizing === 'cushion' ? { ...CUSHION_BASELINE, id: `cushion-${cap}`, name: `Cushion-based, up to ${cap}`, cap } : capPolicy(cap);
}

/** Use the same cycle state for sizing and for the account card's explanation. */
export function accountPolicy(setup: FarmSetup, a: Account, rules: RuleSet): RiskPolicy {
  const p = rules.payout;
  const goal = Math.max(p?.minCycleProfit ?? 0, p?.minProfit ?? 0, (p?.profitDayMin ?? 0) * (p?.profitDays ?? 0),
    p?.consistencyPercent && p.consistencyPercent < 100 ? a.cycle.bestDay / (p.consistencyPercent / 100) : 0);
  return policyOf(setup, a.phase, { profit: a.balance - a.cycle.startBalance, goal, drawdown: rules.drawdown });
}

/** Why a setup can't be run at all (null: it can): a cap over the firm's ceiling is refused, not quietly shrunk. */
export function setupProblem(setup: FarmSetup): string | null {
  const program = FARM_PROGRAM_BY_ID[setup.programId];
  if (!program) return 'No such program';
  return (program.evalRules ? policyProblem(policyOf(setup, 'eval'), program.evalRules) : null) ?? policyProblem(policyOf(setup, 'funded'), program.fundedRules);
}

// ---- The run ---------------------------------------------------------------------------------------------

export type FarmStage = 'empty' | 'eval' | 'funded' | 'parked' | 'busted';
export type FarmEventKind = 'bought' | 'passed' | 'busted' | 'payout-ready' | 'paid' | 'trade' | 'skip' | 'note';

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
  /** For a trade or a skip: why the size was what it was. */
  why?: string;
  /** The signal it came from. */
  trade?: string;
}

/** One slot at the end of one day. */
export interface FarmCell {
  stage: FarmStage;
  status: AccountStatus | 'empty';
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
  /** Micros the firm allows it next session, and the lowest its cushion stood today, open trades included. */
  allowed: number;
  lowCushion: number;
  /** Days that counted toward the payout this cycle, of how many it needs (funded accounts). */
  profitDays: number;
  profitDaysNeeded: number;
  /** End-of-day ledger checks, retained so the view does not invent a shorter checklist. */
  payout?: ReturnType<typeof payoutCheck> & { requested: number | null; requestedOn: string | null; payouts: number; received: number };
  risk?: RiskPolicy;
  /** Why it is where it is. */
  why: string;
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
  /** Of the accounts lost, those that weren't breached but had too little cushion left to trade: retired as spent. */
  spent: number;
  /** Trades taken, signals nothing could take, and what the fills paid in commission and slippage. */
  taken: number;
  skipped: number;
  costs: number;
  /** The day (index) the first payout was requested, and the cushion that account had left once it was paid. */
  firstPayoutDay: number | null;
  cushionAfterPayout: number | null;
  /** The worst run of losing days in a row across the farm, in dollars. */
  worstStreak: number;
  /** Why the run couldn't start, when the setup is refused. */
  refused: string | null;
}

interface Slot {
  account: Account | null;
  rules: RuleSet | null;
  no: number;
  last: string;
  /** The day (index) a requested payout arrives. */
  due: number;
}

/** An account with this share of its drawdown left, or less, that can no longer size a single micro is spent. */
export const SPENT_SHARE = 0.25;
const money = (n: number) => `${n < 0 ? '−' : ''}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`;
const stageOf = (a: Account | null): FarmStage => (!a ? 'empty' : a.status === 'breached' || a.status === 'retired' || a.status === 'passed' ? 'busted' : a.status === 'parked' ? 'parked' : a.phase === 'eval' ? 'eval' : 'funded');
const tag = (s: Slot) => (s.account ? `${s.account.phase === 'eval' ? 'EVAL' : 'FUNDED'}-${s.no}` : '');

/** The trades the strategy takes on a day, out of everything the playbooks called. */
export function farmTrades(trades: PaperTrade[], s: FarmStrategy): PaperTrade[] {
  const mine = trades.filter((t) => t.outcome !== 'open' && s.playbooks.includes(t.playbook) && s.markets.includes(t.symbol));
  return managed(applyPlan(mine, { mode: s.playbooks.length > 1 ? s.mode : 'every', order: s.playbooks, oneAndDone: false, maxTrades: 0 }), s.manage);
}

/**
 * Runs the farm over `dayLists` (one list of the strategy's trades a day, in order). `labels` names the
 * days. Deterministic: the same days in give the same farm out. `quiet` leaves out the feed and the
 * day-by-day cells, for the odds, which only need the totals.
 */
export function runFarm(dayLists: PaperTrade[][], setup: FarmSetup, labels?: string[], o: { quiet?: boolean } = {}): FarmRun {
  const program = FARM_PROGRAM_BY_ID[setup.programId] ?? FARM_PROGRAMS[0]!;
  const fee = setup.fee ?? program.fee;
  const cost = COSTS[setup.cost] ?? COSTS.base;
  const isManaged = setup.strategy.manage !== 'written';
  const run: FarmRun = { days: labels ?? dayLists.map((_, i) => String(i + 1)), cells: [], events: [], cash: [], fees: 0, payouts: 0, attempts: 0, passed: 0, evalBusts: 0, fundedBusts: 0, payoutCount: 0, spent: 0, taken: 0, skipped: 0, costs: 0, firstPayoutDay: null, cushionAfterPayout: null, worstStreak: 0, refused: setupProblem(setup) };
  if (run.refused) return run;
  const slots: Slot[] = Array.from({ length: setup.slots }, () => ({ account: null, rules: null, no: 0, last: '', due: 0 }));
  const policies = { eval: policyOf(setup, 'eval'), funded: policyOf(setup, 'funded') };
  let cash = 0;
  let turn = 0;
  let streak = 0;

  for (let d = 0; d < dayLists.length; d++) {
    const label = run.days[d] ?? String(d + 1);
    const event = (slot: number, kind: FarmEventKind, text: string, amount = 0, extra: Partial<FarmEvent> = {}) => {
      if (!o.quiet) run.events.push({ day: d, slot, kind, account: tag(slots[slot]!), text, amount, ...extra });
    };
    const openOn = (s: Slot, rules: RuleSet, linked: string | null = null) => {
      s.rules = rules;
      s.account = openAccount(rules, { id: `${rules.phase === 'eval' ? 'EVAL' : 'FUNDED'}-${s.no}`, day: label, linked });
      s.last = '';
    };
    // The open: payouts land, passes become funded accounts, empty slots buy their next attempt.
    /** Paid today: back in the rotation tomorrow. */
    const resting = new Set<number>();
    slots.forEach((s, i) => {
      const a = s.account;
      if (a?.status === 'parked' && d >= s.due) {
        const paid = settlePayout(a, s.rules!, label);
        if ('error' in paid) return;
        cash += paid.received;
        run.payouts += paid.received;
        run.payoutCount++;
        run.cushionAfterPayout ??= Math.round(cushionOf(a, s.rules!));
        event(i, 'paid', `Paid ${money(paid.received)} (${Math.round(s.rules!.payout!.split * 100)}% of ${money(paid.withdrawn)}). ${(a.status as AccountStatus) === 'retired' ? 'That was its last payout: the firm moves it on.' : `Back in the rotation tomorrow with ${money(cushionOf(a, s.rules!))} of cushion.`}`, paid.received);
        resting.add(i);
      } else if (a?.status === 'pass-pending') {
        confirmPass(a, label);
        const from = a.id;
        openOn(s, program.fundedRules, from);
        event(i, 'bought', `Pass confirmed: funded account opened at ${s.account!.allowedMicros} micros.`, 0);
      }
      const now = s.account;
      if ((!now || now.status === 'breached' || now.status === 'retired') && run.attempts < setup.maxAttempts) {
        run.attempts++;
        s.no = run.attempts;
        cash -= fee;
        run.fees += fee;
        openOn(s, program.evalRules ?? program.fundedRules);
        s.account!.fees = fee;
        event(i, 'bought', `${program.evalRules ? 'Evaluation' : 'Funded account'} bought for ${money(fee)}.`, -fee);
      }
    });

    // The session: each signal goes to the next account in turn, or to all of them.
    const sessions = slots.map((s, i) => (s.account && canTrade(s.account.status) && !resting.has(i) ? new DaySession(s.account, s.rules!, label) : null));
    const openCushion = slots.map((s) => (s.account ? cushionOf(s.account, s.rules!) : 0));
    /** Signals an account was offered today and couldn't size even one micro for. */
    const starved = slots.map(() => 0);
    const done = (i: number) => {
      const s = sessions[i]!;
      const a = slots[i]!.account!;
      return !canTrade(a.status) || !!s.stopped || s.lossesToday >= DAILY_STOP.losses || (a.phase === 'funded' && setup.fundedOneAndDone && s.winsToday > 0);
    };
    for (const t of dayLists[d]!) {
      const at = t.entryAt + 60_000;
      for (const s of sessions) s?.advance(at);
      const ready = sessions.map((_, i) => i).filter((i) => sessions[i] && !done(i));
      if (!ready.length) break;
      const order = setup.share === 'copy' ? ready : ready.map((_, k) => ready[(turn + k) % ready.length]!);
      let placed = false;
      let lastWhy = '';
      for (const i of order) {
        const s = sessions[i]!;
        const a = slots[i]!.account!;
        const rules = slots[i]!.rules!;
        const held = sessions.flatMap((x, j) => (x ? x.positions.map((p) => ({ account: tag(slots[j]!), ...p })) : []));
        const conflict = crossAccountConflict(t.symbol, t.side, held, tag(slots[i]!));
        const decision = conflict
          ? null
          : sizeTrade({ symbol: t.symbol, stopPoints: Math.abs(t.entry - t.stop), policy: setup.sizing === 'phase' ? accountPolicy(setup, a, rules) : policies[a.phase], cost, allowedMicros: a.allowedMicros, openMicros: s.openMicros, cushion: cushionOf(a, rules), openRisk: s.openRisk, dayStartCushion: openCushion[i]!, dayLoss: Math.max(0, -s.dayPnl), dailyLossLimit: rules.dailyLossLimit });
        if (!decision?.micros) {
          lastWhy ||= conflict ?? decision!.why;
          if (decision && (decision.binding === 'cushion' || decision.binding === 'day')) starved[i]!++;
          if (setup.share === 'copy') {
            run.skipped++;
            event(i, 'skip', `${t.side === 'long' ? 'Long' : 'Short'} ${t.symbol} (${PLAYBOOK_BY_ID[t.playbook].short}) not taken.`, 0, { why: conflict ?? decision!.why, trade: t.id });
          }
          continue;
        }
        const fill = fillOf(t, decision.micros, cost, { managed: isManaged, id: `${t.id}#${i}` });
        if (s.add(fill)) continue;
        placed = true;
        run.taken++;
        run.costs += fill.costs;
        const pnl = Math.round(fill.pnlPoints * fill.pointValue * fill.micros - fill.costs);
        slots[i]!.last = `${t.side === 'long' ? 'LONG' : 'SHORT'} ${decision.micros} ${t.symbol} · ${pnl >= 0 ? '+' : '−'}$${Math.abs(pnl)}`;
        event(i, 'trade', `${t.side === 'long' ? 'Long' : 'Short'} ${decision.micros} micro ${t.symbol} (${PLAYBOOK_BY_ID[t.playbook].short}): ${pnl >= 0 ? '+' : '−'}$${Math.abs(pnl)}`, pnl, { why: decision.why, trade: t.id });
        if (setup.share !== 'copy') break;
      }
      if (setup.share !== 'copy') {
        if (placed) turn++;
        else {
          run.skipped++;
          event(order[0]!, 'skip', `${t.side === 'long' ? 'Long' : 'Short'} ${t.symbol} (${PLAYBOOK_BY_ID[t.playbook].short}) not taken by any account.`, 0, { why: lastWhy, trade: t.id });
        }
      }
    }

    // The close: the floor trails, and each account is checked against its pass or payout rule.
    const reports = sessions.map((s) => s?.close() ?? null);
    slots.forEach((s, i) => {
      const a = s.account;
      const rep = reports[i];
      if (!a || !rep) return;
      const rules = s.rules!;
      if (a.status === 'breached') {
        if (a.phase === 'eval') run.evalBusts++;
        else run.fundedBusts++;
        event(i, 'busted', `${a.why} (${money(a.balance)}).`, 0);
      } else if (setup.sizing !== 'phase' && canTrade(a.status) && starved[i]! > 0 && !rep.fills && cushionOf(a, rules) <= rules.drawdown * SPENT_SHARE) {
        // Not breached, but there is too little cushion left to carry one micro of what the strategy trades:
        // the account is spent. A farm stops feeding it and buys the next attempt.
        if (a.phase === 'eval') run.evalBusts++;
        else run.fundedBusts++;
        run.spent++;
        a.status = 'retired';
        a.why = `Spent: ${money(cushionOf(a, rules))} of cushion can’t carry one micro`;
        event(i, 'busted', `Spent: only ${money(cushionOf(a, rules))} of cushion left, which can’t carry one micro of this strategy’s trades. Retired at ${money(a.balance)}.`, 0);
      } else if (a.status === 'pass-pending') {
        run.passed++;
        event(i, 'passed', `Passed: ${money(a.balance)} with every rule met. Waiting for the firm to confirm.`, 0);
      } else if (a.status === 'payout-eligible') {
        const amount = payoutCheck(a, rules).amount;
        if (!requestPayout(a, rules, label, { key: `${a.id}:${a.payouts + 1}` })) {
          s.due = d + rules.payout!.processingDays;
          run.firstPayoutDay ??= d;
          event(i, 'payout-ready', `Payout of ${money(amount)} requested. Parked until it is paid${rules.payout!.floorOnRequest != null ? `; the floor is now ${money(floorOf(a, rules))}` : ''}.`, 0);
        }
      }
    });
    cash = Math.round(cash * 100) / 100;
    if (!o.quiet) {
      run.cells.push(slots.map((s, i) => {
        const a = s.account;
        const r = s.rules;
        const rep = reports[i];
        if (!a || !r) return { stage: 'empty', status: 'empty', account: '', balance: 0, size: 0, floor: 0, target: 0, pnl: 0, trades: 0, last: '', tradingDays: 0, bestShare: null, allowed: 0, lowCushion: 0, profitDays: 0, profitDaysNeeded: 0, why: 'No attempts left to buy' };
        const profit = a.balance - a.start;
        const funded = a.phase === 'funded';
        const base = funded ? a.balance - a.cycle.startBalance : r.consistencyBasis === 'profitTarget' ? r.profitTarget : profit;
        const best = funded ? a.cycle.bestDay : a.bestDay;
        const stage = stageOf(a);
        return {
          risk: accountPolicy(setup, a, r),
          payout: funded ? { ...payoutCheck(a, r), requested: a.request?.amount ?? null, requestedOn: a.request?.day ?? null, payouts: a.payouts, received: a.received } : undefined,
          stage, status: a.status, account: stage === 'busted' ? `#${s.no}` : a.id, balance: Math.round(a.balance), size: a.start, floor: Math.round(floorOf(a, r)),
          target: funded ? a.start + (r.payout?.minProfit ?? 0) : a.start + r.profitTarget, pnl: Math.round(rep?.pnl ?? 0), trades: rep?.fills ?? 0, last: s.last,
          tradingDays: funded ? a.cycle.tradingDays : a.tradingDays, bestShare: base > 0 ? best / base : null, allowed: a.allowedMicros, lowCushion: Math.round(rep?.lowCushion ?? cushionOf(a, r)),
          profitDays: a.cycle.profitDays, profitDaysNeeded: r.payout?.profitDays ?? 0, why: a.why,
        };
      }));
    }
    // The worst run of losing days in a row, across every account.
    const dayMove = reports.reduce((sum, r) => sum + (r?.pnl ?? 0), 0);
    streak = dayMove < 0 ? streak + dayMove : 0;
    run.worstStreak = Math.min(run.worstStreak, streak);
    run.cash.push(Math.round(cash));
  }
  run.costs = Math.round(run.costs);
  run.worstStreak = Math.round(run.worstStreak);
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
  /** The share of runs that ended with more paid out than spent on fees, with the range that share could really be (95%). */
  ahead: number;
  aheadRange: [number, number];
  /** The average net over the runs: payouts received less fees paid. */
  mean: number;
  /** Averages over the runs. */
  attempts: number;
  passed: number;
  payouts: number;
  fees: number;
  paid: number;
  /** Of the attempts made, the share that passed (or, straight to funded, reached a payout). */
  passRate: number;
  /** Of the accounts opened (evaluations and the funded accounts they became), the share that was breached. */
  breachRate: number;
  /** The share of runs that reached a first payout, and the days it took in the middle one that did. */
  payoutRate: number;
  daysToPayout: number | null;
  /** The cushion an account had left after its first payout, in the middle run. */
  cushionAfterPayout: number | null;
  /** The worst run of losing days in a row, in the middle run and in a bad one. */
  worstStreak: number;
  worstStreakBad: number;
  /** What the redraws were drawn from: real days, and the trades on them. */
  sampleDays: number;
  sampleTrades: number;
  refused: string | null;
}

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The range a share measured on `n` tries could really be (Wilson, 95%). */
export function shareRange(share: number, n: number): [number, number] {
  if (!n) return [0, 1];
  const z = 1.96;
  const mid = (share + (z * z) / (2 * n)) / (1 + (z * z) / n);
  const half = (z * Math.sqrt((share * (1 - share)) / n + (z * z) / (4 * n * n))) / (1 + (z * z) / n);
  return [Math.max(0, mid - half), Math.min(1, mid + half)];
}

/** `horizon` days drawn from the real ones in runs of `block` days in a row, so what carries from one day to the next is kept. */
export function drawDays<X>(pool: X[], horizon: number, rand: () => number, block = 1): X[] {
  const out: X[] = [];
  while (out.length < horizon) {
    const start = Math.floor(rand() * pool.length);
    for (let k = 0; k < block && out.length < horizon; k++) out.push(pool[(start + k) % pool.length]!);
  }
  return out;
}

/** The same farm over many redraws of the real days: what it nets, and how often it ends ahead. */
export function farmOdds(dayLists: PaperTrade[][], setup: FarmSetup, cfg: { runs?: number; horizon?: number; seed?: number; block?: number } = {}): FarmOdds {
  const runs = cfg.runs ?? 300;
  const horizon = cfg.horizon ?? 60;
  const sampleTrades = dayLists.reduce((a, l) => a + l.length, 0);
  const empty: FarmOdds = { runs: 0, horizon, p10: 0, p50: 0, p90: 0, ahead: 0, aheadRange: [0, 1], mean: 0, attempts: 0, passed: 0, payouts: 0, fees: 0, paid: 0, passRate: 0, breachRate: 0, payoutRate: 0, daysToPayout: null, cushionAfterPayout: null, worstStreak: 0, worstStreakBad: 0, sampleDays: dayLists.length, sampleTrades, refused: setupProblem(setup) };
  if (empty.refused || !dayLists.length || !sampleTrades) return empty;
  const rand = rng(cfg.seed ?? 11);
  const nets: number[] = [];
  const firsts: number[] = [];
  const cushions: number[] = [];
  const streaks: number[] = [];
  const sum = { attempts: 0, passed: 0, payouts: 0, fees: 0, paid: 0, busts: 0, opened: 0 };
  const straight = !FARM_PROGRAM_BY_ID[setup.programId]?.evalRules;
  for (let r = 0; r < runs; r++) {
    const f = runFarm(drawDays(dayLists, horizon, rand, cfg.block ?? 1), setup, undefined, { quiet: true });
    nets.push(f.cash[f.cash.length - 1] ?? 0);
    if (f.firstPayoutDay != null) firsts.push(f.firstPayoutDay + 1);
    if (f.cushionAfterPayout != null) cushions.push(f.cushionAfterPayout);
    streaks.push(f.worstStreak);
    sum.attempts += f.attempts;
    sum.passed += straight ? Math.min(f.attempts, f.payoutCount) : f.passed;
    sum.payouts += f.payoutCount;
    sum.fees += f.fees;
    sum.paid += f.payouts;
    sum.busts += f.evalBusts + f.fundedBusts;
    sum.opened += f.attempts + (straight ? 0 : f.passed);
  }
  const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
  const at = (xs: number[], q: number) => xs[Math.min(xs.length - 1, Math.floor(q * xs.length))]!;
  const n = sorted(nets);
  const ahead = nets.filter((x) => x > 0).length / runs;
  return {
    runs, horizon, p10: at(n, 0.1), p50: at(n, 0.5), p90: at(n, 0.9), ahead, aheadRange: shareRange(ahead, runs), mean: Math.round((sum.paid - sum.fees) / runs),
    attempts: sum.attempts / runs, passed: sum.passed / runs, payouts: sum.payouts / runs, fees: sum.fees / runs, paid: sum.paid / runs, passRate: sum.attempts ? sum.passed / sum.attempts : 0, breachRate: sum.opened ? sum.busts / sum.opened : 0,
    payoutRate: firsts.length / runs, daysToPayout: firsts.length ? at(sorted(firsts), 0.5) : null, cushionAfterPayout: cushions.length ? at(sorted(cushions), 0.5) : null,
    worstStreak: at(sorted(streaks), 0.5), worstStreakBad: at(sorted(streaks), 0.1), sampleDays: dayLists.length, sampleTrades, refused: null,
  };
}

/** The live farm as the boards show it: the setup, when it started, and the run so far on the paper book. */
export interface FarmView {
  setup: FarmSetup;
  startDay: string;
  run: FarmRun;
  /** Whether notices also go to a Discord webhook. */
  discord: boolean;
}
