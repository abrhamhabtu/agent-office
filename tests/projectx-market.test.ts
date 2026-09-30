import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HubConnectionState } from '@microsoft/signalr';
import { activeContracts, projectXBars, projectXQuote, ProjectXMarket, type MarketHub } from '../src/server/trading/projectx-market';
import { Market } from '../src/server/trading/market';
import { ProjectX } from '../src/server/trading/projectx';
const contracts = [ { id: 'CON.F.US.ENQ.Z26', name: 'NQZ26', activeContract: true }, { id: 'CON.F.US.EP.Z26', name: 'ESZ26', activeContract: true }, { id: 'CON.F.US.GC.Z26', name: 'GCZ26', activeContract: true } ];
const now = Date.now();
const bar = { t: new Date(now - 120_000).toISOString(), o: 100, h: 102, l: 99, c: 101, v: 10 };
const tick = { lastPrice: 101.5, change: 2, open: 100, high: 102, low: 99, timestamp: new Date(now).toISOString() };
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

class FakeHub {
  state = HubConnectionState.Disconnected;
  calls: [string, string][] = [];
  events = new Map<string, (...args: any[]) => void>();
  reconnecting = () => {};
  reconnected = () => {};
  closed = () => {};
  async start() { this.state = HubConnectionState.Connected; }
  async stop() { this.state = HubConnectionState.Disconnected; this.closed(); }
  async invoke(method: string, id: string) { this.calls.push([method, id]); }
  on(event: string, cb: (...args: any[]) => void) { this.events.set(event, cb); }
  onreconnecting(cb: () => void) { this.reconnecting = cb; }
  onreconnected(cb: () => void) { this.reconnected = cb; }
  onclose(cb: () => void) { this.closed = cb; }
}

test('contract discovery rejects micros, expired and ambiguous active contracts', () => {
  assert.deepEqual([...activeContracts([...contracts, { id: 'micro', name: 'MNQZ26', activeContract: true }, { id: 'old', name: 'NQU26', activeContract: false }]).keys()], ['NQ', 'ES', 'GC']);
  assert.equal(activeContracts([...contracts, { id: 'ambiguous', name: 'NQH27', activeContract: true }]).has('NQ'), false);
});
test('provider candles are sorted, deduplicated and validated without fabricated timestamps', () => {
  const earlier = { ...bar, t: new Date(now - 180_000).toISOString() };
  const bars = projectXBars([bar, earlier, bar, { ...bar, t: 'invalid' }, { ...bar, c: NaN }, { ...bar, h: 98 }, { ...bar, v: -1 }, { ...bar, t: new Date(now + 300_000).toISOString() }], now);
  assert.equal(bars.length, 2);
  assert.equal(bars[0]!.ts, Date.parse(earlier.t));
  assert.equal(bars[1]!.volume, 10);
  assert.equal(projectXQuote({ ...tick, timestamp: undefined }, 'ProjectX', now), null);
  assert.equal(projectXQuote({ ...tick, lastPrice: Infinity }, 'ProjectX', now), null);
  assert.equal(projectXQuote(tick, 'ProjectX', now)?.updatedAt, now);
});
test('stream subscribes read-only, uses provider candles, re-subscribes, and clears on disable', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-px-'));
  const market = new Market(dir);
  const hub = new FakeHub();
  const routes: string[] = [];
  const stream = new ProjectXMarket(market, async (route, body) => {
    routes.push(route);
    assert.equal((body as {live:boolean}).live, false);
    return route === 'Contract/available' ? { contracts } : { bars: [bar] };
  }, async () => 'test-token', () => hub as unknown as MarketHub);
  try {
    stream.start(); await turn();
    assert.equal(hub.calls.length, 3);
    assert.match(market.quotes()[0]!.source, /ProjectX · NQZ26 · candle close/, 'a price derived from a provider candle retains that provider');
    assert.ok(hub.calls.every(([method]) => method === 'SubscribeContractQuotes'));
    assert.ok(routes.every(r => r === 'Contract/available' || r === 'History/retrieveBars'));
    hub.events.get('GatewayQuote')!(contracts[0]!.id, tick);
    const quote = market.quotes().find(q => q.symbol === 'NQ')!;
    assert.equal(quote.source, 'ProjectX · NQZ26');
    assert.equal(quote.barSource, quote.source);
    assert.equal(quote.last, 101.5);
    assert.equal(market.closedBars('NQ')[0]!.volume, 10);
    hub.reconnecting();
    assert.equal(market.quotes()[0]!.stale, true);
    hub.reconnected(); await turn();
    assert.equal(hub.calls.length, 6);
    hub.events.get('GatewayQuote')!(contracts[0]!.id, { ...tick, lastPrice: 1, timestamp: new Date(now - 1000).toISOString() });
    assert.equal(market.quotes()[0]!.last, 101.5, 'out-of-order quote cannot rewind the stream');
    await stream.stop();
    hub.events.get('GatewayQuote')!(contracts[0]!.id, tick);
    assert.equal(market.quotes().length, 0, 'disabled stream ignores late callbacks');
    assert.equal(market.feeds().some(f => f.id === 'projectx-market'), false);
  } finally { await stream.stop(); rmSync(dir, { recursive: true, force: true }); }
});
test('one denied candle entitlement does not prevent other contracts from loading', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-px-'));
  const market = new Market(dir);
  const hub = new FakeHub();
  const stream = new ProjectXMarket(market, async (route, body) => {
    if (route === 'Contract/available') return { contracts };
    if ((body as {contractId:string}).contractId === contracts[0]!.id) throw new Error('Denied');
    return { bars: [bar] };
  }, async () => 'token', () => hub as unknown as MarketHub);
  try {
    stream.start(); await turn();
    assert.equal(market.hasProjectXBars('NQ'), false);
    assert.equal(market.hasProjectXBars('ES'), true);
    assert.equal(hub.state, HubConnectionState.Connected);
    hub.events.get('GatewayQuote')!(contracts[0]!.id, tick);
    assert.equal(market.quotes()[0]!.barSource, 'Yahoo');
    assert.match(market.feeds().find(f => f.id === 'projectx-market')!.note, /NQZ26 candle history unavailable/);
  } finally { await stream.stop(); rmSync(dir, { recursive: true, force: true }); }
});
test('stop during pending discovery cannot start a socket or revive data', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-px-'));
  const market = new Market(dir);
  const hub = new FakeHub();
  let complete!: (data: Record<string, unknown>) => void;
  const stream = new ProjectXMarket(market, () => new Promise(resolve => { complete = resolve; }), async () => 'token', () => hub as unknown as MarketHub);
  try {
    stream.start(); await stream.stop(); complete({ contracts }); await turn();
    assert.equal(hub.state, HubConnectionState.Disconnected);
    assert.equal(market.feeds().some(f => f.id === 'projectx-market'), false);
  } finally { await stream.stop(); rmSync(dir, { recursive: true, force: true }); }
});
test('market streaming cannot be enabled without a saved API connection', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-px-'));
  try {
    const px = new ProjectX(dir, new Market(dir));
    assert.equal(await px.setMarketData(true), 'Connect ProjectX first');
    assert.equal(px.marketEnabled(), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('API keys remain server-side with owner-only permissions; market opt-in persists', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-px-'));
  const originalFetch = globalThis.fetch;
  const { readFileSync, statSync } = await import('node:fs');
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    const route = String(url).split('/api/')[1]!;
    calls.push(route);
    return new Response(JSON.stringify({ success: true, ...(route === 'Auth/loginKey' ? { token: 'fixture-token' } : { accounts: [], trades: [] }) }));
  }) as typeof fetch;
  try {
    const px = new ProjectX(dir);
    assert.equal(await px.connect('fixture-user', 'fixture-secret', ''), undefined);
    assert.equal(px.marketEnabled(), false);
    assert.equal(await px.setMarketData(true), undefined);
    const file = path.join(dir, 'trading/projectx.json');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).marketData, true);
    assert.equal(new ProjectX(dir).marketEnabled(), true);
    assert.ok(!JSON.stringify(px.state()).includes('fixture-secret'));
    assert.ok(calls.every(r => ['Auth/loginKey', 'Account/search', 'Trade/search'].includes(r)));
    px.disconnect();
    assert.equal(px.marketEnabled(), false);
    assert.equal(await px.connect('fixture-user', 'fixture-secret', 'https://other-projectx.example/api'), undefined);
    assert.match((await px.setMarketData(true))!, /default TopstepX gateway/);
    assert.equal(px.marketEnabled(), false, 'custom gateway token cannot be sent to the TopstepX hub');
    px.disconnect();
  } finally { globalThis.fetch = originalFetch; rmSync(dir, { recursive: true, force: true }); }
});
