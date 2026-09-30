import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildDeskMonitor, DESK_MONITOR } from '../src/client/world/desk-monitor';
import { DESK_SIZE } from '../src/shared/layout';

test('matching screens fit side by side on a desk with clear panels above the tabletop', () => {
  const left = buildDeskMonitor(new THREE.Texture());
  const right = buildDeskMonitor(new THREE.Texture());
  left.group.position.x = -DESK_MONITOR.x;
  right.group.position.x = DESK_MONITOR.x;
  const l = new THREE.Box3().setFromObject(left.group);
  const r = new THREE.Box3().setFromObject(right.group);
  assert.ok(!l.intersectsBox(r), 'monitor frames must not overlap');
  assert.ok(l.min.x > -DESK_SIZE.width / 2 && r.max.x < DESK_SIZE.width / 2, 'both monitors fit the desk');
  const panel = new THREE.Box3().setFromObject(left.face);
  assert.ok(panel.min.y > .15, 'panel clears the tabletop and keyboard');
  assert.equal(new THREE.Box3().setFromObject(right.face).getSize(new THREE.Vector3()).y, panel.getSize(new THREE.Vector3()).y);
});

test('keyboard and mouse form one centered input set with room in front of both monitors', async () => {
  const { buildDeskInput } = await import('../src/client/world/desk-input');
  const input = buildDeskInput(new THREE.Texture());
  const bounds = new THREE.Box3().setFromObject(input);
  assert.ok(Math.abs(bounds.min.x + bounds.max.x) < 0.00001, 'the complete set is centered between monitor centers');
  assert.ok(bounds.min.x > -DESK_SIZE.width / 2 && bounds.max.x < DESK_SIZE.width / 2);
  assert.ok(bounds.max.z < DESK_SIZE.depth / 2, 'keyboard palm rest stays on the desk');
  assert.ok(bounds.min.z > DESK_MONITOR.z + .1, 'keyboard clears the monitor bases');
  assert.ok(bounds.min.y > -0.000001, 'mouse and keyboard sit above the tabletop');
});
