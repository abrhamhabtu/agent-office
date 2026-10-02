import { h } from '../ui/dom';
import './lab.css';

// What the Back Office's two consoles (the Backtest Lab and the prop eval simulator) are both built from:
// the numbers' formats, the charts, the chips and the "how it works" sheet. They look like the wall
// screens they open from, so walking up to a board and opening it reads as leaning in, not as leaving.

export const TONE = { up: '#2ee6a6', down: '#ff5d73', warn: '#ffd166', info: '#5cc8ff', dim: '#8b98b8', faint: '#5c6a8c', text: '#e9eef8', line: '#24304f' } as const;

export const money = (v: number) => `${v < 0 ? '−' : ''}$${Math.abs(Math.round(v)).toLocaleString('en-US')}`;
export const signedMoney = (v: number) => `${v < 0 ? '−' : '+'}$${Math.abs(Math.round(v)).toLocaleString('en-US')}`;
export const fmtR = (v: number, d = 2) => `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(d)}R`;
export const pct = (v: number) => `${Math.round(v * 100)}%`;
export const toneOf = (v: number) => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat');
/** "2026-09-14" as "Mon Sep 14". */
export const dayLabel = (day: string) => {
  const d = new Date(`${day}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? day : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
};
export const shortDay = (day: string) => {
  const d = new Date(`${day}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? day : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
};

const NS = 'http://www.w3.org/2000/svg';
export function svg(tag: string, attrs: Record<string, string | number> = {}, ...kids: (SVGElement | string)[]): SVGElement {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const k of kids) el.append(k);
  return el;
}

/** Something remembered between visits (a selection, a setting); the console works without it. */
export function stored<T>(key: string, fallback: T): { get(): T; set(v: T): void } {
  return {
    get() {
      try {
        const raw = localStorage.getItem(key);
        return raw == null ? fallback : (JSON.parse(raw) as T);
      } catch {
        return fallback;
      }
    },
    set(v) {
      try {
        localStorage.setItem(key, JSON.stringify(v));
      } catch {
        /* Browser storage is unavailable. */
      }
    },
  };
}

// ---- Charts ------------------------------------------------------------------------------------------

export interface Series {
  values: (number | null)[];
  color: string;
  width?: number;
  dash?: string;
  /** Fill from the line down to the bottom of the plot (or up to the top). */
  area?: { fill: string; to: 'bottom' | 'top' };
  /** Hold each value until the next one, like a level that only moves at the close. */
  step?: boolean;
  /** A dot on point i, in this colour. */
  dot?: (i: number) => string | null;
  opacity?: number;
}

export interface ChartOpts {
  /** The drawing's height for a width of 1000: it scales with the window. */
  height: number;
  /** The drawing's own width (1000 unless set): a chart in half a row is drawn narrower so its lettering stays readable. */
  width?: number;
  /** How many points along the bottom. */
  n: number;
  series: Series[];
  bands?: { lo: number[]; hi: number[]; fill: string }[];
  /** Levels drawn right across, with a label at the right-hand end. */
  levels?: { y: number; color: string; label: string; dash?: string }[];
  xLabel: (i: number) => string;
  yFmt: (v: number) => string;
  /** What to say about point i when the pointer is over it. */
  tip?: (i: number) => (Node | string)[] | null;
  /** A flag planted on point i of the first series. */
  flags?: { i: number; label: string; color: string }[];
  label: string;
}

function niceTicks(lo: number, hi: number, want = 4): number[] {
  const span = hi - lo || 1;
  const raw = span / want;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

/** A line chart you can run the pointer along: it snaps to the nearest point and says what happened there. */
export function chart(o: ChartOpts): HTMLElement {
  const W = o.width ?? 1000;
  const H = o.height;
  const pad = { l: 64, r: 96, t: 14, b: 26 };
  const pw = W - pad.l - pad.r;
  const ph = H - pad.t - pad.b;
  const all: number[] = [];
  for (const s of o.series) for (const v of s.values) if (v != null && Number.isFinite(v)) all.push(v);
  for (const b of o.bands ?? []) all.push(...b.lo, ...b.hi);
  for (const l of o.levels ?? []) all.push(l.y);
  let lo = all.length ? Math.min(...all) : 0;
  let hi = all.length ? Math.max(...all) : 1;
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
  const m = (hi - lo) * 0.08;
  lo -= m;
  hi += m;
  const n = Math.max(2, o.n);
  const x = (i: number) => pad.l + (i / (n - 1)) * pw;
  const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * ph;
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': o.label, class: 'tl-chart-svg' });

  for (const t of niceTicks(lo, hi)) {
    root.append(svg('line', { x1: pad.l, x2: W - pad.r, y1: y(t), y2: y(t), stroke: TONE.line, 'stroke-width': 1 }));
    const label = svg('text', { x: pad.l - 10, y: y(t) + 4, 'text-anchor': 'end', class: 'tl-axis' });
    label.textContent = o.yFmt(t);
    root.append(label);
  }
  const every = Math.max(1, Math.ceil(n / (W < 700 ? 4 : 7)));
  for (let i = 0; i < n; i += every) {
    const label = svg('text', { x: x(i), y: H - 6, 'text-anchor': i === 0 ? 'start' : 'middle', class: 'tl-axis' });
    label.textContent = o.xLabel(i);
    root.append(label);
  }
  for (const b of o.bands ?? []) {
    const k = Math.min(b.lo.length, b.hi.length, n);
    if (k < 2) continue;
    const top = Array.from({ length: k }, (_, i) => `${x(i).toFixed(1)},${y(b.hi[i]!).toFixed(1)}`);
    const bottom = Array.from({ length: k }, (_, i) => `${x(k - 1 - i).toFixed(1)},${y(b.lo[k - 1 - i]!).toFixed(1)}`);
    root.append(svg('polygon', { points: [...top, ...bottom].join(' '), fill: b.fill }));
  }
  for (const s of o.series) {
    const pts: [number, number][] = [];
    s.values.forEach((v, i) => {
      if (v == null || !Number.isFinite(v) || i >= n) return;
      if (s.step && pts.length) pts.push([x(i), pts[pts.length - 1]![1]]);
      pts.push([x(i), y(v)]);
    });
    if (pts.length < 2) continue;
    const d = pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)} ${py.toFixed(1)}`).join(' ');
    if (s.area) {
      const edge = s.area.to === 'bottom' ? pad.t + ph : pad.t;
      root.append(svg('path', { d: `${d} L${pts[pts.length - 1]![0].toFixed(1)} ${edge} L${pts[0]![0].toFixed(1)} ${edge} Z`, fill: s.area.fill }));
    }
    root.append(svg('path', { d, fill: 'none', stroke: s.color, 'stroke-width': s.width ?? 2.5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', ...(s.dash ? { 'stroke-dasharray': s.dash } : {}), opacity: s.opacity ?? 1 }));
    if (s.dot)
      s.values.forEach((v, i) => {
        const c = v == null || i >= n ? null : s.dot!(i);
        if (c) root.append(svg('circle', { cx: x(i), cy: y(v!), r: 4, fill: c, stroke: '#0a0f1c', 'stroke-width': 1.5 }));
      });
  }
  for (const l of o.levels ?? []) {
    root.append(svg('line', { x1: pad.l, x2: W - pad.r, y1: y(l.y), y2: y(l.y), stroke: l.color, 'stroke-width': 1.5, 'stroke-dasharray': l.dash ?? '6 5' }));
    const t = svg('text', { x: W - pad.r + 8, y: y(l.y) + 4, class: 'tl-level', fill: l.color });
    t.textContent = l.label;
    root.append(t);
  }
  const main = o.series[0];
  for (const f of o.flags ?? []) {
    const v = main?.values[f.i];
    if (v == null) continue;
    const fx = x(f.i);
    const fy = y(v);
    const left = fx > W - pad.r - 130;
    root.append(svg('circle', { cx: fx, cy: fy, r: 7, fill: f.color, stroke: '#0a0f1c', 'stroke-width': 2 }));
    const t = svg('text', { x: fx + (left ? -12 : 12), y: fy - 10, 'text-anchor': left ? 'end' : 'start', class: 'tl-flag', fill: f.color });
    t.textContent = f.label;
    root.append(t);
  }

  const cross = svg('line', { y1: pad.t, y2: pad.t + ph, stroke: '#ffffff', 'stroke-width': 1, opacity: 0, 'stroke-dasharray': '3 4' });
  const dot = svg('circle', { r: 5, fill: '#fff', stroke: '#0a0f1c', 'stroke-width': 2, opacity: 0 });
  root.append(cross, dot);
  const tip = h('div.tl-tip', { role: 'status' });
  const wrap = h('div.tl-chart', {}, root as unknown as Node, tip);
  if (o.tip) {
    let shown = -1;
    const hide = () => {
      shown = -1;
      cross.setAttribute('opacity', '0');
      dot.setAttribute('opacity', '0');
      tip.classList.remove('on');
    };
    wrap.addEventListener('pointermove', (e) => {
      const box = (root as unknown as SVGSVGElement).getBoundingClientRect();
      const px = ((e.clientX - box.left) / box.width) * W;
      const i = Math.max(0, Math.min(n - 1, Math.round(((px - pad.l) / pw) * (n - 1))));
      if (i === shown) return;
      const body = o.tip!(i);
      if (!body) return hide();
      shown = i;
      cross.setAttribute('x1', String(x(i)));
      cross.setAttribute('x2', String(x(i)));
      cross.setAttribute('opacity', '.5');
      const v = main?.values[i];
      if (v != null) {
        dot.setAttribute('cx', String(x(i)));
        dot.setAttribute('cy', String(y(v)));
        dot.setAttribute('opacity', '1');
      } else dot.setAttribute('opacity', '0');
      tip.replaceChildren(...body);
      tip.classList.add('on');
      const frac = x(i) / W;
      tip.style.left = `${frac * 100}%`;
      tip.style.transform = `translateX(${frac > 0.6 ? 'calc(-100% - 14px)' : '14px'})`;
    });
    wrap.addEventListener('pointerleave', hide);
  }
  return wrap;
}

/** A row of bars around a zero line: a result per bucket (the half hour, the weekday). */
export function bars(items: { label: string; value: number; sub: string }[], fmt: (v: number) => string): HTMLElement {
  const max = Math.max(0.0001, ...items.map((i) => Math.abs(i.value)));
  return h('div.tl-bars', {}, ...items.map((it) => {
    const size = Math.round((Math.abs(it.value) / max) * 100);
    return h('div.tl-bar', { 'data-tone': toneOf(it.value), title: it.sub },
      h('span.tl-bar-v', {}, fmt(it.value)),
      h('span.tl-bar-track', {}, h('i', { style: `height:${Math.max(3, size / 2)}%;${it.value >= 0 ? 'bottom:50%' : 'top:50%'}` })),
      h('span.tl-bar-l', {}, it.label),
      h('span.tl-bar-s', {}, it.sub));
  }));
}

/** A tiny line for a card: the shape of a curve, nothing to read off it. */
export function spark(curve: number[], color: string, w = 120, hgt = 32): SVGElement {
  const el = svg('svg', { viewBox: `0 0 ${w} ${hgt}`, width: w, height: hgt, 'aria-hidden': 'true' });
  if (curve.length < 2) return el;
  const lo = Math.min(0, ...curve);
  const hi = Math.max(0, ...curve);
  const span = hi - lo || 1;
  const px = (i: number) => (i / (curve.length - 1)) * (w - 4) + 2;
  const py = (v: number) => hgt - 3 - ((v - lo) / span) * (hgt - 6);
  el.append(svg('line', { x1: 0, x2: w, y1: py(0), y2: py(0), stroke: TONE.faint, 'stroke-dasharray': '2 3', 'stroke-opacity': 0.6 }));
  el.append(svg('polyline', { points: curve.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' '), fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  return el;
}

// ---- Pieces --------------------------------------------------------------------------------------------

/** A choice you can switch on or off. */
export function chip(label: Node | string, on: boolean, onclick: () => void, opts: { color?: string; title?: string; kind?: string } = {}): HTMLElement {
  return h('button.tl-chip', { type: 'button', 'aria-pressed': String(on), title: opts.title, 'data-kind': opts.kind, style: opts.color ? `--c:${opts.color}` : undefined, onclick }, opts.color ? h('i.tl-chip-dot') : null, label);
}

/** One of a few choices side by side. */
export function segmented<T extends string>(options: { id: T; label: string }[], value: T, pick: (v: T) => void): HTMLElement {
  return h('div.tl-seg', { role: 'group' }, ...options.map((o) => h('button', { type: 'button', 'aria-pressed': String(o.id === value), onclick: () => pick(o.id) }, o.label)));
}

export function panel(title: string, sub: string | null, ...kids: (Node | null)[]): HTMLElement {
  return h('section.tl-panel', {}, h('div.tl-panel-head', {}, h('h3', {}, title), sub ? h('span', {}, sub) : null), ...kids.filter((k): k is Node => !!k));
}

export function stat(label: string, value: string, opts: { tone?: string; sub?: string; delta?: string; deltaTone?: string; big?: boolean } = {}): HTMLElement {
  return h('div.tl-stat', { 'data-big': opts.big ? '1' : undefined },
    h('span.tl-label', {}, label),
    h('b', { 'data-tone': opts.tone }, value),
    opts.delta ? h('span.tl-delta', { 'data-tone': opts.deltaTone }, opts.delta) : null,
    opts.sub ? h('small', {}, opts.sub) : null);
}

export interface HowStep {
  title: string;
  body: string;
  /** The real number this step produced on the last run. */
  fact?: string;
}

/** "How it works": the steps a console takes, in order, each with the real number it produced. */
export function howSheet(title: string, lead: string, steps: HowStep[], caveats: string[], onClose: () => void): HTMLElement {
  return h('div.tl-how', { role: 'region', 'aria-label': title },
    h('div.tl-how-head', {}, h('div', {}, h('span.tl-kicker', {}, 'HOW IT WORKS'), h('h3', {}, title)), h('button.tl-btn', { type: 'button', onclick: onClose }, 'Back to the numbers')),
    h('p.tl-how-lead', {}, lead),
    h('ol.tl-how-steps', {}, ...steps.map((s, i) => h('li', {}, h('span.tl-how-n', {}, String(i + 1)), h('div', {}, h('b', {}, s.title), h('p', {}, s.body), s.fact ? h('span.tl-how-fact', {}, s.fact) : null)))),
    h('div.tl-how-caveats', {}, h('span.tl-kicker', {}, 'WHAT IT CAN’T TELL YOU'), h('ul', {}, ...caveats.map((c) => h('li', {}, c)))));
}
