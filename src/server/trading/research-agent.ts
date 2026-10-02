import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import type { PaperTrade, PlaybookId } from '../../shared/trading.js';
import { decide, parseDecision, regimeDecider, REGIME_MODEL, shadowSummary, type Decider, type DecisionRecord, type DecisionRequest, type Feature, type ModelInfo, type ShadowSummary } from '../../shared/research-decision.js';
import { COSTS, withCosts, type CostId } from '../../shared/fills.js';
import { fingerprint } from '../../shared/validation.js';
import type { ForwardDecision } from '../../shared/propfarm.js';

// The adaptive lane, in the shadow. Every setup the playbooks call on a forward run is also put to a
// model (a statistical one by default; an agent when the owner points the office at one), which answers
// take or abstain. Its answers are recorded and scored against the deterministic baseline, and that is
// all: it trades nothing, sizes nothing and changes no limit. It stays here until its record shows it
// adds something over taking every setup, and the owner decides what to do about that.
//
// A decision is asked for once, when the setup is first seen, with only what was known then. Scoring
// reads the record. Nothing is ever re-asked about the past.

/** A setup as the lane is asked about it: the indicators on its bar, all known when the bar closed. */
export function requestOf(d: Pick<ForwardDecision, 'id' | 'signalAt' | 'symbol' | 'side' | 'playbook' | 'ind'>, approved: PlaybookId[]): DecisionRequest {
  const i = d.ind;
  const at = d.signalAt;
  const f = (name: string, value: number | null | undefined): Feature => ({ name, value: value ?? null, availableAt: at });
  const features: Feature[] = i
    ? [f('adx', i.adx), f('rsi', i.rsi), f('relVol', i.relVol), f('minute', i.m), f('macd', i.macd == null ? null : Math.round(i.macd * 100) / 100), f('atr', i.atr == null ? null : Math.round(i.atr * 100) / 100), f('aboveVwap', i.vwap == null || i.ema9 == null ? null : Number(i.ema9 > i.vwap)), f('emaStack', i.ema9 == null || i.ema21 == null ? null : Number(i.ema9 > i.ema21))]
    : [];
  return { id: d.id, at, symbol: d.symbol, side: d.side, playbook: d.playbook, features, approved };
}

/** The same request for a backtest trade (the statistical model can be replayed on history: it has no memory and no clock). */
export const requestOfTrade = (t: PaperTrade, approved: PlaybookId[]): DecisionRequest => requestOf({ id: t.id, signalAt: t.entryAt + 60_000, symbol: t.symbol, side: t.side, playbook: t.playbook, ind: t.ind ?? null }, approved);

/**
 * An agent as a command: the request goes in on stdin as JSON, and its answer is whatever it prints.
 * The office never trusts the answer: it is parsed and checked like any other (see parseDecision).
 */
export function commandDecider(command: string): Decider {
  return (req) =>
    new Promise<string>((resolve, reject) => {
      const child = spawn(command, { shell: true, stdio: ['pipe', 'pipe', 'ignore'] });
      let out = '';
      const kill = setTimeout(() => child.kill('SIGKILL'), 30_000);
      child.stdout.on('data', (c: Buffer) => {
        if (out.length < 8000) out += c.toString('utf8');
      });
      child.on('error', (e) => {
        clearTimeout(kill);
        reject(e);
      });
      child.on('close', () => {
        clearTimeout(kill);
        // An agent may wrap its answer in prose: the first JSON object in what it printed is the answer.
        const m = /\{[\s\S]*\}/.exec(out);
        resolve(m ? m[0] : out);
      });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify({ instructions: 'Answer with one JSON object: {"action":"take"|"abstain","regime":"trend"|"range"|"unclear","confidence":0..1,"reason":"…"}. Nothing else. You cannot set a size, a stop or a target.', request: req }));
    });
}

/** The model the lane uses: the owner's command when one is set (AGENT_OFFICE_ADAPTIVE_CMD), the statistical model otherwise. */
export function laneModel(env: NodeJS.ProcessEnv = process.env): { model: ModelInfo; decider: Decider; adapter: string } {
  const cmd = env.AGENT_OFFICE_ADAPTIVE_CMD?.trim();
  if (cmd) return { model: { id: 'command', version: fingerprint(cmd).slice(0, 8), kind: 'agent' }, decider: commandDecider(cmd), adapter: 'An agent, through the command in AGENT_OFFICE_ADAPTIVE_CMD' };
  return { model: REGIME_MODEL, decider: regimeDecider, adapter: 'The statistical regime model (ADX and volume). Set AGENT_OFFICE_ADAPTIVE_CMD to put an agent in the lane instead.' };
}

const KEEP = 4000;

export class ShadowLane {
  private records = new Map<string, DecisionRecord>();
  private asking = new Set<string>();
  private dirty = false;

  constructor(private file: string | null, readonly model: ModelInfo, private decider: Decider | null, readonly adapter = '', private o: { budgetMs?: number; clock?: () => number } = {}) {
    try {
      const raw = JSON.parse(readFileSync(file ?? '', 'utf8')) as DecisionRecord[];
      if (Array.isArray(raw)) for (const r of raw) if (r?.request?.id) this.records.set(r.request.id, r);
    } catch {
      // Nothing asked yet.
    }
  }

  flush() {
    if (!this.dirty || !this.file) return;
    this.dirty = false;
    try {
      writeFileSync(this.file, JSON.stringify([...this.records.values()].slice(-KEEP)));
    } catch {
      // Kept in memory until the next save.
    }
  }

  has(id: string) {
    return this.records.has(id) || this.asking.has(id);
  }
  all(): DecisionRecord[] {
    return [...this.records.values()];
  }

  /** Asks the model about a setup, once. A setup already asked about (or being asked) is left alone. */
  async consider(d: ForwardDecision, approved: PlaybookId[]): Promise<DecisionRecord | null> {
    if (this.has(d.id)) return this.records.get(d.id) ?? null;
    // Only a decision that is still open can be asked about: afterwards it would be hindsight.
    if (d.kind !== 'forward' || d.outcome) return null;
    this.asking.add(d.id);
    try {
      const rec = await decide(requestOf(d, approved), this.model, this.decider, this.o);
      this.records.set(d.id, rec);
      this.dirty = true;
      return rec;
    } finally {
      this.asking.delete(d.id);
    }
  }

  /** A record read back: the decision it holds, re-checked from the raw response. The model is not asked again. */
  static replay(r: DecisionRecord) {
    return r.raw ? parseDecision(r.raw, r.request) : { decision: r.decision, valid: r.valid, problems: r.problems };
  }

  /** How the lane stands against taking every setup, on the decisions that have closed. In R after costs. */
  summary(decisions: ForwardDecision[], cost: CostId): ShadowSummary {
    const outcomes = new Map<string, number>();
    for (const d of decisions) {
      if (!d.outcome || d.outcome.result === 'void') continue;
      const [net] = withCosts([{ symbol: d.symbol, outcome: d.outcome.result as 'win' | 'loss' | 'time', dollars: d.outcome.dollars, r: d.outcome.r, entry: d.entry, stop: d.stop }], COSTS[cost]);
      outcomes.set(d.id, net!.r);
    }
    return shadowSummary(this.model, this.all(), outcomes);
  }
}

/**
 * The statistical model replayed over backtest trades, for the research queue. Honest for this model only:
 * it is a fixed rule over numbers that were known at each entry. An agent can't be replayed this way.
 */
export async function shadowBacktest(trades: PaperTrade[], approved: PlaybookId[], cost: CostId): Promise<{ summary: ShadowSummary; records: DecisionRecord[] }> {
  const records: DecisionRecord[] = [];
  const outcomes = new Map<string, number>();
  const closed = trades.filter((t) => t.outcome !== 'open');
  const net = withCosts(closed, COSTS[cost]);
  for (let i = 0; i < closed.length; i++) {
    const t = closed[i]!;
    records.push(await decide(requestOfTrade(t, approved), REGIME_MODEL, regimeDecider, { clock: () => t.entryAt + 60_000 }));
    outcomes.set(t.id, net[i]!.r);
  }
  return { summary: shadowSummary(REGIME_MODEL, records, outcomes), records };
}
