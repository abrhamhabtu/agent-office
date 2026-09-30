import test from 'node:test';
import assert from 'node:assert/strict';
import { dataFreshness, marketTime } from '../src/shared/freshness';
import type { Quote } from '../src/shared/trading';

const now = Date.UTC(2026, 8, 30, 15, 30);
const quote = (patch: Partial<Quote> = {}): Quote => ({ symbol: 'NQ', source: 'CME · Yahoo', updatedAt: now - 60_000, stale: false, ...patch } as Quote);

test('Yahoo stays delayed even when snapshots and quotes arrive recently', () => {
  const f = dataFreshness(quote(), now, now - 60_000);
  assert.equal(f.status, 'DELAYED');
  assert.match(f.detail, /CME · Yahoo/);
  assert.match(f.detail, /Quote 09\/30, 08:29:00 PT/);
  assert.match(f.detail, /Yahoo bars 09\/30, 08:29:00 PT/);
});
test('a quote ages to stale without any new market snapshot', () => {
  const q = quote();
  assert.equal(dataFreshness(q, now).status, 'DELAYED');
  assert.equal(dataFreshness(q, now + 16 * 60_000).status, 'STALE');
  assert.equal(q.updatedAt, now - 60_000);
});
test('a current Coinbase tick cannot make old Yahoo chart or proposal bars current', () => {
  const q = quote({ symbol: 'BTC', source: 'Coinbase', updatedAt: now });
  assert.equal(dataFreshness(q, now, now - 60_000).status, 'DELAYED BARS');
  const f = dataFreshness(q, now, now - 20 * 60_000);
  assert.equal(f.status, 'STALE');
  assert.match(f.detail, /Quote 09\/30, 08:30:00 PT/);
  assert.match(f.detail, /Yahoo bars 09\/30, 08:10:00 PT/);
});
test('missing or invalid timestamps are never substituted with the refresh time', () => {
  for (const at of [0, NaN, now + 120_000]) assert.equal(dataFreshness(quote({ updatedAt: at, stale: true }), now).status, 'TIMESTAMP UNKNOWN');
  assert.equal(dataFreshness(quote(), now, null).status, 'TIMESTAMP UNKNOWN');
  assert.equal(dataFreshness(undefined, now, null).status, 'NO DATA');
  assert.equal(marketTime(0), 'unknown');
});
test('source-reported stale data overrides a recent timestamp', () => {
  assert.equal(dataFreshness(quote({ stale: true }), now).status, 'STALE');
});

test('ProjectX ticks and candles can be current; an older Yahoo proposal keeps its own basis', () => {
  const q = quote({ source: 'ProjectX · NQZ26', barSource: 'ProjectX · NQZ26', updatedAt: now });
  assert.equal(dataFreshness(q, now, now - 60_000).status, 'CURRENT');
  assert.match(dataFreshness(q, now, now - 60_000).detail, /ProjectX · NQZ26 bars/);
  assert.equal(dataFreshness(q, now, now - 60_000, 'Yahoo').status, 'DELAYED BARS');
  assert.equal(dataFreshness(q, now + 130_000).quoteStatus, 'STALE');
  assert.equal(dataFreshness(q, now, now - 4 * 60_000).barStatus, 'STALE');
});
