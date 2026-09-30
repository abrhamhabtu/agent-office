import { dataFreshness } from '../../shared/freshness';
import { PLAYBOOKS, SYMBOLS, type Symbol, type PlaybookId } from '../../shared/trading';
import { h, openModal } from '../ui/dom';
import { trading } from './feed';
import { drawChart, fmt, money, STAGE_LABEL, INK } from './screens';
import { openTrading } from './panel';
import './session.css';

const MARKET_KEY = 'agent-office.session-market';
const SETUP_KEY = 'agent-office.session-setup';
function remembered(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function remember(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* Browser storage is unavailable; keep this view usable. */ }
}
const tone = (level: string) => level === 'ok' ? 'ok' : level === 'stop' ? 'stop' : 'warn';
const text = (el: HTMLElement, value: string) => { if (el.textContent !== value) el.textContent = value; };
const card = (title: string, ...children: Node[]) => h('section.session-card', {}, h('h3', {}, title), ...children);

/** One reachable desk; the floor and selected agent sessions continue behind it. */
export function openSessionDesk() {
  let symbol: Symbol = SYMBOLS.find(s => s === remembered(MARKET_KEY)) ?? trading.snap?.markets[0] ?? 'NQ';
  let setup: PlaybookId = PLAYBOOKS.find(p => p.id === remembered(SETUP_KEY))?.id ?? PLAYBOOKS[0]!.id;
  const market = h('select', { 'aria-label': 'Active market' }, ...SYMBOLS.map(s => h('option', { value: s, selected: s === symbol }, s)));
  const setups = h('select', { 'aria-label': 'Setup checklist' }, ...PLAYBOOKS.map(p => h('option', { value: p.id, selected: p.id === setup }, p.name)));
  const price = h('strong.session-price');
  const freshness = h('p.session-freshness');
  const chart = h('canvas', { width: 1024, height: 440, role: 'img', 'aria-label': `${symbol} active chart` });
  const levels = h('dl.session-levels');
  const basis = h('p.session-freshness');
  const plan = h('div.session-plan');
  const checks = h('ul.session-checks');
  const morning = h('div.session-morning');
  const event = h('div.session-event');
  const accounts = h('div.session-accounts');
  const connection = h('span', { role: 'status' });
  const note = h('span', { role: 'status' });
  const close = h('button.btn.close', { 'aria-label': 'Close Session Desk' }, '✕');
  const el = h('div.modal.session-desk', { role: 'dialog', 'aria-label': 'Session Desk' },
    h('header', {}, h('div.grow', {}, h('h2', {}, 'Session Desk'), h('span.session-subtitle', {}, 'Your market, plan and accounts · J to open')), close),
    h('div.body.session-body', {},
      h('div.session-main', {},
        card('Active chart', h('div.session-toolbar', {}, h('label', {}, 'Market ', market), price), freshness, chart),
        card('Important levels', levels),
        card('Setup checklist', h('label', {}, 'Playbook ', setups), plan, basis, checks)),
      h('aside.session-side', {}, card('Next scheduled event', event), card('Account status', accounts), card('Morning checklist', morning))),
    h('footer', {}, connection, h('span.grow'), note, h('button.btn', { onclick: () => { modal.close(); openTrading('bell', 'connections'); } }, 'Data connections')));
  const checklist = new Map<string, HTMLInputElement>();
  let off = () => {};
  let timer = 0;
  const modal = openModal(el, { doing: 'at the session desk', onClose: () => { off(); clearInterval(timer); } });
  close.addEventListener('click', () => modal.close());
  market.addEventListener('change', () => { symbol = market.value as Symbol; remember(MARKET_KEY, symbol); render(); });
  setups.addEventListener('change', () => { setup = setups.value as PlaybookId; remember(SETUP_KEY, setup); render(); });

  function render() {
    const s = trading.snap;
    const now = Date.now();
    if (!s) {
      text(freshness, 'Waiting for market data');
      text(connection, 'Connecting to the office…');
      text(accounts, 'Waiting for account status');
      return;
    }
    text(connection, now - s.at > 10_000 ? 'Office updates interrupted · showing the last snapshot' : 'Office connected · sources and market times shown above');
    const q = s.quotes.find(q => q.symbol === symbol);
    const bars = s.bars[symbol];
    const f = dataFreshness(q, now, bars.at(-1)?.ts ?? null);
    text(price, q ? fmt(q.last, q.decimals) : 'No quote');
    text(freshness, f.detail);
    freshness.dataset.tone = f.tone;
    chart.setAttribute('aria-label', `${symbol} chart · ${f.detail}`);
    const g = chart.getContext('2d')!;
    g.fillStyle = INK.bg;
    g.fillRect(0, 0, chart.width, chart.height);
    const p = s.proposals.find(p => p.symbol === symbol && p.playbook === setup);
    if (q) drawChart(g, 14, 14, chart.width - 28, chart.height - 28, bars.slice(-90), q, s.levels[symbol], { vwap: true, onVwap: true, or: true, prior: true, grid: true, tag: true, plan: p && ['ready', 'live', 'watching'].includes(p.stage) ? p : null });
    if (!bars.length || !q) {
      g.fillStyle = INK.dim;
      g.font = '24px system-ui';
      g.fillText('Waiting for chart data', 24, 70);
    }
    const lv = s.levels[symbol];
    const keyLevels = [ ['VWAP', lv?.vwap], ['Overnight VWAP', lv?.onVwap], ['Overnight high', lv?.onHigh], ['Overnight low', lv?.onLow], ['Prior high', lv?.priorHigh], ['Prior low', lv?.priorLow], ['Opening range high', lv?.orHigh], ['Opening range low', lv?.orLow], ['Value area high', lv?.vah], ['Point of control', lv?.poc], ['Value area low', lv?.val] ] as const;
    levels.replaceChildren(...keyLevels.map(([label, value]) => h('div', {}, h('dt', {}, label), h('dd', {}, fmt(value, q?.decimals ?? 2)))));
    plan.replaceChildren(h('strong', {}, p ? `${STAGE_LABEL[p.stage] ?? p.stage} · ${p.title}` : 'No proposal for this market'), p?.entry != null ? h('p', {}, `Entry ${fmt(p.entry, q?.decimals)} · Stop ${fmt(p.stop, q?.decimals)} · Target ${fmt(p.target, q?.decimals)}`) : h('p', {}, PLAYBOOKS.find(b => b.id === setup)!.rule));
    const pf = dataFreshness(q, now, p?.dataAt ?? null, p?.dataSource);
    text(basis, `Proposal basis · ${pf.detail}`);
    basis.dataset.tone = pf.tone;
    checks.replaceChildren(...(p?.checks.length ? p.checks.map(c => h('li', { 'data-tone': c.ok ? 'ok' : 'warn' }, `${c.ok ? '✓' : '○'} ${c.label}`)) : [h('li', {}, 'Setup checks appear as this playbook evaluates the session.')]));
    const next = s.news.filter(n => n.kind === 'calendar' && n.at >= now).sort((a, b) => a.at - b.at)[0];
    if (next) {
      const seconds = Math.max(0, Math.ceil((next.at - now) / 1000));
      const hours = Math.floor(seconds / 3600);
      const countdown = `${hours}h ${Math.floor(seconds % 3600 / 60)}m ${seconds % 60}s`;
      event.replaceChildren(h('strong', {}, next.headline), h('p', {}, `${next.time} PT · ${next.impact.toUpperCase()} impact`), h('b.session-countdown', {}, `In ${countdown}`), h('small', {}, `Source: ${next.source}`));
    } else text(event, 'No upcoming scheduled event in the current calendar.');
    const active = s.accounts.filter(a => a.active);
    accounts.replaceChildren(h('strong', { 'data-tone': tone(s.guard.level) }, s.guard.headline), ...active.map(a => {
      const guard = s.guard.accounts.find(g => g.accountId === a.rules.id);
      return h('div.session-account', {}, h('b', {}, `${a.rules.firm} · ${a.rules.program}`), h('span', { 'data-tone': tone(guard?.level ?? 'warn') }, guard?.level === 'stop' ? 'STOPPED' : `Risk budget ${money(guard?.maxRisk ?? a.riskPerTrade)}`), h('span', {}, `Balance ${money(a.balance)} · Today ${money(a.todayPnl)}`), h('span', {}, `Cushion ${money(a.cushion)}${guard ? ` · Daily stop left ${money(guard.dailyStopLeft)}` : ''}`), h('small', {}, a.source === 'projectx' ? 'Source: ProjectX · synced account snapshot' : 'Source: manual · update balances in Prop accounts'));
    }), ...(!active.length ? [h('p', {}, 'No active accounts. Choose them in Prop accounts.')] : []));
    for (const item of s.playbook) {
      let input = checklist.get(item.id);
      if (!input) {
        input = h('input', { type: 'checkbox', disabled: item.auto });
        const checkbox = input;
        input.addEventListener('change', async () => {
          checkbox.disabled = true;
          const error = await trading.toggleChecklist(item.id);
          text(note, error ?? 'Checklist saved');
          checkbox.disabled = item.auto;
          render();
        });
        checklist.set(item.id, input);
        morning.append(h('label', {}, input, h('span', {}, item.label, h('small', {}, `${item.owner}${item.auto ? ' · automatic' : ''}`))));
      }
      input.checked = item.done;
    }
  }
  off = trading.on(render);
  timer = window.setInterval(render, 1000);
  render();
}
