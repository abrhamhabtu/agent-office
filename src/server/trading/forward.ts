import { readFileSync, writeFileSync } from 'node:fs';
import type { PaperTrade, Symbol } from '../../shared/trading.js';
import { cleanSetup, FARM_PROGRAM_BY_ID, farmDays, runFarm, strategyLabel, type FarmSetup } from '../../shared/farm.js';
import { COSTS, REALISTIC, withCosts } from '../../shared/fills.js';
import { weekdays } from '../../shared/evalsim.js';
import { RELEASE_GATE } from '../../shared/validation.js';
import type { ForwardDecision, ForwardRunView } from '../../shared/propfarm.js';

// Forward paper runs. The backtest asks "would it have worked"; a forward run asks "is it working", and the
// difference is the order things are written down in. Every setup a playbook calls is recorded as a
// decision the moment the office sees it, while the trade is still open. How it came out is written
// beside it later, never over it. A decision first seen after it had already finished (the office was
// off, or the feed delivered a batch of bars at once) is kept but marked late: it is a reconstruction and
// counts for nothing as forward evidence.
//
// Decisions are shared: one log, written once. A run is a pinned setup (the playbook settings, the rule
// sets, the costs) with a real start time, and its own account ledgers played over the decisions made
// since then. New settings are a new run; nothing rewrites an old one. A restart reads the log back and
// records nothing twice.

export interface StoredRun {
  id: string;
  name: string;
  setup: FarmSetup;
  /** The fingerprint of the playbook settings it runs on, and a line saying what they are. */
  tuning: string;
  tuningLabel: string;
  startedAt: number;
  startDay: string;
  status: 'running' | 'paused' | 'stopped';
  pause: string;
  stoppedAt: number | null;
  discord: string | null;
  /** Events already sent to Discord. */
  notified: number;
}

interface Stored {
  runs: StoredRun[];
  decisions: ForwardDecision[];
}

export interface FeedState {
  source: string;
  delayed: boolean;
  /** No fresh bar while the market is open: nothing can be decided on it. */
  stale: boolean;
}

/** The most decisions kept: a few months of every playbook on every market. */
const KEEP = 6000;
const MAX_RUNS = 8;

export class ForwardBook {
  private runs: StoredRun[] = [];
  private decisions = new Map<string, ForwardDecision>();
  private dirty = false;

  constructor(private file: string | null) {
    try {
      const raw = JSON.parse(readFileSync(file ?? '', 'utf8')) as Partial<Stored>;
      for (const d of raw.decisions ?? []) if (d && typeof d.id === 'string' && typeof d.signalAt === 'number') this.decisions.set(d.id, d);
      this.runs = (raw.runs ?? []).filter((r) => r && typeof r.id === 'string' && typeof r.startedAt === 'number').map((r) => ({ ...r, setup: cleanSetup(r.setup) }));
    } catch {
      // No forward runs yet.
    }
  }

  private save() {
    this.dirty = false;
    if (!this.file) return;
    try {
      const decisions = [...this.decisions.values()].sort((a, b) => a.signalAt - b.signalAt).slice(-KEEP);
      writeFileSync(this.file, JSON.stringify({ runs: this.runs, decisions } satisfies Stored));
    } catch {
      // Kept in memory until the next save.
    }
  }

  /** Writes what has changed since the last save. */
  flush() {
    if (this.dirty) this.save();
  }

  list(): StoredRun[] {
    return this.runs;
  }
  get(id: string): StoredRun | undefined {
    return this.runs.find((r) => r.id === id);
  }
  allDecisions(): ForwardDecision[] {
    return [...this.decisions.values()];
  }

  /**
   * The office has seen this paper trade. New: a decision is written down (forward if the trade is still
   * open, late if it had already finished). Known and now finished: its outcome is written beside it.
   * Known and already finished: nothing, however the trade may have been revised since.
   */
  observe(t: PaperTrade, o: { now: number; tuning: string; feed: FeedState }): 'recorded' | 'outcome' | 'known' {
    const had = this.decisions.get(t.id);
    const outcome = (): ForwardDecision['outcome'] =>
      t.outcome === 'open' ? null : { at: o.now, result: t.outcome, r: t.r, dollars: t.dollars, mae: t.mae ?? null, mfe: t.mfe ?? null, maeAt: t.maeAt ?? null, mfeAt: t.mfeAt ?? null, exitAt: t.exitAt ?? t.entryAt, ambiguous: !!t.ambiguous, alt: t.alt ?? null };
    if (!had) {
      this.decisions.set(t.id, {
        id: t.id, signalAt: t.entryAt + 60_000, recordedAt: o.now, kind: t.outcome === 'open' ? 'forward' : 'late', day: t.day, symbol: t.symbol, side: t.side, playbook: t.playbook,
        entry: t.entry, stop: t.stop, target: t.target, why: t.why, ind: t.ind ?? null, tuning: o.tuning, feed: o.feed.source, delayed: o.feed.delayed, outcome: outcome(),
      });
      this.dirty = true;
      return 'recorded';
    }
    if (!had.outcome && t.outcome !== 'open') {
      had.outcome = outcome();
      this.dirty = true;
      return 'outcome';
    }
    return 'known';
  }

  /**
   * Decisions of `day` whose trade is no longer in the paper book (a revised bar took the setup away) and
   * that never got an outcome: closed as void, so they don't sit open for ever.
   */
  voidMissing(day: string, liveIds: Set<string>, now: number): number {
    let n = 0;
    for (const d of this.decisions.values()) {
      if (d.day !== day || d.outcome || liveIds.has(d.id)) continue;
      d.outcome = { at: now, result: 'void', r: 0, dollars: 0, mae: null, mfe: null, maeAt: null, mfeAt: null, exitAt: d.signalAt, ambiguous: false, alt: null };
      n++;
    }
    if (n) this.dirty = true;
    return n;
  }

  /** Starts a run of `setup` from now on the current playbook settings, or says why not. */
  start(setup: FarmSetup, o: { now: number; day: string; tuning: string; tuningLabel: string; name?: string; fromDay?: string }): StoredRun | string {
    if (this.runs.filter((r) => r.status !== 'stopped').length >= MAX_RUNS) return `${MAX_RUNS} runs at once is the most: stop one first`;
    const program = FARM_PROGRAM_BY_ID[setup.programId];
    if (!program) return 'No such program';
    const n = this.runs.length + 1;
    // "From as far back as the book goes" starts the clock at that day's first minute: everything before now is late.
    const startDay = o.fromDay && o.fromDay < o.day ? o.fromDay : o.day;
    const startedAt = startDay === o.day ? o.now : Date.parse(`${startDay}T00:00:00Z`) - 86_400_000;
    const run: StoredRun = { id: `run-${o.now.toString(36)}-${n}`, name: (o.name ?? '').trim().slice(0, 60) || `${program.firm} ${program.name} · ${strategyLabel(setup.strategy)}`, setup, tuning: o.tuning, tuningLabel: o.tuningLabel, startedAt, startDay, status: 'running', pause: '', stoppedAt: null, discord: null, notified: 0 };
    this.runs.unshift(run);
    this.save();
    return run;
  }

  stop(id: string, now: number): string | undefined {
    const r = this.get(id);
    if (!r) return 'No such run';
    r.status = 'stopped';
    r.stoppedAt = now;
    r.pause = 'Stopped by you';
    this.save();
    return undefined;
  }

  remove(id: string): string | undefined {
    const r = this.get(id);
    if (!r) return 'No such run';
    if (r.status !== 'stopped') return 'Stop it first';
    this.runs = this.runs.filter((x) => x !== r);
    this.save();
    return undefined;
  }

  setDiscord(id: string, url: string | null): string | undefined {
    const r = this.get(id);
    if (!r) return 'No such run';
    r.discord = url;
    this.save();
    return undefined;
  }

  /**
   * The playbook settings the office trades by have this fingerprint now. A run pinned to other settings
   * is paused: its decisions would no longer be its own. It resumes if the settings come back.
   */
  noteTuning(tuning: string) {
    for (const r of this.runs) {
      if (r.status === 'stopped') continue;
      if (r.tuning !== tuning && r.status === 'running') {
        r.status = 'paused';
        r.pause = 'The live playbook settings changed. This run is pinned to the ones it started on: start a new run for the new settings.';
        this.dirty = true;
      } else if (r.tuning === tuning && r.status === 'paused') {
        r.status = 'running';
        r.pause = '';
        this.dirty = true;
      }
    }
  }

  /** The decisions that belong to a run: made on its settings, since it started, until it stopped. */
  decisionsOf(r: StoredRun): ForwardDecision[] {
    const until = r.stoppedAt ?? Infinity;
    return [...this.decisions.values()].filter((d) => d.tuning === r.tuning && d.signalAt >= r.startedAt && d.signalAt <= until && r.setup.strategy.playbooks.includes(d.playbook) && r.setup.strategy.markets.includes(d.symbol)).sort((a, b) => a.signalAt - b.signalAt);
  }

  /** Where a run stands today. `feeds` says what each market's bars are doing right now. */
  view(r: StoredRun, today: string, feeds: Partial<Record<Symbol, FeedState>>, inSession: boolean): ForwardRunView {
    const mine = this.decisionsOf(r);
    const closed = mine.filter((d) => d.outcome && d.outcome.result !== 'void');
    const trades: PaperTrade[] = closed.map((d) => ({
      id: d.id, day: d.day, symbol: d.symbol, playbook: d.playbook, side: d.side, entryAt: d.signalAt - 60_000, entry: d.entry, stop: d.stop, target: d.target, exitAt: d.outcome!.exitAt, exit: null,
      outcome: d.outcome!.result as PaperTrade['outcome'], r: d.outcome!.r, dollars: d.outcome!.dollars, why: d.why, ...(d.outcome!.mae != null && d.outcome!.mfe != null ? { mae: d.outcome!.mae, mfe: d.outcome!.mfe } : {}), ...(d.outcome!.maeAt != null ? { maeAt: d.outcome!.maeAt } : {}), ...(d.outcome!.mfeAt != null ? { mfeAt: d.outcome!.mfeAt } : {}),
      ...(d.ind ? { ind: d.ind } : {}), ...(d.outcome!.alt ? { alt: d.outcome!.alt } : {}),
    }));
    const last = r.stoppedAt ? new Date(r.stoppedAt).toISOString().slice(0, 10) : today;
    const days = weekdays(Array.from({ length: 400 }, (_, i) => new Date(Date.parse(`${r.startDay}T12:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10)).filter((d) => d <= last && d <= today));
    const run = runFarm(farmDays(trades, r.setup.strategy, days.length ? days : [today]), r.setup, days.length ? days : [today]);
    const forward = closed.filter((d) => d.kind === 'forward');
    const sessions = new Set(forward.map((d) => d.day)).size;
    const net = withCosts(trades.map((t) => ({ ...t })), COSTS[r.setup.cost]);
    const totalR = net.reduce((a, t) => a + t.r, 0);
    const program = FARM_PROGRAM_BY_ID[r.setup.programId]!;
    const stale = r.setup.strategy.markets.filter((m) => feeds[m]?.stale);
    const delayed = r.setup.strategy.markets.some((m) => feeds[m]?.delayed ?? true);
    const paused = r.status === 'running' && inSession && stale.length;
    return {
      id: r.id, name: r.name, status: paused ? 'paused' : r.status, pause: paused ? `The ${stale.join(' and ')} feed has gone quiet: no decisions are recorded until it catches up.` : r.pause, startedAt: r.startedAt, startDay: r.startDay, setup: r.setup,
      pinned: { tuning: r.tuning, tuningLabel: r.tuningLabel, ruleSets: [program.evalRules?.id, program.fundedRules.id].filter((x): x is string => !!x), cost: r.setup.cost, fills: REALISTIC.id },
      feedLabel: delayed ? 'Delayed forward replay' : 'Real-time paper', delayed,
      counts: { decisions: mine.length, forward: mine.filter((d) => d.kind === 'forward').length, late: mine.filter((d) => d.kind === 'late').length, closed: closed.length, open: mine.filter((d) => !d.outcome).length, sessions },
      gate: { sessions, sessionsNeeded: RELEASE_GATE.sessions, trades: forward.length, tradesNeeded: RELEASE_GATE.trades, met: sessions >= RELEASE_GATE.sessions && forward.length >= RELEASE_GATE.trades },
      run, net: run.cash[run.cash.length - 1] ?? 0, decisions: [...mine].reverse().slice(0, 60),
      baseline: { trades: net.length, avgR: net.length ? Math.round((totalR / net.length) * 1000) / 1000 : 0, totalR: Math.round(totalR * 100) / 100 },
      discord: !!r.discord,
    };
  }
}
