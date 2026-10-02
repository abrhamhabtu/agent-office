import type { BacktestDetail, PaperTrade, PlaybookId, PropRules, Symbol } from '../../shared/trading';
import { PLAYBOOK_BY_ID, PLAYBOOKS } from '../../shared/trading';
import { ACCOUNT_CATALOG, isOwnAccount } from '../../shared/prop-catalog';
import { applyFilters, envOf, FILTER_BY_ID, type FilterId } from '../../shared/backtest-lab';
import { applyPlan, FALLBACK_AFTER, planLabel, plansOf, TREND_ADX, type DayPlan, type PlanMode } from '../../shared/dayplan';
import { MANAGE, MANAGE_BY_ID, managed, type ManageId } from '../../shared/manage';
import { TUNED_PLAYBOOKS } from '../../shared/tuning';
import { evalOdds, runEval, weekdays, type EvalDetail, type EvalOdds, type EvalOptions } from '../../shared/evalsim';
import { h, openModal } from '../ui/dom';
import { openBacktestLab } from './backtestlab';
import { trading } from './feed';
import { chart, chip, dayLabel, howSheet, money, panel, pct, segmented, shortDay, signedMoney, stat, stored, TONE } from './labkit';

// The prop eval simulator, opened from its board in the Back Office. Pick an account (an evaluation or a
// straight-to-funded one), pick what to trade on it, and the backtest's real trades are played through
// that account's rules: the verdict, the balance day by day against the target and the trailing floor,
// and the odds if the same days had come in another order. Every setting redraws it at once.

const ACCENT = '#b794f4';
/** A prop firm's eval is traded on index futures and gold: Bitcoin isn't on the menu. */
const MARKETS: Symbol[] = ['NQ', 'ES', 'GC'];
const DIAL = [5, 8, 10, 15, 20];
const HORIZONS = [30, 60, 90];
const DD_LABEL: Record<PropRules['drawdownType'], string> = { 'trailing-eod': 'trails the end-of-day high', 'trailing-intraday': 'trails the intraday high', static: 'fixed, never moves' };
/** "Topstep Combine 50K", but not "Lucid LucidFlex 50K". */
const acctName = (a: PropRules) => (a.program.toLowerCase().includes(a.firm.toLowerCase().split(' ')[0]!) ? a.program : `${a.firm} ${a.program}`).replace(/\s*\(funded\)/i, '');
const RESULT = { passed: { word: 'PASSED', tone: 'up' }, busted: { word: 'BUSTED', tone: 'down' }, running: { word: 'STILL GOING', tone: 'warn' } } as const;

interface Saved {
  /** Which accounts the list shows: the kind, the firm and the size (0 is every size). */
  kind: 'eval' | 'funded';
  firm: string;
  size: number;
  /** Trade the tuner's candidate versions of the playbooks instead of the live ones. */
  candidates: boolean;
  /** How the picked playbooks are traded together in a day (see shared/dayplan.ts). */
  plan: PlanMode;
  oneAndDone: boolean;
  maxTrades: number;
  /** How a trade is managed once it's working (see shared/manage.ts). */
  manage: ManageId;
  account: string;
  playbooks: PlaybookId[];
  markets: Symbol[];
  sizing: 'law' | 'fixed' | 'contracts';
  /** Micros on every trade, when the sizing is a fixed contract count. */
  fixedMicros: number;
  divisor: number;
  fixedRisk: number;
  dailyStop: boolean;
  consistency: boolean;
  startReal: boolean;
  view: 'month' | 'odds';
  horizon: number;
  /** Rules the owner changed, by account, over the firm's. */
  custom: Record<string, Partial<PropRules>>;
}

const DEFAULTS: Saved = { kind: 'eval', firm: 'all', size: 0, candidates: false, plan: 'every', oneAndDone: false, maxTrades: 0, manage: 'written', account: ACCOUNT_CATALOG[0]!.id, playbooks: ['double-break'], markets: [...MARKETS], sizing: 'law', divisor: 10, fixedRisk: 150, fixedMicros: 5, dailyStop: true, consistency: true, startReal: false, view: 'month', horizon: 60, custom: {} };

export interface EvalSimInit {
  account?: string;
  playbooks?: PlaybookId[];
  markets?: Symbol[];
  /** Indicator filters carried over from the Backtest Lab. */
  filters?: FilterId[];
  /** Trade the tuner's candidate versions (carried over when the lab was looking at one). */
  candidates?: boolean;
  /** A game plan to open on (the playbooks are its order). */
  plan?: PlanMode;
  manage?: ManageId;
  /** Opened from the Live eval display: go straight to its panel. */
  live?: boolean;
}

export function openEvalSim(init: EvalSimInit = {}) {
  const save = stored<Partial<Saved>>('agent-office.eval-sim', {});
  const st: Saved = { ...DEFAULTS, ...save.get() };
  if (init.account) st.account = init.account;
  if (init.playbooks?.length) st.playbooks = init.playbooks;
  if (init.markets?.length) st.markets = init.markets.filter((m) => MARKETS.includes(m));
  if (init.candidates != null) st.candidates = init.candidates;
  if (init.manage) st.manage = init.manage;
  if (!(st.manage in MANAGE_BY_ID)) st.manage = 'written';
  if (init.plan) st.plan = init.plan;
  else if (init.playbooks?.length) st.plan = 'every';
  if (!ACCOUNT_CATALOG.some((a) => a.id === st.account)) st.account = DEFAULTS.account;
  // The list opens on the kind of account that's selected, so it's never hidden behind the other tab.
  st.kind = ACCOUNT_CATALOG.find((a) => a.id === st.account)!.kind;
  st.playbooks = st.playbooks.filter((p) => p in PLAYBOOK_BY_ID);
  if (!st.playbooks.length) st.playbooks = [...DEFAULTS.playbooks];
  if (!st.markets.length) st.markets = [...MARKETS];
  let filters: FilterId[] = (init.filters ?? []).filter((f) => f in FILTER_BY_ID);
  let detail: BacktestDetail | null = null;
  let loadedFor = '';
  let how = false;
  let ledgerOpen = false;

  const rulesOf = (id: string): PropRules => ({ ...ACCOUNT_CATALOG.find((a) => a.id === id)!, ...(st.custom[id] ?? {}) });
  const realOf = (id: string) => trading.snap?.accounts.find((a) => a.rules.id === id);
  const persist = () => save.set(st);

  // ---- The frame: built once. What's inside each part is redrawn; the sliders and fields stay put. ----
  const rail = h('aside.tl-rail');
  const secStrategy = h('div.tl-bar-row');
  const secHero = h('div');
  const secChart = h('div');
  const secChecks = h('div.tl-checks');
  const dialTable = h('div');
  const dialLabel = h('span.tl-dial-read');
  const secSuggest = h('div');
  const secRules = h('div');
  const secLedger = h('div');
  const secLive = h('div');
  let liveNote = '';
  const sheet = h('div.tl-sheet');
  const status = h('span.grow');
  const rerun = h('button.tl-btn', { type: 'button', onclick: () => void trading.post('/api/trading/backtest', {}) }, '↻ Re-run the backtest') as HTMLButtonElement;
  const close = h('button.btn.close', { type: 'button', 'aria-label': 'Close the eval simulator', title: 'Close (Esc)' }, '✕');

  const slider = h('input.tl-range', { type: 'range', min: '4', max: '20', step: '1', 'aria-label': 'Risk per trade as a fraction of the drawdown left' }) as HTMLInputElement;
  slider.value = String(st.divisor);
  const fixedIn = h('input.tl-input', { type: 'number', min: '10', step: '10', 'aria-label': 'Fixed dollar risk per trade' }) as HTMLInputElement;
  fixedIn.value = String(st.fixedRisk);
  const microsIn = h('input.tl-input', { type: 'number', min: '1', max: '200', step: '1', 'aria-label': 'Micros on every trade' }) as HTMLInputElement;
  microsIn.value = String(st.fixedMicros);
  const sizingSeg = h('div');
  const toggles = h('div.tl-toggles');
  const dialControls = h('div.tl-dial');

  const main = h('div.tl-main', {},
    secStrategy, secHero, secLive, secChart, secChecks,
    h('div.tl-cols', {},
      h('section.tl-panel', {}, h('div.tl-panel-head', {}, h('h3', {}, 'Risk dial'), h('span', {}, 'How much of the cushion each trade risks')), sizingSeg, dialControls, toggles, dialTable),
      secSuggest),
    h('div.tl-cols', {}, secRules, secLedger));
  const el = h('div.modal.tl.tl-sim', { role: 'dialog', 'aria-label': 'Prop eval simulator', style: `--tl-accent:${ACCENT}` },
    h('header.tl-header', {},
      h('div.tl-title', {}, h('span.tl-kicker', {}, 'BACK OFFICE · WALL DISPLAY'), h('h2', {}, '🏦 Prop eval simulator')),
      h('button.tl-btn', { type: 'button', onclick: () => { how = !how; render(); } }, 'How it works'),
      h('button.tl-btn', { type: 'button', title: 'The backtest behind these trades', onclick: () => { modal.close(); openBacktestLab({ playbook: st.playbooks.length === 1 ? st.playbooks[0] : 'all', filters, manage: st.manage }); } }, '🧪 Backtest lab'),
      close),
    h('div.tl-body', {}, rail, main, sheet),
    h('footer.tl-footer', {}, status, rerun));
  let off = () => {};
  const modal = openModal(el, { doing: 'running the eval simulator', onClose: () => off() });
  close.addEventListener('click', () => modal.close());

  // ---- The numbers -----------------------------------------------------------------------------------
  /** What these playbooks called, before any plan or management (the plan decides on the trades as the playbook wrote them). */
  const tradesFor = (playbooks: PlaybookId[]): PaperTrade[] => {
    if (!detail) return [];
    const d = detail;
    // A playbook with a candidate version trades that version's trades when the switch is on.
    const picked = playbooks.flatMap((p) => (st.candidates ? candidateOf(p)?.trades : undefined) ?? d.trades.filter((t) => t.playbook === p)).filter((t) => st.markets.includes(t.symbol));
    return filters.length ? applyFilters(picked, filters, envOf(d.trades)) : picked;
  };
  /** The game plan as it stands: the picked playbooks, in the order they were picked. */
  const planNow = (): DayPlan => ({ mode: st.playbooks.length > 1 ? st.plan : 'every', order: st.playbooks, oneAndDone: st.oneAndDone, maxTrades: st.maxTrades });
  /** The trades a plan takes out of everything its playbooks called. */
  const planned = (plan: DayPlan, style: ManageId = st.manage): PaperTrade[] => managed(applyPlan(tradesFor(plan.order), plan), style);
  /** The newest candidate version of a playbook, when the tuner has one. */
  const candidateOf = (p: PlaybookId) => [...(detail?.versions ?? [])].filter((v) => v.playbook === p).sort((a, b) => b.version - a.version)[0];
  const versionInfo = (p: PlaybookId, version: number) => trading.snap?.backtest?.tuner?.books.find((b) => b.playbook === p)?.versions.find((v) => v.version === version);
  const optsFor = (id: string, divisor = st.divisor): Partial<EvalOptions> => {
    const real = st.startReal && id === st.account ? realOf(id) : undefined;
    return { divisor, fixedRisk: st.sizing === 'fixed' ? Math.max(1, st.fixedRisk) : null, fixedMicros: st.sizing === 'contracts' ? Math.max(1, st.fixedMicros) : null, dailyStop: st.dailyStop, consistency: st.consistency, start: real ? { balance: real.balance, peak: real.peak } : null };
  };
  const strategyName = () => (st.playbooks.length === 1 ? PLAYBOOK_BY_ID[st.playbooks[0]!].name : st.plan === 'every' ? `${st.playbooks.length} playbooks together` : planLabel({ ...planNow(), oneAndDone: false, maxTrades: 0 }));

  const oddsBar = (o: EvalOdds) => h('span.tl-oddsbar', { title: `${pct(o.pass)} pass · ${pct(o.running)} still going · ${pct(o.bust)} bust` }, h('i', { 'data-k': 'pass', style: `width:${o.pass * 100}%` }), h('i', { 'data-k': 'run', style: `width:${o.running * 100}%` }), h('i', { 'data-k': 'bust', style: `width:${o.bust * 100}%` }));

  // ---- Drawing -----------------------------------------------------------------------------------------
  /** The accounts the picker's kind, firm and size leave: the owner's own first, then the likeliest to pass. */
  const listed = () => ACCOUNT_CATALOG.filter((a) => a.kind === st.kind && (st.firm === 'all' || a.firm === st.firm) && (!st.size || a.size === st.size));

  function drawRail(perAccount: Map<string, EvalOdds>) {
    const ofKind = ACCOUNT_CATALOG.filter((a) => a.kind === st.kind);
    const firms = [...new Set(ofKind.map((a) => a.firm))];
    const sizes = [...new Set(ofKind.filter((a) => st.firm === 'all' || a.firm === st.firm).map((a) => a.size))].sort((a, b) => a - b);
    const score = (id: string) => { const o = perAccount.get(id); return o?.runs ? o.pass - o.bust : -2; };
    const list = listed().sort((a, b) => Number(isOwnAccount(b.id)) - Number(isOwnAccount(a.id)) || score(b.id) - score(a.id));
    /** Changing what's listed moves the selection onto the list, so the answer on the right always belongs to it. */
    const show = (patch: Partial<Pick<Saved, 'kind' | 'firm' | 'size'>>) => {
      Object.assign(st, patch);
      if (patch.kind) { st.firm = 'all'; st.size = 0; }
      if (!listed().some((a) => a.id === st.account)) st.account = (listed().find((a) => isOwnAccount(a.id)) ?? listed()[0] ?? ACCOUNT_CATALOG[0]!).id;
      persist();
      render();
    };
    const count = (k: Saved['kind']) => ACCOUNT_CATALOG.filter((a) => a.kind === k).length;
    rail.replaceChildren(
      h('span.tl-kicker', {}, 'PICK AN ACCOUNT'),
      h('div.tl-kind', { role: 'group', 'aria-label': 'Kind of account' },
        h('button', { type: 'button', 'aria-pressed': String(st.kind === 'eval'), onclick: () => show({ kind: 'eval' }) }, h('b', {}, 'Evaluation'), h('small', {}, `Pass a test first · ${count('eval')} accounts`)),
        h('button', { type: 'button', 'aria-pressed': String(st.kind === 'funded'), 'data-kind': 'funded', onclick: () => show({ kind: 'funded' }) }, h('b', {}, 'Straight to funded'), h('small', {}, `No test: trade for a payout · ${count('funded')} accounts`))),
      h('div.tl-pick', {},
        h('select.tl-input', { 'aria-label': 'Firm', onchange: (e: Event) => show({ firm: (e.target as HTMLSelectElement).value, size: 0 }) }, h('option', { value: 'all', selected: st.firm === 'all' }, `Every firm (${ofKind.length})`), ...firms.map((f) => h('option', { value: f, selected: st.firm === f }, `${f} (${ofKind.filter((a) => a.firm === f).length})`))),
        h('div.tl-chips', {}, chip('Any size', !st.size, () => show({ size: 0 })), ...sizes.map((z) => chip(`${z / 1000}K`, st.size === z, () => show({ size: z }))))),
      ...list.map((base) => {
        const a = rulesOf(base.id);
        const o = perAccount.get(a.id);
        const real = realOf(a.id);
        return h('button.tl-acct', { type: 'button', 'data-kind': a.kind, 'aria-pressed': String(st.account === a.id), onclick: () => { st.account = a.id; persist(); render(); } },
          h('span.tl-acct-top', {}, h('b', {}, `$${a.size / 1000}K`), h('span.tl-acct-firm', {}, a.firm), isOwnAccount(a.id) ? h('span.tl-tag', { 'data-kind': 'own', title: 'One of the accounts the risk guard follows' }, 'YOURS') : null),
          h('span.tl-acct-name', {}, a.program.replace(/\s*\(funded\)/i, ''), st.custom[a.id] ? h('em', {}, ' · edited') : null),
          h('span.tl-acct-rule', {}, `${money(a.profitTarget)} ${a.kind === 'funded' ? 'to a payout' : 'target'} · ${money(a.drawdown)} drawdown`),
          o && o.runs ? h('span.tl-acct-odds', {}, oddsBar(o), h('b', {}, `${pct(o.pass)} ${a.kind === 'funded' ? 'paid' : 'pass'}`)) : h('span.tl-acct-odds', {}, h('small', {}, 'no trades to test')),
          real?.active ? h('span.tl-acct-live', { title: 'One of your active accounts' }, `● active · ${money(real.balance)}`) : null);
      }),
      h('p.tl-rail-note', {}, `Sorted by the odds for the strategy you’ve picked${list.some((a) => isOwnAccount(a.id)) ? ', your own accounts first' : ''}: green ${st.kind === 'funded' ? 'reaches a payout' : 'passes'}, amber is still going, red busts. Rules for accounts that aren’t yours are from public summaries: check them with the firm.`));
  }

  function drawStrategy() {
    const toggle = (id: PlaybookId) => {
      const has = st.playbooks.includes(id);
      if (has && st.playbooks.length === 1) return;
      st.playbooks = has ? st.playbooks.filter((p) => p !== id) : [...st.playbooks, id];
      // A split by the kind of day is between two: picking a third replaces the second.
      if (st.plan === 'by-day' && st.playbooks.length > 2) st.playbooks = [st.playbooks[0]!, st.playbooks[st.playbooks.length - 1]!];
      persist();
      render();
    };
    const market = (m: Symbol) => {
      const has = st.markets.includes(m);
      if (has && st.markets.length === 1) return;
      st.markets = has ? st.markets.filter((x) => x !== m) : [...st.markets, m];
      persist();
      render();
    };
    const mixed = st.playbooks.length > 1;
    const cands = st.playbooks.map((p) => candidateOf(p)).filter((c): c is NonNullable<typeof c> => !!c);
    secStrategy.replaceChildren(
      h('div.tl-field', {}, h('span.tl-label', {}, mixed && st.plan !== 'every' ? 'Trade these, in the order you pick them' : 'Trade this'), h('div.tl-chips', {}, ...PLAYBOOKS.map((p) => { const n = st.playbooks.indexOf(p.id); return chip(mixed && st.plan !== 'every' && n >= 0 ? `${n + 1} · ${p.name}` : p.name, n >= 0, () => toggle(p.id), { color: p.color, title: p.rule }); }))),
      h('div.tl-field.wide', {}, h('span.tl-label', {}, 'Game plan'),
        h('div.tl-plan', {},
          segmented<PlanMode>([{ id: 'every', label: 'Every setup' }, { id: 'fallback', label: 'First, then a fallback' }, { id: 'by-day', label: 'By the kind of day' }], mixed ? st.plan : 'every', (v) => { st.plan = v; if (v !== 'every' && st.playbooks.length < 2) st.playbooks = [st.playbooks[0]!, TUNED_PLAYBOOKS.find((x) => x !== st.playbooks[0]) ?? 'failed-auction']; if (v === 'by-day') st.playbooks = st.playbooks.slice(0, 2); persist(); render(); }),
          h('button.tl-toggle.inline', { type: 'button', role: 'switch', 'aria-checked': String(st.oneAndDone), onclick: () => { st.oneAndDone = !st.oneAndDone; persist(); render(); } }, h('i'), h('span', {}, h('b', {}, 'One and done'))),
          h('label.tl-inline', {}, 'Trades a day', h('select.tl-input', { 'aria-label': 'Most trades a day', onchange: (e: Event) => { st.maxTrades = Number((e.target as HTMLSelectElement).value); persist(); render(); } }, ...[0, 1, 2, 3, 4].map((n) => h('option', { value: String(n), selected: st.maxTrades === n }, n ? `At most ${n}` : 'No cap'))))),
        h('small', {}, !mixed || st.plan === 'every' ? (mixed ? 'Every setup any of them calls is taken.' : 'Pick a second playbook to mix them: one first with a fallback, or one for each kind of day.') : st.plan === 'fallback' ? `${PLAYBOOK_BY_ID[st.playbooks[0]!].name} goes first. ${st.playbooks.slice(1).map((p) => PLAYBOOK_BY_ID[p].name).join(', then ')} only gets its turn once the one before has lost today, or hasn’t set up by ${Math.floor(FALLBACK_AFTER / 60)}:00 PT. A winner from the first ends it there.` : `${PLAYBOOK_BY_ID[st.playbooks[0]!].name} when the market is trending (ADX ${TREND_ADX} or more on the entry bar), ${PLAYBOOK_BY_ID[st.playbooks[1]!].name} when it’s ranging. Tap the chips to change which is which.`, st.oneAndDone ? ' A winner ends the day.' : '')),
      h('div.tl-field', {}, h('span.tl-label', {}, 'On'), h('div.tl-chips', {}, ...MARKETS.map((m) => chip(m, st.markets.includes(m), () => market(m))))),
      h('div.tl-field.wide', {}, h('span.tl-label', {}, 'Once a trade is working'),
        segmented<ManageId>(MANAGE.map((m) => ({ id: m.id, label: m.short })), st.manage, (v) => { st.manage = v; persist(); render(); }),
        h('small', {}, MANAGE_BY_ID[st.manage].what)),
      ...(cands.length
        ? [h('div.tl-field', {}, h('span.tl-label', {}, 'Playbook rules'),
            segmented<'live' | 'cand'>([{ id: 'live', label: 'Live versions' }, { id: 'cand', label: `The tuner’s candidate${cands.length === 1 ? '' : 's'}` }], st.candidates ? 'cand' : 'live', (v) => { st.candidates = v === 'cand'; persist(); render(); }),
            h('small', {}, cands.map((c) => { const info = versionInfo(c.playbook, c.version); return `${PLAYBOOK_BY_ID[c.playbook].short} v${c.version}${info?.vs?.verdict === 'better' ? ' (tested better)' : ' (not proven)'}: ${info?.change.join('; ') ?? ''}`; }).join(' · ')))]
        : []),
      ...(filters.length
        ? [h('div.tl-field', {}, h('span.tl-label', {}, 'With the lab’s filters'), h('div.tl-chips', {}, ...filters.map((f) => chip(`${FILTER_BY_ID[f].name} ✕`, true, () => { filters = filters.filter((x) => x !== f); render(); }, { kind: 'filter', title: FILTER_BY_ID[f].rule }))))]
        : []));
  }

  function drawHero(rules: PropRules, run: EvalDetail, odds: EvalOdds) {
    const r = RESULT[run.result];
    const funded = rules.kind === 'funded';
    secHero.replaceChildren(h('div.tl-hero', { 'data-result': run.result },
      h('div.tl-verdict', {},
        h('span.tl-kicker', {}, `${rules.firm} · ${rules.program} · ${strategyName()}`.toUpperCase()),
        h('div.tl-verdict-word', { 'data-tone': r.tone }, funded && run.result === 'passed' ? 'PAYOUT READY' : r.word, run.result !== 'running' ? h('span', {}, `day ${run.days}`) : null),
        h('p', {}, run.why),
        h('div.tl-stats', {},
          stat('Profit', signedMoney(run.pnl), { tone: run.pnl >= 0 ? 'up' : 'down', sub: `of ${money(rules.profitTarget)}` }),
          stat('Days', String(run.days), { sub: `${run.tradingDays} traded` }),
          stat('Trades', String(run.taken), { sub: run.skipped ? `${run.skipped} skipped` : 'all taken' }),
          stat('Closest to the floor', money(run.minCushion), { tone: run.result === 'busted' ? 'down' : undefined, sub: run.minCushionDay ? `day ${run.minCushionDay}` : 'at the start' }))),
      h('div.tl-odds', {},
        h('span.tl-kicker', {}, 'THE ODDS, IF THE DAYS HAD COME IN ANOTHER ORDER'),
        odds.runs
          ? h('div.tl-odds-main', {},
              h('div.tl-odds-big', {}, h('b', {}, pct(odds.pass)), h('span', {}, `pass within ${odds.horizon} trading days`)),
              h('div.tl-odds-meter', {}, h('i', { 'data-k': 'pass', style: `width:${odds.pass * 100}%` }), h('i', { 'data-k': 'run', style: `width:${odds.running * 100}%` }), h('i', { 'data-k': 'bust', style: `width:${odds.bust * 100}%` })),
              h('div.tl-odds-legend', {}, h('span', { 'data-k': 'pass' }, `${pct(odds.pass)} pass`), h('span', { 'data-k': 'run' }, `${pct(odds.running)} still going`), h('span', { 'data-k': 'bust' }, `${pct(odds.bust)} bust`)),
              h('small', {}, `${odds.runs} redraws of your real trading days. ${odds.medianDays ? `A typical pass takes ${odds.medianDays} days.` : 'None of them passed.'}`))
          : h('p', {}, 'No trades to draw from for this choice.'),
        h('div.tl-odds-foot', {}, h('span.tl-label', {}, 'Give it'), segmented(HORIZONS.map((n) => ({ id: String(n), label: `${n} days` })), String(st.horizon), (v) => { st.horizon = Number(v); persist(); render(); })))));
  }

  function drawChart(rules: PropRules, run: EvalDetail, odds: EvalOdds, startBalance: number, startFloor: number) {
    const days = weekdays(detail?.days ?? []);
    const monthN = days.length + 1;
    const n = st.view === 'month' ? monthN : Math.max(monthN, odds.horizon + 1);
    const balance: (number | null)[] = [startBalance, ...run.ledger.map((d) => d.balance)];
    const floor: (number | null)[] = [startFloor, ...run.ledger.map((d) => d.floor)];
    const target = rules.size + rules.profitTarget;
    const end = run.ledger.length;
    const tip = (i: number) => {
      if (i === 0) return [h('b', {}, 'Start'), h('span', {}, `Balance ${money(startBalance)}`), h('span', {}, `Floor ${money(startFloor)}`)];
      const d = run.ledger[i - 1];
      if (!d) return i < odds.p50.length ? [h('b', {}, `Day ${i}`), h('span', {}, 'Past the end of this run'), h('span', {}, `Middle redraw ${money(odds.p50[i]!)}`)] : null;
      return [
        h('b', {}, `Day ${i} · ${dayLabel(d.day)}`),
        h('span', { 'data-tone': d.pnl > 0 ? 'up' : d.pnl < 0 ? 'down' : '' }, d.taken ? `${signedMoney(d.pnl)} on ${d.taken} trade${d.taken === 1 ? '' : 's'} (${d.wins}W ${d.losses}L)` : 'No trade'),
        h('span', {}, `Balance ${money(d.balance)}`),
        h('span', {}, `Cushion ${money(d.cushion)} above the floor`),
        d.taken ? h('span', {}, `Risked ${money(d.risk)} a trade · up to ${d.micros} micros`) : null,
        d.note ? h('em', {}, d.note) : null,
      ].filter((x): x is HTMLElement => !!x);
    };
    secChart.replaceChildren(panel('The account, day by day', st.view === 'month' ? `The ${days.length} real trading days of the backtest, in the order they happened` : `The real month, then where ${odds.runs} redraws of it would be by day ${odds.horizon}`,
      h('div.tl-chart-tools', {},
        segmented([{ id: 'month', label: 'What happened' }, { id: 'odds', label: `What could (${st.horizon} days)` }], st.view, (v) => { st.view = v; persist(); render(); }),
        h('div.tl-legend', {}, h('span', { style: `--c:${TONE.text}` }, 'Balance'), h('span', { style: `--c:${TONE.up}` }, 'Target'), h('span', { style: `--c:${TONE.down}` }, 'Floor (you fail here)'), h('span', { 'data-band': '1', style: `--c:${ACCENT}` }, '8 in 10 redraws land in here'))),
      chart({
        height: 330,
        n,
        label: 'Account balance by day against the profit target and the drawdown floor',
        series: [
          { values: balance, color: TONE.text, width: 3, dot: (i) => (i === 0 ? null : (run.ledger[i - 1]!.pnl > 0 ? TONE.up : run.ledger[i - 1]!.pnl < 0 ? TONE.down : TONE.faint)) },
          { values: floor, color: TONE.down, width: 2, step: true, area: { fill: 'rgba(255,93,115,.10)', to: 'bottom' } },
          { values: odds.p50.slice(0, n), color: ACCENT, width: 1.5, dash: '2 5', opacity: odds.runs ? 0.9 : 0 },
        ],
        bands: odds.runs ? [{ lo: odds.p10.slice(0, n), hi: odds.p90.slice(0, n), fill: 'rgba(183,148,244,.13)' }] : [],
        levels: [{ y: target, color: TONE.up, label: `TARGET ${money(target)}` }, { y: rules.size, color: TONE.faint, label: 'START', dash: '2 6' }],
        flags: end ? [{ i: end, label: run.result === 'passed' ? `PASSED · DAY ${end}` : run.result === 'busted' ? `BUSTED · DAY ${end}` : `TEST ENDS · ${signedMoney(run.pnl)}`, color: run.result === 'passed' ? TONE.up : run.result === 'busted' ? TONE.down : TONE.warn }] : [],
        xLabel: (i) => (i === 0 ? 'Start' : st.view === 'month' && days[i - 1] ? shortDay(days[i - 1]!) : `Day ${i}`),
        yFmt: (v) => `$${(v / 1000).toFixed(1)}K`,
        tip,
      })));
  }

  function drawChecks(rules: PropRules, run: EvalDetail) {
    const check = (state: 'ok' | 'bad' | 'wait', label: string, value: string, sub: string, fill: number, mark?: number) =>
      h('div.tl-check', { 'data-state': state },
        h('span.tl-check-icon', {}, state === 'ok' ? '✓' : state === 'bad' ? '✕' : '…'),
        h('div', {}, h('span.tl-label', {}, label), h('b', {}, value), h('small', {}, sub)),
        h('span.tl-meter', {}, h('i', { style: `width:${Math.max(0, Math.min(1, fill)) * 100}%` }), mark != null ? h('u', { style: `left:${Math.min(1, mark) * 100}%` }) : null));
    const share = run.bestDayShare;
    const limit = rules.consistencyPercent / 100;
    secChecks.replaceChildren(
      check(run.pnl >= rules.profitTarget ? 'ok' : run.result === 'busted' ? 'bad' : 'wait', rules.kind === 'funded' ? 'Payout target' : 'Profit target', `${money(Math.max(0, run.pnl))} of ${money(rules.profitTarget)}`, run.targetDay ? `Reached on day ${run.targetDay}` : `${money(Math.max(0, rules.profitTarget - run.pnl))} to go`, run.pnl / rules.profitTarget),
      check(run.tradingDays >= rules.minTradingDays ? 'ok' : 'wait', 'Trading days', `${run.tradingDays} of ${rules.minTradingDays}`, 'Days with at least one trade', run.tradingDays / Math.max(1, rules.minTradingDays)),
      rules.consistencyPercent >= 100 ? check('ok', 'Consistency', 'No rule', 'This program has no consistency rule', 0) : check(!st.consistency || share == null ? 'wait' : share <= limit + 1e-9 ? 'ok' : run.targetDay == null ? 'wait' : 'bad', 'Consistency', share == null ? 'No profit yet' : `Best day is ${pct(share)}`, !st.consistency ? 'Rule switched off in the risk dial' : `Must be under ${rules.consistencyPercent}% of ${rules.consistencyBasis === 'profitTarget' ? 'the target' : 'total profit'}${share != null && share > limit && run.targetDay == null ? ' by the time the target is hit' : ''}`, share ?? 0, limit),
      check(run.result === 'busted' ? 'bad' : 'ok', 'Drawdown floor', run.result === 'busted' ? 'Touched it' : `Never closer than ${money(run.minCushion)}`, `${money(rules.drawdown)} drawdown, ${DD_LABEL[rules.drawdownType]}`, run.result === 'busted' ? 1 : 1 - run.minCushion / Math.max(1, rules.drawdown)));
  }

  function drawDial(dial: { divisor: number; odds: EvalOdds }[], ladder: { micros: number; odds: EvalOdds }[]) {
    sizingSeg.replaceChildren(segmented<Saved['sizing']>([{ id: 'law', label: 'A share of the cushion' }, { id: 'fixed', label: 'A fixed dollar risk' }, { id: 'contracts', label: 'A fixed number of contracts' }], st.sizing, (v) => { st.sizing = v; persist(); render(); }));
    dialControls.replaceChildren(...(st.sizing === 'law' ? [slider, dialLabel] : st.sizing === 'fixed' ? [h('label.tl-inline', {}, 'Risk per trade $', fixedIn), h('small', {}, 'The same dollar risk on every trade, whatever the cushion is.')] : [h('label.tl-inline', {}, 'Micros on every trade', microsIn), h('small', {}, `The same size every time, however far the stop is (this account allows ${rulesOf(st.account).maxMicros}). The risk is whatever the stop makes it: with a wide stop, one loss can end the account.`)]));
    dialLabel.replaceChildren(h('b', {}, `1/${st.divisor}`), ` of the drawdown left${st.divisor === 10 ? ' · the Law of 10' : ''}`);
    const toggle = (label: string, sub: string, on: boolean, flip: () => void) => h('button.tl-toggle', { type: 'button', role: 'switch', 'aria-checked': String(on), onclick: () => { flip(); persist(); render(); } }, h('i'), h('span', {}, h('b', {}, label), h('small', {}, sub)));
    const real = realOf(st.account);
    const rules = rulesOf(st.account);
    const moved = !!real && (real.balance !== rules.size || real.peak !== rules.size);
    toggles.replaceChildren(
      toggle('Daily stop', 'Three losses or two risks down and the day is over', st.dailyStop, () => (st.dailyStop = !st.dailyStop)),
      toggle('Consistency rule', rules.consistencyPercent >= 100 ? 'This program has none' : `No one day over ${rules.consistencyPercent}% of ${rules.consistencyBasis === 'profitTarget' ? 'the target' : 'the profit'}`, st.consistency, () => (st.consistency = !st.consistency)),
      ...(moved ? [toggle('Start from my real account', `${money(real!.balance)} now, ${money(real!.cushion)} of cushion left`, st.startReal, () => (st.startReal = !st.startReal))] : []));
    const score = (o: EvalOdds) => o.pass - o.bust;
    if (st.sizing === 'contracts' && ladder.length) {
      // The same question for a fixed size: how do the odds move as the contract count goes up?
      const top = ladder.reduce((a, b) => (score(b.odds) > score(a.odds) + 0.005 ? b : a), ladder[0]!);
      return void dialTable.replaceChildren(h('table.tl-table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Micros a trade'), h('th', {}, 'Pass'), h('th', {}, 'Bust'), h('th', {}, 'Typical pass'), h('th', {}, ''))),
        h('tbody', {}, ...ladder.map((d) => h('tr', { 'data-on': d.micros === st.fixedMicros ? '1' : undefined, tabindex: '0', onclick: () => { st.fixedMicros = d.micros; microsIn.value = String(d.micros); persist(); render(); } },
          h('th', { scope: 'row' }, `${d.micros} micro${d.micros === 1 ? '' : 's'}`),
          h('td', { 'data-tone': 'up' }, pct(d.odds.pass)),
          h('td', { 'data-tone': d.odds.bust > 0.25 ? 'down' : '' }, pct(d.odds.bust)),
          h('td', {}, d.odds.medianDays ? `${d.odds.medianDays} days` : '—'),
          h('td', {}, d === top && d.odds.runs ? h('span.tl-star', {}, '★ best balance') : oddsBar(d.odds)))))));
    }
    if (st.sizing !== 'law') return void dialTable.replaceChildren();
    const best = dial.reduce((a, b) => (score(b.odds) > score(a.odds) + 0.005 ? b : a), dial[0]!);
    dialTable.replaceChildren(h('table.tl-table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Risk a trade'), h('th', {}, 'Pass'), h('th', {}, 'Bust'), h('th', {}, 'Typical pass'), h('th', {}, ''))),
      h('tbody', {}, ...dial.map((d) => h('tr', { 'data-on': d.divisor === st.divisor ? '1' : undefined, tabindex: '0', onclick: () => { st.divisor = d.divisor; slider.value = String(d.divisor); persist(); render(); } },
        h('th', { scope: 'row' }, `1/${d.divisor}${d.divisor === 10 ? ' · Law of 10' : ''}`),
        h('td', { 'data-tone': 'up' }, pct(d.odds.pass)),
        h('td', { 'data-tone': d.odds.bust > 0.25 ? 'down' : '' }, pct(d.odds.bust)),
        h('td', {}, d.odds.medianDays ? `${d.odds.medianDays} days` : '—'),
        h('td', {}, d === best && d.odds.runs ? h('span.tl-star', {}, '★ best balance') : oddsBar(d.odds)))))));
  }

  function drawSuggest(rules: PropRules, run: EvalDetail, odds: EvalOdds, perPlaybook: { id: PlaybookId; odds: EvalOdds; trades: number }[], perAccount: Map<string, EvalOdds>, dial: { divisor: number; odds: EvalOdds }[], perPlan: { plan: DayPlan; label: string; trades: number; odds: EvalOdds }[], perManage: { id: ManageId; odds: EvalOdds }[]) {
    const ranked = [...perPlaybook].sort((a, b) => b.odds.pass - b.odds.bust - (a.odds.pass - a.odds.bust));
    const notes: (Node | string)[][] = [];
    const now = planNow();
    const plans = [...perPlan].sort((a, b) => b.odds.pass - b.odds.bust - (a.odds.pass - a.odds.bust));
    const bestPlan = plans.find((p) => p.odds.runs && p.plan.order.length > 1 && p.plan.mode !== 'every');
    if (bestPlan && bestPlan.odds.pass > odds.pass + 0.05 && bestPlan.odds.pass - bestPlan.odds.bust >= (plans[0]!.odds.pass - plans[0]!.odds.bust) - 0.02)
      notes.push([h('b', {}, `Mix them: ${bestPlan.label}. `), `That passes ${pct(bestPlan.odds.pass)} of the redraws and busts ${pct(bestPlan.odds.bust)}, against ${pct(odds.pass)} and ${pct(odds.bust)} for what you have picked.`]);
    const mScore = (o: EvalOdds) => o.pass - o.bust;
    const hereM = perManage.find((m) => m.id === st.manage)!;
    const bestM = [...perManage].sort((a, b) => mScore(b.odds) - mScore(a.odds))[0]!;
    if (bestM.odds.runs && bestM.id !== st.manage && mScore(bestM.odds) > mScore(hereM.odds) + 0.06)
      notes.push([h('b', {}, `Manage it differently: ${MANAGE_BY_ID[bestM.id].name.toLowerCase()}. `), `That passes ${pct(bestM.odds.pass)} and busts ${pct(bestM.odds.bust)}, against ${pct(hereM.odds.pass)} and ${pct(hereM.odds.bust)} ${st.manage === 'written' ? 'leaving the stop and target alone' : 'the way it is managed now'}.`]);
    const top = ranked[0];
    if (top && top.odds.runs && !(st.playbooks.length === 1 && st.playbooks[0] === top.id) && top.odds.pass > odds.pass + 0.05)
      notes.push([h('b', {}, `${PLAYBOOK_BY_ID[top.id].name} fits this account best. `), `It passes ${pct(top.odds.pass)} of the redraws against ${pct(odds.pass)} for what you have picked.`]);
    const easiest = [...perAccount].filter(([, o]) => o.runs).sort((a, b) => b[1].pass - b[1].bust - (a[1].pass - a[1].bust))[0];
    if (easiest && easiest[0] !== st.account && easiest[1].pass > odds.pass + 0.05) {
      const a = rulesOf(easiest[0]);
      notes.push([h('b', {}, `${acctName(a)} is the easier account for this strategy. `), `${pct(easiest[1].pass)} pass there against ${pct(odds.pass)} here.`]);
    }
    if (st.sizing === 'law') {
      const here = dial.find((d) => d.divisor === st.divisor)?.odds ?? odds;
      const better = dial.filter((d) => d.divisor !== st.divisor && d.odds.pass - d.odds.bust > here.pass - here.bust + 0.06).sort((a, b) => b.odds.pass - b.odds.bust - (a.odds.pass - a.odds.bust))[0];
      if (better) notes.push([h('b', {}, `Try risking 1/${better.divisor} of the cushion. `), `That passes ${pct(better.odds.pass)} and busts ${pct(better.odds.bust)}, against ${pct(here.pass)} and ${pct(here.bust)} at 1/${st.divisor}.`]);
    }
    if (st.consistency && run.targetDay != null && run.bestDayShare != null && run.bestDayShare > rules.consistencyPercent / 100)
      notes.push([h('b', {}, 'One big day is holding up the pass. '), `The best day made ${money(run.bestDay)}, ${pct(run.bestDayShare)} of ${rules.consistencyBasis === 'profitTarget' ? 'the target' : 'the profit'}. Stopping for the day near ${money((rules.consistencyPercent / 100) * rules.profitTarget)} would keep it inside the rule.`]);
    if (run.skipped && run.taken && run.skipped >= run.taken / 3) notes.push([h('b', {}, `${run.skipped} trades were left alone. `), 'Their stop was too wide for the risk allowed (or the day was already stopped). A bigger account or a tighter setup would take more of them.']);
    if (odds.runs && odds.bust > odds.pass) notes.push([h('b', {}, 'More redraws bust than pass. '), 'On these days the strategy doesn’t have the edge to carry this account. Prove it on paper first.']);
    if (run.taken < 12) notes.push([h('b', {}, `Only ${run.taken} trades to go on. `), 'That is thin: treat every number here as rough until there is more history.']);
    if (!notes.length) notes.push([h('b', {}, 'Nothing to change. '), 'This strategy, account and risk are already the best balance the simulator can find on these days.']);
    secSuggest.replaceChildren(panel('What the simulator suggests', 'Worked out from the same redraws',
      h('ul.tl-notes', {}, ...notes.map((n) => h('li', {}, ...n))),
      h('span.tl-label', {}, `Game plans on ${acctName(rules)}, best odds first`),
      h('div.tl-rank', {}, ...plans.slice(0, 7).map((p) => {
        const on = p.plan.mode === now.mode && p.plan.order.length === now.order.length && p.plan.order.every((x, k) => x === now.order[k]);
        return h('button.tl-rank-row', { type: 'button', 'aria-pressed': String(on), style: `--c:${PLAYBOOK_BY_ID[p.plan.order[0]!].color}`, title: 'Trade it this way', onclick: () => { st.playbooks = [...p.plan.order]; st.plan = p.plan.mode; persist(); render(); } },
          h('i.tl-chip-dot'), h('span.tl-rank-name', { title: p.label }, p.label), p.odds.runs ? oddsBar(p.odds) : h('span.tl-oddsbar'), h('b', {}, p.odds.runs ? `${pct(p.odds.pass)} pass` : 'no trades'), h('small', {}, `${p.trades} trades`));
      })),
      h('span.tl-label', {}, 'Ways of managing the trade, same plan'),
      h('div.tl-rank', {}, ...[...perManage].sort((a, b) => mScore(b.odds) - mScore(a.odds)).map((m) => h('button.tl-rank-row', { type: 'button', 'aria-pressed': String(st.manage === m.id), style: `--c:${ACCENT}`, title: MANAGE_BY_ID[m.id].what, onclick: () => { st.manage = m.id; persist(); render(); } },
        h('i.tl-chip-dot'), h('span.tl-rank-name', {}, MANAGE_BY_ID[m.id].name), m.odds.runs ? oddsBar(m.odds) : h('span.tl-oddsbar'), h('b', {}, m.odds.runs ? `${pct(m.odds.pass)} pass` : 'no trades'), h('small', {}, `${pct(m.odds.bust)} bust`))))));
  }

  /** The live eval: what's running forward day by day, and the button that sets it to what's on screen. */
  function drawLive(rules: PropRules) {
    const le = trading.snap?.liveEval;
    const start = async (from: 'today' | 'back') => {
      const plan = planNow();
      liveNote = (await trading.post('/api/trading/live-eval', { action: 'start', from, accountId: rules.id, rules: st.custom[rules.id] ?? {}, playbooks: st.playbooks, markets: st.markets, plan: { mode: plan.mode, oneAndDone: plan.oneAndDone, maxTrades: plan.maxTrades }, manage: st.manage, opts: { divisor: st.divisor, fixedRisk: st.sizing === 'fixed' ? st.fixedRisk : null, fixedMicros: st.sizing === 'contracts' ? st.fixedMicros : null, dailyStop: st.dailyStop, consistency: st.consistency } })) ?? (from === 'today' ? 'Running live from today' : 'Running live, counting the paper book’s last month');
      render();
    };
    const o = le?.office;
    const lead = le?.you?.pnl != null && o ? o.pnl - le.you.pnl : null;
    secLive.replaceChildren(h('section.tl-panel.tl-live', { 'data-on': le ? '1' : undefined },
      h('div.tl-panel-head', {}, h('h3', {}, '🏁 Live eval'), h('span', {}, 'The office trades one account forward on paper, a day at a time, beside what you really make. It’s the fourth wall display.')),
      le && o
        ? h('div.tl-live-row', {},
            stat('The office', signedMoney(o.pnl), { tone: o.pnl >= 0 ? 'up' : 'down', sub: `${o.result === 'passed' ? 'passed' : o.result === 'busted' ? 'busted' : `${pct(Math.max(0, o.pnl / o.target))} of the target`} · day ${le.days.length}` }),
            stat('You', le.you?.pnl != null ? signedMoney(le.you.pnl) : '—', { tone: le.you?.pnl != null ? (le.you.pnl >= 0 ? 'up' : 'down') : undefined, sub: le.you ? (le.you.pnl != null ? le.you.name : 'starts with your first trade') : 'no account of yours is active' }),
            stat('Who’s ahead', lead == null ? '—' : Math.abs(lead) < 1 ? 'Level' : lead > 0 ? `Office +${money(lead)}` : `You +${money(-lead)}`, { sub: `today: office ${signedMoney(o.today)}${le.you ? ` · you ${signedMoney(le.you.today)}` : ''}` }),
            h('div.tl-live-what', {}, h('span.tl-label', {}, `${le.firm} ${le.program.replace(/\s*\(funded\)/i, '')} · since ${shortDay(le.startDay)}`), h('p', {}, le.label), h('small', {}, o.why)))
        : h('p.tl-fine', {}, 'Nothing is running live. Set the account, the playbooks, the plan and the risk above, then start it: the office takes every setup that plan allows as it happens, and the display shows the race day by day. Your side comes from your own account’s daily result (ProjectX, or what you log in the Risk guard).'),
      h('div.tl-version-acts', {},
        h('button.tl-btn.primary', { type: 'button', onclick: () => void start('today') }, le ? 'Switch it to what’s on screen, from today' : 'Run this live, from today'),
        h('button.tl-btn', { type: 'button', title: 'Counts the paper trades the office has already taken, up to a month back, so the line has a history', onclick: () => void start('back') }, 'From as far back as the paper book goes'),
        le ? h('button.tl-btn', { type: 'button', onclick: async () => { liveNote = (await trading.post('/api/trading/live-eval', { action: 'stop' })) ?? 'Stopped'; render(); } }, 'Stop it') : null,
        liveNote ? h('span.tl-fine', {}, liveNote) : null)));
  }

  function drawRules(rules: PropRules) {
    const base = ACCOUNT_CATALOG.find((a) => a.id === rules.id)!;
    const edited = !!st.custom[rules.id];
    const set = (patch: Partial<PropRules>) => {
      const next = { ...(st.custom[rules.id] ?? {}), ...patch };
      for (const k of Object.keys(next) as (keyof PropRules)[]) if (next[k] === base[k]) delete next[k];
      if (Object.keys(next).length) st.custom[rules.id] = next;
      else delete st.custom[rules.id];
      persist();
      render();
    };
    const num = (label: string, key: 'profitTarget' | 'drawdown' | 'minTradingDays' | 'consistencyPercent' | 'maxMicros', prefix = '', suffix = '') => {
      const input = h('input.tl-input', { type: 'number', min: '0', value: String(rules[key]), 'aria-label': label, onchange: (e: Event) => { const v = Number((e.target as HTMLInputElement).value); if (Number.isFinite(v) && v >= 0) set({ [key]: v }); } });
      return h('label.tl-rule', { 'data-edited': rules[key] !== base[key] ? '1' : undefined }, h('span', {}, label), h('span.tl-rule-in', {}, prefix, input, suffix));
    };
    const pick = <K extends 'drawdownType' | 'consistencyBasis'>(label: string, key: K, options: [PropRules[K], string][]) =>
      h('label.tl-rule', { 'data-edited': rules[key] !== base[key] ? '1' : undefined }, h('span', {}, label), h('select.tl-input', { 'aria-label': label, onchange: (e: Event) => set({ [key]: (e.target as HTMLSelectElement).value } as Partial<PropRules>) }, ...options.map(([v, l]) => h('option', { value: v, selected: rules[key] === v }, l))));
    secRules.replaceChildren(panel(`${rules.firm} · ${rules.program}`, rules.kind === 'funded' ? 'Straight to funded: no evaluation, the target is the first payout' : 'An evaluation: hit the target inside the rules to get funded',
      h('div.tl-rules', {},
        num(rules.kind === 'funded' ? 'Payout target' : 'Profit target', 'profitTarget', '$'),
        num('Drawdown', 'drawdown', '$'),
        pick('The floor', 'drawdownType', [['trailing-eod', 'Trails the end-of-day high'], ['trailing-intraday', 'Trails the intraday high'], ['static', 'Fixed']]),
        num('Minimum trading days', 'minTradingDays'),
        num('Consistency: best day at most', 'consistencyPercent', '', '%'),
        pick('…measured against', 'consistencyBasis', [['totalProfit', 'Total profit'], ['profitTarget', 'The profit target']]),
        num('Most micros at once', 'maxMicros')),
      h('p.tl-fine', {}, rules.lockProfit != null ? `The floor stops trailing once it reaches ${money(rules.size + rules.lockProfit)}. ` : '', 'Change any rule to try a different account size or a rule change; it’s kept on this computer only. These are the rules Trade Pilot keeps: firms change them, so check before you buy.'),
      edited ? h('button.tl-btn', { type: 'button', onclick: () => { delete st.custom[rules.id]; persist(); render(); } }, `Back to ${rules.firm}’s rules`) : null));
  }

  function drawLedger(run: EvalDetail) {
    const rows = ledgerOpen ? run.ledger : run.ledger.slice(0, 6);
    secLedger.replaceChildren(panel('The ledger', `${run.ledger.length} day${run.ledger.length === 1 ? '' : 's'} played`,
      h('div.tl-scroll', {}, h('table.tl-table', {},
        h('thead', {}, h('tr', {}, ...['Day', 'Trades', 'Risk', 'Result', 'Balance', 'Cushion'].map((c) => h('th', {}, c)))),
        h('tbody', {}, ...rows.map((d, i) => h('tr', { title: d.note || undefined },
          h('th', { scope: 'row' }, `${i + 1} · ${shortDay(d.day)}`),
          h('td', {}, d.taken ? `${d.taken} (${d.wins}W ${d.losses}L)` : d.skipped ? 'skipped' : '—'),
          h('td', {}, d.taken ? `${money(d.risk)} · ${d.micros}×` : '—'),
          h('td', { 'data-tone': d.pnl > 0 ? 'up' : d.pnl < 0 ? 'down' : '' }, d.taken ? signedMoney(d.pnl) : '—'),
          h('td', {}, money(d.balance)),
          h('td', {}, money(d.cushion))))))),
      run.ledger.length > 6 ? h('button.tl-btn', { type: 'button', onclick: () => { ledgerOpen = !ledgerOpen; render(); } }, ledgerOpen ? 'Show fewer days' : `Show all ${run.ledger.length} days`) : null));
  }

  function drawHow(rules: PropRules, run: EvalDetail, odds: EvalOdds, n: number) {
    const first = run.ledger.find((d) => d.taken);
    sheet.replaceChildren(howSheet('The prop eval simulator',
      'It answers one question: if you had traded this strategy on this account for the last month, by the rules, would you have passed? Then it asks how much of that was the luck of the order the days came in.',
      [
        { title: 'It takes the backtest’s real trades', body: 'The Backtest Lab replays every playbook on real one-minute bars. The simulator takes the trades of the strategy and markets you picked, in the order they happened.', fact: `${n} trades over ${weekdays(detail?.days ?? []).length} trading days` },
        { title: 'It sizes each trade off the cushion', body: `Before every trade it measures the cushion (the balance above the floor) and risks a share of it: a tenth is the Law of 10. That risk and the trade’s stop decide how many micros fit, up to the account’s limit of ${rules.maxMicros}.`, fact: first ? `Day 1: ${money(first.risk)} a trade, up to ${first.micros} micros` : undefined },
        { title: 'It moves the floor the way the firm does', body: `This account’s ${money(rules.drawdown)} drawdown ${DD_LABEL[rules.drawdownType]}. Touch the floor and the run is over: busted.`, fact: `Closest it came: ${money(run.minCushion)}` },
        { title: 'It checks every rule before calling a pass', body: `The profit target, the minimum of ${rules.minTradingDays} trading days, and consistency (no single day over ${rules.consistencyPercent}%). With the daily stop on, three losses or two risks down ends the day.`, fact: run.why },
        { title: 'It redraws the days for the odds', body: `One month is one path. So it draws your real days at random, with repeats, into ${odds.runs} imagined ${odds.horizon}-day stretches and plays each through the account. Days stay whole; only which days came, and in what order, changes.`, fact: odds.runs ? `${pct(odds.pass)} pass · ${pct(odds.bust)} bust · ${pct(odds.running)} still going` : undefined },
      ],
      ['It’s paper evidence on about a month of history: no fees, no slippage, and fills on the signal candle’s close.', 'The intraday floor is checked when a trade closes, not tick by tick, so a real intraday-trailing account can be a little stricter.', 'The redraws assume next month’s days look like this month’s. A change in the market isn’t in them.', 'The firms’ rules change. These are the ones Trade Pilot keeps: check them at checkout.'],
      () => { how = false; render(); }));
  }

  function render() {
    const s = trading.snap;
    const bt = s?.backtest;
    rerun.disabled = !!bt?.running;
    el.classList.toggle('tl-how-open', how);
    const days = weekdays(detail?.days ?? []);
    status.textContent = !bt ? 'Waiting for the first backtest…' : bt.running ? 'The backtest is replaying the month…' : `${days.length} real trading days${days.length ? ` (${shortDay(days[0]!)} to ${shortDay(days[days.length - 1]!)})` : ''} · backtest run ${new Date(bt.ranAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · paper evidence, never a promise`;
    if (!detail || !detail.trades.length) {
      rail.replaceChildren(h('span.tl-kicker', {}, 'PICK AN ACCOUNT'));
      main.classList.add('tl-empty');
      secHero.replaceChildren(h('div.tl-waiting', {}, h('span.tl-spin'), h('b', {}, bt?.running || !bt ? 'Replaying the month on real bars…' : 'No backtest trades yet'), h('p', {}, 'The simulator plays the backtest’s trades through an account. It’ll fill in the moment the backtest finishes.')));
      return;
    }
    main.classList.remove('tl-empty');
    const rules = rulesOf(st.account);
    const trades = planned(planNow());
    const opts = optsFor(st.account);
    // Every way of mixing the owner's three (or what's picked, when that's two or more), to say which fits this account.
    const pool = st.playbooks.length > 1 ? st.playbooks : TUNED_PLAYBOOKS;
    const perPlan = plansOf(pool).map((plan) => ({ plan: { ...plan, oneAndDone: st.oneAndDone, maxTrades: st.maxTrades }, label: planLabel(plan) })).map((x) => { const t = planned(x.plan); return { ...x, trades: t.length, odds: evalOdds(t, rules, opts, days, { runs: 200, horizon: st.horizon }) }; });
    const run = runEval(trades, rules, opts, days);
    const odds = evalOdds(trades, rules, opts, days, { runs: 500, horizon: st.horizon });
    const perAccount = new Map([...new Set([st.account, ...listed().map((a) => a.id)])].map((id) => [id, evalOdds(trades, rulesOf(id), optsFor(id), days, { runs: 200, horizon: st.horizon })]));
    const perPlaybook = PLAYBOOKS.map((p) => { const t = managed(tradesFor([p.id]), st.manage); return { id: p.id, trades: t.length, odds: evalOdds(t, rules, opts, days, { runs: 200, horizon: st.horizon }) }; });
    const ladder = st.sizing === 'contracts' ? [...new Set([1, 2, 3, 5, 10, 15, 20, rules.maxMicros].filter((n) => n <= rules.maxMicros))].sort((a, b) => a - b).map((micros) => ({ micros, odds: evalOdds(trades, rules, { ...opts, fixedMicros: micros }, days, { runs: 200, horizon: st.horizon }) })) : [];
    const dial = st.sizing === 'law' ? DIAL.map((divisor) => ({ divisor, odds: evalOdds(trades, rules, optsFor(st.account, divisor), days, { runs: 200, horizon: st.horizon }) })) : [];
    const perManage = MANAGE.map((m) => ({ id: m.id, odds: evalOdds(planned(planNow(), m.id), rules, opts, days, { runs: 200, horizon: st.horizon }) }));
    const startBalance = opts.start?.balance ?? rules.size;
    const startPeak = Math.max(opts.start?.peak ?? rules.size, rules.drawdownType === 'static' ? rules.size : startBalance);
    const startFloor = Math.min(startPeak - rules.drawdown, rules.lockProfit == null ? Infinity : rules.size + rules.lockProfit);
    drawRail(perAccount);
    drawStrategy();
    drawHero(rules, run, odds);
    drawChart(rules, run, odds, startBalance, startFloor);
    drawChecks(rules, run);
    drawDial(dial, ladder);
    drawSuggest(rules, run, odds, perPlaybook, perAccount, dial, perPlan, perManage);
    drawRules(rules);
    drawLedger(run);
    drawLive(rules);
    if (how) drawHow(rules, run, odds, trades.length);
  }

  // Dragging the dial redraws the answer as it moves, once a frame.
  let queued = false;
  const soon = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      render();
    });
  };
  slider.addEventListener('input', () => { st.divisor = Number(slider.value); persist(); soon(); });
  microsIn.addEventListener('input', () => { const v = Math.floor(Number(microsIn.value)); if (v > 0) { st.fixedMicros = v; persist(); soon(); } });
  fixedIn.addEventListener('input', () => { const v = Number(fixedIn.value); if (v > 0) { st.fixedRisk = v; persist(); soon(); } });

  // The trades only change when the backtest runs again; a new price tick isn't a reason to redraw.
  const load = async () => {
    const bt = trading.snap?.backtest;
    // The tuner finishes after the backtest and brings its versions' trades with it.
    const key = `${bt?.ranAt}:${bt?.tuner?.ranAt}:${bt?.tuner?.running}`;
    if (!bt || bt.running || key === loadedFor) return;
    loadedFor = key;
    detail = await trading.backtestDetail();
    render();
  };
  // Prices tick every second; the page only redraws when the backtest or the tuner moves on.
  let was = '';
  off = trading.on(() => {
    const bt = trading.snap?.backtest;
    const le = trading.snap?.liveEval;
    const now = `${!!bt?.running}:${!!bt?.tuner?.running}:${bt?.tuner?.stage ?? ''}:${le ? `${le.label}:${le.office.pnl}:${le.office.openNow}:${le.you?.pnl}` : ''}`;
    if (now !== was) {
      was = now;
      render();
    }
    void load();
  });
  render();
  void load();
  if (init.live) setTimeout(() => secLive.scrollIntoView({ block: 'start' }), 400);
}
