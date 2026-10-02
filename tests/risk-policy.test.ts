import test from 'node:test';
import assert from 'node:assert/strict';
import { capPolicy, crossAccountConflict, CUSHION_BASELINE, EXPERIMENT_CAPS, policyProblem, riskTable, sizeTrade } from '../src/shared/risk-policy.ts';
import { COSTS } from '../src/shared/fills.ts';
import { ruleSetFor } from '../src/shared/prop-rules.ts';

const base = { symbol: 'NQ' as const, stopPoints: 20, cost: COSTS.gross, allowedMicros: 20, cushion: 1000 };

test('the plan’s MNQ risk table: what a stop loses at each size', () => {
  const t = riskTable('NQ', [3, 5, 10, 20], [10, 20]);
  assert.deepEqual(t.map((r) => [r.micros, ...r.stops.map((s) => s.loss)]), [[3, 60, 120], [5, 100, 200], [10, 200, 400], [20, 400, 800]]);
  // With ordinary costs a 20-micro, 20-point stop is $844.80 of a fresh $1,000 allowance.
  assert.equal(riskTable('NQ', [20], [20], COSTS.base)[0]!.stops[0]!.loss, 844.8);
  assert.deepEqual(EXPERIMENT_CAPS, { eval: [5, 10, 15, 20], funded: [3, 5] });
});

test('the size is the smallest of the cap, the firm’s limit and what the cushion can carry, and it says which decided', () => {
  const cap = sizeTrade({ ...base, policy: capPolicy(20) });
  assert.deepEqual([cap.micros, cap.binding, cap.risk, cap.perMicro, cap.code], [20, 'cap', 800, 40, 'sized:cap']);
  // A falling cushion: $500 carries 12 micros of a $40 risk, whatever the cap asks for.
  const fallen = sizeTrade({ ...base, cushion: 500, policy: capPolicy(20) });
  assert.deepEqual([fallen.micros, fallen.binding, fallen.risk], [12, 'cushion', 480]);
  assert.match(fallen.why, /^12 MNQ, risking \$480: \$500 of the \$500 cushion may be risked/);
  // The firm's limit, less what is already held and what is resting.
  const firm = sizeTrade({ ...base, allowedMicros: 10, openMicros: 4, pendingMicros: 2, policy: capPolicy(20) });
  assert.deepEqual([firm.micros, firm.binding], [4, 'firm']);
  // Risk already open comes off the budget.
  const busy = sizeTrade({ ...base, openRisk: 800, policy: capPolicy(20) });
  assert.deepEqual([busy.micros, busy.binding], [5, 'cushion']);
  // The cushion baseline: a tenth of the cushion a trade.
  const law = sizeTrade({ ...base, policy: CUSHION_BASELINE });
  assert.deepEqual([law.micros, law.binding, law.risk], [2, 'cushion', 80]);
  // Costs are part of what a micro risks: $42.24, so a $100 budget is still 2 and a $80 one is 1.
  assert.equal(sizeTrade({ ...base, cost: COSTS.base, policy: CUSHION_BASELINE }).micros, 2);
  assert.equal(sizeTrade({ ...base, cost: COSTS.base, cushion: 800, policy: CUSHION_BASELINE }).micros, 1);
});

test('when not even one micro fits, it is a skip with the reason, never a rounded-up trade', () => {
  const none = sizeTrade({ ...base, cushion: 30, policy: capPolicy(20) });
  assert.deepEqual([none.micros, none.risk, none.binding, none.code], [0, 0, 'cushion', 'skip:cushion']);
  assert.match(none.why, /^No trade: .*not even one MNQ fits\.$/);
  // The day's allowance: a fifth of the cushion at the open, less what the day has lost.
  const day = sizeTrade({ ...base, policy: CUSHION_BASELINE, dayStartCushion: 1000, dayLoss: 150 });
  assert.deepEqual([day.micros, day.binding], [1, 'day']);
  assert.equal(sizeTrade({ ...base, policy: CUSHION_BASELINE, dayStartCushion: 1000, dayLoss: 180 }).code, 'skip:day');
  // The firm's own daily loss limit counts too.
  assert.equal(sizeTrade({ ...base, policy: capPolicy(20), dailyLossLimit: 500, dayLoss: 300 }).micros, 5);
  // The farm's allowance across accounts.
  const farm = sizeTrade({ ...base, policy: capPolicy(20), portfolio: { limit: 100, openRisk: 70 } });
  assert.deepEqual([farm.micros, farm.code], [0, 'skip:portfolio']);
  // Fully at the firm's limit already.
  assert.equal(sizeTrade({ ...base, allowedMicros: 10, openMicros: 10, policy: capPolicy(5) }).code, 'skip:firm');
  // A stop of nothing can't be sized.
  assert.equal(sizeTrade({ ...base, stopPoints: 0, policy: capPolicy(5) }).micros, 0);
});

test('an illegal request is refused before a run, not quietly treated as a valid experiment', () => {
  const e25 = ruleSetFor('lucidflex-25k', 'eval')!;
  assert.equal(policyProblem(capPolicy(20), e25), null);
  assert.match(policyProblem(capPolicy(30), e25)!, /allows 20 micros at most: a cap of 30 can't be run/);
  assert.match(policyProblem(capPolicy(20), ruleSetFor('topone-elite-25k', 'eval')!)!, /allows 10 micros at most/);
  // A funded cap above the starting step but inside the ceiling is legal: the step bounds it day by day.
  assert.equal(policyProblem(capPolicy(15), ruleSetFor('lucidflex-25k', 'funded')!), null);
  assert.match(policyProblem({ ...capPolicy(5), reserve: 1000 }, e25)!, /reserve must be less than/);
  assert.match(policyProblem(capPolicy(0), e25)!, /at least one micro/);
  assert.equal(policyProblem(CUSHION_BASELINE, e25), null);
});

test('opposite positions on one market across the owner’s accounts are refused', () => {
  const held = [{ account: 'EVAL-1', symbol: 'NQ' as const, side: 'long' as const }];
  assert.match(crossAccountConflict('NQ', 'short', held, 'EVAL-2')!, /EVAL-1 is long NQ/);
  assert.equal(crossAccountConflict('NQ', 'long', held, 'EVAL-2'), null);
  assert.equal(crossAccountConflict('ES', 'short', held, 'EVAL-2'), null);
  // On the same account the opposite order would close the trade it holds: refused too, and it says which it is.
  assert.match(crossAccountConflict('NQ', 'short', held, 'EVAL-1')!, /already long NQ: an opposite order would close that trade/);
});
