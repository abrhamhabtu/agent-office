import * as THREE from 'three';
import { mesh, roundedBox, toon } from './toon';

// The complete input set is symmetric about the monitor pair's center. Mouse space is on the right.
const KEYBOARD_X = -.11;
const MOUSE_X = .38;
const Z = .23;
interface Keycap { x: number; z: number; w: number; d: number; label: string }
const keycaps: Keycap[] = [];
const unit = .043;
function row(labels: string[], widths: number[], z: number, d = .031) {
  const total = widths.reduce((n, w) => n + w, 0) * unit;
  let x = KEYBOARD_X - total / 2;
  labels.forEach((label, i) => {
    const w = widths[i]! * unit;
    keycaps.push({ x: x + w / 2, z: Z + z, w: w - .004, d, label });
    x += w;
  });
}
row(['Esc', ...Array.from({length: 12}, (_, i) => `F${i + 1}`), 'Del'], Array(14).fill(1), -.097, .022);
row(['`','1','2','3','4','5','6','7','8','9','0','-','=','⌫'], [...Array(13).fill(1), 1.5], -.061);
row(['Tab','Q','W','E','R','T','Y','U','I','O','P','[',']','\\'], [1.5,...Array(13).fill(1)], -.024);
row(['Caps','A','S','D','F','G','H','J','K','L',';',"'",'Enter'], [1.75,...Array(11).fill(1),1.75], .013);
row(['Shift','Z','X','C','V','B','N','M',',','.','/','Shift','↑'], [2,...Array(10).fill(1),1.5,1], .050);
row(['Ctrl','Alt','Cmd','','Cmd','Alt','←','↓','→'], [1.25,1.25,1.25,6,1.25,1,1,1,1], .087);

let legends: THREE.Texture | null = null;
function keyboardLegends() {
  if (legends) return legends;
  const canvas = document.createElement('canvas');
  canvas.width = 1440;
  canvas.height = 500;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#e1e7ed';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (const k of keycaps) {
    g.font = `${k.label.length > 1 ? 17 : 25}px ui-monospace, Menlo, monospace`;
    // Plane top-left is the keyboard's back-left once laid flat on the desk.
    g.fillText(k.label, (k.x - KEYBOARD_X + .36) / .72 * canvas.width, (k.z - Z + .125) / .25 * canvas.height);
  }
  legends = new THREE.CanvasTexture(canvas);
  legends.colorSpace = THREE.SRGBColorSpace;
  legends.anisotropy = 8;
  return legends;
}

/** One keyboard, palm rest and ergonomic mouse per desk, independent of who occupies the seat. */
export function buildDeskInput(labelTexture = keyboardLegends()) {
  const group = new THREE.Group();
  group.name = 'Centered keyboard and mouse';
  const shell = toon('#283341');
  group.add(mesh(roundedBox(.72, .03, .25, .017), shell, KEYBOARD_X, .015, Z, false));
  const caps = new THREE.InstancedMesh(roundedBox(1, 1, 1, .12), toon('#485767'), keycaps.length);
  caps.name = 'Raised keyboard keys';
  const pose = new THREE.Object3D();
  keycaps.forEach((k, i) => {
    pose.position.set(k.x, .037, k.z);
    pose.scale.set(k.w, .012, k.d);
    pose.updateMatrix(); caps.setMatrixAt(i, pose.matrix);
  });
  caps.instanceMatrix.needsUpdate = true;
  group.add(caps);
  const letters = new THREE.Mesh(new THREE.PlaneGeometry(.72, .25), new THREE.MeshBasicMaterial({ map: labelTexture, transparent: true, depthWrite: false, toneMapped: false }));
  letters.rotation.x = -Math.PI / 2;
  letters.position.set(KEYBOARD_X, .044, Z);
  group.add(letters);
  group.add(mesh(roundedBox(.7, .012, .065, .01), toon('#667484'), KEYBOARD_X, .006, Z + .164, false));
  group.add(mesh(roundedBox(.18, .004, .27, .025), toon('#667484'), MOUSE_X, .002, Z, false));
  const mouse = new THREE.Group();
  mouse.name = 'Mouse with buttons and scroll wheel';
  mouse.position.set(MOUSE_X, .004, Z);
  const body = mesh(new THREE.SphereGeometry(1, 16, 12), shell, 0, .026, 0, false);
  body.scale.set(.055, .026, .078);
  mouse.add(body);
  const buttons = toon('#c4cdd6');
  for (const side of [-1, 1]) mouse.add(mesh(roundedBox(.032, .009, .047, .008), buttons, side * .020, .048, -.023, false));
  const wheel = mesh(new THREE.CylinderGeometry(.009, .009, .012, 10), toon('#17232d'), 0, .050, -.020, false);
  wheel.rotation.z = Math.PI / 2;
  mouse.add(wheel);
  group.add(mouse);
  return group;
}
