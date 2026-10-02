import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, parseDecision, regimeDecider, REGIME_MODEL, type DecisionRequest } from '../src/shared/research-decision.ts';
import { ShadowLane } from '../src/server/trading/research-agent.ts';
const request: DecisionRequest = { id: 'signal-1', at: 1000, symbol: 'NQ', side: 'long', playbook: 'vwap-pullback', approved: ['vwap-pullback'], features: [{ name: 'adx', value: 30, availableAt: 1000 }] };
const take = { action: 'take', regime: 'trend', confidence: 0.8, reason: 'Trend fits' };

test('adaptive lane refuses risk overrides, malformed output, future or invalid features', () => {
  for (const raw of ['not JSON', { ...take, contracts: 20 }, { ...take, settings: { stop: 1 } }, { ...take, confidence: Infinity }]) assert.equal(parseDecision(raw, request).decision.action, 'abstain');
  for (const feature of [{ name: 'adx', value: 30, availableAt: 1001 }, { name: 'adx', value: NaN, availableAt: 1000 }, { name: 'adx', value: 30, availableAt: NaN }]) {
    const result = parseDecision(take, { ...request, features: [feature] });
    assert.equal(result.valid, false); assert.equal(result.decision.action, 'abstain');
  }
  assert.equal(parseDecision(take, { ...request, approved: [] }).decision.action, 'abstain');
  assert.equal(parseDecision(take, request).decision.action, 'take');
});

test('late answers remain abstentions on replay, without asking a model again', async () => {
  let time = 1000;
  const record = await decide(request, REGIME_MODEL, () => { time += 6000; return take; }, { clock: () => time, budgetMs: 5000 });
  assert.equal(record.valid, false); assert.equal(record.decision.action, 'abstain');
  const replayed = ShadowLane.replay(record);
  assert.equal(replayed.valid, false); assert.equal(replayed.decision.action, 'abstain');
  assert.ok(replayed.problems.includes('Late answer'));
});

test('unavailable, timed-out and failed models abstain; valid recorded answers replay', async () => {
  for (const model of [null, () => { throw new Error('offline'); }, () => new Promise(() => {})]) {
    const r = await decide(request, REGIME_MODEL, model, { budgetMs: 5 });
    assert.equal(r.valid, false); assert.equal(r.decision.action, 'abstain');
  }
  const r = await decide(request, REGIME_MODEL, regimeDecider);
  assert.equal(r.valid, true); assert.equal(ShadowLane.replay(r).decision.action, 'take');
});
