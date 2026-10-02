import test from 'node:test';
import assert from 'node:assert/strict';
import type { PaperTrade } from '../src/shared/trading.ts';
import { cleanSetup, FARM_DEFAULTS, FARM_PROGRAMS, farmDays, farmOdds, runFarm, strategyLabel, type FarmSetup } from '../src/shared/farm.ts';
import { ACCOUNT_CATALOG } from '../src/shared/prop-catalog.ts';

const day = (n: number) => `2026-09-${String(n).padStart(2, '0')}`;
/** An NQ double-break trade with a 20-point stop ($40 a micro) that makes `r` risks. */
const trade = (d: number, r: number, k = 0): PaperTrade => ({ id: `t${d}-${k}`, day: day(d), symbol: 'NQ', playbook: 'double-break', side: 'long', entryAt: d * 1000 + k, entry: 100, stop: 80, target: 140, exitAt: d * 1000 + k + 1, exit: 100 + 20 * r, outcome: r > 0 ? 'win' : 'loss', r, dollars: 40 * r, why: '' });
const setup = (o: Partial<FarmSetup> = {}): FarmSetup => ({ ...FARM_DEFAULTS, programId: 'fundednext-rapid-25k', slots: 1, maxAttempts: 1, evalMicros: 10, fundedMicros: 2, strategy: { playbooks: ['double-break'], mode: 'every', manage: 'written', markets: ['NQ', 'ES', 'GC'] }, ...o });
const lists = (...days: PaperTrade[][]) => days;

test('every farm program points at accounts the catalog has', () => {
  for (const p of FARM_PROGRAMS) {
    assert.ok(ACCOUNT_CATALOG.some((a) => a.id === p.fundedId && a.kind === 'funded'), p.id);
    if (p.evalId) assert.ok(ACCOUNT_CATALOG.some((a) => a.id === p.evalId && a.kind === 'eval'), p.id);
    assert.ok(p.fee > 0 && p.split > 0 && p.split <= 1, p.id);
  }
  // The three firms the owner means to use are all there.
  assert.deepEqual([...new Set(FARM_PROGRAMS.map((p) => p.firm))], ['Lucid', 'Top One', 'FundedNext']);
});

test('one account goes from the fee to the payout: evaluation, funded, parked, paid', () => {
  // Two winning days at 10 micros pass the $1,500 evaluation. Then 2 micros make $160 a day: the payout
  // needs $500 and no day over 40%, so it is ready after the fourth funded day, and paid the day after.
  const run = runFarm(lists(...Array.from({ length: 8 }, (_, i) => [trade(i + 1, 2)])), setup());
  const stages = run.cells.map((c) => c[0]!.stage);
  assert.deepEqual(stages, ['eval', 'eval', 'funded', 'funded', 'funded', 'parked', 'funded', 'funded']);
  assert.deepEqual(run.events.filter((e) => e.kind !== 'trade').map((e) => `${e.day}:${e.kind}:${e.account}`), ['0:bought:EVAL-1', '1:passed:EVAL-1', '2:bought:FUNDED-1', '5:payout-ready:FUNDED-1', '6:paid:FUNDED-1']);
  assert.equal(run.cells[1]![0]!.balance, 26_600);
  assert.equal(run.cells[5]![0]!.balance, 25_640);
  // $640 of profit at a 90% share is $576, less the $80 fee.
  assert.equal(run.payouts, 576);
  assert.equal(run.fees, 80);
  assert.deepEqual(run.cash, [-80, -80, -80, -80, -80, -80, 496, 496]);
  // Paid, it starts again from its opening balance and keeps trading.
  assert.equal(run.cells[7]![0]!.balance, 25_160);
  assert.equal(run.passed, 1);
  assert.equal(run.payoutCount, 1);
});

test('a bust buys the next attempt until the attempts run out', () => {
  // Ten micros on a $40 stop lose $400 a trade: three losses and the $1,000 drawdown is gone.
  const losing = lists([trade(1, -1), trade(1, -1, 1), trade(1, -1, 2)], [trade(2, -1), trade(2, -1, 1), trade(2, -1, 2)], [trade(3, 2)]);
  const run = runFarm(losing, setup({ maxAttempts: 2 }));
  assert.deepEqual(run.cells.map((c) => `${c[0]!.stage}:${c[0]!.account}`), ['busted:#1', 'busted:#2', 'busted:#2']);
  assert.equal(run.attempts, 2);
  assert.equal(run.evalBusts, 2);
  assert.equal(run.fees, 160);
  assert.equal(run.cash.at(-1), -160);
});

test('taking turns gives each signal to one account; copying gives it to all', () => {
  const two = lists([trade(1, 2), trade(1, -1, 1)]);
  const rotate = runFarm(two, setup({ slots: 2, maxAttempts: 2 }));
  assert.deepEqual(rotate.cells[0]!.map((c) => c.pnl), [800, -400]);
  const copy = runFarm(two, setup({ slots: 2, maxAttempts: 2, share: 'copy' }));
  assert.deepEqual(copy.cells[0]!.map((c) => c.pnl), [400, 400]);
});

test('a straight-to-funded program starts funded, and one winner ends a funded day', () => {
  const s = setup({ programId: 'tof-ignite-25k', fundedMicros: 2 });
  const run = runFarm(lists([trade(1, 2), trade(1, 2, 1)]), s);
  assert.equal(run.cells[0]![0]!.stage, 'funded');
  assert.equal(run.cells[0]![0]!.trades, 1);
  assert.equal(run.fees, 218);
  assert.equal(runFarm(lists([trade(1, 2), trade(1, 2, 1)]), { ...s, fundedOneAndDone: false }).cells[0]![0]!.trades, 2);
});

test('a setup from anywhere is made safe, and the days keep their quiet ones', () => {
  const s = cleanSetup({ programId: 'nope', slots: 99, evalMicros: -3, strategy: { playbooks: ['made-up', 'double-break'], mode: 'weird', manage: 'x', markets: ['BTC'] }, share: 'x', fee: -1 });
  assert.equal(s.programId, FARM_DEFAULTS.programId);
  assert.equal(s.slots, 10);
  assert.equal(s.evalMicros, 1);
  assert.deepEqual(s.strategy, { playbooks: ['double-break'], mode: 'every', manage: 'written', markets: ['NQ', 'ES', 'GC'] });
  assert.equal(s.share, 'rotate');
  assert.equal(s.fee, null);
  assert.equal(strategyLabel(s.strategy), 'VWAP Double Break');
  const d = farmDays([trade(1, 2), trade(3, -1), { ...trade(3, 2, 1), playbook: 'failed-auction' }], s.strategy, [day(1), day(2), day(3)]);
  assert.deepEqual(d.map((l) => l.length), [1, 0, 1]);
});

test('the odds are repeatable, and tell a farm that pays from one that only pays fees', () => {
  const good = lists(...Array.from({ length: 20 }, (_, i) => [trade(i + 1, i % 4 === 0 ? -1 : 2)]));
  const a = farmOdds(good, setup({ maxAttempts: 6 }), { runs: 80, horizon: 40 });
  assert.deepEqual(a, farmOdds(good, setup({ maxAttempts: 6 }), { runs: 80, horizon: 40 }));
  assert.ok(a.p10 <= a.p50 && a.p50 <= a.p90);
  assert.ok(a.ahead > 0.8 && a.p50 > 0);
  const bad = farmOdds(lists(...Array.from({ length: 20 }, (_, i) => [trade(i + 1, -1), trade(i + 1, -1, 1), trade(i + 1, -1, 2)])), setup({ maxAttempts: 6 }), { runs: 40, horizon: 40 });
  assert.equal(bad.ahead, 0);
  assert.equal(bad.p50, -480);
  assert.equal(farmOdds([], setup()).runs, 0);
});
