import type { BacktestDetail } from '../../shared/trading';
import { STRATEGY_RECIPES } from '../../shared/strategy-recipes';
import { cleanSetup, FARM_DEFAULTS, FARM_PROGRAM_BY_ID, FARM_PROGRAMS, programVerified, setupProblem, strategyLabel, type FarmCell, type FarmEvent, type FarmOdds, type FarmRun, type FarmSetup, type FarmStage, type FarmStrategy } from '../../shared/farm';
import { STATUS_WORD } from '../../shared/account-ledger';
import { COST_IDS, COSTS } from '../../shared/fills';
import { MANAGE } from '../../shared/manage';
import { rungsFor } from '../../shared/farm-planner';
import { h } from '../ui/dom';
import { openEvalSim } from './evalsim';
import { trading } from './feed';
import { badge, chart, chip, dayLabel, money, panel, pct, segmented, shortDay, signedMoney, stat, TONE } from './labkit';
import { planner, savedSetup, type Plan } from './farm-plan';
import type { FarmShell } from './farm';

// The battle test: plan a farm and replay it before running it forward.
//
// On the left, the plan, as four decisions. Each is a row that says what was chosen; open one to change
// it. On the right, the answer, in the order it's wanted: what these real days did to the plan (the
// replay), what usually happens over redraws of them (the odds), then the days themselves to step through.
//
// The answer is worked out in the background and kept (see farm-plan.ts): it is there when the console
// opens, and only a setup that hasn't been tried before has to be worked out. While it is, the screen
// fills in part by part and the last answer stays up, dimmed, rather than going blank.
//
// It runs on the days research may look at: the holdout's days are left out, so planning never spends them.

const ACCENT = '#7ee787';
const STAGES: { id: FarmStage; title: string; sub: string }[] = [
  { id: 'eval', title: 'Evaluations', sub: 'in play' },
  { id: 'funded', title: 'Funded', sub: 'in the rotation' },
  { id: 'parked', title: 'Parked', sub: 'payout requested' },
  { id: 'busted', title: 'Out', sub: 'lost or not bought' },
];
const EVENT_ICON: Record<FarmEvent['kind'], string> = { bought: '🧾', passed: '✅', busted: '💥', 'payout-ready': '💰', paid: '🏦', trade: '📈', skip: '⏭️', note: '📝' };
const EVENT_WORD: Record<FarmEvent['kind'], string> = { bought: 'OPENED', passed: 'PASSED', busted: 'LOST', 'payout-ready': 'PAYOUT REQUESTED', paid: 'PAID', trade: 'TRADE', skip: 'NO TRADE', note: 'NOTE' };
const SIZING: { id: FarmSetup['sizing']; label: string; word: string; what: string }[] = [
  { id: 'cap', label: 'Up to the cap', word: 'up to the cap', what: 'Ask for the cap on every trade, as far as the cushion can carry it at that trade’s stop. The cap is an upper bound, not an order size.' },
  { id: 'cushion', label: 'Off the cushion', word: 'off the cushion', what: 'A tenth of the cushion a trade and a fifth a day (the Law of 10), never more than the cap.' },
  { id: 'phase', label: 'By phase', word: 'by phase', what: 'A share of the cushion for each phase, with a tenth of the drawdown always held back. Funded risk eases off as the payout gets close.' },
];
const ALL_MARKETS: FarmStrategy['markets'] = ['NQ', 'ES', 'GC'];
const short = (v: number) => `${v >= 0 ? '+' : '−'}$${Math.abs(v) >= 1000 ? `${(Math.abs(v) / 1000).toFixed(1)}k` : Math.abs(Math.round(v))}`;

interface Preset {
  id: string;
  name: string;
  why?: string;
  strategy: FarmStrategy;
}

export interface Battle {
  show(): void;
  hide(): void;
  data(detail: BacktestDetail | null): void;
  tick(): void;
  dispose(): void;
}

export function mountBattle(shell: FarmShell, rail: HTMLElement, main: HTMLElement): Battle {
  const kept = savedSetup.get();
  let setup: FarmSetup = cleanSetup({ ...FARM_DEFAULTS, ...kept });
  let firm = FARM_PROGRAM_BY_ID[setup.programId]!.firm;
  let detail: BacktestDetail | null = null;
  let day = -1;
  let playing = 0;
  let feedAll = false;
  let shown = false;
  /** Which of the four decisions is open (0: none). */
  let step = 1;
  /** The last plan that had something to show: it stays up, dimmed, while a new one is worked out. */
  let last: Plan | null = null;
  let painted = '';
  /** The plan whose days are on the board. */
  let daysFor = '';
  let frame = 0;
  /** What the waiting screen last said it was waiting for, so it is redrawn when that changes. */
  let waitingFor = '';
  const persist = () => savedSetup.set({ ...setup, firm });

  rail.classList.add('bt-rail');
  const progress = h('div.bt-progress', { role: 'progressbar', 'aria-label': 'Working out this plan' }, h('i'));
  const replayCard = h('section.bt-result');
  const oddsCard = h('section.bt-result');
  const hero = h('div.bt-hero', {}, replayCard, oddsCard);
  const cta = h('div.bt-cta');
  const pipeline = h('div.fm-pipe.pf-pipe');
  const lower = h('div.tl-cols');
  const dayRead = h('span.fm-day');
  const slider = h('input.tl-range.fm-scrub', { type: 'range', min: '0', max: '0', step: '1', 'aria-label': 'Day of the replay' }) as HTMLInputElement;
  const play = h('button.tl-btn.fm-play', { type: 'button', 'aria-label': 'Replay the days one by one' }, '▶ Play the days') as HTMLButtonElement;
  const timeline = h('div.fm-timeline', {}, play, slider, dayRead);
  const days$ = h('div.bt-days', {}, h('div.bt-section', {}, h('h3', {}, 'The days, one at a time'), h('span', {}, 'Drag the day, or play them, and watch each account move through its stages')), timeline, pipeline, lower);
  const stopPlay = () => {
    if (playing) clearInterval(playing);
    playing = 0;
    play.textContent = '▶ Play the days';
  };

  const limits = (s: FarmSetup) => {
    const p = FARM_PROGRAM_BY_ID[s.programId]!;
    return { evalMax: p.evalRules?.maxMicros ?? 0, fundedMax: p.fundedRules.maxMicros };
  };
  const presets = (): Preset[] => {
    const mix = trading.snap?.backtest?.mixes?.find((m) => m.order.length > 1 && m.mode !== 'every' && m.trades >= 20);
    return [...(mix ? [{ id: 'mix', name: 'The lab’s best mix', why: 'The mix the Backtest Lab ranked first on the days research may look at.', strategy: { playbooks: mix.order, mode: mix.mode, manage: 'written' as const, markets: ALL_MARKETS } }] : []), ...STRATEGY_RECIPES];
  };
  const samePreset = (p: Preset) => p.strategy.mode === setup.strategy.mode && p.strategy.playbooks.length === setup.strategy.playbooks.length && p.strategy.playbooks.every((x, i) => x === setup.strategy.playbooks[i]);

  /** The plan for the setup as it stands (it starts being worked out if it hasn't been). */
  const plan = (): Plan | null => (detail?.trades.length && !setupProblem(setup) ? planner.get(detail, setup) : null);

  const change = (patch: Partial<FarmSetup>) => {
    let next = cleanSetup({ ...setup, ...patch });
    // A cap carried over from another program is brought inside this one's limit.
    const { evalMax, fundedMax } = limits(next);
    if (evalMax && next.evalMicros > evalMax) next = { ...next, evalMicros: evalMax };
    if (next.fundedMicros > fundedMax) next = { ...next, fundedMicros: fundedMax };
    setup = next;
    firm = FARM_PROGRAM_BY_ID[setup.programId]!.firm;
    persist();
    stopPlay();
    day = -1;
    render();
  };

  // ---- The plan: four decisions ------------------------------------------------------------------------
  const stepper = (value: number, min: number, max: number, set: (v: number) => void, label: string) =>
    h('div.fm-stepper', { role: 'group', 'aria-label': label },
      h('button', { type: 'button', disabled: value <= min, 'aria-label': `Fewer: ${label}`, onclick: () => set(value - 1) }, '−'),
      h('b', {}, String(value)),
      h('button', { type: 'button', disabled: value >= max, 'aria-label': `More: ${label}`, onclick: () => set(value + 1) }, '+'));
  const field = (label: string, control: Node, hint?: string | Node | null) => h('label.bt-field', {}, h('span.tl-label', {}, label), control, hint ? h('small', {}, hint) : null);
  const select = <T extends string>(label: string, options: { id: T; label: string }[], value: T, pick: (v: T) => void) =>
    h('select.tl-input.bt-select', { 'aria-label': label, onchange: (e: Event) => pick((e.target as HTMLSelectElement).value as T) }, ...options.map((o) => h('option', { value: o.id, selected: o.id === value }, o.label)));
  /** The sizes for one stage, each with what the farm nets at it once that has been worked out. */
  const ladder = (phase: 'eval' | 'funded', max: number, now: number, pick: (n: number) => void) =>
    h('div.bt-ladder', { 'data-phase': phase }, ...rungsFor(max).map((n) => h('button', { type: 'button', 'data-rung': `${phase}:${n}`, 'aria-pressed': String(n === now), onclick: () => pick(n) }, h('b', {}, String(n)), h('small', {}, '·'))));

  function drawRail() {
    const program = FARM_PROGRAM_BY_ID[setup.programId]!;
    const firms = [...new Set(FARM_PROGRAMS.map((p) => p.firm))];
    const { evalMax, fundedMax } = limits(setup);
    const fee = setup.fee ?? program.fee;
    const recipes = presets();
    const recipe = recipes.find(samePreset);
    const sizing = SIZING.find((s) => s.id === setup.sizing)!;
    const section = (n: number, title: string, summary: string, ...body: (Node | null)[]) => {
      const open = step === n;
      return h('section.bt-step', { 'data-open': open ? '1' : undefined },
        h('button.bt-step-head', { type: 'button', 'aria-expanded': String(open), onclick: () => { step = open ? 0 : n; drawRail(); decorate(); } },
          h('span.bt-step-n', {}, String(n)), h('span.bt-step-text', {}, h('b', {}, title), h('span', {}, summary)), h('span.bt-step-chev', { 'aria-hidden': 'true' }, open ? '–' : '+')),
        open ? h('div.bt-step-body', {}, ...body.filter((k): k is Node => !!k)) : null);
    };
    const feeInput = h('input.tl-input', { type: 'number', min: '0', step: '1', value: String(fee), 'aria-label': 'What one attempt costs, in dollars', onchange: (e: Event) => change({ fee: Number((e.target as HTMLInputElement).value) }) });
    const ruleIds = [program.evalRules?.id, program.fundedRules.id].filter((x): x is string => !!x);
    rail.replaceChildren(
      h('div.bt-rail-head', {}, h('span.tl-kicker', {}, 'YOUR PLAN'), h('button.bt-link', { type: 'button', onclick: () => change({ ...FARM_DEFAULTS, strategy: { ...FARM_DEFAULTS.strategy } }) }, 'Start over')),
      section(1, 'Program', `${program.name} · ${money(fee)} an attempt`,
        h('div.bt-firms', { role: 'group', 'aria-label': 'Firm' }, ...firms.map((f) => h('button', { type: 'button', 'aria-pressed': String(f === firm), onclick: () => { firm = f; if (FARM_PROGRAM_BY_ID[setup.programId]!.firm !== f) change({ programId: FARM_PROGRAMS.find((p) => p.firm === f)!.id, fee: null }); else { persist(); drawRail(); decorate(); } } }, f))),
        h('div.bt-programs', {}, ...FARM_PROGRAMS.filter((p) => p.firm === firm).map((p) => {
          const on = p.id === setup.programId;
          return h('button.bt-program', { type: 'button', 'aria-pressed': String(on), 'data-program': p.id, onclick: () => change({ programId: p.id, fee: null }) },
            h('span.bt-program-top', {}, h('b', {}, p.name), h('span.bt-program-odds', {})),
            h('span.bt-program-tags', {}, badge(p.evalRules ? 'EVALUATION → FUNDED' : 'STRAIGHT TO FUNDED', 'dim'), programVerified(p) ? badge('RULES VERIFIED', 'ok', 'Read on the firm’s own pages') : badge('RULES PARTIAL', 'warn', 'Some of its numbers aren’t the firm’s own, or some conditions are still unknown: see its rules')),
            on ? h('small', {}, p.note) : null);
        })),
        h('div.bt-row', {}, field('One attempt costs ($)', feeInput, program.feeEstimated && setup.fee == null ? 'Not the firm’s published price: set what you pay.' : null),
          h('button.tl-btn', { type: 'button', onclick: () => shell.showRules(ruleIds, `${program.firm} ${program.name}`) }, 'See its rules'))),
      section(2, 'Accounts', `${setup.slots} at once · ${setup.maxAttempts} attempts · ${setup.share === 'rotate' ? 'taking turns' : 'all copying'}`,
        h('div.bt-pair', {}, h('span', {}, h('b', {}, 'Side by side'), h('small', {}, 'Accounts open at once')), stepper(setup.slots, 1, 5, (v) => change({ slots: v }), 'accounts side by side')),
        h('div.bt-pair', {}, h('span', {}, h('b', {}, 'Attempts in all'), h('small', {}, `${money(setup.maxAttempts * fee)} of fees at the very most`)), stepper(setup.maxAttempts, 1, 60, (v) => change({ maxAttempts: v }), 'attempts in all')),
        field('How signals are shared', segmented<FarmSetup['share']>([{ id: 'rotate', label: 'Take turns' }, { id: 'copy', label: 'All copy every trade' }], setup.share, (v) => change({ share: v })),
          setup.share === 'rotate' ? 'Each signal goes to the next account in turn. An opposite position on another account is refused.' : 'Every account takes every signal: they win and lose together, which is one result counted several times.')),
      section(3, 'Strategy', `${recipe?.name ?? 'A custom mix'} · ${setup.strategy.markets.join(' ')}`,
        field('What they trade', select('Strategy', [...(recipe ? [] : [{ id: '', label: 'A custom mix' }]), ...recipes.map((p) => ({ id: p.id, label: p.name }))], recipe?.id ?? '', (id) => {
          const p = recipes.find((x) => x.id === id);
          if (p) change({ strategy: { ...p.strategy, markets: [...setup.strategy.markets], manage: setup.strategy.manage } });
        }), recipe?.why ?? strategyLabel(setup.strategy)),
        field('On which markets', h('div.tl-chips', {}, ...ALL_MARKETS.map((m) => chip(m, setup.strategy.markets.includes(m), () => {
          const markets = setup.strategy.markets.includes(m) ? setup.strategy.markets.filter((x) => x !== m) : [...setup.strategy.markets, m];
          if (markets.length) change({ strategy: { ...setup.strategy, markets } });
        })))),
        setup.strategy.playbooks.length > 1 ? field('How the playbooks combine', select<FarmStrategy['mode']>('How the playbooks combine', [{ id: 'every', label: 'Every setup of each' }, { id: 'fallback', label: 'The first, then the next if it fails' }, { id: 'by-day', label: 'One for trending days, one for ranging' }], setup.strategy.mode, (v) => change({ strategy: { ...setup.strategy, mode: v } })), strategyLabel(setup.strategy)) : null,
        field('How a trade is managed', select('How a trade is managed', MANAGE.map((m) => ({ id: m.id, label: m.short })), setup.strategy.manage, (v) => change({ strategy: { ...setup.strategy, manage: v } }))),
        field('What every fill pays', segmented<FarmSetup['cost']>(COST_IDS.map((c) => ({ id: c, label: COSTS[c].name })), setup.cost, (v) => change({ cost: v })), COSTS[setup.cost].what)),
      section(4, 'Size', `${program.evalRules ? `${setup.evalMicros} eval · ` : ''}${setup.fundedMicros} funded · ${sizing.word}`,
        field('How a trade is sized', segmented<FarmSetup['sizing']>(SIZING.map((s) => ({ id: s.id, label: s.label })), setup.sizing, (v) => change({ sizing: v })), sizing.what),
        setup.sizing === 'phase' ? h('div.bt-row', {},
          ...([['evalRiskPercent', 'Evaluation: % of cushion', 5, 75, 35], ['fundedRiskPercent', 'Funded: % of cushion', 1, 25, 10]] as const).map(([key, label, min, max, fallback]) => field(label,
            h('input.tl-input', { type: 'number', min: String(min), max: String(max), value: String(setup[key] ?? fallback), 'aria-label': label, onchange: (e: Event) => change({ [key]: Number((e.target as HTMLInputElement).value) }) })))) : null,
        setup.sizing === 'phase' ? h('button.tl-toggle', { type: 'button', role: 'switch', 'aria-checked': String(setup.protectPayout !== false), onclick: () => change({ protectPayout: setup.protectPayout === false }) }, h('i'), h('span', {}, h('b', {}, 'Ease off near a payout'), h('small', {}, 'Funded risk falls to a quarter as the payout gets close'))) : null,
        evalMax ? field(`Evaluation: up to ${setup.evalMicros} micros`, ladder('eval', evalMax, setup.evalMicros, (n) => change({ evalMicros: n })), `The firm allows ${evalMax}.`) : h('p.bt-note', {}, 'No evaluation in this program: it starts funded.'),
        field(`Funded: up to ${setup.fundedMicros} micros`, ladder('funded', fundedMax, setup.fundedMicros, (n) => change({ fundedMicros: n })), `The firm allows ${program.fundedRules.scaling ? `${program.fundedRules.scaling[0]!.micros} to start and ${fundedMax} at most` : fundedMax}.`),
        h('p.bt-note', { 'data-ladder-note': '1' }, 'Under each size: what the farm nets on average over 60 days at it. ★ marks the best on these days.'),
        h('button.tl-toggle', { type: 'button', role: 'switch', 'aria-checked': String(setup.fundedOneAndDone), onclick: () => change({ fundedOneAndDone: !setup.fundedOneAndDone }) }, h('i'), h('span', {}, h('b', {}, 'Funded: one winner and done'), h('small', {}, 'Keeps each day small and steady, which payout rules reward')))),
      h('button.bt-link.bt-rail-foot', { type: 'button', onclick: () => openEvalSim({ playbooks: setup.strategy.playbooks, plan: setup.strategy.mode, manage: setup.strategy.manage }) }, 'One account in detail: the eval simulator →'));
  }

  /** Fills in what has been worked out so far beside the choices: each size's net, each program's net. Touches no control. */
  function decorate() {
    const p = detail?.trades.length ? planner.peek(detail, setup) : null;
    for (const phase of ['eval', 'funded'] as const) {
      const got = p?.rungs[phase] ?? new Map<number, FarmOdds>();
      const best = [...got.entries()].reduce<[number, FarmOdds] | null>((a, b) => (!a || b[1].mean > a[1].mean ? b : a), null);
      const whole = !!p && got.size >= rungsFor(phase === 'eval' ? limits(setup).evalMax : limits(setup).fundedMax).length;
      rail.querySelectorAll<HTMLElement>(`[data-rung^="${phase}:"]`).forEach((el) => {
        const n = Number(el.dataset.rung!.split(':')[1]);
        const o = got.get(n);
        const small = el.querySelector('small')!;
        small.textContent = o ? short(o.mean) : '·';
        small.dataset.tone = o ? (o.mean >= 0 ? 'up' : 'down') : 'flat';
        el.toggleAttribute('data-best', whole && best?.[0] === n);
        el.title = o ? `Up to ${n} micros: ${signedMoney(o.mean)} net on average over ${o.horizon} days, ahead in ${pct(o.ahead)} of redraws, ${pct(o.breachRate)} of accounts lost` : `Up to ${n} micros`;
      });
    }
    rail.querySelectorAll<HTMLElement>('[data-program]').forEach((el) => {
      const o = p?.programs.get(el.dataset.program!);
      const out = el.querySelector<HTMLElement>('.bt-program-odds')!;
      out.textContent = o?.runs ? `${short(o.mean)} avg` : '';
      out.dataset.tone = o ? (o.mean >= 0 ? 'up' : 'down') : 'flat';
      el.title = o?.runs ? `${signedMoney(o.mean)} net on average over ${o.horizon} days at this setup, ahead in ${pct(o.ahead)} of redraws` : '';
    });
  }

  // ---- The answer --------------------------------------------------------------------------------------
  const skeleton = (lines: number) => h('div.bt-skel', { 'aria-hidden': 'true' }, h('i.big'), ...Array.from({ length: lines }, () => h('i')));

  function paintReplay(p: Plan, run: FarmRun | null) {
    const program = FARM_PROGRAM_BY_ID[p.setup.programId]!;
    if (!run) return replayCard.replaceChildren(h('span.tl-kicker', {}, 'THE REPLAY'), h('p.bt-what', {}, 'Playing your plan over the real days…'), skeleton(3));
    const net = run.cash[run.cash.length - 1] ?? 0;
    const lost = run.evalBusts + run.fundedBusts;
    replayCard.dataset.tone = net > 0 ? 'up' : net < 0 ? 'down' : 'flat';
    replayCard.replaceChildren(
      h('span.tl-kicker', {}, `THE REPLAY · ${run.days.length} REAL DAYS, AS THEY CAME`),
      h('div.bt-big', { 'data-tone': net > 0 ? 'up' : net < 0 ? 'down' : 'warn' }, signedMoney(net), h('span', {}, 'payouts less fees')),
      h('p.bt-what', {}, `${run.attempts} attempt${run.attempts === 1 ? '' : 's'} bought. ${program.evalRules ? `${run.passed} passed the evaluation. ` : ''}${run.payoutCount} payout${run.payoutCount === 1 ? '' : 's'}${lost ? `, ${lost} account${lost === 1 ? '' : 's'} lost${run.spent ? ` (${run.spent} ran out of cushion rather than breaching)` : ''}` : ''}. ${run.taken} trades taken${run.skipped ? `, ${run.skipped} setups no account could size` : ''}.`),
      h('div.bt-stats', {},
        stat('Fees paid', money(run.fees), { tone: 'down', sub: `${run.attempts} × ${money(p.setup.fee ?? program.fee)}` }),
        stat('Payouts', money(run.payouts), { tone: run.payouts ? 'up' : undefined, sub: run.firstPayoutDay != null ? `first asked day ${run.firstPayoutDay + 1}` : 'none in these days' }),
        stat('Costs in fills', money(run.costs), { sub: COSTS[p.setup.cost].name.toLowerCase() }),
        stat('Accounts lost', String(lost), { tone: lost ? 'down' : undefined, sub: run.worstStreak ? `worst streak ${money(run.worstStreak)}` : 'none' })),
      h('p.bt-fine', {}, 'One path: the days in the order they really came. A different order is a different result, which is what the odds are for.'));
  }

  function paintOdds(p: Plan) {
    const program = FARM_PROGRAM_BY_ID[p.setup.programId]!;
    const o = p.odds;
    if (!o) return oddsCard.replaceChildren(h('span.tl-kicker', {}, 'THE ODDS'), h('p.bt-what', {}, p.error || 'Redrawing the days 200 times…'), ...(p.error ? [] : [skeleton(3)]));
    if (!o.runs) return oddsCard.replaceChildren(h('span.tl-kicker', {}, 'THE ODDS'), h('p.bt-what', {}, 'This strategy took no trades on these days and markets: there is nothing to redraw.'));
    oddsCard.dataset.tone = o.mean > 0 ? 'up' : o.mean < 0 ? 'down' : 'flat';
    oddsCard.replaceChildren(
      h('span.tl-kicker', {}, `THE ODDS · ${o.runs} REDRAWS, ${o.horizon} TRADING DAYS EACH`),
      h('div.bt-big', { 'data-tone': o.mean > 0 ? 'up' : o.mean < 0 ? 'down' : 'warn' }, signedMoney(o.mean), h('span', {}, 'net on average')),
      h('div.bt-meter', {},
        h('div.tl-odds-meter', {}, h('i', { 'data-k': 'pass', style: `width:${o.ahead * 100}%` }), h('i', { 'data-k': 'bust', style: `width:${(1 - o.ahead) * 100}%` })),
        h('div.bt-meter-ends', {}, h('span', { 'data-tone': 'up' }, `${pct(o.ahead)} end ahead`), h('span', {}, `could really be ${pct(o.aheadRange[0])} to ${pct(o.aheadRange[1])}`), h('span', { 'data-tone': 'down' }, `${pct(1 - o.ahead)} behind`))),
      h('div.bt-stats', {},
        stat('Typical run', signedMoney(o.p50), { sub: `${short(o.p10)} to ${short(o.p90)}` }),
        stat(program.evalRules ? 'Pass rate' : 'Reach a payout', pct(o.passRate), { sub: `${o.attempts.toFixed(1)} attempts` }),
        stat('Accounts lost', pct(o.breachRate), { tone: o.breachRate > 0.5 ? 'down' : undefined, sub: 'of those opened' }),
        stat('First payout', o.daysToPayout == null ? 'Never' : `Day ${o.daysToPayout}`, { sub: `in ${pct(o.payoutRate)} of runs` })),
      h('p.bt-fine', {}, `Drawn from ${o.sampleDays} real days and ${o.sampleTrades} trades, two days at a time.${p.held ? ` The backtest’s last ${p.held} days are the holdout and aren’t used.` : ''} What could happen on paper, not a forecast.`));
  }

  function paintCta() {
    const refused = setupProblem(setup);
    cta.replaceChildren(
      h('div', {}, h('b', {}, 'Run this plan forward'), h('small', {}, 'The office opens these accounts in a simulation and writes every decision down before its outcome. Nothing is bought and no order is placed.')),
      h('button.tl-btn', { type: 'button', disabled: !!refused, title: 'The paper book’s trades so far become decisions too, each marked late: they fill the ledgers and count for nothing as forward evidence', onclick: async () => { if (await shell.act({ action: 'run-start', setup, from: 'back' }, 'A forward run has started, with the paper book’s history marked late')) shell.go('forward'); } }, 'Include the paper book so far'),
      h('button.tl-btn.primary', { type: 'button', disabled: !!refused, onclick: async () => { if (await shell.act({ action: 'run-start', setup }, 'A forward run has started: decisions are recorded from now')) shell.go('forward'); } }, 'Start from today →'));
  }

  const card = (c: FarmCell, slot: number) => {
    const span = Math.max(1, c.target - c.floor);
    const at = Math.max(0, Math.min(1, (c.balance - c.floor) / span));
    const start = Math.max(0, Math.min(1, (c.size - c.floor) / span));
    const word = c.status === 'empty' ? 'WAITING' : c.status === 'active' ? (c.stage === 'eval' ? 'IN PLAY' : 'TRADING') : STATUS_WORD[c.status].split(' · ')[0]!.toUpperCase();
    return h('div.fm-card', { 'data-stage': c.stage },
      h('div.fm-card-top', {}, h('b', {}, c.account || `Slot ${slot + 1}`), h('span.fm-chip', {}, word)),
      c.stage === 'empty'
        ? h('small', {}, c.why)
        : h('div', {},
            h('div.fm-balance', {}, money(c.balance)),
            h('div.fm-card-line', {}, h('span', { 'data-tone': c.pnl > 0 ? 'up' : c.pnl < 0 ? 'down' : 'flat' }, `today ${signedMoney(c.pnl)}`), h('span', {}, `to date ${signedMoney(c.balance - c.size)}`)),
            h('div.fm-bar', {}, h('i', { style: `--at:${(at * 100).toFixed(1)}%` }), h('u', { style: `left:${start * 100}%` })),
            h('div.fm-card-line.dim', {}, h('span', {}, `floor ${money(c.floor)}`), h('span', {}, `${c.stage === 'eval' ? 'target' : 'payout at'} ${money(c.target)}`)),
            c.stage !== 'busted' ? h('div.fm-card-line.dim', {}, h('span', {}, `${c.allowed} micros allowed`), h('span', {}, c.trades ? `low: ${money(c.lowCushion)} over the floor` : '')) : null,
            h('small', {}, c.last ? `Last: ${c.last}` : 'No trade yet'),
            h('small', {}, c.stage === 'funded' || c.stage === 'parked' ? `${c.profitDays} of ${c.profitDaysNeeded} payout days · ${c.why}` : c.why)));
  };

  function paintDay(run: FarmRun) {
    const i = Math.max(0, Math.min(run.days.length - 1, day));
    dayRead.replaceChildren(h('b', {}, `Day ${i + 1} of ${run.days.length}`), ` · ${dayLabel(run.days[i]!)}`);
    const cells = run.cells[i] ?? [];
    pipeline.replaceChildren(...STAGES.map((st) => {
      const mine = cells.map((c, slot) => ({ c, slot })).filter((x) => (st.id === 'busted' ? x.c.stage === 'busted' || x.c.stage === 'empty' : x.c.stage === st.id));
      return h('section.fm-col', { 'data-stage': st.id, 'data-empty': mine.length ? undefined : '1', style: `--n:${Math.max(1, Math.min(4, mine.length))}` },
        h('div.fm-col-head', {}, h('b', {}, st.title), h('span', {}, `${mine.length} ${st.sub}`)),
        mine.length ? h('div.pf-col-cards', {}, ...mine.map((x) => card(x.c, x.slot))) : h('p.fm-none', {}, 'None'));
    }));
    const upTo = run.events.filter((e) => e.day <= i);
    const feed = [...(feedAll ? upTo : upTo.filter((e) => e.kind !== 'trade' && e.kind !== 'skip'))].reverse().slice(0, 50);
    const cash = run.cash;
    lower.replaceChildren(
      panel('What happened', `Up to ${shortDay(run.days[i]!)}, newest first`,
        h('div.tl-chips', {}, chip('Milestones', !feedAll, () => { feedAll = false; paintDay(run); }), chip('Every trade and skip, with why', feedAll, () => { feedAll = true; paintDay(run); })),
        h('div.fm-feed', {}, ...(feed.length ? feed.map((e) => h('div.fm-event', { 'data-kind': e.kind }, h('span.fm-event-icon', {}, EVENT_ICON[e.kind]), h('div', {}, h('b', {}, `${e.account || `Slot ${e.slot + 1}`} · ${EVENT_WORD[e.kind]}`), h('p', {}, e.text), e.why ? h('p.pf-because', {}, e.why) : null, h('small', {}, dayLabel(run.days[e.day]!))), e.amount && (e.kind === 'paid' || e.kind === 'bought' || e.kind === 'trade') ? h('span.fm-event-amt', { 'data-tone': e.amount > 0 ? 'up' : 'down' }, signedMoney(e.amount)) : null)) : [h('p.tl-fine', {}, 'Nothing yet.')]))),
      panel('Cash in and out', 'Payouts received less fees paid, after each day',
        chart({
          height: 330, width: 560, n: cash.length + 1, label: 'Net cash by day',
          series: [{ values: [0, ...cash], color: ACCENT, width: 3, area: { fill: 'rgba(126,231,135,.08)', to: 'bottom' }, dot: (k) => (k === i + 1 ? '#fff' : null) }],
          levels: [{ y: 0, color: TONE.faint, label: 'EVEN', dash: '2 6' }],
          xLabel: (k) => (k === 0 ? 'Start' : shortDay(run.days[k - 1]!)),
          yFmt: (v) => `${v < 0 ? '−' : ''}$${Math.abs(v) >= 1000 ? `${(Math.abs(v) / 1000).toFixed(1)}k` : Math.abs(v)}`,
          tip: (k) => (k === 0 ? [h('b', {}, 'Start')] : [h('b', {}, dayLabel(run.days[k - 1]!)), h('span', { 'data-tone': cash[k - 1]! >= 0 ? 'up' : 'down' }, `Net ${signedMoney(cash[k - 1]!)}`), ...run.events.filter((e) => e.day === k - 1 && e.kind !== 'trade' && e.kind !== 'skip').slice(0, 4).map((e) => h('span', {}, `${EVENT_ICON[e.kind]} ${e.account}: ${EVENT_WORD[e.kind].toLowerCase()}`))]),
        }),
        h('p.tl-fine', {}, `By ${shortDay(run.days[i]!)}: ${signedMoney(cash[i] ?? 0)} net.`)));
  }

  /** The answer for the plan as it stands. Only what has changed since the last paint is redrawn. */
  function paint() {
    const p = plan();
    if (!p) return;
    if (p.battle) last = p;
    // Until the new plan's replay is in, the last answer stays up, dimmed.
    const showing = p.battle ? p : last;
    const stale = showing !== p;
    main.toggleAttribute('data-stale', stale);
    progress.toggleAttribute('data-on', !p.done && !p.error);
    (progress.firstElementChild as HTMLElement).style.width = `${Math.round((p.got / Math.max(1, p.total)) * 100)}%`;
    progress.setAttribute('aria-valuenow', String(Math.round((p.got / Math.max(1, p.total)) * 100)));
    const run = showing?.battle ?? null;
    const sig = `${showing?.key}:${!!run}:${!!showing?.odds}:${showing?.error}`;
    if (sig !== painted) {
      painted = sig;
      paintReplay(showing ?? p, run);
      paintOdds(showing ?? p);
      paintCta();
      days$.hidden = !run;
    }
    // The days are redrawn when it is a different replay, not each time another part of the same plan arrives.
    if (run && showing && daysFor !== showing.key) {
      daysFor = showing.key;
      slider.max = String(run.days.length - 1);
      if (day < 0 || day > run.days.length - 1) day = run.days.length - 1;
      slider.value = String(day);
      paintDay(run);
    }
    decorate();
  }

  function render() {
    if (!shown) return;
    const bt = trading.snap?.backtest;
    drawRail();
    const refused = setupProblem(setup);
    if (!detail?.trades.length) {
      // Say which it is: the office not answering, its backtest still running, a backtest that failed or found
      // nothing, or the trades on their way. A spinner is only shown for the ones that will end by themselves.
      const failed = !!bt && !bt.running && !bt.days.length;
      const [head, body, spin] = trading.offline
        ? ['The office isn’t answering', 'This window is showing the last thing the office sent. The battle test fills in as soon as it is back: nothing needs reloading.', true]
        : !bt || bt.running
          ? ['Replaying the month on real bars…', 'The battle test runs on the backtest’s trades. You can set your plan up meanwhile: it fills in the moment the backtest finishes.', true]
          : failed
            ? ['The backtest has no trades', bt.note || 'The backtest finished without any trading days. It runs again after the next close, or from the Backtest tab of the trading panel.', false]
            : ['Fetching the backtest’s trades…', 'The backtest has finished: its trades are on their way.', true];
      main.replaceChildren(h('div.tl-waiting', { role: 'status' }, spin ? h('span.tl-spin') : null, h('b', {}, head), h('p', {}, body)));
      waitingFor = `${trading.offline}:${!!bt}:${bt?.running}:${failed}`;
      painted = daysFor = '';
      return;
    }
    if (refused) {
      main.replaceChildren(h('div.bt-refused', {}, h('span.tl-kicker', {}, 'REFUSED BEFORE RUNNING'), h('b', {}, 'Not a setup the firm allows'), h('p', {}, refused), h('small', {}, 'A request over the firm’s limit is refused, not quietly shrunk, so a result can never be for a setup the firm wouldn’t take.')));
      painted = daysFor = '';
      return;
    }
    if (main.firstElementChild !== progress) {
      main.replaceChildren(progress, hero, cta, days$);
      painted = daysFor = '';
    }
    paint();
  }

  slider.addEventListener('input', () => { stopPlay(); day = Number(slider.value); if (last?.battle) paintDay(last.battle); });
  play.addEventListener('click', () => {
    const run = last?.battle;
    if (!run) return;
    if (playing) return stopPlay();
    day = 0;
    play.textContent = '❚❚ Pause';
    playing = window.setInterval(() => {
      if (day >= run.days.length - 1) return stopPlay();
      day++;
      slider.value = String(day);
      paintDay(run);
    }, 420);
    slider.value = '0';
    paintDay(run);
  });
  // Parts of a plan arrive several times a second: one paint a frame is plenty, and none while it's out of sight.
  const off = planner.on(() => {
    if (!shown || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (shown && detail?.trades.length && !setupProblem(setup)) paint();
    });
  });

  return {
    show() {
      shown = true;
      painted = daysFor = '';
      render();
    },
    hide() {
      if (!shown) return;
      shown = false;
      stopPlay();
      rail.replaceChildren();
    },
    data(d) {
      if (detail === d) return;
      detail = d;
      // Worked out ahead of time, whichever view is open: the battle test is ready when it is turned to.
      plan();
      render();
    },
    /** The office's state moved on while the battle test was waiting for its data: say the new thing. */
    tick() {
      const bt = trading.snap?.backtest;
      if (shown && !detail?.trades.length && waitingFor !== `${trading.offline}:${!!bt}:${bt?.running}:${!!bt && !bt.running && !bt.days.length}`) render();
    },
    dispose: () => { shown = false; stopPlay(); off(); if (frame) cancelAnimationFrame(frame); },
  };
}
