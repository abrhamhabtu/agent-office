import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PaperTrade } from '../src/shared/trading.ts';
import { FARM_DEFAULTS, type FarmSetup } from '../src/shared/farm.ts';
import { ForwardBook, type FeedState } from '../src/server/trading/forward.ts';

const MIN = 60_000;
const T0 = Date.parse('2026-09-14T14:00:00Z');
const live: FeedState = { source: 'TradingView', delayed: false, stale: false };
const delayed: FeedState = { source: 'CME · Yahoo (delayed)', delayed: true, stale: false };
const setup: FarmSetup = { ...FARM_DEFAULTS, programId: 'lucidflex-25k', slots: 1, maxAttempts: 2, evalMicros: 10, cost: 'gross', strategy: { playbooks: ['double-break'], mode: 'every', manage: 'written', markets: ['NQ', 'ES', 'GC'] } };
const open = (id: string, at: number, day = '2026-09-14', o: Partial<PaperTrade> = {}): PaperTrade => ({ id, day, symbol: 'NQ', playbook: 'double-break', side: 'long', entryAt: at, entry: 100, stop: 80, target: 140, exitAt: null, exit: null, outcome: 'open', r: 0, dollars: 0, why: 'Double break long', ...o });
const closed = (t: PaperTrade, r: number, at: number): PaperTrade => ({ ...t, exitAt: at, exit: t.entry + 20 * r, outcome: r > 0 ? 'win' : 'loss', r, dollars: 40 * r, mae: r < 0 ? 20 : 3, mfe: r > 0 ? 40 : 2, maeAt: t.entryAt + MIN, mfeAt: at });
const start = (b: ForwardBook, now = T0, o: { tuning?: string; fromDay?: string } = {}) => b.start(setup, { now, day: '2026-09-14', tuning: o.tuning ?? 'T1', tuningLabel: 'As written', ...(o.fromDay ? { fromDay: o.fromDay } : {}) });

test('a decision is written down while the trade is open, and its outcome is written beside it, never over it', () => {
  const b = new ForwardBook(null);
  const run = start(b);
  assert.equal(typeof run, 'object');
  const t = open('a', T0 + 5 * MIN);
  assert.equal(b.observe(t, { now: T0 + 6 * MIN + 2000, tuning: 'T1', feed: live }), 'recorded');
  const d = b.allDecisions()[0]!;
  assert.deepEqual([d.kind, d.signalAt, d.recordedAt, d.outcome, d.entry, d.stop, d.target, d.delayed], ['forward', T0 + 6 * MIN, T0 + 6 * MIN + 2000, null, 100, 80, 140, false]);
  // Seen again, still open: nothing changes.
  assert.equal(b.observe(t, { now: T0 + 7 * MIN, tuning: 'T1', feed: live }), 'known');
  // It closes: the outcome goes beside the decision.
  assert.equal(b.observe(closed(t, 2, T0 + 20 * MIN), { now: T0 + 21 * MIN, tuning: 'T1', feed: live }), 'outcome');
  assert.deepEqual([d.outcome!.result, d.outcome!.r, d.outcome!.at, d.recordedAt], ['win', 2, T0 + 21 * MIN, T0 + 6 * MIN + 2000]);
  // A revised bar changes the trade afterwards (a different stop, a loss now): the record does not move.
  assert.equal(b.observe({ ...closed(t, -1, T0 + 9 * MIN), stop: 90 }, { now: T0 + 30 * MIN, tuning: 'T2', feed: delayed }), 'known');
  assert.deepEqual([d.stop, d.outcome!.result, d.outcome!.r, d.tuning], [80, 'win', 2, 'T1']);
});

test('a trade first seen after it finished is kept but marked late, and counts for nothing as forward evidence', () => {
  const b = new ForwardBook(null);
  const run = start(b) as { id: string };
  // The office was catching up: it sees this one already closed.
  b.observe(closed(open('late', T0 + 5 * MIN), 2, T0 + 15 * MIN), { now: T0 + 40 * MIN, tuning: 'T1', feed: delayed });
  const fwd = open('fwd', T0 + 60 * MIN);
  b.observe(fwd, { now: T0 + 61 * MIN, tuning: 'T1', feed: delayed });
  b.observe(closed(fwd, 2, T0 + 80 * MIN), { now: T0 + 81 * MIN, tuning: 'T1', feed: delayed });
  const v = b.view(b.get(run.id)!, '2026-09-14', { NQ: delayed, ES: delayed, GC: delayed }, true);
  assert.deepEqual(v.counts, { decisions: 2, forward: 1, late: 1, closed: 2, open: 0, sessions: 1 });
  assert.deepEqual([v.gate.sessions, v.gate.trades, v.gate.sessionsNeeded, v.gate.tradesNeeded, v.gate.met], [1, 1, 30, 100, false]);
  // A delayed feed is never called a live test.
  assert.deepEqual([v.feedLabel, v.delayed], ['Delayed forward replay', true]);
  assert.equal(b.view(b.get(run.id)!, '2026-09-14', { NQ: live, ES: live, GC: live }, true).feedLabel, 'Real-time paper');
  // Both are in the account's ledger (10 micros, +$800 each), and each says what it is.
  assert.equal(v.run.cells.at(-1)![0]!.balance, 26_600);
  assert.deepEqual(v.decisions.map((d) => `${d.id}:${d.kind}`), ['fwd:forward', 'late:late']);
  assert.deepEqual(v.baseline, { trades: 2, avgR: 2, totalR: 4 });
  assert.deepEqual(v.pinned, { tuning: 'T1', tuningLabel: 'As written', ruleSets: ['lucidflex-25k:eval@2026-10', 'lucidflex-25k:funded@2026-10'], cost: 'gross', fills: 'realistic' });
});

test('a restart records nothing twice, and the runs and their decisions come back as they were', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'fwd-')), 'forward.json');
  const b = new ForwardBook(file);
  const run = start(b) as { id: string };
  const t = open('a', T0 + 5 * MIN);
  b.observe(t, { now: T0 + 6 * MIN, tuning: 'T1', feed: live });
  b.observe(open('b', T0 + 30 * MIN), { now: T0 + 31 * MIN, tuning: 'T1', feed: live });
  b.flush();
  // The office restarts and replays the whole day again: every trade is seen a second time.
  const again = new ForwardBook(file);
  assert.equal(again.allDecisions().length, 2);
  assert.equal(again.observe(t, { now: T0 + 90 * MIN, tuning: 'T1', feed: live }), 'known');
  assert.equal(again.observe(closed(t, -1, T0 + 12 * MIN), { now: T0 + 91 * MIN, tuning: 'T1', feed: live }), 'outcome');
  assert.equal(again.allDecisions().length, 2);
  // The decision made before the restart is still a forward one, with the time it was first written down.
  const d = again.allDecisions().find((x) => x.id === 'a')!;
  assert.deepEqual([d.kind, d.recordedAt, d.outcome!.result], ['forward', T0 + 6 * MIN, 'loss']);
  assert.equal(again.get(run.id)!.name, 'Lucid LucidFlex 25K · VWAP Double Break');
  const v = again.view(again.get(run.id)!, '2026-09-14', { NQ: live, ES: live, GC: live }, true);
  assert.equal(v.run.taken, 1);
  assert.equal(v.counts.open, 1);
});

test('a run only has the decisions made since it started, on the settings it was pinned to', () => {
  const b = new ForwardBook(null);
  const before = open('before', T0 - 30 * MIN);
  b.observe(before, { now: T0 - 29 * MIN, tuning: 'T1', feed: live });
  b.observe(closed(before, 2, T0 - 10 * MIN), { now: T0 - 9 * MIN, tuning: 'T1', feed: live });
  const first = start(b) as { id: string };
  const mine = open('mine', T0 + 5 * MIN);
  b.observe(mine, { now: T0 + 6 * MIN, tuning: 'T1', feed: live });
  b.observe(closed(mine, 2, T0 + 20 * MIN), { now: T0 + 21 * MIN, tuning: 'T1', feed: live });
  // The owner makes another playbook version live: the settings' fingerprint changes.
  b.noteTuning('T2');
  assert.deepEqual([b.get(first.id)!.status, /pinned to the ones it started on/.test(b.get(first.id)!.pause)], ['paused', true]);
  const other = open('other', T0 + 60 * MIN);
  b.observe(other, { now: T0 + 61 * MIN, tuning: 'T2', feed: live });
  b.observe(closed(other, 2, T0 + 70 * MIN), { now: T0 + 71 * MIN, tuning: 'T2', feed: live });
  // A second run, on the new settings, shares the log but has its own ledger.
  const second = start(b, T0 + 50 * MIN, { tuning: 'T2' }) as { id: string };
  assert.deepEqual(b.decisionsOf(b.get(first.id)!).map((d) => d.id), ['mine']);
  assert.deepEqual(b.decisionsOf(b.get(second.id)!).map((d) => d.id), ['other']);
  assert.equal(b.allDecisions().length, 3);
  // The old settings come back: the first run carries on.
  b.noteTuning('T1');
  assert.equal(b.get(first.id)!.status, 'running');
  assert.equal(b.get(second.id)!.status, 'paused');
  // Stopped, a run stops taking decisions; only a stopped run can be taken off the list.
  assert.equal(b.remove(first.id), 'Stop it first');
  b.stop(first.id, T0 + 100 * MIN);
  const late = open('late', T0 + 120 * MIN);
  b.observe(late, { now: T0 + 121 * MIN, tuning: 'T1', feed: live });
  assert.deepEqual(b.decisionsOf(b.get(first.id)!).map((d) => d.id), ['mine']);
  assert.equal(b.remove(first.id), undefined);
  assert.equal(b.list().length, 1);
});

test('a quiet feed pauses a run during the session; a setup a revised bar took away is voided, not left open', () => {
  const b = new ForwardBook(null);
  const run = start(b) as { id: string };
  const stale: FeedState = { source: 'CME · Yahoo (delayed)', delayed: true, stale: true };
  const paused = b.view(b.get(run.id)!, '2026-09-14', { NQ: stale, ES: delayed, GC: delayed }, true);
  assert.deepEqual([paused.status, paused.pause], ['paused', 'The NQ feed has gone quiet: no decisions are recorded until it catches up.']);
  // Outside the session a quiet feed is just the market being closed.
  assert.equal(b.view(b.get(run.id)!, '2026-09-14', { NQ: stale }, false).status, 'running');
  b.observe(open('gone', T0 + 5 * MIN), { now: T0 + 6 * MIN, tuning: 'T1', feed: live });
  b.observe(open('kept', T0 + 8 * MIN), { now: T0 + 9 * MIN, tuning: 'T1', feed: live });
  assert.equal(b.voidMissing('2026-09-14', new Set(['kept']), T0 + 30 * MIN), 1);
  const gone = b.allDecisions().find((d) => d.id === 'gone')!;
  assert.equal(gone.outcome!.result, 'void');
  const v = b.view(b.get(run.id)!, '2026-09-14', { NQ: live, ES: live, GC: live }, true);
  assert.deepEqual([v.counts.closed, v.counts.open, v.run.taken], [0, 1, 0]);
  assert.equal(b.voidMissing('2026-09-14', new Set(['kept']), T0 + 31 * MIN), 0);
});

test('started from as far back as the book goes, everything before now is late; too many runs at once is refused', () => {
  const b = new ForwardBook(null);
  const old = closed(open('old', T0 - 3 * 86_400_000, '2026-09-11'), 2, T0 - 3 * 86_400_000 + 10 * MIN);
  b.observe(old, { now: T0, tuning: 'T1', feed: delayed });
  const run = start(b, T0, { fromDay: '2026-09-11' }) as { id: string; startDay: string };
  assert.equal(run.startDay, '2026-09-11');
  const v = b.view(b.get(run.id)!, '2026-09-14', {}, false);
  assert.deepEqual([v.counts.late, v.counts.forward, v.gate.trades, v.run.days], [1, 0, 0, ['2026-09-11', '2026-09-14']]);
  for (let i = 0; i < 7; i++) assert.equal(typeof start(b), 'object');
  assert.match(start(b) as string, /8 runs at once is the most/);
});
