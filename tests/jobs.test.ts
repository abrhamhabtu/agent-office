import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JobQueue, MAX_CELLS, type Dataset, type JobSpec, type Runner } from '../src/server/trading/jobs.ts';

interface Ctx {
  n: number;
}
const spec = (o: Partial<JobSpec> = {}): JobSpec => ({ kind: 'sizing', title: 'Count', agent: 'worker', hypothesis: 'h', criteria: 'c', params: { cells: 5 }, seed: 1, ...o });
const data = (hash = 'd1'): Dataset<Ctx> => ({ hash, label: 'test data', ctx: { n: 1 } });
/** A runner that squares its cell, and can be told to fail on one or to wait on a gate. */
function runner(o: { failAt?: number; gate?: () => Promise<void>; seen?: number[]; active?: { now: number; max: number } } = {}): Runner<Ctx> {
  return {
    cells: (s) => Array.from({ length: s.params.cells as number }, (_, i) => i),
    async run(s, cell) {
      const i = cell as number;
      if (o.active) o.active.max = Math.max(o.active.max, ++o.active.now);
      o.seen?.push(i);
      await o.gate?.();
      if (o.active) o.active.now--;
      if (o.failAt === i) throw new Error('boom');
      return i * i + s.seed;
    },
    conclude: (_s, results) => ({ verdict: `sum ${(results as number[]).reduce((a, b) => a + b, 0)}`, artifacts: [{ label: 'runs', value: String(results.length) }] }),
  };
}
const queue = (r: Runner<Ctx>, file: string | null = null, ds: () => Dataset<Ctx> | null = () => data()) => {
  const q = new JobQueue<Ctx>(file, { sizing: r }, ds);
  q.minRestMs = 0;
  q.restRatio = 0;
  return q;
};
const settle = async (q: JobQueue<Ctx>) => {
  for (let i = 0; i < 400 && (q.busy || q.list().some((j) => j.status === 'queued' || j.status === 'running')); i++) await new Promise((r) => setTimeout(r, 5));
};

test('a job runs every cell once, keeps what it found, and says what it came to', async () => {
  const q = queue(runner());
  const job = q.submit(spec());
  assert.equal(typeof job, 'object');
  await settle(q);
  const j = q.list()[0]!;
  assert.deepEqual([j.status, j.cursor, j.total, j.results, j.verdict], ['done', 5, 5, [1, 2, 5, 10, 17], 'sum 35']);
  assert.deepEqual(j.artifacts, [{ label: 'runs', value: '5' }]);
  assert.ok(j.startedAt != null && j.finishedAt != null && j.cpuMs >= 0);
  const v = JobQueue.view(j);
  assert.deepEqual([v.done, v.total, v.dataset, v.datasetHash, v.seed], [5, 5, 'test data', 'd1', 1]);
});

test('the same seed and data give the same results; another seed gives others', async () => {
  const a = queue(runner());
  a.submit(spec());
  await settle(a);
  const b = queue(runner());
  b.submit(spec());
  await settle(b);
  assert.deepEqual(a.list()[0]!.results, b.list()[0]!.results);
  const c = queue(runner());
  c.submit(spec({ seed: 2 }));
  await settle(c);
  assert.notDeepEqual(c.list()[0]!.results, a.list()[0]!.results);
});

test('asking for the same job twice returns the one already there; a job over the budget is refused', async () => {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const q = queue(runner({ gate: () => gate }));
  const first = q.submit(spec());
  const again = q.submit(spec());
  assert.equal(first, again);
  assert.equal(q.list().length, 1);
  // Different settings are a different job.
  assert.notEqual(q.submit(spec({ params: { cells: 3 } })), first);
  assert.match(q.submit(spec({ params: { cells: MAX_CELLS + 1 } })) as string, /the most one job may do is 400/);
  assert.equal(q.submit(spec({ params: { cells: 0 } })), 'There is nothing to run for that');
  assert.equal(q.submit(spec({ kind: 'shadow' })), 'No such kind of job');
  open();
  await settle(q);
  // Finished, the same job can be asked for again: it is a new run.
  assert.notEqual(q.submit(spec()), first);
  await settle(q);
});

test('one worker: two jobs never run at the same moment', async () => {
  const active = { now: 0, max: 0 };
  const q = queue(runner({ active, gate: () => new Promise((r) => setTimeout(r, 2)) }));
  q.submit(spec({ params: { cells: 4 } }));
  q.submit(spec({ params: { cells: 3 } }));
  q.submit(spec({ params: { cells: 2 } }));
  await settle(q);
  assert.equal(active.max, 1);
  assert.deepEqual(q.list().map((j) => j.status), ['done', 'done', 'done']);
  // Oldest first.
  assert.ok(q.list()[2]!.finishedAt! <= q.list()[1]!.finishedAt! && q.list()[1]!.finishedAt! <= q.list()[0]!.finishedAt!);
});

test('a job that fails keeps what it had finished, and can be resumed from there', async () => {
  const seen: number[] = [];
  let failAt: number | undefined = 3;
  const r = runner({ seen });
  const q = queue({ ...r, run: (s, cell, ctx) => { if (cell === failAt) { seen.push(cell as number); throw new Error('boom'); } return r.run(s, cell, ctx); } });
  q.submit(spec());
  await settle(q);
  const j = q.list()[0]!;
  assert.deepEqual([j.status, j.cursor, j.error, j.results], ['failed', 3, 'boom', [1, 2, 5]]);
  assert.match(j.stage, /Failed at 3 of 5/);
  // Fixed, it carries on from the cell that failed: the first three are not run again.
  failAt = undefined;
  assert.equal(q.resume(j.id), undefined);
  await settle(q);
  assert.deepEqual([j.status, j.results], ['done', [1, 2, 5, 10, 17]]);
  assert.deepEqual(seen, [0, 1, 2, 3, 3, 4]);
  assert.equal(q.resume(j.id), 'Only a stopped or failed job can be resumed');
});

test('a job can be stopped part-way and resumed; a restart picks a running job up from its last saved cell', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jobs-'));
  const file = path.join(dir, 'jobs.json');
  let release: (() => void) | null = null;
  const seen: number[] = [];
  const gated = runner({ seen, gate: () => new Promise<void>((r) => { if (seen.length === 3) release = r; else r(); }) });
  const q = queue(gated, file);
  const job = q.submit(spec()) as { id: string };
  // It is now waiting inside its third cell.
  for (let i = 0; i < 100 && !release; i++) await new Promise((r) => setTimeout(r, 2));
  assert.equal(q.cancel(job.id), undefined);
  release!();
  await settle(q);
  const j = q.get(job.id)!;
  assert.equal(j.status, 'cancelled');
  assert.ok(j.cursor >= 2 && j.cursor <= 3);
  assert.equal(q.cancel(job.id), 'That job isn’t running');
  // The office stops while a job is mid-run: what is on disk says "running".
  const saved = JSON.parse(readFileSync(file, 'utf8')) as { status: string; cursor: number }[];
  assert.equal(saved.length, 1);
  const q2 = queue(runner({ seen }), file);
  // (A cancelled job stays cancelled across a restart; resuming is the owner's call.)
  assert.equal(q2.list()[0]!.status, 'cancelled');
  q2.resume(job.id);
  await settle(q2);
  assert.deepEqual([q2.list()[0]!.status, q2.list()[0]!.results], ['done', [1, 2, 5, 10, 17]]);
});

test('a job that was running when the office stopped goes back in the queue; new data starts it over', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jobs-'));
  const file = path.join(dir, 'jobs.json');
  // Stop the first queue in the middle of a job.
  let q: JobQueue<Ctx>;
  const seen: number[] = [];
  const stopper = runner({ seen, gate: async () => { if (seen.length === 3) q.stop(); } });
  q = queue(stopper, file);
  q.submit(spec());
  await new Promise((r) => setTimeout(r, 40));
  const onDisk = JSON.parse(readFileSync(file, 'utf8')) as { status: string; cursor: number; results: number[] }[];
  assert.equal(onDisk[0]!.status, 'running');
  const done = onDisk[0]!.cursor;
  assert.ok(done >= 1 && done < 5);
  // The restart: it is queued again with its finished cells, and the worker finishes the rest.
  const again: number[] = [];
  const q2 = queue(runner({ seen: again }), file);
  assert.deepEqual([q2.list()[0]!.status, q2.list()[0]!.stage, q2.list()[0]!.cursor], ['queued', 'Resuming after a restart', done]);
  q2.kick();
  await settle(q2);
  assert.deepEqual(q2.list()[0]!.results, [1, 2, 5, 10, 17]);
  assert.equal(again[0], done);
  // The same again, but the data changed underneath: the results belonged to the old data, so it starts over.
  const waiting = new JobQueue<Ctx>(null, { sizing: runner() }, () => null);
  assert.equal(waiting.submit(spec()), 'The backtest hasn’t finished yet: there is no data to run on');
  let hash = 'd1';
  const fresh: number[] = [];
  const q4 = queue(runner({ seen: fresh, gate: async () => { if (fresh.length === 2 && hash === 'd1') { q4.stop(); hash = 'd2'; } } }), file.replace('jobs.json', 'j4.json'), () => data(hash));
  q4.submit(spec());
  await new Promise((r) => setTimeout(r, 40));
  const q5 = queue(runner({ seen: fresh }), file.replace('jobs.json', 'j4.json'), () => data('d2'));
  q5.kick();
  await settle(q5);
  assert.deepEqual([q5.list()[0]!.dataset, q5.list()[0]!.results], ['d2', [1, 2, 5, 10, 17]]);
  assert.equal(fresh.filter((x) => x === 0).length, 2);
});
