#!/usr/bin/env node
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

/** Expose closed candles only. No office pages, sign-in, account data or websocket routes. */
export function candleRelay(target = 'http://127.0.0.1:4600') {
  const upstream = new URL(target);
  if (upstream.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(upstream.hostname) || upstream.username || upstream.password)
    throw new Error('The receiver must forward to a local HTTP office');
  return createServer(async (req, res) => {
    const reply = (status, message) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: message })); };
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method !== 'POST' || url.pathname !== '/api/trading/tradingview') { reply(404, 'No such receiver route'); return; }
    const chunks = []; let bytes = 0;
    try {
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 16_000) { reply(413, 'Candle message is too large'); return; }
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks).toString('utf8');
      let data;
      try { data = JSON.parse(body); } catch { reply(400, 'Use a JSON candle message'); return; }
      if (!data || data.type !== 'bar') { reply(400, 'This receiver accepts closed candles only'); return; }
      const key = url.searchParams.get('key') ?? data.key;
      if (typeof key !== 'string' || !/^[\w-]{16,64}$/.test(key)) { reply(401, 'Missing candle key'); return; }
      const destination = new URL('/api/trading/tradingview', upstream);
      destination.searchParams.set('key', key);
      const result = await fetch(destination, { method: 'POST', headers: { 'content-type': 'application/json' }, body,
        redirect: 'error', signal: AbortSignal.timeout(2200) });
      const answer = await result.text();
      res.writeHead(result.status, { 'content-type': 'application/json' }); res.end(answer);
    } catch { if (!res.headersSent) reply(502, 'The local office did not accept the candle'); else res.end(); }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.TRADINGVIEW_RECEIVER_PORT ?? 4610);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Use a receiver port between 1024 and 65535');
  const relay = candleRelay(process.env.TRADINGVIEW_OFFICE_URL ?? 'http://127.0.0.1:4600');
  relay.listen(port, '127.0.0.1', () => {
    console.log(`TradingView candle receiver: http://127.0.0.1:${port}`);
    console.log(`For a temporary HTTPS address: cloudflared tunnel --url http://127.0.0.1:${port}`);
    console.log('Only keyed POST candle messages are forwarded. Keep this process and the office running.');
  });
}
