import test from 'node:test';
import assert from 'node:assert/strict';
import { feedsReady, readiness } from '../src/server/trading/broker.ts';

test('real-time Bitcoin never clears the CME futures gate', () => {
  const fresh = { delayed: false, stale: false, ageSec: 10 };
  const delayed = { delayed: true, stale: false, ageSec: 10 };
  assert.equal(feedsReady({ BTC: fresh, NQ: delayed }, ['NQ']), false);
  assert.equal(feedsReady({ NQ: fresh }, ['NQ', 'GC']), false);
  assert.equal(feedsReady({ NQ: fresh, GC: fresh }, ['NQ', 'GC']), true);
  for (const ageSec of [null, 241, NaN, -5]) assert.equal(feedsReady({ NQ: { ...fresh, ageSec } }, ['NQ']), false);
  assert.equal(feedsReady({ NQ: fresh }, []), false);
});

test('unverified sandbox lifecycle is never reported as proven', () => {
  const r = readiness({ automation: 'allowed', rulesVerified: true, gateMet: true, holdoutHeld: true, realTimeData: true, projectxConnected: true });
  assert.equal(r.find(x => x.label === 'Order lifecycle proven in a sandbox')!.state, 'blocked');
});
