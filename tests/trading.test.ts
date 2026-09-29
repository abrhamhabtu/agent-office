import assert from 'node:assert/strict';
import test from 'node:test';
import type { Bar, PaperTrade } from '../src/shared/trading.ts';
import { floorRole, lawOf10, microsFor, PROP_ACCOUNTS, seatJob } from '../src/shared/trading.ts';
import { Profile, replayDay, sessionMinute, tradingDay } from '../src/server/trading/engine.ts';
import { parseAlert, playbookFor, sessionAt, simulateEval } from '../src/server/trading/desk.ts';
import { parseChart } from '../src/server/trading/market.ts';
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
