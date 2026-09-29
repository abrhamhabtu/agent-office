import type { ProposalAction, TradingSnapshot } from '../../shared/trading';

/** The market desk as the browser sees it: one snapshot, refreshed every second or two, and who wants to hear. */
class TradingFeed {
  snap: TradingSnapshot | null = null;
  private listeners = new Set<() => void>();
  private timer = 0;
  private busy = false;
  /** Bumps on every snapshot, so a screen can tell whether it has anything new to draw. */
  tick = 0;

  on(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  start() {
    if (this.timer) return;
    void this.pull();
    this.timer = window.setInterval(() => {
      if (!document.hidden) void this.pull();
    }, 1500);
  }

  private async pull() {
    if (this.busy) return;
    this.busy = true;
    try {
      const res = await fetch('/api/trading/snapshot', { credentials: 'same-origin' });
      if (res.ok) this.set((await res.json()) as TradingSnapshot);
    } catch {
      // The office is restarting; the last snapshot stays up.
    } finally {
      this.busy = false;
    }
  }

  private set(s: TradingSnapshot) {
    this.snap = s;
    this.tick++;
    for (const fn of this.listeners) fn();
  }

  private async post(path: string, body: object): Promise<string | undefined> {
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

  togglePlaybook(id: string) {
    return this.post('/api/trading/playbook', { id });
  }

  act(id: string, action: ProposalAction) {
    return this.post('/api/trading/proposal', { id, action });
  }
}

export const trading = new TradingFeed();
