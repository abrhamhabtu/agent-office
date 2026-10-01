import type { BacktestDetail, PaperTrade, PlaybookId, PropRules, Symbol } from '../../shared/trading';
import { PLAYBOOK_BY_ID, PLAYBOOKS, PROP_ACCOUNTS } from '../../shared/trading';
import { applyFilters, envOf, FILTER_BY_ID, type FilterId } from '../../shared/backtest-lab';
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
  account: string;
  playbooks: PlaybookId[];
  markets: Symbol[];
  sizing: 'law' | 'fixed';
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

const DEFAULTS: Saved = { account: PROP_ACCOUNTS[0]!.id, playbooks: ['double-break'], markets: [...MARKETS], sizing: 'law', divisor: 10, fixedRisk: 150, dailyStop: true, consistency: true, startReal: false, view: 'month', horizon: 60, custom: {} };

export interface EvalSimInit {
  account?: string;
  playbooks?: PlaybookId[];
  markets?: Symbol[];
  /** Indicator filters carried over from the Backtest Lab. */
  filters?: FilterId[];
}

export function openEvalSim(init: EvalSimInit = {}) {
  const save = stored<Partial<Saved>>('agent-office.eval-sim', {});
  const st: Saved = { ...DEFAULTS, ...save.get() };
  if (init.account) st.account = init.account;
  if (init.playbooks?.length) st.playbooks = init.playbooks;
  if (init.markets?.length) st.markets = init.markets.filter((m) => MARKETS.includes(m));
  if (!PROP_ACCOUNTS.some((a) => a.id === st.account)) st.account = DEFAULTS.account;
  st.playbooks = st.playbooks.filter((p) => p in PLAYBOOK_BY_ID);
  if (!st.playbooks.length) st.playbooks = [...DEFAULTS.playbooks];
  if (!st.markets.length) st.markets = [...MARKETS];
  let filters: FilterId[] = (init.filters ?? []).filter((f) => f in FILTER_BY_ID);
  let detail: BacktestDetail | null = null;
  let loadedFor = -1;
  let how = false;
  let ledgerOpen = false;

  const rulesOf = (id: string): PropRules => ({ ...PROP_ACCOUNTS.find((a) => a.id === id)!, ...(st.custom[id] ?? {}) });
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
  const sheet = h('div.tl-sheet');
  const status = h('span.grow');
  const rerun = h('button.tl-btn', { type: 'button', onclick: () => void trading.post('/api/trading/backtest', {}) }, '↻ Re-run the backtest') as HTMLButtonElement;
  const close = h('button.btn.close', { type: 'button', 'aria-label': 'Close the eval simulator', title: 'Close (Esc)' }, '✕');

  const slider = h('input.tl-range', { type: 'range', min: '4', max: '20', step: '1', 'aria-label': 'Risk per trade as a fraction of the drawdown left' }) as HTMLInputElement;
  slider.value = String(st.divisor);
  const fixedIn = h('input.tl-input', { type: 'number', min: '10', step: '10', 'aria-label': 'Fixed dollar risk per trade' }) as HTMLInputElement;
  fixedIn.value = String(st.fixedRisk);
  const sizingSeg = h('div');
  const toggles = h('div.tl-toggles');
  const dialControls = h('div.tl-dial');

  const main = h('div.tl-main', {},
    secStrategy, secHero, secChart, secChecks,
    h('div.tl-cols', {},
      h('section.tl-panel', {}, h('div.tl-panel-head', {}, h('h3', {}, 'Risk dial'), h('span', {}, 'How much of the cushion each trade risks')), sizingSeg, dialControls, toggles, dialTable),
      secSuggest),
    h('div.tl-cols', {}, secRules, secLedger));
  const el = h('div.modal.tl.tl-sim', { role: 'dialog', 'aria-label': 'Prop eval simulator', style: `--tl-accent:${ACCENT}` },
    h('header.tl-header', {},
      h('div.tl-title', {}, h('span.tl-kicker', {}, 'BACK OFFICE · WALL DISPLAY'), h('h2', {}, '🏦 Prop eval simulator')),
      h('button.tl-btn', { type: 'button', onclick: () => { how = !how; render(); } }, 'How it works'),
      h('button.tl-btn', { type: 'button', title: 'The backtest behind these trades', onclick: () => { modal.close(); openBacktestLab({ playbook: st.playbooks.length === 1 ? st.playbooks[0] : 'all', filters }); } }, '🧪 Backtest lab'),
      close),
    h('div.tl-body', {}, rail, main, sheet),
    h('footer.tl-footer', {}, status, rerun));
  let off = () => {};
  const modal = openModal(el, { doing: 'running the eval simulator', onClose: () => off() });
  close.addEventListener('click', () => modal.close());

  // ---- The numbers -----------------------------------------------------------------------------------
  const tradesFor = (playbooks: PlaybookId[]): PaperTrade[] => {
    if (!detail) return [];
    const picked = detail.trades.filter((t) => playbooks.includes(t.playbook) && st.markets.includes(t.symbol));
    return filters.length ? applyFilters(picked, filters, envOf(detail.trades)) : picked;
  };
  const optsFor = (id: string, divisor = st.divisor): Partial<EvalOptions> => {
    const real = st.startReal && id === st.account ? realOf(id) : undefined;
    return { divisor, fixedRisk: st.sizing === 'fixed' ? Math.max(1, st.fixedRisk) : null, dailyStop: st.dailyStop, consistency: st.consistency, start: real ? { balance: real.balance, peak: real.peak } : null };
  };
  const strategyName = () => (st.playbooks.length === 1 ? PLAYBOOK_BY_ID[st.playbooks[0]!].name : `${st.playbooks.length} playbooks together`);

  const oddsBar = (o: EvalOdds) => h('span.tl-oddsbar', { title: `${pct(o.pass)} pass · ${pct(o.running)} still going · ${pct(o.bust)} bust` }, h('i', { 'data-k': 'pass', style: `width:${o.pass * 100}%` }), h('i', { 'data-k': 'run', style: `width:${o.running * 100}%` }), h('i', { 'data-k': 'bust', style: `width:${o.bust * 100}%` }));

  // ---- Drawing -----------------------------------------------------------------------------------------
  function drawRail(perAccount: Map<string, EvalOdds>) {
    const firms = [...new Set(PROP_ACCOUNTS.map((a) => a.firm))];
    rail.replaceChildren(
      h('span.tl-kicker', {}, 'PICK AN ACCOUNT'),
      ...firms.flatMap((firm) => [
        h('div.tl-rail-firm', {}, firm),
        ...PROP_ACCOUNTS.filter((a) => a.firm === firm).map((base) => {
          const a = rulesOf(base.id);
          const o = perAccount.get(a.id);
          const real = realOf(a.id);
          return h('button.tl-acct', { type: 'button', 'aria-pressed': String(st.account === a.id), onclick: () => { st.account = a.id; persist(); render(); } },
            h('span.tl-acct-top', {}, h('b', {}, `$${a.size / 1000}K`), h('span.tl-tag', { 'data-kind': a.kind }, a.kind === 'funded' ? 'STRAIGHT TO FUNDED' : 'EVALUATION')),
            h('span.tl-acct-name', {}, a.program.replace(/\s*\(funded\)/i, ''), st.custom[a.id] ? h('em', {}, ' · edited') : null),
            h('span.tl-acct-rule', {}, `${money(a.profitTarget)} target · ${money(a.drawdown)} drawdown`),
            o && o.runs ? h('span.tl-acct-odds', {}, oddsBar(o), h('b', {}, `${pct(o.pass)} pass`)) : h('span.tl-acct-odds', {}, h('small', {}, 'no trades to test')),
            real?.active ? h('span.tl-acct-live', { title: 'One of your active accounts' }, `● yours · ${money(real.balance)}`) : null);
        }),
      ]),
      h('p.tl-rail-note', {}, 'The bar is the odds for the strategy you’ve picked: green passes, amber is still going, red busts.'));
  }

  function drawStrategy() {
    const toggle = (id: PlaybookId) => {
      const has = st.playbooks.includes(id);
      if (has && st.playbooks.length === 1) return;
      st.playbooks = has ? st.playbooks.filter((p) => p !== id) : [...st.playbooks, id];
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
    secStrategy.replaceChildren(
      h('div.tl-field', {}, h('span.tl-label', {}, 'Trade this'), h('div.tl-chips', {}, ...PLAYBOOKS.map((p) => chip(p.name, st.playbooks.includes(p.id), () => toggle(p.id), { color: p.color, title: p.rule })))),
      h('div.tl-field', {}, h('span.tl-label', {}, 'On'), h('div.tl-chips', {}, ...MARKETS.map((m) => chip(m, st.markets.includes(m), () => market(m))))),
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
      check(!st.consistency || share == null ? 'wait' : share <= limit + 1e-9 ? 'ok' : run.targetDay == null ? 'wait' : 'bad', 'Consistency', share == null ? 'No profit yet' : `Best day is ${pct(share)}`, !st.consistency ? 'Rule switched off in the risk dial' : `Must be under ${rules.consistencyPercent}% of ${rules.consistencyBasis === 'profitTarget' ? 'the target' : 'total profit'}${share != null && share > limit && run.targetDay == null ? ' by the time the target is hit' : ''}`, share ?? 0, limit),
      check(run.result === 'busted' ? 'bad' : 'ok', 'Drawdown floor', run.result === 'busted' ? 'Touched it' : `Never closer than ${money(run.minCushion)}`, `${money(rules.drawdown)} drawdown, ${DD_LABEL[rules.drawdownType]}`, run.result === 'busted' ? 1 : 1 - run.minCushion / Math.max(1, rules.drawdown)));
  }

  function drawDial(dial: { divisor: number; odds: EvalOdds }[]) {
    sizingSeg.replaceChildren(segmented([{ id: 'law', label: 'A share of the cushion' }, { id: 'fixed', label: 'A fixed dollar risk' }], st.sizing, (v) => { st.sizing = v; persist(); render(); }));
    dialControls.replaceChildren(...(st.sizing === 'law' ? [slider, dialLabel] : [h('label.tl-inline', {}, 'Risk per trade $', fixedIn), h('small', {}, 'The same dollar risk on every trade, whatever the cushion is.')]));
    dialLabel.replaceChildren(h('b', {}, `1/${st.divisor}`), ` of the drawdown left${st.divisor === 10 ? ' · the Law of 10' : ''}`);
    const toggle = (label: string, sub: string, on: boolean, flip: () => void) => h('button.tl-toggle', { type: 'button', role: 'switch', 'aria-checked': String(on), onclick: () => { flip(); persist(); render(); } }, h('i'), h('span', {}, h('b', {}, label), h('small', {}, sub)));
    const real = realOf(st.account);
    const rules = rulesOf(st.account);
    const moved = !!real && (real.balance !== rules.size || real.peak !== rules.size);
    toggles.replaceChildren(
      toggle('Daily stop', 'Three losses or two risks down and the day is over', st.dailyStop, () => (st.dailyStop = !st.dailyStop)),
      toggle('Consistency rule', `No one day over ${rules.consistencyPercent}% of ${rules.consistencyBasis === 'profitTarget' ? 'the target' : 'the profit'}`, st.consistency, () => (st.consistency = !st.consistency)),
      ...(moved ? [toggle('Start from my real account', `${money(real!.balance)} now, ${money(real!.cushion)} of cushion left`, st.startReal, () => (st.startReal = !st.startReal))] : []));
    if (st.sizing !== 'law') return void dialTable.replaceChildren();
    const score = (o: EvalOdds) => o.pass - o.bust;
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

  function drawSuggest(rules: PropRules, run: EvalDetail, odds: EvalOdds, perPlaybook: { id: PlaybookId; odds: EvalOdds; trades: number }[], perAccount: Map<string, EvalOdds>, dial: { divisor: number; odds: EvalOdds }[]) {
    const ranked = [...perPlaybook].sort((a, b) => b.odds.pass - b.odds.bust - (a.odds.pass - a.odds.bust));
    const notes: (Node | string)[][] = [];
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
      h('span.tl-label', {}, `Every playbook on ${acctName(rules)}`),
      h('div.tl-rank', {}, ...ranked.map((p) => {
        const def = PLAYBOOK_BY_ID[p.id];
        return h('button.tl-rank-row', { type: 'button', 'aria-pressed': String(st.playbooks.length === 1 && st.playbooks[0] === p.id), style: `--c:${def.color}`, title: 'Trade only this playbook', onclick: () => { st.playbooks = [p.id]; persist(); render(); } },
          h('i.tl-chip-dot'), h('span.tl-rank-name', {}, def.name), p.odds.runs ? oddsBar(p.odds) : h('span.tl-oddsbar'), h('b', {}, p.odds.runs ? `${pct(p.odds.pass)} pass` : 'no trades'), h('small', {}, `${p.trades} trades`));
      }))));
  }

  function drawRules(rules: PropRules) {
    const base = PROP_ACCOUNTS.find((a) => a.id === rules.id)!;
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
    const trades = tradesFor(st.playbooks);
    const opts = optsFor(st.account);
    const run = runEval(trades, rules, opts, days);
    const odds = evalOdds(trades, rules, opts, days, { runs: 500, horizon: st.horizon });
    const perAccount = new Map(PROP_ACCOUNTS.map((a) => [a.id, evalOdds(trades, rulesOf(a.id), optsFor(a.id), days, { runs: 200, horizon: st.horizon })]));
    const perPlaybook = PLAYBOOKS.map((p) => { const t = tradesFor([p.id]); return { id: p.id, trades: t.length, odds: evalOdds(t, rules, opts, days, { runs: 200, horizon: st.horizon }) }; });
    const dial = st.sizing === 'law' ? DIAL.map((divisor) => ({ divisor, odds: evalOdds(trades, rules, optsFor(st.account, divisor), days, { runs: 200, horizon: st.horizon }) })) : [];
    const startBalance = opts.start?.balance ?? rules.size;
    const startPeak = Math.max(opts.start?.peak ?? rules.size, rules.drawdownType === 'static' ? rules.size : startBalance);
    const startFloor = Math.min(startPeak - rules.drawdown, rules.lockProfit == null ? Infinity : rules.size + rules.lockProfit);
    drawRail(perAccount);
    drawStrategy();
    drawHero(rules, run, odds);
    drawChart(rules, run, odds, startBalance, startFloor);
    drawChecks(rules, run);
    drawDial(dial);
    drawSuggest(rules, run, odds, perPlaybook, perAccount, dial);
    drawRules(rules);
    drawLedger(run);
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
  fixedIn.addEventListener('input', () => { const v = Number(fixedIn.value); if (v > 0) { st.fixedRisk = v; persist(); soon(); } });

  // The trades only change when the backtest runs again; a new price tick isn't a reason to redraw.
  const load = async () => {
    const bt = trading.snap?.backtest;
    if (!bt || bt.running || bt.ranAt === loadedFor) return;
    loadedFor = bt.ranAt;
    detail = await trading.backtestDetail();
    render();
  };
  let wasRunning = false;
  off = trading.on(() => {
    const running = !!trading.snap?.backtest?.running;
    if (running !== wasRunning) {
      wasRunning = running;
      render();
    }
    void load();
  });
  render();
  void load();
}
