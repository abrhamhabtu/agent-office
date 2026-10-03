import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Bar, PaperTrade } from '../src/shared/trading.ts';
import { PROP_ACCOUNTS } from '../src/shared/trading.ts';
import { act, buildMenu, cleanProbs, CRYPTO_RULES, designDraft, endDay, futuresRules, houseProbs, houseVerdict, newTrader, onBar, parseRules, sizeFor, starters, Tape, type MarketView, type Moment, type Signal, type TraderState } from '../src/shared/arena.ts';
import { Arena } from '../src/server/trading/arena.ts';

const RULES = futuresRules(PROP_ACCOUNTS.find((a) => a.id === 'lucidflex-50k')!);
const T0 = Date.parse('2026-09-08T14:00:00Z');
const bar = (i: number, close: number, spread = 2): Bar => ({ ts: T0 + i * 60_000, open: close, high: close + spread, low: close - spread, close, volume: 100 });
const view = (market: string, last: number, over: Partial<MarketView> = {}): MarketView => ({ market, ts: T0, last, prevClose: last, barHigh: last + 1, barLow: last - 1, open: last, bars: 100, vwap: last, sd: 5, ema9: last, ema21: last, ema50: last, atr: 10, rsi: 50, orHigh: null, orLow: null, donHigh: last + 20, donLow: last - 20, ...over });
const at = (over: Partial<Moment> = {}): Moment => ({ league: 'futures', ts: T0, day: '2026-09-08', minute: 420, canEnter: true, mustFlatten: false, sessionOpen: 390, ...over });
const trader = (rules = 'Trade the Support & Resistance playbook.'): TraderState => {
  const t = newTrader({ ...starters('futures', 0)[1]!, rules }, RULES);
  t.day = '2026-09-08';
  return t;
};
const signal = (side: 'long' | 'short' = 'long'): Signal => ({ engine: 'support-resistance', market: 'NQ', side, stop: side === 'long' ? 19980 : 20020, target: side === 'long' ? 20040 : 19960, why: 'Bounced off the level' });

test('a trader’s rules: the parts code holds it to', () => {
  assert.deepEqual(parseRules('Longs only. Two trades a day. Nothing in the first 30 minutes. No entries after 10:30.'), { side: 'long', maxTrades: 2, waitMinutes: 30, lastEntry: 630 });
  assert.deepEqual(parseRules('Trade whatever is clean.'), { side: null, maxTrades: null, waitMinutes: 0, lastEntry: null });
  assert.equal(parseRules('never shorts, one and done').side, 'long');
  assert.equal(parseRules('never shorts, one and done').maxTrades, 1);
});

test('the tape looks at nothing ahead of the bar it was last given', () => {
  const a = new Tape('NQ');
  const b = new Tape('NQ');
  const bars = Array.from({ length: 90 }, (_, i) => bar(i, 20000 + Math.sin(i / 5) * 30));
  bars.slice(0, 60).forEach((x, i) => a.push(x, i === 0));
  bars.forEach((x, i) => (i < 60 ? b.push(x, i === 0) : null));
  assert.deepEqual(a.view(), b.view());
  assert.equal(a.warm, true);
  // The opening range is the first fifteen bars and does not move after.
  const v = a.view()!;
  assert.equal(v.orHigh, Math.max(...bars.slice(0, 15).map((x) => x.high)));
});

test('a futures trader is offered its own playbook’s setups, and sitting out is always on the menu', () => {
  const t = trader();
  const views = new Map([['NQ', view('NQ', 20000)]]);
  const menu = buildMenu(t, views, at({ signals: [signal(), { ...signal(), engine: 'failed-auction' }] }), RULES);
  assert.deepEqual(menu.options.map((o) => o.label), ['S_R_LONG_NQ', 'PASS']);
  // Its rules take a side off the menu before any brain sees it.
  t.def = { ...t.def, rules: 'Shorts only.' };
  assert.equal(buildMenu(t, views, at({ signals: [signal()] }), RULES).options.length, 0);
  // Nothing to choose late in the session.
  t.def = { ...t.def, rules: '' };
  assert.equal(buildMenu(t, views, at({ canEnter: false, signals: [signal()] }), RULES).options.length, 0);
});

test('the risk desk sizes an entry off the cushion and refuses one a single micro cannot afford', () => {
  const t = trader();
  const open = { kind: 'open' as const, market: 'NQ', side: 'long' as const, stop: 19980, target: 20040 };
  // $2,000 of cushion, 12% of it at risk, a 20-point stop at $2 a point: six micros.
  assert.deepEqual(sizeFor(t, open, 20000, 0.9, RULES), { qty: 6, risk: 240, why: '' });
  // An unsure pick is sized down, never up.
  assert.equal(sizeFor(t, open, 20000, 0.4, RULES).qty, 3);
  // $100 above the floor: 12% of that cannot carry one micro's $40.
  t.equity = t.floor + 100;
  t.dayStart = t.equity;
  const refused = sizeFor(t, open, 20000, 0.9, RULES);
  assert.equal(refused.qty, 0);
  assert.match(refused.why, /one MNQ risks \$40: more than the \$12/);
  // And nothing more once the day's loss limit is spent.
  t.dayStart = 50000;
  assert.match(sizeFor(t, open, 20000, 0.9, RULES).why, /more than the \$0/);
  const views = new Map([['NQ', view('NQ', 20000)]]);
  const menu = buildMenu(trader(), views, at({ signals: [signal()] }), RULES);
  assert.equal(act(t, menu.options[0]!, 0.9, views, at(), RULES).did, 'veto');
  assert.equal(t.pos, null);
});

test('a stop fills before a target on the same bar, and two losses send a trader home', () => {
  const t = trader();
  const views = new Map([['NQ', view('NQ', 20000)]]);
  const menu = buildMenu(t, views, at({ signals: [signal()] }), RULES);
  assert.equal(act(t, menu.options[0]!, 0.9, views, at(), RULES).did, 'open');
  const wide: Bar = { ts: T0 + 60_000, open: 20000, high: 20050, low: 19970, close: 20010, volume: 1 };
  const out = onBar(t, views, new Map([['NQ', wide]]), at({ ts: T0 + 60_000 }), RULES);
  assert.equal(out.decisions[0]!.pick, 'STOPPED');
  assert.equal(t.pos, null);
  assert.equal(t.lossesToday, 1);
  // 6 micros, 20.25 points (the entry is a tick worse than the close), $2 a point, fees both ways.
  assert.equal(Math.round(t.balance), 50000 - 243 - 7);
  t.lossesToday = 2;
  const next = onBar(t, views, new Map(), at({ ts: T0 + 120_000 }), RULES);
  assert.equal(t.cap, 'loss_stop');
  assert.equal(next.banners[0]!.kind, 'sent_home');
  assert.equal(buildMenu(t, views, at({ signals: [signal()] }), RULES).options.length, 0);
});

test('an account through its floor is over, and one with its target, days and consistency is passed', () => {
  const bust = trader();
  bust.balance = bust.equity = bust.floor - 1;
  const out = onBar(bust, new Map(), new Map(), at(), RULES);
  assert.equal(out.banners[0]!.kind, 'busted');
  assert.deepEqual([bust.busts, bust.gen, bust.balance], [1, 2, 50000]);

  const pass = trader();
  pass.balance = pass.equity = 53300;
  pass.dayStart = 52100;
  pass.days = [1000, 1100];
  pass.tradesToday = 1;
  assert.equal(endDay(pass, T0, RULES).banners[0]!.kind, 'passed');
  assert.deepEqual([pass.passes, pass.gen], [1, 2]);

  // The target in one day is not a pass: one day may be at most half the profit.
  const lumpy = trader();
  lumpy.balance = lumpy.equity = 53100;
  lumpy.dayStart = 50000;
  lumpy.tradesToday = 1;
  assert.equal(endDay(lumpy, T0, RULES).banners.length, 0);
  assert.equal(lumpy.passes, 0);
  // The floor trailed the best end of day, and stopped at the start plus the lock.
  assert.equal(lumpy.floor, 50100);
});

test('a brain’s answer is only ever probabilities over the menu it was shown', () => {
  const options = buildMenu(trader(), new Map([['NQ', view('NQ', 20000)]]), at({ signals: [signal()] }), RULES).options;
  assert.deepEqual(cleanProbs({ S_R_LONG_NQ: 60, PASS: 20, BUY_100_CONTRACTS: 900 }, options), { S_R_LONG_NQ: 0.75, PASS: 0.25 });
  assert.equal(cleanProbs({ BUY_100_CONTRACTS: 1 }, options), null);
  assert.equal(cleanProbs('take it', options), null);
  const house = houseProbs(options);
  assert.ok(Math.abs(house.S_R_LONG_NQ! + house.PASS! - 1) < 1e-9);
});

test('a coin’s stop is far enough that the fee is a small part of the risk', () => {
  const t = newTrader(starters('crypto', 0)[0]!, CRYPTO_RULES);
  const v = view('BTC', 84000, { prevClose: 83990, donHigh: 83995, donLow: 83000, atr: 20 });
  const menu = buildMenu(t, new Map([['BTC', v]]), at({ league: 'crypto', sessionOpen: 0 }), CRYPTO_RULES);
  const open = menu.options[0]!.intent;
  assert.equal(open.kind, 'open');
  if (open.kind === 'open') assert.ok(84000 - open.stop >= 84000 * 0.004 - 1e-6);
});

test('a sentence becomes an engine, markets and rules code can enforce', () => {
  const d = designDraft('a patient sniper who trades the double break on NQ, longs only, one trade a day', 'futures');
  assert.deepEqual([d.engine, d.markets, d.patience], ['double-break', ['NQ'], 0.9]);
  assert.deepEqual(parseRules(d.rules), { side: 'long', maxTrades: 1, waitMinutes: 0, lastEntry: null });
  const c = designDraft('a sleepy trader that only buys bitcoin dips', 'crypto');
  assert.deepEqual([c.engine, c.markets], ['reversion', ['BTC']]);
});

test('the Desk Head leaves a trader alone until three losing sessions, and only ever adds a constraint', () => {
  const t = trader('Trade the Support & Resistance playbook. Three trades a day.');
  t.rulesAge = 5;
  t.days = [-100, 200, -50];
  assert.equal(houseVerdict(t), null);
  t.days = [-100, -200, -50];
  const v = houseVerdict(t)!;
  assert.match(v.rules, /Two trades a day\.$/);
  assert.equal(parseRules(v.rules).maxTrades, 2);
  t.rulesAge = 1;
  assert.equal(houseVerdict(t), null);
});

test('the arena plays a recorded session, writes its decisions down and never asks a model unless told to', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'arena-'));
  // Two trading days of a gently rising market: day two's 07:00 PT bar carries a setup.
  const day = (d: number) => Array.from({ length: 400 }, (_, i) => ({ ...bar(i, 20000 + d * 50 + i * 0.2), ts: Date.parse(`2026-09-0${8 + d}T13:00:00Z`) + i * 60_000 }));
  const history: Record<string, Bar[]> = { NQ: [...day(0), ...day(1)], ES: [...day(0), ...day(1)], GC: [...day(0), ...day(1)] };
  const replay = (sym: string, bars: Bar[]): PaperTrade[] => {
    const b = bars[60]!;
    return sym === 'NQ' ? [{ id: 'x', day: '', symbol: 'NQ', playbook: 'support-resistance', side: 'long', entryAt: b.ts, entry: b.close, stop: b.close - 20, target: b.close + 30, exitAt: null, exit: null, outcome: 'open', r: 0, dollars: 0, why: 'Bounced off the level' }] : [];
  };
  const arena = new Arena({ dir, prop: PROP_ACCOUNTS.find((a) => a.id === 'lucidflex-50k')!, history: async (s) => history[s] ?? [], replay, today: () => '2026-12-01', now: () => Date.parse('2026-12-01T00:00:00Z'), claude: '/nonexistent/claude' });
  await arena.play(400);
  const v = arena.view('futures');
  assert.equal(v.tape.sessions, 1);
  assert.equal(v.brain.kind, 'house');
  const ledge = v.traders.find((t) => t.def.engine === 'support-resistance')!;
  assert.equal(ledge.totals.orders >= 1, true);
  const opened = v.decisions.find((d) => d.did === 'open')!;
  assert.equal(opened.pick, 'S_R_LONG_NQ');
  assert.equal(opened.model, 'house');
  // Research replays the same tape off the floor: the floor's own accounts are not touched by it.
  const before = JSON.stringify(arena.view('futures').traders.map((t) => [t.equity, t.totals.orders]));
  const bt = await arena.act({ action: 'backtest', league: 'futures', id: ledge.def.id });
  assert.equal(bt.report!.span, '1 recorded sessions, 2026-09-09 to 2026-09-09');
  assert.equal(bt.report!.trades >= 1, true);
  assert.equal(bt.report!.curve.length, 1);
  const tried = await arena.act({ action: 'backtest', league: 'futures', id: ledge.def.id, rules: 'Shorts only.' });
  assert.equal(tried.report!.trades, 0);
  const lab = await arena.lab('futures');
  assert.equal(lab.cells.length, 15);
  assert.equal(lab.cells.filter((c) => c.trades > 0).map((c) => `${c.engine} ${c.market}`).join(), 'support-resistance NQ');
  assert.equal(JSON.stringify(arena.view('futures').traders.map((t) => [t.equity, t.totals.orders])), before);
  // A model that cannot be reached is refused, and the house brain stays on.
  const r = await arena.act({ action: 'brain', kind: 'claude' });
  assert.match(r.error ?? '', /house brain stays on/);
  assert.equal(arena.view('futures').brain.kind, 'house');
  // The owner's rules are the owner's; a rewrite can be undone only when there is one.
  assert.match((await arena.act({ action: 'undo', league: 'futures', id: ledge.def.id })).error ?? '', /Nothing to undo/);
  assert.equal((await arena.act({ action: 'tape', league: 'crypto', playing: false })).error, 'The crypto tape is live: it cannot be paused or sped up');
});
