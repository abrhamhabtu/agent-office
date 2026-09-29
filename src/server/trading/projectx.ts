import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { JournalInfo, JournalTrade } from '../../shared/trading.js';

// The journal's feed: ProjectX, the platform under TopstepX, Lucid and Top One accounts (the same
// connection Trade Pilot uses). Read-only: it logs in with the API key, lists the accounts with their
// balances, and reads today's fills. It never places, changes or cancels an order.

const DEFAULT_BASE = 'https://api.topstepx.com/api';
const SYNC_EVERY = 60_000;

interface Saved {
  userName: string;
  apiKey: string;
  baseUrl: string;
}

interface Fill {
  id: number;
  accountId: number;
  contractId: string;
  creationTimestamp: string;
  price: number;
  profitAndLoss: number | null;
  fees: number;
  side: number;
  size: number;
  voided: boolean;
}

/** Only an https ProjectX gateway: a typo can't send the API key somewhere else in plain text. */
export function gatewayUrl(raw: unknown): string | null {
  if (raw == null || raw === '') return DEFAULT_BASE;
  if (typeof raw !== 'string' || raw.length > 200) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    return `${u.origin}${u.pathname.replace(/\/+$/, '') || '/api'}`;
  } catch {
    return null;
  }
}

/** Round trips from fills: each closing fill (the one with a P&L) against the entries it closed. */
export function tradesFromFills(fills: Fill[], accountId: number): JournalTrade[] {
  const lots = new Map<string, { fill: Fill; left: number }[]>();
  const out: JournalTrade[] = [];
  for (const f of [...fills].sort((a, b) => Date.parse(a.creationTimestamp) - Date.parse(b.creationTimestamp) || a.id - b.id)) {
    if (f.accountId !== accountId || f.voided || !(f.size > 0)) continue;
    const queue = lots.get(f.contractId) ?? [];
    lots.set(f.contractId, queue);
    if (f.profitAndLoss == null) {
      queue.push({ fill: f, left: f.size });
      continue;
    }
    let left = f.size;
    let value = 0;
    let qty = 0;
    let opened = f.creationTimestamp;
    while (left > 0 && queue.length && queue[0]!.fill.side !== f.side) {
      const lot = queue[0]!;
      const n = Math.min(left, lot.left);
      if (!qty) opened = lot.fill.creationTimestamp;
      value += lot.fill.price * n;
      qty += n;
      lot.left -= n;
      left -= n;
      if (!lot.left) queue.shift();
    }
    if (!qty) continue;
    const symbol = /\.([A-Z0-9]+)\.[A-Z]\d+$/i.exec(f.contractId)?.[1] ?? f.contractId;
    out.push({
      id: `px:${accountId}:${f.id}`,
      accountId: String(accountId),
      symbol,
      // Closing with a sell (side 1) means the position was long.
      side: f.side === 1 ? 'long' : 'short',
      qty,
      entryAt: Date.parse(opened),
      exitAt: Date.parse(f.creationTimestamp),
      entry: value / qty,
      exit: f.price,
      pnl: Math.round((f.profitAndLoss - f.fees) * 100) / 100,
      playbook: null,
    });
  }
  return out;
}

export class ProjectX {
  private file: string;
  private saved: Saved | null = null;
  private token: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private info: JournalInfo = { connected: false, userName: null, error: null, accounts: [], today: [], syncedAt: null };

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'trading', 'projectx.json');
    try {
      const s = JSON.parse(readFileSync(this.file, 'utf8')) as Saved;
      if (typeof s.userName === 'string' && typeof s.apiKey === 'string') this.saved = { ...s, baseUrl: gatewayUrl(s.baseUrl) ?? DEFAULT_BASE };
    } catch {
      // Not connected yet.
    }
  }

  start() {
    if (this.saved) void this.sync();
    this.timer = setInterval(() => void this.sync(), SYNC_EVERY);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  state(): JournalInfo {
    return { ...this.info, userName: this.saved?.userName ?? null };
  }

  private async call(pathName: string, body: unknown, token?: string): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.saved!.baseUrl}/${pathName}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 401) {
      this.token = null;
      throw new Error('Session expired');
    }
    if (!res.ok) throw new Error(`ProjectX answered ${res.status}`);
    const data = (await res.json()) as Record<string, unknown>;
    if (!data.success) throw new Error(typeof data.errorMessage === 'string' && data.errorMessage ? data.errorMessage : 'ProjectX declined the request: check the API key and its permissions');
    return data;
  }

  private async login() {
    const auth = await this.call('Auth/loginKey', { userName: this.saved!.userName, apiKey: this.saved!.apiKey });
    if (typeof auth.token !== 'string' || !auth.token) throw new Error('ProjectX did not return a session');
    this.token = auth.token;
  }

  /** Saves the login and checks it works. The key is kept on this machine only, readable by its owner. */
  async connect(userName: unknown, apiKey: unknown, baseUrl: unknown): Promise<string | undefined> {
    if (typeof userName !== 'string' || !userName.trim() || userName.length > 200) return 'Enter your ProjectX username';
    if (typeof apiKey !== 'string' || !apiKey || apiKey.length > 4096) return 'Enter your ProjectX API key';
    const base = gatewayUrl(baseUrl);
    if (!base) return 'The gateway has to be an https:// address';
    const before = this.saved;
    this.saved = { userName: userName.trim(), apiKey, baseUrl: base };
    this.token = null;
    try {
      await this.login();
    } catch (e) {
      this.saved = before;
      return (e as Error).message;
    }
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.saved), { mode: 0o600 });
    chmodSync(this.file, 0o600);
    await this.sync();
    return undefined;
  }

  disconnect() {
    this.saved = null;
    this.token = null;
    this.info = { connected: false, userName: null, error: null, accounts: [], today: [], syncedAt: null };
    rmSync(this.file, { force: true });
  }

  private async sync() {
    if (!this.saved) return;
    try {
      if (!this.token) await this.login();
      const data = await this.call('Account/search', { onlyActiveAccounts: true }, this.token!);
      const accounts = ((data.accounts as { id: number; name: string; balance: number; canTrade: boolean }[]) ?? []).map((a) => ({ id: a.id, name: String(a.name), balance: Number(a.balance), canTrade: !!a.canTrade }));
      // Today in the futures sense: since the 15:00 PT Globex open.
      const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
      const today: JournalTrade[] = [];
      for (const a of accounts.slice(0, 12)) {
        const h = await this.call('Trade/search', { accountId: a.id, startTimestamp: since, endTimestamp: new Date().toISOString() }, this.token!);
        today.push(...tradesFromFills((h.trades as Fill[]) ?? [], a.id));
      }
      this.info = { connected: true, userName: this.saved.userName, error: null, accounts, today: today.sort((x, y) => y.exitAt - x.exitAt), syncedAt: Date.now() };
    } catch (e) {
      this.info = { ...this.info, connected: false, error: (e as Error).message };
    }
  }
}
