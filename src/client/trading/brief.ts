import type { NewsItem, Proposal, ProposalStage, Symbol } from '../../shared/trading';

export const PROPOSAL_STATUS: Record<ProposalStage, string> = {
  live: 'Paper trade active', ready: 'At entry level', watching: 'Waiting for trigger',
  won: 'Target reached', lost: 'Stop reached', closed: 'Closed', failed: 'Setup failed',
  off: 'Outside setup hours', done: 'Finished today',
};
const priority: Record<ProposalStage, number> = { live: 0, ready: 1, watching: 2, won: 3, lost: 3, closed: 3, failed: 4, done: 4, off: 5 };
export function orderedProposals(list: Proposal[]) {
  return [...list].sort((a, b) => priority[a.stage] - priority[b.stage] || Number(b.mark === 'taken') - Number(a.mark === 'taken'));
}
export function marketBrief(list: Proposal[], symbol: Symbol) {
  const all = orderedProposals(list.filter(p => p.symbol === symbol && p.mark !== 'skipped'));
  return { primary: all[0] ?? null, others: all.slice(1), active: all.filter(p => p.stage === 'live').length, ready: all.filter(p => p.stage === 'ready').length };
}
export function nextCondition(p: Proposal) {
  if (p.stage === 'watching' || p.stage === 'ready') {
    const missing = p.checks.find(c => !c.ok);
    if (missing) return `Waiting on: ${missing.label}`;
    if (p.entry == null || !p.checks.length) return 'Waiting for an entry setup to form.';
    return 'Setup checks passed; review the risk guard.';
  }
  if (p.stage === 'live') return 'Paper simulation is tracking this entry.';
  if (p.stage === 'off') return 'This setup is outside its session window.';
  return 'Review the completed setup in full details.';
}

const dateKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });
const day = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', month: 'short', day: 'numeric' });
const time = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hour12: false });
export const eventTime = (at: number) => time.format(at);
export function calendarDays(news: NewsItem[], now: number, range: 'upcoming' | 'today' | 'week') {
  const today = dateKey.format(now);
  const rows = news.filter(n => n.kind === 'calendar' && Number.isFinite(n.at) && (range === 'week' || range === 'today' && dateKey.format(n.at) === today || range === 'upcoming' && n.at >= now));
  const groups = new Map<string, { label: string; items: NewsItem[] }>();
  for (const n of [...rows].sort((a, b) => a.at - b.at)) {
    const key = dateKey.format(n.at);
    if (!groups.has(key)) groups.set(key, { label: `${key === today ? 'Today · ' : ''}${day.format(n.at)}`, items: [] });
    groups.get(key)!.items.push(n);
  }
  return [...groups.values()];
}
export function calendarRows(news: NewsItem[], now: number, max = 5) {
  const cal = news.filter(n => n.kind === 'calendar').sort((a, b) => a.at - b.at);
  const upcoming = cal.filter(n => n.at >= now);
  return upcoming.length ? upcoming.slice(0, max) : cal.slice(-max);
}
