import test from 'node:test';
import assert from 'node:assert/strict';
import type { PaperTrade, PlaybookId } from '../src/shared/trading.ts';
import { applyPlan, FALLBACK_AFTER, planLabel, plansOf, rankPlans, type DayPlan } from '../src/shared/dayplan.ts';

const A: PlaybookId = 'vwap-pullback';
const B: PlaybookId = 'failed-auction';
/** A trade entered at minute `m` of the day and closed `len` minutes later. */
const t = (d: number, playbook: PlaybookId, m: number, r: number, o: { len?: number; adx?: number } = {}): PaperTrade => {
  const at = d * 86_400_000 + m * 60_000;
  return { id: `${d}-${playbook}-${m}`, day: `2026-09-${String(d).padStart(2, '0')}`, symbol: 'NQ', playbook, side: 'long', entryAt: at, entry: 100, stop: 90, target: 120, exitAt: at + (o.len ?? 10) * 60_000, exit: 100 + 10 * r, outcome: r > 0 ? 'win' : 'loss', r, dollars: 20 * r, why: '', ind: { m, ema9: null, ema21: null, ema50: null, rsi: null, adx: o.adx ?? 25, macd: null, atr: null, vwap: null, onVwap: null, relVol: null } };
};
const plan = (mode: DayPlan['mode'], order: PlaybookId[], o: Partial<DayPlan> = {}): DayPlan => ({ mode, order, oneAndDone: false, maxTrades: 0, ...o });
const ids = (list: PaperTrade[]) => list.map((x) => x.id);

test('every setup takes all the picked playbooks call, and nothing else', () => {
  const trades = [t(1, A, 400, 2), t(1, B, 410, -1), t(1, 'double-break', 420, 2)];
  assert.deepEqual(ids(applyPlan(trades, plan('every', [A, B]))), [trades[0]!.id, trades[1]!.id]);
});

test('a fallback only gets its turn once the first playbook has lost today', () => {
  // Day 1: A loses, then B sets up: B is taken. Day 2: A wins: B stays out. Day 3: A is still in its trade when B sets up: B waits.
  const trades = [
    t(1, A, 400, -1), t(1, B, 430, 2),
    t(2, A, 400, 2), t(2, B, 430, 2),
    t(3, A, 400, -1, { len: 60 }), t(3, B, 430, 2), t(3, B, 470, 2),
  ];
  assert.deepEqual(ids(applyPlan(trades, plan('fallback', [A, B]))), [trades[0]!.id, trades[1]!.id, trades[2]!.id, trades[4]!.id, trades[6]!.id]);
});

test('a first playbook that never sets up has failed by 08:00 PT, not before', () => {
  const early = t(1, B, FALLBACK_AFTER - 30, 2);
  const late = t(1, B, FALLBACK_AFTER + 5, 2);
  assert.deepEqual(ids(applyPlan([early, late], plan('fallback', [A, B]))), [late.id]);
  // The first playbook's own trades are always taken, before or after the fallback has had a go.
  const own = t(1, A, FALLBACK_AFTER + 60, 2);
  assert.deepEqual(ids(applyPlan([late, own], plan('fallback', [A, B]))), [late.id, own.id]);
});

test('by the kind of day: the first playbook when it is trending, the second when it is ranging', () => {
  const trades = [t(1, A, 400, 2, { adx: 30 }), t(1, A, 430, 2, { adx: 12 }), t(1, B, 440, 2, { adx: 12 }), t(1, B, 460, 2, { adx: 30 })];
  assert.deepEqual(ids(applyPlan(trades, plan('by-day', [A, B]))), [trades[0]!.id, trades[2]!.id]);
});

test('one and done stops at the first winner; the cap stops at the number', () => {
  const trades = [t(1, A, 400, -1), t(1, A, 420, 2), t(1, A, 440, 2), t(1, A, 460, 2), t(2, A, 400, 2, { len: 100 }), t(2, A, 420, 2)];
  // Day 2's first trade is a winner too, but it hasn't closed when the second sets up, so that one is still taken.
  assert.deepEqual(ids(applyPlan(trades, plan('every', [A], { oneAndDone: true }))), [trades[0]!.id, trades[1]!.id, trades[4]!.id, trades[5]!.id]);
  assert.deepEqual(ids(applyPlan(trades, plan('every', [A], { maxTrades: 1 }))), [trades[0]!.id, trades[4]!.id]);
});

test('every mix of the playbooks is ranked, with thin ones at the bottom, and says what it is', () => {
  assert.equal(plansOf([A, B]).length, 2 + 1 + 4);
  const trades = Array.from({ length: 30 }, (_, i) => [t(i + 1, A, 400, i % 2 ? 2 : -1, { adx: 30 }), t(i + 1, B, 430, 2, { adx: 10 })]).flat();
  const days = [...new Set(trades.map((x) => x.day))];
  const ranked = rankPlans(trades, [A, B], days);
  assert.equal(ranked[0]!.stats.avgR, 2);
  assert.equal(ranked[0]!.plan.order[0], B);
  assert.ok(ranked.every((r, i) => !i || ranked[i - 1]!.stats.trades >= 20 || r.stats.trades < 20));
  assert.equal(planLabel(plan('fallback', [A, B])), 'VWAP Pullback in Trend first, then Failed Auction if it fails');
  assert.equal(planLabel(plan('by-day', [A, B], { oneAndDone: true })), 'VWAP Pullback in Trend when it’s trending, Failed Auction when it’s ranging · one and done');
});
