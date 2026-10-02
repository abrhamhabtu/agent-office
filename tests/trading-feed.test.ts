import test from 'node:test';
import assert from 'node:assert/strict';
import { TradingFeed } from '../src/client/trading/feed';

test('a failed refresh repaints freshness while retaining the actual source snapshot', async (t) => {
  const feed = new TradingFeed();
  const snapshot = { at: 1000, quotes: [{ updatedAt: 900 }], alerts: [], session: { lastBell: null } };
  let fail = false;
  t.mock.method(globalThis, 'fetch', async () => {
    if (fail) throw new Error('offline');
    return { ok: true, json: async () => snapshot } as Response;
  });
  let repaints = 0;
  feed.on(() => repaints++);
  const pull = () => (feed as unknown as { pull(): Promise<void> }).pull();
  await pull();
  const tick = feed.tick;
  fail = true;
  await pull();
  assert.equal(repaints, 2);
  assert.equal(feed.tick, tick + 1);
  assert.equal(feed.snap, snapshot);
  assert.equal(feed.snap!.quotes[0]!.updatedAt, 900, 'refresh failures must never invent a new market timestamp');
});

test('the backtest’s trades are asked for again after a failed or empty answer, and the feed says when the office isn’t answering', async (t) => {
  const feed = new TradingFeed();
  const snapshot = { at: 1000, quotes: [], alerts: [], session: { lastBell: null }, vault: { scripts: [] }, backtest: { ranAt: 77, running: false, days: ['2026-09-01'], tuner: { ranAt: 78, running: false } } };
  const full = { ranAt: 77, days: ['2026-09-01'], trades: [{ id: 't1' }] };
  let mode: 'down' | 'empty' | 'up' = 'up';
  let asked = 0;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (String(url).includes('/snapshot')) {
      if (mode === 'down') throw new Error('offline');
      return { ok: true, json: async () => snapshot } as Response;
    }
    asked++;
    if (mode === 'down') throw new Error('offline');
    // An office that has only just restarted: it answers, with nothing, until its backtest has run again.
    return { ok: true, json: async () => (mode === 'empty' ? { ranAt: 0, days: [], trades: [] } : full) } as Response;
  });
  const pull = () => (feed as unknown as { pull(): Promise<void> }).pull();
  await pull();
  assert.equal(feed.offline, false);
  // The office goes down: the request fails, and nothing is remembered as the answer.
  mode = 'down';
  await pull();
  assert.equal(feed.offline, true);
  assert.equal(await feed.backtestDetail(), null);
  // It comes back, but its backtest hasn't run yet: an empty answer isn't kept as "no trades" either.
  mode = 'empty';
  await pull();
  assert.equal(feed.offline, false);
  assert.equal((await feed.backtestDetail())!.trades.length, 0);
  assert.equal((await feed.backtestDetail())!.trades.length, 0);
  assert.equal(asked, 3, 'an empty answer is asked for again, not served from memory');
  // The trades arrive: now they are kept, and not fetched again for the same backtest.
  mode = 'up';
  assert.equal((await feed.backtestDetail())!.trades.length, 1);
  assert.equal((await feed.backtestDetail())!.trades.length, 1);
  assert.equal(asked, 4);
  // A later outage doesn't lose what was fetched.
  mode = 'down';
  assert.equal((await feed.backtestDetail())!.trades.length, 1);
});
