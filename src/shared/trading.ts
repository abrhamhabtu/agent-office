// The trading floors: what the server's market desk sends and what the boards, screens and laptops draw.
// Shared by src/server/trading/* (which makes it) and src/client/trading/* (which paints it).
//
// Two floors: 🔔 Opening Bell, where the morning is run live (news, proposals off the three playbooks,
// the prop accounts, the journal), and 🗄️ Back Office, where every setup is proved first: a backtest pod
// and a paper pod. Prices are real (CME futures and Bitcoin); nothing here can place an order.

import type { ManagedR } from './manage.js';
import type { TunerView } from './tuning.js';
import type { FarmView } from './farm.js';

export const SYMBOLS = ['NQ', 'ES', 'GC', 'BTC'] as const;
export type Symbol = (typeof SYMBOLS)[number];

export interface InstrumentSpec {
  symbol: Symbol;
  name: string;
  /** The micro contract a prop account trades it with, and what one point of it is worth. */
  micro: string;
  microPointValue: number;
  /** The full-size contract's point value. */
  pointValue: number;
  tick: number;
  decimals: number;
  ink: string;
  /** How far past a level a stop sits for each playbook, in points (from the playbooks, scaled per market). */
  buffers: { vwap: number; doubleBreak: number; zone: number; auctionStop: number };
  /** The bin a volume profile is built in, in points. */
  profileBin: number;
}

export const INSTRUMENTS: Record<Symbol, InstrumentSpec> = {
  NQ: { symbol: 'NQ', name: 'Nasdaq-100 futures', micro: 'MNQ', microPointValue: 2, pointValue: 20, tick: 0.25, decimals: 2, ink: '#7DF9FF', buffers: { vwap: 6, doubleBreak: 8, zone: 15, auctionStop: 20 }, profileBin: 5 },
  ES: { symbol: 'ES', name: 'S&P 500 futures', micro: 'MES', microPointValue: 5, pointValue: 50, tick: 0.25, decimals: 2, ink: '#A0E7A0', buffers: { vwap: 1.5, doubleBreak: 2, zone: 4, auctionStop: 5 }, profileBin: 1.25 },
  GC: { symbol: 'GC', name: 'Gold futures', micro: 'MGC', microPointValue: 10, pointValue: 100, tick: 0.1, decimals: 1, ink: '#FFD166', buffers: { vwap: 1.5, doubleBreak: 2, zone: 3, auctionStop: 4 }, profileBin: 1 },
  BTC: { symbol: 'BTC', name: 'Bitcoin', micro: 'MBT', microPointValue: 0.1, pointValue: 5, tick: 5, decimals: 0, ink: '#FF9F5A', buffers: { vwap: 60, doubleBreak: 80, zone: 120, auctionStop: 150 }, profileBin: 50 },
};

// ---- The floors -------------------------------------------------------------------------------------

/** Opening Bell runs the morning live; Back Office is the proving ground: backtests and paper. */
export type FloorRole = 'bell' | 'office';

/** Which trading floor a floor is by its name: Back Office (and the old paper floors) prove, every other floor runs the bell. */
export function floorRole(name: string | undefined): FloorRole {
  return /\b(back ?office|proving|paper|backtests?)\b/i.test(name ?? '') ? 'office' : 'bell';
}

/** What each floor's four pods are for, north-west first (the order DESKS fills them: 4 desks a pod). */
export const PODS: Record<FloorRole, { name: string; icon: string; color: string }[]> = {
  bell: [
    { name: 'VWAP desk', icon: '📈', color: '#00bbf9' },
    { name: 'Zones & levels', icon: '🧱', color: '#9b5de5' },
    { name: 'Auction desk', icon: '🔨', color: '#f15bb5' },
    { name: 'Risk & journal', icon: '🛡️', color: '#06d6a0' },
  ],
  office: [
    { name: 'Backtest lab', icon: '🧪', color: '#f15bb5' },
    { name: 'Backtest lab', icon: '🧪', color: '#f15bb5' },
    { name: 'Paper book', icon: '📒', color: '#06d6a0' },
    { name: 'Paper book', icon: '📒', color: '#06d6a0' },
  ],
};

/** The seats with a job on each floor, by desk number (1-based). Past these a seat is just a desk. */
const SEAT_JOBS: Record<FloorRole, string[]> = {
  bell: [
    'Vex · VWAP pullback', 'Vex · double break', 'Tape · NQ', 'Scout · news',
    'Zona · supply & demand', 'Ledge · support & resistance', 'Base · 5m structure', 'Gold desk · GC',
    'Auction · VAH / VAL', 'Auction · POC', 'Crypto desk · BTC', 'Profile · value area',
    'Bulwark · prop rules', 'Journal · trade review', 'Coach · psychology', 'Marshal · session chief',
  ],
  office: [
    'Quill · VWAP backtests', 'Quill · double break tests', 'Replay · zone & level tests', 'Replay · auction backtests',
    'Sweep · parameter tests', 'Sweep · walk-forward', 'Stats · expectancy', 'Stats · drawdown',
    'Ledger · paper NQ', 'Ledger · paper ES', 'Ledger · paper GC', 'Ledger · paper BTC',
    'Grader · process grade', 'Grader · eval simulator', 'Scribe · daily report', 'Scribe · lessons',
  ],
};

export function seatJob(role: FloorRole, deskId: string): string | undefined {
  const n = /^desk-(\d+)$/.exec(deskId)?.[1];
  return n ? SEAT_JOBS[role][Number(n) - 1] : undefined;
}

/** The pod a desk sits in (0..3), by its number. */
export function podOf(deskId: string): number | undefined {
  const n = /^desk-(\d+)$/.exec(deskId)?.[1];
  return n ? Math.floor((Number(n) - 1) / 4) : undefined;
}

// ---- The playbooks -----------------------------------------------------------------------------------

export type PlaybookId = 'vwap-pullback' | 'double-break' | 'supply-demand' | 'support-resistance' | 'failed-auction';

export interface PlaybookDef {
  id: PlaybookId;
  name: string;
  short: string;
  /** Where the idea came from: shown in a playbook's detail, not on the boards. */
  mentor: string;
  /** The desk agent who calls it. */
  agent: string;
  color: string;
  /** The rule of the setup in a line. */
  rule: string;
}

/** Abe's playbooks from Trade Pilot. */
export const PLAYBOOKS: PlaybookDef[] = [
  { id: 'vwap-pullback', name: 'VWAP Pullback in Trend', short: 'VWAP PB', mentor: 'Evan Dyer', agent: 'Vex', color: '#00bbf9', rule: 'Trend set, price comes back to NY VWAP, bounce candle with the trend. One attempt a session.' },
  { id: 'double-break', name: 'VWAP Double Break', short: 'DBL BRK', mentor: 'Evan Dyer', agent: 'Vex', color: '#4cc9f0', rule: '15-min opening range sets, then price breaks the range AND NY VWAP the same way. Enter the retest.' },
  { id: 'supply-demand', name: 'Supply & Demand Zones', short: 'S&D', mentor: 'Octavia', agent: 'Zona', color: '#9b5de5', rule: 'Fresh 5m zone off the basing candle. First retest only, rejection close, stop past the zone.' },
  { id: 'support-resistance', name: 'Support & Resistance', short: 'S/R', mentor: 'Trade Pilot', agent: 'Ledge', color: '#ffb703', rule: 'A level with 3+ touches (or yesterday’s and the overnight high and low). Bounce on a rejection candle, or break and retest. Stop past the level.' },
  { id: 'failed-auction', name: 'Failed Auction', short: 'AUCTION', mentor: 'Chanelle', agent: 'Auction', color: '#f15bb5', rule: 'Price pushed to VAL/VAH, auction stalls, a body closes back through the imbalance. Fixed stop, 1.5R.' },
];
export const PLAYBOOK_BY_ID = Object.fromEntries(PLAYBOOKS.map((p) => [p.id, p])) as Record<PlaybookId, PlaybookDef>;

// ---- Market data -------------------------------------------------------------------------------------

export interface Quote {
  symbol: Symbol;
  name: string;
  ink: string;
  decimals: number;
  tick: number;
  last: number;
  open: number;
  high: number;
  low: number;
  prevClose: number;
  change: number;
  changePct: number;
  /** When the price last changed at the source (ms). */
  updatedAt: number;
  /** Where it came from: "CME · Yahoo" or "Coinbase". */
  source: string;
  /** Provider of the displayed candles, independently of the last-price stream. */
  barSource?: string;
  /** No update from the source for a while (the market's closed, or the feed is down). */
  stale: boolean;
}

/** VIX, the dollar, the 10-year and oil: the backdrop the four markets trade against. */
export interface ContextQuote {
  id: string;
  label: string;
  last: number;
  changePct: number;
  decimals: number;
}

export interface Bar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Zone {
  kind: 'supply' | 'demand';
  top: number;
  bottom: number;
  /** When the basing candle printed. */
  at: number;
  state: 'fresh' | 'tested' | 'broken';
}

/** Everything the playbooks draw on the chart. */
export interface Levels {
  vwap: number | null;
  vwapU1: number | null;
  vwapL1: number | null;
  /** The overnight (Globex) VWAP, anchored at 15:00 PT the day before: Evan's bias. */
  onVwap: number | null;
  orHigh: number | null;
  orLow: number | null;
  onHigh: number | null;
  onLow: number | null;
  priorHigh: number | null;
  priorLow: number | null;
  /** The session's volume profile: Chanelle's fair value and its edges. */
  poc: number | null;
  vah: number | null;
  val: number | null;
  zones: Zone[];
  /** Support and resistance: prior day and overnight extremes, and 5m levels touched three times or more. */
  sr: { price: number; kind: 'support' | 'resistance'; touches: number; label: string }[];
}

export type Impact = 'high' | 'med' | 'low';

export interface NewsItem {
  id: string;
  /** Epoch ms. */
  at: number;
  /** Pacific wall clock, HH:MM, with the day when it isn't today. */
  time: string;
  headline: string;
  impact: Impact;
  symbols: Symbol[];
  kind: 'calendar' | 'headline';
  source: string;
  link?: string;
  forecast?: string;
  previous?: string;
  actual?: string;
}

// ---- Proposals, the paper book, backtests --------------------------------------------------------------

export type ProposalStage = 'off' | 'watching' | 'ready' | 'live' | 'won' | 'lost' | 'closed' | 'failed' | 'done';

/** One playbook's live read on one market. */
export interface Proposal {
  id: string;
  symbol: Symbol;
  playbook: PlaybookId;
  agent: string;
  side: 'long' | 'short' | null;
  stage: ProposalStage;
  title: string;
  /** Why: each condition the playbook checks, and whether it holds right now. */
  checks: { label: string; ok: boolean }[];
  entry: number | null;
  stop: number | null;
  target: number | null;
  r: number | null;
  /** How far the tape is from the entry, in points (positive: still to go). */
  distance: number | null;
  /** Micros per account at its Law-of-10 risk, keyed by account id. */
  sizing: { accountId: string; micros: number; risk: number }[];
  /** When it was triggered (the entry bar), while it's in a trade or after it resolved. */
  triggeredAt?: number | null;
  /** When it resolved (target, stop or closed flat). */
  endedAt?: number | null;
  /** When the office first saw it in this stage, for setups that have no trade yet (at the level, watching). */
  stageSince?: number | null;
  /** The person's own call on it: took it, skipped it, or nothing yet. */
  mark: 'taken' | 'skipped' | null;
  note: string;
  /** Timestamp of the last closed minute bar actually used to compute this proposal. */
  dataAt?: number;
  dataSource?: string;
}

/** What the indicators read on the bar a trade was entered on: what the Backtest Lab's filters ask of it. */
export interface TradeInd {
  /** Minutes since midnight Pacific. */
  m: number;
  /** The 9, 21 and 50 EMA on the 5-minute chart. */
  ema9: number | null;
  ema21: number | null;
  ema50: number | null;
  /** RSI(14), ADX(14) and the MACD histogram (12, 26, 9), all on the 5-minute chart. */
  rsi: number | null;
  adx: number | null;
  macd: number | null;
  /** The 5-minute ATR(14), in points. */
  atr: number | null;
  /** NY VWAP and the overnight VWAP. */
  vwap: number | null;
  onVwap: number | null;
  /** The signal bar's volume against the 20 one-minute bars before it (1 is average). */
  relVol: number | null;
}

export interface PaperTrade {
  id: string;
  day: string;
  symbol: Symbol;
  playbook: PlaybookId;
  side: 'long' | 'short';
  entryAt: number;
  entry: number;
  stop: number;
  target: number;
  exitAt: number | null;
  exit: number | null;
  outcome: 'open' | 'win' | 'loss' | 'time';
  /** Result in R, and in dollars for one micro. */
  r: number;
  dollars: number;
  why: string;
  taken?: boolean;
  /** The indicators on the entry bar (trades from before the lab kept them have none). */
  ind?: TradeInd;
  /** How it would have come out managed other ways (stop to breakeven, half off, trailed, added to), in R. */
  alt?: ManagedR;
  /** The furthest it went against and for the trade while open, in points, and when: what an account's equity did inside it. */
  mae?: number;
  mfe?: number;
  maeAt?: number;
  mfeAt?: number;
  /** One bar touched both its stop and its target: which came first is the fill policy's guess (see shared/fills.ts). */
  ambiguous?: boolean;
  /** A bar opened past its stop, so it lost more than one risk. */
  gapped?: boolean;
}

export interface PlaybookStats {
  playbook: PlaybookId;
  symbol: Symbol | 'ALL';
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgR: number;
  totalR: number;
  maxDrawdownR: number;
  /** Cumulative R after each trade, for the equity curve. */
  curve: number[];
  dollars: number;
}

/** How a playbook would have done on each prop account, sized by the Law of 10. */
export interface EvalRun {
  playbook: PlaybookId;
  accountId: string;
  result: 'passed' | 'busted' | 'running';
  days: number;
  pnl: number;
  peakCushion: number;
}

export interface BacktestSummary {
  /** Trading days replayed, oldest first. */
  days: string[];
  ranAt: number;
  running: boolean;
  stats: PlaybookStats[];
  evals: EvalRun[];
  /** The best playbook and market by expectancy, with enough trades to mean something. */
  best: { playbook: PlaybookId; symbol: Symbol; avgR: number; trades: number } | null;
  note: string;
  /** The playbook tuner: every version of the tuned playbooks, and what its last run tried. */
  tuner?: TunerView;
  /** Ways of mixing the tuned playbooks in a day (one first and another as the fallback, one for trending and one for ranging), best per trade first. */
  mixes?: PlanResult[];
}

/** The live eval as the boards show it (see server/trading/live-eval.ts). */
export interface LiveEvalView {
  accountId: string;
  firm: string;
  program: string;
  kind: 'eval' | 'funded';
  /** What it trades, in a line. */
  label: string;
  startDay: string;
  /** Every weekday since it started, oldest first. */
  days: string[];
  office: {
    result: 'passed' | 'busted' | 'running';
    days: number;
    pnl: number;
    target: number;
    cushion: number;
    drawdown: number;
    taken: number;
    today: number;
    todayTrades: number;
    /** Paper trades it's in right now (they count once they close). */
    openNow: number;
    why: string;
    /** Profit after each day (null: a day it hasn't reached yet). */
    series: (number | null)[];
  };
  /** The owner's own account over the same days: what it has made since the office started keeping count. */
  you: { accountId: string; name: string; pnl: number | null; today: number; since: string | null; series: (number | null)[] } | null;
}

/** How one game plan did over the backtest (see shared/dayplan.ts). */
export interface PlanResult {
  label: string;
  mode: 'every' | 'fallback' | 'by-day';
  order: PlaybookId[];
  trades: number;
  winRate: number;
  avgR: number;
  totalR: number;
  maxDrawdownR: number;
  /** On the later third of the days. */
  laterAvgR: number;
}

/** Every trade the last backtest took, for the Backtest Lab and the eval simulator to work through in the browser. */
export interface BacktestDetail {
  ranAt: number;
  /** Trading days replayed, oldest first (a day a playbook took nothing on is still a day). */
  days: string[];
  trades: PaperTrade[];
  /** The same days traded by each candidate version of a tuned playbook (`trades` has the live versions'). */
  versions?: { playbook: PlaybookId; version: number; trades: PaperTrade[] }[];
}

export interface PaperBook {
  today: PaperTrade[];
  /** The last few days, newest first. */
  recent: PaperTrade[];
  stats: PlaybookStats[];
  todayR: number;
  todayDollars: number;
}

// ---- Prop accounts ---------------------------------------------------------------------------------------

export interface PropRules {
  id: string;
  firm: string;
  program: string;
  size: number;
  profitTarget: number;
  drawdown: number;
  drawdownType: 'trailing-eod' | 'trailing-intraday' | 'static';
  /** Profit over the start at which the trailing threshold stops trailing (null: never). */
  lockProfit: number | null;
  dailyLossLimit: number | null;
  maxMicros: number;
  consistencyPercent: number;
  /** What the consistency rule measures the best day against: the profit target, or all the profit so far. */
  consistencyBasis: 'profitTarget' | 'totalProfit';
  minTradingDays: number;
  kind: 'eval' | 'funded';
}

/** The firms Abe is trying out, with the rules Trade Pilot keeps for them (verify at checkout: firms change them). */
export const PROP_ACCOUNTS: PropRules[] = [
  // LucidFlex: 40 and 60 micros, a floor that locks at $100 over the start, and no published minimum days
  // (two is the least its 50% consistency rule allows), as read on the firm's pages on 2 October 2026.
  // The 50K agrees with its rule set in shared/prop-rules.ts.
  { id: 'lucidflex-50k', firm: 'Lucid', program: 'LucidFlex 50K', size: 50_000, profitTarget: 3000, drawdown: 2000, drawdownType: 'trailing-eod', lockProfit: 100, dailyLossLimit: null, maxMicros: 40, consistencyPercent: 50, consistencyBasis: 'totalProfit', minTradingDays: 2, kind: 'eval' },
  { id: 'lucidflex-100k', firm: 'Lucid', program: 'LucidFlex 100K', size: 100_000, profitTarget: 6000, drawdown: 3000, drawdownType: 'trailing-eod', lockProfit: 100, dailyLossLimit: null, maxMicros: 60, consistencyPercent: 50, consistencyBasis: 'totalProfit', minTradingDays: 2, kind: 'eval' },
  { id: 'topstep-50k', firm: 'Topstep', program: 'Combine 50K', size: 50_000, profitTarget: 3000, drawdown: 2000, drawdownType: 'trailing-eod', lockProfit: 0, dailyLossLimit: null, maxMicros: 50, consistencyPercent: 50, consistencyBasis: 'profitTarget', minTradingDays: 2, kind: 'eval' },
  { id: 'tof-50k', firm: 'Top One', program: 'Ignite 50K (funded)', size: 50_000, profitTarget: 3000, drawdown: 2000, drawdownType: 'trailing-eod', lockProfit: 100, dailyLossLimit: null, maxMicros: 70, consistencyPercent: 15, consistencyBasis: 'totalProfit', minTradingDays: 5, kind: 'funded' },
  { id: 'apex-50k', firm: 'Apex', program: 'Apex 4.0 50K', size: 50_000, profitTarget: 3000, drawdown: 2500, drawdownType: 'trailing-intraday', lockProfit: 100, dailyLossLimit: null, maxMicros: 100, consistencyPercent: 50, consistencyBasis: 'totalProfit', minTradingDays: 8, kind: 'eval' },
];

/** Where one account stands today. */
export interface AccountState {
  rules: PropRules;
  /** Balance now (from ProjectX when connected, otherwise what was typed in). */
  balance: number;
  /** The balance the drawdown trails from. */
  peak: number;
  /** Where the account fails. */
  threshold: number;
  /** Drawdown left before the threshold. */
  cushion: number;
  /** The Law of 10: a tenth of the cushion. */
  riskPerTrade: number;
  toTarget: number;
  todayPnl: number;
  /** Losing trades today (from ProjectX, or what was logged by hand). */
  lossesToday: number;
  tradesToday: number;
  source: 'projectx' | 'manual';
  active: boolean;
}

export type GuardLevel = 'ok' | 'warn' | 'stop';

/** The risk guard's read on one account: may you take the next trade, and how big. */
export interface AccountGuard {
  accountId: string;
  level: GuardLevel;
  reasons: { label: string; level: GuardLevel }[];
  /** The most to risk on the next trade (Law of 10), or 0 when it says stop. */
  maxRisk: number;
  /** How much more you can lose today before your daily stop. */
  dailyStopLeft: number;
  /** The most one day can make without breaking the consistency rule, roughly (null: no rule). */
  dayCap: number | null;
}

/** The risk guard: the office's one answer to "can I take a trade right now?". */
export interface RiskGuard {
  level: GuardLevel;
  headline: string;
  reasons: { label: string; level: GuardLevel }[];
  /** A high-impact release close enough to matter, and when. */
  news: { title: string; at: number } | null;
  accounts: AccountGuard[];
}

/** The daily stop Abe trades by: three losses, or down two risks, and the day is over. */
export const DAILY_STOP = { losses: 3, risks: 2 } as const;

// ---- TradingView alerts, the journal ------------------------------------------------------------------------

export interface TvAlert {
  id: string;
  at: number;
  symbol: string;
  side: 'long' | 'short' | null;
  setup: string;
  price: number | null;
  message: string;
  /** Which playbook it rang for, when the setup names one. */
  playbook: PlaybookId | null;
  /** The alert's own plan, when the script sends one (the VWAP Double Break suite does). */
  stop?: number | null;
  target?: number | null;
  nyVwap?: number | null;
  /** The Pine version that sent it, when the script says (the Vault's versions do). */
  ver?: string | null;
}

export interface JournalTrade {
  id: string;
  accountId: string;
  symbol: string;
  side: 'long' | 'short';
  qty: number;
  entryAt: number;
  exitAt: number;
  entry: number;
  exit: number;
  pnl: number;
  /** The playbook whose paper trade it lines up with, if any. */
  playbook: PlaybookId | null;
}

export interface JournalInfo {
  connected: boolean;
  userName: string | null;
  error: string | null;
  accounts: { id: number; name: string; balance: number; canTrade: boolean }[];
  today: JournalTrade[];
  syncedAt: number | null;
}

// ---- The morning ---------------------------------------------------------------------------------------------

export interface PlaybookItem {
  id: string;
  label: string;
  owner: string;
  done: boolean;
  /** Worked out from the tape rather than ticked by hand. */
  auto: boolean;
}

/** The read on each market before the bell: which way, why, and which playbook fits the day. */
export interface Bias {
  symbol: Symbol;
  direction: 'long' | 'short' | 'neutral';
  lines: string[];
  fit: PlaybookId | null;
}

export interface SessionInfo {
  /** Pacific wall clock, HH:MM:SS. */
  time: string;
  day: string;
  minutes: number;
  phase: 'overnight' | 'premarket' | 'ORB' | 'morning' | 'midday' | 'close' | 'closed';
  weekend: boolean;
  nextBell: { kind: 'open' | 'close'; inSeconds: number };
  /** Seconds since the last bell rang, so every browser rings it once. */
  lastBell: { kind: 'open' | 'close'; at: number } | null;
}

export interface FeedStatus {
  id: string;
  name: string;
  ok: boolean;
  lastAt: number | null;
  note: string;
}

// ---- The Pine Vault ------------------------------------------------------------------------------------

/** Where a version of a Pine script stands. One is LIVE at a time; nothing goes live except when the owner says so. */
export type PineStatus = 'live' | 'candidate' | 'experiment' | 'retired';

/** The settings of the VWAP Double Break script that change its trades. */
export interface PineParams {
  /** Opening range, minutes from the 09:30 ET open. */
  orMinutes: number;
  /** Room past the far side of the range, in points. */
  stopBuffer: number;
  /** The most a micro may lose; the stop is pulled in to it. */
  maxLoss: number;
  /** The target as a multiple of the risk. */
  rMultiple: number;
  /** When a double break may fire, Eastern time, "HHMM-HHMM". */
  window: string;
  /** One re-entry after a stop (DB2). */
  recovery: boolean;
}

export interface PineMetrics {
  trades: number;
  wins: number;
  winRate: number;
  totalR: number;
  avgR: number;
  maxDrawdownR: number;
  /** How much one trade's result varies (standard deviation, in R): the noise any comparison has to beat. */
  stdR: number;
  profitFactor: number | null;
  /** For one micro contract. */
  dollars: number;
}

/** What replaying a version on real bars showed. Paper evidence, never a promise. */
export interface PineTest {
  ranAt: number;
  from: string;
  to: string;
  days: number;
  symbols: Symbol[];
  all: PineMetrics;
  /** The earlier two thirds of the days, then the later third the version wasn't chosen on. */
  inSample: PineMetrics;
  outSample: PineMetrics;
  bySymbol: Partial<Record<Symbol, PineMetrics>>;
  /**
   * The same replay under the office's realistic fill policy and after ordinary costs. Everything above is
   * Pine parity (gross, target before stop inside a bar), which is what TradingView shows; this is what an
   * order would have got. `ambiguous` counts the trades whose result rests on a guess inside one bar.
   */
  realistic?: { all: PineMetrics; ambiguous: number; policy: string; cost: string };
  params: PineParams;
  /** Against the version it was made from, when the lab made it. */
  vs: { version: string; dAvgR: number; dTotalR: number; verdict: 'better' | 'same' | 'worse' | 'unproven'; reason: string; /** How sure: the gap against the noise in this many trades. */ confidence: 'low' | 'medium' | 'high' } | null;
}

export interface PineVersionInfo {
  version: string;
  /** The day it was saved, Pacific (YYYY-MM-DD). */
  date: string;
  status: PineStatus;
  /** The version it was made from, so the history reads as a tree. */
  parent: string | null;
  changelog: string[];
  /** A short fingerprint of the exact source, so a stored version can't quietly change. */
  sha: string;
  lines: number;
  /** The stored file still matches its fingerprint. */
  intact: boolean;
  /** What replaying it on real bars showed, when that's been done. */
  test: PineTest | null;
  /** Made by the test lab and not looked at yet: the Strategy agent has news. */
  fresh: boolean;
  /** Who made it: the owner (saved or imported) or the test lab. */
  by: 'owner' | 'lab';
}

export interface PineScriptInfo {
  id: string;
  name: string;
  /** The office playbook this script is the TradingView version of, if it is one. */
  playbook: PlaybookId | null;
  summary: string;
  /** The rules the script encodes, in a line each: what "locked" means for it. */
  rules: string[];
  /** Newest first. */
  versions: PineVersionInfo[];
}

/** What one run of the test lab did, so there is never any doubt that it ran and what it tried. */
export interface LabReport {
  ranAt: number;
  /** How long it took, in milliseconds. */
  took: number;
  script: string;
  scriptName: string;
  /** The live version that was replayed as the baseline. */
  version: string;
  days: number;
  from: string;
  to: string;
  symbols: Symbol[];
  /** Bars it loaded per market. */
  bars: Partial<Record<Symbol, number>>;
  baseline: { trades: number; avgR: number; totalR: number };
  /** Every change it tried, with the verdict. */
  tried: { change: string[]; trades: number; avgR: number; verdict: 'better' | 'same' | 'worse' | 'unproven'; confidence: 'low' | 'medium' | 'high'; reason: string }[];
  /** The version it saved from this run, if one held up. */
  saved: string | null;
  /** A change that held up but was already saved from an earlier run, and as which version. */
  existing: string | null;
  /** The change that held up, in words, when one did. */
  best: string[] | null;
  /** The other saved versions it re-tested. */
  retested: string[];
}

export interface VaultView {
  scripts: PineScriptInfo[];
  /** The test lab that replays the live version and tries changes to it. */
  lab: {
    ranAt: number | null;
    running: boolean;
    note: string;
    /** What it's doing right now, while it runs. */
    stage: string;
    /** The last run, in full. */
    report: LabReport | null;
  };
}

export interface TradingSnapshot {
  at: number;
  feeds: FeedStatus[];
  /** Every price on the boards is real; when the feeds haven't answered yet there's nothing to show. */
  ready: boolean;
  quotes: Quote[];
  context: ContextQuote[];
  levels: Record<Symbol, Levels>;
  bars: Record<Symbol, Bar[]>;
  news: NewsItem[];
  proposals: Proposal[];
  paper: PaperBook;
  backtest: BacktestSummary | null;
  /** The eval being run forward day by day on the paper book, beside the owner's own result (null: none running). */
  liveEval?: LiveEvalView | null;
  /** The prop farm being run forward on the paper book (null: none). */
  farm?: FarmView | null;
  playbook: PlaybookItem[];
  bias: Bias[];
  accounts: AccountState[];
  alerts: TvAlert[];
  journal: JournalInfo;
  projectXMarketEnabled?: boolean;
  session: SessionInfo;
  /** The TradingView webhook: where to point an alert, and the key it needs. */
  webhook: { path: string; key: string };
  tradePilot: { url: string | null; forwarding: boolean };
  guard: RiskGuard;
  /** The markets the proposals cover (the rest still tick along on the market board). */
  markets: Symbol[];
  /** The Pine scripts the office keeps, with their versions (never their source). */
  vault: VaultView;
}

export type ProposalAction = 'take' | 'skip' | 'reset';

/** Law of 10: risk a tenth of the drawdown left, rounded down to the dollar. */
export function lawOf10(cushion: number): number {
  return Math.max(0, Math.floor(cushion / 10));
}

/** Micros that fit a risk budget for a stop this many points away. */
export function microsFor(symbol: Symbol, riskDollars: number, stopPoints: number, maxMicros = Infinity): number {
  const perMicro = Math.abs(stopPoints) * INSTRUMENTS[symbol].microPointValue;
  if (!(perMicro > 0)) return 0;
  return Math.max(0, Math.min(maxMicros, Math.floor(riskDollars / perMicro)));
}
