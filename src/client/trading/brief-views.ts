import { dataFreshness, marketTime } from '../../shared/freshness';
import { INSTRUMENTS, PLAYBOOK_BY_ID, SYMBOLS, type NewsItem, type Proposal, type ProposalAction, type Symbol, type TradingSnapshot } from '../../shared/trading';
import { h } from '../ui/dom';
import { calendarDays, eventTime, marketBrief, nextCondition, orderedProposals, PROPOSAL_STATUS } from './brief';
import { accountLabel, fmt, money } from './screens';

export type NewsPage = 'calendar' | 'headlines';
const titleOf = (n: NewsItem) => n.headline.split(' · ')[0]!;
const toneOf = (impact: string) => impact === 'high' ? 'stop' : impact === 'med' ? 'warn' : 'muted';
const empty = (text: string) => h('p.brief-empty', { role: 'status' }, text);
const section = (title: string, ...kids: Node[]) => h('section.brief-section', {}, h('h3', {}, title), ...kids);
function replaceContent(root: HTMLElement, ...children: Node[]) {
  const active = document.activeElement as HTMLElement | null;
  const key = active && root.contains(active) ? active.dataset.focus : undefined;
  root.replaceChildren(...children);
  if (key) [...root.querySelectorAll<HTMLElement>('[data-focus]')].find(el => el.dataset.focus === key)?.focus({ preventScroll: true });
}

export function createNewsView(initialPage: NewsPage = 'calendar') {
  let page = initialPage;
  let range: 'upcoming' | 'today' | 'week' = 'upcoming';
  let market = 'all';
  let headPage = 0;
  let snap: TradingSnapshot | null = null;
  const content = h('div.brief-content');
  const info = h('p.brief-source');
  const upcoming = h('button.btn', { type: 'button', onclick: () => { range = 'upcoming'; refresh(); } }, 'Upcoming');
  const today = h('button.btn', { type: 'button', onclick: () => { range = 'today'; refresh(); } }, 'Today');
  const week = h('button.btn', { type: 'button', onclick: () => { range = 'week'; refresh(); } }, 'This week');
  const markets = h('select', { 'aria-label': 'Headlines market' }, h('option', { value: 'all' }, 'All markets'), ...SYMBOLS.map(sym => h('option', { value: sym }, sym)));
  markets.addEventListener('change', () => { market = markets.value; headPage = 0; refresh(); });
  const filters = h('div.brief-toolbar', {}, upcoming, today, week);
  const headFilters = h('div.brief-toolbar', {}, h('label', {}, 'Market ', markets), h('span.brief-muted', {}, 'Newest first · market tags come from the news feed'));
  const calendar = h('button.btn', { type: 'button', onclick: () => { page = 'calendar'; refresh(); } }, 'Calendar');
  const headlines = h('button.btn', { type: 'button', onclick: () => { page = 'headlines'; refresh(); } }, 'Headlines');
  const element = h('div.trading-brief', {}, h('div.brief-pages', { 'aria-label': 'News pages' }, calendar, headlines), filters, headFilters, info, content);

  function refresh() {
    if (!snap) return;
    const s = snap;
    const now = Date.now();
    for (const [btn, selected] of [[calendar, page === 'calendar'], [headlines, page === 'headlines'], [upcoming, range === 'upcoming'], [today, range === 'today'], [week, range === 'week']] as const) {
      btn.classList.toggle('on', selected); btn.setAttribute('aria-pressed', String(selected));
    }
    filters.hidden = page !== 'calendar'; headFilters.hidden = page !== 'headlines';
    const feed = s.feeds.find(f => f.id === (page === 'calendar' ? 'calendar' : 'headlines'));
    info.textContent = `${page === 'calendar' ? 'US releases · all times Pacific' : 'Headlines'} · ${feed?.name ?? 'Waiting for the source'} · Last fetched ${marketTime(feed?.lastAt)}${feed && !feed.ok ? ' · Source unavailable; showing the last received items' : ''}`;
    if (page === 'calendar') {
      const groups = calendarDays(s.news, now, range);
      replaceContent(content, ...(groups.length ? groups.map(group => {
        const table = h('table.calendar-table', {},
          h('thead', {}, h('tr', {}, ...['Time (PT)', 'Event', 'Impact', 'Actual', 'Expected', 'Previous'].map(label => h('th', { scope: 'col' }, label)))),
          h('tbody', {}, ...group.items.map(n => h('tr', { class: n.at < now ? 'released' : '' },
            h('td.event-clock', {}, eventTime(n.at), h('small', {}, n.at < now ? n.actual ? 'Released' : 'Awaiting actual' : 'Upcoming')),
            h('th', { scope: 'row' }, titleOf(n)), h('td', {}, h('span.brief-impact', { 'data-tone': toneOf(n.impact) }, n.impact === 'med' ? 'Medium' : n.impact === 'high' ? 'High' : 'Low')),
            h('td.event-number', {}, n.actual || '—'), h('td.event-number', {}, n.forecast || '—'), h('td.event-number', {}, n.previous || '—')))));
        return section(group.label, h('div.brief-table-scroll', {}, table));
      }) : [empty('No releases in this view. Choose Today or This week to review the calendar.') ]));
      return;
    }
    const items = s.news.filter(n => n.kind === 'headline' && (market === 'all' || n.symbols.includes(market as Symbol))).sort((a, b) => b.at - a.at);
    const pages = Math.max(1, Math.ceil(items.length / 8));
    headPage = Math.min(headPage, pages - 1);
    const cards = items.slice(headPage * 8, headPage * 8 + 8).map(n => h('article.headline-row', {},
      h('div.headline-meta', {}, h('span', {}, n.source), h('time', { datetime: new Date(n.at).toISOString() }, marketTime(n.at)), h('span.brief-impact', { 'data-tone': toneOf(n.impact) }, n.impact === 'med' ? 'Medium impact' : `${n.impact === 'high' ? 'High' : 'Low'} impact`)),
      n.link ? h('a', { href: n.link, target: '_blank', rel: 'noopener noreferrer', 'data-focus': `news:${n.id}` }, n.headline) : h('strong', {}, n.headline),
      h('small.brief-muted', {}, n.symbols.length ? `Markets: ${n.symbols.join(' · ')}` : 'General market news')));
    const previous = h('button.btn', { type: 'button', disabled: !headPage, 'data-focus': 'headlines-previous', onclick: () => { headPage--; refresh(); } }, '← Previous');
    const next = h('button.btn', { type: 'button', disabled: headPage >= pages - 1, 'data-focus': 'headlines-next', onclick: () => { headPage++; refresh(); } }, 'Next →');
    replaceContent(content, ...(cards.length ? cards : [empty('No headlines for this market in the current feed.')]), h('div.brief-pagination', {}, previous, h('span', {}, `Page ${headPage + 1} of ${pages} · ${items.length} headlines`), next));
  }
  return { element, update(s: TradingSnapshot) { snap = s; refresh(); } };
}

export function createProposalView(actions: { act: (id: string, action: ProposalAction) => void; markets: (symbol: Symbol) => void }) {
  let mode: 'overview' | 'all' = 'overview';
  let filter = 'all';
  let snap: TradingSnapshot | null = null;
  const expanded = new Set<string>();
  const cards = h('div.proposal-list');
  const guard = h('div.brief-guard');
  const count = h('p.brief-muted');
  const overview = h('button.btn', { type: 'button', onclick: () => { mode = 'overview'; refresh(); } }, 'Overview');
  const all = h('button.btn', { type: 'button', onclick: () => { mode = 'all'; refresh(); } }, 'All setups');
  const market = h('select', { 'aria-label': 'Proposal market' }, h('option', { value: 'all' }, 'All tracked markets'), ...SYMBOLS.map(sym => h('option', { value: sym }, sym)));
  market.addEventListener('change', () => { filter = market.value; refresh(); });
  const tracking = h('div.brief-toolbar');
  const trackingDetails = h('details.brief-settings', {}, h('summary', {}, 'Tracked markets'), h('p.brief-muted', {}, 'Choose which markets the office evaluates. This changes the shared watchlist.'), tracking);
  const element = h('div.trading-brief', {}, h('div.brief-toolbar', {}, h('div.brief-pages', { 'aria-label': 'Proposal pages' }, overview, all), h('label', {}, 'Show ', market)), guard, count, cards, trackingDetails);
  function viewAll(sym: Symbol) { filter = sym; market.value = sym; mode = 'all'; refresh(); }
  function proposal(p: Proposal, s: TradingSnapshot, otherCount = 0) {
    const q = s.quotes.find(q => q.symbol === p.symbol);
    const d = q?.decimals ?? 2;
    const f = dataFreshness(q, Date.now(), p.dataAt ?? null, p.dataSource);
    const status = p.mark === 'skipped' ? 'Skipped' : PROPOSAL_STATUS[p.stage];
    const priceRow = p.entry != null && p.stage !== 'off' ? h('dl.proposal-prices', {}, ...([['Entry', p.entry], ['Stop', p.stop], ['Target', p.target]] as const).map(([label, value]) => h('div', {}, h('dt', {}, label), h('dd', {}, fmt(value, d))))) : null;
    const details = h('details.proposal-details', { open: expanded.has(p.id) },
      h('summary', { 'data-focus': `details:${p.id}` }, 'Checks, risk and actions'),
      h('div.proposal-detail-body', {}, h('p', {}, PLAYBOOK_BY_ID[p.playbook].rule),
        section('Setup checks', h('ul.proposal-checks', {}, ...p.checks.map(c => h('li', { 'data-tone': c.ok ? 'ok' : 'warn' }, `${c.ok ? '✓' : '○'} ${c.label}`)))),
        section('Account sizing', ...(p.sizing.length && p.entry != null ? p.sizing.map(z => h('div.proposal-sizing', {}, h('span', {}, accountLabel(z.accountId)), h('strong', {}, `${z.micros} ${INSTRUMENTS[p.symbol].micro}`), h('span', {}, `${money(z.risk)} risk`))) : [h('p.brief-muted', {}, 'No position size available for this setup.') ])),
        p.r != null ? h('p', {}, `Planned reward-to-risk: ${p.r}:1`) : null,
        p.note ? h('p.brief-muted', {}, p.note) : null,
        h('div.brief-toolbar', {}, p.mark !== 'taken' ? h('button.btn', { type: 'button', 'data-focus': `take:${p.id}`, onclick: () => actions.act(p.id, 'take') }, 'Record that I took it') : null,
          p.mark !== 'skipped' ? h('button.btn', { type: 'button', 'data-focus': `skip:${p.id}`, onclick: () => actions.act(p.id, 'skip') }, 'Skip setup') : null,
          p.mark ? h('button.btn', { type: 'button', 'data-focus': `reset:${p.id}`, onclick: () => actions.act(p.id, 'reset') }, 'Undo record') : null),
        h('small.brief-muted', {}, 'These buttons only record your decision. They do not submit an order.')));
    details.addEventListener('toggle', () => { if (details.open) expanded.add(p.id); else expanded.delete(p.id); });
    return h('article.proposal-summary', { 'data-stage': p.stage },
      h('div.proposal-heading', {}, h('strong.proposal-market', {}, p.symbol), h('span.proposal-status', {}, status), p.mark === 'taken' ? h('span', {}, 'You recorded this trade') : null, p.side ? h('span.proposal-direction', {}, p.side === 'long' ? 'Long setup' : 'Short setup') : null),
      h('h3', {}, PLAYBOOK_BY_ID[p.playbook].name), h('p.proposal-title', {}, p.title),
      h('p.proposal-condition', {}, nextCondition(p)), priceRow,
      h('div.proposal-source', { 'data-tone': f.tone }, h('strong', {}, f.status), h('span', {}, `${f.source} · Quote ${marketTime(q?.updatedAt)} (${f.quoteStatus})`), h('span', {}, `${f.barSource} candles · ${marketTime(p.dataAt)} (${f.barStatus})`)),
      otherCount ? h('button.brief-more', { type: 'button', 'data-focus': `more:${p.symbol}`, onclick: () => viewAll(p.symbol) }, `${otherCount} more ${p.symbol} setups · View all →`) : null, details);
  }
  function refresh() {
    if (!snap) return;
    const s = snap;
    for (const [btn, selected] of [[overview, mode === 'overview'], [all, mode === 'all']] as const) {
      btn.classList.toggle('on', selected); btn.setAttribute('aria-pressed', String(selected));
    }
    guard.dataset.tone = s.guard.level === 'ok' ? 'ok' : s.guard.level === 'stop' ? 'stop' : 'warn';
    guard.textContent = s.guard.headline;
    count.textContent = mode === 'overview' ? 'One priority setup per market. Paper trades appear first, then setups at entry, then waiting setups. Open All setups to see the rest.' : 'All playbooks, including completed, off-hours and skipped setups. Checks and account sizing are inside each row.';
    replaceContent(tracking, ...SYMBOLS.map(sym => h('button.btn', { type: 'button', 'aria-pressed': String(s.markets.includes(sym)), class: s.markets.includes(sym) ? 'on' : '', 'data-focus': `tracked:${sym}`, onclick: () => actions.markets(sym) }, sym)));
    const shown = s.markets.filter(sym => filter === 'all' || sym === filter);
    if (mode === 'all') {
      const list = orderedProposals(s.proposals.filter(p => shown.includes(p.symbol)));
      replaceContent(cards, ...(list.length ? list.map(p => proposal(p, s)) : [empty('No setups for this market in the current snapshot.') ]));
    } else replaceContent(cards, ...shown.map(sym => {
      const brief = marketBrief(s.proposals, sym);
      return brief.primary ? h('div', {}, brief.active > 1 ? h('p.brief-muted', {}, `${sym}: ${brief.active} paper trades are active. View all for the other tracked entries.`) : null, proposal(brief.primary, s, brief.others.length)) : h('article.proposal-summary', {}, h('h3', {}, sym), empty('No unskipped setups. Open All setups to review recorded decisions.'), h('button.brief-more', { type: 'button', onclick: () => viewAll(sym) }, 'View all setups →'));
    }), ...(!shown.length ? [empty('This market is not tracked. Choose All tracked markets or update Tracked markets below.')] : []));
  }
  return { element, update(s: TradingSnapshot) { snap = s; refresh(); } };
}
