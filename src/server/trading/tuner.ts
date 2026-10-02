import { readFileSync, writeFileSync } from 'node:fs';
import type { Bar, PaperTrade, PlaybookId, Symbol } from '../../shared/trading.js';
import { PLAYBOOK_BY_ID } from '../../shared/trading.js';
import { cleanSettings, describeSettings, judgeTune, KNOBS, MIN_TUNE_TRADES, sameSettings, testOf, TUNED_PLAYBOOKS, variantsOf, type PlaybookVersion, type Settings, type TunerBook, type TunerView, type TuneTry, type Tuning } from '../../shared/tuning.js';
import { pacific, replayDay } from './engine.js';

// The playbook tuner. After every backtest it takes each tuned playbook's live version, changes one
// setting at a time, replays the month for each, and judges the change (see judgeTune). A change that
// holds up is saved as a new candidate version. Versions are kept in playbook-versions.json; version 1
// is always the playbook as written. Nothing here changes what trades live: only the owner makes a
// version live, and then the proposals, the paper book and the backtest all follow it.

/** A market's finished trading days, oldest first, each with the day before it (for the run-up). */
export type History = Partial<Record<Symbol, { day: string; bars: Bar[]; prior: Bar[] }[]>>;

interface Stored {
  versions: Partial<Record<PlaybookId, PlaybookVersion[]>>;
  /** What the last run tried, and on which data, so a restart doesn't repeat it. */
  last?: { key: string; ranAt: number; took: number; replays: number; note: string; tried: Partial<Record<PlaybookId, TuneTry[]>> };
}

const first = (): PlaybookVersion => ({ version: 1, date: '', status: 'live', parent: null, settings: {}, change: ['The playbook as it was written'], test: null, vs: null, fresh: false });
const tick = () => new Promise<void>((r) => setImmediate(r));

export class Tuner {
  private data: Stored = { versions: {} };
  private running = false;
  private stage = '';
  /** The trades of every version that isn't live or retired, for the simulator to try. */
  private trades = new Map<string, PaperTrade[]>();

  constructor(private file: string | null) {
    try {
      const raw = JSON.parse(readFileSync(file ?? '', 'utf8')) as Stored;
      if (raw && typeof raw === 'object' && raw.versions) this.data = raw;
    } catch {
      // No versions yet.
    }
    for (const p of TUNED_PLAYBOOKS) {
      const list = (this.data.versions[p] ?? []).filter((v) => v && Number.isInteger(v.version)).map((v) => ({ ...v, settings: cleanSettings(p, v.settings) }));
      if (!list.some((v) => v.version === 1)) list.push(first());
      if (!list.some((v) => v.status === 'live')) list.find((v) => v.version === 1)!.status = 'live';
      this.data.versions[p] = list.sort((a, b) => b.version - a.version);
    }
  }

  private save() {
    if (!this.file) return;
    try {
      writeFileSync(this.file, JSON.stringify(this.data, null, 1));
    } catch {
      // Kept in memory until the next save.
    }
  }

  private versions(p: PlaybookId): PlaybookVersion[] {
    return this.data.versions[p] ?? [];
  }
  private live(p: PlaybookId): PlaybookVersion {
    return this.versions(p).find((v) => v.status === 'live')!;
  }

  /** The settings the office trades by right now: each tuned playbook's live version. */
  liveTuning(): Tuning {
    const out: Tuning = {};
    for (const p of TUNED_PLAYBOOKS) out[p] = this.live(p).settings;
    return out;
  }

  get busy() {
    return this.running;
  }

  view(): TunerView {
    const last = this.data.last;
    const books: TunerBook[] = TUNED_PLAYBOOKS.map((p) => ({ playbook: p, versions: this.versions(p), tried: last?.tried[p] ?? [] }));
    return { running: this.running, stage: this.stage, ranAt: last?.ranAt ?? null, took: last?.took ?? 0, replays: last?.replays ?? 0, note: last?.note ?? '', books };
  }

  /** The trades of each candidate version, for the Backtest Lab and the eval simulator. */
  versionTrades(): { playbook: PlaybookId; version: number; trades: PaperTrade[] }[] {
    return TUNED_PLAYBOOKS.flatMap((p) => this.versions(p).filter((v) => v.status === 'candidate' && this.trades.has(`${p}@${v.version}`)).map((v) => ({ playbook: p, version: v.version, trades: this.trades.get(`${p}@${v.version}`)! })));
  }

  /** One playbook replayed over the whole history with these settings. */
  private async replay(history: History, p: PlaybookId, settings: Settings): Promise<PaperTrade[]> {
    const out: PaperTrade[] = [];
    for (const sym of Object.keys(history) as Symbol[]) {
      for (const d of history[sym]!) {
        out.push(...replayDay(sym, d.bars, d.prior, { tuning: { [p]: settings }, only: [p] }).trades);
        // A day at a time, so the office keeps answering while the tuner works.
        await tick();
      }
    }
    return out;
  }

  /**
   * Tries every single change to each tuned playbook's live version. `baseline` is the backtest's own
   * trades (already made with the live versions), `days` every day it replayed.
   */
  async run(history: History, baseline: PaperTrade[], days: string[], now = Date.now()): Promise<void> {
    if (this.running) return;
    this.running = true;
    const started = Date.now();
    let replays = 0;
    const today = pacific(now).date;
    try {
      const key = `${days[0] ?? ''}:${days[days.length - 1] ?? ''}:${days.length}:${JSON.stringify(this.liveTuning())}`;
      const fresh = this.data.last?.key !== key;
      const tried: Partial<Record<PlaybookId, TuneTry[]>> = fresh ? {} : this.data.last!.tried;
      const found: string[] = [];
      const watching: string[] = [];
      /** Versions saved by this run: already tested, a moment ago. */
      const made = new Set<string>();
      for (const p of TUNED_PLAYBOOKS) {
        const live = this.live(p);
        const name = PLAYBOOK_BY_ID[p].name;
        const base = testOf(baseline.filter((t) => t.playbook === p && t.outcome !== 'open'), days);
        live.test = base.test;
        live.vs = null;
        if (fresh) {
          const variants = variantsOf(p, live.settings);
          const results: { settings: Settings; change: string[]; t: ReturnType<typeof testOf>; j: ReturnType<typeof judgeTune>; trades: PaperTrade[] }[] = [];
          for (let i = 0; i < variants.length; i++) {
            this.stage = `${name}: trying change ${i + 1} of ${variants.length}`;
            const trades = await this.replay(history, p, variants[i]!);
            replays++;
            const t = testOf(trades, days);
            results.push({ settings: variants[i]!, change: describeSettings(p, live.settings, variants[i]!), t, j: judgeTune(base, t), trades });
          }
          const better = results.filter((r) => r.j.verdict === 'better').sort((a, b) => b.t.later.avgR - a.t.later.avgR || b.t.all.totalR - a.t.all.totalR);
          let best = better[0] ?? null;
          // Two changes that each helped, together: kept only when the pair clearly beats the better one alone.
          if (better.length > 1) {
            const keyOf = (r: (typeof results)[number]) => (KNOBS[p] ?? []).find((k) => (r.settings[k.key] ?? k.base) !== (live.settings[k.key] ?? k.base))!.key;
            const other = better.find((r) => keyOf(r) !== keyOf(best!));
            if (other) {
              const k = keyOf(other);
              const combo = { ...best!.settings };
              if (k in other.settings) combo[k] = other.settings[k]!;
              else delete combo[k];
              this.stage = `${name}: trying the two best changes together`;
              const trades = await this.replay(history, p, combo);
              replays++;
              const t = testOf(trades, days);
              const j = judgeTune(base, t);
              const r = { settings: combo, change: describeSettings(p, live.settings, combo), t, j, trades };
              results.push(r);
              if (j.verdict === 'better' && t.later.avgR >= best!.t.later.avgR + 0.1) best = r;
            }
          }
          tried[p] = results.map((r) => ({ change: r.change, test: r.t.test, verdict: r.j.verdict, confidence: r.j.confidence, reason: r.j.reason, dAvgR: r.j.dAvgR })).sort((a, b) => b.dAvgR - a.dAvgR);
          // Nothing proven: the front-runner is still kept as a version to watch, and says it isn't proven.
          // It's re-tested on every run, so if more days bear it out, it's already there.
          const proven = !!best;
          best ??= results.filter((r) => r.j.verdict === 'unproven' && r.j.dAvgR >= 0.1 && r.j.dTotalR > 0 && r.t.all.trades >= MIN_TUNE_TRADES).sort((a, b) => b.j.dAvgR - a.j.dAvgR)[0] ?? null;
          if (best && !this.versions(p).some((v) => sameSettings(v.settings, best!.settings))) {
            const version = Math.max(...this.versions(p).map((v) => v.version)) + 1;
            this.versions(p).unshift({ version, date: today, status: 'candidate', parent: live.version, settings: best.settings, change: best.change, test: best.t.test, vs: { ...best.j, version: live.version }, fresh: proven });
            this.trades.set(`${p}@${version}`, best.trades);
            made.add(`${p}@${version}`);
            (proven ? found : watching).push(`${name} v${version}`);
          }
        }
        // The other saved versions, against the live one as it stands now.
        for (const v of this.versions(p)) {
          if (v.status !== 'candidate' || made.has(`${p}@${v.version}`)) continue;
          this.stage = `${name}: re-testing v${v.version}`;
          const trades = await this.replay(history, p, v.settings);
          replays++;
          const t = testOf(trades, days);
          v.test = t.test;
          v.vs = { ...judgeTune(base, t), version: live.version };
          v.change = describeSettings(p, this.versions(p).find((x) => x.version === v.parent)?.settings ?? {}, v.settings);
          this.trades.set(`${p}@${v.version}`, trades);
        }
      }
      const total = Object.values(tried).reduce((a, l) => a + (l?.length ?? 0), 0);
      this.data.last = {
        key,
        ranAt: now,
        took: fresh ? Date.now() - started : this.data.last!.took,
        replays: fresh ? replays : this.data.last!.replays,
        note: !fresh ? this.data.last!.note : found.length ? `Found ${found.length === 1 ? 'a version' : 'versions'} that held up: ${found.join(', ')}` : `Tried ${total} changes on ${days.length} days; none beat the live versions convincingly${watching.length ? `. Watching ${watching.join(', ')}` : ''}`,
        tried,
      };
      this.save();
    } finally {
      this.running = false;
      this.stage = '';
    }
  }

  /** The owner's call on a version: make it live (the one that was live is retired), retire it, or bring a retired one back as a candidate. */
  setStatus(p: PlaybookId, version: number, status: unknown): string | undefined {
    const list = this.versions(p);
    const v = list.find((x) => x.version === version);
    if (!v) return 'No such version';
    if (status === 'live') {
      for (const x of list) if (x.status === 'live') x.status = 'retired';
      v.status = 'live';
      v.fresh = false;
      this.trades.delete(`${p}@${version}`);
    } else if (status === 'retired') {
      if (v.status === 'live') return 'The live version is only replaced by making another one live';
      v.status = 'retired';
      this.trades.delete(`${p}@${version}`);
    } else if (status === 'candidate') {
      if (v.status === 'live') return 'The live version is only replaced by making another one live';
      v.status = 'candidate';
    } else return 'Unknown status';
    this.save();
    return undefined;
  }

  markSeen(p: PlaybookId, version: number): string | undefined {
    const v = this.versions(p).find((x) => x.version === version);
    if (!v) return 'No such version';
    if (v.fresh) {
      v.fresh = false;
      this.save();
    }
    return undefined;
  }
}
