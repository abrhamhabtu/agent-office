import type { LiveEvalView, PaperTrade, PlaybookId, PropRules, Symbol } from '../../shared/trading.js';
import { PLAYBOOK_BY_ID, PROP_ACCOUNTS } from '../../shared/trading.js';
import { applyPlan, planLabel, type DayPlan, type PlanMode } from '../../shared/dayplan.js';
import { EVAL_DEFAULTS, runEval } from '../../shared/evalsim.js';
import { MANAGE_BY_ID, managed, type ManageId } from '../../shared/manage.js';
import { ACCOUNT_CATALOG, isOwnAccount } from '../../shared/prop-catalog.js';

// The live eval: one account, one game plan, run forward a day at a time on what the playbooks really
// took on paper, beside what the owner really made on their own account over the same days. The month's
// backtest answers "would it have passed"; this answers "is it passing, and who's ahead".

/** What's being run live, as the owner set it from the eval simulator. Saved with the desk. */
export interface LiveEvalConfig {
  rules: PropRules;
  playbooks: PlaybookId[];
  markets: Symbol[];
  plan: { mode: PlanMode; oneAndDone: boolean; maxTrades: number };
  manage: ManageId;
  opts: { divisor: number; fixedRisk: number | null; fixedMicros?: number | null; dailyStop: boolean; consistency: boolean };
  /** The first trading day it counts (YYYY-MM-DD, Pacific). */
  startDay: string;
  /** The owner's own account it's measured against, and what that account made each day since. */
  mineAccount: string | null;
  mine: Record<string, number>;
}

const MARKETS: Symbol[] = ['NQ', 'ES', 'GC'];
const num = (v: unknown, lo: number, hi: number, fallback: number) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : fallback);

/** A live eval from what the simulator sent, or why not. `today` is the trading day it's asked on. */
export function readLiveEval(b: Record<string, unknown>, today: string, firstPaperDay: string | null, activeOwn: string | null): LiveEvalConfig | string {
  const base = ACCOUNT_CATALOG.find((a) => a.id === b.accountId);
  if (!base) return 'Pick an account to run it on';
  // The account's rules, with any the owner changed on its sheet (numbers only, within reason).
  const r = (b.rules && typeof b.rules === 'object' ? b.rules : {}) as Record<string, unknown>;
  const rules: PropRules = {
    ...base,
    profitTarget: num(r.profitTarget, 1, 1e6, base.profitTarget),
    drawdown: num(r.drawdown, 1, 1e6, base.drawdown),
    minTradingDays: num(r.minTradingDays, 0, 60, base.minTradingDays),
    consistencyPercent: num(r.consistencyPercent, 1, 100, base.consistencyPercent),
    maxMicros: num(r.maxMicros, 1, 1000, base.maxMicros),
    drawdownType: r.drawdownType === 'trailing-eod' || r.drawdownType === 'trailing-intraday' || r.drawdownType === 'static' ? r.drawdownType : base.drawdownType,
    consistencyBasis: r.consistencyBasis === 'profitTarget' || r.consistencyBasis === 'totalProfit' ? r.consistencyBasis : base.consistencyBasis,
  };
  const playbooks = (Array.isArray(b.playbooks) ? b.playbooks : []).filter((p): p is PlaybookId => typeof p === 'string' && p in PLAYBOOK_BY_ID);
  if (!playbooks.length) return 'Pick at least one playbook';
  const markets = MARKETS.filter((m) => !Array.isArray(b.markets) || b.markets.includes(m));
  const p = (b.plan && typeof b.plan === 'object' ? b.plan : {}) as Record<string, unknown>;
  const o = (b.opts && typeof b.opts === 'object' ? b.opts : {}) as Record<string, unknown>;
  // From today, or from as far back as the paper book goes (a month at most), so the line has a history.
  const monthAgo = new Date(Date.parse(`${today}T12:00:00Z`) - 31 * 86_400_000).toISOString().slice(0, 10);
  const startDay = b.from === 'back' && firstPaperDay ? (firstPaperDay > monthAgo ? firstPaperDay : monthAgo) : today;
  return {
    rules,
    playbooks: [...new Set(playbooks)],
    markets: markets.length ? markets : MARKETS,
    plan: { mode: p.mode === 'fallback' || p.mode === 'by-day' ? p.mode : 'every', oneAndDone: p.oneAndDone === true, maxTrades: num(p.maxTrades, 0, 10, 0) },
    manage: typeof b.manage === 'string' && b.manage in MANAGE_BY_ID ? (b.manage as ManageId) : 'written',
    opts: { divisor: num(o.divisor, 2, 50, EVAL_DEFAULTS.divisor), fixedRisk: o.fixedRisk == null ? null : num(o.fixedRisk, 1, 1e5, 150), fixedMicros: o.fixedMicros == null ? null : Math.floor(num(o.fixedMicros, 1, 500, 5)), dailyStop: o.dailyStop !== false, consistency: o.consistency !== false },
    startDay,
    mineAccount: isOwnAccount(rules.id) ? rules.id : activeOwn,
    mine: {},
  };
}

/** Monday to Friday from `from` to `to`, inclusive: the days a futures account could have traded. */
function weekdaysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T12:00:00Z`); t <= Date.parse(`${to}T12:00:00Z`) && out.length < 400; t += 86_400_000) {
    const w = new Date(t).getUTCDay();
    if (w >= 1 && w <= 5) out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** Where the live eval stands: the office's run so far, the owner's own result beside it, and who's ahead. */
export function liveEvalView(cfg: LiveEvalConfig, paper: PaperTrade[], today: string): LiveEvalView {
  const plan: DayPlan = { ...cfg.plan, mode: cfg.playbooks.length > 1 ? cfg.plan.mode : 'every', order: cfg.playbooks };
  const mine = paper.filter((t) => t.day >= cfg.startDay && cfg.playbooks.includes(t.playbook) && cfg.markets.includes(t.symbol));
  const taken = managed(applyPlan(mine, plan), cfg.manage);
  const days = weekdaysBetween(cfg.startDay, today);
  const run = runEval(taken, cfg.rules, cfg.opts, days);
  const series: (number | null)[] = days.map((_, i) => (run.ledger[i] ? run.ledger[i]!.balance - cfg.rules.size : null));
  // After a pass or a bust the account stays where it finished.
  for (let i = 1; i < series.length; i++) if (series[i] == null && run.result !== 'running') series[i] = series[i - 1]!;
  let cum = 0;
  let seen = false;
  const yours = days.map((d) => {
    if (cfg.mine[d] == null) return seen ? cum : null;
    seen = true;
    cum += cfg.mine[d]!;
    return Math.round(cum);
  });
  const own = cfg.mineAccount ? PROP_ACCOUNTS.find((a) => a.id === cfg.mineAccount) : undefined;
  const last = run.ledger.find((d) => d.day === today);
  const label = `${planLabel(plan)}${cfg.manage === 'written' ? '' : ` · ${MANAGE_BY_ID[cfg.manage].short.replace(/^./, (c) => c.toLowerCase())}`}`;
  return {
    accountId: cfg.rules.id,
    firm: cfg.rules.firm,
    program: cfg.rules.program,
    kind: cfg.rules.kind,
    label,
    startDay: cfg.startDay,
    days,
    office: { result: run.result, days: run.days, pnl: run.pnl, target: cfg.rules.profitTarget, cushion: run.ledger.length ? run.ledger[run.ledger.length - 1]!.cushion : cfg.rules.drawdown, drawdown: cfg.rules.drawdown, taken: run.taken, today: last?.pnl ?? 0, todayTrades: last?.taken ?? 0, openNow: mine.filter((t) => t.outcome === 'open').length, why: run.why.replace(/ when the test.s days ran out$/, ''), series },
    you: own ? { accountId: own.id, name: `${own.firm} ${own.program}`, pnl: seen ? Math.round(cum) : null, today: cfg.mine[today] ?? 0, since: Object.keys(cfg.mine).sort()[0] ?? null, series: yours } : null,
  };
}
