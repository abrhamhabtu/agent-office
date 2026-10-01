import type { Bar, Levels, PaperTrade, PlaybookId, ProposalStage, Symbol, Zone } from '../../shared/trading.js';
import { INSTRUMENTS, PLAYBOOK_BY_ID } from '../../shared/trading.js';
import { settingsOf, type Tuning } from '../../shared/tuning.js';
import type { ManagedR, ManageId } from '../../shared/manage.js';

// The playbooks as code. A trading day's one-minute bars are replayed in order through four scanners,
// one per playbook, the way you'd sit through the session watching them: that one replay is what the
// boards show live (where each playbook is up to right now), what the paper book fills (every setup
// that triggered, stopped or hit its target), and, run over past days, what the backtest counts. The
// same code for all three, so a backtest and the morning's proposals can never disagree.
//
// Times are Pacific. A futures trading day runs from the Globex open at 15:00 PT the day before to the
// 13:00 PT close; the New York session (RTH) is 06:30–13:00, the opening range is its first 15 minutes.

export const RTH_OPEN = 390;
export const RTH_CLOSE = 780;
const OR_END = 405;
const GLOBEX_OPEN = 900;

// ---- Pacific time, fast -----------------------------------------------------------------------------
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
/** Pacific's offset from UTC by the hour: it only changes on the hour, twice a year. */
const offsets = new Map<number, number>();
function offsetAt(ts: number): number {
  const hour = Math.floor(ts / 3_600_000);
  let off = offsets.get(hour);
  if (off === undefined) {
    const p = Object.fromEntries(fmt.formatToParts(new Date(hour * 3_600_000)).map((x) => [x.type, x.value]));
    off = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!) - hour * 3_600_000;
    if (offsets.size > 5000) offsets.clear();
    offsets.set(hour, off);
  }
  return off;
}
/** Pacific date (YYYY-MM-DD), minutes since midnight and weekday (0 Sunday) of a moment. */
export function pacific(ts: number): { date: string; minutes: number; seconds: number; weekday: number } {
  const local = ts + offsetAt(ts);
  const d = new Date(local);
  const seconds = Math.floor((local % 86_400_000) / 1000);
  return { date: d.toISOString().slice(0, 10), minutes: Math.floor(seconds / 60), seconds, weekday: d.getUTCDay() };
}
const nextDate = (date: string) => new Date(Date.parse(`${date}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
/** The trading day a moment belongs to: from 15:00 PT on, it's already tomorrow's session. */
export function tradingDay(ts: number): string {
  const p = pacific(ts);
  return p.minutes >= GLOBEX_OPEN ? nextDate(p.date) : p.date;
}
/** Minutes into the trading day's clock: Globex bars (after 15:00) come out negative, before the midnight ones. */
export function sessionMinute(ts: number): number {
  const m = pacific(ts).minutes;
  return m >= GLOBEX_OPEN ? m - 1440 : m;
}

// ---- Indicators ----------------------------------------------------------------------------------------
const round = (v: number, tick: number) => Math.round(v / tick) * tick;

class Ema {
  value: number | null = null;
  constructor(private n: number) {}
  push(v: number) {
    const k = 2 / (this.n + 1);
    this.value = this.value == null ? v : v * k + this.value * (1 - k);
  }
}
class Atr {
  value: number | null = null;
  private prev: number | null = null;
  private seen = 0;
  private sum = 0;
  constructor(private n: number) {}
  push(b: Bar) {
    const tr = this.prev == null ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - this.prev), Math.abs(b.low - this.prev));
    this.prev = b.close;
    if (this.seen < this.n) {
      this.sum += tr;
      this.seen++;
      this.value = this.sum / this.seen;
    } else this.value = (this.value! * (this.n - 1) + tr) / this.n;
  }
}
/** Wilder's RSI. */
class Rsi {
  value: number | null = null;
  private prev: number | null = null;
  private up = 0;
  private down = 0;
  private seen = 0;
  constructor(private n: number) {}
  push(v: number) {
    if (this.prev != null) {
      const d = v - this.prev;
      const u = Math.max(0, d);
      const dn = Math.max(0, -d);
      if (this.seen < this.n) {
        this.up += u / this.n;
        this.down += dn / this.n;
      } else {
        this.up = (this.up * (this.n - 1) + u) / this.n;
        this.down = (this.down * (this.n - 1) + dn) / this.n;
      }
      this.seen++;
      if (this.seen >= this.n) this.value = this.down === 0 ? 100 : 100 - 100 / (1 + this.up / this.down);
    }
    this.prev = v;
  }
}
/** Wilder's ADX: how strongly the market is trending, whichever way. */
class Adx {
  value: number | null = null;
  private prev: Bar | null = null;
  private tr = 0;
  private plus = 0;
  private minus = 0;
  private dxSum = 0;
  private seen = 0;
  constructor(private n: number) {}
  push(b: Bar) {
    const p = this.prev;
    this.prev = b;
    if (!p) return;
    const tr = Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close));
    const upMove = b.high - p.high;
    const downMove = p.low - b.low;
    const plus = upMove > downMove && upMove > 0 ? upMove : 0;
    const minus = downMove > upMove && downMove > 0 ? downMove : 0;
    this.seen++;
    if (this.seen <= this.n) {
      this.tr += tr;
      this.plus += plus;
      this.minus += minus;
      if (this.seen < this.n) return;
    } else {
      this.tr += tr - this.tr / this.n;
      this.plus += plus - this.plus / this.n;
      this.minus += minus - this.minus / this.n;
    }
    if (!(this.tr > 0)) return;
    const pdi = (100 * this.plus) / this.tr;
    const mdi = (100 * this.minus) / this.tr;
    const dx = pdi + mdi > 0 ? (100 * Math.abs(pdi - mdi)) / (pdi + mdi) : 0;
    const k = this.seen - this.n;
    if (k < this.n) {
      this.dxSum += dx;
      if (k === this.n - 1) this.value = this.dxSum / this.n;
    } else this.value = (this.value! * (this.n - 1) + dx) / this.n;
  }
}
class Vwap {
  private pv = 0;
  private pv2 = 0;
  private v = 0;
  push(b: Bar) {
    const typical = (b.high + b.low + b.close) / 3;
    const vol = Math.max(1, b.volume);
    this.pv += typical * vol;
    this.pv2 += typical * typical * vol;
    this.v += vol;
  }
  get value(): number | null {
    return this.v ? this.pv / this.v : null;
  }
  get sd(): number {
    if (!this.v) return 0;
    const m = this.pv / this.v;
    return Math.sqrt(Math.max(0, this.pv2 / this.v - m * m));
  }
}

/** A fixed-range volume profile, a bar's volume spread evenly over the bins it traded through. */
export class Profile {
  private bins = new Map<number, number>();
  total = 0;
  bars = 0;
  constructor(private bin: number) {}
  push(b: Bar) {
    const lo = Math.floor(b.low / this.bin);
    const hi = Math.floor(b.high / this.bin);
    const vol = Math.max(1, b.volume);
    const each = vol / (hi - lo + 1);
    for (let k = lo; k <= hi; k++) this.bins.set(k, (this.bins.get(k) ?? 0) + each);
    this.total += vol;
    this.bars++;
  }
  /** Point of control and the value area around it (70% of the volume). */
  value(): { poc: number; vah: number; val: number } | null {
    if (!this.bins.size) return null;
    const keys = [...this.bins.keys()].sort((a, b) => a - b);
    let pocK = keys[0]!;
    for (const k of keys) if (this.bins.get(k)! > this.bins.get(pocK)!) pocK = k;
    let lo = keys.indexOf(pocK);
    let hi = lo;
    let inside = this.bins.get(pocK)!;
    const want = this.total * 0.7;
    while (inside < want && (lo > 0 || hi < keys.length - 1)) {
      const up = hi < keys.length - 1 ? this.bins.get(keys[hi + 1]!)! : -1;
      const down = lo > 0 ? this.bins.get(keys[lo - 1]!)! : -1;
      if (up >= down) inside += this.bins.get(keys[++hi]!)!;
      else inside += this.bins.get(keys[--lo]!)!;
    }
    return { poc: (pocK + 0.5) * this.bin, vah: (keys[hi]! + 1) * this.bin, val: keys[lo]! * this.bin };
  }
}

// ---- Managing a trade other ways -----------------------------------------------------------------------

/**
 * A trade followed under one other way of managing it (see shared/manage.ts): what's still on, where
 * its stop and target are now, and what has been banked. It runs beside the playbook's own trade and
 * can outlast it: a trailed runner is still going after the written target was hit.
 */
interface Shadow {
  style: Exclude<ManageId, 'written'>;
  stop: number;
  target: number | null;
  /** What's still held: each unit's entry and its share of the first position. */
  units: { entry: number; size: number }[];
  /** R already banked. */
  banked: number;
  /** The +1R step has been taken. */
  moved: boolean;
  best: number;
  done: boolean;
}
const STYLES: Shadow['style'][] = ['be', 'half', 'trail', 'add'];

/** One bar of a managed trade. Like the playbook's own: the stop is looked at first, then the target. */
function stepShadow(sh: Shadow, t: PaperTrade, b: Bar, flat: boolean) {
  const d = t.side === 'long' ? 1 : -1;
  const risk = Math.abs(t.entry - t.stop);
  const out = (price: number) => {
    for (const u of sh.units) sh.banked += (u.size * (price - u.entry) * d) / risk;
    sh.units = [];
    sh.done = true;
  };
  if (d > 0 ? b.low <= sh.stop : b.high >= sh.stop) return out(sh.stop);
  if (sh.target != null && (d > 0 ? b.high >= sh.target : b.low <= sh.target)) return out(sh.target);
  const one = t.entry + d * risk;
  if (!sh.moved && (d > 0 ? b.high >= one : b.low <= one)) {
    sh.moved = true;
    sh.stop = t.entry;
    if (sh.style === 'half') {
      sh.banked += 0.5;
      sh.units[0]!.size = 0.5;
    } else if (sh.style === 'add') sh.units.push({ entry: one, size: 1 });
    else if (sh.style === 'trail') sh.target = null;
  }
  sh.best = d > 0 ? Math.max(sh.best, b.high) : Math.min(sh.best, b.low);
  // The trail only ever tightens, one risk behind the best price so far; it takes effect from the next bar.
  if (sh.style === 'trail' && sh.moved) sh.stop = d > 0 ? Math.max(sh.stop, sh.best - risk) : Math.min(sh.stop, sh.best + risk);
  if (flat) out(b.close);
}

/** Where a managed trade stands: what it banked, and what it still holds marked at `price`. */
function shadowR(sh: Shadow, t: PaperTrade, price: number): number {
  const d = t.side === 'long' ? 1 : -1;
  const risk = Math.abs(t.entry - t.stop);
  return Math.round((sh.banked + sh.units.reduce((a, u) => a + (u.size * (price - u.entry) * d) / risk, 0)) * 100) / 100;
}

// ---- Replaying a day ------------------------------------------------------------------------------------

/** Where one playbook is up to on one market, for the proposals board. */
export interface ScanView {
  stage: ProposalStage;
  side: 'long' | 'short' | null;
  title: string;
  checks: { label: string; ok: boolean }[];
  entry: number | null;
  stop: number | null;
  target: number | null;
  note: string;
}

export interface DayResult {
  levels: Levels;
  trades: PaperTrade[];
  views: Record<PlaybookId, ScanView>;
  /** The last bar the replay saw. */
  lastClose: number | null;
}

interface Ctx {
  i: number;
  b: Bar;
  prev: Bar | null;
  bars: Bar[];
  m: number;
  vwap: number | null;
  vwapPast: number | null;
  onVwap: number | null;
  orHigh: number | null;
  orLow: number | null;
  atr1: number;
  atr5: number;
  ema9: number | null;
  ema21: number | null;
  value: { poc: number; vah: number; val: number } | null;
  profileBars: number;
  zones: Zone[];
  sr: SrLevel[];
  avgVol: number;
}

export interface SrLevel {
  price: number;
  touches: number;
  label: string;
}

interface Signal {
  side: 'long' | 'short';
  entry: number;
  stop: number;
  target: number;
  why: string;
}

interface Scanner {
  id: PlaybookId;
  /** One bar. Returns a signal to open a paper trade on its close. */
  step(c: Ctx, open: boolean): Signal | null;
  view(c: Ctx | null): ScanView;
}

const view = (stage: ProposalStage, title: string, extra: Partial<ScanView> = {}): ScanView => ({ stage, side: null, title, checks: [], entry: null, stop: null, target: null, note: '', ...extra });

// Evan Dyer: the trend is set, price comes all the way back to NY VWAP, and bounces. One attempt a session.
function vwapPullback(symbol: Symbol, k: Record<string, number>): Scanner {
  const buf = INSTRUMENTS[symbol].buffers.vwap;
  const tick = INSTRUMENTS[symbol].tick;
  let phase: 'wait' | 'trend' | 'touched' | 'done' | 'sliced' = 'wait';
  let side: 'long' | 'short' = 'long';
  let swing = 0;
  let touchExt = 0;
  let touchAt = 0;
  let checks: ScanView['checks'] = [];
  const dir = (s: 'long' | 'short') => (s === 'long' ? 1 : -1);
  return {
    id: 'vwap-pullback',
    step(c) {
      if (phase === 'done' || c.vwap == null || c.m < RTH_OPEN + 5 || c.m >= k.lastEntry!) return null;
      const { b, vwap } = c;
      const slope = c.vwapPast == null ? 0 : vwap - c.vwapPast;
      const up = c.ema9 != null && c.ema21 != null && c.ema9 > c.ema21 && b.close > vwap && slope > 0;
      const down = c.ema9 != null && c.ema21 != null && c.ema9 < c.ema21 && b.close < vwap && slope < 0;
      checks = [
        { label: 'Trend on the 5m (9 over 21 EMA)', ok: side === 'long' ? !!(c.ema9 != null && c.ema21 != null && c.ema9 > c.ema21) : !!(c.ema9 != null && c.ema21 != null && c.ema9 < c.ema21) },
        { label: 'NY VWAP sloping with it', ok: side === 'long' ? slope > 0 : slope < 0 },
        { label: 'Overnight VWAP agrees (bias)', ok: c.onVwap == null ? false : side === 'long' ? b.close > c.onVwap : b.close < c.onVwap },
        { label: 'Price came all the way back to VWAP', ok: phase === 'touched' },
      ];
      if (phase === 'wait' || phase === 'sliced') {
        if (up || down) {
          phase = 'trend';
          side = up ? 'long' : 'short';
          swing = side === 'long' ? b.high : b.low;
        }
        return null;
      }
      const d = dir(side);
      if (phase === 'trend') {
        swing = side === 'long' ? Math.max(swing, b.high) : Math.min(swing, b.low);
        const away = (swing - vwap) * d >= k.away! * buf;
        const tagged = side === 'long' ? b.low <= vwap + 2 * tick : b.high >= vwap - 2 * tick;
        if (tagged && away) {
          phase = 'touched';
          touchAt = c.i;
          touchExt = side === 'long' ? b.low : b.high;
        } else if (!(side === 'long' ? up : down) && (b.close - vwap) * d < 0) phase = 'wait';
        if (phase !== 'touched') return null;
      }
      // Touched: bounce with the trend, or slice through and stand aside.
      touchExt = side === 'long' ? Math.min(touchExt, b.low) : Math.max(touchExt, b.high);
      if ((vwap - b.close) * d > buf) {
        phase = 'sliced';
        return null;
      }
      if (c.i - touchAt > k.wait!) {
        phase = 'trend';
        swing = side === 'long' ? b.high : b.low;
        return null;
      }
      const bounce = (b.close - b.open) * d > 0 && (b.close - vwap) * d > 0 && c.prev != null && (b.close - (side === 'long' ? c.prev.high : c.prev.low)) * d > 0;
      if (!bounce) return null;
      // An extra rule the tuner can switch on: only with the night's bias behind it.
      if (k.bias && (c.onVwap == null || (b.close - c.onVwap) * d <= 0)) return null;
      const entry = b.close;
      const stop = round(touchExt - d * buf * k.stop!, tick);
      const risk = (entry - stop) * d;
      if (risk <= 0) return null;
      const target = k.swing && (swing - entry) * d >= 1.5 * risk ? swing : round(entry + d * k.target! * risk, tick);
      phase = 'done';
      return { side, entry, stop, target, why: `Bounced off NY VWAP ${vwap.toFixed(2)} with the trend${b.volume > c.avgVol ? ', volume up' : ''}` };
    },
    view(c) {
      if (!c || c.vwap == null) return view('off', 'Waiting for the New York open');
      if (c.m < RTH_OPEN + 5) return view('off', 'Opens after the first 5 minutes', { checks });
      if (phase === 'done') return view('done', 'Took today’s one attempt', { side, checks });
      if (c.m >= k.lastEntry!) return view('off', 'Best in the first hours: done for today', { checks });
      const d = dir(side);
      if (phase === 'wait' || phase === 'sliced')
        return view('watching', phase === 'sliced' ? 'Sliced through VWAP: trend in doubt, standing aside' : 'No clean trend: sitting on hands', { checks, note: 'If price does not come to VWAP, that is a valid non-trade.' });
      const entry = round(c.vwap, INSTRUMENTS[symbol].tick);
      const stop = round(c.vwap - d * buf * 1.5, INSTRUMENTS[symbol].tick);
      const risk = Math.abs(entry - stop);
      const target = (swing - entry) * d >= 1.5 * risk ? swing : round(entry + d * 2 * risk, INSTRUMENTS[symbol].tick);
      const near = Math.abs(c.b.close - c.vwap) <= Math.max(2 * buf, c.atr1);
      return view(phase === 'touched' || near ? 'ready' : 'watching', phase === 'touched' ? 'At VWAP: waiting for the bounce candle' : `${side === 'long' ? 'Uptrend' : 'Downtrend'}: wait for the pullback to VWAP`, { side, checks, entry, stop, target, note: 'Do not enter while price is still moving into VWAP. Let it tap and bounce.' });
    },
  };
}

// Evan Dyer's double break: the 15-minute opening range sets, then price breaks the range AND NY VWAP
// the same way. Enter the retest of the level it broke. No VWAP break, no trade.
function doubleBreak(symbol: Symbol, _k: Record<string, number>): Scanner {
  const buf = INSTRUMENTS[symbol].buffers.doubleBreak;
  const tick = INSTRUMENTS[symbol].tick;
  let phase: 'wait' | 'armed' | 'retest' | 'done' = 'wait';
  let side: 'long' | 'short' = 'long';
  let ext = 0;
  let checks: ScanView['checks'] = [];
  const level = (c: Ctx) => (side === 'long' ? Math.max(c.orHigh!, c.vwap!) : Math.min(c.orLow!, c.vwap!));
  return {
    id: 'double-break',
    step(c) {
      if (phase === 'done' || c.orHigh == null || c.orLow == null || c.vwap == null || c.m < OR_END || c.m >= 600) return null;
      const { b, vwap } = c;
      const longBreak = b.close > c.orHigh && b.close > vwap;
      const shortBreak = b.close < c.orLow && b.close < vwap;
      if (phase === 'wait') {
        if (longBreak || shortBreak) {
          phase = 'armed';
          side = longBreak ? 'long' : 'short';
        }
      }
      const d = side === 'long' ? 1 : -1;
      checks = [
        { label: '15-min opening range set', ok: true },
        { label: `Broke the range ${side === 'long' ? 'high' : 'low'}`, ok: phase !== 'wait' && (side === 'long' ? b.high > c.orHigh : b.low < c.orLow) },
        { label: `Broke NY VWAP ${side === 'long' ? 'up' : 'down'}`, ok: phase !== 'wait' && (b.close - vwap) * d > 0 },
        { label: 'Retest of the broken level', ok: phase === 'retest' },
      ];
      if (phase === 'wait') return null;
      const lv = level(c);
      // Back inside the range and through VWAP: the break failed.
      if ((side === 'long' ? b.close < Math.min(c.orHigh, vwap) : b.close > Math.max(c.orLow, vwap))) {
        phase = 'wait';
        return null;
      }
      if (phase === 'armed') {
        if (side === 'long' ? b.low <= lv + buf * 0.5 : b.high >= lv - buf * 0.5) {
          phase = 'retest';
          ext = side === 'long' ? b.low : b.high;
        }
        return null;
      }
      ext = side === 'long' ? Math.min(ext, b.low) : Math.max(ext, b.high);
      if ((b.close - lv) * d > 0 && (b.close - b.open) * d > 0) {
        const entry = b.close;
        const stop = round((side === 'long' ? Math.min(ext, lv) : Math.max(ext, lv)) - d * buf, tick);
        const risk = (entry - stop) * d;
        if (risk <= 0) return null;
        phase = 'done';
        return { side, entry, stop, target: round(entry + d * 2 * risk, tick), why: `Broke the opening range and VWAP ${side === 'long' ? 'up' : 'down'}, held the retest at ${lv.toFixed(2)}` };
      }
      return null;
    },
    view(c) {
      if (!c || c.orHigh == null || c.orLow == null || c.vwap == null || c.m < OR_END) return view('off', c && c.m >= RTH_OPEN ? 'Opening range is still setting' : 'Waits for the 15-minute opening range', { checks });
      if (phase === 'done') return view('done', 'Took the double break', { side, checks });
      if (c.m >= 600) return view('off', 'Morning window closed', { checks });
      if (phase === 'wait') return view('watching', `Range ${c.orLow.toFixed(2)}–${c.orHigh.toFixed(2)}: waiting for a break with VWAP`, { checks, note: 'Only trade when the range AND NY VWAP break the same way.' });
      const d = side === 'long' ? 1 : -1;
      const lv = round(level(c), tick);
      const stop = round(lv - d * buf * 1.5, tick);
      return view('ready', phase === 'retest' ? 'Retesting the break: waiting for the hold' : `Double break ${side === 'long' ? 'up' : 'down'}: wait for the retest`, { side, checks, entry: lv, stop, target: round(lv + d * 2 * Math.abs(lv - stop), tick) });
    },
  };
}

// Octavia: zones drawn off the small basing candle before a big 5m impulse. Fresh zones only, first retest,
// a rejection close in the zone's direction. Supply zones short, demand zones long, never the other way.
function supplyDemand(symbol: Symbol, _k: Record<string, number>): Scanner {
  const buf = INSTRUMENTS[symbol].buffers.zone;
  const tick = INSTRUMENTS[symbol].tick;
  let retest: { zone: Zone; at: number; ext: number } | null = null;
  let taken = 0;
  let checks: ScanView['checks'] = [];
  return {
    id: 'supply-demand',
    step(c, open) {
      const { b } = c;
      // A zone price trades into is tested (its first retest is the one worth trading); a close through it breaks it.
      for (const z of c.zones) {
        if (z.state === 'broken') continue;
        const inside = z.kind === 'demand' ? b.low <= z.top : b.high >= z.bottom;
        const through = z.kind === 'demand' ? b.close < z.bottom - buf : b.close > z.top + buf;
        if (through) {
          z.state = 'broken';
          if (retest?.zone === z) retest = null;
        } else if (inside && z.state === 'fresh') {
          z.state = 'tested';
          if (!retest && !open && taken < 3 && c.m >= RTH_OPEN && c.m < 630) retest = { zone: z, at: c.i, ext: z.kind === 'demand' ? b.low : b.high };
        }
      }
      if (!retest) return null;
      const z = retest.zone;
      const d = z.kind === 'demand' ? 1 : -1;
      retest.ext = d > 0 ? Math.min(retest.ext, b.low) : Math.max(retest.ext, b.high);
      if (c.i - retest.at > 10) {
        retest = null;
        return null;
      }
      const hi3 = Math.max(...c.bars.slice(Math.max(0, c.i - 3), c.i).map((x) => x.high));
      const lo3 = Math.min(...c.bars.slice(Math.max(0, c.i - 3), c.i).map((x) => x.low));
      const rejected = d > 0 ? b.close > z.top && b.close > b.open : b.close < z.bottom && b.close < b.open;
      const choch = d > 0 ? b.close > hi3 : b.close < lo3;
      checks = [
        { label: `Fresh ${z.kind} zone ${z.bottom.toFixed(2)}–${z.top.toFixed(2)}`, ok: true },
        { label: 'First retest into the zone', ok: true },
        { label: 'Rejection close or 1m CHoCH', ok: rejected || choch },
      ];
      if (!(rejected || choch)) return null;
      const entry = b.close;
      const stop = round(d > 0 ? z.bottom - buf : z.top + buf, tick);
      const risk = (entry - stop) * d;
      if (risk <= 0) return null;
      // Aim at the next fresh zone the other way, or two risks out.
      const opp = c.zones.filter((o) => o.state === 'fresh' && o.kind !== z.kind && (d > 0 ? o.bottom > entry : o.top < entry)).map((o) => (d > 0 ? o.bottom : o.top));
      const nearest = opp.length ? (d > 0 ? Math.min(...opp) : Math.max(...opp)) : null;
      const target = nearest != null && (nearest - entry) * d >= 1.5 * risk ? nearest : round(entry + d * 2 * risk, tick);
      retest = null;
      taken++;
      return { side: d > 0 ? 'long' : 'short', entry, stop, target, why: `${z.kind === 'demand' ? 'Demand' : 'Supply'} held on the first retest (${z.bottom.toFixed(2)}–${z.top.toFixed(2)})` };
    },
    view(c) {
      if (!c) return view('off', 'Waiting for bars');
      const price = c.b.close;
      const fresh = c.zones.filter((z) => z.state === 'fresh');
      const demand = fresh.filter((z) => z.top < price).sort((a, b) => b.top - a.top)[0];
      const supply = fresh.filter((z) => z.bottom > price).sort((a, b) => a.bottom - b.bottom)[0];
      if (retest) {
        const z = retest.zone;
        const d = z.kind === 'demand' ? 1 : -1;
        const entry = d > 0 ? z.top : z.bottom;
        const stop = round(d > 0 ? z.bottom - buf : z.top + buf, tick);
        return view('ready', `In the ${z.kind} zone: waiting for the rejection`, { side: d > 0 ? 'long' : 'short', checks, entry, stop, target: round(entry + d * 2 * Math.abs(entry - stop), tick) });
      }
      const pick = !demand ? supply : !supply ? demand : price - demand.top <= supply.bottom - price ? demand : supply;
      if (!pick) return view('watching', 'No fresh zones near price', { note: 'Zones come from a small basing candle right before a big 5m impulse.' });
      const d = pick.kind === 'demand' ? 1 : -1;
      const entry = d > 0 ? pick.top : pick.bottom;
      const stop = round(d > 0 ? pick.bottom - buf : pick.top + buf, tick);
      const near = Math.abs(price - entry) <= Math.max(c.atr5 * 0.6, buf);
      const inWindow = c.m >= RTH_OPEN && c.m < 630;
      return view(!inWindow ? 'off' : near ? 'ready' : 'watching', `${d > 0 ? 'Long' : 'Short'} the first retest of fresh ${pick.kind}`, {
        side: d > 0 ? 'long' : 'short',
        checks: [
          { label: `Fresh ${pick.kind} ${pick.bottom.toFixed(2)}–${pick.top.toFixed(2)}`, ok: true },
          { label: 'Morning rush (06:30–10:30 PT)', ok: inWindow },
          { label: 'Price at the zone', ok: near },
        ],
        entry,
        stop,
        target: round(entry + d * 2 * Math.abs(entry - stop), tick),
        note: taken >= 3 ? 'Three zone trades today: done.' : '',
      });
    },
  };
}

// Chanelle: price is pushed to the edge of value (VAL cheap, VAH expensive), the auction stalls, and a
// candle BODY closes back through the last imbalance. A fixed stop, a fixed 1.5R. Never off POC.
function failedAuction(symbol: Symbol, k: Record<string, number>): Scanner {
  const stopPts = INSTRUMENTS[symbol].buffers.auctionStop * k.stop!;
  const tick = INSTRUMENTS[symbol].tick;
  let edge: { side: 'long' | 'short'; at: number; extAt: number; ext: number; poc: number } | null = null;
  let taken = 0;
  let checks: ScanView['checks'] = [];
  // Any session (Globex, London, New York), but flat by the close: no new trade in the last half hour.
  // The tuner can keep it to the New York session.
  const allowed = (m: number) => m < 750 && (!k.nyOnly || m >= RTH_OPEN);
  return {
    id: 'failed-auction',
    step(c, open) {
      const v = c.value;
      if (!v || c.profileBars < 90 || open || taken >= k.maxTrades! || !allowed(c.m)) {
        edge = null;
        return null;
      }
      const { b } = c;
      if (!edge) {
        if (b.low <= v.val) edge = { side: 'long', at: c.i, extAt: c.i, ext: b.low, poc: v.poc };
        else if (b.high >= v.vah) edge = { side: 'short', at: c.i, extAt: c.i, ext: b.high, poc: v.poc };
        else return null;
      }
      const d = edge.side === 'long' ? 1 : -1;
      if (d > 0 ? b.low < edge.ext : b.high > edge.ext) {
        edge.ext = d > 0 ? b.low : b.high;
        edge.extAt = c.i;
      }
      // Auction resolved without us, or took too long.
      if ((b.close - v.poc) * d >= 0 || c.i - edge.at > 60) {
        edge = null;
        return null;
      }
      const stalled = c.i - edge.extAt >= k.stall!;
      // The last imbalance made on the push into the edge: a three-bar gap the move left behind.
      let gap: number | null = null;
      for (let k = c.i - 1; k >= Math.max(2, edge.at - 25); k--) {
        const a = c.bars[k - 2]!;
        const z = c.bars[k]!;
        if (d > 0 && a.low > z.high) {
          gap = a.low;
          break;
        }
        if (d < 0 && a.high < z.low) {
          gap = a.high;
          break;
        }
      }
      // No imbalance on the push, no trigger: Chanelle only takes the inversion.
      const trigger = gap;
      const bodyThrough = trigger != null && (b.close - trigger) * d > 0 && (b.close - b.open) * d > 0;
      const room = (v.poc - b.close) * d >= stopPts * k.room!;
      checks = [
        { label: `Pushed to ${d > 0 ? 'VAL' : 'VAH'} ${(d > 0 ? v.val : v.vah).toFixed(2)}`, ok: true },
        { label: `Auction stalled (no new extreme for ${k.stall} bars)`, ok: stalled },
        { label: 'Body closed back through the imbalance', ok: bodyThrough },
        { label: `At least ${k.room}R of room to POC`, ok: room },
      ];
      if (!stalled || !bodyThrough || !room) return null;
      const entry = b.close;
      const stop = round(entry - d * stopPts, tick);
      const target = round(entry + d * k.target! * stopPts, tick);
      edge = null;
      taken++;
      return { side: d > 0 ? 'long' : 'short', entry, stop, target, why: `Failed auction at ${d > 0 ? 'VAL' : 'VAH'}: body closed back through ${trigger!.toFixed(2)}; POC ${v.poc.toFixed(2)} is the magnet` };
    },
    view(c) {
      if (!c || !c.value || c.profileBars < 90) return view('off', 'Building the session’s volume profile');
      const v = c.value;
      if (edge) {
        const d = edge.side === 'long' ? 1 : -1;
        const entry = round(c.b.close, tick);
        return view('ready', `At ${d > 0 ? 'VAL' : 'VAH'}: waiting for the auction to fail`, { side: edge.side, checks, entry, stop: round(entry - d * stopPts, tick), target: round(entry + d * k.target! * stopPts, tick), note: 'No body close through the imbalance, no trade.' });
      }
      if (taken >= k.maxTrades!) return view('done', 'Auction trades for today: done');
      if (!allowed(c.m)) return view('off', 'Outside the session window');
      const price = c.b.close;
      const long = price - v.val <= v.vah - price;
      const d = long ? 1 : -1;
      const entry = round(long ? v.val : v.vah, tick);
      const nearPoc = Math.abs(price - v.poc) < (v.vah - v.val) * 0.2;
      return view('watching', nearPoc ? 'Price at POC: fair value, two-way chop. Hands off.' : `Watching ${long ? 'VAL' : 'VAH'} ${entry.toFixed(2)} for a failed auction`, {
        side: long ? 'long' : 'short',
        checks: [
          { label: `Value area ${v.val.toFixed(2)}–${v.vah.toFixed(2)}, POC ${v.poc.toFixed(2)}`, ok: true },
          { label: 'Away from POC', ok: !nearPoc },
          { label: `Price at ${long ? 'VAL' : 'VAH'}`, ok: false },
        ],
        entry,
        stop: round(entry - d * stopPts, tick),
        target: round(entry + d * k.target! * stopPts, tick),
        note: 'Longs only from VAL, shorts only from VAH.',
      });
    },
  };
}

// Support and resistance: a level price has respected (three touches or more on the 5m, or yesterday's and
// the overnight extremes). Bounce off it on a rejection candle, or trade the break and retest. Each level
// once a day, the stop just past it, the target at the next level (or two risks out).
function supportResistance(symbol: Symbol, k: Record<string, number>): Scanner {
  const buf = INSTRUMENTS[symbol].buffers.zone * k.stop!;
  const tick = INSTRUMENTS[symbol].tick;
  const used = new Set<number>();
  const broke = new Map<number, { dir: 1 | -1; at: number }>();
  let taken = 0;
  let checks: ScanView['checks'] = [];
  const tolOf = (c: Ctx) => Math.max(tick * 4, c.atr5 * 0.25);
  const nextLevel = (c: Ctx, from: number, d: 1 | -1) => {
    const beyond = c.sr.map((l) => l.price).filter((p) => (p - from) * d > 0);
    return beyond.length ? (d > 0 ? Math.min(...beyond) : Math.max(...beyond)) : null;
  };
  return {
    id: 'support-resistance',
    step(c, open) {
      if (!c.sr.length || !c.prev) return null;
      const { b, prev } = c;
      const tol = tolOf(c);
      // Breaks: a close clean through a level, from the other side.
      for (const l of c.sr) {
        if (prev.close <= l.price + tol && b.close > l.price + tol && prev.close < l.price) broke.set(l.price, { dir: 1, at: c.i });
        if (prev.close >= l.price - tol && b.close < l.price - tol && prev.close > l.price) broke.set(l.price, { dir: -1, at: c.i });
      }
      if (open || taken >= k.maxTrades! || c.m < RTH_OPEN || c.m >= k.lastEntry!) return null;
      for (const l of c.sr) {
        if (used.has(l.price)) continue;
        const brk = broke.get(l.price);
        // Bounce: came from above into support and rejected it (or the mirror at resistance).
        const supportBounce = prev.close > l.price && b.low <= l.price + tol && b.close > l.price && (Math.min(b.open, b.close) - b.low >= (b.high - b.low) * 0.5 || (b.close > b.open && b.close > prev.high));
        const resistBounce = prev.close < l.price && b.high >= l.price - tol && b.close < l.price && (b.high - Math.max(b.open, b.close) >= (b.high - b.low) * 0.5 || (b.close < b.open && b.close < prev.low));
        // Break and retest: broke through within the last 20 bars, came back to it, and held.
        const retestLong = brk?.dir === 1 && c.i - brk.at > 1 && c.i - brk.at <= 20 && b.low <= l.price + tol && b.close > l.price && b.close > b.open;
        const retestShort = brk?.dir === -1 && c.i - brk.at > 1 && c.i - brk.at <= 20 && b.high >= l.price - tol && b.close < l.price && b.close < b.open;
        // The tuner can keep it to bounces (1) or to breaks and retests (2).
        const bounces = k.mode !== 2;
        const retests = k.mode !== 1;
        const d: 1 | -1 | 0 = (bounces && supportBounce) || (retests && retestLong) ? 1 : (bounces && resistBounce) || (retests && retestShort) ? -1 : 0;
        if (!d) continue;
        const kind = retests && (d > 0 ? retestLong : retestShort) && !(bounces && (d > 0 ? supportBounce : resistBounce)) ? 'break and retest' : 'bounce';
        checks = [
          { label: `${l.label} ${l.price.toFixed(2)} (${l.touches} touches)`, ok: true },
          { label: kind === 'bounce' ? 'Rejection candle at the level' : 'Broke it, came back, held', ok: true },
        ];
        const entry = b.close;
        const stop = round(l.price - d * buf, tick);
        const risk = (entry - stop) * d;
        if (risk <= 0) continue;
        const nxt = nextLevel(c, entry, d);
        const target = nxt != null && (nxt - entry) * d >= 1.5 * risk ? nxt : round(entry + d * k.target! * risk, tick);
        used.add(l.price);
        taken++;
        return { side: d > 0 ? 'long' : 'short', entry, stop, target, why: `${kind === 'bounce' ? 'Bounced off' : 'Retested and held'} ${l.label.toLowerCase()} ${l.price.toFixed(2)}` };
      }
      return null;
    },
    view(c) {
      if (!c || !c.sr.length) return view('off', 'Marking the levels');
      if (taken >= k.maxTrades!) return view('done', 'Level trades for today: done');
      const price = c.b.close;
      const tol = tolOf(c);
      const below = c.sr.filter((l) => l.price < price && !used.has(l.price)).sort((a, b) => b.price - a.price)[0];
      const above = c.sr.filter((l) => l.price > price && !used.has(l.price)).sort((a, b) => a.price - b.price)[0];
      const pick = !below ? above : !above ? below : price - below.price <= above.price - price ? below : above;
      if (!pick) return view('watching', 'No level near price');
      const d = pick.price < price ? 1 : -1;
      const stop = round(pick.price - d * buf, tick);
      const nxt = nextLevel(c, pick.price, d as 1 | -1);
      const risk = Math.abs(pick.price - stop);
      const target = nxt != null && Math.abs(nxt - pick.price) >= 1.5 * risk ? nxt : round(pick.price + d * 2 * risk, tick);
      const near = Math.abs(price - pick.price) <= Math.max(tol * 2, c.atr1 * 1.5);
      const inWindow = c.m >= RTH_OPEN && c.m < k.lastEntry!;
      return view(!inWindow ? 'off' : near ? 'ready' : 'watching', `${d > 0 ? 'Support' : 'Resistance'} at ${pick.price.toFixed(2)}: ${d > 0 ? 'buy' : 'sell'} the rejection`, {
        side: d > 0 ? 'long' : 'short',
        checks: [
          { label: `${pick.label} (${pick.touches} touches)`, ok: pick.touches >= k.touches! || /yesterday|overnight/i.test(pick.label) },
          { label: 'Price at the level', ok: near },
          { label: 'Rejection candle (wick or engulfing)', ok: false },
        ],
        entry: round(pick.price, tick),
        stop,
        target,
        note: 'Or wait for a clean break and trade the retest.',
      });
    },
  };
}

/** Levels the 5m swings keep turning at: pivots within a quarter of an ATR of each other, three or more of them. */
function swingLevels(fives: Bar[], atr: number | null, touches = 3): SrLevel[] {
  if (fives.length < 10 || !atr) return [];
  const pivots: number[] = [];
  for (let i = 2; i < fives.length - 2; i++) {
    const b = fives[i]!;
    const around = [fives[i - 2]!, fives[i - 1]!, fives[i + 1]!, fives[i + 2]!];
    if (around.every((x) => x.high < b.high)) pivots.push(b.high);
    if (around.every((x) => x.low > b.low)) pivots.push(b.low);
  }
  pivots.sort((a, b) => a - b);
  const out: SrLevel[] = [];
  const tol = atr * 0.25;
  let group: number[] = [];
  const flush = () => {
    if (group.length >= touches) out.push({ price: group.reduce((a, v) => a + v, 0) / group.length, touches: group.length, label: 'Tested level' });
    group = [];
  };
  for (const p of pivots) {
    if (group.length && p - group[0]! > tol) flush();
    group.push(p);
  }
  flush();
  return out;
}

const SCANNERS: Record<PlaybookId, (s: Symbol, k: Record<string, number>) => Scanner> = { 'vwap-pullback': vwapPullback, 'double-break': doubleBreak, 'supply-demand': supplyDemand, 'support-resistance': supportResistance, 'failed-auction': failedAuction };

/** Finds new zones on the 5m chart: a small basing candle, then an impulse that leaves it. */
function spotZone(fives: Bar[], atr: number | null, zones: Zone[]) {
  if (fives.length < 2 || !atr) return;
  const base = fives[fives.length - 2]!;
  const imp = fives[fives.length - 1]!;
  const baseRange = base.high - base.low;
  const impRange = imp.high - imp.low;
  const impBody = Math.abs(imp.close - imp.open);
  if (baseRange > atr * 0.7 || impRange < atr * 1.5 || impBody < impRange * 0.6) return;
  const up = imp.close > imp.open;
  const baseBody = base.close - base.open;
  const baseAgrees = Math.abs(baseBody) <= baseRange * 0.15 || (baseBody > 0) === up;
  if (!baseAgrees) return;
  if (up ? imp.close - base.high < atr * 0.8 : base.low - imp.close < atr * 0.8) return;
  zones.push({ kind: up ? 'demand' : 'supply', top: base.high, bottom: base.low, at: base.ts, state: 'fresh' });
  while (zones.length > 14) zones.shift();
}

/**
 * Replays a trading day's bars through every playbook. `prior` is the trading day before (for the prior
 * day's high and low, the zones still fresh from it, and indicators that need a run-up).
 */
export function replayDay(symbol: Symbol, bars: Bar[], prior: Bar[], opts: { live?: boolean; tuning?: Tuning; only?: PlaybookId[] } = {}): DayResult {
  const spec = INSTRUMENTS[symbol];
  // `tuning` is a playbook's settings where they differ from how it was written; `only` replays just those playbooks (the tuner's runs).
  const ids = (Object.keys(SCANNERS) as PlaybookId[]).filter((id) => !opts.only || opts.only.includes(id));
  const scanners = ids.map((id) => SCANNERS[id](symbol, settingsOf(id, opts.tuning)));
  const srTouches = settingsOf('support-resistance', opts.tuning).touches!;
  const nyVwap = new Vwap();
  const onVwap = new Vwap();
  const profile = new Profile(spec.profileBin);
  const atr1 = new Atr(14);
  const atr5 = new Atr(14);
  const ema9 = new Ema(9);
  const ema21 = new Ema(21);
  // Not used by any playbook: kept on each trade for the Backtest Lab's filters (see TradeInd).
  const ema50 = new Ema(50);
  const rsi = new Rsi(14);
  const adx = new Adx(14);
  const macdFast = new Ema(12);
  const macdSlow = new Ema(26);
  const macdSignal = new Ema(9);
  let macdHist: number | null = null;
  let fiveCount = 0;
  const lastVols: number[] = [];
  const zones: Zone[] = [];
  const fives: Bar[] = [];
  let five: Bar | null = null;
  const pushFive = (b: Bar) => {
    const bucket = Math.floor(b.ts / 300_000);
    if (five && Math.floor(five.ts / 300_000) !== bucket) {
      fives.push(five);
      atr5.push(five);
      ema9.push(five.close);
      ema21.push(five.close);
      ema50.push(five.close);
      rsi.push(five.close);
      adx.push(five);
      macdFast.push(five.close);
      macdSlow.push(five.close);
      // The signal line only means something once the slow average has had its run-up.
      if (++fiveCount >= 26) {
        const line = macdFast.value! - macdSlow.value!;
        macdSignal.push(line);
        macdHist = line - macdSignal.value!;
      }
      spotZone(fives, atr5.value, zones);
      five = null;
    }
    five = five ? { ...five, high: Math.max(five.high, b.high), low: Math.min(five.low, b.low), close: b.close, volume: five.volume + b.volume } : { ...b, ts: bucket * 300_000 };
  };
  // The day before: warms up the 5m indicators and leaves its zones on the chart.
  const rthPrior = prior.filter((b) => {
    const m = sessionMinute(b.ts);
    return m >= RTH_OPEN && m < RTH_CLOSE;
  });
  const pdSource = rthPrior.length ? rthPrior : prior;
  // Zones from yesterday that price has already been back to aren't fresh any more.
  for (const b of prior) {
    for (const z of zones) {
      if (z.state === 'broken') continue;
      if (z.kind === 'demand' ? b.close < z.bottom - spec.buffers.zone : b.close > z.top + spec.buffers.zone) z.state = 'broken';
      else if (z.kind === 'demand' ? b.low <= z.top : b.high >= z.bottom) z.state = 'tested';
    }
    pushFive(b);
    atr1.push(b);
    lastVols.push(b.volume);
    if (lastVols.length > 20) lastVols.shift();
  }
  let orHigh: number | null = null;
  let orLow: number | null = null;
  let onHigh: number | null = null;
  let onLow: number | null = null;
  const vwapHist: number[] = [];
  const trades: PaperTrade[] = [];
  const open = new Map<PlaybookId, { t: PaperTrade; idx: number }>();
  /** Every trade of the day followed under the other ways of managing it. */
  const shadows: { t: PaperTrade; idx: number; list: Shadow[] }[] = [];
  const day = bars.length ? tradingDay(bars[0]!.ts) : '';
  let volSum = 0;
  let ctx: Ctx | null = null;
  let sr: SrLevel[] = [];
  let srAtFives = -1;
  const pdh = pdSource.length ? Math.max(...pdSource.map((b) => b.high)) : null;
  const pdl = pdSource.length ? Math.min(...pdSource.map((b) => b.low)) : null;
  /** The levels on the chart right now: yesterday's and the overnight extremes, and the 5m's tested levels. */
  const levelsNow = (m: number, price: number): SrLevel[] => {
    if (srAtFives !== fives.length) {
      srAtFives = fives.length;
      sr = swingLevels(fives.slice(-160), atr5.value, srTouches);
    }
    const named: SrLevel[] = [];
    if (pdh != null) named.push({ price: pdh, touches: 1, label: 'Yesterday’s high' });
    if (pdl != null) named.push({ price: pdl, touches: 1, label: 'Yesterday’s low' });
    if (m >= RTH_OPEN && onHigh != null && onLow != null) named.push({ price: onHigh, touches: 1, label: 'Overnight high' }, { price: onLow, touches: 1, label: 'Overnight low' });
    // A tested level right on top of a named one is the named one.
    const tol = (atr5.value ?? 0) * 0.25;
    const all = [...named, ...sr.filter((l) => !named.some((n) => Math.abs(n.price - l.price) <= tol))];
    // Only what's within reach of the tape matters today.
    const reach = (atr5.value ?? 0) * 12;
    return all.filter((l) => !reach || Math.abs(l.price - price) <= reach).map((l) => ({ ...l, price: round(l.price, spec.tick) }));
  };
  const pv = spec.microPointValue;

  const close = (id: PlaybookId, at: number, price: number, outcome: PaperTrade['outcome']) => {
    const o = open.get(id)!;
    const d = o.t.side === 'long' ? 1 : -1;
    const risk = Math.abs(o.t.entry - o.t.stop);
    o.t.exitAt = at;
    o.t.exit = price;
    o.t.outcome = outcome;
    o.t.r = Math.round(((price - o.t.entry) * d * 100) / risk) / 100;
    o.t.dollars = Math.round((price - o.t.entry) * d * pv * 100) / 100;
    open.delete(id);
  };

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    const m = sessionMinute(b.ts);
    // Manage what's open first: a bar that tags both the stop and the target counts as the stop.
    for (const [id, o] of open) {
      if (o.idx === i) continue;
      const long = o.t.side === 'long';
      if (long ? b.low <= o.t.stop : b.high >= o.t.stop) close(id, b.ts, o.t.stop, 'loss');
      else if (long ? b.high >= o.t.target : b.low <= o.t.target) close(id, b.ts, o.t.target, 'win');
      else if (m >= RTH_CLOSE) close(id, b.ts, b.close, 'time');
    }
    for (const s of shadows) if (s.idx !== i) for (const sh of s.list) if (!sh.done) stepShadow(sh, s.t, b, m >= RTH_CLOSE);
    if (m < RTH_OPEN) {
      onVwap.push(b);
      onHigh = onHigh == null ? b.high : Math.max(onHigh, b.high);
      onLow = onLow == null ? b.low : Math.min(onLow, b.low);
    } else if (m < RTH_CLOSE) {
      nyVwap.push(b);
      if (m < OR_END) {
        orHigh = orHigh == null ? b.high : Math.max(orHigh, b.high);
        orLow = orLow == null ? b.low : Math.min(orLow, b.low);
      }
    }
    profile.push(b);
    atr1.push(b);
    pushFive(b);
    volSum += b.volume;
    const vw = nyVwap.value;
    vwapHist.push(vw ?? NaN);
    ctx = {
      i,
      b,
      prev: i ? bars[i - 1]! : null,
      bars,
      m,
      vwap: vw,
      vwapPast: vwapHist.length > 15 && Number.isFinite(vwapHist[vwapHist.length - 16]!) ? vwapHist[vwapHist.length - 16]! : null,
      onVwap: onVwap.value,
      orHigh: m >= OR_END ? orHigh : null,
      orLow: m >= OR_END ? orLow : null,
      atr1: atr1.value ?? 0,
      atr5: atr5.value ?? 0,
      ema9: ema9.value,
      ema21: ema21.value,
      value: profile.value(),
      profileBars: profile.bars,
      zones,
      sr: levelsNow(m, b.close),
      avgVol: volSum / (i + 1),
    };
    const avg20 = lastVols.length ? lastVols.reduce((a, v) => a + v, 0) / lastVols.length : 0;
    for (const s of scanners) {
      const sig = s.step(ctx, open.has(s.id));
      if (sig && !open.has(s.id)) {
        const t: PaperTrade = {
          id: `${day}:${symbol}:${s.id}:${b.ts}`,
          day,
          symbol,
          playbook: s.id,
          side: sig.side,
          entryAt: b.ts,
          entry: round(sig.entry, spec.tick),
          stop: round(sig.stop, spec.tick),
          target: round(sig.target, spec.tick),
          exitAt: null,
          exit: null,
          outcome: 'open',
          r: 0,
          dollars: 0,
          why: sig.why,
          ind: {
            m: m < 0 ? m + 1440 : m,
            ema9: ema9.value,
            ema21: ema21.value,
            ema50: ema50.value,
            rsi: rsi.value == null ? null : Math.round(rsi.value * 10) / 10,
            adx: adx.value == null ? null : Math.round(adx.value * 10) / 10,
            macd: macdHist,
            atr: atr5.value,
            vwap: vw,
            onVwap: onVwap.value,
            relVol: avg20 > 0 ? Math.round((b.volume / avg20) * 100) / 100 : null,
          },
        };
        trades.push(t);
        open.set(s.id, { t, idx: i });
        shadows.push({ t, idx: i, list: STYLES.map((style) => ({ style, stop: t.stop, target: t.target, units: [{ entry: t.entry, size: 1 }], banked: 0, moved: false, best: t.entry, done: false })) });
      }
    }
    lastVols.push(b.volume);
    if (lastVols.length > 20) lastVols.shift();
  }
  // Past the close with nothing left to trade: whatever's still open went flat at the last price.
  const last = bars[bars.length - 1];
  if (last && !opts.live) for (const id of [...open.keys()]) close(id, last.ts, last.close, 'time');
  // What's open live is marked to the tape.
  for (const { t } of open.values()) {
    if (!last) break;
    const d = t.side === 'long' ? 1 : -1;
    t.r = Math.round(((last.close - t.entry) * d * 100) / Math.abs(t.entry - t.stop)) / 100;
    t.dollars = Math.round((last.close - t.entry) * d * pv * 100) / 100;
  }
  // Each trade's other endings; one still running (live, or a runner past the last bar) is marked to the tape.
  if (last) for (const s of shadows) s.t.alt = Object.fromEntries(s.list.map((sh) => [sh.style, shadowR(sh, s.t, last.close)])) as ManagedR;

  const value = profile.value();
  const q = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? null : round(v, spec.tick));
  const sd = nyVwap.sd;
  const levels: Levels = {
    vwap: q(nyVwap.value),
    vwapU1: nyVwap.value == null ? null : q(nyVwap.value + sd),
    vwapL1: nyVwap.value == null ? null : q(nyVwap.value - sd),
    onVwap: q(onVwap.value),
    orHigh: q(orHigh),
    orLow: q(orLow),
    onHigh: q(onHigh),
    onLow: q(onLow),
    priorHigh: pdSource.length ? q(Math.max(...pdSource.map((b) => b.high))) : null,
    priorLow: pdSource.length ? q(Math.min(...pdSource.map((b) => b.low))) : null,
    poc: q(value?.poc),
    vah: q(value?.vah),
    val: q(value?.val),
    zones: zones.filter((z) => z.state !== 'broken').map((z) => ({ ...z })),
    sr: (ctx?.sr ?? []).map((l) => ({ price: l.price, kind: l.price <= (last?.close ?? l.price) ? ('support' as const) : ('resistance' as const), touches: l.touches, label: l.label })),
  };
  const views = {} as Record<PlaybookId, ScanView>;
  for (const s of scanners) {
    const live = [...open.values()].find((o) => o.t.playbook === s.id)?.t;
    const done = [...trades].reverse().find((t) => t.playbook === s.id);
    if (live) {
      views[s.id] = { stage: 'live', side: live.side, title: `In the trade: ${live.why}`, checks: [], entry: live.entry, stop: live.stop, target: live.target, note: `${live.r >= 0 ? '+' : ''}${live.r}R on paper` };
    } else {
      const v = s.view(ctx);
      // A setup that just resolved shows how it went until the playbook has something new.
      if (done && (v.stage === 'done' || v.stage === 'off' || v.stage === 'watching') && ctx && ctx.b.ts - (done.exitAt ?? 0) < 20 * 60_000) {
        views[s.id] = { stage: done.outcome === 'win' ? 'won' : done.outcome === 'loss' ? 'lost' : 'closed', side: done.side, title: `${done.outcome === 'win' ? 'Target hit' : done.outcome === 'loss' ? 'Stopped out' : 'Closed flat'}: ${done.why}`, checks: v.checks, entry: done.entry, stop: done.stop, target: done.target, note: `${done.r >= 0 ? '+' : ''}${done.r}R` };
      } else views[s.id] = v;
    }
  }
  return { levels, trades, views, lastClose: last?.close ?? null };
}

/** Splits bars into trading days, oldest first. */
export function byTradingDay(bars: Bar[]): Map<string, Bar[]> {
  const out = new Map<string, Bar[]>();
  for (const b of bars) {
    const d = tradingDay(b.ts);
    let list = out.get(d);
    if (!list) out.set(d, (list = []));
    list.push(b);
  }
  return out;
}

export const playbookName = (id: PlaybookId) => PLAYBOOK_BY_ID[id].name;
