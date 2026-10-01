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

/**
 * Coinbase's public 1-minute candles: [time (s), low, high, open, close, volume], newest first. They
 * include the minute still forming, so the chart is current to the second. Malformed rows are dropped.
 */
export function parseCoinbaseCandles(raw: unknown, now = Date.now()): Bar[] {
  if (!Array.isArray(raw)) return [];
  const out: Bar[] = [];
  for (const r of raw) {
    if (!Array.isArray(r) || r.length < 6) continue;
    const [t, low, high, open, close, volume] = r as number[];
    if (![t, low, high, open, close, volume].every((n) => typeof n === 'number' && Number.isFinite(n))) continue;
    const ts = t! * 1000;
    if (ts <= 0 || ts > now + 60_000 || !(low! > 0 && high! > 0 && open! > 0 && close! > 0) || volume! < 0) continue;
    out.push({ ts, open: open!, high: Math.max(high!, open!, close!), low: Math.min(low!, open!, close!), close: close!, volume: volume! });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/** The market a TradingView ticker means: NQ1!, MNQ1!, CME_MINI:ES1!, GCZ2026, BTCUSD, MBT1!… */
export function tvSymbol(ticker: unknown): Symbol | null {
  if (typeof ticker !== 'string') return null;
  const t = (ticker.split(':').pop() ?? '').trim().toUpperCase();
  if (/^M?NQ/.test(t)) return 'NQ';
  if (/^M?ES/.test(t)) return 'ES';
  if (/^M?GC/.test(t)) return 'GC';
  if (/^(BTC|MBT)/.test(t)) return 'BTC';
  return null;
}

/**
 * A one-minute candle from a TradingView bar-close alert (see the Connections panel for the message).
 * Anything that doesn't add up is refused with a reason, never patched: a bad bar would move every level.
 */
export function parseTradingViewBar(body: unknown, now = Date.now()): { symbol: Symbol; bar: Bar } | { error: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const symbol = tvSymbol(b.symbol ?? b.ticker);
  if (!symbol) return { error: `Unknown market “${String(b.symbol ?? b.ticker ?? '')}”: NQ, ES, GC and BTC only` };
  const interval = b.interval == null ? '1' : String(b.interval).toLowerCase();
  if (interval !== '1' && interval !== '1m') return { error: 'Set the alert on the 1-minute chart (the message says interval “' + interval + '”)' };
  const num = (v: unknown) => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '') ? Number(v) : NaN);
  const [open, high, low, close] = [b.open, b.high, b.low, b.close].map(num) as [number, number, number, number];
  const volume = b.volume == null || b.volume === '' ? 0 : num(b.volume);
  if (![open, high, low, close].every((n) => Number.isFinite(n) && n > 0)) return { error: 'The message needs open, high, low and close as numbers' };
  if (!Number.isFinite(volume) || volume < 0) return { error: 'Volume has to be a number' };
  if (high < Math.max(open, close) || low > Math.min(open, close) || high < low) return { error: 'The candle’s high and low don’t contain its open and close' };
  let at = NaN;
  if (typeof b.time === 'string') at = Date.parse(b.time);
  else if (typeof b.time === 'number') at = b.time > 1e12 ? b.time : b.time * 1000;
  if (!Number.isFinite(at)) return { error: 'The message needs {{time}}, the candle’s own time' };
  const ts = Math.floor(at / 60_000) * 60_000;
  if (ts > now + 60_000) return { error: 'That candle is from the future' };
  if (ts < now - 36 * 3_600_000) return { error: 'That candle is more than a day old' };
  return { symbol, bar: { ts, open, high, low, close, volume } };
}

const COINBASE_CANDLES = 'https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60';
/** Coinbase returns at most 300 candles per request. */
const COINBASE_PAGE_MS = 300 * 60_000;
/** Bitcoin candles are refreshed this often from Coinbase; the tick stream moves the forming one between. */
const BTC_BARS_EVERY = 5_000;
/** How much Bitcoin history to fetch at start-up. */
const BTC_BACKFILL_MS = 3 * 86_400_000;

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
  /** The minute forming right now, built from streamed quotes, so a chart moves with every tick rather than once a candle. */
  private forming = new Map<Symbol, Bar>();
  /** Real-time candles straight from an exchange (Bitcoin, off Coinbase), preferred over Yahoo's delayed ones while they're current. */
  private exchangeBars = new Map<Symbol, { bars: Bar[]; source: string }>();
  /** Closed one-minute candles sent by TradingView alerts, laid over Yahoo's history while they're current. */
  private tvBars = new Map<Symbol, Bar[]>();
  private tvQuotes = new Map<Symbol, Live>();
  private tvMerged = new Map<Symbol, { key: string; bars: Bar[] }>();
  private tvVersion = 0;
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
    void this.pullBtcBars(true);
    this.timers.push(setInterval(() => void this.pullBtcBars(false), BTC_BARS_EVERY));
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

  /** Bitcoin's candles off Coinbase: a few days at start-up, then the last few minutes every few seconds. */
  private async pullBtcBars(first: boolean) {
    const now = Date.now();
    try {
      let fresh: Bar[] = [];
      if (first) {
        for (let end = now; end > now - BTC_BACKFILL_MS; end -= COINBASE_PAGE_MS) {
          const page = parseCoinbaseCandles(await getJson(`${COINBASE_CANDLES}&start=${new Date(end - COINBASE_PAGE_MS).toISOString()}&end=${new Date(end).toISOString()}`));
          fresh = fresh.concat(page);
        }
      } else fresh = parseCoinbaseCandles(await getJson(`${COINBASE_CANDLES}&start=${new Date(now - 10 * 60_000).toISOString()}&end=${new Date(now).toISOString()}`));
      if (!fresh.length) return;
      const before = this.exchangeBars.get('BTC')?.bars.at(-1);
      const bars = merge(this.exchangeBars.get('BTC')?.bars ?? [], fresh);
      this.exchangeBars.set('BTC', { bars, source: 'Coinbase' });
      const after = bars.at(-1);
      if (!before || !after || before.ts !== after.ts || before.close !== after.close) this.onBars('BTC');
    } catch {
      // Yahoo's candles carry on, marked as delayed, until Coinbase answers again.
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
    const minute = Math.floor(quote.updatedAt / 60_000) * 60_000;
    const f = this.forming.get(sym);
    if (!f || f.ts !== minute) this.forming.set(sym, { ts: minute, open: quote.last, high: quote.last, low: quote.last, close: quote.last, volume: 0 });
    else this.forming.set(sym, { ...f, high: Math.max(f.high, quote.last), low: Math.min(f.low, quote.last), close: quote.last });
    this.projectXStatus(true, note ?? 'Exchange quotes streaming; ProjectX closed 1-minute candles refresh every 20s. Simulation subscription; no orders.');
  }
  setProjectXBars(sym: Symbol, fresh: Bar[], source: string) {
    const before = this.projectXBars.get(sym);
    this.projectXBars.set(sym, { bars: merge(before?.source === source ? before.bars : [], fresh), source });
    this.onBars(sym);
  }
  hasProjectXBars(sym: Symbol) { return !!this.projectXBars.get(sym)?.bars.length; }
  /** A candle closed on TradingView: it becomes the newest real price and candle for that market. */
  setTradingViewBar(sym: Symbol, bar: Bar) {
    const bars = merge(this.tvBars.get(sym) ?? [], [bar]).filter((b) => b.ts >= Date.now() - 2 * 86_400_000);
    this.tvBars.set(sym, bars);
    const cur = this.live.get(sym);
    const closedAt = Math.min(Date.now(), bar.ts + 60_000);
    const tail = bars.at(-1)!;
    // Only the newest candle moves the price, so a late or re-sent older one can't drag it back.
    if (tail.ts === bar.ts)
      this.tvQuotes.set(sym, { last: bar.close, prevClose: cur?.prevClose ?? bar.open, high: Math.max(cur?.high ?? bar.high, bar.high), low: Math.min(cur?.low ?? bar.low, bar.low), open: cur?.open ?? bar.open, updatedAt: closedAt, source: 'TradingView' });
    this.tvVersion++;
    const live = [...this.tvBars.entries()].filter(([, l]) => Date.now() - (l.at(-1)?.ts ?? 0) < 5 * 60_000).map(([k]) => k);
    this.status.set('tradingview', { id: 'tradingview', name: 'TradingView · real-time candles', ok: true, lastAt: Date.now(), note: `One-minute candles from your bar-close alerts (${live.join(', ') || sym}). Laid over Yahoo’s history; if they stop for a few minutes the desk goes back to Yahoo and says so.` });
    this.onBars(sym);
  }
  private tvCurrent(sym: Symbol) {
    const tail = this.tvBars.get(sym)?.at(-1);
    return !!tail && Date.now() - tail.ts < 4 * 60_000;
  }
  /** Yahoo's (or Coinbase's) history with TradingView's candles laid over the recent end. */
  private withTradingView(sym: Symbol, base: Bar[]): Bar[] {
    const key = `${this.tvVersion}|${base.length}|${base.at(-1)?.ts}|${base.at(-1)?.close}`;
    const hit = this.tvMerged.get(sym);
    if (hit?.key === key) return hit.bars;
    const bars = merge(base, this.tvBars.get(sym) ?? []);
    this.tvMerged.set(sym, { key, bars });
    return bars;
  }
  /** The price to show: a streamed exchange quote, else TradingView's if it's newer than Yahoo's, else Yahoo's. */
  private liveOf(sym: Symbol): Live | undefined {
    const px = this.projectXQuotes.get(sym);
    if (px) return px;
    const base = this.live.get(sym);
    const tv = this.tvQuotes.get(sym);
    return tv && Date.now() - tv.updatedAt < 150_000 && (!base || tv.updatedAt > base.updatedAt) ? tv : base;
  }

  /** Whether an exchange's own candles are current enough to use in place of Yahoo's delayed ones. */
  private exchangeCurrent(sym: Symbol) {
    const tail = this.exchangeBars.get(sym)?.bars.at(-1);
    return !!tail && Date.now() - tail.ts < 5 * 60_000;
  }
  barSource(sym: Symbol) { return this.projectXBars.get(sym)?.source ?? (this.exchangeCurrent(sym) ? this.exchangeBars.get(sym)!.source : this.tvCurrent(sym) ? 'TradingView' : 'Yahoo'); }
  clearProjectX() {
    const symbols = [...this.projectXBars.keys()];
    this.projectXBars.clear(); this.projectXQuotes.clear(); this.forming.clear(); this.projectXUp = false;
    this.status.delete('projectx-market');
    for (const sym of symbols) this.onBars(sym);
  }
  private selectedBars(sym: Symbol): Bar[] {
    const px = this.projectXBars.get(sym)?.bars;
    if (px) return px;
    if (this.exchangeCurrent(sym)) return this.exchangeBars.get(sym)!.bars;
    const base = this.bars.get(sym) ?? [];
    return this.tvCurrent(sym) ? this.withTradingView(sym, base) : base;
  }

  /** The minute bars for a market, with the forming minute closed on the live price. */
  barsOf(sym: Symbol): Bar[] {
    const bars = this.selectedBars(sym);
    const live = this.liveOf(sym);
    if (!bars.length || !live) return bars;
    const tail = bars[bars.length - 1]!;
    const minute = Math.floor(Date.now() / 60_000) * 60_000;
    // Streamed quotes but candles that only arrive once closed: the minute in progress is drawn from the ticks.
    const f = this.forming.get(sym);
    if (f && this.projectXBars.has(sym) && f.ts === minute && f.ts > tail.ts) return [...bars, f];
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
      const live = this.liveOf(sym);
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
        stale: (this.projectXQuotes.has(sym) && !this.projectXUp) || Date.now() - updatedAt > (sym === 'BTC' || live?.source.startsWith('ProjectX') ? 120_000 : live?.source === 'TradingView' ? 150_000 : 15 * 60_000),
      });
    }
    return out;
  }

  contextQuotes(): ContextQuote[] {
    return CONTEXT.map((c) => this.context.get(c.id)).filter((x): x is ContextQuote => !!x);
  }

  feeds(): FeedStatus[] {
    // TradingView only talks when an alert fires: quiet for five minutes reads as down.
    return [...this.status.values()].map((s) => ({ ...s, ok: s.id === 'tradingview' ? Date.now() - (s.lastAt ?? 0) < 5 * 60_000 : s.ok }));
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
