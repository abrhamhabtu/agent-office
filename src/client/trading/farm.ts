import type { BacktestDetail, PlaybookId } from '../../shared/trading';
import { PLAYBOOK_BY_ID } from '../../shared/trading';
import { weekdays } from '../../shared/evalsim';
import { cleanSetup, FARM_CAVEATS, FARM_DEFAULTS, FARM_PROGRAM_BY_ID, FARM_PROGRAMS, farmDays, farmOdds, runFarm, strategyLabel, type FarmCell, type FarmEvent, type FarmOdds, type FarmRun, type FarmSetup, type FarmStage, type FarmStrategy } from '../../shared/farm';
import { MANAGE } from '../../shared/manage';
import { ACCOUNT_CATALOG } from '../../shared/prop-catalog';
import { h, openModal } from '../ui/dom';
import { openEvalSim } from './evalsim';
import { trading } from './feed';
import { chart, chip, dayLabel, howSheet, money, panel, pct, segmented, shortDay, signedMoney, stat, stored, TONE } from './labkit';

// The Farm: a few prop accounts run through one firm's program, from the fee to the payout. Set it up in
// four steps on the left; on the right the accounts move through their stages. The battle test replays
// the setup over the backtest's month (drag the day, or press play) and over redraws of it for the odds;
// "live on paper" runs the same setup forward a day at a time on what the playbooks really take.

const ACCENT = '#7ee787';
const STAGES: { id: FarmStage; title: string; sub: string }[] = [
  { id: 'eval', title: 'Evaluations', sub: 'in play' },
  { id: 'funded', title: 'Funded', sub: 'in the rotation' },
  { id: 'parked', title: 'Payout ready', sub: 'parked until paid' },
  { id: 'busted', title: 'Out', sub: 'busted or not bought' },
];
const EVENT_ICON: Record<FarmEvent['kind'], string> = { bought: '🧾', passed: '✅', busted: '💥', 'payout-ready': '💰', paid: '🏦', trade: '📈' };

interface Preset {
  id: string;
  name: string;
  strategy: FarmStrategy;
}
const ALL_MARKETS: FarmStrategy['markets'] = ['NQ', 'ES', 'GC'];
const one = (p: PlaybookId): Preset => ({ id: p, name: PLAYBOOK_BY_ID[p].name, strategy: { playbooks: [p], mode: 'every', manage: 'written', markets: ALL_MARKETS } });

export function openFarm() {
  const save = stored<Partial<FarmSetup> & { tab?: 'battle' | 'live'; firm?: string }>('agent-office.farm', {});
  const kept = save.get();
  let setup: FarmSetup = cleanSetup({ ...FARM_DEFAULTS, ...kept });
  let tab: 'battle' | 'live' = kept.tab === 'live' && trading.snap?.farm ? 'live' : 'battle';
  let firm = FARM_PROGRAM_BY_ID[setup.programId]!.firm;
  let detail: BacktestDetail | null = null;
  let loadedFor = '';
  let how = false;
  let day = 0;
  let playing = 0;
  let note = '';
  let feedAll = false;
  const persist = () => save.set({ ...setup, tab, firm });

  const rail = h('aside.tl-rail.fm-rail');
  const money$ = h('div');
  const pipeline = h('div.fm-pipe');
  const lower = h('div.tl-cols');
  const dayRead = h('span.fm-day');
  const slider = h('input.tl-range.fm-scrub', { type: 'range', min: '0', max: '0', step: '1', 'aria-label': 'Day of the run' }) as HTMLInputElement;
  const play = h('button.tl-btn.fm-play', { type: 'button', 'aria-label': 'Replay the run day by day' }, '▶ Replay') as HTMLButtonElement;
  const timeline = h('div.fm-timeline', {}, play, slider, dayRead);
  const sheet = h('div.tl-sheet');
  const status = h('span.grow');
  const liveBtn = h('button.tl-btn.primary', { type: 'button' }) as HTMLButtonElement;
  const stopBtn = h('button.tl-btn', { type: 'button' }, 'Stop the live farm') as HTMLButtonElement;
  const tabs = h('div');
  const close = h('button.btn.close', { type: 'button', 'aria-label': 'Close the Farm', title: 'Close (Esc)' }, '✕');
  const main = h('div.tl-main', {}, money$, timeline, pipeline, lower);
  const el = h('div.modal.tl.tl-farm', { role: 'dialog', 'aria-label': 'The Farm', style: `--tl-accent:${ACCENT}` },
    h('header.tl-header', {},
      h('div.tl-title', {}, h('span.tl-kicker', {}, 'BACK OFFICE · PROP FARM'), h('h2', {}, '🌾 The Farm')),
      tabs,
      h('button.tl-btn', { type: 'button', onclick: () => { how = !how; render(); } }, 'How it works'),
      h('button.tl-btn', { type: 'button', title: 'Test one account in detail', onclick: () => { modal.close(); openEvalSim({ playbooks: setup.strategy.playbooks, plan: setup.strategy.mode, manage: setup.strategy.manage }); } }, '🏦 Eval simulator'),
      close),
    h('div.tl-body', {}, rail, main, sheet),
    h('footer.tl-footer', {}, status, stopBtn, liveBtn));
  let off = () => {};
  const hook = h('input.tl-input.fm-hook', { type: 'url', placeholder: 'https://discord.com/api/webhooks/…', 'aria-label': 'Discord webhook address', autocomplete: 'off' }) as HTMLInputElement;
  const stopPlay = () => {
    if (playing) clearInterval(playing);
    playing = 0;
    play.textContent = '▶ Replay';
  };
  const modal = openModal(el, { doing: 'running the prop farm', onClose: () => { stopPlay(); off(); } });
  close.addEventListener('click', () => modal.close());

  const change = (patch: Partial<FarmSetup>) => {
    setup = cleanSetup({ ...setup, ...patch });
    persist();
    compute();
    render();
  };

  // ---- The numbers: worked out when the setup or the data changes, not on every drag of the day ----
  let lists: ReturnType<typeof farmDays> = [];
  let days: string[] = [];
  let battle: FarmRun | null = null;
  let odds: FarmOdds | null = null;
  let perProgram = new Map<string, FarmOdds>();
  let evalLadder: { micros: number; odds: FarmOdds }[] = [];
  let fundedLadder: { micros: number; odds: FarmOdds }[] = [];
  let presets: Preset[] = [];
  const limits = (s: FarmSetup) => {
    const p = FARM_PROGRAM_BY_ID[s.programId]!;
    const rules = (id: string | null) => ACCOUNT_CATALOG.find((a) => a.id === id);
    return { evalMax: rules(p.evalId)?.maxMicros ?? 0, fundedMax: rules(p.fundedId)!.maxMicros };
  };
  function compute() {
    if (!detail?.trades.length) return;
    days = weekdays(detail.days);
    lists = farmDays(detail.trades, setup.strategy, days);
    battle = runFarm(lists, setup, days);
    odds = farmOdds(lists, setup, { runs: 300, horizon: 60 });
    perProgram = new Map(FARM_PROGRAMS.map((p) => [p.id, farmOdds(lists, { ...setup, programId: p.id, fee: null }, { runs: 120, horizon: 60 })]));
    const { evalMax, fundedMax } = limits(setup);
    const ladder = (max: number, key: 'evalMicros' | 'fundedMicros') => [...new Set([1, 2, 3, 5, 10, 20, max].filter((n) => n >= 1 && n <= max))].sort((a, b) => a - b).map((micros) => ({ micros, odds: farmOdds(lists, { ...setup, [key]: micros }, { runs: 120, horizon: 60 }) }));
    evalLadder = evalMax ? ladder(evalMax, 'evalMicros') : [];
    fundedLadder = ladder(fundedMax, 'fundedMicros');
    const mix = trading.snap?.backtest?.mixes?.find((m) => m.order.length > 1 && m.mode !== 'every' && m.trades >= 20);
    presets = [
      ...(mix ? [{ id: 'mix', name: 'The lab’s best mix', strategy: { playbooks: mix.order, mode: mix.mode, manage: 'written' as const, markets: ALL_MARKETS } }] : []),
      one('support-resistance'), one('failed-auction'), one('vwap-pullback'), one('double-break'),
    ];
    if (tab === 'battle') day = battle.days.length - 1;
  }
  const shown = (): FarmRun | null => (tab === 'live' ? trading.snap?.farm?.run ?? null : battle);

  // ---- Drawing ---------------------------------------------------------------------------------------
  const stepper = (value: number, min: number, max: number, set: (v: number) => void, label: string) =>
    h('div.fm-stepper', { role: 'group', 'aria-label': label },
      h('button', { type: 'button', disabled: value <= min, 'aria-label': `Fewer: ${label}`, onclick: () => set(value - 1) }, '−'),
      h('b', {}, String(value)),
      h('button', { type: 'button', disabled: value >= max, 'aria-label': `More: ${label}`, onclick: () => set(value + 1) }, '+'));
  const ladderRow = (rows: { micros: number; odds: FarmOdds }[], now: number, pick: (n: number) => void) => {
    if (!rows.length) return null;
    const best = rows.reduce((a, b) => (b.odds.p50 > a.odds.p50 ? b : a), rows[0]!);
    return h('div.fm-ladder', {}, ...rows.map((r) => h('button', { type: 'button', 'aria-pressed': String(r.micros === now), 'data-best': r === best ? '1' : undefined, title: `${r.micros} micros: typically ${signedMoney(r.odds.p50)} over ${r.odds.horizon} days, ahead in ${pct(r.odds.ahead)} of redraws`, onclick: () => pick(r.micros) },
      h('b', {}, String(r.micros)), h('small', { 'data-tone': r.odds.p50 >= 0 ? 'up' : 'down' }, `${r.odds.p50 >= 0 ? '+' : '−'}$${Math.abs(r.odds.p50) >= 1000 ? `${(Math.abs(r.odds.p50) / 1000).toFixed(1)}k` : Math.abs(r.odds.p50)}`), r === best ? h('i', {}, '★') : null)));
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
            h('span.fm-program-top', {}, h('b', {}, p.name), h('span.tl-tag', { 'data-kind': p.evalId ? 'eval' : 'funded' }, p.evalId ? 'EVAL → FUNDED' : 'STRAIGHT TO FUNDED')),
            h('small', {}, p.note),
            o?.runs ? h('span.fm-program-odds', { 'data-tone': o.p50 >= 0 ? 'up' : 'down' }, `Typically ${signedMoney(o.p50)} in ${o.horizon} days · ahead ${pct(o.ahead)}`) : null);
        }),
        h('label.tl-inline.fm-fee', {}, 'One attempt costs $', fee, program.feeEstimated && setup.fee == null ? h('em', {}, 'a guess: set yours') : null)),
      step(2, 'How many accounts',
        h('div.fm-row', {}, stepper(setup.slots, 1, 5, (v) => change({ slots: v }), 'accounts side by side'), h('small', {}, 'side by side')),
        h('div.fm-row', {}, stepper(setup.maxAttempts, 1, 60, (v) => change({ maxAttempts: v }), 'attempts in all'), h('small', {}, `attempts in all (${money(setup.maxAttempts * (setup.fee ?? program.fee))} of fees at most)`)),
        segmented<FarmSetup['share']>([{ id: 'rotate', label: 'Take turns' }, { id: 'copy', label: 'All take every trade' }], setup.share, (v) => change({ share: v })),
        h('small', {}, setup.share === 'rotate' ? 'Each signal goes to the next account in turn, so no two are ever on opposite sides.' : 'Every account takes every signal: allowed between your own accounts, but they win and lose together.')),
      step(3, 'What they trade',
        h('div.fm-presets', {}, ...presets.map((p) => chip(p.name, samePreset(p), () => change({ strategy: { ...p.strategy, manage: setup.strategy.manage } }), { color: PLAYBOOK_BY_ID[p.strategy.playbooks[0]!].color }))),
        h('small', {}, strategyLabel(setup.strategy)),
        h('label.tl-inline', {}, 'Managed', h('select.tl-input', { 'aria-label': 'How a trade is managed', onchange: (e: Event) => change({ strategy: { ...setup.strategy, manage: (e.target as HTMLSelectElement).value as FarmStrategy['manage'] } }) }, ...MANAGE.map((m) => h('option', { value: m.id, selected: m.id === setup.strategy.manage }, m.short))))),
      step(4, 'How big',
        evalMax ? h('div.fm-size', {}, h('span.tl-label', {}, `Evaluation · ${setup.evalMicros} micros (limit ${evalMax})`), ladderRow(evalLadder, setup.evalMicros, (n) => change({ evalMicros: n }))) : h('small', {}, 'No evaluation in this program: it starts funded.'),
        h('div.fm-size', {}, h('span.tl-label', {}, `Funded · ${setup.fundedMicros} micros (limit ${fundedMax})`), ladderRow(fundedLadder, setup.fundedMicros, (n) => change({ fundedMicros: n }))),
        h('small', {}, 'Under each size: what the farm typically nets in 60 days at it. ★ is the best of them on these days.'),
        h('button.tl-toggle', { type: 'button', role: 'switch', 'aria-checked': String(setup.fundedOneAndDone), onclick: () => change({ fundedOneAndDone: !setup.fundedOneAndDone }) }, h('i'), h('span', {}, h('b', {}, 'Funded: one winner and done'), h('small', {}, 'Keeps each day small, which the consistency rules want')))),
      step(5, 'Get the notices',
        h('small', {}, trading.snap?.farm ? (trading.snap.farm.discord ? 'Every fill, pass and payout of the live farm goes to your Discord channel.' : 'Paste a Discord webhook address and the live farm posts every fill, pass and payout there.') : 'Once the farm is live, it can post every fill, pass and payout to a Discord channel.'),
        trading.snap?.farm ? h('div.fm-row', {}, hook, h('button.tl-btn', { type: 'button', onclick: async () => { note = (await trading.post('/api/trading/farm', { action: 'discord', url: hook.value })) ?? (hook.value ? 'Notices on' : 'Notices off'); hook.value = ''; render(); } }, 'Save')) : null));
  }

  const card = (c: FarmCell, slot: number) => {
    const span = Math.max(1, c.target - c.floor);
    const at = Math.max(0, Math.min(1, (c.balance - c.floor) / span));
    const start = Math.max(0, Math.min(1, (c.size - c.floor) / span));
    return h('div.fm-card', { 'data-stage': c.stage },
      h('div.fm-card-top', {}, h('b', {}, c.account || `Slot ${slot + 1}`), h('span.fm-chip', {}, c.stage === 'eval' ? 'IN PLAY' : c.stage === 'funded' ? 'TRADING' : c.stage === 'parked' ? 'PAYOUT READY' : c.stage === 'busted' ? 'BUSTED' : 'WAITING')),
      c.stage === 'empty'
        ? h('small', {}, 'No attempts left to buy')
        : h('div', {},
            h('div.fm-balance', {}, money(c.balance)),
            h('div.fm-card-line', {}, h('span', { 'data-tone': c.pnl > 0 ? 'up' : c.pnl < 0 ? 'down' : 'flat' }, `today ${signedMoney(c.pnl)}`), h('span', {}, `to date ${signedMoney(c.balance - c.size)}`)),
            h('div.fm-bar', {}, h('i', { style: `--at:${(at * 100).toFixed(1)}%` }), h('u', { style: `left:${start * 100}%` })),
            h('div.fm-card-line.dim', {}, h('span', {}, `floor ${money(c.floor)}`), h('span', {}, `${c.stage === 'eval' ? 'target' : 'payout at'} ${money(c.target)}`)),
            c.last ? h('small', {}, `last: ${c.last}`) : h('small', {}, 'no trade yet'),
            c.stage === 'funded' || c.stage === 'parked' ? h('small', {}, `${c.tradingDays} day${c.tradingDays === 1 ? '' : 's'} traded${c.bestShare != null ? ` · best day ${pct(c.bestShare)} of profit` : ''}`) : null));
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
    // The feed up to this day, and the cash line with this day marked.
    const upTo = run.events.filter((e) => e.day <= i);
    const feed = [...(feedAll ? upTo : upTo.filter((e) => e.kind !== 'trade'))].reverse().slice(0, 40);
    const cash = run.cash;
    const untilNow = cash[i] ?? 0;
    lower.replaceChildren(
      panel('What happened', `Up to ${shortDay(run.days[i]!)}, newest first`,
        h('div.tl-chips', {}, chip('Milestones', !feedAll, () => { feedAll = false; drawDay(run); }), chip('Every trade too', feedAll, () => { feedAll = true; drawDay(run); })),
        h('div.fm-feed', {}, ...(feed.length ? feed.map((e) => h('div.fm-event', { 'data-kind': e.kind }, h('span.fm-event-icon', {}, EVENT_ICON[e.kind]), h('div', {}, h('b', {}, `${e.account || `Slot ${e.slot + 1}`} · ${e.kind === 'payout-ready' ? 'PAYOUT READY' : e.kind.toUpperCase()}`), h('p', {}, e.text), h('small', {}, dayLabel(run.days[e.day]!))), e.amount && e.kind !== 'trade' ? h('span.fm-event-amt', { 'data-tone': e.amount > 0 ? 'up' : 'down' }, signedMoney(e.amount)) : null)) : [h('p.tl-fine', {}, 'Nothing yet.')]))),
      panel('Cash in and out', 'Payouts received less fees paid, after each day',
        chart({
          height: 330,
          width: 560,
          n: cash.length + 1,
          label: 'Net cash by day',
          series: [{ values: [0, ...cash], color: ACCENT, width: 3, area: { fill: 'rgba(126,231,135,.08)', to: 'bottom' }, dot: (k) => (k === i + 1 ? '#fff' : null) }],
          levels: [{ y: 0, color: TONE.faint, label: 'EVEN', dash: '2 6' }],
          xLabel: (k) => (k === 0 ? 'Start' : shortDay(run.days[k - 1]!)),
          yFmt: (v) => `${v < 0 ? '−' : ''}$${Math.abs(v) >= 1000 ? `${(Math.abs(v) / 1000).toFixed(1)}k` : Math.abs(v)}`,
          tip: (k) => (k === 0 ? [h('b', {}, 'Start')] : [h('b', {}, dayLabel(run.days[k - 1]!)), h('span', { 'data-tone': cash[k - 1]! >= 0 ? 'up' : 'down' }, `Net ${signedMoney(cash[k - 1]!)}`), ...run.events.filter((e) => e.day === k - 1 && e.kind !== 'trade').slice(0, 4).map((e) => h('span', {}, `${EVENT_ICON[e.kind]} ${e.account}: ${e.kind}`))]),
        }),
        h('p.tl-fine', {}, `By ${shortDay(run.days[i]!)}: ${signedMoney(untilNow)} net.`)));
  }

  function render() {
    const s = trading.snap;
    const bt = s?.backtest;
    const live = s?.farm ?? null;
    el.classList.toggle('tl-how-open', how);
    tabs.replaceChildren(segmented<'battle' | 'live'>([{ id: 'battle', label: 'Battle test' }, { id: 'live', label: live ? '● Live on paper' : 'Live on paper' }], tab, (v) => { tab = v; stopPlay(); const r = shown(); day = r ? r.days.length - 1 : 0; persist(); render(); }));
    const program = FARM_PROGRAM_BY_ID[setup.programId]!;
    status.textContent = !detail?.trades.length ? (bt?.running || !bt ? 'Replaying the month on real bars…' : 'No backtest trades yet') : tab === 'battle' ? `${days.length} real trading days (${shortDay(days[0]!)} to ${shortDay(days[days.length - 1]!)}) · ${program.firm} ${program.name} · paper evidence, never a promise${note ? ` · ${note}` : ''}` : live ? `Live on paper since ${shortDay(live.startDay)} · ${FARM_PROGRAM_BY_ID[live.setup.programId]!.firm} ${FARM_PROGRAM_BY_ID[live.setup.programId]!.name} · ${strategyLabel(live.setup.strategy)}${live.discord ? ' · notices to Discord' : ''}${note ? ` · ${note}` : ''}` : 'No farm is running live';
    liveBtn.textContent = live ? 'Switch the live farm to this setup' : 'Run this farm live on paper';
    stopBtn.hidden = !live;
    if (!detail?.trades.length) {
      rail.replaceChildren(h('span.tl-kicker', {}, 'SET IT UP'));
      money$.replaceChildren(h('div.tl-waiting', {}, h('span.tl-spin'), h('b', {}, bt?.running || !bt ? 'Replaying the month on real bars…' : 'No backtest trades yet'), h('p', {}, 'The farm runs on the backtest’s trades. It fills in the moment the backtest finishes.')));
      timeline.hidden = true;
      pipeline.replaceChildren();
      lower.replaceChildren();
      return;
    }
    drawRail();
    const run = shown();
    timeline.hidden = !run;
    if (!run) {
      money$.replaceChildren(h('div.tl-hero', { 'data-result': 'running' }, h('div.tl-verdict', {}, h('span.tl-kicker', {}, 'LIVE ON PAPER'), h('div.tl-verdict-word', { 'data-size': 'm', 'data-tone': 'warn' }, 'NOT RUNNING YET'), h('p', {}, 'Set the farm up on the left, check it in the battle test, then run it live: the office buys the accounts on paper and trades them forward a day at a time as the playbooks call their setups. Nothing is bought and no order is placed.')), h('div.tl-odds', {}, h('span.tl-kicker', {}, 'WHAT YOU’LL SEE'), h('p', {}, 'Each account moving from evaluation to funded to payout-ready, every fill and milestone in the feed, and the cash line. Add a Discord webhook to get the notices on your phone.'))));
      pipeline.replaceChildren();
      lower.replaceChildren();
      return;
    }
    slider.max = String(run.days.length - 1);
    day = Math.max(0, Math.min(run.days.length - 1, day));
    slider.value = String(day);
    const net = run.cash[run.cash.length - 1] ?? 0;
    const usedSetup = tab === 'live' && live ? live.setup : setup;
    const usedProgram = FARM_PROGRAM_BY_ID[usedSetup.programId]!;
    money$.replaceChildren(h('div.tl-hero', { 'data-result': net > 0 ? 'passed' : net < 0 ? 'busted' : 'running' },
      h('div.tl-verdict', {},
        h('span.tl-kicker', {}, `${usedProgram.firm} · ${usedProgram.name} · ${usedSetup.slots} account${usedSetup.slots === 1 ? '' : 's'} · ${strategyLabel(usedSetup.strategy)}`.toUpperCase()),
        h('div.tl-verdict-word', { 'data-tone': net > 0 ? 'up' : net < 0 ? 'down' : 'warn' }, signedMoney(net), h('span', {}, tab === 'live' ? `net on paper since ${shortDay(run.days[0]!)}` : `net over the ${run.days.length} days`)),
        h('p', {}, `${run.attempts} attempt${run.attempts === 1 ? '' : 's'} bought for ${money(run.fees)}. ${usedProgram.evalId ? `${run.passed} passed, ${run.evalBusts} busted in the evaluation. ` : ''}${run.payoutCount} payout${run.payoutCount === 1 ? '' : 's'} worth ${money(run.payouts)}${run.fundedBusts ? `, and ${run.fundedBusts} funded account${run.fundedBusts === 1 ? '' : 's'} lost` : ''}.`),
        h('div.tl-stats', {},
          stat('Fees paid', money(run.fees), { tone: 'down', sub: `${run.attempts} × ${money(usedSetup.fee ?? usedProgram.fee)}` }),
          stat('Payouts', money(run.payouts), { tone: run.payouts ? 'up' : undefined, sub: `${run.payoutCount} received` }),
          stat(usedProgram.evalId ? 'Passed' : 'Reached a payout', usedProgram.evalId ? `${run.passed} of ${run.attempts}` : `${Math.min(run.attempts, run.payoutCount)} of ${run.attempts}`, { sub: usedProgram.evalId ? 'evaluations' : 'accounts' }),
          stat('Accounts lost', String(run.evalBusts + run.fundedBusts), { tone: run.evalBusts + run.fundedBusts ? 'down' : undefined, sub: 'hit the floor' }))),
      h('div.tl-odds', {},
        h('span.tl-kicker', {}, tab === 'live' ? 'THE BATTLE TEST SAID, FOR THE SETUP ON THE LEFT' : 'THE ODDS, OVER 60 TRADING DAYS'),
        odds?.runs
          ? h('div.tl-odds-main', {},
              h('div.tl-odds-big', {}, h('b', { 'data-tone': odds.p50 >= 0 ? 'up' : 'down' }, signedMoney(odds.p50)), h('span', {}, 'is the typical net')),
              h('div.tl-odds-meter', {}, h('i', { 'data-k': 'pass', style: `width:${odds.ahead * 100}%` }), h('i', { 'data-k': 'bust', style: `width:${(1 - odds.ahead) * 100}%` })),
              h('div.tl-odds-legend', {}, h('span', { 'data-k': 'pass' }, `${pct(odds.ahead)} end ahead`), h('span', { 'data-k': 'bust' }, `${pct(1 - odds.ahead)} end behind`)),
              h('small', {}, `${odds.runs} redraws of your real days. A bad run nets ${signedMoney(odds.p10)}, a good one ${signedMoney(odds.p90)}. On average ${odds.attempts.toFixed(1)} attempts, ${pct(odds.passRate)} of them ${FARM_PROGRAM_BY_ID[setup.programId]!.evalId ? 'pass' : 'reach a payout'}, ${odds.payouts.toFixed(1)} payouts. One month of paper trades, and a withdrawal is assumed to leave the full drawdown: read it as a lead, not a forecast.`))
          : h('p', {}, 'No trades to draw from for this strategy.'))));
    drawDay(run);
    if (how) {
      sheet.replaceChildren(howSheet('The Farm',
        'A prop account costs a fee, not the drawdown. So the question a farm asks is: over many attempts, do the payouts come to more than the fees? This runs that for your playbooks, on real bars.',
        [
          { title: 'It buys the accounts', body: `Each slot buys an attempt at the program you picked${program.evalId ? ': an evaluation first, a funded account when it passes' : ', which starts funded'}. When one busts, the slot buys the next, until the attempts run out.`, fact: `${run.attempts} bought · ${money(run.fees)} in fees` },
          { title: 'It hands out the signals', body: 'Every setup your strategy calls goes to an account. Taking turns sends each one to the next account in line, so they hold different trades and are never on opposite sides. Copying sends it to all of them.', fact: strategyLabel(usedSetup.strategy) },
          { title: 'It sizes by stage', body: 'An evaluation trades the evaluation size; a funded account trades the funded size, which is smaller, because a funded account is worth protecting and its payout rule punishes one big day.', fact: `${usedSetup.evalMicros} micros in the evaluation · ${usedSetup.fundedMicros} funded` },
          { title: 'It checks the firm’s rules every close', body: 'The floor trails the way that firm trails it. An evaluation passes on its target, its days and its consistency rule. A funded account is payout-ready on its own three, and then it parks: no trades until it is paid.', fact: `${run.passed} passed · ${run.payoutCount} payouts · ${run.evalBusts + run.fundedBusts} lost` },
          { title: 'It counts the cash', body: `Fees go out when an attempt is bought. A payout comes in the day after an account parks, at your ${Math.round(usedProgram.split * 100)}% share${usedProgram.payoutCap ? ` and capped at ${money(usedProgram.payoutCap)}` : ''}.`, fact: `${signedMoney(net)} net` },
          { title: 'It redraws the days for the odds', body: 'The month is one path. The same farm is run over 300 redraws of your real days, 60 at a time, to see what it typically nets and how often it ends ahead.', fact: odds?.runs ? `${signedMoney(odds.p50)} typical · ahead ${pct(odds.ahead)}` : undefined },
        ],
        [...FARM_CAVEATS, 'It is one month of history. A strategy that happened to fit September will look better here than it is.'],
        () => { how = false; render(); }));
    }
  }

  slider.addEventListener('input', () => { stopPlay(); day = Number(slider.value); const r = shown(); if (r) drawDay(r); });
  play.addEventListener('click', () => {
    const r = shown();
    if (!r) return;
    if (playing) return stopPlay();
    day = 0;
    play.textContent = '❚❚ Pause';
    playing = window.setInterval(() => {
      const run = shown();
      if (!run || day >= run.days.length - 1) return stopPlay();
      day++;
      slider.value = String(day);
      drawDay(run);
    }, 420);
    slider.value = '0';
    drawDay(r);
  });
  liveBtn.addEventListener('click', async () => {
    note = (await trading.post('/api/trading/farm', { action: 'start', setup, from: 'today' })) ?? 'Running live on paper from today';
    tab = 'live';
    day = 0;
    persist();
    render();
  });
  stopBtn.addEventListener('click', async () => {
    note = (await trading.post('/api/trading/farm', { action: 'stop' })) ?? 'The live farm is stopped';
    tab = 'battle';
    compute();
    render();
  });

  const load = async () => {
    const bt = trading.snap?.backtest;
    const key = `${bt?.ranAt}:${bt?.tuner?.ranAt}`;
    if (!bt || bt.running || key === loadedFor) return;
    loadedFor = key;
    detail = await trading.backtestDetail();
    compute();
    render();
  };
  // Prices tick every second; the page only redraws when the backtest or the live farm moves on.
  let was = '';
  off = trading.on(() => {
    const s = trading.snap;
    const f = s?.farm;
    const now = `${!!s?.backtest?.running}:${f ? `${f.startDay}:${f.run.events.length}:${f.run.cash[f.run.cash.length - 1]}:${f.run.days.length}` : ''}`;
    if (now !== was) {
      was = now;
      if (tab === 'live' && f) day = f.run.days.length - 1;
      render();
    }
    void load();
  });
  render();
  void load();
}
