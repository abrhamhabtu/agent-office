import type { FloorRole, PlaybookId, TradingSnapshot } from '../../shared/trading';
import { INSTRUMENTS, PLAYBOOK_BY_ID, PLAYBOOKS, PROP_ACCOUNTS } from '../../shared/trading';
import { FARM_PROGRAM_BY_ID, strategyLabel } from '../../shared/farm';
import { clip, fmt, INK, money, Screen } from './screens';

// The Back Office's three wall displays: the backtest, the eval simulator and the paper book. They're read
// from across the room, so each leads with one big answer (the best edge, how many accounts pass, today's
// result) and keeps the rest to cards with room around them. The backtest and the eval simulator open
// their consoles when clicked, and say so along the bottom.

const SANS = 'Nunito, ui-rounded, system-ui, sans-serif';
const MONO = 'ui-monospace, Menlo, Consolas, monospace';
const C = { bg0: '#0d1324', bg1: '#070a13', card: '#121a2e', card2: '#17213a', line: '#222e4d', text: '#eef2fa', dim: '#8b98b8', faint: '#566385' };
const tone = (v: number) => (v > 0 ? INK.up : v < 0 ? INK.down : C.dim);
const signed = (v: number, d = 2) => `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(d)}`;
type G = CanvasRenderingContext2D;

function card(g: G, x: number, y: number, w: number, h: number, fill = C.card, r = 16) {
  g.fillStyle = fill;
  g.beginPath();
  g.roundRect(x, y, w, h, r);
  g.fill();
  g.strokeStyle = C.line;
  g.lineWidth = 1.5;
  g.stroke();
}

/** Small spaced capitals: a label over a number. */
function kicker(g: G, text: string, x: number, y: number, color = C.dim, size = 13) {
  g.fillStyle = color;
  g.font = `800 ${size}px ${MONO}`;
  g.letterSpacing = '2px';
  g.fillText(text.toUpperCase(), x, y);
  g.letterSpacing = '0px';
}

function pill(g: G, text: string, x: number, y: number, bg: string, fg: string, size = 13, right = false): number {
  g.font = `900 ${size}px ${MONO}`;
  const w = g.measureText(text).width + size * 1.5;
  const px = right ? x - w : x;
  g.fillStyle = bg;
  g.beginPath();
  g.roundRect(px, y, w, size * 1.9, size);
  g.fill();
  g.fillStyle = fg;
  g.fillText(text, px + size * 0.75, y + size * 1.32);
  return w;
}

/** A line with a soft fill under it, and a dot on where it stands now. */
function curve(g: G, x: number, y: number, w: number, h: number, values: number[], color: string) {
  const pts = [0, ...values];
  if (pts.length < 3) {
    g.strokeStyle = C.line;
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(x, y + h / 2);
    g.lineTo(x + w, y + h / 2);
    g.stroke();
    return;
  }
  const lo = Math.min(...pts);
  const hi = Math.max(...pts);
  const span = hi - lo || 1;
  const px = (i: number) => x + (i / (pts.length - 1)) * w;
  const py = (v: number) => y + h - ((v - lo) / span) * h;
  const grad = g.createLinearGradient(0, y, 0, y + h);
  grad.addColorStop(0, `${color}55`);
  grad.addColorStop(1, `${color}00`);
  g.beginPath();
  pts.forEach((v, i) => (i ? g.lineTo(px(i), py(v)) : g.moveTo(px(i), py(v))));
  g.lineTo(x + w, y + h);
  g.lineTo(x, y + h);
  g.closePath();
  g.fillStyle = grad;
  g.fill();
  g.beginPath();
  pts.forEach((v, i) => (i ? g.lineTo(px(i), py(v)) : g.moveTo(px(i), py(v))));
  g.strokeStyle = color;
  g.lineWidth = 3;
  g.lineJoin = 'round';
  g.stroke();
  g.fillStyle = color;
  g.beginPath();
  g.arc(x + w, py(pts[pts.length - 1]!), 4.5, 0, Math.PI * 2);
  g.fill();
}

/** A number with a glow in its own colour: the one thing on the board to read first. */
function glow(g: G, text: string, x: number, y: number, size: number, color: string) {
  g.save();
  g.font = `900 ${size}px ${MONO}`;
  g.shadowColor = color;
  g.shadowBlur = size * 0.35;
  g.fillStyle = color;
  g.fillText(text, x, y);
  g.restore();
}

abstract class Board extends Screen {
  constructor() {
    super(1200, 600);
  }
  /** The background, the title bar and the line along the bottom. */
  protected frame(s: TradingSnapshot, title: string, sub: string, accent: string, foot: string, action?: string) {
    const g = this.g;
    const { W, H } = this;
    const bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, C.bg0);
    bg.addColorStop(1, C.bg1);
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);
    // A wash of the board's colour in the corner the title sits in.
    const wash = g.createRadialGradient(0, 0, 0, 0, 0, 520);
    wash.addColorStop(0, `${accent}2e`);
    wash.addColorStop(1, `${accent}00`);
    g.fillStyle = wash;
    g.fillRect(0, 0, W, H);
    g.fillStyle = accent;
    g.beginPath();
    g.roundRect(24, 22, 7, 40, 4);
    g.fill();
    g.fillStyle = C.text;
    g.font = `900 34px ${SANS}`;
    g.fillText(title, 44, 53);
    const tw = g.measureText(title).width;
    kicker(g, sub, 44 + tw + 18, 50, C.dim, 14);
    pill(g, `● ${s.session.time.slice(0, 5)} PT`, W - 24, 26, '#ffffff12', C.text, 15, true);
    g.fillStyle = C.line;
    g.fillRect(24, 76, W - 48, 1.5);
    g.fillStyle = C.faint;
    g.font = `700 14px ${SANS}`;
    g.fillText(clip(g, foot, W - (action ? 420 : 60)), 26, H - 16);
    if (action) {
      g.textAlign = 'right';
      g.fillStyle = accent;
      g.font = `900 14px ${MONO}`;
      g.letterSpacing = '1.5px';
      g.fillText(`${action.toUpperCase()}  ›`, W - 26, H - 16);
      g.letterSpacing = '0px';
      g.textAlign = 'left';
    }
  }
  protected waitingFor(line1: string, line2: string) {
    const g = this.g;
    g.textAlign = 'center';
    g.fillStyle = C.text;
    g.font = `900 34px ${SANS}`;
    g.fillText(line1, this.W / 2, this.H / 2);
    g.fillStyle = C.dim;
    g.font = `700 20px ${SANS}`;
    g.fillText(line2, this.W / 2, this.H / 2 + 38);
    g.textAlign = 'left';
  }
}

// ---- 🧪 The backtest -------------------------------------------------------------------------------------
export class BacktestBoard extends Board {
  draw(s: TradingSnapshot) {
    const g = this.g;
    const bt = s.backtest;
    const ACCENT = '#f15bb5';
    this.frame(s, 'Backtest lab', bt ? (bt.running ? 'replaying the month' : `${bt.days.length} real days · NQ ES GC BTC`) : 'queued', ACCENT, 'Real 1-minute bars · fills on the signal candle’s close · no fees or slippage', 'Click to open the lab');
    if (!bt || !bt.stats.length) return this.waitingFor(bt?.running ? 'Replaying the month…' : 'No backtest yet', 'Every playbook, every market, a month of real bars');

    // The one answer: where the edge is.
    card(g, 24, 94, 372, 280, C.card2);
    kicker(g, 'Best edge this month', 46, 128, ACCENT);
    if (bt.best) {
      const p = PLAYBOOK_BY_ID[bt.best.playbook];
      glow(g, `${signed(bt.best.avgR)}R`, 44, 218, 76, tone(bt.best.avgR));
      g.fillStyle = C.dim;
      g.font = `800 18px ${SANS}`;
      g.fillText('a trade, on average', 48, 250);
      g.fillStyle = C.text;
      g.font = `900 24px ${SANS}`;
      g.fillText(clip(g, p.name, 330), 46, 302);
      const w = pill(g, bt.best.symbol, 46, 320, `${INSTRUMENTS[bt.best.symbol].ink}30`, INSTRUMENTS[bt.best.symbol].ink, 15);
      g.fillStyle = C.dim;
      g.font = `700 16px ${SANS}`;
      g.fillText(`${bt.best.trades} trades`, 46 + w + 12, 341);
    } else {
      g.fillStyle = C.text;
      g.font = `900 30px ${SANS}`;
      g.fillText('No clear edge yet', 46, 200);
      g.fillStyle = C.dim;
      g.font = `700 17px ${SANS}`;
      g.fillText('Nothing with 8+ trades is positive', 46, 232);
    }

    // The tuner, and the best way of mixing the playbooks.
    card(g, 24, 386, 372, 168);
    const tuner = bt.tuner;
    const cands = tuner?.books.flatMap((b) => b.versions.filter((v) => v.status === 'candidate').map((v) => ({ b, v }))) ?? [];
    const proven = cands.filter((c) => c.v.vs?.verdict === 'better');
    kicker(g, tuner?.running ? 'Tuner · running' : 'Tuner', 46, 418, proven.length ? INK.up : INK.warn);
    g.fillStyle = C.text;
    g.font = `800 17px ${SANS}`;
    const pick = proven[0] ?? cands[0];
    g.fillText(clip(g, tuner?.running ? tuner.stage || 'Trying changes…' : pick ? `${PLAYBOOK_BY_ID[pick.b.playbook].short} v${pick.v.version}: ${pick.v.vs?.verdict === 'better' ? 'tested better' : 'one to watch'}` : 'No change beat the live rules', 330), 46, 446);
    g.fillStyle = C.dim;
    g.font = `700 14px ${SANS}`;
    g.fillText(clip(g, pick && !tuner?.running ? pick.v.change.join('; ') : tuner?.replays ? `${tuner.replays} replays of the month` : 'Runs after every backtest', 330), 46, 468);
    const mix = bt.mixes?.find((m) => m.order.length > 1 && m.trades >= 20);
    kicker(g, 'Best mix', 46, 504, ACCENT);
    g.fillStyle = C.text;
    g.font = `800 15px ${SANS}`;
    g.fillText(clip(g, mix ? (mix.mode === 'fallback' ? `${mix.order.map((p) => PLAYBOOK_BY_ID[p].short).join(' → ')} as the fallback` : mix.mode === 'by-day' ? `${PLAYBOOK_BY_ID[mix.order[0]!].short} trending · ${PLAYBOOK_BY_ID[mix.order[1]!].short} ranging` : mix.order.map((p) => PLAYBOOK_BY_ID[p].short).join(' + ')) : 'Needs more trades', 330), 46, 528);
    if (mix) {
      g.fillStyle = tone(mix.avgR);
      g.font = `900 14px ${MONO}`;
      g.fillText(`${signed(mix.avgR)}R a trade · ${mix.trades} trades`, 46, 547);
    }

    // Every playbook: what a trade makes, as a bar either side of zero, and its curve.
    const x0 = 416;
    const rowH = 92;
    const zero = x0 + 500;
    const reach = 80;
    const scale = Math.max(0.3, ...PLAYBOOKS.map((p) => Math.abs(bt.stats.find((x) => x.playbook === p.id && x.symbol === 'ALL')?.avgR ?? 0)));
    PLAYBOOKS.forEach((p, i) => {
      const st = bt.stats.find((x) => x.playbook === p.id && x.symbol === 'ALL');
      const y = 94 + i * rowH;
      card(g, x0, y, this.W - x0 - 24, rowH - 10);
      g.fillStyle = p.color;
      g.beginPath();
      g.roundRect(x0 + 14, y + 16, 6, rowH - 42, 3);
      g.fill();
      g.fillStyle = C.text;
      g.font = `900 21px ${SANS}`;
      g.fillText(clip(g, p.name, 270), x0 + 34, y + 36);
      g.fillStyle = C.dim;
      g.font = `700 15px ${SANS}`;
      g.fillText(st?.trades ? `${st.trades} trades · ${Math.round(st.winRate * 100)}% win` : 'No trades yet', x0 + 34, y + 60);
      if (!st?.trades) return;
      g.fillStyle = '#ffffff0d';
      g.beginPath();
      g.roundRect(zero - reach, y + 34, reach * 2, 12, 6);
      g.fill();
      const len = Math.min(reach, (Math.abs(st.avgR) / scale) * reach);
      g.fillStyle = tone(st.avgR);
      g.beginPath();
      g.roundRect(st.avgR >= 0 ? zero : zero - len, y + 34, Math.max(4, len), 12, 6);
      g.fill();
      g.fillStyle = C.faint;
      g.fillRect(zero - 1, y + 28, 2, 24);
      g.fillStyle = tone(st.avgR);
      g.font = `900 22px ${MONO}`;
      g.textAlign = 'right';
      g.fillText(`${signed(st.avgR)}R`, zero - reach - 16, y + 48);
      g.textAlign = 'left';
      curve(g, zero + reach + 22, y + 16, this.W - 24 - (zero + reach + 22) - 20, rowH - 44, st.curve, p.color);
    });
  }
}

// ---- 🏦 The eval simulator --------------------------------------------------------------------------------
export class EvalBoard extends Board {
  draw(s: TradingSnapshot) {
    const g = this.g;
    const bt = s.backtest;
    const ACCENT = '#b794f4';
    const evals = bt?.evals ?? [];
    const passed = evals.filter((e) => e.result === 'passed');
    const busted = evals.filter((e) => e.result === 'busted').length;
    this.frame(s, 'Prop eval simulator', 'your accounts · law of 10 · NQ ES GC', ACCENT, evals.length ? `${passed.length} of ${evals.length} pass on the real month · ${busted} bust · the rest are still going` : 'Each playbook played through each account’s real rules', 'Click to pick an account');
    if (!bt || !evals.length) return this.waitingFor('Waiting on the backtest', 'Each playbook played through each account’s real rules');
    const accts = PROP_ACCOUNTS;
    const x0 = 250;
    const top = 152;
    const cw = (this.W - x0 - 24) / accts.length;
    const rh = (this.H - top - 44) / PLAYBOOKS.length;
    accts.forEach((a, i) => {
      const x = x0 + i * cw;
      kicker(g, a.firm, x + 12, 104, C.dim, 12);
      g.fillStyle = C.text;
      g.font = `900 24px ${MONO}`;
      g.fillText(`$${a.size / 1000}K`, x + 12, 132);
      const w = g.measureText(`$${a.size / 1000}K`).width;
      pill(g, a.kind === 'funded' ? 'FUNDED' : 'EVAL', x + 22 + w, 112, a.kind === 'funded' ? `${INK.warn}2a` : '#ffffff12', a.kind === 'funded' ? INK.warn : C.dim, 11);
    });
    PLAYBOOKS.forEach((p, r) => {
      const y = top + r * rh;
      g.fillStyle = p.color;
      g.beginPath();
      g.arc(34, y + rh / 2 - 8, 6, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = C.text;
      g.font = `900 18px ${SANS}`;
      g.fillText(clip(g, p.name, 190), 50, y + rh / 2 - 2);
      g.fillStyle = C.faint;
      g.font = `700 13px ${MONO}`;
      g.fillText(p.short, 50, y + rh / 2 + 17);
      accts.forEach((a, i) => {
        const e = evals.find((x) => x.playbook === p.id && x.accountId === a.id);
        const x = x0 + i * cw + 5;
        const w = cw - 10;
        const h = rh - 10;
        // The money is there but a rule isn't yet: the consistency rule, or the minimum trading days.
        const held = !!e && e.result === 'running' && e.pnl >= a.profitTarget;
        const ink = !e ? C.dim : e.result === 'passed' ? INK.up : e.result === 'busted' ? INK.down : held ? INK.info : INK.warn;
        card(g, x, y, w, h, e?.result === 'passed' ? '#12312c' : e?.result === 'busted' ? '#331822' : C.card, 12);
        if (!e) return;
        g.fillStyle = ink;
        g.font = `900 15px ${MONO}`;
        g.letterSpacing = '1px';
        g.fillText(e.result === 'passed' ? '✓ PASSED' : e.result === 'busted' ? '✕ BUSTED' : held ? 'TARGET HIT' : 'GOING', x + 12, y + 24);
        g.letterSpacing = '0px';
        g.textAlign = 'right';
        g.fillStyle = C.dim;
        g.font = `700 13px ${MONO}`;
        g.fillText(held ? '' : e.result === 'running' ? `${Math.max(0, Math.round((e.pnl / a.profitTarget) * 100))}%` : `day ${e.days}`, x + w - 12, y + 24);
        g.textAlign = 'left';
        g.fillStyle = e.result === 'running' ? tone(e.pnl) : C.text;
        g.font = `900 20px ${MONO}`;
        g.fillText(money(e.pnl), x + 12, y + 50);
        // How far towards the target it got.
        g.fillStyle = '#ffffff10';
        g.beginPath();
        g.roundRect(x + 12, y + h - 16, w - 24, 6, 3);
        g.fill();
        const frac = Math.max(0, Math.min(1, e.pnl / a.profitTarget));
        if (frac > 0) {
          g.fillStyle = ink;
          g.beginPath();
          g.roundRect(x + 12, y + h - 16, Math.max(6, (w - 24) * frac), 6, 3);
          g.fill();
        }
      });
    });
  }
}

// ---- 📒 The paper book -----------------------------------------------------------------------------------
export class PaperBoard extends Board {
  draw(s: TradingSnapshot, _role: FloorRole) {
    const g = this.g;
    const book = s.paper;
    const ACCENT = '#06d6a0';
    const all = [...book.today, ...book.recent];
    this.frame(s, 'Paper book', 'every setup, traded on paper', ACCENT, 'Filled on the signal candle’s close, tracked to its stop, its target, or flat at 13:00 PT · one micro');

    // Today, big.
    card(g, 24, 94, 372, 176, C.card2);
    kicker(g, 'Today', 46, 128, ACCENT);
    glow(g, `${signed(book.todayR)}R`, 44, 208, 70, book.today.length ? tone(book.todayR) : C.dim);
    g.fillStyle = C.dim;
    g.font = `800 17px ${SANS}`;
    const open = book.today.filter((t) => t.outcome === 'open').length;
    g.fillText(book.today.length ? `${book.today.length} trade${book.today.length === 1 ? '' : 's'}${open ? ` · ${open} live` : ''} · ${money(book.todayDollars)} a micro` : 'No setups have triggered yet', 48, 244);

    // Each playbook's running record.
    card(g, 24, 282, 372, 272);
    kicker(g, 'Since tracking began', 46, 314);
    PLAYBOOKS.forEach((p, i) => {
      const st = book.stats.find((x) => x.playbook === p.id);
      const y = 332 + i * 43;
      g.fillStyle = p.color;
      g.beginPath();
      g.arc(52, y + 14, 5, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = C.text;
      g.font = `800 15px ${SANS}`;
      g.fillText(clip(g, p.name, 156), 66, y + 13);
      g.fillStyle = C.faint;
      g.font = `700 12px ${MONO}`;
      g.fillText(st?.trades ? `${st.trades} · ${Math.round(st.winRate * 100)}% win` : 'no trades', 66, y + 30);
      if (!st?.trades) return;
      curve(g, 226, y + 2, 74, 26, st.curve, p.color);
      g.textAlign = 'right';
      g.fillStyle = tone(st.totalR);
      g.font = `900 17px ${MONO}`;
      g.fillText(`${signed(st.totalR, 1)}R`, 380, y + 20);
      g.textAlign = 'left';
    });

    // The tape of trades, newest first.
    const x0 = 416;
    const w = this.W - x0 - 24;
    card(g, x0, 94, w, 460);
    kicker(g, 'Latest trades', x0 + 22, 128);
    if (!all.length) {
      g.fillStyle = C.dim;
      g.font = `800 20px ${SANS}`;
      g.fillText('Every setup the playbooks take lands here on its own.', x0 + 22, 190);
      return;
    }
    all.slice(0, 7).forEach((t, i) => {
      const y = 144 + i * 58;
      const p = PLAYBOOK_BY_ID[t.playbook as PlaybookId];
      const d = INSTRUMENTS[t.symbol].decimals;
      if (i) {
        g.fillStyle = C.line;
        g.fillRect(x0 + 22, y, w - 44, 1);
      }
      pill(g, t.symbol, x0 + 22, y + 14, `${INSTRUMENTS[t.symbol].ink}26`, INSTRUMENTS[t.symbol].ink, 14);
      g.fillStyle = t.side === 'long' ? INK.up : INK.down;
      g.font = `900 14px ${MONO}`;
      g.fillText(t.side === 'long' ? '▲ LONG' : '▼ SHORT', x0 + 88, y + 34);
      g.fillStyle = C.text;
      g.font = `800 16px ${SANS}`;
      g.fillText(clip(g, t.why, w - 330), x0 + 176, y + 27);
      g.fillStyle = C.faint;
      g.font = `700 13px ${MONO}`;
      g.fillText(clip(g, `${p.short} · ${t.day.slice(5)} · ${fmt(t.entry, d)} → ${t.exit == null ? 'open' : fmt(t.exit, d)}`, w - 330), x0 + 176, y + 46);
      const live = t.outcome === 'open';
      pill(g, `${live ? 'LIVE ' : ''}${signed(t.r)}R`, x0 + w - 22, y + 13, live ? `${INK.info}2a` : t.r > 0 ? `${INK.up}26` : t.r < 0 ? `${INK.down}26` : '#ffffff12', live ? INK.info : tone(t.r), 16, true);
    });
  }
}

// ---- 🏁 The live eval: the office against you, day by day -------------------------------------------------
export class LiveEvalBoard extends Board {
  draw(s: TradingSnapshot) {
    const g = this.g;
    const ACCENT = '#5cc8ff';
    const le = s.liveEval;
    this.frame(s, 'Live eval', le ? `${le.firm} ${le.program.replace(/\s*\(funded\)/i, '')} · day by day` : 'not running', ACCENT, le ? clip(g, `Trading: ${le.label}`, 700) : 'The office trades an account forward on paper, a day at a time, beside your own', le ? 'Click to change it' : 'Click to start one');
    if (!le) return this.waitingFor('No live eval running', 'Open it, set an account and a plan, and press Run this live');
    const o = le.office;
    const you = le.you;
    const ink = o.result === 'passed' ? INK.up : o.result === 'busted' ? INK.down : tone(o.pnl);

    // The office.
    card(g, 24, 94, 372, 250, C.card2);
    kicker(g, `The office · since ${le.startDay.slice(5)}`, 46, 128, ACCENT);
    glow(g, money(o.pnl), 44, 206, 64, ink);
    pill(g, o.result === 'passed' ? (le.kind === 'funded' ? '✓ PAYOUT READY' : '✓ PASSED') : o.result === 'busted' ? '✕ BUSTED' : o.pnl >= o.target ? 'TARGET HIT' : 'GOING', 46, 222, `${o.result === 'running' ? INK.warn : ink}2a`, o.result === 'running' ? INK.warn : ink, 14);
    g.fillStyle = C.dim;
    g.font = `700 15px ${SANS}`;
    g.fillText(`${Math.max(0, Math.round((o.pnl / o.target) * 100))}% of ${money(o.target)} · ${money(o.cushion)} of cushion`, 46, 280);
    g.fillStyle = '#ffffff12';
    g.beginPath();
    g.roundRect(46, 292, 328, 8, 4);
    g.fill();
    const frac = Math.max(0, Math.min(1, o.pnl / o.target));
    if (frac > 0) {
      g.fillStyle = ink;
      g.beginPath();
      g.roundRect(46, 292, Math.max(8, 328 * frac), 8, 4);
      g.fill();
    }
    g.fillStyle = C.faint;
    g.font = `700 13px ${MONO}`;
    g.fillText(clip(g, `today ${money(o.today)} · ${o.todayTrades} trade${o.todayTrades === 1 ? '' : 's'}${o.openNow ? ` · ${o.openNow} live` : ''}`, 328), 46, 326);

    // You, and who's ahead.
    card(g, 24, 356, 372, 198);
    kicker(g, you ? `You · ${you.name}` : 'You', 46, 388);
    if (you?.pnl != null) {
      glow(g, money(you.pnl), 44, 446, 48, tone(you.pnl));
      const lead = o.pnl - you.pnl;
      g.fillStyle = C.text;
      g.font = `900 19px ${SANS}`;
      g.fillText(Math.abs(lead) < 1 ? 'Dead level' : lead > 0 ? `The office leads by ${money(lead)}` : `You lead by ${money(-lead)}`, 46, 490);
      g.fillStyle = C.faint;
      g.font = `700 13px ${MONO}`;
      g.fillText(`today ${money(you.today)} · counted since ${(you.since ?? le.startDay).slice(5)}`, 46, 516);
    } else {
      g.fillStyle = C.text;
      g.font = `900 21px ${SANS}`;
      g.fillText('Nothing logged yet', 46, 436);
      g.fillStyle = C.dim;
      g.font = `700 15px ${SANS}`;
      g.fillText('Your line starts with your first trade:', 46, 466);
      g.fillText('link ProjectX, or log it in the Risk guard.', 46, 488);
    }

    // The race, day by day.
    const x0 = 416;
    const w = this.W - x0 - 24;
    card(g, x0, 94, w, 460);
    kicker(g, 'Profit, day by day', x0 + 22, 128);
    g.font = `800 13px ${MONO}`;
    g.fillStyle = ACCENT;
    g.fillText('━ THE OFFICE', x0 + w - 300, 128);
    g.fillStyle = C.text;
    g.fillText('━ YOU', x0 + w - 170, 128);
    g.fillStyle = INK.up;
    g.fillText('┄ TARGET', x0 + w - 100, 128);
    const px0 = x0 + 78;
    const pw = w - 110;
    const py0 = 150;
    const ph = 350;
    const mineS = you?.series ?? [];
    const vals = [0, o.target, -o.drawdown * 0.5, ...o.series.filter((v): v is number => v != null), ...mineS.filter((v): v is number => v != null)];
    const lo = Math.min(...vals);
    const hi = Math.max(...vals) * 1.08;
    const n = Math.max(2, le.days.length + 1);
    const X = (i: number) => px0 + (i / (n - 1)) * pw;
    const Y = (v: number) => py0 + (1 - (v - lo) / (hi - lo || 1)) * ph;
    for (const [v, label, color, dash] of [[o.target, 'TARGET', INK.up, [8, 6]], [0, 'START', C.faint, [2, 6]]] as const) {
      g.strokeStyle = color;
      g.lineWidth = 1.5;
      g.setLineDash([...dash]);
      g.beginPath();
      g.moveTo(px0, Y(v));
      g.lineTo(px0 + pw, Y(v));
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = color;
      g.font = `800 12px ${MONO}`;
      g.textAlign = 'right';
      g.fillText(v ? money(v) : label, px0 - 10, Y(v) + 4);
      g.textAlign = 'left';
    }
    const line = (series: (number | null)[], color: string, width: number, fill: boolean) => {
      const pts: [number, number][] = [];
      // Both lines start level, on the day before the first one counted.
      let started = false;
      series.forEach((v, i) => {
        if (v == null) return;
        if (!started) pts.push([X(i), Y(0)]);
        started = true;
        pts.push([X(i + 1), Y(v)]);
      });
      if (pts.length < 2) return;
      if (fill) {
        const grad = g.createLinearGradient(0, py0, 0, py0 + ph);
        grad.addColorStop(0, `${color}40`);
        grad.addColorStop(1, `${color}00`);
        g.beginPath();
        pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
        g.lineTo(pts[pts.length - 1]![0], Y(lo));
        g.lineTo(pts[0]![0], Y(lo));
        g.closePath();
        g.fillStyle = grad;
        g.fill();
      }
      g.beginPath();
      pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.strokeStyle = color;
      g.lineWidth = width;
      g.lineJoin = 'round';
      g.stroke();
      const [ex, ey] = pts[pts.length - 1]!;
      g.fillStyle = color;
      g.beginPath();
      g.arc(ex, ey, 6, 0, Math.PI * 2);
      g.fill();
    };
    line(o.series, ACCENT, 4, true);
    line(mineS, C.text, 3, false);
    g.fillStyle = C.faint;
    g.font = `700 12px ${MONO}`;
    const every = Math.max(1, Math.ceil(le.days.length / 8));
    le.days.forEach((d, i) => {
      if (i % every) return;
      g.textAlign = 'center';
      g.fillText(d.slice(5), X(i + 1), py0 + ph + 26);
    });
    g.textAlign = 'left';
  }
}

// ---- 🌾 The farm: every account by its stage. With no farm running, the wall shows the live eval ----------
const STAGE_INK: Record<string, string> = { eval: '#5cc8ff', funded: '#2ee6a6', parked: '#ffd166', busted: '#566385', empty: '#566385' };
const STAGE_WORD: Record<string, string> = { eval: 'IN PLAY', funded: 'TRADING', parked: 'PAYOUT READY', busted: 'BUSTED', empty: 'WAITING' };

export class FarmBoard extends LiveEvalBoard {
  draw(s: TradingSnapshot) {
    const farm = s.farm;
    if (!farm) return super.draw(s);
    const g = this.g;
    const ACCENT = '#7ee787';
    const program = FARM_PROGRAM_BY_ID[farm.setup.programId];
    const run = farm.run;
    const cells = run.cells[run.cells.length - 1] ?? [];
    const net = run.cash[run.cash.length - 1] ?? 0;
    this.frame(s, 'The Farm', `${program?.firm ?? ''} ${program?.name ?? ''} · on paper since ${farm.startDay.slice(5)}`, ACCENT, clip(g, `Trading: ${strategyLabel(farm.setup.strategy)}`, 700), 'Click to run it');

    card(g, 24, 94, 330, 250, C.card2);
    kicker(g, 'Payouts less fees', 46, 128, ACCENT);
    glow(g, money(net), 44, 206, 60, tone(net));
    g.fillStyle = C.dim;
    g.font = `700 16px ${SANS}`;
    g.fillText(`${money(run.payouts)} paid · ${money(run.fees)} in fees`, 46, 246);
    g.fillText(`${run.attempts} bought · ${run.passed} passed · ${run.payoutCount} payout${run.payoutCount === 1 ? '' : 's'}`, 46, 272);
    const count = (st: string) => cells.filter((c) => c.stage === st).length;
    let px = 46;
    for (const st of ['eval', 'funded', 'parked'] as const) px += pill(g, `${count(st)} ${st === 'eval' ? 'EVAL' : st === 'funded' ? 'FUNDED' : 'READY'}`, px, 296, `${STAGE_INK[st]}2a`, STAGE_INK[st]!, 13) + 8;

    // The last few things that happened.
    card(g, 24, 356, 330, 198);
    kicker(g, 'Latest', 46, 388);
    const feed = run.events.filter((e) => e.kind !== 'trade').slice(-4).reverse();
    if (!feed.length) {
      g.fillStyle = C.dim;
      g.font = `700 15px ${SANS}`;
      g.fillText('Waiting for the first setup…', 46, 424);
    }
    feed.forEach((e, i) => {
      const y = 414 + i * 36;
      g.fillStyle = e.kind === 'busted' ? INK.down : e.kind === 'paid' || e.kind === 'passed' ? INK.up : e.kind === 'payout-ready' ? INK.warn : C.text;
      g.font = `900 13px ${MONO}`;
      g.fillText(clip(g, `${e.account} · ${e.kind === 'payout-ready' ? 'PAYOUT READY' : e.kind.toUpperCase()}`, 290), 46, y);
      g.fillStyle = C.dim;
      g.font = `700 12px ${SANS}`;
      g.fillText(clip(g, e.text, 290), 46, y + 16);
    });

    // The accounts.
    const x0 = 374;
    const cols = cells.length > 4 ? 3 : cells.length > 1 ? 2 : 1;
    const rows = Math.ceil(cells.length / cols);
    const cw = (this.W - x0 - 24 - (cols - 1) * 12) / cols;
    const ch = (460 - (rows - 1) * 12) / rows;
    cells.forEach((c, i) => {
      const x = x0 + (i % cols) * (cw + 12);
      const y = 94 + Math.floor(i / cols) * (ch + 12);
      const ink = STAGE_INK[c.stage]!;
      card(g, x, y, cw, ch, c.stage === 'parked' ? '#2a2616' : C.card);
      g.strokeStyle = `${ink}88`;
      g.lineWidth = 2;
      g.beginPath();
      g.roundRect(x, y, cw, ch, 16);
      g.stroke();
      g.fillStyle = C.text;
      g.font = `900 18px ${MONO}`;
      g.fillText(c.account || `SLOT ${i + 1}`, x + 18, y + 34);
      pill(g, STAGE_WORD[c.stage]!, x + cw - 16, y + 14, `${ink}2a`, ink, 12, true);
      if (c.stage === 'empty') return;
      glow(g, money(c.balance), x + 16, y + Math.min(92, ch * 0.46), Math.min(40, ch * 0.2), ink);
      g.fillStyle = tone(c.pnl);
      g.font = `800 14px ${MONO}`;
      g.fillText(`today ${money(c.pnl)}`, x + 18, y + Math.min(92, ch * 0.46) + 26);
      g.fillStyle = C.dim;
      g.fillText(`to date ${money(c.balance - c.size)}`, x + 18 + cw * 0.42, y + Math.min(92, ch * 0.46) + 26);
      const by = y + ch - 46;
      const grad = g.createLinearGradient(x + 18, 0, x + cw - 18, 0);
      grad.addColorStop(0, `${INK.down}99`);
      grad.addColorStop(0.5, `${INK.warn}77`);
      grad.addColorStop(1, `${INK.up}99`);
      g.fillStyle = grad;
      g.beginPath();
      g.roundRect(x + 18, by, cw - 36, 8, 4);
      g.fill();
      const at = Math.max(0, Math.min(1, (c.balance - c.floor) / Math.max(1, c.target - c.floor)));
      g.fillStyle = '#fff';
      g.beginPath();
      g.roundRect(x + 18 + (cw - 36) * at - 3, by - 4, 6, 16, 3);
      g.fill();
      g.fillStyle = C.faint;
      g.font = `700 12px ${MONO}`;
      g.fillText(clip(g, c.last ? `last: ${c.last}` : 'no trade yet', cw - 36), x + 18, y + ch - 14);
    });
  }
}
