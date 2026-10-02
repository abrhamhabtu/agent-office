import type { PlaybookId, Symbol, TradeInd } from './trading.js';
import type { ManagedR } from './manage.js';
import type { AccountStatus, Environment, RuleCheck } from './account-ledger.js';
import type { FarmOdds, FarmRun, FarmSetup } from './farm.js';
import type { CostId } from './fills.js';
import type { Provenance } from './prop-rules.js';
import type { DecisionRecord, ShadowSummary } from './research-decision.js';
import type { ValidationReport } from './validation.js';

// What the Prop Farm console draws: the accounts, the research queue, the forward runs, the payout desk
// and what stands between paper and an order. Made by src/server/trading/* and painted by
// src/client/trading/farm.ts. Everything here is paper or the owner's own bookkeeping: nothing in it is a
// balance read from a firm unless its source says `connected`.

// ---- Research jobs ---------------------------------------------------------------------------------------

export type JobKind = 'sizing' | 'validate' | 'shadow';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface JobView {
  id: string;
  kind: JobKind;
  title: string;
  agent: string;
  hypothesis: string;
  criteria: string;
  /** The data it runs on, in words, and its fingerprint. */
  dataset: string;
  datasetHash: string;
  seed: number;
  status: JobStatus;
  stage: string;
  done: number;
  total: number;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  cpuMs: number;
  error: string | null;
  verdict: string;
  artifacts: { label: string; value: string }[];
}

/** One run of the sizing experiment: a program, a stage's cap, a strategy and a cost setting. */
export interface SizingCell {
  program: string;
  /** The stage whose cap is being varied (the other stage sits at its baseline). */
  phase: 'eval' | 'funded';
  /** Micros asked for, or `cushion` for the cushion-based baseline. */
  cap: number | 'cushion';
  strategy: string;
  strategyName: string;
  cost: CostId;
}

export interface SizingResult extends SizingCell {
  /** Why it couldn't be run (a cap over the firm's limit): kept, so an illegal request is on the record. */
  refused: string | null;
  odds: FarmOdds | null;
}

export interface JobDetail {
  job: JobView;
  sizing?: SizingResult[];
  reports?: ValidationReport[];
  shadow?: { summary: ShadowSummary; records: DecisionRecord[] };
}

/** A job the research lead can launch, with what it sets out to test said up front. */
export interface JobPreset {
  id: string;
  kind: JobKind;
  title: string;
  agent: string;
  hypothesis: string;
  criteria: string;
  /** How many runs it is. */
  cells: number;
  what: string;
}

// ---- Accounts ---------------------------------------------------------------------------------------------

export interface AccountCard {
  id: string;
  label: string;
  /** Where its numbers come from: the office's paper simulation, the owner's own entries, or a connection. */
  source: Environment;
  /** The forward run it belongs to, when it is one of a run's accounts. */
  run: string | null;
  runName: string | null;
  firm: string;
  program: string;
  size: number;
  phase: 'eval' | 'funded';
  status: AccountStatus;
  statusWord: string;
  /** Whether new trades are routed to it, and if not, why. */
  trading: boolean;
  why: string;
  balance: number;
  start: number;
  floor: number;
  /** Distance to failure: what it can lose before it is breached. */
  cushion: number;
  /** What it is aiming at: the evaluation's target balance, or the balance a payout needs. */
  target: number;
  todayPnl: number;
  /** What it may still lose today under its risk policy (null: no day budget). */
  todayBudget: number | null;
  allowedMicros: number;
  /** The cap its policy asks for, and the policy's name. */
  cap: number;
  policy: string;
  /** What it trades, and the pinned version of it. */
  strategy: string;
  version: string;
  /** Whether its rules were read on the firm's own pages. */
  verified: boolean;
  automation: 'allowed' | 'prohibited' | 'unknown';
  tradingDays: number;
  profitDays: number;
  profitDaysNeeded: number;
  fees: number;
  received: number;
  ruleSet: string;
  /** The last few days' balances, for the card's line. */
  series: number[];
}

/** The money, kept apart by what kind of money it is. */
export interface FarmTotals {
  /** Profit on paper in simulated accounts: not cash. */
  simulatedProfit: number;
  /** What simulated and tracked accounts could request right now. */
  eligible: number;
  /** Requested and not yet reconciled. */
  requested: number;
  /** Paid in the simulation: still not cash. */
  simulatedReceived: number;
  /** Cash the owner has confirmed receiving, on accounts they track by hand. */
  confirmedReceived: number;
  /** Fees: what the simulation would have paid, and what the owner has entered as paid. */
  simulatedFees: number;
  confirmedFees: number;
  counts: Record<'eval' | 'funded' | 'parked' | 'breached' | 'other', number>;
}

// ---- Forward runs ---------------------------------------------------------------------------------------

/** One setup a playbook called, written down when the office saw it: before anyone knew how it came out. */
export interface ForwardDecision {
  id: string;
  /** The market's time: when the signal bar closed. */
  signalAt: number;
  /** The office's time: when it wrote the decision down. */
  recordedAt: number;
  /**
   * `forward`: written down while the trade was still open and within a minute and a half of its bar.
   * `late`: reconstructed afterwards (the office was off, or catching up): it counts for nothing as forward evidence.
   */
  kind: 'forward' | 'late';
  day: string;
  symbol: Symbol;
  side: 'long' | 'short';
  playbook: PlaybookId;
  entry: number;
  stop: number;
  target: number;
  /** Why the playbook called it, and what the indicators read on its bar (all known at the decision). */
  why: string;
  ind: TradeInd | null;
  /** The fingerprint of the playbook settings that made it. */
  tuning: string;
  /** Where the bars came from, and whether that feed runs behind the exchange. */
  feed: string;
  delayed: boolean;
  /** How it came out, once it has: written beside the decision, never over it. */
  outcome: { at: number; result: 'win' | 'loss' | 'time' | 'void'; r: number; dollars: number; mae: number | null; mfe: number | null; maeAt: number | null; mfeAt: number | null; exitAt: number; ambiguous: boolean; alt: ManagedR | null } | null;
}

export interface ForwardRunView {
  id: string;
  name: string;
  status: 'running' | 'paused' | 'stopped';
  /** Why it is paused, when it is. */
  pause: string;
  startedAt: number;
  startDay: string;
  setup: FarmSetup;
  /** What is pinned for the life of the run: new settings are a new run. */
  pinned: { tuning: string; tuningLabel: string; ruleSets: string[]; cost: CostId; fills: string };
  /** What kind of test this honestly is. */
  feedLabel: string;
  delayed: boolean;
  counts: { decisions: number; forward: number; late: number; closed: number; open: number; sessions: number };
  /** The release gate: forward sessions and closed forward trades against what it asks for. */
  gate: { sessions: number; sessionsNeeded: number; trades: number; tradesNeeded: number; met: boolean };
  /** The farm's accounts played over the run's decisions. */
  run: FarmRun;
  net: number;
  /** The latest decisions, newest first. */
  decisions: ForwardDecision[];
  /** The deterministic baseline it is measured against: every decision taken at one micro, after the run's costs, in R. */
  baseline: { trades: number; avgR: number; totalR: number };
  discord: boolean;
}

// ---- Payouts ---------------------------------------------------------------------------------------------

export interface PayoutRow {
  account: string;
  label: string;
  source: Environment;
  firm: string;
  program: string;
  status: AccountStatus;
  checks: RuleCheck[];
  /** What may be requested now, what has been requested and is waiting, and what has been received on this account. */
  eligible: number;
  requested: number | null;
  requestedOn: string | null;
  received: number;
  payouts: number;
  payoutsAllowed: number | null;
  /** The floor now, and where the floor and the cushion would be once a request for the eligible amount is made and paid. */
  floor: number;
  floorAfter: number;
  cushionAfter: number;
  microsAfter: number;
  /** When it may trade again. */
  next: string;
  split: number;
}

export interface PayoutEntry {
  id: string;
  at: number;
  day: string;
  account: string;
  source: Environment;
  kind: 'requested' | 'paid' | 'denied';
  /** Requested: the amount asked for. Paid: what the owner received. */
  amount: number;
  note: string;
}

// ---- Rules, readiness, operations --------------------------------------------------------------------------

export interface RuleSetView {
  id: string;
  firm: string;
  program: string;
  size: number;
  phase: 'eval' | 'funded';
  cohort: string;
  verifiedOn: string | null;
  verified: boolean;
  automation: 'allowed' | 'prohibited' | 'unknown';
  rows: { label: string; value: string; how: Provenance }[];
  issues: string[];
  notes: string[];
  sources: { label: string; url: string }[];
}

/** One thing that has to be true before an order could ever be sent, and whether it is. */
export interface ReadinessItem {
  label: string;
  state: 'ready' | 'blocked' | 'missing';
  detail: string;
}

export interface BrokerCapability {
  id: string;
  name: string;
  data: 'wired' | 'unverified' | 'none';
  accounts: 'wired' | 'unverified' | 'none';
  orders: 'sandbox' | 'unverified' | 'none';
  note: string;
}

export interface OpsView {
  /** Each market's feed: where its bars come from, how old the newest is, and whether that is too old to decide on. */
  feeds: { symbol: Symbol; source: string; delayed: boolean; ageSec: number | null; stale: boolean }[];
  /** What the observer has paused or noticed, newest first. */
  notes: { at: number; text: string; level: 'info' | 'warn' }[];
  worker: { busy: boolean; concurrency: number; rest: string };
}

export interface PropFarmView {
  accounts: AccountCard[];
  totals: FarmTotals;
  jobs: JobView[];
  presets: JobPreset[];
  runs: ForwardRunView[];
  payouts: PayoutRow[];
  payoutLog: PayoutEntry[];
  shadow: { summary: ShadowSummary; recent: DecisionRecord[]; adapter: string } | null;
  rules: RuleSetView[];
  readiness: ReadinessItem[];
  brokers: BrokerCapability[];
  ops: OpsView;
  /** How often each family's holdout has been opened: once is a test, more is not. */
  holdout: { family: string; candidate: string; at: number; verdict: string }[];
  /** The strategies a job can be asked to run: the live playbooks, the tuner's candidates and the lab's mixes. */
  strategies: { id: string; name: string; family: string; baseline: boolean; trades: number }[];
  /** The data research runs on right now (null: the backtest hasn't finished). */
  dataset: { hash: string; label: string; days: number; trades: number } | null;
}
