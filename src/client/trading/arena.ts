import { ENGINES, enginesOf, MARKET_BY_ID, marketsOf, type ArenaView, type BacktestReport, type BrainView, type Decision, type Draft, type EngineId, type LabView, type League, type TraderView } from '../../shared/arena';
import { h, openModal } from '../ui/dom';
import './arena.css';
import { openResearchWorkbench } from './research-workbench';

// The Arena console: named traders racing on paper, a futures league and a crypto league.
//
//   Floor         every trader in a column: the account, the position, the curve, the last call; beside them
//                 the Desk Head, the board, the decision stream and what the risk desk refused
//   Leaderboard   the whole cast, with their rules to copy
//   Engine wars   which engine (a playbook, for futures) is winning
//   Research      where the edge is on the tape, and a backtest of any trader before it costs an account
//   Graveyard     every account that ended: passed, busted, retired, let go
//   Design        a trader from a sentence
//
// It needs nothing from the office but this file, its stylesheet and the engine's types: `mountArena` draws
// it into any element (the page at /arena does exactly that), and `openArena` hangs it in an office window.
// The server streams both leagues (server/trading/arena.ts); nothing here can place an order.

type Tab = 'floor' | 'board' | 'wars' | 'lab' | 'graveyard' | 'design';
const TABS: { id: Tab; label: string }[] = [
  { id: 'floor', label: 'Floor' },
  { id: 'board', label: 'Leaderboard' },
  { id: 'wars', label: 'Engine wars' },
  { id: 'lab', label: 'Research' },
  { id: 'graveyard', label: 'Graveyard' },
  { id: 'design', label: 'Design a trader' },
];
const MODELS: [string, string][] = [['claude-opus-5-5', 'Opus 5.5'], ['claude-sonnet-5-5', 'Sonnet 5.5'], ['claude-haiku-4-5-20251001', 'Haiku 4.5']];
/** The other harnesses a model can be asked through: each uses its own CLI, sign-in and default model. */
const HARNESSES: [BrainView['kind'], string, string][] = [['codex', 'Codex', 'OpenAI’s Codex CLI (`codex exec`).'], ['opencode', 'OpenCode', 'The OpenCode CLI (`opencode run`), on whichever model it is set to.'], ['gemini', 'Gemini CLI', 'Google’s Gemini CLI (`gemini -p`).']];
/** Where the idea comes from. */
const BEEBOTS = 'https://github.com/imikerussell/beebots';
const SPEEDS: [number, string][] = [[1, '1 bar/s'], [5, '5'], [20, '20'], [60, '60']];
const NS = 'http://www.w3.org/2000/svg';

const usd = (v: number, d = 0) => `${v < 0 ? '−' : ''}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const signed = (v: number, d = 0) => `${v < 0 ? '−' : '+'}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const pctText = (v: number) => `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(2)}%`;
const tone = (v: number) => (v > 0.004 ? 'up' : v < -0.004 ? 'down' : 'flat');
const price = (market: string, v: number) => v.toLocaleString('en-US', { minimumFractionDigits: MARKET_BY_ID[market]?.decimals ?? 2, maximumFractionDigits: MARKET_BY_ID[market]?.decimals ?? 2 });
const tapeClock = (league: League, ts: number) => (ts ? new Date(ts).toLocaleString('en-US', { timeZone: league === 'futures' ? 'America/Los_Angeles' : 'UTC', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) + (league === 'futures' ? ' PT' : ' UTC') : '');
const barClock = (league: League, ts: number) => new Date(ts).toLocaleTimeString('en-US', { timeZone: league === 'futures' ? 'America/Los_Angeles' : 'UTC', hour: '2-digit', minute: '2-digit', hour12: false });

function svg(tag: string, attrs: Record<string, string | number> = {}, ...kids: (SVGElement | string)[]): SVGElement {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const k of kids) el.append(k);
  return el;
}

let faces = 0;
const SPECIES = [
  { kind: 'bull', fur: '#c98552', dark: '#7b4627', light: '#f6dcbc' },
  { kind: 'bear', fur: '#97694a', dark: '#573520', light: '#ecd2b2' },
  { kind: 'bee', fur: '#f8bd35', dark: '#2b1d10', light: '#fff0b8' },
  { kind: 'owl', fur: '#a4b0d6', dark: '#5a6593', light: '#f1f4fd' },
  { kind: 'fox', fur: '#f37f33', dark: '#a8461a', light: '#fff3e4' },
] as const;

/**
 * A trader's portrait, drawn from its name: the same name always gets the same character. A bull, a bear,
 * a bee, an owl or a fox, in a neon ring, with whatever it wears to the desk.
 */
function portrait(name: string, color: string, size = 64): SVGElement {
  let seed = 7;
  for (const c of name) seed = (seed * 31 + c.charCodeAt(0)) >>> 0;
  const roll = (n: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed >>> 8) % n;
  };
  const sp = SPECIES[roll(SPECIES.length)]!;
  const eyes = roll(4);
  const wear = roll(4);
  const mouth = roll(3);
  const tilt = roll(2) ? 1 : -1;
  const id = `ar-f${faces++}`;
  const ink = '#141826';
  const g = svg('svg', { viewBox: '0 0 96 96', width: size, height: size, class: 'ar-face', role: 'img', 'aria-label': name });
  const add = (...kids: SVGElement[]) => g.append(...kids);
  add(svg('defs', {},
    svg('radialGradient', { id: `${id}b`, cx: '50%', cy: '30%', r: '80%' }, svg('stop', { offset: '0', 'stop-color': color, 'stop-opacity': 0.75 }), svg('stop', { offset: '0.55', 'stop-color': '#1a1440' }), svg('stop', { offset: '1', 'stop-color': '#070912' })),
    svg('linearGradient', { id: `${id}h`, x1: 0, y1: 0, x2: 0, y2: 1 }, svg('stop', { offset: '0', 'stop-color': sp.light }), svg('stop', { offset: '0.45', 'stop-color': sp.fur }), svg('stop', { offset: '1', 'stop-color': sp.dark })),
    svg('linearGradient', { id: `${id}s`, x1: 0, y1: 0, x2: 1, y2: 1 }, svg('stop', { offset: '0', 'stop-color': '#2a2f4a' }), svg('stop', { offset: '1', 'stop-color': '#05060c' })),
    svg('clipPath', { id: `${id}c` }, svg('circle', { cx: 48, cy: 48, r: 45 }))));
  add(svg('circle', { cx: 48, cy: 48, r: 45, fill: `url(#${id}b)` }));
  const body = svg('g', { 'clip-path': `url(#${id}c)` });
  g.append(body);
  const b = (...kids: SVGElement[]) => body.append(...kids);
  // Sparks in the dark behind it, and speed lines for the ones in a hurry.
  for (let i = 0; i < 4; i++) b(svg('circle', { cx: 10 + roll(76), cy: 8 + roll(30), r: 0.8 + roll(2) * 0.5, fill: i % 2 ? color : '#fff', opacity: 0.8 }));
  if (wear === 3) b(svg('path', { d: 'M4 60 H20 M2 68 H16 M78 30 H94', stroke: color, 'stroke-width': 2, 'stroke-linecap': 'round', opacity: 0.6 }));
  // Shoulders in a desk jacket.
  b(svg('path', { d: 'M18 100 Q20 76 48 74 Q76 76 78 100 Z', fill: '#1b2036' }), svg('path', { d: 'M40 76 L48 88 L56 76', fill: 'none', stroke: color, 'stroke-width': 2.5 }));
  if (sp.kind === 'bee') b(svg('ellipse', { cx: 18, cy: 46, rx: 13, ry: 20, fill: '#fff', opacity: 0.22, transform: 'rotate(-24 18 46)' }), svg('ellipse', { cx: 78, cy: 46, rx: 13, ry: 20, fill: '#fff', opacity: 0.22, transform: 'rotate(24 78 46)' }));
  // Ears, horns, tufts, antennae.
  if (sp.kind === 'bull') b(svg('path', { d: 'M24 38 Q8 34 12 16 Q18 28 30 30 Z M72 38 Q88 34 84 16 Q78 28 66 30 Z', fill: '#fbf1dc', stroke: ink, 'stroke-width': 1.5 }), svg('ellipse', { cx: 21, cy: 44, rx: 7, ry: 4.5, fill: sp.fur, transform: 'rotate(-20 21 44)' }), svg('ellipse', { cx: 75, cy: 44, rx: 7, ry: 4.5, fill: sp.fur, transform: 'rotate(20 75 44)' }));
  else if (sp.kind === 'bear') b(svg('circle', { cx: 26, cy: 30, r: 10, fill: sp.fur }), svg('circle', { cx: 70, cy: 30, r: 10, fill: sp.fur }), svg('circle', { cx: 26, cy: 30, r: 5, fill: sp.light }), svg('circle', { cx: 70, cy: 30, r: 5, fill: sp.light }));
  else if (sp.kind === 'bee') b(svg('path', { d: 'M40 30 Q36 14 30 12 M56 30 Q60 14 66 12', fill: 'none', stroke: ink, 'stroke-width': 2.5, 'stroke-linecap': 'round' }), svg('circle', { cx: 30, cy: 12, r: 3.5, fill: color }), svg('circle', { cx: 66, cy: 12, r: 3.5, fill: color }));
  else if (sp.kind === 'owl') b(svg('path', { d: 'M26 38 L22 16 L40 30 Z M70 38 L74 16 L56 30 Z', fill: sp.fur, stroke: sp.dark, 'stroke-width': 1.5 }));
  else b(svg('path', { d: 'M24 42 L18 12 L42 30 Z M72 42 L78 12 L54 30 Z', fill: sp.fur, stroke: sp.dark, 'stroke-width': 1.5 }), svg('path', { d: 'M25 34 L22 20 L34 29 Z M71 34 L74 20 L62 29 Z', fill: ink }));
  b(svg('ellipse', { cx: 48, cy: 52, rx: 27, ry: 25, fill: `url(#${id}h)`, stroke: sp.dark, 'stroke-width': 1.5 }));
  if (sp.kind === 'bee') b(svg('path', { d: 'M27 40 Q48 28 69 40', fill: 'none', stroke: sp.dark, 'stroke-width': 5, 'stroke-linecap': 'round' }));
  if (sp.kind === 'fox') b(svg('path', { d: 'M22 56 Q30 78 48 76 Q66 78 74 56 Q62 66 48 62 Q34 66 22 56 Z', fill: sp.light }));
  // The muzzle and what is on it.
  if (sp.kind === 'owl') b(svg('path', { d: 'M43 58 L53 58 L48 67 Z', fill: '#f4a52e', stroke: ink, 'stroke-width': 1.2 }));
  else {
    if (sp.kind !== 'fox') b(svg('ellipse', { cx: 48, cy: 64, rx: sp.kind === 'bull' ? 15 : 12, ry: 9.5, fill: sp.light }));
    if (sp.kind === 'bull') b(svg('ellipse', { cx: 42, cy: 62, rx: 2.2, ry: 1.6, fill: ink }), svg('ellipse', { cx: 54, cy: 62, rx: 2.2, ry: 1.6, fill: ink }), svg('path', { d: 'M43 66 Q48 74 53 66', fill: 'none', stroke: '#f4c542', 'stroke-width': 2.2 }));
    else if (sp.kind !== 'bee') b(svg('ellipse', { cx: 48, cy: 60, rx: 4, ry: 2.8, fill: ink }));
    const y = sp.kind === 'bull' ? 68 : 65;
    if (sp.kind !== 'bull') b(mouth === 0 ? svg('path', { d: `M41 ${y} Q48 ${y + 8} 55 ${y} Z`, fill: ink }) : svg('path', { d: mouth === 1 ? `M41 ${y} Q48 ${y + 6} 55 ${y}` : `M42 ${y + 2} Q50 ${y + 3} 55 ${y - 2}`, fill: 'none', stroke: ink, 'stroke-width': 2.2, 'stroke-linecap': 'round' }));
    if (sp.kind !== 'bull' && mouth === 0) b(svg('path', { d: `M43.5 ${y + 0.6} H52.5 V${y + 2.4} H43.5 Z`, fill: '#fff' }));
  }
  b(svg('ellipse', { cx: 30, cy: 61, rx: 5, ry: 3, fill: '#ff6b8b', opacity: 0.35 }), svg('ellipse', { cx: 66, cy: 61, rx: 5, ry: 3, fill: '#ff6b8b', opacity: 0.35 }));
  // The eyes: wide, behind shades, behind round glasses, or half shut.
  if (eyes === 1) b(svg('path', { d: 'M24 44 H72 Q73 56 63 57 Q54 57 51 49 H45 Q42 57 33 57 Q23 56 24 44 Z', fill: `url(#${id}s)`, stroke: ink, 'stroke-width': 1.5 }), svg('path', { d: 'M28 47 L38 47 M56 47 L64 47', stroke: color, 'stroke-width': 2, 'stroke-linecap': 'round', opacity: 0.9 }));
  else {
    for (const x of [37, 59]) b(svg('ellipse', { cx: x, cy: 49, rx: 7.5, ry: 8.5, fill: '#fff', stroke: ink, 'stroke-width': 1.5 }), svg('circle', { cx: x + tilt, cy: 50, r: 4.6, fill: color }), svg('circle', { cx: x + tilt, cy: 50, r: 2.6, fill: ink }), svg('circle', { cx: x + tilt + 1.6, cy: 48, r: 1.4, fill: '#fff' }));
    if (eyes === 3) b(svg('path', { d: 'M29 49 Q37 38 45 49 Z M51 49 Q59 38 67 49 Z', fill: sp.fur, stroke: ink, 'stroke-width': 1.2 }));
    else b(svg('path', { d: tilt > 0 ? 'M30 39 L43 36 M53 36 L66 39' : 'M30 36 L43 39 M53 39 L66 36', stroke: ink, 'stroke-width': 2.4, 'stroke-linecap': 'round' }));
    if (eyes === 2) b(svg('circle', { cx: 37, cy: 49, r: 10.5, fill: 'none', stroke: ink, 'stroke-width': 2.2 }), svg('circle', { cx: 59, cy: 49, r: 10.5, fill: 'none', stroke: ink, 'stroke-width': 2.2 }), svg('path', { d: 'M47.5 49 H48.5', stroke: ink, 'stroke-width': 2.2 }));
  }
  // What it wears to the desk: a headset, a visor, a party hat, a sweatband.
  if (wear === 0) b(svg('path', { d: 'M20 50 Q18 22 48 22 Q78 22 76 50', fill: 'none', stroke: '#22283f', 'stroke-width': 5 }), svg('rect', { x: 14, y: 44, width: 9, height: 16, rx: 4.5, fill: color }), svg('rect', { x: 73, y: 44, width: 9, height: 16, rx: 4.5, fill: color }), svg('path', { d: 'M18 60 Q20 74 38 72', fill: 'none', stroke: '#22283f', 'stroke-width': 2.5 }), svg('circle', { cx: 39, cy: 72, r: 2.8, fill: color }));
  else if (wear === 1) b(svg('path', { d: 'M22 36 Q24 20 48 20 Q72 20 74 36 Z', fill: color, stroke: ink, 'stroke-width': 1.5 }), svg('path', { d: 'M20 37 Q48 30 88 40 Q60 42 20 41 Z', fill: ink }));
  else if (wear === 2) b(svg('path', { d: 'M38 30 L52 2 L62 28 Z', fill: color, stroke: ink, 'stroke-width': 1.5 }), svg('path', { d: 'M43 20 L57 16 M46 12 L54 9', stroke: '#fff', 'stroke-width': 2, opacity: 0.8 }), svg('circle', { cx: 52, cy: 3, r: 3.5, fill: '#fff' }));
  else b(svg('path', { d: 'M22 38 Q48 26 74 38 L75 44 Q48 32 21 44 Z', fill: color, stroke: ink, 'stroke-width': 1.2 }));
  add(svg('circle', { cx: 48, cy: 48, r: 45, fill: 'none', stroke: color, 'stroke-width': 3 }), svg('circle', { cx: 48, cy: 48, r: 47, fill: 'none', stroke: color, 'stroke-width': 1, opacity: 0.35 }));
  return g;
}

/** The equity curve as an area, around the line the account started on. */
function curve(points: [number, number][], color: string): SVGElement {
  const W = 320;
  const H = 150;
  const g = svg('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', class: 'ar-curve' });
  const vals = points.map((p) => p[1]);
  const hi = Math.max(1, ...vals);
  const lo = Math.min(-1, ...vals);
  const pad = (hi - lo) * 0.12;
  const y = (v: number) => H - ((v - (lo - pad)) / (hi - lo + pad * 2)) * H;
  const zero = y(0);
  g.append(svg('line', { x1: 0, x2: W, y1: zero, y2: zero, class: 'ar-curve-zero' }));
  if (points.length < 2) return g;
  const x = (i: number) => (i / (points.length - 1)) * W;
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p[1]).toFixed(1)}`).join(' ');
  const id = `ar-c${color.replace('#', '')}`;
  g.append(
    svg('defs', {}, svg('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 }, svg('stop', { offset: '0', 'stop-color': color, 'stop-opacity': 0.42 }), svg('stop', { offset: '1', 'stop-color': color, 'stop-opacity': 0.02 }))),
    svg('path', { d: `${line} L${W} ${zero.toFixed(1)} L0 ${zero.toFixed(1)} Z`, fill: `url(#${id})` }),
    svg('path', { d: line, fill: 'none', stroke: color, 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke', 'stroke-linejoin': 'round' }),
    svg('circle', { cx: W - 2, cy: y(points.at(-1)![1]), r: 3.5, fill: color, class: 'ar-curve-dot' }),
  );
  return g;
}

const probBars = (probs: [string, number][], pick: string, color: string) =>
  h('div.ar-probs', {}, ...probs.slice(0, 3).map(([label, p]) => h('div.ar-prob', { 'data-pick': label === pick ? '1' : undefined }, h('span.ar-prob-label', {}, label), h('span.ar-prob-bar', {}, h('i', { style: `width:${Math.round(p * 100)}%;background:${color}` })), h('span.ar-prob-pct', {}, `${Math.round(p * 100)}%`))));

/** "Powered by Opus 5.5 on Claude Code": said only of the brain that is really deciding. */
const powered = (b: BrainView): HTMLElement => h('span.ar-pw', {}, 'Powered by ', h('em', {}, b.kind === 'claude' ? '✳' : '◆'), h('b', {}, ` ${b.label}`), b.on ? ` on ${b.on}` : '');

/** A backtest's result: what it made, how, and what it cost on the way. */
function reportCard(r: BacktestReport, league: League): HTMLElement {
  const fut = league === 'futures';
  const d = fut ? 0 : 2;
  const stat = (label: string, value: string, t?: string) => h('div', {}, h('span', {}, label), h('b', { 'data-tone': t }, value));
  const won = r.trades ? Math.round((r.wins / r.trades) * 100) : 0;
  return h('div.ar-report', { style: `--c:${ENGINES[r.engine].color}` },
    h('div.ar-report-head', {}, h('b', {}, r.name), h('small', {}, `${ENGINES[r.engine].name} · ${r.markets.join(', ')} · house brain · ${r.span}`)),
    h('div.ar-report-stats', {},
      stat('NET, AFTER FEES', signed(r.net, d), tone(r.net)),
      stat('TRADES', String(r.trades)),
      stat('WON', r.trades ? `${won}%` : '—'),
      stat('WORST DIP', usd(r.worstDip, d), r.worstDip > 0 ? 'down' : undefined),
      stat('BEST · WORST DAY', `${signed(r.bestDay, d)} · ${signed(r.worstDay, d)}`),
      fut ? stat('PASSED · BUST', `${r.passes} · ${r.busts}`, r.passes > r.busts ? 'up' : r.busts ? 'down' : undefined) : stat('RESTARTS', String(r.busts), r.busts ? 'down' : undefined)),
    h('div.ar-report-curve', {}, curve(r.curve.map((v, i) => [i, v]), ENGINES[r.engine].color) as unknown as Node),
    h('small', {}, fut ? (r.firstPass ? `Its first evaluation passed in ${r.firstPass} sessions. ` : r.busts ? 'It hit the floor before it reached the target. ' : 'It neither passed nor hit the floor. ') : '', r.trades < 20 ? `${r.trades} trades is too few to tell luck from edge. ` : '', 'A replay of the past with the house brain: a lead to test forward, not a forecast.'));
}

export interface ArenaHandle {
  close(): void;
}

/** Draws the Arena into `host` and keeps it live. `onClose` adds a ✕. */
export function mountArena(host: HTMLElement, opts: { onClose?: () => void; league?: League; tab?: Tab } = {}): ArenaHandle {
  const views: Partial<Record<League, ArenaView>> = {};
  let league: League = opts.league ?? ((localStorage.getItem('agent-office.arena.league') as League) || 'futures');
  if (league !== 'futures' && league !== 'crypto') league = 'futures';
  let tab: Tab = opts.tab ?? 'floor';
  let note = '';
  let seen = 0;
  let open: string | null = null;
  let sheet: HTMLElement | null = null;
  let offline = false;
  /** The tab the body was last drawn for. */
  let shown: Tab | null = null;
  // The design form's own state: kept out of the stream's redraws so typing is never interrupted.
  const design: { sentence: string; draft: Draft | null; busy: boolean; again: number; report: BacktestReport | null; testing: boolean } = { sentence: '', draft: null, busy: false, again: 0, report: null, testing: false };
  // Research: the edge grid of each league (fetched when the tab is first opened), and the last backtest run there.
  const labs: Partial<Record<League, LabView | 'loading' | { error: string }>> = {};
  const bench: { id: string; busy: boolean; report: BacktestReport | null } = { id: '', busy: false, report: null };

  const head = h('header.ar-head');
  const main = h('div.ar-main');
  const over = h('div.ar-sheet');
  const foot = h('footer.ar-foot');
  const root = h('div.ar', { role: opts.onClose ? 'dialog' : 'main', 'aria-label': 'The Arena' }, head, main, over, foot);
  host.append(root);

  const post = async (body: Record<string, unknown>): Promise<{ ok: boolean; draft?: Draft; report?: BacktestReport }> => {
    try {
      const res = await fetch('/api/trading/arena', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ league, ...body }) });
      const j = (await res.json()) as { error?: string; draft?: Draft; report?: BacktestReport };
      note = res.ok ? '' : (j.error ?? 'That did not work');
      draw();
      return { ok: res.ok, draft: j.draft, report: j.report };
    } catch {
      note = 'The office is not answering';
      draw();
      return { ok: false };
    }
  };

  // ---- The stream ------------------------------------------------------------------------------------------
  let source: EventSource | null = null;
  let retry = 0;
  const connect = () => {
    source = new EventSource('/api/trading/arena/stream');
    source.onmessage = (e) => {
      const m = JSON.parse(e.data as string) as { league: League; view: ArenaView };
      views[m.league] = m.view;
      offline = false;
      if (m.league === league) draw();
    };
    source.onerror = () => {
      offline = true;
      source?.close();
      draw();
      retry = window.setTimeout(connect, 3000);
    };
  };
  connect();

  // ---- Header ----------------------------------------------------------------------------------------------
  function drawHead(v: ArenaView | undefined) {
    const t = v?.tape;
    const tile = (label: string, value: string, sub: string, kind?: string) => h('div.ar-tile', { 'data-tone': kind }, h('span', {}, label), h('b', {}, value), h('small', {}, sub));
    const seg = h('div.ar-seg', { role: 'tablist', 'aria-label': 'League' }, ...(['futures', 'crypto'] as League[]).map((l) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(l === league), onclick: () => { league = l; open = null; bench.id = ''; bench.report = null; design.report = null; setSheet(null); localStorage.setItem('agent-office.arena.league', l); seen = 0; draw(); } }, l === 'futures' ? 'Futures' : 'Crypto')));
    const tape = h('div.ar-tape', { 'data-mode': t?.mode ?? 'warming' },
      h('i'),
      h('div', {}, h('b', {}, t ? (t.mode === 'replay' ? `Replay · session ${t.session} of ${t.sessions}` : t.label) : 'Connecting'), h('small', {}, t?.ts ? tapeClock(league, t.ts) : (t?.source ?? ''))),
      league === 'futures' && t && t.sessions
        ? h('div.ar-tape-ctl', {},
            h('button.ar-btn', { type: 'button', title: t.playing ? 'Pause the tape' : 'Play the tape', disabled: t.mode === 'ended', onclick: () => void post({ action: 'tape', playing: !t.playing }) }, t.playing ? '❚❚' : '▶'),
            h('div.ar-seg.small', { title: 'Minute bars played per second' }, ...SPEEDS.map(([s, label]) => h('button', { type: 'button', 'aria-selected': String(t.speed === s), onclick: () => void post({ action: 'tape', speed: s }) }, label))),
            h('button.ar-btn', { type: 'button', title: 'A new season: the same cast on new accounts, from the first session', onclick: () => void post({ action: 'tape', restart: true }) }, '↺'))
        : null);
    const b = v?.brain;
    const brain = h('button.ar-brain', { type: 'button', 'data-kind': b && b.kind !== 'house' ? 'model' : 'house', title: 'Who makes the picks, and what it costs', onclick: () => setSheet(brainSheet()) },
      b && b.kind !== 'house' ? powered(b) : h('span', {}, h('b', {}, 'House brain'), ' · no model'),
      h('small', {}, b && b.kind !== 'house' ? `${b.calls} of ${b.callCap} calls today${b.metered ? ` · ${usd(b.usd, 2)}` : ''}` : 'Put a model on the desk ›'));
    head.replaceChildren(
      h('div.ar-title', {}, h('h2', {}, 'The Arena'), h('span.ar-paper', {}, 'PAPER TRADING'), h('small', {}, v ? `${v.traders.length} traders · ${v.rules.label}` : 'Loading')),
      seg,
      h('div.ar-tiles', {},
        tile('Total P&L', v ? signed(v.totals.pnl, league === 'crypto' ? 2 : 0) : '—', v ? `${v.totals.orders} orders` : '', v ? tone(v.totals.pnl) : undefined),
        tile('Fees paid', v ? usd(v.totals.fees, 2) : '—', league === 'futures' ? `$${v?.rules.fee ?? 0} a micro a side` : 'taker 0.05%'),
        tile('Decisions', v ? v.totals.decisions.toLocaleString('en-US') : '—', v ? `${v.totals.asked.toLocaleString('en-US')} put to the brain` : '')),
      tape,
      brain,
      opts.onClose ? h('button.ar-x', { type: 'button', 'aria-label': 'Close the Arena', title: 'Close (Esc)', onclick: opts.onClose }, '✕') : '',
      h('nav.ar-tabs', { role: 'tablist' }, ...TABS.map((x) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(x.id === tab), onclick: () => { tab = x.id; main.scrollTop = 0; draw(); } }, x.label, x.id === 'graveyard' && v?.fallen.length ? h('i', {}, String(v.fallen.length)) : null))));
  }

  // ---- Floor -----------------------------------------------------------------------------------------------
  function column(v: ArenaView, t: TraderView): HTMLElement {
    const fut = league === 'futures';
    const leader = [...v.traders].sort((a, b) => b.equity - a.equity)[0]!;
    const behind = leader.equity - t.equity;
    const c = t.def.color;
    const pos = t.pos;
    return h('article.ar-col', { style: `--c:${c}`, 'data-cap': t.cap ?? undefined },
      h('header.ar-col-head', {},
        portrait(t.def.name, c),
        h('div.ar-who', {}, h('h3', {}, t.def.name), h('small', {}, `${t.def.tagline} · `, h('em', {}, ENGINES[t.def.engine].name))),
        h('div.ar-rank', {}, h('b', {}, `#${t.rank}`), h('small', {}, t.rank === 1 ? 'leading' : `${usd(behind, fut ? 0 : 2)} behind`))),
      h('div.ar-money', {}, h('b', {}, usd(t.equity, fut ? 0 : 2)), h('span', { 'data-tone': tone(t.pnl) }, `${t.pnl > 0 ? '▲' : t.pnl < 0 ? '▼' : '•'} ${signed(t.pnl, fut ? 0 : 2)}`, fut ? '' : ` (${pctText(t.pnlPct)})`)),
      // The race an evaluation is: the floor behind, the target ahead.
      t.progress != null
        ? h('div.ar-race', { title: `Floor ${usd(t.floor)} · target ${usd(v.rules.start + (v.rules.target ?? 0))}` },
            h('div.ar-race-bar', {}, h('i', { style: `width:${(t.progress * 100).toFixed(1)}%` }), h('u', { style: `left:${((t.startAt ?? 0) * 100).toFixed(1)}%` })),
            h('div.ar-race-ends', {}, h('span', { 'data-tone': t.cushion < v.rules.drawdown * 0.35 ? 'down' : undefined }, `${usd(t.cushion)} above the floor`), h('span', {}, `${usd(Math.max(0, t.toTarget ?? 0))} to the target`)))
        : h('div.ar-race-ends.solo', {}, h('span', {}, `Today ${signed(t.today, 2)}`), h('span', {}, `Retires at ${usd(t.floor)}`)),
      pos
        ? h('div.ar-pos', { 'data-side': pos.side },
            h('div.ar-pos-top', {}, h('span', {}, pos.side === 'long' ? '▲ LONG' : '▼ SHORT'), h('b', {}, pos.market), h('span.grow'), h('b', {}, fut ? `${pos.qty} ${MARKET_BY_ID[pos.market]!.unit}` : usd(pos.qty * pos.mark, 0))),
            h('div.ar-pos-pnl', { 'data-tone': tone(pos.upl) }, `${signed(pos.upl, fut ? 0 : 2)} open · ${pos.r >= 0 ? '+' : '−'}${Math.abs(pos.r).toFixed(1)}R`),
            h('small', {}, `entry ${price(pos.market, pos.entry)} → ${price(pos.market, pos.mark)} · stop ${price(pos.market, pos.stop)}${pos.target != null ? ` · target ${price(pos.market, pos.target)}` : ''}`))
        : h('div.ar-pos.flat', {}, h('div.ar-pos-top', {}, h('span', {}, t.cap === 'loss_stop' ? 'SENT HOME' : t.cap === 'trade_cap' ? 'BENCHED' : 'FLAT')), h('small', {}, t.status)),
      h('div.ar-chart', {}, curve(t.curve, c) as unknown as Node, h('span.ar-chart-tag', {}, t.gen > 1 ? `account ${t.gen}` : 'start')),
      h('div.ar-call', {},
        h('div.ar-call-head', {}, h('span', {}, 'LAST CALL'), h('span', {}, t.last ? `${t.last.model === 'house' ? 'house' : t.last.model === 'none' ? 'no answer' : t.last.model.replace('claude-', '').replace(/-\d{8}$/, '')}${t.last.ms ? ` · ${t.last.ms} ms` : ''}` : '')),
        t.last ? probBars(t.last.probs, t.last.pick, c) : h('small', {}, 'Nothing put to the brain yet'),
        t.last ? h('small.ar-call-note', { 'data-by': t.last.by }, t.last.note) : null),
      h('div.ar-meter', {}, h('span', {}, 'Trades today'), h('span', {}, `${t.tradesToday} / ${t.tradeCap}`), h('div', {}, h('i', { style: `width:${Math.min(100, (t.tradesToday / Math.max(1, t.tradeCap)) * 100)}%` }))),
      h('button.ar-rules', { type: 'button', title: 'Its rules: open to edit, undo a rewrite, or let it go', onclick: () => { open = t.def.id; setSheet(traderSheet()); } }, h('span', {}, t.rulesBy === 'coach' ? 'RULES · REWRITTEN BY THE DESK HEAD' : 'ITS RULES'), h('p', {}, t.def.rules)),
      h('footer.ar-col-foot', {},
        h('div', {}, h('span', {}, 'FEES'), h('b', {}, usd(t.totals.fees, 2))),
        h('div', {}, h('span', {}, 'W / L'), h('b', {}, `${t.totals.wins} / ${t.totals.losses}`)),
        h('div', {}, h('span', {}, 'CALLS'), h('b', {}, t.totals.asked.toLocaleString('en-US'))),
        fut ? h('div', {}, h('span', {}, 'PASSED · BUST'), h('b', {}, `${t.passes} · ${t.busts}`)) : h('div', {}, h('span', {}, 'RESTARTS'), h('b', {}, String(t.busts)))));
  }

  function streamRow(d: Decision): HTMLElement {
    const fresh = d.seq > seen;
    const moved = d.did === 'open' || d.did === 'close' || d.did === 'stop' || d.did === 'trim';
    return h('div.ar-dec', { style: `--c:${d.color}`, 'data-new': fresh ? '1' : undefined, 'data-did': d.did, 'data-by': d.by },
      h('div.ar-dec-top', {}, h('i'), h('b', {}, d.name.split(' ')[0]!), h('span.ar-dec-pick', {}, d.pick), h('span.grow'),
        d.pnl != null ? h('span', { 'data-tone': tone(d.pnl) }, signed(d.pnl, league === 'crypto' ? 2 : 0)) : d.upl ? h('span', { 'data-tone': tone(d.upl) }, signed(d.upl, league === 'crypto' ? 2 : 0)) : null,
        d.by === 'brain' && d.probs[0] ? h('span.dim', {}, `${Math.round(d.probs[0][1] * 100)}%`) : null,
        h('span.dim', {}, barClock(league, d.ts))),
      d.by === 'brain' && d.probs.length > 1 ? h('div.ar-dec-bars', {}, ...d.probs.slice(0, 3).map(([label, p]) => h('span', { 'data-pick': label === d.pick ? '1' : undefined, style: `flex:${Math.max(0.12, p)}`, title: `${label} ${Math.round(p * 100)}%` }, label))) : null,
      d.note && (moved || d.by !== 'brain' || d.did === 'veto') ? h('small', {}, d.by === 'rules' ? h('em', {}, 'RULES ') : d.by === 'risk' ? h('em.bad', {}, 'RISK DESK ') : null, d.note) : null);
  }

  function coachCard(v: ArenaView): HTMLElement {
    const last = v.coach.rounds.at(-1);
    const b = v.brain;
    return h('section.ar-card.ar-coach', {},
      h('div.ar-coach-head', {}, h('div.ar-coach-face', {}, portrait('The Desk Head', '#ff8a4c', 44) as unknown as Node), h('div', {}, h('h4', {}, 'THE DESK HEAD'), h('small', {}, `checks every trader ${v.coach.every} · ${v.coach.rewrites} ${v.coach.rewrites === 1 ? 'rewrite' : 'rewrites'} so far`)), h('button.ar-btn', { type: 'button', title: 'Have him look now', onclick: () => void post({ action: 'coach' }) }, 'Call him')),
      last
        ? h('blockquote', { 'data-kind': last.kind }, `“${last.quote}”`, h('small', {}, last.kind === 'rewrite' ? `Rewrote ${last.name}` : last.kind === 'undo' ? `Undone on ${last.name}` : 'Hands off', ' · ', tapeClock(league, last.at)))
        : h('blockquote', {}, '“Let them trade a few sessions. Then we talk.”', h('small', {}, 'No round yet')),
      ...v.coach.rounds.slice(-4, -1).reverse().map((r) => h('p.ar-coach-old', { title: r.detail }, r.quote)),
      h('small.ar-coach-fine', {}, 'He can change a trader’s rules and nothing else: never size, stops or limits. Every rewrite can be undone.'),
      h('div.ar-powered', {}, b.kind !== 'house' ? powered(b) : h('span', {}, 'House rules, no model. ', h('button', { type: 'button', onclick: () => setSheet(brainSheet()) }, 'Put a model on the desk ›'))));
  }

  function drawFloor(v: ArenaView): Node[] {
    const ranked = [...v.traders].sort((a, b) => a.rank - b.rank);
    const fut = league === 'futures';
    const banner = v.banners.at(-1);
    const right = h('aside.ar-rail', {},
      coachCard(v),
      h('section.ar-card', {}, h('div.ar-card-head', {}, h('h4', {}, 'LEADERBOARD'), h('small', {}, fut ? 'equity' : 'gain')),
        ...ranked.map((t) => h('div.ar-lb', { style: `--c:${t.def.color}` }, h('span', {}, String(t.rank)), portrait(t.def.name, t.def.color, 26) as unknown as Node, h('b', {}, t.def.name), h('div', {}, h('i', { style: `width:${Math.max(4, Math.min(100, 50 + (fut ? (t.pnl / v.rules.drawdown) * 50 : t.pnlPct * 5)))}%` })), h('span', { 'data-tone': tone(t.pnl) }, fut ? signed(t.pnl) : pctText(t.pnlPct))))),
      h('section.ar-card.ar-stream', {}, h('div.ar-card-head', {}, h('h4', {}, 'DECISION STREAM'), h('small', {}, `${v.totals.perMin}/min`)),
        banner ? h('div.ar-banner', { 'data-kind': banner.kind }, banner.text) : null,
        h('div.ar-stream-list', {}, ...[...v.decisions].reverse().slice(0, 40).map(streamRow)),
        v.decisions.length ? null : h('small', {}, v.tape.playing ? 'Waiting for the first decision' : 'The tape is paused')),
      h('section.ar-card', {}, h('div.ar-card-head', {}, h('h4', {}, 'RISK DESK SAYS NO')), v.vetoes.length ? h('div.ar-vetoes', {}, ...[...v.vetoes].reverse().slice(0, 3).map((x) => h('p', {}, h('b', {}, `${x.name.split(' ')[0]} · ${x.label}`), ` ${x.why}`))) : h('small', {}, 'Nothing refused yet. It sizes every entry and can refuse one.')));
    return [h('div.ar-floor', {}, h('div.ar-cols', { 'data-n': String(v.traders.length) }, ...v.traders.map((t) => column(v, t))), right)];
  }

  // ---- Leaderboard, engine wars, graveyard ------------------------------------------------------------------
  function drawBoard(v: ArenaView): Node[] {
    const fut = league === 'futures';
    const ranked = [...v.traders].sort((a, b) => a.rank - b.rank);
    return [h('section.ar-panel', {},
      h('div.ar-panel-head', {}, h('h3', {}, 'Leaderboard'), h('small', {}, `Every trader on this floor. ${fut ? 'Dollars on the evaluation.' : 'Per cent on the bankroll.'} Open one to read its rules and copy them into a new trader.`)),
      h('div.ar-table', {}, h('div.ar-tr.head', {}, h('span', {}, '#'), h('span', {}, 'TRADER'), h('span', {}, 'ENGINE'), h('span.r', {}, 'P&L'), h('span.r', {}, 'TODAY'), h('span.r', {}, 'TRADES'), h('span.r', {}, 'W / L')),
        ...ranked.flatMap((t) => {
          const isOpen = open === t.def.id;
          const row = h('button.ar-tr', { type: 'button', 'aria-expanded': String(isOpen), style: `--c:${t.def.color}`, onclick: () => { open = isOpen ? null : t.def.id; draw(); } },
            h('span', {}, String(t.rank)), h('span.ar-td-who', {}, portrait(t.def.name, t.def.color, 30) as unknown as Node, h('b', {}, t.def.name), h('small', {}, t.def.tagline)),
            h('span', {}, h('span.ar-chips', {}, ...t.def.markets.map((m) => h('i', {}, m))), h('small', { style: `color:${ENGINES[t.def.engine].color}` }, ENGINES[t.def.engine].name)),
            h('span.r', { 'data-tone': tone(t.pnl) }, fut ? signed(t.pnl) : pctText(t.pnlPct)), h('span.r', { 'data-tone': tone(t.today) }, signed(t.today, fut ? 0 : 2)), h('span.r', {}, String(t.totals.orders)), h('span.r', {}, `${t.totals.wins} / ${t.totals.losses}`));
          return isOpen ? [row, h('div.ar-tr-open', {}, h('div', {}, h('span', {}, 'ITS RULES'), h('p', {}, t.def.rules)), h('div', {}, h('span', {}, 'MARKETS'), h('span.ar-chips', {}, ...t.def.markets.map((m) => h('i', {}, m))), h('small', {}, 'on the ', h('b', { style: `color:${ENGINES[t.def.engine].color}` }, ENGINES[t.def.engine].name), ' engine'), h('button.ar-btn.primary', { type: 'button', onclick: () => { design.sentence = t.def.rules; design.draft = null; tab = 'design'; draw(); } }, 'Copy rules')))] : [row];
        })))];
  }

  function drawWars(v: ArenaView): Node[] {
    const fut = league === 'futures';
    const ran = v.engines.filter((e) => e.traders > 0);
    const top = [...ran].sort((a, b) => b.avg - a.avg)[0];
    const fmt = (x: number) => (fut ? signed(x) : pctText(x));
    return [h('section.ar-panel', {},
      h('div.ar-panel-head', {}, h('h3', {}, 'Engine wars'), h('small', {}, fut ? 'Every futures trader runs its own rules on one of your playbooks. Which playbook is winning? Each number is the average over every account that engine has run here, the ended ones included.' : 'Every crypto trader runs its own rules on one of three engines. Which engine is winning?')),
      h('div.ar-wars', {}, ...v.engines.map((e) => h('div.ar-war', { style: `--c:${ENGINES[e.engine].color}`, 'data-win': top && e.engine === top.engine ? '1' : undefined, 'data-empty': e.traders ? undefined : '1' },
        h('span', {}, top && e.engine === top.engine ? 'WINNING ENGINE' : 'ENGINE'),
        h('h4', {}, ENGINES[e.engine].name),
        e.traders ? h('b', { 'data-tone': tone(e.avg) }, fmt(e.avg)) : h('b.dim', {}, '—'),
        h('small', {}, e.traders ? `average of ${e.traders} ${e.traders === 1 ? 'account' : 'accounts'}` : 'nobody runs it yet'),
        e.best ? h('div.ar-war-best', {}, h('span', {}, 'BEST'), portrait(e.best.name, e.best.color, 24) as unknown as Node, h('b', {}, e.best.name), h('em', { 'data-tone': tone(e.best.score) }, fmt(e.best.score))) : h('button.ar-btn', { type: 'button', onclick: () => { design.sentence = `A trader on the ${ENGINES[e.engine].name} ${fut ? 'playbook' : 'engine'}`; design.draft = null; tab = 'design'; draw(); } }, 'Design one ›'),
        h('p', {}, ENGINES[e.engine].blurb)))))];
  }

  // ---- Research ------------------------------------------------------------------------------------------------
  async function loadLab(l: League) {
    labs[l] = 'loading';
    try {
      const res = await fetch(`/api/trading/arena/lab?league=${l}`, { credentials: 'same-origin' });
      const j = (await res.json()) as LabView & { error?: string };
      labs[l] = res.ok ? j : { error: j.error ?? 'The research could not be run' };
    } catch {
      labs[l] = { error: 'The office is not answering' };
    }
    draw();
  }

  function drawLab(v: ArenaView): Node[] {
    const fut = league === 'futures';
    const lab = labs[league];
    if (!lab) void loadLab(league);
    const d = fut ? 0 : 2;
    let grid: HTMLElement;
    if (!lab || lab === 'loading') grid = h('p.ar-empty', {}, fut ? 'Replaying the month for every playbook on every market…' : 'Fetching a day of candles and replaying it for every engine…');
    else if ('error' in lab) grid = h('p.ar-empty', {}, lab.error, ' ', h('button.ar-btn', { type: 'button', onclick: () => void loadLab(league) }, 'Try again'));
    else {
      const markets = marketsOf(league);
      const peak = Math.max(1, ...lab.cells.map((c) => Math.abs(c.net)));
      grid = h('div.ar-edge', { style: `--cols:${markets.length}` },
        h('span'), ...markets.map((m) => h('span.ar-edge-head', {}, m, h('small', {}, MARKET_BY_ID[m]!.name))),
        ...enginesOf(league).flatMap((e) => [
          h('span.ar-edge-row', { style: `color:${ENGINES[e].color}` }, ENGINES[e].name),
          ...markets.map((m) => {
            const c = lab.cells.find((x) => x.engine === e && x.market === m);
            if (!c || !c.trades) return h('span.ar-edge-cell.none', {}, '—', h('small', {}, 'no trades'));
            const heat = Math.round((Math.abs(c.net) / peak) * 34);
            return h('button.ar-edge-cell', { type: 'button', title: 'Design a trader on this', style: `background:color-mix(in srgb, ${c.net >= 0 ? 'var(--up)' : 'var(--down)'} ${heat}%, var(--panel))`, onclick: () => { design.sentence = `A trader on the ${ENGINES[e].name} ${fut ? 'playbook' : 'engine'}, only ${m}`; design.draft = null; design.report = null; tab = 'design'; draw(); } },
              h('b', { 'data-tone': tone(c.net) }, signed(c.net, d)), h('small', {}, `${c.trades} trades · ${Math.round((c.wins / c.trades) * 100)}% won`));
          }),
        ]));
    }
    const run = async (id: string) => {
      bench.id = id;
      bench.busy = true;
      bench.report = null;
      draw();
      const r = await post({ action: 'backtest', id });
      bench.busy = false;
      bench.report = r.report ?? null;
      draw();
    };
    return [h('section.ar-panel', {},
      ...(fut ? [h('div.ar-panel-head', {}, h('div', {}, h('h3', {}, 'Strategy Workbench'), h('small', {}, 'Import longer chart history, test VWAP-led improvements on unfamiliar sessions, and compare prop firms after costs.')), h('button.ar-btn', { type: 'button', onclick: openResearchWorkbench }, 'Open Strategy Workbench ↗'))] : []),
      h('div.ar-panel-head', {}, h('h3', {}, 'Where the edge is'), h('small', {}, `${fut ? 'Every playbook on every market, over the recorded month' : 'Every engine on every coin, over the last day'}: one plain trader each, the house brain, this league’s account rules and fees. ${lab && lab !== 'loading' && !('error' in lab) ? `Replayed on ${lab.span}. ` : ''}Click a cell to design a trader on it.`)),
      grid,
      h('div.ar-panel-head', {}, h('h3', {}, 'Backtest a trader'), h('small', {}, `Replay the same tape with one of the traders on the floor, exactly as it is set up now. To try a change first, open a trader’s rules and backtest them there; a new design can be backtested before it starts.`)),
      h('div.ar-row', {}, ...v.traders.map((t) => h('button.ar-pick', { type: 'button', style: `--c:${t.def.color}`, 'aria-pressed': String(bench.id === t.def.id), disabled: bench.busy, onclick: () => void run(t.def.id) }, portrait(t.def.name, t.def.color, 30) as unknown as Node, h('span', {}, h('b', {}, t.def.name), h('small', {}, ENGINES[t.def.engine].name))))),
      bench.busy ? h('p.ar-empty', {}, 'Replaying the tape…') : bench.report ? reportCard(bench.report, league) : null)];
  }

  function drawGraveyard(v: ArenaView): Node[] {
    const fut = league === 'futures';
    const WORD = { passed: 'PASSED', busted: 'BUSTED', retired: 'RESTARTED', let_go: 'LET GO' } as const;
    return [h('section.ar-panel', {},
      h('div.ar-panel-head', {}, h('h3', {}, 'Graveyard'), h('small', {}, fut ? 'Every evaluation that ended: passed, hit the floor, or taken off the floor.' : 'Every bankroll that ended.')),
      v.fallen.length
        ? h('div.ar-table', {}, h('div.ar-tr.head.grave', {}, h('span', {}, 'TRADER'), h('span', {}, 'ENGINE'), h('span', {}, 'HOW IT ENDED'), h('span.r', {}, 'RESULT'), h('span.r', {}, 'WHEN')),
            ...[...v.fallen].reverse().map((f) => h('div.ar-tr.grave', { style: `--c:${f.color}` }, h('span.ar-td-who', {}, portrait(f.name, f.color, 30) as unknown as Node, h('b', {}, f.name), h('small', {}, `account ${f.gen}`)), h('span', { style: `color:${ENGINES[f.engine].color}` }, ENGINES[f.engine].name), h('span', {}, h('i.ar-end', { 'data-kind': f.kind }, WORD[f.kind]), h('small', {}, f.why)), h('span.r', { 'data-tone': tone(f.result) }, fut ? signed(f.result) : pctText(f.result)), h('span.r.dim', {}, tapeClock(league, f.at)))))
        : h('p.ar-empty', {}, 'Nobody has ended an account yet. Passes, busts and restarts land here.'))];
  }

  // ---- Design a trader ---------------------------------------------------------------------------------------
  function drawDesign(v: ArenaView): Node[] {
    const fut = league === 'futures';
    const d = design.draft;
    const text = h('textarea.ar-input', { rows: 3, maxlength: 400, placeholder: fut ? 'e.g. a patient sniper who only takes the first VWAP pullback on NQ, longs only, one trade a day' : 'e.g. a sleepy trader that only buys bitcoin dips, two trades a day', oninput: (e: Event) => (design.sentence = (e.target as HTMLTextAreaElement).value) }) as HTMLTextAreaElement;
    text.value = design.sentence;
    const create = async () => {
      design.busy = true;
      draw();
      const r = await post({ action: 'design', sentence: design.sentence, again: design.again++ });
      design.busy = false;
      if (r.draft) design.draft = r.draft;
      design.report = null;
      draw();
    };
    const full = v.traders.length >= 6;
    const left = h('div.ar-design-form', {},
      h('label', {}, 'How do you want this trader to trade?'), text,
      h('div.ar-row', {}, h('button.ar-btn.primary', { type: 'button', disabled: design.busy, onclick: () => void create() }, design.busy ? 'Designing…' : d ? 'Create again' : 'Create my trader'), h('small', {}, v.brain.kind !== 'house' ? `Designed by ${v.brain.label}.` : 'Designed by the house (it reads your sentence for keywords). Put a model on the desk for it to design the trader.')),
      h('div.ar-design-help', {}, h('span', {}, 'WHAT YOUR SENTENCE BECOMES'),
        h('p', {}, h('b', {}, 'An engine. '), fut ? 'One of your playbooks: ' : 'One of three: ', enginesOf(league).map((e) => ENGINES[e].name).join(', '), '.'),
        h('p', {}, h('b', {}, 'Markets. '), `Name any of ${marketsOf(league).join(', ')} and it only trades those.`),
        h('p', {}, h('b', {}, 'Rules the code enforces. '), '“longs only”, “shorts only”, “two trades a day”, “nothing in the first 30 minutes”, “no entries after 10:30”.'),
        h('p', {}, h('b', {}, 'Everything else '), 'steers the brain when it chooses among the moves on offer. It cannot invent a move, a size or a stop.')));
    const card = d
      ? h('div.ar-draft', { style: `--c:${ENGINES[d.engine].color}` },
          h('div.ar-draft-top', {}, portrait(d.name, ENGINES[d.engine].color, 96) as unknown as Node, h('div', {},
            (() => { const i = h('input.ar-input.name', { value: d.name, maxlength: 28, 'aria-label': 'Name', oninput: (e: Event) => { d.name = (e.target as HTMLInputElement).value; } }) as HTMLInputElement; i.addEventListener('change', () => draw()); return i; })(),
            h('input.ar-input', { value: d.tagline, maxlength: 48, 'aria-label': 'Tagline', oninput: (e: Event) => (d.tagline = (e.target as HTMLInputElement).value) }))),
          h('div.ar-draft-engine', {}, h('span.ar-chips', {}, ...d.markets.map((m) => h('i', {}, m))), h('small', {}, 'runs on '), h('select.ar-input', { 'aria-label': 'Engine', onchange: (e: Event) => { d.engine = (e.target as HTMLSelectElement).value as EngineId; draw(); } }, ...enginesOf(league).map((e) => h('option', { value: e, selected: e === d.engine }, ENGINES[e].name)))),
          (() => { const ta = h('textarea.ar-input', { rows: 4, maxlength: 320, 'aria-label': 'Rules', oninput: (e: Event) => (d.rules = (e.target as HTMLTextAreaElement).value) }) as HTMLTextAreaElement; ta.value = d.rules; return ta; })(),
          h('small', {}, `Designed by ${d.by}. Rename it or edit the rules before it starts.`),
          h('button.ar-btn', { type: 'button', disabled: design.testing, onclick: async () => { design.testing = true; draw(); const r = await post({ action: 'backtest', draft: d }); design.testing = false; design.report = r.report ?? null; draw(); } }, design.testing ? 'Replaying the tape…' : design.report ? 'Backtest it again' : `Backtest it first, on ${fut ? 'the recorded month' : 'the last day'}`),
          design.report ? reportCard(design.report, league) : null,
          h('button.ar-btn.primary.big', { type: 'button', disabled: full, title: full ? 'The floor holds six: let one go first' : '', onclick: async () => { const r = await post({ action: 'hire', draft: d, sentence: design.sentence }); if (r.ok) { design.draft = null; design.sentence = ''; tab = 'floor'; draw(); } } }, full ? 'The floor is full' : `Put ${d.name.split(' ')[0]} on the ${fut ? 'futures' : 'crypto'} floor`))
      : h('div.ar-draft.empty', {}, portrait('?', '#3a4666', 96) as unknown as Node, h('p', {}, 'Your trader appears here: a name, a face, an engine and its rules.'));
    return [h('section.ar-panel', {}, h('div.ar-panel-head', {}, h('h3', {}, 'Design a trader'), h('small', {}, `${v.traders.length} of 6 on the ${fut ? 'futures' : 'crypto'} floor. A new trader starts on a fresh ${fut ? 'evaluation' : 'bankroll'} at the tape’s next bar.`)), h('div.ar-design', {}, left, card))];
  }

  // ---- Sheets ------------------------------------------------------------------------------------------------
  function setSheet(node: HTMLElement | null) {
    sheet = node;
    over.replaceChildren(...(node ? [h('div.ar-sheet-card', {}, h('button.ar-x', { type: 'button', 'aria-label': 'Close', onclick: () => setSheet(null) }, '✕'), node)] : []));
    over.dataset.open = node ? '1' : '';
  }
  over.addEventListener('mousedown', (e) => {
    if (e.target === over) setSheet(null);
  });

  function traderSheet(): HTMLElement {
    const v = views[league]!;
    const t = v.traders.find((x) => x.def.id === open)!;
    const fut = league === 'futures';
    const ta = h('textarea.ar-input', { rows: 4, maxlength: 320 }) as HTMLTextAreaElement;
    ta.value = t.def.rules;
    const result = h('div');
    const test = async (e: Event) => {
      const btn = e.target as HTMLButtonElement;
      btn.disabled = true;
      btn.textContent = 'Replaying the tape…';
      const r = await post({ action: 'backtest', id: t.def.id, rules: ta.value });
      btn.disabled = false;
      btn.textContent = 'Backtest these rules';
      result.replaceChildren(...(r.report ? [reportCard(r.report, league)] : [h('small.bad', {}, note)]));
    };
    return h('div.ar-sheet-body', { style: `--c:${t.def.color}` },
      h('div.ar-draft-top', {}, portrait(t.def.name, t.def.color, 72) as unknown as Node, h('div', {}, h('h3', {}, t.def.name), h('small', {}, `${t.def.tagline} · ${ENGINES[t.def.engine].name} · ${t.def.markets.join(', ')}`))),
      h('label', {}, t.rulesBy === 'coach' ? 'Its rules, as the Desk Head rewrote them' : 'Its rules'), ta,
      h('div.ar-row', {},
        h('button.ar-btn.primary', { type: 'button', onclick: async () => { if ((await post({ action: 'rules', id: t.def.id, rules: ta.value })).ok) setSheet(null); } }, 'Save rules'),
        h('button.ar-btn', { type: 'button', title: 'Replay the tape with these rules before saving them', onclick: test }, 'Backtest these rules'),
        t.canUndo ? h('button.ar-btn', { type: 'button', onclick: async () => { if ((await post({ action: 'undo', id: t.def.id })).ok) setSheet(null); } }, 'Undo the rewrite') : null,
        h('span.grow'),
        h('button.ar-btn.danger', { type: 'button', onclick: async () => { if ((await post({ action: 'let_go', id: t.def.id })).ok) setSheet(null); } }, 'Let it go')),
      result,
      h('label', {}, 'Its last trades'),
      t.trades.length
        ? h('div.ar-table.small', {}, ...[...t.trades].reverse().map((x) => h('div.ar-tr.trade', {}, h('span', { 'data-tone': x.side === 'long' ? 'up' : 'down' }, x.side === 'long' ? '▲' : '▼'), h('b', {}, x.market), h('span', {}, `${price(x.market, x.entry)} → ${price(x.market, x.exit)}`), h('span.dim', {}, x.why), h('span.r', { 'data-tone': tone(x.pnl) }, signed(x.pnl, fut ? 0 : 2)), h('span.r.dim', {}, barClock(league, x.at)))))
        : h('small', {}, 'No closed trades yet.'));
  }

  function brainSheet(): HTMLElement {
    const b = views[league]?.brain;
    const select = h('select.ar-input', {}, ...MODELS.map(([id, label]) => h('option', { value: id, selected: id === b?.model }, `Claude ${label}`))) as HTMLSelectElement;
    const use = (kind: BrainView['kind'], name: string, model?: () => string) => async (e: Event) => {
      const btn = e.target as HTMLButtonElement;
      btn.disabled = true;
      btn.textContent = `Asking ${name} one test question…`;
      if ((await post({ action: 'brain', kind, model: model?.() })).ok) setSheet(null);
      else setSheet(brainSheet());
    };
    return h('div.ar-sheet-body', {},
      h('h3', {}, 'The brain'),
      h('p', {}, 'Every bar, code works out the moves each trader may make. When there is a real choice, a brain picks one. It only ever sees the menu: never a size, a stop or anything that could place an order. When it does not answer, the trader holds and opens nothing.'),
      h('div.ar-brain-opt', { 'data-on': b?.kind === 'house' ? '1' : undefined }, h('div', {}, h('b', {}, 'House brain'), h('small', {}, 'The engines’ own scores, no model. Free, instant, and the same every replay.')), h('button.ar-btn', { type: 'button', disabled: b?.kind === 'house', onclick: async () => { if ((await post({ action: 'brain', kind: 'house' })).ok) setSheet(null); } }, b?.kind === 'house' ? 'In use' : 'Use it')),
      h('div.ar-brain-opt', { 'data-on': b?.kind === 'claude' ? '1' : undefined }, h('div', {}, h('b', {}, 'Claude, on Claude Code'), h('small', {}, `A model reads each trader’s rules and the tape, and gives every move a probability. It also designs traders and writes the Desk Head’s rewrites. It uses this machine’s Claude Code sign-in and spends its usage: at most ${b?.callCap ?? 250} calls a day. The futures tape waits for each answer, so a replay runs slower.`), select),
        h('button.ar-btn.primary', { type: 'button', onclick: use('claude', 'Claude', () => select.value) }, b?.kind === 'claude' ? 'Switch model' : 'Switch on')),
      ...HARNESSES.map(([kind, name, what]) => h('div.ar-brain-opt', { 'data-on': b?.kind === kind ? '1' : undefined }, h('div', {}, h('b', {}, name), h('small', {}, `${what} It has to be installed and signed in on this machine; the office does not meter what it spends.`)), h('button.ar-btn', { type: 'button', disabled: b?.kind === kind, onclick: use(kind, name) }, b?.kind === kind ? 'In use' : 'Switch on'))),
      b?.error ? h('small', {}, `Last problem: ${b.error}`) : null,
      note ? h('small.bad', {}, note) : null);
  }

  // ---- Draw -----------------------------------------------------------------------------------------------------
  function draw() {
    const v = views[league];
    drawHead(v);
    // The design tab is only redrawn by its own actions: a stream tick must not eat what is being typed.
    const typing = tab === 'design' && shown === 'design' && main.contains(document.activeElement) && !!document.activeElement?.matches('input, textarea, select');
    if (!typing) {
      shown = tab;
      const keep = main.querySelector('.ar-stream-list')?.scrollTop ?? 0;
      main.replaceChildren(...(!v ? [h('p.ar-empty', {}, offline ? 'The office is not answering. Trying again.' : 'Opening the floor…')] : tab === 'floor' ? drawFloor(v) : tab === 'board' ? drawBoard(v) : tab === 'wars' ? drawWars(v) : tab === 'lab' ? drawLab(v) : tab === 'graveyard' ? drawGraveyard(v) : drawDesign(v)));
      const list = main.querySelector('.ar-stream-list');
      if (list && keep) list.scrollTop = keep;
    }
    if (v) seen = Math.max(seen, ...v.decisions.map((d) => d.seq));
    foot.replaceChildren(
      h('span', { 'data-tone': note || offline ? 'down' : undefined }, note || (offline ? 'The office is not answering: what is on screen is the last it sent.' : v ? `${v.tape.source}. Everything here is paper: nothing can place an order.` : '')),
      h('a.ar-credit', { href: BEEBOTS, target: '_blank', rel: 'noreferrer', title: 'The idea is beebots’: named bots, a menu of valid moves, a risk layer in plain code, a coach. MIT.' }, 'Inspired by ', h('b', {}, 'beebots'), ' by Mike of Creator Magic ↗'),
      h('span.grow'),
      ...(v?.markets ?? []).map((m) => h('span.ar-quote', {}, h('b', {}, m.id), ` ${price(m.id, m.last)} `, h('em', { 'data-tone': tone(m.changePct) }, `${m.changePct >= 0 ? '+' : '−'}${Math.abs(m.changePct).toFixed(2)}%`))));
    void sheet;
  }
  draw();

  return {
    close() {
      source?.close();
      clearTimeout(retry);
      root.remove();
    },
  };
}

/** The Arena in an office window. */
export function openArena(league?: League) {
  // Not the office's own modal frame: its paper header and footer styles would land on the console's.
  const host = h('div.ar-window');
  let handle: ArenaHandle | null = null;
  const modal = openModal(host, { closeButton: false, onClose: () => handle?.close(), doing: 'watching the Arena' });
  handle = mountArena(host, { league, onClose: () => modal.close() });
}
