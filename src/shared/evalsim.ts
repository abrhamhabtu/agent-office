import type { PaperTrade, PropRules } from './trading.js';
import { DAILY_STOP, INSTRUMENTS, microsFor } from './trading.js';

// The prop eval simulator. A strategy's backtest trades are played, in order, through one account's rules:
// each trade is sized off the drawdown that's left, the floor trails the way that firm trails it, and the
// run ends the moment the account passes or busts. Shared by the server (the wall board) and the browser
// (the simulator window, where every setting can be changed and the answer redrawn at once).
//
// One real month is one path, and the order the days came in is luck. So the odds are worked out too:
// the same real days are redrawn at random, many times, to see how often the account would have passed.

export interface EvalOptions {
  /** Risk this fraction of the drawdown left on each trade: 10 is the Law of 10. */
  divisor: number;
  /** A fixed dollar risk per trade instead, when set. */
  fixedRisk: number | null;
  /** A fixed number of micros on every trade instead, when set (still capped by the account's limit). */
  fixedMicros?: number | null;
  /** Stop for the day after three losses or two risks down, as the desk trades. */
  dailyStop: boolean;
  /** Hold the pass until the firm's consistency rule is met. */
  consistency: boolean;
  /** Start from where an account really is instead of a fresh one. */
  start: { balance: number; peak: number } | null;
}

export const EVAL_DEFAULTS: EvalOptions = { divisor: 10, fixedRisk: null, dailyStop: true, consistency: true, start: null };

/** One day of a run, as the ledger shows it. */
export interface EvalDay {
  day: string;
  /** Trades taken, and those left alone (the daily stop, or a stop too wide for the risk). */
  taken: number;
  skipped: number;
  wins: number;
  losses: number;
  /** The risk a trade was allowed at the start of the day, and the most micros any trade used. */
  risk: number;
  micros: number;
  pnl: number;
  balance: number;
  /** Where the account fails, after this day, and how far above it the balance is. */
  floor: number;
  cushion: number;
  note: string;
}

export interface EvalDetail {
  result: 'passed' | 'busted' | 'running';
  /** Days it ran for (every day in the test counts, traded or not), and the days a trade was taken on. */
  days: number;
  tradingDays: number;
  pnl: number;
  peakCushion: number;
  ledger: EvalDay[];
  /** The first day the profit target was reached (which isn't a pass until the other rules hold). */
  targetDay: number | null;
  bestDay: number;
  /** The best day as a share of what the consistency rule measures it against, or null when there's no profit yet. */
  bestDayShare: number | null;
  /** The closest it came to the floor, and on which day. */
  minCushion: number;
  minCushionDay: number;
  taken: number;
  skipped: number;
  /** What ended it, or what it's still waiting for, in a line. */
  why: string;
}

const dollars = (n: number) => `${n < 0 ? '−' : ''}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`;

/** A trade as the simulator needs it. */
type T = Pick<PaperTrade, 'day' | 'symbol' | 'entryAt' | 'entry' | 'stop' | 'dollars' | 'outcome'>;

interface Core {
  result: EvalDetail['result'];
  days: number;
  tradingDays: number;
  balance: number;
  peakCushion: number;
  targetDay: number | null;
  bestDay: number;
  minCushion: number;
  minCushionDay: number;
  taken: number;
  skipped: number;
  why: string;
}

/** The share of the consistency rule's base that the best day takes up. */
function share(rules: PropRules, bestDay: number, profit: number): number | null {
  const base = rules.consistencyBasis === 'profitTarget' ? rules.profitTarget : profit;
  return base > 0 ? bestDay / base : null;
}

/**
 * The run itself. `dayTrades` is one list of trades per day, already in order; `label` names day i.
 * `onDay` hears each finished day (the ledger); the odds runs pass none, so they stay quick.
 */
function play(dayTrades: T[][], rules: PropRules, o: EvalOptions, onDay?: (d: EvalDay, i: number) => void, label?: (i: number) => string): Core {
  const size = rules.size;
  let balance = o.start?.balance ?? size;
  let peak = Math.max(o.start?.peak ?? size, rules.drawdownType === 'static' ? size : balance);
  const floor = () => Math.min(peak - rules.drawdown, rules.lockProfit == null ? Infinity : size + rules.lockProfit);
  let peakCushion = balance - floor();
  let minCushion = peakCushion;
  let minCushionDay = 0;
  let bestDay = 0;
  let targetDay: number | null = null;
  let tradingDays = 0;
  let taken = 0;
  let skipped = 0;
  const core = (result: Core['result'], days: number, why: string): Core => ({ result, days, tradingDays, balance, peakCushion, targetDay, bestDay, minCushion, minCushionDay, taken, skipped, why });

  for (let i = 0; i < dayTrades.length; i++) {
    const startBalance = balance;
    // With a fixed contract count the risk is whatever the stop makes it, so the day's risk isn't known up front.
    let dayRisk = o.fixedMicros ? 0 : o.fixedRisk ?? Math.max(0, Math.floor((balance - floor()) / o.divisor));
    let dTaken = 0;
    let dSkipped = 0;
    let wins = 0;
    let losses = 0;
    let micros = 0;
    let stopped = '';
    let busted = false;
    for (const t of dayTrades[i]!) {
      if (t.outcome === 'open') continue;
      if (stopped) {
        dSkipped++;
        continue;
      }
      const cushion = balance - floor();
      // A fixed risk doesn't shrink as the cushion does, which is what lets it bust.
      const risk = o.fixedRisk ?? Math.max(0, Math.floor(cushion / o.divisor));
      const n = o.fixedMicros ? Math.min(Math.floor(o.fixedMicros), rules.maxMicros) : microsFor(t.symbol, risk, Math.abs(t.entry - t.stop), rules.maxMicros);
      if (!n) {
        dSkipped++;
        continue;
      }
      // (The first trade's risk stands for the day's, for the ledger and the daily stop.)
      if (o.fixedMicros && !dTaken) dayRisk = Math.round(n * Math.abs(t.entry - t.stop) * INSTRUMENTS[t.symbol].microPointValue);
      dTaken++;
      micros = Math.max(micros, n);
      const pnl = n * t.dollars;
      balance += pnl;
      if (pnl > 0) wins++;
      else if (pnl < 0) losses++;
      if (rules.drawdownType === 'trailing-intraday') peak = Math.max(peak, balance);
      if (balance <= floor()) {
        busted = true;
        break;
      }
      const dayPnl = balance - startBalance;
      if (rules.dailyLossLimit != null && dayPnl <= -rules.dailyLossLimit) stopped = 'daily loss limit';
      else if (o.dailyStop && (losses >= DAILY_STOP.losses || (dayRisk > 0 && dayPnl <= -DAILY_STOP.risks * dayRisk))) stopped = 'daily stop';
    }
    const dayPnl = balance - startBalance;
    if (!busted && rules.drawdownType === 'trailing-eod') peak = Math.max(peak, balance);
    const cushion = balance - floor();
    if (dTaken) tradingDays++;
    taken += dTaken;
    skipped += dSkipped;
    bestDay = Math.max(bestDay, dayPnl);
    peakCushion = Math.max(peakCushion, cushion);
    if (cushion < minCushion) {
      minCushion = cushion;
      minCushionDay = i + 1;
    }
    const profit = balance - size;
    if (targetDay == null && profit >= rules.profitTarget) targetDay = i + 1;
    onDay?.({ day: label?.(i) ?? String(i + 1), taken: dTaken, skipped: dSkipped, wins, losses, risk: dayRisk, micros, pnl: Math.round(dayPnl), balance: Math.round(balance), floor: Math.round(floor()), cushion: Math.round(Math.max(0, cushion)), note: busted ? 'Hit the floor' : stopped ? `Stopped for the day (${stopped})` : !dTaken && dSkipped ? 'Stop too wide for the risk' : '' }, i);
    if (busted) return core('busted', i + 1, `Balance fell to the drawdown floor on day ${i + 1}`);
    if (profit >= rules.profitTarget) {
      const s = share(rules, bestDay, profit);
      // A rule of 100% is no rule: with losing days in the run, the best day can be more than all the profit.
      const steady = !o.consistency || rules.consistencyPercent >= 100 || s == null || s <= rules.consistencyPercent / 100 + 1e-9;
      if (tradingDays >= rules.minTradingDays && steady) return core('passed', i + 1, `${rules.kind === 'funded' ? 'Reached the payout target' : 'Hit the profit target'} on day ${i + 1} with every rule met`);
    }
  }
  const profit = balance - size;
  const n = dayTrades.length;
  if (profit >= rules.profitTarget) {
    const s = share(rules, bestDay, profit);
    if (tradingDays < rules.minTradingDays) return core('running', n, `Target reached, but only ${tradingDays} of the ${rules.minTradingDays} trading days it needs`);
    return core('running', n, `Target reached, but the best day is ${Math.round((s ?? 0) * 100)}% of ${rules.consistencyBasis === 'profitTarget' ? 'the target' : 'the profit'} (the rule allows ${rules.consistencyPercent}%)`);
  }
  return core('running', n, taken ? `${dollars(Math.max(0, rules.profitTarget - profit))} still to go when the test's days ran out` : 'No trades to play through this account');
}

/** Monday to Friday: the days a futures account can trade (Bitcoin's weekends are no part of an eval). */
export function weekdays(days: string[]): string[] {
  return days.filter((d) => {
    const w = new Date(`${d}T12:00:00Z`).getUTCDay();
    return w >= 1 && w <= 5;
  });
}

/** Trades in order, grouped by day; `days` adds the days nothing was traded on, so a quiet day is still a day. */
export function byDay<X extends T>(trades: X[], days?: string[]): { days: string[]; lists: X[][] } {
  const map = new Map<string, X[]>();
  for (const d of days ?? []) map.set(d, []);
  for (const t of trades) {
    if (t.outcome === 'open') continue;
    let list = map.get(t.day);
    if (!list) map.set(t.day, (list = []));
    list.push(t);
  }
  const keys = [...map.keys()].sort();
  return { days: keys, lists: keys.map((k) => map.get(k)!.sort((a, b) => a.entryAt - b.entryAt)) };
}

/** Plays a strategy's trades through one account, day by day, and says how it went and why. */
export function runEval(trades: T[], rules: PropRules, opts: Partial<EvalOptions> = {}, days?: string[]): EvalDetail {
  const o = { ...EVAL_DEFAULTS, ...opts };
  const g = byDay(trades, days);
  const ledger: EvalDay[] = [];
  const c = play(g.lists, rules, o, (d) => ledger.push(d), (i) => g.days[i]!);
  const profit = c.balance - rules.size;
  return {
    result: c.result,
    days: c.days,
    tradingDays: c.tradingDays,
    pnl: Math.round(profit),
    peakCushion: Math.round(c.peakCushion),
    ledger,
    targetDay: c.targetDay,
    bestDay: Math.round(c.bestDay),
    bestDayShare: profit > 0 ? share(rules, c.bestDay, profit) : null,
    minCushion: Math.round(Math.max(0, c.minCushion)),
    minCushionDay: c.minCushionDay,
    taken: c.taken,
    skipped: c.skipped,
    why: c.why,
  };
}

export interface EvalOdds {
  runs: number;
  /** How many days each imagined run was given. */
  horizon: number;
  /** Shares of the runs, adding to 1. */
  pass: number;
  bust: number;
  running: number;
  /** Days to pass, in the middle run that passed (null when none did). */
  medianDays: number | null;
  /** The balance after each day across the runs: the 10th, 50th and 90th percentiles, from day 0. */
  p10: number[];
  p50: number[];
  p90: number[];
}

/** A small seeded generator, so the same settings always draw the same runs and the numbers don't flicker. */
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

/**
 * The odds. The real days are drawn at random, with repeats, into `runs` imagined stretches of `horizon`
 * days each, and every one is played through the account. A day stays whole (its trades in their order),
 * since what happens inside a day isn't independent; what changes is which days came, and in what order.
 */
export function evalOdds(trades: T[], rules: PropRules, opts: Partial<EvalOptions> = {}, days?: string[], cfg: { runs?: number; horizon?: number; seed?: number } = {}): EvalOdds {
  const o = { ...EVAL_DEFAULTS, ...opts };
  const runs = cfg.runs ?? 500;
  const horizon = cfg.horizon ?? 60;
  const pool = byDay(trades, days).lists;
  const start = o.start?.balance ?? rules.size;
  const flat = Array.from({ length: horizon + 1 }, () => start);
  if (!pool.length || !pool.some((l) => l.length)) return { runs: 0, horizon, pass: 0, bust: 0, running: 1, medianDays: null, p10: flat, p50: flat, p90: flat };
  const rand = rng(cfg.seed ?? 7);
  let pass = 0;
  let bust = 0;
  const passDays: number[] = [];
  const paths: Float64Array[] = [];
  for (let r = 0; r < runs; r++) {
    const draw: T[][] = [];
    for (let d = 0; d < horizon; d++) draw.push(pool[Math.floor(rand() * pool.length)]!);
    const path = new Float64Array(horizon + 1);
    path[0] = start;
    let last = 0;
    const c = play(draw, rules, o, (day, i) => {
      path[i + 1] = day.balance;
      last = i + 1;
    });
    // Once a run has passed or busted, the account stays where it finished.
    for (let i = last + 1; i <= horizon; i++) path[i] = path[last]!;
    paths.push(path);
    if (c.result === 'passed') {
      pass++;
      passDays.push(c.days);
    } else if (c.result === 'busted') bust++;
  }
  const at = (q: number) =>
    Array.from({ length: horizon + 1 }, (_, i) => {
      const col = paths.map((p) => p[i]!).sort((a, b) => a - b);
      return Math.round(col[Math.min(col.length - 1, Math.floor(q * col.length))]!);
    });
  passDays.sort((a, b) => a - b);
  return { runs, horizon, pass: pass / runs, bust: bust / runs, running: (runs - pass - bust) / runs, medianDays: passDays.length ? passDays[Math.floor(passDays.length / 2)]! : null, p10: at(0.1), p50: at(0.5), p90: at(0.9) };
}
