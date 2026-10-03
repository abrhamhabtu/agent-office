import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FUTURES, type FuturesSymbol } from '../../shared/history-data.js';
import type { PaperTrade } from '../../shared/trading.js';
import { holdoutFinding, RESEARCH_PLAYBOOKS, researchFindings, type ResearchReport, type ResearchStatus } from '../../shared/strategy-research.js';
import { byTradingDay, replayDay, tradingDay } from './engine.js';
import type { Market } from './market.js';

interface SavedRun { report: ResearchReport; trades: PaperTrade[] }
export class ResearchWorkbench {
  private state: ResearchStatus = { busy: false, stage: 'Ready to research', error: null, report: null };
  private reserved: Record<string, { run: string; playbook: string; at: number }> = {};
  constructor(private dir: string, private market: Pick<Market, 'history' | 'historyView'>) {
    mkdirSync(dir, { recursive: true });
    try { this.reserved = JSON.parse(readFileSync(path.join(dir, 'holdout.json'), 'utf8')); } catch { /* No openings. */ }
    try { this.state.report = JSON.parse(readFileSync(path.join(dir, 'latest.json'), 'utf8')); } catch { /* No research. */ }
  }
  status(): ResearchStatus { return structuredClone(this.state); }
  private write(file: string, value: unknown) {
    writeFileSync(path.join(this.dir, `${file}.tmp`), JSON.stringify(value), { mode: 0o600 });
    renameSync(path.join(this.dir, `${file}.tmp`), path.join(this.dir, file));
  }
  start(raw: Record<string, unknown>) {
    if (this.state.busy) throw new Error('Research is already running');
    const markets = FUTURES.filter(s => Array.isArray(raw.markets) && raw.markets.includes(s));
    if (!markets.length) throw new Error('Select at least one futures market');
    const cap = Number(raw.cap ?? 5);
    if (![1, 3, 5, 10].includes(cap)) throw new Error('Choose a cap of 1, 3, 5 or 10 micros');
    this.state.busy = true; this.state.error = null; this.state.stage = 'Loading actual futures candles';
    void this.run(markets, cap).catch(e => { this.state.error = e instanceof Error ? e.message : 'Research failed'; this.state.stage = 'Research failed; previous report kept'; })
      .finally(() => { this.state.busy = false; });
  }
  private async run(markets: FuturesSymbol[], cap: number) {
    const sources: ResearchReport['sources'] = []; const hash = createHash('sha256');
    const daysByMarket = new Map<FuturesSymbol, ReturnType<typeof byTradingDay>>();
    const usableByMarket = new Map<FuturesSymbol, Set<string>>();
    const view = this.market.historyView(); const today = tradingDay(Date.now());
    for (const symbol of markets) {
      this.state.stage = `Loading ${symbol} history`;
      const bars = await this.market.history(symbol);
      if (!bars.length) throw new Error(`No ${symbol} candles available. Import a one-minute chart CSV or restore the data connection.`);
      const selected = view.datasets.find(d => d.id === view.selected[symbol]);
      sources.push({ symbol, label: selected ? `${selected.source} · ${selected.contract} · ${selected.name}` : 'Yahoo · delayed futures history', bars: bars.length, first: bars[0]!.ts, last: bars.at(-1)!.ts });
      const byDay = byTradingDay(bars); const entries = [...byDay]; daysByMarket.set(symbol, byDay);
      // Require a preceding session for context; do not run across a missing multi-day hole.
      usableByMarket.set(symbol, new Set(entries.filter(([day, b], i) => i > 0 && day < today && b.length >= 300 && Date.parse(day) - Date.parse(entries[i - 1]![0]) <= 4 * 86_400_000).map(([d]) => d)));
    }
    const days = [...usableByMarket.get(markets[0]!)!].filter(day => markets.every(s => usableByMarket.get(s)!.has(day))).sort();
    if (days.length < 12) throw new Error(`Only ${days.length} complete overlapping sessions across ${markets.join(', ')}. At least 12 are required; use matching date ranges or research one market first.`);
    const trades: PaperTrade[] = [];
    for (const symbol of markets) {
      const entries = [...daysByMarket.get(symbol)!]; const selected = new Set(days);
      for (let i = 1; i < entries.length; i++) {
        const [day, bars] = entries[i]!; if (!selected.has(day)) continue;
        // Hash only the complete sessions actually replayed and their preceding context. A forming
        // candle or unused date must not create a fresh holdout identity every time the feed ticks.
        hash.update(JSON.stringify([symbol, day, bars, entries[i - 1]]));
        this.state.stage = `Replaying ${symbol} · ${day}`;
        trades.push(...replayDay(symbol, bars, entries[i - 1]![1], { only: RESEARCH_PLAYBOOKS }).trades);
        // Long imported histories yield between sessions so the office and its HTTP routes stay responsive.
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    }
    trades.sort((a, b) => a.entryAt - b.entryAt || a.id.localeCompare(b.id));
    if (!trades.length) throw new Error('No closed setups on these sessions. The engine will not invent trades.');
    this.state.stage = 'Comparing training candidates, validation costs and prop accounts';
    const dataset = hash.digest('hex');
    const id = createHash('sha256').update(JSON.stringify([dataset, markets, cap, sources.map(s => [s.symbol, s.label]), 'filters-v2'])).digest('hex');
    // Same settings and raw candles return the frozen report; rerunning cannot reset a reserved quarter.
    let saved: SavedRun | null = null;
    try { saved = JSON.parse(readFileSync(path.join(this.dir, `${id}.json`), 'utf8')); } catch { /* New experiment. */ }
    const report = saved?.report ?? { id, createdAt: Date.now(), dataset, markets, days, cap, sources,
      findings: researchFindings(trades, days, cap), holdout: null,
      notes: [
        'Built-in strategy rules, realistic stop-first exits, adverse gap fills; entries at the signal close. Costs are assumptions, not broker execution measurements.',
        'Half the sessions select one fixed filter per playbook; the next quarter judges it. The last quarter is reserved within this workbench, not quarantined from the office’s other tools.',
        'Nine predefined filters per playbook. At least 20 training trades, 35% retention, positive stressed expectancy and no deeper training drawdown are required before choosing one.',
        'Prop accounts replay only the validation quarter in time order: up to the selected micro cap, 10% of remaining cushion per entry, 20% per day, and stop after three losses. No rebuying or projected pass probability.',
        'Only dates with at least 300 candles and prior-session context in every selected market count. Missing minutes are not filled. Continuous-contract rolls and sparse sessions need review.',
      ] };
    const opened = this.reserved[dataset];
    if (opened && !report.holdout) report.notes.push(`This dataset’s reserved quarter was already opened for ${opened.playbook}. It cannot be opened again under new settings.`);
    this.write(`${id}.json`, saved ?? { report, trades }); this.write('latest.json', report);
    this.state.report = report; this.state.stage = `Finished · ${days.length} common sessions · ${trades.length} setups`;
  }
  openHoldout(raw: Record<string, unknown>) {
    if (this.state.busy) throw new Error('Wait until research finishes');
    const report = this.state.report;
    if (!report || raw.id !== report.id) throw new Error('The experiment changed; refresh before opening its reserved quarter');
    if (report.holdout) return this.status();
    if (this.reserved[report.dataset]) throw new Error('This dataset’s reserved quarter has already been opened. New sizing does not make it unseen again.');
    const finding = report.findings.find(f => f.playbook === raw.playbook);
    if (!finding?.filter || finding.report.verdict !== 'promising') throw new Error('Only a candidate that cleared validation can open the reserved quarter');
    const saved = JSON.parse(readFileSync(path.join(this.dir, `${report.id}.json`), 'utf8')) as SavedRun;
    const next = holdoutFinding(finding, saved.trades, report.days); const at = Date.now();
    this.reserved[report.dataset] = { run: report.id, playbook: finding.playbook, at };
    this.write('holdout.json', this.reserved);
    finding.report = next; report.holdout = { playbook: finding.playbook, openedAt: at };
    this.write(`${report.id}.json`, { report, trades: saved.trades }); this.write('latest.json', report);
    return this.status();
  }
}
