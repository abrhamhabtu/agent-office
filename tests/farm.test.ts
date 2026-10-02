import test from 'node:test';
import assert from 'node:assert/strict';
import type { PaperTrade } from '../src/shared/trading.ts';
import { cleanSetup, drawDays, FARM_DEFAULTS, FARM_PROGRAMS, farmDays, farmOdds, policyOf, programVerified, rng, runFarm, setupProblem, shareRange, strategyLabel, type FarmSetup } from '../src/shared/farm.ts';

const day = (n: number) => `2026-09-${String(n).padStart(2, '0')}`;
const MIN = 60_000;
/** An NQ double-break trade with a 20-point stop ($40 a micro) that makes `r` risks, `k` half hours into the day. */
const trade = (d: number, r: number, k = 0, o: Partial<PaperTrade> = {}): PaperTrade => ({ id: `t${d}-${k}`, day: day(d), symbol: 'NQ', playbook: 'double-break', side: 'long', entryAt: d * 1e9 + k * 30 * MIN, entry: 100, stop: 80, target: 140, exitAt: d * 1e9 + k * 30 * MIN + 10 * MIN, exit: 100 + 20 * r, outcome: r > 0 ? 'win' : 'loss', r, dollars: 40 * r, why: '', mae: r < 0 ? 20 : 0, mfe: r > 0 ? 20 * r : 0, ...o });
/** LucidFlex 25K, one account, no costs, so the arithmetic is the firm's rules and nothing else. */
const setup = (o: Partial<FarmSetup> = {}): FarmSetup => ({ ...FARM_DEFAULTS, programId: 'lucidflex-25k', slots: 1, maxAttempts: 1, evalMicros: 10, fundedMicros: 5, cost: 'gross', strategy: { playbooks: ['double-break'], mode: 'every', manage: 'written', markets: ['NQ', 'ES', 'GC'] }, ...o });
const lists = (...days: PaperTrade[][]) => days;

test('every farm program has its rules, and only the ones read on the firm’s pages are called verified', () => {
  for (const p of FARM_PROGRAMS) {
    assert.equal(p.fundedRules.phase, 'funded', p.id);
    assert.ok(p.fundedRules.payout, p.id);
    if (p.evalRules) assert.equal(p.evalRules.phase, 'eval', p.id);
    assert.ok(p.fee > 0 && p.fundedRules.payout!.split > 0 && p.fundedRules.payout!.split <= 1, p.id);
  }
  // The three firms the owner means to use are all there.
  assert.deepEqual([...new Set(FARM_PROGRAMS.map((p) => p.firm))], ['Lucid', 'Top One', 'FundedNext']);
  assert.deepEqual(FARM_PROGRAMS.filter(programVerified).map((p) => p.id), ['lucidflex-25k', 'lucidflex-50k']);
  assert.deepEqual(FARM_PROGRAMS.filter((p) => p.fundedRules.automation === 'prohibited').map((p) => p.firm), ['Top One', 'Top One']);
});

test('one LucidFlex 25K account goes from the fee to the payout, by hand', () => {
  // Evaluation at 10 micros: two winners a day, +$1,600. Day one is over the $1,250 target already, but one
  // day is 100% of the profit and the rule allows 50%: target reached, rules pending. Day two: $3,200, the
  // best day 50%. Passed, and confirmed at the next open: funded, where the firm starts it at 10 micros and
  // the cap asks for 5: +$400 a day (one winner and done). Five days: $2,000 of profit and five $100 days.
  // Half, capped at $1,000, is requested; it parks; two days later $900 arrives (90%) and it trades again.
  const run = runFarm(lists(...Array.from({ length: 10 }, (_, i) => [trade(i + 1, 2), trade(i + 1, 2, 1)])), setup({ evalMicros: 10 }), undefined);
  assert.deepEqual(run.cells.map((c) => `${c[0]!.stage}:${c[0]!.status}`), ['eval:target-reached', 'eval:pass-pending', 'funded:active', 'funded:active', 'funded:active', 'funded:active', 'parked:parked', 'parked:parked', 'funded:active', 'funded:active']);
  assert.deepEqual(run.cells.map((c) => c[0]!.balance), [26_600, 28_200, 25_400, 25_800, 26_200, 26_600, 27_000, 27_000, 26_000, 26_400]);
  assert.deepEqual(run.events.filter((e) => e.kind !== 'trade').map((e) => `${e.day}:${e.kind}:${e.account}`), ['0:bought:EVAL-1', '1:passed:EVAL-1', '2:bought:FUNDED-1', '6:payout-ready:FUNDED-1', '8:paid:FUNDED-1']);
  assert.deepEqual(run.cash, [-75, -75, -75, -75, -75, -75, -75, -75, 825, 825]);
  assert.deepEqual([run.payouts, run.fees, run.passed, run.payoutCount, run.firstPayoutDay, run.cushionAfterPayout], [900, 75, 1, 1, 6, 900]);
  // The funded account's limit stepped from 10 to 20 micros at $1,000 of profit; $1,000 is still there after the withdrawal, so it stays.
  assert.deepEqual(run.cells.map((c) => c[0]!.allowed), [20, 20, 10, 10, 20, 20, 20, 20, 20, 20]);
  // Parked: its floor is the locked balance, $25,100.
  assert.equal(run.cells[6]![0]!.floor, 25_100);
  assert.deepEqual([run.cells[6]![0]!.profitDays, run.cells[6]![0]!.profitDaysNeeded], [5, 5]);
  // Every trade says why it was the size it was.
  const first = run.events.find((e) => e.kind === 'trade')!;
  assert.match(first.why!, /^10 MNQ, risking \$400: the cap asked for is 10\.$/);
});

test('a breach buys the next attempt until the attempts run out, and each loss is sized to what is left', () => {
  // 10 micros on a $40 stop loses $400: $1,000 of cushion, then $600 carries 10 again, then $200 carries 5.
  const losing = lists([trade(1, -1), trade(1, -1, 1), trade(1, -1, 2)], [trade(2, -1), trade(2, -1, 1), trade(2, -1, 2)], [trade(3, 2)]);
  const run = runFarm(losing, setup({ maxAttempts: 2 }));
  assert.deepEqual(run.cells.map((c) => `${c[0]!.stage}:${c[0]!.account}`), ['busted:#1', 'busted:#2', 'busted:#2']);
  assert.deepEqual(run.events.filter((e) => e.kind === 'trade' && e.day === 0).map((e) => e.amount), [-400, -400, -200]);
  assert.match(run.events.filter((e) => e.kind === 'trade')[2]!.why!, /^5 MNQ, risking \$200: \$200 of the \$200 cushion may be risked/);
  assert.deepEqual([run.attempts, run.evalBusts, run.fees, run.cash.at(-1)], [2, 2, 150, -150]);
  assert.equal(run.worstStreak, -2000);
});

test('the governor sizes a trade so its full stop can’t breach the account, and the ledger shows how close it came', () => {
  // 20 micros asked for on a 30-point stop ($60 a micro): the $1,000 cushion carries 16. The trade went 26
  // points against it (−$832 open) before making $1,280: the account stood $168 above its floor at the worst.
  const run = runFarm(lists([trade(1, 2, 0, { stop: 70, mae: 26, maeAt: 1e9 + 2 * MIN, mfeAt: 1e9 + 9 * MIN })]), setup({ evalMicros: 20 }));
  const cell = run.cells[0]![0]!;
  assert.deepEqual([cell.stage, cell.pnl, cell.lowCushion], ['eval', 1280, 168]);
  assert.match(run.events.find((e) => e.kind === 'trade')!.why!, /^16 MNQ, risking \$960: \$1,000 of the \$1,000 cushion may be risked, and one MNQ risks \$60\.$/);
  // Two trades open at once share the firm's limit: 15 are held, so the second gets the 5 that are left of 20.
  const pair = runFarm(lists([trade(1, 2, 0, { exitAt: 1e9 + 90 * MIN }), trade(1, 2, 1)]), setup({ evalMicros: 15 }));
  assert.deepEqual(pair.events.filter((e) => e.kind === 'trade').map((e) => e.why!.split(',')[0]), ['15 MNQ', '5 MNQ']);
  assert.match(pair.events.filter((e) => e.kind === 'trade')[1]!.why!, /the firm allows 20 and 15 are already held or resting/);
  // At the limit already, the next signal is a skip that says so.
  const full = runFarm(lists([trade(1, 2, 0, { exitAt: 1e9 + 90 * MIN }), trade(1, 2, 1)]), setup({ evalMicros: 20 }));
  assert.deepEqual([full.taken, full.skipped], [1, 1]);
  assert.match(full.events.find((e) => e.kind === 'skip')!.why!, /^No trade: the firm allows 20 and 20 are already held or resting, so not even one MNQ fits\.$/);
});

test('taking turns gives each signal to one account; copying gives it to all; opposite sides are refused', () => {
  const two = lists([trade(1, 2), trade(1, -1, 1)]);
  const rotate = runFarm(two, setup({ slots: 2, maxAttempts: 2 }));
  assert.deepEqual(rotate.cells[0]!.map((c) => c.pnl), [800, -400]);
  const copy = runFarm(two, setup({ slots: 2, maxAttempts: 2, share: 'copy' }));
  assert.deepEqual(copy.cells[0]!.map((c) => c.pnl), [400, 400]);
  // A short while the other account is still long the same market: no account takes it.
  const against = lists([trade(1, 2, 0, { exitAt: 1e9 + 60 * MIN }), trade(1, 2, 1, { side: 'short', stop: 120, target: 60 })]);
  const run = runFarm(against, setup({ slots: 2, maxAttempts: 2 }));
  assert.deepEqual([run.taken, run.skipped], [1, 1]);
  assert.match(run.events.find((e) => e.kind === 'skip')!.why!, /EVAL-1 is long NQ: an opposite position on another of your accounts is prohibited/);
});

test('a cap over the firm’s limit is refused outright; costs come off every fill; sizing by the cushion is smaller', () => {
  assert.match(setupProblem(setup({ evalMicros: 25 }))!, /allows 20 micros at most/);
  const refused = runFarm(lists([trade(1, 2)]), setup({ evalMicros: 25 }));
  assert.deepEqual([refused.attempts, refused.cells.length, !!refused.refused], [0, 0, true]);
  assert.equal(farmOdds(lists([trade(1, 2)]), setup({ evalMicros: 25 })).runs, 0);
  // 10 micros at ordinary costs: a winner pays $1.74 a micro, so +$800 is +$782.60.
  const paid = runFarm(lists([trade(1, 2)]), setup({ cost: 'base' }));
  assert.equal(paid.cells[0]![0]!.balance, 25_783);
  assert.equal(paid.costs, 17);
  // The Law of 10: $100 of a $1,000 cushion a trade, so 2 micros of a $40 risk.
  const law = runFarm(lists([trade(1, 2)]), setup({ sizing: 'cushion' }));
  assert.equal(law.cells[0]![0]!.pnl, 160);
  assert.equal(policyOf(setup({ sizing: 'cushion' }), 'eval').cushionShare, 0.1);
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
  const s = cleanSetup({ programId: 'nope', slots: 99, evalMicros: -3, sizing: 'x', cost: 'free', strategy: { playbooks: ['made-up', 'double-break'], mode: 'weird', manage: 'x', markets: ['BTC'] }, share: 'x', fee: -1 });
  assert.equal(s.programId, FARM_DEFAULTS.programId);
  assert.equal(s.slots, 10);
  assert.equal(s.evalMicros, 1);
  assert.deepEqual([s.sizing, s.cost], ['cap', 'base']);
  assert.deepEqual(s.strategy, { playbooks: ['double-break'], mode: 'every', manage: 'written', markets: ['NQ', 'ES', 'GC'] });
  assert.equal(s.share, 'rotate');
  assert.equal(s.fee, null);
  assert.equal(strategyLabel(s.strategy), 'VWAP Double Break');
  const d = farmDays([trade(1, 2), trade(3, -1), { ...trade(3, 2, 1), playbook: 'failed-auction' }], s.strategy, [day(1), day(2), day(3)]);
  assert.deepEqual(d.map((l) => l.length), [1, 0, 1]);
});

test('the odds are repeatable, say how sure they are, and tell a farm that pays from one that only pays fees', () => {
  const good = lists(...Array.from({ length: 20 }, (_, i) => [trade(i + 1, i % 4 === 0 ? -1 : 2)]));
  const a = farmOdds(good, setup({ maxAttempts: 6, evalMicros: 5 }), { runs: 80, horizon: 40 });
  assert.deepEqual(a, farmOdds(good, setup({ maxAttempts: 6, evalMicros: 5 }), { runs: 80, horizon: 40 }));
  assert.ok(a.p10 <= a.p50 && a.p50 <= a.p90);
  assert.ok(a.ahead > 0.8 && a.p50 > 0);
  assert.ok(a.aheadRange[0] <= a.ahead && a.ahead <= a.aheadRange[1] && a.aheadRange[0] > 0.5);
  assert.ok(a.payoutRate > 0.8 && a.daysToPayout! > 5 && a.cushionAfterPayout! > 0);
  assert.deepEqual([a.sampleDays, a.sampleTrades], [20, 20]);
  const bad = farmOdds(lists(...Array.from({ length: 20 }, (_, i) => [trade(i + 1, -1), trade(i + 1, -1, 1), trade(i + 1, -1, 2)])), setup({ maxAttempts: 6 }), { runs: 40, horizon: 40 });
  assert.deepEqual([bad.ahead, bad.p50, bad.payoutRate, bad.daysToPayout], [0, -450, 0, null]);
  assert.ok(bad.worstStreak < 0);
  assert.equal(farmOdds([], setup()).runs, 0);
  // Redraws keep runs of days together when asked, and the range on a share narrows with more tries.
  const rand = rng(3);
  const drawn = drawDays([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 9, rand, 3);
  assert.equal(drawn.length, 9);
  for (let i = 0; i < 9; i += 3) assert.deepEqual([drawn[i + 1], drawn[i + 2]], [(drawn[i]! + 1) % 10, (drawn[i]! + 2) % 10]);
  const wide = shareRange(0.5, 20);
  const tight = shareRange(0.5, 2000);
  assert.ok(wide[1] - wide[0] > 0.3 && tight[1] - tight[0] < 0.05);
});
