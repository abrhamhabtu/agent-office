import { HubConnectionBuilder, HubConnectionState, HttpTransportType, LogLevel, type HubConnection } from '@microsoft/signalr';
import type { Bar, Symbol } from '../../shared/trading.js';
import type { Market } from './market.js';

export type FuturesSymbol = Exclude<Symbol, 'BTC'>;
export interface Contract { id: string; name: string; activeContract: boolean }
const FUTURES: FuturesSymbol[] = ['NQ', 'ES', 'GC'];

/** Discover the active full-size contract, never an arbitrary expiry or a similarly named micro. */
export function activeContracts(raw: unknown): Map<FuturesSymbol, Contract> {
  const out = new Map<FuturesSymbol, Contract>();
  if (!Array.isArray(raw)) return out;
  for (const sym of FUTURES) {
    const matches = raw.filter((c): c is Contract => !!c && typeof c.id === 'string' && typeof c.name === 'string' && c.activeContract === true && new RegExp(`^${sym}[FGHJKMNQUVXZ]\\d{1,4}$`).test(c.name));
    if (matches.length === 1) out.set(sym, matches[0]!);
  }
  return out;
}

/** ProjectX returns newest first. Preserve exchange times; reject malformed candles. */
export function projectXBars(raw: unknown, now = Date.now()): Bar[] {
  if (!Array.isArray(raw)) return [];
  const out = new Map<number, Bar>();
  for (const b of raw) {
    if (!b || typeof b.t !== 'string') continue;
    const ts = Date.parse(b.t);
    if (!Number.isFinite(ts) || ts <= 0 || ts > now || ![b.o, b.h, b.l, b.c].every(n => typeof n === 'number' && Number.isFinite(n) && n > 0) || !Number.isFinite(b.v) || b.v < 0 || b.h < Math.max(b.o, b.c) || b.l > Math.min(b.o, b.c) || b.h < b.l) continue;
    out.set(ts, { ts, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v });
  }
  return [...out.values()].sort((a, b) => a.ts - b.ts);
}

export function projectXQuote(raw: unknown, source: string, now = Date.now()) {
  const q = raw as Record<string, unknown> | null;
  if (!q || typeof q.lastPrice !== 'number' || !Number.isFinite(q.lastPrice) || q.lastPrice <= 0) return null;
  const at = typeof q.lastUpdated === 'string' ? Date.parse(q.lastUpdated) : typeof q.timestamp === 'string' ? Date.parse(q.timestamp) : NaN;
  if (!Number.isFinite(at) || at <= 0 || at > now + 60_000) return null;
  const positive = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : q.lastPrice as number;
  return { last: q.lastPrice, prevClose: positive(typeof q.change === 'number' ? q.lastPrice - q.change : null), open: positive(q.open), high: positive(q.high), low: positive(q.low), updatedAt: at, source };
}

export type MarketHub = Pick<HubConnection, 'state' | 'start' | 'stop' | 'invoke' | 'on' | 'onreconnecting' | 'onreconnected' | 'onclose'>;
type Read = (route: 'Contract/available' | 'History/retrieveBars', body: unknown) => Promise<Record<string, unknown>>;

/** TopstepX simulation data subscription. Quotes stream; provider candles refresh every 20s.
 * No user/order hub, account selection or order calls are needed for market data.
 */
export class ProjectXMarket {
  private hub: MarketHub | null = null;
  private contracts = new Map<FuturesSymbol, Contract>();
  private timer: NodeJS.Timeout | null = null;
  private generation = 0;
  private busy = false;
  private missingBars = new Set<string>();
  constructor(private market: Market, private read: Read, private token: () => Promise<string>,
    private createHub: () => MarketHub = () => new HubConnectionBuilder().withUrl('https://rtc.topstepx.com/hubs/market', {
      skipNegotiation: true, transport: HttpTransportType.WebSockets, accessTokenFactory: this.token, timeout: 10_000,
    }).withAutomaticReconnect().configureLogging(LogLevel.None).build()) {}

  start() {
    if (this.timer) return;
    this.market.projectXStatus(false, 'Connecting to TopstepX real-time data…');
    this.timer = setInterval(() => void this.refresh(), 20_000);
    void this.refresh();
  }
  async stop(clear = true) {
    this.generation++;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const hub = this.hub;
    this.hub = null;
    this.contracts.clear();
    this.missingBars.clear();
    if (clear) this.market.clearProjectX();
    if (hub) await hub.stop().catch(() => {});
  }

  private async subscribe(hub: MarketHub, gen: number) {
    for (const c of this.contracts.values()) {
      if (gen !== this.generation) return;
      await hub.invoke('SubscribeContractQuotes', c.id);
    }
  }

  private async refresh() {
    if (this.busy || !this.timer) return;
    this.busy = true;
    const gen = this.generation;
    try {
      if (!this.hub || this.hub.state === HubConnectionState.Disconnected) {
        const data = await this.read('Contract/available', { live: false });
        if (gen !== this.generation) return;
        const contracts = activeContracts(data.contracts);
        if (!contracts.size) throw new Error('No eligible NQ, ES or GC contracts');
        this.contracts = contracts;
        const hub = this.createHub();
        this.hub = hub;
        const current = () => gen === this.generation && this.hub === hub;
        hub.on('GatewayQuote', (id: string, data: unknown) => {
          if (!current()) return;
          const match = [...this.contracts].find(([, c]) => c.id === id);
          if (!match) return;
          const [sym, contract] = match;
          const q = projectXQuote(data, `ProjectX · ${contract.name}`);
          if (q) this.market.setProjectXQuote(sym, q, this.missingBars.size ? `Quotes streaming; ${[...this.missingBars].join(', ')} candle history unavailable. Check market-data entitlement; chart sources remain visible.` : undefined);
        });
        hub.onreconnecting(() => { if (current()) this.market.projectXStatus(false, 'Reconnecting; last exchange times retained'); });
        hub.onclose(() => { if (current()) this.market.projectXStatus(false, 'Connection interrupted; retrying in up to 20s'); });
        hub.onreconnected(() => {
          if (current()) void this.subscribe(hub, gen).catch(() => {
            if (!current()) return;
            this.market.projectXStatus(false, 'Quote subscription failed; reconnecting in up to 20s');
            void hub.stop().catch(() => {});
          });
        });
        await hub.start();
        if (!current()) { await hub.stop(); return; }
        await this.subscribe(hub, gen);
      }
      if (this.hub.state !== HubConnectionState.Connected) return;
      for (const [sym, contract] of this.contracts) {
        const first = !this.market.hasProjectXBars(sym);
        const now = Date.now();
        try {
          const data = await this.read('History/retrieveBars', { contractId: contract.id, live: false,
            startTime: new Date(now - (first ? 5 * 86_400_000 : 10 * 60_000)).toISOString(), endTime: new Date(now).toISOString(),
            unit: 2, unitNumber: 1, limit: first ? 8000 : 20, includePartialBar: false });
          if (gen !== this.generation) return;
          const bars = projectXBars(data.bars);
          if (bars.length) {
            this.market.setProjectXBars(sym, bars, `ProjectX · ${contract.name}`);
            this.missingBars.delete(contract.name);
          } else if (first) this.missingBars.add(contract.name);
        } catch {
          if (gen !== this.generation) return;
          this.missingBars.add(contract.name);
          this.market.projectXNote(`${contract.name} candle history unavailable; check market-data entitlement. Other subscribed contracts continue; chart sources remain visible.`);
        }
      }
    } catch {
      // Avoid forwarding transport errors that could contain token-bearing URLs to logs or snapshots.
      if (gen === this.generation) {
        this.market.projectXStatus(false, 'TopstepX data unavailable. Check API access and market-data entitlement in Connections; last prices retain their source and time.');
        const hub = this.hub;
        this.hub = null;
        if (hub) await hub.stop().catch(() => {});
      }
    } finally { this.busy = false; }
  }
}
