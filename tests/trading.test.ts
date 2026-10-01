import assert from 'node:assert/strict';
import test from 'node:test';
import type { Bar, PaperTrade } from '../src/shared/trading.ts';
import { floorRole, lawOf10, microsFor, PROP_ACCOUNTS, seatJob } from '../src/shared/trading.ts';
import { Profile, replayDay, sessionMinute, tradingDay } from '../src/server/trading/engine.ts';
import { parseAlert, playbookFor, sessionAt, simulateEval, TradingDesk } from '../src/server/trading/desk.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Market, parseChart, parseCoinbaseCandles, parseTradingViewBar, tvSymbol } from '../src/server/trading/market.ts';
import { parseRss } from '../src/server/trading/news.ts';
import { gatewayUrl, tradesFromFills } from '../src/server/trading/projectx.ts';

/** 06:30 PT on Tuesday 29 September 2026 (PDT, UTC-7). */
const OPEN = Date.UTC(2026, 8, 29, 13, 30);
const bar = (ts: number, open: number, close: number, spread = 1, volume = 100): Bar => ({ ts, open, close, high: Math.max(open, close) + spread, low: Math.min(open, close) - spread, volume });

/** A day that trends up off the open, pulls back to VWAP, and bounces: Evan's setup. */
function trendDay(): { today: Bar[]; prior: Bar[] } {
  const prior: Bar[] = [];
  for (let i = 0; i < 390; i++) prior.push(bar(OPEN - 86_400_000 + i * 60_000, 20_000 + i * 0.1, 20_000 + (i + 1) * 0.1));
  const today: Bar[] = [];
  let p = 20_050;
  // Globex: quiet, a touch higher.
  for (let t = OPEN - 60 * 60_000; t < OPEN; t += 60_000) today.push(bar(t, p, (p += 0.2)));
  let pv = 0;
  let v = 0;
  const push = (i: number, o: number, c: number, vol: number) => {
    const b = bar(OPEN + i * 60_000, o, c, 1, vol);
    pv += ((b.high + b.low + b.close) / 3) * vol;
    v += vol;
    today.push(b);
  };
  // The open: a clean trend up for an hour.
  let i = 0;
  for (; i < 60; i++) push(i, p, (p += 3), 300);
  // The pullback: all the way back down to VWAP, where it stops.
  while (p - 4 > pv / v) push(i++, p, (p -= 2), 80);
  push(i++, p, pv / v + 0.5, 80);
  p = pv / v + 0.5;
  // And the bounce, with volume.
  for (const end = i + 60; i < end; i++) push(i, p, (p += 2.5), 400);
  return { today, prior };
}

test('a trading day starts at the 15:00 PT Globex open, and RTH minutes are Pacific', () => {
  assert.equal(tradingDay(OPEN), '2026-09-29');
  assert.equal(tradingDay(Date.UTC(2026, 8, 28, 22, 5)), '2026-09-29'); // 15:05 PT Monday
  assert.equal(tradingDay(Date.UTC(2026, 8, 28, 21, 55)), '2026-09-28'); // 14:55 PT Monday
  assert.equal(sessionMinute(OPEN), 390);
  assert.ok(sessionMinute(Date.UTC(2026, 8, 28, 23, 0)) < 0);
});

test('the VWAP pullback takes its one trade off the bounce, stop under the touch, target up the trend', () => {
  const { today, prior } = trendDay();
  const res = replayDay('NQ', today, prior);
  const pb = res.trades.filter((t) => t.playbook === 'vwap-pullback');
  assert.equal(pb.length, 1, JSON.stringify(res.trades.map((t) => t.playbook)));
  const t = pb[0]!;
  assert.equal(t.side, 'long');
  assert.ok(t.stop < t.entry && t.entry < t.target, JSON.stringify(t));
  assert.ok(Math.abs((t.entry - res.levels.vwap!) / t.entry) < 0.01);
  assert.ok(res.levels.vwap! > 0 && res.levels.orHigh! > res.levels.orLow!);
});

test('support and resistance buys the rejection of yesterday’s low, stop just under it', () => {
  const prior: Bar[] = [];
  // Yesterday's session: 20,000 to 20,100.
  for (let i = 0; i < 390; i++) prior.push(bar(OPEN - 86_400_000 + i * 60_000, 20_050 + Math.sin(i / 20) * 45, 20_050 + Math.sin((i + 1) / 20) * 45, 5));
  const pdl = Math.min(...prior.map((b) => b.low));
  const today: Bar[] = [];
  let p = pdl + 60;
  for (let t = OPEN - 60 * 60_000; t < OPEN; t += 60_000) today.push(bar(t, p, p, 1));
  // Drifts down into yesterday's low…
  let i = 0;
  while (p - 2 > pdl + 3) today.push(bar(OPEN + i++ * 60_000, p, (p -= 2), 1, 200));
  // …wicks through it and closes back above: the rejection.
  today.push({ ts: OPEN + i++ * 60_000, open: p, high: p + 1, low: pdl - 2, close: p + 1.5, volume: 400 });
  p += 1.5;
  for (let k = 0; k < 40; k++) today.push(bar(OPEN + i++ * 60_000, p, (p += 2), 1, 300));
  const res = replayDay('NQ', today, prior);
  // (Tested levels on the way down may have their own trades; the one at yesterday's low is the long.)
  const long = res.trades.find((t) => t.playbook === 'support-resistance' && t.side === 'long');
  assert.ok(long, JSON.stringify(res.trades));
  assert.ok(long.stop < pdl && long.entry > pdl, JSON.stringify(long));
  assert.match(long.why, /Yesterday’s low/i);
});

test('every paper trade aims the way its side says, and closes by the end of the day', () => {
  const { today, prior } = trendDay();
  for (const t of replayDay('NQ', today, prior).trades) {
    if (t.side === 'long') assert.ok(t.stop < t.entry && t.entry < t.target, t.id);
    else assert.ok(t.stop > t.entry && t.entry > t.target, t.id);
    assert.notEqual(t.outcome, 'open', t.id);
    assert.ok(Number.isFinite(t.r) && Number.isFinite(t.dollars));
  }
});

test('a replay is the same every time: the board, the paper book and the backtest agree', () => {
  const { today, prior } = trendDay();
  assert.deepEqual(replayDay('ES', today, prior).trades, replayDay('ES', today, prior).trades);
});

test('the volume profile puts POC where most volume traded and the value area around it', () => {
  const p = new Profile(1);
  for (let i = 0; i < 50; i++) p.push({ ts: i, open: 100, high: 100.5, low: 99.5, close: 100, volume: 100 });
  p.push({ ts: 99, open: 110, high: 110.5, low: 109.5, close: 110, volume: 5 });
  const v = p.value()!;
  assert.ok(v.poc >= 99 && v.poc <= 101);
  assert.ok(v.val <= v.poc && v.poc <= v.vah);
  assert.ok(v.vah < 109);
});

test('Law of 10: a tenth of the cushion, in whole micros for the stop', () => {
  assert.equal(lawOf10(2000), 200);
  assert.equal(lawOf10(1800), 180);
  assert.equal(microsFor('NQ', 300, 20), 7); // 20 pts × $2 = $40 a micro
  assert.equal(microsFor('ES', 300, 20), 3); // 20 pts × $5 = $100
  assert.equal(microsFor('NQ', 300, 20, 5), 5);
  assert.equal(microsFor('NQ', 300, 0), 0);
});

test('the eval simulator passes a steady winner and busts a steady loser', () => {
  const rules = PROP_ACCOUNTS.find((a) => a.id === 'topstep-50k')!;
  const mk = (day: number, r: number): PaperTrade => ({ id: `t${day}`, day: `2026-09-${String(day).padStart(2, '0')}`, symbol: 'NQ', playbook: 'vwap-pullback', side: 'long', entryAt: day, entry: 100, stop: 80, target: 140, exitAt: day, exit: 100 + 20 * r, outcome: r > 0 ? 'win' : 'loss', r, dollars: 20 * r * 2, why: '' });
  const win = simulateEval(Array.from({ length: 20 }, (_, i) => mk(i + 1, 2)), rules);
  assert.equal(win.result, 'passed');
  assert.ok(win.days >= rules.minTradingDays);
  const lose = simulateEval(Array.from({ length: 60 }, (_, i) => mk(i + 1, -1)), rules);
  // The Law of 10 shrinks the size after every loss: it bleeds slowly instead of blowing up at once.
  assert.notEqual(lose.result, 'passed');
  assert.ok(lose.pnl < 0);
});

test('TradingView alerts parse from JSON or plain text, and name their playbook', () => {
  const a = parseAlert(JSON.stringify({ symbol: 'MNQ1!', side: 'buy', setup: 'VWAP Double Break', price: '30512.25' }));
  assert.equal(a.side, 'long');
  assert.equal(a.playbook, 'double-break');
  assert.equal(a.price, 30512.25);
  assert.equal(a.symbol, 'MNQ1!');
  const b = parseAlert('Supply zone rejection SHORT NQ');
  assert.equal(b.side, 'short');
  assert.equal(b.playbook, 'supply-demand');
  assert.equal(playbookFor('failed auction at VAL'), 'failed-auction');
  assert.equal(playbookFor('pullback to vwap'), 'vwap-pullback');
});

test('the VWAP Double Break Suite’s own alert message rings the double-break desk with its plan', () => {
  const first = parseAlert('{"ticker":"NQ1!","price":30512.25,"ny_vwap":30498.4,"stop":30480.5,"target":30575.75,"event_type":"NY_VWAP_SECOND_BREAK","side":"LONG"}');
  assert.equal(first.symbol, 'NQ1!');
  assert.equal(first.side, 'long');
  assert.equal(first.setup, 'VWAP Double Break');
  assert.equal(first.playbook, 'double-break', 'NY_VWAP must not ring the VWAP pullback desk');
  assert.equal(first.price, 30512.25);
  assert.equal(first.stop, 30480.5);
  assert.equal(first.target, 30575.75);
  assert.equal(first.message, 'Stop 30480.5 · Target 30575.75 · NY VWAP 30498.4');
  const again = parseAlert('{"ticker":"GC1!","price":4330.1,"ny_vwap":4331.2,"stop":4335.6,"target":4319.1,"event_type":"NY_VWAP_RECOVERY","side":"SHORT"}');
  assert.equal(again.side, 'short');
  assert.match(again.setup, /re-entry \(DB2\)/);
  assert.equal(again.playbook, 'double-break');
  // A script with no plan in it still works, and an explicit message wins.
  assert.equal(parseAlert('{"symbol":"NQ1!","side":"long","setup":"x","message":"hello"}').message, 'hello');
  assert.equal(parseAlert('{"ticker":"NQ1!","side":"long","price":1,"stop":0,"target":"","event_type":"NY_VWAP_SECOND_BREAK"}').stop, null);
});

test('the session clock rings the bells on weekdays only', () => {
  const tueOpen = sessionAt(OPEN + 5_000);
  assert.equal(tueOpen.phase, 'ORB');
  assert.equal(tueOpen.lastBell?.kind, 'open');
  assert.equal(tueOpen.nextBell.kind, 'close');
  // Saturday noon PT: nothing rings until Monday 06:30.
  const sat = sessionAt(Date.UTC(2026, 9, 3, 19, 0));
  assert.equal(sat.phase, 'closed');
  assert.equal(sat.lastBell, null);
  assert.equal(sat.nextBell.kind, 'open');
  // Saturday 12:00 → Monday 06:30 is 42½ hours.
  assert.equal(sat.nextBell.inSeconds, 42.5 * 3600);
});

test('Yahoo bars skip empty minutes; RSS items come out with their time', () => {
  const bars = parseChart({ chart: { result: [{ timestamp: [1, 2, 3], indicators: { quote: [{ open: [1, null, 3], high: [1.5, null, 3.5], low: [0.5, null, 2.5], close: [1.2, null, 3.1], volume: [10, null, 30] }] } }] } });
  assert.equal(bars.length, 2);
  assert.equal(bars[1]!.ts, 3000);
  const items = parseRss('<rss><item><title><![CDATA[Nasdaq futures &amp; the Fed]]></title><link>https://x.test/a</link><pubDate>Tue, 29 Sep 2026 13:00:00 GMT</pubDate></item></rss>');
  assert.equal(items[0]!.title, 'Nasdaq futures & the Fed');
  assert.equal(items[0]!.at, Date.UTC(2026, 8, 29, 13));
});

test('ProjectX fills pair into round trips, and the gateway has to be https', () => {
  const fills = [
    { id: 1, accountId: 7, contractId: 'CON.F.US.MNQ.Z26', creationTimestamp: '2026-09-29T13:40:00Z', price: 30500, profitAndLoss: null, fees: 0.37, side: 0, size: 2, voided: false },
    { id: 2, accountId: 7, contractId: 'CON.F.US.MNQ.Z26', creationTimestamp: '2026-09-29T13:52:00Z', price: 30530, profitAndLoss: 120, fees: 0.37, side: 1, size: 2, voided: false },
  ];
  const t = tradesFromFills(fills, 7);
  assert.equal(t.length, 1);
  assert.equal(t[0]!.side, 'long');
  assert.equal(t[0]!.symbol, 'MNQ');
  assert.equal(t[0]!.qty, 2);
  assert.equal(t[0]!.pnl, 119.63);
  assert.equal(gatewayUrl('http://evil.test'), null);
  assert.equal(gatewayUrl(''), 'https://api.topstepx.com/api');
  assert.equal(gatewayUrl('https://gateway.example.com/api/'), 'https://gateway.example.com/api');
});

test('Back Office proves, every other floor rings the bell, and each floor names its seats', () => {
  assert.equal(floorRole('Back Office'), 'office');
  assert.equal(floorRole('backoffice'), 'office');
  assert.equal(floorRole('Opening Bell'), 'bell');
  assert.equal(floorRole('trade-pilot'), 'bell');
  assert.equal(floorRole(undefined), 'bell');
  assert.match(seatJob('bell', 'desk-1')!, /VWAP/);
  assert.match(seatJob('office', 'desk-1')!, /backtest/i);
  assert.equal(seatJob('bell', 'beanbag-1'), undefined);
});

test('the risk guard stops an account after three losses, and a logged trade moves its balance', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'desk-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const desk = new TradingDesk(dir);
  const before = desk.snapshot().guard.accounts.find((a) => a.accountId === 'topstep-50k')!;
  assert.ok(before.maxRisk >= 0);
  for (const loss of [-50, -60, -40]) assert.equal(desk.setAccount('topstep-50k', { log: loss }), undefined);
  const s = desk.snapshot();
  const acct = s.accounts.find((a) => a.rules.id === 'topstep-50k')!;
  assert.equal(acct.lossesToday, 3);
  assert.equal(acct.todayPnl, -150);
  assert.equal(acct.balance, 50_000 - 150);
  const g = s.guard.accounts.find((a) => a.accountId === 'topstep-50k')!;
  assert.equal(g.level, 'stop');
  assert.equal(g.maxRisk, 0);
  assert.match(g.reasons[0]!.label, /daily stop/);
  // Another account is untouched (whatever the clock says about the market).
  assert.ok(!s.guard.accounts.find((a) => a.accountId === 'lucidflex-50k')!.reasons.some((r) => /daily stop hit/.test(r.label)));
  assert.match(desk.setAccount('topstep-50k', { log: 1e9 }) ?? '', /doesn’t look right/);
});

test('Coinbase candles: sorted oldest first, malformed and future rows dropped', () => {
  const now = Date.UTC(2026, 8, 30, 20, 0);
  const t = now / 1000;
  const rows = [
    [t, 83_000, 83_100, 83_010, 83_050, 1.5],
    [t - 60, 82_900, 83_020, 82_950, 83_010, 2.25],
    [t - 120, 'x', 1, 1, 1, 1],
    [t + 3_600, 1, 2, 1, 2, 1],
    [t - 180, 82_800, 82_700, 82_750, 82_760, 1],
    [t - 240],
  ];
  const bars = parseCoinbaseCandles(rows, now);
  assert.deepEqual(bars.map((b) => b.ts), [(t - 180) * 1000, (t - 60) * 1000, t * 1000]);
  assert.equal(bars[2]!.open, 83_010);
  assert.equal(bars[2]!.close, 83_050);
  assert.equal(bars[2]!.volume, 1.5);
  // A row whose high dips below its own open/close is repaired, never trusted.
  assert.equal(bars[0]!.high, 82_760);
  assert.deepEqual(parseCoinbaseCandles('nope'), []);
});

test('TradingView tickers map to the four markets', () => {
  assert.equal(tvSymbol('NQ1!'), 'NQ');
  assert.equal(tvSymbol('CME_MINI:MNQ1!'), 'NQ');
  assert.equal(tvSymbol('ESZ2026'), 'ES');
  assert.equal(tvSymbol('COMEX:GC1!'), 'GC');
  assert.equal(tvSymbol('BTCUSD'), 'BTC');
  assert.equal(tvSymbol('CME:MBT1!'), 'BTC');
  assert.equal(tvSymbol('AAPL'), null);
  assert.equal(tvSymbol(42), null);
});

test('a TradingView bar-close message becomes a candle, or is refused with a reason', () => {
  const now = Date.UTC(2026, 8, 30, 20, 5, 30);
  const ok = parseTradingViewBar({ type: 'bar', symbol: 'NQ1!', interval: '1', time: '2026-09-30T20:04:00Z', open: '20000.5', high: 20003, low: '19999.25', close: 20002, volume: '118' }, now);
  assert.ok(!('error' in ok));
  if ('error' in ok) return;
  assert.equal(ok.symbol, 'NQ');
  assert.deepEqual(ok.bar, { ts: Date.UTC(2026, 8, 30, 20, 4), open: 20000.5, high: 20003, low: 19999.25, close: 20002, volume: 118 });
  // The candle's time is floored to its minute; seconds-since-epoch work too.
  const sec = parseTradingViewBar({ symbol: 'GC1!', time: Date.UTC(2026, 8, 30, 20, 4, 40) / 1000, open: 1, high: 2, low: 1, close: 2 }, now);
  assert.ok(!('error' in sec) && sec.bar.ts === Date.UTC(2026, 8, 30, 20, 4) && sec.bar.volume === 0);
  const refused = (b: object) => {
    const r = parseTradingViewBar({ symbol: 'NQ1!', time: '2026-09-30T20:04:00Z', open: 10, high: 12, low: 9, close: 11, ...b }, now);
    return 'error' in r ? r.error : null;
  };
  assert.match(refused({ symbol: 'AAPL' })!, /NQ, ES, GC and BTC/);
  assert.match(refused({ interval: '5' })!, /1-minute/);
  assert.match(refused({ high: 10.5 })!, /high and low/);
  assert.match(refused({ close: 'NaN' })!, /numbers/);
  assert.match(refused({ open: 0 })!, /numbers/);
  assert.match(refused({ time: '2026-09-30T20:30:00Z' })!, /future/);
  assert.match(refused({ time: '2026-09-28T20:00:00Z' })!, /day old/);
  assert.match(refused({ time: undefined })!, /time/);
  assert.match(refused({ volume: -1 })!, /Volume/);
});

test('a current TradingView candle becomes the desk’s price, candle source and feed, and lapses when it goes quiet', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tv-'));
  try {
    const m = new Market(dir);
    const minute = Math.floor(Date.now() / 60_000) * 60_000;
    m.setTradingViewBar('NQ', { ts: minute - 60_000, open: 20_000, high: 20_010, low: 19_995, close: 20_005, volume: 50 });
    const q = m.quotes().find((x) => x.symbol === 'NQ')!;
    assert.equal(q.last, 20_005);
    assert.equal(q.source, 'TradingView');
    assert.equal(q.barSource, 'TradingView');
    assert.equal(q.stale, false);
    assert.equal(m.closedBars('NQ').at(-1)!.close, 20_005);
    const feed = m.feeds().find((f) => f.id === 'tradingview')!;
    assert.equal(feed.ok, true);
    // An older candle re-sent later doesn't drag the price back.
    m.setTradingViewBar('NQ', { ts: minute - 120_000, open: 1, high: 30_000, low: 1, close: 19_000, volume: 1 });
    assert.equal(m.quotes().find((x) => x.symbol === 'NQ')!.last, 20_005);
    // Quiet for a while: back to whatever else there is, and labelled so.
    m.setTradingViewBar('ES', { ts: minute - 10 * 60_000, open: 5_000, high: 5_001, low: 4_999, close: 5_000.5, volume: 10 });
    assert.equal(m.barSource('ES'), 'Yahoo');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the TradingView webhook sends candles to the market feed and everything else to the alert log', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'desk-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const desk = new TradingDesk(dir);
  const minute = Math.floor(Date.now() / 60_000) * 60_000 - 60_000;
  const bar = JSON.stringify({ type: 'bar', symbol: 'NQ1!', interval: '1', time: new Date(minute).toISOString(), open: 20_000, high: 20_004, low: 19_998, close: 20_002, volume: 40 });
  const r = desk.tradingView(bar);
  assert.deepEqual(r, { kind: 'bar', symbol: 'NQ' });
  const s = desk.snapshot();
  assert.equal(s.alerts.length, 0, 'a candle is not an alert');
  const nq = s.quotes.find((q) => q.symbol === 'NQ')!;
  assert.equal(nq.source, 'TradingView');
  assert.equal(nq.barSource, 'TradingView');
  assert.ok(s.feeds.some((f) => f.id === 'tradingview' && f.ok));
  // A refused candle says why, and changes nothing.
  assert.match((desk.tradingView(JSON.stringify({ type: 'bar', symbol: 'NQ1!', interval: '15', time: new Date(minute).toISOString(), open: 1, high: 2, low: 1, close: 2 })) as { error: string }).error, /1-minute/);
  // Anything else is an alert, as before.
  const a = desk.tradingView(JSON.stringify({ symbol: 'NQ1!', side: 'long', setup: 'VWAP Double Break', price: 20_002 }));
  assert.ok('kind' in a && a.kind === 'alert');
  assert.equal(desk.snapshot().alerts.length, 1);
});

test('the message the Pine script sends (time in milliseconds, numbers unquoted) is accepted', () => {
  const t = Math.floor(Date.now() / 60_000) * 60_000 - 60_000;
  const msg = `{"type":"bar","symbol":"NQ1!","interval":"1","time":${t},"open":20000.25,"high":20004,"low":19998.5,"close":20002.75,"volume":312}`;
  const r = parseTradingViewBar(JSON.parse(msg));
  assert.ok(!('error' in r));
  if ('error' in r) return;
  assert.equal(r.symbol, 'NQ');
  assert.equal(r.bar.ts, t);
  assert.equal(r.bar.close, 20002.75);
  assert.equal(r.bar.volume, 312);
});

test('a setup in a trade carries when it was triggered, for the board’s stopwatch', async () => {
  const { today, prior } = trendDay();
  let seen: { stage: string; triggeredAt?: number } | null = null;
  let last = 0;
  for (let n = 80; n <= today.length && !seen; n++) {
    const res = replayDay('NQ', today.slice(0, n), prior, { live: true });
    last = today[n - 1]!.ts;
    const live = Object.values(res.views).find((v) => v.stage === 'live');
    if (live) seen = live;
  }
  assert.ok(seen, 'the trend day has a trade open at some point');
  assert.ok(seen!.triggeredAt && seen!.triggeredAt >= OPEN - 3_600_000 && seen!.triggeredAt <= last, 'the trigger is a bar from this day, no later than now');
});

test('the stopwatch on a proposal: in the trade, at the level, or how long ago it resolved', async () => {
  const { stageClock, stopwatch } = await import('../src/client/trading/screens.ts');
  assert.equal(stopwatch(7_000), '7s');
  assert.equal(stopwatch(14 * 60_000 + 7_000), '14m 07s');
  assert.equal(stopwatch(65 * 60_000), '1h 05m');
  assert.equal(stopwatch(-5), '0s');
  const now = Date.UTC(2026, 8, 30, 20, 0);
  const base = { id: 'x', symbol: 'BTC', playbook: 'failed-auction', agent: 'a', side: 'long', title: '', checks: [], entry: 1, stop: 0, target: 2, r: 2, distance: 0, sizing: [], mark: null, note: '' } as never;
  const live = stageClock({ ...(base as object), stage: 'live', triggeredAt: now - 14 * 60_000 - 7_000 } as never, now, true)!;
  assert.match(live.text, /^IN TRADE 14m 07s · since \d\d:\d\d$/);
  assert.equal(live.live, true);
  assert.equal(stageClock({ ...(base as object), stage: 'live', triggeredAt: now - 60_000 } as never, now, false)!.text, 'IN TRADE 1m 00s');
  assert.equal(stageClock({ ...(base as object), stage: 'won', triggeredAt: now - 31 * 60_000, endedAt: now - 6 * 60_000 } as never, now, true)!.text, 'TARGET 6m 00s ago · ran 25m 00s');
  assert.equal(stageClock({ ...(base as object), stage: 'lost', endedAt: now - 90_000 } as never, now, false)!.text, 'STOPPED 1m 30s ago');
  assert.equal(stageClock({ ...(base as object), stage: 'ready', stageSince: now - 200_000 } as never, now)!.text, 'AT THE LEVEL 3m 20s');
  assert.equal(stageClock({ ...(base as object), stage: 'watching', stageSince: now } as never, now), null);
  assert.equal(stageClock({ ...(base as object), stage: 'live' } as never, now), null, 'no trigger time, no guess');
});

test('the proposal timer steps down to shorter wording so it never has to overlap anything', async () => {
  const { stageClock } = await import('../src/client/trading/screens.ts');
  const now = Date.UTC(2026, 8, 30, 20, 0);
  const live = { id: 'x', symbol: 'NQ', playbook: 'failed-auction', stage: 'live', triggeredAt: now - 46 * 60_000 } as never;
  const texts = ([0, 1, 2] as const).map((l) => stageClock(live, now, l)!.text);
  assert.match(texts[0]!, /^IN TRADE 46m 00s · since \d\d:\d\d$/);
  assert.equal(texts[1], 'IN TRADE 46m 00s');
  assert.equal(texts[2], '46m 00s');
  assert.ok(texts[0]!.length > texts[1]!.length && texts[1]!.length > texts[2]!.length, 'each step is shorter than the last');
  const won = { id: 'x', symbol: 'GC', playbook: 'failed-auction', stage: 'won', triggeredAt: now - 31 * 60_000, endedAt: now - 6 * 60_000 } as never;
  assert.deepEqual(([0, 1, 2] as const).map((l) => stageClock(won, now, l)!.text), ['TARGET 6m 00s ago · ran 25m 00s', 'TARGET 6m 00s ago', '6m 00s ago']);
  assert.equal(stageClock({ id: 'x', symbol: 'GC', playbook: 'failed-auction', stage: 'ready', stageSince: now - 200_000 } as never, now, 2)!.text, '3m 20s');
});
