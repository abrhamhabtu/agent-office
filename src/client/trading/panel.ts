import type { FloorRole, Proposal, Ticket, TradingSnapshot } from '../../shared/trading';
import { h, openModal } from '../ui/dom';
import { trading } from './feed';
import { fmt } from './screens';

export type PanelTab = 'news' | 'proposals' | 'playbook' | 'connectors' | 'tickets';

const TABS: { id: PanelTab; label: string; floors: FloorRole[] }[] = [
  { id: 'news', label: '📰 News', floors: ['pit', 'desk'] },
  { id: 'proposals', label: '🎯 Proposals', floors: ['pit'] },
  { id: 'tickets', label: '🎫 Tickets', floors: ['desk', 'pit'] },
  { id: 'playbook', label: '📋 Playbook', floors: ['pit', 'desk'] },
  { id: 'connectors', label: '🔌 Connectors', floors: ['pit', 'desk'] },
];

const STAGE_NOTE: Record<string, string> = {
  watching: 'Waiting for price to come to the entry',
  ready: 'Price is at the entry',
  paper: 'Taken on paper. Prove it, then graduate it',
  graduated: 'Graduated: ticketed on The Desk',
  skipped: 'Skipped today',
};

/** The trading window: every board's detail in one place, with the buttons the boards can't have. */
export function openTrading(role: FloorRole, start?: PanelTab) {
  const tabs = TABS.filter((t) => t.floors.includes(role));
  let tab: PanelTab = start && tabs.some((t) => t.id === start) ? start : tabs[0]!.id;
  let note = '';
  const body = h('div.body', { style: 'display:grid;gap:10px;max-height:70vh;overflow:auto' });
  const nav = h('div.os-tabs');
  const close = h('button.btn.close', { 'aria-label': 'Close' }, '✕');
  const foot = h('span.grow', {});
  const el = h('div.modal', { role: 'dialog', 'aria-label': 'Trading', style: 'width:min(860px,100%)' }, h('header', {}, h('h2', {}, role === 'desk' ? '🌃 The Desk' : '📈 The Pit'), nav, close), body, h('footer', {}, foot));
  let off = () => {};
  const modal = openModal(el, { doing: 'reading the tape', onClose: () => off() });
  close.addEventListener('click', () => modal.close());

  const act = async (id: string, action: 'paper' | 'graduate' | 'skip' | 'reset') => {
    note = (await trading.act(id, action)) ?? '';
    render();
  };

  const card = (...kids: (Node | string)[]) => h('div', { style: 'background:rgba(0,0,0,.05);border-radius:12px;padding:12px 14px;display:grid;gap:6px' }, ...kids);
  const row = (...kids: (Node | string)[]) => h('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' }, ...kids);
  const mono = (t: string, color?: string) => h('span', { style: `font-family:ui-monospace,Menlo,monospace;font-weight:800;${color ? `color:${color}` : ''}` }, t);

  const proposalCard = (p: Proposal, s: TradingSnapshot) => {
    const q = s.quotes.find((x) => x.symbol === p.symbol)!;
    const buttons: HTMLElement[] = [];
    if (p.stage === 'watching' || p.stage === 'ready') buttons.push(h('button.btn', { onclick: () => act(p.id, 'paper') }, 'Take on paper'));
    if (p.stage === 'paper') buttons.push(h('button.btn.primary', { onclick: () => act(p.id, 'graduate') }, 'Graduate to The Desk'));
    if (p.stage !== 'skipped') buttons.push(h('button.btn', { onclick: () => act(p.id, 'skip') }, 'Skip'));
    if (p.stage !== 'watching' && p.stage !== 'ready') buttons.push(h('button.btn', { onclick: () => act(p.id, 'reset') }, 'Reset'));
    return card(
      row(mono(p.symbol, q.ink), mono(p.side.toUpperCase(), p.side === 'long' ? '#0a9d6a' : '#d63c55'), h('b', {}, p.title), h('span', { style: 'opacity:.6' }, `${p.agent} · ${p.strategy}`), mono(`${p.r}R`)),
      row(mono(`entry ${fmt(p.entry, q.decimals)}`), mono(`stop ${fmt(p.stop, q.decimals)}`, '#d63c55'), mono(`target ${fmt(p.target, q.decimals)}`, '#0a9d6a'), h('span', { style: 'opacity:.6' }, `last ${fmt(q.last, q.decimals)}`)),
      row(h('span', { style: 'opacity:.7' }, STAGE_NOTE[p.stage] ?? ''), h('span.grow', {}), ...buttons),
    );
  };

  const ticketCard = (t: Ticket, s: TradingSnapshot) => {
    const q = s.quotes.find((x) => x.symbol === t.symbol)!;
    return card(
      row(mono(t.symbol, q.ink), mono(`${t.side.toUpperCase()} ${t.contracts}×`), mono(`E ${fmt(t.entry, q.decimals)}`), mono(`S ${fmt(t.stop, q.decimals)}`, '#d63c55'), mono(`T ${fmt(t.target, q.decimals)}`, '#0a9d6a'), h('span.grow', {}), mono(t.cleared ? 'CLEARED' : 'STAND DOWN', t.cleared ? '#0a9d6a' : '#d63c55')),
      row(h('span', { style: 'opacity:.7' }, `Risk $${t.riskDollars} · reward $${t.rewardDollars}`)),
      ...t.checks.map((c) => h('div', { style: `color:${c.ok ? '#0a9d6a' : '#d63c55'};font-weight:700` }, `${c.ok ? '✓' : '✗'} ${c.label}`)),
      h('div', { style: 'opacity:.65;font-size:.9em' }, 'Tick lays the ticket out; you place the order at your broker. The office never connects to one.'),
    );
  };

  const render = () => {
    const s = trading.snap;
    nav.replaceChildren(...tabs.map((t) => h('button.btn', { type: 'button', class: t.id === tab ? 'on' : '', onclick: () => ((tab = t.id), (note = ''), render()) }, t.label)));
    foot.textContent = note || (s ? `${s.source === 'sample' ? 'Sample feed — not a market. ' : ''}Paper only. The office never places an order.` : 'Loading…');
    if (!s) return body.replaceChildren(h('p', {}, 'Waiting for the market desk…'));
    if (tab === 'news') {
      body.replaceChildren(...s.news.map((n) => card(row(mono(n.time), mono(n.impact.toUpperCase(), n.impact === 'high' ? '#d63c55' : n.impact === 'med' ? '#c98a00' : undefined), h('b', {}, n.headline), h('span.grow', {}), mono(n.symbols.join(' '))))));
    } else if (tab === 'proposals') {
      body.replaceChildren(...s.proposals.map((p) => proposalCard(p, s)));
    } else if (tab === 'tickets') {
      body.replaceChildren(...(s.tickets.length ? s.tickets.map((t) => ticketCard(t, s)) : [card(h('b', {}, 'No tickets yet'), h('span', { style: 'opacity:.7' }, 'Take a proposal on paper on The Pit, then graduate it. Bulwark checks it against the account rules here.'))]));
    } else if (tab === 'playbook') {
      body.replaceChildren(...s.playbook.map((p) => card(row(h('input', { type: 'checkbox', checked: p.done, onchange: async () => { await trading.togglePlaybook(p.id); render(); } }), h('b', { style: p.done ? 'opacity:.5;text-decoration:line-through' : '' }, p.label), h('span.grow', {}), h('span', { style: 'opacity:.6' }, p.owner)))));
    } else {
      body.replaceChildren(...s.connectors.map((c) => card(row(mono(c.status.toUpperCase(), c.status === 'live' ? '#0a9d6a' : c.status === 'locked' ? '#d63c55' : '#c98a00'), h('b', {}, c.name)), h('span', { style: 'opacity:.7' }, c.note))));
    }
  };
  off = trading.on(() => {
    // Redraw with the snapshot unless someone is midway through a click.
    if (!body.matches(':hover')) render();
  });
  render();
}
