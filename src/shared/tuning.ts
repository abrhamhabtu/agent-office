import type { PaperTrade, PlaybookId } from './trading.js';
import { labStats, type LabStats } from './backtest-lab.js';

// The tuner's side of the playbooks. Each playbook has a handful of settings (its target, how much room
// the stop gets, when it stops looking for trades), and every one has the value the playbook was written
// with. The tuner changes one at a time, replays the month, and asks whether the change is really better
// or only looks it on the days it was picked on. A change that holds up becomes a new version of the
// playbook: kept, numbered, and never made live unless the owner says so.

/** One setting of a playbook the tuner may change. */
export interface Knob {
  key: string;
  /** What it is, for the list of settings. */
  name: string;
  /** The value the playbook was written with. */
  base: number;
  /** The other values worth trying. */
  tries: number[];
  /** A value in words: "Target 2.5R". */
  say(v: number): string;
}

const clock = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')} PT`;

/** The playbooks the tuner works on, and what it may change in each. */
export const KNOBS: Partial<Record<PlaybookId, Knob[]>> = {
  'vwap-pullback': [
    { key: 'target', name: 'Target', base: 2, tries: [1.5, 2.5, 3], say: (v) => `Target ${v}R` },
    { key: 'swing', name: 'Aim at the swing', base: 1, tries: [0], say: (v) => (v ? 'Aims at the prior swing when it is far enough' : 'Always a fixed target, never the prior swing') },
    { key: 'stop', name: 'Stop room', base: 1, tries: [0.5, 1.5, 2], say: (v) => `Stop ${v}× the usual room past the pullback` },
    { key: 'lastEntry', name: 'Last entry', base: 660, tries: [540, 600, 720], say: (v) => `No entries after ${clock(v)}` },
    { key: 'wait', name: 'Wait for the bounce', base: 6, tries: [3, 10], say: (v) => `Waits ${v} minutes at VWAP for the bounce` },
    { key: 'away', name: 'How far it ran first', base: 2, tries: [1, 3], say: (v) => `Price must first run ${v}× the usual room away from VWAP` },
    { key: 'bias', name: 'Overnight bias', base: 0, tries: [1], say: (v) => (v ? 'Only with the overnight VWAP agreeing' : 'Overnight VWAP not required') },
  ],
  'support-resistance': [
    { key: 'target', name: 'Target', base: 2, tries: [1.5, 2.5, 3], say: (v) => `Target ${v}R when the next level is too close` },
    { key: 'stop', name: 'Stop room', base: 1, tries: [0.5, 1.5], say: (v) => `Stop ${v}× the usual room past the level` },
    { key: 'touches', name: 'Touches', base: 3, tries: [2, 4], say: (v) => `A level needs ${v} touches` },
    { key: 'lastEntry', name: 'Last entry', base: 720, tries: [600, 660], say: (v) => `No entries after ${clock(v)}` },
    { key: 'maxTrades', name: 'Trades a day', base: 3, tries: [1, 2], say: (v) => `At most ${v} trade${v === 1 ? '' : 's'} a day` },
    { key: 'mode', name: 'Which setups', base: 0, tries: [1, 2], say: (v) => (v === 1 ? 'Bounces only' : v === 2 ? 'Break-and-retests only' : 'Bounces and break-and-retests') },
  ],
  'failed-auction': [
    { key: 'target', name: 'Target', base: 1.5, tries: [1, 2, 2.5], say: (v) => `Target ${v}R` },
    { key: 'stop', name: 'Stop size', base: 1, tries: [0.75, 1.25, 1.5], say: (v) => `Stop ${v}× the usual fixed stop` },
    { key: 'stall', name: 'Stall', base: 3, tries: [2, 5], say: (v) => `The auction must stall for ${v} bars` },
    { key: 'room', name: 'Room to POC', base: 1, tries: [1.5, 2], say: (v) => `Needs ${v}R of room to POC` },
    { key: 'maxTrades', name: 'Trades a day', base: 4, tries: [1, 2, 3], say: (v) => `At most ${v} trade${v === 1 ? '' : 's'} a day` },
    { key: 'nyOnly', name: 'Session', base: 0, tries: [1], say: (v) => (v ? 'New York session only' : 'Any session') },
  ],
};
export const TUNED_PLAYBOOKS = Object.keys(KNOBS) as PlaybookId[];

/** A playbook's settings where they differ from how it was written. */
export type Settings = Record<string, number>;
export type Tuning = Partial<Record<PlaybookId, Settings>>;

/** Every setting of a playbook: its own values, with `tuning`'s changes over them. */
export function settingsOf(playbook: PlaybookId, tuning?: Tuning): Settings {
  const out: Settings = {};
  for (const k of KNOBS[playbook] ?? []) out[k.key] = tuning?.[playbook]?.[k.key] ?? k.base;
  return out;
}

/** Only what differs from the playbook as written, with unknown or broken values dropped. */
export function cleanSettings(playbook: PlaybookId, raw: unknown): Settings {
  const out: Settings = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const k of KNOBS[playbook] ?? []) {
    const v = (raw as Record<string, unknown>)[k.key];
    if (typeof v === 'number' && Number.isFinite(v) && v !== k.base && (k.tries.includes(v) || v === k.base)) out[k.key] = v;
  }
  return out;
}

/** What `to` changes from `from`, in plain words. */
export function describeSettings(playbook: PlaybookId, from: Settings, to: Settings): string[] {
  const out: string[] = [];
  for (const k of KNOBS[playbook] ?? []) {
    const a = from[k.key] ?? k.base;
    const b = to[k.key] ?? k.base;
    if (a !== b) out.push(`${k.say(b)} (was: ${k.say(a).replace(/^./, (c) => c.toLowerCase())})`);
  }
  return out;
}

/** Every single change to try from `live`: one setting moved to one other value. */
export function variantsOf(playbook: PlaybookId, live: Settings): Settings[] {
  const out: Settings[] = [];
  for (const k of KNOBS[playbook] ?? []) {
    const now = live[k.key] ?? k.base;
    for (const v of [k.base, ...k.tries]) {
      if (v === now) continue;
      const next = { ...live, [k.key]: v };
      if (v === k.base) delete next[k.key];
      out.push(next);
    }
  }
  return out;
}

export const sameSettings = (a: Settings, b: Settings) => {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
};

// ---- Judging a change ------------------------------------------------------------------------------------

export type TuneVerdict = 'better' | 'same' | 'worse' | 'unproven';

export interface TuneTest {
  trades: number;
  winRate: number;
  avgR: number;
  totalR: number;
  maxDrawdownR: number;
  /** The later third of the days, which a change isn't picked on. */
  laterAvgR: number;
  laterTrades: number;
}

export interface TuneJudgement {
  verdict: TuneVerdict;
  confidence: 'low' | 'medium' | 'high';
  reason: string;
  dAvgR: number;
  dTotalR: number;
}

/** Fewer trades than this and the tuner says it can't tell. */
export const MIN_TUNE_TRADES = 20;
const fmtR = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(2)}R`;
const r2 = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

/** A version's results over the whole test and over its later third. */
export function testOf(trades: PaperTrade[], days: string[]): { all: LabStats; later: LabStats; test: TuneTest } {
  const cut = new Set(days.slice(Math.ceil((days.length * 2) / 3)));
  const all = labStats(trades);
  const later = labStats(trades.filter((t) => cut.has(t.day)));
  return { all, later, test: { trades: all.trades, winRate: all.winRate, avgR: all.avgR, totalR: all.totalR, maxDrawdownR: all.maxDrawdownR, laterAvgR: later.avgR, laterTrades: later.trades } };
}

/**
 * Is the changed playbook better than the live one? Conservative on purpose: it has to make more per
 * trade and more in total, hold up on the later days, keep most of the trades and not deepen the dip.
 */
export function judgeTune(base: { all: LabStats; later: LabStats }, v: { all: LabStats; later: LabStats }): TuneJudgement {
  const dAvgR = r2(v.all.avgR - base.all.avgR, 3);
  const dTotalR = r2(v.all.totalR - base.all.totalR);
  const se = Math.sqrt(base.all.stdR ** 2 / Math.max(1, base.all.trades) + v.all.stdR ** 2 / Math.max(1, v.all.trades));
  const z = se > 0 ? (v.all.avgR - base.all.avgR) / se : 0;
  const confidence: TuneJudgement['confidence'] = z >= 2.5 ? 'high' : z >= 1.5 ? 'medium' : 'low';
  const out = (verdict: TuneVerdict, reason: string): TuneJudgement => ({ verdict, confidence, reason, dAvgR, dTotalR });
  if (base.all.trades < MIN_TUNE_TRADES || v.all.trades < MIN_TUNE_TRADES) return out('unproven', `Only ${Math.min(base.all.trades, v.all.trades)} trades to go on, too few to tell (the tuner wants ${MIN_TUNE_TRADES}+)`);
  if (dAvgR <= -0.05) return out('worse', `${fmtR(dAvgR)} a trade against the live version`);
  if (dAvgR < 0.08) return out('same', `Within noise: ${fmtR(dAvgR)} a trade`);
  if (dTotalR <= 0) return out('same', `Better per trade only because it takes fewer of them: the total falls by ${Math.abs(dTotalR).toFixed(1)}R`);
  if (v.all.trades < 0.6 * base.all.trades) return out('same', `Takes far fewer trades (${v.all.trades} against ${base.all.trades}), which is a different strategy`);
  if (v.later.trades < 5 || base.later.trades < 5) return out('unproven', 'Too few trades on the later days to check it held up');
  if (v.later.avgR <= base.later.avgR) return out('same', `Better overall but not on the later days it wasn’t picked on (${fmtR(v.later.avgR)} against ${fmtR(base.later.avgR)})`);
  if (v.all.maxDrawdownR > base.all.maxDrawdownR * 1.25 + 0.5) return out('same', `Better average but a deeper dip (${v.all.maxDrawdownR}R against ${base.all.maxDrawdownR}R)`);
  if (z < 1) return out('unproven', `${fmtR(dAvgR)} a trade better, which is within normal luck for this many trades`);
  return out('better', `${fmtR(dAvgR)} a trade better, ${fmtR(dTotalR)} in total, and it held up on the later days (${fmtR(v.later.avgR)} against ${fmtR(base.later.avgR)})`);
}

// ---- Versions --------------------------------------------------------------------------------------------

/** One version of a playbook's settings. Version 1 is the playbook as written. */
export interface PlaybookVersion {
  version: number;
  /** The day it was saved (YYYY-MM-DD), Pacific. */
  date: string;
  status: 'live' | 'candidate' | 'retired';
  /** The version it was made from. */
  parent: number | null;
  settings: Settings;
  /** What it changes from its parent, in words. */
  change: string[];
  test: TuneTest | null;
  /** Against the live version when it was last tested. */
  vs: (TuneJudgement & { version: number }) | null;
  /** Made by the tuner and not looked at yet. */
  fresh: boolean;
}

/** One change the tuner tried on its last run. */
export interface TuneTry {
  change: string[];
  test: TuneTest;
  verdict: TuneVerdict;
  confidence: 'low' | 'medium' | 'high';
  reason: string;
  dAvgR: number;
}

export interface TunerBook {
  playbook: PlaybookId;
  /** Newest first. */
  versions: PlaybookVersion[];
  /** What the last run tried, best first. */
  tried: TuneTry[];
}

export interface TunerView {
  running: boolean;
  /** What it's doing right now, while it runs. */
  stage: string;
  ranAt: number | null;
  /** How long the last run took, and how many replays of the month it made. */
  took: number;
  replays: number;
  note: string;
  books: TunerBook[];
}
