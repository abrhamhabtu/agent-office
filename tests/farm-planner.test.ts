import test from 'node:test';
import assert from 'node:assert/strict';
import { planFarm } from '../src/shared/farm-planner.ts';
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
