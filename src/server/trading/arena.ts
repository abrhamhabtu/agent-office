import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Bar, PaperTrade, PropRules } from '../../shared/trading.js';
import {
  act,
  buildMenu,
  cleanProbs,
  COACH_COOLDOWN,
  CRYPTO_RULES,
  designDraft,
  endDay,
  ENGINES,
  enginesOf,
  isEngine,
  futuresRules,
  houseProbs,
  houseVerdict,
  mark,
  marketsOf,
  newTrader,
  onBar,
  pick,
  plot,
  scoreOf,
  seeded,
  starters,
  Tape,
  TRADER_COLORS,
  traderView,
  type ArenaView,
  type BacktestReport,
  type LabView,
  type Banner,
  type BrainView,
  type CoachRound,
  type Decision,
  type Draft,
  type EngineId,
  type Fallen,
  type League,
  type LeagueRules,
  type MarketView,
  type MenuOption,
  type Moment,
  type Signal,
  type TapeView,
  type TraderDef,
  type TraderState,
} from '../../shared/arena.js';
import { parseCoinbaseCandles } from './market.js';
import { byTradingDay, RTH_CLOSE, RTH_OPEN, sessionMinute } from './engine.js';

// The Arena's floor manager: it feeds the engine (shared/arena.ts) bars, asks a brain when there is a real
// choice, writes every decision down and streams the result to whoever is watching.
//
// Two leagues. Futures replays the office's own month of minute bars a session at a time, because the
// market is shut most of the week and a race nobody can watch is no race; the tape only moves while
// someone is watching. Crypto never shuts: it follows Coinbase's public minute candles as they close.
//
// The brain is the house's (the engines' own scores, no model, free) unless the owner switches it to a
// model, which is asked through an agent CLI already on this machine: Claude Code, Codex, OpenCode or
// Gemini, the harnesses the office hires workers on. A brain only ever picks a
// label off the menu: it never sees a size, a stop or anything that could place an order, and when it
// doesn't answer the trader holds and opens nothing.

const MAX_TRADERS = 6;
const KEEP_DECISIONS = 90;
const COINBASE: Record<string, string> = { BTC: 'BTC-USD', ETH: 'ETH-USD', SOL: 'SOL-USD' };
const SPEEDS = [1, 5, 20, 60];
const SPEED = 20;
const MODELS: Record<string, string> = { 'claude-opus-5-5': 'Opus 5.5', 'claude-sonnet-5-5': 'Sonnet 5.5', 'claude-haiku-4-5-20251001': 'Haiku 4.5' };
const CALL_CAP = 250;
/** The harnesses a model can be asked through: each is its own CLI, signed in by the owner. */
const HARNESS = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', gemini: 'Gemini CLI' } as const;
type HarnessId = keyof typeof HARNESS;
const isHarness = (v: unknown): v is HarnessId => typeof v === 'string' && v in HARNESS;
/** How often a brain is asked about a trade that is already on. */
const MANAGE_EVERY = 5;

export interface ArenaDeps {
  dir: string;
  /** The evaluation the futures league runs. */
  prop: PropRules;
  /** About a month of minute bars for a futures market. */
  history(symbol: string): Promise<Bar[]>;
  /** What the office's playbooks took on one day of one market, given the day before: the setups the futures traders are offered. */
  replay(symbol: string, bars: Bar[], prior: Bar[]): PaperTrade[];
  /** The trading day it is now. */
  today(): string;
  now(): number;
  /** The Claude Code CLI, when the owner wants Claude as the brain. */
  claude: string;
  fetchJson?(url: string): Promise<unknown>;
}

interface Session {
  day: string;
  times: number[];
  bars: Map<string, Map<number, Bar>>;
  warm: Map<string, Bar[]>;
  /** The playbooks' setups, by the bar they were called on. */
  signals: Map<number, Signal[]>;
}

interface Saved {
  traders: TraderState[];
  decisions: Decision[];
  banners: Banner[];
  fallen: Fallen[];
  rounds: CoachRound[];
  rewrites: number;
  /** Futures: where the tape is. Crypto: the last bar dealt with. */
  day: string;
  ts: number;
  speed: number;
  playing: boolean;
  mode: 'replay' | 'live';
}

class Run {
  traders: TraderState[] = [];
  decisions: Decision[] = [];
  banners: Banner[] = [];
  fallen: Fallen[] = [];
  rounds: CoachRound[] = [];
  rewrites = 0;
  vetoes: ArenaView['vetoes'] = [];
  tapes = new Map<string, Tape>();
  views = new Map<string, MarketView>();
  opens = new Map<string, number>();
  day = '';
  ts = 0;
  speed = SPEED;
  playing = true;
  mode: 'replay' | 'live' = 'replay';
  note = '';
  dirty = true;
  /** Wall-clock times of the latest decisions, for the per-minute rate. */
  recent: number[] = [];
  bars = 0;
  /** What each idle trader last told the stream, so it isn't said twice. */
  said = new Map<string, string>();

  constructor(
    readonly league: League,
    readonly rules: LeagueRules,
  ) {}
}

export class Arena {
  private runs: Record<League, Run>;
  private sessions: Session[] = [];
  private sessionAt = -1;
  private cursor = 0;
  private loading: Promise<void> | null = null;
  private seq = 0;
  private brain: { kind: 'house' | HarnessId; model: string } = { kind: 'house', model: 'claude-opus-5-5' };
  private brainDay = '';
  private calls = 0;
  private usd = 0;
  private brainError = '';
  private listeners = new Set<(league: League, view: ArenaView) => void>();
  private timers: NodeJS.Timeout[] = [];
  private busy = false;
  private credit = 0;
  private cryptoBusy = false;
  private cryptoNote = 'Connecting to Coinbase';
  private cryptoLive = false;
  private file: string;
  private savedAt = 0;
  private labs: Partial<Record<League, { key: string; view: Promise<LabView> }>> = {};
  private cryptoPast: { at: number; bars: Map<string, Bar[]> } | null = null;

  constructor(private deps: ArenaDeps) {
    mkdirSync(deps.dir, { recursive: true });
    this.file = path.join(deps.dir, 'arena.json');
    this.runs = { futures: new Run('futures', futuresRules(deps.prop)), crypto: new Run('crypto', CRYPTO_RULES) };
    let saved: { brain?: Arena['brain']; futures?: Partial<Saved>; crypto?: Partial<Saved>; seq?: number } = {};
    try {
      saved = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      // A new arena.
    }
    if (saved.brain && (saved.brain.kind === 'house' || isHarness(saved.brain.kind)) && MODELS[saved.brain.model]) this.brain = saved.brain;
    this.seq = Number(saved.seq) || 0;
    for (const league of ['futures', 'crypto'] as League[]) {
      const run = this.runs[league];
      const s = saved[league];
      if (s && Array.isArray(s.traders) && s.traders.length) {
        run.traders = s.traders;
        run.decisions = s.decisions ?? [];
        run.banners = s.banners ?? [];
        run.fallen = s.fallen ?? [];
        run.rounds = s.rounds ?? [];
        run.rewrites = s.rewrites ?? 0;
        run.day = s.day ?? '';
        run.ts = s.ts ?? 0;
        run.speed = SPEEDS.includes(s.speed!) ? s.speed! : SPEED;
        run.playing = s.playing !== false;
      } else run.traders = starters(league, deps.now()).map((d) => newTrader(d, run.rules));
    }
  }

  start() {
    this.timers.push(setInterval(() => void this.tickFutures(), 200));
    this.timers.push(setInterval(() => void this.tickCrypto(), 20_000));
    this.timers.push(setInterval(() => this.flush(), 250));
    void this.tickCrypto();
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.save(true);
  }

  /** Hears every change, throttled: the stream behind the console. */
  subscribe(fn: (league: League, view: ArenaView) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private flush() {
    for (const run of Object.values(this.runs)) {
      if (!run.dirty) continue;
      run.dirty = false;
      if (!this.listeners.size) continue;
      const view = this.view(run.league);
      this.listeners.forEach((fn) => fn(run.league, view));
    }
    this.save(false);
  }

  private save(now: boolean) {
    if (!now && this.deps.now() - this.savedAt < 20_000) return;
    this.savedAt = this.deps.now();
    const keep = (run: Run): Saved => ({ traders: run.traders, decisions: run.decisions.slice(-40), banners: run.banners.slice(-12), fallen: run.fallen.slice(-60), rounds: run.rounds.slice(-12), rewrites: run.rewrites, day: run.day, ts: run.ts, speed: run.speed, playing: run.playing, mode: run.mode });
    try {
      writeFileSync(this.file, JSON.stringify({ v: 1, seq: this.seq, brain: this.brain, futures: keep(this.runs.futures), crypto: keep(this.runs.crypto) }));
    } catch {
      // Not saved this time.
    }
  }

  // ---- The futures tape -----------------------------------------------------------------------------------

  /**
   * Cuts the month into sessions, a trading day each (the Globex open to the New York close), with the end
   * of the day before to warm the averages, and has the office's playbooks call their setups on each.
   */
  private async load() {
    const markets = marketsOf('futures');
    const byDay = new Map<string, Session>();
    for (const m of markets) {
      let bars: Bar[] = [];
      try {
        bars = await this.deps.history(m);
      } catch {
        // No history for this market: the sessions it is missing from are left out.
      }
      const days = [...byTradingDay(bars)];
      for (let i = 1; i < days.length; i++) {
        const [day, mine] = days[i]!;
        const prior = days[i - 1]![1];
        if (mine.length < 300) continue;
        let s = byDay.get(day);
        if (!s) byDay.set(day, (s = { day, times: [], bars: new Map(), warm: new Map(), signals: new Map() }));
        s.bars.set(m, new Map(mine.map((b) => [b.ts, b])));
        s.warm.set(m, prior.slice(-120));
        for (const t of this.deps.replay(m, mine, prior)) {
          const list = s.signals.get(t.entryAt) ?? [];
          list.push({ engine: t.playbook, market: m, side: t.side, stop: t.stop, target: t.target, why: t.why });
          s.signals.set(t.entryAt, list);
        }
      }
      // Let the office breathe between markets.
      await new Promise((r) => setTimeout(r, 20));
    }
    const today = this.deps.today();
    this.sessions = [...byDay.values()].filter((s) => s.day < today && markets.every((m) => s.bars.has(m))).sort((a, b) => a.day.localeCompare(b.day));
    for (const s of this.sessions) s.times = [...new Set(markets.flatMap((m) => [...s.bars.get(m)!.keys()]))].sort((a, b) => a - b);
    const run = this.runs.futures;
    if (!this.sessions.length) {
      run.note = 'No recorded sessions yet: the office fetches a month of minute bars when the market desk starts';
      return;
    }
    // Pick up where the tape was left: the averages are rebuilt from the bars before it, with no trading.
    const at = this.sessions.findIndex((s) => s.day === run.day);
    this.openSession(at >= 0 ? at : 0);
    if (at >= 0) {
      const s = this.sessions[at]!;
      while (this.cursor < s.times.length && s.times[this.cursor]! <= run.ts) this.feed(run, s, s.times[this.cursor++]!);
    }
    run.dirty = true;
  }

  private openSession(index: number) {
    const run = this.runs.futures;
    const s = this.sessions[index]!;
    this.sessionAt = index;
    this.cursor = 0;
    run.tapes.clear();
    run.views.clear();
    for (const m of marketsOf('futures')) {
      const tape = new Tape(m);
      (s.warm.get(m) ?? []).forEach((b, i) => tape.push(b, i === 0));
      run.tapes.set(m, tape);
    }
  }

  /** Puts one minute's bars on the tapes. */
  private feed(run: Run, s: Session, ts: number): Map<string, Bar> {
    const bars = new Map<string, Bar>();
    for (const m of marketsOf('futures')) {
      const b = s.bars.get(m)?.get(ts);
      if (!b) continue;
      const fresh = this.cursor === 0 || !run.opens.has(`${s.day}:${m}`);
      if (fresh) run.opens.set(`${s.day}:${m}`, b.open);
      run.views.set(m, run.tapes.get(m)!.push(b, fresh));
      bars.set(m, b);
    }
    return bars;
  }

  private async tickFutures() {
    const run = this.runs.futures;
    if (this.busy) return;
    this.busy = true;
    try {
      if (!this.sessions.length && !this.loading) this.loading = this.load();
      if (this.loading) {
        await this.loading;
        this.loading = null;
      }
      // The tape moves only while someone is watching it.
      if (!run.playing || !this.listeners.size || this.sessionAt < 0 || run.mode !== 'replay') return;
      this.credit = Math.min(60, this.credit + run.speed * 0.2);
      while (this.credit >= 1) {
        this.credit -= 1;
        if (!(await this.stepReplay())) break;
      }
    } finally {
      this.busy = false;
    }
  }

  /** Plays the next minute of the tape. False when the tape has run out. */
  private async stepReplay(): Promise<boolean> {
    const run = this.runs.futures;
    let s = this.sessions[this.sessionAt]!;
    if (this.cursor >= s.times.length) {
      await this.closeSession(run, s.times.at(-1) ?? run.ts);
      if (this.sessionAt + 1 >= this.sessions.length) {
        run.playing = false;
        run.note = 'ended';
        run.dirty = true;
        return false;
      }
      this.openSession(this.sessionAt + 1);
      s = this.sessions[this.sessionAt]!;
    }
    const ts = s.times[this.cursor]!;
    const bars = this.feed(run, s, ts);
    this.cursor++;
    const minute = sessionMinute(ts);
    await this.step(run, { league: 'futures', ts, day: s.day, minute, canEnter: minute < RTH_CLOSE - 30, mustFlatten: minute >= RTH_CLOSE - 5, sessionOpen: RTH_OPEN, signals: s.signals.get(ts) }, bars, this.brain.kind !== 'house');
    return true;
  }

  /** A session is over: the floors trail, evaluations pass, and the Desk Head makes his round. */
  private async closeSession(run: Run, ts: number) {
    for (const t of run.traders) {
      const before = { gen: t.gen, equity: t.equity };
      const out = endDay(t, ts, run.rules);
      t.day = '';
      this.record(run, out.decisions, out.banners);
      if (t.gen !== before.gen) this.bury(run, t, before, 'passed', ts);
    }
    await this.coachRound(run, ts);
  }

  // ---- The crypto tape: Coinbase's public minute candles, as they close ---------------------------------

  private async tickCrypto() {
    if (this.cryptoBusy) return;
    this.cryptoBusy = true;
    const run = this.runs.crypto;
    try {
      const get = this.deps.fetchJson ?? (async (url: string) => (await fetch(url, { headers: { 'user-agent': 'agent-office' }, signal: AbortSignal.timeout(10_000) })).json());
      const now = this.deps.now();
      const closedBefore = Math.floor(now / 60_000) * 60_000;
      const fresh = new Map<string, Map<number, Bar>>();
      for (const m of marketsOf('crypto')) {
        const bars = parseCoinbaseCandles(await get(`https://api.exchange.coinbase.com/products/${COINBASE[m]}/candles?granularity=60`), now).filter((b) => b.ts < closedBefore);
        fresh.set(m, new Map(bars.map((b) => [b.ts, b])));
      }
      const times = [...new Set([...fresh.values()].flatMap((x) => [...x.keys()]))].sort((a, b) => a - b);
      if (!times.length) throw new Error('no candles');
      // The first hour only warms the averages; a tape picked up after a restart is rebuilt up to where it was.
      const firstRun = run.tapes.size === 0;
      if (firstRun) for (const m of marketsOf('crypto')) run.tapes.set(m, new Tape(m));
      const tradeFrom = firstRun ? Math.max(run.ts + 60_000, times[Math.min(60, times.length - 1)]!) : run.ts + 60_000;
      const last = Math.max(0, ...[...run.views.values()].map((v) => v.ts));
      for (const ts of times) {
        if (ts <= last) continue;
        const day = new Date(ts).toISOString().slice(0, 10);
        const bars = new Map<string, Bar>();
        for (const m of marketsOf('crypto')) {
          const b = fresh.get(m)!.get(ts);
          if (!b) continue;
          const key = `${day}:${m}`;
          const freshDay = !run.opens.has(key);
          if (freshDay) run.opens.set(key, b.open);
          run.views.set(m, run.tapes.get(m)!.push(b, freshDay));
          bars.set(m, b);
        }
        if (ts < tradeFrom) continue;
        const d = new Date(ts);
        // Catching up on history is the house's work: a model is only asked about a bar as it closes.
        const live = now - ts < 3 * 60_000;
        await this.step(run, { league: 'crypto', ts, day, minute: d.getUTCHours() * 60 + d.getUTCMinutes(), canEnter: true, mustFlatten: false, sessionOpen: 0 }, bars, live && this.brain.kind !== 'house');
        // A round every four hours of tape.
        if (d.getUTCMinutes() === 0 && d.getUTCHours() % 4 === 0) {
          for (const t of run.traders) t.rulesAge++;
          await this.coachRound(run, ts);
        }
      }
      this.cryptoLive = true;
      this.cryptoNote = '';
    } catch (err) {
      this.cryptoLive = false;
      this.cryptoNote = `Coinbase did not answer (${err instanceof Error ? err.message : 'error'}): trying again`;
      run.dirty = true;
    } finally {
      this.cryptoBusy = false;
    }
  }

  // ---- One bar, every trader ---------------------------------------------------------------------------------

  private record(run: Run, decisions: Omit<Decision, 'seq' | 'at'>[], banners: Omit<Banner, 'seq'>[]) {
    const at = this.deps.now();
    for (const d of decisions) {
      run.decisions.push({ ...d, seq: ++this.seq, at });
      run.recent.push(at);
    }
    for (const b of banners) run.banners.push({ ...b, seq: ++this.seq });
    if (run.decisions.length > KEEP_DECISIONS) run.decisions.splice(0, run.decisions.length - KEEP_DECISIONS);
    if (run.banners.length > 20) run.banners.splice(0, run.banners.length - 20);
    if (run.recent.length > 600) run.recent.splice(0, 300);
    if (decisions.length || banners.length) run.dirty = true;
  }

  private bury(run: Run, t: TraderState, before: { gen: number; equity: number }, kind: Fallen['kind'], ts: number) {
    const result = scoreOf(before, run.rules);
    run.fallen.push({ name: t.def.name, color: t.def.color, engine: t.def.engine, gen: before.gen, at: ts, result, kind, why: kind === 'passed' ? 'Hit the target with its days and consistency' : kind === 'busted' ? 'Equity touched the trailing floor' : kind === 'retired' ? 'Lost the share of the bankroll that ends a run' : 'Taken off the floor by the owner' });
  }

  private async step(run: Run, at: Moment, bars: Map<string, Bar>, useModel: boolean) {
    run.day = at.day;
    run.ts = at.ts;
    run.bars++;
    const ready = [...run.tapes.values()].every((t) => t.warm);
    for (const t of run.traders) {
      const before = { gen: t.gen, equity: t.equity };
      const out = onBar(t, run.views, bars, at, run.rules);
      this.record(run, out.decisions, out.banners);
      if (t.gen !== before.gen) this.bury(run, t, before, out.banners.some((b) => b.kind === 'passed') ? 'passed' : run.league === 'futures' ? 'busted' : 'retired', at.ts);
      const menu = buildMenu(t, run.views, { ...at, canEnter: at.canEnter && ready }, run.rules);
      if (!menu.options.length) {
        t.status = menu.idle;
        // Now and then the stream says what an idle trader is waiting for.
        if (run.bars % 12 === 0 && !t.cap && run.said.get(t.def.id) !== menu.idle && run.said.set(t.def.id, menu.idle)) this.record(run, [{ ts: at.ts, trader: t.def.id, name: t.def.name, color: t.def.color, pick: 'WATCHING', probs: [['WATCHING', 1]], by: 'rules', note: menu.idle, did: 'none', pnl: null, upl: t.upl, ms: 0, model: '' }], []);
        continue;
      }
      t.totals.decisions++;
      const managing = !!t.pos;
      // A trade that is on is put to the brain every few bars, not every bar.
      const choice = menu.options.length > 1 && (!managing || run.bars % MANAGE_EVERY === 0);
      if (!choice) {
        const only = menu.options[0]!;
        t.status = managing ? `Holding ${t.pos!.market}` : only.desc;
        if (menu.options.length === 1 && run.bars % 12 === 0) this.record(run, [{ ts: at.ts, trader: t.def.id, name: t.def.name, color: t.def.color, pick: 'RIDE', probs: [['RIDE', 1]], by: 'rules', note: menu.idle || 'only legal move: no brain asked', did: 'none', pnl: null, upl: t.upl, ms: 0, model: '' }], []);
        continue;
      }
      const answer = await this.ask(t, menu.options, run, at, useModel);
      const chosen = menu.options.find((o) => o.label === answer.pick) ?? menu.options.find((o) => o.intent.kind === 'pass' || o.intent.kind === 'hold')!;
      const did = act(t, chosen, answer.probs[chosen.label] ?? 0, run.views, at, run.rules);
      const probs = Object.entries(answer.probs).sort((a, b) => b[1] - a[1]).slice(0, 4) as [string, number][];
      t.totals.asked++;
      t.last = { ts: at.ts, pick: chosen.label, probs, by: did.veto ? 'risk' : 'brain', note: answer.why || chosen.desc, ms: answer.ms, model: answer.model };
      t.status = did.veto ? `Risk desk said no: ${did.veto}` : t.pos ? `In ${t.pos.market}` : chosen.intent.kind === 'pass' ? `Passed on ${menu.options[0]!.label}` : chosen.desc;
      if (did.veto) {
        run.vetoes.push({ ts: at.ts, name: t.def.name, label: chosen.label, why: did.veto });
        if (run.vetoes.length > 6) run.vetoes.shift();
      }
      this.record(run, [{ ts: at.ts, trader: t.def.id, name: t.def.name, color: t.def.color, pick: chosen.label, probs, by: did.veto ? 'risk' : 'brain', note: did.veto ? `Risk desk: ${did.veto}` : did.did === 'none' ? answer.why || chosen.desc : did.note, did: did.did, pnl: did.pnl, upl: t.upl, ms: answer.ms, model: answer.model }], []);
    }
    for (const t of run.traders) mark(t, run.views);
    if (run.bars % 3 === 0) for (const t of run.traders) plot(t, at.ts, run.rules);
    run.dirty = true;
  }

  // ---- Research: the same engine over the same tape, off the floor ----------------------------------------

  /** A day of minute candles for every coin, fetched a few hours at a time and kept for ten minutes. */
  private async cryptoHistory(): Promise<Map<string, Bar[]>> {
    const now = this.deps.now();
    if (this.cryptoPast && now - this.cryptoPast.at < 600_000) return this.cryptoPast.bars;
    const get = this.deps.fetchJson ?? (async (url: string) => (await fetch(url, { headers: { 'user-agent': 'agent-office' }, signal: AbortSignal.timeout(10_000) })).json());
    const bars = new Map<string, Bar[]>();
    const end = Math.floor(now / 60_000) * 60_000;
    for (const m of marketsOf('crypto')) {
      const all = new Map<number, Bar>();
      // Coinbase gives 300 candles a request: five requests are 25 hours.
      for (let page = 0; page < 5; page++) {
        const to = end - page * 300 * 60_000;
        for (const b of parseCoinbaseCandles(await get(`https://api.exchange.coinbase.com/products/${COINBASE[m]}/candles?granularity=60&start=${new Date(to - 300 * 60_000).toISOString()}&end=${new Date(to).toISOString()}`), now)) if (b.ts < end) all.set(b.ts, b);
      }
      bars.set(m, [...all.values()].sort((a, b) => a.ts - b.ts));
    }
    this.cryptoPast = { at: now, bars };
    return bars;
  }

  /**
   * Replays traders over the league's tape on a floor of their own: the house brain, the same rules and the
   * same risk desk, nothing streamed and nothing kept. Futures: every recorded session. Crypto: the last day.
   */
  private async simulate(league: League, defs: TraderDef[]): Promise<{ span: string; reports: BacktestReport[] }> {
    const rules = this.runs[league].rules;
    const run = new Run(league, rules);
    run.traders = defs.map((d) => newTrader(d, rules));
    const tally = run.traders.map(() => ({ peak: 0, dip: 0, curve: [] as number[], firstPass: null as number | null, dayNets: [] as number[], dayAt: 0, sessions: 0 }));
    const net = (t: TraderState) => t.totals.realised + t.upl;
    const watch = () =>
      run.traders.forEach((t, i) => {
        const a = tally[i]!;
        const n = net(t);
        a.peak = Math.max(a.peak, n);
        a.dip = Math.max(a.dip, a.peak - n);
      });
    const point = () => run.traders.forEach((t, i) => tally[i]!.curve.push(Math.round(net(t) * 100) / 100));
    const closeDay = () =>
      run.traders.forEach((t, i) => {
        const a = tally[i]!;
        const n = net(t);
        a.sessions++;
        if (n !== a.dayAt) a.dayNets.push(n - a.dayAt);
        a.dayAt = n;
        if (a.firstPass == null && t.passes > 0) a.firstPass = a.sessions;
      });
    const breathe = () => new Promise((r) => setImmediate(r));
    let span: string;
    if (league === 'futures') {
      if (!this.sessions.length) throw new Error('The tape is still loading: try again in a moment');
      for (const s of this.sessions) {
        run.tapes.clear();
        run.views.clear();
        for (const m of marketsOf('futures')) {
          const tape = new Tape(m);
          (s.warm.get(m) ?? []).forEach((b, i) => tape.push(b, i === 0));
          run.tapes.set(m, tape);
        }
        const begun = new Set<string>();
        for (const ts of s.times) {
          const bars = new Map<string, Bar>();
          for (const m of marketsOf('futures')) {
            const b = s.bars.get(m)?.get(ts);
            if (!b) continue;
            run.views.set(m, run.tapes.get(m)!.push(b, !begun.has(m)));
            begun.add(m);
            bars.set(m, b);
          }
          const minute = sessionMinute(ts);
          await this.step(run, { league, ts, day: s.day, minute, canEnter: minute < RTH_CLOSE - 30, mustFlatten: minute >= RTH_CLOSE - 5, sessionOpen: RTH_OPEN, signals: s.signals.get(ts) }, bars, false);
          watch();
        }
        for (const t of run.traders) {
          endDay(t, s.times.at(-1) ?? 0, rules);
          t.day = '';
        }
        closeDay();
        point();
        await breathe();
      }
      span = `${this.sessions.length} recorded sessions, ${this.sessions[0]!.day} to ${this.sessions.at(-1)!.day}`;
    } else {
      const past = await this.cryptoHistory();
      const index = new Map([...past].map(([m, bars]) => [m, new Map(bars.map((b) => [b.ts, b]))]));
      const times = [...new Set([...past.values()].flatMap((bars) => bars.map((b) => b.ts)))].sort((a, b) => a - b);
      if (times.length < 200) throw new Error('Coinbase gave too little history to replay');
      for (const m of marketsOf('crypto')) run.tapes.set(m, new Tape(m));
      let lastDay = '';
      for (const [i, ts] of times.entries()) {
        const d = new Date(ts);
        const day = d.toISOString().slice(0, 10);
        const bars = new Map<string, Bar>();
        for (const m of marketsOf('crypto')) {
          const b = index.get(m)!.get(ts);
          if (!b) continue;
          const key = `${day}:${m}`;
          run.views.set(m, run.tapes.get(m)!.push(b, !run.opens.has(key)));
          run.opens.set(key, b.open);
          bars.set(m, b);
        }
        // The first hour only warms the averages.
        if (i < 60) continue;
        if (lastDay && day !== lastDay) closeDay();
        lastDay = day;
        await this.step(run, { league, ts, day, minute: d.getUTCHours() * 60 + d.getUTCMinutes(), canEnter: true, mustFlatten: false, sessionOpen: 0 }, bars, false);
        watch();
        if (d.getUTCMinutes() === 0) point();
        if (i % 400 === 0) await breathe();
      }
      closeDay();
      point();
      span = `the last ${Math.round((times.at(-1)! - times[60]!) / 3_600_000)} hours of Coinbase minute candles`;
    }
    return {
      span,
      reports: run.traders.map((t, i) => {
        const a = tally[i]!;
        return { name: t.def.name, engine: t.def.engine, markets: t.def.markets, span, net: net(t), trades: t.totals.wins + t.totals.losses, wins: t.totals.wins, losses: t.totals.losses, worstDip: a.dip, bestDay: Math.max(0, ...a.dayNets), worstDay: Math.min(0, ...a.dayNets), days: a.dayNets.length, passes: t.passes, busts: t.busts, firstPass: a.firstPass, curve: a.curve };
      }),
    };
  }

  /** Where the edge is: every engine on every market of a league, one neutral trader each. Worked out once per tape. */
  lab(league: League): Promise<LabView> {
    const key = league === 'futures' ? `f${this.sessions.length}` : `c${Math.floor(this.deps.now() / 600_000)}`;
    const had = this.labs[league];
    if (had?.key === key) return had.view;
    const defs: TraderDef[] = enginesOf(league).flatMap((engine) => marketsOf(league).map((m) => ({ id: `lab-${engine}-${m}`, league, name: `${ENGINES[engine].name} on ${m}`, tagline: '', engine, color: ENGINES[engine].color, markets: [m], rules: '', prompt: '', patience: 0.5, createdAt: 0 })));
    const view = this.simulate(league, defs).then(({ span, reports }) => ({ league, span, cells: reports.map((r) => ({ engine: r.engine, market: r.markets[0]!, net: r.net, trades: r.trades, wins: r.wins, losses: r.losses })) }));
    this.labs[league] = { key, view };
    // A run that failed is not kept: the next ask tries again.
    view.catch(() => delete this.labs[league]);
    return view;
  }

  // ---- The brain ---------------------------------------------------------------------------------------------

  private async ask(t: TraderState, options: MenuOption[], run: Run, at: Moment, useModel: boolean): Promise<{ pick: string; probs: Record<string, number>; why: string; ms: number; model: string }> {
    const house = () => {
      const probs = houseProbs(options);
      const top = Object.entries(probs).sort((a, b) => b[1] - a[1])[0]!;
      // A clear favourite is taken; a close call is drawn, the same way every replay.
      return { pick: top[1] >= 0.55 ? top[0] : pick(probs, seeded(`${t.def.id}:${at.ts}`)), probs, why: '', ms: 0, model: 'house' };
    };
    if (!useModel) return house();
    const safe = options.find((o) => o.intent.kind === 'pass' || o.intent.kind === 'hold')!;
    const down = (why: string) => {
      this.brainError = why;
      return { pick: safe.label, probs: { [safe.label]: 1 }, why: `${why}: holds, opens nothing`, ms: 0, model: 'none' };
    };
    const today = new Date(this.deps.now()).toISOString().slice(0, 10);
    if (today !== this.brainDay) {
      this.brainDay = today;
      this.calls = 0;
      this.usd = 0;
    }
    if (this.calls >= CALL_CAP) return down(`Today’s ${CALL_CAP} calls are used`);
    const lines = t.def.markets
      .map((m) => run.views.get(m))
      .filter((v): v is MarketView => !!v)
      .map((v) => `${v.market}: last ${v.last}, session open ${v.open}, VWAP ${v.vwap.toFixed(2)}, EMA9 ${v.ema9.toFixed(2)}, EMA21 ${v.ema21.toFixed(2)}, EMA50 ${v.ema50.toFixed(2)}, 5m ATR ${v.atr.toFixed(2)}, RSI ${v.rsi.toFixed(0)}`);
    const prompt = [
      `You are the decision model for ${t.def.name}, "${t.def.tagline}", a paper trader in a game. No real money is involved.`,
      `Its engine: ${ENGINES[t.def.engine].name}. ${ENGINES[t.def.engine].blurb}`,
      `Its owner's rules (they come first, within the moves offered): ${t.def.rules}`,
      run.league === 'futures' ? `Account: a prop evaluation. Equity $${Math.round(t.equity)}, floor $${Math.round(t.floor)}, target $${run.rules.start + (run.rules.target ?? 0)}. Sitting out is always allowed.` : `Account: $${t.equity.toFixed(2)} paper bankroll.`,
      `Today: ${t.tradesToday} trades, ${t.lossesToday} losses.`,
      t.pos ? `Open: ${t.pos.side} ${t.pos.market} from ${t.pos.entry}, stop ${t.pos.stop}, target ${t.pos.target ?? 'none'}, open profit $${t.upl.toFixed(2)}.` : 'Flat.',
      'Market:',
      ...lines,
      'The only moves that exist right now:',
      ...options.map((o) => `- ${o.label}: ${o.desc}`),
      'Answer with JSON only, no other text: {"probs": {"<LABEL>": <0-100>, ...}, "why": "<under 14 words>"}. Give every label a number.',
    ].join('\n');
    const started = Date.now();
    const res = await this.model(prompt);
    const ms = Date.now() - started;
    if (!res) return down(this.brainError || `${this.who()} did not answer`);
    this.calls++;
    this.usd += res.usd;
    t.totals.brainUsd += res.usd;
    const parsed = jsonIn(res.text) as { probs?: unknown; why?: unknown } | null;
    const probs = cleanProbs(parsed?.probs, options);
    if (!probs) return down(`${this.who()}’s answer was not the shape asked for`);
    this.brainError = '';
    const top = Object.entries(probs).sort((a, b) => b[1] - a[1])[0]!;
    return { pick: top[0], probs, why: typeof parsed?.why === 'string' ? parsed.why.slice(0, 120) : '', ms, model: this.brain.kind === 'claude' ? this.brain.model : this.brain.kind };
  }

  /** What the brain in use is called: the model for Claude, the harness for the others (each picks its own model). */
  private who(): string {
    return this.brain.kind === 'house' ? 'The house' : this.brain.kind === 'claude' ? MODELS[this.brain.model]! : HARNESS[this.brain.kind];
  }

  /**
   * One question to a model through its CLI on this machine. Claude Code is run with no tools, no settings
   * and no transcript, and says what the call cost; the others answer in plain text and are not metered.
   */
  private model(prompt: string, timeout = 60_000): Promise<{ text: string; usd: number } | null> {
    const kind = this.brain.kind;
    if (kind === 'house') return Promise.resolve(null);
    const name = HARNESS[kind];
    const [cmd, args, viaStdin]: [string, string[], boolean] =
      kind === 'claude'
        ? [this.deps.claude, ['-p', '--model', this.brain.model, '--output-format', 'json', '--tools', '', '--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', '--system-prompt', 'You pick moves for a paper-trading game. You answer with JSON only.'], true]
        : kind === 'codex'
          ? ['codex', ['exec', '--skip-git-repo-check', prompt], false]
          : kind === 'opencode'
            ? ['opencode', ['run', '--pure', prompt], false]
            : ['gemini', ['-p', prompt, '--approval-mode', 'plan'], false];
    return new Promise((resolve) => {
      let out = '';
      let done = false;
      const finish = (v: { text: string; usd: number } | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v);
      };
      let child;
      try {
        child = spawn(cmd, args, { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'ignore'] });
      } catch {
        this.brainError = `${name} could not be started`;
        return resolve(null);
      }
      const timer = setTimeout(() => {
        this.brainError = `${name} took too long`;
        child.kill('SIGKILL');
        finish(null);
      }, timeout);
      child.on('error', () => {
        this.brainError = `${name} is not installed on this machine, or will not start`;
        finish(null);
      });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d: string) => (out += d));
      child.on('close', (code) => {
        if (kind !== 'claude') {
          if (code !== 0 || !out.trim()) this.brainError = `${name} gave no answer${code ? ` (exit ${code})` : ''}`;
          return finish(code === 0 && out.trim() ? { text: out, usd: 0 } : null);
        }
        try {
          const j = JSON.parse(out) as { result?: string; is_error?: boolean; total_cost_usd?: number };
          if (j.is_error || typeof j.result !== 'string') {
            this.brainError = `Claude: ${String(j.result ?? 'no answer').slice(0, 140)}`;
            return finish(null);
          }
          finish({ text: j.result, usd: Number(j.total_cost_usd) || 0 });
        } catch {
          this.brainError = 'Claude gave no answer';
          finish(null);
        }
      });
      child.stdin.end(viaStdin ? prompt : '');
    });
  }

  // ---- The Desk Head ---------------------------------------------------------------------------------------

  /** Looks at every trader and rewrites the rules of at most one. He changes rules text only. */
  private async coachRound(run: Run, ts: number, called = false) {
    const due = run.traders
      .map((t) => ({ t, v: houseVerdict(t) }))
      .filter((x): x is { t: TraderState; v: NonNullable<ReturnType<typeof houseVerdict>> } => !!x.v)
      .sort((a, b) => a.t.equity - b.t.equity)[0];
    if (!due) {
      const fresh = run.traders.filter((t) => t.rulesBy === 'coach' && t.rulesAge < COACH_COOLDOWN);
      const quote = fresh.length === run.traders.length && fresh.length ? 'Everyone is on fresh rules. Let them breathe.' : fresh.length ? `${fresh.map((t) => t.def.name).join(' and ')} just got new rules. Hands off until they have had a few sessions.` : called ? 'Nothing is broken. A losing day is a losing day, not a bad rulebook.' : 'Nobody needs me. Hands off.';
      // A quiet round that says what the last one said just moves its time on.
      const last = run.rounds.at(-1);
      if (last?.kind === 'hands_off' && last.quote === quote) last.at = ts;
      else run.rounds.push({ at: ts, kind: 'hands_off', quote, trader: null, name: null, detail: '' });
    } else {
      let { quote, rules, detail } = due.v;
      let by = 'house rules';
      if (this.brain.kind !== 'house') {
        const t = due.t;
        const res = await this.model(
          [
            `You coach paper traders in a game. ${t.def.name} ("${t.def.tagline}", ${ENGINES[t.def.engine].name} engine) keeps losing.`,
            `Current rules: ${t.def.rules}`,
            `Last sessions' results: ${t.days.slice(-5).map((d) => Math.round(d)).join(', ')}.`,
            `Last trades: ${t.trades.slice(-10).map((x) => `${x.side} ${x.market} ${x.pnl >= 0 ? '+' : ''}${Math.round(x.pnl)} (${x.why})`).join('; ')}`,
            'Write new rules for it, 30 to 280 characters, plain English. You may only change how it chooses among its engine’s setups: which side, which markets, how many trades a day, when in the session. You cannot change size, stops, leverage or limits.',
            'Answer with JSON only: {"quote": "<one blunt line to the trader, under 20 words>", "rules": "<the new rules>"}',
          ].join('\n'),
          90_000,
        );
        const j = res && (jsonIn(res.text) as { quote?: unknown; rules?: unknown } | null);
        if (res) this.usd += res.usd;
        if (j && typeof j.rules === 'string' && j.rules.length >= 30 && j.rules.length <= 320 && typeof j.quote === 'string') {
          quote = j.quote.slice(0, 160);
          rules = j.rules;
          detail = `Rewritten by ${this.who()}.`;
          by = this.who();
        }
      }
      const t = due.t;
      t.rulesBefore.push(t.def.rules);
      if (t.rulesBefore.length > 5) t.rulesBefore.shift();
      t.def = { ...t.def, rules };
      t.rulesBy = 'coach';
      t.rulesAge = 0;
      run.rewrites++;
      run.rounds.push({ at: ts, kind: 'rewrite', quote, trader: t.def.id, name: t.def.name, detail: `${detail} New rules (${by}): ${rules}` });
      this.record(run, [], [{ ts, trader: t.def.id, name: t.def.name, kind: 'coach', text: `The Desk Head rewrote ${t.def.name}’s rules` }]);
    }
    if (run.rounds.length > 12) run.rounds.shift();
    run.dirty = true;
  }

  // ---- What the owner can do ---------------------------------------------------------------------------------

  /** One action from the console. Says why not, or hands back a draft. */
  async act(b: Record<string, unknown>): Promise<{ error?: string; draft?: Draft; report?: BacktestReport }> {
    const league = b.league === 'crypto' ? 'crypto' : 'futures';
    const run = this.runs[league];
    const trader = () => run.traders.find((t) => t.def.id === b.id);
    run.dirty = true;
    switch (b.action) {
      case 'tape': {
        if (league !== 'futures') return { error: 'The crypto tape is live: it cannot be paused or sped up' };
        if (typeof b.playing === 'boolean') run.playing = b.playing && run.note !== 'ended';
        if (SPEEDS.includes(Number(b.speed))) run.speed = Number(b.speed);
        if (b.restart === true) {
          if (!this.sessions.length) return { error: 'There are no recorded sessions to replay yet' };
          // A new season: the same cast on new accounts, from the first session.
          run.traders = run.traders.map((t) => newTrader(t.def, run.rules));
          run.decisions = [];
          run.banners = [];
          run.vetoes = [];
          run.note = '';
          run.opens.clear();
          this.openSession(0);
          run.playing = true;
        }
        return {};
      }
      case 'brain': {
        if (b.kind !== 'house' && !isHarness(b.kind)) return { error: 'No such brain' };
        const before = this.brain;
        if (isHarness(b.kind)) {
          this.brain = { kind: b.kind, model: typeof b.model === 'string' && MODELS[b.model] ? b.model : before.model };
          // One question first, so the console never says a model is deciding when it cannot be reached.
          this.brainError = '';
          const test = await this.model('Answer with JSON only: {"ok": true}', 60_000);
          if (!test || !jsonIn(test.text)) {
            const why = this.brainError || `${this.who()} did not answer with what was asked`;
            this.brain = before;
            return { error: `${why}. ${before.kind === 'house' ? 'The house brain stays on' : 'Nothing was changed'}.` };
          }
          this.usd += test.usd;
        } else this.brain = { kind: 'house', model: before.model };
        Object.values(this.runs).forEach((r) => (r.dirty = true));
        this.save(true);
        return {};
      }
      case 'design': {
        const sentence = String(b.sentence ?? '').trim().slice(0, 400);
        if (sentence.length < 8) return { error: 'Say how it should trade, in a sentence' };
        const house = designDraft(sentence, league, `${sentence}:${b.again ?? 0}`);
        if (this.brain.kind === 'house') return { draft: house };
        const res = await this.model(
          [
            `Design a paper trader for a ${league} trading game from this sentence: "${sentence}"`,
            `Engines: ${enginesOf(league).map((e) => `${e} (${ENGINES[e].blurb})`).join('; ')}.`,
            `Markets it may trade: ${marketsOf(league).join(', ')}.`,
            'Rules are plain English, 30 to 280 characters. Phrases the game enforces in code: "longs only", "shorts only", "N trades a day", "nothing in the first 30 minutes", "no entries after 10:30".',
            `Answer with JSON only: {"name": "<a short character name>", "tagline": "<3 to 5 words, lower case>", "engine": "<${enginesOf(league).join(' or ')}>", "markets": ["..."], "rules": "<the rules>", "patience": <0 to 1>}`,
          ].join('\n'),
          90_000,
        );
        const j = res && (jsonIn(res.text) as Partial<Draft> | null);
        if (res) this.usd += res.usd;
        if (!j || typeof j.name !== 'string' || !isEngine(league, j.engine) || typeof j.rules !== 'string') return { draft: { ...house, by: `the house (${this.who()} did not answer)` } };
        const markets = Array.isArray(j.markets) ? j.markets.filter((m) => marketsOf(league).includes(m)) : [];
        return { draft: { name: j.name.slice(0, 28), tagline: String(j.tagline ?? house.tagline).slice(0, 48), engine: j.engine as EngineId, markets: markets.length ? markets : house.markets, rules: j.rules.slice(0, 320), patience: Math.max(0, Math.min(1, Number(j.patience) || 0.5)), by: this.who() } };
      }
      case 'hire': {
        const d = b.draft as Partial<Draft> | undefined;
        if (!d || typeof d.name !== 'string' || !d.name.trim() || !isEngine(league, d.engine) || typeof d.rules !== 'string') return { error: 'That draft is not complete' };
        if (run.traders.length >= MAX_TRADERS) return { error: `The floor holds ${MAX_TRADERS} traders: let one go first` };
        const markets = (Array.isArray(d.markets) ? d.markets : []).filter((m) => marketsOf(league).includes(m));
        const used = new Set(run.traders.map((t) => t.def.color));
        const def: TraderDef = {
          id: `${league}-${this.deps.now().toString(36)}`,
          league,
          name: d.name.trim().slice(0, 28),
          tagline: String(d.tagline ?? '').slice(0, 48),
          engine: d.engine as EngineId,
          color: TRADER_COLORS.find((c) => !used.has(c)) ?? ENGINES[d.engine as EngineId].color,
          markets: markets.length ? markets : marketsOf(league),
          rules: d.rules.slice(0, 320),
          prompt: String(b.sentence ?? '').slice(0, 400),
          patience: Math.max(0, Math.min(1, Number(d.patience) || 0.5)),
          createdAt: this.deps.now(),
        };
        run.traders.push(newTrader(def, run.rules));
        this.save(true);
        return {};
      }
      case 'let_go': {
        const t = trader();
        if (!t) return { error: 'No such trader' };
        if (run.traders.length <= 1) return { error: 'The floor needs at least one trader' };
        this.bury(run, t, { gen: t.gen, equity: t.equity }, 'let_go', run.ts || this.deps.now());
        run.traders = run.traders.filter((x) => x !== t);
        this.save(true);
        return {};
      }
      case 'rules': {
        const t = trader();
        const rules = String(b.rules ?? '').trim();
        if (!t) return { error: 'No such trader' };
        if (rules.length < 10 || rules.length > 320) return { error: 'Rules are 10 to 320 characters' };
        t.def = { ...t.def, rules };
        t.rulesBy = 'owner';
        t.rulesBefore = [];
        t.rulesAge = 0;
        return {};
      }
      case 'undo': {
        const t = trader();
        if (!t || !t.rulesBefore.length) return { error: 'Nothing to undo' };
        t.def = { ...t.def, rules: t.rulesBefore.pop()! };
        t.rulesBy = t.rulesBefore.length ? 'coach' : 'owner';
        // He leaves a trader he was overruled on alone for a while.
        t.rulesAge = 0;
        run.rounds.push({ at: run.ts || this.deps.now(), kind: 'undo', quote: `Fine. ${t.def.name} goes back to the old rules.`, trader: t.def.id, name: t.def.name, detail: `Restored: ${t.def.rules}` });
        return {};
      }
      case 'backtest': {
        // A trader on the floor (with rules being tried, when given), or a draft that has not started.
        const t = trader();
        const d = b.draft as Partial<Draft> | undefined;
        let def: TraderDef;
        if (t) def = { ...t.def, rules: typeof b.rules === 'string' && b.rules.trim() ? b.rules.trim().slice(0, 320) : t.def.rules };
        else if (d && isEngine(league, d.engine) && typeof d.rules === 'string') {
          const markets = (Array.isArray(d.markets) ? d.markets : []).filter((m) => marketsOf(league).includes(m));
          def = { id: 'draft', league, name: String(d.name || 'The draft').slice(0, 28), tagline: '', engine: d.engine, color: ENGINES[d.engine].color, markets: markets.length ? markets : marketsOf(league), rules: d.rules.slice(0, 320), prompt: '', patience: Math.max(0, Math.min(1, Number(d.patience) || 0.5)), createdAt: 0 };
        } else return { error: 'There is nothing to backtest' };
        try {
          return { report: (await this.simulate(league, [def])).reports[0] };
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'The backtest failed' };
        }
      }
      case 'coach':
        await this.coachRound(run, run.ts || this.deps.now(), true);
        return {};
      default:
        return { error: 'No such action' };
    }
  }

  // ---- What the console draws ---------------------------------------------------------------------------------

  private brainView(): BrainView {
    const k = this.brain.kind;
    return { kind: k, model: this.brain.model, label: this.who(), on: k === 'claude' ? HARNESS.claude : '', metered: k === 'claude', calls: this.calls, callCap: CALL_CAP, usd: this.usd, error: this.brainError };
  }

  private tapeView(run: Run): TapeView {
    if (run.league === 'crypto') {
      const live = this.cryptoLive && this.deps.now() - run.ts < 5 * 60_000;
      return { mode: live ? 'live' : run.ts ? 'offline' : 'warming', label: live ? 'Live' : this.cryptoNote || 'Waiting for the next candle', day: run.day, ts: run.ts, playing: live, speed: 1, session: 0, sessions: 0, source: 'Coinbase public candles' };
    }
    const ended = run.note === 'ended';
    return {
      mode: !this.sessions.length ? 'warming' : ended ? 'ended' : 'replay',
      label: !this.sessions.length ? run.note || 'Loading the month of minute bars' : ended ? `The tape has run out: ${this.sessions.length} sessions played` : 'Replay',
      day: run.day,
      ts: run.ts,
      playing: run.playing,
      speed: run.speed,
      session: this.sessionAt + 1,
      sessions: this.sessions.length,
      source: 'The office’s recorded minute bars (CME, delayed)',
    };
  }

  view(league: League): ArenaView {
    const run = this.runs[league];
    const now = this.deps.now();
    const ranked = [...run.traders].sort((a, b) => b.equity - a.equity);
    const traders = run.traders.map((t) => traderView(t, run.views, run.rules, ranked.indexOf(t) + 1));
    // Engine wars: every account each engine has run, the live ones and the ones that ended.
    const engines = enginesOf(league).map((engine) => {
      const live = run.traders.filter((t) => t.def.engine === engine).map((t) => ({ name: t.def.name, color: t.def.color, score: scoreOf(t, run.rules) }));
      const past = run.fallen.filter((f) => f.engine === engine && f.kind !== 'let_go').map((f) => ({ name: f.name, color: f.color, score: f.result }));
      const all = [...live, ...past];
      return { engine, traders: all.length, avg: all.length ? all.reduce((a, x) => a + x.score, 0) / all.length : 0, best: live.sort((a, b) => b.score - a.score)[0] ?? null };
    });
    return {
      league,
      rules: run.rules,
      tape: this.tapeView(run),
      brain: this.brainView(),
      traders,
      decisions: run.decisions.slice(-60),
      banners: run.banners.slice(-6),
      vetoes: run.vetoes,
      coach: { every: league === 'futures' ? 'after every session' : 'every 4 hours', rounds: run.rounds.slice(-6), rewrites: run.rewrites },
      engines,
      fallen: run.fallen.slice(-40),
      markets: marketsOf(league).flatMap((m) => {
        const v = run.views.get(m);
        return v ? [{ id: m, last: v.last, changePct: v.open ? ((v.last - v.open) / v.open) * 100 : 0 }] : [];
      }),
      totals: {
        pnl: run.traders.reduce((a, t) => a + (t.equity - run.rules.start), 0),
        fees: run.traders.reduce((a, t) => a + t.totals.fees, 0),
        decisions: run.traders.reduce((a, t) => a + t.totals.decisions, 0),
        asked: run.traders.reduce((a, t) => a + t.totals.asked, 0),
        orders: run.traders.reduce((a, t) => a + t.totals.orders, 0),
        perMin: run.recent.filter((x) => now - x < 60_000).length,
      },
      seq: this.seq,
    };
  }

  /** For tests: plays the futures tape forward without waiting on the clock. */
  async play(steps: number) {
    if (!this.sessions.length) await this.load();
    for (let i = 0; i < steps; i++) if (!(await this.stepReplay())) break;
  }
}

/** The first JSON object in a model's answer. */
function jsonIn(text: string): unknown {
  const from = text.indexOf('{');
  const to = text.lastIndexOf('}');
  if (from < 0 || to <= from) return null;
  try {
    return JSON.parse(text.slice(from, to + 1));
  } catch {
    return null;
  }
}
