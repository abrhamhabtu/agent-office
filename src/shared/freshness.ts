import type { Quote } from './trading.js';

const clock = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
export function marketTime(at: number | null | undefined): string {
  return at && Number.isFinite(at) && at > 0 ? `${clock.format(at)} PT` : 'unknown';
}

/** Quote time comes from the source, never the browser's refresh time. Bars have their own age. */
export function dataFreshness(q: Quote | undefined, now: number, barAt?: number | null, barSource = q?.barSource ?? 'Yahoo') {
  const valid = (at: number | null | undefined) => !!at && Number.isFinite(at) && at > 0 && at <= now + 60_000;
  const delayed = !!q?.source.includes('Yahoo');
  const limit = q?.source.startsWith('ProjectX') || q?.symbol === 'BTC' && !delayed ? 120_000 : q?.source === 'TradingView' ? 150_000 : 15 * 60_000;
  const delayedBars = barSource.includes('Yahoo');
  const oldQuote = q && valid(q.updatedAt) && (q.stale || now - q.updatedAt > limit);
  const oldBars = barAt !== undefined && valid(barAt) && now - barAt! > (delayedBars ? 15 * 60_000 : 3 * 60_000);
  const unknown = !q || !valid(q.updatedAt) || (barAt !== undefined && !valid(barAt));
  const quoteStatus = !q ? 'NO DATA' : oldQuote ? 'STALE' : !valid(q.updatedAt) ? 'TIMESTAMP UNKNOWN' : delayed ? 'DELAYED' : 'CURRENT';
  const barStatus = oldBars ? 'STALE' : !valid(barAt) ? 'TIMESTAMP UNKNOWN' : delayedBars ? 'DELAYED' : 'CURRENT';
  const status = !q ? 'NO DATA' : oldQuote || oldBars ? 'STALE' : unknown ? 'TIMESTAMP UNKNOWN' : delayed ? 'DELAYED' : barAt !== undefined && delayedBars ? 'DELAYED BARS' : 'CURRENT';
  return {
    status,
    quoteStatus,
    barStatus,
    barSource,
    tone: status === 'CURRENT' ? 'ok' : status === 'STALE' || status === 'NO DATA' ? 'stop' : 'warn',
    source: q?.source ?? 'No quote source',
    detail: `${q?.source ?? 'No quote source'} · ${status} · Quote ${marketTime(q?.updatedAt)} (${quoteStatus})${barAt !== undefined ? ` · ${barSource} bars ${marketTime(barAt)} (${barStatus})` : ''}`,
  };
}
