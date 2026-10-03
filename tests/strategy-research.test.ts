import test from 'node:test';
import assert from 'node:assert/strict';
import type { PaperTrade } from '../src/shared/trading.js';
import { researchFindings, holdoutFinding, RESEARCH_FILTERS } from '../src/shared/strategy-research.js';
import { splitDays } from '../src/shared/validation.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ResearchWorkbench } from '../src/server/trading/research-workbench.js';
import type { ResearchReport } from '../src/shared/strategy-research.js';

const days = Array.from({ length: 40 }, (_, i) => new Date(Date.UTC(2026, 7, i + 1)).toISOString().slice(0, 10));
function trade(day: string, i: number, good: boolean): PaperTrade {
  const at = Date.parse(`${day}T14:00:00Z`) + i * 600_000; const r = good ? 2 : -1;
  return { id: `${day}-${i}`, day, symbol: 'NQ', playbook: 'vwap-pullback', side: 'long', entryAt: at, entry: 20000, stop: 19980, target: 20040,
    exitAt: at + 300_000, exit: 20000 + 20 * r, r, dollars: 40 * r, outcome: good ? 'win' : 'loss', why: '', mae: good ? 2 : 20, mfe: good ? 40 : 2,
    ind: { ema9: good ? 20001 : 19999, ema21: 20000, ema50: 20000, macd: null, rsi: null, adx: null, atr: null, relVol: null, m: 120, vwap: null, ovwap: null } };
}
const tape = days.flatMap(day => Array.from({ length: 4 }, (_, i) => trade(day, i, i % 2 === 0)));
test('training alone selects a fixed rule; later losses cannot alter the rule chosen', () => {
  const a = researchFindings(tape, days)[0]!;
  assert.equal(a.filter, 'ema-trend'); assert.equal(a.tried, RESEARCH_FILTERS.length);
  assert.equal(a.report.holdout, null);
  const unseen = new Set([...splitDays(days).validation, ...splitDays(days).holdout]);
  const b = researchFindings(tape.map(t => unseen.has(t.day) ? { ...t, r: -4, dollars: -160, outcome: 'loss', ind: { ...t.ind!, ema9: 19999 } } : t), days)[0]!;
  assert.equal(b.filter, a.filter); assert.notEqual(b.report.verdict, 'promising');
  assert.deepEqual(b.report.train, a.report.train);
});
test('holdout scores the frozen filter and missing trades stay inconclusive', () => {
  const a = researchFindings(tape, days)[0]!; const r = holdoutFinding(a, tape, days);
  assert.ok(r.holdout); assert.equal(r.candidate.id, a.report.candidate.id);
  const empty = researchFindings([], days)[0]!;
  assert.equal(empty.filter, null); assert.equal(empty.report.verdict, 'inconclusive');
  assert.ok(empty.firms.every(f => f.candidate.taken === 0 && f.candidate.profit === 0));
});
test('firm comparisons replay validation only, retain provenance and stress costs on the same trades', () => {
  const finding = researchFindings(tape, days)[0]!;
  assert.ok(finding.firms.length >= 3);
  for (const name of ['Topstep', 'Apex']) {
    const scenarios = finding.firms.filter(f => f.name.startsWith(name));
    assert.ok(scenarios.length);
    assert.ok(scenarios.every(f => !f.verified));
  }
  for (const f of finding.firms) {
    assert.ok(f.ruleSet); assert.ok(f.candidate.taken <= 20);
    assert.ok(f.candidate.days <= splitDays(days).validation.length);
    if (f.verified) assert.ok(f.sources.length && f.verifiedOn);
  }
  const lucid = finding.firms.find(f => f.id === 'lucidflex-50k')!;
  assert.ok(lucid.stressed.profit < lucid.candidate.profit);
});

test('reserved data stays opened after restart and cannot be reopened with another sizing cap', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-research-'));
  const market = { history: async () => [], historyView: () => ({ datasets: [], selected: {}, cached: [] }) };
  const report: ResearchReport = { id: 'run-a', createdAt: Date.now(), dataset: 'same-candles', markets: ['NQ'], days, cap: 5, sources: [],
    findings: researchFindings(tape, days), holdout: null, notes: [] };
  assert.equal(report.findings[0]!.report.verdict, 'promising');
  const save = (r: ResearchReport) => {
    writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(r));
    writeFileSync(path.join(dir, `${r.id}.json`), JSON.stringify({ report: r, trades: tape }));
  };
  try {
    save(report);
    const first = new ResearchWorkbench(dir, market).openHoldout({ id: report.id, playbook: 'vwap-pullback' });
    assert.ok(first.report?.holdout); assert.ok(first.report?.findings[0]!.report.holdout);
    assert.deepEqual(new ResearchWorkbench(dir, market).openHoldout({ id: report.id, playbook: 'vwap-pullback' }).report, first.report);
    save({ ...report, id: 'run-b', cap: 1 });
    assert.throws(() => new ResearchWorkbench(dir, market).openHoldout({ id: 'run-b', playbook: 'vwap-pullback' }), /already been opened/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
