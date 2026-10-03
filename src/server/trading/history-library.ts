import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import type { Bar } from '../../shared/trading.js';
import { FUTURES, parseHistoryCsv, type FuturesSymbol, type HistoryDataset, type HistoryView } from '../../shared/history-data.js';

/** Immutable chart exports; selection is separate from the live quotes and from Yahoo's cache. */
export class HistoryLibrary {
  private manifest: Pick<HistoryView, 'datasets' | 'selected'> = { datasets: [], selected: {} };
  constructor(private dir: string) {
    try {
      const saved = JSON.parse(readFileSync(path.join(dir, 'index.json'), 'utf8'));
      if (Array.isArray(saved.datasets) && saved.selected) this.manifest = saved;
    } catch { /* First run. */ }
  }
  private save() {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(path.join(this.dir, 'index.json.tmp'), JSON.stringify(this.manifest), { mode: 0o600 });
    renameSync(path.join(this.dir, 'index.json.tmp'), path.join(this.dir, 'index.json'));
  }
  view(): Pick<HistoryView, 'datasets' | 'selected'> {
    return structuredClone(this.manifest);
  }
  import(raw: Record<string, unknown>): HistoryDataset {
    const symbol = raw.symbol as FuturesSymbol;
    if (!FUTURES.includes(symbol)) throw new Error('Choose NQ, ES or GC');
    const contract = typeof raw.contract === 'string' ? raw.contract.trim().toUpperCase() : '';
    // Distinguish minis, micros and continuous contracts. Never mix series just because their roots match.
    if (!new RegExp(`^(?:[A-Z]+:)?M?${symbol}(?:[12]!|[FGHJKMNQUVXZ]\\d{1,4})$`).test(contract)) throw new Error(`Name the actual chart, such as ${symbol}1! or ${symbol}Z2026`);
    if (typeof raw.csv !== 'string') throw new Error('Choose a chart CSV');
    const parsed = parseHistoryCsv(raw.csv);
    const id = createHash('sha256').update(JSON.stringify([symbol, contract, parsed.bars])).digest('hex');
    const existing = this.manifest.datasets.find(d => d.id === id);
    if (existing) return existing;
    const d: HistoryDataset = { id, symbol, contract, name: typeof raw.name === 'string' ? raw.name.trim().slice(0, 100) || contract : contract,
      source: 'Chart CSV', importedAt: Date.now(), bars: parsed.bars.length, first: parsed.bars[0]!.ts, last: parsed.bars.at(-1)!.ts,
      duplicates: parsed.duplicates, gaps: parsed.gaps, warnings: [...parsed.warnings, ...(contract.includes('!') ? ['Continuous futures can contain roll adjustments. Compare with an unadjusted individual contract before forward testing.'] : [])] };
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(path.join(this.dir, `${id}.json`), JSON.stringify(parsed.bars), { mode: 0o600 });
    this.manifest.datasets.push(d); this.save();
    return d;
  }
  select(symbol: FuturesSymbol, id: string | null) {
    if (!FUTURES.includes(symbol)) throw new Error('Unknown market');
    if (id !== null && !this.manifest.datasets.some(d => d.id === id && d.symbol === symbol)) throw new Error('Dataset does not belong to this market');
    if (id === null) delete this.manifest.selected[symbol]; else this.manifest.selected[symbol] = id;
    this.save();
  }
  selected(symbol: string): Bar[] | null {
    const id = this.manifest.selected[symbol as FuturesSymbol];
    if (!id) return null;
    // A missing selected file is an error, never a silent fallback onto another provider's prices.
    return JSON.parse(readFileSync(path.join(this.dir, `${id}.json`), 'utf8')) as Bar[];
  }
}
