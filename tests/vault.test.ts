import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseAlert } from '../src/server/trading/desk.ts';
import { VWAP_DB_V1_0_0, VWAP_DB_V1_0_1 } from '../src/server/trading/pine-seed.ts';
import { bumpVersion, Vault } from '../src/server/trading/vault.ts';

const fresh = (t: { after: (f: () => void) => void }) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vault-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, vault: new Vault(dir) };
};
const PINE = (n: number) => `//@version=6\nindicator("Test ${n}")\nplot(close + ${n})\n`;

test('the vault starts with the owner’s script, v1.0.0 live exactly as pasted, and v1.0.1 as a candidate', (t) => {
  const { vault } = fresh(t);
  const script = vault.view().scripts.find((s) => s.id === 'vwap-double-break')!;
  assert.ok(script);
  assert.deepEqual(script.versions.map((v) => [v.version, v.status]), [['1.0.1', 'candidate'], ['1.0.0', 'live']]);
  assert.ok(script.versions.every((v) => v.intact));
  assert.equal(vault.source('vwap-double-break', '1.0.0'), VWAP_DB_V1_0_0);
  assert.equal(vault.live('vwap-double-break'), '1.0.0');
  // The raw string kept the escaped quotes of the alert message byte for byte.
  assert.ok(VWAP_DB_V1_0_0.includes('"{\\"ticker\\":\\""'));
  assert.ok(VWAP_DB_V1_0_0.includes('alert(jsonMsg("LONG", "NY_VWAP_SECOND_BREAK"), alert.freq_once_per_bar_close)'));
});

test('v1.0.1 differs from v1.0.0 only by the version comment and the "ver" field in the alert', () => {
  const a = VWAP_DB_V1_0_0.split('\n');
  const b = VWAP_DB_V1_0_1.split('\n');
  assert.equal(b.length, a.length + 1);
  const changed = b.filter((line) => !a.includes(line));
  assert.equal(changed.length, 2);
  assert.ok(changed.some((l) => l.includes('"ver\\":\\"1.0.1')));
  assert.equal(VWAP_DB_V1_0_1.replace('"{\\"ver\\":\\"1.0.1\\",\\"ticker', '"{\\"ticker').split('\n').filter((l) => !l.startsWith('// VWAP Double Break Suite v1.0.1')).join('\n'), VWAP_DB_V1_0_0);
});

test('seeding twice changes nothing, and the vault reopens from disk', (t) => {
  const { dir, vault } = fresh(t);
  vault.setStatus('vwap-double-break', '1.0.1', 'live');
  const again = new Vault(dir);
  assert.equal(again.live('vwap-double-break'), '1.0.1');
});

test('only one version is live; going live retires the old one, and a rollback is allowed', (t) => {
  const { vault } = fresh(t);
  assert.equal(vault.setStatus('vwap-double-break', '1.0.1', 'live'), undefined);
  const v = () => Object.fromEntries(vault.view().scripts[0]!.versions.map((x) => [x.version, x.status]));
  assert.deepEqual(v(), { '1.0.1': 'live', '1.0.0': 'retired' });
  assert.equal(vault.setStatus('vwap-double-break', '1.0.0', 'live'), undefined);
  assert.deepEqual(v(), { '1.0.1': 'retired', '1.0.0': 'live' });
  assert.match(vault.setStatus('vwap-double-break', '9.9.9', 'live')!, /No such version/);
  assert.match(vault.setStatus('vwap-double-break', '1.0.0', 'banana')!, /Unknown status/);
});

test('a version whose file was changed can’t go live, and is flagged', (t) => {
  const { dir, vault } = fresh(t);
  writeFileSync(path.join(dir, 'vwap-double-break', 'v1.0.1.pine'), VWAP_DB_V1_0_1 + '\n// sneaky edit\n');
  const fresh2 = new Vault(dir);
  assert.equal(fresh2.view().scripts[0]!.versions.find((x) => x.version === '1.0.1')!.intact, false);
  assert.match(fresh2.setStatus('vwap-double-break', '1.0.1', 'live')!, /fingerprint/);
  assert.equal(fresh2.live('vwap-double-break'), '1.0.0');
  void vault;
});

test('a new version is a new dated file: bumped, with its parent and changelog, never live on its own', (t) => {
  const { dir, vault } = fresh(t);
  const r = vault.addVersion('vwap-double-break', { source: PINE(1), changelog: 'OR 20 minutes\nStop room 1.5', bump: 'minor' });
  assert.deepEqual(r, { version: '1.1.0' });
  const v = vault.view().scripts[0]!.versions[0]!;
  assert.equal(v.version, '1.1.0');
  assert.equal(v.status, 'candidate');
  assert.equal(v.parent, '1.0.0', 'made from what is live');
  assert.deepEqual(v.changelog, ['OR 20 minutes', 'Stop room 1.5']);
  assert.match(v.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(vault.live('vwap-double-break'), '1.0.0');
  assert.equal(readFileSync(path.join(dir, 'vwap-double-break', 'v1.1.0.pine'), 'utf8'), PINE(1));
  assert.deepEqual(vault.addVersion('vwap-double-break', { source: PINE(2), changelog: 'x', status: 'experiment' }), { version: '1.1.1' });
  assert.equal(vault.view().scripts[0]!.versions[0]!.status, 'experiment');
});

test('bad versions are refused: not Pine, no changelog, too big, a repeat', (t) => {
  const { vault } = fresh(t);
  const err = (o: object) => {
    const r = vault.addVersion('vwap-double-break', { source: PINE(3), changelog: 'ok', ...o });
    return 'error' in r ? r.error : null;
  };
  assert.match(err({ source: 'hello' })!, /Pine/);
  assert.match(err({ source: '' })!, /Paste/);
  assert.match(err({ changelog: '  ' })!, /what changed/);
  assert.match(err({ source: '//@version=6\n' + 'x'.repeat(250_000) })!, /too big/);
  assert.match(err({ source: VWAP_DB_V1_0_0 })!, /same source as v1\.0\.0/);
  assert.match((vault.addVersion('nope', { source: PINE(4), changelog: 'x' }) as { error: string }).error, /No such script/);
});

test('version numbers bump and order like semver', () => {
  assert.equal(bumpVersion(undefined, 'patch'), '1.0.0');
  assert.equal(bumpVersion('1.9.3', 'patch'), '1.9.4');
  assert.equal(bumpVersion('1.9.3', 'minor'), '1.10.0');
  assert.equal(bumpVersion('1.9.3', 'major'), '2.0.0');
});

test('another script can be added to the vault, starting as an experiment', (t) => {
  const { vault } = fresh(t);
  const r = vault.addScript({ name: 'Supply & Demand Zones', summary: 'Octavia’s zones', source: PINE(5), changelog: 'First version' });
  assert.deepEqual(r, { id: 'supply-demand-zones' });
  const s = vault.view().scripts.find((x) => x.id === 'supply-demand-zones')!;
  assert.deepEqual(s.versions.map((v) => [v.version, v.status]), [['1.0.0', 'experiment']]);
  assert.equal(vault.live('supply-demand-zones'), null);
  assert.match((vault.addScript({ name: 'Supply & Demand Zones', source: PINE(6) }) as { error: string }).error, /already/);
  // A bad first version leaves nothing behind.
  assert.match((vault.addScript({ name: 'Broken', source: 'nope' }) as { error: string }).error, /Pine/);
  assert.equal(vault.view().scripts.some((x) => x.id === 'broken'), false);
});

test('an alert says which Pine version sent it', () => {
  assert.equal(parseAlert('{"ver":"1.0.1","ticker":"NQ1!","price":1,"event_type":"NY_VWAP_SECOND_BREAK","side":"LONG"}').ver, '1.0.1');
  assert.equal(parseAlert('{"ticker":"NQ1!","price":1,"event_type":"NY_VWAP_SECOND_BREAK","side":"LONG"}').ver, null);
  assert.equal(parseAlert('{"ver":"latest","ticker":"NQ1!"}').ver, null);
});

test('the lab’s version: live’s script with one change, stamped, dated, marked new, never live, and never made twice', async (t) => {
  const { vault } = fresh(t);
  const { readParams } = await import('../src/server/trading/lab.ts');
  const { V1_PARAMS } = await import('../src/server/trading/pine-sim.ts');
  const params = { ...V1_PARAMS, orMinutes: 20 };
  const test = { ranAt: 1, from: '2026-09-01', to: '2026-09-28', days: 20, symbols: ['NQ', 'GC', 'ES'] as ('NQ' | 'GC' | 'ES')[], all: { trades: 41, wins: 20, winRate: 0.49, totalR: 12.3, avgR: 0.3, maxDrawdownR: 4, stdR: 1.5, profitFactor: 1.6, dollars: 900 }, inSample: { trades: 28, wins: 13, winRate: 0.46, totalR: 7, avgR: 0.25, maxDrawdownR: 4, stdR: 1.5, profitFactor: 1.4, dollars: 500 }, outSample: { trades: 13, wins: 7, winRate: 0.54, totalR: 5.3, avgR: 0.41, maxDrawdownR: 2, stdR: 1.5, profitFactor: 2.1, dollars: 400 }, bySymbol: {}, params, vs: { version: '1.0.0', dAvgR: 0.2, dTotalR: 6.1, verdict: 'better' as const, reason: 'Average +0.20 R better per trade, and it held up on the later days (+0.41 R against +0.10 R)', confidence: 'medium' as const } };
  assert.equal(vault.triedParams('vwap-double-break', params), false);
  const r = vault.addFromLab('vwap-double-break', { from: '1.0.0', params, change: ['Opening range 20 minutes (was 15)'], test });
  assert.deepEqual(r, { version: '1.1.0' });
  const v = vault.view().scripts[0]!.versions.find((x) => x.version === '1.1.0')!;
  assert.equal(v.status, 'candidate');
  assert.equal(v.by, 'lab');
  assert.equal(v.fresh, true);
  assert.equal(v.parent, '1.0.0');
  assert.equal(v.test!.all.trades, 41);
  assert.match(v.changelog.join('\n'), /Opening range 20 minutes \(was 15\)/);
  assert.match(v.changelog.join('\n'), /Replayed on 20 sessions/);
  assert.match(v.changelog.join('\n'), /Made by the test lab/);
  const src = vault.source('vwap-double-break', '1.1.0')!;
  assert.equal(readParams(src)!.orMinutes, 20);
  assert.ok(src.includes('\\"ver\\":\\"1.1.0\\"'));
  assert.equal(vault.live('vwap-double-break'), '1.0.0', 'never live on its own');
  assert.equal(vault.triedParams('vwap-double-break', params), true, 'the lab won’t make it again');
  assert.equal(vault.markSeen('vwap-double-break', '1.1.0'), undefined);
  assert.equal(vault.view().scripts[0]!.versions.find((x) => x.version === '1.1.0')!.fresh, false);
  assert.match(vault.markSeen('vwap-double-break', '9.9.9')!, /No such version/);
});

test('the lab can’t make a version from something that isn’t the script, and test results are kept with a version', (t) => {
  const { vault } = fresh(t);
  vault.addScript({ name: 'Other', source: PINE(9), changelog: 'x' });
  const fake = { ranAt: 1, from: 'a', to: 'b', days: 1, symbols: [], all: {} as never, inSample: {} as never, outSample: {} as never, bySymbol: {}, params: {} as never, vs: null };
  assert.match((vault.addFromLab('other', { from: '1.0.0', params: { orMinutes: 20, stopBuffer: 1, maxLoss: 325, rMultiple: 2, window: '1000-1200', recovery: true }, change: ['x'], test: fake }) as { error: string }).error, /settings/);
  vault.setTest('vwap-double-break', '1.0.0', { ...fake, days: 22 });
  assert.equal(vault.view().scripts.find((x) => x.id === 'vwap-double-break')!.versions.find((x) => x.version === '1.0.0')!.test!.days, 22);
  vault.setLab({ running: true, note: 'testing' });
  assert.deepEqual([vault.view().lab.running, vault.view().lab.note], [true, 'testing']);
});

test('a script is tied to the playbook it is the TradingView version of, so the desk can put them together', (t) => {
  const { vault } = fresh(t);
  assert.equal(vault.view().scripts.find((s) => s.id === 'vwap-double-break')!.playbook, 'double-break');
  assert.deepEqual(vault.addScript({ name: 'Failed Auction Pine', source: PINE(7), changelog: 'x', playbook: 'failed-auction' }), { id: 'failed-auction-pine' });
  assert.equal(vault.view().scripts.find((s) => s.id === 'failed-auction-pine')!.playbook, 'failed-auction');
  // Not a playbook: kept, but not linked.
  vault.addScript({ name: 'Mine', source: PINE(8), changelog: 'x', playbook: 'not-a-playbook' });
  assert.equal(vault.view().scripts.find((s) => s.id === 'mine')!.playbook, null);
  assert.equal(vault.versionWithParams('vwap-double-break', { nope: 1 }), null);
});
