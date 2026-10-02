import type { PaperTrade } from './trading.js';
import { INSTRUMENTS } from './trading.js';

// Managing a trade once it's working. The playbooks, as written, set a stop and a target and leave them.
// A trader plays it by ear: moves the stop up so the trade can't lose, banks half, lets it run, or adds
// to it. The backtest follows every trade bar by bar under each of these as well (see Shadow in
// server/trading/engine.ts) and keeps how each would have come out, so the Backtest Lab and the eval
// simulator can switch between them at once.
//
// Results are in R of the trade's first risk, so they compare like for like. "Add" ends up holding two
// units: an account at its contract limit couldn't take the second.

export type ManageId = 'written' | 'be' | 'half' | 'trail' | 'add';
/** How a trade came out under each way of managing it, in R (the playbook's own way is the trade's `r`). */
export type ManagedR = Record<Exclude<ManageId, 'written'>, number>;

export const MANAGE: { id: ManageId; name: string; short: string; what: string }[] = [
  { id: 'written', name: 'As the playbook is written', short: 'As written', what: 'The stop and the target are set at the entry and left alone.' },
  { id: 'be', name: 'Stop to breakeven at +1R', short: 'Breakeven at +1R', what: 'Once the trade is up one risk, the stop moves to the entry: from there it can’t lose. The target stays.' },
  { id: 'half', name: 'Bank half at +1R', short: 'Bank half', what: 'At +1R half the position is taken off and the stop moves to the entry; the other half goes for the target.' },
  { id: 'trail', name: 'Let it run with a trailing stop', short: 'Let it run', what: 'Once the trade is up one risk the target comes off and the stop follows one risk behind the best price, to the close if it gets there.' },
  { id: 'add', name: 'Size up at +1R', short: 'Size up', what: 'At +1R a second unit is added and the stop on both moves to the first entry: a winner pays more, and a turn-around now costs a full risk.' },
];
export const MANAGE_BY_ID = Object.fromEntries(MANAGE.map((m) => [m.id, m])) as Record<ManageId, (typeof MANAGE)[number]>;

/** The trades as they'd have come out managed this way. A trade the backtest has no reading for stays as it was. */
export function managed(trades: PaperTrade[], style: ManageId): PaperTrade[] {
  if (style === 'written') return trades;
  return trades.map((t) => {
    const r = t.alt?.[style];
    if (r == null || t.outcome === 'open') return t;
    const dollars = Math.round(r * Math.abs(t.entry - t.stop) * INSTRUMENTS[t.symbol].microPointValue * 100) / 100;
    return { ...t, r, dollars, outcome: r > 0 ? 'win' : r < 0 ? 'loss' : 'time' };
  });
}
