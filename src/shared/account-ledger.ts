import type { PaperTrade, Symbol } from './trading.js';
import { INSTRUMENTS } from './trading.js';
import { costPerMicro, type CostModel } from './fills.js';
import { floorFor, isVerified, tierMicros, type RuleSet } from './prop-rules.js';

// The account ledger: one prop account played event by event. Where the older eval simulator adds up
// closed trades, this follows the account's equity through each trade (how far it went against it before
// it came back), across trades that overlap, against the firm's limits as they stand at that moment. An
// account that touches its floor inside a trade is breached there, whatever the trade went on to do.
//
// It is the one place the rules are applied: evaluations, funded accounts, the farm, the forward runs
// and the payout desk all go through it. Nothing here knows about a strategy; it is given fills.
//
// What minute bars can't say: the order of prices inside a bar. A trade's worst and best prices are
// marked at the bars they happened on, and between marks its open result is drawn as a straight line.
// Two trades' extremes inside the same minute are taken together, which is the careful reading.

export type Environment = 'simulated' | 'manual' | 'connected';

/**
 * Where an account stands. An evaluation: active → target-reached (rules still pending) → pass-pending
 * (every rule met; the firm confirms) → passed. A funded account: active → payout-eligible → parked
 * (requested: no trades until it's reconciled) → active again. Breached, review and retired end or
 * interrupt either.
 */
export type AccountStatus = 'active' | 'target-reached' | 'pass-pending' | 'passed' | 'payout-eligible' | 'parked' | 'breached' | 'review' | 'retired';

export const STATUS_WORD: Record<AccountStatus, string> = {
  active: 'Trading', 'target-reached': 'Target reached · rules pending', 'pass-pending': 'Pass pending confirmation', passed: 'Passed', 'payout-eligible': 'Payout eligible', parked: 'Parked · payout requested', breached: 'Breached', review: 'Needs review', retired: 'Retired',
};

/** Whether new trades may be routed to an account in this state. */
export const canTrade = (s: AccountStatus) => s === 'active' || s === 'target-reached' || s === 'payout-eligible';

export interface PayoutRequest {
  /** The owner's (or the simulation's) key for it, so the same request can't be made twice. */
  key: string;
  amount: number;
  day: string;
}

export interface Account {
  id: string;
  label: string;
  ruleSetId: string;
  phase: 'eval' | 'funded';
  environment: Environment;
  status: AccountStatus;
  openedOn: string;
  /** The funded account an evaluation became, or the evaluation a funded account came from. */
  linked: string | null;
  start: number;
  /** Settled balance: closed trades only. */
  balance: number;
  /** The highest balance the floor has trailed from. */
  peak: number;
  /** A floor fixed by a payout request (the firm's locked balance), when there is one. */
  floorLock: number | null;
  /** Micros allowed in the next session (a funded account's scaling step). */
  allowedMicros: number;
  /** Days a trade was taken on, and the best single day, since it opened. */
  tradingDays: number;
  bestDay: number;
  /** The payout cycle: since it opened or since the last payout. */
  cycle: { startBalance: number; profitDays: number; tradingDays: number; bestDay: number };
  payouts: number;
  /** Withdrawn from the account so far, before the firm's split. */
  withdrawn: number;
  /** Paid to the owner so far, after the split. */
  received: number;
  /** Fees paid for it (the attempt, an activation). */
  fees: number;
  request: PayoutRequest | null;
  /** Payout request keys already seen, so a repeat is refused. */
  seenRequests: string[];
  /** Why it is in the state it is, in a line. */
  why: string;
}

export interface LedgerFill {
  id: string;
  day: string;
  symbol: Symbol;
  side: 'long' | 'short';
  micros: number;
  /** When the order could be acted on (the signal bar's close) and when the exit bar was complete. */
  entryAt: number;
  exitAt: number;
  /** What a point of this market's micro is worth. */
  pointValue: number;
  /** The stop's distance, the result, and the worst and best the trade stood while open: all in points, the result signed. */
  stopPoints: number;
  pnlPoints: number;
  mae: number;
  mfe: number;
  maeAt: number | null;
  mfeAt: number | null;
  /** Commission and slippage for the whole fill, in dollars. */
  costs: number;
  /** The excursions weren't recorded for this trade: they are the least they could have been. */
  approx: boolean;
  label: string;
}

export type LedgerEventKind = 'opened' | 'fill' | 'closed' | 'rejected' | 'breach' | 'daily-limit' | 'day' | 'target' | 'pass-pending' | 'passed' | 'tier' | 'payout-eligible' | 'payout-requested' | 'payout-paid' | 'payout-denied' | 'retired' | 'fee' | 'note';

export interface LedgerEvent {
  at: number;
  day: string;
  account: string;
  kind: LedgerEventKind;
  text: string;
  /** Money: a trade's result, a fee (negative), a payout to the owner. */
  amount: number;
  fillId?: string;
}

export interface DayReport {
  day: string;
  fills: number;
  wins: number;
  losses: number;
  /** Settled result of the day. */
  pnl: number;
  balance: number;
  floor: number;
  cushion: number;
  /** The lowest the account's equity stood in the day, open trades included, and how far above the floor that was. */
  lowEquity: number;
  lowCushion: number;
  /** The most micros held at once. */
  peakMicros: number;
  status: AccountStatus;
  note: string;
}

const money = (n: number) => `${n < 0 ? '−' : ''}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`;
const cents = (n: number) => Math.round(n * 100) / 100;

export function openAccount(rules: RuleSet, o: { id: string; label?: string; environment?: Environment; day: string; fee?: number; linked?: string | null }): Account {
  return {
    id: o.id, label: o.label ?? o.id, ruleSetId: rules.id, phase: rules.phase, environment: o.environment ?? 'simulated', status: 'active', openedOn: o.day, linked: o.linked ?? null,
    start: rules.size, balance: rules.size, peak: rules.size, floorLock: null, allowedMicros: tierMicros(rules, 0), tradingDays: 0, bestDay: 0,
    cycle: { startBalance: rules.size, profitDays: 0, tradingDays: 0, bestDay: 0 }, payouts: 0, withdrawn: 0, received: 0, fees: o.fee ?? 0, request: null, seenRequests: [], why: rules.phase === 'eval' ? 'Evaluation opened' : 'Funded account opened',
  };
}

/** Where the account fails right now. */
export const floorOf = (a: Account, rules: RuleSet) => Math.max(floorFor(rules, a.peak), a.floorLock ?? -Infinity);
export const cushionOf = (a: Account, rules: RuleSet) => Math.max(0, a.balance - floorOf(a, rules));

/** A paper trade as the fill an account would have had: this many micros, after these costs. */
export function fillOf(t: PaperTrade, micros: number, cost: CostModel, o: { managed?: boolean; id?: string } = {}): LedgerFill {
  const pv = INSTRUMENTS[t.symbol].microPointValue;
  const stopPoints = Math.abs(t.entry - t.stop);
  const pnlPoints = t.dollars / pv;
  // A trade managed another way ended somewhere else: all that's known of its path is where it finished.
  const known = !o.managed && t.mae != null && t.mfe != null;
  const mae = known ? Math.max(t.mae!, Math.max(0, -pnlPoints)) : Math.max(0, -pnlPoints);
  const mfe = known ? Math.max(t.mfe!, Math.max(0, pnlPoints)) : Math.max(0, pnlPoints);
  const entryAt = t.entryAt + 60_000;
  const exitAt = Math.max(entryAt, (t.exitAt ?? t.entryAt) + 60_000);
  return {
    id: o.id ?? t.id, day: t.day, symbol: t.symbol, side: t.side, micros, entryAt, exitAt, pointValue: pv, stopPoints, pnlPoints, mae, mfe,
    maeAt: known && t.maeAt != null ? t.maeAt + 60_000 : null, mfeAt: known && t.mfeAt != null ? t.mfeAt + 60_000 : null,
    costs: cents(micros * costPerMicro(t.symbol, t.outcome, cost)), approx: !known,
    label: `${t.side === 'long' ? 'Long' : 'Short'} ${micros} ${INSTRUMENTS[t.symbol].micro}`,
  };
}

/** A fill's open result along the way: where it stood at each time it's known, in points. */
function marksOf(f: LedgerFill): { t: number; pts: number }[] {
  const span = Math.max(1, f.exitAt - f.entryAt);
  const clamp = (t: number) => Math.min(f.exitAt, Math.max(f.entryAt, t));
  // With no times recorded, the worst comes first: the reading that tests the account hardest.
  const lo = { t: clamp(f.maeAt ?? f.entryAt + span / 3), pts: -f.mae };
  const hi = { t: clamp(f.mfeAt ?? f.entryAt + (span * 2) / 3), pts: f.mfe };
  const mid = [lo, hi].filter((m) => m.pts !== 0).sort((a, b) => a.t - b.t || a.pts - b.pts);
  return [{ t: f.entryAt, pts: 0 }, ...mid, { t: f.exitAt, pts: f.pnlPoints }];
}

interface Open {
  f: LedgerFill;
  marks: { t: number; pts: number }[];
}

function openPoints(o: Open, at: number): number {
  const m = o.marks;
  if (at <= m[0]!.t) return 0;
  for (let i = 1; i < m.length; i++) {
    const a = m[i - 1]!;
    const b = m[i]!;
    if (at <= b.t) return b.t === a.t ? Math.min(a.pts, b.pts) : a.pts + ((b.pts - a.pts) * (at - a.t)) / (b.t - a.t);
  }
  return m[m.length - 1]!.pts;
}

/**
 * One session of one account. Fills are added in the order they were entered; `advance` moves the clock,
 * settling what has closed and checking the limits at every mark on the way. `close` ends the day: the
 * floor trails, the contract limit steps, and the account is checked against its pass or payout rule.
 */
export class DaySession {
  private open: Open[] = [];
  private clock = 0;
  private dayStart: number;
  private fills = 0;
  private wins = 0;
  private losses = 0;
  private lowEquity: number;
  /** The least the equity stood above the floor as the floor was at that moment. */
  private lowCushion: number;
  private peakMicros = 0;
  /** No more trades today: the daily loss limit, or the account is finished. */
  stopped = '';
  /** When the account was breached, if it was. */
  breachedAt: number | null = null;

  constructor(readonly account: Account, readonly rules: RuleSet, readonly day: string, private log?: (e: LedgerEvent) => void) {
    this.dayStart = account.balance;
    this.lowEquity = account.balance;
    this.lowCushion = account.balance - floorOf(account, rules);
  }

  private emit(kind: LedgerEventKind, at: number, text: string, amount = 0, fillId?: string) {
    this.log?.({ at, day: this.day, account: this.account.id, kind, text, amount, ...(fillId ? { fillId } : {}) });
  }

  /** Micros held right now, and what they'd lose if every stop were hit. */
  get openMicros() {
    return this.open.reduce((a, o) => a + o.f.micros, 0);
  }
  get openRisk() {
    return this.open.reduce((a, o) => a + o.f.micros * o.f.stopPoints * o.f.pointValue + o.f.costs, 0);
  }
  /** The positions held right now, for a check across accounts. */
  get positions(): { symbol: Symbol; side: 'long' | 'short'; micros: number }[] {
    return this.open.map((o) => ({ symbol: o.f.symbol, side: o.f.side, micros: o.f.micros }));
  }
  /** The day's settled result so far, and how many trades have closed at a loss. */
  get dayPnl() {
    return cents(this.account.balance - this.dayStart);
  }
  get lossesToday() {
    return this.losses;
  }
  get winsToday() {
    return this.wins;
  }
  get fillsToday() {
    return this.fills;
  }

  private equity(at: number): number {
    return this.account.balance + this.open.reduce((a, o) => a + openPoints(o, at) * o.f.pointValue * o.f.micros, 0);
  }

  private settle(o: Open, at: number, points: number, how: 'closed' | 'liquidated') {
    const a = this.account;
    const pnl = cents(points * o.f.pointValue * o.f.micros - o.f.costs);
    a.balance = cents(a.balance + pnl);
    if (pnl > 0) this.wins++;
    else if (pnl < 0) this.losses++;
    this.emit('closed', at, `${o.f.label}${how === 'liquidated' ? ' flattened' : ''}: ${pnl >= 0 ? '+' : '−'}$${Math.abs(Math.round(pnl))}`, pnl, o.f.id);
  }

  /** Moves the clock to `to`, settling exits and checking the limits at every mark up to it. */
  advance(to: number) {
    while (this.open.length && this.breachedAt == null) {
      // The next moment anything is known: a mark or an exit of something held.
      let next = Infinity;
      for (const o of this.open) for (const m of o.marks) if (m.t > this.clock && m.t < next) next = m.t;
      if (next > to) break;
      this.clock = next;
      for (const o of [...this.open]) {
        if (o.f.exitAt <= next) {
          this.open.splice(this.open.indexOf(o), 1);
          this.settle(o, next, o.f.pnlPoints, 'closed');
        }
      }
      this.check(next);
    }
    if (to > this.clock && Number.isFinite(to)) this.clock = to;
  }

  /** The limits, at one moment: the trailing floor, then the day's loss limit. */
  private check(at: number) {
    const a = this.account;
    const r = this.rules;
    const eq = this.equity(at);
    if (r.drawdownType === 'trailing-intraday' && eq > a.peak) a.peak = eq;
    const floor = floorOf(a, r);
    if (eq < this.lowEquity) this.lowEquity = eq;
    if (eq - floor < this.lowCushion) this.lowCushion = eq - floor;
    if (eq <= floor) {
      for (const o of this.open.splice(0)) this.settle(o, at, openPoints(o, at), 'liquidated');
      a.status = 'breached';
      a.why = `Equity touched the ${money(floor)} floor${this.fills ? ' inside a trade' : ''}`;
      this.breachedAt = at;
      this.stopped = 'breached';
      this.emit('breach', at, `Breached: equity ${money(eq)} at the ${money(floor)} floor.`, 0);
      return;
    }
    if (r.dailyLossLimit != null && !this.stopped && eq - this.dayStart <= -r.dailyLossLimit) {
      for (const o of this.open.splice(0)) this.settle(o, at, openPoints(o, at), 'liquidated');
      this.stopped = 'daily loss limit';
      this.emit('daily-limit', at, `Daily loss limit of ${money(r.dailyLossLimit)} reached: flat, and no more trades today.`, 0);
    }
  }

  /** Takes a fill at its entry, or says why the account can't (and logs it). */
  add(f: LedgerFill): string | null {
    this.advance(f.entryAt);
    const a = this.account;
    const refuse = (why: string) => {
      this.emit('rejected', f.entryAt, `${f.label} refused: ${why}`, 0, f.id);
      return why;
    };
    if (!canTrade(a.status)) return refuse(a.status === 'parked' ? 'parked until the payout is reconciled' : `the account is ${STATUS_WORD[a.status].toLowerCase()}`);
    if (this.stopped) return refuse(`stopped for the day (${this.stopped})`);
    if (!(f.micros >= 1)) return refuse('no size');
    if (this.openMicros + f.micros > a.allowedMicros) return refuse(`${this.openMicros + f.micros} micros would be over the limit of ${a.allowedMicros}`);
    this.open.push({ f, marks: marksOf(f) });
    this.fills++;
    this.peakMicros = Math.max(this.peakMicros, this.openMicros);
    this.emit('fill', f.entryAt, `${f.label} · stop ${money(f.micros * f.stopPoints * f.pointValue)} away`, 0, f.id);
    return null;
  }

  /** The end of the session. */
  close(): DayReport {
    this.advance(Infinity);
    const at = this.clock;
    const a = this.account;
    const r = this.rules;
    const pnl = cents(a.balance - this.dayStart);
    const done = (note: string): DayReport => {
      const floor = floorOf(a, r);
      return { day: this.day, fills: this.fills, wins: this.wins, losses: this.losses, pnl, balance: a.balance, floor, cushion: Math.max(0, cents(a.balance - floor)), lowEquity: cents(this.lowEquity), lowCushion: cents(Math.max(0, this.lowCushion)), peakMicros: this.peakMicros, status: a.status, note };
    };
    if (a.status === 'breached') return done('Breached');
    if (!canTrade(a.status)) return done(STATUS_WORD[a.status]);
    if (r.drawdownType === 'trailing-eod' && a.balance > a.peak) a.peak = a.balance;
    if (this.fills) {
      a.tradingDays++;
      a.cycle.tradingDays++;
    }
    a.bestDay = Math.max(a.bestDay, pnl);
    a.cycle.bestDay = Math.max(a.cycle.bestDay, pnl);
    if (r.payout && pnl >= Math.max(r.payout.profitDayMin, 0.01)) a.cycle.profitDays++;
    const tier = tierMicros(r, a.balance - a.start);
    if (tier !== a.allowedMicros) {
      this.emit('tier', at, `Contract limit ${tier > a.allowedMicros ? 'up' : 'down'} to ${tier} micros from the next session.`, 0);
      a.allowedMicros = tier;
    }
    let note = this.stopped ? `Stopped for the day (${this.stopped})` : '';
    if (r.phase === 'eval') {
      const check = passCheck(a, r);
      if (check.passed) {
        a.status = 'pass-pending';
        a.why = `Every rule met at ${money(a.balance)}: waiting for the firm to confirm`;
        this.emit('pass-pending', at, `Target and every rule met at ${money(a.balance)}. No more trades until the firm confirms the pass.`, 0);
        note = 'Pass pending confirmation';
      } else if (check.targetMet) {
        if (a.status !== 'target-reached') this.emit('target', at, `Target reached at ${money(a.balance)}, but ${check.pending.join(' and ')}.`, 0);
        a.status = 'target-reached';
        a.why = `Target reached, but ${check.pending.join(' and ')}`;
        note = a.why;
      } else {
        a.status = 'active';
        a.why = `${money(Math.max(0, r.profitTarget - (a.balance - a.start)))} to the target`;
      }
    } else if (r.payout) {
      const p = payoutCheck(a, r);
      if (p.eligible) {
        if (a.status !== 'payout-eligible') this.emit('payout-eligible', at, `Payout eligible: ${money(p.amount)} may be requested.`, 0);
        a.status = 'payout-eligible';
        a.why = `${money(p.amount)} may be requested`;
        note = 'Payout eligible';
      } else {
        a.status = 'active';
        a.why = p.checks.find((c) => !c.ok)?.detail ?? 'Trading';
      }
    }
    return done(note);
  }
}

export interface RuleCheck {
  label: string;
  ok: boolean;
  detail: string;
}

/** An evaluation against its pass rule. */
export function passCheck(a: Account, r: RuleSet): { passed: boolean; targetMet: boolean; pending: string[]; checks: RuleCheck[] } {
  const profit = a.balance - a.start;
  const targetMet = profit >= r.profitTarget - 1e-9;
  const base = r.consistencyBasis === 'profitTarget' ? r.profitTarget : profit;
  const share = base > 0 ? a.bestDay / base : null;
  const steady = r.consistencyPercent >= 100 || share == null || share <= r.consistencyPercent / 100 + 1e-9;
  const days = a.tradingDays >= r.minTradingDays;
  const checks: RuleCheck[] = [
    { label: 'Profit target', ok: targetMet, detail: targetMet ? `${money(profit)} of ${money(r.profitTarget)}` : `${money(r.profitTarget - profit)} still to make` },
    { label: 'Trading days', ok: days, detail: `${a.tradingDays} of ${r.minTradingDays}` },
    { label: 'Consistency', ok: steady, detail: r.consistencyPercent >= 100 ? 'No rule' : share == null ? `Best day at most ${r.consistencyPercent}%` : `Best day is ${Math.round(share * 100)}% of ${r.consistencyBasis === 'profitTarget' ? 'the target' : 'the profit'} (at most ${r.consistencyPercent}%)` },
  ];
  const pending: string[] = [];
  if (!days) pending.push(`only ${a.tradingDays} of the ${r.minTradingDays} trading days it needs`);
  if (!steady) pending.push(`the best day is ${Math.round((share ?? 0) * 100)}% of ${r.consistencyBasis === 'profitTarget' ? 'the target' : 'the profit'} (the rule allows ${r.consistencyPercent}%)`);
  return { passed: targetMet && days && steady, targetMet, pending, checks };
}

/** A funded account against its payout rule: what may be requested, and each condition. */
export function payoutCheck(a: Account, r: RuleSet): { eligible: boolean; amount: number; checks: RuleCheck[] } {
  const p = r.payout;
  if (!p) return { eligible: false, amount: 0, checks: [{ label: 'Payouts', ok: false, detail: 'This account has no payout rule' }] };
  const profit = a.balance - a.start;
  const cycleProfit = a.balance - a.cycle.startBalance;
  const amount = Math.max(0, Math.floor(Math.min(profit * p.withdrawShare, p.maxRequest ?? Infinity)));
  const share = cycleProfit > 0 ? a.cycle.bestDay / cycleProfit : null;
  const steady = p.consistencyPercent >= 100 || (share != null && share <= p.consistencyPercent / 100 + 1e-9);
  const left = p.maxPayouts == null ? null : p.maxPayouts - a.payouts;
  const checks: RuleCheck[] = [
    { label: p.profitDayMin ? `Days of ${money(p.profitDayMin)} or more` : 'Trading days', ok: (p.profitDayMin ? a.cycle.profitDays : a.cycle.tradingDays) >= p.profitDays, detail: `${p.profitDayMin ? a.cycle.profitDays : a.cycle.tradingDays} of ${p.profitDays} this cycle` },
    { label: 'Profit in the account', ok: profit >= p.minProfit - 1e-9, detail: profit >= p.minProfit ? `${money(profit)} (needs ${money(p.minProfit)})` : `${money(p.minProfit - profit)} more to reach ${money(p.minProfit)}` },
    { label: 'Net profit this cycle', ok: cycleProfit > 0, detail: cycleProfit > 0 ? money(cycleProfit) : 'The cycle isn’t in profit' },
    { label: 'Request size', ok: amount >= p.minRequest && amount > 0, detail: `${money(amount)} available${p.minRequest ? ` (least ${money(p.minRequest)}${p.maxRequest ? `, most ${money(p.maxRequest)}` : ''})` : ''}` },
  ];
  if (p.consistencyPercent < 100) checks.push({ label: 'Consistency', ok: steady, detail: share == null ? `Best day at most ${p.consistencyPercent}% of the cycle’s profit` : `Best day is ${Math.round(share * 100)}% of the cycle’s profit (at most ${p.consistencyPercent}%)` });
  if (left != null) checks.push({ label: 'Payouts left', ok: left > 0, detail: `${Math.max(0, left)} of ${p.maxPayouts}` });
  return { eligible: canTrade(a.status) && checks.every((c) => c.ok), amount, checks };
}

/** The firm (or, in a simulation, the next open) confirms a pending pass. */
export function confirmPass(a: Account, day: string, log?: (e: LedgerEvent) => void): string | null {
  if (a.status !== 'pass-pending') return 'There is no pass waiting to be confirmed';
  a.status = 'passed';
  a.why = 'Evaluation passed';
  log?.({ at: 0, day, account: a.id, kind: 'passed', text: `Passed at ${money(a.balance)}.`, amount: 0 });
  return null;
}

/**
 * A payout request. The account is parked from here: nothing is routed to it until the request is
 * reconciled. The floor moves where the firm's rule says it moves on a request.
 */
export function requestPayout(a: Account, r: RuleSet, day: string, o: { key: string; amount?: number }, log?: (e: LedgerEvent) => void): string | null {
  if (a.seenRequests.includes(o.key)) return 'That request was already made';
  if (a.request) return 'A payout is already requested on this account';
  const c = payoutCheck(a, r);
  if (!c.eligible) return c.checks.find((x) => !x.ok)?.detail ?? 'Not eligible for a payout yet';
  const amount = Math.round(o.amount ?? c.amount);
  if (!(amount > 0) || amount > c.amount) return `The most that can be requested is ${money(c.amount)}`;
  if (amount < r.payout!.minRequest) return `The least that can be requested is ${money(r.payout!.minRequest)}`;
  a.request = { key: o.key, amount, day };
  a.seenRequests.push(o.key);
  a.status = 'parked';
  a.why = `${money(amount)} requested on ${day}: parked until it's reconciled`;
  if (r.payout!.floorOnRequest != null) a.floorLock = Math.max(a.floorLock ?? -Infinity, a.start + r.payout!.floorOnRequest);
  log?.({ at: 0, day, account: a.id, kind: 'payout-requested', text: `Payout of ${money(amount)} requested. Parked: no trades until it is reconciled${r.payout!.floorOnRequest != null ? `; the floor is now ${money(a.start + r.payout!.floorOnRequest)}` : ''}.`, amount: 0 });
  return null;
}

/**
 * The withdrawal is reconciled: `withdrawn` left the account (all of the request, or part of it), and the
 * owner's share of that is what was received. The account goes back into the rotation with what's left.
 */
export function settlePayout(a: Account, r: RuleSet, day: string, o: { withdrawn?: number } = {}, log?: (e: LedgerEvent) => void): { error: string } | { received: number; withdrawn: number } {
  const req = a.request;
  const p = r.payout;
  if (!req || !p) return { error: 'No payout is waiting on this account' };
  const withdrawn = Math.round(o.withdrawn ?? req.amount);
  if (!(withdrawn > 0) || withdrawn > req.amount) return { error: `The request was for ${money(req.amount)}: enter what was actually withdrawn, up to that` };
  const received = Math.round(withdrawn * p.split);
  a.request = null;
  a.payouts++;
  a.withdrawn += withdrawn;
  a.received += received;
  if (p.after === 'reset') {
    a.balance = a.start;
    a.peak = a.start;
    a.floorLock = null;
    a.tradingDays = 0;
    a.bestDay = 0;
  } else a.balance = cents(a.balance - withdrawn);
  a.cycle = { startBalance: a.balance, profitDays: 0, tradingDays: 0, bestDay: 0 };
  a.allowedMicros = tierMicros(r, a.balance - a.start);
  const last = p.maxPayouts != null && a.payouts >= p.maxPayouts;
  a.status = last ? 'retired' : 'active';
  a.why = last ? `Payout ${a.payouts} of ${p.maxPayouts} taken: the firm moves the account on from here` : `Paid ${money(received)}: back in the rotation with ${money(cushionOf(a, r))} of cushion`;
  log?.({ at: 0, day, account: a.id, kind: 'payout-paid', text: `Paid ${money(received)} (${Math.round(p.split * 100)}% of ${money(withdrawn)}${withdrawn < req.amount ? `, of the ${money(req.amount)} requested` : ''}). Balance ${money(a.balance)}, limit ${a.allowedMicros} micros.`, amount: received });
  if (last) log?.({ at: 0, day, account: a.id, kind: 'retired', text: a.why, amount: 0 });
  return { received, withdrawn };
}

/** The firm turned the request down: nothing left the account, and it goes back to trading. */
export function denyPayout(a: Account, day: string, reason: string, log?: (e: LedgerEvent) => void): string | null {
  if (!a.request) return 'No payout is waiting on this account';
  const amount = a.request.amount;
  a.request = null;
  a.status = 'active';
  a.why = `Payout of ${money(amount)} denied${reason ? `: ${reason}` : ''}`;
  log?.({ at: 0, day, account: a.id, kind: 'payout-denied', text: `${a.why}. Nothing left the account.`, amount: 0 });
  return null;
}

export interface ReplayResult {
  account: Account;
  days: DayReport[];
  events: LedgerEvent[];
  /**
   * How it ended. `insufficient` is not a fail and not a pass: the days ran out first. `hypothetical`
   * is true when the rule set has unknowns or unverified numbers, so even a pass is a what-if.
   */
  verdict: 'passed' | 'breached' | 'payout' | 'insufficient';
  hypothetical: boolean;
  why: string;
}

/**
 * One account over a run of days, given the fills it took each day (already sized). Stops at a pass,
 * a breach, or a funded account's first payout request.
 */
export function replayAccount(rules: RuleSet, days: { day: string; fills: LedgerFill[] }[], o: { id?: string } = {}): ReplayResult {
  const events: LedgerEvent[] = [];
  const log = (e: LedgerEvent) => events.push(e);
  const a = openAccount(rules, { id: o.id ?? 'ACCOUNT-1', day: days[0]?.day ?? '' });
  const reports: DayReport[] = [];
  const end = (verdict: ReplayResult['verdict'], why: string): ReplayResult => ({ account: a, days: reports, events, verdict, hypothetical: !isVerified(rules), why });
  for (const d of days) {
    const s = new DaySession(a, rules, d.day, log);
    for (const f of [...d.fills].sort((x, y) => x.entryAt - y.entryAt)) s.add(f);
    reports.push(s.close());
    if (a.status === 'breached') return end('breached', a.why);
    if (a.status === 'pass-pending') return end('passed', `Every rule met on day ${reports.length}`);
    if (a.status === 'payout-eligible') return end('payout', `Payout eligible on day ${reports.length}`);
  }
  return end('insufficient', days.length ? `${a.why} when the days ran out: not enough data to call it` : 'No days to play');
}
