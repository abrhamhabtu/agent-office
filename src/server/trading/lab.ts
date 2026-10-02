import type { Bar, LabReport, PineMetrics, PineParams, PineTest, Symbol } from '../../shared/trading.js';
import { afterCosts, metrics, sessionsOf, simulate, type SimTrade } from './pine-sim.js';
import { COSTS, REALISTIC } from '../../shared/fills.js';

// The Strategy lab. It replays the live version of the VWAP Double Break Suite on real bars, then tries
// the script's settings one at a time and asks: is this change better, or does it just look better on
// the days it was picked on? A change only counts as better when it beats the live version overall, holds
// up on the later days it wasn't judged on, keeps most of the trades (not just skips the losers) and
// doesn't deepen the drawdown. Thin evidence is called thin. Everything here is paper evidence.

/** Fewer trades than this and the lab says it can't tell. */
export const MIN_TRADES = 20;
const SYMBOLS_TESTED: Symbol[] = ['NQ', 'GC', 'ES'];

// ---- Reading and changing the script's settings -------------------------------------------------------

const RX = {
  orMinutes: /(orMinutes\s*=\s*input\.int\(\s*)(\d+)/,
  stopBuffer: /(stopBufferPts\s*=\s*input\.float\(\s*)(\d+(?:\.\d+)?)/,
  maxLoss: /(maxLossDollars\s*=\s*input\.float\(\s*)(\d+(?:\.\d+)?)/,
  window: /(dbWindow\s*=\s*input\.session\(\s*")(\d{4}-\d{4})(")/,
  recovery: /(allowRecovery\s*=\s*input\.bool\(\s*)(true|false)/,
  long: /(tradeTp\s*:=\s*close\s*\+\s*riskL\s*\*\s*)(\d+(?:\.\d+)?)/,
  short: /(tradeTp\s*:=\s*close\s*-\s*riskS\s*\*\s*)(\d+(?:\.\d+)?)/,
};

/** The settings a script has now, or null when it isn't this kind of script (or one of them can't be found). */
export function readParams(src: string): PineParams | null {
  const m = Object.fromEntries(Object.entries(RX).map(([k, rx]) => [k, rx.exec(src)]));
  if (Object.values(m).some((x) => !x)) return null;
  const long = Number(m.long![2]);
  if (long !== Number(m.short![2])) return null;
  return { orMinutes: Number(m.orMinutes![2]), stopBuffer: Number(m.stopBuffer![2]), maxLoss: Number(m.maxLoss![2]), rMultiple: long, window: m.window![2]!, recovery: m.recovery![2] === 'true' };
}

const lit = (n: number) => (Number.isInteger(n) ? n.toFixed(1) : String(n));

/** The script with new settings, or null if a setting couldn't be found to change. */
export function applyParams(src: string, p: PineParams): string | null {
  let out = src;
  const swap = (rx: RegExp, to: string, tail = false) => {
    if (!rx.test(out)) return false;
    out = out.replace(rx, (_all, a: string, _old: string, b?: string) => `${a}${to}${tail ? b ?? '' : ''}`);
    return true;
  };
  const ok =
    swap(RX.orMinutes, String(p.orMinutes)) && swap(RX.stopBuffer, lit(p.stopBuffer)) && swap(RX.maxLoss, lit(p.maxLoss)) && swap(RX.window, p.window, true) && swap(RX.recovery, String(p.recovery)) && swap(RX.long, lit(p.rMultiple)) && swap(RX.short, lit(p.rMultiple));
  return ok ? out : null;
}

/** The script stamped with a version: its alert says which version sent it, and a comment says what this is. */
export function stamp(src: string, version: string, note: string): string {
  let out = src;
  if (/\\"ver\\":\\"[\d.]+\\"/.test(out)) out = out.replace(/(\\"ver\\":\\")[\d.]+(\\")/, `$1${version}$2`);
  else out = out.replace('"{\\"ticker\\":\\""', `"{\\"ver\\":\\"${version}\\",\\"ticker\\":\\""`);
  out = out.replace(/^\/\/ VWAP Double Break Suite v[\d.]+.*\n/m, '');
  return out.replace('//@version=6\n', `//@version=6\n// VWAP Double Break Suite v${version}: ${note}\n`);
}

const pt = (window: string) => {
  const m = /^(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(window);
  if (!m) return window;
  const f = (h: number, mm: string) => `${(h + 21) % 24 % 12 || 12}:${mm}`;
  return `${f(Number(m[1]), m[2]!)}–${f(Number(m[3]), m[4]!)} PT`;
};

/** What changed between two sets of settings, in plain words. */
export function describeChange(from: PineParams, to: PineParams): string[] {
  const out: string[] = [];
  if (from.orMinutes !== to.orMinutes) out.push(`Opening range ${to.orMinutes} minutes (was ${from.orMinutes})`);
  if (from.stopBuffer !== to.stopBuffer) out.push(`Stop room past the range ${to.stopBuffer} points (was ${from.stopBuffer})`);
  if (from.maxLoss !== to.maxLoss) out.push(`Micro loss cap $${to.maxLoss} (was $${from.maxLoss})`);
  if (from.rMultiple !== to.rMultiple) out.push(`Target ${to.rMultiple}R (was ${from.rMultiple}R)`);
  if (from.window !== to.window) out.push(`Window ${pt(to.window)} (was ${pt(from.window)})`);
  if (from.recovery !== to.recovery) out.push(to.recovery ? 'DB2 re-entry switched on' : 'DB2 re-entry switched off');
  return out;
}

// ---- Testing -------------------------------------------------------------------------------------------

type Verdict = NonNullable<PineTest['vs']>['verdict'];

/** How big the gap is against the noise in this many trades (a z-score of the difference in average R). */
function noiseRatio(base: PineMetrics, v: PineMetrics): number {
  const se = Math.sqrt((base.stdR ** 2) / Math.max(1, base.trades) + (v.stdR ** 2) / Math.max(1, v.trades));
  return se > 0 ? (v.avgR - base.avgR) / se : 0;
}
const confidenceOf = (z: number): 'low' | 'medium' | 'high' => (z >= 2.5 ? 'high' : z >= 1.5 ? 'medium' : 'low');

/** Is `v` better than `base`? Conservative on purpose: every condition has to hold. */
export function judge(base: { all: PineMetrics; inSample: PineMetrics; outSample: PineMetrics }, v: { all: PineMetrics; inSample: PineMetrics; outSample: PineMetrics }): { verdict: Verdict; reason: string; confidence: 'low' | 'medium' | 'high' } {
  const dAvg = Math.round((v.all.avgR - base.all.avgR) * 1000) / 1000;
  const z = noiseRatio(base.all, v.all);
  const confidence = confidenceOf(z);
  const out = (verdict: Verdict, reason: string) => ({ verdict, reason, confidence });
  if (base.all.trades < MIN_TRADES || v.all.trades < MIN_TRADES) return out('unproven', `Only ${Math.min(base.all.trades, v.all.trades)} trades to go on, too few to tell (the lab wants ${MIN_TRADES}+)`);
  if (dAvg < -0.05) return out('worse', `Average ${fmtR(dAvg)} R per trade against the live version`);
  if (Math.abs(dAvg) < 0.1) return out('same', `Within noise: average ${fmtR(dAvg)} R per trade`);
  if (v.all.trades < 0.7 * base.all.trades) return out('same', `Looks better only because it takes far fewer trades (${v.all.trades} against ${base.all.trades})`);
  if (v.outSample.trades < 5) return out('unproven', 'Too few trades on the later days to check it held up');
  if (v.outSample.avgR < base.outSample.avgR) return out('same', `Better overall but not on the later days it wasn't picked on (${fmtR(v.outSample.avgR)} R against ${fmtR(base.outSample.avgR)} R)`);
  if (v.inSample.avgR < base.inSample.avgR - 0.02) return out('same', 'Only the later days improved; the earlier ones got worse');
  if (v.all.maxDrawdownR > base.all.maxDrawdownR * 1.25 + 0.5) return out('same', `Better average but a deeper drawdown (${v.all.maxDrawdownR} R against ${base.all.maxDrawdownR} R)`);
  if (z < 1) return out('same', `${fmtR(dAvg)} R a trade is within normal luck for this many trades`);
  return out('better', `Average ${fmtR(dAvg)} R better per trade, and it held up on the later days (${fmtR(v.outSample.avgR)} R against ${fmtR(base.outSample.avgR)} R)`);
}
const fmtR = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(2)}`;

/** Every single-setting change the lab tries, around the live version's settings. */
export function variantsOf(base: PineParams): PineParams[] {
  const v: PineParams[] = [];
  for (const orMinutes of [10, 20, 30]) if (orMinutes !== base.orMinutes) v.push({ ...base, orMinutes });
  for (const stopBuffer of [0.5, 1.5, 2, 3]) if (stopBuffer !== base.stopBuffer) v.push({ ...base, stopBuffer });
  for (const maxLoss of [200, 250, 400, 500]) if (maxLoss !== base.maxLoss) v.push({ ...base, maxLoss });
  for (const rMultiple of [1.5, 2.5, 3]) if (rMultiple !== base.rMultiple) v.push({ ...base, rMultiple });
  for (const window of ['0930-1130', '1000-1130', '1000-1300', '1030-1200']) if (window !== base.window) v.push({ ...base, window });
  if (base.recovery) v.push({ ...base, recovery: false });
  return v;
}

export interface LabResult {
  baseline: PineTest;
  /** Every change tried, with its verdict. */
  tried: { params: PineParams; change: string[]; test: PineTest }[];
  /** The change worth a new version, if any passed. */
  best: { params: PineParams; change: string[]; test: PineTest } | null;
  note: string;
}

/** Replays `params` over the sessions, split into the days it's judged on and the later days it isn't. */
function evaluate(sessions: Partial<Record<Symbol, Map<string, Bar[]>>>, params: PineParams, train: Set<string>, test: Set<string>, days: string[], now: number): PineTest {
  const all: SimTrade[] = [];
  const real: SimTrade[] = [];
  const bySymbol: PineTest['bySymbol'] = {};
  const symbols = SYMBOLS_TESTED.filter((s) => sessions[s]);
  for (const sym of symbols) {
    const t = simulate(sessions[sym]!, sym, params);
    all.push(...t);
    bySymbol[sym] = metrics(t);
    // The same settings filled the way an order would be, and charged for: the number to judge by.
    real.push(...simulate(sessions[sym]!, sym, params, undefined, REALISTIC));
  }
  return {
    realistic: { all: metrics(afterCosts(real, COSTS.base)), ambiguous: real.filter((t) => t.ambiguous).length, policy: REALISTIC.id, cost: COSTS.base.id },
    ranAt: now,
    from: days[0] ?? '',
    to: days[days.length - 1] ?? '',
    days: days.length,
    symbols,
    all: metrics(all),
    inSample: metrics(all.filter((t) => train.has(t.day))),
    outSample: metrics(all.filter((t) => test.has(t.day))),
    bySymbol,
    params,
    vs: null,
  };
}

/** Tests the live version's settings and every change to them on `histories` (1-minute bars per market). */
export function runLab(histories: Partial<Record<Symbol, Bar[]>>, live: PineParams, liveVersion: string, now = Date.now()): LabResult | { error: string } {
  const sessions: Partial<Record<Symbol, Map<string, Bar[]>>> = {};
  for (const sym of SYMBOLS_TESTED) {
    const bars = histories[sym];
    if (bars?.length) sessions[sym] = sessionsOf(bars, 5);
  }
  const days = [...new Set(Object.values(sessions).flatMap((m) => [...m!.keys()]))].sort();
  if (days.length < 12) return { error: `Only ${days.length} sessions of history so far: the lab needs about 12 to say anything` };
  const cut = Math.ceil((days.length * 2) / 3);
  const train = new Set(days.slice(0, cut));
  const test = new Set(days.slice(cut));
  const baseline = evaluate(sessions, live, train, test, days, now);
  const tried = variantsOf(live).map((params) => {
    const t = evaluate(sessions, params, train, test, days, now);
    const j = judge(baseline, t);
    t.vs = { version: liveVersion, dAvgR: Math.round((t.all.avgR - baseline.all.avgR) * 1000) / 1000, dTotalR: Math.round((t.all.totalR - baseline.all.totalR) * 100) / 100, verdict: j.verdict, reason: j.reason, confidence: j.confidence };
    return { params, change: describeChange(live, params), test: t };
  });
  const better = tried.filter((x) => x.test.vs!.verdict === 'better').sort((a, b) => b.test.outSample.avgR - a.test.outSample.avgR || b.test.all.totalR - a.test.all.totalR);
  let best = better[0] ?? null;
  // Changes that each helped, together: kept only if the combination is itself better and no worse than the best alone.
  if (better.length > 1) {
    const combo: PineParams = { ...live };
    const used = new Set<string>();
    for (const b of better) {
      const key = (Object.keys(b.params) as (keyof PineParams)[]).find((k) => b.params[k] !== live[k])!;
      if (used.has(key)) continue;
      used.add(key);
      (combo as unknown as Record<string, unknown>)[key] = b.params[key];
    }
    if (used.size > 1) {
      const t = evaluate(sessions, combo, train, test, days, now);
      const j = judge(baseline, t);
      t.vs = { version: liveVersion, dAvgR: Math.round((t.all.avgR - baseline.all.avgR) * 1000) / 1000, dTotalR: Math.round((t.all.totalR - baseline.all.totalR) * 100) / 100, verdict: j.verdict, reason: j.reason, confidence: j.confidence };
      tried.push({ params: combo, change: describeChange(live, combo), test: t });
      // Two changes chosen on the same days are likelier to be luck than one: the pair has to clearly beat the best single one.
      if (j.verdict === 'better' && t.outSample.avgR >= best!.test.outSample.avgR + 0.15) best = tried[tried.length - 1]!;
    }
  }
  const note = best
    ? `Found a change that held up: ${best.change.join('; ')}`
    : baseline.all.trades < MIN_TRADES
      ? `Only ${baseline.all.trades} trades in ${days.length} sessions: too few to judge any change yet`
      : `Tried ${tried.length} changes; none beat the live version convincingly on ${days.length} sessions`;
  return { baseline, tried, best, note };
}

/** Replays other saved versions (their own settings) against the live one, so each shows where it stands. */
export function testVersions(histories: Partial<Record<Symbol, Bar[]>>, live: PineParams, liveVersion: string, versions: { version: string; params: PineParams }[], now = Date.now()): Map<string, PineTest> {
  const out = new Map<string, PineTest>();
  const sessions: Partial<Record<Symbol, Map<string, Bar[]>>> = {};
  for (const sym of SYMBOLS_TESTED) if (histories[sym]?.length) sessions[sym] = sessionsOf(histories[sym]!, 5);
  const days = [...new Set(Object.values(sessions).flatMap((m) => [...m!.keys()]))].sort();
  if (days.length < 12) return out;
  const cut = Math.ceil((days.length * 2) / 3);
  const train = new Set(days.slice(0, cut));
  const test = new Set(days.slice(cut));
  const baseline = evaluate(sessions, live, train, test, days, now);
  for (const v of versions) {
    const t = evaluate(sessions, v.params, train, test, days, now);
    const j = judge(baseline, t);
    t.vs = { version: liveVersion, dAvgR: Math.round((t.all.avgR - baseline.all.avgR) * 1000) / 1000, dTotalR: Math.round((t.all.totalR - baseline.all.totalR) * 100) / 100, verdict: j.verdict, reason: j.reason, confidence: j.confidence };
    out.set(v.version, t);
  }
  return out;
}

/** A run of the lab, written up: what it replayed, what it tried, and what came of it. */
export function reportOf(res: LabResult, o: { script: string; scriptName: string; version: string; bars: Partial<Record<Symbol, number>>; took: number; saved: string | null; existing: string | null; retested: string[]; now?: number }): LabReport {
  const b = res.baseline;
  return {
    ranAt: o.now ?? Date.now(),
    took: o.took,
    script: o.script,
    scriptName: o.scriptName,
    version: o.version,
    days: b.days,
    from: b.from,
    to: b.to,
    symbols: b.symbols,
    bars: o.bars,
    baseline: { trades: b.all.trades, avgR: b.all.avgR, totalR: b.all.totalR },
    tried: res.tried.map((t) => ({ change: t.change, trades: t.test.all.trades, avgR: t.test.all.avgR, verdict: t.test.vs!.verdict, confidence: t.test.vs!.confidence, reason: t.test.vs!.reason })),
    saved: o.saved,
    existing: o.existing,
    best: res.best ? res.best.change : null,
    retested: o.retested,
  };
}
