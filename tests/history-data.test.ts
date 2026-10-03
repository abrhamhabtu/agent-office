import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseHistoryCsv } from '../src/shared/history-data.js';
import { HistoryLibrary } from '../src/server/trading/history-library.js';

const header = 'time,open,high,low,close,volume,indicator';
const csv = `${header}\n1756819860,11,13,10,12,30,"a,b"\n1756819800,10,12,9,11,20,x\n1756819800,10,12,9,11,20,x`;
test('chart CSV keeps volume, sorts UTC time, ignores quoted indicator columns and removes identical duplicates', () => {
  const p = parseHistoryCsv(csv);
  assert.equal(p.duplicates, 1); assert.equal(p.bars.length, 2);
  assert.equal(p.bars[0]!.volume, 20); assert.equal(p.bars[0]!.ts, 1756819800000);
});
test('CSV refuses conflicting candles, missing volume, impossible prices, naive dates, and larger timeframes', () => {
  assert.throws(() => parseHistoryCsv(csv + '\n1756819800,10,12,9,10,20,x'), /conflicting/);
  assert.throws(() => parseHistoryCsv(csv.replace('volume', 'unknown')), /volume/);
  assert.throws(() => parseHistoryCsv(csv.replace('11,13,10,12', '11,8,10,12')), /OHLC/);
  assert.throws(() => parseHistoryCsv(csv.replace('1756819860', '2025-09-02T13:31:00')), /timezone/);
  assert.throws(() => parseHistoryCsv(`${header}\n1756819800,10,12,9,11,20,x\n1756820100,11,13,10,12,30,x`), /not a 1-minute/);
});
test('imports are immutable, durable and selected explicitly; one market cannot use another market’s history', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'office-history-'));
  try {
    const lib = new HistoryLibrary(dir); const d = lib.import({ symbol: 'NQ', contract: 'NQ1!', csv });
    assert.equal(lib.selected('NQ'), null);
    assert.equal(lib.import({ symbol: 'NQ', contract: 'NQ1!', csv }).id, d.id);
    assert.equal(lib.view().datasets.length, 1);
    assert.throws(() => lib.select('ES', d.id), /belong/);
    lib.select('NQ', d.id);
    assert.equal(new HistoryLibrary(dir).selected('NQ')!.length, 2);
    lib.select('NQ', null); assert.equal(lib.selected('NQ'), null);
    assert.throws(() => lib.import({ symbol: 'NQ', contract: '../../x', csv }), /actual chart/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
