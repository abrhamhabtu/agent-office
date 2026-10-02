import type { PaperTrade } from '../../shared/trading';
import { INSTRUMENTS, PLAYBOOK_BY_ID } from '../../shared/trading';
import type { JobDetail, JobView, PropFarmView, SizingResult } from '../../shared/propfarm';
import type { FarmOdds } from '../../shared/farm';
import { FARM_PROGRAM_BY_ID } from '../../shared/farm';
import { COSTS, withCosts, type CostId } from '../../shared/fills';
import { splitDays, VERDICT_WORD, type SliceStats, type ValidationReport } from '../../shared/validation';
import { h } from '../ui/dom';
import { trading } from './feed';
import { badge, chip, fmtR, money, panel, pct, segmented, shortDay, signedMoney, stat, svg, TONE } from './labkit';
import type { FarmShell } from './farm';

// The Research and Compare views of the Prop Farm console. Research is the queue: what each experiment
// sets out to test, who does it, on what data, how far along it is, what it cost to compute, and what it
// found, whether or not that was what anyone hoped. Compare takes one candidate and its baseline and lays
// them side by side on the same days and the same costs, with the holdout kept shut until it is asked for.

const details = new Map<string, JobDetail>();
const asked = new Set<string>();

/** A job's results, fetched once they're wanted and again when the job moves on. */
function detailOf(sh: FarmShell, j: JobView | undefined): JobDetail | null {
  if (!j) return null;
  const key = `${j.id}:${j.status}:${j.done}`;
  if (!asked.has(key)) {
    asked.add(key);
    void trading.farmJob(j.id).then((d) => {
      if (d) {
        details.set(j.id, d);
        sh.redraw();
      }
    });
  }
  return details.get(j.id) ?? null;
}

const STATUS: Record<JobView['status'], { word: string; kind: string }> = { queued: { word: 'WAITING', kind: 'info' }, running: { word: 'RUNNING', kind: 'ok' }, done: { word: 'FINISHED', kind: 'dim' }, failed: { word: 'FAILED', kind: 'bad' }, cancelled: { word: 'STOPPED', kind: 'warn' } };
const cpu = (ms: number) => (ms < 1000 ? `${Math.round(ms)}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);
const when = (ts: number | null) => (ts ? new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '—');
const ROLES: { name: string; does: string; cant: string; busy: (v: PropFarmView) => string }[] = [
  { name: 'Research lead', does: 'States each hypothesis and what would count as support, before it runs', cant: 'Can’t promote its own strategy or touch a broker setting', busy: (v) => `${v.presets.length} experiments on offer` },
  { name: 'Strategy workers', does: 'Run the experiments: sizing, candidates, the adaptive lane', cant: 'Reproducible code on pinned data. No credentials.', busy: (v) => { const j = v.jobs.find((x) => x.status === 'running'); return j ? `On: ${j.title}` : 'Idle'; } },
  { name: 'Skeptic', does: 'Looks for leaks, stresses costs, keeps the holdout shut, reports what failed', cant: 'Works only on locked slices of the days', busy: (v) => `${v.holdout.length} holdout opening${v.holdout.length === 1 ? '' : 's'} on record` },
  { name: 'Risk governor', does: 'Sizes every order and says why', cant: 'Deterministic. No strategy and no model gets round it.', busy: (v) => `${v.accounts.filter((a) => a.trading).length} accounts being sized` },
  { name: 'Account accountant', does: 'Keeps each account’s ledger, fees, payouts and floors', cant: 'Never infers a payout from a winning trade', busy: (v) => `${v.payoutLog.length} payout entries` },
  { name: 'Operations observer', does: 'Watches the feeds, the jobs and missed events', cant: 'Pauses on an unresolved state. Never retries blind.', busy: (v) => (v.ops.notes[0]?.text ?? 'Nothing to report') },
];

function jobRow(sh: FarmShell, j: JobView, open: boolean): HTMLElement {
  const s = STATUS[j.status];
  const live = j.status === 'running' || j.status === 'queued';
  return h('section.pf-job', { 'data-status': j.status, 'data-open': open ? '1' : undefined },
    h('button.pf-job-head', { type: 'button', 'aria-expanded': String(open), onclick: () => { sh.ui.job = open ? undefined : j.id; sh.redraw(); } },
      badge(s.word, s.kind), h('b', {}, j.title), h('span.pf-job-agent', {}, j.agent), h('span.grow'),
      h('span.pf-job-meta', {}, `${j.done} of ${j.total} runs · ${cpu(j.cpuMs)} of compute`)),
    h('div.pf-progress', { 'data-live': j.status === 'running' ? '1' : undefined }, h('i', { style: `width:${j.total ? (j.done / j.total) * 100 : 0}%` })),
    // Closed, a job is its headline and what it found. Open, it is everything: what it set out to test, on what, and its results.
    !open ? (j.verdict || j.error ? h('div.pf-job-line', {}, j.error ? h('span.pf-pause', {}, `Failed: ${j.error}`) : j.verdict) : live ? h('div.pf-job-line', {}, j.stage) : null) : h('div.pf-job-body', {},
      h('p', {}, h('span.tl-label', {}, 'Hypothesis'), j.hypothesis),
      h('p', {}, h('span.tl-label', {}, 'Counts as support only if'), j.criteria),
      h('p.tl-fine', {}, `${j.stage} · data ${j.datasetHash.slice(0, 8)} (${j.dataset}) · seed ${j.seed} · asked ${when(j.createdAt)}${j.finishedAt ? ` · finished ${when(j.finishedAt)}` : ''}`),
      j.error ? h('p.pf-pause', {}, `Failed: ${j.error}. What it had finished is kept.`) : null,
      j.verdict ? h('p.pf-verdict', {}, j.verdict) : null,
      j.artifacts.length ? h('div.pf-artifacts', {}, ...j.artifacts.map((a) => h('span', {}, h('small', {}, a.label), h('b', {}, a.value)))) : null,
      h('div.pf-acts', {},
        live ? h('button.tl-btn', { type: 'button', onclick: () => void sh.act({ action: 'job-cancel', id: j.id }, 'Stopped: what it finished is kept') }, '■ Stop') : null,
        j.status === 'cancelled' || j.status === 'failed' ? h('button.tl-btn', { type: 'button', onclick: () => void sh.act({ action: 'job-resume', id: j.id }, 'Resumed from where it stopped') }, '▶ Resume') : null,
        !live ? h('button.tl-btn', { type: 'button', onclick: () => void sh.act({ action: 'job-remove', id: j.id }, 'Removed') }, 'Remove') : null,
        j.kind === 'validate' && j.done ? h('button.tl-btn', { type: 'button', onclick: () => { sh.ui.compareJob = j.id; sh.go('compare'); } }, 'Open in Compare →') : null)),
    open ? jobResults(sh, j) : null);
}

/** The trade-off: how long to a first payout against how often the account is lost. Each dot is one size. */
function tradeoff(points: { label: string; days: number | null; lost: number; net: number; on?: boolean }[]): HTMLElement {
  const W = 640;
  const H = 300;
  const pad = { l: 56, r: 28, t: 40, b: 40 };
  const ok = points.filter((p) => p.days != null);
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Days to a first payout against the share of accounts lost', class: 'tl-chart-svg' });
  if (!ok.length) return h('p.tl-fine', {}, 'None of these sizes reached a payout in the redraws: there is no trade-off to draw.');
  const maxD = Math.max(20, ...ok.map((p) => p.days!)) * 1.1;
  const maxL = Math.max(0.2, ...ok.map((p) => p.lost)) * 1.15;
  const x = (d: number) => pad.l + (d / maxD) * (W - pad.l - pad.r);
  const y = (l: number) => pad.t + (1 - l / maxL) * (H - pad.t - pad.b);
  for (let i = 0; i <= 4; i++) {
    const l = (maxL * i) / 4;
    root.append(svg('line', { x1: pad.l, x2: W - pad.r, y1: y(l), y2: y(l), stroke: TONE.line }));
    const t = svg('text', { x: pad.l - 8, y: y(l) + 4, 'text-anchor': 'end', class: 'tl-axis' });
    t.textContent = pct(l);
    root.append(t);
    const d = (maxD * i) / 4;
    const tx = svg('text', { x: x(d), y: H - 20, 'text-anchor': 'middle', class: 'tl-axis' });
    tx.textContent = `${Math.round(d)}d`;
    root.append(tx);
  }
  const ax = svg('text', { x: (W + pad.l) / 2, y: H - 4, 'text-anchor': 'middle', class: 'tl-axis' });
  ax.textContent = 'days to a first payout (middle run that got one) →';
  root.append(ax);
  const ay = svg('text', { x: 8, y: 14, class: 'tl-axis' });
  ay.textContent = '↑ accounts lost';
  root.append(ay);
  for (const p of ok) {
    const cx = x(p.days!);
    const cy = y(p.lost);
    const r = 7 + Math.min(11, Math.sqrt(Math.abs(p.net)) / 6);
    const c = svg('circle', { cx, cy, r, fill: p.net >= 0 ? TONE.up : TONE.down, 'fill-opacity': p.on ? 0.95 : 0.4, stroke: p.on ? '#fff' : '#0a0f1c', 'stroke-width': p.on ? 2.5 : 1.5 });
    const tip = svg('title');
    tip.textContent = `${p.label}: ${p.days} days to a first payout, ${pct(p.lost)} of accounts lost, ${signedMoney(p.net)} net on average`;
    c.append(tip);
    root.append(c);
    const t = svg('text', { x: cx, y: cy - r - 5, 'text-anchor': 'middle', class: 'tl-flag', fill: TONE.text });
    t.textContent = p.label;
    root.append(t);
  }
  return h('div.tl-chart', {}, root as unknown as Node, h('p.tl-fine', {}, 'Down and to the left is better: paid sooner, fewer accounts lost. The dot’s size is what it nets; green is ahead, red behind. There is no single best: it is a trade.'));
}

function sizingResults(sh: FarmShell, rs: SizingResult[]): HTMLElement {
  const programs = [...new Set(rs.map((r) => r.program))];
  const strategies = [...new Map(rs.map((r) => [r.strategy, r.strategyName])).entries()];
  const costs = [...new Set(rs.map((r) => r.cost))];
  const program = programs.includes(sh.ui.szProgram as string) ? (sh.ui.szProgram as string) : programs[0]!;
  // Opens on the strategy that did best, since that is the one the sizes matter for.
  const total = (id: string) => rs.filter((r) => r.strategy === id && r.odds?.runs).reduce((a, r) => a + r.odds!.mean, 0);
  const strategy = strategies.some(([id]) => id === sh.ui.szStrategy) ? (sh.ui.szStrategy as string) : [...strategies].sort((a, b) => total(b[0]) - total(a[0]))[0]![0];
  const cost = costs.includes(sh.ui.szCost as CostId) ? (sh.ui.szCost as CostId) : costs[0]!;
  const phase = sh.ui.szPhase === 'funded' ? 'funded' : 'eval';
  const set = (k: string, val: string) => () => { sh.ui[k] = val; sh.redraw(); };
  const rows = rs.filter((r) => r.program === program && r.strategy === strategy && r.cost === cost && r.phase === phase);
  const best = rows.filter((r) => r.odds?.runs).reduce<SizingResult | null>((a, b) => (!a || b.odds!.mean > a.odds!.mean ? b : a), null);
  const capWord = (r: SizingResult) => (r.cap === 'cushion' ? 'Cushion-based' : `${r.cap} micros`);
  const cell = (o: FarmOdds | null, f: (o: FarmOdds) => string, tone?: (o: FarmOdds) => string | undefined) => h('td', { 'data-tone': o ? tone?.(o) : undefined }, o?.runs ? f(o) : '—');
  return h('div.pf-results', {},
    h('div.pf-result-tools', {},
      segmented(programs.map((p) => ({ id: p, label: FARM_PROGRAM_BY_ID[p]?.name ?? p })), program, (p) => set('szProgram', p)()),
      segmented([{ id: 'eval', label: 'Evaluation cap' }, { id: 'funded', label: 'Funded cap' }], phase, (p) => set('szPhase', p)()),
      segmented(costs.map((c) => ({ id: c, label: `${COSTS[c].name} costs` })), cost, (c) => set('szCost', c)())),
    h('div.tl-chips', {}, ...strategies.map(([id, name]) => chip(name, id === strategy, set('szStrategy', id)))),
    h('div.pf-sizing', {},
      h('div.tl-scroll', {}, h('table.tl-table', {},
        h('thead', {}, h('tr', {}, ...['Size', 'Net, average', 'Typical', 'Bad to good', 'Ends ahead', 'Pass rate', 'Accounts lost', 'First payout', 'Cushion after'].map((x) => h('th', {}, x)))),
        h('tbody', {}, ...rows.map((r) => r.refused
          ? h('tr', { 'data-skipped': '1' }, h('th', {}, capWord(r)), h('td.l.why', { colspan: '8' }, `Refused before running: ${r.refused}`))
          : h('tr', { 'data-on': r === best ? '1' : undefined }, h('th', {}, capWord(r), r === best ? h('span.tl-star', {}, ' ★') : null),
              cell(r.odds, (o) => signedMoney(o.mean), (o) => (o.mean > 0 ? 'up' : o.mean < 0 ? 'down' : undefined)), cell(r.odds, (o) => signedMoney(o.p50)), cell(r.odds, (o) => `${signedMoney(o.p10)} … ${signedMoney(o.p90)}`),
              cell(r.odds, (o) => `${pct(o.ahead)} (${pct(o.aheadRange[0])}–${pct(o.aheadRange[1])})`), cell(r.odds, (o) => pct(o.passRate)), cell(r.odds, (o) => pct(o.breachRate), (o) => (o.breachRate > 0.5 ? 'down' : undefined)),
              cell(r.odds, (o) => (o.daysToPayout == null ? 'never' : `${o.daysToPayout}d · ${pct(o.payoutRate)} of runs`)), cell(r.odds, (o) => (o.cushionAfterPayout == null ? '—' : money(o.cushionAfterPayout)))))))),
      tradeoff(rows.filter((r) => r.odds?.runs).map((r) => ({ label: r.cap === 'cushion' ? 'cushion' : String(r.cap), days: r.odds!.daysToPayout, lost: r.odds!.breachRate, net: r.odds!.mean, on: r === best })))),
    h('p.tl-fine', {}, `Each row: 120 redraws of the real days (in runs of two days, so what carries overnight is kept), 60 trading days each, one account at a time, the other stage at its baseline (${phase === 'eval' ? '3 micros funded' : '5 micros in the evaluation'}). The range after “ends ahead” is how far that share could really be from what 120 redraws show. ${rows[0]?.odds ? `Drawn from ${rows[0].odds.sampleDays} real days and ${rows[0].odds.sampleTrades} trades: a small sample, so read the ranking as a lead, not a forecast.` : ''}`));
}

function jobResults(sh: FarmShell, j: JobView): HTMLElement {
  const d = detailOf(sh, j);
  if (!d) return h('div.pf-results', {}, h('p.tl-fine', {}, j.done ? 'Fetching the results…' : 'No results yet.'));
  if (d.sizing?.length) return sizingResults(sh, d.sizing);
  if (d.reports?.length) return h('div.pf-results', {}, h('div.pf-reports', {}, ...d.reports.map((r) => reportCard(r, () => { sh.ui.compareJob = j.id; sh.ui.candidate = r.candidate.id; sh.go('compare'); }))));
  if (d.shadow) {
    const s = d.shadow.summary;
    return h('div.pf-results', {},
      h('div.tl-stats', {}, stat('Asked about', String(s.asked)), stat('Took', String(s.taken), { sub: `${s.abstained} abstained` }), stat('Lane, per trade', fmtR(s.shadow.avgR), { tone: s.shadow.avgR > 0 ? 'up' : 'down', sub: `${s.shadow.trades} taken` }), stat('Everything, per trade', fmtR(s.baseline.avgR), { sub: `${s.baseline.trades} setups` })),
      h('p', {}, s.read),
      h('p.tl-fine', {}, `What it left alone made ${fmtR(s.skipped.avgR)} a trade over ${s.skipped.trades}. A statistical model with no memory can be replayed on history like this; an agent can’t, and never is.`));
  }
  return h('div.pf-results', {}, h('p.tl-fine', {}, 'No results yet.'));
}

const VERDICT_KIND: Record<ValidationReport['verdict'], string> = { promising: 'ok', held: 'ok', inconclusive: 'warn', rejected: 'bad', 'failed-holdout': 'bad', leaky: 'bad' };

function reportCard(r: ValidationReport, open: () => void): HTMLElement {
  return h('button.pf-report', { type: 'button', 'data-verdict': r.verdict, onclick: open },
    h('span.pf-report-top', {}, h('b', {}, r.candidate.name), badge(VERDICT_WORD[r.verdict].split(':')[0]!.toUpperCase(), VERDICT_KIND[r.verdict])),
    h('small', {}, `against ${r.baseline.name} · ${r.searchCount} variant${r.searchCount === 1 ? '' : 's'} tried`),
    h('span.pf-report-nums', {}, h('span', {}, 'Validation'), h('b', { 'data-tone': r.validation.cand.avgR > r.validation.base.avgR ? 'up' : 'down' }, `${fmtR(r.validation.cand.avgR)} vs ${fmtR(r.validation.base.avgR)}`)),
    h('small', {}, r.reasons[0] ?? ''));
}

export function drawResearch(sh: FarmShell, v: PropFarmView): Node[] {
  const d = v.dataset;
  const busy = v.jobs.some((j) => j.status === 'running' || j.status === 'queued');
  const banner = h('div.pf-banner', {},
    h('div', {}, h('span.tl-kicker', {}, 'THE DATA RESEARCH RUNS ON'), h('b', {}, d ? `Fingerprint ${d.hash.slice(0, 8)}` : 'Waiting for the backtest'), h('small', {}, d ? d.label : 'The backtest replays about a month of real one-minute bars. Experiments can start the moment it finishes.')),
    h('div', {}, h('span.tl-kicker', {}, 'COMPUTE'), h('b', {}, v.ops.worker.busy ? 'One worker, working' : 'One worker, idle'), h('small', {}, v.ops.worker.rest)),
    h('div', {}, h('span.tl-kicker', {}, 'THE RECORD'), h('b', {}, `${v.jobs.length} job${v.jobs.length === 1 ? '' : 's'} kept`), h('small', {}, `${v.jobs.filter((j) => j.status === 'failed' || j.status === 'cancelled').length} failed or stopped, kept with the rest. ${cpu(v.jobs.reduce((a, j) => a + j.cpuMs, 0))} of compute in all.`)));
  const launch = panel('Launch an experiment', 'Each one says what it is testing and what would count as support, before it runs',
    h('div.pf-presets', {}, ...v.presets.map((p) => h('div.pf-preset', {},
      h('span.tl-kicker', {}, p.agent), h('b', {}, p.title), h('p', {}, p.hypothesis), h('small', {}, p.what),
      h('div.pf-preset-foot', {}, h('span', {}, p.cells ? `${p.cells} run${p.cells === 1 ? '' : 's'}` : 'Nothing to run yet'), h('button.tl-btn.primary', { type: 'button', disabled: !d || !p.cells, onclick: () => void sh.act({ action: 'job-start', preset: p.id }, 'In the queue') }, busy ? 'Queue it' : 'Run it'))))));
  const queue = panel('The queue', 'Newest first. Finished jobs stay: the failures and the dead ends are results too.',
    v.jobs.length ? h('div.pf-jobs', {}, ...v.jobs.map((j) => jobRow(sh, j, sh.ui.job === j.id))) : h('p.tl-fine', {}, 'Nothing has been run yet. Start with the sizing experiment: it answers the 3-to-5 funded and up-to-20 evaluation question on your own trades.'));
  const roles = panel('Who does what', 'Roles, and what each is not allowed to do', h('div.pf-roles', {}, ...ROLES.map((r) => h('div.pf-role', {}, h('b', {}, r.name), h('p', {}, r.does), h('small', {}, r.cant), h('span.pf-role-now', {}, r.busy(v))))));
  return [banner, launch, queue, roles];
}

// ---- Compare --------------------------------------------------------------------------------------------

function sliceCol(title: string, sub: string, pair: { base: SliceStats; cand: SliceStats } | null, locked?: HTMLElement): HTMLElement {
  const row = (label: string, f: (s: SliceStats) => string, better?: (c: SliceStats, b: SliceStats) => boolean) => h('tr', {}, h('th', {}, label), h('td', {}, pair ? f(pair.base) : '—'), h('td', { 'data-tone': pair && better ? (better(pair.cand, pair.base) ? 'up' : 'down') : undefined }, pair ? f(pair.cand) : '—'));
  return h('section.pf-slice', { 'data-locked': pair ? undefined : '1' },
    h('div.pf-slice-head', {}, h('b', {}, title), h('small', {}, sub)),
    pair
      ? h('table.tl-table', {}, h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'Baseline'), h('th', {}, 'Candidate'))),
          h('tbody', {}, row('Trades', (s) => String(s.trades)), row('Win rate', (s) => pct(s.winRate), (c, b) => c.winRate >= b.winRate), row('Per trade', (s) => fmtR(s.avgR), (c, b) => c.avgR > b.avgR), row('Total', (s) => fmtR(s.totalR, 1), (c, b) => c.totalR > b.totalR), row('Worst dip', (s) => `${s.maxDrawdownR.toFixed(1)}R`, (c, b) => c.maxDrawdownR <= b.maxDrawdownR), row('One micro', (s) => signedMoney(s.dollars), (c, b) => c.dollars > b.dollars)))
      : h('div.pf-locked', {}, h('div.pf-lock', {}, '🔒'), locked ?? null));
}

export function drawCompare(sh: FarmShell, v: PropFarmView): (Node | null)[] {
  const jobs = v.jobs.filter((j) => j.kind === 'validate' && j.done > 0);
  if (!jobs.length) {
    return [h('div.pf-empty', {}, h('div.pf-empty-art', {}, '⚖️'), h('b', {}, 'Nothing to compare yet'),
      h('p', {}, 'Run the candidates experiment in Research. It takes every candidate version the tuner has made and every mix the lab has ranked, and sets each against the live playbook it would replace, on days it wasn’t picked on.'),
      h('div.pf-empty-acts', {}, h('button.tl-btn.primary', { type: 'button', disabled: !v.dataset, onclick: () => void sh.act({ action: 'job-start', preset: 'validate' }, 'In the queue').then(() => sh.go('research')) }, 'Run the candidates experiment')))];
  }
  // Every candidate's newest report: a holdout job's report replaces the earlier one for its candidate.
  const reports = new Map<string, { r: ValidationReport; job: JobView }>();
  for (const j of [...jobs].reverse()) for (const r of detailOf(sh, j)?.reports ?? []) reports.set(r.candidate.id, { r, job: j });
  if (!reports.size) return [h('div.tl-waiting', {}, h('span.tl-spin'), h('b', {}, 'Fetching the reports…'))];
  const list = [...reports.values()];
  const picked = list.find((x) => x.r.candidate.id === sh.ui.candidate) ?? list[0]!;
  const r = picked.r;
  const opened = v.holdout.filter((x) => x.candidate === r.candidate.id);
  const familyOpened = v.holdout.filter((x) => x.family === r.candidate.family);
  const good = r.verdict === 'promising' || r.verdict === 'held';
  const maxZ = Math.max(r.hurdle * 1.4, Math.abs(r.z) * 1.15, 2);
  const lockNote = h('div', {},
    h('p', {}, opened.length ? `Opened ${opened.length} time${opened.length === 1 ? '' : 's'}: ${opened[0]!.verdict}. The result is frozen.` : r.verdict === 'leaky' ? 'A candidate that leaks never gets its look at the holdout.' : `The last ${r.split.holdout} days (from ${shortDay(r.split.holdoutFrom)}). Nothing has been judged on them.`),
    !opened.length && r.verdict !== 'leaky' ? h('button.tl-btn', { type: 'button', onclick: () => void sh.act({ action: 'holdout-open', candidate: r.candidate.id }, 'Opening the holdout for this candidate') }, 'Open the holdout for this candidate (once)') : null,
    familyOpened.length > opened.length ? h('small', {}, `This family’s holdout has been opened ${familyOpened.length - opened.length} time${familyOpened.length - opened.length === 1 ? '' : 's'} for other candidates: it is already less than untouched.`) : h('small', {}, 'Open it for the one candidate you would actually trade. Every opening is counted: a period looked at again and again proves nothing.'));

  // The trades behind it, on the validation days: what the candidate took that the baseline didn't, and the reverse.
  const detail = sh.detail();
  const split = detail ? splitDays(detail.days.filter((d) => { const w = new Date(`${d}T12:00:00Z`).getUTCDay(); return w >= 1 && w <= 5; })) : null;
  const tradesOf = (id: string): PaperTrade[] => {
    if (!detail) return [];
    const m = /^pb:([a-z-]+)(?:@v(\d+))?$/.exec(id);
    if (!m) return [];
    const list = m[2] ? detail.versions?.find((x) => x.playbook === m[1] && x.version === Number(m[2]))?.trades ?? [] : detail.trades.filter((t) => t.playbook === m[1]);
    return list.filter((t) => t.symbol !== 'BTC' && t.outcome !== 'open');
  };
  const scope = (sh.ui.drill as string) ?? 'validation';
  const days = new Set(split ? (scope === 'train' ? split.train : split.validation) : []);
  const net = (ts: PaperTrade[]) => withCosts(ts.filter((t) => days.has(t.day)), COSTS[r.cost]).sort((a, b) => a.entryAt - b.entryAt);
  const cand = net(tradesOf(r.candidate.id));
  const base = net(tradesOf(r.baseline.id));
  const key = (t: PaperTrade) => `${t.day}:${t.symbol}:${Math.round(t.entryAt / 300_000)}`;
  const baseKeys = new Set(base.map(key));
  const candKeys = new Set(cand.map(key));
  const which = (sh.ui.drillSet as string) ?? 'new';
  const drill = which === 'new' ? cand.filter((t) => !baseKeys.has(key(t))) : which === 'dropped' ? base.filter((t) => !candKeys.has(key(t))) : cand;
  const tradeRow = (t: PaperTrade) => h('tr', {}, h('th', {}, `${shortDay(t.day)} ${new Date(t.entryAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Los_Angeles' })}`), h('td.l', {}, `${t.side === 'long' ? 'Long' : 'Short'} ${INSTRUMENTS[t.symbol].micro}`), h('td', {}, String(t.entry)), h('td', {}, String(t.stop)), h('td', {}, String(t.target)), h('td', { 'data-tone': t.r > 0 ? 'up' : t.r < 0 ? 'down' : 'flat' }, fmtR(t.r)), h('td.l', {}, t.ambiguous ? badge('GUESS IN A BAR', 'warn', 'One bar touched both the stop and the target: counted as the stop') : t.gapped ? badge('GAPPED', 'warn', 'A bar opened past the stop: filled worse than the stop') : ''), h('td.l.why', {}, t.why));

  const acct = r.account;
  const acctRow = (label: string, f: (o: FarmOdds) => string, better?: (c: FarmOdds, b: FarmOdds) => boolean) => h('tr', {}, h('th', {}, label), h('td', {}, acct ? f(acct.base) : '—'), h('td', { 'data-tone': acct && better ? (better(acct.cand, acct.base) ? 'up' : 'down') : undefined }, acct ? f(acct.cand) : '—'));
  const maxStress = Math.max(0.05, ...r.stress.flatMap((s) => [Math.abs(s.base), Math.abs(s.cand)]));
  return [
    h('div.tl-chips', {}, ...list.map((x) => chip(h('span', {}, x.r.candidate.name, ' ', h('em.pf-chip-verdict', { 'data-kind': VERDICT_KIND[x.r.verdict] }, VERDICT_WORD[x.r.verdict].split(':')[0]!)), x.r.candidate.id === r.candidate.id, () => { sh.ui.candidate = x.r.candidate.id; sh.redraw(); }, { color: PLAYBOOK_BY_ID[x.r.candidate.family as keyof typeof PLAYBOOK_BY_ID]?.color }))),
    h('div.tl-hero.pf-verdict-hero', { 'data-result': good ? 'passed' : r.verdict === 'inconclusive' ? 'running' : 'busted' },
      h('div.tl-verdict', {},
        h('span.tl-kicker', {}, `${r.candidate.name} AGAINST ${r.baseline.name}`.toUpperCase()),
        h('div.tl-verdict-word', { 'data-size': 'm', 'data-tone': good ? 'up' : r.verdict === 'inconclusive' ? 'warn' : 'down' }, VERDICT_WORD[r.verdict].split(':')[0]!),
        h('ul.pf-reasons', {}, ...r.reasons.map((x) => h('li', {}, x))),
        h('p.tl-fine', {}, `Same days, same ${COSTS[r.cost].name.toLowerCase()} costs, same fills. Report ${r.id.slice(0, 8)} on data ${r.dataset.slice(0, 8)}: the same inputs give the same report.`)),
      h('div.tl-odds', {},
        h('span.tl-kicker', {}, 'THE EDGE AGAINST LUCK'),
        h('div.pf-hurdle', {}, h('span.pf-hurdle-track', {}, h('i', { 'data-ok': r.z >= r.hurdle ? '1' : undefined, style: `width:${Math.max(0, Math.min(100, (r.z / maxZ) * 100))}%` }), h('u', { style: `left:${(r.hurdle / maxZ) * 100}%` })),
          h('div.pf-hurdle-ends', {}, h('span', {}, `edge: ${r.z} noise-widths`), h('span', {}, `hurdle: ${r.hurdle}`))),
        h('small', {}, `${r.searchCount} variant${r.searchCount === 1 ? ' was' : 's were'} tried in this family. The best of that many tries on pure noise would show about ${r.hurdle} noise-widths, so that is what a real edge has to clear. This is the candidate’s gap over the baseline on the validation days, measured against the scatter of its trades.`))),
    h('div.pf-slices', {},
      sliceCol('Training', `${r.split.train} days: where ideas come from`, r.train),
      sliceCol('Validation', `${r.split.validation} days: where it is judged`, r.validation),
      sliceCol('Holdout', `${r.split.holdout} days: quarantined`, r.holdout, lockNote)),
    h('div.tl-cols', {},
      panel('Under each cost setting', 'Per trade, on the training and validation days together',
        h('div.pf-stress', {}, ...r.stress.map((s) => h('div.pf-stress-row', {}, h('span', {}, COSTS[s.cost].name), h('div.pf-stress-bars', {},
          h('i', { 'data-k': 'base', style: `width:${(Math.abs(s.base) / maxStress) * 100}%`, 'data-neg': s.base < 0 ? '1' : undefined }), h('i', { 'data-k': 'cand', style: `width:${(Math.abs(s.cand) / maxStress) * 100}%`, 'data-neg': s.cand < 0 ? '1' : undefined })),
          h('small', {}, `${fmtR(s.base)} → `, h('b', { 'data-tone': s.cand > 0 ? 'up' : 'down' }, fmtR(s.cand)))))),
        h('p.tl-fine', {}, `The upper bar is the baseline, the lower the candidate; red is a loss. Stressed: ${COSTS.stressed.what.replace(/:.*$/, '')}. An edge that vanishes there was never bigger than its costs.`)),
      panel('What a farm of each would have done', acct ? `LucidFlex 25K, one account, 60 days, ${acct.cand.runs} redraws in blocks of three days` : 'Not run',
        h('table.tl-table', {}, h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'Baseline'), h('th', {}, 'Candidate'))), h('tbody', {},
          acctRow('Net, average', (o) => signedMoney(o.mean), (c, b) => c.mean > b.mean), acctRow('Ends ahead', (o) => `${pct(o.ahead)} (${pct(o.aheadRange[0])}–${pct(o.aheadRange[1])})`, (c, b) => c.ahead >= b.ahead), acctRow('Evaluations passed', (o) => pct(o.passRate), (c, b) => c.passRate >= b.passRate),
          acctRow('Accounts lost', (o) => pct(o.breachRate), (c, b) => c.breachRate <= b.breachRate), acctRow('First payout', (o) => (o.daysToPayout == null ? 'never' : `day ${o.daysToPayout}, in ${pct(o.payoutRate)} of runs`)), acctRow('Worst losing streak', (o) => money(o.worstStreak), (c, b) => c.worstStreak >= b.worstStreak))),
        h('p.tl-fine', {}, 'Conditional scenarios on paper: how these trades would have played through the firm’s rules if the days had come in another order. Not a promised pass rate.'))),
    panel('The trades behind it', detail ? `On the ${scope === 'train' ? 'training' : 'validation'} days, after ${COSTS[r.cost].name.toLowerCase()} costs` : 'Loading the backtest’s trades…',
      h('div.pf-result-tools', {},
        segmented([{ id: 'validation', label: 'Validation days' }, { id: 'train', label: 'Training days' }], scope, (x) => { sh.ui.drill = x; sh.redraw(); }),
        segmented([{ id: 'new', label: `Only the candidate took · ${cand.filter((t) => !baseKeys.has(key(t))).length}` }, { id: 'dropped', label: `Only the baseline took · ${base.filter((t) => !candKeys.has(key(t))).length}` }, { id: 'all', label: `All the candidate’s · ${cand.length}` }], which, (x) => { sh.ui.drillSet = x; sh.redraw(); })),
      r.candidate.id.startsWith('mix:') ? h('p.tl-fine', {}, 'A mix takes a subset of the playbooks’ own trades by rule: its entries are in the Backtest Lab under the game plan.') : drill.length
        ? h('div.tl-scroll', {}, h('table.tl-table', {}, h('thead', {}, h('tr', {}, ...['When (PT)', 'Trade', 'Entry', 'Stop', 'Target', 'Result', '', 'Why the playbook called it'].map((x) => h('th', {}, x)))), h('tbody', {}, ...drill.slice(0, 80).map(tradeRow))))
        : h('p.tl-fine', {}, detail ? 'None: on these days the two took the same trades.' : '')),
    v.holdout.length ? panel('Every opening of a holdout', 'Once is a test. More than once is not.', h('table.tl-table', {}, h('tbody', {}, ...v.holdout.map((x) => h('tr', {}, h('th', {}, v.strategies.find((s) => s.id === x.candidate)?.name ?? x.candidate), h('td.l', {}, x.family), h('td.l', {}, x.verdict), h('td', {}, when(x.at))))))) : null,
  ];
}
