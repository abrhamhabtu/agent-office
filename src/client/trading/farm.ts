import type { BacktestDetail } from '../../shared/trading';
import type { AccountCard, ForwardDecision, ForwardRunView, PayoutRow, PropFarmView, RuleSetView } from '../../shared/propfarm';
import { FARM_CAVEATS, FARM_PROGRAM_BY_ID, strategyLabel } from '../../shared/farm';
import { INSTRUMENTS, PLAYBOOK_BY_ID } from '../../shared/trading';
import { COSTS, FILL_POLICIES } from '../../shared/fills';
import { h, openModal } from '../ui/dom';
import { trading } from './feed';
import { badge, chart, chip, dayLabel, howSheet, money, panel, pct, segmented, shortDay, signedMoney, spark, stat, stored, TONE } from './labkit';
import { mountBattle } from './farm-battle';
import { connectionsSheet, DATA_WORD, dataState } from './farm-connections';
import { drawCompare, drawResearch } from './farm-research';
import './farm.css';

// The Prop Farm console: the Back Office's research and account-operations desk. Six views of one farm:
//
//   Overview   every account, by state: what it has, how far it is from failing, what it may trade, and why
//   Research   the queue of experiments: what each sets out to test, on what data, and what it found
//   Compare    a candidate against its baseline: training, validation, the locked holdout, costs, accounts
//   Forward    runs recording decisions before their outcomes, and the adaptive lane in its shadow
//   Payouts    eligible, requested and received, kept apart, with each rule checked
//   Battle     plan a farm and replay it over the backtest's days before running it forward
//
// Everything in it is paper, or the owner's own bookkeeping. It places no order and buys nothing.

export type TabId = 'overview' | 'research' | 'compare' | 'forward' | 'payouts' | 'battle';
const ACCENT = '#7ee787';
const TABS: { id: TabId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'research', label: 'Research' },
  { id: 'compare', label: 'Compare' },
  { id: 'forward', label: 'Forward' },
  { id: 'payouts', label: 'Payouts' },
  { id: 'battle', label: 'Battle test' },
];

/** What a view of the console is handed: the farm, a way to act on it, and the console's own controls. */
export interface FarmShell {
  view(): PropFarmView | null;
  /** Does one action on the server; says what happened in the footer. True when it worked. */
  act(body: object, ok?: string): Promise<boolean>;
  go(tab: TabId): void;
  redraw(): void;
  /** Slides a sheet over the view (null: closes it). */
  sheet(node: HTMLElement | null): void;
  /** Shows these rule sets, a rule a line, each saying how it is known. */
  showRules(ids: string[], title: string): void;
  /** Shows what the office is connected to, and whether the data is real-time. */
  showConnections(): void;
  detail(): BacktestDetail | null;
  /** What this console remembers while it's open: selections, filters, half-typed forms. */
  ui: Record<string, string | number | boolean | undefined>;
  say(text: string): void;
}

const SOURCE_WORD: Record<AccountCard['source'], string> = { simulated: 'SIMULATED', manual: 'YOURS · BY HAND', connected: 'CONNECTED' };
const HOW: Record<string, string> = { verified: 'Firm’s own page', reported: 'Public summary', assumed: 'Assumed' };
const clock = (ts: number) => new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Los_Angeles' });
const ago = (ts: number) => {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60_000));
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ${m % 60}m ago` : `${Math.floor(m / 1440)}d ago`;
};
/** How long after its bar closed a decision was written down, in words. */
const lag = (ms: number) => {
  const sec = Math.max(0, Math.round(ms / 1000));
  return sec < 120 ? `${sec}s` : sec < 7200 ? `${Math.round(sec / 60)}m` : sec < 172_800 ? `${Math.round(sec / 3600)}h` : `${Math.round(sec / 86_400)}d`;
};
const price = (symbol: keyof typeof INSTRUMENTS, v: number) => v.toFixed(INSTRUMENTS[symbol].decimals);
const field = (label: string, input: HTMLElement) => h('label.pf-field', {}, h('span.tl-label', {}, label), input);

/** One account: what it has, how far it is from failing, what it may trade, and why it is or isn't trading. */
function accountCard(c: AccountCard, open: () => void): HTMLElement {
  const span = Math.max(1, c.target - c.floor);
  const at = Math.max(0, Math.min(1, (c.balance - c.floor) / span));
  const start = Math.max(0, Math.min(1, (c.start - c.floor) / span));
  const lost = c.status === 'breached' || c.status === 'retired';
  return h('button.pf-card', { type: 'button', 'data-state': c.status, 'data-source': c.source, onclick: open, 'aria-label': `${c.label}: ${c.statusWord}` },
    h('span.pf-card-top', {}, h('b', {}, c.label), badge(SOURCE_WORD[c.source], c.source, c.source === 'simulated' ? 'The office’s paper simulation: not a balance at a firm' : c.source === 'manual' ? 'Numbers you typed in: the office can’t see this account' : 'Balance and fills reported by ProjectX')),
    c.runName ? h('span.pf-card-run', { title: c.runName }, c.runName) : null,
    h('span.pf-card-sub', {}, `${c.firm} · ${c.program}`, c.verified ? badge('RULES VERIFIED', 'ok', 'Read on the firm’s own pages') : badge('WHAT-IF RULES', 'warn', 'Not the firm’s own numbers: every result on it is a what-if')),
    h('span.pf-card-money', {}, h('span.pf-balance', {}, money(c.balance)), c.series.length > 1 ? (spark(c.series.map((v) => v - c.start), lost ? TONE.faint : c.balance >= c.start ? TONE.up : TONE.down, 92, 30) as unknown as Node) : null),
    h('span.pf-risk', {},
      h('span.pf-risk-head', {}, h('span', {}, 'Distance to failure'), h('b', { 'data-tone': lost ? 'down' : c.cushion < (c.start - c.floor) * 0.3 ? 'warn' : undefined }, lost ? '—' : money(c.cushion))),
      h('span.fm-bar', {}, h('i', { style: `--at:${(at * 100).toFixed(1)}%` }), h('u', { style: `left:${start * 100}%` })),
      h('span.pf-risk-ends', {}, h('span', {}, `floor ${money(c.floor)}`), h('span', {}, `${c.phase === 'eval' ? 'target' : 'payout at'} ${money(c.target)}`))),
    h('span.pf-kv', {},
      h('span', {}, h('small', {}, 'Today'), h('b', { 'data-tone': c.todayPnl > 0 ? 'up' : c.todayPnl < 0 ? 'down' : 'flat' }, signedMoney(c.todayPnl))),
      h('span', {}, h('small', {}, 'Loss budget today'), h('b', {}, c.todayBudget == null || lost ? '—' : money(c.todayBudget))),
      h('span', { title: 'The most it asks for on a trade, of what the firm allows it now' }, h('small', {}, c.source === 'simulated' ? 'Asks for up to' : 'Firm allows'), h('b', {}, lost ? '—' : c.source === 'simulated' ? `${c.cap} of ${c.allowedMicros} micros` : `${c.allowedMicros} micros`)),
      h('span', {}, h('small', {}, c.phase === 'funded' ? 'Payout days' : 'Trading days'), h('b', {}, c.phase === 'funded' && c.profitDaysNeeded ? `${c.profitDays} of ${c.profitDaysNeeded}` : String(c.tradingDays)))),
    h('span.pf-card-strategy', {}, h('small', {}, c.strategy), c.source === 'simulated' ? h('small', { title: c.version }, `Pinned: ${c.version}`) : null),
    h('span.pf-why', { 'data-on': c.trading ? '1' : undefined }, h('i'), h('span', {}, c.trading ? `Trading · ${c.why}` : c.why)));
}

/** A rule set, a rule a line, each saying how it is known. */
function ruleSheet(r: RuleSetView): HTMLElement {
  return h('div.pf-rules', {},
    h('div.pf-rules-head', {}, h('b', {}, `${r.firm} ${r.program}`), badge(r.phase === 'eval' ? 'EVALUATION' : 'FUNDED', r.phase), r.verified ? badge(`VERIFIED ${r.verifiedOn}`, 'ok') : badge('NOT VERIFIED', 'warn'), badge(r.automation === 'allowed' ? 'AUTOMATION PERMITTED' : r.automation === 'prohibited' ? 'MANUAL ONLY' : 'AUTOMATION UNKNOWN', r.automation === 'allowed' ? 'ok' : 'warn')),
    h('table.tl-table.pf-rule-table', {}, h('tbody', {}, ...r.rows.map((row) => h('tr', {}, h('th', {}, row.label), h('td.l', {}, row.value), h('td', {}, badge(HOW[row.how]!.toUpperCase(), row.how === 'verified' ? 'ok' : row.how === 'reported' ? 'info' : 'warn')))))),
    r.issues.length ? h('ul.pf-issues', {}, ...r.issues.map((i) => h('li', {}, i))) : null,
    r.notes.length ? h('ul.pf-notes', {}, ...r.notes.map((n) => h('li', {}, n))) : null,
    r.sources.length ? h('p.tl-fine', {}, `Cohort ${r.cohort} · sources: `, ...r.sources.flatMap((s, i) => [i ? ', ' : '', h('a', { href: s.url, target: '_blank', rel: 'noreferrer' }, s.label)])) : h('p.tl-fine', {}, `Cohort ${r.cohort} · no firm page was read for this one.`));
}

// ---- Overview ---------------------------------------------------------------------------------------------

function drawOverview(sh: FarmShell, v: PropFarmView): Node[] {
  const t = v.totals;
  const size = (sh.ui.size as string) ?? 'all';
  const source = (sh.ui.source as string) ?? 'all';
  const shown = v.accounts.filter((a) => (size === 'all' || (size === 'other' ? ![25_000, 50_000, 100_000, 150_000].includes(a.size) : a.size === Number(size))) && (source === 'all' || a.source === source));
  const openAccount = (c: AccountCard) => sh.sheet(accountSheet(sh, v, c));
  const cols: { id: string; title: string; sub: string; has: (a: AccountCard) => boolean }[] = [
    { id: 'eval', title: 'Evaluations', sub: 'working toward a pass', has: (a) => a.phase === 'eval' && !['breached', 'retired', 'passed', 'review'].includes(a.status) },
    { id: 'funded', title: 'Funded', sub: 'building a payout', has: (a) => a.phase === 'funded' && !['breached', 'retired', 'parked', 'review'].includes(a.status) },
    { id: 'parked', title: 'Parked', sub: 'payout requested: no trades', has: (a) => a.status === 'parked' },
    { id: 'out', title: 'Out', sub: 'breached, retired or under review', has: (a) => ['breached', 'retired', 'passed', 'review'].includes(a.status) },
  ];
  const tile = (kicker: string, value: string, sub: string, kind: string, tone?: string) => h('div.pf-tile', { 'data-kind': kind }, h('span.tl-kicker', {}, kicker), h('b', { 'data-tone': tone }, value), h('small', {}, sub));
  const money$ = h('div.pf-ledger', {},
    tile('On paper', signedMoney(t.simulatedProfit), 'Profit in simulated accounts. Not cash.', 'paper', t.simulatedProfit > 0 ? 'up' : t.simulatedProfit < 0 ? 'down' : undefined),
    tile('Could be requested', money(t.eligible), 'What the rules would let you ask for now. An estimate.', 'eligible'),
    tile('Requested, waiting', money(t.requested), 'Asked for and not yet reconciled. Those accounts are parked.', 'requested'),
    tile('Cash received', money(t.confirmedReceived), `Confirmed by you. The simulation has “paid” ${money(t.simulatedReceived)} on paper: that is not this.`, 'cash', t.confirmedReceived ? 'up' : undefined),
    tile('Fees', money(t.confirmedFees), `Entered by you. The simulation would have spent ${money(t.simulatedFees)}.`, 'fees', t.confirmedFees ? 'down' : undefined));

  const bar = h('div.pf-filters', {},
    h('div.tl-chips', {}, ...[['all', 'Every size'], ['25000', '25K'], ['50000', '50K'], ['100000', '100K'], ['150000', '150K'], ['other', 'Other']].map(([id, label]) => chip(label!, size === id, () => { sh.ui.size = id; sh.redraw(); }))),
    h('div.tl-chips', {}, ...[['all', 'Every source'], ['simulated', 'Simulated'], ['manual', 'Yours, by hand'], ['connected', 'Connected']].map(([id, label]) => chip(label!, source === id, () => { sh.ui.source = id; sh.redraw(); }))),
    h('span.grow'),
    h('button.tl-btn', { type: 'button', onclick: () => sh.sheet(addAccountSheet(sh, v)) }, '＋ Track one of your accounts'),
    h('button.tl-btn.primary', { type: 'button', onclick: () => sh.go('battle') }, 'Plan a farm'));

  const board = v.accounts.length
    ? h('div.fm-pipe.pf-pipe', {}, ...cols.map((c) => {
        const mine = shown.filter(c.has);
        // A column is as wide as what is in it: three evaluations and nothing funded doesn't leave three quarters of the board empty.
        return h('section.fm-col', { 'data-stage': c.id === 'out' ? 'busted' : c.id, 'data-empty': mine.length ? undefined : '1', style: `--n:${Math.max(1, Math.min(4, mine.length))}` }, h('div.fm-col-head', {}, h('b', {}, c.title), h('span', {}, `${mine.length} · ${c.sub}`)), mine.length ? h('div.pf-col-cards', {}, ...mine.map((a) => accountCard(a, () => openAccount(a)))) : h('p.fm-none', {}, 'None'));
      }))
    : h('div.pf-empty', {},
        h('div.pf-empty-art', {}, '🌾'),
        h('b', {}, 'No accounts on the farm yet'),
        h('p', {}, 'Plan a farm in the battle test and run it forward on paper: the office opens the accounts in a simulation and trades them as the playbooks call their setups. Or add an account you really hold, and keep its ledger here by hand.'),
        h('div.pf-empty-acts', {}, h('button.tl-btn.primary', { type: 'button', onclick: () => sh.go('battle') }, 'Plan a farm'), h('button.tl-btn', { type: 'button', onclick: () => sh.sheet(addAccountSheet(sh, v)) }, '＋ Track one of your accounts')));

  const ready = panel('Between paper and an order', 'Everything that has to be true first. Most of it isn’t, and that is the honest state.',
    h('ul.pf-ready', {}, ...v.readiness.map((r) => h('li', { 'data-state': r.state }, h('i', {}, r.state === 'ready' ? '✓' : r.state === 'blocked' ? '✕' : '·'), h('div', {}, h('b', {}, r.label), h('small', {}, r.detail))))),
    h('table.tl-table.pf-brokers', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Connection'), h('th', {}, 'Data'), h('th', {}, 'Accounts'), h('th', {}, 'Orders'))),
      h('tbody', {}, ...v.brokers.map((b) => h('tr', { title: b.note }, h('th', {}, b.name), ...[b.data, b.accounts, b.orders].map((s) => h('td', {}, badge(s === 'wired' ? 'WIRED' : s === 'sandbox' ? 'PAPER ONLY' : s === 'unverified' ? 'UNVERIFIED' : 'NONE', s === 'wired' ? 'ok' : s === 'none' ? 'dim' : 'warn'))))))));
  const ops = panel('Operations', 'The observer: feeds, the worker, and anything it paused',
    h('div.pf-feeds', {}, ...v.ops.feeds.map((f) => h('div.pf-feed', { 'data-stale': f.stale ? '1' : undefined }, h('b', {}, f.symbol), h('span', {}, f.source), badge(f.stale ? 'QUIET' : f.delayed ? 'DELAYED' : 'REAL-TIME', f.stale ? 'bad' : f.delayed ? 'warn' : 'ok'), h('small', {}, f.ageSec == null ? 'no bars yet' : `newest bar ${f.ageSec < 90 ? `${f.ageSec}s` : `${Math.round(f.ageSec / 60)}m`} old`)))),
    h('div.pf-acts', {}, h('button.tl-btn', { type: 'button', onclick: () => sh.showConnections() }, 'Every connection, and how to get real-time data →')),
    h('p.tl-fine', {}, `Research worker: ${v.ops.worker.busy ? 'working' : 'idle'}. ${v.ops.worker.rest}.`),
    v.ops.notes.length ? h('ul.pf-opsnotes', {}, ...v.ops.notes.slice(0, 6).map((n) => h('li', { 'data-level': n.level }, h('small', {}, ago(n.at)), n.text))) : h('p.tl-fine', {}, 'Nothing paused, nothing missed.'));
  const rules = panel('Rule library', 'Each program, size and phase, with where every number came from',
    h('div.pf-rulelist', {}, ...v.rules.map((r) => h('button.pf-rulerow', { type: 'button', onclick: () => sh.sheet(wrapSheet(sh, `${r.firm} ${r.program}`, 'THE RULES THIS ACCOUNT IS HELD TO', ruleSheet(r))) },
      h('b', {}, `${r.firm} ${r.program}`), badge(r.phase === 'eval' ? 'EVAL' : 'FUNDED', r.phase), r.verified ? badge('VERIFIED', 'ok') : badge('WHAT-IF', 'warn'), r.automation === 'prohibited' ? badge('MANUAL ONLY', 'warn') : null))));
  return [money$, bar, board, h('div.pf-cols3', {}, ready, h('div.tl-stack', {}, ops, rules))];
}

/** A sheet with a heading and a way back. */
export function wrapSheet(sh: FarmShell, title: string, kicker: string, ...body: (Node | null)[]): HTMLElement {
  return h('div.pf-sheet', {}, h('div.tl-how-head', {}, h('div', {}, h('span.tl-kicker', {}, kicker), h('h3', {}, title)), h('button.tl-btn', { type: 'button', onclick: () => sh.sheet(null) }, 'Back')), ...body.filter((b): b is Node => !!b));
}

function addAccountSheet(sh: FarmShell, v: PropFarmView): HTMLElement {
  const rules = h('select.tl-input', { 'aria-label': 'Program, size and phase' }, ...v.rules.map((r) => h('option', { value: r.id, selected: r.id === sh.ui.addRule }, `${r.firm} ${r.program}${r.phase === 'eval' && !/eval/i.test(r.program) ? ' (evaluation)' : ''}${r.verified ? '' : ' · what-if rules'}`))) as HTMLSelectElement;
  const label = h('input.tl-input.wide', { type: 'text', placeholder: 'e.g. Lucid 25K #2', maxlength: '40', 'aria-label': 'A name for it' }) as HTMLInputElement;
  const fee = h('input.tl-input', { type: 'number', min: '0', step: '1', placeholder: '75', 'aria-label': 'What you paid for it' }) as HTMLInputElement;
  const preview = h('div');
  const show = () => {
    sh.ui.addRule = rules.value;
    const r = v.rules.find((x) => x.id === rules.value);
    preview.replaceChildren(r ? ruleSheet(r) : '');
  };
  rules.addEventListener('change', show);
  show();
  return wrapSheet(sh, 'Track one of your accounts', 'KEPT BY HAND',
    h('p.tl-how-lead', {}, 'An account you really hold at a firm. The office can’t see it: you log each day’s result, and the same ledger that runs the simulated accounts checks it against the rules it was bought on. Five accounts on one program are five entries here.'),
    h('div.pf-form', {}, field('Program, size and phase', rules), field('A name for it', label), field('Fee you paid ($)', fee),
      h('button.tl-btn.primary', { type: 'button', onclick: async () => { if (await sh.act({ action: 'account-add', ruleSet: rules.value, label: label.value, ...(fee.value ? { fee: Number(fee.value) } : {}) }, 'Account added')) sh.sheet(null); } }, 'Add the account')),
    preview);
}

function accountSheet(sh: FarmShell, v: PropFarmView, c: AccountCard): HTMLElement {
  const rules = v.rules.find((r) => r.id === c.ruleSet);
  const run = c.run ? v.runs.find((r) => r.id === c.run) : undefined;
  const slot = c.run ? Number(c.id.split(':')[1]) : -1;
  const events = run ? run.run.events.filter((e) => e.slot === slot).slice(-40).reverse() : [];
  const pnl = h('input.tl-input', { type: 'number', step: '1', placeholder: '+250', 'aria-label': 'The day’s result in dollars' }) as HTMLInputElement;
  const trades = h('input.tl-input', { type: 'number', min: '0', step: '1', placeholder: '2', 'aria-label': 'Trades taken' }) as HTMLInputElement;
  const worst = h('input.tl-input', { type: 'number', min: '0', step: '1', placeholder: 'optional', 'aria-label': 'The most it was down during the day' }) as HTMLInputElement;
  const day = h('input.tl-input.wide', { type: 'date', 'aria-label': 'Which day' }) as HTMLInputElement;
  const act = (body: object, ok: string) => async () => { if (await sh.act({ id: c.id, ...body }, ok)) sh.sheet(null); };
  const manual = c.source === 'manual';
  return wrapSheet(sh, c.label, `${SOURCE_WORD[c.source]} · ${c.statusWord.toUpperCase()}`,
    h('div.pf-sheet-grid', {},
      h('div.tl-stack', {},
        h('div.pf-sheet-card', {}, accountCard(c, () => {})),
        manual ? panel('Log a day', 'What the account made or lost, as the firm’s platform shows it',
          h('div.pf-form', {}, field('Day', day), field('Result ($)', pnl), field('Trades', trades), field('Worst it stood ($ down)', worst),
            h('button.tl-btn.primary', { type: 'button', onclick: act({ action: 'account-log', pnl: Number(pnl.value), ...(day.value ? { day: day.value } : {}), ...(trades.value ? { trades: Number(trades.value) } : {}), ...(worst.value ? { worst: Number(worst.value) } : {}) }, 'Day logged') }, 'Log it')),
          h('p.tl-fine', {}, 'The worst it stood matters: an account that touched its floor during the day is breached, whatever it closed at.')) : null,
        manual ? panel('This account', null, h('div.pf-acts', {},
          c.status === 'pass-pending' ? h('button.tl-btn.primary', { type: 'button', onclick: act({ action: 'account-confirm' }, 'Pass confirmed: funded account opened') }, 'The firm confirmed the pass') : null,
          c.status === 'review' ? h('button.tl-btn', { type: 'button', onclick: act({ action: 'account-status', status: 'active' }, 'Cleared') }, 'Clear the review') : h('button.tl-btn', { type: 'button', onclick: act({ action: 'account-status', status: 'review' }, 'Marked for review') }, 'Mark for review'),
          h('button.tl-btn', { type: 'button', onclick: act({ action: 'account-status', status: 'retired' }, 'Retired') }, 'Retire it'),
          h('button.tl-btn', { type: 'button', onclick: act({ action: 'account-status', status: 'removed' }, 'Removed') }, 'Remove from the list')),
          c.phase === 'funded' ? h('button.tl-btn', { type: 'button', onclick: () => { sh.sheet(null); sh.go('payouts'); } }, 'Its payouts →') : null) : null,
        run ? panel('Why this size, why no trade', 'The risk governor’s answer for every setup this account was offered, newest first',
          h('div.fm-feed', {}, ...(events.length ? events.map((e) => h('div.fm-event', { 'data-kind': e.kind }, h('span.fm-event-icon', {}, e.kind === 'trade' ? '📈' : e.kind === 'skip' ? '⏭️' : e.kind === 'busted' ? '💥' : e.kind === 'paid' ? '🏦' : e.kind === 'passed' ? '✅' : e.kind === 'payout-ready' ? '💰' : '🧾'), h('div', {}, h('b', {}, e.kind === 'skip' ? 'NO TRADE' : e.kind === 'payout-ready' ? 'PAYOUT REQUESTED' : e.kind.toUpperCase()), h('p', {}, e.text), e.why ? h('p.pf-because', {}, e.why) : null, h('small', {}, dayLabel(run.run.days[e.day] ?? ''))), e.amount && e.kind === 'trade' ? h('span.fm-event-amt', { 'data-tone': e.amount > 0 ? 'up' : 'down' }, signedMoney(e.amount)) : null)) : [h('p.tl-fine', {}, 'Nothing offered to it yet.')]))) : null),
      h('div.tl-stack', {}, rules ? panel('The rules it is held to', `Rule set ${rules.id}: it keeps these even if the firm’s site changes`, ruleSheet(rules)) : panel('The rules it is held to', null, h('p.tl-fine', {}, `Rule set ${c.ruleSet}, from the older catalog: a public summary, not the firm’s own page.`)))));
}

// ---- Forward ----------------------------------------------------------------------------------------------

function decisionRow(d: ForwardDecision, open: () => void, on: boolean): HTMLElement {
  const o = d.outcome;
  return h('tr', { tabindex: '0', 'data-on': on ? '1' : undefined, onclick: open, onkeydown: (e: Event) => { if ((e as KeyboardEvent).key === 'Enter') open(); } },
    h('th', {}, `${shortDay(d.day)} ${clock(d.signalAt)}`),
    h('td.l', {}, badge(d.kind === 'forward' ? 'FORWARD' : 'LATE', d.kind === 'forward' ? 'ok' : 'dim', d.kind === 'forward' ? 'Written down while the trade was still open' : 'Reconstructed after it had finished: not forward evidence')),
    h('td.l', {}, `${d.side === 'long' ? 'Long' : 'Short'} ${d.symbol} · ${PLAYBOOK_BY_ID[d.playbook].short}`),
    h('td', {}, price(d.symbol, d.entry)), h('td', {}, price(d.symbol, d.stop)), h('td', {}, price(d.symbol, d.target)),
    h('td', { title: 'How long after its bar closed the office wrote it down' }, d.kind === 'late' ? `${lag(d.recordedAt - d.signalAt)} after` : lag(d.recordedAt - d.signalAt)),
    h('td', { 'data-tone': !o ? 'warn' : o.result === 'void' ? 'flat' : o.r > 0 ? 'up' : o.r < 0 ? 'down' : 'flat' }, !o ? 'open' : o.result === 'void' ? 'void' : `${o.r >= 0 ? '+' : '−'}${Math.abs(o.r).toFixed(2)}R${o.ambiguous ? ' ?' : ''}`));
}

function drawForward(sh: FarmShell, v: PropFarmView): (Node | null)[] {
  if (!v.runs.length) {
    return [h('div.pf-empty', {}, h('div.pf-empty-art', {}, '⏱️'), h('b', {}, 'No forward run yet'),
      h('p', {}, 'A backtest asks whether it would have worked. A forward run asks whether it is working: every setup is written down the moment the office sees it, before anyone knows how it came out, and the accounts are played over those decisions. Plan a farm in the battle test, then run it forward.'),
      h('div.pf-empty-acts', {}, h('button.tl-btn.primary', { type: 'button', onclick: () => sh.go('battle') }, 'Plan a farm')))];
  }
  const run = v.runs.find((r) => r.id === sh.ui.run) ?? v.runs[0]!;
  const program = FARM_PROGRAM_BY_ID[run.setup.programId]!;
  const picked = run.decisions.find((d) => d.id === sh.ui.decision);
  const g = run.gate;
  const meter = (label: string, n: number, need: number) => h('div.pf-gate', { 'data-ok': n >= need ? '1' : undefined }, h('span.tl-label', {}, label), h('b', {}, `${n} of ${need}`), h('span.tl-meter', {}, h('i', { style: `width:${Math.min(100, (n / need) * 100)}%` })));
  const hook = h('input.tl-input.fm-hook', { type: 'url', placeholder: 'https://discord.com/api/webhooks/…', 'aria-label': 'Discord webhook address', autocomplete: 'off' }) as HTMLInputElement;
  const cash = run.run.cash;
  const cells = run.run.cells[run.run.cells.length - 1] ?? [];
  const mine = v.accounts.filter((a) => a.run === run.id);
  const head = h('div.tl-hero.pf-run', { 'data-result': run.net > 0 ? 'passed' : run.net < 0 ? 'busted' : 'running' },
    h('div.tl-verdict', {},
      h('div.pf-run-badges', {}, badge(run.feedLabel.toUpperCase(), run.delayed ? 'warn' : 'ok', run.delayed ? 'The bars run behind the exchange: this is a delayed replay, never an exchange-live test' : 'Bars arrive in real time'), badge(run.status === 'running' ? '● RECORDING' : run.status.toUpperCase(), run.status === 'running' ? 'ok' : run.status === 'paused' ? 'bad' : 'dim'), badge('DETERMINISTIC LANE', 'info', 'Exact rules: the same bars always give the same decisions')),
      h('span.tl-kicker', {}, `${program.firm} · ${program.name} · ${run.setup.slots} account${run.setup.slots === 1 ? '' : 's'} · since ${shortDay(run.startDay)}`),
      h('div.tl-verdict-word', { 'data-tone': run.net > 0 ? 'up' : run.net < 0 ? 'down' : 'warn' }, signedMoney(run.net), h('span', {}, 'net on paper: payouts less fees')),
      run.pause ? h('p.pf-pause', {}, `Paused: ${run.pause}`) : h('p', {}, `${run.counts.forward} decision${run.counts.forward === 1 ? '' : 's'} written down before their outcomes${run.counts.late ? `, and ${run.counts.late} reconstructed afterwards, which count for nothing as evidence` : ''}. ${run.counts.open} open now.`),
      h('div.tl-stats', {},
        stat('Taken', String(run.run.taken), { sub: `${run.run.skipped} not taken` }),
        stat('Per trade', `${run.baseline.avgR >= 0 ? '+' : '−'}${Math.abs(run.baseline.avgR).toFixed(2)}R`, { tone: run.baseline.avgR > 0 ? 'up' : run.baseline.avgR < 0 ? 'down' : undefined, sub: `${run.baseline.trades} closed, after costs` }),
        stat('Costs paid', money(run.run.costs), { sub: COSTS[run.setup.cost].name.toLowerCase() }),
        stat('Accounts lost', String(run.run.evalBusts + run.run.fundedBusts), { tone: run.run.evalBusts + run.run.fundedBusts ? 'down' : undefined, sub: `${run.run.passed} passed · ${run.run.payoutCount} paid` }))),
    h('div.tl-odds', {},
      h('span.tl-kicker', {}, 'THE RELEASE GATE'),
      meter('Forward sessions', g.sessions, g.sessionsNeeded), meter('Closed forward trades', g.trades, g.tradesNeeded),
      h('small', {}, g.met ? 'Cleared. That is where a review starts: it is not proof, and nothing is promoted by it.' : 'Planning thresholds before anything is even reviewed for promotion. Only decisions written down before their outcome count.'),
      h('div.pf-pinned', {}, h('span.tl-kicker', {}, 'PINNED FOR THE LIFE OF THE RUN'),
        h('small', {}, `Playbook settings ${run.pinned.tuning}: ${run.pinned.tuningLabel}`), h('small', {}, `Rules ${run.pinned.ruleSets.join(' → ')}`), h('small', {}, `${FILL_POLICIES[run.pinned.fills as 'realistic']?.name ?? run.pinned.fills} fills · ${COSTS[run.pinned.cost].name.toLowerCase()} costs · ${strategyLabel(run.setup.strategy)}`), h('small', {}, 'New settings are a new run. Nothing rewrites this one.'))));

  const tape = panel('The decision tape', 'Each setup as it was written down, newest first. Click one for what every account did with it.',
    run.decisions.length
      ? h('div.tl-scroll.pf-tape', {}, h('table.tl-table', {}, h('thead', {}, h('tr', {}, ...['When (PT)', 'Recorded', 'Setup', 'Entry', 'Stop', 'Target', 'Written down', 'Result'].map((x, i) => h(i < 3 ? 'th.l' : 'th', {}, x)))), h('tbody', {}, ...run.decisions.map((d) => decisionRow(d, () => { sh.ui.decision = sh.ui.decision === d.id ? undefined : d.id; sh.redraw(); }, d.id === picked?.id)))))
      : h('p.tl-fine', {}, 'Waiting for the first setup. Decisions appear here the moment a playbook calls one.'),
    picked ? h('div.pf-picked', {}, h('b', {}, `${picked.side === 'long' ? 'Long' : 'Short'} ${picked.symbol} · ${PLAYBOOK_BY_ID[picked.playbook].name}`), h('p', {}, picked.why), h('small', {}, `Signal bar closed ${clock(picked.signalAt)} PT · written down ${clock(picked.recordedAt)} PT · bars from ${picked.feed}${picked.delayed ? ' (delayed)' : ''} · settings ${picked.tuning}`),
      ...run.run.events.filter((e) => e.trade === picked.id).map((e) => h('div.pf-because-row', { 'data-kind': e.kind }, h('b', {}, e.account || `Slot ${e.slot + 1}`), h('span', {}, e.kind === 'skip' ? 'No trade' : e.text), h('small', {}, e.why ?? ''))),
      !run.run.events.some((e) => e.trade === picked.id) ? h('small', {}, picked.outcome ? 'No account took it: each was done for the day, parked, or not open yet.' : 'Still open: it reaches the accounts’ ledgers when it closes.') : null) : null);

  const s = v.shadow;
  const lane = s ? panel('The adaptive lane, in the shadow', 'A model says take or abstain on every setup. It trades nothing and can change no limit.',
    h('div.pf-lane', {},
      h('div.tl-stats', {}, stat('Asked', String(s.summary.asked)), stat('Took', String(s.summary.taken), { sub: `${s.summary.abstained} abstained` }), stat('Invalid', String(s.summary.invalid), { tone: s.summary.invalid ? 'warn' : undefined, sub: 'counted as abstain' }), stat('Lane vs all', `${s.summary.shadow.avgR.toFixed(2)}R / ${s.summary.baseline.avgR.toFixed(2)}R`, { sub: `${s.summary.shadow.trades} / ${s.summary.baseline.trades} closed` })),
      h('p', {}, s.summary.read),
      h('small', {}, `Model: ${s.summary.model.id} v${s.summary.model.version} (${s.summary.model.kind}). ${s.adapter}`),
      s.recent.length ? h('ul.pf-lane-list', {}, ...s.recent.slice(0, 6).map((r) => h('li', { 'data-action': r.decision.action }, badge(r.decision.action === 'take' ? 'TAKE' : 'ABSTAIN', r.decision.action === 'take' ? 'ok' : 'dim'), h('span', {}, `${r.request.side === 'long' ? 'Long' : 'Short'} ${r.request.symbol} · ${PLAYBOOK_BY_ID[r.request.playbook].short}`), h('small', {}, r.valid ? r.decision.reason : `Invalid: ${r.problems[0] ?? ''}`)))) : null)) : null;

  return [
    v.runs.length > 1 ? h('div.tl-chips', {}, ...v.runs.map((r) => chip(`${r.name}${r.status === 'stopped' ? ' (stopped)' : ''}`, r.id === run.id, () => { sh.ui.run = r.id; sh.ui.decision = undefined; sh.redraw(); }))) : null,
    head,
    h('div.tl-cols', {},
      panel('The accounts', `${mine.length || cells.length} in this run`, h('div.pf-cards', {}, ...(mine.length ? mine.map((a) => accountCard(a, () => sh.sheet(accountSheet(sh, v, a)))) : [h('p.tl-fine', {}, 'Stopped: its accounts are closed.')]))),
      h('div.tl-stack', {},
        panel('Cash in and out', 'Payouts received less fees paid, after each day',
          chart({ height: 260, width: 560, n: cash.length + 1, label: 'Net cash by day', series: [{ values: [0, ...cash], color: ACCENT, width: 3, area: { fill: 'rgba(126,231,135,.08)', to: 'bottom' } }], levels: [{ y: 0, color: TONE.faint, label: 'EVEN', dash: '2 6' }], xLabel: (k) => (k === 0 ? 'Start' : shortDay(run.run.days[k - 1]!)), yFmt: (x) => `${x < 0 ? '−' : ''}$${Math.abs(x) >= 1000 ? `${(Math.abs(x) / 1000).toFixed(1)}k` : Math.abs(x)}`, tip: (k) => (k === 0 ? [h('b', {}, 'Start')] : [h('b', {}, dayLabel(run.run.days[k - 1]!)), h('span', {}, `Net ${signedMoney(cash[k - 1]!)}`)]) })),
        lane)),
    tape,
    panel('This run', null, h('div.pf-acts', {},
      h('span.tl-fine', {}, run.discord ? 'Every fill, pass and payout goes to your Discord channel.' : 'Paste a Discord webhook address and the run posts every fill, pass and payout there.'),
      hook, h('button.tl-btn', { type: 'button', onclick: () => void sh.act({ action: 'run-discord', id: run.id, url: hook.value }, hook.value ? 'Notices on' : 'Notices off') }, 'Save'),
      h('span.grow'),
      run.status !== 'stopped' ? h('button.tl-btn', { type: 'button', onclick: () => void sh.act({ action: 'run-stop', id: run.id }, 'Run stopped') }, 'Stop this run') : h('button.tl-btn', { type: 'button', onclick: () => void sh.act({ action: 'run-remove', id: run.id }, 'Run removed') }, 'Remove it'))),
  ];
}

// ---- Payouts ----------------------------------------------------------------------------------------------

function payoutCard(sh: FarmShell, r: PayoutRow): HTMLElement {
  const amount = h('input.tl-input', { type: 'number', min: '0', step: '1', value: String(r.eligible || ''), 'aria-label': 'Amount to request' }) as HTMLInputElement;
  const got = h('input.tl-input', { type: 'number', min: '0', step: '1', value: String(r.requested ?? ''), 'aria-label': 'What was actually withdrawn' }) as HTMLInputElement;
  const why = h('input.tl-input.wide', { type: 'text', placeholder: 'reason', maxlength: '120', 'aria-label': 'Why it was denied' }) as HTMLInputElement;
  const manual = r.source === 'manual';
  const state = r.status === 'parked' ? 'requested' : r.eligible ? 'eligible' : 'building';
  return h('section.pf-payout', { 'data-state': state },
    h('div.pf-payout-head', {}, h('b', {}, r.label), badge(SOURCE_WORD[r.source], r.source), h('span.grow'), badge(state === 'requested' ? 'REQUESTED · PARKED' : state === 'eligible' ? 'ELIGIBLE' : 'NOT YET', state === 'requested' ? 'warn' : state === 'eligible' ? 'ok' : 'dim')),
    h('small', {}, `${r.firm} · ${r.program}${r.payoutsAllowed ? ` · payout ${Math.min(r.payouts + 1, r.payoutsAllowed)} of ${r.payoutsAllowed}` : ''}`),
    h('ul.pf-checklist', {}, ...r.checks.map((c) => h('li', { 'data-ok': c.ok ? '1' : undefined }, h('i', {}, c.ok ? '✓' : '·'), h('span', {}, c.label), h('small', {}, c.detail)))),
    h('div.pf-payout-nums', {},
      stat('Eligible now', money(r.eligible), { tone: r.eligible ? 'up' : undefined, sub: 'an estimate' }),
      stat('Requested', r.requested == null ? '—' : money(r.requested), { tone: r.requested ? 'warn' : undefined, sub: r.requestedOn ? `on ${shortDay(r.requestedOn)}` : 'not requested' }),
      stat('You’d receive', r.requested != null || r.eligible ? money((r.requested ?? r.eligible) * r.split) : '—', { sub: `${Math.round(r.split * 100)}% is yours` }),
      stat('Received so far', money(r.received), { tone: r.received ? 'up' : undefined, sub: manual ? 'confirmed by you' : 'on paper only' })),
    h('div.pf-after', {}, h('span.tl-label', {}, 'After it is paid'), h('span', {}, `floor ${money(r.floorAfter)}`), h('span', {}, `cushion ${money(r.cushionAfter)}`), h('span', {}, `${r.microsAfter} micros allowed`), h('span', {}, `trades again: ${r.next.toLowerCase()}`)),
    manual
      ? h('div.pf-acts', {},
          state === 'eligible' ? h('span.pf-inline', {}, '$', amount, h('button.tl-btn.primary', { type: 'button', onclick: () => void sh.act({ action: 'payout-request', id: r.account, amount: Number(amount.value) }, 'Requested: the account is parked') }, 'I requested it')) : null,
          state === 'requested' ? h('span.pf-inline', {}, 'Withdrawn $', got, h('button.tl-btn.primary', { type: 'button', onclick: () => void sh.act({ action: 'payout-received', id: r.account, withdrawn: Number(got.value) }, 'Reconciled: back in the rotation') }, 'It arrived')) : null,
          state === 'requested' ? h('span.pf-inline', {}, why, h('button.tl-btn', { type: 'button', onclick: () => void sh.act({ action: 'payout-denied', id: r.account, reason: why.value }, 'Marked denied') }, 'It was denied')) : null,
          state === 'building' ? h('small', {}, 'Nothing to request yet: the conditions above aren’t all met.') : null)
      : h('small', {}, 'A simulated account: the simulation requests and pays it on schedule. Nothing was really requested.'));
}

function drawPayouts(sh: FarmShell, v: PropFarmView): Node[] {
  const t = v.totals;
  const head = h('div.pf-ledger', {},
    h('div.pf-tile', { 'data-kind': 'eligible' }, h('span.tl-kicker', {}, 'Eligible'), h('b', {}, money(t.eligible)), h('small', {}, 'The rules say a request could be made. An estimate, not money.')),
    h('div.pf-tile', { 'data-kind': 'requested' }, h('span.tl-kicker', {}, 'Requested'), h('b', {}, money(t.requested)), h('small', {}, 'Asked for. The account is parked until it is reconciled.')),
    h('div.pf-tile', { 'data-kind': 'cash' }, h('span.tl-kicker', {}, 'Received'), h('b', { 'data-tone': t.confirmedReceived ? 'up' : undefined }, money(t.confirmedReceived)), h('small', {}, 'You said it arrived. Only this is cash.')),
    h('div.pf-tile', { 'data-kind': 'paper' }, h('span.tl-kicker', {}, 'Paid on paper'), h('b', {}, money(t.simulatedReceived)), h('small', {}, 'What the simulation paid its own accounts. Not cash, and never added to the above.')));
  const rows = v.payouts;
  return [
    head,
    rows.length ? h('div.pf-payouts', {}, ...rows.map((r) => payoutCard(sh, r))) : h('div.pf-empty', {}, h('div.pf-empty-art', {}, '🏦'), h('b', {}, 'No funded accounts yet'), h('p', {}, 'When an evaluation is passed and a funded account opens, it appears here with every payout condition checked: the days that count, the profit it needs, what could be requested, and where the floor and the contract limit land afterwards.')),
    panel('The payout ledger', 'Every request, payment and denial, newest first. A winning trade is none of these.',
      v.payoutLog.length
        ? h('div.tl-scroll', {}, h('table.tl-table', {}, h('thead', {}, h('tr', {}, ...['Day', 'Account', 'What', 'Amount', 'Source', 'Note'].map((x, i) => h(i === 3 ? 'th' : 'th.l', {}, x)))),
            h('tbody', {}, ...v.payoutLog.map((e) => h('tr', {}, h('th', {}, shortDay(e.day)), h('td.l', {}, e.account), h('td.l', {}, e.kind === 'paid' ? 'Received' : e.kind === 'requested' ? 'Requested' : 'Denied'), h('td', { 'data-tone': e.kind === 'paid' ? 'up' : e.kind === 'denied' ? 'down' : 'warn' }, money(e.amount)), h('td.l', {}, badge(SOURCE_WORD[e.source], e.source)), h('td.l.why', {}, e.note))))))
        : h('p.tl-fine', {}, 'Nothing requested yet.')),
  ];
}

// ---- The console ------------------------------------------------------------------------------------------

export function openFarm(first?: TabId) {
  const save = stored<{ tab?: TabId }>('agent-office.prop-farm', {});
  let tab: TabId = first ?? save.get().tab ?? 'overview';
  let how = false;
  let note = '';
  let custom: HTMLElement | null = null;
  let detail: BacktestDetail | null = null;
  let loadedFor = '';
  let drawn = '';
  let off = () => {};
  const ui: FarmShell['ui'] = {};

  const tabs = h('div');
  const rail = h('aside.tl-rail.fm-rail');
  const main = h('div.tl-main');
  const sheet = h('div.tl-sheet');
  const status = h('span.grow');
  const close = h('button.btn.close', { type: 'button', 'aria-label': 'Close the Prop Farm', title: 'Close (Esc)' }, '✕');
  // Always in view: whether the data is real-time, and the way to everything the office is connected to.
  const conn = h('button.pf-conn', { type: 'button', title: 'What the office is connected to, and whether the data is real-time', onclick: () => shell.showConnections() }, h('i'), h('span'));
  const body = h('div.tl-body', {}, rail, main, sheet);
  const el = h('div.modal.tl.tl-farm', { role: 'dialog', 'aria-label': 'Prop Farm', style: `--tl-accent:${ACCENT}` },
    h('header.tl-header', {},
      h('div.tl-title', {}, h('span.tl-kicker', {}, 'BACK OFFICE · PAPER ONLY · NO ORDERS'), h('h2', {}, '🌾 Prop Farm')),
      tabs,
      conn,
      h('button.tl-btn', { type: 'button', onclick: () => { how = !how; custom = null; render(true); } }, 'How it works'),
      close),
    body,
    h('footer.tl-footer', {}, status));

  const shell: FarmShell = {
    view: () => trading.snap?.propFarm ?? null,
    async act(b, ok) {
      const why = await trading.farm(b);
      note = why ?? ok ?? '';
      render(true);
      return !why;
    },
    go(t) {
      if (t !== tab) main.scrollTop = 0;
      tab = t;
      how = false;
      custom = null;
      save.set({ tab });
      render(true);
    },
    redraw: () => render(true),
    sheet(node) {
      custom = node;
      how = false;
      render(true);
    },
    showRules(ids, title) {
      const sets = (shell.view()?.rules ?? []).filter((r) => ids.includes(r.id));
      shell.sheet(wrapSheet(shell, title, 'THE RULES AN ACCOUNT ON THIS PROGRAM IS HELD TO', ...(sets.length ? sets.map((r) => h('section.tl-panel', {}, ruleSheet(r))) : [h('p.tl-how-lead', {}, 'This program’s rules come from the older catalog, a public summary rather than the firm’s own pages: there is no rule sheet for it. Treat every result on it as a what-if.')])));
    },
    showConnections() {
      shell.sheet(connectionsSheet(shell.view(), () => shell.sheet(null)));
    },
    detail: () => detail,
    ui,
    say(text) {
      note = text;
      status.textContent = footer();
    },
  };
  const battle = mountBattle(shell, rail, main);
  const modal = openModal(el, { doing: 'running the prop farm', onClose: () => { battle.dispose(); off(); } });
  close.addEventListener('click', () => modal.close());

  const footer = () => {
    const v = shell.view();
    const d = v?.dataset;
    if (trading.offline) return 'The office isn’t answering: this is the last it sent. Trying again every second…';
    return `${d ? `Research data ${d.hash.slice(0, 8)}: ${d.days} days, ${d.trades} trades` : 'Waiting for the backtest'} · everything here is paper or your own bookkeeping${note ? ` · ${note}` : ''}`;
  };

  /** What the open view depends on: it is redrawn when this changes, not on every price tick. */
  const signature = (v: PropFarmView | null): string => {
    if (!v) return 'none';
    if (tab === 'overview') return JSON.stringify([v.accounts.map((a) => [a.id, a.status, a.balance, a.todayPnl, a.allowedMicros, a.trading]), v.totals, v.ops.notes.length, v.ops.feeds.map((f) => [f.stale, f.delayed, f.ageSec == null ? null : Math.round(f.ageSec / 60)]), v.ops.worker.busy]);
    if (tab === 'research' || tab === 'compare') return JSON.stringify([v.jobs.map((j) => [j.id, j.status, j.done]), v.holdout, v.dataset?.hash, v.presets.map((p) => p.cells)]);
    if (tab === 'forward') return JSON.stringify([v.runs.map((r) => [r.id, r.status, r.pause, r.counts, r.net, r.run.events.length]), v.shadow?.summary.asked, v.accounts.map((a) => [a.id, a.balance, a.status])]);
    if (tab === 'payouts') return JSON.stringify([v.payouts.map((p) => [p.account, p.status, p.eligible, p.requested, p.checks.map((c) => c.ok)]), v.payoutLog.length, v.totals]);
    return 'battle';
  };

  function render(force = false) {
    const v = shell.view();
    tabs.replaceChildren(segmented<TabId>(TABS.map((t) => {
      const n = !v ? 0 : t.id === 'overview' ? v.accounts.filter((a) => a.trading).length : t.id === 'research' ? v.jobs.filter((j) => j.status === 'running' || j.status === 'queued').length : t.id === 'forward' ? v.runs.filter((r) => r.status === 'running').length : t.id === 'payouts' ? v.payouts.filter((p) => p.eligible || p.requested).length : 0;
      return { id: t.id, label: n ? `${t.label} · ${n}` : t.label };
    }), tab, (t) => shell.go(t)));
    status.textContent = footer();
    status.toggleAttribute('data-offline', trading.offline);
    const data = dataState(v);
    conn.dataset.kind = DATA_WORD[data].kind;
    conn.lastElementChild!.textContent = DATA_WORD[data].chip;
    el.classList.toggle('tl-how-open', how || !!custom);
    // A sheet takes the whole width, the battle test's rail included.
    el.classList.toggle('pf-sheet-open', how || !!custom);
    el.classList.toggle('pf-wide', tab !== 'battle');
    const sig = `${tab}:${signature(v)}:${how}:${custom ? 1 : 0}`;
    if (tab === 'battle') {
      if (drawn.split(':')[0] !== 'battle' || force) battle.show();
      drawn = sig;
    } else if (force || sig !== drawn) {
      drawn = sig;
      battle.hide();
      if (!v) main.replaceChildren(h('div.tl-waiting', {}, h('span.tl-spin'), h('b', {}, 'Opening the farm…')));
      else {
        const top = main.scrollTop;
        main.replaceChildren(...(tab === 'overview' ? drawOverview(shell, v) : tab === 'research' ? drawResearch(shell, v) : tab === 'compare' ? drawCompare(shell, v) : tab === 'forward' ? drawForward(shell, v) : drawPayouts(shell, v)).filter((n): n is Node => !!n));
        main.scrollTop = top;
      }
    }
    if (custom) sheet.replaceChildren(custom);
    else if (how) sheet.replaceChildren(howIt(() => { how = false; render(true); }));
  }

  // The backtest's trades, for the battle test and the Compare view. Asked for again until they arrive:
  // a request that fails (the office restarting) or comes back empty (its backtest hasn't run yet) is
  // not remembered as the answer, or the battle test would wait for ever on trades the office has.
  let loading = false;
  let askedAt = 0;
  const load = async () => {
    const bt = trading.snap?.backtest;
    const key = `${bt?.ranAt}:${bt?.tuner?.ranAt}`;
    if (!bt || bt.running || key === loadedFor || loading || Date.now() - askedAt < 2500) return;
    loading = true;
    askedAt = Date.now();
    try {
      const got = await trading.backtestDetail();
      if (!got?.trades.length || got.ranAt !== bt.ranAt) return;
      loadedFor = key;
      detail = got;
      battle.data(got);
      render(tab === 'compare');
    } finally {
      loading = false;
    }
  };
  off = trading.on(() => {
    // A sheet with a form in it is left alone while it is open.
    if (!custom) render();
    battle.tick();
    void load();
  });
  render(true);
  void load();
}

function howIt(onClose: () => void): HTMLElement {
  return howSheet('The Prop Farm',
    'A prop account costs a fee, not its drawdown. So the question is never “did this trade win” but “over many accounts and many months, do the payouts that actually arrive come to more than everything spent getting them”. This desk is built to answer that honestly, on paper, before any of it is real.',
    [
      { title: 'The rules are written down, with where they came from', body: 'Each program, size and phase is a rule set: its target, how its floor trails and locks, its contract limit and how that steps, its consistency and payout rules. Every number says whether it was read on the firm’s own page, taken from a summary, or assumed. An account keeps the rule set it was opened on.', fact: 'LucidFlex 25K and 50K: read on the firm’s pages, 2 October 2026' },
      { title: 'Every fill is counted one way', body: 'One fill policy for the whole office: the stop is taken before the target when a bar touches both, a gap through the stop fills at the open, and every fill pays commission and slippage. A result that rests on a guess inside one bar says so.', fact: `${FILL_POLICIES.realistic.what}` },
      { title: 'Each account is a ledger', body: 'An account’s equity is followed through every trade, including how far a trade went against it before it came back, and across trades that overlap. It is breached the moment its equity touches the floor, whatever the trade went on to do.' },
      { title: 'One governor sizes everything', body: 'The size is the smallest of the cap asked for, what the firm still allows, and what the cushion and the day’s allowance can carry. Every trade says which decided, and a setup that can’t fit one micro is skipped with the reason.' },
      { title: 'Research is a queue of bounded jobs', body: 'An experiment states what it is testing and what would count as support before it runs. One worker, resting between runs. Failed and inconclusive results are kept beside the winners.' },
      { title: 'A candidate is judged on days it never saw', body: 'Training days, validation days, and a holdout that is opened once for one chosen candidate. The more variants were tried, the more a candidate has to show, because the best of many tries is mostly luck.' },
      { title: 'Forward runs write the decision down first', body: 'Every setup is recorded when the office sees it, before its outcome. Decisions reconstructed afterwards are kept and marked late: they count for nothing as evidence. On delayed bars it is called a delayed forward replay, never a live test.' },
      { title: 'A payout is cash only when you say it arrived', body: 'Eligible, requested and received are three columns. A parked account takes no trades until its withdrawal is reconciled, and what it looks like afterwards (floor, cushion, contract limit) is worked out before you ask.' },
    ],
    [...FARM_CAVEATS, 'About a month of history. A strategy that happened to fit that month looks better here than it is: that is what the holdout and the forward runs are for.'],
    onClose);
}

export type { ForwardRunView };
export { pct };
