import { h, openModal } from '../ui/dom';
import { FUTURES, MAX_CSV_BYTES, type FuturesSymbol, type HistoryView } from '../../shared/history-data';
import { PLAYBOOK_BY_ID, type PlaybookId } from '../../shared/trading';
import { RESEARCH_PLAYBOOKS, type ResearchStatus, type StrategyFinding } from '../../shared/strategy-research';
import { VERDICT_WORD, type SliceStats } from '../../shared/validation';
import { tradingViewMcpCard } from './tv-mcp';
import { openTrading } from './panel';
import { trading } from './feed';
import './research-workbench.css';

const money = (n: number) => `${n < 0 ? '−' : n > 0 ? '+' : ''}$${Math.abs(n).toLocaleString('en-US')}`;
const date = (ts: number | null) => ts == null ? 'No candles' : new Date(ts).toISOString().slice(0, 10);
const expectancy = (s: SliceStats) => `${s.avgR >= 0 ? '+' : ''}${s.avgR.toFixed(2)}R`;
const tag = (text: string, kind = '') => h('span.rw-tag', { 'data-kind': kind }, text);
const button = (text: string, fn: () => void, disabled = false, primary = false) => h('button.rw-btn', { type: 'button', onclick: fn, disabled, class: primary ? 'primary' : '' }, text);
const section = (title: string, note: string, ...nodes: (Node | null)[]) => h('section.rw-panel', {}, h('div.rw-panel-head', {}, h('h3', {}, title), h('p', {}, note)), ...nodes);

async function api<T>(path: string, body?: object): Promise<T> {
  const res = await fetch(`/api/trading/${path}`, { credentials: 'same-origin', cache: 'no-store', ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const data = await res.json().catch(() => { throw new Error('The office is restarting or unavailable. Reopen the workbench to retry.'); });
  if (!res.ok) throw new Error(data.error ?? 'The office did not answer'); return data as T;
}

export function mountResearchWorkbench(host: HTMLElement, close?: () => void) {
  let tab: 'research' | 'history' | 'connections' = 'research';
  let status: ResearchStatus = { busy: false, stage: 'Checking the office', error: null, report: null };
  let history: HistoryView | null = null; let message = ''; let acting = false; let disposed = false;
  let picked: PlaybookId = 'vwap-pullback'; let markets: FuturesSymbol[] = [...FUTURES]; let cap = 5;
  let uploadSymbol: FuturesSymbol = 'NQ'; let contract = 'NQ1!'; let filename = ''; let csv = '';
  const root = h('div.rw'); host.append(root); trading.start();
  const act = async (fn: () => Promise<void>) => {
    if (acting) return; acting = true; message = ''; draw();
    try { await fn(); } catch (e) { message = e instanceof Error ? e.message : 'Request failed'; }
    finally { acting = false; if (!disposed) draw(); }
  };
  const download = () => {
    if (!status.report) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(status.report, null, 2)], { type: 'application/json' }));
    const a = h('a', { href: url, download: `futures-research-${status.report.id.slice(0, 8)}.json` }); a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const run = () => void act(async () => { status = await api('research', { action: 'start', markets, cap }); });

  function controls() {
    return h('div.rw-controls', {},
      h('div.rw-market-picks', { 'aria-label': 'Research markets' }, ...FUTURES.map(s => button(s, () => { markets = markets.includes(s) ? markets.filter(x => x !== s) : [...markets, s]; draw(); }, status.busy || acting, markets.includes(s)))),
      h('label', {}, 'Risk cap ', h('select', { 'aria-label': 'Maximum micro contracts', disabled: acting || status.busy, onchange: (e: Event) => { cap = Number((e.target as HTMLSelectElement).value); } }, ...[1, 3, 5, 10].map(n => h('option', { value: n, selected: n === cap }, `Up to ${n} micros`)))),
      button(status.busy ? 'Researching…' : 'Run strategy research', run, status.busy || acting || !markets.length, true));
  }
  function slices(f: StrategyFinding) {
    const pairs = [['Training', f.report.train], ['Validation', f.report.validation], ['Reserved quarter', f.report.holdout]] as const;
    return h('div.rw-slices', {}, ...pairs.map(([label, pair]) => h('div.rw-slice', {},
      h('div.rw-slice-head', {}, h('b', {}, label), tag(label === 'Training' ? '50% · selection' : label === 'Validation' ? '25% · evaluation' : pair ? '25% · opened once' : '25% · closed')),
      pair ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'Original'), h('th', {}, 'Candidate'))),
        h('tbody', {}, ...[['Trades', (s: SliceStats) => s.trades], ['Net / trade', expectancy], ['Total', (s: SliceStats) => `${s.totalR.toFixed(1)}R`], ['Worst dip', (s: SliceStats) => `${s.maxDrawdownR.toFixed(1)}R`], ['Win rate', (s: SliceStats) => `${Math.round(s.winRate * 100)}%`]].map(([name, format]) => h('tr', {}, h('td', {}, name as string), h('td', {}, (format as (s: SliceStats) => string | number)(pair.base)), h('td', {}, (format as (s: SliceStats) => string | number)(pair.cand))))))
        : h('div.rw-reserved', {}, h('b', {}, 'Keep an unfamiliar test'), h('p', {}, 'One validated candidate gets one look. New sizing does not reset that look.'),
          button('Open for this candidate', () => void act(async () => { status = await api('research', { action: 'holdout', id: status.report!.id, playbook: f.playbook }); }), acting || !!status.report?.holdout || !f.filter || f.report.verdict !== 'promising')))));
  }
  function research() {
    const report = status.report;
    const f = report?.findings.find(x => x.playbook === picked);
    return [section('Three playbooks. One honest test.', 'VWAP Pullback in Trend leads. Support/resistance and failed auction use the same sessions and assumptions.', controls(),
      h('p.rw-small', {}, 'Fixed built-in entries · conservative exits · fees and slippage · training-only filter selection')),
      report ? h('div.rw-run-info', {}, tag(`${report.days.length} common sessions`), tag(`${report.days[0]} → ${report.days.at(-1)}`), tag(`Data ${report.dataset.slice(0, 10)}`), tag(`Report cap ${report.cap} micros`), button('Download report', download)) : null,
      report ? h('div.rw-strategies', {}, ...report.findings.map(x => h('button.rw-strategy', { type: 'button', 'data-selected': x.playbook === picked ? '1' : '0', onclick: () => { picked = x.playbook; draw(); } },
        h('span.rw-eyebrow', {}, x.playbook === 'vwap-pullback' ? 'PRIMARY STRATEGY' : 'COMPARISON'), h('b', {}, PLAYBOOK_BY_ID[x.playbook].name),
        h('strong', { 'data-positive': x.report.validation.base.avgR > 0 ? '1' : '0' }, expectancy(x.report.validation.base)), h('span', {}, `${x.report.validation.base.trades} validation trades · original after costs`), tag(x.filter ? VERDICT_WORD[x.report.verdict] : 'No improvement qualified', x.report.verdict === 'promising' || x.report.verdict === 'held' ? 'ok' : 'warn')))) : h('div.rw-empty', {}, h('b', {}, 'Research the actual tape'), h('p', {}, 'Load your history or use the retained delayed futures data. Run the test to see the original strategies, one candidate per strategy, and how prop accounts survived.'), button('Review history first', () => { tab = 'history'; draw(); })),
      f ? section(f.filter ? f.report.candidate.name : 'Keep the original strategy', f.rule,
        h('p.rw-reason', {}, ...f.report.reasons.map(r => h('span', {}, r))), slices(f),
        h('div.rw-stress', {}, h('b', {}, 'Cost sensitivity · training + validation'), ...f.report.stress.map(s => h('span', {}, tag(s.cost), `${s.base.toFixed(2)}R original → ${s.cand.toFixed(2)}R candidate`))),
        h('p.rw-small', {}, `${f.tried} filters tried; validation hurdle ${f.report.hurdle} noise widths, observed ${f.report.z}. This screen only adds a filter to the existing entries. It does not rewrite stops or targets or promote a trader.`)) : null,
      f ? section('Which prop accounts survived?', 'One attempt per firm on chronological validation sessions. Original and candidate have identical risk budgets. Results are simulated account outcomes.',
        h('div.rw-scroll', {}, h('table.rw-firms', {}, h('thead', {}, h('tr', {}, ...['Program / rule evidence', 'Target / drawdown', 'Original net', 'Candidate net', 'Stressed net', 'Candidate outcome'].map(s => h('th', {}, s)))),
          h('tbody', {}, ...f.firms.map(firm => h('tr', {}, h('td', {}, h('b', {}, firm.name), h('small', {}, `${firm.verified ? 'Official numerical rules' : 'Research scenario'} · ${firm.verifiedOn ?? firm.basis}`), h('details', {}, h('summary', {}, 'Rules and sources'), h('small', {}, firm.ruleSet), ...firm.issues.map(s => h('p', {}, s)), ...firm.sources.map(s => h('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer' }, s.label)))),
            h('td', {}, `$${firm.target.toLocaleString()} / $${firm.drawdown.toLocaleString()}`), h('td', {}, money(firm.baseline.profit)), h('td', {}, money(firm.candidate.profit)), h('td', {}, money(firm.stressed.profit)),
            h('td', {}, tag(firm.candidate.status === 'pass-pending' ? 'Simulated pass' : firm.candidate.status === 'breached' ? 'Breached' : 'Not passed', firm.candidate.status === 'breached' ? 'bad' : firm.candidate.status === 'pass-pending' ? 'ok' : 'warn'), h('small', {}, `${firm.candidate.taken} fills · ${firm.candidate.days} sessions`), h('details', {}, h('summary', {}, 'Why'), h('p', {}, firm.candidate.why)))))))),
        h('p.rw-small', {}, 'Rule evidence is separate from execution approval. Fees paid to a firm and funded-account payouts are outside this single-evaluation replay. Inspect the rule source before purchasing an account.')) : null,
      report ? section('What went into this result', 'Pinned candles, explicit assumptions, and the tests that still remain.',
        h('div.rw-source-grid', {}, ...report.sources.map(s => h('div', {}, h('b', {}, s.symbol), h('span', {}, s.label), h('small', {}, `${s.bars.toLocaleString()} candles · ${date(s.first)} → ${date(s.last)}`)))),
        h('ul.rw-notes', {}, ...report.notes.map(s => h('li', {}, s)))) : null];
  }

  function data() {
    const upload = h('input', { type: 'file', accept: '.csv,text/csv', 'aria-label': 'One-minute chart CSV', disabled: acting, onchange: (event: Event) => {
      const file = (event.target as HTMLInputElement).files?.[0]; if (!file) return;
      void act(async () => { if (file.size > MAX_CSV_BYTES) throw new Error('Export must be 64 MB or smaller'); csv = await file.text(); filename = file.name; });
    } });
    return [section('Your history library', 'Choose one series per market. Imports remain on disk; chart history and live quotes stay separate.',
      h('div.rw-source-grid', {}, ...FUTURES.map(symbol => {
        const cached = history?.cached.find(c => c.symbol === symbol);
        const choices = history?.datasets.filter(d => d.symbol === symbol) ?? [];
        const selected = choices.find(d => d.id === history?.selected[symbol]);
        return h('div', {}, h('b', {}, symbol), h('select', { 'aria-label': `${symbol} research history`, disabled: acting || status.busy, onchange: (e: Event) => void act(async () => { history = await api('history', { action: 'select', symbol, id: (e.target as HTMLSelectElement).value || null }); message = `${symbol} history selected. Run research to create a new report.`; }) },
          h('option', { value: '', selected: !selected }, 'Retained Yahoo history'), ...choices.map(d => h('option', { value: d.id, selected: d.id === selected?.id }, `${d.name} · ${d.contract}`))),
          h('small', {}, `${(selected?.bars ?? cached?.bars ?? 0).toLocaleString()} candles · ${date(selected?.first ?? cached?.first ?? null)} → ${date(selected?.last ?? cached?.last ?? null)}`),
          ...(selected?.warnings ?? []).map(w => h('p.rw-small', {}, w)));
      }))),
      section('Bring your TradingView chart history', 'Export standard one-minute candles with volume. The import does not need your TradingView password.',
        h('ol.rw-notes', {}, h('li', {}, 'Open NQ1!, ES1! or GC1!, or the individual contract you trade, on a standard 1-minute candle chart.'), h('li', {}, 'Scroll left to load the dates you need, then use Download chart data… in TradingView’s upper toolbar.'), h('li', {}, 'Choose the matching market and type the exact chart symbol. Import, select it above, then run research. Use overlapping dates across markets.')),
        h('a', { href: 'https://www.tradingview.com/support/solutions/43000537255-how-to-export-chart-data/', target: '_blank', rel: 'noopener noreferrer' }, 'TradingView’s export instructions ↗'),
        h('div.rw-upload', {}, h('label', {}, 'Market', h('select', { 'aria-label': 'CSV market', disabled: acting, onchange: (e: Event) => { uploadSymbol = (e.target as HTMLSelectElement).value as FuturesSymbol; contract = `${uploadSymbol}1!`; draw(); } }, ...FUTURES.map(s => h('option', { value: s, selected: s === uploadSymbol }, s)))),
          h('label', {}, 'Exact chart symbol', h('input', { value: contract, 'aria-label': 'Exact chart symbol', placeholder: 'NQ1! or NQZ2026', maxlength: 50, disabled: acting, oninput: (e: Event) => { contract = (e.target as HTMLInputElement).value; } })),
          h('label', {}, filename || 'Chart CSV', upload), button('Validate and import', () => void act(async () => { history = await api('history', { action: 'import', symbol: uploadSymbol, contract, name: filename, csv }); message = 'Imported. Select this chart above to use it for research.'; csv = ''; filename = ''; }), acting || !csv, true)),
        h('p.rw-small', {}, 'UTC epoch seconds/milliseconds or ISO timestamps with an explicit offset; OHLC + volume; maximum 500,000 rows / 64 MB per chart. No Heikin Ashi or Renko prices. Invalid rows reject the whole file. Imports are immutable and deduplicated; no fabricated candles.'))];
  }
  function connections() {
    return [section('TradingView account · official research connection', 'Sign in using TradingView’s own authorization page. OAuth tokens stay on the office server.', tradingViewMcpCard(),
      h('p.rw-small', {}, 'TradingView’s current MCP beta returns delayed market data, even with exchange entitlements. It supports read-only research here; it does not stream your live futures or load a long backtest automatically.'),
      h('a', { href: 'https://www.tradingview.com/mcp/docs', target: '_blank', rel: 'noopener noreferrer' }, 'Official TradingView connection guide ↗')),
      section('Real-time or delayed forward testing', 'The office already supports two routes to exchange candles.',
        h('div.rw-source-grid', {}, h('div', {}, h('b', {}, 'TradingView chart alerts'), h('p', {}, 'One bar-close Pine alert per 1-minute chart. Requires a webhook-capable plan, CME data for real-time quotes, and an HTTPS endpoint TradingView can reach.')), h('div', {}, h('b', {}, 'ProjectX / TopstepX'), h('p', {}, 'Eligible API access supplies streamed quotes and provider candles. Account balances and fills remain read-only.'))),
        button('Open live data connection settings', () => openTrading('office', 'connections')),
        h('p.rw-small', {}, 'Until configured, the futures feed is delayed and forward runs stay labeled as delayed paper replays. The research history selector above does not relabel that feed as live.'))];
  }
  function draw() {
    if (disposed) return;
    root.replaceChildren(h('div.rw-frame', {}, h('header.rw-head', {}, h('div', {}, h('span.rw-eyebrow', {}, 'FUTURES · RESEARCH BEFORE RISK'), h('h2', {}, 'Strategy Workbench'), h('p', {}, 'Actual candles. Measured changes. Prop-account evidence.')),
      tag('PAPER RESEARCH', 'warn'), close ? h('button.rw-btn', { type: 'button', 'aria-label': 'Close Strategy Workbench', onclick: close }, '✕') : h('a.rw-btn', { href: '/' }, 'Return to office')),
      h('nav.rw-nav', { 'aria-label': 'Strategy workbench' }, ...[['research', 'Strategy research'], ['history', 'History library'], ['connections', 'Data connections']].map(([id, label]) => button(label!, () => { tab = id as typeof tab; draw(); }, false, tab === id))),
      h('div.rw-status', { role: 'status', 'aria-live': 'polite', 'data-busy': status.busy ? '1' : undefined }, h('span', {}, status.busy ? '◌' : '●'), h('b', {}, status.stage), status.report ? h('small', {}, `Saved ${new Date(status.report.createdAt).toLocaleString()}`) : null),
      message || status.error ? h('div.rw-message', { role: 'alert' }, message || status.error) : null,
      h('main.rw-body', {}, ...(tab === 'history' ? data() : tab === 'connections' ? connections() : research())),
      h('footer.rw-footer', {}, 'Strategies are hypotheses. Results include failures. Nothing in this workbench places orders or changes an Arena trader.')));
  }
  const load = async () => {
    try {
      [status, history] = await Promise.all([api<ResearchStatus>('research'), api<HistoryView>('history')]);
      if (status.report) { markets = [...status.report.markets]; cap = status.report.cap; }
    }
    catch (e) { message = e instanceof Error ? e.message : 'The office did not answer'; }
    draw();
  };
  void load(); draw();
  const poll = window.setInterval(() => { if (status.busy && !acting) void api<ResearchStatus>('research').then(next => { status = next; draw(); }).catch(() => { message = 'Office connection interrupted; the previous report is kept.'; draw(); }); }, 1200);
  return { close() { disposed = true; clearInterval(poll); root.remove(); } };
}

export function openResearchWorkbench() {
  const host = h('div.rw-window'); let handle: ReturnType<typeof mountResearchWorkbench> | null = null;
  const modal = openModal(host, { closeButton: false, doing: 'researching futures strategies', onClose: () => handle?.close() });
  handle = mountResearchWorkbench(host, () => modal.close());
}
