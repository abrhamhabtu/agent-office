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
