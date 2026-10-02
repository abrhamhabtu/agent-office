import { planFarm } from '../../shared/farm-planner';
import type { BacktestDetail } from '../../shared/trading';
import type { FarmSetup } from '../../shared/farm';

self.onmessage = (event: MessageEvent<{ detail: Pick<BacktestDetail, 'trades' | 'days'>; setup: FarmSetup }>) => {
  try { self.postMessage({ result: planFarm(event.data.detail, event.data.setup) }); }
  catch { self.postMessage({ error: 'The comparison could not finish. Change the setup or reopen Battle test to retry.' }); }
};
