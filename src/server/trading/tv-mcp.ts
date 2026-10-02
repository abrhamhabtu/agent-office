import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, chmodSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthTokens, OAuthClientInformationMixed } from '@modelcontextprotocol/sdk/shared/auth.js';

export const TV_MCP_URL = 'https://mcp.tradingview.com/mcp';
export const TV_MCP_TOOLS = ['get_ohlcv', 'get_technicals_rating', 'search_symbols', 'get_economic_calendar'] as const;
export type TvTool = typeof TV_MCP_TOOLS[number];

/** Restrict this connection to bounded, read-only research requests, never arbitrary MCP calls. */
export function tvRequest(raw: unknown): { name: TvTool; arguments: Record<string, unknown> } {
  const b = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  if (!TV_MCP_TOOLS.includes(b.tool as TvTool)) throw new Error('Choose a supported read-only research tool');
  const name = b.tool as TvTool;
  if (name === 'get_economic_calendar') return { name, arguments: { countries: 'US', min_importance: 1 } };
  if (name === 'search_symbols') {
    if (typeof b.symbol !== 'string' || !b.symbol.trim() || b.symbol.length > 80) throw new Error('Enter a symbol to search');
    return { name, arguments: { query: b.symbol.trim(), type_filter: 'futures' } };
  }
  if (typeof b.symbol !== 'string' || !/^[A-Z0-9_]{1,30}:[A-Z0-9_.!\-]{1,40}$/.test(b.symbol)) throw new Error('Use an exchange-qualified symbol, such as CME_MINI:MNQ1!');
  return { name, arguments: { symbol: b.symbol, interval: '1m', ...(name === 'get_ohlcv' ? { count: 100, summary: false } : {}) } };
}

type Saved = { redirectUrl?: string; client?: OAuthClientInformationMixed; tokens?: OAuthTokens };
export class TvMcp implements OAuthClientProvider {
  private saved: Saved = {};
  private pending?: { state: string; verifier?: string; expires: number };
  private authorizationUrl?: string;
  private busy = false;
  private lastCall = 0;
  private file: string;
  constructor(dir: string, owner: string, readonly redirectUrl: string, private network: typeof fetch = boundedFetch) {
    this.file = path.join(dir, `tradingview-mcp-${createHash('sha256').update(owner).digest('hex').slice(0, 24)}.json`);
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as Saved;
      if (saved.redirectUrl === redirectUrl) this.saved = saved;
    } catch { /* not connected */ }
  }
  get clientMetadata() {
    return { scope: 'mcp:read', client_name: 'Opening Bell research', redirect_uris: [this.redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
  }
  clientInformation() { return this.saved.client; }
  saveClientInformation(client: OAuthClientInformationMixed) { this.saved.client = client; this.save(); }
  tokens() { return this.saved.tokens; }
  saveTokens(tokens: OAuthTokens) { this.saved.tokens = tokens; this.save(); }
  state() { if (!this.pending) throw new Error('Start sign-in from Connections'); return this.pending.state; }
  saveCodeVerifier(verifier: string) { if (!this.pending) throw new Error('No sign-in in progress'); this.pending.verifier = verifier; }
  codeVerifier() { if (!this.pending?.verifier) throw new Error('Sign-in expired; start again'); return this.pending.verifier; }
  redirectToAuthorization(url: URL) {
    if (url.protocol !== 'https:' || !(url.hostname === 'tradingview.com' || url.hostname.endsWith('.tradingview.com'))) throw new Error('Unexpected authorization destination');
    this.authorizationUrl = url.href;
  }
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    if (scope === 'all' || scope === 'client') delete this.saved.client;
    if (scope === 'all' || scope === 'tokens') delete this.saved.tokens;
    if (scope === 'verifier' && this.pending) delete this.pending.verifier;
    this.save();
  }
  private save() {
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify({ ...this.saved, redirectUrl: this.redirectUrl }), { mode: 0o600 });
    chmodSync(`${this.file}.tmp`, 0o600);
    renameSync(`${this.file}.tmp`, this.file);
  }
  status() { return { configured: !!this.saved.tokens, busy: this.busy, server: TV_MCP_URL, tools: TV_MCP_TOOLS }; }
  accepts(state: string) { return !!state && this.pending?.state === state && this.pending.expires > Date.now(); }
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('A TradingView request is already in progress');
    this.busy = true;
    try { return await fn(); } finally { this.busy = false; }
  }
  async begin() {
    return this.exclusive(async () => {
      this.pending = { state: randomBytes(32).toString('base64url'), expires: Date.now() + 10 * 60_000 };
      this.authorizationUrl = undefined;
      const result = await auth(this, { serverUrl: TV_MCP_URL, fetchFn: this.network });
      if (result === 'REDIRECT' && !this.authorizationUrl) throw new Error('TradingView did not return a sign-in URL');
      if (result === 'AUTHORIZED') this.pending = undefined;
      return { authorized: result === 'AUTHORIZED', url: this.authorizationUrl };
    });
  }
  async finish(state: string, code: string) {
    return this.exclusive(async () => {
      if (!this.accepts(state) || !code || code.length > 4096) throw new Error('Invalid or expired sign-in; start again from Connections');
      // Consume state before the network request; keep the verifier only for this exchange.
      this.pending!.state = '';
      try {
        const result = await auth(this, { serverUrl: TV_MCP_URL, authorizationCode: code, fetchFn: this.network });
        if (result !== 'AUTHORIZED') throw new Error('TradingView authorization did not finish');
      } finally { this.pending = undefined; this.authorizationUrl = undefined; }
    });
  }
  async disconnect() {
    return this.exclusive(async () => {
      this.saved = {}; this.pending = undefined;
      rmSync(this.file, { force: true });
      return { ok: true };
    });
  }
  async research(raw: unknown) {
    const request = tvRequest(raw);
    return this.exclusive(async () => {
      if (!this.saved.tokens) throw new Error('Connect TradingView first');
      if (Date.now() - this.lastCall < 3000) throw new Error('Wait three seconds between research requests');
      this.lastCall = Date.now();
      const client = new Client({ name: 'opening-bell-research', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(TV_MCP_URL), { authProvider: this, fetch: this.network });
      try {
        await client.connect(transport, { timeout: 20000 });
        const result = await client.callTool(request, undefined, { timeout: 20000 });
        // Preserve the provider's timestamps/delay fields. Never relabel this as the office's live feed.
        return { tool: request.name, requestedAt: Date.now(), source: 'TradingView MCP', result };
      } catch { throw new Error('TradingView research failed. Check your paid plan, symbol, connection and provider availability; reconnect if authorization expired.'); }
      finally { await client.close().catch(() => {}); }
    });
  }
}

// Only the official service and its authorization host may receive requests/tokens.
const boundedFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.protocol !== 'https:' || !(url.hostname === 'tradingview.com' || url.hostname.endsWith('.tradingview.com'))) throw new Error('Unexpected TradingView endpoint');
  return fetch(input, { ...init, redirect: 'error', signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000) });
};
