import type {
  AccountInfo, Bar, ConnectorInfo, Levels, NewsItem, PlaybookItem, Proposal, ProposalAction, ProposalStage, Quote, SessionInfo, Ticket, TradingSnapshot,
} from '../shared/trading.js';
import { SYMBOLS, type Symbol } from '../shared/trading.js';

// The market desk. Prices are a deterministic simulation (the same bars for the same minute, on every
// machine) until a real feed is wired in: everything downstream reads this one module, so a live adapter
// replaces `barsFor` and nothing else. The snapshot says `source: 'sample'` so no screen pretends otherwise.
// Nothing here can place an order: the desk produces proposals and tickets for a person to act on.

interface Spec { name: string; tick: number; pointValue: number; decimals: number; base: number; vol: number; ink: string; maxContracts: number }
const SPECS: Record<Symbol, Spec> = {
  MNQ: { name: 'Micro E-mini Nasdaq-100', tick: 0.25, pointValue: 2, decimals: 2, base: 24_850, vol: 0.00085, ink: '#7DF9FF', maxContracts: 3 },
  MES: { name: 'Micro E-mini S&P 500', tick: 0.25, pointValue: 5, decimals: 2, base: 6_810, vol: 0.00055, ink: '#A0E7A0', maxContracts: 3 },
  MBT: { name: 'Micro Bitcoin Futures', tick: 5, pointValue: 0.1, decimals: 0, base: 96_400, vol: 0.0018, ink: '#FFB86C', maxContracts: 2 },
  BTC: { name: 'Bitcoin Spot', tick: 0.01, pointValue: 1, decimals: 2, base: 96_310, vol: 0.0019, ink: '#FF79C6', maxContracts: 1 },
};

/** The prop-firm account the desk sizes against (an evaluation-style practice account). */
const ACCOUNT = { name: 'EVAL-50K', dailyLossLimit: 1000, trailingDrawdown: 2000, riskPerTrade: 150 };

const TZ = 'America/Los_Angeles';
const clock = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function pacific(ts: number) {
  const p = Object.fromEntries(clock.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  const weekday = new Date(`${p.year}-${p.month}-${p.day}T12:00:00Z`).getUTCDay();
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: +p.hour! * 60 + +p.minute!, seconds: +p.hour! * 3600 + +p.minute! * 60 + +p.second!, time: `${p.hour}:${p.minute}`, weekend: weekday === 0 || weekday === 6 };
}

/** Quiet overnight, a real expansion into the 06:30 open, a lunch lull. Hour is Pacific. */
function energy(hour: number): number {
  if (hour >= 6.5 && hour < 8) return 1.9;
  if (hour >= 5.5 && hour < 6.5) return 1.4;
  if (hour >= 8 && hour < 10) return 1;
  if (hour >= 10 && hour < 12) return 0.6;
  if (hour >= 12 && hour < 13) return 1.1;
  return 0.45;
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash = (s: string) => {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
};
const roundTo = (v: number, step: number) => Math.round(v / step) * step;

const cache = new Map<string, Bar[]>();
/** `count` one-minute bars ending at the minute `end` falls in. Same day and symbol give the same walk. */
function barsFor(symbol: Symbol, count: number, end: number): Bar[] {
  const endMin = Math.floor(end / 60_000) * 60_000;
  const key = `${symbol}:${count}:${endMin}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const spec = SPECS[symbol];
  const r = rng(hash(`${pacific(end).date}:${symbol}`));
  let price = spec.base * (1 + (r() - 0.5) * 0.012);
  let drift = (r() - 0.5) * 0.4;
  const out: Bar[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const ts = endMin - i * 60_000;
    const e = energy(pacific(ts).minutes / 60);
    const open = price;
    let high = open;
    let low = open;
    for (let k = 0; k < 8; k++) {
      const g = (r() + r() + r() - 1.5) / 1.5;
      price = Math.max(spec.tick, price + price * spec.vol * e * (g + drift * 0.15) * 0.45);
      high = Math.max(high, price);
      low = Math.min(low, price);
    }
    if (r() < 0.03) drift = (r() - 0.5) * 0.9;
    out.push({ ts, open: roundTo(open, spec.tick), high: roundTo(high, spec.tick), low: roundTo(low, spec.tick), close: roundTo(price, spec.tick), volume: Math.round(300 * e * (0.6 + r())) });
  }
  if (cache.size > 64) cache.clear();
  cache.set(key, out);
  return out;
}

/** The tape between the minute bars: the last bar's close plus a small seeded wiggle by the second. */
function livePrice(symbol: Symbol, bars: Bar[], now: number): number {
  const spec = SPECS[symbol];
  const last = bars[bars.length - 1]!;
  const s = Math.floor(now / 1000);
  const wiggle = (rng(hash(`${symbol}:${s}`))() - 0.5) * 2;
  return roundTo(last.close + wiggle * spec.tick * 3, spec.tick);
}

function levelsFor(symbol: Symbol, bars: Bar[], now: number): Levels {
  const spec = SPECS[symbol];
  const today = pacific(now).date;
  const q = (v: number) => roundTo(v, spec.tick);
  const session = bars.filter((b) => pacific(b.ts).date === today);
  let pv = 0;
  let vol = 0;
  let pv2 = 0;
  for (const b of session) {
    const typical = (b.high + b.low + b.close) / 3;
    pv += typical * b.volume;
    vol += b.volume;
    pv2 += typical * typical * b.volume;
  }
  const vwap = vol ? pv / vol : bars[bars.length - 1]!.close;
  const sd = vol ? Math.sqrt(Math.max(0, pv2 / vol - vwap * vwap)) : 0;
  const orBars = session.filter((b) => { const m = pacific(b.ts).minutes; return m >= 390 && m < 405; });
  const overnight = session.filter((b) => pacific(b.ts).minutes < 390);
  const priorDate = bars.map((b) => pacific(b.ts).date).filter((d) => d < today).at(-1);
  const prior = bars.filter((b) => pacific(b.ts).date === priorDate);
  const ext = (rows: Bar[], key: 'high' | 'low', fn: (...v: number[]) => number) => (rows.length ? q(fn(...rows.map((b) => b[key]))) : null);
  return {
    vwap: q(vwap), vwapU1: q(vwap + sd), vwapL1: q(vwap - sd), vwapU2: q(vwap + 2 * sd), vwapL2: q(vwap - 2 * sd),
    orHigh: ext(orBars, 'high', Math.max), orLow: ext(orBars, 'low', Math.min),
    onHigh: ext(overnight, 'high', Math.max), onLow: ext(overnight, 'low', Math.min),
    priorHigh: ext(prior, 'high', Math.max), priorLow: ext(prior, 'low', Math.min),
  };
}

function session(now: number): SessionInfo {
  const p = pacific(now);
  const m = p.minutes;
  const phase: SessionInfo['phase'] = p.weekend ? 'closed' : m < 390 ? 'premarket' : m < 420 ? 'ORB' : m < 540 ? 'open' : m < 780 ? 'post' : 'closed';
  // The bells: 06:30 PT opens the cash session, 13:00 PT closes it.
  const open = 390 * 60;
  const close = 780 * 60;
  const day = 86400;
  const kind = p.seconds < open ? 'open' : p.seconds < close ? 'close' : 'open';
  const target = kind === 'open' ? (p.seconds < open ? open : open + day) : close;
  return { time: p.time, minutes: m, phase, weekend: p.weekend, nextBell: { kind, inSeconds: Math.max(0, target - p.seconds) } };
}

// ---- The morning's news (sample) ------------------------------------------------------------------
const NEWS: Omit<NewsItem, 'id' | 'time'>[] = [
  { at: 5 * 60 + 30, headline: 'CPI (m/m) — consensus 0.3%', impact: 'high', symbols: ['MNQ', 'MES'], kind: 'calendar' },
  { at: 6 * 60, headline: 'Futures firm ahead of the open; tech leads pre-market', impact: 'med', symbols: ['MNQ', 'MES'], kind: 'headline' },
  { at: 6 * 60 + 15, headline: 'BTC holds overnight range as ETF flows turn positive', impact: 'med', symbols: ['MBT', 'BTC'], kind: 'headline' },
  { at: 7 * 60, headline: 'ISM Services PMI — consensus 52.1', impact: 'med', symbols: ['MES', 'MNQ'], kind: 'calendar' },
  { at: 7 * 60 + 30, headline: 'Treasury 10y yield ticks lower into the data', impact: 'low', symbols: ['MES'], kind: 'headline' },
  { at: 8 * 60, headline: 'Fed speaker crosses the wires — watch for tone on cuts', impact: 'high', symbols: ['MNQ', 'MES', 'MBT'], kind: 'calendar' },
  { at: 10 * 60 + 30, headline: 'Crude inventories — consensus -1.2M', impact: 'low', symbols: ['MES'], kind: 'calendar' },
  { at: 11 * 60, headline: 'Two-year note auction, 11:00 PT', impact: 'med', symbols: ['MES', 'MNQ'], kind: 'calendar' },
  { at: 12 * 60 + 30, headline: 'Closing imbalance: buyers lean in on the S&P', impact: 'low', symbols: ['MES'], kind: 'headline' },
];
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const news = (): NewsItem[] => NEWS.map((n, i) => ({ ...n, id: `n${i}`, time: hhmm(n.at) }));

// ---- The playbook (per day, in memory) ------------------------------------------------------------
const PLAYBOOK: { id: string; label: string; owner: string }[] = [
  { id: 'brief', label: 'Read the 06:00 tape brief', owner: 'Scout' },
  { id: 'levels', label: 'Mark VWAP, OR and prior-day levels', owner: 'Vex' },
  { id: 'sr', label: 'Mark support & resistance that held', owner: 'Ledge' },
  { id: 'news', label: 'No high-impact news inside 15 minutes', owner: 'Scout' },
  { id: 'size', label: 'Size the day: risk per trade and daily stop', owner: 'Bulwark' },
  { id: 'plan', label: 'Write the plan: bias, trigger, invalidation', owner: 'Marshal' },
];
const state = { date: '', done: new Set<string>(), stages: new Map<string, ProposalStage>() };
function rollDay(date: string) {
  if (state.date !== date) {
    state.date = date;
    state.done.clear();
    state.stages.clear();
  }
}

// ---- Proposals: VWAP and support/resistance, read off the levels -----------------------------------
function proposalsFor(quotes: Quote[], levels: Record<Symbol, Levels>): Proposal[] {
  const out: Proposal[] = [];
  for (const q of quotes) {
    const lv = levels[q.symbol];
    const { tick } = SPECS[q.symbol];
    const rr = (side: 'long' | 'short', entry: number, stop: number, target: number) => {
      const risk = Math.abs(entry - stop);
      return risk > 0 ? Math.round((Math.abs(target - entry) / risk) * 10) / 10 : 0;
    };
    const stageFor = (id: string, entry: number, stop: number): ProposalStage => {
      const chosen = state.stages.get(id);
      if (chosen) return chosen;
      return Math.abs(q.last - entry) <= Math.abs(entry - stop) * 0.35 ? 'ready' : 'watching';
    };
    // VWAP: above it, buy the pullback to VWAP into the upper band; below it, fade the rally into VWAP.
    const long = q.last >= lv.vwap;
    const vEntry = lv.vwap;
    const vStop = long ? lv.vwapL1 : lv.vwapU1;
    const vTarget = long ? lv.vwapU2 : lv.vwapL2;
    if (Math.abs(vEntry - vStop) >= tick * 2) {
      const id = `${q.symbol}-vwap-${long ? 'L' : 'S'}`;
      out.push({ id, symbol: q.symbol, strategy: 'VWAP', agent: 'Vex', side: long ? 'long' : 'short', title: long ? 'Pullback to VWAP, buy' : 'Rally into VWAP, fade', entry: vEntry, stop: vStop, target: vTarget, r: rr(long ? 'long' : 'short', vEntry, vStop, vTarget), stage: stageFor(id, vEntry, vStop) });
    }
    // Support / resistance: the nearest held level under (or over) the tape.
    const supports = [lv.priorLow, lv.onLow, lv.orLow].filter((v): v is number => v != null && v < q.last);
    const resists = [lv.priorHigh, lv.onHigh, lv.orHigh].filter((v): v is number => v != null && v > q.last);
    const support = supports.length ? Math.max(...supports) : null;
    const resist = resists.length ? Math.min(...resists) : null;
    const wantLong = support != null && (resist == null || q.last - support <= resist - q.last);
    const level = wantLong ? support : resist;
    if (level != null) {
      const stop = wantLong ? level - Math.max(tick * 4, (lv.vwapU1 - lv.vwapL1) * 0.25) : level + Math.max(tick * 4, (lv.vwapU1 - lv.vwapL1) * 0.25);
      // Aim for VWAP when it's on the right side of the level; otherwise two risks out the right way.
      const risk = Math.abs(level - stop);
      const target = wantLong ? (lv.vwap > level ? lv.vwap : level + 2 * risk) : lv.vwap < level ? lv.vwap : level - 2 * risk;
      {
        const id = `${q.symbol}-sr-${wantLong ? 'L' : 'S'}`;
        out.push({ id, symbol: q.symbol, strategy: 'S/R', agent: 'Ledge', side: wantLong ? 'long' : 'short', title: wantLong ? 'Support holds, bounce' : 'Resistance caps, fade', entry: roundTo(level, tick), stop: roundTo(stop, tick), target: roundTo(target, tick), r: rr(wantLong ? 'long' : 'short', level, stop, target), stage: stageFor(id, level, stop) });
      }
    }
  }
  return out;
}

// ---- Bulwark's read on a graduated setup ---------------------------------------------------------
function ticketFor(p: Proposal, account: AccountInfo, sess: SessionInfo, riskyNews: boolean): Ticket {
  const spec = SPECS[p.symbol];
  const riskPoints = Math.abs(p.entry - p.stop);
  const perContract = riskPoints * spec.pointValue;
  const fit = perContract > 0 ? Math.floor(ACCOUNT.riskPerTrade / perContract) : 0;
  const contracts = Math.max(0, Math.min(spec.maxContracts, fit));
  const checks = [
    { label: `Risk per trade ≤ $${ACCOUNT.riskPerTrade}`, ok: contracts >= 1 },
    { label: 'Within the daily loss limit', ok: account.dailyLossUsed + ACCOUNT.riskPerTrade <= account.dailyLossLimit * 0.8 },
    { label: 'Inside the trailing drawdown buffer', ok: account.trailingUsed + ACCOUNT.riskPerTrade <= account.trailingDrawdown * 0.8 },
    { label: 'In the 07:00–09:00 window', ok: sess.phase === 'open' },
    { label: 'Reward at least 1.5R', ok: p.r >= 1.5 },
    { label: 'No high-impact news inside 15 minutes', ok: !riskyNews },
    { label: 'Proved on the Pit (paper) first', ok: p.stage === 'graduated' },
  ];
  return {
    proposalId: p.id, symbol: p.symbol, side: p.side, contracts, entry: p.entry, stop: p.stop, target: p.target,
    riskDollars: Math.round(contracts * perContract), rewardDollars: Math.round(contracts * Math.abs(p.target - p.entry) * spec.pointValue),
    checks, cleared: checks.every((c) => c.ok),
  };
}

// ---- Public ---------------------------------------------------------------------------------------
export function snapshot(now = Date.now()): TradingSnapshot {
  const p = pacific(now);
  rollDay(p.date);
  const quotes: Quote[] = [];
  const levels = {} as Record<Symbol, Levels>;
  const bars = {} as Record<Symbol, Bar[]>;
  for (const sym of SYMBOLS) {
    const spec = SPECS[sym];
    const series = barsFor(sym, 2880, now);
    const last = livePrice(sym, series, now);
    // The live bar closes on the live price, so a chart's last candle and the ticker agree.
    const tail = series[series.length - 1]!;
    const live: Bar = { ...tail, close: last, high: Math.max(tail.high, last), low: Math.min(tail.low, last) };
    const shown = [...series.slice(-120, -1), live];
    bars[sym] = shown;
    levels[sym] = levelsFor(sym, [...series.slice(0, -1), live], now);
    const day = series.filter((b) => pacific(b.ts).date === p.date);
    const open = day[0]?.open ?? series[0]!.open;
    const prior = series.filter((b) => pacific(b.ts).date < p.date).at(-1)?.close ?? open;
    const high = Math.max(...day.map((b) => b.high), last);
    const low = Math.min(...day.map((b) => b.low), last);
    quotes.push({
      symbol: sym, name: spec.name, ink: spec.ink, decimals: spec.decimals, tick: spec.tick, last, bid: roundTo(last - spec.tick, spec.tick), ask: roundTo(last + spec.tick, spec.tick),
      open, high, low, prevClose: prior, change: last - prior, changePct: ((last - prior) / prior) * 100,
    });
  }
  const sess = session(now);
  const account: AccountInfo = { name: ACCOUNT.name, dailyLossLimit: ACCOUNT.dailyLossLimit, dailyLossUsed: 0, trailingDrawdown: ACCOUNT.trailingDrawdown, trailingUsed: 0, paperPnl: 0, armed: sess.phase === 'open' };
  const proposals = proposalsFor(quotes, levels);
  const nowMin = p.minutes;
  const riskyNews = news().some((n) => n.impact === 'high' && Math.abs(n.at - nowMin) <= 15);
  const tickets = proposals.filter((x) => x.stage === 'graduated').map((x) => ticketFor(x, account, sess, riskyNews));
  const playbook: PlaybookItem[] = PLAYBOOK.map((x) => ({ ...x, done: state.done.has(x.id) }));
  const connectors: ConnectorInfo[] = [
    { id: 'market', name: 'Market Data', status: 'sample', note: 'Simulated tape until a live feed is wired in' },
    { id: 'tradingview', name: 'TradingView', status: 'stub', note: 'Chart links and alerts — connect the MCP server to go live' },
    { id: 'runner', name: 'Script Runner', status: 'off', note: 'Backtests run from the Trading Office project' },
    { id: 'brain', name: 'Brain Notes', status: 'off', note: 'Notes and lessons from the Trading Office project' },
    { id: 'clock', name: 'Session Clock', status: 'live', note: 'Pacific time; bells at 06:30 and 13:00' },
    { id: 'broker', name: 'Broker (live)', status: 'locked', note: 'Never connected. The office produces tickets; you place the order.' },
  ];
  return { at: now, source: 'sample', quotes, levels, bars, news: news(), proposals, tickets, playbook, connectors, session: sess, account };
}

/** Ticks a playbook item on or off. */
export function togglePlaybook(id: string): boolean {
  if (!PLAYBOOK.some((x) => x.id === id)) return false;
  rollDay(pacific(Date.now()).date);
  if (state.done.has(id)) state.done.delete(id);
  else state.done.add(id);
  return true;
}

/**
 * Moves a proposal along: taken on the paper floor, graduated to the desk, skipped, or put back. Graduation
 * only follows a paper fill, so nothing reaches The Desk without being proved first.
 */
export function actOnProposal(id: string, action: ProposalAction): string | undefined {
  rollDay(pacific(Date.now()).date);
  if (!/^[A-Z]{3}-(vwap|sr)-[LS]$/.test(id)) return 'No such proposal';
  const now = state.stages.get(id);
  if (action === 'reset') state.stages.delete(id);
  else if (action === 'skip') state.stages.set(id, 'skipped');
  else if (action === 'paper') state.stages.set(id, 'paper');
  else if (action === 'graduate') {
    if (now !== 'paper') return 'Take it on paper first';
    state.stages.set(id, 'graduated');
  } else return 'Unknown action';
  return undefined;
}
