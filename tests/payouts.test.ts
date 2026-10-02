import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AccountBook } from '../src/server/trading/accounts.ts';
import { PayoutLedger, payoutRow } from '../src/server/trading/payouts.ts';
import { ruleSetFor } from '../src/shared/prop-rules.ts';

const E25 = ruleSetFor('lucidflex-25k', 'eval')!.id;
const F25 = ruleSetFor('lucidflex-25k', 'funded')!.id;
const day = (n: number) => `2026-09-${String(n).padStart(2, '0')}`;
const NOW = Date.parse('2026-09-01T16:00:00Z');
/** A funded 25K the owner tracks, with five $300 days logged: $1,500 of profit, $750 available. */
function ready(file: string | null = null) {
  const book = new AccountBook(file);
  const t = book.add({ ruleSetId: F25, label: 'Lucid funded', fee: 0, day: day(1), now: NOW });
  assert.equal(typeof t, 'object');
  const id = (t as { account: { id: string } }).account.id;
  for (let d = 1; d <= 5; d++) assert.equal(book.logDay(id, { day: day(d), pnl: 300, trades: 2, now: NOW }), undefined);
  return { book, id, ledger: new PayoutLedger(file ? file.replace('accounts', 'payouts') : null, book) };
}

test('five copies of one program are five accounts, each with its own identity and ledger', () => {
  const book = new AccountBook(null);
  const ids = Array.from({ length: 5 }, () => (book.add({ ruleSetId: E25, fee: 75, day: day(1), now: NOW }) as { account: { id: string } }).account.id);
  assert.equal(new Set(ids).size, 5);
  assert.ok(ids.every((id) => /^MY-EVAL-\d+$/.test(id)));
  book.logDay(ids[0]!, { day: day(1), pnl: 400, now: NOW });
  book.logDay(ids[1]!, { day: day(1), pnl: -300, now: NOW });
  assert.deepEqual(ids.map((id) => book.get(id)!.account.balance), [25_400, 24_700, 25_000, 25_000, 25_000]);
  // Every one keeps the rule set it was opened on, and the fee that was paid for it.
  assert.ok(book.list().every((t) => t.account.ruleSetId === E25 && t.account.fees === 75 && t.account.environment === 'manual'));
  assert.equal(book.add({ ruleSetId: 'nope', day: day(1), now: NOW }), 'Pick a program and size');
});

test('a tracked evaluation goes through the same rules: a pass is pending until the owner says the firm confirmed it', () => {
  const book = new AccountBook(null);
  const id = (book.add({ ruleSetId: E25, day: day(1), now: NOW }) as { account: { id: string } }).account.id;
  book.logDay(id, { day: day(1), pnl: 700, now: NOW });
  assert.equal(book.get(id)!.account.status, 'active');
  assert.equal(book.logDay(id, { day: day(1), pnl: 100, now: NOW }), `${day(1)} is already logged: a day is logged once`);
  assert.equal(book.logDay(id, { day: 'yesterday', pnl: 100, now: NOW }), 'Which day was it?');
  assert.equal(book.logDay(id, { day: day(2), pnl: 99_999, now: NOW }), 'That result doesn’t look right for this account');
  book.logDay(id, { day: day(2), pnl: 700, now: NOW });
  // $1,400 over two even days: every rule met. The office does not call it passed.
  assert.equal(book.get(id)!.account.status, 'pass-pending');
  assert.match(book.logDay(id, { day: day(3), pnl: 100, now: NOW })!, /can’t trade: the account is pass pending confirmation/);
  const funded = book.confirmPass(id, { day: day(3), now: NOW });
  assert.equal(typeof funded, 'object');
  const f = funded as { account: { id: string; phase: string; linked: string | null; allowedMicros: number } };
  assert.deepEqual([book.get(id)!.account.status, book.get(id)!.account.linked, f.account.phase, f.account.linked, f.account.allowedMicros], ['passed', f.account.id, 'funded', id, 10]);
  assert.equal(book.confirmPass(id, { day: day(3), now: NOW }), 'There is no pass waiting to be confirmed');
  // A day that went badly inside the day: the owner says how far down it was, and the ledger checks it.
  const risky = (book.add({ ruleSetId: E25, day: day(1), now: NOW }) as { account: { id: string } }).account.id;
  book.logDay(risky, { day: day(1), pnl: 200, worst: 1100, now: NOW });
  assert.equal(book.get(risky)!.account.status, 'breached');
});

test('eligible, requested and received are three different things, and only received is cash', () => {
  const { book, id, ledger } = ready();
  const a = book.get(id)!.account;
  const rules = book.rules(book.get(id)!);
  const row = payoutRow(a, rules, 'manual')!;
  assert.deepEqual([row.eligible, row.requested, row.received, row.floor, row.floorAfter, row.cushionAfter, row.microsAfter], [750, null, 0, 25_100, 25_100, 650, 10]);
  assert.ok(row.checks.every((c) => c.ok));
  assert.equal(ledger.confirmedReceived(), 0);
  // Requested: parked, and nothing can be logged on it.
  assert.equal(ledger.request(id, { day: day(5), now: NOW, key: 'r1' }), undefined);
  const parked = payoutRow(a, rules, 'manual')!;
  assert.deepEqual([a.status, parked.eligible, parked.requested, parked.requestedOn, parked.next], ['parked', 0, 750, day(5), 'Once the withdrawal is reconciled']);
  assert.match(book.logDay(id, { day: day(6), pnl: 100, now: NOW })!, /parked until the payout is reconciled/);
  assert.equal(ledger.confirmedReceived(), 0);
  // A double click, or the same message again: one request.
  assert.equal(ledger.request(id, { day: day(5), now: NOW, key: 'r1' }), 'That request was already made');
  assert.equal(ledger.request(id, { day: day(5), now: NOW, key: 'r2' }), 'A payout is already requested on this account');
  // Received: 90% of what was withdrawn reaches the owner, and the account trades again with what is left.
  assert.equal(ledger.received(id, { day: day(7), now: NOW }), undefined);
  assert.deepEqual([a.status, a.balance, a.received, ledger.confirmedReceived()], ['active', 25_750, 675, 675]);
  assert.equal(ledger.received(id, { day: day(7), now: NOW }), 'No payout is waiting on that account');
  assert.deepEqual(ledger.log().map((e) => `${e.kind}:${e.amount}`), ['paid:675', 'requested:750']);
  // Back in the rotation: with $650 of cushion over the locked floor.
  assert.equal(book.logDay(id, { day: day(8), pnl: 150, now: NOW }), undefined);
});

test('a denied request, a part payment, an account that isn’t eligible, and one that isn’t funded', () => {
  const denied = ready();
  denied.ledger.request(denied.id, { day: day(5), now: NOW, key: 'r1' });
  assert.equal(denied.ledger.denied(denied.id, { day: day(6), now: NOW, reason: 'Under review' }), undefined);
  const a = denied.book.get(denied.id)!.account;
  assert.deepEqual([a.status, a.balance, denied.ledger.confirmedReceived()], ['active', 26_500, 0]);
  assert.deepEqual(denied.ledger.log().map((e) => e.kind), ['denied', 'requested']);
  assert.equal(denied.ledger.denied(denied.id, { day: day(6), now: NOW, reason: '' }), 'No payout is waiting on that account');
  // Part of it arrived: what was withdrawn is what leaves the account, and the note says so.
  const part = ready();
  part.ledger.request(part.id, { day: day(5), now: NOW, key: 'r1', amount: 600 });
  assert.match(part.ledger.received(part.id, { day: day(7), now: NOW, withdrawn: 700 })!, /The request was for \$600/);
  assert.equal(part.ledger.received(part.id, { day: day(7), now: NOW, withdrawn: 400 }), undefined);
  assert.deepEqual([part.book.get(part.id)!.account.balance, part.ledger.confirmedReceived(), part.ledger.log()[0]!.note], [26_100, 360, 'Part payment: $400 of the $600 requested']);
  // Not eligible yet.
  const book = new AccountBook(null);
  const ledger = new PayoutLedger(null, book);
  const fresh = (book.add({ ruleSetId: F25, day: day(1), now: NOW }) as { account: { id: string } }).account.id;
  assert.match(ledger.request(fresh, { day: day(1), now: NOW, key: 'x' })!, /0 of 5 this cycle/);
  assert.equal(ledger.request('nobody', { day: day(1), now: NOW, key: 'x' }), 'No such account');
  // An evaluation has no payouts.
  const ev = (book.add({ ruleSetId: E25, day: day(1), now: NOW }) as { account: { id: string } }).account.id;
  assert.equal(payoutRow(book.get(ev)!.account, book.rules(book.get(ev)!), 'manual'), null);
});

test('tracked accounts and their payouts survive a restart; an account under review takes no trades', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'acct-')), 'accounts.json');
  const first = ready(file);
  first.ledger.request(first.id, { day: day(5), now: NOW, key: 'r1' });
  const book = new AccountBook(file);
  const ledger = new PayoutLedger(file.replace('accounts', 'payouts'), book);
  const a = book.get(first.id)!.account;
  assert.deepEqual([a.status, a.request!.amount, book.get(first.id)!.days.length], ['parked', 750, 5]);
  // After the restart the same request is still refused, and it can still be reconciled.
  assert.equal(ledger.request(first.id, { day: day(5), now: NOW, key: 'r1' }), 'That request was already made');
  assert.equal(ledger.received(first.id, { day: day(7), now: NOW }), undefined);
  assert.equal(new PayoutLedger(file.replace('accounts', 'payouts'), new AccountBook(file)).confirmedReceived(), 675);
  assert.equal(book.setStatus(first.id, 'review', { day: day(8), now: NOW }), undefined);
  assert.match(book.logDay(first.id, { day: day(8), pnl: 50, now: NOW })!, /can’t trade: the account is needs review/);
  assert.equal(book.setStatus(first.id, 'active', { day: day(8), now: NOW }), undefined);
  assert.equal(book.logDay(first.id, { day: day(8), pnl: 50, now: NOW }), undefined);
  assert.equal(book.setStatus(first.id, 'removed', { day: day(9), now: NOW }), undefined);
  assert.equal(book.list().length, 0);
});
