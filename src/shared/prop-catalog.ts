import type { PropRules } from './trading.js';
import { PROP_ACCOUNTS } from './trading.js';

// More accounts for the eval simulator to try a strategy on: the other sizes of the firms the desk already
// trades, and the straight-to-funded programs. They are for simulating only: the risk guard, the proposals'
// sizing and the wall board stay on the owner's own accounts (PROP_ACCOUNTS).
//
// The numbers are from the firms' public rule summaries as they stood in September 2026. Firms change
// them, and a summary can be wrong: every one of these is to be checked with the firm before buying.
// For a straight-to-funded account `profitTarget` is the profit the first payout needs. A consistency
// rule of 100% means the program has none.

const eval_ = (id: string, firm: string, program: string, size: number, profitTarget: number, drawdown: number, o: Partial<PropRules> = {}): PropRules => ({ id, firm, program, size, profitTarget, drawdown, drawdownType: 'trailing-eod', lockProfit: 0, dailyLossLimit: null, maxMicros: size / 1000, consistencyPercent: 50, consistencyBasis: 'totalProfit', minTradingDays: 1, kind: 'eval', ...o });
const funded = (id: string, firm: string, program: string, size: number, profitTarget: number, drawdown: number, o: Partial<PropRules> = {}): PropRules => ({ ...eval_(id, firm, program, size, profitTarget, drawdown, { lockProfit: 100, ...o }), kind: 'funded' });

const MORE: PropRules[] = [
  // FundedNext Futures, the firm in the "bot farm" screenshots. Rapid has no consistency rule or minimum days
  // in the challenge, which is what lets one trade pass it. Its funded payout rule here (three trading days,
  // $500 of profit, best day at most 40%) is as those screenshots show it; published summaries differ on the
  // contract limit (10 or 20 micros on the 25K challenge), so the stricter one is used.
  eval_('fundednext-rapid-25k', 'FundedNext', 'Rapid 25K', 25_000, 1500, 1000, { maxMicros: 10, consistencyPercent: 100 }),
  eval_('fundednext-rapid-50k', 'FundedNext', 'Rapid 50K', 50_000, 3000, 2000, { maxMicros: 15, consistencyPercent: 100 }),
  eval_('fundednext-legacy-25k', 'FundedNext', 'Legacy 25K', 25_000, 1250, 1000, { maxMicros: 20, consistencyPercent: 40, minTradingDays: 5 }),
  funded('fundednext-funded-25k', 'FundedNext', 'Rapid 25K (funded)', 25_000, 500, 1000, { lockProfit: 0, maxMicros: 15, consistencyPercent: 40, minTradingDays: 3 }),
  funded('fundednext-funded-50k', 'FundedNext', 'Rapid 50K (funded)', 50_000, 500, 2000, { lockProfit: 0, maxMicros: 25, consistencyPercent: 40, minTradingDays: 3 }),
  // The 25K sizes of the firms already here.
  eval_('lucidflex-25k', 'Lucid', 'LucidFlex 25K', 25_000, 1250, 1000, { minTradingDays: 5 }),
  funded('luciddirect-25k', 'Lucid', 'LucidDirect 25K', 25_000, 1500, 1000, { consistencyPercent: 20, minTradingDays: 5 }),
  eval_('apex-eod-25k', 'Apex', 'Apex 4.0 EOD 25K', 25_000, 1500, 1000, { lockProfit: 100, dailyLossLimit: 500, maxMicros: 40, consistencyPercent: 100 }),
  funded('tof-25k', 'Top One', 'Ignite 25K (funded)', 25_000, 1250, 1000, { dailyLossLimit: 500, maxMicros: 10, consistencyPercent: 15 }),
  eval_('lucidflex-150k', 'Lucid', 'LucidFlex 150K', 150_000, 9000, 4500, { minTradingDays: 5 }),
  // LucidDirect's contract limits aren't in the public summaries: taken to be LucidFlex's.
  funded('luciddirect-50k', 'Lucid', 'LucidDirect 50K', 50_000, 3000, 2000, { dailyLossLimit: 1200, consistencyPercent: 20, minTradingDays: 5 }),
  funded('luciddirect-100k', 'Lucid', 'LucidDirect 100K', 100_000, 6000, 3500, { dailyLossLimit: 2100, consistencyPercent: 20, minTradingDays: 5 }),
  funded('luciddirect-150k', 'Lucid', 'LucidDirect 150K', 150_000, 9000, 5000, { dailyLossLimit: 3000, consistencyPercent: 20, minTradingDays: 5 }),
  eval_('topstep-100k', 'Topstep', 'Combine 100K', 100_000, 6000, 3000, { consistencyBasis: 'profitTarget', minTradingDays: 2 }),
  eval_('topstep-150k', 'Topstep', 'Combine 150K', 150_000, 9000, 4500, { consistencyBasis: 'profitTarget', minTradingDays: 2 }),
  funded('tof-100k', 'Top One', 'Ignite 100K (funded)', 100_000, 5000, 4000, { dailyLossLimit: 2000, maxMicros: 50, consistencyPercent: 15 }),
  funded('tof-150k', 'Top One', 'Ignite 150K (funded)', 150_000, 7500, 6000, { dailyLossLimit: 3000, maxMicros: 70, consistencyPercent: 15 }),
  eval_('apex-eod-50k', 'Apex', 'Apex 4.0 EOD 50K', 50_000, 3000, 2000, { lockProfit: 100, dailyLossLimit: 1000, maxMicros: 60, consistencyPercent: 100 }),
  eval_('apex-eod-100k', 'Apex', 'Apex 4.0 EOD 100K', 100_000, 6000, 3000, { lockProfit: 100, dailyLossLimit: 1500, maxMicros: 80, consistencyPercent: 100 }),
  eval_('apex-eod-150k', 'Apex', 'Apex 4.0 EOD 150K', 150_000, 9000, 4000, { lockProfit: 100, dailyLossLimit: 2000, maxMicros: 120, consistencyPercent: 100 }),
  funded('tradeify-lightning-50k', 'Tradeify', 'Lightning 50K (funded)', 50_000, 3000, 2000, { dailyLossLimit: 1250, maxMicros: 40, consistencyPercent: 20 }),
  funded('tradeify-lightning-100k', 'Tradeify', 'Lightning 100K (funded)', 100_000, 6000, 4000, { dailyLossLimit: 2500, maxMicros: 80, consistencyPercent: 20 }),
  funded('tradeify-lightning-150k', 'Tradeify', 'Lightning 150K (funded)', 150_000, 9000, 5250, { dailyLossLimit: 3000, maxMicros: 120, consistencyPercent: 20 }),
];

/** Every account the simulator can play a strategy through: the owner's own first. */
export const ACCOUNT_CATALOG: PropRules[] = [...PROP_ACCOUNTS, ...MORE];
/** Whether an account is one of the owner's own (the rest are there to try). */
export const isOwnAccount = (id: string) => PROP_ACCOUNTS.some((a) => a.id === id);
