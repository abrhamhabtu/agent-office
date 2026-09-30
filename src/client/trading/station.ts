import * as THREE from 'three';
import { SESSION_STATION as S } from '../../shared/layout';
import type { FloorRole, TradingSnapshot } from '../../shared/trading';
import { buildDeskMonitor } from '../world/desk-monitor';
import type { Collider, Interactable } from '../world/office';
import { mesh, roundedBox, textPlane, toon } from '../world/toon';
import { paintLaptopChart, Screen } from './screens';

class SessionScreen extends Screen {
  constructor() { super(640, 360); }
  draw(s: TradingSnapshot, _role: FloorRole, _now: number) {
    paintLaptopChart(this.g, this.W, this.H, s, s.markets[0] ?? 'NQ');
  }
}

/** A shared session dashboard, separate from the seats where agents work. */
export function buildSessionStation() {
  const screen = new SessionScreen();
  const group = new THREE.Group();
  group.position.set(S.x, 0, S.z);
  const frame = toon('#1b2033');
  group.add(mesh(roundedBox(.8, .08, S.depth, .05), frame, 0, .04, 0));
  group.add(mesh(roundedBox(.18, .94, .18, .04), frame, 0, .53, -.04));
  group.add(mesh(roundedBox(S.width, .08, S.depth, .04), toon('#e8eadc'), 0, 1.04, 0));
  const monitor = buildDeskMonitor(screen.texture);
  monitor.group.scale.setScalar(1.4);
  monitor.group.position.set(0, 1.08, -.12);
  group.add(monitor.group);
  const name = textPlane('Session Desk', { size: 36, bg: '#1b2033', color: '#64dfd2', border: '#64dfd2' });
  name.position.set(0, 2.3, -.08);
  group.add(name);
  const prompt = textPlane('E  Open session', { size: 20, bg: '#1b2033', color: '#ffffff' });
  prompt.position.set(0, 1.05, .37);
  group.add(prompt);
  const interact: Interactable = { kind: 'session-desk', x: S.x, z: S.approachZ, radius: 2.8 };
  group.userData.interact = interact;
  const collider: Collider = { minX: S.x - S.width / 2, maxX: S.x + S.width / 2, minZ: S.z - S.depth / 2, maxZ: S.z + S.depth / 2, top: 2.1 };
  return { group, screen, interact, collider };
}
