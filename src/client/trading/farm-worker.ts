import { planParts } from '../../shared/farm-planner';
import type { BacktestDetail } from '../../shared/trading';
import type { FarmSetup } from '../../shared/farm';

// The battle test's arithmetic, off the page's own thread. It keeps the backtest's trades once they have
// been sent (they are the big part of every message), and hands each part of a plan back as it is ready.
// A newer plan takes over from an older one between parts, so changing the setup never waits for a plan
// nobody is looking at any more.

let detail: Pick<BacktestDetail, 'trades' | 'days'> | null = null;
let latest = 0;
const breathe = () => new Promise<void>((r) => setTimeout(r, 0));

self.onmessage = async (event: MessageEvent<{ id: number; detail?: Pick<BacktestDetail, 'trades' | 'days'>; setup: FarmSetup }>) => {
  const { id, setup } = event.data;
  latest = id;
  if (event.data.detail) detail = event.data.detail;
  if (!detail) return self.postMessage({ id, error: 'The backtest’s trades never arrived.' });
  try {
    for (const part of planParts(detail, setup)) {
      self.postMessage({ id, part });
      // Let a newer request in: if one has arrived, this plan is abandoned here.
      await breathe();
      if (latest !== id) return;
    }
    self.postMessage({ id, done: true });
  } catch {
    self.postMessage({ id, error: 'This plan couldn’t be worked out. Change the setup to try again.' });
  }
};
