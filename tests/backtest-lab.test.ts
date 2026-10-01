import test from 'node:test';
import assert from 'node:assert/strict';
import type { Bar, PaperTrade, TradeInd } from '../src/shared/trading.ts';
import { applyFilters, envOf, FILTERS, groupStats, labStats, suggestFilters } from '../src/shared/backtest-lab.ts';
import { replayDay } from '../src/server/trading/engine.ts';

const IND: TradeInd = { m: 420, ema9: 101, ema21: 100, ema50: 99, rsi: 60, adx: 25, macd: 1, atr: 10, vwap: 99, onVwap: 98, relVol: 1.5 };
const day = (n: number) => `2026-09-${String(n).padStart(2, '0')}`;
const trade = (d: number, r: number, ind: Partial<TradeInd> = {}, side: 'long' | 'short' = 'long', k = 0): PaperTrade => ({ id: `t${d}-${k}`, day: day(d), symbol: 'NQ', playbook: 'vwap-pullback', side, entryAt: d * 1000 + k, entry: 100, stop: 90, target: 120, exitAt: d * 1000 + k + 1, exit: 100 + 10 * r, outcome: r > 0 ? 'win' : 'loss', r, dollars: 20 * r, why: '', ind: { ...IND, ...ind } });

test('the stats count wins, expectancy, the worst dip and won over lost', () => {
  const s = labStats([trade(1, 2), trade(2, -1), trade(3, -1), trade(4, 2)]);
  assert.equal(s.trades, 4);
  assert.equal(s.winRate, 0.5);
  assert.equal(s.avgR, 0.5);
  assert.equal(s.totalR, 2);
  assert.equal(s.maxDrawdownR, 2);
  assert.equal(s.profitFactor, 2);
  assert.deepEqual(s.curve, [2, 1, 0, 2]);
});

test('a filter keeps the trades its indicator agreed with, by side, and drops the ones it has no reading for', () => {
  const env = envOf([]);
  const up = trade(1, 1);
  const down = trade(2, 1, { ema9: 99, ema21: 100 });
  const short = trade(3, 1, { ema9: 99, ema21: 100 }, 'short');
  assert.deepEqual(applyFilters([up, down, short], ['ema-trend'], env).map((t) => t.id), [up.id, short.id]);
  assert.deepEqual(applyFilters([up, { ...up, id: 'x', ind: undefined }], ['rsi-momentum'], env).map((t) => t.id), [up.id]);
  // Two filters both have to pass.
  assert.equal(applyFilters([up, trade(4, 1, { relVol: 0.8 })], ['ema-trend', 'vol-up'], env).length, 1);
});

test('the lively and calm tape filters split a market at its own usual ATR', () => {
  const list = [trade(1, 1, { atr: 5 }), trade(2, 1, { atr: 10 }), trade(3, 1, { atr: 20 })];
  const env = envOf(list);
  assert.equal(env.atrMedian.NQ, 10);
  assert.equal(applyFilters(list, ['atr-active'], env).length, 2);
  assert.equal(applyFilters(list, ['atr-calm'], env).length, 2);
});

test('a filter that really separates winners from losers is recommended; one that changes nothing is not', () => {
  // Thirty days: with volume the setup wins, without it it loses, on the earlier days and the later ones alike.
  const trades: PaperTrade[] = [];
  const days: string[] = [];
  for (let d = 1; d <= 30; d++) {
    days.push(day(d));
    trades.push(trade(d, d % 4 === 0 ? -1 : 2, { relVol: 1.6 }, 'long', 0));
    trades.push(trade(d, d % 4 === 1 ? 2 : -1, { relVol: 0.7 }, 'long', 1));
  }
  const out = suggestFilters(trades, [], envOf(trades), days);
  const vol = out.find((s) => s.filter === 'vol-up')!;
  assert.equal(vol.verdict, 'recommended');
  assert.equal(vol.kept, 30);
  assert.ok(vol.dAvgR > 0.5 && vol.laterDAvgR! > 0);
  assert.equal(out[0]!.filter, 'vol-up');
  // Every trade is above the 50 EMA already, so that filter has nothing to say.
  assert.equal(out.find((s) => s.filter === 'ema50-side')!.verdict, 'neutral');
  // On: it isn't offered again.
  assert.ok(!suggestFilters(trades, ['vol-up'], envOf(trades), days).some((s) => s.filter === 'vol-up'));
});

test('an edge that only shows on the earlier days is not recommended, and nor is a direction', () => {
  const trades: PaperTrade[] = [];
  const days: string[] = [];
  for (let d = 1; d <= 30; d++) {
    days.push(day(d));
    const early = d <= 20;
    trades.push(trade(d, early ? 2 : -1, { adx: 30 }, 'short', 0));
    trades.push(trade(d, early ? -1 : 2, { adx: 10 }, 'long', 1));
  }
  const out = suggestFilters(trades, [], envOf(trades), days);
  assert.equal(out.find((s) => s.filter === 'adx-trending')!.verdict, 'unproven');
  const steady = trades.map((t) => ({ ...t, r: t.side === 'short' ? 2 : -1 }));
  const dir = suggestFilters(steady, [], envOf(steady), days).find((s) => s.filter === 'shorts-only')!;
  assert.equal(dir.verdict, 'unproven');
  assert.match(dir.reason, /the market, not the setup/);
});

test('too few trades left is called thin', () => {
  const trades = Array.from({ length: 14 }, (_, i) => trade(i + 1, i < 5 ? 2 : -1, { relVol: i < 5 ? 2 : 0.5 }));
  assert.equal(suggestFilters(trades, [], envOf(trades), trades.map((t) => t.day)).find((s) => s.filter === 'vol-up')!.verdict, 'thin');
});

test('group stats split results by a property of the trade', () => {
  const g = groupStats([trade(1, 2), trade(2, -1, {}, 'short'), trade(3, 2)], (t) => t.side);
  assert.equal(g.find((x) => x.key === 'long')!.stats.trades, 2);
  assert.equal(g.find((x) => x.key === 'short')!.stats.avgR, -1);
});

test('every filter has its words, and the backtest keeps the indicators on each trade it takes', () => {
  for (const f of FILTERS) assert.ok(f.name && f.what.length > 20 && f.rule.length > 10, f.id);
  // A drifting day and a half of one-minute bars: whatever the playbooks take, each trade carries its readings.
  const OPEN = Date.UTC(2026, 8, 29, 13, 30);
  const bar = (ts: number, o: number, c: number): Bar => ({ ts, open: o, close: c, high: Math.max(o, c) + 1.5, low: Math.min(o, c) - 1.5, volume: 100 + ((ts / 60_000) % 7) * 30 });
  const walk = (from: number, n: number, start: number) => Array.from({ length: n }, (_, i) => bar(from + i * 60_000, start + Math.sin(i / 9) * 12 + i * 0.05, start + Math.sin((i + 1) / 9) * 12 + (i + 1) * 0.05));
  const res = replayDay('NQ', walk(OPEN - 3_600_000, 450, 20_050), walk(OPEN - 86_400_000, 390, 20_000));
  assert.ok(res.trades.length > 0);
  for (const t of res.trades) {
    assert.ok(t.ind, 'a backtest trade carries its indicators');
    assert.ok(t.ind!.m >= 0 && t.ind!.m < 1440);
    assert.ok(t.ind!.rsi == null || (t.ind!.rsi >= 0 && t.ind!.rsi <= 100));
    assert.ok(t.ind!.adx == null || (t.ind!.adx >= 0 && t.ind!.adx <= 100));
    assert.ok(t.ind!.ema9 != null && t.ind!.atr != null);
  }
});
