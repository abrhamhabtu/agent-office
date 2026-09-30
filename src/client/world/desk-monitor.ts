import * as THREE from 'three';
import { mesh, roundedBox, toon } from './toon';

export const DESK_MONITOR = { width: 0.86, height: 0.86 * 360 / 640, x: 0.49, z: -0.31 } as const;

/** Matching displays, with their bases at desk height. The terminal adds a keyboard below. */
export function buildDeskMonitor(texture: THREE.Texture): { group: THREE.Group; face: THREE.Mesh } {
  const group = new THREE.Group();
  const { width: w, height: h } = DESK_MONITOR;
  const frame = toon('#1b2033');
  const panel = new THREE.Group();
  panel.position.y = 0.19 + h / 2;
  panel.add(mesh(roundedBox(w + 0.06, h + 0.06, 0.05, 0.02), frame, 0, 0, 0));
  const face = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }));
  face.position.z = 0.028;
  panel.add(face);
  panel.add(mesh(new THREE.BoxGeometry(w - 0.12, 0.012, 0.014), toon('#64dfd2'), 0, -h / 2 - 0.018, 0.03, false));
  group.add(panel);
  group.add(mesh(new THREE.BoxGeometry(0.05, 0.18, 0.05), frame, 0, 0.1, -0.03, false));
  group.add(mesh(roundedBox(0.3, 0.025, 0.2, 0.01), frame, 0, 0.013, -0.01, false));
  return { group, face };
}
