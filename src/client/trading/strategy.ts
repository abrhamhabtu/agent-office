import type { LabReport, PineMetrics, PineScriptInfo, PineStatus, PineVersionInfo, PlaybookDef, PlaybookId, PlaybookStats, TradingSnapshot } from '../../shared/trading';
import { PLAYBOOKS } from '../../shared/trading';
import { h, openModal } from '../ui/dom';
import { confirmDialog } from '../ui/prompt';
import { trading } from './feed';
import { stageClock } from './screens';
import './strategy.css';

// The Strategy Desk: every strategy the office trades (the five playbooks, and any Pine script saved for
// one), each with how it tests, what it's doing right now, and, where there's a Pine script, every
// version of it dated and tested. The point is that nothing has to be typed: the live version copies to
// TradingView in one tap, and when the test lab finds a version that holds up it's waiting here, marked
// new, with the numbers next to the live one. Every test run writes itself up, so it's clear what ran.

const POST = '/api/trading/vault';
const SELECTED_KEY = 'agent-office.strategy-selected';
const STATUS_LABEL: Record<PineStatus, string> = { live: 'LIVE', candidate: 'CANDIDATE', experiment: 'EXPERIMENT', retired: 'RETIRED' };
const PINE_INK = '#f4a261';
const text = (el: HTMLElement, value: string) => {
  if (el.textContent !== value) el.textContent = value;
};
const signed = (n: number, d = 2) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(d)}`;
const pctOf = (n: number) => `${Math.round(n * 100)}%`;
const card = (title: string, ...children: (Node | null)[]) => h('section.strategy-card', {}, h('h3', {}, title), ...children.filter((x): x is Node => !!x));
const remembered = (): string | null => {
  try {
    return localStorage.getItem(SELECTED_KEY);
  } catch {
    return null;
  }
};
const remember = (v: string) => {
  try {
    localStorage.setItem(SELECTED_KEY, v);
  } catch {
    /* Browser storage is unavailable; the desk still works. */
  }
};

/** A small line for a curve of cumulative results. */
function spark(curve: number[], color: string, w = 120, hgt = 30): SVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${hgt}`);
  svg.setAttribute('width', String(w));
  svg.setAttribute('height', String(hgt));
  svg.setAttribute('aria-hidden', 'true');
  if (curve.length < 2) return svg;
  const lo = Math.min(0, ...curve);
  const hi = Math.max(0, ...curve);
  const span = hi - lo || 1;
  const pts = curve.map((v, i) => `${((i / (curve.length - 1)) * (w - 4) + 2).toFixed(1)},${(hgt - 3 - ((v - lo) / span) * (hgt - 6)).toFixed(1)}`);
  const zero = hgt - 3 - ((0 - lo) / span) * (hgt - 6);
  const base = document.createElementNS(ns, 'line');
  for (const [k, v] of Object.entries({ x1: '0', x2: String(w), y1: zero.toFixed(1), y2: zero.toFixed(1), stroke: '#8a8f9a', 'stroke-opacity': '.35', 'stroke-dasharray': '2 3' })) base.setAttribute(k, v);
  const line = document.createElementNS(ns, 'polyline');
  for (const [k, v] of Object.entries({ points: pts.join(' '), fill: 'none', stroke: color, 'stroke-width': '2', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' })) line.setAttribute(k, v);
  svg.append(base, line);
  return svg;
}

/** A line diff (longest common subsequence), trimmed to the changes with a couple of lines of context. */
export function diffLines(a: string[], b: string[], context = 2): { t: ' ' | '+' | '-' | '…'; s: string }[] {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const all: { t: ' ' | '+' | '-'; s: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) all.push({ t: ' ', s: a[i++]! }), j++;
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) all.push({ t: '-', s: a[i++]! });
    else all.push({ t: '+', s: b[j++]! });
  }
  while (i < n) all.push({ t: '-', s: a[i++]! });
  while (j < m) all.push({ t: '+', s: b[j++]! });
  const keep = all.map((l, k) => l.t !== ' ' || all.slice(Math.max(0, k - context), k + context + 1).some((x) => x.t !== ' '));
  const out: { t: ' ' | '+' | '-' | '…'; s: string }[] = [];
  let skipped = 0;
  all.forEach((l, k) => {
    if (keep[k]) {
      if (skipped) out.push({ t: '…', s: `${skipped} unchanged lines` });
      skipped = 0;
      out.push(l);
    } else skipped++;
  });
  if (skipped) out.push({ t: '…', s: `${skipped} unchanged lines` });
  return out;
}

/** One strategy as the desk shows it: an office playbook, and the Pine script saved for it if there is one. */
interface Strategy {
  id: string;
  name: string;
  color: string;
  playbook: PlaybookDef | null;
  script: PineScriptInfo | null;
}

/** Every strategy: the playbooks (those with a Pine script first), then any Pine script that isn't one of them. */
function strategiesOf(s: TradingSnapshot): Strategy[] {
  const list: Strategy[] = PLAYBOOKS.map((p) => ({ id: p.id, name: p.name, color: p.color, playbook: p, script: s.vault.scripts.find((sc) => sc.playbook === p.id) ?? null }));
  list.sort((a, b) => Number(!!b.script) - Number(!!a.script));
  for (const sc of s.vault.scripts) if (!sc.playbook || !PLAYBOOKS.some((p) => p.id === sc.playbook)) list.push({ id: `script:${sc.id}`, name: sc.name, color: PINE_INK, playbook: null, script: sc });
  return list;
}

const statsOf = (s: TradingSnapshot, id: PlaybookId, symbol: PlaybookStats['symbol'] = 'ALL', book: 'backtest' | 'paper' = 'backtest'): PlaybookStats | undefined => (book === 'backtest' ? s.backtest?.stats : s.paper.stats)?.find((x) => x.playbook === id && x.symbol === symbol);

/** The Strategy Desk. `onAsk` opens the usual question box to the Strategy agent. */
export function openStrategyDesk(opts: { onAsk?: () => void } = {}) {
  const openDiffs = new Set<string>();
  const diffs = new Map<string, ReturnType<typeof diffLines>>();
  const drafts = new Map<string, { source: string; changelog: string; bump: string; status: string }>();
  let newScript = { name: '', source: '' };
  let note = '';
  /** The strategy open, and which version of its script. */
  let strategyId: string | null = remembered();
  const versionOf = new Map<string, string>();
  /** What was new when this was opened, so it keeps its NEW mark while you look (the lab's own flag clears once seen). */
  const newThisVisit = new Set<string>();
  const markedSeen = new Set<string>();
  let addOpen = false;

  const picker = h('div.strategy-picker');
  const hero = h('div.strategy-hero');
  const nowRow = h('div.strategy-now');
  const testing = h('div');
  const pine = h('div.strategy-pine');
  const report = h('div');
  const side = h('aside.strategy-side');
  const status = h('span', { role: 'status' });
  const noteEl = h('span', { role: 'status' });
  const runBtn = h('button.btn', { onclick: () => void go(trading.post(POST, { action: 'lab' }), 'Tests started: see the report below') }, 'Run tests now') as HTMLButtonElement;
  const close = h('button.btn.close', { 'aria-label': 'Close Strategy Desk' }, '✕');
  const el = h('div.modal.strategy-desk', { role: 'dialog', 'aria-label': 'Strategy Desk' },
    h('header', {}, h('div.grow', {}, h('h2', {}, 'Strategy Desk'), h('span.strategy-subtitle', {}, 'Every strategy the office trades · how it tests · your Pine versions, ready to copy')), close),
    h('div.body.strategy-body', {}, h('div.strategy-main', {}, picker, hero, nowRow, testing, pine, report), side),
    h('footer', {}, status, h('span.grow'), noteEl, runBtn));
  let off = () => {};
  const modal = openModal(el, { doing: 'at the Strategy Desk', onClose: () => off() });
  close.addEventListener('click', () => modal.close());

  const go = async (p: Promise<string | undefined>, ok = '') => {
    note = (await p) ?? ok;
    render();
  };
  const copy = async (script: string, v: PineVersionInfo) => {
    const src = await trading.vaultSource(script, v.version);
    if (src === null) return void go(Promise.resolve('Couldn’t read that version'));
    await navigator.clipboard?.writeText(src).catch(() => {});
    note = `v${v.version} copied. In TradingView: Pine Editor → select all → paste → Save → Add to chart`;
    render();
  };
  const goLive = (sc: PineScriptInfo, v: PineVersionInfo) => {
    const live = sc.versions.find((x) => x.status === 'live');
    confirmDialog(`Make ${sc.name} v${v.version} live?`, `This becomes your locked book for ${sc.name}${live ? `, and v${live.version} is retired (it stays here, and you can roll back any time)` : ''}. Nothing changes on your TradingView chart until you paste this version there.`, 'Make it live', () => void go(trading.post(POST, { action: 'status', script: sc.id, version: v.version, status: 'live' }), `v${v.version} is live`));
  };
  const toggleDiff = async (sc: PineScriptInfo, v: PineVersionInfo) => {
    const key = `${sc.id}@${v.version}`;
    if (openDiffs.has(key)) openDiffs.delete(key);
    else if (v.parent) {
      const [a, b] = await Promise.all([trading.vaultSource(sc.id, v.parent), trading.vaultSource(sc.id, v.version)]);
      if (a !== null && b !== null) diffs.set(key, diffLines(a.split('\n'), b.split('\n')));
      openDiffs.add(key);
    }
    render();
  };

  const tag = (st: PineStatus) => h('span.strategy-tag', { 'data-status': st }, STATUS_LABEL[st]);
  const num = (value: string, tone = '') => h('td', { 'data-tone': tone }, value);
  const th = (...labels: string[]) => h('thead', {}, h('tr', {}, ...labels.map((l, i) => h('th', { class: i ? 'n' : '' }, l))));
  const rTone = (n: number) => (n > 0 ? 'ok' : n < 0 ? 'bad' : '');

  // ---- Pine version tables ----
  /** This version against the live one, a metric a row; the change is green where it's better. */
  const againstLive = (live: PineMetrics, v: PineMetrics) => {
    const rows: [string, string, string, number, boolean][] = [
      ['Average per trade', `${signed(live.avgR)} R`, `${signed(v.avgR)} R`, v.avgR - live.avgR, true],
      ['Total result', `${signed(live.totalR, 1)} R`, `${signed(v.totalR, 1)} R`, v.totalR - live.totalR, true],
      ['Win rate', pctOf(live.winRate), pctOf(v.winRate), v.winRate - live.winRate, true],
      ['Worst dip', `${live.maxDrawdownR} R`, `${v.maxDrawdownR} R`, live.maxDrawdownR - v.maxDrawdownR, true],
      ['Trades', String(live.trades), String(v.trades), 0, false],
    ];
    const change = (label: string, d: number) => (d === 0 ? '—' : label === 'Win rate' ? `${d > 0 ? '+' : '−'}${Math.abs(Math.round(d * 100))}%` : label === 'Worst dip' ? `${d > 0 ? '−' : '+'}${Math.abs(d).toFixed(1)} R` : `${signed(d, label === 'Total result' ? 1 : 2)} R`);
    return h('table.strategy-table', {}, th('', 'Live', 'This version', 'Difference'), h('tbody', {}, ...rows.map(([label, a, b, d, judged]) => h('tr', {}, h('th', { scope: 'row' }, label), num(a), num(b, judged ? rTone(d) : ''), num(judged ? change(label, d) : '', judged ? rTone(d) : '')))));
  };
  /** Did it hold up? All the days, the earlier days it's picked on, and the later days held back (with the live version's number beside it). */
  const periods = (t: NonNullable<PineVersionInfo['test']>, liveT: PineVersionInfo['test'], isLive: boolean) => {
    const rows: [string, PineMetrics, PineMetrics | undefined][] = [['All days', t.all, liveT?.all], ['Earlier days', t.inSample, liveT?.inSample], ['Later days (held back)', t.outSample, liveT?.outSample]];
    // The rows above count fills the way the chart does. This one fills the way an order would be, and charges for it.
    if (t.realistic) rows.push([`Realistic fills, after costs${t.realistic.ambiguous ? ` (${t.realistic.ambiguous} rest on a guess inside a bar)` : ''}`, t.realistic.all, liveT?.realistic?.all]);
    return h('table.strategy-table', {}, th('', 'Trades', 'Win rate', 'Avg per trade', 'Total', ...(isLive ? [] : ['Live avg'])), h('tbody', {}, ...rows.map(([label, m, l]) => h('tr', {}, h('th', { scope: 'row' }, label), num(String(m.trades)), num(pctOf(m.winRate)), num(`${signed(m.avgR)} R`, rTone(m.avgR)), num(`${signed(m.totalR, 1)} R`, rTone(m.totalR)), ...(isLive ? [] : [num(l ? `${signed(l.avgR)} R` : '—', l ? rTone(l.avgR) : '')])))));
  };
  const markets = (t: NonNullable<PineVersionInfo['test']>) =>
    h('table.strategy-table', {}, th('Market', 'Trades', 'Win rate', 'Avg per trade', 'Total'), h('tbody', {}, ...t.symbols.map((sym) => { const m = t.bySymbol[sym]!; return h('tr', {}, h('th', { scope: 'row' }, sym), num(String(m.trades)), num(pctOf(m.winRate)), num(`${signed(m.avgR)} R`, rTone(m.avgR)), num(`${signed(m.totalR, 1)} R`, rTone(m.totalR))); })));

  /** The open version: what changed, how it tested, and what you can do with it. One card, so nothing is buried. */
  const detailCard = (st: Strategy, sc: PineScriptInfo, v: PineVersionInfo, live: PineVersionInfo | undefined) => {
    const key = `${sc.id}@${v.version}`;
    const t = v.test;
    const isLive = v.status === 'live';
    const open = openDiffs.has(key);
    return h('section.strategy-detail', { 'data-status': v.status },
      h('div.strategy-vhead', {}, h('span.strategy-vname', { style: `--c:${st.color}` }, st.name), h('b.strategy-vnum', {}, `v${v.version}`), tag(v.status), v.by === 'lab' ? h('span.strategy-tag', { 'data-status': 'lab' }, 'MADE BY THE LAB') : null, h('span.grow'), h('span.strategy-date', {}, v.date), v.parent ? h('small', {}, `from v${v.parent}`) : h('small', {}, 'first version')),
      h('div.strategy-actions', {},
        h('button.btn.primary', { onclick: () => void copy(sc.id, v) }, `📋 Copy v${v.version} for TradingView`),
        v.parent ? h('button.btn', { onclick: () => void toggleDiff(sc, v) }, open ? 'Hide changes' : `See what changed from v${v.parent}`) : null,
        !isLive && v.status !== 'retired' && v.intact ? h('button.btn', { onclick: () => goLive(sc, v) }, 'Make live') : null,
        v.status === 'retired' && v.intact ? h('button.btn', { onclick: () => goLive(sc, v) }, 'Roll back to this') : null,
        // The live version is only ever replaced by making another one live, never retired with one click.
        !isLive && v.status !== 'retired' ? h('button.btn', { onclick: () => void go(trading.post(POST, { action: 'status', script: sc.id, version: v.version, status: 'retired' }), `v${v.version} retired`) }, 'Retire') : null),
      open ? h('pre.strategy-diff', {}, ...(diffs.get(key) ?? []).map((l) => h('div', { 'data-t': l.t }, l.t === '…' ? `⋯ ${l.s}` : `${l.t} ${l.s}`))) : null,
      h('h4', {}, 'What changed'),
      h('ul.strategy-log', {}, ...v.changelog.filter((l) => !/^(Replayed on|Against v|Made by the test lab)/.test(l)).map((l) => h('li', {}, l))),
      !v.intact ? h('p.strategy-verdict', { 'data-verdict': 'worse' }, '⚠ The saved file no longer matches its fingerprint, so it can’t be made live') : null,
      t?.vs ? h('p.strategy-verdict', { 'data-verdict': t.vs.verdict }, `${t.vs.verdict === 'better' ? `✓ Tested better · confidence ${t.vs.confidence.toUpperCase()}` : t.vs.verdict === 'worse' ? '✗ Tested worse' : t.vs.verdict === 'unproven' ? '… Too early to tell' : '＝ No real difference'} · ${t.vs.reason}`) : null,
      t
        ? h('div', {},
            !isLive && live?.test ? h('div', {}, h('h4', {}, `Against the live version (v${live.version})`), againstLive(live.test.all, t.all)) : null,
            h('h4', {}, 'Did it hold up?'), periods(t, live?.test ?? null, isLive),
            h('h4', {}, 'By market'), markets(t),
            h('p.strategy-fine', {}, `Replayed on ${t.days} real sessions (${t.from} to ${t.to}), on 5-minute bars like your chart. Earlier days are what changes are picked on; later days are held back to check it’s real. Paper evidence on a short history, never a promise.${t.all.trades < 20 ? ` Only ${t.all.trades} trades, which is too few for the lab to call a change better.` : ''}`))
        : h('p.strategy-fine', {}, 'Not tested yet. The lab runs after every close, or tap “Run tests now”.'),
      h('small.strategy-meta', {}, `${v.intact ? '✓ intact' : '⚠ changed'} · fingerprint ${v.sha} · ${v.lines} lines`));
  };

  /** One chip per version, newest first: the whole history at a glance, and a click to open any of it. */
  const chip = (st: Strategy, sc: PineScriptInfo, v: PineVersionInfo, openV: string) => {
    const isNew = newThisVisit.has(`${sc.id}@${v.version}`) || (v.fresh && v.test?.vs?.verdict === 'better');
    return h('button.strategy-chip', { type: 'button', 'data-status': v.status, 'aria-pressed': String(openV === v.version), onclick: () => { versionOf.set(st.id, v.version); render(); } },
      h('b', {}, `v${v.version}`),
      isNew ? h('span.strategy-new', {}, 'NEW') : null,
      h('small', {}, v.status === 'live' ? 'LIVE' : v.status === 'retired' ? 'retired' : v.status),
      h('span.strategy-chip-r', { 'data-tone': v.test ? rTone(v.test.all.avgR) : '' }, v.test ? `${signed(v.test.all.avgR)} R` : v.date.slice(5)));
  };

  // ---- The page for the open strategy ----
  const pickerCard = (s: TradingSnapshot, st: Strategy) => {
    const sc = st.script;
    const live = sc?.versions.find((v) => v.status === 'live');
    const news = !!sc?.versions.some((v) => (v.fresh && v.test?.vs?.verdict === 'better') || newThisVisit.has(`${sc.id}@${v.version}`));
    const stats = st.playbook ? statsOf(s, st.playbook.id) : undefined;
    const inTrade = st.playbook ? s.proposals.filter((p) => p.playbook === st.playbook!.id && p.stage === 'live').length : 0;
    const lastR = stats?.trades ? `${signed(stats.avgR)} R · ${stats.trades} trades` : 'no trades yet';
    return h('button.strategy-pick', { type: 'button', style: `--c:${st.color}`, 'aria-pressed': String(strategyId === st.id), onclick: () => { strategyId = st.id; remember(st.id); render(); } },
      h('span.strategy-pick-bar'),
      h('b', {}, st.name),
      h('small', {}, live ? `PINE v${live.version} · LIVE` : sc ? 'PINE · nothing live' : 'PLAYBOOK · no Pine yet'),
      stats ? spark(stats.curve, st.color, 112, 26) : h('span.strategy-pick-gap'),
      h('span.strategy-pick-r', { 'data-tone': stats?.trades ? rTone(stats.avgR) : '' }, lastR),
      news ? h('span.strategy-new', {}, 'NEW') : inTrade ? h('span.strategy-live', {}, '● IN TRADE') : null);
  };

  const heroCard = (st: Strategy) => {
    const sc = st.script;
    const live = sc?.versions.find((v) => v.status === 'live');
    const rule = st.playbook ? st.playbook.rule : sc?.summary ?? '';
    return [
      h('div', {},
        h('small.strategy-eyebrow', {}, `STRATEGY${st.playbook ? ` · ${st.playbook.mentor.toUpperCase()} · DESK AGENT ${st.playbook.agent.toUpperCase()}` : ' · PINE SCRIPT'}`),
        h('div.strategy-title', { style: `--c:${st.color}` }, st.name),
        h('p.strategy-rule', {}, rule)),
      live && sc
        ? h('div.strategy-livebox', {}, h('small', {}, `LIVE ON YOUR CHART · ${sc.name.toUpperCase()}`), h('div.strategy-big', {}, `v${live.version}`), h('button.btn.primary.strategy-copy', { onclick: () => void copy(sc.id, live) }, '📋 Copy for TradingView'), h('small', {}, 'Pine Editor → select all → paste → Save → Add to chart'))
        : h('div.strategy-livebox', {}, h('small', {}, 'TRADINGVIEW'), h('div.strategy-bigtext', {}, sc ? 'Nothing live yet' : 'No Pine script yet'), h('p', {}, sc ? 'Make one of its versions live below.' : 'This strategy runs inside the office. Save its Pine script to keep every version here and test changes to it.'), sc ? null : h('button.btn.primary', { onclick: () => { addOpen = true; render(); } }, '＋ Add its Pine script')),
    ];
  };

  /** What it's doing right now on each market, with the stopwatch. */
  const nowCard = (s: TradingSnapshot, st: Strategy) => {
    const id = st.playbook?.id;
    const mine = id ? s.proposals.filter((p) => p.playbook === id && ['live', 'ready', 'won', 'lost', 'closed'].includes(p.stage)) : [];
    return card('Right now',
      mine.length
        ? h('div.strategy-chiprow', {}, ...mine.map((p) => { const c = stageClock(p, Date.now(), false); return h('div.strategy-setup', { style: `--c:${c?.ink ?? '#8a8f9a'}` }, h('b', {}, p.symbol), p.side ? h('span', { 'data-side': p.side }, p.side === 'long' ? '▲ LONG' : '▼ SHORT') : null, h('span.strategy-setup-t', {}, c ? c.text : p.stage)); }))
        : h('p.strategy-fine', {}, id ? `No ${st.name} setup at a level on ${s.markets.join(', ')} right now. The playbook is watching.` : 'This Pine script has no office playbook behind it, so it has no live setups here.'));
  };

  /** How the office's backtest says the playbook does, by market. */
  const testingCard = (s: TradingSnapshot, st: Strategy) => {
    const id = st.playbook?.id;
    if (!id) return h('div');
    const all = statsOf(s, id);
    const per = (s.backtest?.stats ?? []).filter((x) => x.playbook === id && x.symbol !== 'ALL');
    const paper = statsOf(s, id, 'ALL', 'paper');
    const bt = s.backtest;
    return card('How it tests · the office backtest',
      bt && all
        ? h('div', {},
            h('div.strategy-testhead', {}, spark(all.curve, st.color, 220, 44), h('div', {}, h('b', {}, `${signed(all.avgR)} R a trade`), h('small', {}, `${all.trades} trades over ${bt.days.length} days · win rate ${pctOf(all.winRate)} · total ${signed(all.totalR, 1)} R · worst dip ${all.maxDrawdownR} R`))),
            per.length ? h('table.strategy-table', {}, th('Market', 'Trades', 'Win rate', 'Avg per trade', 'Total', 'Worst dip'), h('tbody', {}, ...per.map((m) => h('tr', {}, h('th', { scope: 'row' }, m.symbol), num(String(m.trades)), num(pctOf(m.winRate)), num(`${signed(m.avgR)} R`, rTone(m.avgR)), num(`${signed(m.totalR, 1)} R`, rTone(m.totalR)), num(`${m.maxDrawdownR} R`))))) : null,
            st.script ? h('p.strategy-fine', {}, `This is the office’s own version of ${st.name}. Your Pine script is tested separately, on its own exact rules, in the report below, so the two sets of numbers can differ.`) : null,
            paper && paper.trades ? h('p.strategy-fine', {}, `Paper book so far: ${paper.trades} trades, ${signed(paper.avgR)} R average.`) : null,
            h('p.strategy-fine', {}, `The office replays this playbook's rules on ${bt.days.length} real trading days of 1-minute bars (${bt.days[0]} to ${bt.days[bt.days.length - 1]}). Last run ${new Date(bt.ranAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${bt.running ? ' · running now…' : ''}. Paper evidence, never a promise.`))
        : h('p.strategy-fine', {}, bt?.running ? 'The backtest is running…' : 'No backtest numbers yet. Tap “Run tests now”.'));
  };

  /** The Pine area: every version as a chip, one open in full. Or, with no script, a way to add one. */
  const pineArea = (st: Strategy): Node[] => {
    const sc = st.script;
    if (!sc) {
      const d = drafts.get(`new:${st.id}`) ?? { source: '', changelog: '', bump: st.name, status: '' };
      drafts.set(`new:${st.id}`, d);
      const nm = h('input', { placeholder: 'Script name', oninput: (e: Event) => (d.bump = (e.target as HTMLInputElement).value) }) as HTMLInputElement;
      nm.value = d.bump;
      const src = h('textarea', { placeholder: 'Paste its Pine source (Pine Editor → select all → copy)', rows: '4', oninput: (e: Event) => (d.source = (e.target as HTMLTextAreaElement).value) }) as HTMLTextAreaElement;
      src.value = d.source;
      const det = h('details.strategy-card', { open: addOpen }, h('summary', {}, `Add the Pine script for ${st.name}`), nm, src,
        h('div.strategy-actions', {}, h('button.btn.primary', { onclick: () => void go(trading.post(POST, { action: 'script', name: d.bump, source: d.source, changelog: 'First version', playbook: st.playbook?.id }).then((e) => { if (!e) { d.source = ''; addOpen = false; } return e; }), 'Pine script saved as an experiment') }, 'Save script')),
        h('small', {}, 'It’s saved as an experiment and never goes live until you say so. Once saved, its versions are dated and kept here.'));
      det.addEventListener('toggle', () => (addOpen = (det as HTMLDetailsElement).open));
      return [det];
    }
    const live = sc.versions.find((v) => v.status === 'live');
    for (const v of sc.versions) if (v.fresh && v.test?.vs?.verdict === 'better') newThisVisit.add(`${sc.id}@${v.version}`);
    let openV = versionOf.get(st.id);
    // Opens on what's new, else on what's live. Looking at a new version tells the lab you've seen it.
    if (!openV || !sc.versions.some((v) => v.version === openV)) {
      openV = sc.versions.find((v) => newThisVisit.has(`${sc.id}@${v.version}`))?.version ?? live?.version ?? sc.versions[0]!.version;
      versionOf.set(st.id, openV);
    }
    const open = sc.versions.find((v) => v.version === openV)!;
    if (open.fresh && !markedSeen.has(`${sc.id}@${open.version}`)) {
      markedSeen.add(`${sc.id}@${open.version}`);
      void trading.post(POST, { action: 'seen', script: sc.id, version: open.version });
    }
    return [
      h('div.strategy-strip', {}, h('div.strategy-striphead', {}, h('b', {}, `${st.name} · Pine versions`), h('small', {}, `${sc.versions.length} saved · newest first · tap one to open it`)), h('div.strategy-chips', {}, ...sc.versions.map((v) => chip(st, sc, v, openV!)))),
      detailCard(st, sc, open, live),
    ];
  };

  /** What the last test run did, step by step, so it's never a mystery. */
  const stepsOf = (r: LabReport) => {
    const count = (v: string) => r.tried.filter((t) => t.verdict === v).length;
    const bars = Object.entries(r.bars).map(([k, n]) => `${k} ${n!.toLocaleString()}`).join(' · ');
    return [
      `Loaded ${r.days} real trading sessions (${r.from} to ${r.to}) of 1-minute bars: ${bars}.`,
      `Replayed ${r.scriptName} v${r.version}, your live version, on 5-minute bars like your chart, following its rules exactly: ${r.baseline.trades} trades, ${signed(r.baseline.avgR)} R average.`,
      `Tried ${r.tried.length} single changes to its settings (opening range, stop room, loss cap, target, window, re-entry): ${count('better')} better, ${count('same')} no real difference, ${count('worse')} worse, ${count('unproven')} too early to tell.`,
      r.retested.length ? `Re-tested the other saved versions against the live one: ${r.retested.map((v) => `v${v}`).join(', ')}.` : 'There were no other saved versions to re-test.',
      r.saved ? `Result: one change held up (${r.best?.join(' + ')}), saved as v${r.saved} for you to look at.` : r.existing ? `Result: the best change (${r.best?.join(' + ')}) is already saved as v${r.existing}, so nothing new was added.` : 'Result: nothing beat the live version convincingly, so nothing new was saved.',
    ];
  };
  const reportCard = (s: TradingSnapshot, st: Strategy) => {
    const lab = s.vault.lab;
    const r = lab.report && st.script && lab.report.script === st.script.id ? lab.report : null;
    const body: (Node | null)[] = [];
    if (lab.running) body.push(h('div.strategy-running', {}, h('span.strategy-spin'), h('div', {}, h('b', {}, 'Running now'), h('small', {}, lab.stage || 'Starting…'))));
    if (r) {
      body.push(
        h('p.strategy-fine', {}, Date.now() - r.ranAt < 30_000 ? h('span.strategy-ran', {}, '✓ Ran just now') : null, `Last run ${new Date(r.ranAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })} · took ${(r.took / 1000).toFixed(1)} s · ${r.scriptName} v${r.version}`),
        h('ol.strategy-steps-list', {}, ...stepsOf(r).map((t) => h('li', {}, t))),
        h('details.strategy-tried', {}, h('summary', {}, `Every change it tried (${r.tried.length})`),
          h('table.strategy-table', {}, th('Change', 'Trades', 'Avg per trade', 'Verdict'), h('tbody', {}, ...[...r.tried].sort((a, b) => b.avgR - a.avgR).map((t) => h('tr', {}, h('th', { scope: 'row' }, t.change.join(' + ')), num(String(t.trades)), num(`${signed(t.avgR)} R`, rTone(t.avgR - r.baseline.avgR)), num(t.verdict === 'better' ? `better · ${t.confidence}` : t.verdict === 'unproven' ? 'too early' : t.verdict, t.verdict === 'better' ? 'ok' : t.verdict === 'worse' ? 'bad' : ''))))),
          h('small', {}, `Compared with the live version’s ${signed(r.baseline.avgR)} R average.`)));
    } else if (!lab.running) body.push(h('p.strategy-fine', {}, st.script ? 'No test run yet. Tap “Run tests now” below, or wait for the next market close.' : 'The Pine lab tests a saved Pine script. This strategy has none yet, so only the office backtest above covers it.'));
    body.push(h('details.strategy-tried', {}, h('summary', {}, 'How does testing work?'),
      h('ul.strategy-how', {},
        h('li', {}, h('b', {}, 'Real data. '), 'About a month of real 1-minute bars for NQ, GC and ES.'),
        h('li', {}, h('b', {}, 'Your script’s own rules. '), 'The lab replays the live version exactly as the script plays it on your 5-minute chart: NY VWAP, the opening range, the window, the stop and target, and the one DB2 re-entry.'),
        h('li', {}, h('b', {}, 'One change at a time. '), 'It tries each setting alone, so you can see which one matters.'),
        h('li', {}, h('b', {}, 'Earlier and later days. '), 'A change is picked on the earlier two thirds of the days and must also hold up on the later third it never saw.'),
        h('li', {}, h('b', {}, 'Honest about luck. '), 'Each verdict has a confidence, from how big the gap is against normal trade-to-trade noise. A short history can flatter any change.'),
        h('li', {}, h('b', {}, 'You decide. '), 'The lab only saves candidates. Nothing goes live, and nothing on your TradingView chart changes, unless you say so.'),
        h('li', {}, h('b', {}, 'When. '), 'After every market close, and whenever you tap “Run tests now” (which also re-runs the office backtest of every playbook).'))));
    return card('Test run report', ...body);
  };

  const agentCard = () => card('Your Strategy agent',
    h('p', {}, 'Strategy holds every strategy and every version of your Pine scripts, and hands them to the other desks for testing. It never edits what’s live.'),
    opts.onAsk ? h('button.btn.primary', { onclick: () => { modal.close(); opts.onAsk!(); } }, 'Ask Strategy ✨') : null,
    h('small', {}, 'e.g. “How is Failed Auction doing, and what would you change?”'));
  const rulesCard = (st: Strategy) => card('Locked rules', st.playbook ? h('p', {}, st.playbook.rule) : null, st.script?.rules.length ? h('ul.strategy-rules', {}, ...st.script.rules.map((r) => h('li', {}, r))) : null, !st.playbook && !st.script?.rules.length ? h('p', {}, 'None written down yet.') : null);
  const alertsCard = (s: TradingSnapshot, st: Strategy) => {
    const mine = s.alerts.filter((a) => (st.playbook ? a.playbook === st.playbook.id : true)).slice(0, 6);
    return card('Alerts from TradingView', ...(mine.length ? mine.map((a) => h('div.strategy-alert', {}, h('b', {}, `${a.symbol} ${a.side?.toUpperCase() ?? ''}`), h('span', {}, `${a.price ?? ''}`), h('small', {}, `${new Date(a.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · ${a.ver ? `v${a.ver}` : 'version not stated'}`))) : [h('p', {}, `None yet for ${st.name}. When your alert fires, it shows here with the version that sent it.`)]));
  };
  const addVersionCard = (st: Strategy) => {
    const sc = st.script;
    if (!sc) return null;
    const d = drafts.get(sc.id) ?? { source: '', changelog: '', bump: 'patch', status: 'candidate' };
    drafts.set(sc.id, d);
    const src = h('textarea', { placeholder: 'Paste a version you changed yourself', rows: '4', oninput: (e: Event) => (d.source = (e.target as HTMLTextAreaElement).value) }) as HTMLTextAreaElement;
    src.value = d.source;
    const log = h('textarea', { placeholder: 'What changed?', rows: '2', oninput: (e: Event) => (d.changelog = (e.target as HTMLTextAreaElement).value) }) as HTMLTextAreaElement;
    log.value = d.changelog;
    return h('details.strategy-card', {}, h('summary', {}, `Save a version of ${st.name} you wrote`), src, log,
      h('div.strategy-actions', {}, h('button.btn.primary', { onclick: () => void go(trading.post(POST, { action: 'add', script: sc.id, source: d.source, changelog: d.changelog, bump: d.bump, status: d.status }).then((e) => { if (!e) { d.source = ''; d.changelog = ''; } return e; }), 'Saved as a new version. It never goes live on its own') }, 'Save version')));
  };
  const addScript = () => {
    const name = h('input', { placeholder: 'Script name', oninput: (e: Event) => (newScript.name = (e.target as HTMLInputElement).value) }) as HTMLInputElement;
    name.value = newScript.name;
    const src = h('textarea', { placeholder: 'Paste its Pine source', rows: '3', oninput: (e: Event) => (newScript.source = (e.target as HTMLTextAreaElement).value) }) as HTMLTextAreaElement;
    src.value = newScript.source;
    return h('details.strategy-card', {}, h('summary', {}, 'Add a Pine script that isn’t a playbook'), name, src, h('div.strategy-actions', {}, h('button.btn.primary', { onclick: () => void go(trading.post(POST, { action: 'script', name: newScript.name, source: newScript.source, changelog: 'First version' }).then((e) => { if (!e) newScript = { name: '', source: '' }; return e; }), 'Script added') }, 'Add script')));
  };

  function render() {
    const s = trading.snap;
    if (!s) return void text(status, 'Connecting to the office…');
    const lab = s.vault.lab;
    const bt = s.backtest;
    text(status, lab.running ? `🧪 ${lab.stage || 'Testing…'}` : lab.ranAt ? `Last tested ${new Date(lab.ranAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · ${lab.note}${bt?.running ? ' · backtest running' : ''}` : 'Waiting for the first test run');
    text(noteEl, note);
    runBtn.disabled = lab.running || !!bt?.running;
    const list = strategiesOf(s);
    if (!strategyId || !list.some((x) => x.id === strategyId)) strategyId = list[0]?.id ?? null;
    const st = list.find((x) => x.id === strategyId);
    if (!st) return;
    picker.replaceChildren(...list.map((x) => pickerCard(s, x)));
    hero.replaceChildren(...heroCard(st));
    hero.style.setProperty('--c', st.color);
    nowRow.replaceChildren(nowCard(s, st));
    testing.replaceChildren(testingCard(s, st));
    pine.replaceChildren(...pineArea(st));
    report.replaceChildren(reportCard(s, st));
    const addV = addVersionCard(st);
    side.replaceChildren(agentCard(), rulesCard(st), alertsCard(s, st), ...(addV ? [addV] : []), addScript());
  }

  // Typing shouldn't be wiped by the next snapshot.
  let editing = false;
  el.addEventListener('focusin', (e) => (editing = (e.target as HTMLElement).matches('input,textarea')));
  el.addEventListener('focusout', () => (editing = false));
  off = trading.on(() => {
    if (!editing) render();
  });
  render();
}
