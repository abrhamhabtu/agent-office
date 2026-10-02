import { readFileSync, writeFileSync } from 'node:fs';
import { fingerprint } from '../../shared/validation.js';
import type { JobKind, JobView, JobStatus } from '../../shared/propfarm.js';

// Durable experiment jobs. A job is a bounded list of cells (one cell: one configuration replayed), worked
// through one at a time by a single worker, with a rest between cells so the office stays cool and keeps
// answering. Every finished cell is saved, so a job survives a restart and carries on where it stopped,
// can be cancelled and resumed, and keeps what it found whether that was a winner, a loser or nothing.
//
// A job is pinned to the data it started on (a fingerprint of the dataset) and to a seed, so the same job
// on the same data gives the same answer. Asking for the same job twice while it is waiting or running
// returns the one that's already there.

export interface JobSpec {
  kind: JobKind;
  title: string;
  /** Who does it: the role, not a model. */
  agent: string;
  /** What is being tested, stated so it can turn out false. */
  hypothesis: string;
  /** What would count as support for it, said before the run. */
  criteria: string;
  params: Record<string, unknown>;
  seed: number;
}

export interface Job {
  id: string;
  spec: JobSpec;
  /** The fingerprint of the spec: the same job asked for again. */
  key: string;
  /** The data it runs on. A job whose data changed under it starts over. */
  dataset: string;
  datasetLabel: string;
  status: JobStatus;
  stage: string;
  cursor: number;
  total: number;
  results: unknown[];
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** Time spent computing, in milliseconds: the job's compute cost. */
  cpuMs: number;
  error: string | null;
  /** What it concluded, in a line, and the numbers worth keeping. */
  verdict: string;
  artifacts: { label: string; value: string }[];
}

/** How one kind of job is done. `ctx` is whatever the desk hands in: the dataset. */
export interface Runner<C> {
  /** The cells this job has on this data (bounded by `MAX_CELLS`). */
  cells(spec: JobSpec, ctx: C): unknown[];
  /** Does one cell. May throw: the job fails and keeps what it had. */
  run(spec: JobSpec, cell: unknown, ctx: C): unknown | Promise<unknown>;
  /** What it all came to. */
  conclude(spec: JobSpec, results: unknown[], ctx: C): { verdict: string; artifacts: { label: string; value: string }[] };
}

export interface Dataset<C> {
  hash: string;
  label: string;
  ctx: C;
}

/** No job is bigger than this many cells: an experiment is bounded before it starts. */
export const MAX_CELLS = 400;
/** Finished jobs kept, newest first: the failures and the dead ends stay on the record. */
const KEEP = 60;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class JobQueue<C> {
  private jobs: Job[] = [];
  private working = false;
  private stopped = false;
  /** Rest after each cell, as a multiple of how long the cell took: 1 keeps the worker at half a core. */
  restRatio = 1;
  minRestMs = 5;

  constructor(private file: string | null, private runners: Partial<Record<JobKind, Runner<C>>>, private dataset: () => Dataset<C> | null, private clock: () => number = Date.now) {
    try {
      const raw = JSON.parse(readFileSync(file ?? '', 'utf8')) as Job[];
      if (Array.isArray(raw)) this.jobs = raw.filter((j) => j && typeof j.id === 'string' && j.spec && Array.isArray(j.results));
    } catch {
      // No jobs yet.
    }
    // What was running when the office stopped goes back in the queue and carries on from its last saved cell.
    for (const j of this.jobs) if (j.status === 'running') {
      j.status = 'queued';
      j.stage = 'Resuming after a restart';
    }
  }

  private save() {
    if (!this.file) return;
    try {
      writeFileSync(this.file, JSON.stringify(this.jobs));
    } catch {
      // Kept in memory until the next save.
    }
  }

  list(): Job[] {
    return this.jobs;
  }
  get(id: string): Job | undefined {
    return this.jobs.find((j) => j.id === id);
  }
  /** Whether the worker has a job in hand. Never more than one. */
  get busy() {
    return this.working;
  }

  /** Adds a job, or returns the one already waiting or running for the same spec. A job over the budget is refused. */
  submit(spec: JobSpec): Job | string {
    const runner = this.runners[spec.kind];
    if (!runner) return 'No such kind of job';
    const data = this.dataset();
    if (!data) return 'The backtest hasn’t finished yet: there is no data to run on';
    const key = fingerprint([spec.kind, spec.params, spec.seed]);
    const same = this.jobs.find((j) => j.key === key && j.dataset === data.hash && (j.status === 'queued' || j.status === 'running'));
    if (same) return same;
    let total: number;
    try {
      total = runner.cells(spec, data.ctx).length;
    } catch (e) {
      return (e as Error).message;
    }
    if (!total) return 'There is nothing to run for that';
    if (total > MAX_CELLS) return `That is ${total} runs: the most one job may do is ${MAX_CELLS}. Narrow it down.`;
    const now = this.clock();
    const job: Job = { id: `job-${now.toString(36)}-${key.slice(0, 6)}`, spec, key, dataset: data.hash, datasetLabel: data.label, status: 'queued', stage: 'Waiting for the worker', cursor: 0, total, results: [], createdAt: now, startedAt: null, finishedAt: null, cpuMs: 0, error: null, verdict: '', artifacts: [] };
    this.jobs.unshift(job);
    this.trim();
    this.save();
    void this.work();
    return job;
  }

  /** Stops a job where it is. What it finished is kept, and it can be resumed. */
  cancel(id: string): string | undefined {
    const j = this.get(id);
    if (!j) return 'No such job';
    if (j.status !== 'queued' && j.status !== 'running') return 'That job isn’t running';
    j.status = 'cancelled';
    j.stage = `Stopped at ${j.cursor} of ${j.total}`;
    j.finishedAt = this.clock();
    this.save();
    return undefined;
  }

  /** Puts a stopped or failed job back in the queue, to carry on from its last finished cell. */
  resume(id: string): string | undefined {
    const j = this.get(id);
    if (!j) return 'No such job';
    if (j.status !== 'cancelled' && j.status !== 'failed') return 'Only a stopped or failed job can be resumed';
    j.status = 'queued';
    j.stage = `Resuming from ${j.cursor} of ${j.total}`;
    j.error = null;
    j.finishedAt = null;
    this.save();
    void this.work();
    return undefined;
  }

  remove(id: string): string | undefined {
    const j = this.get(id);
    if (!j) return 'No such job';
    if (j.status === 'running') return 'Stop it first';
    this.jobs = this.jobs.filter((x) => x !== j);
    this.save();
    return undefined;
  }

  private trim() {
    const done = this.jobs.filter((j) => j.status !== 'queued' && j.status !== 'running');
    for (const j of done.slice(KEEP)) this.jobs.splice(this.jobs.indexOf(j), 1);
  }

  /** Stops the worker (the office is shutting down). Jobs stay as they are on disk. */
  stop() {
    this.stopped = true;
  }

  /** Kicks the worker: called when a job is added and whenever the data becomes ready. */
  kick() {
    void this.work();
  }

  /** The single worker: the oldest waiting job, a cell at a time, until none are left. */
  async work(): Promise<void> {
    if (this.working || this.stopped) return;
    this.working = true;
    try {
      for (;;) {
        const job = [...this.jobs].reverse().find((j) => j.status === 'queued');
        if (!job || this.stopped) return;
        const data = this.dataset();
        if (!data) {
          job.stage = 'Waiting for the backtest';
          return;
        }
        await this.runJob(job, data);
      }
    } finally {
      this.working = false;
    }
  }

  private async runJob(job: Job, data: Dataset<C>) {
    const runner = this.runners[job.spec.kind]!;
    // Results belong to the data they were made on: new data means starting over.
    if (job.dataset !== data.hash) {
      job.dataset = data.hash;
      job.datasetLabel = data.label;
      job.cursor = 0;
      job.results = [];
    }
    let cells: unknown[];
    try {
      cells = runner.cells(job.spec, data.ctx);
    } catch (e) {
      return this.fail(job, e);
    }
    job.total = cells.length;
    job.status = 'running';
    job.startedAt ??= this.clock();
    let savedAt = 0;
    while (job.cursor < cells.length) {
      if (this.stopped) return;
      // Cancelled from outside, between cells.
      if ((job.status as JobStatus) !== 'running') return;
      const began = performance.now();
      job.stage = `Run ${job.cursor + 1} of ${cells.length}`;
      try {
        job.results.push(await runner.run(job.spec, cells[job.cursor], data.ctx));
      } catch (e) {
        return this.fail(job, e);
      }
      job.cursor++;
      const took = performance.now() - began;
      job.cpuMs += took;
      if (this.clock() - savedAt > 1500 || job.cursor === cells.length) {
        this.save();
        savedAt = this.clock();
      }
      // The rest between cells: the worker never takes more than its share of a core.
      await sleep(Math.max(this.minRestMs, took * this.restRatio));
    }
    if ((job.status as JobStatus) !== 'running') return;
    try {
      const end = runner.conclude(job.spec, job.results, data.ctx);
      job.verdict = end.verdict;
      job.artifacts = end.artifacts;
      job.status = 'done';
      job.stage = 'Finished';
    } catch (e) {
      return this.fail(job, e);
    }
    job.cpuMs = Math.round(job.cpuMs);
    job.finishedAt = this.clock();
    this.trim();
    this.save();
  }

  private fail(job: Job, e: unknown) {
    job.status = 'failed';
    job.error = (e as Error)?.message?.slice(0, 300) ?? 'Failed';
    job.stage = `Failed at ${job.cursor} of ${job.total}`;
    job.finishedAt = this.clock();
    job.cpuMs = Math.round(job.cpuMs);
    this.save();
  }

  /** A job as the Research Queue shows it (without its results, which are fetched one job at a time). */
  static view(j: Job): JobView {
    return { id: j.id, kind: j.spec.kind, title: j.spec.title, agent: j.spec.agent, hypothesis: j.spec.hypothesis, criteria: j.spec.criteria, dataset: j.datasetLabel, datasetHash: j.dataset, seed: j.spec.seed, status: j.status, stage: j.stage, done: j.cursor, total: j.total, createdAt: j.createdAt, startedAt: j.startedAt, finishedAt: j.finishedAt, cpuMs: Math.round(j.cpuMs), error: j.error, verdict: j.verdict, artifacts: j.artifacts };
  }
}
