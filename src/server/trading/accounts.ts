import { readFileSync, writeFileSync } from 'node:fs';
import { confirmPass, DaySession, denyPayout, openAccount, requestPayout, settlePayout, type Account, type DayReport, type LedgerEvent, type LedgerFill } from '../../shared/account-ledger.js';
import { ruleSetById, ruleSetFor, type RuleSet } from '../../shared/prop-rules.js';

// The owner's own prop accounts, tracked by hand. Each one is an instance with its own identity and its
// own ledger: five accounts bought on one program are five ledgers, not one. An account keeps the rule
// set it was opened on, so a firm changing its website doesn't change an account that's already running.
//
// The office cannot see these accounts: every number on them is one the owner typed in. So nothing here
// decides anything about the real account. A pass is "pending" until the owner says the firm confirmed
// it; a payout is "requested" until the owner says what arrived. The same ledger and the same rules
// check them as check the simulated accounts, which is the point: one set of rules, applied one way.

export interface TrackedAccount {
  account: Account;
  /** What the owner logged, a day at a time: the day's result and how many trades. */
  days: (DayReport & { trades: number })[];
  events: LedgerEvent[];
  note: string;
  addedAt: number;
}

interface Stored {
  accounts: TrackedAccount[];
  seq: number;
}

const KEEP_EVENTS = 300;

export class AccountBook {
  private data: Stored = { accounts: [], seq: 0 };

  constructor(private file: string | null) {
    try {
      const raw = JSON.parse(readFileSync(file ?? '', 'utf8')) as Stored;
      if (raw && Array.isArray(raw.accounts)) this.data = { accounts: raw.accounts.filter((a) => a?.account?.id && ruleSetById(a.account.ruleSetId)), seq: Number(raw.seq) || raw.accounts.length };
    } catch {
      // No tracked accounts yet.
    }
  }

  private save() {
    if (!this.file) return;
    try {
      writeFileSync(this.file, JSON.stringify(this.data, null, 1), { mode: 0o600 });
    } catch {
      // Kept in memory until the next save.
    }
  }

  list(): TrackedAccount[] {
    return this.data.accounts;
  }
  get(id: string): TrackedAccount | undefined {
    return this.data.accounts.find((a) => a.account.id === id);
  }
  rules(t: TrackedAccount): RuleSet {
    return ruleSetById(t.account.ruleSetId)!;
  }

  private log(t: TrackedAccount) {
    return (e: LedgerEvent) => {
      t.events.push({ ...e, at: e.at || Date.now() });
      if (t.events.length > KEEP_EVENTS) t.events.splice(0, t.events.length - KEEP_EVENTS);
    };
  }

  /** A new account on a rule set (its newest cohort), with the fee that was paid for it. */
  add(o: { ruleSetId: string; label?: string; fee?: number; day: string; now: number; balance?: number }): TrackedAccount | string {
    const rules = ruleSetById(o.ruleSetId);
    if (!rules) return 'Pick a program and size';
    if (this.data.accounts.filter((a) => a.account.status !== 'retired' && a.account.status !== 'breached' && a.account.status !== 'passed').length >= 20) return 'Twenty open accounts is the most this tracks';
    const fee = Number.isFinite(o.fee) && o.fee! >= 0 && o.fee! < 1e5 ? Math.round(o.fee!) : rules.fee ?? 0;
    const n = ++this.data.seq;
    const id = `${rules.phase === 'eval' ? 'MY-EVAL' : 'MY-FUNDED'}-${n}`;
    const account = openAccount(rules, { id, label: (o.label ?? '').trim().slice(0, 40) || `${rules.firm} ${rules.program} #${n}`, environment: 'manual', day: o.day, fee });
    const t: TrackedAccount = { account, days: [], events: [], note: '', addedAt: o.now };
    this.log(t)({ at: o.now, day: o.day, account: id, kind: 'opened', text: `${account.label} added${fee ? `, $${fee} paid` : ''}. Rules: ${rules.id}.`, amount: -fee });
    this.data.accounts.unshift(t);
    this.save();
    return t;
  }

  /**
   * One day of an account as the owner reports it: what it made or lost, over how many trades, and (when
   * they know it) the worst it stood during the day. It goes through the same ledger as a simulated day.
   */
  logDay(id: string, o: { day: string; pnl: number; trades?: number; worst?: number; now: number }): string | undefined {
    const t = this.get(id);
    if (!t) return 'No such account';
    const rules = this.rules(t);
    if (!Number.isFinite(o.pnl) || Math.abs(o.pnl) > rules.size) return 'That result doesn’t look right for this account';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(o.day)) return 'Which day was it?';
    if (t.days.some((d) => d.day === o.day)) return `${o.day} is already logged: a day is logged once`;
    if (t.days.length && o.day < t.days[t.days.length - 1]!.day) return 'Days are logged in order';
    const trades = Math.max(0, Math.min(200, Math.round(o.trades ?? (o.pnl === 0 ? 0 : 1))));
    const worst = Number.isFinite(o.worst) ? Math.max(0, o.worst!) : Math.max(0, -o.pnl);
    const session = new DaySession(t.account, rules, o.day, this.log(t));
    if (trades > 0) {
      // The day as one position: its result, and the worst it stood. Dollars as points at a dollar a point.
      const at = Date.parse(`${o.day}T14:00:00Z`);
      const fill: LedgerFill = { id: `${id}:${o.day}`, day: o.day, symbol: 'NQ', side: 'long', micros: 1, entryAt: at, exitAt: at + 3_600_000, pointValue: 1, stopPoints: Math.max(worst, Math.abs(o.pnl)), pnlPoints: o.pnl, mae: Math.max(worst, Math.max(0, -o.pnl)), mfe: Math.max(0, o.pnl), maeAt: at + 60_000, mfeAt: at + 3_000_000, costs: 0, approx: !Number.isFinite(o.worst), label: `Logged ${trades} trade${trades === 1 ? '' : 's'}` };
      const why = session.add(fill);
      if (why) return `This account can’t trade: ${why}`;
    }
    const rep = session.close();
    t.days.push({ ...rep, trades });
    if (t.days.length > 400) t.days.shift();
    this.save();
    return undefined;
  }

  /** The firm confirmed the pass: the evaluation is closed and a funded account is opened, linked to it. */
  confirmPass(id: string, o: { day: string; now: number }): TrackedAccount | string {
    const t = this.get(id);
    if (!t) return 'No such account';
    const why = confirmPass(t.account, o.day, this.log(t));
    if (why) return why;
    const eval_ = this.rules(t);
    const funded = ruleSetFor(eval_.template, 'funded');
    this.save();
    if (!funded) return t;
    const next = this.add({ ruleSetId: funded.id, label: t.account.label.replace(/#(\d+)$/, 'funded #$1'), fee: 0, day: o.day, now: o.now });
    if (typeof next === 'string') return next;
    next.account.linked = t.account.id;
    t.account.linked = next.account.id;
    this.save();
    return next;
  }

  request(id: string, o: { day: string; amount?: number; key: string }): string | undefined {
    const t = this.get(id);
    if (!t) return 'No such account';
    const why = requestPayout(t.account, this.rules(t), o.day, { key: o.key, ...(o.amount != null ? { amount: o.amount } : {}) }, this.log(t));
    if (!why) this.save();
    return why ?? undefined;
  }

  /** The owner says what was actually withdrawn: all of the request, or part of it. */
  settle(id: string, o: { day: string; withdrawn?: number }): { error: string } | { received: number; withdrawn: number } {
    const t = this.get(id);
    if (!t) return { error: 'No such account' };
    const out = settlePayout(t.account, this.rules(t), o.day, o.withdrawn != null ? { withdrawn: o.withdrawn } : {}, this.log(t));
    if (!('error' in out)) this.save();
    return out;
  }

  deny(id: string, o: { day: string; reason: string }): string | undefined {
    const t = this.get(id);
    if (!t) return 'No such account';
    const why = denyPayout(t.account, o.day, o.reason.slice(0, 120), this.log(t));
    if (!why) this.save();
    return why ?? undefined;
  }

  /** Marks an account as needing a look (a state the office can't make sense of), retires it, or takes it off the list. */
  setStatus(id: string, status: 'review' | 'retired' | 'active' | 'removed', o: { day: string; now: number }): string | undefined {
    const t = this.get(id);
    if (!t) return 'No such account';
    if (status === 'removed') this.data.accounts = this.data.accounts.filter((x) => x !== t);
    else {
      if (status === 'active' && t.account.status !== 'review') return 'Only an account under review can be put back';
      if (t.account.request && status !== 'review') return 'A payout is waiting on it: reconcile that first';
      t.account.status = status;
      t.account.why = status === 'review' ? 'Marked for review: no new trades until it is cleared' : status === 'retired' ? 'Retired by you' : 'Cleared after review';
      this.log(t)({ at: o.now, day: o.day, account: id, kind: status === 'retired' ? 'retired' : 'note', text: t.account.why, amount: 0 });
    }
    this.save();
    return undefined;
  }
}
