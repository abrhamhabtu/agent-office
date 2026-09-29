import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type {
  AccountState, BacktestSummary, Bar, Bias, EvalRun, Levels, PaperBook, PaperTrade, PlaybookId, PlaybookItem, PlaybookStats, Proposal, ProposalAction, PropRules, SessionInfo, Symbol, TradingSnapshot, TvAlert,
} from '../../shared/trading.js';
import { INSTRUMENTS, lawOf10, microsFor, PLAYBOOK_BY_ID, PLAYBOOKS, PROP_ACCOUNTS, SYMBOLS } from '../../shared/trading.js';
import { byTradingDay, pacific, replayDay, RTH_CLOSE, RTH_OPEN, sessionMinute, tradingDay, type DayResult } from './engine.js';
import { Market } from './market.js';
import { NewsDesk } from './news.js';
import { ProjectX } from './projectx.js';

// The market desk: real prices in, the three playbooks replayed over today's bars, and out comes what
// every board and laptop on the two trading floors draws. It also keeps the paper book (every setup the
// playbooks took, on its own, against the real tape), runs the month's backtest, and plays each playbook
// through each prop account's rules with Law-of-10 sizing. It produces proposals; it never places an order.

interface Saved {
  webhookKey: string;
  marks: Record<string, 'taken' | 'skipped'>;
  checklist: { day: string; done: string[] };
  accounts: Record<string, { active: boolean; balance: number; peak: number; projectxId?: number }>;
  tradePilot: { url: string | null; key: string | null };
  alerts: TvAlert[];
  /** The markets the proposals cover. */
  markets: Symbol[];
}

const DEFAULT_ACTIVE = new Set(['lucidflex-50k', 'lucidflex-100k', 'topstep-50k', 'tof-50k', 'apex-50k']);
const LIVE_EVERY = 10_000;

const CHECKLIST: { id: string; label: string; owner: string; auto?: boolean }[] = [
  { id: 'calendar', label: 'Read the calendar: know every high-impact print', owner: 'Scout', auto: true },
  { id: 'bias', label: 'Overnight VWAP read: bias for NQ and ES', owner: 'Vex', auto: true },
  { id: 'value', label: 'Value area marked: VAH, POC, VAL', owner: 'Auction', auto: true },
  { id: 'zones', label: 'Fresh supply and demand zones drawn on the 5m', owner: 'Zona', auto: true },
  { id: 'or', label: '15-minute opening range set (06:45 PT)', owner: 'Vex', auto: true },
  { id: 'news', label: 'No high-impact print in the next 15 minutes', owner: 'Scout', auto: true },
  { id: 'account', label: 'Pick today’s account; Law-of-10 risk set', owner: 'Bulwark' },
  { id: 'plan', label: 'Write the plan: which playbook, bias, invalidation', owner: 'Marshal' },
  { id: 'stop', label: 'Daily stop agreed: 3 losses or −2R and walk away', owner: 'Coach' },
];

/** The playbook a TradingView alert names, by the words in it. */
export function playbookFor(text: string): PlaybookId | null {
  if (/double|dbl|\bdb\b/i.test(text)) return 'double-break';
  if (/vwap|pull ?back/i.test(text)) return 'vwap-pullback';
  if (/supply|demand|zone|s ?& ?d/i.test(text)) return 'supply-demand';
  if (/auction|\bval\b|\bvah\b|\bpoc\b|value area/i.test(text)) return 'failed-auction';
  return null;
}

/** A TradingView alert, from its JSON message (any of the usual field names) or its plain text. */
export function parseAlert(raw: string): Omit<TvAlert, 'id' | 'at'> {
  let body: Record<string, unknown> = {};
  try {
    const j = JSON.parse(raw) as unknown;
    if (j && typeof j === 'object') body = j as Record<string, unknown>;
  } catch {
    // Plain text.
  }
  const str = (...keys: string[]) => {
    for (const k of keys) if (typeof body[k] === 'string' && (body[k] as string).trim()) return (body[k] as string).trim().slice(0, 160);
    return '';
  };
  const text = raw.slice(0, 500);
  const sideText = `${str('side', 'action', 'direction', 'order_action')} ${text}`;
  const side = /\b(buy|long|bull)/i.test(sideText) ? 'long' : /\b(sell|short|bear)/i.test(sideText) ? 'short' : null;
  const price = Number(body.price ?? body.close ?? body.entry);
  const setup = str('setup', 'strategy', 'name', 'alert', 'title') || (Object.keys(body).length ? '' : text.split(/[\n.]/)[0]!.slice(0, 80));
  const symbol = (str('symbol', 'ticker', 'instrument') || /\b(M?NQ|M?ES|M?GC|MBT|BTC\w*)\b/i.exec(text)?.[1] || '').toUpperCase();
  return { symbol, side, setup: setup || 'TradingView alert', price: Number.isFinite(price) && price > 0 ? price : null, message: str('message', 'msg', 'comment', 'text') || (Object.keys(body).length ? '' : text), playbook: playbookFor(`${setup} ${text}`) };
}

function stats(trades: PaperTrade[], playbook: PlaybookId, symbol: Symbol | 'ALL'): PlaybookStats {
  const list = trades.filter((t) => t.playbook === playbook && (symbol === 'ALL' || t.symbol === symbol) && t.outcome !== 'open').sort((a, b) => a.entryAt - b.entryAt);
  let cum = 0;
  let peak = 0;
  let dd = 0;
  const curve: number[] = [];
  for (const t of list) {
    cum += t.r;
    peak = Math.max(peak, cum);
    dd = Math.max(dd, peak - cum);
    curve.push(Math.round(cum * 100) / 100);
  }
  const wins = list.filter((t) => t.r > 0).length;
  return {
    playbook,
    symbol,
    trades: list.length,
    wins,
    losses: list.filter((t) => t.r < 0).length,
    winRate: list.length ? wins / list.length : 0,
    avgR: list.length ? Math.round((cum / list.length) * 100) / 100 : 0,
    totalR: Math.round(cum * 100) / 100,
    maxDrawdownR: Math.round(dd * 100) / 100,
    curve,
    dollars: Math.round(list.reduce((a, t) => a + t.dollars, 0)),
  };
}

/** Plays a playbook's trades through one account's rules, sized by the Law of 10 after every trade. */
export function simulateEval(trades: PaperTrade[], rules: PropRules): Omit<EvalRun, 'playbook' | 'accountId'> {
  let balance = rules.size;
  let peak = rules.size;
  let peakCushion = rules.drawdown;
  const threshold = () => Math.min(peak - rules.drawdown, rules.lockProfit == null ? Infinity : rules.size + rules.lockProfit);
  const days = [...new Set(trades.map((t) => t.day))].sort();
  let n = 0;
  for (const day of days) {
    n++;
    for (const t of trades.filter((x) => x.day === day && x.outcome !== 'open').sort((a, b) => a.entryAt - b.entryAt)) {
      const cushion = balance - threshold();
      const micros = microsFor(t.symbol, lawOf10(cushion), Math.abs(t.entry - t.stop), rules.maxMicros);
      balance += micros * t.dollars;
      if (rules.drawdownType === 'trailing-intraday') peak = Math.max(peak, balance);
      if (balance <= threshold()) return { result: 'busted', days: n, pnl: Math.round(balance - rules.size), peakCushion: Math.round(peakCushion) };
    }
    if (rules.drawdownType === 'trailing-eod') peak = Math.max(peak, balance);
    peakCushion = Math.max(peakCushion, balance - threshold());
    if (balance - rules.size >= rules.profitTarget && n >= rules.minTradingDays) return { result: 'passed', days: n, pnl: Math.round(balance - rules.size), peakCushion: Math.round(peakCushion) };
  }
  return { result: 'running', days: n, pnl: Math.round(balance - rules.size), peakCushion: Math.round(peakCushion) };
}

/** The session clock: which part of the day it is, and when the next bell rings (weekdays only). */
export function sessionAt(now: number): SessionInfo {
  const p = pacific(now);
  const m = p.minutes;
  const weekday = p.weekday;
  const weekend = weekday === 6 || (weekday === 0 && m < 900) || (weekday === 5 && m >= RTH_CLOSE);
  const phase: SessionInfo['phase'] = weekend ? 'closed' : m < 330 || m >= 900 ? 'overnight' : m < RTH_OPEN ? 'premarket' : m < 405 ? 'ORB' : m < 540 ? 'morning' : m < 720 ? 'midday' : m < RTH_CLOSE ? 'close' : 'closed';
  const isTradingDay = (wd: number) => wd >= 1 && wd <= 5;
  // The next bell: today's open or close if still ahead, else the next weekday's open.
  const secs = p.seconds;
  let next: { kind: 'open' | 'close'; inSeconds: number };
  if (isTradingDay(weekday) && secs < RTH_OPEN * 60) next = { kind: 'open', inSeconds: RTH_OPEN * 60 - secs };
  else if (isTradingDay(weekday) && secs < RTH_CLOSE * 60) next = { kind: 'close', inSeconds: RTH_CLOSE * 60 - secs };
  else {
    let add = 1;
    while (!isTradingDay((weekday + add) % 7)) add++;
    next = { kind: 'open', inSeconds: add * 86400 - secs + RTH_OPEN * 60 };
  }
  // The bell that last rang, so every browser that's open when it does rings it once.
  let last: SessionInfo['lastBell'] = null;
  if (isTradingDay(weekday)) {
    const dayStart = now - secs * 1000 - (now % 1000);
    if (secs >= RTH_CLOSE * 60) last = { kind: 'close', at: dayStart + RTH_CLOSE * 60_000 };
    else if (secs >= RTH_OPEN * 60) last = { kind: 'open', at: dayStart + RTH_OPEN * 60_000 };
  }
  const hh = (n: number) => String(n).padStart(2, '0');
  return { time: `${hh(Math.floor(secs / 3600))}:${hh(Math.floor((secs % 3600) / 60))}:${hh(secs % 60)}`, day: p.date, minutes: m, phase, weekend, nextBell: next, lastBell: last };
}

export class TradingDesk {
  readonly market: Market;
  readonly news: NewsDesk;
  readonly projectx: ProjectX;
  private file: string;
  private paperFile: string;
  private saved: Saved;
  private live = new Map<Symbol, DayResult>();
  private paperHistory = new Map<string, PaperTrade>();
  private backtest: BacktestSummary | null = null;
  private timers: NodeJS.Timeout[] = [];
  private forwarded = new Set<string>();
  private dirty = new Set<Symbol>();
  private liveFile: string;

  constructor(private dataDir: string) {
    const dir = path.join(dataDir, 'trading');
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'desk.json');
    this.paperFile = path.join(dir, 'paper.json');
    this.market = new Market(dataDir);
    this.news = new NewsDesk(dataDir);
    // The desk agents read the tape from this file (their terminals can't sign in to the office's API).
    this.liveFile = path.join(dir, 'live.json');
    process.env.TRADING_OFFICE_SNAPSHOT = this.liveFile;
    this.projectx = new ProjectX(dataDir);
    let s: Partial<Saved> = {};
    try {
      s = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Saved>;
    } catch {
      // A new desk.
    }
    this.saved = {
      webhookKey: typeof s.webhookKey === 'string' && /^[\w-]{16,64}$/.test(s.webhookKey) ? s.webhookKey : randomBytes(18).toString('base64url'),
      marks: s.marks ?? {},
      checklist: s.checklist ?? { day: '', done: [] },
      accounts: s.accounts ?? {},
      tradePilot: s.tradePilot ?? { url: null, key: null },
      alerts: Array.isArray(s.alerts) ? s.alerts.slice(-30) : [],
      markets: Array.isArray(s.markets) && s.markets.every((m) => (SYMBOLS as readonly string[]).includes(m)) && s.markets.length ? s.markets : ['NQ', 'GC', 'BTC'],
    };
    for (const a of PROP_ACCOUNTS) this.saved.accounts[a.id] ??= { active: DEFAULT_ACTIVE.has(a.id), balance: a.size, peak: a.size };
    try {
      for (const t of JSON.parse(readFileSync(this.paperFile, 'utf8')) as PaperTrade[]) this.paperHistory.set(t.id, t);
    } catch {
      // No paper trades yet.
    }
    this.save();
  }

  start() {
    this.market.onBars = (sym) => this.dirty.add(sym);
    this.market.start();
    this.news.start();
    this.projectx.start();
    this.timers.push(
      setInterval(() => {
        for (const sym of SYMBOLS) if (this.dirty.has(sym) || !this.live.has(sym)) this.replay(sym);
        this.dirty.clear();
      }, 3000),
    );
    this.timers.push(setInterval(() => SYMBOLS.forEach((s) => this.replay(s)), LIVE_EVERY));
    this.timers.push(setInterval(() => this.writeLive(), 15_000));
    // The month's backtest: once the bars are in, then again after every close.
    setTimeout(() => void this.runBacktest(), 8000);
    this.timers.push(
      setInterval(() => {
        const s = sessionAt(Date.now());
        if (s.minutes === RTH_CLOSE + 10 && !this.backtest?.running) void this.runBacktest();
      }, 60_000),
    );
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.market.stop();
    this.news.stop();
    this.projectx.stop();
  }

  private save() {
    try {
      writeFileSync(this.file, JSON.stringify(this.saved, null, 1), { mode: 0o600 });
    } catch {
      // Kept in memory until the next save.
    }
  }

  /** Today's and yesterday's closed bars for a market, split at the Globex open. */
  private days(sym: Symbol): { today: Bar[]; prior: Bar[] } {
    const byDay = [...byTradingDay(this.market.closedBars(sym))];
    const now = tradingDay(Date.now());
    const i = byDay.findIndex(([d]) => d === now);
    if (i < 0) return { today: [], prior: byDay.at(-1)?.[1] ?? [] };
    return { today: byDay[i]![1], prior: byDay[i - 1]?.[1] ?? [] };
  }

  private replay(sym: Symbol) {
    const { today, prior } = this.days(sym);
    if (!today.length && !prior.length) return;
    // Nothing traded yet today (a weekend, or before Globex): show where yesterday finished.
    const res = today.length ? replayDay(sym, today, prior, { live: true }) : replayDay(sym, prior, [], { live: false });
    this.live.set(sym, res);
    // The paper book keeps every trade the day actually took, so a restart or a revised bar can't rewrite history.
    let changed = false;
    for (const t of res.trades) {
      const had = this.paperHistory.get(t.id);
      if (!had || (had.outcome === 'open' && t.outcome !== 'open') || (had.outcome === 'open' && t.outcome === 'open' && had.r !== t.r)) {
        this.paperHistory.set(t.id, { ...t, taken: this.saved.marks[`${sym}:${t.playbook}:${t.day}`] === 'taken' });
        changed = true;
        if (!had) void this.forward(t);
      }
    }
    if (changed) this.savePaper();
  }

  private savePaper() {
    const cut = Date.now() - 45 * 86_400_000;
    const list = [...this.paperHistory.values()].filter((t) => t.entryAt >= cut);
    try {
      writeFileSync(this.paperFile, JSON.stringify(list));
    } catch {
      // Next time.
    }
  }

  // ---- Backtest --------------------------------------------------------------------------------------
  async runBacktest(): Promise<void> {
    if (this.backtest?.running) return;
    this.backtest = { ...(this.backtest ?? { days: [], stats: [], evals: [], best: null, note: '' }), ranAt: Date.now(), running: true };
    const all: PaperTrade[] = [];
    const days = new Set<string>();
    const today = tradingDay(Date.now());
    try {
      for (const sym of SYMBOLS) {
        const byDay = [...byTradingDay(await this.market.history(sym))];
        for (let i = 1; i < byDay.length; i++) {
          const [day, bars] = byDay[i]!;
          if (day >= today || bars.length < 300) continue;
          days.add(day);
          all.push(...replayDay(sym, bars, byDay[i - 1]![1]).trades);
        }
        // Let the office breathe between markets.
        await new Promise((r) => setTimeout(r, 50));
      }
      const statsList: PlaybookStats[] = [];
      for (const p of PLAYBOOKS) {
        statsList.push(stats(all, p.id, 'ALL'));
        for (const s of SYMBOLS) statsList.push(stats(all, p.id, s));
      }
      const evals: EvalRun[] = [];
      for (const p of PLAYBOOKS)
        for (const a of PROP_ACCOUNTS) {
          // An eval is traded on the index futures a prop firm allows: NQ and ES (and gold where offered).
          const trades = all.filter((t) => t.playbook === p.id && t.symbol !== 'BTC');
          evals.push({ playbook: p.id, accountId: a.id, ...simulateEval(trades, a) });
        }
      const ranked = statsList.filter((s) => s.symbol !== 'ALL' && s.trades >= 8).sort((a, b) => b.avgR - a.avgR);
      const top = ranked[0];
      this.backtest = {
        days: [...days].sort(),
        ranAt: Date.now(),
        running: false,
        stats: statsList,
        evals,
        best: top && top.avgR > 0 ? { playbook: top.playbook, symbol: top.symbol as Symbol, avgR: top.avgR, trades: top.trades } : null,
        note: `${days.size} trading days of real 1-minute bars (Yahoo keeps a month). Entries on the signal bar's close, stop before target when one bar tags both, flat at 13:00 PT. No fees or slippage.`,
      };
    } catch (e) {
      this.backtest = { ...this.backtest!, running: false, note: `Backtest failed: ${(e as Error).message}` };
    }
  }

  // ---- Accounts ----------------------------------------------------------------------------------------
  private accounts(): AccountState[] {
    const px = this.projectx.state();
    return PROP_ACCOUNTS.map((rules) => {
      const s = this.saved.accounts[rules.id]!;
      const linked = s.projectxId != null ? px.accounts.find((a) => a.id === s.projectxId) : undefined;
      const balance = linked ? linked.balance : s.balance;
      const peak = Math.max(s.peak, balance);
      const threshold = Math.min(peak - rules.drawdown, rules.lockProfit == null ? Infinity : rules.size + rules.lockProfit);
      const cushion = Math.max(0, balance - threshold);
      const todayPnl = linked ? px.today.filter((t) => t.accountId === String(linked.id)).reduce((a, t) => a + t.pnl, 0) : 0;
      return { rules, balance, peak, threshold, cushion, riskPerTrade: lawOf10(cushion), toTarget: Math.max(0, rules.size + rules.profitTarget - balance), todayPnl: Math.round(todayPnl), source: linked ? 'projectx' : 'manual', active: s.active };
    });
  }

  setAccount(id: string, patch: { active?: unknown; balance?: unknown; projectxId?: unknown }): string | undefined {
    const s = this.saved.accounts[id];
    const rules = PROP_ACCOUNTS.find((a) => a.id === id);
    if (!s || !rules) return 'No such account';
    if (typeof patch.active === 'boolean') s.active = patch.active;
    if (patch.balance !== undefined) {
      const b = Number(patch.balance);
      if (!Number.isFinite(b) || b < rules.size - rules.drawdown * 2 || b > rules.size * 3) return 'That balance doesn’t look right for this account';
      s.balance = Math.round(b * 100) / 100;
      // A balance typed in is where the account stands: its peak is at least that, and a reset starts the trail over.
      s.peak = b === rules.size ? rules.size : Math.max(s.peak, b);
    }
    if (patch.projectxId === null) delete s.projectxId;
    else if (patch.projectxId !== undefined) {
      const n = Number(patch.projectxId);
      if (!Number.isSafeInteger(n)) return 'Pick one of the connected ProjectX accounts';
      s.projectxId = n;
    }
    this.save();
    return undefined;
  }

  // ---- Proposals ----------------------------------------------------------------------------------------
  private proposals(accounts: AccountState[], risky: boolean): Proposal[] {
    const out: Proposal[] = [];
    const day = tradingDay(Date.now());
    for (const sym of this.saved.markets) {
      const res = this.live.get(sym);
      if (!res) continue;
      const q = this.market.quotes().find((x) => x.symbol === sym);
      for (const p of PLAYBOOKS) {
        const v = res.views[p.id];
        const id = `${sym}:${p.id}:${day}`;
        const r = v.entry != null && v.stop != null && v.target != null && v.entry !== v.stop ? Math.round((Math.abs(v.target - v.entry) / Math.abs(v.entry - v.stop)) * 10) / 10 : null;
        const stopPts = v.entry != null && v.stop != null ? Math.abs(v.entry - v.stop) : 0;
        const checks = [...v.checks];
        if (v.stage === 'ready' || v.stage === 'watching') checks.push({ label: 'No high-impact print within 15 minutes', ok: !risky });
        out.push({
          id,
          symbol: sym,
          playbook: p.id,
          agent: p.agent,
          side: v.side,
          stage: v.stage,
          title: v.title,
          checks,
          entry: v.entry,
          stop: v.stop,
          target: v.target,
          r,
          distance: v.entry != null && q ? Math.round((v.entry - q.last) * 100) / 100 : null,
          sizing: accounts.filter((a) => a.active).map((a) => ({ accountId: a.rules.id, micros: stopPts ? microsFor(sym, a.riskPerTrade, stopPts, a.rules.maxMicros) : 0, risk: a.riskPerTrade })),
          mark: this.saved.marks[id] ?? null,
          note: risky && v.stage === 'ready' ? 'High-impact news is close: stand aside until it prints.' : v.note,
        });
      }
    }
    // What's live and ready first, then what's being watched.
    const order: Record<string, number> = { live: 0, ready: 1, won: 2, lost: 2, closed: 2, watching: 3, done: 4, failed: 4, off: 5 };
    return out.sort((a, b) => (order[a.stage] ?? 9) - (order[b.stage] ?? 9));
  }

  /** Which markets the proposals cover: at least one. */
  setMarkets(list: unknown): string | undefined {
    if (!Array.isArray(list) || !list.length || !list.every((m) => (SYMBOLS as readonly unknown[]).includes(m))) return 'Pick at least one of NQ, ES, GC and BTC';
    this.saved.markets = SYMBOLS.filter((s) => list.includes(s));
    this.save();
    return undefined;
  }

  act(id: string, action: ProposalAction): string | undefined {
    if (!/^(NQ|ES|GC|BTC):[a-z-]+:\d{4}-\d{2}-\d{2}$/.test(id) || !PLAYBOOK_BY_ID[id.split(':')[1] as PlaybookId]) return 'No such proposal';
    if (action === 'reset') delete this.saved.marks[id];
    else if (action === 'take' || action === 'skip') this.saved.marks[id] = action === 'take' ? 'taken' : 'skipped';
    else return 'Unknown action';
    this.save();
    return undefined;
  }

  // ---- The morning ----------------------------------------------------------------------------------------
  private bias(): Bias[] {
    const quotes = this.market.quotes();
    return SYMBOLS.map((sym) => {
      const lv = this.live.get(sym)?.levels;
      const q = quotes.find((x) => x.symbol === sym);
      if (!lv || !q) return { symbol: sym, direction: 'neutral' as const, lines: ['Waiting for the tape'], fit: null };
      const px = q.last;
      const d = INSTRUMENTS[sym].decimals;
      const f = (v: number) => v.toFixed(d);
      const lines: string[] = [];
      let score = 0;
      if (lv.onVwap != null) {
        const above = px > lv.onVwap;
        score += above ? 1 : -1;
        lines.push(`${above ? 'Above' : 'Below'} overnight VWAP ${f(lv.onVwap)}: ${above ? 'buyers' : 'sellers'} own the night`);
      }
      if (lv.vwap != null) {
        const above = px > lv.vwap;
        score += above ? 1 : -1;
        lines.push(`${above ? 'Above' : 'Below'} NY VWAP ${f(lv.vwap)}`);
      }
      if (lv.priorHigh != null && lv.priorLow != null) {
        if (px > lv.priorHigh) {
          score++;
          lines.push(`Trading over yesterday’s high ${f(lv.priorHigh)}: trend day risk`);
        } else if (px < lv.priorLow) {
          score--;
          lines.push(`Under yesterday’s low ${f(lv.priorLow)}: trend day risk`);
        } else lines.push(`Inside yesterday’s range ${f(lv.priorLow)}–${f(lv.priorHigh)}`);
      }
      const inValue = lv.val != null && lv.vah != null && px >= lv.val && px <= lv.vah;
      if (lv.poc != null && lv.vah != null && lv.val != null) lines.push(`Value ${f(lv.val)}–${f(lv.vah)}, POC ${f(lv.poc)}${inValue ? ' (inside value: rotation)' : ''}`);
      const trending = Math.abs(score) >= 2 && !inValue;
      const fresh = lv.zones.filter((z) => z.state === 'fresh').length;
      if (fresh) lines.push(`${fresh} fresh zone${fresh === 1 ? '' : 's'} on the 5m`);
      const fit: Bias['fit'] = trending ? (sessionAt(Date.now()).minutes < 405 ? 'double-break' : 'vwap-pullback') : inValue ? 'failed-auction' : fresh ? 'supply-demand' : 'failed-auction';
      return { symbol: sym, direction: score >= 2 ? 'long' : score <= -2 ? 'short' : 'neutral', lines, fit };
    });
  }

  private checklist(): PlaybookItem[] {
    const day = tradingDay(Date.now());
    if (this.saved.checklist.day !== day) this.saved.checklist = { day, done: [] };
    const sess = sessionAt(Date.now());
    const nq = this.live.get('NQ')?.levels;
    const auto: Record<string, boolean> = {
      calendar: this.news.feeds()[0]!.ok,
      bias: nq?.onVwap != null,
      value: nq?.poc != null,
      zones: (nq?.zones.length ?? 0) > 0,
      or: nq?.orHigh != null,
      news: !this.news.riskyNews(Date.now()),
    };
    void sess;
    return CHECKLIST.map((c) => ({ id: c.id, label: c.label, owner: c.owner, auto: !!c.auto, done: c.auto ? !!auto[c.id] : this.saved.checklist.done.includes(c.id) }));
  }

  toggleChecklist(id: string): boolean {
    const item = CHECKLIST.find((c) => c.id === id);
    if (!item || item.auto) return false;
    this.checklist();
    const done = this.saved.checklist.done;
    this.saved.checklist.done = done.includes(id) ? done.filter((x) => x !== id) : [...done, id];
    this.save();
    return true;
  }

  // ---- TradingView and Trade Pilot ----------------------------------------------------------------------------
  checkKey(key: string | null | undefined): boolean {
    return typeof key === 'string' && key.length === this.saved.webhookKey.length && key === this.saved.webhookKey;
  }

  alert(raw: string): TvAlert {
    const a: TvAlert = { id: `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`, at: Date.now(), ...parseAlert(raw) };
    this.saved.alerts = [...this.saved.alerts, a].slice(-30);
    this.save();
    void this.forwardRaw({ source: 'agent-office', kind: 'tradingview', ...a });
    return a;
  }

  rotateKey() {
    this.saved.webhookKey = randomBytes(18).toString('base64url');
    this.save();
  }

  setTradePilot(url: unknown, key: unknown): string | undefined {
    if (url === null || url === '') {
      this.saved.tradePilot = { url: null, key: null };
      this.save();
      return undefined;
    }
    let u: URL;
    try {
      u = new URL(String(url));
    } catch {
      return 'That isn’t a web address';
    }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (!(u.protocol === 'https:' || (u.protocol === 'http:' && local))) return 'Trade Pilot has to be https, or http on this machine';
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(key)) return 'Use the signal key from Trade Pilot’s TradingView connection (16–64 letters, digits, - or _)';
    this.saved.tradePilot = { url: u.origin, key };
    this.save();
    return undefined;
  }

  /** New paper setups go to Trade Pilot's signal inbox too, so both apps see the same morning. */
  private async forward(t: PaperTrade) {
    if (this.forwarded.has(t.id) || Date.now() - t.entryAt > 10 * 60_000) return;
    this.forwarded.add(t.id);
    await this.forwardRaw({ source: 'agent-office', kind: 'paper-entry', symbol: t.symbol, side: t.side, setup: PLAYBOOK_BY_ID[t.playbook].name, price: t.entry, stop: t.stop, target: t.target, why: t.why });
  }

  private async forwardRaw(payload: object) {
    const tp = this.saved.tradePilot;
    if (!tp.url || !tp.key) return;
    try {
      await fetch(`${tp.url}/api/signals/tradingview?key=${encodeURIComponent(tp.key)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(5000) });
    } catch {
      // Trade Pilot isn't running; the office carries on.
    }
  }

  /** What the desk agents read: everything but the webhook key, with the last half hour of bars. */
  private writeLive() {
    try {
      const s = this.snapshot();
      const bars = Object.fromEntries(SYMBOLS.map((sym) => [sym, s.bars[sym].slice(-30)]));
      writeFileSync(this.liveFile, JSON.stringify({ ...s, bars, webhook: undefined, note: 'Written by the office every 15 seconds. Pacific time. Paper and decision support only.' }), { mode: 0o600 });
    } catch {
      // Next time.
    }
  }

  // ---- The snapshot ------------------------------------------------------------------------------------------
  private paperBook(): PaperBook {
    const day = tradingDay(Date.now());
    const all = [...this.paperHistory.values()];
    const today = all.filter((t) => t.day === day).sort((a, b) => b.entryAt - a.entryAt);
    const recent = all.filter((t) => t.day < day).sort((a, b) => b.entryAt - a.entryAt).slice(0, 40);
    const statsList = PLAYBOOKS.map((p) => stats(all, p.id, 'ALL'));
    return { today, recent, stats: statsList, todayR: Math.round(today.reduce((a, t) => a + t.r, 0) * 100) / 100, todayDollars: Math.round(today.reduce((a, t) => a + t.dollars, 0)) };
  }

  snapshot(): TradingSnapshot {
    const now = Date.now();
    const quotes = this.market.quotes();
    const accounts = this.accounts();
    const risky = !!this.news.riskyNews(now);
    const levels = {} as Record<Symbol, Levels>;
    const bars = {} as Record<Symbol, Bar[]>;
    for (const sym of SYMBOLS) {
      const res = this.live.get(sym);
      levels[sym] = res?.levels ?? { vwap: null, vwapU1: null, vwapL1: null, onVwap: null, orHigh: null, orLow: null, onHigh: null, onLow: null, priorHigh: null, priorLow: null, poc: null, vah: null, val: null, zones: [], sr: [] };
      bars[sym] = this.market.barsOf(sym).slice(-150);
    }
    const journal = this.projectx.state();
    return {
      at: now,
      feeds: [...this.market.feeds(), ...this.news.feeds()],
      ready: quotes.length > 0,
      quotes,
      context: this.market.contextQuotes(),
      levels,
      bars,
      news: this.news.items(now),
      proposals: this.proposals(accounts, risky),
      paper: this.paperBook(),
      backtest: this.backtest,
      playbook: this.checklist(),
      bias: this.bias(),
      accounts,
      alerts: [...this.saved.alerts].reverse(),
      journal,
      session: sessionAt(now),
      webhook: { path: '/api/trading/tradingview', key: this.saved.webhookKey },
      tradePilot: { url: this.saved.tradePilot.url, forwarding: !!(this.saved.tradePilot.url && this.saved.tradePilot.key) },
      markets: this.saved.markets,
    };
  }
}

export { sessionMinute };
