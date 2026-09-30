import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarDays, calendarRows, eventTime, marketBrief, nextCondition, orderedProposals, PROPOSAL_STATUS } from '../src/client/trading/brief';
import type { NewsItem, Proposal, ProposalStage, Symbol } from '../src/shared/trading';
const proposal = (id: string, stage: ProposalStage, symbol: Symbol = 'NQ', mark: Proposal['mark'] = null) => ({ id, stage, symbol, mark, checks: [] } as unknown as Proposal);
const event = (id: string, at: string, kind: NewsItem['kind'] = 'calendar') => ({ id, at: Date.parse(at), kind } as NewsItem);

test('overview prioritizes tracked paper trades and entry setups without hiding them behind off-hours rows', () => {
  const list = [proposal('off', 'off'), proposal('watch', 'watching'), proposal('ready', 'ready'), proposal('live', 'live'), proposal('taken', 'live', 'NQ', 'taken'), proposal('skip', 'live', 'NQ', 'skipped'), proposal('es', 'live', 'ES')];
  const original = [...list];
  const brief = marketBrief(list, 'NQ');
  assert.equal(brief.primary?.id, 'taken');
  assert.equal(brief.active, 2);
  assert.equal(brief.ready, 1);
  assert.deepEqual(brief.others.map(p => p.id), ['live', 'ready', 'watch', 'off']);
  assert.deepEqual(list, original, 'overview must not change the snapshot order');
  assert.equal(orderedProposals(list).some(p => p.id === 'skip'), true, 'All setups retains skipped records');
});
test('completed and off-hours setups remain reviewable, including markets with only skipped decisions', () => {
  assert.equal(marketBrief([proposal('off', 'off'), proposal('done', 'won')], 'NQ').primary?.id, 'done');
  assert.equal(marketBrief([proposal('skip', 'ready', 'NQ', 'skipped')], 'NQ').primary, null);
  assert.equal(PROPOSAL_STATUS.live, 'Paper trade active', 'paper tracking is not presented as a broker position');
  const p = { ...proposal('waiting', 'watching'), checks: [{ ok: true, label: 'Level tested' }, { ok: false, label: 'Rejection candle' }] };
  assert.equal(nextCondition(p), 'Waiting on: Rejection candle');
  assert.equal(nextCondition(proposal('no-zone', 'watching')), 'Waiting for an entry setup to form.', 'an empty checklist is not a passed setup');
  assert.equal(nextCondition({ ...p, entry: 100, checks: [{ ok: true, label: 'Level tested' }] }), 'Setup checks passed; review the risk guard.');
});
test('calendar groups by Pacific date rather than UTC date and excludes released rows from upcoming', () => {
  const now = Date.parse('2026-09-30T07:15:00Z'); // 00:15 Pacific
  const past = event('yesterday', '2026-09-30T06:50:00Z');
  const earlier = event('released', '2026-09-30T07:00:00Z');
  const next = event('next', '2026-09-30T12:30:00Z');
  const tomorrow = event('tomorrow', '2026-10-01T12:30:00Z');
  const list = [tomorrow, next, past, earlier, event('headline', '2026-09-30T12:00:00Z', 'headline')];
  assert.deepEqual(calendarDays(list, now, 'upcoming').flatMap(g => g.items.map(n => n.id)), ['next', 'tomorrow']);
  assert.deepEqual(calendarDays(list, now, 'today').flatMap(g => g.items.map(n => n.id)), ['released', 'next']);
  const week = calendarDays(list, now, 'week');
  assert.equal(week.length, 3);
  assert.match(week[1]!.label, /^Today/);
  assert.equal(eventTime(next.at), '05:30');
});
test('wall calendar shows nearest upcoming releases before recently released ones', () => {
  const now = Date.parse('2026-09-30T12:00:00Z');
  const list = [event('past', '2026-09-30T11:55:00Z'), event('later', '2026-09-30T14:00:00Z'), event('next', '2026-09-30T12:15:00Z')];
  assert.deepEqual(calendarRows(list, now).map(n => n.id), ['next', 'later']);
  assert.deepEqual(calendarRows(list, now + 86_400_000, 1).map(n => n.id), ['later']);
});
