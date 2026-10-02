import test from 'node:test';
import assert from 'node:assert/strict';
import { cushionOf, DaySession, denyPayout, fillOf, floorOf, openAccount, passCheck, payoutCheck, replayAccount, requestPayout, settlePayout, type LedgerEvent, type LedgerFill } from '../src/shared/account-ledger.ts';
import { ruleSetFor, type RuleSet } from '../src/shared/prop-rules.ts';
import { COSTS } from '../src/shared/fills.ts';
import type { PaperTrade } from '../src/shared/trading.ts';

const e25 = ruleSetFor('lucidflex-25k', 'eval')!;
const f25 = ruleSetFor('lucidflex-25k', 'funded')!;
const e50 = ruleSetFor('lucidflex-50k', 'eval')!;
const day = (n: number) => `2026-09-${String(n).padStart(2, '0')}`;
const MIN = 60_000;
/** An MNQ fill ($2 a point a micro): `pnl`, `mae` and `mfe` in points, times in minutes into the day. */
const fill = (o: { id?: string; d?: number; micros: number; pnl: number; mae?: number; mfe?: number; in?: number; out?: number; maeAt?: number; mfeAt?: number; stop?: number; side?: 'long' | 'short' }): LedgerFill => ({
  id: o.id ?? `f${o.in ?? 0}`, day: day(o.d ?? 1), symbol: 'NQ', side: o.side ?? 'long', micros: o.micros, entryAt: (o.in ?? 0) * MIN, exitAt: (o.out ?? (o.in ?? 0) + 10) * MIN, pointValue: 2,
  stopPoints: o.stop ?? 60, pnlPoints: o.pnl, mae: o.mae ?? Math.max(0, -o.pnl), mfe: o.mfe ?? Math.max(0, o.pnl), maeAt: o.maeAt == null ? null : o.maeAt * MIN, mfeAt: o.mfeAt == null ? null : o.mfeAt * MIN, costs: 0, approx: false, label: `Long ${o.micros} MNQ`,
});
const play = (rules: RuleSet, days: LedgerFill[][]) => replayAccount(rules, days.map((fills, i) => ({ day: day(i + 1), fills })));

test('a 25K evaluation by hand: the floor trails the close, and the target alone isn’t a pass', () => {
  // Day 1: 10 micros make 40 points: +$800. Floor trails to $24,800.
  // Day 2: lose 20 points: −$400 → $25,400; the floor stays at $24,800.
  // Day 3: +$850 → $26,250, profit $1,250: the target exactly, but the best day ($850) is 68% of it.
  const r = play(e25, [[fill({ micros: 10, pnl: 40 })], [fill({ micros: 10, pnl: -20 })], [fill({ micros: 10, pnl: 42.5 })]]);
  assert.deepEqual(r.days.map((d) => [d.balance, d.floor, d.cushion, d.status]), [[25_800, 24_800, 1000, 'active'], [25_400, 24_800, 600, 'active'], [26_250, 25_100, 1150, 'target-reached']]);
  assert.equal(r.verdict, 'insufficient');
  assert.match(r.why, /Target reached, but the best day is 68% of the profit/);
  assert.equal(r.hypothetical, false);
  // Day 4: +$450 → profit $1,700, best day 50%: every rule met, pending the firm.
  const more = play(e25, [[fill({ micros: 10, pnl: 40 })], [fill({ micros: 10, pnl: -20 })], [fill({ micros: 10, pnl: 42.5 })], [fill({ micros: 10, pnl: 22.5 })]]);
  assert.equal(more.verdict, 'passed');
  assert.equal(more.account.status, 'pass-pending');
  assert.equal(more.account.balance, 26_700);
  const c = passCheck(more.account, e25);
  assert.deepEqual(c.checks.map((x) => x.ok), [true, true, true]);
  assert.match(c.checks[2]!.detail, /Best day is 50% of the profit/);
});

test('a breach inside a trade is a breach, whatever the trade went on to do', () => {
  // 10 micros, 55 points against it (−$1,100 open) before finishing +30 points: closed-trade accounting
  // would call this a +$600 day. The account was at $23,900 against a $24,000 floor: it is gone.
  const r = play(e25, [[fill({ micros: 10, pnl: 30, mae: 55, mfe: 30, in: 0, out: 30, maeAt: 10, mfeAt: 30 })]]);
  assert.equal(r.verdict, 'breached');
  assert.equal(r.account.status, 'breached');
  assert.equal(r.account.balance, 23_900);
  assert.equal(r.days[0]!.lowEquity, 23_900);
  assert.match(r.account.why, /touched the \$24,000 floor inside a trade/);
  assert.ok(r.events.some((e) => e.kind === 'breach'));
  // The same trade a size smaller never got there: 5 micros was −$550 at worst, and it keeps the +$300.
  const ok = play(e25, [[fill({ micros: 5, pnl: 30, mae: 55, mfe: 30, in: 0, out: 30, maeAt: 10, mfeAt: 30 })]]);
  assert.equal(ok.account.balance, 25_300);
  assert.equal(ok.days[0]!.lowEquity, 24_450);
  assert.equal(ok.days[0]!.lowCushion, 450);
});

test('the exact threshold: at the floor is breached, a dollar above is not; at the target is the target', () => {
  // 10 micros, 50 points against: −$1,000 exactly, equity $24,000 at a $24,000 floor.
  assert.equal(play(e25, [[fill({ micros: 10, pnl: -50 })]]).verdict, 'breached');
  assert.equal(play(e25, [[fill({ micros: 10, pnl: -49.95 })]]).account.status, 'active');
  // $1,250 over two even days of $625: the target to the dollar, and 50% consistency to the dollar.
  const r = play(e25, [[fill({ micros: 10, pnl: 31.25 })], [fill({ micros: 10, pnl: 31.25 })]]);
  assert.equal(r.verdict, 'passed');
  assert.equal(r.account.balance, 26_250);
  // A cent short is not.
  assert.equal(play(e25, [[fill({ micros: 10, pnl: 31.25 })], [fill({ micros: 1, pnl: 312.495 })]]).verdict, 'insufficient');
});

test('trades that overlap are held together: two that are each fine alone can breach as a pair', () => {
  const a = fill({ id: 'a', micros: 10, pnl: 5, mae: 30, in: 0, out: 20, maeAt: 10, mfeAt: 20 });
  const b = fill({ id: 'b', micros: 10, pnl: 5, mae: 30, in: 5, out: 25, maeAt: 10, mfeAt: 25 });
  // Each is −$600 at its worst; at minute 10 both are, and −$1,200 is through the $1,000 drawdown.
  const pair = play(e25, [[a, b]]);
  assert.equal(pair.verdict, 'breached');
  assert.equal(pair.days[0]!.peakMicros, 20);
  // One after the other, the same two trades are two small winners.
  const apart = play(e25, [[a, { ...b, entryAt: 30 * MIN, exitAt: 50 * MIN, maeAt: 40 * MIN, mfeAt: 50 * MIN }]]);
  assert.equal(apart.account.status, 'active');
  assert.equal(apart.account.balance, 25_200);
  assert.equal(apart.days[0]!.peakMicros, 10);
  // And the firm's contract limit is counted across what is open: 20 are allowed, a third trade isn't.
  const events: LedgerEvent[] = [];
  const acct = openAccount(e25, { id: 'E', day: day(1) });
  const s = new DaySession(acct, e25, day(1), (e) => events.push(e));
  assert.equal(s.add(fill({ id: 'x', micros: 12, pnl: 1, in: 0, out: 20 })), null);
  assert.match(s.add(fill({ id: 'y', micros: 9, pnl: 1, in: 5, out: 25 }))!, /21 micros would be over the limit of 20/);
  assert.equal(s.add(fill({ id: 'z', micros: 8, pnl: 1, in: 6, out: 25 })), null);
  assert.deepEqual([s.openMicros, s.openRisk], [20, 2400]);
  s.close();
  assert.ok(events.some((e) => e.kind === 'rejected' && e.fillId === 'y'));
});

test('a day with no trades is still a day, but not a trading day; days that run out are not a fail', () => {
  const r = play(e50, [[fill({ micros: 20, pnl: 40 })], [], [], [fill({ micros: 20, pnl: 40 })]]);
  assert.equal(r.account.tradingDays, 2);
  assert.equal(r.days[1]!.fills, 0);
  assert.equal(r.days[1]!.balance, 51_600);
  // $3,200 over two even days on a 50K: passed.
  assert.equal(r.verdict, 'passed');
  const short = play(e50, [[fill({ micros: 20, pnl: 40 })], []]);
  assert.equal(short.verdict, 'insufficient');
  assert.match(short.why, /not enough data to call it/);
  assert.equal(play(e50, []).verdict, 'insufficient');
  // On rules with unknowns even a pass is a what-if.
  const top = ruleSetFor('topone-elite-25k', 'eval')!;
  const hyp = play(top, [[fill({ micros: 10, pnl: 40 })], [fill({ micros: 10, pnl: 40 })]]);
  assert.deepEqual([hyp.verdict, hyp.hypothetical], ['passed', true]);
});

test('a funded 25K by hand: five $200 days, a request, the floor moves, it is parked, paid, and steps down', () => {
  const events: LedgerEvent[] = [];
  const log = (e: LedgerEvent) => events.push(e);
  const a = openAccount(f25, { id: 'FUNDED-1', day: day(1) });
  assert.equal(a.allowedMicros, 10);
  for (let d = 1; d <= 5; d++) {
    const s = new DaySession(a, f25, day(d), log);
    assert.equal(s.add(fill({ d, micros: 10, pnl: 10 })), null);
    const rep = s.close();
    assert.equal(rep.balance, 25_000 + 200 * d);
  }
  // $1,000 of profit over five $200 days: half of it, $500, may be requested. The limit stepped up to 20.
  assert.equal(a.status, 'payout-eligible');
  assert.equal(a.allowedMicros, 20);
  assert.equal(floorOf(a, f25), 25_000);
  const check = payoutCheck(a, f25);
  assert.deepEqual([check.eligible, check.amount, check.checks.every((c) => c.ok)], [true, 500, true]);
  assert.match(requestPayout(a, f25, day(5), { key: 'k1', amount: 600 })!, /most that can be requested is \$500/);
  assert.match(requestPayout(a, f25, day(5), { key: 'k1', amount: 400 })!, /least that can be requested is \$500/);
  assert.equal(requestPayout(a, f25, day(5), { key: 'k1' }, log), null);
  // Requested: parked, and the floor is the locked balance, $25,100.
  assert.equal(a.status, 'parked');
  assert.equal(floorOf(a, f25), 25_100);
  assert.equal(cushionOf(a, f25), 900);
  // The same request again, or another while one is open, is refused.
  assert.equal(requestPayout(a, f25, day(5), { key: 'k1' }), 'That request was already made');
  assert.equal(requestPayout(a, f25, day(5), { key: 'k2' }), 'A payout is already requested on this account');
  // Parked: nothing is routed to it.
  const parked = new DaySession(a, f25, day(6), log);
  assert.match(parked.add(fill({ d: 6, micros: 5, pnl: 10 }))!, /parked until the payout is reconciled/);
  parked.close();
  assert.equal(a.balance, 26_000);
  // Reconciled: $500 left the account, $450 reached the owner; the limit steps back to 10; a new cycle.
  assert.deepEqual(settlePayout(a, f25, day(8), {}, log), { received: 450, withdrawn: 500 });
  assert.deepEqual([a.status, a.balance, a.allowedMicros, a.payouts, a.received, a.withdrawn], ['active', 25_500, 10, 1, 450, 500]);
  assert.deepEqual(a.cycle, { startBalance: 25_500, profitDays: 0, tradingDays: 0, bestDay: 0 });
  assert.equal(cushionOf(a, f25), 400);
  assert.deepEqual(settlePayout(a, f25, day(8)), { error: 'No payout is waiting on this account' });
  assert.deepEqual(events.filter((e) => e.kind.startsWith('payout') || e.kind === 'tier').map((e) => e.kind), ['tier', 'payout-eligible', 'payout-requested', 'payout-paid']);
});

test('a denied request leaves the money in; a part payment pays what it paid; the last payout retires the account', () => {
  const ready = () => {
    const a = openAccount(f25, { id: 'F', day: day(1) });
    for (let d = 1; d <= 5; d++) {
      const s = new DaySession(a, f25, day(d));
      s.add(fill({ d, micros: 10, pnl: 15 }));
      s.close();
    }
    return a;
  };
  // $1,500 of profit: $750 may be taken.
  const denied = ready();
  assert.equal(payoutCheck(denied, f25).amount, 750);
  assert.equal(requestPayout(denied, f25, day(5), { key: 'a' }), null);
  assert.equal(denyPayout(denied, day(6), 'under review'), null);
  assert.deepEqual([denied.status, denied.balance, denied.payouts, denied.request], ['active', 26_500, 0, null]);
  assert.match(denied.why, /Payout of \$750 denied: under review/);
  assert.equal(denyPayout(denied, day(6), ''), 'No payout is waiting on this account');
  const part = ready();
  requestPayout(part, f25, day(5), { key: 'a' });
  assert.deepEqual(settlePayout(part, f25, day(7), { withdrawn: 300 }), { received: 270, withdrawn: 300 });
  assert.equal(part.balance, 26_200);
  assert.deepEqual(settlePayout(ready(), f25, day(7)), { error: 'No payout is waiting on this account' });
  const over = ready();
  requestPayout(over, f25, day(5), { key: 'a' });
  assert.match((settlePayout(over, f25, day(7), { withdrawn: 900 }) as { error: string }).error, /The request was for \$750/);
  // The fifth payout is the last the firm allows.
  const last = ready();
  last.payouts = 4;
  requestPayout(last, f25, day(5), { key: 'a' });
  settlePayout(last, f25, day(7));
  assert.equal(last.status, 'retired');
  // Not eligible: no request.
  const fresh = openAccount(f25, { id: 'G', day: day(1) });
  assert.match(requestPayout(fresh, f25, day(1), { key: 'a' })!, /0 of 5 this cycle/);
});

test('a day that makes less than the firm’s minimum doesn’t count toward a payout; a daily loss limit stops the day, not the account', () => {
  const a = openAccount(f25, { id: 'F', day: day(1) });
  const s = new DaySession(a, f25, day(1));
  s.add(fill({ micros: 4, pnl: 12 }));
  s.close();
  // +$96: a trading day, not a $100 profit day.
  assert.deepEqual([a.balance, a.cycle.tradingDays, a.cycle.profitDays], [25_096, 1, 0]);
  const dll: RuleSet = { ...e25, dailyLossLimit: 300 };
  const b = openAccount(dll, { id: 'D', day: day(1) });
  const events: LedgerEvent[] = [];
  const t = new DaySession(b, dll, day(1), (e) => events.push(e));
  t.add(fill({ id: 'one', micros: 10, pnl: -16, in: 0, out: 10 }));
  assert.match(t.add(fill({ id: 'two', micros: 10, pnl: 40, in: 20, out: 30 }))!, /stopped for the day \(daily loss limit\)/);
  const rep = t.close();
  assert.deepEqual([rep.balance, rep.status, b.status, rep.fills], [24_680, 'active', 'active', 1]);
  assert.ok(events.some((e) => e.kind === 'daily-limit'));
});

test('a paper trade becomes a fill: sized, charged for, and timed from when its bar was complete', () => {
  const t: PaperTrade = { id: 't', day: day(1), symbol: 'NQ', playbook: 'double-break', side: 'short', entryAt: 0, entry: 100, stop: 120, target: 60, exitAt: 5 * MIN, exit: 60, outcome: 'win', r: 2, dollars: 80, why: '', mae: 8, mfe: 40, maeAt: 2 * MIN, mfeAt: 5 * MIN };
  const f = fillOf(t, 5, COSTS.base);
  assert.deepEqual([f.entryAt, f.exitAt, f.stopPoints, f.pnlPoints, f.mae, f.mfe, f.maeAt, f.mfeAt, f.costs, f.approx, f.label], [MIN, 6 * MIN, 20, 40, 8, 40, 3 * MIN, 6 * MIN, 8.7, false, 'Short 5 MNQ']);
  // An older trade with no excursions kept, or one managed another way: the least its path could have been.
  const { mae: _m, mfe: _f, ...old } = t;
  assert.deepEqual([fillOf(old, 5, COSTS.gross).mae, fillOf(old, 5, COSTS.gross).approx], [0, true]);
  assert.equal(fillOf({ ...t, dollars: -40, outcome: 'loss' }, 5, COSTS.gross, { managed: true }).mae, 20);
  // Costs come off the account: a +$400 trade nets $391.30.
  const r = replayAccount(e25, [{ day: day(1), fills: [f] }]);
  assert.equal(r.account.balance, 25_391.3);
});
