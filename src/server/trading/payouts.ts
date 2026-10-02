import { readFileSync, writeFileSync } from 'node:fs';
import { cushionOf, floorOf, payoutCheck, requestPayout, settlePayout, type Account, type Environment } from '../../shared/account-ledger.js';
import type { RuleSet } from '../../shared/prop-rules.js';
import type { PayoutEntry, PayoutRow } from '../../shared/propfarm.js';
import type { AccountBook } from './accounts.js';

// The payout ledger. Three different things get called "a payout" and they are kept apart here:
//
//   eligible    the rules say a request could be made, and for how much. An estimate.
//   requested   the owner asked the firm for it. The account is parked: nothing trades it.
//   received    the owner says the money arrived, and how much. Only this is cash.
//
// A winning notification is none of them. Nothing is inferred: an entry exists because the owner made
// it (on an account they track) or because the simulation did (on a paper account, and marked as such).
// Each request has a key, so a double click or a repeated message can't request twice.

/** Where an account would stand once its payout is requested and paid: the floor, the cushion and the contract limit. */
function after(a: Account, rules: RuleSet, amount: number): { floor: number; cushion: number; micros: number } {
  const copy: Account = { ...a, cycle: { ...a.cycle }, seenRequests: [...a.seenRequests], request: a.request ? { ...a.request } : null };
  if (!copy.request && amount > 0) requestPayout(copy, rules, '', { key: 'what-if', amount });
  if (copy.request) settlePayout(copy, rules, '');
  return { floor: Math.round(floorOf(copy, rules)), cushion: Math.round(cushionOf(copy, rules)), micros: copy.allowedMicros };
}

/** One account as the Payout Desk shows it: each condition, what is eligible, requested and received, and where it lands afterwards. */
export function payoutRow(a: Account, rules: RuleSet, source: Environment): PayoutRow | null {
  const p = rules.payout;
  if (!p || a.phase !== 'funded') return null;
  const check = payoutCheck(a, rules);
  const eligible = check.eligible ? check.amount : 0;
  const then = after(a, rules, a.request?.amount ?? eligible);
  return {
    account: a.id, label: a.label, source, firm: rules.firm, program: rules.program, status: a.status, checks: check.checks, eligible, requested: a.request?.amount ?? null, requestedOn: a.request?.day ?? null,
    received: a.received, payouts: a.payouts, payoutsAllowed: p.maxPayouts, floor: Math.round(floorOf(a, rules)), floorAfter: then.floor, cushionAfter: then.cushion, microsAfter: then.micros,
    next: a.status === 'parked' ? 'Once the withdrawal is reconciled' : a.status === 'retired' ? 'Never: the firm moves it on' : a.status === 'breached' ? 'Never: it is breached' : eligible ? 'Now, until you request the payout: then it parks' : 'Now',
    split: p.split,
  };
}

const KEEP = 500;

export class PayoutLedger {
  private entries: PayoutEntry[] = [];

  constructor(private file: string | null, private book: AccountBook) {
    try {
      const raw = JSON.parse(readFileSync(file ?? '', 'utf8')) as PayoutEntry[];
      if (Array.isArray(raw)) this.entries = raw.filter((e) => e && typeof e.id === 'string');
    } catch {
      // Nothing requested yet.
    }
  }

  private add(e: PayoutEntry) {
    this.entries.push(e);
    if (this.entries.length > KEEP) this.entries.splice(0, this.entries.length - KEEP);
    if (!this.file) return;
    try {
      writeFileSync(this.file, JSON.stringify(this.entries, null, 1), { mode: 0o600 });
    } catch {
      // Kept in memory until the next save.
    }
  }

  /** The owner's own entries, newest first. */
  log(): PayoutEntry[] {
    return [...this.entries].reverse();
  }

  /** The owner requested a payout on an account they track. `key` makes a repeat of the same request a no-op. */
  request(id: string, o: { day: string; now: number; amount?: number; key: string }): string | undefined {
    if (this.entries.some((e) => e.id === `${id}:${o.key}:requested`)) return 'That request was already made';
    const t = this.book.get(id);
    if (!t) return 'No such account';
    const why = this.book.request(id, { day: o.day, key: o.key, ...(o.amount != null ? { amount: o.amount } : {}) });
    if (why) return why;
    this.add({ id: `${id}:${o.key}:requested`, at: o.now, day: o.day, account: id, source: 'manual', kind: 'requested', amount: t.account.request!.amount, note: 'Parked until it is reconciled' });
    return undefined;
  }

  /** The owner says what left the account. Their share of that is what was received. */
  received(id: string, o: { day: string; now: number; withdrawn?: number }): string | undefined {
    const t = this.book.get(id);
    const req = t?.account.request;
    if (!t || !req) return 'No payout is waiting on that account';
    const out = this.book.settle(id, { day: o.day, ...(o.withdrawn != null ? { withdrawn: o.withdrawn } : {}) });
    if ('error' in out) return out.error;
    this.add({ id: `${id}:${req.key}:paid`, at: o.now, day: o.day, account: id, source: 'manual', kind: 'paid', amount: out.received, note: out.withdrawn < req.amount ? `Part payment: $${out.withdrawn} of the $${req.amount} requested` : `$${out.withdrawn} withdrawn` });
    return undefined;
  }

  denied(id: string, o: { day: string; now: number; reason: string }): string | undefined {
    const t = this.book.get(id);
    const req = t?.account.request;
    if (!t || !req) return 'No payout is waiting on that account';
    const why = this.book.deny(id, { day: o.day, reason: o.reason });
    if (why) return why;
    this.add({ id: `${id}:${req.key}:denied`, at: o.now, day: o.day, account: id, source: 'manual', kind: 'denied', amount: req.amount, note: o.reason.slice(0, 120) || 'Denied' });
    return undefined;
  }

  /** Cash the owner has confirmed receiving. */
  confirmedReceived(): number {
    return this.entries.filter((e) => e.kind === 'paid').reduce((a, e) => a + e.amount, 0);
  }
}
