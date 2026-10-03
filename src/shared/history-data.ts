import type { Bar } from './trading.js';

export const FUTURES = ['NQ', 'ES', 'GC'] as const;
export type FuturesSymbol = (typeof FUTURES)[number];
export const MAX_CSV_BYTES = 64 * 1024 * 1024;
export interface HistoryDataset {
  id: string; symbol: FuturesSymbol; contract: string; name: string; source: string;
  importedAt: number; bars: number; first: number; last: number; duplicates: number;
  gaps: number; warnings: string[];
}
export interface HistoryView {
  datasets: HistoryDataset[];
  selected: Partial<Record<FuturesSymbol, string>>;
  cached: { symbol: FuturesSymbol; bars: number; first: number | null; last: number | null }[];
}

/** RFC 4180 quoting, including indicator columns containing commas and quoted newlines. */
function csvRows(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let field = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else if (quoted || !field) quoted = !quoted;
      else throw new Error('Unexpected quote in CSV');
    } else if (!quoted && (c === ',' || c === '\n')) {
      row.push(field.replace(/\r$/, '')); field = '';
      if (c === '\n') { if (row.some(x => x.trim())) rows.push(row); row = []; }
    } else field += c;
  }
  if (quoted) throw new Error('Unclosed quote in CSV');
  row.push(field.replace(/\r$/, '')); if (row.some(x => x.trim())) rows.push(row);
  return rows;
}

/** UTC epoch seconds/milliseconds, or ISO dates with an explicit timezone; never guess local time. */
function timestamp(raw: string): number {
  const s = raw.trim();
  if (/^\d+(\.\d+)?$/.test(s)) { const n = Number(s); return n < 1e11 ? n * 1000 : n; }
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) throw new Error('Timestamps need UTC epoch seconds or an explicit timezone, such as 2026-09-01T13:30:00Z');
  return Date.parse(s);
}

/** Chart exports are data, never executable code. Invalid rows reject the entire import. */
export function parseHistoryCsv(text: string, now = Date.now()): { bars: Bar[]; duplicates: number; gaps: number; warnings: string[] } {
  if (text.length > MAX_CSV_BYTES) throw new Error('CSV exceeds 64 MB; export smaller date ranges');
  const rows = csvRows(text.replace(/^\uFEFF/, ''));
  const header = rows.shift()?.map(x => x.trim().toLowerCase()) ?? [];
  const columns = ['time', 'open', 'high', 'low', 'close', 'volume'].map(k => header.indexOf(k === 'time' && !header.includes(k) ? 'timestamp' : k));
  if (columns.some(i => i < 0)) throw new Error('CSV needs time (or timestamp), open, high, low, close and volume columns. Export a standard 1-minute candle chart.');
  if (rows.length > 500_000) throw new Error('At most 500,000 rows per export');
  const map = new Map<number, Bar>(); let duplicates = 0;
  for (const [index, row] of rows.entries()) {
    try {
      const [time, ...values] = columns.map(i => row[i]?.trim() ?? '');
      if (!time || values.some(x => !x)) throw new Error('missing time, price or volume');
      const ts = timestamp(time); const [open, high, low, close, vol] = values.map(Number);
      if (![ts, open, high, low, close, vol].every(Number.isFinite) || ts < Date.UTC(2000, 0, 1) || ts > now || ts % 60_000 !== 0) throw new Error('invalid or future timestamp; bars must align to a minute');
      if (Math.min(open!, high!, low!, close!) <= 0 || vol! < 0 || high! < Math.max(open!, close!, low!) || low! > Math.min(open!, close!, high!)) throw new Error('invalid OHLC or volume');
      const bar = { ts, open: open!, high: high!, low: low!, close: close!, volume: vol! };
      const previous = map.get(ts);
      if (previous && JSON.stringify(previous) !== JSON.stringify(bar)) throw new Error('conflicting duplicate candle');
      if (previous) duplicates++; else map.set(ts, bar);
    } catch (error) { throw new Error(`Row ${index + 2}: ${error instanceof Error ? error.message : 'invalid candle'}`); }
  }
  const bars = [...map.values()].sort((a, b) => a.ts - b.ts);
  if (bars.length < 2) throw new Error('At least two candles are required');
  let oneMinute = false; let gaps = 0;
  for (let i = 1; i < bars.length; i++) {
    const delta = bars[i]!.ts - bars[i - 1]!.ts;
    if (delta === 60_000) oneMinute = true;
    if (delta > 60_000 && delta < 60 * 60_000) gaps++;
  }
  if (!oneMinute) throw new Error('This is not a 1-minute export. Five-minute or daily bars cannot run the minute replay.');
  return { bars, duplicates, gaps, warnings: [
    ...(gaps ? [`${gaps} intraday gaps under one hour. Missing minutes are never invented.`] : []),
    ...(bars.every(b => b.volume === 0) ? ['Volume is zero throughout; volume-based signals cannot be judged.'] : []),
    'An imported chart is historical research data. It does not replace the live feed.',
  ] };
}
