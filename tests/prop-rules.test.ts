import test from 'node:test';
import assert from 'node:assert/strict';
import { describeRules, floorFor, fromPropRules, isVerified, provenanceOf, ruleIssues, ruleSetById, ruleSetFor, RULESETS, tierMicros, toPropRules } from '../src/shared/prop-rules.ts';
import { ACCOUNT_CATALOG } from '../src/shared/prop-catalog.ts';
import { PROP_ACCOUNTS } from '../src/shared/trading.ts';

const lucid = (size: '25k' | '50k', phase: 'eval' | 'funded') => ruleSetFor(`lucidflex-${size}`, phase)!;

test('LucidFlex 25K and 50K are first-class, with the numbers on the firm’s own pages', () => {
  const e25 = lucid('25k', 'eval');
  assert.deepEqual([e25.profitTarget, e25.drawdown, e25.maxMicros, e25.consistencyPercent, e25.drawdownType, e25.automation], [1250, 1000, 20, 50, 'trailing-eod', 'allowed']);
  const e50 = lucid('50k', 'eval');
  assert.deepEqual([e50.profitTarget, e50.drawdown, e50.maxMicros], [3000, 2000, 40]);
  const f25 = lucid('25k', 'funded').payout!;
  assert.deepEqual([f25.profitDays, f25.profitDayMin, f25.minRequest, f25.maxRequest, f25.withdrawShare, f25.split, f25.maxPayouts], [5, 100, 500, 1000, 0.5, 0.9, 5]);
  const f50 = lucid('50k', 'funded').payout!;
  assert.deepEqual([f50.profitDayMin, f50.maxRequest], [150, 2000]);
  for (const r of [e25, e50, lucid('25k', 'funded'), lucid('50k', 'funded')]) {
    assert.equal(isVerified(r), true, r.id);
    assert.equal(r.verifiedOn, '2026-10-02');
    assert.ok(r.sources.length >= 5 && r.sources.every((s) => s.url.startsWith('https://support.lucidtrading.com/')));
    assert.deepEqual(ruleIssues(r), []);
  }
  // What the firm doesn't publish says so, and the fee is the owner's to set.
  assert.equal(provenanceOf(e25, 'days'), 'assumed');
  assert.equal(e50.fee, null);
  assert.equal(provenanceOf(e25, 'target'), 'verified');
});

test('every rule set has its own identity, and a template has an evaluation and a funded one apart', () => {
  assert.equal(new Set(RULESETS.map((r) => r.id)).size, RULESETS.length);
  assert.equal(ruleSetById('lucidflex-25k:eval@2026-10')!.phase, 'eval');
  assert.equal(ruleSetById('lucidflex-25k:funded@2026-10')!.phase, 'funded');
  assert.equal(lucid('25k', 'eval').template, lucid('25k', 'funded').template);
  assert.equal(ruleSetById('nope'), undefined);
});

test('a funded account starts under the ceiling and steps up with profit, at the boundaries', () => {
  const f25 = lucid('25k', 'funded');
  assert.deepEqual([0, 999, 1000, 1999, 2000, 9000].map((p) => tierMicros(f25, p)), [10, 10, 20, 20, 20, 20]);
  const f50 = lucid('50k', 'funded');
  assert.deepEqual([-500, 0, 999, 1000, 1999, 2000, 4500].map((p) => tierMicros(f50, p)), [20, 20, 20, 30, 30, 40, 40]);
  // An evaluation has no steps: its limit is the ceiling.
  assert.equal(tierMicros(lucid('25k', 'eval'), 0), 20);
});

test('the floor trails the highest close and locks $100 over the start once the trail gets there', () => {
  const f25 = lucid('25k', 'funded');
  assert.equal(floorFor(f25, 25_000), 24_000);
  assert.equal(floorFor(f25, 25_600), 24_600);
  assert.equal(floorFor(f25, 26_099), 25_099);
  // The initial trail balance: $26,100. From there the floor is $25,100 for good.
  assert.equal(floorFor(f25, 26_100), 25_100);
  assert.equal(floorFor(f25, 31_000), 25_100);
  const f50 = lucid('50k', 'funded');
  assert.equal(floorFor(f50, 52_100), 50_100);
  assert.equal(floorFor(f50, 51_000), 49_000);
});

test('unknown is not unlimited: Top One can be simulated as a what-if, never verified, and never automated', () => {
  const t25 = ruleSetFor('topone-elite-25k', 'eval')!;
  assert.equal(t25.maxMicros, 10);
  assert.equal(ruleSetFor('topone-elite-50k', 'eval')!.maxMicros, 30);
  assert.equal(t25.automation, 'prohibited');
  assert.equal(isVerified(t25), false);
  assert.ok(t25.unknowns.length >= 3);
  const issues = ruleIssues(t25);
  assert.ok(issues.some((i) => /Not known/.test(i)) && issues.some((i) => /prohibits automated/.test(i)));
  // Its contract limit is the firm's own even though the rest isn't.
  assert.equal(provenanceOf(t25, 'limits'), 'verified');
  assert.equal(provenanceOf(t25, 'target'), 'assumed');
});

test('the older simulators read the same rules: the catalog and the owner’s accounts agree with the rule sets', () => {
  const p = toPropRules(lucid('25k', 'eval'));
  assert.deepEqual([p.id, p.kind, p.profitTarget, p.drawdown, p.maxMicros, p.lockProfit], ['lucidflex-25k', 'eval', 1250, 1000, 20, 100]);
  const f = toPropRules(lucid('25k', 'funded'));
  assert.deepEqual([f.id, f.kind, f.profitTarget, f.maxMicros, f.minTradingDays, f.consistencyPercent], ['lucidflex-funded-25k', 'funded', 1000, 10, 5, 100]);
  for (const id of ['lucidflex-25k', 'lucidflex-funded-25k', 'lucidflex-funded-50k']) assert.ok(ACCOUNT_CATALOG.some((a) => a.id === id), id);
  // The owner's own 50K evaluation is the same account as its rule set (a balance saved against it still fits).
  const own = PROP_ACCOUNTS.find((a) => a.id === 'lucidflex-50k')!;
  const { program: _a, ...viaRules } = toPropRules(lucid('50k', 'eval'));
  const { program: _b, ...mine } = own;
  assert.deepEqual(mine, viaRules);
});

test('an account from a public summary becomes a rule set that says so', () => {
  const r = fromPropRules(ACCOUNT_CATALOG.find((a) => a.id === 'fundednext-funded-25k')!, { payoutCap: 800 });
  assert.equal(r.basis, 'reported');
  assert.equal(isVerified(r), false);
  assert.deepEqual([r.payout!.profitDays, r.payout!.minProfit, r.payout!.consistencyPercent, r.payout!.maxRequest, r.payout!.after], [3, 500, 40, 800, 'reset']);
  assert.ok(ruleIssues(r).some((i) => /Never checked/.test(i)));
  const rows = describeRules(lucid('25k', 'funded'));
  assert.ok(rows.some((x) => x.label === 'Contract limit' && /10 micros from \$0 · 20 micros from \$1,000/.test(x.value)));
  assert.ok(rows.every((x) => x.how === 'verified' || x.label === 'Fee'));
});
