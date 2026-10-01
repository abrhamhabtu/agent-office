import type { PaperTrade, Symbol } from './trading.js';

// The Backtest Lab's own arithmetic. The backtest keeps what the indicators read on every trade's entry
// bar (see TradeInd), so a filter here is a question asked of each trade after the fact: "would I have
// taken this one if I also wanted the trend with me?" Skipping the trades that fail it is exactly what
// a trader does with an extra rule, and it's instant, so every filter can be tried and compared.
//
// It also judges its own advice. A filter only gets recommended when the trades it keeps do better per
// trade, it keeps enough of them to matter, and the improvement shows up again on the later days it
// wasn't picked on. Anything less is called what it is.

export type FilterId =
  | 'ema-trend' | 'ema50-side' | 'macd-with'
  | 'rsi-momentum' | 'rsi-room' | 'adx-trending' | 'adx-quiet'
  | 'vol-up' | 'atr-active' | 'atr-calm'
  | 'vwap-side' | 'on-vwap'
  | 'first-hour' | 'after-open' | 'before-lunch'
  | 'longs-only' | 'shorts-only';

export type FilterGroup = 'Trend' | 'Momentum' | 'Volume & volatility' | 'Location' | 'Time of day' | 'Direction';

/** What a filter can look at besides the trade: each market's usual 5-minute ATR over the test. */
export interface FilterEnv {
  atrMedian: Partial<Record<Symbol, number>>;
}

export interface FilterDef {
  id: FilterId;
  group: FilterGroup;
  name: string;
  /** What the indicator is, for someone who hasn't used it. */
  what: string;
  /** The rule it adds, in a line. */
  rule: string;
  /** Why the lab won't recommend it however it tests (one month's direction says more about the month than the setup). */
  caution?: string;
  /** Whether a trade passes (a trade the indicator has no reading for doesn't). */
  keep(t: PaperTrade, env: FilterEnv): boolean;
}

const dir = (t: PaperTrade) => (t.side === 'long' ? 1 : -1);
const has = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);

export const FILTERS: FilterDef[] = [
  { id: 'ema-trend', group: 'Trend', name: '9 / 21 EMA trend', what: 'Two moving averages of the 5-minute closes. When the fast one (9) is above the slow one (21), the short-term trend is up.', rule: 'Longs only when the 9 is above the 21; shorts only when it is below.', keep: (t) => has(t.ind?.ema9) && has(t.ind?.ema21) && (t.ind.ema9 - t.ind.ema21) * dir(t) > 0 },
  { id: 'ema50-side', group: 'Trend', name: '50 EMA side', what: 'A slower moving average (50 bars of the 5-minute chart, about four hours). Which side of it price is on is the bigger-picture direction.', rule: 'Longs only above the 50 EMA; shorts only below it.', keep: (t) => has(t.ind?.ema50) && (t.entry - t.ind.ema50) * dir(t) > 0 },
  { id: 'macd-with', group: 'Trend', name: 'MACD agrees', what: 'MACD measures whether momentum is building or fading by comparing a 12-bar and a 26-bar average. Its histogram is positive while upward momentum is building.', rule: 'Longs only with the histogram above zero; shorts only with it below.', keep: (t) => has(t.ind?.macd) && t.ind.macd * dir(t) > 0 },
  { id: 'rsi-momentum', group: 'Momentum', name: 'RSI on your side', what: 'RSI scores recent gains against recent losses from 0 to 100. Above 50 the buyers have had the better of the last 14 bars.', rule: 'Longs only with RSI above 50; shorts only with it below 50.', keep: (t) => has(t.ind?.rsi) && (t.ind.rsi - 50) * dir(t) > 0 },
  { id: 'rsi-room', group: 'Momentum', name: 'RSI not stretched', what: 'The same RSI, read the other way: above 70 a move is stretched and often due a pause, below 30 the same on the downside.', rule: 'No longs with RSI above 70; no shorts with RSI below 30.', keep: (t) => has(t.ind?.rsi) && (t.side === 'long' ? t.ind.rsi < 70 : t.ind.rsi > 30) },
  { id: 'adx-trending', group: 'Momentum', name: 'ADX trending', what: 'ADX measures how strongly the market is trending, whichever way. Above 20 there is a trend to trade with.', rule: 'Only trade when ADX is above 20.', keep: (t) => has(t.ind?.adx) && t.ind.adx >= 20 },
  { id: 'adx-quiet', group: 'Momentum', name: 'ADX ranging', what: 'The opposite read of ADX: below 20 the market is going sideways, which suits setups that fade the edges of a range.', rule: 'Only trade when ADX is below 20.', keep: (t) => has(t.ind?.adx) && t.ind.adx < 20 },
  { id: 'vol-up', group: 'Volume & volatility', name: 'Volume above average', what: 'The volume on the signal candle against the 20 one-minute bars before it. A move on heavy volume has more people behind it.', rule: 'Only trade when the signal candle has at least 1.2 times the usual volume.', keep: (t) => has(t.ind?.relVol) && t.ind.relVol >= 1.2 },
  { id: 'atr-active', group: 'Volume & volatility', name: 'Lively tape', what: 'ATR is the average size of a 5-minute bar. Compared with what is normal for that market, it says whether today is moving or asleep.', rule: 'Only trade when the 5-minute ATR is above its usual level for that market.', keep: (t, e) => has(t.ind?.atr) && has(e.atrMedian[t.symbol]) && t.ind.atr >= e.atrMedian[t.symbol]! },
  { id: 'atr-calm', group: 'Volume & volatility', name: 'Calm tape', what: 'The same ATR, the other way: on a wild day stops get run, so some setups do better when the bars are their normal size or smaller.', rule: 'Only trade when the 5-minute ATR is at or below its usual level for that market.', keep: (t, e) => has(t.ind?.atr) && has(e.atrMedian[t.symbol]) && t.ind.atr <= e.atrMedian[t.symbol]! },
  { id: 'vwap-side', group: 'Location', name: 'Right side of VWAP', what: 'NY VWAP is the average price everyone has paid since the 06:30 PT open, weighted by volume. Above it buyers are in profit and in control.', rule: 'Longs only above NY VWAP; shorts only below it.', keep: (t) => has(t.ind?.vwap) && (t.entry - t.ind.vwap) * dir(t) > 0 },
  { id: 'on-vwap', group: 'Location', name: 'Overnight VWAP bias', what: 'The same average, anchored at the overnight open (15:00 PT the day before). It says who won the night.', rule: 'Longs only above the overnight VWAP; shorts only below it.', keep: (t) => has(t.ind?.onVwap) && (t.entry - t.ind.onVwap) * dir(t) > 0 },
  { id: 'after-open', group: 'Time of day', name: 'Skip the first 15 minutes', what: 'The first minutes after the New York open are the fastest and least orderly of the day.', rule: 'No trades before 06:45 PT.', keep: (t) => has(t.ind?.m) && t.ind.m >= 405 },
  { id: 'first-hour', group: 'Time of day', name: 'First 90 minutes only', what: 'Most of the day’s volume and its cleanest moves come in the first hour and a half after the open.', rule: 'Only trades between 06:30 and 08:00 PT.', keep: (t) => has(t.ind?.m) && t.ind.m >= 390 && t.ind.m < 480 },
  { id: 'before-lunch', group: 'Time of day', name: 'Done by 09:00', what: 'By late morning New York goes to lunch and the tape slows down.', rule: 'No trades after 09:00 PT.', keep: (t) => has(t.ind?.m) && t.ind.m < 540 },
  { id: 'longs-only', group: 'Direction', name: 'Longs only', what: 'Some setups only work one way in a market that has been climbing.', rule: 'Skip every short.', caution: 'a month that mostly rose will always favour longs: that is the market, not the setup', keep: (t) => t.side === 'long' },
  { id: 'shorts-only', group: 'Direction', name: 'Shorts only', what: 'The mirror: only the short side of the setup.', rule: 'Skip every long.', caution: 'a month that mostly fell will always favour shorts: that is the market, not the setup', keep: (t) => t.side === 'short' },
];
export const FILTER_BY_ID = Object.fromEntries(FILTERS.map((f) => [f.id, f])) as Record<FilterId, FilterDef>;
/** Filters that can't both be on: turning one on turns its opposite off. */
export const OPPOSITES: [FilterId, FilterId][] = [['adx-trending', 'adx-quiet'], ['atr-active', 'atr-calm'], ['longs-only', 'shorts-only']];

const median = (v: number[]) => (v.length ? [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]! : NaN);

/** What a filter needs to know about the whole test, worked out once from every trade in it. */
export function envOf(all: PaperTrade[]): FilterEnv {
  const by = new Map<Symbol, number[]>();
  for (const t of all) if (has(t.ind?.atr)) by.set(t.symbol, [...(by.get(t.symbol) ?? []), t.ind.atr]);
  const atrMedian: FilterEnv['atrMedian'] = {};
  for (const [sym, v] of by) atrMedian[sym] = median(v);
  return { atrMedian };
}

export function applyFilters(trades: PaperTrade[], ids: readonly FilterId[], env: FilterEnv): PaperTrade[] {
  if (!ids.length) return trades;
  const fs = ids.map((id) => FILTER_BY_ID[id]).filter(Boolean);
  return trades.filter((t) => fs.every((f) => f.keep(t, env)));
}

export interface LabStats {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  /** Expectancy: the average result of one trade, in risks. */
  avgR: number;
  totalR: number;
  maxDrawdownR: number;
  /** Winning R over losing R (null when nothing lost). */
  profitFactor: number | null;
  stdR: number;
  /** Cumulative R after each trade, in the order they were taken. */
  curve: number[];
  /** For one micro contract. */
  dollars: number;
}

const r2 = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

export function labStats(trades: PaperTrade[]): LabStats {
  const list = trades.filter((t) => t.outcome !== 'open').sort((a, b) => a.entryAt - b.entryAt);
  const n = list.length;
  let cum = 0;
  let peak = 0;
  let dd = 0;
  let won = 0;
  let lost = 0;
  let wins = 0;
  let losses = 0;
  const curve: number[] = [];
  for (const t of list) {
    cum += t.r;
    peak = Math.max(peak, cum);
    dd = Math.max(dd, peak - cum);
    if (t.r > 0) {
      wins++;
      won += t.r;
    } else if (t.r < 0) {
      losses++;
      lost -= t.r;
    }
    curve.push(r2(cum));
  }
  const mean = n ? cum / n : 0;
  const std = n > 1 ? Math.sqrt(list.reduce((a, t) => a + (t.r - mean) ** 2, 0) / (n - 1)) : 0;
  return { trades: n, wins, losses, winRate: n ? wins / n : 0, avgR: r2(mean, 3), totalR: r2(cum), maxDrawdownR: r2(dd), profitFactor: lost > 0 ? r2(won / lost) : null, stdR: r2(std), curve, dollars: Math.round(list.reduce((a, t) => a + t.dollars, 0)) };
}

/** Results split by some property of a trade (the half hour it was taken in, the weekday, the side). */
export function groupStats<K extends string>(trades: PaperTrade[], key: (t: PaperTrade) => K | null): { key: K; stats: LabStats }[] {
  const by = new Map<K, PaperTrade[]>();
  for (const t of trades) {
    const k = key(t);
    if (k == null) continue;
    by.set(k, [...(by.get(k) ?? []), t]);
  }
  return [...by].map(([k, list]) => ({ key: k, stats: labStats(list) }));
}

export type SuggestVerdict = 'recommended' | 'unproven' | 'neutral' | 'hurts' | 'thin';

export interface Suggestion {
  filter: FilterId;
  verdict: SuggestVerdict;
  confidence: 'low' | 'medium' | 'high';
  /** With the filter added, and what it changes against the trades without it. */
  kept: number;
  of: number;
  avgR: number;
  dAvgR: number;
  totalR: number;
  dTotalR: number;
  winRate: number;
  /** The same change measured only on the later third of the days, which the choice wasn't made on. */
  laterDAvgR: number | null;
  reason: string;
}

/** Fewer trades than this, with a filter on, and there isn't enough to say anything. */
export const MIN_KEPT = 12;
const fmtR = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(2)}R`;

/**
 * Tries every filter that isn't on yet, on top of the ones that are, and says which are worth adding.
 * `days` is every day in the test, oldest first: the later third is held back to check a filter on.
 */
export function suggestFilters(trades: PaperTrade[], active: readonly FilterId[], env: FilterEnv, days: string[]): Suggestion[] {
  const base = applyFilters(trades, active, env);
  const b = labStats(base);
  const later = new Set(days.slice(Math.ceil((days.length * 2) / 3)));
  const bLater = labStats(base.filter((t) => later.has(t.day)));
  const blocked = new Set<FilterId>();
  for (const [x, y] of OPPOSITES) {
    if (active.includes(x)) blocked.add(y);
    if (active.includes(y)) blocked.add(x);
  }
  const out: Suggestion[] = [];
  for (const f of FILTERS) {
    if (active.includes(f.id) || blocked.has(f.id)) continue;
    const kept = base.filter((t) => f.keep(t, env));
    const gone = base.filter((t) => !f.keep(t, env));
    const k = labStats(kept);
    const g = labStats(gone);
    const kLater = labStats(kept.filter((t) => later.has(t.day)));
    const dAvg = r2(k.avgR - b.avgR, 3);
    const laterD = kLater.trades >= 4 && bLater.trades >= 4 ? r2(kLater.avgR - bLater.avgR, 3) : null;
    // The kept trades against the ones it throws away: how big the gap is beside trade-to-trade noise.
    const se = Math.sqrt(k.stdR ** 2 / Math.max(1, k.trades) + g.stdR ** 2 / Math.max(1, g.trades));
    const z = se > 0 && g.trades > 1 && k.trades > 1 ? (k.avgR - g.avgR) / se : 0;
    const confidence: Suggestion['confidence'] = z >= 2.5 ? 'high' : z >= 1.5 ? 'medium' : 'low';
    const share = b.trades ? k.trades / b.trades : 0;
    let verdict: SuggestVerdict;
    let reason: string;
    if (!gone.length) {
      verdict = 'neutral';
      reason = 'Every trade already passes it, so it changes nothing';
    } else if (k.trades < MIN_KEPT) {
      verdict = 'thin';
      reason = `Leaves only ${k.trades} trade${k.trades === 1 ? '' : 's'}, too few to judge (the lab wants ${MIN_KEPT}+)`;
    } else if (dAvg <= -0.05) {
      verdict = 'hurts';
      reason = `The trades it removes were better than the ones it keeps (${fmtR(g.avgR)} against ${fmtR(k.avgR)} a trade)`;
    } else if (dAvg < 0.08) {
      verdict = 'neutral';
      reason = `Makes no real difference: ${fmtR(dAvg)} a trade`;
    } else if (laterD == null) {
      verdict = 'unproven';
      reason = `${fmtR(dAvg)} a trade better, but too few trades on the later days to check it held`;
    } else if (laterD <= 0) {
      verdict = 'unproven';
      reason = `${fmtR(dAvg)} a trade better overall, but not on the later days it wasn’t picked on (${fmtR(laterD)})`;
    } else if (share < 0.35) {
      verdict = 'unproven';
      reason = `${fmtR(dAvg)} a trade better, but it skips ${Math.round((1 - share) * 100)}% of the trades: that is a different, rarer strategy`;
    } else if (f.caution) {
      verdict = 'unproven';
      reason = `${fmtR(dAvg)} a trade better and it held on the later days, but ${f.caution}`;
    } else if (z < 1) {
      verdict = 'unproven';
      reason = `${fmtR(dAvg)} a trade better, which is within normal luck for ${k.trades} trades`;
    } else {
      verdict = 'recommended';
      reason = `${fmtR(dAvg)} a trade better, keeps ${k.trades} of ${b.trades} trades, and held on the later days (${fmtR(laterD)})`;
    }
    out.push({ filter: f.id, verdict, confidence, kept: k.trades, of: b.trades, avgR: k.avgR, dAvgR: dAvg, totalR: k.totalR, dTotalR: r2(k.totalR - b.totalR), winRate: k.winRate, laterDAvgR: laterD, reason });
  }
  const rank: Record<SuggestVerdict, number> = { recommended: 0, unproven: 1, neutral: 2, thin: 3, hurts: 4 };
  return out.sort((a, c) => rank[a.verdict] - rank[c.verdict] || c.dAvgR - a.dAvgR);
}
