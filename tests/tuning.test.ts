import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Bar, PaperTrade } from '../src/shared/trading.ts';
import { PROP_ACCOUNTS } from '../src/shared/trading.ts';
import { cleanSettings, describeSettings, judgeTune, KNOBS, settingsOf, testOf, TUNED_PLAYBOOKS, variantsOf } from '../src/shared/tuning.ts';
import { ACCOUNT_CATALOG, isOwnAccount } from '../src/shared/prop-catalog.ts';
import { runEval } from '../src/shared/evalsim.ts';
import { replayDay } from '../src/server/trading/engine.ts';
import { Tuner, type History } from '../src/server/trading/tuner.ts';

const day = (n: number) => `2026-09-${String(n).padStart(2, '0')}`;
const trade = (d: number, r: number, k = 0): PaperTrade => ({ id: `t${d}-${k}`, day: day(d), symbol: 'NQ', playbook: 'vwap-pullback', side: 'long', entryAt: d * 1000 + k, entry: 100, stop: 90, target: 120, exitAt: d * 1000 + k + 1, exit: 100 + 10 * r, outcome: r > 0 ? 'win' : 'loss', r, dollars: 20 * r, why: '' });
const days = Array.from({ length: 30 }, (_, i) => day(i + 1));

/** A drifting, wavy session of one-minute bars: enough for the playbooks to find something. */
const OPEN = Date.UTC(2026, 8, 29, 13, 30);
const bar = (ts: number, o: number, c: number): Bar => ({ ts, open: o, close: c, high: Math.max(o, c) + 1.5, low: Math.min(o, c) - 1.5, volume: 100 + ((ts / 60_000) % 7) * 30 });
const walk = (from: number, n: number, start: number, wave = 9) => Array.from({ length: n }, (_, i) => bar(from + i * 60_000, start + Math.sin(i / wave) * 12 + i * 0.05, start + Math.sin((i + 1) / wave) * 12 + (i + 1) * 0.05));

test('a playbook’s settings are its own values unless a version changes them', () => {
  assert.deepEqual(TUNED_PLAYBOOKS, ['vwap-pullback', 'support-resistance', 'failed-auction']);
  assert.equal(settingsOf('vwap-pullback').target, 2);
  assert.equal(settingsOf('vwap-pullback', { 'vwap-pullback': { target: 3 } }).target, 3);
  assert.equal(settingsOf('failed-auction').target, 1.5);
  assert.deepEqual(settingsOf('double-break'), {});
  // Only known settings with values the tuner tries survive being read back from disk.
  assert.deepEqual(cleanSettings('vwap-pullback', { target: 3, stop: 99, nonsense: 1, wait: 6 }), { target: 3 });
});

test('the tuner tries one setting at a time, and says each change in words', () => {
  const v = variantsOf('support-resistance', {});
  assert.equal(v.length, KNOBS['support-resistance']!.reduce((a, k) => a + k.tries.length, 0));
  assert.ok(v.every((s) => Object.keys(s).length === 1));
  // From a version that already changed something, going back to the original is one of the tries.
  assert.ok(variantsOf('support-resistance', { target: 3 }).some((s) => Object.keys(s).length === 0));
  assert.deepEqual(describeSettings('vwap-pullback', {}, { target: 2.5 }), ['Target 2.5R (was: target 2R)']);
  assert.deepEqual(describeSettings('failed-auction', {}, { nyOnly: 1 }), ['New York session only (was: any session)']);
});

test('a change is only better when it holds on the later days, keeps the trades and adds to the total', () => {
  const base = testOf(days.flatMap((_, i) => [trade(i + 1, i % 3 === 0 ? 2 : -1)]), days);
  const better = testOf(days.flatMap((_, i) => [trade(i + 1, i % 3 === 2 ? -1 : 2)]), days);
  assert.equal(judgeTune(base, better).verdict, 'better');
  // Good early, bad late: not better.
  const fades = testOf(days.flatMap((_, i) => [trade(i + 1, i < 20 ? 2 : -1)]), days);
  assert.notEqual(judgeTune(base, fades).verdict, 'better');
  // Better per trade only by skipping most of them, so the total falls.
  const few = testOf([1, 4, 7, 10].map((d) => trade(d, 2)), days);
  assert.notEqual(judgeTune(testOf(days.flatMap((_, i) => [trade(i + 1, i % 2 ? 2 : -1), trade(i + 1, 2, 1)]), days), few).verdict, 'better');
  assert.equal(judgeTune(base, testOf(days.map((_, i) => trade(i + 1, -1)), days)).verdict, 'worse');
  assert.equal(judgeTune(testOf([trade(1, 2)], days), testOf([trade(1, 2)], days)).verdict, 'unproven');
});

/** A day that trends up off the open, pulls all the way back to VWAP, and bounces: the VWAP pullback's setup. */
function trendDay(): { today: Bar[]; prior: Bar[] } {
  const b = (ts: number, o: number, c: number, volume = 100): Bar => ({ ts, open: o, close: c, high: Math.max(o, c) + 1, low: Math.min(o, c) - 1, volume });
  const prior: Bar[] = [];
  for (let i = 0; i < 390; i++) prior.push(b(OPEN - 86_400_000 + i * 60_000, 20_000 + i * 0.1, 20_000 + (i + 1) * 0.1));
  const today: Bar[] = [];
  let p = 20_050;
  for (let t = OPEN - 60 * 60_000; t < OPEN; t += 60_000) today.push(b(t, p, (p += 0.2)));
  let pv = 0;
  let v = 0;
  const push = (i: number, o: number, c: number, vol: number) => {
    const x = b(OPEN + i * 60_000, o, c, vol);
    pv += ((x.high + x.low + x.close) / 3) * vol;
    v += vol;
    today.push(x);
  };
  let i = 0;
  for (; i < 60; i++) push(i, p, (p += 3), 300);
  while (p - 4 > pv / v) push(i++, p, (p -= 2), 80);
  push(i++, p, pv / v + 0.5, 80);
  p = pv / v + 0.5;
  for (const end = i + 60; i < end; i++) push(i, p, (p += 2.5), 400);
  return { today, prior };
}

test('the playbooks trade exactly as written until a setting is changed, and `only` replays just one', () => {
  const { today, prior } = trendDay();
  const plain = replayDay('NQ', today, prior).trades;
  const same = replayDay('NQ', today, prior, { tuning: { 'vwap-pullback': {}, 'support-resistance': {}, 'failed-auction': {} } }).trades;
  assert.deepEqual(same, plain);
  const pb = replayDay('NQ', today, prior, { only: ['vwap-pullback'] }).trades;
  assert.deepEqual(pb, plain.filter((t) => t.playbook === 'vwap-pullback'));
  assert.equal(pb.length, 1);
  // A fixed 3R target instead of the swing, and twice the stop room: that trade's plan moves, and nobody else's.
  const tuned = replayDay('NQ', today, prior, { tuning: { 'vwap-pullback': { swing: 0, target: 3, stop: 2 } } }).trades;
  const moved = tuned.find((t) => t.playbook === 'vwap-pullback')!;
  assert.equal(moved.entry, pb[0]!.entry);
  assert.ok(moved.entry - moved.stop > pb[0]!.entry - pb[0]!.stop);
  assert.ok(Math.abs((moved.target - moved.entry) / (moved.entry - moved.stop) - 3) < 0.05);
  assert.deepEqual(tuned.filter((t) => t.playbook !== 'vwap-pullback'), plain.filter((t) => t.playbook !== 'vwap-pullback'));
});

test('a run of the tuner tries every change, keeps its versions on disk, and only the owner makes one live', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tuner-'));
  const file = path.join(dir, 'versions.json');
  try {
    const history: History = { NQ: Array.from({ length: 6 }, (_, i) => ({ day: day(i + 1), bars: walk(OPEN + (i - 20) * 86_400_000 - 3_600_000, 450, 20_050 + i * 7, 7 + i), prior: walk(OPEN + (i - 21) * 86_400_000, 390, 20_000 + i * 7, 8 + i) })) };
    const all = history.NQ!.flatMap((d) => replayDay('NQ', d.bars, d.prior).trades);
    const tuner = new Tuner(file);
    assert.deepEqual(tuner.liveTuning(), { 'vwap-pullback': {}, 'support-resistance': {}, 'failed-auction': {} });
    await tuner.run(history, all, history.NQ!.map((d) => d.day));
    const view = tuner.view();
    assert.equal(view.running, false);
    assert.equal(view.books.length, 3);
    for (const b of view.books) {
      assert.equal(b.tried.length >= KNOBS[b.playbook]!.reduce((a, k) => a + k.tries.length, 0), true);
      assert.equal(b.versions.at(-1)!.version, 1);
      assert.equal(b.versions.filter((v) => v.status === 'live').length, 1);
    }
    assert.ok(view.replays >= 42);
    // The same data again: nothing is replayed twice.
    await tuner.run(history, all, history.NQ!.map((d) => d.day));
    assert.equal(tuner.view().replays, view.replays);
    // The live version can't be retired, only replaced; and a restart reads the same versions back.
    assert.match(tuner.setStatus('vwap-pullback', 1, 'retired')!, /only replaced/);
    assert.equal(tuner.setStatus('vwap-pullback', 99, 'live'), 'No such version');
    assert.deepEqual(new Tuner(file).view().books.map((b) => b.versions.map((v) => `${v.version}:${v.status}`)), tuner.view().books.map((b) => b.versions.map((v) => `${v.version}:${v.status}`)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the simulator’s catalog adds accounts without touching the owner’s own', () => {
  assert.equal(new Set(ACCOUNT_CATALOG.map((a) => a.id)).size, ACCOUNT_CATALOG.length);
  assert.deepEqual(ACCOUNT_CATALOG.slice(0, PROP_ACCOUNTS.length), PROP_ACCOUNTS);
  assert.ok(isOwnAccount('tof-50k') && !isOwnAccount('luciddirect-50k'));
  assert.ok(ACCOUNT_CATALOG.filter((a) => a.kind === 'funded').length >= 8);
  // The 25K accounts, and the firm whose challenge one trade can pass.
  assert.ok(ACCOUNT_CATALOG.filter((a) => a.size === 25_000).length >= 6);
  const rapid = ACCOUNT_CATALOG.find((a) => a.id === 'fundednext-rapid-25k')!;
  assert.deepEqual([rapid.profitTarget, rapid.drawdown, rapid.consistencyPercent, rapid.minTradingDays], [1500, 1000, 100, 1]);
  for (const a of ACCOUNT_CATALOG) assert.ok(a.profitTarget > 0 && a.drawdown > 0 && a.maxMicros > 0 && a.consistencyPercent > 0 && a.consistencyPercent <= 100, a.id);
});

test('a program with no consistency rule passes on the target and the days alone', () => {
  const apex = ACCOUNT_CATALOG.find((a) => a.id === 'apex-eod-50k')!;
  // One huge day and a losing one: the best day is more than all the profit, which no consistency rule could allow.
  const eTrade = (d: number, r: number): PaperTrade => ({ ...trade(d, r), stop: 80, dollars: 40 * r });
  const run = runEval([eTrade(1, 16), eTrade(2, -1)], apex);
  assert.equal(run.result, 'passed');
  assert.equal(run.days, 1);
});
