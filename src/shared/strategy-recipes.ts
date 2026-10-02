import type { FarmStrategy } from './farm.js';
import { PLAYBOOKS } from './trading.js';

export interface StrategyRecipe { id: string; name: string; why: string; strategy: FarmStrategy }
const mix = (id: string, name: string, why: string, playbooks: FarmStrategy['playbooks'], mode: FarmStrategy['mode']): StrategyRecipe => ({
  id, name, why, strategy: { playbooks, mode, manage: 'written', markets: ['NQ', 'ES', 'GC'] },
});
/** Candidate hypotheses, not recommendations inferred from the same test month. */
export const STRATEGY_RECIPES: StrategyRecipe[] = [
  ...PLAYBOOKS.map(p => mix(p.id, p.name, p.rule, [p.id], 'every')),
  mix('vwap-levels', 'VWAP + support/resistance', 'Compare both signal families. Overlapping positions still share the account risk budget.', ['vwap-pullback', 'support-resistance'], 'every'),
  mix('trend-range', 'Trend pullback / range rejection', 'VWAP pullbacks when ADX is at least 20; failed auctions below 20. Missing ADX means abstain.', ['vwap-pullback', 'failed-auction'], 'by-day'),
  mix('levels-vwap', 'Levels first, VWAP fallback', 'Support/resistance gets the first chance. VWAP takes over only after failure or the documented fallback time.', ['support-resistance', 'vwap-pullback'], 'fallback'),
  mix('break-auction', 'Breakout / auction regime mix', 'Double Break in a trend; Failed Auction in a range. Test costs and unfamiliar days before promotion.', ['double-break', 'failed-auction'], 'by-day'),
];
