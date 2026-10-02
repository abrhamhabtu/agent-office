import test from 'node:test';
import assert from 'node:assert/strict';
import { barCloseAt, barGaps, COSTS, costPerMicro, exitOnBar, netDollars, PINE_PARITY, REALISTIC, receipt, riskPerMicro, withCosts } from '../src/shared/fills.ts';
import { aggregate, sessionsOf, simulate, V1_PARAMS } from '../src/server/trading/pine-sim.ts';
import type { Bar } from '../src/shared/trading.ts';

const bar = (open: number, high: number, low: number) => ({ open, high, low });

test('a bar that touches both the stop and the target is the stop when realistic, the target under Pine parity, and says it was a guess', () => {
  const both = bar(100, 111, 94);
  assert.deepEqual(exitOnBar('long', 95, 110, both, REALISTIC), { price: 95, outcome: 'loss', ambiguous: true, gapped: false });
  assert.deepEqual(exitOnBar('long', 95, 110, both, PINE_PARITY), { price: 110, outcome: 'win', ambiguous: true, gapped: false });
  // The same for a short: stop above, target below.
  assert.deepEqual(exitOnBar('short', 105, 90, bar(100, 106, 89), REALISTIC), { price: 105, outcome: 'loss', ambiguous: true, gapped: false });
  assert.deepEqual(exitOnBar('short', 105, 90, bar(100, 106, 89), PINE_PARITY), { price: 90, outcome: 'win', ambiguous: true, gapped: false });
  // Only one of them touched: no guess in it.
  assert.deepEqual(exitOnBar('long', 95, 110, bar(100, 112, 99)), { price: 110, outcome: 'win', ambiguous: false, gapped: false });
  assert.deepEqual(exitOnBar('long', 95, 110, bar(100, 104, 95)), { price: 95, outcome: 'loss', ambiguous: false, gapped: false });
  assert.equal(exitOnBar('long', 95, 110, bar(100, 109.75, 95.25)), null);
});

test('a bar that opens past the stop fills at the open, which is worse; a target never fills better than its price', () => {
  assert.deepEqual(exitOnBar('long', 95, 110, bar(93, 96, 92), REALISTIC), { price: 93, outcome: 'loss', ambiguous: false, gapped: true });
  assert.deepEqual(exitOnBar('short', 105, 90, bar(107.5, 108, 104), REALISTIC), { price: 107.5, outcome: 'loss', ambiguous: false, gapped: true });
  // Pine fills the stop at its own price.
  assert.deepEqual(exitOnBar('long', 95, 110, bar(93, 96, 92), PINE_PARITY), { price: 95, outcome: 'loss', ambiguous: false, gapped: false });
  // Opens beyond the target: filled at the target, not at the better open; and the open settles which came first.
  assert.deepEqual(exitOnBar('long', 95, 110, bar(112, 113, 94), REALISTIC), { price: 110, outcome: 'win', ambiguous: false, gapped: false });
  // A stop with no target working (a trailed runner).
  assert.deepEqual(exitOnBar('long', 95, null, bar(100, 200, 94)), { price: 95, outcome: 'loss', ambiguous: false, gapped: false });
});

test('costs: a round trip per micro, more on a stop than on a target, long and short alike', () => {
  // MNQ: a tick is 0.25 points at $2 a point, so $0.50.
  assert.equal(costPerMicro('NQ', 'loss', COSTS.base), 2.24);
  assert.equal(costPerMicro('NQ', 'win', COSTS.base), 1.74);
  assert.equal(costPerMicro('NQ', 'loss', COSTS.gross), 0);
  assert.equal(costPerMicro('NQ', 'loss', COSTS.stressed), 4.5);
  // MGC: a tick is 0.1 points at $10 a point, so $1.
  assert.equal(costPerMicro('GC', 'time', COSTS.base), 3.24);
  assert.equal(riskPerMicro('NQ', 20, COSTS.base), 42.24);
  assert.equal(riskPerMicro('NQ', -20, COSTS.gross), 40);
  assert.equal(netDollars({ symbol: 'NQ', outcome: 'win', dollars: 80 }, COSTS.base), 78.26);
  const [w, l, o] = withCosts([
    { symbol: 'NQ' as const, outcome: 'win' as const, dollars: 80, r: 2, entry: 100, stop: 80 },
    { symbol: 'NQ' as const, outcome: 'loss' as const, dollars: -40, r: -1, entry: 100, stop: 120 },
    { symbol: 'NQ' as const, outcome: 'open' as const, dollars: 12, r: 0.3, entry: 100, stop: 80 },
  ], COSTS.base);
  assert.equal(w!.dollars, 78.26);
  assert.equal(w!.r, 1.957);
  assert.equal(l!.dollars, -42.24);
  assert.equal(l!.r, -1.056);
  assert.equal(o!.dollars, 12);
});

test('a bar can be acted on at its close, and a late one is a delayed replay, not a live decision', () => {
  assert.equal(barCloseAt({ ts: 1_000_000 }), 1_060_000);
  assert.equal(barCloseAt({ ts: 0 }, 5), 300_000);
  assert.deepEqual(receipt({ ts: 0 }, 90_000), { closedAt: 60_000, receivedAt: 90_000, delayMs: 30_000, late: false });
  assert.equal(receipt({ ts: 0 }, 60_000 + 15 * 60_000).late, true);
  // Received before it closed (a clock a little off): no delay, never negative.
  assert.equal(receipt({ ts: 0 }, 10_000).delayMs, 0);
  assert.deepEqual(barGaps([{ ts: 0 }, { ts: 60_000 }, { ts: 240_000 }, { ts: 300_000 }]), [{ at: 120_000, missing: 2 }]);
  assert.deepEqual(barGaps([{ ts: 0 }, { ts: 60_000 }]), []);
});

test('the Pine replay is parity by default and can be filled realistically: the same bars, a different answer on a bar that tags both', () => {
  // One New York session of 5-minute bars (09:30 ET on 2026-09-14 is 13:30 UTC), built so the script takes
  // a long double break at 10:05 and the very next bar tags both its stop and its target.
  const t0 = Date.UTC(2026, 8, 14, 13, 30);
  const bars: Bar[] = [];
  const push = (i: number, open: number, high: number, low: number, close: number) => bars.push({ ts: t0 + i * 300_000, open, high, low, close, volume: 100 });
  // The opening range (15 minutes): 100 to 104, closing under VWAP so the state is "broke down".
  push(0, 102, 104, 100, 101);
  push(1, 101, 103, 100, 100.5);
  push(2, 100.5, 102, 100, 100.5);
  for (let i = 3; i < 7; i++) push(i, 100.5, 101, 100.2, 100.4);
  // 10:05: a close back up through NY VWAP: the double break long. Stop under the range, target at 2R.
  push(7, 100.4, 103, 100.4, 102.8);
  // The next bar runs to the target and back through the stop.
  push(8, 102.8, 115, 90, 101);
  for (let i = 9; i < 60; i++) push(i, 101, 101.5, 100.5, 101);
  const sessions = sessionsOf(bars.flatMap((b) => [b]), 5);
  assert.equal(sessions.size, 1);
  const parity = simulate(sessions, 'NQ', V1_PARAMS);
  const real = simulate(sessions, 'NQ', V1_PARAMS, undefined, REALISTIC);
  assert.equal(parity.length >= 1 && real.length >= 1, true);
  assert.equal(parity[0]!.outcome, 'win');
  assert.equal(parity[0]!.r, 2);
  assert.equal(parity[0]!.ambiguous, true);
  assert.equal(real[0]!.outcome, 'loss');
  assert.equal(real[0]!.r, -1);
  assert.equal(real[0]!.ambiguous, true);
  assert.equal(aggregate(bars, 5).length, bars.length);
});
