import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TvMcp, TV_MCP_URL, tvRequest } from '../src/server/trading/tv-mcp.ts';

function oauth() {
  let exchanges = 0;
  const network: typeof fetch = async (input, init) => {
    const url = String(input);
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    if (url.includes('oauth-protected-resource')) return json({ resource: TV_MCP_URL, authorization_servers: ['https://mcp.tradingview.com'] });
    if (url.includes('oauth-authorization-server') || url.includes('openid-configuration')) return json({ issuer: 'https://mcp.tradingview.com', authorization_endpoint: 'https://www.tradingview.com/oauth/authorize', token_endpoint: 'https://mcp.tradingview.com/token', registration_endpoint: 'https://mcp.tradingview.com/register', response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] });
    if (url.endsWith('/register')) return json({ ...JSON.parse(String(init?.body)), client_id: 'fixture-client' });
    if (url.endsWith('/token')) {
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get('grant_type'), 'authorization_code');
      assert.ok((body.get('code_verifier') ?? '').length > 30);
      exchanges++;
      return json({ access_token: 'fixture-secret', token_type: 'Bearer', refresh_token: 'fixture-refresh', expires_in: 3600 });
    }
    throw new Error(`Unexpected request ${url}`);
  };
  return { network, exchanges: () => exchanges };
}

test('TradingView accepts only bounded read-only tools, never arbitrary write parameters', () => {
  assert.throws(() => tvRequest({ tool: 'create_alert', symbol: 'CME_MINI:MNQ1!' }));
  assert.throws(() => tvRequest({ tool: 'get_ohlcv', symbol: 'https://evil.test' }));
  assert.deepEqual(tvRequest({ tool: 'get_ohlcv', symbol: 'CME_MINI:MNQ1!', count: 100000, interval: '1s' }).arguments, { symbol: 'CME_MINI:MNQ1!', interval: '1m', count: 100, summary: false });
  assert.deepEqual(tvRequest({ tool: 'get_economic_calendar' }).arguments, { countries: 'US', min_importance: 1 });
});

test('TradingView OAuth binds state to owner, exchanges once, and saves private credentials across restart', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tv-oauth-'));
  try {
    const mock = oauth();
    const redirect = 'http://localhost:4602/api/trading/tv-mcp/callback';
    const a = new TvMcp(dir, 'owner-a', redirect, mock.network);
    const b = new TvMcp(dir, 'owner-b', redirect, mock.network);
    const started = await a.begin();
    const url = new URL(started.url!);
    const state = url.searchParams.get('state')!;
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(a.accepts(state)); assert.ok(!b.accepts(state));
    await assert.rejects(() => a.finish('wrong-state', 'code'));
    assert.equal(mock.exchanges(), 0);
    await a.finish(state, 'code');
    assert.equal(mock.exchanges(), 1);
    assert.ok(!a.accepts(state));
    await assert.rejects(() => a.finish(state, 'code'));
    assert.ok(new TvMcp(dir, 'owner-a', redirect).status().configured);
    assert.ok(!new TvMcp(dir, 'owner-a', redirect.replace('4602', '4603')).status().configured);
    assert.ok(!JSON.stringify(a.status()).includes('fixture-secret'));
    const file = path.join(dir, readdirSync(dir)[0]!);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.match(readFileSync(file, 'utf8'), /fixture-secret/);
    await a.disconnect();
    assert.equal(readdirSync(dir).length, 0);
    await assert.rejects(() => a.research({ tool: 'search_symbols', symbol: 'MNQ' }), /Connect TradingView/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('TradingView refuses authorization outside its official domain', () => {
  const c = new TvMcp(tmpdir(), 'unused-owner', 'http://localhost/callback');
  assert.throws(() => c.redirectToAuthorization(new URL('https://tradingview.com.evil.test/authorize')));
  assert.throws(() => c.redirectToAuthorization(new URL('http://www.tradingview.com/authorize')));
});


test('TradingView sign-in state expires after ten minutes', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tv-expiry-'));
  try {
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    const c = new TvMcp(dir, 'expiry', 'http://localhost:4602/callback', oauth().network);
    const started = await c.begin();
    const state = new URL(started.url!).searchParams.get('state')!;
    now += 10 * 60_000 + 1;
    assert.equal(c.accepts(state), false);
    await assert.rejects(() => c.finish(state, 'code'), /expired/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
