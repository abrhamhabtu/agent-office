import test from 'node:test';
import assert from 'node:assert/strict';
import { planFarm, planParts, planSize, rungsFor } from '../src/shared/farm-planner.ts';
import { FARM_DEFAULTS, FARM_PROGRAM_BY_ID } from '../src/shared/farm.ts';
import type { PaperTrade } from '../src/shared/trading.ts';

test('planner excludes holdout trades and compares only the selected firm', () => {
  const days = Array.from({ length: 30 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`);
  const t = (day: string): PaperTrade => ({ id: day, day, symbol: 'NQ', playbook: 'double-break', side: 'long', entryAt: Date.parse(`${day}T14:00:00Z`), exitAt: Date.parse(`${day}T14:10:00Z`), entry: 100, stop: 80, target: 140, exit: 140, outcome: 'win', r: 2, dollars: 80, why: '', mae: 0, mfe: 40 });
  const setup = { ...FARM_DEFAULTS, slots: 1, maxAttempts: 1 };
  const detail = { days, trades: days.map(t) };
  const result = planFarm(detail, setup, 2);
  assert.ok(result.held > 0);
  const heldDays = days.filter(d => !result.battle.days.includes(d));
  const altered = { ...detail, trades: detail.trades.map(t => heldDays.includes(t.day) ? { ...t, dollars: -100000, r: -1000 } : t) };
  assert.deepEqual(planFarm(altered, setup, 2), result);
  assert.ok(result.perProgram.every(([id]) => FARM_PROGRAM_BY_ID[id]!.firm === 'Lucid'));
  assert.ok(result.evalLadder.every(r => r.micros <= 20));
});

test('a plan arrives in parts, the replay first, and the parts add up to the whole plan', () => {
  const days = Array.from({ length: 30 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`);
  const t = (day: string): PaperTrade => ({ id: day, day, symbol: 'NQ', playbook: 'double-break', side: 'long', entryAt: Date.parse(`${day}T14:00:00Z`), exitAt: Date.parse(`${day}T14:10:00Z`), entry: 100, stop: 80, target: 140, exit: 140, outcome: 'win', r: 2, dollars: 80, why: '', mae: 0, mfe: 40 });
  const setup = { ...FARM_DEFAULTS, slots: 1, maxAttempts: 2 };
  const detail = { days, trades: days.map(t) };
  const parts = [...planParts(detail, setup, 2)];
  // The order the screen wants them in: the replay at once, then the odds, then each size, then each program.
  assert.deepEqual(parts.slice(0, 2).map((p) => p.k), ['battle', 'odds']);
  assert.equal(parts.length, planSize(setup));
  assert.deepEqual(parts.filter((p) => p.k === 'rung' && p.phase === 'eval').map((p) => (p.k === 'rung' ? p.micros : 0)), rungsFor(20));
  assert.deepEqual(rungsFor(20), [1, 2, 3, 5, 10, 15, 20]);
  assert.deepEqual(rungsFor(4), [1, 2, 3, 4]);
  assert.deepEqual(rungsFor(0), []);
  const whole = planFarm(detail, setup, 2);
  const battle = parts.find((p) => p.k === 'battle');
  assert.deepEqual(battle?.k === 'battle' ? battle.battle : null, whole.battle);
  assert.deepEqual(parts.filter((p) => p.k === 'program').map((p) => (p.k === 'program' ? p.id : '')), whole.perProgram.map(([id]) => id));
  // A straight-to-funded program has no evaluation sizes to compare.
  const direct = [...planParts(detail, { ...setup, programId: 'luciddirect-25k' }, 2)];
  assert.equal(direct.filter((p) => p.k === 'rung' && p.phase === 'eval').length, 0);
  assert.equal(direct.length, planSize({ ...setup, programId: 'luciddirect-25k' }));
});
