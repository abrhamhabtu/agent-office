import type { BacktestDetail, PlaybookId } from '../../shared/trading';
import { PLAYBOOK_BY_ID } from '../../shared/trading';
import { weekdays } from '../../shared/evalsim';
import { cleanSetup, FARM_DEFAULTS, FARM_PROGRAM_BY_ID, FARM_PROGRAMS, farmDays, farmOdds, programVerified, runFarm, setupProblem, strategyLabel, type FarmCell, type FarmEvent, type FarmOdds, type FarmRun, type FarmSetup, type FarmStage, type FarmStrategy } from '../../shared/farm';
import { STATUS_WORD } from '../../shared/account-ledger';
import { COST_IDS, COSTS } from '../../shared/fills';
import { MANAGE } from '../../shared/manage';
import { splitDays } from '../../shared/validation';
import { h } from '../ui/dom';
import { openEvalSim } from './evalsim';
import { trading } from './feed';
import { badge, chart, chip, dayLabel, money, panel, pct, segmented, shortDay, signedMoney, stat, stored, TONE } from './labkit';
import type { FarmShell } from './farm';

// The battle test: plan a farm and replay it before running it forward. Set it up in four steps on the
// left; on the right the accounts move through their stages over the backtest's days (drag the day, or
// press play), with the odds over redraws of those days beside it. It runs on the days research may look
// at: the holdout's days are left out, so planning a farm never spends them.

const ACCENT = '#7ee787';
const STAGES: { id: FarmStage; title: string; sub: string }[] = [
  { id: 'eval', title: 'Evaluations', sub: 'in play' },
  { id: 'funded', title: 'Funded', sub: 'in the rotation' },
  { id: 'parked', title: 'Parked', sub: 'payout requested' },
  { id: 'busted', title: 'Out', sub: 'lost or not bought' },
];
const EVENT_ICON: Record<FarmEvent['kind'], string> = { bought: '🧾', passed: '✅', busted: '💥', 'payout-ready': '💰', paid: '🏦', trade: '📈', skip: '⏭️', note: '📝' };
const EVENT_WORD: Record<FarmEvent['kind'], string> = { bought: 'OPENED', passed: 'PASSED', busted: 'LOST', 'payout-ready': 'PAYOUT REQUESTED', paid: 'PAID', trade: 'TRADE', skip: 'NO TRADE', note: 'NOTE' };

interface Preset {
  id: string;
  name: string;
  strategy: FarmStrategy;
}
const ALL_MARKETS: FarmStrategy['markets'] = ['NQ', 'ES', 'GC'];
const one = (p: PlaybookId): Preset => ({ id: p, name: PLAYBOOK_BY_ID[p].name, strategy: { playbooks: [p], mode: 'every', manage: 'written', markets: ALL_MARKETS } });

export interface Battle {
  show(): void;
  hide(): void;
  data(detail: BacktestDetail | null): void;
  dispose(): void;
}

export function mountBattle(shell: FarmShell, rail: HTMLElement, main: HTMLElement): Battle {
  const save = stored<Partial<FarmSetup> & { firm?: string }>('agent-office.farm', {});
  const kept = save.get();
  let setup: FarmSetup = cleanSetup({ ...FARM_DEFAULTS, ...kept });
  let firm = FARM_PROGRAM_BY_ID[setup.programId]!.firm;
  let detail: BacktestDetail | null = null;
  let day = 0;
  let playing = 0;
  let feedAll = false;
  let shown = false;
  const persist = () => save.set({ ...setup, firm });

  const money$ = h('div');
  const pipeline = h('div.fm-pipe');
  const lower = h('div.tl-cols');
  const dayRead = h('span.fm-day');
  const slider = h('input.tl-range.fm-scrub', { type: 'range', min: '0', max: '0', step: '1', 'aria-label': 'Day of the run' }) as HTMLInputElement;
  const play = h('button.tl-btn.fm-play', { type: 'button', 'aria-label': 'Replay the run day by day' }, '▶ Replay') as HTMLButtonElement;
  const timeline = h('div.fm-timeline', {}, play, slider, dayRead);
  const stopPlay = () => {
    if (playing) clearInterval(playing);
    playing = 0;
    play.textContent = '▶ Replay';
  };

  const change = (patch: Partial<FarmSetup>) => {
    setup = cleanSetup({ ...setup, ...patch });
    persist();
    compute();
    render();
  };

  // ---- The numbers: worked out when the setup or the data changes, not on every drag of the day ----
  let lists: ReturnType<typeof farmDays> = [];
  let days: string[] = [];
  let held = 0;
  let battle: FarmRun | null = null;
  let odds: FarmOdds | null = null;
  let perProgram = new Map<string, FarmOdds>();
  let evalLadder: { micros: number; odds: FarmOdds }[] = [];
  let fundedLadder: { micros: number; odds: FarmOdds }[] = [];
  let presets: Preset[] = [];
  const limits = (s: FarmSetup) => {
    const p = FARM_PROGRAM_BY_ID[s.programId]!;
    return { evalMax: p.evalRules?.maxMicros ?? 0, fundedMax: p.fundedRules.maxMicros };
  };
  function compute() {
    if (!detail?.trades.length) return;
    // The holdout's days are kept out of planning: only what research may look at.
    const split = splitDays(weekdays(detail.days));
    days = [...split.train, ...split.validation];
    held = split.holdout.length;
    lists = farmDays(detail.trades, setup.strategy, days);
    const { evalMax, fundedMax } = limits(setup);
    // A cap from another program that this one doesn't allow is brought inside its limit.
    if (evalMax && setup.evalMicros > evalMax) setup = { ...setup, evalMicros: evalMax };
    if (setup.fundedMicros > fundedMax) setup = { ...setup, fundedMicros: fundedMax };
    battle = runFarm(lists, setup, days);
    odds = farmOdds(lists, setup, { runs: 200, horizon: 60, block: 2 });
    perProgram = new Map(FARM_PROGRAMS.map((p) => {
      const s = { ...setup, programId: p.id, fee: null };
      const lim = limits(s);
      return [p.id, farmOdds(lists, { ...s, evalMicros: Math.min(s.evalMicros, lim.evalMax || s.evalMicros), fundedMicros: Math.min(s.fundedMicros, lim.fundedMax) }, { runs: 60, horizon: 60, block: 2 })];
    }));
    const ladder = (max: number, key: 'evalMicros' | 'fundedMicros') => [...new Set([1, 2, 3, 5, 10, 15, 20, max].filter((n) => n >= 1 && n <= max))].sort((a, b) => a - b).map((micros) => ({ micros, odds: farmOdds(lists, { ...setup, [key]: micros }, { runs: 60, horizon: 60, block: 2 }) }));
    evalLadder = evalMax ? ladder(evalMax, 'evalMicros') : [];
    fundedLadder = ladder(fundedMax, 'fundedMicros');
    const mix = trading.snap?.backtest?.mixes?.find((m) => m.order.length > 1 && m.mode !== 'every' && m.trades >= 20);
    presets = [
      ...(mix ? [{ id: 'mix', name: 'The lab’s best mix', strategy: { playbooks: mix.order, mode: mix.mode, manage: 'written' as const, markets: ALL_MARKETS } }] : []),
      one('support-resistance'), one('failed-auction'), one('vwap-pullback'), one('double-break'),
    ];
    day = Math.max(0, battle.days.length - 1);
  }

  // ---- Drawing ---------------------------------------------------------------------------------------
  const stepper = (value: number, min: number, max: number, set: (v: number) => void, label: string) =>
    h('div.fm-stepper', { role: 'group', 'aria-label': label },
      h('button', { type: 'button', disabled: value <= min, 'aria-label': `Fewer: ${label}`, onclick: () => set(value - 1) }, '−'),
      h('b', {}, String(value)),
      h('button', { type: 'button', disabled: value >= max, 'aria-label': `More: ${label}`, onclick: () => set(value + 1) }, '+'));
  const short = (v: number) => `${v >= 0 ? '+' : '−'}$${Math.abs(v) >= 1000 ? `${(Math.abs(v) / 1000).toFixed(1)}k` : Math.abs(v)}`;
  const ladderRow = (rows: { micros: number; odds: FarmOdds }[], now: number, pick: (n: number) => void) => {
    if (!rows.length) return null;
    const best = rows.reduce((a, b) => (b.odds.mean > a.odds.mean ? b : a), rows[0]!);
    return h('div.fm-ladder', {}, ...rows.map((r) => h('button', { type: 'button', 'aria-pressed': String(r.micros === now), 'data-best': r === best ? '1' : undefined, title: `Up to ${r.micros} micros: ${signedMoney(r.odds.mean)} net on average over ${r.odds.horizon} days, ahead in ${pct(r.odds.ahead)} of redraws, ${pct(r.odds.breachRate)} of accounts lost`, onclick: () => pick(r.micros) },
      h('b', {}, String(r.micros)), h('small', { 'data-tone': r.odds.mean >= 0 ? 'up' : 'down' }, short(r.odds.mean)), r === best ? h('i', {}, '★') : null)));
  };

  function drawRail() {
    const program = FARM_PROGRAM_BY_ID[setup.programId]!;
    const firms = [...new Set(FARM_PROGRAMS.map((p) => p.firm))];
    const { evalMax, fundedMax } = limits(setup);
    const fee = h('input.tl-input', { type: 'number', min: '0', step: '1', value: String(setup.fee ?? program.fee), 'aria-label': 'What one attempt costs', onchange: (e: Event) => change({ fee: Number((e.target as HTMLInputElement).value) }) });
    const samePreset = (p: Preset) => p.strategy.mode === setup.strategy.mode && p.strategy.playbooks.length === setup.strategy.playbooks.length && p.strategy.playbooks.every((x, i) => x === setup.strategy.playbooks[i]);
    const step = (n: number, title: string, ...kids: (Node | null)[]) => h('section.fm-step', {}, h('div.fm-step-head', {}, h('span', {}, String(n)), h('b', {}, title)), ...kids.filter((k): k is Node => !!k));
    rail.replaceChildren(
      step(1, 'Pick the firm and the program',
        h('div.tl-seg.fm-firms', { role: 'group' }, ...firms.map((f) => h('button', { type: 'button', 'aria-pressed': String(f === firm), onclick: () => { firm = f; if (FARM_PROGRAM_BY_ID[setup.programId]!.firm !== f) change({ programId: FARM_PROGRAMS.find((p) => p.firm === f)!.id, fee: null }); else { persist(); render(); } } }, f))),
        ...FARM_PROGRAMS.filter((p) => p.firm === firm).map((p) => {
          const o = perProgram.get(p.id);
          return h('button.fm-program', { type: 'button', 'aria-pressed': String(p.id === setup.programId), onclick: () => change({ programId: p.id, fee: null }) },
            h('span.fm-program-top', {}, h('b', {}, p.name), programVerified(p) ? badge('RULES VERIFIED', 'ok', 'Read on the firm’s own pages, 2 October 2026') : badge('WHAT-IF RULES', 'warn', 'From public summaries: every number is to be checked with the firm')),
            h('small', {}, p.note),
            o?.runs ? h('span.fm-program-odds', { 'data-tone': o.mean >= 0 ? 'up' : 'down' }, `${signedMoney(o.mean)} on average in ${o.horizon} days · ahead ${pct(o.ahead)}`) : null);
        }),
        h('label.tl-inline.fm-fee', {}, 'One attempt costs $', fee, program.feeEstimated && setup.fee == null ? h('em', {}, 'not the firm’s published price: set yours') : null)),
      step(2, 'How many accounts',
        h('div.fm-row', {}, stepper(setup.slots, 1, 5, (v) => change({ slots: v }), 'accounts side by side'), h('small', {}, 'side by side')),
        h('div.fm-row', {}, stepper(setup.maxAttempts, 1, 60, (v) => change({ maxAttempts: v }), 'attempts in all'), h('small', {}, `attempts in all (${money(setup.maxAttempts * (setup.fee ?? program.fee))} of fees at most)`)),
        segmented<FarmSetup['share']>([{ id: 'rotate', label: 'Take turns' }, { id: 'copy', label: 'All take every trade' }], setup.share, (v) => change({ share: v })),
        h('small', {}, setup.share === 'rotate' ? 'Each signal goes to the next account in turn. An opposite position on another account is refused.' : 'Every account takes every signal: they win and lose together, which is one result counted several times.')),
      step(3, 'What they trade',
        h('div.fm-presets', {}, ...presets.map((p) => chip(p.name, samePreset(p), () => change({ strategy: { ...p.strategy, manage: setup.strategy.manage } }), { color: PLAYBOOK_BY_ID[p.strategy.playbooks[0]!].color }))),
        h('small', {}, strategyLabel(setup.strategy)),
        h('label.tl-inline', {}, 'Managed', h('select.tl-input', { 'aria-label': 'How a trade is managed', onchange: (e: Event) => change({ strategy: { ...setup.strategy, manage: (e.target as HTMLSelectElement).value as FarmStrategy['manage'] } }) }, ...MANAGE.map((m) => h('option', { value: m.id, selected: m.id === setup.strategy.manage }, m.short)))),
        h('label.tl-inline', {}, 'Costs', h('select.tl-input', { 'aria-label': 'What every fill pays', onchange: (e: Event) => change({ cost: (e.target as HTMLSelectElement).value as FarmSetup['cost'] }) }, ...COST_IDS.map((c) => h('option', { value: c, selected: c === setup.cost }, COSTS[c].name)))),
        h('small', {}, COSTS[setup.cost].what)),
      step(4, 'How big',
        segmented<FarmSetup['sizing']>([{ id: 'cap', label: 'Up to the cap' }, { id: 'cushion', label: 'Off the cushion' }], setup.sizing, (v) => change({ sizing: v })),
        h('small', {}, setup.sizing === 'cap' ? 'Ask for the cap on every trade, as far as the cushion can carry it at that trade’s stop. A cap is an upper bound, not an order size.' : 'A tenth of the cushion a trade and a fifth a day (the Law of 10), never more than the cap.'),
        evalMax ? h('div.fm-size', {}, h('span.tl-label', {}, `Evaluation · up to ${setup.evalMicros} micros (the firm allows ${evalMax})`), ladderRow(evalLadder, setup.evalMicros, (n) => change({ evalMicros: n }))) : h('small', {}, 'No evaluation in this program: it starts funded.'),
        h('div.fm-size', {}, h('span.tl-label', {}, `Funded · up to ${setup.fundedMicros} micros (the firm allows ${program.fundedRules.scaling ? `${program.fundedRules.scaling[0]!.micros} to start, ${fundedMax} at most` : fundedMax})`), ladderRow(fundedLadder, setup.fundedMicros, (n) => change({ fundedMicros: n }))),
        h('small', {}, 'Under each size: what the farm nets on average in 60 days at it. ★ is the best of them on these days.'),
        h('button.tl-toggle', { type: 'button', role: 'switch', 'aria-checked': String(setup.fundedOneAndDone), onclick: () => change({ fundedOneAndDone: !setup.fundedOneAndDone }) }, h('i'), h('span', {}, h('b', {}, 'Funded: one winner and done'), h('small', {}, 'Keeps each day small and steady, which payout rules reward')))),
      h('button.tl-btn', { type: 'button', title: 'Test one account in detail', onclick: () => openEvalSim({ playbooks: setup.strategy.playbooks, plan: setup.strategy.mode, manage: setup.strategy.manage }) }, '🏦 One account in detail: the eval simulator'));
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
            c.last ? h('small', {}, `last: ${c.last}`) : h('small', {}, 'no trade yet'),
            h('small', {}, c.stage === 'funded' || c.stage === 'parked' ? `${c.profitDays} of ${c.profitDaysNeeded} payout days · ${c.why}` : c.why)));
  };

  function drawDay(run: FarmRun) {
    const i = Math.max(0, Math.min(run.days.length - 1, day));
    dayRead.replaceChildren(h('b', {}, `Day ${i + 1} of ${run.days.length}`), ` · ${dayLabel(run.days[i]!)}`);
    const cells = run.cells[i] ?? [];
    pipeline.replaceChildren(...STAGES.map((st) => {
      const mine = cells.map((c, slot) => ({ c, slot })).filter((x) => (st.id === 'busted' ? x.c.stage === 'busted' || x.c.stage === 'empty' : x.c.stage === st.id));
      return h('section.fm-col', { 'data-stage': st.id },
        h('div.fm-col-head', {}, h('b', {}, st.title), h('span', {}, `${mine.length} ${st.sub}`)),
        ...(mine.length ? mine.map((x) => card(x.c, x.slot)) : [h('p.fm-none', {}, '—')]));
    }));
    const upTo = run.events.filter((e) => e.day <= i);
    const feed = [...(feedAll ? upTo : upTo.filter((e) => e.kind !== 'trade' && e.kind !== 'skip'))].reverse().slice(0, 50);
    const cash = run.cash;
    lower.replaceChildren(
      panel('What happened', `Up to ${shortDay(run.days[i]!)}, newest first`,
        h('div.tl-chips', {}, chip('Milestones', !feedAll, () => { feedAll = false; drawDay(run); }), chip('Every trade and skip, with why', feedAll, () => { feedAll = true; drawDay(run); })),
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

  function render() {
    if (!shown) return;
    const bt = trading.snap?.backtest;
    if (!detail?.trades.length) {
      rail.replaceChildren(h('span.tl-kicker', {}, 'SET IT UP'));
      main.replaceChildren(h('div.tl-waiting', {}, h('span.tl-spin'), h('b', {}, bt?.running || !bt ? 'Replaying the month on real bars…' : 'No backtest trades yet'), h('p', {}, 'The battle test runs on the backtest’s trades. It fills in the moment the backtest finishes.')));
      return;
    }
    drawRail();
    const run = battle;
    const refused = setupProblem(setup);
    const program = FARM_PROGRAM_BY_ID[setup.programId]!;
    const forward = h('button.tl-btn.primary', { type: 'button', disabled: !!refused, onclick: async () => { if (await shell.act({ action: 'run-start', setup }, 'A forward run has started: decisions are recorded from now')) shell.go('forward'); } }, 'Run this farm forward on paper →');
    if (!run || refused) {
      main.replaceChildren(h('div.tl-hero', { 'data-result': 'busted' }, h('div.tl-verdict', {}, h('span.tl-kicker', {}, 'REFUSED BEFORE RUNNING'), h('div.tl-verdict-word', { 'data-size': 'm', 'data-tone': 'down' }, 'Not a legal setup'), h('p', {}, refused ?? 'This setup can’t be run.')), h('div.tl-odds', {}, h('p', {}, 'A request over the firm’s limit is refused, not quietly shrunk, so a result can never be for a setup the firm wouldn’t allow.'))));
      return;
    }
    slider.max = String(run.days.length - 1);
    day = Math.max(0, Math.min(run.days.length - 1, day));
    slider.value = String(day);
    const net = run.cash[run.cash.length - 1] ?? 0;
    const lost = run.evalBusts + run.fundedBusts;
    money$.replaceChildren(h('div.tl-hero', { 'data-result': net > 0 ? 'passed' : net < 0 ? 'busted' : 'running' },
      h('div.tl-verdict', {},
        h('span.tl-kicker', {}, `${program.firm} · ${program.name} · ${setup.slots} account${setup.slots === 1 ? '' : 's'} · ${strategyLabel(setup.strategy)}`.toUpperCase()),
        h('div.tl-verdict-word', { 'data-tone': net > 0 ? 'up' : net < 0 ? 'down' : 'warn' }, signedMoney(net), h('span', {}, `net over the ${run.days.length} days`)),
        h('p', {}, `${run.attempts} attempt${run.attempts === 1 ? '' : 's'} bought for ${money(run.fees)}. ${program.evalRules ? `${run.passed} passed the evaluation. ` : ''}${run.payoutCount} payout${run.payoutCount === 1 ? '' : 's'} worth ${money(run.payouts)}${lost ? `, and ${lost} account${lost === 1 ? '' : 's'} lost${run.spent ? ` (${run.spent} spent rather than breached)` : ''}` : ''}. ${run.taken} trades taken, ${run.skipped} setups nothing could size.`),
        h('div.tl-stats', {},
          stat('Fees paid', money(run.fees), { tone: 'down', sub: `${run.attempts} × ${money(setup.fee ?? program.fee)}` }),
          stat('Payouts', money(run.payouts), { tone: run.payouts ? 'up' : undefined, sub: run.firstPayoutDay != null ? `first requested day ${run.firstPayoutDay + 1}` : 'none yet' }),
          stat('Costs in fills', money(run.costs), { sub: COSTS[setup.cost].name.toLowerCase() }),
          stat('Accounts lost', String(lost), { tone: lost ? 'down' : undefined, sub: `worst streak ${money(run.worstStreak)}` })),
        h('div.pf-acts', {}, forward,
          h('button.tl-btn', { type: 'button', disabled: !!refused, title: 'The paper book’s trades so far become decisions too, each marked late: they fill the ledgers and count for nothing as forward evidence', onclick: async () => { if (await shell.act({ action: 'run-start', setup, from: 'back' }, 'A forward run has started, with the paper book’s history marked late')) shell.go('forward'); } }, '…and include the paper book so far'),
          h('small', {}, 'Nothing is bought and no order is placed: the office opens the accounts in a simulation and writes down every decision from now.'))),
      h('div.tl-odds', {},
        h('span.tl-kicker', {}, 'THE ODDS, OVER 60 TRADING DAYS'),
        odds?.runs
          ? h('div.tl-odds-main', {},
              h('div.tl-odds-big', {}, h('b', { 'data-tone': odds.mean >= 0 ? 'up' : 'down' }, signedMoney(odds.mean)), h('span', {}, 'net on average')),
              h('div.tl-odds-meter', {}, h('i', { 'data-k': 'pass', style: `width:${odds.ahead * 100}%` }), h('i', { 'data-k': 'bust', style: `width:${(1 - odds.ahead) * 100}%` })),
              h('div.tl-odds-legend', {}, h('span', { 'data-k': 'pass' }, `${pct(odds.ahead)} end ahead (${pct(odds.aheadRange[0])}–${pct(odds.aheadRange[1])})`), h('span', { 'data-k': 'bust' }, `${pct(1 - odds.ahead)} end behind`)),
              h('div.pf-oddsgrid', {},
                stat('Typical', signedMoney(odds.p50), { sub: `${signedMoney(odds.p10)} … ${signedMoney(odds.p90)}` }),
                stat(program.evalRules ? 'Pass rate' : 'Reach a payout', pct(odds.passRate), { sub: `${odds.attempts.toFixed(1)} attempts` }),
                stat('Accounts lost', pct(odds.breachRate), { tone: odds.breachRate > 0.5 ? 'down' : undefined }),
                stat('First payout', odds.daysToPayout == null ? 'never' : `day ${odds.daysToPayout}`, { sub: `in ${pct(odds.payoutRate)} of runs` })),
              h('small', {}, `${odds.runs} redraws of ${odds.sampleDays} real days (${odds.sampleTrades} trades), in runs of two days. ${held ? `The last ${held} days of the backtest are the holdout and aren’t used here. ` : ''}Conditional scenarios on paper, not a forecast.`))
          : h('p', {}, 'No trades to draw from for this strategy.'))));
    main.replaceChildren(money$, timeline, pipeline, lower);
    drawDay(run);
  }

  slider.addEventListener('input', () => { stopPlay(); day = Number(slider.value); if (battle) drawDay(battle); });
  play.addEventListener('click', () => {
    if (!battle) return;
    if (playing) return stopPlay();
    day = 0;
    play.textContent = '❚❚ Pause';
    playing = window.setInterval(() => {
      if (!battle || day >= battle.days.length - 1) return stopPlay();
      day++;
      slider.value = String(day);
      drawDay(battle);
    }, 420);
    slider.value = '0';
    drawDay(battle);
  });

  return {
    show() {
      shown = true;
      render();
    },
    hide() {
      if (!shown) return;
      shown = false;
      stopPlay();
      rail.replaceChildren();
    },
    data(d) {
      detail = d;
      compute();
      render();
    },
    dispose: stopPlay,
  };
}
