import { PLAYBOOK_BY_ID, type PaperTrade, type PlaybookId } from './trading.js';
import { applyFilters, envOf, FILTER_BY_ID, type FilterId } from './backtest-lab.js';
import { sliceStats, splitDays, validate, type ValidationReport } from './validation.js';
import { COSTS, type CostId } from './fills.js';
import { canTrade, cushionOf, DaySession, fillOf, openAccount, passCheck } from './account-ledger.js';
import { CUSHION_BASELINE, sizeTrade } from './risk-policy.js';
import { FARM_PROGRAMS } from './farm.js';
import { fromPropRules, isVerified, ruleIssues, type RuleSet } from './prop-rules.js';
import { ACCOUNT_CATALOG } from './prop-catalog.js';
import type { FuturesSymbol } from './history-data.js';

export const RESEARCH_PLAYBOOKS: PlaybookId[] = ['vwap-pullback', 'support-resistance', 'failed-auction'];
export const RESEARCH_FILTERS: FilterId[] = ['ema-trend', 'ema50-side', 'macd-with', 'rsi-room', 'adx-trending', 'adx-quiet', 'vol-up', 'first-hour', 'before-lunch'];
// Catalog-only rules retain their reported provenance: they are scenarios, not current offers.
const EVALUATIONS = [
  ...FARM_PROGRAMS.filter(p => p.evalRules).map(p => ({ id: p.id, name: `${p.firm} · ${p.name}`, rules: p.evalRules! })),
  ...ACCOUNT_CATALOG.filter(p => p.kind === 'eval' && ['Topstep', 'Apex'].includes(p.firm))
    .map(p => ({ id: p.id, name: `${p.firm} · ${p.program}`, rules: fromPropRules(p) })),
];
export interface AccountReplay {
  status: string; profit: number; days: number; taken: number; skipped: number; why: string;
}
export interface FirmComparison {
  id: string; name: string; ruleSet: string; verifiedOn: string | null; verified: boolean;
  target: number; drawdown: number; basis: string; issues: string[]; sources: { label: string; url: string }[];
  baseline: AccountReplay; candidate: AccountReplay; stressed: AccountReplay;
}
export interface StrategyFinding {
  playbook: PlaybookId; filter: FilterId | null; rule: string; tried: number;
  report: ValidationReport; firms: FirmComparison[];
}
export interface ResearchReport {
  id: string; createdAt: number; dataset: string; markets: FuturesSymbol[]; days: string[];
  cap: number; sources: { symbol: FuturesSymbol; label: string; bars: number; first: number; last: number }[];
  findings: StrategyFinding[]; holdout: { playbook: PlaybookId; openedAt: number } | null;
  notes: string[];
}
export interface ResearchStatus { busy: boolean; stage: string; error: string | null; report: ResearchReport | null }

/** One account on chronological validation sessions. Never rebuy a failed attempt or confirm a real pass. */
export function researchAccount(trades: PaperTrade[], days: string[], rules: RuleSet, cap: number, cost: CostId): AccountReplay {
  const account = openAccount(rules, { id: 'research', day: days[0] ?? '', environment: 'simulated' });
  let taken = 0; let skipped = 0; let sessions = 0;
  for (const day of days) {
    if (!canTrade(account.status)) break;
    const session = new DaySession(account, rules, day); const opening = cushionOf(account, rules);
    for (const t of trades.filter(t => t.day === day && t.outcome !== 'open').sort((a, b) => a.entryAt - b.entryAt)) {
      session.advance(t.entryAt + 60_000);
      if (!canTrade(account.status) || session.stopped || session.lossesToday >= 3) { skipped++; continue; }
      const size = sizeTrade({ symbol: t.symbol, stopPoints: Math.abs(t.entry - t.stop), policy: { ...CUSHION_BASELINE, cap },
        cost: COSTS[cost], allowedMicros: account.allowedMicros, openMicros: session.openMicros, openRisk: session.openRisk,
        cushion: cushionOf(account, rules), dayStartCushion: opening, dayLoss: Math.max(0, -session.dayPnl), dailyLossLimit: rules.dailyLossLimit });
      if (!size.micros || session.add(fillOf(t, size.micros, COSTS[cost]))) skipped++; else taken++;
    }
    session.close(); sessions++;
  }
  const check = passCheck(account, rules);
  return { status: account.status, profit: Math.round(account.balance - account.start), days: sessions, taken, skipped,
    why: account.status === 'breached' ? account.why : check.passed ? 'Simulated pass; firm confirmation is still required' : check.pending.join('; ') || account.why };
}

/** Candidate selection sees training only. Indicators are fixed filters, not a rewrite of the entry engine. */
export function researchFindings(trades: PaperTrade[], days: string[], cap = 5): StrategyFinding[] {
  const split = splitDays(days); const training = new Set(split.train);
  // Any whole-sample thresholds (e.g. ATR) must be trained here, never on validation or holdout.
  const env = envOf(trades.filter(t => training.has(t.day)));
  return RESEARCH_PLAYBOOKS.map(playbook => {
    const all = trades.filter(t => t.playbook === playbook);
    const base = sliceStats(all, split.train);
    const candidates = RESEARCH_FILTERS.map(filter => {
      const filtered = applyFilters(all, [filter], env);
      return { filter, trades: filtered, stats: sliceStats(filtered, split.train), stressed: sliceStats(filtered, split.train, 'stressed') };
    }).filter(c => c.stats.trades >= 20 && c.stats.trades >= base.trades * 0.35 && c.stats.avgR > base.avgR && c.stressed.avgR > 0 && c.stats.maxDrawdownR <= base.maxDrawdownR)
      .sort((a, b) => b.stats.avgR - a.stats.avgR || a.filter.localeCompare(b.filter));
    const picked = candidates[0]; const filter = picked?.filter ?? null;
    const chosen = picked?.trades ?? all;
    const baseline = { id: playbook, name: PLAYBOOK_BY_ID[playbook].name, family: playbook, trades: all };
    const candidate = { id: `${playbook}:${filter ?? 'baseline'}`, name: filter ? `${baseline.name} + ${FILTER_BY_ID[filter].name}` : baseline.name,
      family: playbook, trades: chosen, selectedOn: split.train };
    const report = validate(candidate, baseline, { days, searchCount: RESEARCH_FILTERS.length, minTrades: 20 });
    const firms = EVALUATIONS.map(p => {
      const r = p.rules;
      return { id: p.id, name: p.name, ruleSet: r.id, verifiedOn: r.verifiedOn, verified: isVerified(r), target: r.profitTarget, drawdown: r.drawdown,
        basis: r.basis, issues: ruleIssues(r), sources: r.sources, baseline: researchAccount(all, split.validation, r, cap, 'base'),
        candidate: researchAccount(chosen, split.validation, r, cap, 'base'), stressed: researchAccount(chosen, split.validation, r, cap, 'stressed') };
    }).sort((a, b) => Number(b.verified) - Number(a.verified) || a.name.localeCompare(b.name));
    return { playbook, filter, rule: filter ? FILTER_BY_ID[filter].rule : 'No filter cleared the training requirements. Keep the original rules.', tried: RESEARCH_FILTERS.length, report, firms };
  });
}

/** The selected candidate remains fixed when its reserved quarter is opened. */
export function holdoutFinding(finding: StrategyFinding, trades: PaperTrade[], days: string[]): ValidationReport {
  const all = trades.filter(t => t.playbook === finding.playbook); const split = splitDays(days);
  const filtered = applyFilters(all, finding.filter ? [finding.filter] : [], envOf(trades.filter(t => split.train.includes(t.day))));
  return validate({ id: finding.report.candidate.id, name: finding.report.candidate.name, family: finding.playbook, trades: filtered, selectedOn: split.train },
    { id: finding.playbook, name: PLAYBOOK_BY_ID[finding.playbook].name, family: finding.playbook, trades: all },
    { days, searchCount: finding.tried, minTrades: 20, openHoldout: true });
}
