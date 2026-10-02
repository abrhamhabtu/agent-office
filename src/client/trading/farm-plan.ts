import type { BacktestDetail } from '../../shared/trading';
import type { FarmOdds, FarmRun, FarmSetup } from '../../shared/farm';
import { cleanSetup, FARM_DEFAULTS } from '../../shared/farm';
import { planSize, type PlanPart } from '../../shared/farm-planner';
import { stored } from './labkit';

// The battle test's plans, worked out once and kept. A plan is the answer for one setup on one backtest:
// its replay, its odds, what each other size nets and how the firm's other programs compare. It is made
// in a worker, arrives in parts, and stays in memory for as long as the page is open, so closing the
// console and opening it again shows the answer at once. Only a setup that hasn't been asked for before
// costs anything.
//
// The planner belongs to the page, not to the console: the office can ask it for the saved setup's plan
// before the console is ever opened (see `warm`).

export interface Plan {
  key: string;
  setup: FarmSetup;
  battle: FarmRun | null;
  /** Days of the backtest held out of planning. */
  held: number;
  odds: FarmOdds | null;
  /** What each size nets, by stage, as far as they've been worked out. */
  rungs: { eval: Map<number, FarmOdds>; funded: Map<number, FarmOdds> };
  programs: Map<string, FarmOdds>;
  /** Parts arrived, of how many there are. */
  got: number;
  total: number;
  done: boolean;
  error: string;
}

/** The setup the battle test was last left on. */
export const savedSetup = stored<Partial<FarmSetup> & { firm?: string }>('agent-office.farm', {});

/** Plans kept, newest last. A plan is a few hundred kilobytes: a dozen is plenty and bounded. */
const KEEP = 12;
const plans = new Map<string, Plan>();
const listeners = new Set<() => void>();
let worker: Worker | null = null;
let sent: BacktestDetail | null = null;
let running: Plan | null = null;
let seq = 0;

const dataKey = (d: BacktestDetail) => `${d.ranAt}:${d.days.length}:${d.trades.length}`;
const keyOf = (d: BacktestDetail, s: FarmSetup) => `${dataKey(d)}|${JSON.stringify(s)}`;
const tell = () => listeners.forEach((fn) => fn());

function start(detail: BacktestDetail, plan: Plan) {
  try {
    worker ??= new Worker(new URL('./farm-worker.ts', import.meta.url), { type: 'module' });
  } catch {
    plan.error = 'This browser couldn’t start the worker the battle test runs in.';
    return tell();
  }
  const id = ++seq;
  // A plan abandoned part-way isn't an answer: it is dropped, and asked for afresh if it's wanted again.
  if (running && !running.done) plans.delete(running.key);
  running = plan;
  worker.onmessage = (e: MessageEvent<{ id: number; part?: PlanPart; done?: boolean; error?: string }>) => {
    if (e.data.id !== id) return;
    const p = e.data.part;
    if (p) {
      plan.got++;
      if (p.k === 'battle') {
        plan.battle = p.battle;
        plan.held = p.held;
      } else if (p.k === 'odds') plan.odds = p.odds;
      else if (p.k === 'rung') plan.rungs[p.phase].set(p.micros, p.odds);
      else plan.programs.set(p.id, p.odds);
    } else if (e.data.done) plan.done = true;
    else if (e.data.error) {
      plan.error = e.data.error;
      plans.delete(plan.key);
    }
    tell();
  };
  worker.onerror = () => {
    plan.error = 'The battle test’s worker stopped. Change the setup to try again.';
    plans.delete(plan.key);
    worker = null;
    sent = null;
    tell();
  };
  // The trades are sent once per backtest; after that a plan is only its setup.
  worker.postMessage({ id, setup: plan.setup, ...(sent === detail ? {} : { detail: { trades: detail.trades, days: detail.days } }) });
  sent = detail;
}

export const planner = {
  /** The plan for this setup on this backtest: the one already kept, or a new one that starts filling in now. */
  get(detail: BacktestDetail, setup: FarmSetup): Plan {
    const key = keyOf(detail, setup);
    const had = plans.get(key);
    if (had) {
      // Asked for again: it becomes the newest.
      plans.delete(key);
      plans.set(key, had);
      return had;
    }
    const plan: Plan = { key, setup, battle: null, held: 0, odds: null, rungs: { eval: new Map(), funded: new Map() }, programs: new Map(), got: 0, total: planSize(setup), done: false, error: '' };
    plans.set(key, plan);
    for (const old of [...plans.keys()].slice(0, Math.max(0, plans.size - KEEP))) plans.delete(old);
    start(detail, plan);
    return plan;
  },
  /** The plan for this setup if it has already been made (or is being made): never starts one. */
  peek(detail: BacktestDetail, setup: FarmSetup): Plan | null {
    return plans.get(keyOf(detail, setup)) ?? null;
  },
  /** Hears every part of every plan as it arrives. */
  on(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  /** Works out the saved setup's plan ahead of time, so the battle test is ready when it is opened. */
  warm(detail: BacktestDetail | null) {
    if (!detail?.trades.length) return;
    this.get(detail, cleanSetup({ ...FARM_DEFAULTS, ...savedSetup.get() }));
  },
};
