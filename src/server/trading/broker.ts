import type { Symbol } from '../../shared/trading.js';
import type { BrokerCapability, ReadinessItem } from '../../shared/propfarm.js';

// The broker boundary. Nothing in this office sends an order to a firm, and this file is why that stays
// true until the owner decides otherwise: there is no live adapter here, only the shapes one would have
// to fit, a sandbox that behaves badly on purpose, and the order manager that has to survive it.
//
// The order manager is independent of any strategy or research agent. It takes an order that the risk
// governor has already sized, and its job is to never make things worse: the same order is never sent
// twice; an order whose fate is unknown is found out before anything else is tried; a position without
// its protective stop is flattened; and stale account state, a dropped connection or an unreconciled
// order blocks new exposure rather than guessing.

export type OrderState = 'placing' | 'working' | 'partial' | 'filled' | 'rejected' | 'cancelled' | 'unknown' | 'flattened';

export interface OrderIntent {
  /** The idempotency key: one per decision per account. The same key is the same order. */
  key: string;
  account: string;
  symbol: Symbol;
  side: 'long' | 'short';
  micros: number;
  stop: number;
  target: number;
  /** The decision it came from, and the size the risk governor allowed for it. */
  decision: string;
  allowedMicros: number;
}

export interface OrderRecord {
  intent: OrderIntent;
  state: OrderState;
  filled: number;
  /** The stop and target are confirmed working at the broker. */
  bracket: boolean;
  brokerId: string | null;
  attempts: number;
  note: string;
  /** Event ids already applied, so a repeated message changes nothing. */
  seen: string[];
}

export interface BrokerAck {
  brokerId: string;
  state: 'working' | 'partial' | 'filled' | 'rejected';
  filled: number;
  bracket: boolean;
  reason?: string;
}

export interface BrokerEvent {
  id: string;
  key: string;
  kind: 'fill' | 'reject' | 'cancel' | 'bracket';
  /** Micros filled by this event. */
  qty?: number;
}

export interface BrokerAdapter {
  id: string;
  /** `sandbox` and `paper` can never reach a firm. There is no other kind in this build. */
  environment: 'sandbox' | 'paper' | 'live';
  connected(): boolean;
  /** Sends the order with its bracket. May time out: then nobody knows whether it arrived. */
  place(intent: OrderIntent): Promise<BrokerAck>;
  /** What the broker knows of an order by its key (null: it never arrived). */
  status(key: string): Promise<BrokerAck | null>;
  /** Flatten whatever this order holds and cancel what's resting. */
  flatten(key: string): Promise<void>;
  /** The account's balance, and when the broker last reported it. */
  account(id: string): Promise<{ balance: number; at: number } | null>;
}

export class BrokerTimeout extends Error {
  constructor() {
    super('The broker did not answer');
  }
}

export interface GuardOptions {
  /** Account state older than this blocks new orders. */
  maxAccountAgeMs: number;
  /** The owner's stop switch: when on, nothing new is sent. */
  halted: () => boolean;
}

export type SubmitResult = { ok: true; order: OrderRecord } | { ok: false; reason: string; order?: OrderRecord };

export class OrderManager {
  private orders = new Map<string, OrderRecord>();

  constructor(private adapter: BrokerAdapter, private guard: GuardOptions, private clock: () => number = Date.now) {}

  get(key: string): OrderRecord | undefined {
    return this.orders.get(key);
  }
  all(): OrderRecord[] {
    return [...this.orders.values()];
  }
  /** Orders whose fate isn't known: nothing new goes to their account until they're reconciled. */
  unresolved(account?: string): OrderRecord[] {
    return this.all().filter((o) => (o.state === 'unknown' || o.state === 'placing') && (!account || o.intent.account === account));
  }

  /** Why a new order can't be sent right now (null: it can). */
  async blocked(intent: OrderIntent): Promise<string | null> {
    if (this.adapter.environment === 'live') return 'There is no live trading in this build: orders go to a sandbox or to paper only';
    if (this.guard.halted()) return 'Stopped by the owner';
    if (!this.adapter.connected()) return 'The broker connection is down: no new exposure until it is back and reconciled';
    if (this.unresolved(intent.account).length) return 'An earlier order on this account is unaccounted for: it is reconciled before anything new is sent';
    if (!(intent.micros >= 1) || intent.micros > intent.allowedMicros) return `The risk governor allowed ${intent.allowedMicros} micros: ${intent.micros} can’t be sent`;
    if (!(intent.stop > 0) || !(intent.target > 0)) return 'An order needs its stop and its target: none is sent without a bracket';
    const acct = await this.adapter.account(intent.account).catch(() => null);
    if (!acct) return 'The account’s state couldn’t be read';
    if (this.clock() - acct.at > this.guard.maxAccountAgeMs) return `The account’s state is ${Math.round((this.clock() - acct.at) / 1000)}s old: too stale to add exposure on`;
    return null;
  }

  /** Sends an order once. The same key again returns the order it already made. */
  async submit(intent: OrderIntent): Promise<SubmitResult> {
    const had = this.orders.get(intent.key);
    if (had) return had.state === 'rejected' ? { ok: false, reason: had.note, order: had } : { ok: true, order: had };
    const why = await this.blocked(intent);
    if (why) return { ok: false, reason: why };
    const order: OrderRecord = { intent, state: 'placing', filled: 0, bracket: false, brokerId: null, attempts: 1, note: '', seen: [] };
    this.orders.set(intent.key, order);
    try {
      await this.apply(order, await this.adapter.place(intent));
    } catch (e) {
      // Nobody knows whether it arrived. It is not sent again: it is looked for.
      order.state = 'unknown';
      order.note = e instanceof BrokerTimeout ? 'Timed out: the broker may or may not have it' : `Failed in flight: ${(e as Error).message}`;
      return { ok: false, reason: order.note, order };
    }
    return order.state === 'rejected' || order.state === 'flattened' ? { ok: false, reason: order.note, order } : { ok: true, order };
  }

  private async apply(order: OrderRecord, ack: BrokerAck) {
    order.brokerId = ack.brokerId;
    order.filled = ack.filled;
    order.bracket = ack.bracket;
    if (ack.state === 'rejected') {
      order.state = 'rejected';
      order.note = `Rejected by the broker${ack.reason ? `: ${ack.reason}` : ''}`;
      return;
    }
    order.state = ack.state;
    // A position with no protective stop is not held: it is flattened, and it says so.
    if (ack.filled > 0 && !ack.bracket) {
      await this.adapter.flatten(order.intent.key).catch(() => {});
      order.state = 'flattened';
      order.note = 'Filled without its stop and target confirmed: flattened';
    }
  }

  /**
   * Finds out what happened to every order whose fate isn't known. One the broker has is adopted as it
   * stands; one that never arrived is closed as never placed, and only then may the caller send it again
   * (under a new key).
   */
  async reconcile(): Promise<{ adopted: number; missing: number; pending: number }> {
    const out = { adopted: 0, missing: 0, pending: 0 };
    if (!this.adapter.connected()) return { ...out, pending: this.unresolved().length };
    for (const order of this.unresolved()) {
      let ack: BrokerAck | null;
      try {
        ack = await this.adapter.status(order.intent.key);
      } catch {
        out.pending++;
        continue;
      }
      if (ack) {
        await this.apply(order, ack);
        order.note ||= 'Found at the broker after a timeout';
        out.adopted++;
      } else {
        order.state = 'cancelled';
        order.note = 'Never reached the broker';
        out.missing++;
      }
    }
    return out;
  }

  /** A message from the broker. One already seen (a repeat after a reconnect) changes nothing. */
  onEvent(e: BrokerEvent): 'applied' | 'duplicate' | 'unknown-order' {
    const order = this.orders.get(e.key);
    if (!order) return 'unknown-order';
    if (order.seen.includes(e.id)) return 'duplicate';
    order.seen.push(e.id);
    if (e.kind === 'fill') {
      order.filled = Math.min(order.intent.micros, order.filled + (e.qty ?? 0));
      order.state = order.filled >= order.intent.micros ? 'filled' : 'partial';
    } else if (e.kind === 'reject') {
      order.state = 'rejected';
      order.note = 'Rejected by the broker';
    } else if (e.kind === 'cancel') {
      order.state = order.filled ? 'partial' : 'cancelled';
      order.note = order.filled ? `Cancelled with ${order.filled} of ${order.intent.micros} filled` : 'Cancelled';
    } else if (e.kind === 'bracket') order.bracket = true;
    return 'applied';
  }
}

/** A broker that can be told to misbehave: for proving the order manager, never for trading. */
export class SandboxBroker implements BrokerAdapter {
  readonly id = 'sandbox';
  readonly environment = 'sandbox' as const;
  private up = true;
  private book = new Map<string, BrokerAck>();
  private seq = 0;
  /** What the next order does. */
  next: 'fill' | 'partial' | 'reject' | 'timeout-lost' | 'timeout-arrived' | 'no-bracket' = 'fill';
  accountAt: number;
  balance = 25_000;
  /** Every order that actually reached this broker, by key: an order here twice would be a bug. */
  placed: string[] = [];
  flattened: string[] = [];

  constructor(private clock: () => number = Date.now) {
    this.accountAt = clock();
  }

  connected() {
    return this.up;
  }
  disconnect() {
    this.up = false;
  }
  reconnect() {
    this.up = true;
    this.accountAt = this.clock();
  }

  async place(intent: OrderIntent): Promise<BrokerAck> {
    if (!this.up) throw new Error('Not connected');
    const mode = this.next;
    this.next = 'fill';
    if (mode === 'timeout-lost') throw new BrokerTimeout();
    this.placed.push(intent.key);
    const ack: BrokerAck =
      mode === 'reject' ? { brokerId: `SB-${++this.seq}`, state: 'rejected', filled: 0, bracket: false, reason: 'Insufficient margin' }
      : mode === 'partial' ? { brokerId: `SB-${++this.seq}`, state: 'partial', filled: Math.max(1, Math.floor(intent.micros / 2)), bracket: true }
      : mode === 'no-bracket' ? { brokerId: `SB-${++this.seq}`, state: 'filled', filled: intent.micros, bracket: false }
      : { brokerId: `SB-${++this.seq}`, state: 'filled', filled: intent.micros, bracket: true };
    this.book.set(intent.key, ack);
    if (mode === 'timeout-arrived') throw new BrokerTimeout();
    return ack;
  }

  async status(key: string): Promise<BrokerAck | null> {
    if (!this.up) throw new Error('Not connected');
    return this.book.get(key) ?? null;
  }

  async flatten(key: string): Promise<void> {
    this.flattened.push(key);
  }

  async account(_id: string): Promise<{ balance: number; at: number } | null> {
    return this.up ? { balance: this.balance, at: this.accountAt } : null;
  }
}

/** What each connection can do today. `unverified` means nobody has checked it against the provider: it is not a yes. */
export const BROKERS: BrokerCapability[] = [
  { id: 'paper', name: 'The office’s paper book', data: 'wired', accounts: 'wired', orders: 'sandbox', note: 'Simulated fills on the office’s own bars. What every forward run uses.' },
  { id: 'projectx', name: 'ProjectX / TopstepX', data: 'wired', accounts: 'wired', orders: 'none', note: 'Wired read-only: real-time bars and your accounts’ balances and fills. No order route is built.' },
  { id: 'tradovate', name: 'Tradovate', data: 'unverified', accounts: 'unverified', orders: 'unverified', note: 'What Lucid accounts are commonly traded through. API rights, data permissions and costs are unverified.' },
  { id: 'rithmic', name: 'Rithmic', data: 'unverified', accounts: 'unverified', orders: 'unverified', note: 'Unverified. A chart subscription does not grant API access.' },
  { id: 'tradingview', name: 'TradingView alerts', data: 'wired', accounts: 'none', orders: 'none', note: 'Bar closes and alerts arrive by webhook. It cannot report an account or take an order back.' },
];

/** Every selected market needs its own recent, entitled feed; BTC cannot stand in for CME. */
export function feedsReady(feeds: Partial<Record<Symbol, { delayed: boolean; stale: boolean; ageSec: number | null }>>, markets: Symbol[]): boolean {
  return markets.length > 0 && markets.every(symbol => {
    const f = feeds[symbol];
    return !!f && !f.delayed && !f.stale && f.ageSec != null && Number.isFinite(f.ageSec) && f.ageSec >= 0 && f.ageSec <= 240;
  });
}

export interface ReadinessContext {
  /** The program a run trades allows automation, by its rule set. */
  automation: 'allowed' | 'prohibited' | 'unknown' | null;
  rulesVerified: boolean;
  /** A forward run has cleared the release gate. */
  gateMet: boolean;
  /** A candidate has held up on the holdout under stressed costs. */
  holdoutHeld: boolean;
  realTimeData: boolean;
  projectxConnected: boolean;
}

/** Everything that has to be true before an order could be sent, and whether it is. Most of it isn't, and that's the honest state. */
export function readiness(c: ReadinessContext): ReadinessItem[] {
  return [
    { label: 'The firm allows automation', state: c.automation === 'allowed' && c.rulesVerified ? 'ready' : 'blocked', detail: c.automation == null ? 'No forward run to check' : c.automation === 'allowed' ? (c.rulesVerified ? 'Read on the firm’s own pages. Its API access is a separate question, below.' : 'Reported, not read on the firm’s pages') : c.automation === 'prohibited' ? 'This firm prohibits automated execution: manual only, with the office advising' : 'Not known for this program' },
    { label: 'Forward evidence', state: c.gateMet ? 'ready' : 'blocked', detail: c.gateMet ? 'A run has 30 forward sessions and 100 closed forward trades' : 'No run has 30 forward sessions and 100 closed forward trades yet' },
    { label: 'Holdout under stressed costs', state: c.holdoutHeld ? 'ready' : 'blocked', detail: c.holdoutHeld ? 'A candidate held up on the untouched days' : 'No candidate has been taken to the holdout and held' },
    { label: 'Real-time data', state: c.realTimeData ? 'ready' : 'blocked', detail: c.realTimeData ? 'Every selected market has recent, non-delayed bars' : 'A selected futures feed is delayed, stale or missing: research only' },
    { label: 'Account reconciliation', state: c.projectxConnected ? 'ready' : 'blocked', detail: c.projectxConnected ? 'ProjectX reports balances and fills, read-only' : 'No broker reports your accounts: balances are typed in by hand' },
    { label: 'Order lifecycle proven in a sandbox', state: 'blocked', detail: 'Sandbox components exist; complete fault-path integration coverage and broker-specific validation are still pending' },
    { label: 'A supported order route', state: 'missing', detail: 'None. No provider’s order API has been verified for a prop account, so no live adapter exists in this build.' },
    { label: 'Your decision to arm it', state: 'missing', detail: 'A separate step, by you, after reviewing all of the above. Nothing here does it for you.' },
  ];
}
