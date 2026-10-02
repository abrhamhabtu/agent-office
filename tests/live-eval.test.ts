import test from 'node:test';
import assert from 'node:assert/strict';
import type { Bar, PaperTrade } from '../src/shared/trading.ts';
import { MANAGE, managed } from '../src/shared/manage.ts';
import { replayDay } from '../src/server/trading/engine.ts';
import { liveEvalView, readLiveEval } from '../src/server/trading/live-eval.ts';

const OPEN = Date.UTC(2026, 8, 29, 13, 30);
/** A day that trends up off the open, pulls all the way back to VWAP, and bounces straight to its target. */
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

test('every trade is also followed under the other ways of managing it', () => {
  const { today, prior } = trendDay();
  const t = replayDay('NQ', today, prior).trades.find((x) => x.playbook === 'vwap-pullback')!;
  assert.equal(t.outcome, 'win');
  const alt = t.alt!;
  // It went straight to its target without coming back to the entry, so the stop at breakeven was never touched.
  assert.equal(alt.be, t.r);
  // Half banked at +1R, the other half at the target.
  assert.ok(Math.abs(alt.half - (0.5 + 0.5 * t.r)) < 0.02, JSON.stringify(alt));
  // A second unit from +1R to the target on top of the first.
  assert.ok(Math.abs(alt.add - (2 * t.r - 1)) < 0.02, JSON.stringify(alt));
  // The runner had no target: it rode the rest of the bounce, further than the written one.
  assert.ok(alt.trail > t.r, JSON.stringify(alt));
  // Picking a way of managing swaps the result, and the dollars with it; the playbook's own way changes nothing.
  assert.equal(managed([t], 'written')[0], t);
  const run = managed([t], 'trail')[0]!;
  assert.equal(run.r, alt.trail);
  assert.ok(run.dollars > t.dollars);
  assert.equal(MANAGE.length, 5);
  // A trade the backtest has no other endings for stays as it was.
  assert.equal(managed([{ ...t, alt: undefined }], 'be')[0]!.r, t.r);
});

const trade = (day: string, r: number, k = 0, playbook: PaperTrade['playbook'] = 'double-break'): PaperTrade => ({ id: `${day}-${k}`, day, symbol: 'NQ', playbook, side: 'long', entryAt: Date.parse(`${day}T15:00:00Z`) + k * 60_000, entry: 100, stop: 80, target: 140, exitAt: Date.parse(`${day}T15:00:00Z`) + k * 60_000 + 30_000, exit: 100 + 20 * r, outcome: r > 0 ? 'win' : 'loss', r, dollars: 40 * r, why: '' });

test('a live eval is read from what the simulator sends, and refuses what it can’t run', () => {
  assert.equal(readLiveEval({ accountId: 'nope', playbooks: ['double-break'] }, '2026-09-30', null, null), 'Pick an account to run it on');
  assert.equal(readLiveEval({ accountId: 'lucidflex-50k', playbooks: ['made-up'] }, '2026-09-30', null, null), 'Pick at least one playbook');
  const cfg = readLiveEval({ accountId: 'luciddirect-50k', playbooks: ['double-break', 'failed-auction'], plan: { mode: 'fallback', oneAndDone: true }, manage: 'be', rules: { profitTarget: 2500, firm: 'Hacked', maxMicros: -5 }, opts: { divisor: 8 }, from: 'back' }, '2026-09-30', '2026-09-22', 'topstep-50k');
  assert.ok(typeof cfg !== 'string');
  if (typeof cfg === 'string') return;
  assert.equal(cfg.rules.profitTarget, 2500);
  assert.equal(cfg.rules.firm, 'Lucid');
  assert.equal(cfg.rules.maxMicros, 50);
  assert.equal(cfg.startDay, '2026-09-22');
  assert.equal(cfg.plan.mode, 'fallback');
  assert.equal(cfg.opts.divisor, 8);
  // It isn't one of the owner's accounts, so it's measured against the one they have active.
  assert.equal(cfg.mineAccount, 'topstep-50k');
  // From today when not asked to look back, and never further back than a month.
  assert.equal((readLiveEval({ accountId: 'lucidflex-50k', playbooks: ['double-break'] }, '2026-09-30', '2026-09-01', null) as { startDay: string }).startDay, '2026-09-30');
  assert.equal((readLiveEval({ accountId: 'lucidflex-50k', playbooks: ['double-break'], from: 'back' }, '2026-09-30', '2026-07-01', null) as { startDay: string }).startDay, '2026-08-30');
});

test('the live eval runs the paper book forward day by day, beside what the owner made', () => {
  const cfg = readLiveEval({ accountId: 'lucidflex-50k', playbooks: ['double-break'], from: 'back' }, '2026-09-30', '2026-09-24', null);
  assert.ok(typeof cfg !== 'string');
  if (typeof cfg === 'string') return;
  // Thursday to Wednesday: five weekdays. A winner, a loser, a quiet day, a winner; today one is still open.
  const paper = [trade('2026-09-24', 2), trade('2026-09-25', -1), trade('2026-09-29', 2), { ...trade('2026-09-30', 0), outcome: 'open' as const }, trade('2026-09-20', 2), trade('2026-09-29', 2, 1, 'failed-auction')];
  cfg.mine = { '2026-09-28': 150, '2026-09-30': -40 };
  const v = liveEvalView(cfg, paper, '2026-09-30');
  assert.deepEqual(v.days, ['2026-09-24', '2026-09-25', '2026-09-28', '2026-09-29', '2026-09-30']);
  assert.equal(v.office.taken, 3);
  assert.equal(v.office.openNow, 1);
  assert.equal(v.office.result, 'running');
  // $200 of risk is five micros on a $40 stop: +$400, then the same five lose $200 (the floor trailed up), a flat day,
  // then $180 of risk is four micros: +$320.
  assert.deepEqual(v.office.series, [400, 200, 200, 520, 520]);
  assert.equal(v.office.pnl, 520);
  // The owner's line starts the first day they traded, and holds on the days they didn't.
  assert.deepEqual(v.you!.series, [null, null, 150, 150, 110]);
  assert.equal(v.you!.pnl, 110);
  assert.equal(v.you!.since, '2026-09-28');
  assert.equal(v.label, 'VWAP Double Break');
});
