import test from 'node:test';
import assert from 'node:assert/strict';
import type { PaperTrade } from '../src/shared/trading.ts';
import { datasetHash, fingerprint, leakCheck, sliceStats, splitDays, validate, type Candidate } from '../src/shared/validation.ts';
import { FARM_DEFAULTS } from '../src/shared/farm.ts';

const day = (n: number) => `2026-09-${String(n).padStart(2, '0')}`;
const DAYS = Array.from({ length: 28 }, (_, i) => day(i + 1));
const DAY_MS = 86_400_000;
const T0 = Date.parse('2026-09-01T14:00:00Z');
/** A trade on day `d` (1-based), the `k`th of that day, that makes `r` risks on a 20-point NQ stop. */
const trade = (d: number, k: number, r: number): PaperTrade => ({ id: `t${d}-${k}`, day: day(d), symbol: 'NQ', playbook: 'double-break', side: 'long', entryAt: T0 + (d - 1) * DAY_MS + k * 600_000, entry: 100, stop: 80, target: 140, exitAt: T0 + (d - 1) * DAY_MS + k * 600_000 + 300_000, exit: 100 + 20 * r, outcome: r > 0 ? 'win' : 'loss', r, dollars: 40 * r, why: '', mae: r < 0 ? 20 : 2, mfe: r > 0 ? 20 * r : 2 });
/** A baseline that wins a little more than it loses, the same every day: four trades a day, +2R, −1R, −1R, +2R… */
const pattern = [2, -1, -1, 2, -1, -1];
const baselineTrades = DAYS.flatMap((_, i) => Array.from({ length: 4 }, (_, k) => trade(i + 1, k, pattern[(i * 4 + k) % pattern.length]!)));
const baseline: Candidate = { id: 'base', name: 'Baseline', family: 'double-break', trades: baselineTrades };

test('the days split half, a quarter and a quarter, in order, and the last quarter is the holdout', () => {
  const s = splitDays(DAYS);
  assert.deepEqual([s.train.length, s.validation.length, s.holdout.length], [14, 7, 7]);
  assert.deepEqual([s.train[0], s.validation[0], s.holdout[0], s.holdout.at(-1)], [day(1), day(15), day(22), day(28)]);
  // Given out of order, or twice, it is the same split.
  assert.deepEqual(splitDays([...DAYS].reverse().concat(DAYS)), s);
  const st = sliceStats(baselineTrades, s.train, 'gross');
  assert.deepEqual([st.trades, st.days], [56, 14]);
  assert.ok(st.avgR < sliceStats(baselineTrades, s.train, 'gross').avgR + 1e-9 && sliceStats(baselineTrades, s.train, 'stressed').avgR < st.avgR);
});

test('a candidate overfit to the days it was picked on looks great there and fails the untouched holdout', () => {
  const split = splitDays(DAYS);
  const seen = new Set([...split.train, ...split.validation]);
  // Picked with hindsight: on the days it could see, it skips every loser. On the holdout it is the baseline.
  const overfit: Candidate = { id: 'overfit', name: 'Skip the losers', family: 'double-break', trades: baselineTrades.filter((t) => !seen.has(t.day) || t.r > 0) };
  const before = validate(overfit, baseline, { days: DAYS, searchCount: 20, minTrades: 8 });
  assert.equal(before.verdict, 'promising');
  assert.equal(before.holdout, null);
  assert.ok(before.z > before.hurdle && before.hurdle > 2);
  const opened = validate(overfit, baseline, { days: DAYS, searchCount: 20, minTrades: 8, openHoldout: true });
  assert.equal(opened.verdict, 'failed-holdout');
  assert.equal(opened.holdout!.cand.avgR, opened.holdout!.base.avgR);
  assert.match(opened.reasons.at(-1)!, /On the untouched holdout .* did not carry/);
});

test('a real edge that carries onto the holdout is held; a small one is inconclusive once many variants were tried', () => {
  // Better everywhere, holdout included: every loss is half the size.
  const better: Candidate = { id: 'better', name: 'Tighter stop', family: 'double-break', trades: baselineTrades.map((t) => (t.r < 0 ? { ...t, r: -0.2, dollars: -8 } : t)) };
  const r = validate(better, baseline, { days: DAYS, searchCount: 3, minTrades: 8, openHoldout: true });
  assert.equal(r.verdict, 'held');
  assert.ok(r.holdout!.cand.avgR > r.holdout!.base.avgR);
  // A sliver of an edge: fine for one try, not when it was the best of two hundred.
  const sliver: Candidate = { id: 'sliver', name: 'A sliver', family: 'double-break', trades: baselineTrades.map((t) => (t.r < 0 ? { ...t, r: -0.75, dollars: -30 } : t)) };
  const many = validate(sliver, baseline, { days: DAYS, searchCount: 200, minTrades: 8 });
  assert.equal(many.verdict, 'inconclusive');
  assert.match(many.reasons[0]!, /with 200 variants tried, luck alone reaches 3\.26/);
  // Worse than the baseline: rejected, plainly.
  const worse: Candidate = { id: 'worse', name: 'Worse', family: 'double-break', trades: baselineTrades.map((t) => (t.r > 0 ? { ...t, r: 1, dollars: 40 } : t)) };
  assert.equal(validate(worse, baseline, { days: DAYS, searchCount: 1, minTrades: 8 }).verdict, 'rejected');
  // Positive gross but under water once it pays stressed costs: rejected, and it says why.
  const thin = (r: number, dollars: number): Candidate => ({ id: 'thin', name: 'Thin', family: 'x', trades: baselineTrades.map((t, i) => ({ ...t, r: i % 2 ? r : -r + 0.04, dollars: i % 2 ? dollars : -dollars + 1.6 })) });
  const thinBase: Candidate = { ...thin(1, 40), id: 'thin-base', trades: thin(1, 40).trades.map((t) => ({ ...t, r: t.r - 0.03, dollars: t.dollars - 1.2 })) };
  const costly = validate(thin(1, 40), thinBase, { days: DAYS, searchCount: 1, minTrades: 8 });
  assert.equal(costly.verdict, 'rejected');
  assert.match(costly.reasons[0]!, /Under stressed costs it loses money/);
  // Too few trades to say anything.
  assert.equal(validate({ ...better, trades: better.trades.slice(0, 10) }, baseline, { days: DAYS, searchCount: 1 }).verdict, 'inconclusive');
});

test('a shuffled or leaky candidate is caught and never judged', () => {
  const split = splitDays(DAYS);
  assert.deepEqual(leakCheck(baseline, DAYS, split), []);
  // Shuffled: the days are swapped between trades, so a later day holds an earlier trade.
  const shuffled: Candidate = { ...baseline, id: 'shuffled', trades: baselineTrades.map((t, i) => ({ ...t, day: baselineTrades[(i * 37) % baselineTrades.length]!.day })) };
  const leaks = leakCheck(shuffled, DAYS, split);
  assert.ok(leaks.some((l) => /the days have been shuffled/.test(l)));
  const r = validate(shuffled, baseline, { days: DAYS, searchCount: 1, minTrades: 8, openHoldout: true });
  assert.equal(r.verdict, 'leaky');
  // A leaky candidate never gets its look at the holdout.
  assert.equal(r.holdout, null);
  // Picked on the holdout's own days.
  assert.match(leakCheck({ ...baseline, selectedOn: DAYS }, DAYS, split)[0]!, /picked using 7 of the holdout’s 7 days/);
  // The same trade twice, a trade that ends before it starts, a trade on a day that isn't in the data.
  const odd = leakCheck({ ...baseline, trades: [baselineTrades[0]!, baselineTrades[0]!, { ...baselineTrades[1]!, exitAt: baselineTrades[1]!.entryAt - 1 }, { ...baselineTrades[2]!, day: '2027-01-01' }] }, DAYS, split);
  assert.ok(odd.some((l) => /counted twice/.test(l)) && odd.some((l) => /before it starts/.test(l)) && odd.some((l) => /aren’t in the data/.test(l)));
});

test('the same data and settings give the same report, to the fingerprint; anything different gives another', () => {
  const better: Candidate = { id: 'better', name: 'Tighter stop', family: 'double-break', trades: baselineTrades.map((t) => (t.r < 0 ? { ...t, r: -0.5, dollars: -20 } : t)) };
  const farm = { ...FARM_DEFAULTS, slots: 1, evalMicros: 5, strategy: { ...FARM_DEFAULTS.strategy, playbooks: ['double-break' as const] } };
  const o = { days: DAYS, searchCount: 4, minTrades: 8, farm, runs: 40 };
  const a = validate(better, baseline, o);
  const b = validate(better, baseline, o);
  assert.deepEqual(a, b);
  assert.ok(a.account && a.account.cand.runs === 40 && a.account.cand.p50 >= a.account.base.p50);
  assert.deepEqual(a.stress.map((s) => s.cost), ['gross', 'base', 'stressed']);
  assert.ok(a.stress[0]!.cand > a.stress[1]!.cand && a.stress[1]!.cand > a.stress[2]!.cand);
  assert.notEqual(validate(better, baseline, { ...o, searchCount: 5 }).id, a.id);
  assert.notEqual(validate(better, baseline, { ...o, seed: 12 }).id, a.id);
  assert.notEqual(validate(better, baseline, { ...o, openHoldout: true }).id, a.id);
  assert.equal(fingerprint({ a: 1 }), fingerprint({ a: 1 }));
  assert.notEqual(fingerprint({ a: 1 }), fingerprint({ a: 2 }));
  assert.notEqual(datasetHash(DAYS, baselineTrades), datasetHash(DAYS, baselineTrades.slice(1)));
});
