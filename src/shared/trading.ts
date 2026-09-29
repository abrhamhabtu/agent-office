// The trading floors: what the server's market desk sends and what the boards, screens and laptops draw.
// Shared by src/server/trading/* (which makes it) and src/client/trading/* (which paints it).
//
// Two floors: 🔔 Opening Bell, where the morning is run live (news, proposals off the three playbooks,
// the prop accounts, the journal), and 🗄️ Back Office, where every setup is proved first: a backtest pod
// and a paper pod. Prices are real (CME futures and Bitcoin); nothing here can place an order.

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
  /** The person's own call on it: took it, skipped it, or nothing yet. */
  mark: 'taken' | 'skipped' | null;
  note: string;
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
  { id: 'lucidflex-50k', firm: 'Lucid', program: 'LucidFlex 50K', size: 50_000, profitTarget: 3000, drawdown: 2000, drawdownType: 'trailing-eod', lockProfit: 0, dailyLossLimit: null, maxMicros: 50, consistencyPercent: 50, consistencyBasis: 'totalProfit', minTradingDays: 5, kind: 'eval' },
  { id: 'lucidflex-100k', firm: 'Lucid', program: 'LucidFlex 100K', size: 100_000, profitTarget: 6000, drawdown: 3000, drawdownType: 'trailing-eod', lockProfit: 0, dailyLossLimit: null, maxMicros: 100, consistencyPercent: 50, consistencyBasis: 'totalProfit', minTradingDays: 5, kind: 'eval' },
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
  playbook: PlaybookItem[];
  bias: Bias[];
  accounts: AccountState[];
  alerts: TvAlert[];
  journal: JournalInfo;
  session: SessionInfo;
  /** The TradingView webhook: where to point an alert, and the key it needs. */
  webhook: { path: string; key: string };
  tradePilot: { url: string | null; forwarding: boolean };
  guard: RiskGuard;
  /** The markets the proposals cover (the rest still tick along on the market board). */
  markets: Symbol[];
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
