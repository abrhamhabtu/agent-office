import test from 'node:test';
import assert from 'node:assert/strict';
import { ruleSetFor, isVerified } from '../src/shared/prop-rules.ts';
import { openAccount, payoutCheck } from '../src/shared/account-ledger.ts';
import { FARM_PROGRAM_BY_ID } from '../src/shared/farm.ts';

test('current FundedNext programs cover all four sizes without changing old Rapid identities', () => {
  const sizes = new Set([25000, 50000, 100000, 150000]);
  for (const [id, target, loss, micros] of [
    ['fundednext-rapid-pro-25k', 1500, 1000, 20], ['fundednext-rapid-pro-100k', 5000, 2500, 60],
    ['fundednext-flex-50k', 2500, 1500, 30], ['fundednext-flex-150k', 8000, 4000, 80],
  ] as const) {
    const r = ruleSetFor(id, 'eval')!;
    assert.deepEqual([r.profitTarget, r.drawdown, r.maxMicros], [target, loss, micros]);
    assert.equal(r.lockProfit, 100);
    assert.equal(r.automation, 'allowed');
    assert.equal(isVerified(r), false); // execution conditions still need review
    assert.ok(FARM_PROGRAM_BY_ID[id]);
    sizes.delete(r.size);
  }
  assert.equal(sizes.size, 0);
  assert.equal(FARM_PROGRAM_BY_ID['fundednext-rapid-25k']!.evalRules!.maxMicros, 10);
});

test('retained profit cannot substitute for the next FundedNext payout cycle', () => {
  const r = ruleSetFor('fundednext-flex-50k', 'funded')!;
  const a = openAccount(r, { id: 'test', day: '2026-10-02' });
  a.balance = 53000;
  a.cycle = { startBalance: 52700, profitDays: 5, tradingDays: 5, bestDay: 200 };
  assert.equal(payoutCheck(a, r).eligible, false);
  a.cycle.startBalance = 52500;
  assert.equal(payoutCheck(a, r).eligible, true);
  assert.equal(payoutCheck(a, r).amount, 1500);
  assert.equal(r.payout!.after, 'keep');
});
