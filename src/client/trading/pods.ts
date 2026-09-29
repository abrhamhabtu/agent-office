import * as THREE from 'three';
import { DESKS } from '../../shared/layout';
import type { FloorRole, TradingSnapshot } from '../../shared/trading';
import { PODS } from '../../shared/trading';
import { mesh, textPlane, toon } from '../world/toon';
import { PodScreen } from './screens';

// A screen hung over the middle of each pod of four desks, the way a trading floor hangs its monitors: both
// sides show the same thing, so either row looks up at it. On Opening Bell each pod's screen is its
// playbook live (VWAP, zones, the volume profile) or the prop accounts; on Back Office, equity curves and
// the paper book. A sign on top names the pod, and flashes when a TradingView alert rings for it.

const W = 3.6;
const H = W * (460 / 1024);
const Y = 3.55;

export interface PodScreens {
  group: THREE.Group;
  render(s: TradingSnapshot | null, role: FloorRole): void;
  /** Lights a pod's sign up for a while (a TradingView alert for its playbook). */
  flash(pod: number): void;
}

export function buildPodScreens(): PodScreens {
  const group = new THREE.Group();
  const screens: PodScreen[] = [];
  const signs: { holder: THREE.Group; text: string; sign: THREE.Group | null }[] = [];
  const flashUntil = [0, 0, 0, 0];
  const frame = toon('#1b2033');
  const rod = toon('#8d99ae');
  for (let pod = 0; pod < 4; pod++) {
    const desks = DESKS.slice(pod * 4, pod * 4 + 4);
    const x = desks.reduce((a, d) => a + d.x, 0) / desks.length;
    const z = desks.reduce((a, d) => a + d.z, 0) / desks.length;
    const screen = new PodScreen(pod);
    screens.push(screen);
    const holder = new THREE.Group();
    holder.position.set(x, Y, z);
    holder.add(mesh(new THREE.BoxGeometry(W + 0.14, H + 0.14, 0.12), frame, 0, 0, 0, false));
    const mat = new THREE.MeshBasicMaterial({ map: screen.texture, toneMapped: false });
    for (const side of [1, -1]) {
      const face = new THREE.Mesh(new THREE.PlaneGeometry(W, H), mat);
      face.position.z = side * 0.065;
      face.rotation.y = side > 0 ? 0 : Math.PI;
      holder.add(face);
    }
    // Two rods up to the ceiling.
    for (const dx of [-W / 3, W / 3]) holder.add(mesh(new THREE.CylinderGeometry(0.02, 0.02, 3), rod, dx, H / 2 + 1.5, 0, false));
    group.add(holder);
    signs.push({ holder, text: '', sign: null });
  }

  const setSign = (i: number, text: string, bg: string) => {
    const s = signs[i]!;
    const key = `${text}|${bg}`;
    if (s.text === key) return;
    if (s.sign) {
      s.holder.remove(s.sign);
      const face = s.sign.children[0] as THREE.Mesh;
      face.geometry.dispose();
      (face.material as THREE.MeshBasicMaterial).map?.dispose();
      (face.material as THREE.Material).dispose();
    }
    const sign = new THREE.Group();
    const front = textPlane(text, { bg, size: 56 });
    front.scale.multiplyScalar(0.9);
    const back = front.clone();
    back.rotation.y = Math.PI;
    front.position.z = 0.07;
    back.position.z = -0.07;
    sign.add(front, back);
    sign.position.y = H / 2 + 0.3;
    s.holder.add(sign);
    s.sign = sign;
    s.text = key;
  };

  return {
    group,
    render(s, role) {
      const now = Date.now();
      PODS[role].forEach((p, i) => setSign(i, `${p.icon} ${p.name}`, flashUntil[i]! > now && Math.floor(now / 400) % 2 === 0 ? '#ffd166' : '#fffaf3'));
      for (const sc of screens) sc.render(s, role);
    },
    flash(pod) {
      flashUntil[pod] = Date.now() + 12_000;
    },
  };
}
