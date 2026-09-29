import * as THREE from 'three';
import type { Bar, FloorRole, Levels, Quote, TradingSnapshot } from '../../shared/trading';
import { SYMBOLS } from '../../shared/trading';

// Every screen and board on the trading floors: canvases drawn from one snapshot, the way a desk's
// monitors all read the same tape. Dark terminal cards on the office's warm walls.

export const INK = { bg: '#0f1522', panel: '#18213a', line: '#26314f', text: '#e8edf5', dim: '#8391ad', up: '#2ee6a6', down: '#ff5d73', warn: '#ffd166', info: '#5cc8ff' };
const SANS = 'Nunito, ui-rounded, system-ui, sans-serif';
const MONO = 'ui-monospace, Menlo, Consolas, monospace';

export const fmt = (v: number | null | undefined, decimals = 2) => (v == null || !Number.isFinite(v) ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }));
const sign = (v: number) => (v > 0 ? '+' : v < 0 ? '−' : '');
export const pct = (v: number) => `${sign(v)}${Math.abs(v).toFixed(2)}%`;
const tone = (v: number) => (v >= 0 ? INK.up : INK.down);

function rr(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}

function clip(g: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (g.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && g.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t}…`;
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

/** A screen: a canvas texture and how to redraw it from a snapshot. */
export abstract class Screen {
  readonly texture: THREE.CanvasTexture;
  protected canvas: HTMLCanvasElement;
  protected g: CanvasRenderingContext2D;
  constructor(protected W: number, protected H: number) {
    const t = texture(W, H);
    this.canvas = t.canvas;
    this.g = t.g;
    this.texture = t.tex;
  }
  abstract draw(s: TradingSnapshot, role: FloorRole, now: number): void;
  render(s: TradingSnapshot | null, role: FloorRole) {
    if (!s) return;
    const g = this.g;
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    this.draw(s, role, Date.now());
    this.texture.needsUpdate = true;
  }
  protected header(title: string, right: string, s: TradingSnapshot) {
    const g = this.g;
    g.fillStyle = INK.bg;
    g.fillRect(0, 0, this.W, this.H);
    g.fillStyle = INK.panel;
    g.fillRect(0, 0, this.W, 78);
    g.fillStyle = INK.text;
    g.font = `900 40px ${SANS}`;
    g.fillText(title, 32, 52);
    const titleW = g.measureText(title).width;
    g.textAlign = 'right';
    g.fillStyle = INK.dim;
    g.font = `800 26px ${MONO}`;
    g.fillText(`${right}${right ? '  ·  ' : ''}${s.session.time} PT`, this.W - 32, 50);
    g.textAlign = 'left';
    if (s.source === 'sample') {
      g.font = `900 18px ${SANS}`;
      g.fillStyle = 'rgba(255,209,102,.16)';
      rr(g, 32 + titleW + 20, 26, 132, 30, 15);
      g.fill();
      g.fillStyle = INK.warn;
      g.fillText('SAMPLE FEED', 32 + titleW + 34, 47);
    }
  }
}

/** Candles, VWAP and the day's levels, scaled to what's on screen. */
export function drawChart(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, bars: Bar[], q: Quote, lv: Levels | null, opts: { levels?: boolean; grid?: boolean; tag?: boolean } = {}) {
  if (!bars.length) return;
  let lo = Math.min(...bars.map((b) => b.low));
  let hi = Math.max(...bars.map((b) => b.high));
  if (opts.levels && lv) {
    // Levels only count when they're near the tape; a far level shouldn't squash the candles.
    const pad = (hi - lo) * 0.35;
    for (const v of [lv.vwap, lv.vwapU1, lv.vwapL1, lv.orHigh, lv.orLow, lv.priorHigh, lv.priorLow]) if (v != null && v > lo - pad && v < hi + pad) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  }
  const span = hi - lo || q.tick;
  lo -= span * 0.06;
  hi += span * 0.06;
  const py = (v: number) => y + h - ((v - lo) / (hi - lo)) * h;
  const tagW = opts.tag ? Math.min(150, w * 0.2) : 0;
  const cw = (w - tagW) / bars.length;
  if (opts.grid) {
    g.strokeStyle = INK.line;
    g.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const gy = y + (h * i) / 4;
      g.beginPath();
      g.moveTo(x, gy);
      g.lineTo(x + w - tagW, gy);
      g.stroke();
    }
  }
  const line = (v: number | null, color: string, dash: number[] = [], label?: string) => {
    if (v == null || v < lo || v > hi) return;
    g.strokeStyle = color;
    g.lineWidth = 2;
    g.setLineDash(dash);
    g.beginPath();
    g.moveTo(x, py(v));
    g.lineTo(x + w - tagW, py(v));
    g.stroke();
    g.setLineDash([]);
    if (label && opts.tag) {
      g.fillStyle = color;
      g.font = `800 ${Math.max(11, h * 0.06)}px ${MONO}`;
      g.fillText(label, x + w - tagW + 6, py(v) + 4);
    }
  };
  if (opts.levels && lv) {
    line(lv.vwapU1, 'rgba(255,209,102,.35)', [6, 6]);
    line(lv.vwapL1, 'rgba(255,209,102,.35)', [6, 6]);
    line(lv.priorHigh, 'rgba(156,110,255,.7)', [3, 5], 'PDH');
    line(lv.priorLow, 'rgba(156,110,255,.7)', [3, 5], 'PDL');
    line(lv.orHigh, 'rgba(92,200,255,.7)', [10, 4], 'ORH');
    line(lv.orLow, 'rgba(92,200,255,.7)', [10, 4], 'ORL');
    line(lv.vwap, INK.warn, [], 'VWAP');
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
  if (opts.tag) {
    const last = bars[bars.length - 1]!.close;
    const ty = Math.min(y + h - 16, Math.max(y + 14, py(last)));
    g.fillStyle = tone(q.change);
    rr(g, x + w - tagW, ty - 14, tagW - 4, 28, 6);
    g.fill();
    g.fillStyle = INK.bg;
    const label = fmt(last, q.decimals);
    g.font = `900 ${Math.max(9, Math.min(h * 0.06, (tagW - 12) / (label.length * 0.62)))}px ${MONO}`;
    g.textAlign = 'center';
    g.fillText(label, x + w - tagW / 2 - 2, ty + 5);
    g.textAlign = 'left';
  }
}

// ---- The Pit: news, proposals, playbook, connectors ----------------------------------------------
export class NewsBoard extends Screen {
  constructor() {
    super(1200, 600);
  }
  draw(s: TradingSnapshot) {
    const g = this.g;
    this.header('📰 News & catalysts', 'MNQ · MES · MBT · BTC', s);
    const now = s.session.minutes;
    // Upcoming first, then what already printed, most recent on top.
    const items = [...s.news].sort((a, b) => ((a.at >= now ? 0 : 1) - (b.at >= now ? 0 : 1)) || (a.at >= now ? a.at - b.at : b.at - a.at)).slice(0, 7);
    const rowH = 64;
    items.forEach((n, i) => {
      const y = 96 + i * (rowH + 4);
      const past = n.at < now;
      g.globalAlpha = past ? 0.45 : 1;
      g.fillStyle = i % 2 ? INK.bg : INK.panel;
      g.fillRect(20, y, this.W - 40, rowH);
      g.fillStyle = INK.text;
      g.font = `900 28px ${MONO}`;
      g.fillText(n.time, 36, y + 42);
      const c = n.impact === 'high' ? INK.down : n.impact === 'med' ? INK.warn : INK.dim;
      g.fillStyle = c;
      rr(g, 140, y + 16, 84, 32, 8);
      g.fill();
      g.fillStyle = INK.bg;
      g.font = `900 19px ${SANS}`;
      g.textAlign = 'center';
      g.fillText(n.impact.toUpperCase(), 182, y + 39);
      g.textAlign = 'left';
      g.fillStyle = INK.text;
      g.font = `800 27px ${SANS}`;
      g.fillText(clip(g, `${n.kind === 'calendar' ? '🗓 ' : ''}${n.headline}`, 640), 244, y + 42);
      g.fillStyle = INK.info;
      g.font = `800 20px ${MONO}`;
      g.textAlign = 'right';
      g.fillText(n.symbols.join(' '), this.W - 36, y + 40);
      g.textAlign = 'left';
      g.globalAlpha = 1;
    });
    g.fillStyle = INK.dim;
    g.font = `700 20px ${SANS}`;
    g.fillText('Sample headlines. Connect a news source and Scout reads the real ones.', 32, this.H - 14);
  }
}

const stageColor = (stage: string) => (stage === 'ready' ? INK.warn : stage === 'paper' ? INK.info : stage === 'graduated' ? INK.up : stage === 'skipped' ? INK.dim : INK.line);

export class ProposalsBoard extends Screen {
  constructor() {
    super(1200, 600);
  }
  draw(s: TradingSnapshot, role: FloorRole, now: number) {
    const g = this.g;
    const desk = role === 'desk';
    this.header(desk ? '🎫 Trade tickets' : '🎯 Trade proposals', desk ? 'you click the order' : 'VWAP · S/R', s);
    const list = (desk ? s.proposals.filter((p) => p.stage === 'graduated') : s.proposals.filter((p) => p.stage !== 'skipped')).slice(0, 8);
    if (!list.length) {
      g.fillStyle = INK.dim;
      g.textAlign = 'center';
      g.font = `900 40px ${SANS}`;
      g.fillText(desk ? 'Nothing has graduated yet' : 'Nothing to propose', this.W / 2, 320);
      g.font = `700 26px ${SANS}`;
      g.fillText(desk ? 'Prove a setup on The Pit first' : 'Vex and Ledge are waiting on the tape', this.W / 2, 366);
      g.textAlign = 'left';
      return;
    }
    const cols = 4;
    const cw = (this.W - 40 - (cols - 1) * 14) / cols;
    const ch = 236;
    list.forEach((p, i) => {
      const x = 20 + (i % cols) * (cw + 14);
      const y = 94 + Math.floor(i / cols) * (ch + 12);
      const spec = s.quotes.find((q) => q.symbol === p.symbol)!;
      const pulse = p.stage === 'ready' ? 0.5 + 0.5 * Math.sin(now / 260) : 0;
      g.fillStyle = INK.panel;
      rr(g, x, y, cw, ch, 14);
      g.fill();
      g.lineWidth = p.stage === 'ready' ? 3 + pulse * 3 : 2;
      g.strokeStyle = stageColor(p.stage);
      g.stroke();
      g.fillStyle = spec.ink;
      g.font = `900 34px ${MONO}`;
      g.fillText(p.symbol, x + 16, y + 44);
      g.fillStyle = p.side === 'long' ? INK.up : INK.down;
      rr(g, x + cw - 92, y + 16, 76, 30, 8);
      g.fill();
      g.fillStyle = INK.bg;
      g.font = `900 19px ${SANS}`;
      g.textAlign = 'center';
      g.fillText(p.side.toUpperCase(), x + cw - 54, y + 38);
      g.textAlign = 'left';
      g.fillStyle = INK.dim;
      g.font = `800 19px ${SANS}`;
      g.fillText(`${p.agent} · ${p.strategy}`, x + 16, y + 72);
      g.fillStyle = INK.text;
      g.font = `800 22px ${SANS}`;
      g.fillText(clip(g, p.title, cw - 32), x + 16, y + 102);
      const rows: [string, number, string][] = [['ENTRY', p.entry, INK.text], ['STOP', p.stop, INK.down], ['TARGET', p.target, INK.up]];
      rows.forEach(([label, v, c], k) => {
        g.fillStyle = INK.dim;
        g.font = `800 17px ${SANS}`;
        g.fillText(label, x + 16, y + 132 + k * 28);
        g.fillStyle = c;
        g.font = `900 22px ${MONO}`;
        g.textAlign = 'right';
        g.fillText(fmt(v, spec.decimals), x + cw - 16, y + 133 + k * 28);
        g.textAlign = 'left';
      });
      g.fillStyle = stageColor(p.stage);
      g.font = `900 19px ${SANS}`;
      g.fillText(p.stage === 'ready' ? '● AT ENTRY' : p.stage.toUpperCase(), x + 16, y + ch - 14);
      g.textAlign = 'right';
      g.fillStyle = INK.warn;
      g.font = `900 24px ${MONO}`;
      g.fillText(`${p.r}R`, x + cw - 16, y + ch - 12);
      g.textAlign = 'left';
    });
  }
}

export class PlaybookBoard extends Screen {
  constructor() {
    super(1200, 600);
  }
  draw(s: TradingSnapshot) {
    const g = this.g;
    const done = s.playbook.filter((p) => p.done).length;
    this.header('📋 Playbook', `${done}/${s.playbook.length} done`, s);
    s.playbook.forEach((p, i) => {
      const y = 100 + i * 66;
      g.fillStyle = i % 2 ? INK.bg : INK.panel;
      g.fillRect(20, y, this.W - 40, 62);
      g.strokeStyle = p.done ? INK.up : INK.dim;
      g.lineWidth = 4;
      rr(g, 40, y + 14, 34, 34, 8);
      g.stroke();
      if (p.done) {
        g.fillStyle = INK.up;
        g.font = `900 34px ${SANS}`;
        g.fillText('✓', 43, y + 44);
      }
      g.fillStyle = p.done ? INK.dim : INK.text;
      g.font = `800 28px ${SANS}`;
      g.fillText(clip(g, p.label, 800), 96, y + 42);
      g.fillStyle = INK.info;
      g.font = `800 22px ${SANS}`;
      g.textAlign = 'right';
      g.fillText(p.owner, this.W - 40, y + 40);
      g.textAlign = 'left';
    });
    g.fillStyle = INK.line;
    g.fillRect(20, this.H - 34, this.W - 40, 10);
    g.fillStyle = INK.up;
    g.fillRect(20, this.H - 34, ((this.W - 40) * done) / Math.max(1, s.playbook.length), 10);
  }
}

const STATUS_COLOR: Record<string, string> = { live: INK.up, sample: INK.warn, stub: INK.info, locked: INK.down, off: INK.dim };

export class ConnectorsBoard extends Screen {
  constructor() {
    super(1200, 600);
  }
  draw(s: TradingSnapshot) {
    const g = this.g;
    this.header('🔌 Connectors', 'discover · allow · route', s);
    s.connectors.forEach((c, i) => {
      const y = 96 + i * 82;
      g.fillStyle = INK.panel;
      g.fillRect(20, y, this.W - 40, 74);
      g.fillStyle = STATUS_COLOR[c.status] ?? INK.dim;
      g.beginPath();
      g.arc(58, y + 37, 12, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = INK.text;
      g.font = `900 30px ${SANS}`;
      g.fillText(c.name, 90, y + 36);
      g.fillStyle = INK.dim;
      g.font = `700 21px ${SANS}`;
      g.fillText(clip(g, c.note, 760), 90, y + 62);
      g.fillStyle = STATUS_COLOR[c.status] ?? INK.dim;
      g.font = `900 22px ${MONO}`;
      g.textAlign = 'right';
      g.fillText(c.status.toUpperCase(), this.W - 40, y + 44);
      g.textAlign = 'left';
    });
  }
}

// ---- The Desk: Bulwark's read on each graduated setup ---------------------------------------------
export class TicketsBoard extends Screen {
  constructor() {
    super(1200, 600);
  }
  draw(s: TradingSnapshot) {
    const g = this.g;
    this.header('✅ Bulwark · rules check', s.account.name, s);
    if (!s.tickets.length) {
      g.fillStyle = INK.dim;
      g.textAlign = 'center';
      g.font = `900 38px ${SANS}`;
      g.fillText('No tickets yet', this.W / 2, 320);
      g.font = `700 26px ${SANS}`;
      g.fillText('A setup appears here once it graduates from The Pit', this.W / 2, 366);
      g.textAlign = 'left';
      return;
    }
    s.tickets.slice(0, 2).forEach((t, i) => {
      const y = 96 + i * 250;
      const q = s.quotes.find((x) => x.symbol === t.symbol)!;
      g.fillStyle = INK.panel;
      g.fillRect(20, y, this.W - 40, 236);
      g.fillStyle = q.ink;
      g.font = `900 40px ${MONO}`;
      g.fillText(t.symbol, 40, y + 52);
      g.fillStyle = t.side === 'long' ? INK.up : INK.down;
      g.font = `900 30px ${SANS}`;
      g.fillText(`${t.side.toUpperCase()} ${t.contracts}×`, 40, y + 96);
      g.fillStyle = INK.text;
      g.font = `900 24px ${MONO}`;
      g.fillText(`E ${fmt(t.entry, q.decimals)}`, 40, y + 136);
      g.fillStyle = INK.down;
      g.fillText(`S ${fmt(t.stop, q.decimals)}`, 40, y + 168);
      g.fillStyle = INK.up;
      g.fillText(`T ${fmt(t.target, q.decimals)}`, 40, y + 200);
      g.fillStyle = INK.dim;
      g.font = `800 20px ${SANS}`;
      g.fillText(`risk $${t.riskDollars} · reward $${t.rewardDollars}`, 260, y + 52);
      t.checks.slice(0, 7).forEach((c, k) => {
        g.fillStyle = c.ok ? INK.up : INK.down;
        g.font = `900 22px ${SANS}`;
        g.fillText(`${c.ok ? '✓' : '✗'} ${c.label}`, 260 + (k % 2) * 460, y + 92 + Math.floor(k / 2) * 32);
      });
      g.textAlign = 'right';
      g.fillStyle = t.cleared ? INK.up : INK.down;
      g.font = `900 30px ${SANS}`;
      g.fillText(t.cleared ? 'CLEARED' : 'STAND DOWN', this.W - 40, y + 52);
      g.textAlign = 'left';
    });
  }
}

// ---- The big screens: the market map on the TV, the tape along the wall ------------------------------
export function bellText(s: TradingSnapshot): string {
  const n = s.session.nextBell.inSeconds;
  const t = `${String(Math.floor(n / 3600)).padStart(2, '0')}:${String(Math.floor((n % 3600) / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
  return `${s.session.nextBell.kind === 'open' ? '🔔 Open bell' : '🔔 Close bell'} in ${t}`;
}

export class MarketMap extends Screen {
  constructor() {
    super(1280, 720);
  }
  draw(s: TradingSnapshot, role: FloorRole) {
    const g = this.g;
    this.header(role === 'desk' ? '🌃 The Desk · market map' : '📈 The Pit · market map', s.session.phase.toUpperCase(), s);
    const gap = 16;
    const cw = (this.W - 40 - gap) / 2;
    const ch = (this.H - 78 - 72 - gap) / 2;
    SYMBOLS.forEach((sym, i) => {
      const q = s.quotes.find((x) => x.symbol === sym)!;
      const x = 20 + (i % 2) * (cw + gap);
      const y = 94 + Math.floor(i / 2) * (ch + gap);
      g.fillStyle = INK.panel;
      rr(g, x, y, cw, ch, 14);
      g.fill();
      g.fillStyle = q.ink;
      g.font = `900 40px ${MONO}`;
      g.fillText(sym, x + 18, y + 48);
      g.fillStyle = INK.text;
      g.font = `900 34px ${MONO}`;
      g.textAlign = 'right';
      g.fillText(fmt(q.last, q.decimals), x + cw - 18, y + 46);
      g.fillStyle = tone(q.change);
      g.font = `800 22px ${MONO}`;
      g.fillText(`${sign(q.change)}${fmt(Math.abs(q.change), q.decimals)}  ${pct(q.changePct)}`, x + cw - 18, y + 76);
      g.textAlign = 'left';
      drawChart(g, x + 14, y + 90, cw - 28, ch - 104, s.bars[sym].slice(-70), q, s.levels[sym], { levels: true, tag: true });
    });
    g.fillStyle = INK.panel;
    g.fillRect(0, this.H - 62, this.W, 62);
    g.fillStyle = INK.warn;
    g.font = `900 28px ${SANS}`;
    g.fillText(bellText(s), 28, this.H - 20);
    g.textAlign = 'right';
    g.fillStyle = s.account.armed ? INK.up : INK.dim;
    g.fillText(role === 'desk' ? (s.account.armed ? '● ARMED' : '○ STANDING DOWN') : `${s.account.name} · paper`, this.W - 28, this.H - 20);
    g.textAlign = 'left';
  }
}

/** The tape that runs the length of the wall. It scrolls with the clock, so every screen agrees where it is. */
export class TickerStrip extends Screen {
  constructor() {
    super(2048, 128);
  }
  draw(s: TradingSnapshot, _role: FloorRole, now: number) {
    const g = this.g;
    g.fillStyle = '#080c16';
    g.fillRect(0, 0, this.W, this.H);
    g.fillStyle = INK.warn;
    g.fillRect(0, 0, this.W, 4);
    g.fillRect(0, this.H - 4, this.W, 4);
    g.font = `900 58px ${MONO}`;
    const cells = s.quotes.map((q) => ({ q, text: `${q.symbol}  ${fmt(q.last, q.decimals)}  ${q.change >= 0 ? '▲' : '▼'} ${pct(q.changePct)}` }));
    const gapPx = 110;
    const widths = cells.map((c) => g.measureText(c.text).width + gapPx);
    const total = widths.reduce((a, b) => a + b, 0);
    const offset = ((now / 1000) * 90) % total;
    // Repeat the tape as often as it takes to cover the strip.
    for (let rep = -1; rep < Math.ceil(this.W / total) + 1; rep++) {
      let x = rep * total - offset;
      cells.forEach((c, i) => {
        g.fillStyle = c.q.ink;
        g.fillText(c.q.symbol, x, 82);
        const symW = g.measureText(`${c.q.symbol}  `).width;
        g.fillStyle = INK.text;
        g.fillText(fmt(c.q.last, c.q.decimals), x + symW, 82);
        const priceW = g.measureText(`${fmt(c.q.last, c.q.decimals)}  `).width;
        g.fillStyle = tone(c.q.change);
        g.fillText(`${c.q.change >= 0 ? '▲' : '▼'} ${pct(c.q.changePct)}`, x + symW + priceW, 82);
        x += widths[i]!;
      });
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
  const cell = w / s.quotes.length;
  const fs = Math.round(bar * 0.42);
  g.font = `900 ${fs}px ${MONO}`;
  g.textBaseline = 'middle';
  s.quotes.forEach((q, i) => {
    const x = i * cell + 10;
    g.fillStyle = q.ink;
    g.fillText(q.symbol, x, h - bar / 2 + 1);
    g.fillStyle = tone(q.change);
    g.font = `800 ${Math.round(fs * 0.9)}px ${MONO}`;
    g.fillText(`${fmt(q.last, q.decimals)}`, x + g.measureText(`${q.symbol} `).width + fs * 0.6, h - bar / 2 + 1);
    g.font = `900 ${fs}px ${MONO}`;
  });
  g.textBaseline = 'alphabetic';
}

/** The chart a laptop shows while its worker has nothing on the terminal. */
export function paintLaptopChart(g: CanvasRenderingContext2D, w: number, h: number, s: TradingSnapshot | null, symbol: (typeof SYMBOLS)[number]) {
  g.fillStyle = INK.bg;
  g.fillRect(0, 0, w, h);
  if (!s) return;
  const q = s.quotes.find((x) => x.symbol === symbol)!;
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
  drawChart(g, 14, h * 0.2, w - 28, h * 0.68 - h * 0.04, s.bars[symbol].slice(-64), q, s.levels[symbol], { levels: true, grid: true, tag: true });
}
