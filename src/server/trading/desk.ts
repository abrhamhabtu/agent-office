import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type {
  AccountGuard, GuardLevel, RiskGuard,
  AccountState, BacktestDetail, BacktestSummary, Bar, Bias, EvalRun, Levels, PaperBook, PaperTrade, PlaybookId, PlaybookItem, PlaybookStats, Proposal, ProposalAction, PropRules, SessionInfo, Symbol, TradingSnapshot, TvAlert,
} from '../../shared/trading.js';
import { DAILY_STOP, INSTRUMENTS, lawOf10, microsFor, PLAYBOOK_BY_ID, PLAYBOOKS, PROP_ACCOUNTS, SYMBOLS } from '../../shared/trading.js';
import { byTradingDay, pacific, replayDay, RTH_CLOSE, RTH_OPEN, sessionMinute, tradingDay, type DayResult } from './engine.js';
import { runEval, weekdays } from '../../shared/evalsim.js';
import { TUNED_PLAYBOOKS } from '../../shared/tuning.js';
import { rankPlans } from '../../shared/dayplan.js';
import { Tuner, type History } from './tuner.js';
import { liveEvalView, readLiveEval, type LiveEvalConfig } from './live-eval.js';
import { cleanSetup, farmDays, runFarm, type FarmSetup, type FarmView } from '../../shared/farm.js';
import { Market, parseTradingViewBar } from './market.js';
import { readParams, reportOf, runLab, testVersions } from './lab.js';
import { Vault } from './vault.js';
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
  accounts: Record<string, { active: boolean; balance: number; peak: number; projectxId?: number; today?: { day: string; pnl: number; trades: number; losses: number } }>;
  tradePilot: { url: string | null; key: string | null };
  alerts: TvAlert[];
  /** The markets the proposals cover. */
  markets: Symbol[];
  /** The eval being run forward live, when there is one (see live-eval.ts). */
  liveEval?: LiveEvalConfig | null;
  /** The prop farm being run forward on the paper book, when there is one (see shared/farm.ts). */
  farm?: { setup: FarmSetup; startDay: string; discord: string | null; notified: number } | null;
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

/** The events the VWAP Double Break Suite sends as `event_type`: the first DB, and the re-entry after a stop (DB2). */
const SUITE_EVENTS: Record<string, { setup: string; playbook: PlaybookId }> = {
  NY_VWAP_SECOND_BREAK: { setup: 'VWAP Double Break', playbook: 'double-break' },
  NY_VWAP_RECOVERY: { setup: 'VWAP Double Break · re-entry (DB2)', playbook: 'double-break' },
};

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
  const num = (...keys: string[]) => {
    for (const k of keys) {
      const n = typeof body[k] === 'number' || (typeof body[k] === 'string' && (body[k] as string).trim() !== '') ? Number(body[k]) : NaN;
      if (Number.isFinite(n) && n > 0) return n;
    }
    return null;
  };
  const text = raw.slice(0, 500);
  const sideText = `${str('side', 'action', 'direction', 'order_action')} ${text}`;
  const side = /\b(buy|long|bull)/i.test(sideText) ? 'long' : /\b(sell|short|bear)/i.test(sideText) ? 'short' : null;
  const price = num('price', 'close', 'entry');
  const stop = num('stop', 'sl', 'stop_loss');
  const target = num('target', 'tp', 'take_profit');
  const nyVwap = num('ny_vwap', 'vwap');
  const known = SUITE_EVENTS[str('event_type', 'event').toUpperCase()];
  const ver = /^\d+\.\d+\.\d+$/.test(str('ver', 'version')) ? str('ver', 'version') : null;
  const setup = known?.setup ?? (str('setup', 'strategy', 'name', 'alert', 'title') || (Object.keys(body).length ? '' : text.split(/[\n.]/)[0]!.slice(0, 80)));
  const symbol = (str('symbol', 'ticker', 'instrument') || /\b(M?NQ|M?ES|M?GC|MBT|BTC\w*)\b/i.exec(text)?.[1] || '').toUpperCase();
  // What the alert itself says about the trade, when it has a plan: the office shows it beside its own.
  const plan = stop || target || nyVwap ? [stop ? `Stop ${stop}` : '', target ? `Target ${target}` : '', nyVwap ? `NY VWAP ${Math.round(nyVwap * 100) / 100}` : ''].filter(Boolean).join(' · ') : '';
  const message = str('message', 'msg', 'comment', 'text') || plan || (Object.keys(body).length ? '' : text);
  return { symbol, side, setup: setup || 'TradingView alert', price, message, playbook: known?.playbook ?? playbookFor(`${setup} ${text}`), stop, target, nyVwap, ver };
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

/** Plays a playbook's trades through one account's rules, sized by the Law of 10 after every trade (see shared/evalsim.ts). */
export function simulateEval(trades: PaperTrade[], rules: PropRules, days?: string[]): Omit<EvalRun, 'playbook' | 'accountId'> {
  const e = runEval(trades, rules, {}, days);
  return { result: e.result, days: e.days, pnl: e.pnl, peakCushion: e.peakCushion };
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
  /** The owner's Pine scripts, every version kept. */
  readonly vault: Vault;
  readonly news: NewsDesk;
  /** The tuned playbooks' versions, and the runs that look for better ones. */
  readonly tuner: Tuner;
  readonly projectx: ProjectX;
  private file: string;
  private paperFile: string;
  private saved: Saved;
  private live = new Map<Symbol, DayResult>();
  private liveSource = new Map<Symbol, string>();
  private liveAt = new Map<Symbol, number>();
  private paperHistory = new Map<string, PaperTrade>();
  private backtest: BacktestSummary | null = null;
  /** Every trade the last backtest took, for the Backtest Lab and the eval simulator. */
  private backtestTrades: PaperTrade[] = [];
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
    this.vault = new Vault(path.join(dataDir, 'trading', 'pine'));
    this.news = new NewsDesk(dataDir);
    this.tuner = new Tuner(path.join(dir, 'playbook-versions.json'));
    // The desk agents read the tape from this file (their terminals can't sign in to the office's API).
    this.liveFile = path.join(dir, 'live.json');
    process.env.TRADING_OFFICE_SNAPSHOT = this.liveFile;
    // The Pine Keeper reads the stored scripts from here (read-only as far as any agent is told).
    process.env.TRADING_OFFICE_PINE_DIR = this.vault.directory;
    this.projectx = new ProjectX(dataDir, this.market);
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
      liveEval: s.liveEval && typeof s.liveEval === 'object' && s.liveEval.rules && Array.isArray(s.liveEval.playbooks) ? s.liveEval : null,
      farm: s.farm && typeof s.farm === 'object' && typeof s.farm.startDay === 'string' ? { setup: cleanSetup(s.farm.setup), startDay: s.farm.startDay, discord: typeof s.farm.discord === 'string' ? s.farm.discord : null, notified: Number(s.farm.notified) || 0 } : null,
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
    this.market.onBars = (sym) => {
      if (this.liveSource.get(sym) !== this.market.barSource(sym)) {
        this.live.delete(sym); this.liveAt.delete(sym); this.liveSource.delete(sym);
      }
      this.dirty.add(sym);
    };
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
    this.timers.push(setInterval(() => this.noteMine(), 20_000));
    this.timers.push(setInterval(() => void this.notifyFarm(), 20_000));
    // The month's backtest: once the bars are in, then again after every close.
    setTimeout(() => void this.runBacktest(), 8000);
    // The Strategy lab after the backtest has fetched the history, then again after every close.
    setTimeout(() => void this.runStrategyLab(), 20_000);
    this.timers.push(
      setInterval(() => {
        const s = sessionAt(Date.now());
        if (s.minutes === RTH_CLOSE + 10 && !this.backtest?.running) void this.runBacktest();
        if (s.minutes === RTH_CLOSE + 15) void this.runStrategyLab();
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
    const tuning = this.tuner.liveTuning();
    const res = today.length ? replayDay(sym, today, prior, { live: true, tuning }) : replayDay(sym, prior, [], { live: false, tuning });
    this.liveSource.set(sym, this.market.barSource(sym));
    this.liveAt.set(sym, (today.length ? today : prior).at(-1)?.ts ?? 0);
    this.live.set(sym, res);
    // The paper book keeps every trade the day actually took, so a restart or a revised bar can't rewrite history.
    let changed = false;
    for (const t of res.trades) {
      const had = this.paperHistory.get(t.id);
      // (A trade managed another way can still be running after the playbook's own has closed: its endings are kept up too.)
      if (!had || (had.outcome === 'open' && t.outcome !== 'open') || (had.outcome === 'open' && t.outcome === 'open' && had.r !== t.r) || JSON.stringify(had.alt) !== JSON.stringify(t.alt)) {
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
    const history: History = {};
    const tuning = this.tuner.liveTuning();
    try {
      for (const sym of SYMBOLS) {
        const byDay = [...byTradingDay(await this.market.history(sym))];
        for (let i = 1; i < byDay.length; i++) {
          const [day, bars] = byDay[i]!;
          if (day >= today || bars.length < 300) continue;
          days.add(day);
          (history[sym] ??= []).push({ day, bars, prior: byDay[i - 1]![1] });
          all.push(...replayDay(sym, bars, byDay[i - 1]![1], { tuning }).trades);
        }
        // Let the office breathe between markets.
        await new Promise((r) => setTimeout(r, 50));
      }
      const statsList: PlaybookStats[] = [];
      for (const p of PLAYBOOKS) {
        statsList.push(stats(all, p.id, 'ALL'));
        for (const s of SYMBOLS) statsList.push(stats(all, p.id, s));
      }
      const sortedDays = weekdays([...days].sort());
      this.backtestTrades = all;
      const evals: EvalRun[] = [];
      for (const p of PLAYBOOKS)
        for (const a of PROP_ACCOUNTS) {
          // An eval is traded on the index futures a prop firm allows: NQ and ES (and gold where offered).
          const trades = all.filter((t) => t.playbook === p.id && t.symbol !== 'BTC');
          evals.push({ playbook: p.id, accountId: a.id, ...simulateEval(trades, a, sortedDays) });
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
        // The owner's three playbooks mixed in a day, on the markets a prop account trades.
        mixes: rankPlans(all.filter((t) => t.symbol !== 'BTC'), TUNED_PLAYBOOKS, sortedDays).slice(0, 8).map((m) => ({ label: m.label, mode: m.plan.mode, order: m.plan.order, trades: m.stats.trades, winRate: m.stats.winRate, avgR: m.stats.avgR, totalR: m.stats.totalR, maxDrawdownR: m.stats.maxDrawdownR, laterAvgR: m.laterAvgR })),
        note: `${days.size} trading days of real 1-minute bars (Yahoo keeps a month). Entries on the signal bar's close, stop before target when one bar tags both, flat at 13:00 PT. No fees or slippage.`,
      };
      // The tuner follows every backtest, in the background: the boards don't wait for it.
      void this.tuner.run(history, all, [...days].sort()).catch(() => {});
    } catch (e) {
      this.backtest = { ...this.backtest!, running: false, note: `Backtest failed: ${(e as Error).message}` };
    }
  }

  /** The last backtest trade by trade (the snapshot only carries its totals). */
  backtestDetail(): BacktestDetail {
    return { ranAt: this.backtest?.ranAt ?? 0, days: this.backtest?.days ?? [], trades: this.backtestTrades, versions: this.tuner.versionTrades() };
  }

  /** The owner's call on a playbook version. Making one live changes what trades from here on, so everything is replayed. */
  setVersion(playbook: unknown, version: unknown, status: unknown): string | undefined {
    if (!TUNED_PLAYBOOKS.includes(playbook as PlaybookId)) return 'That playbook has no versions';
    if (this.tuner.busy || this.backtest?.running) return 'The tuner is still running: try again in a moment';
    const why = this.tuner.setStatus(playbook as PlaybookId, Number(version), status);
    if (why) return why;
    if (status === 'live') {
      for (const sym of SYMBOLS) this.replay(sym);
      void this.runBacktest();
    }
    return undefined;
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
      // Today: the real fills when ProjectX is linked, otherwise what was logged by hand for today.
      const day = tradingDay(Date.now());
      const fills = linked ? px.today.filter((t) => t.accountId === String(linked.id)) : [];
      const manual = s.today?.day === day ? s.today : { pnl: 0, trades: 0, losses: 0 };
      const todayPnl = linked ? fills.reduce((a, t) => a + t.pnl, 0) : manual.pnl;
      return {
        rules, balance, peak, threshold, cushion, riskPerTrade: lawOf10(cushion), toTarget: Math.max(0, rules.size + rules.profitTarget - balance), todayPnl: Math.round(todayPnl),
        lossesToday: linked ? fills.filter((t) => t.pnl < 0).length : manual.losses,
        tradesToday: linked ? fills.length : manual.trades,
        source: linked ? 'projectx' : 'manual', active: s.active,
      };
    });
  }

  setAccount(id: string, patch: { active?: unknown; balance?: unknown; projectxId?: unknown; log?: unknown; resetToday?: unknown }): string | undefined {
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
    // A trade logged by hand (for an account ProjectX doesn't follow): its P&L moves today and the balance.
    if (patch.log !== undefined) {
      const pnl = Number(patch.log);
      if (!Number.isFinite(pnl) || Math.abs(pnl) > rules.drawdown * 2) return 'That P&L doesn’t look right';
      const day = tradingDay(Date.now());
      const t = s.today?.day === day ? s.today : { day, pnl: 0, trades: 0, losses: 0 };
      s.today = { day, pnl: Math.round((t.pnl + pnl) * 100) / 100, trades: t.trades + 1, losses: t.losses + (pnl < 0 ? 1 : 0) };
      s.balance = Math.round((s.balance + pnl) * 100) / 100;
      if (rules.drawdownType === 'trailing-intraday') s.peak = Math.max(s.peak, s.balance);
    }
    if (patch.resetToday === true) delete s.today;
    if (patch.projectxId === null) delete s.projectxId;
    else if (patch.projectxId !== undefined) {
      const n = Number(patch.projectxId);
      if (!Number.isSafeInteger(n)) return 'Pick one of the connected ProjectX accounts';
      s.projectxId = n;
    }
    this.save();
    return undefined;
  }

  // ---- The risk guard ----------------------------------------------------------------------------------
  /**
   * Can you take a trade right now, and how big? High-impact news (15 minutes before to 5 after), the last
   * quarter hour before the close, your daily stop (three losses, or down two risks), how close the account
   * is to its threshold, and the consistency rule's cap on one day's profit.
   */
  private guard(accounts: AccountState[], now: number): RiskGuard {
    const sess = sessionAt(now);
    const reasons: RiskGuard['reasons'] = [];
    const cal = this.news.items(now).filter((n) => n.kind === 'calendar' && n.impact === 'high');
    const lock = cal.find((n) => n.at - now <= 15 * 60_000 && now - n.at <= 5 * 60_000);
    const soon = cal.filter((n) => n.at > now).sort((a, b) => a.at - b.at)[0];
    const mins = (ms: number) => {
      const m = Math.max(0, Math.round(ms / 60_000));
      return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
    };
    const title = (h: string) => h.split(' · ')[0]!;
    if (lock) reasons.push({ label: lock.at > now ? `${title(lock.headline)} in ${mins(lock.at - now)}: no new trades until 5 minutes after` : `${title(lock.headline)} just printed: let the spike settle`, level: 'stop' });
    else if (soon && soon.at - now <= 60 * 60_000) reasons.push({ label: `${title(soon.headline)} in ${mins(soon.at - now)}: be flat or tight before it`, level: 'warn' });
    else reasons.push({ label: soon ? `No high-impact news for ${mins(soon.at - now)}` : 'No high-impact news left this week', level: 'ok' });
    if (sess.weekend || sess.phase === 'closed') reasons.push({ label: 'Market closed', level: 'warn' });
    else if (sess.minutes >= RTH_CLOSE - 15 && sess.minutes < RTH_CLOSE) reasons.push({ label: 'Last 15 minutes: flat by the 13:00 close, no new trades', level: 'stop' });
    else if (sess.phase === 'overnight' || sess.phase === 'premarket') reasons.push({ label: 'Outside the New York session: thinner tape, smaller size', level: 'warn' });
    else if (sess.phase === 'ORB') reasons.push({ label: 'Opening range still setting (until 06:45)', level: 'warn' });
    else reasons.push({ label: 'New York session open', level: 'ok' });
    const worst = (xs: { level: GuardLevel }[]): GuardLevel => (xs.some((x) => x.level === 'stop') ? 'stop' : xs.some((x) => x.level === 'warn') ? 'warn' : 'ok');
    const market = worst(reasons);
    const per: AccountGuard[] = accounts
      .filter((a) => a.active)
      .map((a) => {
        const r: AccountGuard['reasons'] = [];
        const stopDollars = DAILY_STOP.risks * a.riskPerTrade;
        const dailyStopLeft = Math.max(0, stopDollars + Math.min(0, a.todayPnl));
        if (a.lossesToday >= DAILY_STOP.losses) r.push({ label: `${a.lossesToday} losses today: daily stop hit, walk away`, level: 'stop' });
        else if (a.todayPnl <= -stopDollars) r.push({ label: `Down ${Math.abs(a.todayPnl)} today (two risks): daily stop hit`, level: 'stop' });
        else if (a.lossesToday === DAILY_STOP.losses - 1) r.push({ label: `${a.lossesToday} losses today: one more ends the day`, level: 'warn' });
        const frac = a.cushion / a.rules.drawdown;
        if (a.cushion <= 0) r.push({ label: 'At the threshold: the account is done', level: 'stop' });
        else if (frac < 0.25) r.push({ label: `Only $${Math.round(a.cushion)} of drawdown left: stop, reset, come back tomorrow`, level: 'stop' });
        else if (frac < 0.5) r.push({ label: `Half the drawdown gone ($${Math.round(a.cushion)} left): Law of 10 already sized you down`, level: 'warn' });
        const dayCap = a.rules.consistencyPercent ? Math.round((a.rules.consistencyPercent / 100) * a.rules.profitTarget) : null;
        if (dayCap != null && a.todayPnl >= dayCap) r.push({ label: `Up $${a.todayPnl} today: at the ${a.rules.consistencyPercent}% consistency cap ($${dayCap}), stop for the day`, level: 'stop' });
        else if (dayCap != null && a.todayPnl >= dayCap * 0.8) r.push({ label: `Near the consistency cap ($${dayCap} a day)`, level: 'warn' });
        if (!r.length) r.push({ label: `Clear: risk up to $${a.riskPerTrade}, daily stop $${dailyStopLeft} away`, level: 'ok' });
        const level = worst([...r, { level: market === 'stop' ? 'stop' : 'ok' }]);
        return { accountId: a.rules.id, level, reasons: r, maxRisk: level === 'stop' ? 0 : a.riskPerTrade, dailyStopLeft, dayCap };
      });
    const level = market === 'stop' ? 'stop' : per.length && per.every((p) => p.level === 'stop') ? 'stop' : market === 'warn' || per.some((p) => p.level !== 'ok') ? 'warn' : 'ok';
    const first = reasons.find((x) => x.level === level) ?? per.flatMap((p) => p.reasons).find((x) => x.level === level);
    const headline = level === 'ok' ? 'Clear to trade' : level === 'stop' ? `Stand down: ${first?.label ?? 'every account is stopped'}` : `Careful: ${first?.label ?? ''}`;
    return { level, headline, reasons, news: lock ? { title: title(lock.headline), at: lock.at } : soon ? { title: title(soon.headline), at: soon.at } : null, accounts: per };
  }

  // ---- Proposals ----------------------------------------------------------------------------------------
  /** When each proposal was first seen in its current stage (this run of the office), for the board's timer. */
  private stages = new Map<string, { stage: string; at: number }>();
  private stageSince(id: string, stage: string): number {
    const hit = this.stages.get(id);
    if (hit && hit.stage === stage) return hit.at;
    const at = Date.now();
    this.stages.set(id, { stage, at });
    return at;
  }

  private proposals(accounts: AccountState[], risky: boolean, guard: RiskGuard): Proposal[] {
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
        if (v.stage === 'ready' || v.stage === 'watching') checks.push({ label: 'Risk guard clear', ok: guard.level !== 'stop' });
        out.push({
          id,
          symbol: sym,
          dataAt: this.liveAt.get(sym),
          dataSource: this.liveSource.get(sym),
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
          sizing: accounts.filter((a) => a.active).map((a) => {
            const g = guard.accounts.find((x) => x.accountId === a.rules.id);
            const risk = g ? g.maxRisk : a.riskPerTrade;
            return { accountId: a.rules.id, micros: stopPts && risk ? microsFor(sym, risk, stopPts, a.rules.maxMicros) : 0, risk };
          }),
          triggeredAt: v.triggeredAt ?? null,
          endedAt: v.endedAt ?? null,
          stageSince: this.stageSince(id, v.stage),
          mark: this.saved.marks[id] ?? null,
          note: guard.level === 'stop' && (v.stage === 'ready' || v.stage === 'watching') ? `🛡️ ${guard.headline}` : risky && v.stage === 'ready' ? 'High-impact news is close: stand aside until it prints.' : v.note,
        });
      }
    }
    // What's live and ready first, then what's being watched.
    const order: Record<string, number> = { live: 0, ready: 1, won: 2, lost: 2, closed: 2, watching: 3, done: 4, failed: 4, off: 5 };
    return out.sort((a, b) => (order[a.stage] ?? 9) - (order[b.stage] ?? 9));
  }

  /** Starts the farm on the paper book (from today, or from as far back as the book goes), stops it, or sets where its notices go. */
  setFarm(b: Record<string, unknown>): string | undefined {
    if (b.action === 'stop') this.saved.farm = null;
    else if (b.action === 'discord') {
      if (!this.saved.farm) return 'Start the farm first';
      const url = typeof b.url === 'string' ? b.url.trim() : '';
      if (url && !/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[\w-]+$/.test(url)) return 'That isn’t a Discord webhook address';
      this.saved.farm.discord = url || null;
    } else {
      const today = tradingDay(Date.now());
      const first = [...this.paperHistory.values()].reduce<string | null>((a, t) => (a == null || t.day < a ? t.day : a), null);
      const monthAgo = new Date(Date.parse(`${today}T12:00:00Z`) - 31 * 86_400_000).toISOString().slice(0, 10);
      const startDay = b.from === 'back' && first ? (first > monthAgo ? first : monthAgo) : today;
      this.saved.farm = { setup: cleanSetup(b.setup), startDay, discord: this.saved.farm?.discord ?? null, notified: 0 };
      // What already happened on the days it's counting isn't news.
      this.saved.farm.notified = this.farmView()?.run.events.length ?? 0;
    }
    this.save();
    return undefined;
  }

  /** The farm so far: its setup run over the paper book's days since it started. */
  private farmView(): FarmView | null {
    const f = this.saved.farm;
    if (!f) return null;
    const today = tradingDay(Date.now());
    const days = weekdays(Array.from({ length: 400 }, (_, i) => new Date(Date.parse(`${f.startDay}T12:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10)).filter((d) => d <= today));
    const paper = [...this.paperHistory.values()].filter((t) => t.day >= f.startDay);
    return { setup: f.setup, startDay: f.startDay, run: runFarm(farmDays(paper, f.setup.strategy, days), f.setup, days), discord: !!f.discord };
  }

  /** Sends what has happened on the farm since the last look to its Discord webhook, in order. */
  private async notifyFarm() {
    const f = this.saved.farm;
    if (!f) return;
    const events = this.farmView()?.run.events ?? [];
    if (events.length <= f.notified) return;
    const fresh = events.slice(f.notified);
    f.notified = events.length;
    this.save();
    if (!f.discord) return;
    const icon = { bought: '🧾', passed: '✅', busted: '💥', 'payout-ready': '💰', paid: '🏦', trade: '📈', skip: '⏭️', note: '📝' } as const;
    for (const e of fresh.slice(-10)) {
      try {
        await fetch(f.discord, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'Prop Farm (paper)', content: `${icon[e.kind]} **${e.account || `Slot ${e.slot + 1}`}** · ${e.text}` }), signal: AbortSignal.timeout(5000) });
      } catch {
        // Discord is unreachable; the farm carries on.
      }
    }
  }

  /** Starts a live eval from what the simulator has on screen, or stops the one that's running. */
  setLiveEval(b: Record<string, unknown>): string | undefined {
    if (b.action === 'stop') this.saved.liveEval = null;
    else {
      const today = tradingDay(Date.now());
      const firstPaper = [...this.paperHistory.values()].reduce<string | null>((a, t) => (a == null || t.day < a ? t.day : a), null);
      const cfg = readLiveEval(b, today, firstPaper, PROP_ACCOUNTS.find((a) => this.saved.accounts[a.id]?.active)?.id ?? null);
      if (typeof cfg === 'string') return cfg;
      this.saved.liveEval = cfg;
      this.noteMine();
    }
    this.save();
    return undefined;
  }

  /** Keeps what the owner's own account has made today, for the live eval to be measured against. */
  private noteMine() {
    const cfg = this.saved.liveEval;
    if (!cfg?.mineAccount) return;
    const mine = this.accounts().find((a) => a.rules.id === cfg.mineAccount);
    if (!mine) return;
    const day = tradingDay(Date.now());
    const pnl = Math.round(mine.todayPnl);
    // A day with nothing on it yet isn't written down, so the owner's line only starts when they trade.
    if (cfg.mine[day] === pnl || (cfg.mine[day] == null && pnl === 0 && !mine.tradesToday)) return;
    cfg.mine[day] = pnl;
    this.save();
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

  /**
   * What TradingView posted: a bar-close candle (`"type":"bar"`) goes to the market feed, anything else is
   * an alert for the desk as before. A refused candle says why, so the alert's own log shows it.
   */
  tradingView(raw: string): { kind: 'bar'; symbol: Symbol } | { kind: 'alert'; alert: TvAlert } | { error: string } {
    let body: unknown = null;
    try {
      body = JSON.parse(raw);
    } catch {
      // Plain text: an alert.
    }
    if (body && typeof body === 'object' && (body as { type?: unknown }).type === 'bar') {
      const r = parseTradingViewBar(body);
      if ('error' in r) return r;
      this.market.setTradingViewBar(r.symbol, r.bar);
      return { kind: 'bar', symbol: r.symbol };
    }
    return { kind: 'alert', alert: this.alert(raw) };
  }

  private labRunning = false;

  /**
   * The Strategy lab: replays the live Pine version on the real history, tests the saved versions and
   * every single-setting change to it, and saves a new candidate (marked new) when one genuinely holds up.
   * Nothing goes live from here; the owner decides.
   */
  async runStrategyLab(): Promise<void> {
    if (this.labRunning) return;
    this.labRunning = true;
    const started = Date.now();
    const id = 'vwap-double-break';
    const stage = (text: string) => this.vault.setLab({ running: true, stage: text });
    stage('Starting: reading the live version');
    let note = '';
    try {
      const live = this.vault.live(id);
      const src = live ? this.vault.source(id, live) : null;
      const params = src ? readParams(src) : null;
      if (!live || !src) note = 'Nothing is live in the Vault, so there is nothing to test against';
      else if (!params) note = `v${live} doesn’t look like the VWAP Double Break script, so the lab can’t read its settings`;
      else {
        const histories: Partial<Record<Symbol, Bar[]>> = {};
        for (const sym of ['NQ', 'GC', 'ES'] as Symbol[]) {
          stage(`Loading a month of 1-minute ${sym} history`);
          histories[sym] = await this.market.history(sym).catch(() => []);
        }
        stage(`Replaying v${live} on 5-minute bars, then trying each change to its settings`);
        const res = runLab(histories, params, live);
        if ('error' in res) note = res.error;
        else {
          this.vault.setTest(id, live, res.baseline);
          stage('Re-testing the other saved versions against the live one');
          // The versions already saved, each against the live one.
          const others = (this.vault.view().scripts.find((x) => x.id === id)?.versions ?? []).filter((v) => v.version !== live && v.status !== 'retired').flatMap((v) => {
            const p = readParams(this.vault.source(id, v.version) ?? '');
            return p ? [{ version: v.version, params: p }] : [];
          });
          for (const [version, test] of testVersions(histories, params, live, others)) this.vault.setTest(id, version, test);
          note = res.note;
          let saved: string | null = null;
          const existing = res.best ? this.vault.versionWithParams(id, res.best.params) : null;
          if (existing) note = `${res.note}. Already saved as v${existing}`;
          if (res.best && !existing) {
            const r = this.vault.addFromLab(id, { from: live, params: res.best.params, change: res.best.change, test: res.best.test });
            if ('version' in r) {
              saved = r.version;
              note = `${res.note}. Saved as v${r.version}, waiting for you`;
            } else note = `${res.note}, but couldn’t save it: ${r.error}`;
          }
          const name = this.vault.view().scripts.find((x) => x.id === id)?.name ?? id;
          this.vault.setLab({ report: reportOf(res, { script: id, scriptName: name, version: live, bars: Object.fromEntries(Object.entries(histories).map(([k, v]) => [k, v?.length ?? 0])), took: Date.now() - started, saved, existing, retested: others.map((o) => o.version) }) });
        }
      }
    } catch (e) {
      note = `The lab stopped: ${(e as Error).message}`;
    } finally {
      this.labRunning = false;
      this.vault.setLab({ running: false, stage: '', ranAt: Date.now(), note });
    }
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
    const guard = this.guard(accounts, now);
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
      proposals: this.proposals(accounts, risky, guard),
      guard,
      paper: this.paperBook(),
      backtest: this.backtest ? { ...this.backtest, tuner: this.tuner.view() } : null,
      farm: this.farmView(),
      liveEval: this.saved.liveEval ? liveEvalView(this.saved.liveEval, [...this.paperHistory.values()], tradingDay(now)) : null,
      playbook: this.checklist(),
      bias: this.bias(),
      accounts,
      alerts: [...this.saved.alerts].reverse(),
      journal,
      projectXMarketEnabled: this.projectx.marketEnabled(),
      session: sessionAt(now),
      webhook: { path: '/api/trading/tradingview', key: this.saved.webhookKey },
      tradePilot: { url: this.saved.tradePilot.url, forwarding: !!(this.saved.tradePilot.url && this.saved.tradePilot.key) },
      markets: this.saved.markets,
      vault: this.vault.view(),
    };
  }
}

export { sessionMinute };
