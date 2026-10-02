import type { BacktestDetail } from './trading.js';
import { weekdays } from './evalsim.js';
import { splitDays } from './validation.js';
import { FARM_PROGRAM_BY_ID, FARM_PROGRAMS, farmDays, farmOdds, runFarm, type FarmOdds, type FarmRun, type FarmSetup } from './farm.js';

// What the battle test works out for one plan, in the order it is wanted on screen: the replay of the
// real days first (it is instant), then the odds, then what each other size would have netted, then
// the firm's other programs. Each part is handed over as soon as it is ready, so the screen fills in
// rather than waiting for all of it.

export type PlanPart =
  | { k: 'battle'; battle: FarmRun; held: number }
  | { k: 'odds'; odds: FarmOdds }
  | { k: 'rung'; phase: 'eval' | 'funded'; micros: number; odds: FarmOdds }
  | { k: 'program'; id: string; odds: FarmOdds };

/** The sizes the ladder compares for a stage, up to what the firm allows. */
export function rungsFor(max: number): number[] {
  return [...new Set([1, 2, 3, 5, 10, 15, 20, max].filter((n) => n >= 1 && n <= max))].sort((a, b) => a - b);
}

/** How many parts a plan has, so progress can be shown against it. */
export function planSize(setup: FarmSetup): number {
  const program = FARM_PROGRAM_BY_ID[setup.programId]!;
  return 2 + rungsFor(program.evalRules?.maxMicros ?? 0).length + rungsFor(program.fundedRules.maxMicros).length + FARM_PROGRAMS.filter((p) => p.firm === program.firm).length;
}

/** Planning never sees holdout days. Each comparison uses the same sampled days and seed. */
export function* planParts(detail: Pick<BacktestDetail, 'trades' | 'days'>, setup: FarmSetup, runs = 200): Generator<PlanPart> {
  const split = splitDays(weekdays(detail.days));
  const days = [...split.train, ...split.validation];
  const lists = farmDays(detail.trades, setup.strategy, days);
  const program = FARM_PROGRAM_BY_ID[setup.programId]!;
  const options = { runs, horizon: 60, block: 2 };
  const compare = { ...options, runs: Math.min(60, runs) };
  yield { k: 'battle', battle: runFarm(lists, setup, days), held: split.holdout.length };
  yield { k: 'odds', odds: farmOdds(lists, setup, options) };
  for (const [phase, key, max] of [['eval', 'evalMicros', program.evalRules?.maxMicros ?? 0], ['funded', 'fundedMicros', program.fundedRules.maxMicros]] as const)
    for (const micros of rungsFor(max)) yield { k: 'rung', phase, micros, odds: farmOdds(lists, { ...setup, [key]: micros }, compare) };
  for (const p of FARM_PROGRAMS.filter((x) => x.firm === program.firm))
    yield { k: 'program', id: p.id, odds: farmOdds(lists, { ...setup, programId: p.id, fee: null, evalMicros: Math.min(setup.evalMicros, p.evalRules?.maxMicros ?? setup.evalMicros), fundedMicros: Math.min(setup.fundedMicros, p.fundedRules.maxMicros) }, compare) };
}

/** The whole plan at once. */
export function planFarm(detail: Pick<BacktestDetail, 'trades' | 'days'>, setup: FarmSetup, runs = 200) {
  let battle!: FarmRun;
  let odds!: FarmOdds;
  let held = 0;
  const perProgram: (readonly [string, FarmOdds])[] = [];
  const evalLadder: { micros: number; odds: FarmOdds }[] = [];
  const fundedLadder: { micros: number; odds: FarmOdds }[] = [];
  for (const p of planParts(detail, setup, runs)) {
    if (p.k === 'battle') {
      battle = p.battle;
      held = p.held;
    } else if (p.k === 'odds') odds = p.odds;
    else if (p.k === 'rung') (p.phase === 'eval' ? evalLadder : fundedLadder).push({ micros: p.micros, odds: p.odds });
    else perProgram.push([p.id, p.odds] as const);
  }
  return { held, battle, odds, perProgram, evalLadder, fundedLadder };
}
