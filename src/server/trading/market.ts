import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import type { Bar, ContextQuote, FeedStatus, Quote, Symbol } from '../../shared/trading.js';
import { INSTRUMENTS, SYMBOLS } from '../../shared/trading.js';
import { tradingDay } from './engine.js';

// Real prices. CME futures (NQ, ES, GC) come from Yahoo Finance's public chart API, which carries
// one-minute bars with volume for the last month and a price that trails the exchange by seconds to
// a few minutes; Bitcoin ticks in live off Coinbase's public websocket. Neither needs a key. When a
// source is down the last real price stays up, marked stale; nothing here ever makes a price up.

const YAHOO: Record<Symbol, string> = { NQ: 'NQ=F', ES: 'ES=F', GC: 'GC=F', BTC: 'BTC-USD' };
const CONTEXT: { id: string; label: string; yahoo: string; decimals: number }[] = [
  { id: 'VIX', label: 'VIX', yahoo: '^VIX', decimals: 2 },
  { id: 'DXY', label: 'Dollar', yahoo: 'DX-Y.NYB', decimals: 2 },
  { id: 'TNX', label: '10Y yield', yahoo: '^TNX', decimals: 3 },
  { id: 'CL', label: 'Crude', yahoo: 'CL=F', decimals: 2 },
  { id: 'RTY', label: 'Russell', yahoo: 'RTY=F', decimals: 1 },
  { id: 'YM', label: 'Dow', yahoo: 'YM=F', decimals: 0 },
];
const UA = { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) agent-office' };
const QUOTE_EVERY = 5_000;
const BARS_EVERY = 20_000;
/** Bars kept in memory per market: about a week and a half of minutes. */
const KEEP_MS = 11 * 86_400_000;

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

interface ChartResult {
  timestamp?: number[];
  indicators?: { quote?: { open?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[]; close?: (number | null)[]; volume?: (number | null)[] }[] };
}

/** One-minute bars from Yahoo's chart API, skipping the minutes it has no price for. */
export function parseChart(json: unknown): Bar[] {
  const r = (json as { chart?: { result?: ChartResult[] } })?.chart?.result?.[0];
  const ts = r?.timestamp ?? [];
  const q = r?.indicators?.quote?.[0];
  if (!q) return [];
  const out: Bar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const [o, h, l, c] = [q.open?.[i], q.high?.[i], q.low?.[i], q.close?.[i]];
    if (o == null || h == null || l == null || c == null || !(o > 0 && h > 0 && l > 0 && c > 0)) continue;
    out.push({ ts: ts[i]! * 1000, open: o, high: Math.max(h, o, c), low: Math.min(l, o, c), close: c, volume: q.volume?.[i] ?? 0 });
  }
  return out;
}

function merge(into: Bar[], fresh: Bar[]): Bar[] {
  if (!fresh.length) return into;
  const map = new Map(into.map((b) => [b.ts, b]));
  for (const b of fresh) map.set(b.ts, b);
  const cut = Date.now() - KEEP_MS;
  return [...map.values()].filter((b) => b.ts >= cut).sort((a, b) => a.ts - b.ts);
}

export interface Live {
  last: number;
  prevClose: number;
  high: number;
  low: number;
  open: number;
  updatedAt: number;
  source: string;
}

export class Market {
  private bars = new Map<Symbol, Bar[]>();
  private live = new Map<Symbol, Live>();
  private projectXBars = new Map<Symbol, { bars: Bar[]; source: string }>();
  private projectXQuotes = new Map<Symbol, Live>();
  private projectXUp = false;
  private context = new Map<string, ContextQuote>();
  private status = new Map<string, FeedStatus>();
  private timers: NodeJS.Timeout[] = [];
  private ws: WebSocket | null = null;
  private wsRetry = 1000;
  private stopped = false;
  private historyDir: string;
  /** Called when a market's bars change, so the desk can replay the day. */
  onBars: (s: Symbol) => void = () => {};

  constructor(dataDir: string) {
    this.historyDir = path.join(dataDir, 'trading', 'bars');
    for (const [id, name, note] of [
      ['yahoo', 'CME futures · Yahoo', 'NQ, ES and gold: 1-minute bars and the last price, seconds to minutes behind the exchange'],
      ['coinbase', 'Bitcoin · Coinbase', 'Live BTC-USD ticks over Coinbase’s public websocket'],
    ] as const)
      this.status.set(id, { id, name, ok: false, lastAt: null, note });
  }

  start() {
    void this.pullBars(true);
    void this.pullQuotes();
    this.timers.push(setInterval(() => void this.pullQuotes(), QUOTE_EVERY));
    this.timers.push(setInterval(() => void this.pullBars(false), BARS_EVERY));
    this.connectCoinbase();
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.ws?.close();
  }

  private mark(id: string, ok: boolean, note?: string) {
    const s = this.status.get(id)!;
    s.ok = ok;
    if (ok) s.lastAt = Date.now();
    if (note) s.note = note;
  }

  private async pullBars(first: boolean) {
    for (const sym of SYMBOLS) {
      try {
        const range = first || !this.bars.get(sym)?.length ? '5d' : '1d';
        const fresh = parseChart(await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(YAHOO[sym])}?interval=1m&range=${range}&includePrePost=true`));
        const before = this.bars.get(sym)?.at(-1);
        this.bars.set(sym, merge(this.bars.get(sym) ?? [], fresh));
        const after = this.bars.get(sym)?.at(-1);
        if (sym !== 'BTC') this.mark('yahoo', true);
        if (!before || !after || before.ts !== after.ts || before.close !== after.close) this.onBars(sym);
      } catch (e) {
        if (sym !== 'BTC') this.mark('yahoo', false, `Yahoo didn’t answer (${(e as Error).message}); showing the last real prices`);
      }
    }
  }

  private async pullQuotes() {
    const all = [...SYMBOLS.map((s) => YAHOO[s]), ...CONTEXT.map((c) => c.yahoo)];
    try {
      const json = (await getJson(`https://query1.finance.yahoo.com/v7/finance/spark?symbols=${all.map(encodeURIComponent).join(',')}&range=1d&interval=5m`)) as {
        spark?: { result?: { symbol: string; response?: { meta?: Record<string, number> }[] }[] };
      };
      for (const r of json.spark?.result ?? []) {
        const m = r.response?.[0]?.meta;
        if (!m || !(m.regularMarketPrice! > 0)) continue;
        const sym = SYMBOLS.find((s) => YAHOO[s] === r.symbol);
        const prev = m.chartPreviousClose ?? m.previousClose ?? m.regularMarketPrice!;
        if (sym) {
          // Bitcoin's price comes off Coinbase while that's up; Yahoo fills in when it isn't.
          const cur = this.live.get(sym);
          const fromCoinbase = sym === 'BTC' && cur?.source === 'Coinbase' && Date.now() - cur.updatedAt < 60_000;
          this.live.set(sym, {
            last: fromCoinbase ? cur!.last : m.regularMarketPrice!,
            prevClose: prev,
            high: m.regularMarketDayHigh ?? m.regularMarketPrice!,
            low: m.regularMarketDayLow ?? m.regularMarketPrice!,
            open: cur?.open ?? prev,
            updatedAt: fromCoinbase ? cur!.updatedAt : (m.regularMarketTime ?? 0) * 1000,
            source: fromCoinbase ? 'Coinbase' : sym === 'BTC' ? 'Yahoo' : 'CME · Yahoo',
          });
        } else {
          const c = CONTEXT.find((x) => x.yahoo === r.symbol)!;
          this.context.set(c.id, { id: c.id, label: c.label, last: m.regularMarketPrice!, changePct: prev ? ((m.regularMarketPrice! - prev) / prev) * 100 : 0, decimals: c.decimals });
        }
      }
      this.mark('yahoo', true);
    } catch (e) {
      this.mark('yahoo', false, `Yahoo didn’t answer (${(e as Error).message}); showing the last real prices`);
    }
  }

  private connectCoinbase() {
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket('wss://ws-feed.exchange.coinbase.com');
    } catch {
      return void setTimeout(() => this.connectCoinbase(), this.wsRetry);
    }
    this.ws = ws;
    ws.on('open', () => {
      this.wsRetry = 1000;
      ws.send(JSON.stringify({ type: 'subscribe', product_ids: ['BTC-USD'], channels: ['ticker'] }));
    });
    ws.on('message', (raw) => {
      let msg: { type?: string; price?: string; open_24h?: string; high_24h?: string; low_24h?: string; time?: string };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type !== 'ticker' || !msg.price) return;
      const price = Number(msg.price);
      if (!(price > 0)) return;
      const cur = this.live.get('BTC');
      this.live.set('BTC', {
        last: price,
        prevClose: cur?.prevClose ?? Number(msg.open_24h) ?? price,
        high: Math.max(cur?.high ?? price, price),
        low: Math.min(cur?.low ?? price, price),
        open: cur?.open ?? Number(msg.open_24h ?? price),
        updatedAt: msg.time ? Date.parse(msg.time) : 0,
        source: 'Coinbase',
      });
      this.mark('coinbase', true);
    });
    const retry = () => {
      if (this.ws !== ws || this.stopped) return;
      this.ws = null;
      this.mark('coinbase', false, 'Reconnecting to Coinbase…');
      setTimeout(() => this.connectCoinbase(), this.wsRetry);
      this.wsRetry = Math.min(30_000, this.wsRetry * 2);
    };
    ws.on('close', retry);
    ws.on('error', () => ws.close());
  }

  projectXStatus(ok: boolean, note: string) {
    this.projectXUp = ok;
    const before = this.status.get('projectx-market');
    this.status.set('projectx-market', { id: 'projectx-market', name: 'TopstepX · real-time futures', ok, lastAt: ok ? Date.now() : before?.lastAt ?? null, note });
  }

  projectXNote(note: string) {
    const status = this.status.get('projectx-market');
    if (status) status.note = note;
  }
  setProjectXQuote(sym: Symbol, quote: Live, note?: string) {
    const previous = this.projectXQuotes.get(sym);
    if (previous && quote.updatedAt < previous.updatedAt) return;
    this.projectXQuotes.set(sym, quote);
    this.projectXStatus(true, note ?? 'Exchange quotes streaming; ProjectX closed 1-minute candles refresh every 20s. Simulation subscription; no orders.');
  }
  setProjectXBars(sym: Symbol, fresh: Bar[], source: string) {
    const before = this.projectXBars.get(sym);
    this.projectXBars.set(sym, { bars: merge(before?.source === source ? before.bars : [], fresh), source });
    this.onBars(sym);
  }
  hasProjectXBars(sym: Symbol) { return !!this.projectXBars.get(sym)?.bars.length; }
  barSource(sym: Symbol) { return this.projectXBars.get(sym)?.source ?? 'Yahoo'; }
  clearProjectX() {
    const symbols = [...this.projectXBars.keys()];
    this.projectXBars.clear(); this.projectXQuotes.clear(); this.projectXUp = false;
    this.status.delete('projectx-market');
    for (const sym of symbols) this.onBars(sym);
  }
  private selectedBars(sym: Symbol) { return this.projectXBars.get(sym)?.bars ?? this.bars.get(sym) ?? []; }

  /** The minute bars for a market, with the forming minute closed on the live price. */
  barsOf(sym: Symbol): Bar[] {
    const bars = this.selectedBars(sym);
    const live = this.projectXQuotes.get(sym) ?? this.live.get(sym);
    if (!bars.length || !live) return bars;
    const tail = bars[bars.length - 1]!;
    const minute = Math.floor(Date.now() / 60_000) * 60_000;
    if (live.updatedAt < tail.ts) return bars;
    if (tail.ts === minute) return [...bars.slice(0, -1), { ...tail, close: live.last, high: Math.max(tail.high, live.last), low: Math.min(tail.low, live.last) }];
    return bars;
  }

  /** Bars that have finished: the forming minute is left out, so a setup never triggers on half a candle. */
  closedBars(sym: Symbol): Bar[] {
    const minute = Math.floor(Date.now() / 60_000) * 60_000;
    const bars = this.selectedBars(sym);
    return bars.length && bars[bars.length - 1]!.ts >= minute ? bars.slice(0, -1) : bars;
  }

  quotes(): Quote[] {
    const out: Quote[] = [];
    for (const sym of SYMBOLS) {
      const spec = INSTRUMENTS[sym];
      const live = this.projectXQuotes.get(sym) ?? this.live.get(sym);
      const bars = this.selectedBars(sym);
      const last = live?.last ?? bars.at(-1)?.close;
      if (last == null) continue;
      const day = tradingDay(Date.now());
      const today = bars.filter((b) => tradingDay(b.ts) === day);
      const prevClose = live?.prevClose ?? bars.filter((b) => tradingDay(b.ts) < day).at(-1)?.close ?? last;
      const updatedAt = live?.updatedAt ?? bars.at(-1)?.ts ?? 0;
      out.push({
        symbol: sym,
        name: spec.name,
        ink: spec.ink,
        decimals: spec.decimals,
        tick: spec.tick,
        last,
        open: today[0]?.open ?? live?.open ?? last,
        high: Math.max(live?.high ?? last, ...today.map((b) => b.high), last),
        low: Math.min(live?.low ?? last, ...today.map((b) => b.low), last),
        prevClose,
        change: last - prevClose,
        changePct: prevClose ? ((last - prevClose) / prevClose) * 100 : 0,
        updatedAt,
        barSource: this.barSource(sym),
        source: live?.source ?? (this.projectXBars.has(sym) ? `${this.barSource(sym)} · candle close` : sym === 'BTC' ? 'Yahoo' : 'CME · Yahoo'),
        stale: (this.projectXQuotes.has(sym) && !this.projectXUp) || Date.now() - updatedAt > (sym === 'BTC' || live?.source.startsWith('ProjectX') ? 120_000 : 15 * 60_000),
      });
    }
    return out;
  }

  contextQuotes(): ContextQuote[] {
    return CONTEXT.map((c) => this.context.get(c.id)).filter((x): x is ContextQuote => !!x);
  }

  feeds(): FeedStatus[] {
    return [...this.status.values()].map((s) => ({ ...s }));
  }

  // ---- History for the backtest ------------------------------------------------------------------

  /**
   * About a month of minute bars for a market: Yahoo keeps 1-minute history for 30 days, served a week
   * at a time. Finished days are kept on disk, so only the days since the last run are fetched again.
   */
  async history(sym: Symbol): Promise<Bar[]> {
    const file = path.join(this.historyDir, `${sym}.json`);
    let cached: Bar[] = [];
    try {
      cached = JSON.parse(readFileSync(file, 'utf8')) as Bar[];
    } catch {
      // First run.
    }
    const now = Date.now();
    const since = cached.length ? cached[cached.length - 1]!.ts + 60_000 : now - 29 * 86_400_000;
    let fresh: Bar[] = [];
    for (let from = Math.max(since, now - 29 * 86_400_000); from < now; from += 7 * 86_400_000) {
      const to = Math.min(now, from + 7 * 86_400_000);
      try {
        fresh = fresh.concat(parseChart(await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(YAHOO[sym])}?interval=1m&period1=${Math.floor(from / 1000)}&period2=${Math.floor(to / 1000)}&includePrePost=true`)));
      } catch {
        // A week Yahoo won't give: the backtest runs on what there is.
      }
    }
    const map = new Map([...cached, ...fresh].map((b) => [b.ts, b]));
    const all = [...map.values()].sort((a, b) => a.ts - b.ts).filter((b) => b.ts > now - 45 * 86_400_000);
    // Keep only finished trading days on disk: today's are still changing.
    const today = tradingDay(now);
    try {
      mkdirSync(this.historyDir, { recursive: true });
      writeFileSync(file, JSON.stringify(all.filter((b) => tradingDay(b.ts) < today)));
    } catch {
      // Not saved: fetched again next time.
    }
    return all;
  }
}
