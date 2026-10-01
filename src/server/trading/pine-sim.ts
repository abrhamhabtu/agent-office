import type { Bar, PineMetrics, PineParams, Symbol } from '../../shared/trading.js';
import { INSTRUMENTS } from '../../shared/trading.js';

// A faithful replay of the owner's "VWAP Double Break Suite" Pine script on real bars, so a change to it
// can be tested before it's ever run live. It follows the script statement by statement: NY VWAP from the
// 09:30 ET open, the opening range, the window, the trap then the close back through NY VWAP (the DB),
// the stop at the far side of the range (pulled in to the micro's dollar cap), the target at 2R, and one
// re-entry (DB2) after a stop. It runs on the chart's timeframe (5 minutes), built from 1-minute bars.

export type { PineParams };
export const V1_PARAMS: PineParams = { orMinutes: 15, stopBuffer: 1, maxLoss: 325, rMultiple: 2, window: '1000-1200', recovery: true };

export interface SimTrade {
  day: string;
  symbol: Symbol;
  /** 1 long, -1 short. */
  dir: 1 | -1;
  ts: number;
  entry: number;
  stop: number;
  target: number;
  /** A DB2 re-entry rather than the first break. */
  second: boolean;
  outcome: 'win' | 'loss' | 'time';
  /** Result in R, and in dollars for one micro. */
  r: number;
  dollars: number;
}

const etFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
/** Eastern day (YYYY-MM-DD) and minutes since midnight for a bar's open time. */
function et(ts: number): { day: string; mins: number } {
  const p = Object.fromEntries(etFormat.formatToParts(ts).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, mins: Number(p.hour) * 60 + Number(p.minute) };
}

/** Bars of `minutes` from 1-minute bars, on the clock (5-minute bars open at :00, :05, …). */
export function aggregate(bars: Bar[], minutes: number): Bar[] {
  const ms = minutes * 60_000;
  const out: Bar[] = [];
  for (const b of bars) {
    const ts = Math.floor(b.ts / ms) * ms;
    const tail = out[out.length - 1];
    if (tail && tail.ts === ts) {
      tail.high = Math.max(tail.high, b.high);
      tail.low = Math.min(tail.low, b.low);
      tail.close = b.close;
      tail.volume += b.volume;
    } else out.push({ ts, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume });
  }
  return out;
}

/** "1000-1200" as minutes [from, to). */
function session(window: string): [number, number] {
  const m = /^(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(window);
  return m ? [Number(m[1]) * 60 + Number(m[2]), Number(m[3]) * 60 + Number(m[4])] : [600, 720];
}

const OPEN = 9 * 60 + 30;
const CLOSE = 16 * 60;

/** One New York session of bars through the script. */
function simDay(day: string, symbol: Symbol, bars: Bar[], p: PineParams, tick: number): SimTrade[] {
  const pv = INSTRUMENTS[symbol].microPointValue;
  const [winFrom, winTo] = session(p.window);
  const capPts = p.maxLoss / pv;
  const trades: SimTrade[] = [];
  let nySum = 0;
  let nyVol = 0;
  let nyVwap = NaN;
  let orbH = NaN;
  let orbL = NaN;
  let orbSet = false;
  let st = 'IDLE';
  let longFired = false;
  let shortFired = false;
  let db2Used = false;
  let recoverDir = 0;
  let tradeDir = 0;
  let entry = NaN;
  let sl = NaN;
  let tp = NaN;
  let tradeIdx = -1;
  let tradeTs = 0;
  let tradeIs2 = false;
  let dayDone = false;
  let prevClose = NaN;
  let prevVwap = NaN;

  const settle = (outcome: SimTrade['outcome'], exit: number) => {
    const risk = Math.abs(entry - sl);
    const r = outcome === 'win' ? p.rMultiple : outcome === 'loss' ? -1 : (tradeDir * (exit - entry)) / risk;
    trades.push({ day, symbol, dir: tradeDir as 1 | -1, ts: tradeTs, entry, stop: sl, target: tp, second: tradeIs2, outcome, r, dollars: r * risk * pv });
  };

  bars.forEach((b, i) => {
    const mins = et(b.ts).mins;
    const open = i === 0;
    const src = (b.high + b.low + b.close) / 3;
    // NY VWAP, from the open.
    if (open) {
      nySum = src * b.volume;
      nyVol = b.volume;
      nyVwap = src;
    } else {
      nySum += src * b.volume;
      nyVol += b.volume;
      nyVwap = nyVol > 0 ? nySum / nyVol : nyVwap;
    }
    // The opening range.
    const since = mins - OPEN;
    if (open) {
      orbH = b.high;
      orbL = b.low;
      orbSet = false;
    } else if (!orbSet) {
      if (since >= 0 && since < p.orMinutes) {
        orbH = Math.max(orbH, b.high);
        orbL = Math.min(orbL, b.low);
      } else if (since >= p.orMinutes) orbSet = true;
    }
    const above = b.close > nyVwap;
    const below = b.close < nyVwap;
    const ref = Number.isNaN(prevVwap) ? nyVwap : prevVwap;
    const crossUp = above && prevClose <= ref;
    const crossDn = below && prevClose >= ref;
    if (open) {
      st = below ? 'BROKE_DN' : above ? 'BROKE_UP' : 'IDLE';
    } else if (st === 'IDLE' && recoverDir === 0 && !dayDone) {
      if (crossDn) st = 'BROKE_DN';
      if (crossUp) st = 'BROKE_UP';
    }
    const inWindow = mins >= winFrom && mins < winTo;
    const canFire = inWindow && orbSet && tradeDir === 0 && !dayDone;
    const dbLong = canFire && st === 'BROKE_DN' && crossUp && !longFired;
    const dbShort = canFire && st === 'BROKE_UP' && crossDn && !shortFired;
    const db2Long = canFire && p.recovery && recoverDir === 1 && !db2Used && crossUp;
    const db2Short = canFire && p.recovery && recoverDir === -1 && !db2Used && crossDn;
    if (dbLong || db2Long) {
      let stop = orbL - p.stopBuffer;
      if (b.close - stop > capPts) stop = b.close - capPts;
      const risk = Math.max(b.close - stop, tick);
      tradeDir = 1;
      entry = b.close;
      sl = stop;
      tp = b.close + risk * p.rMultiple;
      tradeIdx = i;
      tradeTs = b.ts;
      tradeIs2 = db2Long;
      st = 'IDLE';
      recoverDir = 0;
      if (db2Long) db2Used = true;
      else longFired = true;
    }
    if (dbShort || db2Short) {
      let stop = orbH + p.stopBuffer;
      if (stop - b.close > capPts) stop = b.close + capPts;
      const risk = Math.max(stop - b.close, tick);
      tradeDir = -1;
      entry = b.close;
      sl = stop;
      tp = b.close - risk * p.rMultiple;
      tradeIdx = i;
      tradeTs = b.ts;
      tradeIs2 = db2Short;
      st = 'IDLE';
      recoverDir = 0;
      if (db2Short) db2Used = true;
      else shortFired = true;
    }
    // A trade already open is checked on the bars after its entry; the target is looked at first, as in the script.
    if (tradeDir !== 0 && i > tradeIdx) {
      const hitTp = tradeDir === 1 ? b.high >= tp : b.low <= tp;
      const hitSl = tradeDir === 1 ? b.low <= sl : b.high >= sl;
      if (hitTp) {
        settle('win', tp);
        dayDone = true;
        recoverDir = 0;
        tradeDir = 0;
      } else if (hitSl) {
        settle('loss', sl);
        if (p.recovery && !tradeIs2 && !db2Used && inWindow) recoverDir = tradeDir === 1 ? 1 : -1;
        else {
          dayDone = true;
          recoverDir = 0;
        }
        tradeDir = 0;
      }
    }
    prevClose = b.close;
    prevVwap = nyVwap;
  });
  // Still open at the close: counted at the last price, so nothing hides as "unfinished".
  if (tradeDir !== 0 && bars.length) settle('time', bars[bars.length - 1]!.close);
  return trades;
}

/** The bars of each New York session (09:30 to 16:00 ET), by Eastern day, from 1-minute bars. */
export function sessionsOf(bars1m: Bar[], minutes = 5): Map<string, Bar[]> {
  const days = new Map<string, Bar[]>();
  for (const b of aggregate(bars1m, minutes)) {
    const { day, mins } = et(b.ts);
    if (mins < OPEN || mins >= CLOSE || b.volume < 0) continue;
    const list = days.get(day) ?? [];
    list.push(b);
    days.set(day, list);
  }
  // A day with only a stub of bars (a holiday, a half-loaded day) isn't a session.
  for (const [day, list] of days) if (list.length < 40) days.delete(day);
  return days;
}

export function simulate(sessions: Map<string, Bar[]>, symbol: Symbol, p: PineParams, only?: Set<string>): SimTrade[] {
  const out: SimTrade[] = [];
  for (const [day, bars] of [...sessions].sort(([a], [b]) => (a < b ? -1 : 1))) if (!only || only.has(day)) out.push(...simDay(day, symbol, bars, p, INSTRUMENTS[symbol].tick));
  return out;
}

export function metrics(trades: SimTrade[]): PineMetrics {
  const n = trades.length;
  const wins = trades.filter((t) => t.r > 0).length;
  const totalR = trades.reduce((a, t) => a + t.r, 0);
  let peak = 0;
  let run = 0;
  let dd = 0;
  for (const t of [...trades].sort((a, b) => a.ts - b.ts)) {
    run += t.r;
    peak = Math.max(peak, run);
    dd = Math.max(dd, peak - run);
  }
  const won = trades.filter((t) => t.r > 0).reduce((a, t) => a + t.r, 0);
  const lost = Math.abs(trades.filter((t) => t.r < 0).reduce((a, t) => a + t.r, 0));
  const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
  const mean = n ? totalR / n : 0;
  const std = n > 1 ? Math.sqrt(trades.reduce((a, t) => a + (t.r - mean) ** 2, 0) / (n - 1)) : 0;
  return { trades: n, wins, winRate: n ? round(wins / n, 3) : 0, totalR: round(totalR), avgR: n ? round(totalR / n, 3) : 0, maxDrawdownR: round(dd), stdR: round(std), profitFactor: lost > 0 ? round(won / lost) : won > 0 ? null : 0, dollars: Math.round(trades.reduce((a, t) => a + t.dollars, 0)) };
}
