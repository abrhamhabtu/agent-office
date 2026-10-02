import type { BacktestDetail, ProposalAction, TradingSnapshot, TvAlert } from '../../shared/trading';
import type { JobDetail } from '../../shared/propfarm';

/** A version the test lab made that tested better than the live one, which the owner hasn't looked at. */
export interface StrategyNews {
  script: string;
  /** Which strategy it is: the script's name. */
  name: string;
  version: string;
  /** What changed, in a line. */
  summary: string;
  /** Against which version, and by how much. */
  against: string;
  dAvgR: number;
}

/** The market desk as the browser sees it: one snapshot, refreshed every second or so, and who wants to hear. */
export class TradingFeed {
  snap: TradingSnapshot | null = null;
  private listeners = new Set<() => void>();
  private alertListeners = new Set<(a: TvAlert) => void>();
  private bellListeners = new Set<(kind: 'open' | 'close') => void>();
  private strategyListeners = new Set<(n: StrategyNews) => void>();
  private seenStrategy = new Set<string>();
  private timer = 0;
  private busy = false;
  private pulledAt = 0;
  private seenAlerts: Set<string> | null = null;
  private rungBell: number | null | undefined;
  /** Bumps on every snapshot, so a screen can tell whether it has anything new to draw. */
  tick = 0;

  on(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** A TradingView alert came in since the page loaded. */
  onAlert(fn: (a: TvAlert) => void) {
    this.alertListeners.add(fn);
  }

  /** The opening or closing bell rang (in the last minute and a half, while this page was open). */
  onBell(fn: (kind: 'open' | 'close') => void) {
    this.bellListeners.add(fn);
  }

  /** The test lab found a version that tested better (once per page load for each, including ones waiting when it opened). */
  onStrategy(fn: (n: StrategyNews) => void) {
    this.strategyListeners.add(fn);
  }

  /** New versions from the test lab that nobody has looked at yet. */
  freshStrategies(): StrategyNews[] {
    return (this.snap?.vault.scripts ?? []).flatMap((sc) =>
      sc.versions.filter((v) => v.fresh && v.test?.vs?.verdict === 'better').map((v) => ({ script: sc.id, name: sc.name, version: v.version, summary: v.changelog[0] ?? `v${v.version}`, against: `v${v.test!.vs!.version}`, dAvgR: v.test!.vs!.dAvgR })),
    );
  }

  start() {
    if (this.timer) return;
    void this.pull();
    this.timer = window.setInterval(() => {
      if (document.hidden) return;
      // Another window in front: keep up, but a few times slower.
      if (!document.hasFocus() && Date.now() - this.pulledAt < 5000) return;
      void this.pull();
    }, 1200);
  }

  private async pull() {
    if (this.busy) return;
    this.busy = true;
    this.pulledAt = Date.now();
    let received = false;
    try {
      const res = await fetch('/api/trading/snapshot', { credentials: 'same-origin' });
      if (res.ok) {
        this.set((await res.json()) as TradingSnapshot);
        received = true;
      }
    } catch {
      // The office is restarting; the last snapshot stays up.
    } finally {
      this.busy = false;
      // A failed refresh must still age every screen's freshness label; retain source timestamps.
      if (!received && this.snap) {
        this.tick++;
        for (const fn of this.listeners) fn();
      }
    }
  }

  private set(s: TradingSnapshot) {
    this.snap = s;
    this.tick++;
    // Alerts and bells that happen while the page is open ring once; what was there before doesn't.
    if (this.seenAlerts === null) this.seenAlerts = new Set(s.alerts.map((a) => a.id));
    else
      for (const a of [...s.alerts].reverse())
        if (!this.seenAlerts.has(a.id)) {
          this.seenAlerts.add(a.id);
          for (const fn of this.alertListeners) fn(a);
        }
    const bell = s.session.lastBell;
    if (this.rungBell === undefined) this.rungBell = bell?.at ?? null;
    else if (bell && bell.at !== this.rungBell) {
      this.rungBell = bell.at;
      if (s.at - bell.at < 90_000) for (const fn of this.bellListeners) fn(bell.kind);
    }
    for (const n of this.freshStrategies()) {
      const key = `${n.script}@${n.version}`;
      if (this.seenStrategy.has(key)) continue;
      this.seenStrategy.add(key);
      for (const fn of this.strategyListeners) fn(n);
    }
    for (const fn of this.listeners) fn();
  }

  async post(path: string, body: object): Promise<string | undefined> {
    try {
      const res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const json = (await res.json()) as TradingSnapshot & { error?: string };
      if (!res.ok) return json.error ?? 'Something went wrong';
      this.set(json);
    } catch {
      return "Couldn't reach the office";
    }
    return undefined;
  }

  /** One Pine version's exact source, for copying into TradingView or comparing. */
  async vaultSource(script: string, version: string): Promise<string | null> {
    try {
      const res = await fetch(`/api/trading/vault/source?script=${encodeURIComponent(script)}&version=${encodeURIComponent(version)}`, { credentials: 'same-origin' });
      return res.ok ? ((await res.json()) as { source: string }).source : null;
    } catch {
      return null;
    }
  }

  private detail: BacktestDetail | null = null;
  private detailKey = '';

  /** The last backtest trade by trade, fetched once per run (the Backtest Lab and the eval simulator work on it). */
  async backtestDetail(): Promise<BacktestDetail | null> {
    const bt = this.snap?.backtest;
    // The tuner finishes after the backtest and adds its versions' trades, so its run is part of what's cached.
    const key = `${bt?.ranAt}:${bt?.tuner?.ranAt}:${bt?.tuner?.running}`;
    if (this.detail && this.detailKey === key && !bt?.running) return this.detail;
    try {
      const res = await fetch('/api/trading/backtest/trades', { credentials: 'same-origin' });
      if (res.ok) {
        this.detail = (await res.json()) as BacktestDetail;
        this.detailKey = key;
      }
    } catch {
      // The office is restarting; whatever was fetched before stays.
    }
    return this.detail;
  }

  private jobs = new Map<string, { key: string; detail: JobDetail }>();

  /** One research job in full, fetched again only when it has moved on. */
  async farmJob(id: string): Promise<JobDetail | null> {
    const j = this.snap?.propFarm?.jobs.find((x) => x.id === id);
    const key = `${j?.status}:${j?.done}`;
    const had = this.jobs.get(id);
    if (had && had.key === key) return had.detail;
    try {
      const res = await fetch(`/api/trading/prop-farm/job?id=${encodeURIComponent(id)}`, { credentials: 'same-origin' });
      if (!res.ok) return had?.detail ?? null;
      const detail = (await res.json()) as JobDetail;
      this.jobs.set(id, { key, detail });
      return detail;
    } catch {
      return had?.detail ?? null;
    }
  }

  /** One action on the prop farm (see PropFarm.act on the server). */
  farm(body: object) {
    return this.post('/api/trading/prop-farm', body);
  }

  toggleChecklist(id: string) {
    return this.post('/api/trading/checklist', { id });
  }

  act(id: string, action: ProposalAction) {
    return this.post('/api/trading/proposal', { id, action });
  }
}

export const trading = new TradingFeed();
