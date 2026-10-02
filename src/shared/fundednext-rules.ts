import type { RuleSet } from './prop-rules.js';

// New identities preserve the older Rapid scenarios already pinned to saved runs.
// Official program pages checked 2026-10-02. Execution-specific conditions remain explicit gaps.
const sources = [
  { label: 'Objectives', url: 'https://fundednext.com/general-rules/futures/trading-objectives' },
  { label: 'Loss limits', url: 'https://helpfutures.fundednext.com/en/articles/17230292-daily-loss-limit-and-maximum-loss-limit-at-fundednext-futures' },
  { label: 'Rapid Pro funded rules', url: 'https://helpfutures.fundednext.com/en/articles/17229713-fundednext-futures-rapid-pro-fundednext-account-all-rules' },
  { label: 'Flex challenge', url: 'https://helpfutures.fundednext.com/en/articles/14878751-what-is-fundednext-futures-flex-challenge' },
  { label: 'Flex rewards', url: 'https://helpfutures.fundednext.com/en/articles/14878865-what-are-the-performance-reward-eligibility-criteria-for-flex-fundednext-account' },
  { label: 'Automation', url: 'https://fundednext.com/general-rules/futures/what-is-allowed' },
];
const programs = [
  { model: 'rapid-pro', name: 'Rapid Pro', size: 25000, target: 1500, loss: 1000, micros: 20, payout: 800 },
  { model: 'rapid-pro', name: 'Rapid Pro', size: 50000, target: 3000, loss: 2000, micros: 40, payout: 1200 },
  { model: 'rapid-pro', name: 'Rapid Pro', size: 100000, target: 5000, loss: 2500, micros: 60, payout: 2500 },
  { model: 'flex', name: 'Flex', size: 50000, target: 2500, loss: 1500, micros: 30, payout: 1500 },
  { model: 'flex', name: 'Flex', size: 100000, target: 5000, loss: 2500, micros: 50, payout: 2500 },
  { model: 'flex', name: 'Flex', size: 150000, target: 8000, loss: 4000, micros: 80, payout: 4000 },
];
export const FUNDEDNEXT_RULESETS: RuleSet[] = programs.flatMap(p => (['eval', 'funded'] as const).map(phase => {
  const flex = p.model === 'flex';
  const template = `fundednext-${p.model}-${p.size / 1000}k`;
  return {
    id: `${template}:${phase}@2026-10-02`, template, firm: 'FundedNext', program: `${p.name} ${p.size / 1000}K${phase === 'funded' ? ' (funded)' : ''}`,
    size: p.size, phase, cohort: '2026-10-02', verifiedOn: '2026-10-02', sources,
    profitTarget: phase === 'eval' ? p.target : 0, drawdown: p.loss, drawdownType: 'trailing-eod', lockProfit: 100,
    dailyLossLimit: null, maxMicros: p.micros, scaling: null,
    consistencyPercent: phase === 'eval' && flex ? 40 : 100, consistencyBasis: 'totalProfit', minTradingDays: phase === 'eval' ? (flex ? 3 : 1) : 0,
    payout: phase === 'eval' ? null : {
      profitDays: flex ? 5 : 3, profitDayMin: flex ? (p.size === 150000 ? 250 : 200) : 0,
      minProfit: 500, minCycleProfit: 500, minRequest: 250, maxRequest: p.payout, withdrawShare: flex ? 0.5 : 1,
      split: flex ? 0.95 : 0.9, consistencyPercent: flex ? 100 : 40, floorOnRequest: flex ? 100 : null,
      after: 'keep', maxPayouts: 5, processingDays: 2,
    },
    automation: 'allowed', fee: null, activation: 0, basis: 'verified', provenance: { fee: 'assumed', days: 'assumed' },
    unknowns: ['Withdrawal request scheduling, inactivity and micro-scalping deductions are not simulated'],
    notes: ['Source-checked numerical rules; results remain research scenarios until the execution-specific gaps are resolved.',
      'No optional daily-loss add-on is modeled. Select rules matching the actual purchase before using an account.',
      'Processing time is a two-session simulation assumption. A real reward requires firm confirmation.',
      'The detailed loss-limit article specifies a floor lock at opening balance + $100; the general summary omits the $100.'],
  } satisfies RuleSet;
}));
