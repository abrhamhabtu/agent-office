import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
// @ts-expect-error Executable JavaScript receiver intentionally has no declaration file.
import { candleRelay } from '../bin/tradingview-relay.mjs';
async function listen(s: Server) {
  await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
}
async function close(s: Server) { s.closeAllConnections(); await new Promise<void>(resolve => s.close(() => resolve())); }
test('public candle receiver forwards only keyed JSON candles, never office routes or signal alerts', async () => {
  const received: string[] = [];
  const office = createServer((req, res) => { received.push(req.url!); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true,"bar":"NQ"}'); });
  const destination = await listen(office); const relay: Server = candleRelay(destination); const base = await listen(relay);
  try {
    const key = 'test-candle-key-123456'; const route = `${base}/api/trading/tradingview?key=${key}`;
    assert.equal((await fetch(`${base}/api/trading/state`)).status, 404);
    assert.equal((await fetch(route)).status, 404);
    assert.equal((await fetch(route, { method: 'POST', body: '{"symbol":"NQ","side":"long"}' })).status, 400);
    assert.equal((await fetch(`${base}/api/trading/tradingview`, { method: 'POST', body: '{"type":"bar"}' })).status, 401);
    assert.equal((await fetch(route, { method: 'POST', body: 'x'.repeat(16001) })).status, 413);
    assert.equal(received.length, 0);
    assert.deepEqual(await (await fetch(`${route}&ignored=anything`, { method: 'POST', body: '{"type":"bar","symbol":"NQ"}' })).json(), { ok: true, bar: 'NQ' });
    assert.deepEqual(received, [`/api/trading/tradingview?key=${key}`]);
    assert.throws(() => candleRelay('https://example.com'), /local HTTP/);
  } finally { await close(relay); await close(office); }
});
