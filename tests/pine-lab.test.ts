import assert from 'node:assert/strict';
import test from 'node:test';
import type { Bar, PineMetrics } from '../src/shared/trading.ts';
import { applyParams, describeChange, judge, MIN_TRADES, readParams, runLab, stamp, variantsOf } from '../src/server/trading/lab.ts';
import { VWAP_DB_V1_0_0, VWAP_DB_V1_0_1 } from '../src/server/trading/pine-seed.ts';
import { aggregate, metrics, sessionsOf, simulate, V1_PARAMS } from '../src/server/trading/pine-sim.ts';

type Five = [o: number, h: number, l: number, c: number];

/** One New York session as 1-minute bars: each 5-minute bar (open, high, low, close) spelled out so it aggregates back to exactly that. */
function day(dateUtc: string, fives: Five[]): Bar[] {
  const start = Date.parse(`${dateUtc}T13:30:00Z`); // 09:30 EDT
  const out: Bar[] = [];
  fives.forEach(([o, h, l, c], i) => {
    const path = [[o, o], [o, h], [h, l], [l, l], [l, c]] as const;
    path.forEach(([a, b], k) => out.push({ ts: start + (i * 5 + k) * 60_000, open: a, high: Math.max(a, b), low: Math.min(a, b), close: b, volume: 20 }));
  });
  return out;
}

const FLAT: Five = [20_050, 20_052, 20_048, 20_050];
const pad = (head: Five[], tail: Five = FLAT): Five[] => [...head, ...Array.from({ length: 78 - head.length }, () => tail)];

/**
 * 09:30 closes under its midpoint (the trap: price is below NY VWAP), the range sets at 09:45, and at 10:05
 * a close back above NY VWAP inside the window is the double break: long at 19,996, stop under the range.
 */
const SETUP: Five[] = [
  [20_000, 20_010, 19_990, 19_992],
  [19_992, 19_995, 19_975, 19_980],
  [19_980, 19_985, 19_970, 19_975],
  [19_975, 19_990, 19_972, 19_988],
  [19_988, 19_992, 19_980, 19_984],
  [19_984, 19_990, 19_982, 19_986],
  [19_986, 19_987, 19_978, 19_980],
  [19_980, 19_998, 19_979, 19_996],
];
const WIN = pad([...SETUP, [19_996, 20_020, 19_995, 20_018], [20_018, 20_055, 20_015, 20_050]]);
const LOSS = pad([...SETUP, [19_996, 19_997, 19_960, 19_965]], [19_965, 19_966, 19_964, 19_965]);

const run = (fives: Five[], p = V1_PARAMS, symbol: 'NQ' | 'GC' | 'ES' = 'NQ') => simulate(sessionsOf(day('2026-09-01', fives), 5), symbol, p);

test('5-minute bars are built on the clock from 1-minute bars', () => {
  const bars = aggregate(day('2026-09-01', [[10, 14, 8, 12], [12, 13, 9, 11]]), 5);
  assert.deepEqual(bars.map((b) => [b.open, b.high, b.low, b.close, b.volume]), [[10, 14, 8, 12, 100], [12, 13, 9, 11, 100]]);
});

test('a double break the script would take: the trap, the close back through NY VWAP in the window, the stop and the 2R target', () => {
  const [t, ...more] = run(WIN);
  assert.equal(more.length, 0, 'one break, then the day is done');
  assert.equal(t!.dir, 1);
  assert.equal(t!.entry, 19_996);
  // The far side of the opening range (19,970) less a point of room; the risk is 27 points.
  assert.equal(t!.stop, 19_969);
  assert.equal(t!.target, 19_996 + 54);
  assert.equal(t!.outcome, 'win');
  assert.equal(t!.r, 2);
  assert.equal(t!.second, false);
  assert.equal(t!.dollars, 2 * 27 * 2, 'two R of 27 points on an MNQ at $2 a point');
});

test('the stop: a loss is minus one R, and with re-entry off the day is done', () => {
  const [t] = run(LOSS, { ...V1_PARAMS, recovery: false });
  assert.equal(t!.outcome, 'loss');
  assert.equal(t!.r, -1);
  assert.equal(t!.dollars, -54);
  assert.equal(run(LOSS, { ...V1_PARAMS, recovery: false }).length, 1);
});

test('nothing fires outside the window, or before the opening range is set', () => {
  assert.equal(run(WIN, { ...V1_PARAMS, window: '1130-1200' }).length, 0);
  // A 30-minute range isn't set until 10:00, so the 10:05 break is still in time but the stop is wider.
  const wide = run(WIN, { ...V1_PARAMS, orMinutes: 30 });
  assert.equal(wide.length, 1);
  assert.ok(wide[0]!.stop <= 19_969);
});

test('the stop is pulled in to the micro’s dollar cap', () => {
  // $40 on an MNQ at $2 a point is 20 points of risk, tighter than the 27 the range gives.
  const [t] = run(WIN, { ...V1_PARAMS, maxLoss: 40 });
  assert.equal(t!.stop, 19_996 - 20);
  assert.equal(t!.target, 19_996 + 40);
});

test('a short is the mirror of a long, and the target multiple is the settings’', () => {
  const mirror = (f: Five): Five => [40_000 - f[0], 40_000 - f[2], 40_000 - f[1], 40_000 - f[3]];
  const [t] = run(WIN.map(mirror), { ...V1_PARAMS, rMultiple: 1.5 });
  assert.equal(t!.dir, -1);
  assert.equal(t!.entry, 20_004);
  assert.equal(t!.stop, 20_031);
  assert.equal(t!.target, 20_004 - 40.5);
  assert.equal(t!.outcome, 'win');
  assert.equal(t!.r, 1.5);
});

test('a holiday stub or an overnight-only day is not a session', () => {
  assert.equal(sessionsOf(day('2026-09-01', WIN.slice(0, 10)), 5).size, 0);
});

test('metrics: win rate, total and average R, drawdown, profit factor', () => {
  const t = (r: number, i: number) => ({ day: `d${i}`, symbol: 'NQ' as const, dir: 1 as const, ts: i, entry: 1, stop: 0, target: 2, second: false, outcome: r > 0 ? ('win' as const) : ('loss' as const), r, dollars: r * 10 });
  const m = metrics([t(2, 1), t(-1, 2), t(-1, 3), t(2, 4)]);
  assert.deepEqual([m.trades, m.wins, m.winRate, m.totalR, m.avgR, m.maxDrawdownR, m.profitFactor, m.dollars], [4, 2, 0.5, 2, 0.5, 2, 2, 20]);
  assert.equal(m.stdR, 1.73, 'the spread of one trade’s result, in R');
});

const M = (trades: number, avgR: number, dd = 3): PineMetrics => ({ trades, wins: Math.round(trades / 2), winRate: 0.5, totalR: Math.round(trades * avgR * 100) / 100, avgR, maxDrawdownR: dd, stdR: 1.5, profitFactor: 1, dollars: 0 });
const bundle = (all: PineMetrics, inS: PineMetrics, out: PineMetrics) => ({ all, inSample: inS, outSample: out });

test('the lab only calls a change better when it holds up, and says why when it does not', () => {
  const base = bundle(M(40, 0.1), M(26, 0.1), M(14, 0.1));
  // The same gap on few trades is within normal luck; on many it isn't, and the confidence says so.
  assert.equal(judge(base, bundle(M(40, 0.32), M(26, 0.3), M(14, 0.36))).verdict, 'same');
  assert.match(judge(base, bundle(M(40, 0.32), M(26, 0.3), M(14, 0.36))).reason, /normal luck/);
  const big = bundle(M(150, 0.1), M(100, 0.1), M(50, 0.1));
  assert.deepEqual([judge(big, bundle(M(150, 0.32), M(100, 0.3), M(50, 0.36))).verdict, judge(big, bundle(M(150, 0.32), M(100, 0.3), M(50, 0.36))).confidence], ['better', 'low']);
  assert.equal(judge(big, bundle(M(150, 0.4), M(100, 0.4), M(50, 0.4))).confidence, 'medium');
  assert.equal(judge(big, bundle(M(150, 0.7), M(100, 0.7), M(50, 0.7))).confidence, 'high');
  assert.match(judge(base, bundle(M(40, 0.32), M(26, 0.45), M(14, 0.05))).reason, /later days/);
  assert.equal(judge(base, bundle(M(40, 0.32), M(26, 0.45), M(14, 0.05))).verdict, 'same');
  assert.match(judge(base, bundle(M(20, 0.4), M(13, 0.4), M(7, 0.4))).reason, /far fewer trades/);
  assert.equal(judge(base, bundle(M(40, 0.12), M(26, 0.12), M(14, 0.12))).verdict, 'same');
  assert.equal(judge(base, bundle(M(40, -0.2), M(26, -0.2), M(14, -0.2))).verdict, 'worse');
  assert.match(judge(base, bundle(M(40, 0.4, 9), M(26, 0.4), M(14, 0.4))).reason, /drawdown/);
  const thin = judge(bundle(M(MIN_TRADES - 1, 0.1), M(10, 0.1), M(5, 0.1)), bundle(M(40, 0.5), M(26, 0.5), M(14, 0.5)));
  assert.equal(thin.verdict, 'unproven');
  assert.match(thin.reason, /too few/);
  assert.equal(judge(base, bundle(M(40, 0.4), M(38, 0.4), M(2, 0.4))).verdict, 'unproven');
});

test('the script’s settings are read from its code, changed in place, and stamped with a version', () => {
  assert.deepEqual(readParams(VWAP_DB_V1_0_0), V1_PARAMS);
  const changed = { ...V1_PARAMS, orMinutes: 20, stopBuffer: 1.5, maxLoss: 250, rMultiple: 2.5, window: '1000-1130', recovery: false };
  const src = applyParams(VWAP_DB_V1_0_0, changed)!;
  assert.deepEqual(readParams(src), changed);
  // Only those lines moved.
  const a = VWAP_DB_V1_0_0.split('\n');
  const b = src.split('\n');
  assert.equal(a.length, b.length);
  assert.equal(b.filter((l, i) => l !== a[i]).length, 7);
  assert.equal(applyParams('//@version=6\nindicator("x")\n', changed), null, 'not this script: refused, not guessed');
  assert.equal(readParams('plot(close)'), null);
  const stamped = stamp(src, '1.1.0', 'opening range 20 (made by the test lab)');
  assert.ok(stamped.includes('\\"ver\\":\\"1.1.0\\"'));
  assert.ok(stamped.includes('// VWAP Double Break Suite v1.1.0: opening range 20'));
  assert.equal(stamp(stamped, '1.2.0', 'again').split('\n').filter((l) => l.startsWith('// VWAP Double Break Suite v')).length, 1, 'a re-stamp replaces the note');
  assert.ok(stamp(VWAP_DB_V1_0_0, '1.0.9', 'x').includes('\\"ver\\":\\"1.0.9\\"'), 'a version without the field gets it');
  assert.deepEqual(readParams(VWAP_DB_V1_0_1), V1_PARAMS);
});

test('changes read in plain words, and every try changes exactly one setting', () => {
  assert.deepEqual(describeChange(V1_PARAMS, { ...V1_PARAMS, orMinutes: 20, window: '1000-1130' }), ['Opening range 20 minutes (was 15)', 'Window 7:00–8:30 PT (was 7:00–9:00 PT)']);
  assert.deepEqual(describeChange(V1_PARAMS, { ...V1_PARAMS, recovery: false }), ['DB2 re-entry switched off']);
  for (const v of variantsOf(V1_PARAMS)) assert.equal(describeChange(V1_PARAMS, v).length, 1);
  assert.ok(variantsOf(V1_PARAMS).length >= 15);
});

test('the lab runs end to end on real-shaped history: a baseline, every change tried, nothing invented', () => {
  const symbols = ['NQ', 'GC', 'ES'] as const;
  const histories: Record<string, Bar[]> = {};
  for (const s of symbols) {
    histories[s] = [];
    for (let d = 1; d <= 16; d++) histories[s].push(...day(`2026-09-${String(d).padStart(2, '0')}`, d % 4 === 0 ? LOSS : WIN));
  }
  const r = runLab(histories, V1_PARAMS, '1.0.0');
  assert.ok(!('error' in r));
  if ('error' in r) return;
  assert.equal(r.baseline.days, 16);
  assert.equal(r.baseline.all.trades, 48);
  assert.ok(r.baseline.all.avgR > 0);
  assert.equal(r.baseline.symbols.length, 3);
  assert.ok(r.tried.length >= 15 && r.tried.every((x) => x.test.vs && ['better', 'same', 'worse', 'unproven'].includes(x.test.vs.verdict)));
  assert.equal(r.baseline.inSample.trades + r.baseline.outSample.trades, r.baseline.all.trades);
  // Too little history is said plainly.
  assert.match((runLab({ NQ: day('2026-09-01', WIN) }, V1_PARAMS, '1.0.0') as { error: string }).error, /12/);
});

test('a run of the lab is written up: what it loaded, replayed, tried, saved and re-tested', async () => {
  const { reportOf } = await import('../src/server/trading/lab.ts');
  const histories: Record<string, Bar[]> = {};
  for (const s of ['NQ', 'GC', 'ES'] as const) {
    histories[s] = [];
    for (let d = 1; d <= 16; d++) histories[s].push(...day(`2026-09-${String(d).padStart(2, '0')}`, d % 4 === 0 ? LOSS : WIN));
  }
  const res = runLab(histories, V1_PARAMS, '1.0.0');
  assert.ok(!('error' in res));
  if ('error' in res) return;
  const r = reportOf(res, { script: 'vwap-double-break', scriptName: 'VWAP Double Break Suite', version: '1.0.0', bars: { NQ: 1, GC: 2, ES: 3 }, took: 420, saved: null, existing: '1.2.0', retested: ['1.0.1'], now: 1234 });
  assert.deepEqual([r.ranAt, r.took, r.script, r.version, r.days, r.symbols.length], [1234, 420, 'vwap-double-break', '1.0.0', 16, 3]);
  assert.equal(r.baseline.trades, 48);
  assert.equal(r.tried.length, res.tried.length);
  assert.ok(r.tried.every((t) => t.change.length >= 1 && Number.isFinite(t.avgR) && t.reason.length > 0));
  assert.deepEqual([r.saved, r.existing, r.retested], [null, '1.2.0', ['1.0.1']]);
  assert.equal(r.best, res.best ? res.best.change : null);
});
