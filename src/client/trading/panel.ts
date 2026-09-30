import { createNewsView, createProposalView, type NewsPage } from './brief-views';
import './brief.css';
import type { FloorRole, TradingSnapshot } from '../../shared/trading';
import { DAILY_STOP, INSTRUMENTS, PLAYBOOK_BY_ID, PLAYBOOKS, PROP_ACCOUNTS, SYMBOLS } from '../../shared/trading';
import { h, openModal } from '../ui/dom';
import { trading } from './feed';
import { accountLabel, fmt, money, pct } from './screens';

export type PanelTab = 'proposals' | 'news' | 'playbook' | 'accounts' | 'paper' | 'backtest' | 'alerts' | 'connections';

const TABS: { id: PanelTab; label: string }[] = [
  { id: 'proposals', label: '🎯 Proposals' },
  { id: 'news', label: '📰 News' },
  { id: 'playbook', label: '📋 Playbook' },
  { id: 'accounts', label: '🛡️ Risk guard' },
  { id: 'paper', label: '📒 Paper' },
  { id: 'backtest', label: '🧪 Backtest' },
  { id: 'alerts', label: '🔔 Alerts & journal' },
  { id: 'connections', label: '🔌 Connections' },
];

const GOOD = '#0a9d6a';
const BAD = '#d63c55';
const WARN = '#c98a00';

/** The trading window: every board's detail in one place, with the buttons and settings the boards can't have. */
export function openTrading(role: FloorRole, start?: PanelTab, initial?: { newsPage?: NewsPage }) {
  let tab: PanelTab = start ?? (role === 'office' ? 'backtest' : 'proposals');
  let note = '';
  const body = h('div.body', { style: 'display:grid;gap:10px;max-height:72vh;overflow:auto' });
  const nav = h('div.os-tabs', { style: 'flex-wrap:wrap;padding:0 16px 8px' });
  const close = h('button.btn.close', { 'aria-label': 'Close' }, '✕');
  const foot = h('span.grow', {});
  const title = role === 'office' ? '🗄️ Back Office' : '🔔 Opening Bell';
  const el = h('div.modal', { role: 'dialog', 'aria-label': 'Trading', style: 'width:min(980px,100%)' }, h('header', {}, h('h2', { style: 'flex:1' }, title), close), nav, body, h('footer', {}, foot));
  let off = () => {};
  const modal = openModal(el, { doing: 'reading the tape', onClose: () => off() });
  close.addEventListener('click', () => modal.close());
  // Typing into a field shouldn't be wiped by the next snapshot.
  let editing = false;
  el.addEventListener('focusin', (e) => (editing = (e.target as HTMLElement).matches('input,select,textarea')));
  el.addEventListener('focusout', () => (editing = false));

  const run = async (p: Promise<string | undefined>, ok?: string) => {
    note = (await p) ?? ok ?? '';
    render();
  };

  const card = (...kids: (Node | string | null)[]) => h('div', { style: 'background:rgba(0,0,0,.05);border-radius:12px;padding:12px 14px;display:grid;gap:6px' }, ...kids);
  const row = (...kids: (Node | string | null)[]) => h('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' }, ...kids);
  const mono = (t: string, color?: string) => h('span', { style: `font-family:ui-monospace,Menlo,monospace;font-weight:800;${color ? `color:${color}` : ''}` }, t);
  const dim = (t: string) => h('span', { style: 'opacity:.65' }, t);
  const heading = (t: string) => h('h3', { style: 'margin:6px 0 0' }, t);
  const tone = (v: number) => (v >= 0 ? GOOD : BAD);

  const newsView = createNewsView(initial?.newsPage);
  const proposalView = createProposalView({
    act: (id, action) => { void run(trading.act(id, action)); },
    markets: (sym) => {
      const s = trading.snap;
      if (!s) return;
      const markets = s.markets.includes(sym) ? s.markets.filter(m => m !== sym) : [...s.markets, sym];
      void run(trading.post('/api/trading/markets', { markets }));
    },
  });
  const views: Record<PanelTab, (s: TradingSnapshot) => (Node | null)[]> = {
    proposals: (s) => { proposalView.update(s); return [proposalView.element]; },
    news: (s) => { newsView.update(s); return [newsView.element]; },
    playbook: (s) => [
      heading('The morning checklist'),
      ...s.playbook.map((p) =>
        card(row(h('input', { type: 'checkbox', checked: p.done, disabled: p.auto, onchange: () => run(trading.toggleChecklist(p.id)) }), h('b', { style: p.done ? 'opacity:.55;text-decoration:line-through' : '' }, p.label), h('span.grow', {}), dim(p.auto ? `auto · ${p.owner}` : p.owner))),
      ),
      heading('Bias'),
      ...s.bias.map((b) => card(row(mono(b.symbol, INSTRUMENTS[b.symbol].ink), mono(b.direction.toUpperCase(), b.direction === 'long' ? GOOD : b.direction === 'short' ? BAD : undefined), b.fit ? h('span', { style: `color:${PLAYBOOK_BY_ID[b.fit].color};font-weight:800` }, `fits ${PLAYBOOK_BY_ID[b.fit].name}`) : null), ...b.lines.map((l) => dim(`• ${l}`)))),
      heading('The playbooks'),
      // Where each idea came from stays tucked inside; the boards just name the setup.
      ...PLAYBOOKS.map((p) => card(h('details', {}, h('summary', { style: `color:${p.color};font-weight:800;cursor:pointer` }, `${p.name} · ${p.agent}'s desk`), dim(p.rule), dim(`Source: ${p.mentor} (from Trade Pilot’s playbooks)`)))),
    ],
    accounts: (s) => {
      const gd = s.guard;
      const ink = (l: 'ok' | 'warn' | 'stop') => (l === 'ok' ? GOOD : l === 'warn' ? WARN : BAD);
      // The position sizer: a market and a stop, and what every account can take on it right now.
      const market = h('select', {}, ...SYMBOLS.map((sym) => h('option', { value: sym, selected: sym === s.markets[0] }, `${sym} (${INSTRUMENTS[sym].micro})`)));
      const stopIn = h('input', { type: 'number', min: '0', step: '0.25', placeholder: 'stop, points', style: 'width:120px' });
      const out = h('div', { style: 'display:grid;gap:4px' }, dim('Type the stop distance to size the trade.'));
      const size = () => {
        const sym = market.value as (typeof SYMBOLS)[number];
        const pts = Number(stopIn.value);
        if (!(pts > 0)) return out.replaceChildren(dim('Type the stop distance to size the trade.'));
        const perMicro = pts * INSTRUMENTS[sym].microPointValue;
        out.replaceChildren(
          dim(`One ${INSTRUMENTS[sym].micro} risks $${perMicro.toFixed(2)} on a ${pts}-point stop.`),
          ...gd.accounts.map((ag) => {
            const a = s.accounts.find((x) => x.rules.id === ag.accountId)!;
            const n = ag.maxRisk ? Math.min(a.rules.maxMicros, Math.floor(ag.maxRisk / perMicro)) : 0;
            return row(h('b', { style: 'min-width:190px' }, accountLabel(ag.accountId)), n ? mono(`${n} ${INSTRUMENTS[sym].micro}`, GOOD) : mono('NO TRADE', BAD), dim(n ? `risks $${(n * perMicro).toFixed(0)} of $${ag.maxRisk} allowed` : ag.maxRisk ? 'the stop is too wide for this account’s risk' : ag.reasons.find((r) => r.level === 'stop')?.label ?? 'stopped'));
          }),
        );
      };
      market.addEventListener('change', size);
      stopIn.addEventListener('input', size);
      return [
        card(
          row(mono(gd.level === 'ok' ? 'CLEAR' : gd.level === 'warn' ? 'CAREFUL' : 'STAND DOWN', ink(gd.level)), h('b', {}, gd.headline)),
          ...gd.reasons.map((r) => h('div', { style: `color:${ink(r.level)};font-weight:700` }, `${r.level === 'ok' ? '✓' : r.level === 'warn' ? '⚠' : '⛔'} ${r.label}`)),
          dim(`Daily stop: ${DAILY_STOP.losses} losses or down ${DAILY_STOP.risks} risks, then you’re done. News: no new trades 15 minutes before a high-impact print until 5 after. Flat by 13:00 PT.`),
        ),
        heading('Position sizer'),
        card(row(market, stopIn), out),
        heading('Accounts'),
        dim('Law of 10: risk a tenth of the drawdown you have left, recompiled after every trade. Link ProjectX (Connections) to follow the real balance and fills, or log trades here by hand. Rules are from Trade Pilot: check them with the firm.'),
        ...s.accounts.map((a) => {
          const ag = gd.accounts.find((x) => x.accountId === a.rules.id);
          const bal = h('input', { type: 'number', value: String(a.balance), step: '0.01', style: 'width:120px', disabled: a.source === 'projectx' });
          const pnl = h('input', { type: 'number', step: '0.01', placeholder: '+/− $', style: 'width:90px' });
          const link = h('select', {}, h('option', { value: '' }, 'Not linked'), ...s.journal.accounts.map((x) => h('option', { value: String(x.id), selected: a.source === 'projectx' && a.balance === x.balance }, `${x.name} (${money(x.balance)})`)));
          return card(
            row(h('input', { type: 'checkbox', checked: a.active, title: 'Size proposals for this account', onchange: (e: Event) => run(trading.post('/api/trading/account', { id: a.rules.id, active: (e.target as HTMLInputElement).checked })) }), h('b', {}, `${a.rules.firm} · ${a.rules.program}`), dim(a.rules.kind === 'funded' ? 'funded' : 'evaluation'), h('span.grow', {}), ag ? mono(ag.level === 'stop' ? 'STOPPED' : `risk $${ag.maxRisk}`, ink(ag.level)) : dim('not active')),
            ...(ag?.reasons ?? []).map((r) => h('div', { style: `color:${ink(r.level)};font-weight:700` }, `${r.level === 'ok' ? '✓' : r.level === 'warn' ? '⚠' : '⛔'} ${r.label}`)),
            row(mono(`today ${money(a.todayPnl)}`, a.todayPnl >= 0 ? GOOD : BAD), dim(`${a.tradesToday} trades · ${a.lossesToday}/${DAILY_STOP.losses} losses`), ag ? dim(`· daily stop $${ag.dailyStopLeft} away`) : null, ag?.dayCap ? dim(`· best-day cap ~$${ag.dayCap}`) : null),
            a.source === 'manual'
              ? row(dim('Log a trade'), pnl, h('button.btn', { onclick: () => run(trading.post('/api/trading/account', { id: a.rules.id, log: Number(pnl.value) }), 'Logged') }, 'Log'), dim('Balance'), bal, h('button.btn', { onclick: () => run(trading.post('/api/trading/account', { id: a.rules.id, balance: Number(bal.value) }), 'Saved') }, 'Save'), a.tradesToday ? h('button.btn', { onclick: () => run(trading.post('/api/trading/account', { id: a.rules.id, resetToday: true }), 'Today cleared') }, 'Clear today') : null)
              : null,
            s.journal.accounts.length ? row(dim('ProjectX'), link, h('button.btn', { onclick: () => run(trading.post('/api/trading/account', { id: a.rules.id, projectxId: link.value ? Number(link.value) : null })) }, 'Link')) : null,
            row(mono(`cushion ${money(a.cushion)} / ${money(a.rules.drawdown)}`, a.cushion > a.rules.drawdown * 0.5 ? GOOD : BAD), dim(`fails at ${money(a.threshold)} · ${money(a.toTarget)} to the ${money(a.rules.profitTarget)} target · ${a.rules.drawdownType.replace('-', ' ')} drawdown · consistency ${a.rules.consistencyPercent}% of ${a.rules.consistencyBasis === 'profitTarget' ? 'the target' : 'total profit'} · ${a.rules.minTradingDays} days min · up to ${a.rules.maxMicros} micros`)),
          );
        }),
      ];
    },
    paper: (s) => [
      dim('The playbooks paper-trade themselves: every setup that triggers is filled on the signal candle’s close and tracked to its stop, its target, or flat at 13:00 PT. P&L is for one micro.'),
      row(...s.paper.stats.map((st) => card(h('b', { style: `color:${PLAYBOOK_BY_ID[st.playbook].color}` }, PLAYBOOK_BY_ID[st.playbook].name), mono(`${st.totalR >= 0 ? '+' : ''}${st.totalR}R`, tone(st.totalR)), dim(`${st.trades} trades · ${Math.round(st.winRate * 100)}% win · ${money(st.dollars)}/micro`)))),
      heading(`Today: ${s.paper.todayR >= 0 ? '+' : ''}${s.paper.todayR}R · ${money(s.paper.todayDollars)} per micro`),
      ...(s.paper.today.length ? s.paper.today : [null]).map((t) =>
        t ? card(row(mono(t.symbol, INSTRUMENTS[t.symbol].ink), mono(t.side.toUpperCase(), t.side === 'long' ? GOOD : BAD), h('b', {}, PLAYBOOK_BY_ID[t.playbook].name), h('span.grow', {}), mono(t.outcome === 'open' ? `LIVE ${t.r}R` : `${t.r >= 0 ? '+' : ''}${t.r}R`, t.outcome === 'open' ? undefined : tone(t.r)), mono(money(t.dollars))), dim(`${t.why} · entry ${t.entry} stop ${t.stop} target ${t.target}${t.exit != null ? ` → ${t.exit} (${t.outcome})` : ''}`)) : dim('No paper trades yet today.'),
      ),
      heading('Before today'),
      ...s.paper.recent.slice(0, 25).map((t) => row(mono(t.day), mono(t.symbol, INSTRUMENTS[t.symbol].ink), dim(PLAYBOOK_BY_ID[t.playbook].short), mono(t.side), h('span.grow', {}), mono(`${t.r >= 0 ? '+' : ''}${t.r}R`, tone(t.r)))),
    ],
    backtest: (s) => {
      const bt = s.backtest;
      if (!bt) return [dim('The backtest starts a few seconds after the office does.')];
      return [
        row(dim(bt.running ? 'Replaying…' : `${bt.days.length} trading days (${bt.days[0] ?? ''} → ${bt.days.at(-1) ?? ''}), run ${new Date(bt.ranAt).toLocaleTimeString()}`), h('span.grow', {}), h('button.btn', { disabled: bt.running, onclick: () => run(trading.post('/api/trading/backtest', {}), 'Backtest started') }, '↻ Run again')),
        dim(bt.note),
        bt.best ? card(h('b', {}, `Best edge this month: ${PLAYBOOK_BY_ID[bt.best.playbook].name} on ${bt.best.symbol}`), dim(`${bt.best.avgR >= 0 ? '+' : ''}${bt.best.avgR}R a trade over ${bt.best.trades} trades`)) : null,
        ...PLAYBOOKS.map((p) => {
          const rows = bt.stats.filter((x) => x.playbook === p.id);
          return card(
            h('b', { style: `color:${p.color}` }, p.name),
            h(
              'table',
              { style: 'width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums' },
              h('tr', { style: 'opacity:.6;text-align:left' }, ...['Market', 'Trades', 'Win %', 'Avg R', 'Total R', 'Max DD', '$ / micro'].map((c) => h('th', {}, c))),
              ...rows.map((r) => h('tr', { style: r.symbol === 'ALL' ? 'font-weight:900' : '' }, h('td', {}, r.symbol), h('td', {}, String(r.trades)), h('td', {}, `${Math.round(r.winRate * 100)}%`), h('td', { style: `color:${tone(r.avgR)}` }, String(r.avgR)), h('td', { style: `color:${tone(r.totalR)}` }, String(r.totalR)), h('td', {}, String(r.maxDrawdownR)), h('td', {}, money(r.dollars)))),
            ),
          );
        }),
        heading('Eval simulator (Law of 10, NQ/ES/GC trades in order)'),
        ...PLAYBOOKS.map((p) => card(h('b', { style: `color:${p.color}` }, p.name), row(...PROP_ACCOUNTS.map((a) => {
          const e = bt.evals.find((x) => x.playbook === p.id && x.accountId === a.id);
          return e ? h('span', { style: 'margin-right:14px' }, `${a.firm} ${a.size / 1000}K: `, mono(e.result.toUpperCase(), e.result === 'passed' ? GOOD : e.result === 'busted' ? BAD : WARN), dim(` ${money(e.pnl)} in ${e.days}d`)) : null;
        })))),
      ];
    },
    alerts: (s) => [
      heading('TradingView alerts'),
      ...(s.alerts.length ? s.alerts.slice(0, 20).map((a) => card(row(mono(new Date(a.at).toLocaleTimeString()), mono(a.symbol || '—'), a.side ? mono(a.side.toUpperCase(), a.side === 'long' ? GOOD : BAD) : null, h('b', {}, a.setup), a.price ? mono(String(a.price)) : null, h('span.grow', {}), a.playbook ? dim(PLAYBOOK_BY_ID[a.playbook].name) : null), a.message ? dim(a.message) : null)) : [dim('No alerts yet. Set one up under 🔌 Connections: when your indicator fires, the office dings and the desk agent jumps.')]),
      heading(`Journal${s.journal.connected ? ` · ProjectX (${s.journal.userName})` : ''}`),
      ...(s.journal.today.length
        ? s.journal.today.map((t) => card(row(mono(new Date(t.exitAt).toLocaleTimeString()), mono(t.symbol), mono(t.side.toUpperCase(), t.side === 'long' ? GOOD : BAD), mono(`×${t.qty}`), dim(`${fmt(t.entry)} → ${fmt(t.exit)}`), h('span.grow', {}), mono(money(t.pnl), tone(t.pnl)))))
        : [dim(s.journal.connected ? 'No trades on your accounts in the last day.' : 'Connect ProjectX under 🔌 Connections to pull your real fills here. The Journal desk reviews them against the playbooks.')]),
    ],
    connections: (s) => {
      const origin = location.origin;
      const hook = `${origin}${s.webhook.path}?key=${s.webhook.key}`;
      const user = h('input', { placeholder: 'ProjectX username', autocomplete: 'off', style: 'width:200px' });
      const key = h('input', { placeholder: 'API key', type: 'password', autocomplete: 'off', style: 'width:260px' });
      const base = h('input', { placeholder: 'https://api.topstepx.com/api', style: 'width:280px' });
      const tpUrl = h('input', { placeholder: 'http://localhost:4040', value: s.tradePilot.url ?? '', style: 'width:220px' });
      const tpKey = h('input', { placeholder: 'Trade Pilot signal key', type: 'password', autocomplete: 'off', style: 'width:240px' });
      const template = JSON.stringify({ symbol: '{{ticker}}', side: 'long', setup: 'VWAP Double Break', price: '{{close}}', message: '{{strategy.order.comment}}' });
      return [
        heading('Data connections'),
        ...s.feeds.map((f) => card(row(mono(f.ok ? 'CONNECTED' : 'DOWN', f.ok ? GOOD : BAD), h('b', {}, f.name), h('span.grow', {}), f.lastAt ? dim(`updated ${new Date(f.lastAt).toLocaleTimeString()}`) : null), dim(f.note))),
        heading('TradingView → the office'),
        card(
          dim('In TradingView, create an alert on your indicator or strategy, tick Webhook URL and paste this. When it fires, the office dings, the playbook’s desk agent jumps up, and the alert lands on the Risk & Journal screen.'),
          row(h('input', { value: hook, readonly: true, style: 'flex:1;min-width:300px;font-family:ui-monospace,Menlo,monospace', onclick: (e: Event) => (e.target as HTMLInputElement).select() }), h('button.btn', { onclick: () => void navigator.clipboard?.writeText(hook).then(() => ((note = 'Webhook URL copied'), render())) }, 'Copy'), h('button.btn', { onclick: () => run(trading.post('/api/trading/webhook-key', {}), 'New key: update your alerts') }, 'New key')),
          dim('Alert message (JSON, TradingView fills the {{…}}): name the setup so it rings the right desk.'),
          h('code', { style: 'white-space:pre-wrap;font-size:12px' }, template),
          dim(/localhost|127\.0\.0\.1/.test(origin) ? 'TradingView’s servers can’t reach localhost: open a tunnel (for example `cloudflared tunnel --url http://localhost:4600`) and use its https address in place of this one.' : 'TradingView only posts to https on port 443.'),
        ),
        heading('ProjectX → accounts, journal and market data'),
        card(
          s.journal.connected
            ? row(mono('CONNECTED', GOOD), h('b', {}, s.journal.userName ?? ''), dim(`${s.journal.accounts.length} accounts · synced ${s.journal.syncedAt ? new Date(s.journal.syncedAt).toLocaleTimeString() : '—'}`), h('span.grow', {}), h('button.btn', { onclick: () => run(trading.post('/api/trading/projectx', { action: 'disconnect' }), 'Disconnected') }, 'Disconnect'))
            : row(user, key, base, h('button.btn.primary', { onclick: () => run(trading.post('/api/trading/projectx', { userName: user.value, apiKey: key.value, baseUrl: base.value }), 'Connected') }, 'Connect')),
          s.journal.error ? mono(s.journal.error, BAD) : null,
          s.journal.userName ? row(h('button.btn', { onclick: () => run(trading.post('/api/trading/projectx', { action: 'market-data', enabled: !s.projectXMarketEnabled }), s.projectXMarketEnabled ? 'Real-time data disabled' : 'Connecting to real-time data') }, s.projectXMarketEnabled ? 'Disable real-time futures' : 'Enable real-time futures'), dim(s.projectXMarketEnabled ? 'TopstepX market connection enabled · check source status above' : 'Optional · requires TopstepX API access')) : null,
          dim('For real-time NQ, ES and GC: activate API access in your TopstepX/ProjectX dashboard, connect here, then enable real-time futures. This connector uses TopstepX’s simulation data subscription. Other ProjectX gateways currently support journal syncing only. BTC quotes continue through Coinbase; BTC candles and historical backtests use Yahoo.'),
          h('a', { href: 'https://help.topstep.com/en/articles/11187768-topstepx-api-access', target: '_blank', rel: 'noopener noreferrer' }, 'TopstepX API setup guide'),
          dim('Read-only: the office reads market data, balances and fills, never orders. The key stays on this machine (readable only by you). Each firm has its own ProjectX gateway: TopstepX is the default; paste your firm’s API address if it’s different.'),
        ),
        heading('Trade Pilot'),
        card(
          dim('Send every paper setup and TradingView alert on to Trade Pilot’s signal inbox, so both apps see the same morning. Use the key from Trade Pilot’s TradingView connection.'),
          row(tpUrl, tpKey, h('button.btn', { onclick: () => run(trading.post('/api/trading/tradepilot', { url: tpUrl.value, key: tpKey.value }), 'Saved') }, 'Save'), s.tradePilot.forwarding ? h('button.btn', { onclick: () => run(trading.post('/api/trading/tradepilot', { url: null }), 'Stopped') }, 'Stop') : null),
          s.tradePilot.forwarding ? mono(`FORWARDING to ${s.tradePilot.url}`, GOOD) : dim('Not forwarding.'),
        ),
        heading('Broker'),
        card(mono('LOCKED', BAD), dim('The office never connects to a broker or places an order. It proposes; you click.')),
      ];
    },
  };

  // The tabs only change when you pick one, so a click never lands on a button the next snapshot replaced.
  const renderNav = () => nav.replaceChildren(...TABS.map((t) => h('button.btn', { type: 'button', class: t.id === tab ? 'on' : '', onclick: () => { tab = t.id; note = ''; renderNav(); render(); body.scrollTop = 0; } }, t.label)));
  const render = () => {
    const s = trading.snap;
    const q = s?.quotes.map((x) => `${x.symbol} ${fmt(x.last, x.decimals)} ${pct(x.changePct)}`).join(' · ');
    foot.textContent = note || (s ? (s.ready ? `${q} · proposals only, never orders` : 'Connecting to the market…') : 'Loading…');
    if (!s) return body.replaceChildren(h('p', {}, 'Waiting for the market desk…'));
    const nodes = views[tab](s).filter((x): x is Node => !!x);
    if (nodes.length !== body.childNodes.length || nodes.some((n, i) => body.childNodes[i] !== n)) body.replaceChildren(...nodes);
  };
  off = trading.on(() => {
    // Redraw with the snapshot unless someone is midway through a click or typing.
    if (!editing && !body.matches(':hover')) render();
  });
  renderNav();
  render();
}
