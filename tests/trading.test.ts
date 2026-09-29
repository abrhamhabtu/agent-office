import assert from 'node:assert/strict';
import test from 'node:test';
import { floorRole, SYMBOLS } from '../src/shared/trading.ts';
import { actOnProposal, snapshot, togglePlaybook } from '../src/server/trading.ts';

test('The Desk is the live-ticket floor and every other floor is a pit', () => {
  assert.equal(floorRole('The Desk'), 'desk');
  assert.equal(floorRole('the desk'), 'desk');
  assert.equal(floorRole('The Pit'), 'pit');
  assert.equal(floorRole('trade-pilot'), 'pit');
  assert.equal(floorRole('Desktop apps'), 'pit');
  assert.equal(floorRole(undefined), 'pit');
});

test('the snapshot covers every contract, and a chart ends on the price the ticker shows', () => {
  const s = snapshot(Date.UTC(2026, 8, 28, 15, 0, 0));
  assert.equal(s.source, 'sample');
  for (const sym of SYMBOLS) {
    const q = s.quotes.find((x) => x.symbol === sym)!;
    assert.ok(q.last > 0 && q.ask >= q.bid, sym);
    assert.equal(s.bars[sym].at(-1)!.close, q.last, sym);
    assert.ok(s.levels[sym].vwapU1 >= s.levels[sym].vwap && s.levels[sym].vwap >= s.levels[sym].vwapL1, sym);
  }
});

test('the same minute gives the same tape', () => {
  const at = Date.UTC(2026, 8, 28, 15, 0, 0);
  assert.deepEqual(snapshot(at).bars.MNQ, snapshot(at).bars.MNQ);
});

test('a proposal always aims the way its side says, with the stop the other way', () => {
  const s = snapshot(Date.UTC(2026, 8, 28, 15, 0, 0));
  assert.ok(s.proposals.length > 0);
  for (const p of s.proposals) {
    if (p.side === 'long') assert.ok(p.stop < p.entry && p.entry < p.target, p.id);
    else assert.ok(p.stop > p.entry && p.entry > p.target, p.id);
    assert.ok(p.r > 0, p.id);
  }
});

test('nothing reaches The Desk without being taken on paper first, and Bulwark never clears an unproved setup', () => {
  const id = snapshot().proposals[0]!.id;
  assert.equal(actOnProposal(id, 'reset'), undefined);
  assert.match(actOnProposal(id, 'graduate') ?? '', /paper first/);
  assert.equal(snapshot().tickets.length, 0);
  assert.equal(actOnProposal(id, 'paper'), undefined);
  assert.equal(actOnProposal(id, 'graduate'), undefined);
  const ticket = snapshot().tickets.find((t) => t.proposalId === id)!;
  assert.ok(ticket);
  assert.ok(ticket.checks.some((c) => /Proved on the Pit/.test(c.label) && c.ok));
  assert.equal(actOnProposal(id, 'reset'), undefined);
  assert.match(actOnProposal('nonsense', 'paper') ?? '', /No such/);
});

test('the playbook ticks on and off, and rejects unknown items', () => {
  assert.equal(togglePlaybook('brief'), true);
  assert.equal(snapshot().playbook.find((p) => p.id === 'brief')!.done, true);
  assert.equal(togglePlaybook('brief'), true);
  assert.equal(snapshot().playbook.find((p) => p.id === 'brief')!.done, false);
  assert.equal(togglePlaybook('nope'), false);
});
