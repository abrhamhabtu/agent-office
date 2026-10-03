// The Arena: named traders racing each other on paper, a futures league and a crypto league.
//
// The idea is beebots' (github.com/imikerussell/beebots, MIT): a trader is a character with rules, every
// decision is a pick from a menu of moves that are valid right now, and plain code can veto, shrink or
// force the pick. What is different here is the race. A futures trader runs a prop evaluation, so what
// matters is the floor behind and the target ahead, and sitting out is a legal move. A crypto trader runs
// a small bankroll around the clock.
//
// This file is the whole engine and touches nothing else in the office but the bar type and the prop
// rules: the tape's indicators, the three engines' menus, the house brain, the risk desk, the account.
// The server (server/trading/arena.ts) feeds it bars and asks a brain; the console draws what it returns.
// Everything is paper. Nothing here can place an order.

import { PLAYBOOKS, type Bar, type PlaybookId, type PropRules } from './trading.js';

export type League = 'futures' | 'crypto';
/** The three engines a coin runs on. A futures trader runs on one of the office's own playbooks instead. */
export type StyleId = 'breakout' | 'trend' | 'reversion';
export type EngineId = StyleId | PlaybookId;
export type Side = 'long' | 'short';

const STYLES: Record<StyleId, { name: string; short: string; color: string; blurb: string }> = {
  breakout: { name: 'Breakout', short: 'BREAK', color: '#f4a52e', blurb: 'Waits for price to leave a range and goes with it.' },
  trend: { name: 'Trend', short: 'PULLBACK', color: '#8b7cf6', blurb: 'Buys pullbacks in an uptrend, sells them in a downtrend.' },
  reversion: { name: 'Reversion', short: 'FADE', color: '#ec5f8f', blurb: 'Fades a stretch away from VWAP back toward it.' },
};
export const ENGINES = {
  ...STYLES,
  ...Object.fromEntries(PLAYBOOKS.map((p) => [p.id, { name: p.name, short: p.short.replace(/[^A-Z]+/g, '_'), color: p.color, blurb: p.rule }])),
} as Record<EngineId, { name: string; short: string; color: string; blurb: string }>;
const STYLE_IDS = Object.keys(STYLES) as StyleId[];
const isStyle = (e: EngineId): e is StyleId => e in STYLES;
/** The engines a league's traders run on: the office's playbooks for futures, the three styles for crypto. */
export const enginesOf = (league: League): EngineId[] => (league === 'futures' ? PLAYBOOKS.map((p) => p.id) : STYLE_IDS);
export const isEngine = (league: League, e: unknown): e is EngineId => enginesOf(league).includes(e as EngineId);

export interface MarketSpec {
  id: string;
  name: string;
  league: League;
  /** Dollars one unit makes when price moves 1.0: a micro contract's point value, or 1 for a coin. */
  pointValue: number;
  tick: number;
  decimals: number;
  /** What a unit is called. */
  unit: string;
}

export const MARKETS: MarketSpec[] = [
  { id: 'NQ', name: 'Nasdaq-100', league: 'futures', pointValue: 2, tick: 0.25, decimals: 2, unit: 'MNQ' },
  { id: 'ES', name: 'S&P 500', league: 'futures', pointValue: 5, tick: 0.25, decimals: 2, unit: 'MES' },
  { id: 'GC', name: 'Gold', league: 'futures', pointValue: 10, tick: 0.1, decimals: 1, unit: 'MGC' },
  { id: 'BTC', name: 'Bitcoin', league: 'crypto', pointValue: 1, tick: 0.01, decimals: 0, unit: 'BTC' },
  { id: 'ETH', name: 'Ethereum', league: 'crypto', pointValue: 1, tick: 0.01, decimals: 1, unit: 'ETH' },
  { id: 'SOL', name: 'Solana', league: 'crypto', pointValue: 1, tick: 0.01, decimals: 2, unit: 'SOL' },
];
export const MARKET_BY_ID = Object.fromEntries(MARKETS.map((m) => [m.id, m])) as Record<string, MarketSpec>;
export const marketsOf = (league: League) => MARKETS.filter((m) => m.league === league).map((m) => m.id);

// ---- The rules of each league ---------------------------------------------------------------------------

export interface LeagueRules {
  league: League;
  /** What the account is, in a line. */
  label: string;
  start: number;
  /** Futures: the evaluation's profit target. Crypto has none. */
  target: number | null;
  /** Futures: how far the floor trails the best end-of-day balance. Crypto: the loss that retires a trader. */
  drawdown: number;
  /** Futures: once the floor reaches start + this, it stops moving. */
  lockProfit: number;
  maxUnits: number;
  minDays: number;
  /** The best day may be at most this share of the profit when the target is reached (null: no such rule). */
  consistency: number | null;
  /** Share of the cushion (futures) or of equity (crypto) one trade may risk. */
  riskFrac: number;
  tradeCap: number;
  /** Losing trades in a day that send a trader home. */
  lossStop: number;
  /** Share of the day's starting cushion (futures) or equity (crypto) that, lost, sends a trader home. */
  dayLossFrac: number;
  /** Crypto: the most notional, as a multiple of equity. */
  leverage: number;
  /** Futures: dollars a unit a side. Crypto: share of notional a side. */
  fee: number;
  /** Bars after an order before the next. */
  cooldownBars: number;
}

/** The futures league runs this evaluation: the office's own rule sheet for it, so the two never disagree. */
export function futuresRules(p: PropRules): LeagueRules {
  return {
    league: 'futures',
    label: `${p.firm} ${p.program} evaluation`,
    start: p.size,
    target: p.profitTarget,
    drawdown: p.drawdown,
    lockProfit: p.lockProfit ?? 0,
    maxUnits: p.maxMicros,
    minDays: p.minTradingDays,
    consistency: p.consistencyPercent ? p.consistencyPercent / 100 : null,
    riskFrac: 0.12,
    tradeCap: 3,
    lossStop: 2,
    dayLossFrac: 0.3,
    leverage: 0,
    fee: 0.62,
    cooldownBars: 5,
  };
}

export const CRYPTO_RULES: LeagueRules = {
  league: 'crypto',
  label: '$1,000 paper bankroll, 2x at most',
  start: 1000,
  target: null,
  drawdown: 400,
  lockProfit: 0,
  maxUnits: Infinity,
  minDays: 0,
  consistency: null,
  riskFrac: 0.01,
  tradeCap: 6,
  lossStop: 3,
  dayLossFrac: 0.03,
  leverage: 2,
  fee: 0.0005,
  cooldownBars: 10,
};

// ---- The tape: what a market looks like at a bar's close ------------------------------------------------

export interface MarketView {
  market: string;
  ts: number;
  last: number;
  prevClose: number;
  barHigh: number;
  barLow: number;
  /** The session's open, and how many of its bars have closed. */
  open: number;
  bars: number;
  vwap: number;
  /** The volume-weighted spread of price around VWAP. */
  sd: number;
  ema9: number;
  ema21: number;
  ema50: number;
  /** A five-minute bar's typical range, worked out from the minute bars. */
  atr: number;
  rsi: number;
  /** The first fifteen minutes' range (null until it is set). */
  orHigh: number | null;
  orLow: number | null;
  /** The highest high and lowest low of the two hours before this bar. */
  donHigh: number;
  donLow: number;
}

const OR_BARS = 15;
const DON_BARS = 120;

/** One market's indicators, fed a closed minute bar at a time. Nothing in it looks ahead. */
export class Tape {
  private n = 0;
  private sessionBars = 0;
  private open = 0;
  private pv = 0;
  private pv2 = 0;
  private vol = 0;
  private e9 = 0;
  private e21 = 0;
  private e50 = 0;
  private tr = 0;
  private gain = 0;
  private loss = 0;
  private prev = 0;
  private orHigh: number | null = null;
  private orLow: number | null = null;
  private highs: number[] = [];
  private lows: number[] = [];
  private last: MarketView | null = null;

  constructor(readonly market: string) {}

  /** `fresh`: this bar opens a new session (VWAP and the opening range start over). */
  push(bar: Bar, fresh: boolean): MarketView {
    const donHigh = this.highs.length ? Math.max(...this.highs) : bar.high;
    const donLow = this.lows.length ? Math.min(...this.lows) : bar.low;
    if (fresh || !this.n) {
      this.sessionBars = 0;
      this.open = bar.open;
      this.pv = this.pv2 = this.vol = 0;
      this.orHigh = this.orLow = null;
    }
    const prev = this.n ? this.prev : bar.open;
    const typical = (bar.high + bar.low + bar.close) / 3;
    const v = Math.max(bar.volume, 1);
    this.pv += typical * v;
    this.pv2 += typical * typical * v;
    this.vol += v;
    const ema = (old: number, len: number) => (this.n ? old + (2 / (len + 1)) * (bar.close - old) : bar.close);
    this.e9 = ema(this.e9, 9);
    this.e21 = ema(this.e21, 21);
    this.e50 = ema(this.e50, 50);
    const range = Math.max(bar.high - bar.low, Math.abs(bar.high - prev), Math.abs(bar.low - prev));
    this.tr = this.n ? this.tr + (range - this.tr) / 70 : range;
    const change = bar.close - prev;
    this.gain += (Math.max(change, 0) - this.gain) / 21;
    this.loss += (Math.max(-change, 0) - this.loss) / 21;
    this.sessionBars++;
    if (this.sessionBars <= OR_BARS) {
      this.orHigh = Math.max(this.orHigh ?? bar.high, bar.high);
      this.orLow = Math.min(this.orLow ?? bar.low, bar.low);
    }
    this.highs.push(bar.high);
    this.lows.push(bar.low);
    if (this.highs.length > DON_BARS) {
      this.highs.shift();
      this.lows.shift();
    }
    this.n++;
    this.prev = bar.close;
    const vwap = this.pv / this.vol;
    this.last = {
      market: this.market,
      ts: bar.ts,
      last: bar.close,
      prevClose: prev,
      barHigh: bar.high,
      barLow: bar.low,
      open: this.open,
      bars: this.sessionBars,
      vwap,
      sd: Math.sqrt(Math.max(0, this.pv2 / this.vol - vwap * vwap)),
      ema9: this.e9,
      ema21: this.e21,
      ema50: this.e50,
      // A five-minute range is about √5 of a one-minute one.
      atr: this.tr * 2.24,
      rsi: this.gain + this.loss === 0 ? 50 : (100 * this.gain) / (this.gain + this.loss),
      orHigh: this.sessionBars >= OR_BARS ? this.orHigh : null,
      orLow: this.sessionBars >= OR_BARS ? this.orLow : null,
      donHigh,
      donLow,
    };
    return this.last;
  }

  view(): MarketView | null {
    return this.last;
  }

  /** Enough bars behind it for the slow average to mean something. */
  get warm(): boolean {
    return this.n >= 60;
  }
}

// ---- Traders -------------------------------------------------------------------------------------------

export interface TraderDef {
  id: string;
  league: League;
  name: string;
  tagline: string;
  engine: EngineId;
  color: string;
  /** The markets it may trade (never empty). */
  markets: string[];
  /** The owner's rules in plain English: the parts code can enforce are enforced, all of it goes to the brain. */
  rules: string;
  /** The sentence it was designed from. */
  prompt: string;
  /** How readily it sits out: 0 eager, 1 patient. */
  patience: number;
  createdAt: number;
}

export interface Position {
  market: string;
  side: Side;
  qty: number;
  entry: number;
  stop: number;
  target: number | null;
  /** Dollars at risk as sized: 1R. */
  risk: number;
  openedAt: number;
  label: string;
  banked: boolean;
}

export type Cap = 'trade_cap' | 'loss_stop' | 'session_over';

export interface ClosedTrade {
  market: string;
  side: Side;
  qty: number;
  entry: number;
  exit: number;
  pnl: number;
  r: number;
  at: number;
  why: string;
}

/** What the brain said the last time it was asked, or why it wasn't. */
export interface LastCall {
  ts: number;
  pick: string;
  probs: [string, number][];
  by: 'brain' | 'rules' | 'risk';
  note: string;
  ms: number;
  model: string;
}

export interface TraderState {
  def: TraderDef;
  /** Which account this is for this trader: 1 for the first, one more after every pass or bust. */
  gen: number;
  /** Realised balance, its best end of day, and the line that ends the account. */
  balance: number;
  peak: number;
  floor: number;
  equity: number;
  upl: number;
  pos: Position | null;
  day: string;
  dayStart: number;
  /** The cushion (or equity) the day began with: what the day's loss limit is measured on. */
  dayCushion: number;
  tradesToday: number;
  lossesToday: number;
  cap: Cap | null;
  lastOrderAt: number;
  /** Finished sessions' results on this account, oldest first. */
  days: number[];
  passes: number;
  busts: number;
  status: string;
  last: LastCall | null;
  /** Equity less the account's start, a point per step (thinned as it grows). */
  curve: [number, number][];
  trades: ClosedTrade[];
  totals: { fees: number; decisions: number; asked: number; orders: number; wins: number; losses: number; realised: number; brainUsd: number };
  /** Who wrote the rules in force, and what they replaced (newest last) so a rewrite can be undone. */
  rulesBy: 'owner' | 'coach';
  rulesBefore: string[];
  /** Sessions since the rules last changed. */
  rulesAge: number;
}

export function newTrader(def: TraderDef, rules: LeagueRules): TraderState {
  return {
    def,
    gen: 1,
    balance: rules.start,
    peak: rules.start,
    floor: rules.start - rules.drawdown,
    equity: rules.start,
    upl: 0,
    pos: null,
    day: '',
    dayStart: rules.start,
    dayCushion: rules.league === 'futures' ? rules.drawdown : rules.start,
    tradesToday: 0,
    lossesToday: 0,
    cap: null,
    lastOrderAt: 0,
    days: [],
    passes: 0,
    busts: 0,
    status: 'Waiting for the tape',
    last: null,
    curve: [],
    trades: [],
    totals: { fees: 0, decisions: 0, asked: 0, orders: 0, wins: 0, losses: 0, realised: 0, brainUsd: 0 },
    rulesBy: 'owner',
    rulesBefore: [],
    rulesAge: 0,
  };
}

// ---- The owner's rules, as far as code can hold a trader to them ----------------------------------------

export interface HardRules {
  side: Side | null;
  maxTrades: number | null;
  /** Futures: no entry before this many minutes into the session, or after this clock minute (Pacific). */
  waitMinutes: number;
  lastEntry: number | null;
}

/** The parts of a trader's rules that are enforced whoever the brain is. The rest steers the brain only. */
export function parseRules(text: string): HardRules {
  const t = text.toLowerCase();
  const longOnly = /\b(longs? only|only (?:go(?:es)? )?long|never shorts?|buys? only|only buys?)\b/.test(t);
  const shortOnly = /\b(shorts? only|only (?:go(?:es)? )?short|never (?:goes? )?longs?|sells? only|only sells?)\b/.test(t);
  const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
  const cap = /\b(\d|one|two|three|four|five|six) (?:trades?|attempts?|shots?) (?:a|per) (?:day|session)\b/.exec(t);
  const wait = /\b(?:after|nothing in|not in|skips?) the first (\d+ minutes|half hour|hour)\b/.exec(t);
  const until = /\b(?:no (?:new )?(?:entries|trades) after|(?:done|flat|stops?) by|before) (\d{1,2})(?::(\d{2}))?\b/.exec(t);
  return {
    side: longOnly && !shortOnly ? 'long' : shortOnly && !longOnly ? 'short' : null,
    maxTrades: cap ? (words[cap[1]!] ?? Number(cap[1])) : /\bone and done\b/.test(t) ? 1 : null,
    waitMinutes: wait ? (wait[1] === 'hour' ? 60 : wait[1] === 'half hour' ? 30 : parseInt(wait[1]!, 10)) : 0,
    lastEntry: until ? Number(until[1]) * 60 + Number(until[2] ?? 0) : /\bmorning only\b/.test(t) ? 9 * 60 : null,
  };
}

// ---- The menu: the moves that are valid right now --------------------------------------------------------

export type Intent =
  | { kind: 'pass' }
  | { kind: 'hold' }
  | { kind: 'open'; market: string; side: Side; stop: number; target: number | null }
  | { kind: 'close'; why: string }
  | { kind: 'breakeven' }
  | { kind: 'bank' };

export interface MenuOption {
  label: string;
  desc: string;
  intent: Intent;
  /** The engine's own read of the move, 0 to 1: what the house brain weighs. */
  score: number;
}

export interface Menu {
  options: MenuOption[];
  /** What the trader is doing when there is nothing to choose. */
  idle: string;
}

/** A setup one of the office's playbooks called on this bar: where its stop and target go is the playbook's. */
export interface Signal {
  engine: PlaybookId;
  market: string;
  side: Side;
  stop: number;
  target: number;
  why: string;
}

/** What the engine needs to know about the moment. */
export interface Moment {
  league: League;
  ts: number;
  day: string;
  /** Minutes on the session's clock: Pacific for futures (the session runs 390 to 780), UTC for crypto. */
  minute: number;
  /** New positions may be opened now. */
  canEnter: boolean;
  /** The session is ending: anything open is closed. */
  mustFlatten: boolean;
  sessionOpen: number;
  /** The playbooks' setups on this bar (futures). */
  signals?: Signal[];
}

const px = (m: string, v: number) => v.toFixed(MARKET_BY_ID[m]?.decimals ?? 2);
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const dirOf = (s: Side) => (s === 'long' ? 1 : -1);

/** R made or lost on an open position at a price. */
export function openR(p: Position, last: number): number {
  // Against the risk as sized, not the stop where it is now: a stop moved to the entry would make every R infinite.
  return p.risk ? ((last - p.entry) * dirOf(p.side) * p.qty * MARKET_BY_ID[p.market]!.pointValue) / p.risk : 0;
}

/**
 * The nearest a stop may sit. A coin's has to be far enough that the fee on the way in and out is a small
 * part of the risk: at 0.05% a side, a stop 0.4% away makes the round trip a quarter of one risk.
 */
const minStop = (v: MarketView) => Math.max(v.atr * 0.8, MARKET_BY_ID[v.market]!.tick * 4, MARKET_BY_ID[v.market]!.league === 'crypto' ? v.last * 0.004 : 0);

function entry(engine: string, v: MarketView, side: Side, stopDist: number, target: number | null, score: number, desc: string): MenuOption {
  const d = Math.max(stopDist, minStop(v));
  const stop = v.last - dirOf(side) * d;
  return { label: `${engine}_${side.toUpperCase()}_${v.market}`, desc, score: clamp01(score), intent: { kind: 'open', market: v.market, side, stop, target: target ?? v.last + dirOf(side) * d * 2 } };
}

function breakoutSetups(v: MarketView, league: League): MenuOption[] {
  const out: MenuOption[] = [];
  // Futures break the opening range; a coin, with no opening bell, breaks its last two hours.
  const hi = league === 'futures' ? v.orHigh : v.donHigh;
  const lo = league === 'futures' ? v.orLow : v.donLow;
  if (hi == null || lo == null || hi - lo < v.atr * 0.5) return out;
  const what = league === 'futures' ? 'opening range' : 'two-hour range';
  const mid = (hi + lo) / 2;
  if (v.prevClose <= hi && v.last > hi) out.push(entry('BREAK', v, 'long', Math.min(v.last - mid, v.atr * 1.5), null, 0.55 + (v.ema9 > v.ema21 ? 0.15 : -0.1) + (v.last > v.vwap ? 0.1 : -0.1), `closed above the ${what} high ${px(v.market, hi)}`));
  if (v.prevClose >= lo && v.last < lo) out.push(entry('BREAK', v, 'short', Math.min(mid - v.last, v.atr * 1.5), null, 0.55 + (v.ema9 < v.ema21 ? 0.15 : -0.1) + (v.last < v.vwap ? 0.1 : -0.1), `closed below the ${what} low ${px(v.market, lo)}`));
  return out;
}

function trendSetups(v: MarketView): MenuOption[] {
  const up = v.ema9 > v.ema21 && v.ema21 > v.ema50 && v.last > v.vwap;
  const down = v.ema9 < v.ema21 && v.ema21 < v.ema50 && v.last < v.vwap;
  const spread = Math.abs(v.ema21 - v.ema50) / (v.atr || 1);
  if (up && v.barLow <= v.ema21 && v.last > v.ema9 && v.last > v.prevClose) return [entry('PULLBACK', v, 'long', v.last - Math.min(v.barLow, v.ema21) + v.atr * 0.4, null, 0.5 + Math.min(0.3, spread * 0.25), `uptrend, dipped to the 21 EMA ${px(v.market, v.ema21)} and closed back up`)];
  if (down && v.barHigh >= v.ema21 && v.last < v.ema9 && v.last < v.prevClose) return [entry('PULLBACK', v, 'short', Math.max(v.barHigh, v.ema21) - v.last + v.atr * 0.4, null, 0.5 + Math.min(0.3, spread * 0.25), `downtrend, popped to the 21 EMA ${px(v.market, v.ema21)} and closed back down`)];
  return [];
}

function reversionSetups(v: MarketView): MenuOption[] {
  if (v.sd <= 0 || v.bars < 30) return [];
  const z = (v.last - v.vwap) / v.sd;
  const stopDist = Math.max(v.atr * 1.2, minStop(v));
  // The trip back to VWAP has to pay at least what the stop risks.
  if (Math.abs(v.last - v.vwap) < stopDist) return [];
  if (z > 2 && v.rsi > 66) return [entry('FADE', v, 'short', stopDist, v.vwap, 0.45 + Math.min(0.35, (z - 2) * 0.25), `${z.toFixed(1)} deviations above VWAP, RSI ${v.rsi.toFixed(0)}`)];
  if (z < -2 && v.rsi < 34) return [entry('FADE', v, 'long', stopDist, v.vwap, 0.45 + Math.min(0.35, (-z - 2) * 0.25), `${(-z).toFixed(1)} deviations below VWAP, RSI ${v.rsi.toFixed(0)}`)];
  return [];
}

/** A playbook's setups on this bar, as moves: the stop and the target are the playbook's own. */
function called(engine: PlaybookId, mine: MarketView[], signals: Signal[]): MenuOption[] {
  return signals.flatMap((sig) => {
    const v = mine.find((x) => x.market === sig.market);
    if (sig.engine !== engine || !v) return [];
    const d = dirOf(sig.side);
    // A setup whose stop the close has already passed is gone.
    if ((v.last - sig.stop) * d < MARKET_BY_ID[v.market]!.tick * 2) return [];
    const withTape = sig.side === 'long' ? v.ema9 >= v.ema21 : v.ema9 <= v.ema21;
    return [{ label: `${ENGINES[engine].short}_${sig.side.toUpperCase()}_${v.market}`, desc: sig.why, score: 0.6 + (withTape ? 0.08 : -0.08), intent: { kind: 'open' as const, market: v.market, side: sig.side, stop: sig.stop, target: sig.target } }];
  });
}

/** How far the nearest setup is, for a trader with nothing to choose. */
function watching(engine: EngineId, v: MarketView, league: League): string {
  if (!isStyle(engine)) return `Waiting for a ${ENGINES[engine].name} setup`;
  if (engine === 'breakout') {
    const hi = league === 'futures' ? v.orHigh : v.donHigh;
    const lo = league === 'futures' ? v.orLow : v.donLow;
    if (hi == null || lo == null) return `${v.market}: the opening range is still forming`;
    const toHi = hi - v.last;
    const toLo = v.last - lo;
    return toHi < toLo ? `${v.market} is ${px(v.market, Math.max(0, toHi))} under the range high` : `${v.market} is ${px(v.market, Math.max(0, toLo))} over the range low`;
  }
  if (engine === 'trend') {
    const up = v.ema9 > v.ema21 && v.ema21 > v.ema50;
    const down = v.ema9 < v.ema21 && v.ema21 < v.ema50;
    return up || down ? `${v.market} ${up ? 'uptrend' : 'downtrend'}: waiting for a pullback to ${px(v.market, v.ema21)}` : `${v.market} has no trend to join`;
  }
  const z = v.sd > 0 ? (v.last - v.vwap) / v.sd : 0;
  return `${v.market} is ${Math.abs(z).toFixed(1)} deviations ${z >= 0 ? 'above' : 'below'} VWAP: needs 2`;
}

/** The moves a trader may make at this bar's close. One option, or none, means there is nothing to ask a brain. */
export function buildMenu(t: TraderState, views: Map<string, MarketView>, at: Moment, rules: LeagueRules): Menu {
  const hard = parseRules(t.def.rules);
  if (t.pos) {
    const v = views.get(t.pos.market);
    if (!v) return { options: [], idle: `No price for ${t.pos.market}` };
    const r = openR(t.pos, v.last);
    const against = t.pos.side === 'long' ? v.ema9 < v.ema21 : v.ema9 > v.ema21;
    const options: MenuOption[] = [{ label: 'HOLD', desc: `${r >= 0 ? '+' : '−'}${Math.abs(r).toFixed(1)}R, stop ${px(t.pos.market, t.pos.stop)}`, intent: { kind: 'hold' }, score: 0.62 + (against ? -0.12 : 0.08) }];
    // A capped trader rides: only code can close it.
    if (t.cap) return { options, idle: 'Riding: capped, only the stop or the close can end it' };
    options.push({ label: 'CUT', desc: against ? 'the fast average has turned against it' : 'close it now', intent: { kind: 'close', why: 'cut' }, score: clamp01(0.1 + (against ? 0.15 : 0) + (r < -0.5 ? 0.15 : 0)) });
    const stopBehind = t.pos.side === 'long' ? t.pos.stop < t.pos.entry : t.pos.stop > t.pos.entry;
    if (r >= 1 && stopBehind) options.push({ label: 'MOVE_BE', desc: 'stop to the entry: the trade can no longer lose', intent: { kind: 'breakeven' }, score: 0.6 });
    if (r >= 1.2 && !t.pos.banked && t.pos.qty >= (at.league === 'futures' ? 2 : 0)) options.push({ label: 'BANK_HALF', desc: 'take half off here', intent: { kind: 'bank' }, score: 0.4 + t.def.patience * 0.15 });
    return { options, idle: '' };
  }
  if (t.cap) return { options: [], idle: t.cap === 'trade_cap' ? 'Benched: out of trades today' : t.cap === 'loss_stop' ? 'Sent home on the loss stop' : 'Session over' };
  if (!at.canEnter) return { options: [], idle: at.league === 'futures' ? 'No new trades this late in the session' : 'Entries are paused' };
  if (hard.waitMinutes && at.minute < at.sessionOpen + hard.waitMinutes) return { options: [], idle: `Its rules: nothing in the first ${hard.waitMinutes} minutes` };
  if (hard.lastEntry != null && at.minute >= hard.lastEntry) return { options: [], idle: 'Its rules: done for the day' };
  if (t.lastOrderAt && at.ts - t.lastOrderAt < rules.cooldownBars * 60_000) return { options: [], idle: 'Cooling off after the last order' };
  const mine = t.def.markets.map((m) => views.get(m)).filter((v): v is MarketView => !!v);
  const engine = t.def.engine;
  const setups = (isStyle(engine) ? mine.flatMap((v) => (engine === 'breakout' ? breakoutSetups(v, at.league) : engine === 'trend' ? trendSetups(v) : reversionSetups(v))) : called(engine, mine, at.signals ?? []))
    .filter((o) => o.intent.kind !== 'open' || !hard.side || o.intent.side === hard.side);
  if (!setups.length) return { options: [], idle: mine.length ? watching(t.def.engine, mine[0]!, at.league) : 'None of its markets are trading' };
  // Sitting out is always on the menu: on an evaluation, patience is a move.
  return { options: [...setups, { label: 'PASS', desc: 'let this one go', intent: { kind: 'pass' }, score: 0.22 + t.def.patience * 0.22 }], idle: '' };
}

// ---- The house brain: no model, the engine's own scores -------------------------------------------------

/** A small seeded generator, so the house brain's picks replay the same. */
export function seeded(key: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let x = Math.imul(h ^ (h >>> 15), 1 | h);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** The menu as probabilities: a softmax of the engine's scores. */
export function houseProbs(options: MenuOption[]): Record<string, number> {
  const w = options.map((o) => Math.exp(o.score * 6));
  const sum = w.reduce((a, b) => a + b, 0) || 1;
  return Object.fromEntries(options.map((o, i) => [o.label, w[i]! / sum]));
}

export function pick(probs: Record<string, number>, rand: () => number): string {
  let roll = rand();
  const all = Object.entries(probs);
  for (const [label, p] of all) {
    roll -= p;
    if (roll <= 0) return label;
  }
  return all.sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'PASS';
}

/** Makes whatever a brain returned into probabilities over this menu: unknown labels are dropped, the rest sum to 1. */
export function cleanProbs(raw: unknown, options: MenuOption[]): Record<string, number> | null {
  if (!raw || typeof raw !== 'object') return null;
  const out: Record<string, number> = {};
  let sum = 0;
  for (const o of options) {
    const v = Number((raw as Record<string, unknown>)[o.label]);
    if (Number.isFinite(v) && v > 0) {
      out[o.label] = v;
      sum += v;
    }
  }
  if (sum <= 0) return null;
  for (const k of Object.keys(out)) out[k] = out[k]! / sum;
  return out;
}

// ---- What happened, for the stream ------------------------------------------------------------------------

export interface Decision {
  seq: number;
  /** The bar it was made on, and when it was written down. */
  ts: number;
  at: number;
  trader: string;
  name: string;
  color: string;
  pick: string;
  probs: [string, number][];
  /** Who chose: a brain, the trader's rules (one legal move, or code closing a trade), or the risk desk overruling. */
  by: 'brain' | 'rules' | 'risk';
  note: string;
  /** What it did to the book. */
  did: 'open' | 'close' | 'trim' | 'stop' | 'none' | 'veto';
  pnl: number | null;
  upl: number;
  ms: number;
  model: string;
}

/** Something the stream announces above the decisions: a cap, a pass, a bust. */
export interface Banner {
  seq: number;
  ts: number;
  trader: string;
  name: string;
  kind: 'passed' | 'busted' | 'sent_home' | 'benched' | 'retired' | 'veto' | 'coach';
  text: string;
}

// ---- The book: fills, stops, the day, the account ---------------------------------------------------------

const feeFor = (rules: LeagueRules, qty: number, price: number) => (rules.league === 'futures' ? rules.fee * qty : rules.fee * qty * price);

function realise(t: TraderState, rules: LeagueRules, qty: number, exit: number, ts: number, why: string): number {
  const p = t.pos!;
  const spec = MARKET_BY_ID[p.market]!;
  const fee = feeFor(rules, qty, exit);
  const pnl = (exit - p.entry) * dirOf(p.side) * qty * spec.pointValue - fee;
  t.balance += pnl;
  t.totals.fees += fee;
  t.totals.realised += pnl;
  const r = p.risk ? pnl / (p.risk * (qty / p.qty)) : 0;
  t.trades.push({ market: p.market, side: p.side, qty, entry: p.entry, exit, pnl, r, at: ts, why });
  if (t.trades.length > 60) t.trades.shift();
  if (qty >= p.qty) {
    if (pnl >= 0) t.totals.wins++;
    else {
      t.totals.losses++;
      t.lossesToday++;
    }
    t.pos = null;
  } else {
    p.risk *= 1 - qty / p.qty;
    p.qty -= qty;
  }
  return pnl;
}

/** Equity and open profit at the latest prices. */
export function mark(t: TraderState, views: Map<string, MarketView>) {
  const v = t.pos && views.get(t.pos.market);
  t.upl = t.pos && v ? (v.last - t.pos.entry) * dirOf(t.pos.side) * t.pos.qty * MARKET_BY_ID[t.pos.market]!.pointValue : 0;
  t.equity = t.balance + t.upl;
}

export interface BarOutcome {
  decisions: Omit<Decision, 'seq' | 'at'>[];
  banners: Omit<Banner, 'seq'>[];
}

const said = (t: TraderState, ts: number, pickLabel: string, note: string, did: Decision['did'], pnl: number | null, by: Decision['by'] = 'rules'): Omit<Decision, 'seq' | 'at'> => ({
  ts,
  trader: t.def.id,
  name: t.def.name,
  color: t.def.color,
  pick: pickLabel,
  probs: [[pickLabel, 1]],
  by,
  note,
  did,
  pnl,
  upl: t.upl,
  ms: 0,
  model: '',
});

/** Starts a trading day: the counters, and what the day's loss limit is measured on. */
function startDay(t: TraderState, at: Moment, rules: LeagueRules) {
  t.day = at.day;
  t.dayStart = t.balance;
  t.dayCushion = rules.league === 'futures' ? t.balance - t.floor : t.balance;
  t.tradesToday = 0;
  t.lossesToday = 0;
  t.cap = null;
}

/** Puts a trader on a new account: the next evaluation, or a new bankroll. */
function newAccount(t: TraderState, rules: LeagueRules) {
  t.gen++;
  t.balance = t.peak = t.equity = rules.start;
  t.floor = rules.start - rules.drawdown;
  t.upl = 0;
  t.pos = null;
  t.days = [];
  t.curve = [];
}

/**
 * Closes a finished day: the floor trails the best end-of-day balance, and an evaluation that has its
 * target, its days and its consistency is passed.
 */
export function endDay(t: TraderState, ts: number, rules: LeagueRules): BarOutcome {
  const out: BarOutcome = { decisions: [], banners: [] };
  if (!t.day) return out;
  if (t.tradesToday > 0 || t.balance !== t.dayStart) t.days.push(t.balance - t.dayStart);
  t.rulesAge++;
  if (rules.league !== 'futures') return out;
  t.peak = Math.max(t.peak, t.balance);
  t.floor = Math.max(t.floor, Math.min(rules.start + rules.lockProfit, t.peak - rules.drawdown));
  const profit = t.balance - rules.start;
  if (rules.target != null && profit >= rules.target) {
    const best = Math.max(0, ...t.days);
    const steady = rules.consistency == null || best <= profit * rules.consistency;
    if (t.days.length >= rules.minDays && steady) {
      t.passes++;
      out.banners.push({ ts, trader: t.def.id, name: t.def.name, kind: 'passed', text: `${t.def.name} passed evaluation ${t.gen} in ${t.days.length} days` });
      newAccount(t, rules);
    } else t.status = steady ? `Target hit: needs ${rules.minDays} trading days` : `Target hit: one day is more than ${Math.round(rules.consistency! * 100)}% of the profit`;
  }
  return out;
}

/**
 * A closed bar reaches a trader, before any decision: a new day starts, a stop or a target fills (the stop
 * first when a bar holds both), the session's end flattens, and an account through its floor is over.
 */
export function onBar(t: TraderState, views: Map<string, MarketView>, bars: Map<string, Bar>, at: Moment, rules: LeagueRules): BarOutcome {
  const out: BarOutcome = { decisions: [], banners: [] };
  if (t.day !== at.day) {
    const closed = endDay(t, at.ts, rules);
    out.banners.push(...closed.banners);
    startDay(t, at, rules);
  }
  const p = t.pos;
  const bar = p && bars.get(p.market);
  if (p && bar) {
    const long = p.side === 'long';
    const stopped = long ? bar.low <= p.stop : bar.high >= p.stop;
    const hit = p.target != null && (long ? bar.high >= p.target : bar.low <= p.target);
    if (stopped) {
      // A bar that opens past the stop fills at its open, not at the stop.
      const fill = long ? Math.min(p.stop, bar.open) : Math.max(p.stop, bar.open);
      const pnl = realise(t, rules, p.qty, fill, at.ts, 'stop');
      mark(t, views);
      out.decisions.push(said(t, at.ts, 'STOPPED', `${p.market} stop ${px(p.market, fill)}`, 'stop', pnl));
    } else if (hit) {
      const pnl = realise(t, rules, p.qty, p.target!, at.ts, 'target');
      mark(t, views);
      out.decisions.push(said(t, at.ts, 'TARGET', `${p.market} target ${px(p.market, p.target!)}`, 'close', pnl));
    }
  }
  mark(t, views);
  if (t.pos && at.mustFlatten) {
    const v = views.get(t.pos.market);
    if (v) {
      const pnl = realise(t, rules, t.pos.qty, v.last, at.ts, 'session close');
      mark(t, views);
      out.decisions.push(said(t, at.ts, 'FLATTEN', 'the session is closing', 'close', pnl));
    }
  }
  // The account's own line. Futures: the trailing floor. Crypto: the loss that retires a bankroll.
  if (t.equity <= t.floor) {
    const v = t.pos && views.get(t.pos.market);
    if (t.pos && v) realise(t, rules, t.pos.qty, v.last, at.ts, 'account over');
    t.busts++;
    const lost = rules.start - t.balance;
    out.banners.push({ ts: at.ts, trader: t.def.id, name: t.def.name, kind: rules.league === 'futures' ? 'busted' : 'retired', text: rules.league === 'futures' ? `${t.def.name} hit the floor on evaluation ${t.gen}: account over` : `${t.def.name} lost $${Math.round(lost)} of the bankroll and starts over` });
    newAccount(t, rules);
    startDay(t, at, rules);
    t.cap = 'loss_stop';
    return out;
  }
  if (!t.cap) {
    const lostToday = t.dayStart - t.equity;
    if (t.lossesToday >= rules.lossStop || lostToday >= t.dayCushion * rules.dayLossFrac) {
      t.cap = 'loss_stop';
      out.banners.push({ ts: at.ts, trader: t.def.id, name: t.def.name, kind: 'sent_home', text: `${t.def.name} is sent home: ${t.lossesToday >= rules.lossStop ? `${t.lossesToday} losses today` : 'the day’s loss limit'}` });
    } else if (t.tradesToday >= (parseRules(t.def.rules).maxTrades ?? rules.tradeCap) && !t.pos) {
      t.cap = 'trade_cap';
      out.banners.push({ ts: at.ts, trader: t.def.id, name: t.def.name, kind: 'benched', text: `${t.def.name} is benched: trade ${t.tradesToday} of ${parseRules(t.def.rules).maxTrades ?? rules.tradeCap}` });
    }
  }
  return out;
}

/** How many units the risk desk allows on an entry, and why not when it is none. */
export function sizeFor(t: TraderState, o: Extract<Intent, { kind: 'open' }>, last: number, prob: number, rules: LeagueRules): { qty: number; risk: number; why: string } {
  const spec = MARKET_BY_ID[o.market]!;
  const perUnit = Math.abs(last - o.stop) * spec.pointValue;
  if (perUnit <= 0) return { qty: 0, risk: 0, why: 'no stop distance' };
  // A pick the brain was unsure of is sized down, never up.
  const conviction = prob >= 0.6 ? 1 : prob >= 0.45 ? 0.75 : 0.5;
  if (rules.league === 'futures') {
    const cushion = t.equity - t.floor;
    const dayLeft = t.dayCushion * rules.dayLossFrac - (t.dayStart - t.equity);
    const budget = Math.min(cushion * rules.riskFrac * conviction, dayLeft);
    const qty = Math.min(rules.maxUnits, Math.floor(budget / perUnit));
    return qty >= 1 ? { qty, risk: qty * perUnit, why: '' } : { qty: 0, risk: 0, why: `one ${spec.unit} risks $${Math.round(perUnit)}: more than the $${Math.max(0, Math.round(budget))} this trade may risk` };
  }
  const budget = t.equity * rules.riskFrac * conviction;
  const qty = Math.min(budget / perUnit, (t.equity * rules.leverage) / last);
  return qty * last >= 5 ? { qty, risk: qty * perUnit, why: '' } : { qty: 0, risk: 0, why: 'too small to be worth the fee' };
}

/** Carries out a pick. The risk desk sizes an entry, and can refuse it. */
export function act(t: TraderState, option: MenuOption, prob: number, views: Map<string, MarketView>, at: Moment, rules: LeagueRules): { did: Decision['did']; note: string; pnl: number | null; veto: string } {
  const i = option.intent;
  if (i.kind === 'pass' || i.kind === 'hold') return { did: 'none', note: option.desc, pnl: null, veto: '' };
  if (i.kind === 'open') {
    const v = views.get(i.market)!;
    const spec = MARKET_BY_ID[i.market]!;
    const size = sizeFor(t, i, v.last, prob, rules);
    if (!size.qty) return { did: 'veto', note: size.why, pnl: null, veto: size.why };
    // Filled at the close, a tick the wrong way.
    const fill = v.last + dirOf(i.side) * spec.tick;
    const fee = feeFor(rules, size.qty, fill);
    t.balance -= fee;
    t.totals.fees += fee;
    t.totals.realised -= fee;
    t.totals.orders++;
    t.tradesToday++;
    t.lastOrderAt = at.ts;
    t.pos = { market: i.market, side: i.side, qty: size.qty, entry: fill, stop: i.stop, target: i.target, risk: size.risk, openedAt: at.ts, label: option.label, banked: false };
    mark(t, views);
    const units = rules.league === 'futures' ? `${size.qty} ${spec.unit}` : `${size.qty.toPrecision(3)} ${spec.unit}`;
    return { did: 'open', note: `${units} at ${px(i.market, fill)}, risking $${Math.round(size.risk)}: ${option.desc}`, pnl: null, veto: '' };
  }
  const p = t.pos;
  const v = p && views.get(p.market);
  if (!p || !v) return { did: 'none', note: 'nothing open', pnl: null, veto: '' };
  if (i.kind === 'breakeven') {
    p.stop = p.entry;
    return { did: 'none', note: `stop moved to the entry ${px(p.market, p.entry)}`, pnl: null, veto: '' };
  }
  if (i.kind === 'bank') {
    const half = rules.league === 'futures' ? Math.floor(p.qty / 2) : p.qty / 2;
    p.banked = true;
    const pnl = realise(t, rules, half, v.last, at.ts, 'banked half');
    t.totals.orders++;
    mark(t, views);
    return { did: 'trim', note: `half off at ${px(p.market, v.last)}`, pnl, veto: '' };
  }
  const pnl = realise(t, rules, p.qty, v.last, at.ts, i.why);
  t.totals.orders++;
  t.lastOrderAt = at.ts;
  mark(t, views);
  return { did: 'close', note: `closed at ${px(p.market, v.last)}`, pnl, veto: '' };
}

/** Adds a point to a trader's curve, thinning the old half when it gets long. */
export function plot(t: TraderState, ts: number, rules: LeagueRules) {
  t.curve.push([ts, Math.round((t.equity - rules.start) * 100) / 100]);
  if (t.curve.length > 480) t.curve = t.curve.filter((_, i) => i % 2 === 0 || i > 400);
}

// ---- Designing a trader from a sentence (the house way: no model) ---------------------------------------

const FIRST = ['Vex', 'Juno', 'Marlo', 'Pike', 'Odessa', 'Rook', 'Sable', 'Tully', 'Wren', 'Zeke', 'Indy', 'Cass', 'Bram', 'Nova', 'Dax', 'Lux', 'Remy', 'Kit', 'Arlo', 'Mina'];
const LAST: Record<EngineId, string[]> = {
  breakout: ['Breaker', 'Rangebuster', 'Bellringer', 'Gapper', 'Launch'],
  trend: ['Tailwind', 'Glide', 'Longhaul', 'Drift', 'Compass'],
  reversion: ['Rubberband', 'Fader', 'Snapback', 'Contra', 'Pendulum'],
  'vwap-pullback': ['Tailwind', 'Anchor', 'Glide', 'Longhaul'],
  'double-break': ['Bellringer', 'Breaker', 'Doubletap', 'Launch'],
  'supply-demand': ['Zonewalker', 'Basecamp', 'Shelf', 'Depot'],
  'support-resistance': ['Ledger', 'Holloway', 'Threshold', 'Backstop'],
  'failed-auction': ['Gavel', 'Nobid', 'Hammer', 'Passline'],
};
const TAG: Record<EngineId, string[]> = {
  breakout: ['the range breaker', 'first through the door', 'the bell ringer'],
  trend: ['the patient passenger', 'rides what is already moving', 'the pullback buyer'],
  reversion: ['bets on the snap back', 'the stretch fader', 'sells the excitement'],
  'vwap-pullback': ['the patient passenger', 'buys the dip to VWAP', 'one clean pullback'],
  'double-break': ['first through the door', 'the bell ringer', 'range and VWAP, both'],
  'supply-demand': ['first retest only', 'the zone keeper', 'buys the base'],
  'support-resistance': ['lives at the level', 'the level keeper', 'bounce or break'],
  'failed-auction': ['sells the stalled auction', 'the auctioneer', 'back to value'],
};
export const TRADER_COLORS = ['#f4a52e', '#8b7cf6', '#ec5f8f', '#36c5f0', '#5fd38d', '#f97362', '#d4a5ff', '#ffd166'];

export interface Draft {
  name: string;
  tagline: string;
  engine: EngineId;
  markets: string[];
  rules: string;
  patience: number;
  /** Who designed it: the house's keyword reading, or a model. */
  by: string;
}

/** Reads a sentence for the engine, the markets and the temperament it asks for. */
export function designDraft(sentence: string, league: League, seed = sentence): Draft {
  const s = sentence.toLowerCase();
  const rand = seeded(`${league}:${seed}`);
  const any = <T>(list: T[]) => list[Math.floor(rand() * list.length)]!;
  const engine: EngineId =
    league === 'futures'
      ? /\b(auction|value area|vah|val|poc|profile|imbalance)/.test(s) ? 'failed-auction' : /\b(supply|demand|zones?|base|basing)/.test(s) ? 'supply-demand' : /\b(double|opening range|orb|bell|break(?:out|s)?)\b/.test(s) && !/\bretest of a level\b/.test(s) ? 'double-break' : /\b(support|resistance|levels?|bounce|s\/r|high and low)/.test(s) ? 'support-resistance' : /\b(vwap|pullback|trend|ema|ride|follow)/.test(s) ? 'vwap-pullback' : any(enginesOf(league))
      : /\b(fade|fades|revert|reversion|mean|snap|stretch|overbought|oversold|dips?|contrarian|exhaust)/.test(s) ? 'reversion' : /\b(break|breakout|range|momentum|pump|rip)/.test(s) ? 'breakout' : /\b(trend|pullback|vwap|ema|ride|follow|swing|patient)/.test(s) ? 'trend' : any(enginesOf(league));
  const names: Record<string, RegExp> = { NQ: /\b(nq|mnq|nasdaq|tech)\b/, ES: /\b(es|mes|s&p|spx|sp500)\b/, GC: /\b(gc|mgc|gold)\b/, BTC: /\b(btc|bitcoin)\b/, ETH: /\b(eth|ethereum|ether)\b/, SOL: /\b(sol|solana)\b/ };
  const all = marketsOf(league);
  const named = all.filter((m) => names[m]!.test(s));
  const patience = /\b(patient|sniper|calm|careful|picky|selective|sleepy|disciplined|conservative)\b/.test(s) ? 0.9 : /\b(aggressive|degen|eager|hungry|fast|scalp|reckless|wild|gremlin)\b/.test(s) ? 0.1 : 0.5;
  const kept = parseRules(sentence);
  const lines = [
    named.length ? `Only ${named.join(' and ')}.` : '',
    kept.side ? `${kept.side === 'long' ? 'Longs' : 'Shorts'} only.` : '',
    kept.maxTrades ? `${kept.maxTrades} ${kept.maxTrades === 1 ? 'trade' : 'trades'} a day.` : '',
    kept.waitMinutes ? `Nothing in the first ${kept.waitMinutes} minutes.` : '',
    kept.lastEntry != null ? `No entries after ${Math.floor(kept.lastEntry / 60)}:${String(kept.lastEntry % 60).padStart(2, '0')}.` : '',
    patience > 0.7 ? 'Pass on anything that is not clean.' : patience < 0.3 ? 'Take the setup when it is there.' : '',
  ].filter(Boolean);
  return {
    name: `${any(FIRST)} ${any(LAST[engine])}`,
    tagline: any(TAG[engine]),
    engine,
    markets: named.length ? named : all,
    rules: `${isStyle(engine) ? ENGINES[engine].blurb : `Trade the ${ENGINES[engine].name} playbook.`} ${lines.join(' ')}`.trim(),
    patience,
    by: 'the house (keywords, no model)',
  };
}

/** The three traders a league opens with, one on each engine. */
export function starters(league: League, now: number): TraderDef[] {
  const cast: [string, string, EngineId, number, string][] =
    league === 'futures'
      ? [
          ['Marlo Tailwind', 'the patient passenger', 'vwap-pullback', 0.8, 'Trade the VWAP Pullback in Trend playbook on NQ and ES. Pass on anything that is not clean.'],
          ['Ledge Holloway', 'lives at the level', 'support-resistance', 0.5, 'Trade the Support & Resistance playbook on any market. Three trades a day.'],
          ['Sable Gavel', 'sells the stalled auction', 'failed-auction', 0.3, 'Trade the Failed Auction playbook on any market, overnight included.'],
        ]
      : [
          ['Rook Rangebuster', 'the two-hour breaker', 'breakout', 0.3, 'Take the break of the two-hour range on any coin.'],
          ['Juno Glide', 'rides what is already moving', 'trend', 0.8, 'Only BTC and ETH. Join the trend on a pullback and sit tight.'],
          ['Dax Rubberband', 'the stretch fader', 'reversion', 0.4, 'Fade a stretched coin back to VWAP. Four trades a day.'],
        ];
  return cast.map(([name, tagline, engine, patience, rules], i) => ({
    id: `${league}-${i + 1}`,
    league,
    name,
    tagline,
    engine,
    color: ENGINES[engine].color,
    markets: /only btc and eth/i.test(rules) ? ['BTC', 'ETH'] : /on nq and es/i.test(rules) ? ['NQ', 'ES'] : marketsOf(league),
    rules,
    prompt: rules,
    patience,
    createdAt: now,
  }));
}

// ---- What the console is sent -----------------------------------------------------------------------------

export interface TraderView {
  def: TraderDef;
  rank: number;
  gen: number;
  equity: number;
  pnl: number;
  pnlPct: number;
  today: number;
  floor: number;
  /** 0 at the floor, 1 at the target: where the account stands in its race (futures). */
  progress: number | null;
  /** Where the account started on that same line. */
  startAt: number | null;
  cushion: number;
  toTarget: number | null;
  days: number;
  pos: (Position & { mark: number; upl: number; r: number }) | null;
  status: string;
  cap: Cap | null;
  tradesToday: number;
  tradeCap: number;
  last: LastCall | null;
  curve: [number, number][];
  trades: ClosedTrade[];
  totals: TraderState['totals'];
  passes: number;
  busts: number;
  rulesBy: 'owner' | 'coach';
  canUndo: boolean;
}

export interface CoachRound {
  at: number;
  kind: 'hands_off' | 'rewrite' | 'undo';
  quote: string;
  trader: string | null;
  name: string | null;
  detail: string;
}

export interface BrainView {
  kind: 'house' | 'claude' | 'codex' | 'opencode' | 'gemini';
  /**
   * What the console may say powers the decisions, and through what: "Opus 5.5" on "Claude Code", or just
   * "Codex" (a harness that picks its own model). Only ever the brain that is really in use.
   */
  label: string;
  on: string;
  model: string;
  /** The harness says what each call cost. */
  metered: boolean;
  calls: number;
  callCap: number;
  usd: number;
  error: string;
}

/** How a trader, or a draft of one, did over the tape it was replayed on. */
export interface BacktestReport {
  name: string;
  engine: EngineId;
  markets: string[];
  /** What it was replayed on, in words. */
  span: string;
  /** Realised result over every account it ran, after fees. */
  net: number;
  trades: number;
  wins: number;
  losses: number;
  /** The deepest fall from a high, in dollars. */
  worstDip: number;
  bestDay: number;
  worstDay: number;
  days: number;
  passes: number;
  busts: number;
  /** Sessions the first evaluation took to pass (null: it did not). */
  firstPass: number | null;
  /** The running result, a point per session (futures) or per hour (crypto). */
  curve: number[];
}

/** Where the edge is: every engine on every market, one neutral trader each. */
export interface LabView {
  league: League;
  span: string;
  cells: { engine: EngineId; market: string; net: number; trades: number; wins: number; losses: number }[];
}

export interface TapeView {
  mode: 'replay' | 'live' | 'warming' | 'ended' | 'offline';
  label: string;
  day: string;
  ts: number;
  playing: boolean;
  speed: number;
  /** Sessions on the tape, and which one this is. */
  session: number;
  sessions: number;
  source: string;
}

export interface EngineScore {
  engine: EngineId;
  traders: number;
  avg: number;
  best: { name: string; color: string; score: number } | null;
}

export interface Fallen {
  name: string;
  color: string;
  engine: EngineId;
  gen: number;
  at: number;
  result: number;
  why: string;
  kind: 'passed' | 'busted' | 'retired' | 'let_go';
}

export interface ArenaView {
  league: League;
  rules: LeagueRules;
  tape: TapeView;
  brain: BrainView;
  traders: TraderView[];
  decisions: Decision[];
  banners: Banner[];
  /** The latest entries the risk desk refused. */
  vetoes: { ts: number; name: string; label: string; why: string }[];
  coach: { every: string; rounds: CoachRound[]; rewrites: number };
  engines: EngineScore[];
  fallen: Fallen[];
  markets: { id: string; last: number; changePct: number }[];
  totals: { pnl: number; fees: number; decisions: number; asked: number; orders: number; perMin: number };
  seq: number;
}

/** A trader's score in its league: dollars on an evaluation, per cent on a bankroll. */
export const scoreOf = (t: { equity: number }, rules: LeagueRules) => (rules.league === 'futures' ? t.equity - rules.start : ((t.equity - rules.start) / rules.start) * 100);

export function traderView(t: TraderState, views: Map<string, MarketView>, rules: LeagueRules, rank: number): TraderView {
  const v = t.pos && views.get(t.pos.market);
  const span = rules.target != null ? rules.start + rules.target - t.floor : null;
  return {
    def: t.def,
    rank,
    gen: t.gen,
    equity: t.equity,
    pnl: t.equity - rules.start,
    pnlPct: ((t.equity - rules.start) / rules.start) * 100,
    today: t.equity - t.dayStart,
    floor: t.floor,
    progress: span ? clamp01((t.equity - t.floor) / span) : null,
    startAt: span ? clamp01((rules.start - t.floor) / span) : null,
    cushion: t.equity - t.floor,
    toTarget: rules.target != null ? rules.start + rules.target - t.equity : null,
    days: t.days.length,
    pos: t.pos ? { ...t.pos, mark: v?.last ?? t.pos.entry, upl: t.upl, r: openR(t.pos, v?.last ?? t.pos.entry) } : null,
    status: t.status,
    cap: t.cap,
    tradesToday: t.tradesToday,
    tradeCap: parseRules(t.def.rules).maxTrades ?? rules.tradeCap,
    last: t.last,
    curve: t.curve,
    trades: t.trades.slice(-12),
    totals: t.totals,
    passes: t.passes,
    busts: t.busts,
    rulesBy: t.rulesBy,
    canUndo: t.rulesBy === 'coach' && t.rulesBefore.length > 0,
  };
}

// ---- The Desk Head: a coach who may change a trader's rules, and nothing else ----------------------------

/** Sessions a rewrite is left alone before the next. */
export const COACH_COOLDOWN = 3;

/**
 * The house coach's verdict on one trader, from its own trades: null when it should be left alone. It can
 * only add a constraint the code enforces (a side, a trade count, a wait), never size, stops or limits.
 */
export function houseVerdict(t: TraderState): { quote: string; detail: string; rules: string } | null {
  if (t.rulesAge < COACH_COOLDOWN || t.days.length < 3) return null;
  // Three losing sessions running: fewer than that is a bad day, not a bad rulebook.
  const recent = t.days.slice(-3);
  if (!recent.every((d) => d < 0)) return null;
  const tidy = (rules: string) => rules.replace(/\s+/g, ' ').trim();
  const hard = parseRules(t.def.rules);
  const lost = t.trades.slice(-12);
  const sum = (side: Side) => lost.filter((x) => x.side === side).reduce((a, x) => a + x.pnl, 0);
  const longs = sum('long');
  const shorts = sum('short');
  if (!hard.side && lost.length >= 4 && Math.min(longs, shorts) < 0 && Math.max(longs, shorts) >= 0) {
    const keep = longs > shorts ? 'Longs' : 'Shorts';
    return { quote: `The ${keep === 'Longs' ? 'shorts' : 'longs'} are the whole loss. ${keep} only until that changes.`, detail: `${keep === 'Longs' ? 'Shorts' : 'Longs'} lost $${Math.round(-Math.min(longs, shorts))} over the last ${lost.length} trades while ${keep.toLowerCase()} made money.`, rules: tidy(`${t.def.rules} ${keep} only.`) };
  }
  const cap = hard.maxTrades ?? 3;
  if (cap > 1) return { quote: `Losing days in a row. ${cap - 1 === 1 ? 'One trade' : 'Two trades'} a day, and make it count.`, detail: `${recent.filter((d) => d < 0).length} losing sessions: fewer attempts a day.`, rules: tidy(`${t.def.rules.replace(/\b(\d|one|two|three|four|five|six) (?:trades?|attempts?|shots?) (?:a|per) (?:day|session)\.?/gi, '')} ${cap - 1 === 1 ? 'One trade' : 'Two trades'} a day.`) };
  if (!hard.waitMinutes) return { quote: 'Still bleeding on one trade a day. Let the open settle first.', detail: 'Already at one trade a day: now it waits out the first half hour.', rules: tidy(`${t.def.rules} Nothing in the first half hour.`) };
  return null;
}
