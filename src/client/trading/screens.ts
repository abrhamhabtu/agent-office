import * as THREE from 'three';
import { dataFreshness, marketTime } from '../../shared/freshness';
import type { AccountState, Bar, FloorRole, Levels, NewsItem, PlaybookId, Proposal, Quote, Symbol, TradingSnapshot } from '../../shared/trading';
import { INSTRUMENTS, PLAYBOOK_BY_ID, PLAYBOOKS, PROP_ACCOUNTS, SYMBOLS } from '../../shared/trading';

// Every screen and board on the trading floors: canvases drawn from one snapshot, the way a desk's
// monitors all read the same tape. Dark terminal cards on the office's warm walls.

export const INK = { bg: '#0f1522', panel: '#18213a', panel2: '#1f2a47', line: '#2a3656', text: '#e8edf5', dim: '#8391ad', up: '#2ee6a6', down: '#ff5d73', warn: '#ffd166', info: '#5cc8ff', violet: '#b794f4' };
const SANS = 'Nunito, ui-rounded, system-ui, sans-serif';
const MONO = 'ui-monospace, Menlo, Consolas, monospace';

export const fmt = (v: number | null | undefined, decimals = 2) => (v == null || !Number.isFinite(v) ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }));
const sign = (v: number) => (v > 0 ? '+' : v < 0 ? '−' : '');
export const pct = (v: number) => `${sign(v)}${Math.abs(v).toFixed(2)}%`;
export const money = (v: number) => `${v < 0 ? '−' : ''}$${Math.abs(Math.round(v)).toLocaleString('en-US')}`;
const tone = (v: number) => (v >= 0 ? INK.up : INK.down);
export const STAGE_COLOR: Record<string, string> = { live: INK.info, ready: INK.warn, won: INK.up, lost: INK.down, closed: INK.dim, watching: '#5d6b8f', done: INK.dim, failed: INK.down, off: '#3b4768' };
export const STAGE_LABEL: Record<string, string> = { live: '● IN TRADE', ready: '● AT THE LEVEL', won: '✓ TARGET', lost: '✗ STOPPED', closed: 'FLAT', watching: 'WATCHING', done: 'DONE TODAY', failed: 'FAILED', off: 'OFF HOURS' };

function rr(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}

export function clip(g: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (g.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && g.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t}…`;
}

function pill(g: CanvasRenderingContext2D, x: number, y: number, text: string, bg: string, fg = INK.bg, size = 18) {
  g.font = `900 ${size}px ${SANS}`;
  const w = g.measureText(text).width + size * 1.1;
  g.fillStyle = bg;
  rr(g, x, y, w, size * 1.6, size * 0.5);
  g.fill();
  g.fillStyle = fg;
  g.fillText(text, x + size * 0.55, y + size * 1.17);
  return w;
}

function texture(w: number, h: number) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return { canvas, g: canvas.getContext('2d')!, tex };
}

const quoteOf = (s: TradingSnapshot, sym: Symbol) => s.quotes.find((q) => q.symbol === sym);
const age = (ts: number, now: number) => {
  const m = Math.max(0, Math.round((now - ts) / 60_000));
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};
export const accountLabel = (id: string) => PROP_ACCOUNTS.find((a) => a.id === id)?.program ?? id;
const shortAccount = (id: string) => {
  const a = PROP_ACCOUNTS.find((x) => x.id === id);
  return a ? `${a.firm} ${a.size / 1000}K` : id;
};

/** A screen: a canvas texture and how to redraw it from a snapshot. */
export abstract class Screen {
  readonly texture: THREE.CanvasTexture;
  protected canvas: HTMLCanvasElement;
  protected g: CanvasRenderingContext2D;
  /** The same live canvas used by the 3D texture, for a readable close-up. */
  get element(): HTMLCanvasElement { return this.canvas; }
  constructor(
    protected W: number,
    protected H: number,
  ) {
    const t = texture(W, H);
    this.canvas = t.canvas;
    this.g = t.g;
    this.texture = t.tex;
  }
  abstract draw(s: TradingSnapshot, role: FloorRole, now: number): void;
  render(s: TradingSnapshot | null, role: FloorRole) {
    const g = this.g;
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    if (!s || !s.ready) this.waiting(s);
    else this.draw(s, role, Date.now());
    this.texture.needsUpdate = true;
  }
  private waiting(s: TradingSnapshot | null) {
    const g = this.g;
    g.fillStyle = INK.bg;
    g.fillRect(0, 0, this.W, this.H);
    g.fillStyle = INK.dim;
    g.textAlign = 'center';
    g.font = `900 ${Math.round(this.H * 0.07)}px ${SANS}`;
    g.fillText('Connecting to the market…', this.W / 2, this.H / 2);
    g.font = `700 ${Math.round(this.H * 0.04)}px ${SANS}`;
    g.fillText(s ? 'Waiting for the first real prices' : 'Reaching the office', this.W / 2, this.H / 2 + this.H * 0.08);
    g.textAlign = 'left';
  }
  protected header(title: string, right: string, s: TradingSnapshot, accent = INK.warn) {
    const g = this.g;
    g.fillStyle = INK.bg;
    g.fillRect(0, 0, this.W, this.H);
    g.fillStyle = INK.panel;
    g.fillRect(0, 0, this.W, 78);
    g.fillStyle = accent;
    g.fillRect(0, 74, this.W, 4);
    g.fillStyle = INK.text;
    g.font = `900 40px ${SANS}`;
    g.fillText(title, 28, 52);
    g.textAlign = 'right';
    g.fillStyle = INK.dim;
    g.font = `800 24px ${MONO}`;
    g.fillText(`${right}${right ? '  ·  ' : ''}${s.session.time.slice(0, 5)} PT`, this.W - 28, 50);
    g.textAlign = 'left';
  }
  protected empty(line1: string, line2: string) {
    const g = this.g;
    g.fillStyle = INK.dim;
    g.textAlign = 'center';
    g.font = `900 38px ${SANS}`;
    g.fillText(line1, this.W / 2, this.H / 2 + 10);
    g.font = `700 24px ${SANS}`;
    g.fillText(line2, this.W / 2, this.H / 2 + 52);
    g.textAlign = 'left';
  }
}

// ---- Charts ------------------------------------------------------------------------------------------

export interface ChartOpts {
  vwap?: boolean;
  onVwap?: boolean;
  or?: boolean;
  prior?: boolean;
  value?: boolean;
  zones?: boolean;
  sr?: boolean;
  profile?: boolean;
  grid?: boolean;
  tag?: boolean;
  /** Draw the three-line source clocks under the candles (default). Boards with their own line turn it off. */
  footer?: boolean;
  plan?: Proposal | null;
}

/** Source clocks remain visible even when the chart or terminal is still waiting. */
export function drawFreshness(g: CanvasRenderingContext2D, x: number, y: number, w: number, q: Quote | undefined, barAt: number | null, now: number, size = 11, barSource = q?.barSource ?? 'Yahoo') {
  const f = dataFreshness(q, now, barAt, barSource);
  g.save();
  g.globalAlpha = 1;
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  g.font = `700 ${size}px ${MONO}`;
  g.fillStyle = f.tone === 'ok' ? INK.up : f.tone === 'stop' ? INK.down : INK.warn;
  g.fillText(`${f.source} · ${f.status}`, x, y, w);
  g.fillStyle = INK.dim;
  g.fillText(`Quote ${marketTime(q?.updatedAt)} · ${f.quoteStatus}`, x, y + size + 3, w);
  g.fillText(`${f.barSource} bars ${marketTime(barAt)} · ${f.barStatus}`, x, y + (size + 3) * 2, w);
  g.restore();
}

/** Candles and whichever of the day's levels the playbook reads, scaled to what's on screen. */
export function drawChart(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, bars: Bar[], q: Quote, lv: Levels | null, opts: ChartOpts = {}) {
  if (opts.footer !== false) {
    const fsFoot = Math.min(13, Math.max(10, w / 48));
    const footer = (fsFoot + 3) * 3 + 4;
    drawFreshness(g, x + 4, y + h - footer + fsFoot, w - 8, q, bars.at(-1)?.ts ?? null, Date.now(), fsFoot);
    h -= footer;
  }
  if (!bars.length) return;
  let lo = Math.min(...bars.map((b) => b.low));
  let hi = Math.max(...bars.map((b) => b.high));
  const near: number[] = [];
  if (lv) {
    if (opts.vwap) near.push(...[lv.vwap, lv.vwapU1, lv.vwapL1].filter((v): v is number => v != null));
    if (opts.onVwap && lv.onVwap != null) near.push(lv.onVwap);
    if (opts.or) near.push(...[lv.orHigh, lv.orLow].filter((v): v is number => v != null));
    if (opts.value) near.push(...[lv.vah, lv.poc, lv.val].filter((v): v is number => v != null));
    if (opts.sr) near.push(...lv.sr.map((l) => l.price));
  }
  if (opts.plan) near.push(...[opts.plan.entry, opts.plan.stop, opts.plan.target].filter((v): v is number => v != null));
  // Levels only count when they're near the tape; a far level shouldn't squash the candles.
  const pad = (hi - lo) * 0.5;
  for (const v of near) if (v > lo - pad && v < hi + pad) ((lo = Math.min(lo, v)), (hi = Math.max(hi, v)));
  const span = hi - lo || q.tick * 4;
  lo -= span * 0.06;
  hi += span * 0.06;
  const py = (v: number) => y + h - ((v - lo) / (hi - lo)) * h;
  const tagW = opts.tag ? Math.min(150, w * 0.18) : 0;
  const plotW = w - tagW;
  const cw = plotW / bars.length;
  const fs = Math.max(11, Math.min(20, h * 0.055));
  g.save();
  g.beginPath();
  g.rect(x, y, w, h);
  g.clip();
  if (opts.grid) {
    g.strokeStyle = INK.line;
    g.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const gy = y + (h * i) / 4;
      g.beginPath();
      g.moveTo(x, gy);
      g.lineTo(x + plotW, gy);
      g.stroke();
    }
  }
  if (lv && opts.zones)
    for (const z of lv.zones) {
      if (z.bottom > hi || z.top < lo) continue;
      const since = bars.findIndex((b) => b.ts >= z.at);
      const x0 = since < 0 ? x : x + since * cw;
      g.fillStyle = z.kind === 'demand' ? `rgba(46,230,166,${z.state === 'fresh' ? 0.22 : 0.08})` : `rgba(255,93,115,${z.state === 'fresh' ? 0.22 : 0.08})`;
      g.fillRect(x0, py(z.top), x + plotW - x0, Math.max(3, py(z.bottom) - py(z.top)));
      g.fillStyle = z.kind === 'demand' ? INK.up : INK.down;
      g.font = `900 ${fs * 0.8}px ${SANS}`;
      g.fillText(`${z.kind === 'demand' ? 'DEMAND' : 'SUPPLY'}${z.state === 'fresh' ? '' : ' · tested'}`, x0 + 6, py(z.top) + fs * 0.9);
    }
  if (opts.profile && bars.length) {
    // A sideways volume profile of what's on screen, against the right edge.
    const bins = 40;
    const vol = new Array<number>(bins).fill(0);
    for (const b of bars) {
      const a = Math.floor(((b.low - lo) / (hi - lo)) * bins);
      const z = Math.floor(((b.high - lo) / (hi - lo)) * bins);
      for (let k = Math.max(0, a); k <= Math.min(bins - 1, z); k++) vol[k]! += b.volume / (z - a + 1);
    }
    const max = Math.max(...vol, 1);
    for (let k = 0; k < bins; k++) {
      const bw = (vol[k]! / max) * plotW * 0.28;
      g.fillStyle = 'rgba(183,148,244,.22)';
      g.fillRect(x + plotW - bw, y + h - ((k + 1) / bins) * h, bw, h / bins - 1);
    }
  }
  const line = (v: number | null | undefined, color: string, dash: number[] = [], label?: string, width = 2) => {
    if (v == null || v < lo || v > hi) return;
    g.strokeStyle = color;
    g.lineWidth = width;
    g.setLineDash(dash);
    g.beginPath();
    g.moveTo(x, py(v));
    g.lineTo(x + plotW, py(v));
    g.stroke();
    g.setLineDash([]);
    if (label) {
      g.fillStyle = color;
      g.font = `900 ${fs * 0.85}px ${MONO}`;
      g.fillText(label, x + 6, py(v) - 4);
    }
  };
  if (lv) {
    if (opts.prior) {
      line(lv.priorHigh, 'rgba(156,110,255,.7)', [3, 5], 'PDH');
      line(lv.priorLow, 'rgba(156,110,255,.7)', [3, 5], 'PDL');
    }
    if (opts.or) {
      line(lv.orHigh, 'rgba(92,200,255,.8)', [10, 4], 'ORH');
      line(lv.orLow, 'rgba(92,200,255,.8)', [10, 4], 'ORL');
    }
    if (opts.value) {
      line(lv.vah, 'rgba(241,91,181,.85)', [8, 5], 'VAH');
      line(lv.val, 'rgba(241,91,181,.85)', [8, 5], 'VAL');
      line(lv.poc, '#f15bb5', [], 'POC', 3);
    }
    if (opts.sr)
      for (const l of lv.sr) line(l.price, l.kind === 'support' ? 'rgba(46,230,166,.8)' : 'rgba(255,93,115,.8)', [12, 5], `${l.label.replace('Yesterday’s', 'PD').replace('Overnight', 'ON').replace('Tested level', `S/R ×${l.touches}`)}`, 2.5);
    if (opts.onVwap) line(lv.onVwap, 'rgba(255,159,90,.9)', [4, 4], 'ON VWAP');
    if (opts.vwap) {
      line(lv.vwapU1, 'rgba(255,209,102,.35)', [6, 6]);
      line(lv.vwapL1, 'rgba(255,209,102,.35)', [6, 6]);
      line(lv.vwap, INK.warn, [], 'VWAP', 3);
    }
  }
  const p = opts.plan;
  if (p && p.entry != null && p.stop != null && p.target != null) {
    const x0 = x + plotW * 0.72;
    g.fillStyle = 'rgba(46,230,166,.18)';
    g.fillRect(x0, Math.min(py(p.entry), py(p.target)), plotW - (x0 - x), Math.abs(py(p.target) - py(p.entry)));
    g.fillStyle = 'rgba(255,93,115,.18)';
    g.fillRect(x0, Math.min(py(p.entry), py(p.stop)), plotW - (x0 - x), Math.abs(py(p.stop) - py(p.entry)));
    line(p.entry, INK.text, [2, 3], undefined, 1.5);
  }
  const body = Math.max(1.5, cw * 0.62);
  bars.forEach((b, i) => {
    const cx = x + i * cw + cw / 2;
    const up = b.close >= b.open;
    g.strokeStyle = g.fillStyle = up ? INK.up : INK.down;
    g.lineWidth = Math.max(1, cw * 0.14);
    g.beginPath();
    g.moveTo(cx, py(b.high));
    g.lineTo(cx, py(b.low));
    g.stroke();
    const top = py(Math.max(b.open, b.close));
    g.fillRect(cx - body / 2, top, body, Math.max(1.5, Math.abs(py(b.open) - py(b.close))));
  });
  g.restore();
  if (opts.tag) {
    const last = bars[bars.length - 1]!.close;
    const ty = Math.min(y + h - 16, Math.max(y + 14, py(last)));
    g.fillStyle = tone(q.change);
    rr(g, x + plotW + 2, ty - 15, tagW - 4, 30, 6);
    g.fill();
    g.fillStyle = INK.bg;
    const label = fmt(last, q.decimals);
    g.font = `900 ${Math.max(9, Math.min(20, (tagW - 12) / (label.length * 0.62)))}px ${MONO}`;
    g.textAlign = 'center';
    g.fillText(label, x + plotW + tagW / 2, ty + 6);
    g.textAlign = 'left';
  }
}

/** Five-minute candles from ones, for the zone charts. */
export function fives(bars: Bar[]): Bar[] {
  const out: Bar[] = [];
  for (const b of bars) {
    const k = Math.floor(b.ts / 300_000) * 300_000;
    const last = out[out.length - 1];
    if (last && last.ts === k) {
      last.high = Math.max(last.high, b.high);
      last.low = Math.min(last.low, b.low);
      last.close = b.close;
      last.volume += b.volume;
    } else out.push({ ...b, ts: k });
  }
  return out;
}

export function sparkline(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, curve: number[], color?: string) {
  if (curve.length < 2) {
    g.strokeStyle = INK.line;
    g.beginPath();
    g.moveTo(x, y + h / 2);
    g.lineTo(x + w, y + h / 2);
    g.stroke();
    return;
  }
  const pts = [0, ...curve];
  const lo = Math.min(...pts);
  const hi = Math.max(...pts);
  const span = hi - lo || 1;
  const py = (v: number) => y + h - ((v - lo) / span) * h;
  g.strokeStyle = 'rgba(131,145,173,.4)';
  g.setLineDash([3, 4]);
  g.beginPath();
  g.moveTo(x, py(0));
  g.lineTo(x + w, py(0));
  g.stroke();
  g.setLineDash([]);
  g.strokeStyle = color ?? tone(pts[pts.length - 1]!);
  g.lineWidth = 3;
  g.beginPath();
  pts.forEach((v, i) => {
    const px = x + (i / (pts.length - 1)) * w;
    if (i) g.lineTo(px, py(v));
    else g.moveTo(px, py(v));
  });
  g.stroke();
}

const GUARD_INK = { ok: INK.up, warn: INK.warn, stop: INK.down } as const;

/** The risk guard's one line, as a bar: green clear, amber careful, red stand down (it pulses). */
export function guardBar(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, s: TradingSnapshot, now: number) {
  const gd = s.guard;
  const c = GUARD_INK[gd.level];
  const pulse = gd.level === 'stop' ? 0.18 + 0.12 * Math.sin(now / 260) : 0.16;
  g.fillStyle = gd.level === 'ok' ? `rgba(46,230,166,${pulse})` : gd.level === 'warn' ? `rgba(255,209,102,${pulse})` : `rgba(255,93,115,${pulse + 0.1})`;
  rr(g, x, y, w, h, h / 2);
  g.fill();
  g.strokeStyle = c;
  g.lineWidth = 2;
  g.stroke();
  g.fillStyle = c;
  g.font = `900 ${Math.round(h * 0.5)}px ${SANS}`;
  const icon = gd.level === 'ok' ? '🛡️' : gd.level === 'warn' ? '⚠️' : '⛔';
  g.fillText(clip(g, `${icon}  ${gd.headline}`, w - h * 1.2), x + h * 0.5, y + h * 0.68);
}

// ---- 📰 News & calendar ------------------------------------------------------------------------------

/** Word-wrap to at most `lines` lines, ellipsising the last one. */
function wrap(g: CanvasRenderingContext2D, text: string, maxW: number, lines: number): string[] {
  const out: string[] = [];
  let line = '';
  const words = text.split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const next = line ? `${line} ${words[i]}` : words[i]!;
    if (g.measureText(next).width <= maxW || !line) line = next;
    else {
      out.push(line);
      line = words[i]!;
      if (out.length === lines - 1) {
        line = words.slice(i).join(' ');
        break;
      }
    }
  }
  if (line) out.push(clip(g, line, maxW));
  return out;
}

const IMPACT_INK = { high: INK.down, med: INK.warn, low: INK.dim } as const;
const phaseLabel: Record<string, string> = { overnight: 'OVERNIGHT', premarket: 'PRE-MARKET', ORB: 'OPENING RANGE', morning: 'MORNING', midday: 'MIDDAY', close: 'INTO THE CLOSE', closed: 'MARKET CLOSED' };

/** The bar every modern board opens with: what this is, the market's state, the risk guard and the clock. */
function topBar(g: CanvasRenderingContext2D, W: number, title: string, sub: string, s: TradingSnapshot, accent: string) {
  g.fillStyle = INK.bg;
  g.fillRect(0, 0, W, 600);
  g.fillStyle = accent;
  rr(g, 24, 22, 6, 34, 3);
  g.fill();
  g.fillStyle = INK.text;
  g.font = `900 34px ${SANS}`;
  g.fillText(title, 44, 52);
  const tw = g.measureText(title).width;
  g.fillStyle = INK.dim;
  g.font = `700 19px ${SANS}`;
  g.fillText(sub, 44 + tw + 16, 51);
  // Right side, from the edge inwards: clock, risk guard, session phase.
  g.textAlign = 'right';
  g.fillStyle = INK.text;
  g.font = `800 24px ${MONO}`;
  g.fillText(s.session.time.slice(0, 5), W - 24, 50);
  const clockW = g.measureText(s.session.time.slice(0, 5)).width + 10;
  g.fillStyle = INK.dim;
  g.font = `800 13px ${SANS}`;
  g.fillText('PT', W - 24 - clockW + 6, 50);
  g.textAlign = 'left';
  const closed = s.session.phase === 'closed';
  const gc = GUARD_INK[s.guard.level];
  const chip = (label: string, ink: string, right: number) => {
    g.font = `900 14px ${SANS}`;
    const w = g.measureText(label).width + 34;
    g.fillStyle = ink + '22';
    rr(g, right - w, 26, w, 30, 15);
    g.fill();
    g.fillStyle = ink;
    g.beginPath();
    g.arc(right - w + 15, 41, 4, 0, Math.PI * 2);
    g.fill();
    g.fillText(label, right - w + 26, 46);
    return w;
  };
  const w1 = chip(s.guard.level === 'ok' ? 'RISK CLEAR' : s.guard.level === 'warn' ? 'CAREFUL' : 'STAND DOWN', gc, W - 24 - clockW - 40);
  chip(phaseLabel[s.session.phase] ?? s.session.phase.toUpperCase(), closed ? INK.dim : INK.info, W - 24 - clockW - 40 - w1 - 10);
}

/** A ring that fills as the moment gets closer. */
function ring(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, frac: number, ink: string) {
  g.lineWidth = 10;
  g.lineCap = 'round';
  g.strokeStyle = INK.panel2;
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.stroke();
  if (frac > 0.005) {
    g.strokeStyle = ink;
    g.beginPath();
    g.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, frac));
    g.stroke();
  }
  g.lineCap = 'butt';
}

const clock = (ms: number) => {
  const t = Math.max(0, Math.round(ms / 1000));
  return t >= 86400 ? `${Math.floor(t / 86400)}d ${Math.floor((t % 86400) / 3600)}h` : t >= 3600 ? `${Math.floor(t / 3600)}h ${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}m` : `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

export class NewsBoard extends Screen {
  constructor() {
    super(1200, 600);
  }
  draw(s: TradingSnapshot, _role: FloorRole, now: number) {
    const g = this.g;
    const cal = s.news.filter((n) => n.kind === 'calendar').sort((a, b) => a.at - b.at);
    const ahead = cal.filter((n) => n.at > now);
    const hero = ahead.find((n) => n.impact === 'high') ?? ahead[0] ?? null;
    const justOut = cal.filter((n) => n.at <= now && now - n.at < 45 * 60_000).slice(-1)[0] ?? null;
    topBar(g, this.W, 'News & calendar', `${s.markets.join(' · ')} in focus`, s, INK.info);
    this.hero(g, s, hero, ahead.filter((n) => n !== hero).slice(0, 3), justOut, now);
    this.wire(g, s, now);
  }

  private hero(g: CanvasRenderingContext2D, s: TradingSnapshot, n: NewsItem | null, then: NewsItem[], justOut: NewsItem | null, now: number) {
    const x = 24;
    const y = 82;
    const w = 548;
    const h = 496;
    g.fillStyle = INK.panel;
    rr(g, x, y, w, h, 20);
    g.fill();
    if (!n) {
      g.fillStyle = INK.dim;
      g.textAlign = 'center';
      g.font = `900 34px ${SANS}`;
      g.fillText('Calendar is clear', x + w / 2, y + h / 2 - 6);
      g.font = `700 20px ${SANS}`;
      g.fillText('Nothing scheduled for the rest of the week', x + w / 2, y + h / 2 + 30);
      g.textAlign = 'left';
      return;
    }
    const ink = IMPACT_INK[n.impact];
    const ms = n.at - now;
    g.fillStyle = ink + '2a';
    const tag = n.impact === 'high' ? 'NEXT HIGH IMPACT' : 'NEXT ON THE CALENDAR';
    g.font = `900 14px ${SANS}`;
    const tagW = g.measureText(tag).width + 30;
    rr(g, x + 28, y + 26, tagW, 28, 14);
    g.fill();
    g.fillStyle = ink;
    g.beginPath();
    g.arc(x + 42, y + 40, 4.5, 0, Math.PI * 2);
    g.fill();
    g.fillText(tag, x + 54, y + 45);
    // What it is, and when.
    g.fillStyle = INK.text;
    g.font = `900 36px ${SANS}`;
    const name = n.headline.split(' · ')[0]!;
    const lines = wrap(g, name, w - 56, 2);
    lines.forEach((l, i) => g.fillText(l, x + 28, y + 100 + i * 42));
    const top = y + 100 + (lines.length - 1) * 42;
    const [day, time] = n.time.includes(' ') ? n.time.split(' ') : ['Today', n.time];
    g.fillStyle = INK.dim;
    g.font = `800 19px ${MONO}`;
    g.fillText(`${day!.toUpperCase()} ${time} PT`, x + 28, top + 34);
    // The countdown in its ring.
    const cx = x + 28 + 88;
    const cy = top + 136;
    ring(g, cx, cy, 78, 1 - Math.min(ms, 6 * 3600_000) / (6 * 3600_000), ink);
    g.textAlign = 'center';
    g.fillStyle = INK.text;
    g.font = `900 ${clock(ms).length > 6 ? 30 : 38}px ${MONO}`;
    g.fillText(clock(ms), cx, cy + 10);
    g.fillStyle = INK.dim;
    g.font = `800 12px ${SANS}`;
    g.fillText(ms < 3600_000 ? 'MIN : SEC' : 'UNTIL RELEASE', cx, cy + 34);
    g.textAlign = 'left';
    // The numbers: what the room expects against what was.
    const stats: [string, string | undefined, string][] = [['ACTUAL', n.actual, INK.up], ['CONSENSUS', n.forecast, INK.text], ['PREVIOUS', n.previous, INK.dim]];
    const sx = x + 244;
    stats.forEach(([label, v, c], i) => {
      const sy = cy - 64 + i * 56;
      g.fillStyle = INK.dim;
      g.font = `800 13px ${SANS}`;
      g.fillText(label, sx, sy);
      g.fillStyle = v ? c : INK.line;
      g.font = `900 30px ${MONO}`;
      g.fillText(v ?? (label === 'ACTUAL' ? 'pending' : '—'), sx, sy + 30);
    });
    // Which of your markets care.
    const mine = n.symbols.filter((q) => s.markets.includes(q));
    const watch = mine.length ? mine : s.markets;
    let cxp = x + 28;
    const cyp = cy + 98;
    g.fillStyle = INK.dim;
    g.font = `800 13px ${SANS}`;
    g.fillText(mine.length ? 'MOVES' : 'WATCH', cxp, cyp + 19);
    cxp += 62;
    for (const sym of watch) cxp += pill(g, cxp, cyp, sym, INSTRUMENTS[sym].ink, INK.bg, 14) + 8;
    // What follows.
    const ty = cyp + 54;
    g.strokeStyle = INK.line;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(x + 28, ty - 12);
    g.lineTo(x + w - 28, ty - 12);
    g.stroke();
    const rows = then.length ? then : [];
    rows.forEach((t, i) => {
      const ry = ty + i * 28;
      g.fillStyle = IMPACT_INK[t.impact];
      g.beginPath();
      g.arc(x + 34, ry + 11, 5, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = INK.dim;
      g.font = `800 15px ${MONO}`;
      g.fillText(t.time.replace(' ', ' · '), x + 50, ry + 17);
      const tw = 128;
      g.fillStyle = INK.text;
      g.font = `800 17px ${SANS}`;
      g.fillText(clip(g, t.headline.split(' · ')[0]!, w - 50 - tw - 100), x + 50 + tw, ry + 17);
      g.textAlign = 'right';
      g.fillStyle = INK.dim;
      g.font = `800 15px ${MONO}`;
      g.fillText(clock(t.at - now), x + w - 28, ry + 17);
      g.textAlign = 'left';
    });
    if (justOut && !rows.length) {
      g.fillStyle = INK.dim;
      g.font = `800 17px ${SANS}`;
      g.fillText(`Just out: ${justOut.headline.split(' · ')[0]}`, x + 28, ty + 17);
    }
  }

  private wire(g: CanvasRenderingContext2D, s: TradingSnapshot, now: number) {
    const x = 596;
    const w = this.W - x - 24;
    g.fillStyle = INK.dim;
    g.font = `900 14px ${SANS}`;
    g.fillText('THE WIRE', x, 100);
    g.fillStyle = INK.info;
    g.font = `800 14px ${SANS}`;
    g.fillText('FILTERED TO YOUR MARKETS', x + 86, 100);
    const all = s.news.filter((n) => n.kind === 'headline').sort((a, b) => b.at - a.at);
    const mine = all.filter((n) => n.symbols.some((q) => s.markets.includes(q)));
    const rest = all.filter((n) => !mine.includes(n));
    const rows = [...mine, ...rest].slice(0, 5);
    const rh = 88;
    rows.forEach((n, i) => {
      const y = 116 + i * (rh + 8);
      const relevant = mine.includes(n);
      g.fillStyle = INK.panel;
      rr(g, x, y, w, rh, 16);
      g.fill();
      if (n.impact !== 'low') {
        g.fillStyle = IMPACT_INK[n.impact];
        rr(g, x, y + 16, 5, rh - 32, 2.5);
        g.fill();
      }
      g.fillStyle = relevant ? INK.text : INK.dim;
      g.font = `800 20px ${SANS}`;
      const lines = wrap(g, n.headline, w - 48, 2);
      lines.forEach((l, k) => g.fillText(l, x + 22, y + 32 + k * 25));
      g.font = `700 14px ${SANS}`;
      g.fillStyle = INK.dim;
      g.fillText(`${n.source} · ${age(n.at, now)} ago`, x + 22, y + rh - 12);
      let cxp = x + w - 16;
      // A tag only means something when the story is about some of your markets, not all of them.
      const syms = relevant ? n.symbols.filter((q) => s.markets.includes(q)) : [];
      if (syms.length >= s.markets.length) syms.length = 0;
      g.font = `900 13px ${MONO}`;
      if (!relevant) {
        g.textAlign = 'right';
        g.fillStyle = INK.line;
        g.fillText('MARKET-WIDE', cxp, y + rh - 12);
        g.textAlign = 'left';
      }
      for (const sym of [...syms].reverse()) {
        const tw = g.measureText(sym).width + 18;
        cxp -= tw;
        g.fillStyle = INSTRUMENTS[sym].ink + '33';
        rr(g, cxp, y + rh - 32, tw, 22, 11);
        g.fill();
        g.fillStyle = INSTRUMENTS[sym].ink;
        g.fillText(sym, cxp + 9, y + rh - 16);
        cxp -= 6;
      }
    });
    if (!rows.length) {
      g.fillStyle = INK.dim;
      g.font = `800 22px ${SANS}`;
      g.fillText('No headlines yet', x, 160);
    }
  }
}


// ---- 📋 The morning playbook: the checklist and the bias -------------------------------------------------
export class PlaybookBoard extends Screen {
  constructor() {
    super(1200, 600);
  }
  draw(s: TradingSnapshot, _role?: FloorRole, now = Date.now()) {
    const g = this.g;
    const done = s.playbook.filter((p) => p.done).length;
    const total = Math.max(1, s.playbook.length);
    topBar(g, this.W, 'Morning playbook', done === s.playbook.length ? 'ready to trade' : `${s.playbook.length - done} to go`, s, INK.up);
    this.checklist(g, s, done, total);
    this.bias(g, s, now);
  }

  private checklist(g: CanvasRenderingContext2D, s: TradingSnapshot, done: number, total: number) {
    const x = 24;
    const y = 82;
    const w = 500;
    const h = 496;
    g.fillStyle = INK.panel;
    rr(g, x, y, w, h, 20);
    g.fill();
    // Readiness: a big fraction over a segmented bar.
    g.fillStyle = INK.dim;
    g.font = `900 14px ${SANS}`;
    g.fillText('READINESS', x + 26, y + 38);
    g.fillStyle = done === total ? INK.up : INK.text;
    g.font = `900 52px ${MONO}`;
    g.fillText(`${done}`, x + 26, y + 92);
    const dw = g.measureText(`${done}`).width;
    g.fillStyle = INK.dim;
    g.font = `800 28px ${MONO}`;
    g.fillText(`/ ${total}`, x + 32 + dw, y + 92);
    const seg = (w - 52 - (total - 1) * 4) / total;
    for (let i = 0; i < total; i++) {
      g.fillStyle = i < done ? INK.up : INK.panel2;
      rr(g, x + 26 + i * (seg + 4), y + 108, seg, 8, 4);
      g.fill();
    }
    // The list: open items first, since those are the ones that need someone.
    const items = [...s.playbook].sort((a, b) => Number(a.done) - Number(b.done));
    const top = y + 138;
    const rh = Math.min(44, (y + h - 14 - top) / Math.max(1, items.length));
    items.forEach((p, i) => {
      const ry = top + i * rh;
      const cy = ry + rh / 2;
      if (p.done) {
        g.fillStyle = INK.up + '26';
        g.beginPath();
        g.arc(x + 38, cy, 11, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = INK.up;
        g.lineWidth = 2.5;
        g.lineCap = 'round';
        g.beginPath();
        g.moveTo(x + 33, cy + 0.5);
        g.lineTo(x + 37, cy + 4.5);
        g.lineTo(x + 44, cy - 4);
        g.stroke();
        g.lineCap = 'butt';
      } else {
        g.strokeStyle = INK.dim;
        g.lineWidth = 2;
        g.beginPath();
        g.arc(x + 38, cy, 10, 0, Math.PI * 2);
        g.stroke();
      }
      g.fillStyle = p.done ? INK.dim : INK.text;
      g.font = `${p.done ? 700 : 800} 16px ${SANS}`;
      const lines = wrap(g, p.label, w - 62 - 110, 2);
      lines.forEach((l, k) => g.fillText(l, x + 62, cy + 5 + (k - (lines.length - 1) / 2) * 18));
      const tag = p.auto ? 'AUTO' : p.owner.toUpperCase();
      g.font = `900 11px ${MONO}`;
      const tw = g.measureText(tag).width + 16;
      g.fillStyle = (p.auto ? INK.info : INK.warn) + (p.done ? '18' : '2a');
      rr(g, x + w - 24 - tw, cy - 11, tw, 22, 11);
      g.fill();
      g.fillStyle = p.done ? INK.dim : p.auto ? INK.info : INK.warn;
      g.fillText(tag, x + w - 24 - tw + 8, cy + 4);
    });
  }

  /** One wide row per market: which way the tape leans, how far, and why. */
  private bias(g: CanvasRenderingContext2D, s: TradingSnapshot, now: number) {
    const x = 548;
    const w = this.W - x - 24;
    const list = s.bias.filter((b) => s.markets.includes(b.symbol));
    const gap = 12;
    const h = Math.min(190, (496 - gap * (list.length - 1)) / Math.max(1, list.length));
    list.forEach((b, i) => {
      const y = 82 + i * (h + gap);
      const q = quoteOf(s, b.symbol);
      const ink = b.direction === 'long' ? INK.up : b.direction === 'short' ? INK.down : INK.dim;
      g.fillStyle = INK.panel;
      rr(g, x, y, w, h, 20);
      g.fill();
      const wash = g.createLinearGradient(x, 0, x + 260, 0);
      wash.addColorStop(0, ink + '22');
      wash.addColorStop(1, ink + '00');
      g.fillStyle = wash;
      rr(g, x, y, w, h, 20);
      g.fill();
      // Left: the market and the lean.
      g.fillStyle = INSTRUMENTS[b.symbol].ink;
      g.font = `900 36px ${MONO}`;
      g.fillText(b.symbol, x + 26, y + 52);
      if (q) {
        g.fillStyle = INK.text;
        g.font = `800 19px ${MONO}`;
        const priceTxt = fmt(q.last, q.decimals);
        g.fillText(priceTxt, x + 26, y + 80);
        const pw = g.measureText(priceTxt).width;
        g.fillStyle = tone(q.changePct);
        g.font = `800 14px ${MONO}`;
        g.fillText(pct(q.changePct), x + 26 + pw + 10, y + 80);
      }
      const label = b.direction === 'long' ? 'LONG BIAS' : b.direction === 'short' ? 'SHORT BIAS' : 'NEUTRAL';
      g.fillStyle = ink;
      g.font = `900 17px ${SANS}`;
      g.fillText(`${b.direction === 'long' ? '▲' : b.direction === 'short' ? '▼' : '◆'} ${label}`, x + 26, y + h - 50);
      // The lean as a dial: short on the left, long on the right.
      const mx = x + 26;
      const mw = 190;
      const my = y + h - 28;
      g.fillStyle = INK.panel2;
      rr(g, mx, my - 4, mw, 8, 4);
      g.fill();
      g.fillStyle = INK.line;
      g.fillRect(mx + mw / 2 - 1, my - 9, 2, 18);
      const at = b.direction === 'long' ? 0.85 : b.direction === 'short' ? 0.15 : 0.5;
      g.fillStyle = ink + 'aa';
      rr(g, Math.min(mx + mw / 2, mx + mw * at), my - 4, Math.abs(mw * at - mw / 2), 8, 4);
      g.fill();
      g.fillStyle = '#fff';
      g.beginPath();
      g.arc(mx + mw * at, my, 7, 0, Math.PI * 2);
      g.fill();
      // Right: the reasons, and the playbook that suits the day.
      const tx = x + 270;
      g.fillStyle = INK.line;
      g.fillRect(tx - 18, y + 22, 1, h - 44);
      g.fillStyle = INK.dim;
      g.font = `900 12px ${SANS}`;
      g.fillText('WHY', tx, y + 34);
      g.font = `700 15px ${SANS}`;
      const textW = w - 270 - 34;
      const maxY = y + h - (b.fit ? 50 : 20);
      let ly = y + 62;
      for (const l of b.lines) {
        const ls = wrap(g, l, textW - 14, 2);
        if (ly + (ls.length - 1) * 19 > maxY) break;
        g.fillStyle = INK.dim;
        g.beginPath();
        g.arc(tx + 4, ly - 5, 2.5, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = INK.text;
        ls.forEach((t, k) => g.fillText(t, tx + 16, ly + k * 19));
        ly += ls.length * 19 + 7;
      }
      if (b.fit) {
        const p = PLAYBOOK_BY_ID[b.fit];
        g.font = `800 12px ${SANS}`;
        g.fillStyle = INK.dim;
        g.fillText('FITS', tx, y + h - 20);
        pill(g, tx + 38, y + h - 38, p.name, p.color + '33', p.color, 13);
      }
    });
    void now;
  }
}

// ---- 🎯 Live proposals ------------------------------------------------------------------------------------

const isHot = (p: Proposal) => p.stage === 'live' || p.stage === 'ready';
const FRESH_INK = { ok: INK.up, warn: INK.warn, stop: INK.down } as const;

export class ProposalsBoard extends Screen {
  constructor() {
    super(1200, 600);
  }
  draw(s: TradingSnapshot, _role: FloorRole, now: number) {
    const g = this.g;
    const all = s.proposals.filter((p) => p.stage !== 'off' && p.mark !== 'skipped');
    const hot = all.filter(isHot);
    const rest = all.filter((p) => !isHot(p));
    const watching = rest.filter((p) => p.stage === 'watching').length;
    topBar(g, this.W, 'Trade proposals', hot.length ? `${hot.length} at a level` : `${watching} watching`, s, INK.warn);
    let y = 82;
    if (s.guard.level !== 'ok') {
      guardBar(g, 24, y, this.W - 48, 34, s, now);
      y += 46;
    }
    // Standing down: the setups stay up to learn from, dimmed, so nobody mistakes them for a go.
    g.globalAlpha = s.guard.level === 'stop' ? 0.55 : 1;
    if (!all.length) {
      g.globalAlpha = 1;
      return this.empty('Nothing to propose right now', `The playbooks are watching ${s.markets.join(', ')}`);
    }
    if (hot.length) {
      const shown = hot.slice(0, 4);
      const cols = shown.length;
      const cw = (this.W - 48 - (cols - 1) * 14) / cols;
      const ch = rest.length ? 316 : this.H - y - 24;
      shown.forEach((p, i) => proposalCard(g, 24 + i * (cw + 14), y, cw, ch, p, s, now));
      y += ch + 14;
    } else {
      this.quiet(g, s, y, now);
      y += 132;
    }
    const left = this.H - y - 20;
    if (rest.length && left > 40) this.roster(g, rest, s, y, left);
    g.globalAlpha = 1;
  }

  /** Nothing at a level: say so calmly, and what the desk is waiting for. */
  private quiet(g: CanvasRenderingContext2D, s: TradingSnapshot, y: number, now: number) {
    const w = this.W - 48;
    g.fillStyle = INK.panel;
    rr(g, 24, y, w, 118, 20);
    g.fill();
    g.fillStyle = INK.dim + '';
    g.beginPath();
    g.arc(62, y + 59, 7, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = INK.dim;
    g.globalAlpha *= 0.35 + 0.25 * Math.sin(now / 600);
    g.lineWidth = 2;
    g.beginPath();
    g.arc(62, y + 59, 16, 0, Math.PI * 2);
    g.stroke();
    g.globalAlpha = s.guard.level === 'stop' ? 0.55 : 1;
    g.fillStyle = INK.text;
    g.font = `900 30px ${SANS}`;
    g.fillText('No setup at a level', 96, y + 54);
    g.fillStyle = INK.dim;
    g.font = `700 19px ${SANS}`;
    g.fillText(s.session.phase === 'closed' ? 'Markets are closed. The playbooks wake up at the next session.' : 'The playbooks are on watch. The first one to reach its level lights up here.', 96, y + 86);
    g.textAlign = 'right';
    g.fillStyle = INK.warn;
    g.font = `900 22px ${MONO}`;
    g.fillText(bellText(s).replace('🔔 ', ''), 24 + w - 28, y + 66);
    g.textAlign = 'left';
  }

  /** Everything that isn't a go right now, as a tidy ledger of one-liners. */
  private roster(g: CanvasRenderingContext2D, list: Proposal[], s: TradingSnapshot, y: number, room: number) {
    const cols = 3;
    const cw = (this.W - 48 - (cols - 1) * 12) / cols;
    const rh = 40;
    const rowsFit = Math.max(1, Math.floor((room + 6) / (rh + 6)));
    const cap = rowsFit * cols;
    g.fillStyle = INK.dim;
    g.font = `900 13px ${SANS}`;
    const shown = list.slice(0, cap);
    shown.forEach((p, i) => {
      const x = 24 + (i % cols) * (cw + 12);
      const ry = y + Math.floor(i / cols) * (rh + 6);
      const book = PLAYBOOK_BY_ID[p.playbook];
      const ink = STAGE_COLOR[p.stage] ?? INK.dim;
      g.fillStyle = INK.panel;
      rr(g, x, ry, cw, rh, 12);
      g.fill();
      g.fillStyle = book.color;
      g.beginPath();
      g.arc(x + 16, ry + rh / 2, 5, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = INK.text;
      g.font = `900 17px ${MONO}`;
      g.fillText(p.symbol, x + 30, ry + 26);
      const resolved = ['won', 'lost', 'closed'].includes(p.stage) ? stageClock(p, Date.now(), false) : null;
      const stage = resolved ? resolved.text : p.stage === 'done' ? 'Done' : p.stage === 'watching' ? 'Watching' : (STAGE_LABEL[p.stage] ?? p.stage).replace(/^[●✓✗]\s*/, '');
      g.textAlign = 'right';
      g.fillStyle = ink;
      g.font = `900 13px ${SANS}`;
      const fresh = dataFreshness(quoteOf(s, p.symbol), Date.now(), p.dataAt ?? null, p.dataSource);
      g.fillText(stage.toUpperCase(), x + cw - (p.stage === 'done' ? 16 : 30), ry + 25);
      if (p.stage !== 'done') {
        g.fillStyle = FRESH_INK[fresh.tone as keyof typeof FRESH_INK];
        g.beginPath();
        g.arc(x + cw - 16, ry + rh / 2, 4, 0, Math.PI * 2);
        g.fill();
      }
      g.textAlign = 'left';
      g.fillStyle = INK.dim;
      g.font = `700 14px ${SANS}`;
      g.font = `900 13px ${SANS}`;
      const stageW = g.measureText(stage.toUpperCase()).width;
      g.font = `700 14px ${SANS}`;
      g.fillText(clip(g, p.title, Math.max(40, cw - 78 - stageW - 52)), x + 78, ry + 25);
    });
    if (list.length > cap) {
      g.fillStyle = INK.dim;
      g.textAlign = 'right';
      g.font = `800 13px ${SANS}`;
      g.fillText(`+${list.length - cap} more`, this.W - 24, y + room + 10);
      g.textAlign = 'left';
    }
  }
}


/** "14m 07s" while it's short, "1h 05m" after: a stopwatch for a setup. */
export function stopwatch(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000));
  if (t < 60) return `${t}s`;
  if (t < 3600) return `${Math.floor(t / 60)}m ${String(t % 60).padStart(2, '0')}s`;
  return `${Math.floor(t / 3600)}h ${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}m`;
}
const clockAt = (ts: number) => new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Los_Angeles' });

/**
 * The timer a proposal wears, in words the board can fit. `level` 0 is the full line, 1 drops the extras
 * ("since 18:16", "ran 25m"), 2 is just the stopwatch, so the board can pick the longest one that fits.
 */
export function stageClock(p: Proposal, now: number, level: boolean | 0 | 1 | 2 = 0): { text: string; ink: string; live: boolean } | null {
  const lv = typeof level === 'boolean' ? (level ? 0 : 1) : level;
  if (p.stage === 'live' && p.triggeredAt) {
    const w = stopwatch(now - p.triggeredAt);
    return { text: lv === 0 ? `IN TRADE ${w} · since ${clockAt(p.triggeredAt)}` : lv === 1 ? `IN TRADE ${w}` : w, ink: INK.info, live: true };
  }
  if ((p.stage === 'won' || p.stage === 'lost' || p.stage === 'closed') && p.endedAt) {
    const ago = stopwatch(now - p.endedAt);
    const ran = p.triggeredAt ? ` · ran ${stopwatch(p.endedAt - p.triggeredAt)}` : '';
    const word = p.stage === 'won' ? 'TARGET' : p.stage === 'lost' ? 'STOPPED' : 'FLAT';
    return { text: lv === 0 ? `${word} ${ago} ago${ran}` : lv === 1 ? `${word} ${ago} ago` : `${ago} ago`, ink: p.stage === 'won' ? INK.up : p.stage === 'lost' ? INK.down : INK.dim, live: false };
  }
  if (p.stage === 'ready' && p.stageSince) {
    const w = stopwatch(now - p.stageSince);
    return { text: lv <= 1 ? `AT THE LEVEL ${w}` : w, ink: INK.warn, live: true };
  }
  return null;
}

/** A setup that's at its level or in a trade: the big card, with the trade drawn as a ladder. */
function proposalCard(g: CanvasRenderingContext2D, x: number, y: number, cw: number, ch: number, p: Proposal, s: TradingSnapshot, now: number) {
  const q = quoteOf(s, p.symbol);
  const book = PLAYBOOK_BY_ID[p.playbook];
  const color = STAGE_COLOR[p.stage] ?? INK.line;
  const pulse = isHot(p) ? 0.5 + 0.5 * Math.sin(now / 320) : 0;
  const dec = q?.decimals ?? 2;
  const pad = 22;
  // Card, with a soft wash of the playbook's color at the top.
  g.fillStyle = INK.panel;
  rr(g, x, y, cw, ch, 20);
  g.fill();
  const wash = g.createLinearGradient(0, y, 0, y + 110);
  wash.addColorStop(0, book.color + '2e');
  wash.addColorStop(1, book.color + '00');
  g.fillStyle = wash;
  rr(g, x, y, cw, 110, 20);
  g.fill();
  g.lineWidth = 1.5 + pulse * 1.5;
  g.strokeStyle = color + (pulse ? Math.round(120 + pulse * 120).toString(16) : '88');
  rr(g, x, y, cw, ch, 20);
  g.stroke();
  // Who and what.
  g.fillStyle = INK.text;
  g.font = `900 38px ${MONO}`;
  g.fillText(p.symbol, x + pad, y + 54);
  if (p.side) {
    const up = p.side === 'long';
    g.font = `900 16px ${SANS}`;
    const label = `${up ? '▲' : '▼'} ${p.side.toUpperCase()}`;
    const w = g.measureText(label).width + 28;
    g.fillStyle = up ? INK.up : INK.down;
    rr(g, x + cw - pad - w, y + 28, w, 32, 16);
    g.fill();
    g.fillStyle = INK.bg;
    g.fillText(label, x + cw - pad - w + 14, y + 50);
  }
  g.fillStyle = book.color;
  g.font = `900 15px ${SANS}`;
  g.fillText(book.name.toUpperCase(), x + pad, y + 82, cw - pad * 2);
  // The title row: what it is, with the stopwatch at the right. The timer is the thing to keep whole, so it
  // takes the longest wording that still leaves the title a readable width, and the title is clipped to what's left.
  g.font = `900 14px ${MONO}`;
  const full = cw - pad * 2;
  let chip: { c: NonNullable<ReturnType<typeof stageClock>>; tw: number } | null = null;
  for (const level of [0, 1, 2] as const) {
    const c = stageClock(p, now, level);
    if (!c) break;
    const tw = g.measureText(c.text).width + 30;
    if (full - tw - 10 >= 120 || level === 2) {
      chip = { c, tw: Math.min(tw, full - 90) };
      break;
    }
  }
  g.fillStyle = INK.dim;
  g.font = `700 16px ${SANS}`;
  g.fillText(clip(g, p.title, chip ? full - chip.tw - 10 : full), x + pad, y + 106);
  if (chip) {
    const { c, tw } = chip;
    const cx = x + cw - pad - tw;
    g.fillStyle = c.ink + '26';
    rr(g, cx, y + 90, tw, 24, 12);
    g.fill();
    g.fillStyle = c.ink;
    g.beginPath();
    g.arc(cx + 13, y + 102, 3.5 + (c.live ? 1.2 * Math.sin(now / 300) : 0), 0, Math.PI * 2);
    g.fill();
    g.font = `900 14px ${MONO}`;
    g.fillText(c.text, cx + 23, y + 107, tw - 28);
  }
  // The ladder: stop ── entry ── target, with the tape riding on it.
  const levels = [p.stop, p.entry, p.target].filter((v): v is number => v != null);
  const ly = y + 172;
  if (p.entry != null && p.stop != null && p.target != null && q) {
    const all = [...levels, q.last];
    const lo = Math.min(...all);
    const hi = Math.max(...all);
    const span = hi - lo || 1;
    const tx0 = x + pad + 8;
    const tx1 = x + cw - pad - 8;
    const px = (v: number) => tx0 + ((v - lo) / span) * (tx1 - tx0);
    const short = p.side === 'short';
    const a = px(p.stop);
    const b = px(p.entry);
    const c = px(p.target);
    const bar = (x1: number, x2: number, ink: string) => {
      g.fillStyle = ink;
      rr(g, Math.min(x1, x2), ly - 7, Math.abs(x2 - x1), 14, 7);
      g.fill();
    };
    bar(a, b, 'rgba(255,93,115,.55)');
    bar(b, c, 'rgba(46,230,166,.55)');
    const tick = (px0: number, ink: string, label: string, v: number, below: boolean) => {
      g.fillStyle = ink;
      g.fillRect(px0 - 1.5, ly - 16, 3, 32);
      g.textAlign = px0 < x + 70 ? 'left' : px0 > x + cw - 70 ? 'right' : 'center';
      const tx = g.textAlign === 'left' ? Math.max(px0 - 4, x + pad) : g.textAlign === 'right' ? Math.min(px0 + 4, x + cw - pad) : px0;
      g.fillStyle = INK.dim;
      g.font = `800 11px ${SANS}`;
      g.fillText(label, tx, below ? ly + 36 : ly - 24);
      g.fillStyle = ink === INK.text ? INK.text : ink;
      g.font = `900 16px ${MONO}`;
      g.fillText(fmt(v, dec), tx, below ? ly + 54 : ly - 40);
      g.textAlign = 'left';
    };
    // Entry sits above the bar; stop and target hang below, so three labels never collide.
    tick(a, INK.down, 'STOP', p.stop, true);
    tick(c, INK.up, 'TARGET', p.target, true);
    tick(b, INK.text, 'ENTRY', p.entry, false);
    // The tape itself.
    const now_x = px(q.last);
    const glow = g.createRadialGradient(now_x, ly, 0, now_x, ly, 16 + pulse * 6);
    glow.addColorStop(0, color + 'cc');
    glow.addColorStop(1, color + '00');
    g.fillStyle = glow;
    g.beginPath();
    g.arc(now_x, ly, 16 + pulse * 6, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#fff';
    g.beginPath();
    g.arc(now_x, ly, 6.5, 0, Math.PI * 2);
    g.fill();
    void short;
  } else if (p.distance != null) {
    g.fillStyle = INK.text;
    g.font = `900 30px ${MONO}`;
    g.fillText(fmt(Math.abs(p.distance), dec), x + pad, ly + 10);
    g.fillStyle = INK.dim;
    g.font = `700 16px ${SANS}`;
    g.fillText('points from the entry', x + pad, ly + 34);
  }
  // The payoff and the size.
  const planR = p.entry != null && p.stop != null && p.target != null && p.entry !== p.stop ? Math.abs(p.target - p.entry) / Math.abs(p.entry - p.stop) : null;
  const rv = p.r ?? planR;
  const by = y + ch - 58;
  if (rv != null) {
    g.fillStyle = INK.warn;
    g.font = `900 30px ${MONO}`;
    g.fillText(`${rv.toFixed(1)}R`, x + pad, by + 4);
    g.fillStyle = INK.dim;
    g.font = `800 11px ${SANS}`;
    g.fillText(p.r != null ? 'RESULT' : 'PLANNED', x + pad, by + 20);
  }
  const size = p.sizing.find((z) => z.micros > 0);
  g.textAlign = 'right';
  g.fillStyle = INK.text;
  g.font = `800 15px ${SANS}`;
  if (size) {
    g.fillText(`${size.micros} ${INSTRUMENTS[p.symbol].micro}`, x + cw - pad, by - 3);
    g.fillStyle = INK.dim;
    g.font = `700 13px ${SANS}`;
    g.fillText(`${shortAccount(size.accountId)} · $${size.risk} risk`, x + cw - pad, by + 16, cw / 2);
  } else if (p.distance != null && p.entry != null) {
    g.fillText(`${fmt(Math.abs(p.distance), dec)} pts to go`, x + cw - pad, by + 6);
  }
  g.textAlign = 'left';
  // Footer: where it stands, and how much to trust the tape it's built on.
  const fy = y + ch - 20;
  g.fillStyle = color;
  g.beginPath();
  g.arc(x + pad + 4, fy - 5, 4 + pulse * 1.5, 0, Math.PI * 2);
  g.fill();
  g.font = `900 14px ${SANS}`;
  g.fillText((STAGE_LABEL[p.stage] ?? p.stage).replace(/^[●✓✗]\s*/, ''), x + pad + 16, fy);
  const fresh = dataFreshness(q, now, p.dataAt ?? null, p.dataSource);
  g.textAlign = 'right';
  g.fillStyle = FRESH_INK[fresh.tone as keyof typeof FRESH_INK];
  g.font = `800 12px ${MONO}`;
  g.fillText(`${fresh.source.split(' ')[0]} · ${fresh.status}`, x + cw - pad, fy - 1, cw / 2);
  g.textAlign = 'left';
}


// ---- 📊 The live market map (the east wall) ----------------------------------------------------------------
export function bellText(s: TradingSnapshot): string {
  const n = s.session.nextBell.inSeconds;
  const d = Math.floor(n / 86400);
  const t = `${d ? `${d}d ` : ''}${String(Math.floor((n % 86400) / 3600)).padStart(2, '0')}:${String(Math.floor((n % 3600) / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
  return `🔔 ${s.session.nextBell.kind === 'open' ? 'Opening' : 'Closing'} bell in ${t}`;
}

export class MarketMap extends Screen {
  constructor() {
    super(1200, 600);
  }
  draw(s: TradingSnapshot, _role?: FloorRole, now = Date.now()) {
    const g = this.g;
    const live = s.feeds.filter((f) => f.ok).length;
    topBar(g, this.W, 'Live market', `${live}/${s.feeds.length} feeds live`, s, INK.up);
    const gap = 14;
    const cw = (this.W - 48 - gap * 3) / 4;
    const ch = 402;
    const y = 82;
    SYMBOLS.forEach((sym, i) => {
      const q = quoteOf(s, sym);
      const x = 24 + i * (cw + gap);
      g.fillStyle = INK.panel;
      rr(g, x, y, cw, ch, 20);
      g.fill();
      if (!q) return;
      const up = q.change >= 0;
      const pad = 18;
      const f = dataFreshness(q, now, s.bars[sym].at(-1)?.ts ?? null, q.barSource);
      const fInk = f.tone === 'ok' ? INK.up : f.tone === 'stop' ? INK.down : INK.warn;
      const chipInk = q.stale ? INK.dim : fInk;
      // A wash of the day's direction, so the wall reads green or red from across the room.
      const wash = g.createLinearGradient(0, y, 0, y + 150);
      wash.addColorStop(0, (up ? INK.up : INK.down) + '1c');
      wash.addColorStop(1, (up ? INK.up : INK.down) + '00');
      g.fillStyle = wash;
      rr(g, x, y, cw, 150, 20);
      g.fill();
      // Symbol, and whether the tape behind it can be trusted.
      g.fillStyle = q.ink;
      g.font = `900 26px ${MONO}`;
      g.fillText(sym, x + pad, y + 40);
      g.font = `900 11px ${SANS}`;
      const st = q.stale ? 'CLOSED' : f.status === 'CURRENT' ? 'LIVE' : f.status;
      const sw = g.measureText(st).width + 26;
      g.fillStyle = chipInk + '24';
      rr(g, x + cw - pad - sw, y + 20, sw, 24, 12);
      g.fill();
      g.fillStyle = chipInk;
      g.beginPath();
      g.arc(x + cw - pad - sw + 12, y + 32, 3.5 + (st === 'LIVE' ? 1 + Math.sin(now / 400) : 0), 0, Math.PI * 2);
      g.fill();
      g.fillText(st, x + cw - pad - sw + 21, y + 36);
      // The price, then the day's move.
      g.fillStyle = q.stale ? INK.dim : INK.text;
      g.font = `900 40px ${MONO}`;
      g.fillText(fmt(q.last, q.decimals), x + pad, y + 92, cw - pad * 2);
      const mv = `${up ? '▲' : '▼'} ${fmt(Math.abs(q.change), q.decimals)}  ${pct(q.changePct)}`;
      g.font = `900 16px ${MONO}`;
      const mw = g.measureText(mv).width + 22;
      g.fillStyle = (up ? INK.up : INK.down) + '26';
      rr(g, x + pad, y + 106, mw, 30, 15);
      g.fill();
      g.fillStyle = up ? INK.up : INK.down;
      g.fillText(mv, x + pad + 11, y + 127);
      // Where the price sits inside the day's range.
      const ry = y + 162;
      const rw = cw - pad * 2;
      const pos = q.high > q.low ? Math.min(1, Math.max(0, (q.last - q.low) / (q.high - q.low))) : 0.5;
      g.fillStyle = INK.panel2;
      rr(g, x + pad, ry, rw, 6, 3);
      g.fill();
      g.fillStyle = (up ? INK.up : INK.down) + '88';
      rr(g, x + pad, ry, Math.max(6, rw * pos), 6, 3);
      g.fill();
      g.fillStyle = '#fff';
      g.beginPath();
      g.arc(x + pad + rw * pos, ry + 3, 6, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = INK.dim;
      g.font = `800 12px ${MONO}`;
      g.fillText(fmt(q.low, q.decimals), x + pad, ry + 24);
      g.textAlign = 'right';
      g.fillText(fmt(q.high, q.decimals), x + cw - pad, ry + 24);
      g.textAlign = 'left';
      // The candles, without their own footer; the honest clocks live in one line below.
      drawChart(g, x + 8, y + 196, cw - 16, ch - 196 - 38, s.bars[sym].slice(-60), q, s.levels[sym], { vwap: true, footer: false });
      g.fillStyle = INK.line;
      g.fillRect(x + pad, y + ch - 34, cw - pad * 2, 1);
      g.fillStyle = INK.dim;
      g.font = `700 11px ${MONO}`;
      g.fillText(`${f.source} · quote ${marketTime(q.updatedAt).match(/\d\d:\d\d/)?.[0] ?? '—'}`, x + pad, y + ch - 13, cw - pad * 2 - 70);
      g.textAlign = 'right';
      g.fillStyle = fInk;
      g.fillText(f.status, x + cw - pad, y + ch - 13);
      g.textAlign = 'left';
    });
    // The backdrop: VIX, the dollar, yields, crude, the Russell and the Dow.
    const cy = y + ch + 14;
    const n = Math.max(1, s.context.length);
    const w = (this.W - 48 - (n - 1) * 10) / n;
    s.context.forEach((c, i) => {
      const x = 24 + i * (w + 10);
      g.fillStyle = INK.panel;
      rr(g, x, cy, w, 76, 16);
      g.fill();
      g.fillStyle = INK.dim;
      g.font = `900 12px ${SANS}`;
      g.fillText(c.label.toUpperCase(), x + 16, cy + 26);
      g.fillStyle = INK.text;
      g.font = `900 22px ${MONO}`;
      g.fillText(fmt(c.last, c.decimals), x + 16, cy + 56);
      // VIX and yields rising is risk-off: red, whatever the sign.
      const riskOff = c.id === 'VIX' || c.id === 'TNX' || c.id === 'DXY';
      const ink = c.changePct === 0 ? INK.dim : (c.changePct > 0) !== riskOff ? INK.up : INK.down;
      g.textAlign = 'right';
      g.fillStyle = ink;
      g.font = `800 14px ${MONO}`;
      g.fillText(pct(c.changePct), x + w - 14, cy + 26);
      g.textAlign = 'left';
    });
  }
}

// The Back Office's own wall displays (the backtest, the eval simulator, the paper book) are in backoffice-boards.ts.

export function accountRow(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, a: AccountState) {
  g.fillStyle = INK.panel;
  rr(g, x, y, w, h, 10);
  g.fill();
  g.fillStyle = INK.text;
  g.font = `900 20px ${SANS}`;
  g.fillText(clip(g, `${a.rules.firm} ${a.rules.program.replace(a.rules.firm, '').trim()}`, 260), x + 14, y + 23);
  g.fillStyle = INK.dim;
  g.font = `700 14px ${SANS}`;
  g.fillText(`${money(a.balance)} · ${a.source === 'projectx' ? 'ProjectX' : 'typed in'}`, x + 14, y + 43);
  // The cushion left before the threshold, as a bar.
  const bx = x + 300;
  const bw = w - 300 - 260;
  const frac = Math.max(0, Math.min(1, a.cushion / a.rules.drawdown));
  g.fillStyle = INK.line;
  rr(g, bx, y + 18, bw, 16, 8);
  g.fill();
  g.fillStyle = frac > 0.6 ? INK.up : frac > 0.3 ? INK.warn : INK.down;
  rr(g, bx, y + 18, Math.max(8, bw * frac), 16, 8);
  g.fill();
  g.fillStyle = INK.dim;
  g.font = `700 13px ${SANS}`;
  g.fillText(`cushion ${money(a.cushion)} of ${money(a.rules.drawdown)} · ${money(a.toTarget)} to target`, bx, y + 48);
  g.textAlign = 'right';
  g.fillStyle = INK.warn;
  g.font = `900 24px ${MONO}`;
  g.fillText(`$${a.riskPerTrade}`, x + w - 14, y + 26);
  g.fillStyle = INK.dim;
  g.font = `700 13px ${SANS}`;
  g.fillText('risk / trade', x + w - 14, y + 44);
  g.textAlign = 'left';
}

/** The tape that runs the length of the wall. It scrolls with the clock, so every screen agrees where it is. */
/** How far the tape is drawn: a wide strip holding the same stretch of items over and over, so the GPU can scroll it by shifting texture coordinates. */
export const TAPE_WIDTH = 8192;
/** Tape pixels per second of scroll. */
export const TAPE_SPEED = 70;

/**
 * The ticker. It's painted rarely (once a second is plenty) into a strip holding the items on repeat,
 * and scrolled by sliding the texture's offset by `period` pixels' worth at a time (see main.ts), so a
 * moving tape costs no canvas drawing and no texture uploads per frame.
 */
export class TickerStrip extends Screen {
  /** Width in pixels of one run of items; the strip repeats this. */
  period = TAPE_WIDTH;
  constructor() {
    super(TAPE_WIDTH, 64);
  }
  draw(s: TradingSnapshot, _role: FloorRole, _now: number) {
    const g = this.g;
    const H = this.H;
    const W = this.W;
    const mid = H / 2;
    // A dark glass bar with hairlines, instead of a loud rule.
    const bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#0b1120');
    bg.addColorStop(1, '#0f172a');
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);
    g.fillStyle = INK.line;
    g.fillRect(0, 0, W, 1);
    g.fillRect(0, H - 1, W, 1);

    type Cell = { label: string; ink: string; price: string; changePct: number; main: boolean };
    const cells: Cell[] = [
      ...s.quotes.map((q) => ({ label: q.symbol, ink: q.ink, price: fmt(q.last, q.decimals), changePct: q.changePct, main: true })),
      ...s.context.map((c) => ({ label: c.id, ink: '#8fa0c4', price: fmt(c.last, c.decimals), changePct: c.changePct, main: false })),
    ];
    const font = (w: number, px: number) => `${w} ${px}px ${MONO}`;
    // Measure each cell once: tag pill, price, change chip.
    const layout = cells.map((c) => {
      g.font = font(900, 26);
      const tag = g.measureText(c.label).width + 26;
      g.font = font(800, 30);
      const price = g.measureText(c.price).width;
      const chg = `${c.changePct >= 0 ? '▲' : '▼'} ${pct(c.changePct)}`;
      g.font = font(900, 22);
      const chipW = g.measureText(chg).width + 24;
      return { tag, price, chg, chipW, w: tag + 14 + price + 14 + chipW };
    });
    const bell = bellText(s).replace('🔔 ', '');
    g.font = font(900, 22);
    const bellW = g.measureText(bell).width + 66;
    const gap = 52;
    // Rounded up to whole pixels, so the repeat lines up exactly.
    const total = Math.ceil(layout.reduce((a, l) => a + l.w + gap, 0) + bellW + gap);
    this.period = total;
    const chip = (x: number, w: number, ink: string, fill = '22') => {
      g.fillStyle = ink + fill;
      rr(g, x, mid - 15, w, 30, 15);
      g.fill();
    };
    for (let rep = 0; rep * total < W; rep++) {
      let x = rep * total;
      cells.forEach((c, i) => {
        const l = layout[i]!;
        // Tag.
        chip(x, l.tag, c.ink, c.main ? '2e' : '1c');
        g.fillStyle = c.ink;
        g.font = font(900, 26);
        g.fillText(c.label, x + 13, mid + 9);
        // Price.
        g.fillStyle = c.main ? INK.text : '#c4cde0';
        g.font = font(800, 30);
        g.fillText(c.price, x + l.tag + 14, mid + 10);
        // Change.
        const cx = x + l.tag + 14 + l.price + 14;
        chip(cx, l.chipW, tone(c.changePct));
        g.fillStyle = tone(c.changePct);
        g.font = font(900, 22);
        g.fillText(l.chg, cx + 12, mid + 8);
        x += l.w;
        // A hairline between markets, and a dot where the futures end and the backdrop begins.
        if (c.main && !cells[i + 1]?.main) {
          g.beginPath();
          g.arc(x + gap / 2, mid, 4, 0, Math.PI * 2);
          g.fillStyle = INK.warn;
          g.fill();
        } else {
          g.fillStyle = INK.line;
          g.fillRect(x + gap / 2, mid - 13, 2, 26);
        }
        x += gap;
      });
      // The next bell, as a chip in the same language.
      chip(x, bellW, INK.warn, '24');
      g.fillStyle = INK.warn;
      g.font = font(900, 22);
      g.fillText('🔔', x + 14, mid + 8);
      g.fillText(bell, x + 50, mid + 8);
      x += bellW;
      g.fillStyle = INK.warn;
      g.beginPath();
      g.arc(x + gap / 2, mid, 4, 0, Math.PI * 2);
      g.fill();
    }
  }
}

/** The fixed badge at the left end of the tape: is the market open. Its own small canvas, drawn opaque so the tape slides underneath. */
export function paintTickerBadge(g: CanvasRenderingContext2D, w: number, h: number, s: TradingSnapshot | null, now: number) {
  const mid = h / 2;
  g.clearRect(0, 0, w, h);
  g.fillStyle = '#0d1424';
  g.fillRect(0, 0, w, h);
  g.fillStyle = INK.line;
  g.fillRect(0, 0, w, 1);
  g.fillRect(0, h - 1, w, 1);
  if (!s) return;
  const closed = s.session.phase === 'closed';
  const label = (phaseLabel[s.session.phase] ?? s.session.phase).toUpperCase();
  g.font = `900 20px ${MONO}`;
  const bw = g.measureText(label).width + 44;
  const live = closed ? INK.dim : INK.up;
  g.fillStyle = live + '26';
  rr(g, 22, mid - 15, bw, 30, 15);
  g.fill();
  g.fillStyle = live;
  g.beginPath();
  g.arc(40, mid, 4.5 + (closed ? 0 : 1.2 * Math.sin(now / 420)), 0, Math.PI * 2);
  g.fill();
  g.fillText(label, 54, mid + 7);
}

/** A worker's monitor strip: the four tickers along the bottom of a laptop. */
export function paintLaptopTape(g: CanvasRenderingContext2D, w: number, h: number, s: TradingSnapshot | null) {
  const bar = Math.round(h * 0.1);
  g.fillStyle = '#080c16';
  g.fillRect(0, h - bar, w, bar);
  g.fillStyle = INK.warn;
  g.fillRect(0, h - bar, w, 2);
  if (!s) return;
  const cell = w / Math.max(1, s.quotes.length);
  const fs = Math.round(bar * 0.42);
  g.textBaseline = 'middle';
  s.quotes.forEach((q, i) => {
    const x = i * cell + 10;
    g.font = `900 ${fs}px ${MONO}`;
    g.fillStyle = q.ink;
    g.fillText(q.symbol, x, h - bar / 2 + 1);
    g.fillStyle = tone(q.change);
    g.font = `800 ${Math.round(fs * 0.9)}px ${MONO}`;
    g.fillText(fmt(q.last, q.decimals), x + g.measureText(`${q.symbol} `).width + fs * 0.6, h - bar / 2 + 1);
  });
  g.textBaseline = 'alphabetic';
}

/** What a laptop shows while its worker has nothing on the terminal: its pod's market, the way that pod reads it. */
export function paintLaptopChart(g: CanvasRenderingContext2D, w: number, h: number, s: TradingSnapshot | null, symbol: Symbol, view: 'vwap' | 'zones' | 'profile' = 'vwap') {
  g.fillStyle = INK.bg;
  g.fillRect(0, 0, w, h);
  const q = s ? quoteOf(s, symbol) : undefined;
  if (!s || !q) return;
  g.fillStyle = q.ink;
  g.font = `900 ${Math.round(h * 0.09)}px ${MONO}`;
  g.fillText(symbol, 20, h * 0.11);
  g.fillStyle = INK.text;
  g.textAlign = 'right';
  g.fillText(fmt(q.last, q.decimals), w - 20, h * 0.11);
  g.fillStyle = tone(q.change);
  g.font = `800 ${Math.round(h * 0.05)}px ${MONO}`;
  g.fillText(pct(q.changePct), w - 20, h * 0.18);
  g.textAlign = 'left';
  const bars = view === 'zones' ? fives(s.bars[symbol]).slice(-36) : s.bars[symbol].slice(-64);
  drawChart(g, 14, h * 0.2, w - 28, h * 0.64, bars, q, s.levels[symbol], { vwap: view === 'vwap', onVwap: view === 'vwap', or: view === 'vwap', zones: view === 'zones', value: view === 'profile', profile: view === 'profile', grid: true, tag: true });
}

/** The boss's second monitor: your markets at a glance, the day's paper result, and what's live. */
export class BossScreen extends Screen {
  constructor() {
    super(1024, 576);
  }
  draw(s: TradingSnapshot) {
    const g = this.g;
    this.header('👑 Your markets', bellText(s).replace('🔔 ', ''), s, INK.warn);
    const syms = s.markets;
    const cw = (this.W - 24 - (syms.length - 1) * 10) / Math.max(1, syms.length);
    syms.forEach((sym, i) => {
      const q = quoteOf(s, sym);
      const x = 12 + i * (cw + 10);
      g.fillStyle = INK.panel;
      rr(g, x, 90, cw, 300, 12);
      g.fill();
      if (!q) return;
      g.fillStyle = q.ink;
      g.font = `900 28px ${MONO}`;
      g.fillText(sym, x + 12, 124);
      g.fillStyle = INK.text;
      g.font = `900 26px ${MONO}`;
      g.fillText(fmt(q.last, q.decimals), x + 12, 158);
      g.fillStyle = tone(q.change);
      g.font = `800 18px ${MONO}`;
      g.fillText(pct(q.changePct), x + 12, 184);
      drawChart(g, x + 6, 194, cw - 12, 190, s.bars[sym].slice(-60), q, s.levels[sym], { vwap: true });
    });
    const live = s.proposals.filter((p) => p.stage === 'live' || p.stage === 'ready').slice(0, 2);
    guardBar(g, 12, 400, this.W - 24, 44, s, Date.now());
    g.fillStyle = INK.panel2;
    rr(g, 12, 452, this.W - 24, 112, 12);
    g.fill();
    g.fillStyle = INK.text;
    g.font = `900 22px ${SANS}`;
    g.fillText(`Paper today ${s.paper.todayR >= 0 ? '+' : ''}${s.paper.todayR}R · ${money(s.paper.todayDollars)} a micro`, 28, 484);
    g.font = `800 19px ${SANS}`;
    if (!live.length) {
      g.fillStyle = INK.dim;
      g.fillText('Nothing at a level right now.', 28, 518);
    }
    live.forEach((p, i) => {
      g.fillStyle = STAGE_COLOR[p.stage] ?? INK.dim;
      g.fillText(clip(g, `${p.symbol} ${PLAYBOOK_BY_ID[p.playbook].short} ${p.side ?? ''} · ${STAGE_LABEL[p.stage]} · ${p.title}`, this.W - 60), 28, 512 + i * 28);
      g.font = `700 11px ${MONO}`;
      g.fillText(dataFreshness(quoteOf(s, p.symbol), Date.now(), p.dataAt ?? null, p.dataSource).detail, 28, 526 + i * 28, this.W - 60);
      g.font = `800 19px ${SANS}`;
    });
  }
}
