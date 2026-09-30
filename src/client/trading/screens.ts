import { calendarRows, eventTime, marketBrief, nextCondition, PROPOSAL_STATUS } from './brief';
import * as THREE from 'three';
import { dataFreshness, marketTime } from '../../shared/freshness';
import type { AccountState, Bar, FloorRole, Levels, PlaybookId, Proposal, Quote, Symbol, TradingSnapshot } from '../../shared/trading';
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
export const STAGE_LABEL: Record<string, string> = { live: '● PAPER TRADE', ready: '● AT ENTRY', won: '✓ TARGET', lost: '✗ STOPPED', closed: 'FLAT', watching: 'WATCHING', done: 'DONE TODAY', failed: 'FAILED', off: 'OFF HOURS' };

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
  readonly pages: readonly { id: string; label: string }[] = [];
  page = '';
  setPage(id: string) { if (this.pages.some(p => p.id === id)) this.page = id; }
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
  const fsFoot = Math.min(13, Math.max(10, w / 48));
  const footer = (fsFoot + 3) * 3 + 4;
  drawFreshness(g, x + 4, y + h - footer + fsFoot, w - 8, q, bars.at(-1)?.ts ?? null, Date.now(), fsFoot);
  h -= footer;
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

// ---- 📰 News & calendar ------------------------------------------------------------------------------
const GUARD_INK = { ok: INK.up, warn: INK.warn, stop: INK.down } as const;
const until = (ms: number) => {
  const m = Math.round(ms / 60_000);
  if (m <= 0) return 'now';
  return m >= 1440 ? `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h` : m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
};

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

export class NewsBoard extends Screen {
  readonly pages = [{ id: 'calendar', label: 'Calendar' }, { id: 'headlines', label: 'Headlines' }] as const;
  page = 'calendar';
  constructor() { super(1200, 600); }
  draw(s: TradingSnapshot, _role: FloorRole, now: number) {
    const g = this.g;
    const calendar = this.page === 'calendar';
    const next = s.news.filter(n => n.kind === 'calendar' && n.impact === 'high' && n.at >= now).sort((a, b) => a.at - b.at)[0];
    this.header(calendar ? 'Economic calendar' : 'Market headlines', `PAGE ${calendar ? '1' : '2'} / 2`, s, INK.info);
    guardBar(g, 20, 90, this.W - 40, 36, s, now);
    if (calendar) {
      const items = calendarRows(s.news, now);
      g.fillStyle = INK.dim; g.font = `800 16px ${SANS}`;
      g.fillText(next ? `NEXT HIGH IMPACT: ${next.headline.split(' · ')[0]} · in ${until(next.at - now)}` : 'US releases · all times Pacific', 24, 152, this.W - 48);
      const columns = [['TIME (PT)', 36], ['EVENT', 170], ['IMPACT', 720], ['ACTUAL', 860], ['EXPECTED', 985], ['PREVIOUS', 1110]] as const;
      g.font = `900 14px ${SANS}`;
      for (const [label, x] of columns) g.fillText(label, x, 184);
      items.forEach((n, i) => {
        const y = 198 + i * 68;
        const released = n.at < now;
        g.fillStyle = i === 0 && !released ? INK.panel2 : INK.panel;
        rr(g, 20, y, this.W - 40, 60, 8); g.fill();
        g.fillStyle = INK.text; g.font = `900 23px ${MONO}`; g.fillText(eventTime(n.at), 36, y + 27);
        g.fillStyle = INK.dim; g.font = `700 13px ${SANS}`;
        g.fillText(released ? n.actual ? 'Released' : 'Awaiting actual' : n.time.includes(' ') ? n.time.split(' ')[0]! : 'Today', 36, y + 48);
        g.fillStyle = INK.text; g.font = `800 22px ${SANS}`;
        g.fillText(clip(g, n.headline.split(' · ')[0]!, 525), 170, y + 37);
        g.fillStyle = n.impact === 'high' ? INK.down : n.impact === 'med' ? INK.warn : INK.dim;
        g.font = `900 16px ${SANS}`; g.fillText(n.impact === 'med' ? 'MEDIUM' : n.impact.toUpperCase(), 720, y + 36);
        g.fillStyle = INK.text; g.font = `800 19px ${MONO}`;
        for (const [value, x] of [[n.actual, 860], [n.forecast, 985], [n.previous, 1110]] as const) g.fillText(clip(g, value || '—', 100), x, y + 36);
      });
      if (!items.length) this.empty('No calendar releases received', 'Open details to check the source status.');
    } else {
      g.fillStyle = INK.dim; g.font = `800 16px ${SANS}`; g.fillText('NEWEST FIRST · OPEN FULL DETAILS FOR SOURCE LINKS AND MARKET FILTERS', 24, 155);
      const items = s.news.filter(n => n.kind === 'headline').sort((a, b) => b.at - a.at).slice(0, 5);
      items.forEach((n, i) => {
        const y = 174 + i * 74;
        g.fillStyle = INK.panel; rr(g, 20, y, this.W - 40, 66, 8); g.fill();
        g.fillStyle = INK.text; g.font = `800 24px ${SANS}`; g.fillText(clip(g, n.headline, this.W - 74), 36, y + 29);
        g.fillStyle = INK.dim; g.font = `700 15px ${SANS}`; g.fillText(`${n.source} · ${marketTime(n.at)} · ${n.impact === 'med' ? 'MEDIUM' : n.impact.toUpperCase()} IMPACT`, 36, y + 53);
        g.textAlign = 'right'; g.fillStyle = INK.info; g.font = `900 16px ${MONO}`;
        g.fillText(n.symbols.join(' · '), this.W - 36, y + 53); g.textAlign = 'left';
      });
      if (!items.length) this.empty('No headlines received', 'Open details to check the source status.');
    }
    const feed = s.feeds.find(f => f.id === (calendar ? 'calendar' : 'headlines'));
    g.fillStyle = INK.dim; g.font = `700 14px ${SANS}`;
    g.fillText(`${feed?.name ?? 'Waiting for source'} · Fetched ${marketTime(feed?.lastAt)}${feed && !feed.ok ? ' · SOURCE UNAVAILABLE' : ''}`, 24, 572, 830);
    g.textAlign = 'right'; g.fillStyle = INK.info; g.fillText('Open display to choose a page →', this.W - 24, 572); g.textAlign = 'left';
  }
}

// ---- 📋 The morning playbook: the checklist and the bias -------------------------------------------------
export class PlaybookBoard extends Screen {
  constructor() {
    super(1200, 600);
  }
  draw(s: TradingSnapshot) {
    const g = this.g;
    const done = s.playbook.filter((p) => p.done).length;
    this.header('📋 Morning playbook', `${done}/${s.playbook.length} ready`, s, INK.up);
    s.playbook.forEach((p, i) => {
      const y = 94 + i * 55;
      g.fillStyle = i % 2 ? INK.bg : INK.panel;
      rr(g, 20, y, 560, 50, 8);
      g.fill();
      g.strokeStyle = p.done ? INK.up : INK.dim;
      g.lineWidth = 3;
      rr(g, 32, y + 12, 26, 26, 6);
      g.stroke();
      if (p.done) {
        g.fillStyle = INK.up;
        g.font = `900 26px ${SANS}`;
        g.fillText('✓', 34, y + 35);
      }
      g.fillStyle = p.done ? INK.dim : INK.text;
      g.font = `800 20px ${SANS}`;
      g.fillText(clip(g, p.label, 400), 70, y + 32);
      g.fillStyle = p.auto ? INK.info : INK.warn;
      g.font = `900 14px ${MONO}`;
      g.textAlign = 'right';
      g.fillText(p.auto ? 'AUTO' : p.owner.toUpperCase(), 570, y + 31);
      g.textAlign = 'left';
    });
    // The bias, a card per market.
    const x0 = 600;
    const cw = (this.W - x0 - 20 - 12) / 2;
    const ch = 244;
    s.bias.filter((b) => s.markets.includes(b.symbol)).forEach((b, i) => {
      const x = x0 + (i % 2) * (cw + 12);
      const y = 94 + Math.floor(i / 2) * (ch + 10);
      const q = quoteOf(s, b.symbol);
      g.fillStyle = INK.panel;
      rr(g, x, y, cw, ch, 12);
      g.fill();
      g.fillStyle = INSTRUMENTS[b.symbol].ink;
      g.font = `900 30px ${MONO}`;
      g.fillText(b.symbol, x + 14, y + 38);
      const c = b.direction === 'long' ? INK.up : b.direction === 'short' ? INK.down : INK.dim;
      g.fillStyle = c;
      g.font = `900 22px ${SANS}`;
      g.textAlign = 'right';
      g.fillText(b.direction === 'long' ? '▲ LONG BIAS' : b.direction === 'short' ? '▼ SHORT BIAS' : '◆ NEUTRAL', x + cw - 14, y + 36);
      g.textAlign = 'left';
      if (q) {
        g.fillStyle = INK.text;
        g.font = `800 18px ${MONO}`;
        g.fillText(`${fmt(q.last, q.decimals)}  ${pct(q.changePct)}`, x + 14, y + 64);
      }
      g.fillStyle = INK.dim;
      g.font = `700 15px ${SANS}`;
      b.lines.slice(0, 5).forEach((l, k) => g.fillText(clip(g, `• ${l}`, cw - 28), x + 14, y + 92 + k * 24));
      if (b.fit) {
        const p = PLAYBOOK_BY_ID[b.fit];
        pill(g, x + 14, y + ch - 36, `Fits: ${p.name}`, p.color, INK.bg, 14);
      }
    });
  }
}

// ---- 🎯 Live proposals ------------------------------------------------------------------------------------
export class ProposalsBoard extends Screen {
  constructor() { super(1200, 600); }
  draw(s: TradingSnapshot, _role: FloorRole, now: number) {
    const g = this.g;
    this.header('Trade proposals', 'OVERVIEW · ONE PER MARKET', s, INK.warn);
    if (s.guard.level !== 'ok') guardBar(g, 20, 90, this.W - 40, 36, s, now);
    const cols = Math.max(1, s.markets.length);
    const cw = (this.W - 40 - (cols - 1) * 12) / cols;
    const y = s.guard.level !== 'ok' ? 142 : 100;
    const ch = 410;
    s.markets.forEach((sym, i) => {
      const x = 20 + i * (cw + 12);
      const brief = marketBrief(s.proposals, sym);
      const p = brief.primary;
      const q = quoteOf(s, sym);
      g.fillStyle = INK.panel; rr(g, x, y, cw, ch, 12); g.fill();
      g.fillStyle = INSTRUMENTS[sym].ink; g.font = `900 30px ${MONO}`; g.fillText(sym, x + 16, y + 42);
      g.textAlign = 'right'; g.fillStyle = INK.dim; g.font = `800 ${cols === 4 ? 16 : 20}px ${MONO}`;
      g.fillText(q ? fmt(q.last, q.decimals) : '—', x + cw - 16, y + 41); g.textAlign = 'left';
      const status = p ? PROPOSAL_STATUS[p.stage] : 'No unskipped setup';
      g.fillStyle = p?.stage === 'live' ? INK.info : p?.stage === 'ready' ? INK.warn : INK.dim;
      g.font = `900 ${cols === 4 ? 20 : 24}px ${SANS}`; g.fillText(clip(g, status, cw - 32), x + 16, y + 83);
      g.fillStyle = INK.text; g.font = `900 21px ${SANS}`;
      g.fillText(clip(g, p ? PLAYBOOK_BY_ID[p.playbook].name : 'Watching the market', cw - 32), x + 16, y + 123);
      g.fillStyle = INK.dim; g.font = `700 16px ${SANS}`;
      g.fillText(clip(g, p ? nextCondition(p) : 'Open All setups to review decisions.', cw - 32), x + 16, y + 153);
      if (p?.entry != null && p.stage !== 'off') {
        const w = (cw - 32) / 3;
        for (const [k, label, value] of [[0, 'ENTRY', p.entry], [1, 'STOP', p.stop], [2, 'TARGET', p.target]] as const) {
          g.fillStyle = INK.dim; g.font = `900 13px ${SANS}`; g.fillText(label, x + 16 + k * w, y + 194);
          g.fillStyle = INK.text; g.font = `900 ${cols === 4 ? 15 : 19}px ${MONO}`;
          g.fillText(fmt(value, q?.decimals), x + 16 + k * w, y + 224, w - 5);
        }
        g.fillStyle = INK.dim; g.font = `800 16px ${SANS}`;
        g.fillText(`${p.side === 'long' ? 'Long' : p.side === 'short' ? 'Short' : 'Neutral'} setup${p.mark === 'taken' ? ' · You recorded this trade' : ''}`, x + 16, y + 254, cw - 32);
      } else {
        g.fillStyle = INK.dim; g.font = `700 17px ${SANS}`;
        g.fillText('No entry to review in this session.', x + 16, y + 212, cw - 32);
      }
      drawFreshness(g, x + 16, y + 296, cw - 32, q, p?.dataAt ?? null, now, 12, p?.dataSource);
      g.fillStyle = INK.info; g.font = `800 15px ${SANS}`;
      g.fillText(brief.active > 1 ? `${brief.active} active paper trades · View all` : `${brief.others.length} other setups · View all`, x + 16, y + 378, cw - 32);
    });
    g.fillStyle = INK.dim; g.font = `700 15px ${SANS}`;
    g.fillText('Paper simulation, not broker positions · Open full details for all setups, checks and account sizing', 24, 582);
  }
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
  draw(s: TradingSnapshot) {
    const g = this.g;
    const live = s.feeds.filter((f) => f.ok).length;
    this.header('📊 Live market', `${live}/${s.feeds.length} feeds live`, s, INK.up);
    const gap = 12;
    const cw = (this.W - 40 - gap * 3) / 4;
    const ch = 390;
    SYMBOLS.forEach((sym, i) => {
      const q = quoteOf(s, sym);
      const x = 20 + i * (cw + gap);
      const y = 92;
      g.fillStyle = INK.panel;
      rr(g, x, y, cw, ch, 12);
      g.fill();
      if (!q) return;
      g.fillStyle = q.ink;
      g.font = `900 30px ${MONO}`;
      g.fillText(sym, x + 14, y + 38);
      g.fillStyle = INK.dim;
      g.font = `800 13px ${SANS}`;
      g.textAlign = 'right';
      g.fillText(q.stale ? 'CLOSED / STALE' : q.source.toUpperCase(), x + cw - 12, y + 34);
      g.textAlign = 'left';
      g.fillStyle = q.stale ? INK.dim : INK.text;
      g.font = `900 30px ${MONO}`;
      g.fillText(fmt(q.last, q.decimals), x + 14, y + 78);
      g.fillStyle = tone(q.change);
      g.font = `800 19px ${MONO}`;
      g.fillText(`${sign(q.change)}${fmt(Math.abs(q.change), q.decimals)}  ${pct(q.changePct)}`, x + 14, y + 106);
      g.fillStyle = INK.dim;
      g.font = `700 14px ${MONO}`;
      g.fillText(`H ${fmt(q.high, q.decimals)}  L ${fmt(q.low, q.decimals)}`, x + 14, y + 128);
      drawChart(g, x + 8, y + 140, cw - 16, ch - 150, s.bars[sym].slice(-60), q, s.levels[sym], { vwap: true, grid: true });
    });
    // The backdrop: VIX, the dollar, yields, crude, the Russell and the Dow.
    const y = 494;
    const n = Math.max(1, s.context.length);
    const w = (this.W - 40 - (n - 1) * 10) / n;
    s.context.forEach((c, i) => {
      const x = 20 + i * (w + 10);
      g.fillStyle = INK.panel2;
      rr(g, x, y, w, 88, 10);
      g.fill();
      g.fillStyle = INK.dim;
      g.font = `900 16px ${SANS}`;
      g.fillText(c.label.toUpperCase(), x + 12, y + 26);
      g.fillStyle = INK.text;
      g.font = `900 24px ${MONO}`;
      g.fillText(fmt(c.last, c.decimals), x + 12, y + 56);
      // VIX and yields rising is risk-off: red, whatever the sign.
      const riskOff = c.id === 'VIX' || c.id === 'TNX' || c.id === 'DXY';
      g.fillStyle = c.changePct === 0 ? INK.dim : (c.changePct > 0) !== riskOff ? INK.up : INK.down;
      g.font = `800 16px ${MONO}`;
      g.fillText(pct(c.changePct), x + 12, y + 78);
    });
  }
}

// ---- Back Office: 🧪 backtests, 🏦 the eval simulator, 📒 the paper book ------------------------------------
export class BacktestBoard extends Screen {
  constructor() {
    super(1200, 600);
  }
  draw(s: TradingSnapshot) {
    const g = this.g;
    const bt = s.backtest;
    this.header('🧪 Backtest lab', bt ? (bt.running ? 'replaying…' : `${bt.days.length} days · NQ ES GC BTC`) : 'queued', s, '#f15bb5');
    if (!bt || !bt.stats.length) return this.empty(bt?.running ? 'Replaying the month…' : 'No backtest yet', 'Every playbook, every market, a month of real 1-minute bars');
    const cols = ['PLAYBOOK', 'TRADES', 'WIN %', 'AVG R', 'TOTAL R', 'MAX DD', 'EQUITY (R)'];
    const xs = [28, 380, 490, 590, 700, 820, 930];
    g.fillStyle = INK.dim;
    g.font = `900 16px ${SANS}`;
    cols.forEach((c, i) => g.fillText(c, xs[i]!, 110));
    PLAYBOOKS.forEach((p, i) => {
      const st = bt.stats.find((x) => x.playbook === p.id && x.symbol === 'ALL');
      const y = 122 + i * 84;
      g.fillStyle = i % 2 ? INK.bg : INK.panel;
      rr(g, 20, y, this.W - 40, 78, 10);
      g.fill();
      g.fillStyle = p.color;
      g.fillRect(20, y + 10, 6, 58);
      g.fillStyle = INK.text;
      g.font = `900 22px ${SANS}`;
      g.fillText(p.name, xs[0]!, y + 34);
      g.fillStyle = INK.dim;
      g.font = `700 15px ${SANS}`;
      // Which market it works best on.
      const per = bt.stats.filter((x) => x.playbook === p.id && x.symbol !== 'ALL' && x.trades >= 3).sort((a, b) => b.avgR - a.avgR);
      g.fillText(per.length ? `Best: ${per[0]!.symbol} ${per[0]!.avgR >= 0 ? '+' : ''}${per[0]!.avgR}R a trade` : 'Not enough trades yet', xs[0]!, y + 58);
      if (!st) return;
      g.font = `900 22px ${MONO}`;
      g.fillStyle = INK.text;
      g.fillText(String(st.trades), xs[1]!, y + 46);
      g.fillStyle = st.winRate >= 0.5 ? INK.up : INK.text;
      g.fillText(`${Math.round(st.winRate * 100)}%`, xs[2]!, y + 46);
      g.fillStyle = tone(st.avgR);
      g.fillText(`${st.avgR >= 0 ? '+' : ''}${st.avgR}`, xs[3]!, y + 46);
      g.fillText(`${st.totalR >= 0 ? '+' : ''}${st.totalR}`, xs[4]!, y + 46);
      g.fillStyle = INK.down;
      g.fillText(`−${st.maxDrawdownR}`, xs[5]!, y + 46);
      sparkline(g, xs[6]!, y + 12, this.W - xs[6]! - 36, 54, st.curve, p.color);
    });
    g.fillStyle = INK.dim;
    g.font = `700 15px ${SANS}`;
    g.fillText(clip(g, bt.note, this.W - 56), 28, this.H - 18);
  }
}

export class EvalBoard extends Screen {
  constructor() {
    super(1200, 600);
  }
  draw(s: TradingSnapshot) {
    const g = this.g;
    const bt = s.backtest;
    this.header('🏦 Prop eval simulator', 'Law of 10 sizing · NQ ES GC', s, INK.violet);
    if (!bt || !bt.evals.length) return this.empty('Waiting on the backtest', 'Each playbook run through each account’s real rules');
    const accts = PROP_ACCOUNTS;
    const x0 = 290;
    const cw = (this.W - x0 - 20) / accts.length;
    g.font = `900 16px ${SANS}`;
    accts.forEach((a, i) => {
      g.fillStyle = INK.text;
      g.fillText(clip(g, `${a.firm} ${a.size / 1000}K`, cw - 12), x0 + i * cw + 8, 108);
      g.fillStyle = INK.dim;
      g.font = `700 13px ${SANS}`;
      g.fillText(clip(g, `$${a.profitTarget / 1000}K target · $${a.drawdown / 1000}K DD`, cw - 12), x0 + i * cw + 8, 126);
      g.font = `900 16px ${SANS}`;
    });
    PLAYBOOKS.forEach((p, r) => {
      const y = 138 + r * 106;
      g.fillStyle = p.color;
      g.fillRect(20, y + 8, 6, 84);
      g.fillStyle = INK.text;
      g.font = `900 21px ${SANS}`;
      g.fillText(clip(g, p.name, 240), 36, y + 44);
      g.fillStyle = INK.dim;
      g.font = `700 15px ${SANS}`;
      g.fillText(p.short, 36, y + 68);
      accts.forEach((a, i) => {
        const e = bt.evals.find((x) => x.playbook === p.id && x.accountId === a.id);
        const x = x0 + i * cw + 4;
        const c = !e ? INK.dim : e.result === 'passed' ? INK.up : e.result === 'busted' ? INK.down : INK.warn;
        g.fillStyle = e?.result === 'passed' ? 'rgba(46,230,166,.14)' : e?.result === 'busted' ? 'rgba(255,93,115,.12)' : INK.panel;
        rr(g, x, y, cw - 8, 98, 10);
        g.fill();
        if (!e) return;
        g.fillStyle = c;
        g.font = `900 19px ${SANS}`;
        g.fillText(e.result === 'passed' ? 'PASSED' : e.result === 'busted' ? 'BUSTED' : 'IN PROGRESS', x + 10, y + 30);
        g.fillStyle = INK.text;
        g.font = `900 20px ${MONO}`;
        g.fillText(money(e.pnl), x + 10, y + 60);
        g.fillStyle = INK.dim;
        g.font = `700 14px ${SANS}`;
        g.fillText(`${e.days} day${e.days === 1 ? '' : 's'}`, x + 10, y + 84);
      });
    });
  }
}

export class PaperBoard extends Screen {
  constructor() {
    super(1200, 600);
  }
  draw(s: TradingSnapshot, _role: FloorRole, now: number) {
    const g = this.g;
    const book = s.paper;
    this.header('📒 Paper book', `today ${book.todayR >= 0 ? '+' : ''}${book.todayR}R · ${money(book.todayDollars)}/micro`, s, INK.up);
    // Every playbook's running record since the office started tracking.
    const cw = (this.W - 40 - 3 * 10) / 4;
    book.stats.forEach((st, i) => {
      const p = PLAYBOOK_BY_ID[st.playbook];
      const x = 20 + i * (cw + 10);
      g.fillStyle = INK.panel;
      rr(g, x, 92, cw, 128, 12);
      g.fill();
      g.fillStyle = p.color;
      g.fillRect(x + 12, 102, cw - 24, 4);
      g.fillStyle = INK.text;
      g.font = `900 18px ${SANS}`;
      g.fillText(clip(g, p.name, cw - 24), x + 12, 130);
      g.font = `900 24px ${MONO}`;
      g.fillStyle = tone(st.totalR);
      g.fillText(`${st.totalR >= 0 ? '+' : ''}${st.totalR}R`, x + 12, 162);
      g.fillStyle = INK.dim;
      g.font = `700 15px ${SANS}`;
      g.fillText(`${st.trades} trades · ${Math.round(st.winRate * 100)}% win`, x + 12, 186);
      sparkline(g, x + 12, 194, cw - 24, 20, st.curve, p.color);
    });
    const list = [...book.today, ...book.recent].slice(0, 7);
    if (!list.length) {
      g.fillStyle = INK.dim;
      g.font = `800 24px ${SANS}`;
      g.fillText('No paper trades yet: every setup the playbooks take lands here on its own.', 28, 290);
      return;
    }
    list.forEach((t, i) => {
      const y = 232 + i * 51;
      const q = quoteOf(s, t.symbol);
      const p = PLAYBOOK_BY_ID[t.playbook];
      g.fillStyle = i % 2 ? INK.bg : INK.panel;
      rr(g, 20, y, this.W - 40, 46, 8);
      g.fill();
      g.fillStyle = p.color;
      g.fillRect(20, y + 8, 5, 30);
      g.fillStyle = INK.dim;
      g.font = `800 16px ${MONO}`;
      g.fillText(t.day.slice(5), 34, y + 29);
      g.fillStyle = INSTRUMENTS[t.symbol].ink;
      g.font = `900 20px ${MONO}`;
      g.fillText(t.symbol, 100, y + 30);
      g.fillStyle = t.side === 'long' ? INK.up : INK.down;
      g.font = `900 16px ${SANS}`;
      g.fillText(t.side.toUpperCase(), 164, y + 29);
      g.fillStyle = INK.text;
      g.font = `800 17px ${SANS}`;
      g.fillText(clip(g, `${p.short} · ${t.why}`, 560), 230, y + 29);
      g.font = `800 17px ${MONO}`;
      g.fillStyle = INK.dim;
      g.fillText(`${fmt(t.entry, q?.decimals ?? 2)} → ${t.exit == null ? 'open' : fmt(t.exit, q?.decimals ?? 2)}`, 800, y + 29);
      g.textAlign = 'right';
      g.fillStyle = t.outcome === 'open' ? INK.info : tone(t.r);
      g.font = `900 20px ${MONO}`;
      g.fillText(t.outcome === 'open' ? `LIVE ${t.r >= 0 ? '+' : ''}${t.r}R` : `${t.r >= 0 ? '+' : ''}${t.r}R`, this.W - 36, y + 30);
      g.textAlign = 'left';
    });
    void now;
  }
}

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
export class TickerStrip extends Screen {
  constructor() {
    super(4096, 64);
  }
  draw(s: TradingSnapshot, _role: FloorRole, now: number) {
    const g = this.g;
    g.fillStyle = '#080c16';
    g.fillRect(0, 0, this.W, this.H);
    g.fillStyle = INK.warn;
    g.fillRect(0, 0, this.W, 2);
    g.fillRect(0, this.H - 2, this.W, 2);
    g.font = `900 39px ${MONO}`;
    const cells: { label: string; ink: string; price: string; changePct: number }[] = [
      ...s.quotes.map((q) => ({ label: q.symbol, ink: q.ink, price: fmt(q.last, q.decimals), changePct: q.changePct })),
      ...s.context.map((c) => ({ label: c.id, ink: '#a7b4d4', price: fmt(c.last, c.decimals), changePct: c.changePct })),
    ];
    const bell = bellText(s);
    const texts = cells.map((c) => `${c.label}  ${c.price}  ${c.changePct >= 0 ? '▲' : '▼'} ${pct(c.changePct)}`);
    const gapPx = 90;
    const widths = [...texts.map((t) => g.measureText(t).width + gapPx), g.measureText(bell).width + gapPx];
    const total = widths.reduce((a, b) => a + b, 0);
    const offset = ((now / 1000) * 85) % total;
    for (let rep = -1; rep < Math.ceil(this.W / total) + 1; rep++) {
      let x = rep * total - offset;
      cells.forEach((c, i) => {
        g.fillStyle = c.ink;
        g.fillText(c.label, x, 46);
        const lw = g.measureText(`${c.label}  `).width;
        g.fillStyle = INK.text;
        g.fillText(c.price, x + lw, 46);
        const pw = g.measureText(`${c.price}  `).width;
        g.fillStyle = tone(c.changePct);
        g.fillText(`${c.changePct >= 0 ? '▲' : '▼'} ${pct(c.changePct)}`, x + lw + pw, 46);
        x += widths[i]!;
      });
      g.fillStyle = INK.warn;
      g.fillText(bell, x, 46);
    }
  }
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
