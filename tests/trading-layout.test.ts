import test from 'node:test';
import assert from 'node:assert/strict';
import { BOARDS, DESKS, ELEVATOR, FLOOR, GONG, HIREABLE_DESKS, WING, WING_DESKS, beanbagsOut, nextFreeSeat } from '../src/shared/layout.js';
import { BUILTIN_MAPS, planMap } from '../src/shared/maps/index.js';
import { walkable, wayHome } from '../src/shared/nav.js';

test('north-wall displays, elevator and opening bell stay clear of the expandable wing', () => {
  const shaftLeft = ELEVATOR.x - ELEVATOR.width / 2;
  const shaftRight = ELEVATOR.x + ELEVATOR.width / 2;
  assert.ok(BOARDS.pulls.x + BOARDS.pulls.width / 2 + 0.4 < shaftLeft, 'proposals stay visible beside the shaft');
  assert.ok(shaftRight + 0.4 < GONG.x - GONG.width / 2, 'the bell has space beside the shaft');
  assert.ok(GONG.x + GONG.width / 2 + 0.4 < WING.minX, 'the bell and elevator leave the wing entrance open');
});

test('ordinary hires preserve resident desks and fill an expanded wing before overflow seats', () => {
  const occupied = new Set(HIREABLE_DESKS.map((d) => d.id));
  const taken = (id: string) => occupied.has(id);
  assert.equal(nextFreeSeat(taken, 0)?.beanbag, true);
  assert.equal(nextFreeSeat(taken, 1)?.id, WING_DESKS[0].id);
  assert.equal(beanbagsOut(taken, 1).size, 0);
  for (const d of WING_DESKS.filter((d) => d.wing === 1)) occupied.add(d.id);
  assert.equal(nextFreeSeat(taken, 1)?.beanbag, true);
  assert.equal(nextFreeSeat(taken, 2)?.id, WING_DESKS.find((d) => d.wing === 2)?.id);
  assert.ok(DESKS.filter((d) => d.station).every((d) => !occupied.has(d.id)));
});

test('resident desk roles remain the same when the building changes maps', () => {
  const residents = DESKS.filter((d) => d.station);
  assert.equal(residents.length, 7, 'Chief, Tape, Levels, Risk, Backtest, Paper and the Pine Keeper');
  for (const map of BUILTIN_MAPS) {
    const plan = planMap(map);
    for (const d of residents) assert.equal(plan.byId.get(d.id)?.station, d.station);
  }
});

test('resident advisers leave their seated desks using clear routes rather than kiosk paths', () => {
  for (const d of DESKS.filter((d) => d.station)) {
    const path = wayHome(d);
    const out = path.findIndex(([x]) => x < FLOOR.minX);
    assert.ok(out > 1, `${d.id} reaches the exit`);
    for (let i = 2; i < out; i++) {
      const [a, b] = [path[i - 1], path[i]];
      const steps = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.2);
      for (let n = 0; n <= steps; n++) assert.ok(walkable(a[0] + (b[0] - a[0]) * n / steps, a[1] + (b[1] - a[1]) * n / steps), `${d.id} has a clear route`);
    }
  }
});

test('session kiosk has an accessible approach and navigation avoids its footprint', async () => {
  const { SESSION_STATION: kiosk } = await import('../src/shared/layout');
  const { officeNav } = await import('../src/shared/nav');
  const nav = officeNav();
  assert.equal(nav.walkable(kiosk.x, kiosk.z), false);
  assert.equal(nav.walkable(kiosk.x, kiosk.approachZ), true);
  assert.ok(nav.route([5, 4.5], [kiosk.x, kiosk.approachZ]).length > 1);
  assert.equal(nav.walkable(8.5, kiosk.z), true, 'elevator aisle remains clear');
});
