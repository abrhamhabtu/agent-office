import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanSetup, policyOf, FARM_DEFAULTS, setupProblem } from '../src/shared/farm.ts';
import { sizeTrade } from '../src/shared/risk-policy.ts';
import { STRATEGY_RECIPES } from '../src/shared/strategy-recipes.ts';

test('phase sizing lowers funded risk near payout without enlarging the requested cap', () => {
  const setup = cleanSetup({ ...FARM_DEFAULTS, sizing: 'phase', evalMicros: 20, fundedMicros: 5 });
  const context = { profit: 0, goal: 1000, drawdown: 1000 };
  const start = policyOf(setup, 'funded', context);
  const near = policyOf(setup, 'funded', { ...context, profit: 900 });
  assert.equal(start.reserve, 100);
  assert.ok(near.cushionShare < start.cushionShare);
  assert.equal(near.cap, 5);
  const ev = policyOf(setup, 'eval', context);
  assert.ok(ev.cushionShare > start.cushionShare);
  const d = sizeTrade({ symbol: 'NQ', stopPoints: 20, policy: ev, allowedMicros: 20, cushion: 1000 });
  assert.ok(d.risk <= 900 * 0.35);
  assert.equal(setupProblem(setup), null);
  assert.equal(policyOf({ ...setup, protectPayout: false }, 'funded', { ...context, profit: 900 }).cushionShare, start.cushionShare);
});

test('persisted risk controls reject nonfinite values and bound experimental aggression', () => {
  const s = cleanSetup({ sizing: 'phase', evalRiskPercent: 1000, fundedRiskPercent: NaN });
  assert.equal(s.evalRiskPercent, 75);
  assert.equal(s.fundedRiskPercent, 10);
  assert.equal(cleanSetup({}).sizing, 'cap'); // old runs retain behavior
  assert.equal(policyOf(FARM_DEFAULTS, 'eval').cushionShare, 1);
});

test('every selectable recipe uses existing executable playbooks and survives cleaning', () => {
  for (const r of STRATEGY_RECIPES) assert.deepEqual(cleanSetup({ strategy: r.strategy }).strategy, r.strategy);
  assert.ok(STRATEGY_RECIPES.some(r => r.strategy.mode === 'by-day'));
  assert.ok(STRATEGY_RECIPES.some(r => r.strategy.mode === 'fallback'));
});
