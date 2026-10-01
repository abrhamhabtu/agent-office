import * as THREE from 'three';
import { ELEVATOR, ELEVATOR_CAR, ELEVATOR_FRONT, FLOOR, WALL_HEIGHT } from '../../shared/layout';
import { mesh, roundedBox, toon } from './toon';
import type { Collider, Interactable } from './office';

// The elevator: a graphite shaft beside the opening bell, doors facing into the room. Every floor has
// it in the same place; riding it swaps the floor around you while the doors are shut.

const STEEL = '#8798a8';
const STEEL_DARK = '#293b4f';
const ACCENT = '#64dfd2';
/** The face the room sees: near-black graphite, fluted with slightly lighter fins. */
const FACE = '#141d29';
const FIN = '#243246';

/** Brushed aluminium for the doors: a soft vertical sheen with fine grain, and a dark seam where they meet. */
function brushed(seamSide: -1 | 1): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 256;
  const g = c.getContext('2d')!;
  const sheen = g.createLinearGradient(0, 0, 128, 0);
  sheen.addColorStop(0, '#9fb0bf');
  sheen.addColorStop(0.35, '#e6edf3');
  sheen.addColorStop(0.65, '#c3cfda');
  sheen.addColorStop(1, '#8c9dad');
  g.fillStyle = sheen;
  g.fillRect(0, 0, 128, 256);
  g.globalAlpha = 0.07;
  for (let y = 0; y < 256; y += 2) {
    g.fillStyle = y % 4 ? '#ffffff' : '#000000';
    g.fillRect(0, y, 128, 1);
  }
  g.globalAlpha = 1;
  g.fillStyle = '#1b2735';
  g.fillRect(seamSide > 0 ? 0 : 124, 0, 4, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** The display over the doors: a dark glass pill with the floor's name in teal-white, arrows either side. */
function displayTexture(text: string): { tex: THREE.CanvasTexture; w: number; h: number } {
  const w = 640;
  const h = 190;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.shadowColor = ACCENT;
  g.shadowBlur = 18;
  g.fillStyle = '#0a111c';
  g.strokeStyle = ACCENT;
  g.lineWidth = 5;
  g.beginPath();
  g.roundRect(14, 14, w - 28, h - 28, 54);
  g.fill();
  g.stroke();
  g.shadowBlur = 0;
  const inner = g.createLinearGradient(0, 14, 0, h - 14);
  inner.addColorStop(0, 'rgba(100,223,210,0.16)');
  inner.addColorStop(1, 'rgba(100,223,210,0)');
  g.fillStyle = inner;
  g.beginPath();
  g.roundRect(20, 20, w - 40, (h - 40) / 2, 48);
  g.fill();
  g.fillStyle = ACCENT;
  g.globalAlpha = 0.7;
  g.font = `900 38px ui-rounded, system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('▲', 78, h / 2 - 16);
  g.fillText('▼', 78, h / 2 + 18);
  g.fillText('▲', w - 78, h / 2 - 16);
  g.fillText('▼', w - 78, h / 2 + 18);
  g.globalAlpha = 1;
  let size = 82;
  g.font = `800 ${size}px Nunito, ui-rounded, system-ui, sans-serif`;
  while (g.measureText(text).width > w - 260 && size > 34) g.font = `800 ${(size -= 4)}px Nunito, ui-rounded, system-ui, sans-serif`;
  g.fillStyle = '#e9fffb';
  g.shadowColor = ACCENT;
  g.shadowBlur = 14;
  g.fillText(text, w / 2, h / 2 + 4);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return { tex, w, h };
}

/** Light spilling onto the floor from the doorway: soft teal, brighter when the doors are open. */
function glowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const g = c.getContext('2d')!;
  const r = g.createRadialGradient(128, 0, 4, 128, 0, 128);
  r.addColorStop(0, 'rgba(120,240,225,0.95)');
  r.addColorStop(0.45, 'rgba(100,223,210,0.35)');
  r.addColorStop(1, 'rgba(100,223,210,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 256, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export interface Elevator {
  group: THREE.Group;
  /** What stops you walking out through shut doors. Part of the office's colliders. */
  colliders: Collider[];
  /** Step in, or up to the call button, and press E. */
  interactable: Interactable;
  /** Opens or shuts the doors; they slide there over a moment. */
  setOpen(open: boolean): void;
  readonly open: boolean;
  /** Whether the doors have finished moving. */
  readonly settled: boolean;
  /** The sign over the doors, and the display inside: which floor this is. */
  setSign(text: string): void;
  /** Stands it on the floor at `y`: the garage's goes further down the higher your floor is. */
  setFloor(y: number): void;
  update(dt: number): void;
}

/**
 * An elevator `height` tall, the storey it stands in: the office's, or the garage's under it. The
 * office's walls go on up out of reach; a shorter one's stop at its ceiling.
 */
export function buildElevator(height = WALL_HEIGHT): Elevator {
  const { x, width, depth, wall, doorWidth, doorHeight } = ELEVATOR;
  const group = new THREE.Group();
  const colliders: Collider[] = [];
  const tall = height >= WALL_HEIGHT;
  const topOf = (floorY: number) => (tall ? 99 : floorY + height);
  const minX = x - width / 2;
  const maxX = x + width / 2;
  const back = FLOOR.minZ;
  const front = ELEVATOR_FRONT;
  const midZ = (back + front) / 2;
  const steel = toon(STEEL);
  const steelDark = toon(STEEL_DARK);
  const accent = toon(ACCENT, { emissive: '#1c8e89' });
  const face = toon(FACE);

  // Side walls, the whole height of the room.
  for (const sx of [minX + wall / 2, maxX - wall / 2]) {
    group.add(mesh(new THREE.BoxGeometry(wall, height, depth), toon('#1c2838'), sx, height / 2, midZ));
    colliders.push({ minX: sx - wall / 2, maxX: sx + wall / 2, minZ: back, maxZ: front, bottom: 0, top: topOf(0) });
  }
  // The front: a pillar either side of the doorway, and a header over it up to the ceiling line.
  const pillar = (width - doorWidth) / 2;
  for (const [x0, x1] of [
    [minX, x - doorWidth / 2],
    [x + doorWidth / 2, maxX],
  ]) {
    group.add(mesh(new THREE.BoxGeometry(pillar, height, wall), face, (x0 + x1) / 2, height / 2, front - wall / 2));
    colliders.push({ minX: x0, maxX: x1, minZ: front - wall, maxZ: front, bottom: 0, top: topOf(0) });
  }
  const header = height - doorHeight;
  group.add(mesh(new THREE.BoxGeometry(doorWidth, header, wall), face, x, doorHeight + header / 2, front - wall / 2));
  // Fluted fins across the whole face, stopping at the doorway, for depth and a finished, architectural look.
  const fin = toon(FIN);
  const finCount = Math.round(width / 0.2);
  for (let i = 0; i < finCount; i++) {
    const fx = minX + ((i + 0.5) * width) / finCount;
    const inDoor = Math.abs(fx - x) < doorWidth / 2 + 0.06;
    const y0 = inDoor ? doorHeight + 0.12 : 0.2;
    const y1 = height - 0.12;
    if (y1 - y0 < 0.3) continue;
    group.add(mesh(new THREE.BoxGeometry(0.07, y1 - y0, 0.035), fin, fx, (y0 + y1) / 2, front + 0.0175, false));
  }
  // A recessed illuminated portal and a low kick plate keep the tall shaft visually light.
  const frameT = 0.045;
  group.add(mesh(new THREE.BoxGeometry(doorWidth + frameT * 2, frameT, 0.05), accent, x, doorHeight + frameT / 2, front + 0.02, false));
  for (const sx of [-1, 1]) group.add(mesh(new THREE.BoxGeometry(frameT, doorHeight, 0.05), accent, x + sx * (doorWidth / 2 + frameT / 2), doorHeight / 2, front + 0.02, false));
  group.add(mesh(new THREE.BoxGeometry(width + 0.02, 0.15, wall + 0.04), steelDark, x, 0.075, front - wall / 2, false));
  for (const sx of [-1, 1]) {
    group.add(mesh(new THREE.BoxGeometry(0.03, Math.min(height, WALL_HEIGHT) - 0.5, 0.03), accent, x + sx * (width / 2 - 0.1), Math.min(height, WALL_HEIGHT) / 2, front + 0.05, false));
  }
  // Two chamfered cheeks and a floating canopy frame the shaft's doorway.
  // They sit outside the moving doors, so the car and its shared floor geometry stay aligned.
  for (const side of [-1, 1]) {
    const cheek = mesh(roundedBox(0.38, 3.35, 0.08, 0.035), steelDark, x + side * (doorWidth / 2 + 0.3), 1.78, front + 0.12, false);
    cheek.rotation.y = -side * 0.32;
    group.add(cheek);
    const edge = mesh(new THREE.BoxGeometry(0.025, 2.7, 0.035), accent, x + side * (doorWidth / 2 + 0.11), 1.55, front + 0.17, false);
    edge.rotation.y = -side * 0.32;
    group.add(edge);
  }
  group.add(mesh(roundedBox(width + 0.22, 0.14, 0.56, 0.07), steelDark, x, 3.49, front + 0.12, false));
  group.add(mesh(new THREE.BoxGeometry(width - 0.12, 0.025, 0.03), accent, x, 3.39, front + 0.41, false));

  // Inside: a dark floor, a mirror on the back wall, handrails, a strip light over the doors.
  const inW = ELEVATOR_CAR.maxX - ELEVATOR_CAR.minX;
  const inD = ELEVATOR_CAR.maxZ - ELEVATOR_CAR.minZ;
  const carFloor = mesh(new THREE.BoxGeometry(inW, 0.02, inD), toon('#253244'), x, 0.012, (ELEVATOR_CAR.minZ + ELEVATOR_CAR.maxZ) / 2, false);
  group.add(carFloor);
  for (let i = 1; i < 4; i++) group.add(mesh(new THREE.BoxGeometry(inW, 0.024, 0.025), toon('#516276'), x, 0.013, ELEVATOR_CAR.minZ + (i * inD) / 4, false));
  const mirror = mesh(new THREE.PlaneGeometry(inW - 0.3, 1.5), new THREE.MeshBasicMaterial({ color: '#cfe8f5' }), x, 1.55, back + 0.02, false);
  group.add(mirror);
  for (const [gx, gw] of [
    [-0.4, 0.14],
    [-0.15, 0.06],
  ]) {
    const glint = mesh(new THREE.PlaneGeometry(gw, 1.1), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.5 }), x + gx, 1.6, back + 0.03, false);
    glint.rotation.z = -0.45;
    group.add(glint);
  }
  const rail = (len: number, px: number, pz: number, alongX: boolean) => {
    const r = mesh(new THREE.CylinderGeometry(0.025, 0.025, len, 8), toon('#9aabb9'), px, 0.95, pz, false);
    r.rotation.z = alongX ? Math.PI / 2 : 0;
    r.rotation.x = alongX ? 0 : Math.PI / 2;
    group.add(r);
  };
  rail(inW - 0.2, x, back + 0.08, true);
  rail(inD - 0.5, ELEVATOR_CAR.minX + 0.06, midZ - 0.1, false);
  rail(inD - 0.5, ELEVATOR_CAR.maxX - 0.06, midZ - 0.1, false);
  group.add(mesh(new THREE.BoxGeometry(inW - 0.2, 0.045, 0.12), toon('#e1faf5', { emissive: '#74eadb' }), x, doorHeight + 0.35, front - wall - 0.1, false));

  // The button panel inside, by the doors on the right as you face out (the west wall).
  const panelIn = new THREE.Group();
  panelIn.add(mesh(roundedBox(0.04, 0.7, 0.32, 0.02), steelDark, 0, 0, 0, false));
  for (let row = 0; row < 4; row++) {
    for (const col of [-1, 1]) {
      const b = mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.02, 12), toon('#dce8eb', { emissive: row === 0 && col === 1 ? ACCENT : '#40536a' }), -0.03, 0.22 - row * 0.15, col * 0.07, false);
      b.rotation.z = Math.PI / 2;
      panelIn.add(b);
    }
  }
  panelIn.position.set(ELEVATOR_CAR.minX + 0.03, 1.25, front - wall - 0.35);
  panelIn.rotation.y = Math.PI;
  group.add(panelIn);

  // The call button outside, on the right-hand pillar.
  const call = new THREE.Group();
  call.add(mesh(roundedBox(0.2, 0.36, 0.04, 0.02), steelDark, 0, 0, 0, false));
  const arrow = (up: boolean) => {
    const a = mesh(new THREE.ConeGeometry(0.045, 0.06, 3), toon('#e1faf5', { emissive: up ? ACCENT : '#40536a' }), 0, up ? 0.07 : -0.07, 0.03, false);
    if (!up) a.rotation.z = Math.PI;
    call.add(a);
  };
  arrow(true);
  arrow(false);
  call.position.set(x + doorWidth / 2 + pillar / 2, 1.2, front + 0.02);
  group.add(call);

  // The doors: two steel panels that slide apart behind the pillars.
  const half = doorWidth / 2 + 0.02;
  const doorZ = front - wall - 0.03;
  const doors = [-1, 1].map((side) => {
    const d = new THREE.Group();
    const doorMat = new THREE.MeshBasicMaterial({ map: brushed(side as -1 | 1) });
    d.add(mesh(new THREE.BoxGeometry(half, doorHeight - 0.02, 0.05), doorMat, 0, 0, 0));
    // Fine horizontal breaks keep the doors legible from across the room.
    d.add(mesh(new THREE.BoxGeometry(0.02, doorHeight - 0.1, 0.055), steelDark, (-side * half) / 2 + side * 0.01, 0, 0, false));
    d.add(mesh(new THREE.BoxGeometry(half - 0.2, 0.05, 0.055), steelDark, 0, 0.35, 0, false));
    d.position.set(x + (side * half) / 2, doorHeight / 2, doorZ);
    group.add(d);
    return { group: d, side };
  });
  const doorCollider: Collider = { minX: x - doorWidth / 2, maxX: x + doorWidth / 2, minZ: front - wall - 0.06, maxZ: front, bottom: 0, top: topOf(0) };
  colliders.push(doorCollider);
  /** The floor it stands on: open doors drop their collider under it. */
  let floorY = 0;

  // What floor this is: a sign over the doors, facing the room.
  let sign: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> | null = null;
  const setSign = (text: string) => {
    if (sign) {
      group.remove(sign);
      sign.material.map?.dispose();
      sign.material.dispose();
      sign.geometry.dispose();
    }
    const { tex, w, h } = displayTexture(text);
    const next = new THREE.Mesh(new THREE.PlaneGeometry((w / h) * 0.56, 0.56), new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false }));
    const { width: sw, height: sh } = next.geometry.parameters;
    // As big as fits over the doors (in the garage, under its low ceiling too).
    next.scale.multiplyScalar(Math.min(1, (width - 0.3) / sw, (header - 0.25) / sh));
    next.position.set(x, doorHeight + Math.min(0.55, header / 2), front + 0.06);
    group.add(next);
    sign = next;
  };

  const glowMat = new THREE.MeshBasicMaterial({ map: glowTexture(), transparent: true, opacity: 0.3, depthWrite: false, toneMapped: false });
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(width + 0.6, 1.6), glowMat);
  glow.rotation.x = -Math.PI / 2;
  glow.position.set(x, 0.022, front + 0.8);
  group.add(glow);

  let open = false;
  let openness = 0; // 0 shut, 1 open
  const setOpen = (v: boolean) => {
    open = v;
    // Shut means shut at once for walking, so nobody slips out while they close.
    if (!v) doorCollider.top = topOf(floorY);
  };
  const update = (dt: number) => {
    const target = open ? 1 : 0;
    if (openness !== target) {
      openness = target > openness ? Math.min(1, openness + dt / 0.7) : Math.max(0, openness - dt / 0.6);
      // Eased, like a real one: slow to start, slow to stop.
      const e = openness * openness * (3 - 2 * openness);
      // As far as the pillars hide them; a sliver still shows at the edge of the doorway.
      for (const d of doors) d.group.position.x = x + (d.side * half) / 2 + d.side * e * (pillar - 0.03);
      glowMat.opacity = 0.3 + 0.55 * e;
    }
    if (open && openness > 0.85) doorCollider.top = floorY - 1;
  };

  const interactable: Interactable = { kind: 'elevator', x, z: front - 0.4, radius: 1.9 };
  group.userData.interact = interactable;
  const setFloor = (y: number) => {
    floorY = y;
    group.position.y = y;
    interactable.y = y;
    for (const c of colliders) {
      c.bottom = y;
      c.top = topOf(y);
    }
    if (open && openness > 0.85) doorCollider.top = y - 1;
  };
  return {
    group,
    colliders,
    interactable,
    setOpen,
    get open() {
      return open;
    },
    get settled() {
      return openness === (open ? 1 : 0);
    },
    setSign,
    setFloor,
    update,
  };
}
