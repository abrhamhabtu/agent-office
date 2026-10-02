import type { PlaybookId, Symbol } from './trading.js';
import { PLAYBOOK_BY_ID } from './trading.js';

// The adaptive lane's contract. Beside the deterministic lane (exact rules, the same inputs always give
// the same decision), an agent or a statistical model may look at a setup the playbooks have called and
// say one of two things: take it, or abstain. That is all it can say. It cannot name a size, a stop or a
// target: those belong to the playbook and the risk governor, and a response that tries to set them is
// invalid.
//
// Everything that goes wrong means abstain: a response that isn't the shape asked for, a model that is
// unavailable or answers late, a feature that wasn't known yet at the time of the decision. The request,
// the model and its version, the raw response and the checked decision are all recorded, and a replay
// reads the record: yesterday's candles are never put to today's model and called a live test.

export type Regime = 'trend' | 'range' | 'unclear';

export interface Feature {
  name: string;
  value: number | null;
  /** When this value was known. A feature from after the decision is a leak. */
  availableAt: number;
}

export interface DecisionRequest {
  /** The setup's id (the paper trade it would become). */
  id: string;
  /** When the decision is made: the signal bar's close. */
  at: number;
  symbol: Symbol;
  side: 'long' | 'short';
  playbook: PlaybookId;
  features: Feature[];
  /** The playbooks the lane may approve: the owner's approved list. */
  approved: PlaybookId[];
}

export interface AdaptiveDecision {
  action: 'take' | 'abstain';
  regime: Regime;
  confidence: number;
  reason: string;
}

export interface ModelInfo {
  id: string;
  version: string;
  kind: 'statistical' | 'agent';
}

export interface DecisionRecord {
  request: DecisionRequest;
  model: ModelInfo;
  /** What the model said, exactly as it said it. */
  raw: string;
  decision: AdaptiveDecision;
  /** The response was the shape asked for and broke no rule. */
  valid: boolean;
  problems: string[];
  askedAt: number;
  answeredAt: number;
}

const ABSTAIN = (reason: string): AdaptiveDecision => ({ action: 'abstain', regime: 'unclear', confidence: 0, reason });
/** Fields a response may not carry: a model that tries to set any of them is out of its lane. */
const FORBIDDEN = ['size', 'micros', 'contracts', 'quantity', 'qty', 'risk', 'stop', 'target', 'entry', 'leverage', 'account', 'override', 'max_loss', 'maxLoss'];

/** Features that were known when the decision was made; the rest are reported as problems. */
export function usableFeatures(req: DecisionRequest): { features: Feature[]; problems: string[] } {
  const late = req.features.filter((f) => f.availableAt > req.at);
  return { features: req.features.filter((f) => f.availableAt <= req.at), problems: late.map((f) => `Feature "${f.name}" wasn't known until after the decision`) };
}

/**
 * Reads a model's response. Anything other than a clean take is an abstain, and `problems` says why.
 * `raw` is the model's text (JSON) or an object it returned.
 */
export function parseDecision(raw: unknown, req: DecisionRequest): { decision: AdaptiveDecision; valid: boolean; problems: string[] } {
  const problems: string[] = [...usableFeatures(req).problems];
  const fail = (why: string) => ({ decision: ABSTAIN(why), valid: false, problems: [...problems, why] });
  let body: unknown = raw;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return fail('The model said nothing');
    if (text.length > 4000) return fail('The response is too long to be a decision');
    try {
      body = JSON.parse(text);
    } catch {
      return fail('The response isn’t JSON');
    }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('The response isn’t a decision');
  const b = body as Record<string, unknown>;
  const tried = Object.keys(b).filter((k) => FORBIDDEN.includes(k));
  if (tried.length) return fail(`The response tries to set ${tried.join(', ')}: the lane can only take or abstain`);
  if (b.action !== 'take' && b.action !== 'abstain') return fail('The action must be "take" or "abstain"');
  const confidence = typeof b.confidence === 'number' && Number.isFinite(b.confidence) ? b.confidence : NaN;
  if (!(confidence >= 0 && confidence <= 1)) return fail('The confidence must be a number from 0 to 1');
  const regime: Regime = b.regime === 'trend' || b.regime === 'range' ? b.regime : 'unclear';
  const reason = typeof b.reason === 'string' ? b.reason.replace(/\s+/g, ' ').trim().slice(0, 240) : '';
  if (b.playbook !== undefined && (typeof b.playbook !== 'string' || !(b.playbook in PLAYBOOK_BY_ID))) return fail('The response names a playbook that doesn’t exist');
  if (b.playbook !== undefined && b.playbook !== req.playbook) return fail('The response answers about a different playbook than the one it was asked about');
  if (b.action === 'take' && !req.approved.includes(req.playbook)) return fail(`${PLAYBOOK_BY_ID[req.playbook].name} isn’t on the approved list`);
  // A leak anywhere in what it was shown makes its answer untrustworthy.
  if (problems.length) return { decision: ABSTAIN(problems[0]!), valid: false, problems };
  return { decision: { action: b.action, regime, confidence: Math.round(confidence * 100) / 100, reason: reason || (b.action === 'take' ? 'Taken' : 'Abstained') }, valid: true, problems };
}

/** A model: given the request (with only the features it may see), it returns its raw response. */
export type Decider = (req: DecisionRequest) => unknown | Promise<unknown>;

/** Which playbooks suit which kind of market, for the statistical model. */
export const REGIME_FIT: Record<Regime, PlaybookId[]> = {
  trend: ['vwap-pullback', 'support-resistance', 'double-break', 'supply-demand'],
  range: ['failed-auction', 'support-resistance', 'supply-demand'],
  unclear: [],
};

export const REGIME_MODEL: ModelInfo = { id: 'regime', version: '1', kind: 'statistical' };

/**
 * The statistical model: ADX on the 5-minute chart says whether the market is trending or ranging, and a
 * setup is taken only when its playbook suits that. Thin volume, or no reading, is an abstain. The same
 * features always give the same answer.
 */
export const regimeDecider: Decider = (req) => {
  const get = (name: string) => req.features.find((f) => f.name === name)?.value ?? null;
  const adx = get('adx');
  const relVol = get('relVol');
  if (adx == null) return { action: 'abstain', confidence: 0, regime: 'unclear', reason: 'No ADX reading yet' };
  if (relVol != null && relVol < 0.6) return { action: 'abstain', confidence: 0.3, regime: 'unclear', reason: `Thin volume (${relVol}× the usual)` };
  const regime: Regime = adx >= 22 ? 'trend' : adx <= 18 ? 'range' : 'unclear';
  if (regime === 'unclear') return { action: 'abstain', confidence: 0.2, regime, reason: `ADX ${adx}: neither trending nor ranging` };
  const fits = REGIME_FIT[regime].includes(req.playbook);
  const confidence = Math.min(1, Math.abs(adx - 20) / 20 + 0.4);
  return fits ? { action: 'take', confidence, regime, reason: `ADX ${adx}: a ${regime === 'trend' ? 'trending' : 'ranging'} market, which suits this playbook` } : { action: 'abstain', confidence, regime, reason: `ADX ${adx}: a ${regime === 'trend' ? 'trending' : 'ranging'} market, which this playbook isn’t for` };
};

/**
 * Asks a model and records what came back. A model that throws, isn't there, or takes longer than
 * `budgetMs` is an abstain. `clock` is injectable so a test can make a model slow.
 */
export async function decide(req: DecisionRequest, model: ModelInfo, decider: Decider | null, o: { budgetMs?: number; clock?: () => number } = {}): Promise<DecisionRecord> {
  const clock = o.clock ?? Date.now;
  const budget = o.budgetMs ?? 5000;
  const askedAt = clock();
  const seen = usableFeatures(req);
  const shown: DecisionRequest = { ...req, features: seen.features };
  const record = (raw: string, decision: AdaptiveDecision, valid: boolean, problems: string[]): DecisionRecord => ({ request: req, model, raw, decision, valid, problems, askedAt, answeredAt: clock() });
  if (!decider) return record('', ABSTAIN('The model is unavailable'), false, ['The model is unavailable']);
  let raw: unknown;
  try {
    raw = await Promise.race([Promise.resolve().then(() => decider(shown)), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), budget))]);
  } catch (e) {
    const why = (e as Error).message === 'timeout' ? `No answer within ${Math.round(budget / 1000)}s` : `The model failed: ${(e as Error).message.slice(0, 120)}`;
    return record('', ABSTAIN(why), false, [why]);
  }
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? null);
  // A leak in what it would have been shown, or an answer that came back after the budget: abstain either way.
  const parsed = parseDecision(raw, req);
  const took = clock() - askedAt;
  if (took > budget) return record(text.slice(0, 4000), ABSTAIN(`The answer came ${Math.round(took / 1000)}s after it was asked: too late to act on`), false, [...parsed.problems, 'Late answer']);
  return record(text.slice(0, 4000), parsed.decision, parsed.valid, parsed.problems);
}

export interface ShadowSummary {
  model: ModelInfo;
  /** Setups it was asked about, took, abstained from, and answers that were invalid (counted as abstains). */
  asked: number;
  taken: number;
  abstained: number;
  invalid: number;
  /** The deterministic baseline takes every setup: its result per trade, and the lane's on the ones it took. In R after costs. */
  baseline: { trades: number; avgR: number; totalR: number };
  shadow: { trades: number; avgR: number; totalR: number };
  /** What abstaining saved or cost: the result of the setups it left alone. */
  skipped: { trades: number; avgR: number; totalR: number };
  /** Whether it has shown anything yet, in a line. */
  read: string;
}

/** How the lane would have done beside the baseline, from its records and how each setup came out (in R). */
export function shadowSummary(model: ModelInfo, records: DecisionRecord[], outcomes: Map<string, number>): ShadowSummary {
  const stat = (rs: number[]) => ({ trades: rs.length, avgR: rs.length ? Math.round((rs.reduce((a, b) => a + b, 0) / rs.length) * 1000) / 1000 : 0, totalR: Math.round(rs.reduce((a, b) => a + b, 0) * 100) / 100 });
  const closed = records.filter((r) => outcomes.has(r.request.id));
  const took = closed.filter((r) => r.decision.action === 'take');
  const left = closed.filter((r) => r.decision.action !== 'take');
  const baseline = stat(closed.map((r) => outcomes.get(r.request.id)!));
  const shadow = stat(took.map((r) => outcomes.get(r.request.id)!));
  const skipped = stat(left.map((r) => outcomes.get(r.request.id)!));
  const edge = Math.round((shadow.avgR - baseline.avgR) * 1000) / 1000;
  const read = closed.length < 30 ? `${closed.length} closed setups so far: too few to say whether it adds anything (30 at least)` : !shadow.trades ? 'It has abstained from everything' : edge > 0.05 ? `Taking only what it approved made ${edge >= 0 ? '+' : '−'}${Math.abs(edge).toFixed(2)}R a trade more than taking everything, over ${shadow.trades} trades. Shadow only: it trades nothing.` : `No better than taking every setup (${edge >= 0 ? '+' : '−'}${Math.abs(edge).toFixed(2)}R a trade). It stays in the shadow.`;
  return { model, asked: records.length, taken: records.filter((r) => r.decision.action === 'take').length, abstained: records.filter((r) => r.decision.action !== 'take').length, invalid: records.filter((r) => !r.valid).length, baseline, shadow, skipped, read };
}
