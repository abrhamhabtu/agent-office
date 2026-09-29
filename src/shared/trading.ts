// The trading floors: what the server's market desk sends and what the boards, screens and laptops draw.
// Shared by src/server/trading.ts (which makes it) and src/client/trading/* (which paints it).

export const SYMBOLS = ['MNQ', 'MES', 'MBT', 'BTC'] as const;
export type Symbol = (typeof SYMBOLS)[number];

/** The two floors: the paper floor where ideas are proven, and the desk where a graduated one is ticketed. */
export type FloorRole = 'pit' | 'desk';

/** Which trading floor a floor is by its name ("The Desk" is the live-ticket floor; every other floor is a pit). */
export function floorRole(name: string | undefined): FloorRole {
  return /\bdesk\b/i.test(name ?? '') ? 'desk' : 'pit';
}

export interface Quote {
  symbol: Symbol;
  name: string;
  ink: string;
  decimals: number;
  tick: number;
  last: number;
  bid: number;
  ask: number;
  open: number;
  high: number;
  low: number;
  prevClose: number;
  change: number;
  changePct: number;
}

export interface Bar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** VWAP with its bands, the opening range and the extremes the day is drawn against. */
export interface Levels {
  vwap: number;
  vwapU1: number;
  vwapL1: number;
  vwapU2: number;
  vwapL2: number;
  orHigh: number | null;
  orLow: number | null;
  onHigh: number | null;
  onLow: number | null;
  priorHigh: number | null;
  priorLow: number | null;
}

export type Impact = 'high' | 'med' | 'low';

export interface NewsItem {
  id: string;
  /** Minutes since midnight Pacific, so the board can order and dim what's passed. */
  at: number;
  time: string;
  headline: string;
  impact: Impact;
  symbols: Symbol[];
  kind: 'calendar' | 'headline';
}

export type ProposalStage = 'watching' | 'ready' | 'paper' | 'graduated' | 'skipped';

/** A setup as a card: one strategy's read on one contract. */
export interface Proposal {
  id: string;
  symbol: Symbol;
  strategy: 'VWAP' | 'S/R';
  agent: string;
  side: 'long' | 'short';
  title: string;
  entry: number;
  stop: number;
  target: number;
  /** Reward over risk. */
  r: number;
  stage: ProposalStage;
}

/** What Bulwark says about a graduated setup, and what Tick would have you click at the broker. */
export interface Ticket {
  proposalId: string;
  symbol: Symbol;
  side: 'long' | 'short';
  contracts: number;
  entry: number;
  stop: number;
  target: number;
  riskDollars: number;
  rewardDollars: number;
  /** Every rule Bulwark checked, and whether it passed. */
  checks: { label: string; ok: boolean }[];
  cleared: boolean;
}

export interface PlaybookItem {
  id: string;
  label: string;
  owner: string;
  done: boolean;
}

export interface ConnectorInfo {
  id: string;
  name: string;
  status: 'live' | 'sample' | 'stub' | 'locked' | 'off';
  note: string;
}

export interface SessionInfo {
  /** Pacific wall clock, HH:MM. */
  time: string;
  minutes: number;
  phase: 'premarket' | 'ORB' | 'open' | 'post' | 'closed';
  weekend: boolean;
  /** The next bell: what it is, and how many seconds away. */
  nextBell: { kind: 'open' | 'close'; inSeconds: number };
}

export interface AccountInfo {
  name: string;
  dailyLossLimit: number;
  dailyLossUsed: number;
  trailingDrawdown: number;
  trailingUsed: number;
  paperPnl: number;
  armed: boolean;
}

export interface TradingSnapshot {
  at: number;
  /** Where the prices come from. "sample" is a deterministic simulation, not a market. */
  source: 'sample' | 'live';
  quotes: Quote[];
  levels: Record<Symbol, Levels>;
  bars: Record<Symbol, Bar[]>;
  news: NewsItem[];
  proposals: Proposal[];
  tickets: Ticket[];
  playbook: PlaybookItem[];
  connectors: ConnectorInfo[];
  session: SessionInfo;
  account: AccountInfo;
}

export type ProposalAction = 'paper' | 'graduate' | 'skip' | 'reset';

/** The desks the trading floors seat, in the order the hire menu fills them. */
export const TRADING_DESKS: { name: string; role: string; color: string; floor: FloorRole | 'both' }[] = [
  { name: 'Marshal', role: 'Session chief', color: '#ffd166', floor: 'both' },
  { name: 'Scout', role: 'Tape & news', color: '#4ecdc4', floor: 'pit' },
  { name: 'Vex', role: 'VWAP', color: '#00bbf9', floor: 'pit' },
  { name: 'Ledge', role: 'Support & resistance', color: '#9b5de5', floor: 'pit' },
  { name: 'Ledger', role: 'Paper book & grade', color: '#06d6a0', floor: 'pit' },
  { name: 'Quill', role: 'Backtests', color: '#f15bb5', floor: 'pit' },
  { name: 'Bulwark', role: 'Prop-firm rules', color: '#ef476f', floor: 'desk' },
  { name: 'Tick', role: 'Trade tickets', color: '#fb8500', floor: 'desk' },
];
