import type { BacktestDetail, ProposalAction, TradingSnapshot, TvAlert } from '../../shared/trading';

/** The market desk as the browser sees it: one snapshot, refreshed every second or so, and who wants to hear. */
export class TradingFeed {
  snap: TradingSnapshot | null = null;
  private listeners = new Set<() => void>();
  private alertListeners = new Set<(a: TvAlert) => void>();
  private bellListeners = new Set<(kind: 'open' | 'close') => void>();
  private timer = 0;
  private busy = false;
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

  start() {
    if (this.timer) return;
    void this.pull();
    this.timer = window.setInterval(() => {
      if (!document.hidden) void this.pull();
    }, 1200);
  }

  private async pull() {
    if (this.busy) return;
    this.busy = true;
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

  toggleChecklist(id: string) {
    return this.post('/api/trading/checklist', { id });
  }

  act(id: string, action: ProposalAction) {
    return this.post('/api/trading/proposal', { id, action });
  }
}

export const trading = new TradingFeed();
