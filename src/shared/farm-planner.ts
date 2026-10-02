import type { BacktestDetail } from './trading.js';
import { weekdays } from './evalsim.js';
import { splitDays } from './validation.js';
import { FARM_PROGRAM_BY_ID, FARM_PROGRAMS, farmDays, farmOdds, runFarm, type FarmSetup } from './farm.js';

/** Planning never sees holdout days. Each comparison uses the same sampled days and seed. */
export function planFarm(detail: Pick<BacktestDetail, 'trades' | 'days'>, setup: FarmSetup, runs = 200) {
  const split = splitDays(weekdays(detail.days));
  const days = [...split.train, ...split.validation];
  const lists = farmDays(detail.trades, setup.strategy, days);
  const program = FARM_PROGRAM_BY_ID[setup.programId]!;
  const options = { runs, horizon: 60, block: 2 };
  const compare = { ...options, runs: Math.min(60, runs) };
  const perProgram = FARM_PROGRAMS.filter(p => p.firm === program.firm).map(p => [p.id, farmOdds(lists, {
    ...setup, programId: p.id, fee: null,
    evalMicros: Math.min(setup.evalMicros, p.evalRules?.maxMicros ?? setup.evalMicros),
    fundedMicros: Math.min(setup.fundedMicros, p.fundedRules.maxMicros),
  }, compare)] as const);
  const ladder = (max: number, key: 'evalMicros' | 'fundedMicros') => [...new Set([1, 2, 3, 5, 10, 15, 20, max].filter(n => n >= 1 && n <= max))]
    .sort((a, b) => a - b).map(micros => ({ micros, odds: farmOdds(lists, { ...setup, [key]: micros }, compare) }));
  return { held: split.holdout.length, battle: runFarm(lists, setup, days), odds: farmOdds(lists, setup, options), perProgram,
    evalLadder: ladder(program.evalRules?.maxMicros ?? 0, 'evalMicros'), fundedLadder: ladder(program.fundedRules.maxMicros, 'fundedMicros') };
}
