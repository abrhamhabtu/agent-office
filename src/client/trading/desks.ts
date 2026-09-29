import * as THREE from 'three';
import { DESK_SIZE, DESKS } from '../../shared/layout';
import type { FloorRole, PlaybookId, Symbol, TradingSnapshot } from '../../shared/trading';
import { INSTRUMENTS, PLAYBOOK_BY_ID, PLAYBOOKS, PODS, PROP_ACCOUNTS, seatJob } from '../../shared/trading';
import { DESK_BY_ID, STATION_AGENT } from '../../shared/layout';
import { Worker } from '../world/character';
import { Laptop } from '../world/laptop';
import type { DeskView } from '../world/office';
import type { PanelTab } from './panel';
import { mesh, roundedBox, toon } from '../world/toon';
import { accountRow, clip, guardBar, drawChart, fives, fmt, INK, money, pct, Screen, sparkline, STAGE_COLOR, STAGE_LABEL, type ChartOpts } from './screens';

// The trading desks: a monitor on every desk showing that seat's job live (its playbook's chart, the news,
// the accounts, the journal, the backtest), the way a trading floor's desks each have their own screens,
// and a few traders already sat at their laptops, working the tape, until someone hires a worker into
// their seat.

const SANS = 'Nunito, ui-rounded, system-ui, sans-serif';
const MONO = 'ui-monospace, Menlo, Consolas, monospace';

type Job =
  | { kind: 'chart'; playbook: PlaybookId | null; symbol: number; view: ChartOpts; fives?: boolean }
  | { kind: 'quotes' | 'news' | 'accounts' | 'journal' | 'paperToday' | 'proposals' | 'eval' | 'paperStats' | 'paperRecent' }
  | { kind: 'equity'; playbook: PlaybookId }
  | { kind: 'paperMarket'; symbol: number };

const vwapView: ChartOpts = { vwap: true, onVwap: true, or: true };
/** What each desk's monitor shows, by desk number, on each floor. `symbol` indexes the chosen markets. */
const JOBS: Record<FloorRole, Job[]> = {
  bell: [
    { kind: 'chart', playbook: 'vwap-pullback', symbol: 0, view: vwapView },
    { kind: 'chart', playbook: 'double-break', symbol: 1, view: vwapView },
    { kind: 'quotes' },
    { kind: 'news' },
    { kind: 'chart', playbook: 'supply-demand', symbol: 0, view: { zones: true }, fives: true },
    { kind: 'chart', playbook: 'support-resistance', symbol: 0, view: { sr: true } },
    { kind: 'chart', playbook: 'supply-demand', symbol: 1, view: { zones: true }, fives: true },
    { kind: 'chart', playbook: 'support-resistance', symbol: 1, view: { sr: true, vwap: true } },
    { kind: 'chart', playbook: 'failed-auction', symbol: 0, view: { value: true, profile: true } },
    { kind: 'chart', playbook: 'failed-auction', symbol: 1, view: { value: true, profile: true } },
    { kind: 'chart', playbook: 'vwap-pullback', symbol: 2, view: vwapView },
    { kind: 'chart', playbook: 'failed-auction', symbol: 2, view: { value: true, profile: true } },
    { kind: 'accounts' },
    { kind: 'journal' },
    { kind: 'paperToday' },
    { kind: 'proposals' },
  ],
  office: [
    { kind: 'equity', playbook: 'vwap-pullback' },
    { kind: 'equity', playbook: 'double-break' },
    { kind: 'equity', playbook: 'supply-demand' },
    { kind: 'equity', playbook: 'failed-auction' },
    { kind: 'equity', playbook: 'support-resistance' },
    { kind: 'eval' },
    { kind: 'paperStats' },
    { kind: 'paperRecent' },
    { kind: 'paperMarket', symbol: 0 },
    { kind: 'paperMarket', symbol: 1 },
    { kind: 'paperMarket', symbol: 2 },
    { kind: 'paperMarket', symbol: 3 },
    { kind: 'paperStats' },
    { kind: 'eval' },
    { kind: 'paperToday' },
    { kind: 'paperRecent' },
  ],
};

/** The seats that already have a trader working at them when nobody's been hired there. */
const TRADERS: Record<FloorRole, number[]> = { bell: [1, 3, 6, 13, 14, 16], office: [1, 3, 6, 13, 14, 16] };
const RESIDENT_TITLES = {
  chief: 'SESSION CHIEF', tape: 'TAPE BRIEF', levels: 'LEVELS', risk: 'RISK', backtest: 'BACKTEST', paper: 'PAPER + GRADE',
} as const;

const marketAt = (s: TradingSnapshot, i: number): Symbol => s.markets[i % Math.max(1, s.markets.length)] ?? 'NQ';

export function deskDetailsTab(deskId: string, role: FloorRole): PanelTab {
  const n = Number(/^desk-(\d+)$/.exec(deskId)?.[1]);
  const job = JOBS[role][n - 1];
  switch (job?.kind) {
    case 'news': return 'news';
    case 'accounts': return 'accounts';
    case 'journal': return 'alerts';
    case 'paperToday':
    case 'paperRecent':
    case 'paperStats': return 'paper';
    case 'equity':
    case 'eval': return 'backtest';
    case 'quotes':
    case 'paperMarket': return 'connections';
    default: return 'proposals';
  }
}

/** A desk monitor: one seat's job, redrawn from the snapshot. */
class DeskMonitor extends Screen {
  constructor(private n: number) {
    super(640, 360);
  }
  private title(text: string, color: string, right = '') {
    const g = this.g;
    g.fillStyle = INK.bg;
    g.fillRect(0, 0, this.W, this.H);
    g.fillStyle = color;
    g.fillRect(0, 0, this.W, 6);
    g.fillStyle = INK.text;
    g.font = `900 26px ${SANS}`;
    g.fillText(clip(g, text, this.W - 200), 16, 40);
    if (right) {
      g.textAlign = 'right';
      g.font = `900 24px ${MONO}`;
      g.fillText(right, this.W - 16, 40);
      g.textAlign = 'left';
    }
  }
  draw(s: TradingSnapshot, role: FloorRole, now: number) {
    const g = this.g;
    const job = JOBS[role][this.n - 1]!;
    const pod = PODS[role][Math.floor((this.n - 1) / 4)]!;
    switch (job.kind) {
      case 'chart': {
        const sym = marketAt(s, job.symbol);
        const q = s.quotes.find((x) => x.symbol === sym);
        const book = job.playbook ? PLAYBOOK_BY_ID[job.playbook] : null;
        this.title(`${sym} · ${book?.short ?? pod.name}`, book?.color ?? pod.color, q ? fmt(q.last, q.decimals) : '');
        const plan = book ? s.proposals.find((p) => p.symbol === sym && p.playbook === book.id) ?? null : null;
        if (plan) {
          g.fillStyle = STAGE_COLOR[plan.stage] ?? INK.dim;
          g.font = `900 18px ${SANS}`;
          g.fillText(clip(g, `${STAGE_LABEL[plan.stage] ?? ''}  ${plan.title}`, this.W - 32), 16, 68);
        }
        if (q) drawChart(g, 8, 80, this.W - 16, this.H - 88, job.fives ? fives(s.bars[sym]).slice(-36) : s.bars[sym].slice(-70), q, s.levels[sym], { ...job.view, grid: true, tag: true, plan: plan && ['ready', 'live', 'watching'].includes(plan.stage) ? plan : null });
        return;
      }
      case 'quotes': {
        this.title('Tape', pod.color);
        s.quotes.forEach((q, i) => {
          const y = 64 + i * 72;
          g.fillStyle = i % 2 ? INK.bg : INK.panel;
          g.fillRect(8, y, this.W - 16, 66);
          g.fillStyle = q.ink;
          g.font = `900 30px ${MONO}`;
          g.fillText(q.symbol, 22, y + 44);
          g.fillStyle = INK.text;
          g.fillText(fmt(q.last, q.decimals), 130, y + 44);
          g.textAlign = 'right';
          g.fillStyle = q.change >= 0 ? INK.up : INK.down;
          g.font = `900 26px ${MONO}`;
          g.fillText(pct(q.changePct), this.W - 22, y + 44);
          g.textAlign = 'left';
        });
        return;
      }
      case 'news': {
        this.title('The wire', INK.info);
        const cal = s.news.filter((n) => n.kind === 'calendar' && n.at > now - 30 * 60_000).sort((a, b) => a.at - b.at).slice(0, 2);
        const heads = s.news.filter((n) => n.kind === 'headline').slice(0, 5 - cal.length);
        [...cal, ...heads].forEach((n, i) => {
          const y = 60 + i * 58;
          g.fillStyle = n.impact === 'high' ? INK.down : n.impact === 'med' ? INK.warn : INK.dim;
          g.fillRect(8, y + 6, 6, 44);
          g.fillStyle = INK.dim;
          g.font = `800 17px ${MONO}`;
          g.fillText(`${n.time}${n.kind === 'calendar' ? ' · CALENDAR' : ` · ${n.source}`}`, 24, y + 22);
          g.fillStyle = INK.text;
          g.font = `800 20px ${SANS}`;
          g.fillText(clip(g, n.headline, this.W - 40), 24, y + 48);
        });
        return;
      }
      case 'accounts': {
        this.title('Risk guard · Law of 10', pod.color);
        guardBar(g, 8, 52, this.W - 16, 34, s, now);
        s.accounts.filter((a) => a.active).slice(0, 5).forEach((a, i) => accountRow(g, 8, 94 + i * 53, this.W - 16, 49, a));
        return;
      }
      case 'journal': {
        this.title('Journal & alerts', pod.color);
        const rows: string[] = [
          ...s.alerts.slice(0, 3).map((a) => `🔔 ${new Date(a.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ${a.setup} ${a.symbol} ${a.side ?? ''}`),
          ...s.journal.today.slice(0, 4).map((t) => `📓 ${t.symbol} ${t.side} ×${t.qty}  ${money(t.pnl)}`),
        ];
        if (!rows.length) rows.push(s.journal.connected ? 'No trades on your accounts today' : 'Connect ProjectX to journal your fills', 'TradingView alerts land here too');
        g.font = `800 21px ${SANS}`;
        rows.slice(0, 6).forEach((r, i) => {
          g.fillStyle = i % 2 ? INK.bg : INK.panel;
          g.fillRect(8, 58 + i * 48, this.W - 16, 44);
          g.fillStyle = INK.text;
          g.fillText(clip(g, r, this.W - 40), 20, 88 + i * 48);
        });
        return;
      }
      case 'proposals': {
        this.title('Session chief · what’s live', pod.color);
        s.proposals.filter((p) => p.stage !== 'off').slice(0, 6).forEach((p, i) => {
          const y = 56 + i * 50;
          g.fillStyle = i % 2 ? INK.bg : INK.panel;
          g.fillRect(8, y, this.W - 16, 46);
          g.fillStyle = INSTRUMENTS[p.symbol].ink;
          g.font = `900 21px ${MONO}`;
          g.fillText(p.symbol, 18, y + 31);
          g.fillStyle = PLAYBOOK_BY_ID[p.playbook].color;
          g.font = `900 18px ${SANS}`;
          g.fillText(PLAYBOOK_BY_ID[p.playbook].short, 84, y + 30);
          g.fillStyle = STAGE_COLOR[p.stage] ?? INK.dim;
          g.fillText(STAGE_LABEL[p.stage] ?? p.stage, 190, y + 30);
          if (p.r != null) {
            g.textAlign = 'right';
            g.fillStyle = INK.warn;
            g.font = `900 20px ${MONO}`;
            g.fillText(`${p.r}R`, this.W - 18, y + 31);
            g.textAlign = 'left';
          }
        });
        return;
      }
      case 'paperToday':
      case 'paperRecent': {
        const list = job.kind === 'paperToday' ? s.paper.today : s.paper.recent;
        this.title(job.kind === 'paperToday' ? 'Paper · today' : 'Paper · last days', '#06d6a0', job.kind === 'paperToday' ? `${s.paper.todayR >= 0 ? '+' : ''}${s.paper.todayR}R` : '');
        if (!list.length) {
          g.fillStyle = INK.dim;
          g.font = `800 22px ${SANS}`;
          g.fillText('No paper trades yet', 16, 100);
        }
        list.slice(0, 6).forEach((t, i) => {
          const y = 56 + i * 50;
          g.fillStyle = i % 2 ? INK.bg : INK.panel;
          g.fillRect(8, y, this.W - 16, 46);
          g.fillStyle = INSTRUMENTS[t.symbol].ink;
          g.font = `900 20px ${MONO}`;
          g.fillText(t.symbol, 18, y + 31);
          g.fillStyle = PLAYBOOK_BY_ID[t.playbook].color;
          g.font = `900 17px ${SANS}`;
          g.fillText(`${PLAYBOOK_BY_ID[t.playbook].short} ${t.side}`, 84, y + 30);
          g.textAlign = 'right';
          g.fillStyle = t.outcome === 'open' ? INK.info : t.r >= 0 ? INK.up : INK.down;
          g.font = `900 20px ${MONO}`;
          g.fillText(t.outcome === 'open' ? `LIVE ${t.r}R` : `${t.r >= 0 ? '+' : ''}${t.r}R`, this.W - 18, y + 31);
          g.textAlign = 'left';
        });
        return;
      }
      case 'paperStats': {
        this.title('Paper · by playbook', '#06d6a0');
        s.paper.stats.forEach((st, i) => {
          const p = PLAYBOOK_BY_ID[st.playbook];
          const y = 56 + i * 58;
          g.fillStyle = p.color;
          g.font = `900 20px ${SANS}`;
          g.fillText(p.short, 16, y + 24);
          g.fillStyle = INK.dim;
          g.font = `700 15px ${SANS}`;
          g.fillText(`${st.trades} tr · ${Math.round(st.winRate * 100)}%`, 16, y + 46);
          g.fillStyle = st.totalR >= 0 ? INK.up : INK.down;
          g.font = `900 20px ${MONO}`;
          g.fillText(`${st.totalR >= 0 ? '+' : ''}${st.totalR}R`, 150, y + 34);
          sparkline(g, 260, y + 6, this.W - 280, 44, st.curve, p.color);
        });
        return;
      }
      case 'equity': {
        const p = PLAYBOOK_BY_ID[job.playbook];
        const all = s.backtest?.stats.find((x) => x.playbook === p.id && x.symbol === 'ALL');
        this.title(`Backtest · ${p.name}`, p.color, all ? `${all.totalR >= 0 ? '+' : ''}${all.totalR}R` : '');
        const per = (s.backtest?.stats ?? []).filter((x) => x.playbook === p.id && x.symbol !== 'ALL');
        per.forEach((st, i) => {
          const y = 56 + i * 74;
          g.fillStyle = INSTRUMENTS[st.symbol as Symbol].ink;
          g.font = `900 20px ${MONO}`;
          g.fillText(String(st.symbol), 16, y + 28);
          g.fillStyle = st.totalR >= 0 ? INK.up : INK.down;
          g.fillText(`${st.totalR >= 0 ? '+' : ''}${st.totalR}R`, 16, y + 54);
          g.fillStyle = INK.dim;
          g.font = `700 14px ${SANS}`;
          g.fillText(`${st.trades} tr · ${Math.round(st.winRate * 100)}%`, 110, y + 28);
          sparkline(g, 230, y + 8, this.W - 250, 56, st.curve, INSTRUMENTS[st.symbol as Symbol].ink);
        });
        if (!per.length) {
          g.fillStyle = INK.dim;
          g.font = `800 22px ${SANS}`;
          g.fillText('Replaying the month…', 16, 100);
        }
        return;
      }
      case 'eval': {
        this.title('Eval simulator', INK.violet);
        const accts = PROP_ACCOUNTS;
        const cw = (this.W - 150) / accts.length;
        g.font = `900 13px ${SANS}`;
        accts.forEach((a, i) => {
          g.fillStyle = INK.dim;
          g.fillText(clip(g, `${a.firm} ${a.size / 1000}K`, cw - 4), 140 + i * cw, 66);
        });
        PLAYBOOKS.forEach((p, r) => {
          const y = 78 + r * 54;
          g.fillStyle = p.color;
          g.font = `900 17px ${SANS}`;
          g.fillText(p.short, 12, y + 30);
          accts.forEach((a, i) => {
            const e = s.backtest?.evals.find((x) => x.playbook === p.id && x.accountId === a.id);
            g.fillStyle = !e ? INK.panel : e.result === 'passed' ? 'rgba(46,230,166,.35)' : e.result === 'busted' ? 'rgba(255,93,115,.3)' : INK.panel;
            g.fillRect(138 + i * cw, y + 6, cw - 6, 40);
            if (!e) return;
            g.fillStyle = INK.text;
            g.font = `900 14px ${SANS}`;
            g.fillText(e.result === 'passed' ? `✓ ${e.days}d` : e.result === 'busted' ? '✗' : money(e.pnl), 144 + i * cw, y + 31);
          });
        });
        return;
      }
      case 'paperMarket': {
        const sym = (['NQ', 'ES', 'GC', 'BTC'] as Symbol[])[job.symbol]!;
        const q = s.quotes.find((x) => x.symbol === sym);
        const mine = s.paper.today.filter((t) => t.symbol === sym);
        const r = Math.round(mine.reduce((a, t) => a + t.r, 0) * 100) / 100;
        this.title(`Paper · ${sym}`, '#06d6a0', `${r >= 0 ? '+' : ''}${r}R`);
        const open = mine.find((t) => t.outcome === 'open');
        if (q) drawChart(g, 8, 56, this.W - 16, this.H - 64, s.bars[sym].slice(-70), q, s.levels[sym], { vwap: true, grid: true, tag: true, plan: open ? ({ entry: open.entry, stop: open.stop, target: open.target } as never) : null });
        return;
      }
    }
  }
}

export interface TradingDesks {
  /** Redraws what's due and animates the traders; cheap enough to call every frame. */
  update(dt: number, t: number, cam: THREE.Vector3, role: FloorRole, snap: TradingSnapshot | null, tick: number): void;
  screenFor(deskId: string, role: FloorRole, snap: TradingSnapshot | null): Screen | null;
}

export function buildTradingDesks(desks: Map<string, DeskView>): TradingDesks {
  const { height, depth } = DESK_SIZE;
  const W = 0.86;
  const H = W * (360 / 640);
  const monitors: { n: number; screen: DeskMonitor; at: THREE.Vector3; drawn: number; role: FloorRole | null }[] = [];
  const frameMat = toon('#1b2033');
  for (const def of DESKS) {
    const view = desks.get(def.id);
    const n = Number(/^desk-(\d+)$/.exec(def.id)?.[1]);
    if (!view || !n) continue;
    const screen = new DeskMonitor(n);
    // On a stand to the right of the laptop, turned in toward the chair: laptop and monitor side by side.
    const mon = new THREE.Group();
    mon.add(mesh(roundedBox(W + 0.06, H + 0.06, 0.05, 0.02), frameMat, 0, 0, 0));
    const face = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshBasicMaterial({ map: screen.texture, toneMapped: false }));
    face.position.z = 0.028;
    mon.add(face);
    mon.add(mesh(new THREE.BoxGeometry(W - 0.12, 0.012, 0.014), toon('#06d6a0'), 0, H / 2 + 0.018, 0.03, false));
    mon.add(mesh(new THREE.SphereGeometry(0.012, 8, 8), toon('#06d6a0', { emissive: '#06d6a0' }), W / 2 - 0.055, -H / 2 - 0.015, 0.03, false));
    // Only the second screen opens a market preview. The laptop and the desk still open the terminal.
    face.userData.interact = { kind: 'monitor', x: def.x, z: def.z, radius: 4.5, deskId: def.id };
    mon.add(mesh(new THREE.BoxGeometry(0.05, 0.2, 0.05), frameMat, 0, -H / 2 - 0.08, -0.03, false));
    mon.add(mesh(roundedBox(0.3, 0.025, 0.2, 0.01), frameMat, 0, -H / 2 - 0.18, -0.01, false));
    mon.position.set(0.56, height + 0.19 + H / 2, -depth / 2 + 0.24);
    mon.rotation.set(-0.05, -0.32, 0, 'YXZ');
    view.group.add(mon);
    monitors.push({ n, screen, at: new THREE.Vector3(def.x, 1.2, def.z), drawn: -1, role: null });
  }

  // The traders at their laptops: each is visible only while nobody's been hired into the seat.
  const traders = (['bell', 'office'] as FloorRole[]).flatMap((role) =>
    TRADERS[role].map((n) => {
      const id = `desk-${n}`;
      const view = desks.get(id)!;
      const station = DESK_BY_ID.get(id)?.station;
      const job = station && station in RESIDENT_TITLES
        ? `${STATION_AGENT[station].name} · ${RESIDENT_TITLES[station as keyof typeof RESIDENT_TITLES]}`
        : seatJob(role, id) ?? 'Trader';
      const name = station && station in RESIDENT_TITLES ? STATION_AGENT[station].name : job.split(' · ')[0]!;
      const pod = PODS[role][Math.floor((n - 1) / 4)]!;
      const model = new Worker(name, station && station in RESIDENT_TITLES ? STATION_AGENT[station].color : pod.color);
      model.setStatus('working', false);
      view.seatAnchor.add(model.root);
      const laptop = new Laptop();
      const i = TRADERS[role].indexOf(n);
      laptop.chartFor = () => ({ symbol: (['NQ', 'GC', 'BTC', 'NQ'] as Symbol[])[i]!, view: role === 'bell' && i === 1 ? 'zones' : role === 'bell' && i === 2 ? 'profile' : 'vwap' });
      view.laptopAnchor.add(laptop.root);
      model.root.visible = false;
      laptop.root.visible = false;
      return { role, n, view, model, laptop, job, card: '' };
    }),
  );
  let drawnTick = -1;
  let cursor = 0;

  return {
    screenFor(deskId, role, snap) {
      const monitor = monitors.find((m) => `desk-${m.n}` === deskId);
      if (!monitor) return null;
      monitor.screen.render(snap, role);
      return monitor.screen;
    },
    update(dt, t, cam, role, snap, tick) {
      // Monitors: when the prices move, redraw the nearest few each frame rather than all sixteen at once.
      if (tick !== drawnTick) {
        drawnTick = tick;
        for (const m of monitors) m.drawn = -1;
      }
      let budget = 2;
      for (let k = 0; k < monitors.length && budget > 0; k++) {
        const m = monitors[(cursor + k) % monitors.length]!;
        if (m.drawn === tick && m.role === role) continue;
        if (m.at.distanceTo(cam) > 26 && m.role === role && m.drawn >= 0 && tick - m.drawn < 8) continue;
        m.screen.render(snap, role);
        m.drawn = tick;
        m.role = role;
        budget--;
        cursor = (cursor + k + 1) % monitors.length;
        k = -1;
      }
      // A trader's seat shows no "+" while they're in it; every other seat keeps its marker.
      const sitting = new Set(traders.filter((tr) => tr.role === role && tr.view.vacancy.visible).map((tr) => tr.view));
      for (const tr of traders) for (const c of tr.view.vacancy.children) c.visible = !sitting.has(tr.view);
      for (const tr of traders) {
        // A hired worker takes the seat (its vacancy marker goes): the trader gets up and goes.
        const here = tr.role === role && tr.view.vacancy.visible;
        tr.model.root.visible = here;
        tr.laptop.root.visible = here;
        if (!here) continue;
        tr.model.update(dt, t);
        tr.laptop.update(dt, undefined, tr.view.group.position.distanceTo(cam));
        // The card over their head says what they're on, live.
        const job = JOBS[role][tr.n - 1];
        const book = job && (job.kind === 'chart' || job.kind === 'equity') ? job.playbook : null;
        const p = book ? snap?.proposals.find((x) => x.playbook === book) : undefined;
        const card = p ? `${p.symbol} ${PLAYBOOK_BY_ID[p.playbook].short}: ${STAGE_LABEL[p.stage] ?? p.stage}` : tr.job.split(' · ')[1] ?? '';
        if (card !== tr.card) {
          tr.card = card;
          tr.model.setTask({ name: tr.job.split(' · ')[1] ?? tr.job, summary: card });
        }
      }
    },
  };
}
