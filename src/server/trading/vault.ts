import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { PineParams, PineScriptInfo, PineStatus, PineTest, PineVersionInfo, PlaybookId, VaultView } from '../../shared/trading.js';
import { PLAYBOOKS } from '../../shared/trading.js';
import { applyParams, stamp } from './lab.js';
import { VWAP_DB_V1_0_0, VWAP_DB_V1_0_1 } from './pine-seed.js';

// The Pine Vault: the owner's TradingView scripts, every version kept as its own file with a date, a
// changelog, where it came from and a fingerprint of its exact source. A version is never edited: a change
// is a new version. One version per script is LIVE (what's on the chart), and only the owner makes one live.
// Layout on disk: <dir>/<script id>/manifest.json and <dir>/<script id>/v<version>.pine.

const STATUSES: PineStatus[] = ['live', 'candidate', 'experiment', 'retired'];
/** The biggest script the vault takes (TradingView's own limit is far below this). */
export const MAX_PINE_BYTES = 200_000;

interface StoredVersion {
  version: string;
  date: string;
  status: PineStatus;
  parent: string | null;
  changelog: string[];
  sha: string;
  /** What replaying it on real bars showed. */
  test?: PineTest | null;
  /** Made by the test lab and not looked at yet. */
  fresh?: boolean;
  by?: 'owner' | 'lab';
}
interface Manifest {
  id: string;
  name: string;
  /** The office playbook this script is the TradingView version of. */
  playbook?: PlaybookId | null;
  summary: string;
  rules: string[];
  versions: StoredVersion[];
}

const sha = (source: string) => createHash('sha256').update(source).digest('hex').slice(0, 12);
/** Today in Pacific time, the office's clock. */
const today = (at = Date.now()) => new Date(at).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
const parts = (v: string) => v.split('.').map(Number) as [number, number, number];
/** Semantic order: the newest version sorts first. */
const newer = (a: string, b: string) => {
  const [x, y] = [parts(a), parts(b)];
  return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
};
export const bumpVersion = (latest: string | undefined, bump: 'major' | 'minor' | 'patch'): string => {
  if (!latest) return '1.0.0';
  const [a, b, c] = parts(latest);
  return bump === 'major' ? `${a + 1}.0.0` : bump === 'minor' ? `${a}.${b + 1}.0` : `${a}.${b}.${c + 1}`;
};
/** Whether something is a Pine script worth keeping; why not, if not. */
function checkSource(source: unknown): string | undefined {
  if (typeof source !== 'string' || !source.trim()) return 'Paste the Pine source';
  if (Buffer.byteLength(source) > MAX_PINE_BYTES) return 'That’s too big for a Pine script';
  if (!/^\s*\/\/\s*@version\s*=\s*\d/m.test(source)) return 'That doesn’t look like Pine: it should start with //@version=6';
  return undefined;
}
const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

const VWAP_DB = {
  id: 'vwap-double-break',
  name: 'VWAP Double Break Suite',
  playbook: 'double-break' as PlaybookId,
  summary: 'NY VWAP double break for NQ and GC micros (Evan Dyer style): the first close through NY VWAP is the trap, the close back the other way inside the window is the entry.',
  rules: [
    'Trigger: NY VWAP double break only; overnight VWAP is context',
    'Window 7 to 9 AM PT (10 to 12 ET), opening range 15 minutes',
    'One DB per direction a day; after a stop, one re-entry (DB2), then done',
    'Stop: the far side of the opening range, micro loss capped near $325',
    'Target: 2R from the entry candle',
  ],
};

export class Vault {
  private cache: { at: number; view: VaultView } | null = null;
  private lab: VaultView['lab'] = { ranAt: null, running: false, note: '', stage: '', report: null };

  constructor(private dir: string) {
    try {
      mkdirSync(dir, { recursive: true });
      this.seed();
    } catch {
      // A read-only data folder: the vault just stays empty.
    }
  }

  /** The owner's script goes in as v1.0.0 (live, exactly as pasted), and v1.0.1 (adds the version to its alerts) beside it. */
  private seed() {
    if (existsSync(path.join(this.dir, VWAP_DB.id, 'manifest.json'))) return;
    const day = today();
    const m: Manifest = { ...VWAP_DB, versions: [] };
    this.write(m, [
      { version: '1.0.0', date: day, status: 'live', parent: null, changelog: ['Imported into the vault exactly as it runs on the chart today', 'The locked book: signals, stop, target and alert message are as pasted'], sha: sha(VWAP_DB_V1_0_0) },
      { version: '1.0.1', date: day, status: 'candidate', parent: '1.0.0', changelog: ['Adds "ver" to the alert message so every live alert says which version sent it', 'Signals, stops and targets are identical to 1.0.0'], sha: sha(VWAP_DB_V1_0_1) },
    ], { '1.0.0': VWAP_DB_V1_0_0, '1.0.1': VWAP_DB_V1_0_1 });
  }

  /** The folder the scripts live in. */
  get directory() {
    return this.dir;
  }

  private scriptDir(id: string) {
    return path.join(this.dir, id);
  }
  private file(id: string, version: string) {
    return path.join(this.scriptDir(id), `v${version}.pine`);
  }
  private read(id: string): Manifest | null {
    try {
      const m = JSON.parse(readFileSync(path.join(this.scriptDir(id), 'manifest.json'), 'utf8')) as Manifest;
      if (!m || m.id !== id || !Array.isArray(m.versions)) return null;
      if (m.playbook === undefined && id === VWAP_DB.id) m.playbook = VWAP_DB.playbook;
      return m;
    } catch {
      return null;
    }
  }
  private write(m: Manifest, versions: StoredVersion[], sources: Record<string, string> = {}) {
    mkdirSync(this.scriptDir(m.id), { recursive: true });
    for (const [v, src] of Object.entries(sources)) writeFileSync(this.file(m.id, v), src, { mode: 0o600, flag: 'wx' });
    m.versions = versions.sort((a, b) => newer(a.version, b.version));
    const tmp = path.join(this.scriptDir(m.id), 'manifest.json.tmp');
    writeFileSync(tmp, JSON.stringify(m, null, 2), { mode: 0o600 });
    renameSync(tmp, path.join(this.scriptDir(m.id), 'manifest.json'));
    this.cache = null;
  }
  private ids(): string[] {
    try {
      return readdirSync(this.dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return [];
    }
  }

  /** Every script and version, as the boards and panel show them (never the source). Re-checks the files now and then. */
  view(): VaultView {
    if (this.cache && Date.now() - this.cache.at < 30_000) return this.cache.view;
    const scripts: PineScriptInfo[] = [];
    for (const id of this.ids()) {
      const m = this.read(id);
      if (!m) continue;
      scripts.push({
        id: m.id,
        name: m.name,
        playbook: m.playbook && PLAYBOOKS.some((p) => p.id === m.playbook) ? m.playbook : null,
        summary: m.summary,
        rules: m.rules,
        versions: m.versions.map((v): PineVersionInfo => {
          const src = this.source(m.id, v.version);
          return { version: v.version, date: v.date, status: v.status, parent: v.parent, changelog: v.changelog, sha: v.sha, lines: src ? src.split('\n').length : 0, intact: src !== null && sha(src) === v.sha, test: v.test ?? null, fresh: !!v.fresh, by: v.by ?? 'owner' };
        }),
      });
    }
    const view = { scripts: scripts.sort((a, b) => a.name.localeCompare(b.name)), lab: { ...this.lab } };
    this.cache = { at: Date.now(), view };
    return view;
  }

  /** The exact source of one version, or null. */
  source(id: string, version: string): string | null {
    if (!/^[a-z0-9-]+$/.test(id) || !/^\d+\.\d+\.\d+$/.test(version)) return null;
    try {
      return readFileSync(this.file(id, version), 'utf8');
    } catch {
      return null;
    }
  }

  /** What the test lab is doing, for the desk to show. */
  setLab(patch: Partial<VaultView['lab']>) {
    this.lab = { ...this.lab, ...patch };
    this.cache = null;
  }

  /** The stored version, with what's kept about it (for the lab to read and update). */
  versionOf(id: string, version: string): StoredVersion | undefined {
    return this.read(id)?.versions.find((v) => v.version === version);
  }

  /** Records what replaying a version showed. */
  setTest(id: string, version: string, test: PineTest): void {
    const m = this.read(id);
    const v = m?.versions.find((x) => x.version === version);
    if (!m || !v) return;
    v.test = test;
    this.write(m, m.versions);
  }

  /** The owner has looked at a version the lab made: the Strategy agent stops jumping. */
  markSeen(id: string, version: string): string | undefined {
    const m = this.read(id);
    const v = m?.versions.find((x) => x.version === version);
    if (!m || !v) return 'No such version';
    if (v.fresh) {
      v.fresh = false;
      this.write(m, m.versions);
    }
    return undefined;
  }

  /** The version that already tried exactly these settings (kept, retired or rejected), so the lab doesn't keep re-making it. */
  versionWithParams(id: string, params: unknown): string | null {
    const key = JSON.stringify(params);
    return this.read(id)?.versions.find((v) => v.test && JSON.stringify(v.test.params) === key)?.version ?? null;
  }

  triedParams(id: string, params: unknown): boolean {
    return this.versionWithParams(id, params) !== null;
  }

  /** The version that's on the chart now, if any. */
  live(id: string): string | null {
    return this.read(id)?.versions.find((v) => v.status === 'live')?.version ?? null;
  }

  /**
   * Moves a version between statuses. Only one is LIVE: making another live retires the old one, and
   * that (or rolling back to a retired version) is the owner's call. Returns why not, if not.
   */
  setStatus(id: string, version: string, status: unknown): string | undefined {
    if (typeof status !== 'string' || !STATUSES.includes(status as PineStatus)) return 'Unknown status';
    const m = this.read(id);
    const v = m?.versions.find((x) => x.version === version);
    if (!m || !v) return 'No such version';
    const src = this.source(id, version);
    if (src === null || sha(src) !== v.sha) return 'That version’s file doesn’t match its fingerprint, so it can’t go live';
    if (v.status === status) return undefined;
    if (status === 'live') for (const x of m.versions) if (x.status === 'live') x.status = 'retired';
    v.status = status as PineStatus;
    this.write(m, m.versions);
    return undefined;
  }

  /**
   * Saves a new version: a new file, dated today, with its changelog and the version it came from. It
   * starts as a candidate (or an experiment) and never replaces what's live.
   */
  addVersion(id: string, o: { source: unknown; changelog: unknown; bump?: unknown; parent?: unknown; status?: unknown; by?: 'owner' | 'lab'; test?: PineTest | null; fresh?: boolean }): { version: string } | { error: string } {
    const m = this.read(id);
    if (!m) return { error: 'No such script' };
    const bad = checkSource(o.source);
    if (bad) return { error: bad };
    const source = o.source as string;
    const changelog = (Array.isArray(o.changelog) ? o.changelog : typeof o.changelog === 'string' ? o.changelog.split('\n') : []).map((l) => String(l).trim()).filter(Boolean).slice(0, 12);
    if (!changelog.length) return { error: 'Say what changed, in a line or two' };
    const status = o.status === 'experiment' ? 'experiment' : 'candidate';
    const bump = o.bump === 'major' || o.bump === 'minor' ? o.bump : 'patch';
    const fp = sha(source);
    const dup = m.versions.find((v) => v.sha === fp);
    if (dup) return { error: `That’s the same source as v${dup.version}` };
    const latest = [...m.versions].sort((a, b) => newer(a.version, b.version))[0]?.version;
    const version = bumpVersion(latest, bump);
    const parent = typeof o.parent === 'string' && m.versions.some((v) => v.version === o.parent) ? o.parent : m.versions.find((v) => v.status === 'live')?.version ?? latest ?? null;
    this.write(m, [...m.versions, { version, date: today(), status, parent, changelog, sha: fp, by: o.by ?? 'owner', ...(o.test ? { test: o.test } : {}), ...(o.fresh ? { fresh: true } : {}) }], { [version]: source });
    return { version };
  }

  /**
   * The lab's own new version: `from` with these settings changed, stamped with its version, saved as a
   * candidate that the owner hasn't seen yet. It is never live until the owner says so.
   */
  addFromLab(id: string, o: { from: string; params: PineParams; change: string[]; test: PineTest }): { version: string } | { error: string } {
    const m = this.read(id);
    const base = this.source(id, o.from);
    if (!m || base === null) return { error: 'Nothing to make it from' };
    const applied = applyParams(base, o.params);
    if (!applied) return { error: 'The script’s settings couldn’t be found to change' };
    const latest = [...m.versions].sort((a, b) => newer(a.version, b.version))[0]?.version;
    const version = bumpVersion(latest, 'minor');
    const t = o.test;
    const vs = t.vs;
    const changelog = [
      ...o.change,
      `Replayed on ${t.days} sessions (${t.from} to ${t.to}) of ${t.symbols.join(', ')}: ${t.all.trades} trades, average ${t.all.avgR >= 0 ? '+' : '−'}${Math.abs(t.all.avgR).toFixed(2)} R, total ${t.all.totalR >= 0 ? '+' : '−'}${Math.abs(t.all.totalR).toFixed(1)} R`,
      ...(vs ? [`Against v${vs.version}: ${vs.reason}. Confidence ${vs.confidence.toUpperCase()}`] : []),
      ...(o.change.length > 1 ? ['Two changes that each helped on their own, tested together. Both were picked on these same sessions, so this is promising, not proven'] : []),
      'Made by the test lab. Paper evidence on a short history, not a promise',
    ];
    const text = stamp(applied, version, `${o.change.join('; ')} (made by the test lab from v${o.from})`);
    return this.addVersion(id, { source: text, changelog, bump: 'minor', parent: o.from, status: 'candidate', by: 'lab', test: o.test, fresh: true });
  }

  /** A new script in the vault, its first version an experiment until the owner makes it live. */
  addScript(o: { name: unknown; summary?: unknown; source: unknown; changelog?: unknown; playbook?: unknown }): { id: string } | { error: string } {
    const name = typeof o.name === 'string' ? o.name.trim().slice(0, 60) : '';
    const id = slug(name);
    if (!id) return { error: 'Give the script a name' };
    if (this.read(id)) return { error: 'There’s already a script with that name' };
    const bad = checkSource(o.source);
    if (bad) return { error: bad };
    const playbook = PLAYBOOKS.find((p) => p.id === o.playbook)?.id ?? null;
    this.write({ id, name, playbook, summary: typeof o.summary === 'string' ? o.summary.trim().slice(0, 240) : '', rules: [], versions: [] }, []);
    const r = this.addVersion(id, { source: o.source, changelog: o.changelog || 'First version', bump: 'patch', status: 'experiment' });
    return 'error' in r ? r : { id };
  }
}
