import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AccountState, PaperTrade, PlanResult, PlaybookId, Symbol } from '../../shared/trading.js';
import { PLAYBOOK_BY_ID, PLAYBOOKS } from '../../shared/trading.js';
import { applyPlan, plansOf } from '../../shared/dayplan.js';
import { TUNED_PLAYBOOKS, type Tuning } from '../../shared/tuning.js';
import { cushionOf, floorOf, STATUS_WORD, canTrade, type Account } from '../../shared/account-ledger.js';
import { cleanSetup, FARM_DEFAULTS, FARM_PROGRAM_BY_ID, farmOdds, policyOf, programVerified, setupProblem, strategyLabel, type FarmSetup, type FarmView } from '../../shared/farm.js';
import { COST_IDS, type CostId } from '../../shared/fills.js';
import { describeRules, isVerified, ruleIssues, ruleSetById, RULESETS, type RuleSet } from '../../shared/prop-rules.js';
import { datasetHash, fingerprint, splitDays, validate, VERDICT_WORD, type Candidate, type ValidationReport } from '../../shared/validation.js';
import type { AccountCard, FarmTotals, ForwardRunView, JobDetail, JobPreset, OpsView, PayoutEntry, PayoutRow, PropFarmView, SizingCell, SizingResult } from '../../shared/propfarm.js';
import { AccountBook } from './accounts.js';
import { BROKERS, readiness, feedsReady } from './broker.js';
import { ForwardBook, type FeedState } from './forward.js';
import { JobQueue, type Dataset, type JobSpec, type Runner } from './jobs.js';
import { PayoutLedger, payoutRow } from './payouts.js';
import { laneModel, shadowBacktest, ShadowLane } from './research-agent.js';

// The prop farm's back room: the research queue, the forward runs, the owner's tracked accounts, the payout
// ledger and the adaptive lane's shadow, and the one view the console draws from all of them. The market
// desk owns the tape and the paper book; it hands this what it needs through `FarmHost` and tells it
// about every paper trade it sees.

export interface BacktestData {
  ranAt: number;
  /** Trading days replayed, oldest first (weekdays). */
  days: string[];
  /** Every trade the live playbook versions took (the markets a prop account trades). */
  trades: PaperTrade[];
  /** The tuner's candidate versions, each with the same days traded its way. */
  versions: { playbook: PlaybookId; version: number; trades: PaperTrade[] }[];
  /** How many changes the tuner tried for each playbook. */
  tried: Partial<Record<PlaybookId, number>>;
  mixes: PlanResult[];
}

export interface FarmHost {
  now(): number;
  today(): string;
  backtest(): BacktestData | null;
  tuning(): Tuning;
  feeds(): Partial<Record<Symbol, FeedState & { ageSec: number | null }>>;
  inSession(): boolean;
  /** Every trade in the paper book. */
  paper(): PaperTrade[];
  /** Where a market's bars are coming from right now. */
  feed(sym: Symbol): FeedState;
  /** The owner's accounts that a broker connection reports. */
  connected(): AccountState[];
  projectxConnected(): boolean;
}

interface Strategy extends Candidate {
  baseline: boolean;
  /** What it is judged against. */
  against: string;
  searchCount: number;
}

interface Research {
  days: string[];
  /** The days research may look at: everything but the holdout. */
  seen: string[];
  strategies: Strategy[];
}

const MARKETS: Symbol[] = ['NQ', 'ES', 'GC'];
const EVAL_CAPS: (number | 'cushion')[] = ['cushion', 5, 10, 15, 20, 40];
const FUNDED_CAPS: (number | 'cushion')[] = ['cushion', 3, 5];
/** What the stage that isn't being varied sits at. */
const BASE_CAPS = { eval: 5, funded: 3 };

const tuningLabel = (t: Tuning) => {
  const parts = Object.entries(t).filter(([, s]) => s && Object.keys(s).length).map(([p, s]) => `${PLAYBOOK_BY_ID[p as PlaybookId].short} ${Object.entries(s!).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  return parts.length ? parts.join(' · ') : 'Every playbook as it was written';
};

/** The strategies research can run: each playbook's live version, the tuner's candidates, and the lab's best mixes. */
export function strategiesOf(b: BacktestData): Strategy[] {
  const out: Strategy[] = [];
  // The tuner and the mixes are judged on these days only (see TradingDesk.runBacktest): never on the holdout.
  const split = splitDays(b.days);
  const picked = [...split.train, ...split.validation];
  const mine = b.trades.filter((t) => MARKETS.includes(t.symbol) && t.outcome !== 'open');
  for (const p of PLAYBOOKS) out.push({ id: `pb:${p.id}`, name: p.name, family: p.id, trades: mine.filter((t) => t.playbook === p.id), baseline: true, against: `pb:${p.id}`, searchCount: 1 });
  for (const v of b.versions) out.push({ id: `pb:${v.playbook}@v${v.version}`, name: `${PLAYBOOK_BY_ID[v.playbook].name} v${v.version}`, family: v.playbook, trades: v.trades.filter((t) => MARKETS.includes(t.symbol) && t.outcome !== 'open'), baseline: false, against: `pb:${v.playbook}`, searchCount: Math.max(1, b.tried[v.playbook] ?? 1), selectedOn: picked });
  const plans = plansOf(TUNED_PLAYBOOKS).length;
  for (const m of b.mixes.filter((x) => x.order.length > 1 && x.mode !== 'every').slice(0, 3)) {
    out.push({ id: `mix:${m.mode}:${m.order.join('+')}`, name: m.label, family: 'mix', trades: applyPlan(mine, { mode: m.mode, order: m.order, oneAndDone: false, maxTrades: 0 }), baseline: false, against: `pb:${m.order[0]}`, searchCount: plans, selectedOn: picked });
  }
  return out;
}

const dayLists = (trades: PaperTrade[], days: string[]) => {
  const by = new Map<string, PaperTrade[]>(days.map((d) => [d, []]));
  for (const t of trades) by.get(t.day)?.push(t);
  return days.map((d) => by.get(d)!.sort((a, b) => a.entryAt - b.entryAt));
};

const sizingRunner: Runner<Research> = {
  cells(spec, ctx) {
    const programs = (spec.params.programs as string[]).filter((p) => p in FARM_PROGRAM_BY_ID);
    const strategies = (spec.params.strategies as string[]).filter((id) => ctx.strategies.some((s) => s.id === id));
    const costs = (spec.params.costs as CostId[]).filter((c) => COST_IDS.includes(c));
    const cells: SizingCell[] = [];
    for (const program of programs)
      for (const strategy of strategies)
        for (const cost of costs) {
          const name = ctx.strategies.find((s) => s.id === strategy)!.name;
          if (FARM_PROGRAM_BY_ID[program]!.evalRules) for (const cap of EVAL_CAPS) cells.push({ program, phase: 'eval', cap, strategy, strategyName: name, cost });
          for (const cap of FUNDED_CAPS) cells.push({ program, phase: 'funded', cap, strategy, strategyName: name, cost });
        }
    return cells;
  },
  run(spec, cell, ctx): SizingResult {
    const c = cell as SizingCell;
    const s = ctx.strategies.find((x) => x.id === c.strategy)!;
    const program = FARM_PROGRAM_BY_ID[c.program]!;
    const rules = c.phase === 'eval' ? program.evalRules! : program.fundedRules;
    const cap = c.cap === 'cushion' ? rules.maxMicros : c.cap;
    const setup: FarmSetup = { ...FARM_DEFAULTS, programId: c.program, fee: null, slots: 1, maxAttempts: 12, cost: c.cost, sizing: c.cap === 'cushion' ? 'cushion' : 'cap', evalMicros: c.phase === 'eval' ? cap : BASE_CAPS.eval, fundedMicros: c.phase === 'funded' ? cap : BASE_CAPS.funded, strategy: { playbooks: PLAYBOOKS.map((p) => p.id), mode: 'every', manage: 'written', markets: MARKETS } };
    const refused = setupProblem(setup);
    if (refused) return { ...c, refused, odds: null };
    return { ...c, refused: null, odds: farmOdds(dayLists(s.trades, ctx.seen), setup, { runs: 120, horizon: 60, seed: spec.seed, block: 2 }) };
  },
  conclude(_spec, results) {
    const rs = results as SizingResult[];
    const ran = rs.filter((r) => r.odds?.runs);
    const refused = rs.filter((r) => r.refused).length;
    const lines: string[] = [];
    const artifacts: { label: string; value: string }[] = [];
    const $ = (n: number) => `${n < 0 ? '−' : '+'}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`;
    for (const program of [...new Set(ran.map((r) => r.program))]) {
      for (const phase of ['eval', 'funded'] as const) {
        // A size has to hold at ordinary and at stressed costs, over every strategy that was run: the typical net, averaged.
        const caps = [...new Set(ran.filter((r) => r.program === program && r.phase === phase).map((r) => String(r.cap)))];
        const score = caps.map((cap) => {
          const mine = ran.filter((r) => r.program === program && r.phase === phase && String(r.cap) === cap);
          return { cap, net: mine.reduce((a, r) => a + r.odds!.mean, 0) / mine.length, breach: mine.reduce((a, r) => a + r.odds!.breachRate, 0) / mine.length };
        }).sort((a, b) => b.net - a.net);
        if (!score.length) continue;
        const best = score[0]!;
        const big = score.find((s) => s.cap === (phase === 'eval' ? '20' : '5'));
        const name = FARM_PROGRAM_BY_ID[program]!.name;
        artifacts.push({ label: `${name} · ${phase === 'eval' ? 'evaluation' : 'funded'}`, value: `${best.cap === 'cushion' ? 'cushion-based' : `${best.cap} micros`} nets most (${$(best.net)} on average, ${Math.round(best.breach * 100)}% of accounts lost)` });
        if (big && big.cap !== best.cap && best.net - big.net > 25) lines.push(`${name} ${phase === 'eval' ? 'evaluation' : 'funded'}: ${big.cap} micros nets ${$(big.net)} against ${$(best.net)} at ${best.cap === 'cushion' ? 'the cushion-based size' : `${best.cap} micros`}`);
      }
    }
    if (refused) artifacts.push({ label: 'Refused before running', value: `${refused} run${refused === 1 ? '' : 's'}: the cap is over the firm’s limit` });
    return { verdict: !ran.length ? 'Nothing could be run: no trades for these strategies' : lines.length ? `Not supported: the largest cap is not the best. ${lines.slice(0, 2).join('. ')}, on average over 60 days.` : 'The largest caps net as much as any on these days: check them against the accounts lost before believing it.', artifacts };
  },
};

function validateRunner(openings: (family: string, candidate: string) => number): Runner<Research> {
  return {
    cells(spec, ctx) {
      const ids = spec.params.candidates as string[] | undefined;
      return ctx.strategies.filter((s) => !s.baseline && (!ids?.length || ids.includes(s.id))).map((s) => s.id);
    },
    run(spec, cell, ctx): ValidationReport {
      const c = ctx.strategies.find((s) => s.id === cell)!;
      const base = ctx.strategies.find((s) => s.id === c.against)!;
      const open = spec.params.openHoldout === c.id;
      const programId = typeof spec.params.program === 'string' && spec.params.program in FARM_PROGRAM_BY_ID ? spec.params.program : 'lucidflex-25k';
      const farm: FarmSetup = { ...FARM_DEFAULTS, programId, slots: 1, cost: 'base', strategy: { playbooks: PLAYBOOKS.map((p) => p.id), mode: 'every', manage: 'written', markets: MARKETS } };
      const report = validate(c, base, { days: ctx.days, searchCount: c.searchCount, cost: (spec.params.cost as CostId) ?? 'base', openHoldout: open, farm, seed: spec.seed, runs: 100 });
      // A holdout opened before for another candidate of the same family has been used: say so on the report.
      const before = open ? openings(c.family, c.id) : 0;
      if (before) report.reasons.push(`This family’s holdout had already been opened ${before} time${before === 1 ? '' : 's'} for other candidates: it is no longer an untouched test`);
      return report;
    },
    conclude(_spec, results) {
      const rs = results as ValidationReport[];
      const count = (v: string) => rs.filter((r) => r.verdict === v).length;
      const good = rs.filter((r) => r.verdict === 'promising' || r.verdict === 'held');
      return {
        verdict: good.length ? `${good.map((r) => r.candidate.name).join(', ')}: ${good.some((r) => r.verdict === 'held') ? 'held up on the holdout' : 'promising, and not yet shown the holdout'}.` : `None of ${rs.length} candidate${rs.length === 1 ? '' : 's'} beat its baseline convincingly. That is a result too.`,
        artifacts: [...(['promising', 'held', 'inconclusive', 'rejected', 'failed-holdout', 'leaky'] as const).filter((v) => count(v)).map((v) => ({ label: VERDICT_WORD[v].split(':')[0]!, value: String(count(v)) })), { label: 'Variants tried across the families', value: String(rs.reduce((a, r) => a + r.searchCount, 0)) }],
      };
    },
  };
}

const shadowRunner: Runner<Research> = {
  cells: () => ['regime'],
  async run(spec, _cell, ctx) {
    const trades = ctx.strategies.filter((s) => s.baseline).flatMap((s) => s.trades).filter((t) => new Set(ctx.seen).has(t.day));
    const out = await shadowBacktest(trades, PLAYBOOKS.map((p) => p.id), (spec.params.cost as CostId) ?? 'base');
    return { summary: out.summary, records: out.records.slice(-200) };
  },
  conclude(_spec, results) {
    const s = (results[0] as { summary: { read: string; asked: number; taken: number; shadow: { avgR: number }; baseline: { avgR: number } } }).summary;
    return { verdict: s.read, artifacts: [{ label: 'Asked about', value: String(s.asked) }, { label: 'Took', value: String(s.taken) }, { label: 'Per trade, lane against baseline', value: `${s.shadow.avgR.toFixed(2)}R against ${s.baseline.avgR.toFixed(2)}R` }] };
  },
};

interface Saved {
  holdout: { family: string; candidate: string; at: number; verdict: string; job: string }[];
  /** A run the old single live farm was migrated into. */
  migrated?: boolean;
}

export class PropFarm {
  readonly forward: ForwardBook;
  readonly book: AccountBook;
  readonly payouts: PayoutLedger;
  readonly lane: ShadowLane;
  readonly jobs: JobQueue<Research>;
  private saved: Saved = { holdout: [] };
  private file: string;
  private notes: OpsView['notes'] = [];
  private research: { key: string; data: Dataset<Research> } | null = null;
  private viewCache: { at: number; key: string; view: PropFarmView } | null = null;

  constructor(dir: string, private host: FarmHost) {
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'farm.json');
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Saved;
      if (raw && Array.isArray(raw.holdout)) this.saved = raw;
    } catch {
      // A new farm.
    }
    this.forward = new ForwardBook(path.join(dir, 'forward.json'));
    this.book = new AccountBook(path.join(dir, 'accounts.json'));
    this.payouts = new PayoutLedger(path.join(dir, 'payouts.json'), this.book);
    const lane = laneModel();
    this.lane = new ShadowLane(path.join(dir, 'shadow.json'), lane.model, lane.decider, lane.adapter);
    this.jobs = new JobQueue<Research>(path.join(dir, 'jobs.json'), { sizing: sizingRunner, validate: validateRunner((family, candidate) => this.saved.holdout.filter((h) => h.family === family && h.candidate !== candidate).length), shadow: shadowRunner }, () => this.dataset(), () => host.now());
    const resumed = this.jobs.list().filter((j) => j.status === 'queued' && j.cursor > 0).length;
    if (resumed) this.note(`${resumed} research job${resumed === 1 ? '' : 's'} picked up where the office stopped`);
  }

  private save() {
    try {
      writeFileSync(this.file, JSON.stringify(this.saved, null, 1));
    } catch {
      // Kept in memory until the next save.
    }
  }

  private note(text: string, level: 'info' | 'warn' = 'info') {
    if (this.notes[0]?.text === text) return;
    this.notes.unshift({ at: this.host.now(), text, level });
    this.notes.length = Math.min(this.notes.length, 30);
  }

  stop() {
    this.jobs.stop();
    this.forward.flush();
    this.lane.flush();
  }

  /** The data research runs on: the last backtest's trades by strategy, with the holdout's days set apart. */
  private dataset(): Dataset<Research> | null {
    const b = this.host.backtest();
    if (!b || !b.days.length || !b.trades.length) return null;
    const key = `${b.ranAt}:${b.versions.length}:${b.mixes.length}`;
    if (this.research?.key === key) return this.research.data;
    const split = splitDays(b.days);
    const data: Dataset<Research> = {
      hash: datasetHash(b.days, b.trades),
      label: `${b.days.length} trading days of 1-minute bars (${b.days[0]} to ${b.days[b.days.length - 1]}), ${b.trades.length} trades; the last ${split.holdout.length} days are the holdout`,
      ctx: { days: b.days, seen: [...split.train, ...split.validation], strategies: strategiesOf(b) },
    };
    this.research = { key, data };
    return data;
  }

  /** The backtest finished (or the tuner did): waiting jobs can start. */
  dataReady() {
    this.jobs.kick();
  }

  private fingerprintOf(t: Tuning): string {
    return fingerprint(t).slice(0, 10);
  }

  /** The desk saw this paper trade. It is written down for the forward runs, and the adaptive lane is asked about it. */
  observe(t: PaperTrade, feed: FeedState) {
    const tuning = this.fingerprintOf(this.host.tuning());
    const what = this.forward.observe(t, { now: this.host.now(), tuning, feed });
    if (what === 'recorded') {
      const d = this.forward.allDecisions().find((x) => x.id === t.id);
      if (d) void this.lane.consider(d, PLAYBOOKS.map((p) => p.id)).catch(() => {});
    }
  }

  /** Housekeeping, every few seconds: pin checks, saving, and notices. */
  async tick(liveIds: Set<string> | null) {
    this.forward.noteTuning(this.fingerprintOf(this.host.tuning()));
    const voided = liveIds ? this.forward.voidMissing(this.host.today(), liveIds, this.host.now()) : 0;
    if (voided) this.note(`${voided} decision${voided === 1 ? '' : 's'} voided: a revised bar took the setup away`, 'warn');
    for (const r of this.forward.list()) if (r.status === 'paused' && r.pause) this.note(`${r.name} is paused: ${r.pause}`, 'warn');
    const feeds = this.host.feeds();
    if (this.host.inSession()) for (const [sym, f] of Object.entries(feeds)) if (f?.stale) this.note(`The ${sym} feed has gone quiet: no forward decisions on it until it catches up`, 'warn');
    this.forward.flush();
    this.lane.flush();
    await this.notify();
  }

  /** Sends what has happened on each run since the last look to its Discord webhook, in order. */
  private async notify() {
    const icon: Record<string, string> = { bought: '🧾', passed: '✅', busted: '💥', 'payout-ready': '💰', paid: '🏦', trade: '📈', skip: '⏭️', note: '📝' };
    for (const r of this.forward.list()) {
      if (r.status === 'stopped') continue;
      const events = this.runView(r).run.events.filter((e) => e.kind !== 'skip');
      if (events.length <= r.notified) continue;
      const fresh = events.slice(r.notified);
      r.notified = events.length;
      this.forward.setDiscord(r.id, r.discord);
      if (!r.discord) continue;
      for (const e of fresh.slice(-10)) {
        try {
          await fetch(r.discord, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'Prop Farm (paper)', content: `${icon[e.kind] ?? '•'} **${e.account || `Slot ${e.slot + 1}`}** · ${e.text}` }), signal: AbortSignal.timeout(5000) });
        } catch {
          // Discord is unreachable; the farm carries on.
        }
      }
    }
  }

  private runView(r: ReturnType<ForwardBook['list']>[number]): ForwardRunView {
    return this.forward.view(r, this.host.today(), this.host.feeds(), this.host.inSession());
  }

  /** The first run still going, as the wall board and the older farm view read it. */
  primary(): FarmView | null {
    const r = this.forward.list().find((x) => x.status !== 'stopped');
    if (!r) return null;
    const v = this.viewOf().runs.find((x) => x.id === r.id);
    return v ? { setup: v.setup, startDay: v.startDay, run: v.run, discord: v.discord } : null;
  }

  /** Brings the old single live farm in as a forward run, once. */
  migrate(old: { setup: FarmSetup; startDay: string; discord: string | null } | null | undefined, paper: PaperTrade[], feed: FeedState) {
    if (this.saved.migrated || !old) return;
    this.saved.migrated = true;
    this.save();
    for (const t of paper) if (t.day >= old.startDay) this.observe(t, feed);
    const run = this.forward.start(cleanSetup(old.setup), { now: this.host.now(), day: this.host.today(), tuning: this.fingerprintOf(this.host.tuning()), tuningLabel: tuningLabel(this.host.tuning()), fromDay: old.startDay });
    if (typeof run !== 'string' && old.discord) this.forward.setDiscord(run.id, old.discord);
    this.note('The live farm from before is now a forward run. Its trades so far were reconstructed, so they are marked late.');
  }

  // ---- Actions --------------------------------------------------------------------------------------------

  presets(): JobPreset[] {
    const d = this.dataset();
    const cells = (spec: JobSpec) => (d ? this.runnerCells(spec, d.ctx) : 0);
    return this.presetSpecs().map((p) => ({ id: p.id, kind: p.spec.kind, title: p.spec.title, agent: p.spec.agent, hypothesis: p.spec.hypothesis, criteria: p.spec.criteria, cells: cells(p.spec), what: p.what }));
  }

  private runnerCells(spec: JobSpec, ctx: Research): number {
    const r = spec.kind === 'sizing' ? sizingRunner : spec.kind === 'shadow' ? shadowRunner : validateRunner(() => 0);
    try {
      return r.cells(spec, ctx).length;
    } catch {
      return 0;
    }
  }

  private presetSpecs(): { id: string; what: string; spec: JobSpec }[] {
    const d = this.dataset();
    // The strategies with enough trades to redraw: the live playbooks the owner leans on, and the best candidates.
    const live = (d?.ctx.strategies ?? []).filter((s) => s.baseline && s.trades.length >= 20).sort((a, b) => b.trades.length - a.trades.length).slice(0, 4).map((s) => s.id);
    return [
      {
        id: 'sizing', what: 'Each program, each stage, each cap, at ordinary and at stressed costs, over redraws of the real days. Caps over a firm’s limit are refused and kept on the record.',
        spec: { kind: 'sizing', title: 'Evaluation and funded size: does a bigger cap pay?', agent: 'Risk governor · sizing worker', hypothesis: 'On LucidFlex 25K and 50K, asking for more micros (up to 20 in the evaluation, 5 funded) nets more cash after fees over 60 days than sizing off the cushion.', criteria: 'Supported only if the bigger cap’s typical net is higher at ordinary and at stressed costs and its breach rate is no more than ten points worse.', params: { programs: ['lucidflex-25k', 'lucidflex-50k'], strategies: live, costs: ['base', 'stressed'] }, seed: 11 },
      },
      {
        id: 'validate', what: 'Every candidate version and mix against the live playbook it would replace: training days, validation days, three cost settings, and a farm of each. The holdout stays shut.',
        spec: { kind: 'validate', title: 'Do the candidates beat the live playbooks?', agent: 'Skeptic · validation worker', hypothesis: 'The tuner’s candidate versions and the lab’s mixes are better than the live playbooks on days they were not picked on.', criteria: 'A candidate is promising only if it beats its baseline on the validation days by more than luck would among the variants tried, is no worse on the training days, and stays positive under stressed costs.', params: { candidates: [], cost: 'base', program: 'lucidflex-25k' }, seed: 11 },
      },
      {
        id: 'shadow', what: 'The statistical regime model asked about every setup the live playbooks took, with only what was known at each entry, and scored against taking them all.',
        spec: { kind: 'shadow', title: 'Would the adaptive lane have added anything?', agent: 'Strategy worker · adaptive lane', hypothesis: 'Taking only the setups whose playbook suits the market’s regime (ADX) makes more per trade than taking every setup.', criteria: 'Supported only if the lane’s average per trade beats the baseline’s by more than 0.05R over at least 30 closed setups. It stays shadow-only either way.', params: { cost: 'base' }, seed: 11 },
      },
    ];
  }

  /** One action from the console. Returns why it couldn't be done, or nothing. */
  act(b: Record<string, unknown>): string | undefined {
    const now = this.host.now();
    const day = this.host.today();
    const id = typeof b.id === 'string' ? b.id : '';
    this.viewCache = null;
    switch (b.action) {
      case 'job-start': {
        const preset = this.presetSpecs().find((p) => p.id === b.preset);
        if (!preset) return 'No such experiment';
        const spec: JobSpec = { ...preset.spec, params: { ...preset.spec.params } };
        if (Array.isArray(b.strategies) && b.strategies.length) spec.params.strategies = b.strategies.filter((s): s is string => typeof s === 'string').slice(0, 6);
        if (Array.isArray(b.programs) && b.programs.length) spec.params.programs = b.programs.filter((s): s is string => typeof s === 'string' && s in FARM_PROGRAM_BY_ID).slice(0, 4);
        if (Array.isArray(b.candidates)) spec.params.candidates = b.candidates.filter((s): s is string => typeof s === 'string').slice(0, 12);
        if (typeof b.seed === 'number' && Number.isInteger(b.seed) && b.seed > 0) spec.seed = b.seed;
        const out = this.jobs.submit(spec);
        return typeof out === 'string' ? out : undefined;
      }
      case 'holdout-open': {
        const d = this.dataset();
        const c = d?.ctx.strategies.find((s) => s.id === b.candidate && !s.baseline);
        if (!d || !c) return 'Pick a candidate to open the holdout for';
        if (this.saved.holdout.some((h) => h.candidate === c.id && h.job.startsWith(d.hash))) return 'The holdout has already been opened for this candidate on this data: its result is frozen';
        const out = this.jobs.submit({ kind: 'validate', title: `The holdout, opened for ${c.name}`, agent: 'Skeptic · validation worker', hypothesis: `${c.name} keeps its edge over ${PLAYBOOK_BY_ID[c.against.replace(/^pb:/, '') as PlaybookId]?.name ?? 'its baseline'} on the days nothing has looked at.`, criteria: 'It held only if, on the holdout days, it makes more per trade than its baseline and more than nothing. The result is frozen: it is not run again on this data.', params: { candidates: [c.id], openHoldout: c.id, cost: 'base', program: 'lucidflex-25k' }, seed: 11 });
        if (typeof out === 'string') return out;
        this.saved.holdout.unshift({ family: c.family, candidate: c.id, at: now, verdict: 'Running', job: `${d.hash}:${out.id}` });
        this.save();
        return undefined;
      }
      case 'job-cancel':
        return this.jobs.cancel(id);
      case 'job-resume':
        return this.jobs.resume(id);
      case 'job-remove':
        return this.jobs.remove(id);
      case 'run-start': {
        const setup = cleanSetup(b.setup);
        const why = setupProblem(setup);
        if (why) return why;
        const tuning = this.host.tuning();
        // "From as far back as the paper book goes": its trades become decisions, every one marked late,
        // since they are written down after the fact. They fill the accounts' ledgers and count for nothing as evidence.
        let fromDay: string | undefined;
        if (b.from === 'back') {
          const monthAgo = new Date(Date.parse(`${day}T12:00:00Z`) - 31 * 86_400_000).toISOString().slice(0, 10);
          const paper = this.host.paper().filter((t) => t.day >= monthAgo);
          for (const t of paper) this.forward.observe(t, { now, tuning: this.fingerprintOf(tuning), feed: { ...this.host.feed(t.symbol), source: 'Reconstructed from the paper book' } });
          fromDay = paper.reduce<string | undefined>((a, t) => (a == null || t.day < a ? t.day : a), undefined);
        }
        const out = this.forward.start(setup, { now, day, tuning: this.fingerprintOf(tuning), tuningLabel: tuningLabel(tuning), ...(typeof b.name === 'string' ? { name: b.name } : {}), ...(fromDay ? { fromDay } : {}) });
        return typeof out === 'string' ? out : undefined;
      }
      case 'run-stop':
        return this.forward.stop(id, now);
      case 'run-remove':
        return this.forward.remove(id);
      case 'run-discord': {
        const url = typeof b.url === 'string' ? b.url.trim() : '';
        if (url && !/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[\w-]+$/.test(url)) return 'That isn’t a Discord webhook address';
        return this.forward.setDiscord(id, url || null);
      }
      case 'account-add': {
        const out = this.book.add({ ruleSetId: String(b.ruleSet ?? ''), ...(typeof b.label === 'string' ? { label: b.label } : {}), ...(typeof b.fee === 'number' ? { fee: b.fee } : {}), day, now });
        return typeof out === 'string' ? out : undefined;
      }
      case 'account-log':
        return this.book.logDay(id, { day: typeof b.day === 'string' && b.day ? b.day : day, pnl: Number(b.pnl), ...(typeof b.trades === 'number' ? { trades: b.trades } : {}), ...(typeof b.worst === 'number' ? { worst: b.worst } : {}), now });
      case 'account-confirm': {
        const out = this.book.confirmPass(id, { day, now });
        return typeof out === 'string' ? out : undefined;
      }
      case 'account-status':
        return this.book.setStatus(id, b.status === 'review' || b.status === 'retired' || b.status === 'active' || b.status === 'removed' ? b.status : 'review', { day, now });
      case 'payout-request':
        return this.payouts.request(id, { day, now, key: typeof b.key === 'string' && b.key ? b.key.slice(0, 40) : `${day}:${this.book.get(id)?.account.payouts ?? 0}`, ...(typeof b.amount === 'number' ? { amount: b.amount } : {}) });
      case 'payout-received':
        return this.payouts.received(id, { day, now, ...(typeof b.withdrawn === 'number' ? { withdrawn: b.withdrawn } : {}) });
      case 'payout-denied':
        return this.payouts.denied(id, { day, now, reason: typeof b.reason === 'string' ? b.reason : '' });
      default:
        return 'Unknown action';
    }
  }

  /** One job in full: its results as well as its summary. */
  jobDetail(id: string): JobDetail | null {
    const j = this.jobs.get(id);
    if (!j) return null;
    const job = JobQueue.view(j);
    if (j.spec.kind === 'sizing') return { job, sizing: j.results as SizingResult[] };
    if (j.spec.kind === 'validate') return { job, reports: j.results as ValidationReport[] };
    return { job, ...(j.results[0] ? { shadow: j.results[0] as NonNullable<JobDetail['shadow']> } : {}) };
  }

  // ---- The view ------------------------------------------------------------------------------------------

  private cardOfTracked(a: Account, rules: RuleSet, series: number[], todayPnl: number): AccountCard {
    const cushion = cushionOf(a, rules);
    return {
      id: a.id, label: a.label, source: a.environment, run: null, runName: null, firm: rules.firm, program: rules.program, size: rules.size, phase: a.phase, status: a.status, statusWord: STATUS_WORD[a.status], trading: canTrade(a.status), why: a.why,
      balance: Math.round(a.balance), start: a.start, floor: Math.round(floorOf(a, rules)), cushion: Math.round(cushion), target: a.phase === 'eval' ? a.start + rules.profitTarget : a.start + (rules.payout?.minProfit ?? 0), todayPnl, todayBudget: rules.dailyLossLimit ?? Math.round(cushion),
      allowedMicros: a.allowedMicros, cap: a.allowedMicros, policy: 'Traded by hand', strategy: 'Your own trading', version: '—', verified: isVerified(rules), automation: rules.automation, tradingDays: a.phase === 'eval' ? a.tradingDays : a.cycle.tradingDays, profitDays: a.cycle.profitDays, profitDaysNeeded: rules.payout?.profitDays ?? 0,
      fees: a.fees, received: a.received, ruleSet: rules.id, series,
    };
  }

  private viewOf(): PropFarmView {
    const now = this.host.now();
    const key = `${this.forward.allDecisions().length}:${this.forward.list().map((r) => `${r.id}${r.status}`).join()}:${this.host.today()}:${this.jobs.list().map((j) => `${j.id}${j.status}${j.cursor}`).join()}`;
    // The runs' ledgers are replayed from their decisions: once every couple of seconds is plenty.
    if (this.viewCache && this.viewCache.key === key && now - this.viewCache.at < 4000) return this.viewCache.view;
    const today = this.host.today();
    const runs = this.forward.list().map((r) => this.runView(r));
    const accounts: AccountCard[] = [];
    const payouts: PayoutRow[] = [];
    const log: PayoutEntry[] = [...this.payouts.log()];
    const totals: FarmTotals = { simulatedProfit: 0, eligible: 0, requested: 0, simulatedReceived: 0, confirmedReceived: this.payouts.confirmedReceived(), simulatedFees: 0, confirmedFees: 0, counts: { eval: 0, funded: 0, parked: 0, breached: 0, other: 0 } };
    const count = (status: Account['status'], phase: 'eval' | 'funded') => {
      totals.counts[status === 'parked' ? 'parked' : status === 'breached' ? 'breached' : status === 'retired' || status === 'passed' || status === 'review' ? 'other' : phase]++;
    };

    for (const v of runs) {
      if (v.status === 'stopped') continue;
      const program = FARM_PROGRAM_BY_ID[v.setup.programId]!;
      const cells = v.run.cells[v.run.cells.length - 1] ?? [];
      totals.simulatedFees += v.run.fees;
      totals.simulatedReceived += v.run.payouts;
      cells.forEach((c, slot) => {
        if (c.status === 'empty') return;
        const funded = c.stage === 'funded' || c.stage === 'parked' || /^FUNDED/.test(c.account);
        const rules = funded ? program.fundedRules : program.evalRules ?? program.fundedRules;
        const policy = c.risk ?? policyOf(v.setup, rules.phase);
        const cushion = Math.max(0, c.balance - c.floor);
        const dayBudget = Math.min(policy.dayShare != null ? cushion * policy.dayShare : Infinity, rules.dailyLossLimit ?? Infinity, cushion);
        accounts.push({
          id: `${v.id}:${slot}`, label: c.account || `Slot ${slot + 1}`, source: 'simulated', run: v.id, runName: v.name, firm: program.firm, program: rules.program, size: rules.size, phase: rules.phase, status: c.status as Account['status'], statusWord: STATUS_WORD[c.status as Account['status']],
          trading: canTrade(c.status as Account['status']) && v.status === 'running', why: v.status === 'paused' ? v.pause : c.why, balance: c.balance, start: c.size, floor: c.floor, cushion, target: c.target, todayPnl: c.pnl, todayBudget: Math.round(Math.max(0, dayBudget + Math.min(0, c.pnl))),
          allowedMicros: c.allowed, cap: Math.min(policy.cap, c.allowed), policy: policy.name, strategy: strategyLabel(v.setup.strategy), version: v.pinned.tuningLabel, verified: programVerified(program), automation: rules.automation,
          tradingDays: c.tradingDays, profitDays: c.profitDays, profitDaysNeeded: c.profitDaysNeeded, fees: 0, received: 0, ruleSet: rules.id, series: v.run.cells.slice(-20).map((row) => row[slot]?.balance ?? 0).filter((x) => x > 0),
        });
        count(c.status as Account['status'], rules.phase);
        if (c.status !== 'breached') totals.simulatedProfit += c.balance - c.size;
      });
      // The run's payouts, as the simulation made them.
      for (const e of v.run.events) {
        if (e.kind === 'paid') log.push({ id: `${v.id}:${e.day}:${e.slot}:paid`, at: Date.parse(`${v.run.days[e.day]}T20:00:00Z`), day: v.run.days[e.day] ?? '', account: e.account, source: 'simulated', kind: 'paid', amount: e.amount, note: `${v.name} · on paper` });
        else if (e.kind === 'payout-ready') log.push({ id: `${v.id}:${e.day}:${e.slot}:req`, at: Date.parse(`${v.run.days[e.day]}T20:00:00Z`), day: v.run.days[e.day] ?? '', account: e.account, source: 'simulated', kind: 'requested', amount: Number(/\$([\d,]+)/.exec(e.text)?.[1]?.replace(/,/g, '') ?? 0), note: `${v.name} · on paper` });
      }
      // The run's funded accounts on the desk: each condition, from the last day's cell.
      cells.forEach((c, slot) => {
        if (c.status === 'empty' || !/^FUNDED/.test(c.account)) return;
        const rules = program.fundedRules;
        const p = rules.payout!;
        const profit = c.balance - c.size;
        const amount = c.payout?.requested ?? c.payout?.amount ?? 0;
        const parked = c.status === 'parked';
        const eligible = c.status === 'payout-eligible' ? amount : 0;
        if (parked) totals.requested += amount;
        totals.eligible += eligible;
        payouts.push({
          account: `${v.id}:${slot}`, label: `${c.account} · ${v.name}`, source: 'simulated', firm: program.firm, program: rules.program, status: c.status as Account['status'],
          checks: c.payout?.checks ?? [],
          eligible, requested: c.payout?.requested ?? null, requestedOn: c.payout?.requestedOn ?? null, received: c.payout?.received ?? 0, payouts: c.payout?.payouts ?? 0, payoutsAllowed: p.maxPayouts, floor: c.floor, floorAfter: p.floorOnRequest != null ? Math.max(c.floor, c.size + p.floorOnRequest) : c.floor,
          cushionAfter: Math.max(0, c.balance - (parked || eligible ? amount : 0) - (p.floorOnRequest != null ? Math.max(c.floor, c.size + p.floorOnRequest) : c.floor)), microsAfter: c.allowed,
          next: parked ? 'When the simulated payout lands' : c.status === 'breached' ? 'Never: it is breached' : 'Now', split: p.split,
        });
      });
    }

    for (const t of this.book.list()) {
      const rules = this.book.rules(t);
      const a = t.account;
      const last = t.days[t.days.length - 1];
      accounts.push(this.cardOfTracked(a, rules, t.days.slice(-20).map((d) => Math.round(d.balance)), last?.day === today ? Math.round(last.pnl) : 0));
      count(a.status, a.phase);
      totals.confirmedFees += a.fees;
      const row = payoutRow(a, rules, 'manual');
      if (row) {
        payouts.push(row);
        totals.eligible += row.eligible;
        totals.requested += row.requested ?? 0;
      }
    }
    // Accounts a broker connection reports: their balances are the broker's, not typed in.
    for (const s of this.host.connected()) {
      const funded = s.rules.kind === 'funded';
      accounts.push({
        id: `connected:${s.rules.id}`, label: `${s.rules.firm} ${s.rules.program}`, source: 'connected', run: null, runName: null, firm: s.rules.firm, program: s.rules.program, size: s.rules.size, phase: funded ? 'funded' : 'eval', status: s.cushion <= 0 ? 'breached' : 'active', statusWord: s.cushion <= 0 ? 'Breached' : 'Trading',
        trading: s.cushion > 0, why: 'Balance and fills from ProjectX', balance: Math.round(s.balance), start: s.rules.size, floor: Math.round(s.threshold), cushion: Math.round(s.cushion), target: s.rules.size + s.rules.profitTarget, todayPnl: s.todayPnl, todayBudget: s.riskPerTrade * 2,
        allowedMicros: s.rules.maxMicros, cap: s.rules.maxMicros, policy: 'Traded by hand', strategy: 'Your own trading', version: '—', verified: false, automation: 'unknown', tradingDays: 0, profitDays: 0, profitDaysNeeded: 0, fees: 0, received: 0, ruleSet: s.rules.id, series: [],
      });
      count(s.cushion <= 0 ? 'breached' : 'active', funded ? 'funded' : 'eval');
    }

    const d = this.dataset();
    const active = runs.find((r) => r.status !== 'stopped');
    const activeProgram = active ? FARM_PROGRAM_BY_ID[active.setup.programId] : null;
    // A finished holdout job freezes its verdict into the log.
    for (const h of this.saved.holdout) {
      if (h.verdict !== 'Running') continue;
      const job = this.jobs.get(h.job.split(':')[1] ?? '');
      const report = job?.status === 'done' ? (job.results as ValidationReport[])[0] : undefined;
      if (report) {
        h.verdict = VERDICT_WORD[report.verdict];
        this.save();
      } else if (job && (job.status === 'failed' || job.status === 'cancelled')) {
        h.verdict = 'Not finished';
        this.save();
      }
    }
    const feeds = this.host.feeds();
    const decisions = this.forward.allDecisions();
    const view: PropFarmView = {
      accounts, totals,
      jobs: this.jobs.list().map((j) => JobQueue.view(j)),
      presets: this.presets(),
      runs, payouts,
      payoutLog: log.sort((a, b) => b.at - a.at).slice(0, 60),
      shadow: { summary: this.lane.summary(decisions, active?.setup.cost ?? 'base'), recent: this.lane.all().slice(-12).reverse(), adapter: this.lane.adapter },
      rules: RULESETS.map((r) => ({ id: r.id, firm: r.firm, program: r.program, size: r.size, phase: r.phase, cohort: r.cohort, verifiedOn: r.verifiedOn, verified: isVerified(r), automation: r.automation, rows: describeRules(r), issues: ruleIssues(r), notes: r.notes, sources: r.sources })),
      readiness: readiness({
        automation: activeProgram ? (activeProgram.evalRules ?? activeProgram.fundedRules).automation : null, rulesVerified: activeProgram ? programVerified(activeProgram) : false, gateMet: runs.some((r) => r.gate.met),
        holdoutHeld: this.saved.holdout.some((h) => h.verdict === VERDICT_WORD.held), realTimeData: feedsReady(feeds, runs.some(r => r.status !== 'stopped') ? [...new Set(runs.filter(r => r.status !== 'stopped').flatMap(r => r.setup.strategy.markets))] : MARKETS), projectxConnected: this.host.projectxConnected(),
      }),
      brokers: BROKERS,
      ops: {
        feeds: MARKETS.map((symbol) => ({ symbol, source: feeds[symbol]?.source ?? 'No feed', delayed: feeds[symbol]?.delayed ?? true, ageSec: feeds[symbol]?.ageSec ?? null, stale: feeds[symbol]?.stale ?? true })),
        notes: this.notes,
        worker: { busy: this.jobs.busy, concurrency: 1, rest: 'One job at a time, resting as long as each run took: half a core at most' },
      },
      holdout: this.saved.holdout.map((h) => ({ family: h.family, candidate: h.candidate, at: h.at, verdict: h.verdict })),
      strategies: (d?.ctx.strategies ?? []).map((s) => ({ id: s.id, name: s.name, family: s.family, baseline: s.baseline, trades: s.trades.length })),
      dataset: d ? { hash: d.hash, label: d.label, days: d.ctx.days.length, trades: d.ctx.strategies.filter((s) => s.baseline).reduce((a, s) => a + s.trades.length, 0) } : null,
    };
    this.viewCache = { at: now, key, view };
    return view;
  }

  view(): PropFarmView {
    return this.viewOf();
  }

  ruleSet(id: string) {
    return ruleSetById(id);
  }
}
