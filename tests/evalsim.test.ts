import test from 'node:test';
import assert from 'node:assert/strict';
import type { PaperTrade, PropRules } from '../src/shared/trading.ts';
import { PROP_ACCOUNTS } from '../src/shared/trading.ts';
import { evalOdds, runEval, weekdays } from '../src/shared/evalsim.ts';

const rules = (id: string): PropRules => PROP_ACCOUNTS.find((a) => a.id === id)!;
const day = (n: number) => `2026-09-${String(n).padStart(2, '0')}`;
/** An NQ trade with a 20-point stop ($40 a micro) that makes `r` risks. */
const trade = (d: number, r: number, k = 0): PaperTrade => ({ id: `t${d}-${k}`, day: day(d), symbol: 'NQ', playbook: 'double-break', side: 'long', entryAt: d * 1000 + k, entry: 100, stop: 80, target: 140, exitAt: d * 1000 + k + 1, exit: 100 + 20 * r, outcome: r > 0 ? 'win' : 'loss', r, dollars: 40 * r, why: '' });

test('a steady winner passes, and the ledger shows the Law of 10 sizing each day', () => {
  const run = runEval(Array.from({ length: 20 }, (_, i) => trade(i + 1, 2)), rules('topstep-50k'));
  assert.equal(run.result, 'passed');
  // A $2,000 cushion risks $200: five micros on a $40 stop, so the first day makes 5 x $80.
  assert.equal(run.ledger[0]!.risk, 200);
  assert.equal(run.ledger[0]!.micros, 5);
  assert.equal(run.ledger[0]!.pnl, 400);
  assert.equal(run.ledger.length, run.days);
  assert.ok(run.pnl >= 3000);
  assert.ok(run.tradingDays >= rules('topstep-50k').minTradingDays);
});

test('the pass waits for the minimum trading days', () => {
  // One enormous day reaches the target at once, but an eval needs its days.
  const r = { ...rules('lucidflex-50k'), consistencyPercent: 100 };
  const run = runEval([trade(1, 20), trade(2, 0.1), trade(3, 0.1)], r);
  assert.equal(run.targetDay, 1);
  assert.equal(run.result, 'running');
  assert.match(run.why, /trading days/);
});

test('the consistency rule holds a pass back until no one day is too much of the profit', () => {
  const big = [trade(1, 16), ...Array.from({ length: 6 }, (_, i) => trade(i + 2, 0.05))];
  const held = runEval(big, rules('topstep-50k'));
  assert.equal(held.result, 'running');
  assert.match(held.why, /best day/);
  assert.ok(held.bestDayShare! > 0.5);
  assert.equal(runEval(big, rules('topstep-50k'), { consistency: false }).result, 'passed');
});

test('a fixed risk that is too big busts; the Law of 10 only bleeds', () => {
  const losers = Array.from({ length: 30 }, (_, i) => trade(i + 1, -1));
  const fixed = runEval(losers, rules('apex-50k'), { fixedRisk: 600, dailyStop: false });
  assert.equal(fixed.result, 'busted');
  assert.equal(fixed.ledger.at(-1)!.note, 'Hit the floor');
  const law = runEval(losers, rules('apex-50k'));
  assert.equal(law.result, 'running');
  assert.ok(law.pnl < 0 && law.minCushion > 0);
});

test('the daily stop ends the day after three losses', () => {
  const rough = [0, 1, 2, 3, 4].map((k) => trade(1, -1, k));
  const run = runEval(rough, rules('lucidflex-100k'));
  assert.equal(run.ledger[0]!.taken, 3);
  assert.equal(run.ledger[0]!.skipped, 2);
  assert.equal(runEval(rough, rules('lucidflex-100k'), { dailyStop: false }).ledger[0]!.taken, 5);
});

test('a day nothing was traded on still counts as a day, and starting from a real balance starts there', () => {
  const run = runEval([trade(2, 1)], rules('lucidflex-50k'), { start: { balance: 51_000, peak: 51_200 } }, [day(1), day(2), day(3)]);
  assert.equal(run.days, 3);
  assert.equal(run.tradingDays, 1);
  assert.equal(run.ledger[0]!.balance, 51_000);
  // The floor trails the $51,200 peak by $2,000 but locks at the starting balance: $49,200.
  assert.equal(run.ledger[0]!.floor, 49_200);
});

test('the odds add up, are repeatable, and tell a winner from a loser', () => {
  const winners = Array.from({ length: 20 }, (_, i) => trade(i + 1, i % 3 === 0 ? -1 : 2));
  const a = evalOdds(winners, rules('topstep-50k'), {}, undefined, { runs: 200, horizon: 40 });
  const b = evalOdds(winners, rules('topstep-50k'), {}, undefined, { runs: 200, horizon: 40 });
  assert.deepEqual(a, b);
  assert.ok(Math.abs(a.pass + a.bust + a.running - 1) < 1e-9);
  assert.ok(a.pass > 0.8);
  assert.equal(a.p50.length, 41);
  assert.ok(a.p10.every((v, i) => v <= a.p90[i]!));
  const losers = evalOdds(Array.from({ length: 20 }, (_, i) => trade(i + 1, -1)), rules('topstep-50k'), {}, undefined, { runs: 100, horizon: 40 });
  assert.equal(losers.pass, 0);
  assert.equal(evalOdds([], rules('topstep-50k')).runs, 0);
});

test('weekdays drops the weekend days only Bitcoin trades', () => {
  assert.deepEqual(weekdays(['2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28']), ['2026-09-25', '2026-09-28']);
});
