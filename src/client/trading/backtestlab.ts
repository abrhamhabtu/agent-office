import type { BacktestDetail, PaperTrade, PlaybookId, Symbol } from '../../shared/trading';
import { INSTRUMENTS, PLAYBOOK_BY_ID, PLAYBOOKS, SYMBOLS } from '../../shared/trading';
import { applyFilters, envOf, FILTER_BY_ID, FILTERS, groupStats, labStats, OPPOSITES, suggestFilters, type FilterGroup, type FilterId, type LabStats, type Suggestion } from '../../shared/backtest-lab';
import type { PlaybookVersion, TunerBook, TunerView } from '../../shared/tuning';
import { KNOBS } from '../../shared/tuning';
import { MANAGE, MANAGE_BY_ID, managed, type ManageId } from '../../shared/manage';
import { h, openModal } from '../ui/dom';
import { confirmDialog } from '../ui/prompt';
import { openEvalSim } from './evalsim';
import { trading } from './feed';
import { bars, chart, chip, dayLabel, fmtR, howSheet, panel, pct, shortDay, signedMoney, spark, stat, stored, TONE, toneOf } from './labkit';

// The Backtest Lab, opened from its board in the Back Office. It says, in plain numbers, what each playbook
// did on real bars: what a trade makes on average, how often it wins, how deep the worst dip went. Then it
// lets you ask "what if I only took the ones with the trend?" by switching indicators on, shows what each
// one changes before you click it, and recommends the ones that held up on days they weren't picked on.

const ACCENT = '#f15bb5';
const GROUPS: FilterGroup[] = ['Trend', 'Momentum', 'Volume & volatility', 'Location', 'Time of day', 'Direction'];
const VERDICT: Record<Suggestion['verdict'], { label: string; tone: string }> = {
  recommended: { label: 'Recommended', tone: 'up' },
  unproven: { label: 'Looks better, not proven', tone: 'warn' },
  neutral: { label: 'No real difference', tone: 'flat' },
  thin: { label: 'Too few trades left', tone: 'flat' },
  hurts: { label: 'Makes it worse', tone: 'down' },
};
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const clock = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;

interface Saved {
  /** How a trade is managed once it's working. */
  manage: ManageId;
  playbook: PlaybookId | 'all';
  market: Symbol | 'ALL';
  filters: FilterId[];
}

export interface BacktestLabInit {
  manage?: ManageId;
  playbook?: PlaybookId | 'all';
  market?: Symbol | 'ALL';
  filters?: FilterId[];
}

export function openBacktestLab(init: BacktestLabInit = {}) {
  const save = stored<Partial<Saved>>('agent-office.backtest-lab', {});
  const st: Saved = { manage: 'written', playbook: 'all', market: 'ALL', filters: [], ...save.get(), ...init };
  if (!(st.manage in MANAGE_BY_ID)) st.manage = 'written';
  if (st.playbook !== 'all' && !(st.playbook in PLAYBOOK_BY_ID)) st.playbook = 'all';
  st.filters = st.filters.filter((f) => f in FILTER_BY_ID);
  let detail: BacktestDetail | null = null;
  let loadedFor = '';
  let how = false;
  let tradesOpen = false;
  let focus: FilterId | null = null;
  /** The version of the open playbook being looked at, when it isn't the live one. */
  let version: number | null = null;
  let triedOpen = false;
  let note = '';
  const persist = () => save.set(st);

  const rail = h('aside.tl-rail');
  const main = h('div.tl-main');
  const sheet = h('div.tl-sheet');
  const explain = h('div.tl-explain');
  const status = h('span.grow');
  const rerun = h('button.tl-btn', { type: 'button', onclick: () => void trading.post('/api/trading/backtest', {}) }, '↻ Run it again') as HTMLButtonElement;
  const close = h('button.btn.close', { type: 'button', 'aria-label': 'Close the Backtest Lab', title: 'Close (Esc)' }, '✕');
  const toSim = () => {
    modal.close();
    openEvalSim({ playbooks: st.playbook === 'all' ? PLAYBOOKS.map((p) => p.id) : [st.playbook], markets: st.market === 'ALL' ? undefined : [st.market], filters: st.filters, candidates: version != null, manage: st.manage });
  };
  const el = h('div.modal.tl.tl-lab', { role: 'dialog', 'aria-label': 'Backtest Lab', style: `--tl-accent:${ACCENT}` },
    h('header.tl-header', {},
      h('div.tl-title', {}, h('span.tl-kicker', {}, 'BACK OFFICE · WALL DISPLAY'), h('h2', {}, '🧪 Backtest lab')),
      h('button.tl-btn', { type: 'button', onclick: () => { how = !how; render(); } }, 'How it works'),
      h('button.tl-btn', { type: 'button', title: 'Play these trades through a prop account’s rules', onclick: toSim }, '🏦 Eval simulator'),
      close),
    h('div.tl-body', {}, rail, main, sheet),
    h('footer.tl-footer', {}, status, rerun, h('button.tl-btn.primary', { type: 'button', onclick: toSim }, 'Test this on a prop account →')));
  let off = () => {};
  const modal = openModal(el, { doing: 'in the Backtest Lab', onClose: () => off() });
  close.addEventListener('click', () => modal.close());

  const toggleFilter = (id: FilterId) => {
    if (st.filters.includes(id)) st.filters = st.filters.filter((f) => f !== id);
    else {
      const clash = OPPOSITES.find((p) => p.includes(id))?.find((x) => x !== id);
      st.filters = [...st.filters.filter((f) => f !== clash), id];
    }
    focus = id;
    persist();
    render();
  };
  const scopeOf = (all: PaperTrade[], playbook: Saved['playbook'], market: Saved['market']) => all.filter((t) => (playbook === 'all' || t.playbook === playbook) && (market === 'ALL' || t.symbol === market));
  const scopeName = () => `${st.playbook === 'all' ? 'All five playbooks' : PLAYBOOK_BY_ID[st.playbook].name} on ${st.market === 'ALL' ? 'every market' : st.market}`;

  /** What a filter does to the trades in view: against the others that are on, whether it's on itself or not. */
  function effects(scope: PaperTrade[], env: ReturnType<typeof envOf>, days: string[]): Map<FilterId, Suggestion> {
    const out = new Map<FilterId, Suggestion>();
    for (const s of suggestFilters(scope, st.filters, env, days)) out.set(s.filter, s);
    for (const f of st.filters) {
      const s = suggestFilters(scope, st.filters.filter((x) => x !== f), env, days).find((x) => x.filter === f);
      if (s) out.set(f, s);
    }
    return out;
  }

  function drawExplain(fx: Map<FilterId, Suggestion>) {
    const id = focus ?? [...fx.values()].find((s) => s.verdict === 'recommended')?.filter ?? null;
    if (!id) return void explain.replaceChildren(h('span.tl-kicker', {}, 'WHAT AN INDICATOR DOES'), h('p', {}, 'Point at an indicator to see what it measures, the rule it adds, and what it would have changed on these trades. Click to switch it on.'));
    const f = FILTER_BY_ID[id];
    const s = fx.get(id);
    const on = st.filters.includes(id);
    const v = s ? VERDICT[s.verdict] : null;
    explain.replaceChildren(
      h('span.tl-kicker', {}, f.group.toUpperCase()),
      h('h4', {}, f.name),
      h('p', {}, f.what),
      h('p.tl-explain-rule', {}, h('b', {}, 'The rule: '), f.rule),
      ...(s
        ? [h('div.tl-explain-fx', {},
            h('span.tl-pill', { 'data-tone': v!.tone }, on ? `On · ${v!.label.toLowerCase()}` : v!.label, s.verdict === 'recommended' ? ` · ${s.confidence} confidence` : ''),
            h('div.tl-explain-nums', {}, stat('Keeps', `${s.kept} of ${s.of}`, { sub: 'trades' }), stat('Per trade', fmtR(s.avgR), { tone: toneOf(s.avgR), delta: fmtR(s.dAvgR), deltaTone: toneOf(s.dAvgR) }), stat('Total', fmtR(s.totalR, 1), { tone: toneOf(s.totalR), delta: fmtR(s.dTotalR, 1), deltaTone: toneOf(s.dTotalR) })),
            h('p', {}, s.reason, '.'))]
        : []),
      h('button.tl-btn.primary', { type: 'button', onclick: () => toggleFilter(id) }, on ? 'Switch it off' : 'Switch it on'));
  }

  function drawRail(all: PaperTrade[], env: ReturnType<typeof envOf>) {
    const card = (id: PlaybookId | 'all', name: string, color: string, sub: string) => {
      const s = labStats(applyFilters(scopeOf(all, id, st.market), st.filters, env));
      return h('button.tl-book', { type: 'button', style: `--c:${color}`, 'aria-pressed': String(st.playbook === id), onclick: () => { st.playbook = id; version = null; persist(); render(); } },
        h('span.tl-book-name', {}, name),
        h('span.tl-book-row', {}, h('b', { 'data-tone': s.trades ? toneOf(s.avgR) : 'flat' }, s.trades ? fmtR(s.avgR) : '—'), spark(s.curve, color, 96, 28) as unknown as Node),
        h('small', {}, s.trades ? `${s.trades} trades · ${pct(s.winRate)} win · ${sub}` : 'no trades'));
    };
    rail.replaceChildren(
      h('span.tl-kicker', {}, 'PICK A PLAYBOOK'),
      card('all', 'All playbooks', '#e9eef8', 'together'),
      ...PLAYBOOKS.map((p) => card(p.id, p.name, p.color, `${p.agent}’s desk`)),
      h('p.tl-rail-note', {}, 'The big number is what one trade makes on average, in risks (R). Above zero, the setup paid.'));
  }

  function render() {
    const s = trading.snap;
    const bt = s?.backtest;
    rerun.disabled = !!bt?.running;
    el.classList.toggle('tl-how-open', how);
    const days = detail?.days ?? [];
    status.textContent = !bt ? 'Waiting for the first backtest…' : bt.running ? 'Replaying the month on real bars…' : `${days.length} real trading days${days.length ? ` (${shortDay(days[0]!)} to ${shortDay(days[days.length - 1]!)})` : ''} · run ${new Date(bt.ranAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · no fees or slippage · paper evidence, never a promise`;
    if (!detail || !detail.trades.length) {
      rail.replaceChildren(h('span.tl-kicker', {}, 'PICK A PLAYBOOK'));
      main.replaceChildren(h('div.tl-waiting', {}, h('span.tl-spin'), h('b', {}, bt?.running || !bt ? 'Replaying the month on real bars…' : 'No backtest trades yet'), h('p', {}, 'Every playbook is replayed on about a month of real one-minute bars. It takes a few seconds after the office starts.')));
      return;
    }
    const tuner = bt?.tuner;
    const book = st.playbook === 'all' ? undefined : tuner?.books.find((b) => b.playbook === st.playbook);
    const viewed = version != null ? detail.versions?.find((v) => v.playbook === st.playbook && v.version === version) : undefined;
    if (version != null && !viewed) version = null;
    // Looking at a candidate version swaps that playbook's trades for the candidate's, everywhere on the page.
    const all = managed(viewed ? [...detail.trades.filter((t) => t.playbook !== st.playbook), ...viewed.trades] : detail.trades, st.manage);
    const env = envOf(all);
    const scope = scopeOf(all, st.playbook, st.market).filter((t) => t.outcome !== 'open').sort((a, b) => a.entryAt - b.entryAt);
    /** The same trades as the playbook wrote them, to compare the ways of managing them. */
    const rawScope = scopeOf(viewed ? [...detail.trades.filter((t) => t.playbook !== st.playbook), ...viewed.trades] : detail.trades, st.playbook, st.market).filter((t) => t.outcome !== 'open');
    const kept = applyFilters(scope, st.filters, env);
    const keptIds = new Set(kept.map((t) => t.id));
    const base = labStats(scope);
    const now = labStats(kept);
    const filtered = st.filters.length > 0;
    const fx = effects(scope, env, days);
    drawRail(all, env);
    drawExplain(fx);

    // ---- The answer, in a sentence and six numbers ----
    const verdict = now.trades < 20 ? { tone: 'warn', label: 'TOO FEW TRADES TO TRUST' } : now.avgR >= 0.1 ? { tone: 'up', label: 'THIS HAS AN EDGE' } : now.avgR > 0 ? { tone: 'warn', label: 'A THIN EDGE' } : { tone: 'down', label: 'NO EDGE ON THESE DAYS' };
    const delta = (a: number, b: number, fmt: (v: number) => string) => (filtered && a !== b ? { delta: `${fmt(a - b)} with filters`, deltaTone: toneOf(a - b) } : {});
    const answer = h('div.tl-hero', { 'data-result': verdict.tone === 'up' ? 'passed' : verdict.tone === 'down' ? 'busted' : 'running' },
      h('div.tl-verdict', {},
        h('span.tl-kicker', {}, `${scopeName()}${viewed ? ` · v${viewed.version} candidate, not live` : ''}`.toUpperCase()),
        h('div.tl-verdict-word', { 'data-tone': verdict.tone, 'data-size': 'm' }, verdict.label),
        h('p', {}, now.trades
          ? `Over ${days.length} trading days it took ${now.trades} trade${now.trades === 1 ? '' : 's'}${filtered ? ` (of ${base.trades} before your filters)` : ''}, won ${pct(now.winRate)} of them and made ${fmtR(now.avgR)} a trade. Risk $100 a trade and that is ${signedMoney(now.totalR * 100)}.`
          : 'No trades pass those filters. Switch one off.')),
      h('div.tl-kpis', {},
        stat('A trade makes', fmtR(now.avgR), { tone: toneOf(now.avgR), big: true, sub: 'on average, in risks', ...delta(now.avgR, base.avgR, (v) => fmtR(v)) }),
        stat('Wins', pct(now.winRate), { sub: `${now.wins} won · ${now.losses} lost`, ...delta(now.winRate, base.winRate, (v) => `${v >= 0 ? '+' : '−'}${Math.abs(Math.round(v * 100))} pts`) }),
        stat('All together', fmtR(now.totalR, 1), { tone: toneOf(now.totalR), sub: 'every trade added up', ...delta(now.totalR, base.totalR, (v) => fmtR(v, 1)) }),
        stat('Worst dip', `−${now.maxDrawdownR.toFixed(1)}R`, { tone: 'down', sub: 'peak to trough', ...(filtered && now.maxDrawdownR !== base.maxDrawdownR ? { delta: `${Math.abs(base.maxDrawdownR - now.maxDrawdownR).toFixed(1)}R ${base.maxDrawdownR > now.maxDrawdownR ? 'shallower' : 'deeper'} with filters`, deltaTone: toneOf(base.maxDrawdownR - now.maxDrawdownR) } : {}) }),
        stat('Won ÷ lost', now.profitFactor == null ? '—' : `${now.profitFactor.toFixed(2)}×`, { tone: now.profitFactor != null && now.profitFactor >= 1 ? 'up' : 'down', sub: 'above 1 pays' }),
        stat('Trades', String(now.trades), { sub: filtered ? `of ${base.trades}` : `${(now.trades / Math.max(1, days.length)).toFixed(1)} a day` })));

    // ---- The curve: every trade in order, what the filters skip drawn as a flat step ----
    const baseCurve = [0, ...base.curve];
    let run = 0;
    const keptCurve = [0, ...scope.map((t) => (keptIds.has(t.id) ? (run = Math.round((run + t.r) * 100) / 100) : run))];
    const color = st.playbook === 'all' ? TONE.text : PLAYBOOK_BY_ID[st.playbook].color;
    const curve = panel('The equity curve', 'Every trade added up, in the order it was taken. Run the pointer along it.',
      h('div.tl-field', {}, h('span.tl-label', {}, 'Once a trade is working'),
        h('div.tl-seg', { role: 'group' }, ...MANAGE.map((m) => {
          const alt = labStats(applyFilters(managed(rawScope, m.id), st.filters, env));
          return h('button', { type: 'button', title: m.what, 'aria-pressed': String(st.manage === m.id), onclick: () => { st.manage = m.id; persist(); render(); } }, m.short, h('em', { 'data-tone': toneOf(alt.avgR) }, alt.trades ? fmtR(alt.avgR) : '—'));
        })),
        h('small', {}, `${MANAGE_BY_ID[st.manage].what} The number on each is what a trade makes on average managed that way.`)),
      h('div.tl-chart-tools', {},
        h('div.tl-chips', {}, chip('All markets', st.market === 'ALL', () => { st.market = 'ALL'; persist(); render(); }), ...SYMBOLS.map((m) => chip(m, st.market === m, () => { st.market = m; persist(); render(); }, { color: INSTRUMENTS[m].ink, title: INSTRUMENTS[m].name }))),
        h('div.tl-legend', {}, h('span', { style: `--c:${color}` }, filtered ? 'With your filters' : 'Result in R'), filtered ? h('span', { style: `--c:${TONE.faint}` }, 'Without them') : null)),
      scope.length
        ? chart({
            height: 300,
            n: scope.length + 1,
            label: 'Cumulative result in R after each trade',
            series: [
              { values: filtered ? keptCurve : baseCurve, color, width: 3, area: { fill: 'rgba(241,91,181,.07)', to: 'bottom' } },
              ...(filtered ? [{ values: baseCurve, color: TONE.faint, width: 1.5, dash: '4 5' }] : []),
            ],
            levels: [{ y: 0, color: TONE.faint, label: 'BREAK EVEN', dash: '2 6' }],
            xLabel: (i) => (i === 0 ? 'Start' : shortDay(scope[i - 1]!.day)),
            yFmt: (v) => (v === 0 ? '0R' : `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(v % 1 ? 1 : 0)}R`),
            tip: (i) => {
              const t = scope[i - 1];
              if (!t) return [h('b', {}, 'Start'), h('span', {}, 'Before the first trade')];
              const on = keptIds.has(t.id);
              return [
                h('b', {}, `${dayLabel(t.day)}${t.ind ? ` · ${clock(t.ind.m)} PT` : ''}`),
                h('span', {}, `${t.symbol} ${t.side.toUpperCase()} · ${PLAYBOOK_BY_ID[t.playbook].name}`),
                h('span', { 'data-tone': toneOf(t.r) }, `${fmtR(t.r)} (${t.outcome === 'win' ? 'target' : t.outcome === 'loss' ? 'stopped' : 'flat at the close'})`),
                h('span', {}, `Running total ${fmtR((filtered ? keptCurve : baseCurve)[i]!, 1)}`),
                h('em', {}, on ? t.why : 'Skipped by your filters'),
              ];
            },
          })
        : h('p.tl-fine', {}, 'No trades here yet.'));

    // ---- Indicators: what each would change, before you click it ----
    const recs = [...fx.values()].filter((x) => x.verdict === 'recommended' && !st.filters.includes(x.filter)).slice(0, 3);
    const bench = panel('Add an indicator', 'Each one is a rule for which trades to take. The badge is what it would change per trade.',
      h('div.tl-recs', {},
        recs.length
          ? h('div.tl-rec-row', {}, ...recs.map((r) => h('button.tl-rec', { type: 'button', onclick: () => toggleFilter(r.filter), onmouseenter: () => { focus = r.filter; drawExplain(fx); } },
              h('span.tl-kicker', {}, `★ RECOMMENDED · ${r.confidence.toUpperCase()} CONFIDENCE`),
              h('b', {}, FILTER_BY_ID[r.filter].name),
              h('span', {}, `${fmtR(r.dAvgR)} a trade · keeps ${r.kept} of ${r.of}`),
              h('small', {}, 'Held up on the later days too. Click to add.'))))
          : h('p.tl-rec-none', {}, h('b', {}, filtered ? 'Nothing more to add. ' : 'The lab has no indicator to recommend here. '), 'One only gets recommended when the trades it keeps do better, it keeps enough of them, and it still works on the later days it wasn’t picked on. Several below may look better without clearing that bar.')),
      h('div.tl-bench', {},
        h('div.tl-bench-groups', {}, ...GROUPS.map((g) => h('div.tl-bench-group', {}, h('span.tl-label', {}, g),
          h('div.tl-chips', {}, ...FILTERS.filter((f) => f.group === g).map((f) => {
            const e = fx.get(f.id);
            const on = st.filters.includes(f.id);
            const b = h('button.tl-ind', { type: 'button', 'aria-pressed': String(on), 'data-verdict': e?.verdict ?? 'blocked', onclick: () => toggleFilter(f.id) },
              h('span', {}, e?.verdict === 'recommended' && !on ? '★ ' : '', f.name),
              e ? h('em', { 'data-tone': e.verdict === 'thin' ? 'flat' : toneOf(e.dAvgR) }, e.verdict === 'thin' ? `${e.kept} left` : fmtR(e.dAvgR)) : null);
            const show = () => { focus = f.id; drawExplain(fx); };
            b.addEventListener('mouseenter', show);
            b.addEventListener('focus', show);
            return b;
          }))))),
        explain),
      filtered ? h('div.tl-active', {}, h('span.tl-label', {}, `On now (${st.filters.length})`), h('div.tl-chips', {}, ...st.filters.map((f) => chip(`${FILTER_BY_ID[f].name} ✕`, true, () => toggleFilter(f), { kind: 'filter' }))), h('button.tl-btn', { type: 'button', onclick: () => { st.filters = []; focus = null; persist(); render(); } }, 'Clear them all')) : null);


    // ---- Versions: what the tuner tried on this playbook, and the ones it kept ----
    const act = async (body: object, ok: string) => {
      note = (await trading.post('/api/trading/tuner', body)) ?? ok;
      render();
    };
    const tunerLine = !tuner ? 'The tuner runs after the backtest.' : tuner.running ? `Tuning now: ${tuner.stage || 'starting'}…` : tuner.ranAt ? `Last tuned ${new Date(tuner.ranAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · ${tuner.replays} replays of the month in ${(tuner.took / 1000).toFixed(0)}s · ${tuner.note}` : 'The tuner hasn’t run yet.';
    const verdictPill = (v: PlaybookVersion) => (v.status === 'live' ? h('span.tl-pill', { 'data-tone': 'up' }, 'Live') : v.status === 'retired' ? h('span.tl-pill', {}, 'Retired') : h('span.tl-pill', { 'data-tone': v.vs?.verdict === 'better' ? 'up' : v.vs?.verdict === 'worse' ? 'down' : 'warn' }, v.vs?.verdict === 'better' ? `Tested better · ${v.vs.confidence}` : v.vs?.verdict === 'worse' ? 'Tested worse' : 'Not proven yet'));
    const versionCard = (b: TunerBook, v: PlaybookVersion) => {
      const live = b.versions.find((x) => x.status === 'live')!;
      const open = v.status === 'live' ? version == null : version === v.version;
      const has = !!detail!.versions?.some((x) => x.playbook === b.playbook && x.version === v.version);
      return h('div.tl-version', { 'data-status': v.status, 'data-open': open ? '1' : undefined },
        h('div.tl-version-head', {}, h('b', {}, `v${v.version}`), verdictPill(v), v.fresh ? h('span.tl-pill', { 'data-tone': 'up' }, 'New') : null, h('small', {}, v.version === 1 ? 'as written' : `${v.date} · from v${v.parent}`)),
        h('ul', {}, ...v.change.map((c) => h('li', {}, c))),
        v.test ? h('div.tl-version-nums', {}, stat('A trade makes', fmtR(v.test.avgR), { tone: toneOf(v.test.avgR), ...(v.vs ? { delta: `${fmtR(v.vs.dAvgR)} vs v${v.vs.version}`, deltaTone: toneOf(v.vs.dAvgR) } : {}) }), stat('Total', fmtR(v.test.totalR, 1), { tone: toneOf(v.test.totalR) }), stat('Later days', fmtR(v.test.laterAvgR), { tone: toneOf(v.test.laterAvgR), sub: `${v.test.laterTrades} trades` }), stat('Trades', String(v.test.trades), { sub: `${pct(v.test.winRate)} win` })) : null,
        v.vs ? h('p.tl-fine', {}, v.vs.reason, '.') : null,
        h('div.tl-version-acts', {},
          v.status === 'live' ? (version != null ? h('button.tl-btn', { type: 'button', onclick: () => { version = null; render(); } }, 'Back to the live version') : h('span.tl-fine', {}, 'This is what the proposals, the paper book and the numbers above use.')) : null,
          v.status === 'candidate' && has ? h('button.tl-btn', { type: 'button', onclick: () => { version = open ? null : v.version; if (v.fresh) void trading.post('/api/trading/tuner', { action: 'seen', playbook: b.playbook, version: v.version }); render(); } }, open ? 'Looking at it now' : 'Look at its trades') : null,
          v.status !== 'live' && v.status !== 'retired' ? h('button.tl-btn.primary', { type: 'button', onclick: () => confirmDialog(`Make ${PLAYBOOK_BY_ID[b.playbook].name} v${v.version} live?`, `The office will call ${PLAYBOOK_BY_ID[b.playbook].name} by v${v.version}’s rules from now on: the proposals, the paper book and the backtest all follow it, and v${live.version} is retired (you can bring it back). ${v.vs?.verdict === 'better' ? '' : 'The tuner hasn’t proven this one better yet. '}Nothing on your TradingView chart changes.`, 'Make it live', () => void act({ playbook: b.playbook, version: v.version, status: 'live' }, `v${v.version} is live: replaying the month with it`)) }, 'Make it live') : null,
          v.status === 'candidate' ? h('button.tl-btn', { type: 'button', onclick: () => { if (version === v.version) version = null; void act({ playbook: b.playbook, version: v.version, status: 'retired' }, `v${v.version} retired`); } }, 'Retire') : null,
          v.status === 'retired' ? h('button.tl-btn', { type: 'button', onclick: () => confirmDialog(`Bring back ${PLAYBOOK_BY_ID[b.playbook].name} v${v.version}?`, `It becomes the live version again and v${live.version} is retired.`, 'Make it live', () => void act({ playbook: b.playbook, version: v.version, status: 'live' }, `v${v.version} is live again`)) }, 'Roll back to this') : null));
    };
    const versions = book
      ? panel(`Versions of ${PLAYBOOK_BY_ID[book.playbook].name}`, 'The tuner changes one rule at a time, replays the month, and keeps what holds up',
          h('p.tl-fine', {}, tuner?.running ? h('span.tl-spin.small') : null, tunerLine, note ? ` · ${note}` : ''),
          h('div.tl-versions', {}, ...book.versions.filter((v) => v.status !== 'retired' || v.version !== 1 || book.versions.length > 1).map((v) => versionCard(book, v))),
          book.tried.length
            ? h('div', {},
                h('button.tl-btn', { type: 'button', onclick: () => { triedOpen = !triedOpen; render(); } }, triedOpen ? 'Hide what it tried' : `See all ${book.tried.length} changes it tried`),
                triedOpen ? h('div.tl-scroll', {}, h('table.tl-table', {},
                  h('thead', {}, h('tr', {}, ...['Change', 'Trades', 'Per trade', 'Against live', 'Later days', 'Verdict'].map((c) => h('th', {}, c)))),
                  h('tbody', {}, ...book.tried.map((t) => h('tr', { title: t.reason }, h('th', { scope: 'row', class: 'wrap' }, t.change.join(' + ')), h('td', {}, String(t.test.trades)), h('td', { 'data-tone': toneOf(t.test.avgR) }, fmtR(t.test.avgR)), h('td', { 'data-tone': toneOf(t.dAvgR) }, fmtR(t.dAvgR)), h('td', { 'data-tone': toneOf(t.test.laterAvgR) }, fmtR(t.test.laterAvgR)), h('td', { 'data-tone': t.verdict === 'better' ? 'up' : t.verdict === 'worse' ? 'down' : 'flat' }, t.verdict === 'better' ? `better · ${t.confidence}` : t.verdict === 'unproven' ? 'not proven' : t.verdict === 'same' ? 'no real difference' : 'worse')))))) : null)
            : null,
          h('p.tl-fine', {}, `It can change: ${(KNOBS[book.playbook] ?? []).map((k) => k.name.toLowerCase()).join(', ')}. A change is only called better when it makes more per trade and in total, keeps most of the trades, doesn’t deepen the dip, and still wins on the later third of the days. On a month of history most changes can’t clear that, and the tuner says so rather than guess.`))
      : st.playbook === 'all' && tuner
        ? panel('The tuner', 'Looks for better versions of your three playbooks after every backtest',
            h('p.tl-fine', {}, tuner.running ? h('span.tl-spin.small') : null, tunerLine),
            h('div.tl-rank', {}, ...tuner.books.map((b) => {
              const def = PLAYBOOK_BY_ID[b.playbook];
              const live = b.versions.find((v) => v.status === 'live')!;
              const cand = b.versions.find((v) => v.status === 'candidate');
              return h('button.tl-rank-row.wide', { type: 'button', style: `--c:${def.color}`, onclick: () => { st.playbook = b.playbook; version = null; persist(); render(); } },
                h('i.tl-chip-dot'), h('span.tl-rank-name', {}, def.name), h('span.tl-fine', {}, `v${live.version} live${cand ? ` · v${cand.version} ${cand.vs?.verdict === 'better' ? 'tested better' : 'to watch'}: ${cand.change.join('; ')}` : ' · no candidate yet'}`), h('b', {}, 'Open →'));
            })))
        : null;

    // ---- Mixes: the three playbooks traded together in a day ----
    const mixes = st.playbook === 'all' && bt?.mixes?.length
      ? panel('Mixing playbooks in a day', 'One first and another as the fallback, or one for trending and one for ranging markets (NQ, ES, GC)',
          h('div.tl-scroll', {}, h('table.tl-table', {},
            h('thead', {}, h('tr', {}, ...['The plan', 'Trades', 'Wins', 'Per trade', 'Total', 'Worst dip', 'Later days', ''].map((c) => h('th', {}, c)))),
            h('tbody', {}, ...bt.mixes.map((m) => h('tr', {},
              h('th', { scope: 'row', class: 'wrap' }, m.label),
              h('td', {}, String(m.trades)), h('td', {}, pct(m.winRate)),
              h('td', { 'data-tone': toneOf(m.avgR) }, fmtR(m.avgR)), h('td', { 'data-tone': toneOf(m.totalR) }, fmtR(m.totalR, 1)), h('td', {}, `−${m.maxDrawdownR.toFixed(1)}R`), h('td', { 'data-tone': toneOf(m.laterAvgR) }, fmtR(m.laterAvgR)),
              h('td', {}, h('button.tl-btn', { type: 'button', onclick: () => { modal.close(); openEvalSim({ playbooks: m.order, plan: m.mode, filters: st.filters, manage: st.manage }); } }, 'Simulate →'))))))),
          h('p.tl-fine', {}, 'A fallback only gets its turn once the first playbook has lost today, or hasn’t set up by 8:00 PT. Trending means ADX at 20 or more on the entry bar. Best per trade first; anything under 20 trades is at the bottom.'))
      : null;

    // ---- Where the edge is: every playbook on every market ----
    const cols: (Symbol | 'ALL')[] = ['ALL', ...SYMBOLS];
    const cell = (playbook: PlaybookId, market: Symbol | 'ALL') => {
      const cs = labStats(applyFilters(scopeOf(all, playbook, market), st.filters, env));
      const strength = Math.min(1, Math.abs(cs.avgR) / 0.6);
      const bg = !cs.trades ? 'transparent' : cs.avgR >= 0 ? `rgba(46,230,166,${0.06 + strength * 0.36})` : `rgba(255,93,115,${0.06 + strength * 0.36})`;
      return h('td', {}, h('button.tl-cell', { type: 'button', style: `background:${bg}`, 'data-thin': cs.trades < 8 ? '1' : undefined, 'aria-pressed': String(st.playbook === playbook && st.market === market), title: cs.trades ? `${cs.trades} trades · ${pct(cs.winRate)} win · total ${fmtR(cs.totalR, 1)}` : 'No trades', onclick: () => { st.playbook = playbook; st.market = market; version = null; persist(); render(); } },
        h('b', {}, cs.trades ? fmtR(cs.avgR) : '—'), h('small', {}, cs.trades ? `${cs.trades} trades` : '')));
    };
    const map = panel('Where the edge is', 'What a trade makes on average, playbook by market. Greener pays more; faded cells have under 8 trades. Click one to open it.',
      h('div.tl-scroll', {}, h('table.tl-map', {},
        h('thead', {}, h('tr', {}, h('th', {}, ''), ...cols.map((c) => h('th', {}, c === 'ALL' ? 'All markets' : c)))),
        h('tbody', {}, ...PLAYBOOKS.map((p) => h('tr', {}, h('th', { scope: 'row', style: `--c:${p.color}` }, h('i.tl-chip-dot'), p.name), ...cols.map((c) => cell(p.id, c))))))));

    // ---- When and which way it works ----
    const half = groupStats(kept, (t) => (t.ind ? (String(Math.floor(t.ind.m / 30) * 30).padStart(4, '0') as string) : null)).sort((a, b) => a.key.localeCompare(b.key));
    const week = groupStats(kept, (t) => String(new Date(`${t.day}T12:00:00Z`).getUTCDay())).sort((a, b) => a.key.localeCompare(b.key));
    const side = groupStats(kept, (t) => t.side);
    const sub = (x: LabStats) => `${x.trades} trade${x.trades === 1 ? '' : 's'} · ${pct(x.winRate)} win`;
    const bestOf = (list: { key: string; stats: LabStats }[], name: (k: string) => string) => {
      const ok = list.filter((x) => x.stats.trades >= 5).sort((a, b) => b.stats.avgR - a.stats.avgR);
      return ok.length > 1 && ok[0]!.stats.avgR > 0 ? `Best: ${name(ok[0]!.key)} (${fmtR(ok[0]!.stats.avgR)} a trade). Worst: ${name(ok[ok.length - 1]!.key)} (${fmtR(ok[ok.length - 1]!.stats.avgR)}).` : 'Not enough trades in each bucket to call a best one.';
    };
    const when = h('div.tl-cols', {},
      panel('By time of day', 'Average per trade, by the half hour it was entered (Pacific)',
        half.length ? bars(half.map((x) => ({ label: clock(Number(x.key)), value: x.stats.avgR, sub: sub(x.stats) })), (v) => fmtR(v)) : h('p.tl-fine', {}, 'No trades to split.'),
        h('p.tl-fine', {}, bestOf(half, (k) => `${clock(Number(k))} PT`))),
      h('div.tl-stack', {},
        panel('By weekday', null, week.length ? bars(week.map((x) => ({ label: WEEKDAYS[Number(x.key)]!, value: x.stats.avgR, sub: sub(x.stats) })), (v) => fmtR(v)) : h('p.tl-fine', {}, 'No trades to split.')),
        panel('Long against short', null, h('div.tl-sides', {}, ...(['long', 'short'] as const).map((k) => {
          const x = side.find((g) => g.key === k)?.stats;
          return h('div.tl-side', { 'data-side': k }, h('span.tl-label', {}, k === 'long' ? '▲ Longs' : '▼ Shorts'), h('b', { 'data-tone': x ? toneOf(x.avgR) : 'flat' }, x ? fmtR(x.avgR) : '—'), h('small', {}, x ? sub(x) : 'none taken'));
        })))));

    // ---- Every trade ----
    const shown = [...scope].reverse().slice(0, tradesOpen ? 300 : 10);
    const list = panel('Every trade', `${scope.length} in view, newest first${filtered ? ' · faded rows are skipped by your filters' : ''}`,
      h('div.tl-scroll', {}, h('table.tl-table', {},
        h('thead', {}, h('tr', {}, ...['When', 'Market', 'Playbook', 'Side', 'Entry', 'Stop', 'Result', 'Why it was taken'].map((c) => h('th', {}, c)))),
        h('tbody', {}, ...shown.map((t) => h('tr', { 'data-skipped': keptIds.has(t.id) ? undefined : '1' },
          h('th', { scope: 'row' }, `${shortDay(t.day)}${t.ind ? ` ${clock(t.ind.m)}` : ''}`),
          h('td', {}, t.symbol),
          h('td', { class: 'l' }, PLAYBOOK_BY_ID[t.playbook].short),
          h('td', { 'data-tone': t.side === 'long' ? 'up' : 'down' }, t.side === 'long' ? '▲ long' : '▼ short'),
          h('td', {}, t.entry.toFixed(INSTRUMENTS[t.symbol].decimals)),
          h('td', {}, t.stop.toFixed(INSTRUMENTS[t.symbol].decimals)),
          h('td', { 'data-tone': toneOf(t.r) }, fmtR(t.r)),
          h('td', { class: 'l why' }, t.why)))))),
      scope.length > 10 ? h('button.tl-btn', { type: 'button', onclick: () => { tradesOpen = !tradesOpen; render(); } }, tradesOpen ? 'Show fewer' : `Show ${Math.min(300, scope.length)} trades`) : null);

    main.replaceChildren(...[answer, curve, versions, mixes, bench, map, when, list].filter((x): x is HTMLElement => !!x));

    if (how) {
      const outcomes = { win: all.filter((t) => t.outcome === 'win').length, loss: all.filter((t) => t.outcome === 'loss').length, time: all.filter((t) => t.outcome === 'time').length };
      const everything = labStats(all);
      sheet.replaceChildren(howSheet('The Backtest Lab',
        'It answers one question: if you had taken every setup a playbook called over the last month, exactly by its rules, what would have happened? It uses the same code that calls the live proposals, so the two can’t disagree.',
        [
          { title: 'It loads real bars', body: 'About a month of real one-minute bars for NQ, ES, gold and Bitcoin (the most the free feed keeps). Finished days are stored, so each run only fetches what’s new.', fact: `${days.length} trading days · ${days.length ? `${shortDay(days[0]!)} to ${shortDay(days[days.length - 1]!)}` : ''}` },
          { title: 'It replays each day, bar by bar', body: 'Every playbook watches the day unfold one minute at a time, the way you would, with only what was known at that moment: VWAP, the opening range, zones, levels, the volume profile.', fact: `${all.length} trades across ${PLAYBOOKS.length} playbooks` },
          { title: 'It fills and exits the hard way', body: 'In on the signal candle’s close. Out at the stop or the target. If one bar touches both, it counts as the stop. Anything still open is closed flat at 13:00 PT.', fact: `${outcomes.win} hit the target · ${outcomes.loss} stopped · ${outcomes.time} closed flat` },
          { title: 'It counts in R, not dollars', body: 'R is what you risked on the trade. A loss is −1R, a 2-to-1 winner is +2R. That way a trade on gold and a trade on the Nasdaq compare fairly, and you can scale it to any account.', fact: `${fmtR(everything.avgR)} a trade across everything` },
          { title: 'It remembers what the indicators said', body: 'On each entry bar it keeps the EMAs, RSI, ADX, MACD, ATR, both VWAPs and the volume. An indicator filter is then just: skip the trades where that reading was against you. Nothing is re-fitted.', fact: st.filters.length ? `${st.filters.length} on · ${now.trades} of ${base.trades} trades kept` : `${FILTERS.length} indicators to try` },
          { title: 'It checks its own advice', body: 'A filter is only recommended when the trades it keeps do better per trade, it keeps enough of them, and it still helps on the later third of the days, which the choice wasn’t made on. That last check is what stops it recommending luck.', fact: `${[...fx.values()].filter((x) => x.verdict === 'recommended').length} recommended for ${scopeName().toLowerCase()}` },
        ],
        ['A month is a short history. A setup can look good or bad on it by chance: the more filters you stack, the more likely you are fitting the past.', 'No fees and no slippage are taken off. Real fills are a little worse.', 'A filter skips trades after the fact. A playbook that only takes one attempt a day would not have gone on to take a later one instead.', 'It is paper evidence. It can tell you where to look; it can’t promise next month.'],
        () => { how = false; render(); }));
    }
  }

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
    const now = `${!!bt?.running}:${!!bt?.tuner?.running}:${bt?.tuner?.stage ?? ''}`;
    if (now !== was) {
      was = now;
      render();
    }
    void load();
  });
  render();
  void load();
}
