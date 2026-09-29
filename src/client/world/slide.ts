import * as THREE from 'three';
import { LOFT } from '../../shared/layout';
import { mesh, toon } from './toon';
import type { Collider, Interactable } from './office';

/** How far west of where it was first laid out the loft's edge now is: the whole slide moves with it. */
const DX = LOFT.minX - 9;
/** The feet's route, from the boss's office to the open floor beside the stairs. */
const ROUTE: readonly (readonly [number, number, number])[] = [
  [LOFT.minX + 0.7, LOFT.y, 9.65],
  [DX + 8.8, 2.9, 9.6],
  [DX + 7.9, 2.62, 9.25],
  [DX + 7.15, 2.28, 8.6],
  [DX + 6.8, 1.95, 7.7],
  [DX + 6.15, 1.58, 6.9],
  [DX + 5.2, 1.25, 6.75],
  [DX + 4.2, 0.92, 7.15],
  [DX + 3.5, 0.57, 7.85],
  [DX + 2.9, 0.26, 8.3],
  [DX + 2.15, 0.09, 8.45],
  [DX + 1.3, 0.02, 8.45],
];

export interface OfficeSlide {
  group: THREE.Group;
  path: THREE.Curve<THREE.Vector3>;
  interactable: Interactable;
  colliders: Collider[];
}

/** A half-open playground slide: orange shell, teal riding surface, cream rims, yellow racing stripes and a soft landing mat. */
export function buildSlide(): OfficeSlide {
  const group = new THREE.Group();
  const chute = new THREE.CatmullRomCurve3(ROUTE.map(([x, y, z]) => new THREE.Vector3(x, y, z)), false, 'centripetal');
  // Carry riders beyond the open end so walking back into the chute meets its collision boundary.
  const path = new THREE.CurvePath<THREE.Vector3>();
  path.add(chute);
  path.add(new THREE.LineCurve3(chute.getPoint(1), new THREE.Vector3(DX - 0.35, 0.02, 8.45)));
  // The office's own candy palette: a teal riding surface in an orange shell, with cream rolled edges.
  const metal = toon('#4ecdc4');
  const copper = toon('#ff8f3f');
  const dark = toon('#fffaf3');
  const stripe = toon('#ffd166');
  const pink = toon('#f15bb5');
  metal.side = copper.side = THREE.DoubleSide;
  const startAngle = -Math.PI - 0.25;
  const endAngle = 0.25;
  const up = new THREE.Vector3(0, 1, 0);
  const surfacePoint = (t: number, angle: number, inner: boolean, offset = 0) => {
    // The last part widens and its sides sink toward the floor instead of ending as a full-height wall.
    const flare = THREE.MathUtils.smoothstep(t, 0.72, 1);
    const height = THREE.MathUtils.lerp(0.64, 0.12, flare);
    const width = THREE.MathUtils.lerp(0.69, 0.98, flare);
    const tangent = chute.getTangentAt(t);
    const side = new THREE.Vector3().crossVectors(tangent, up).normalize();
    const normal = new THREE.Vector3().crossVectors(side, tangent).normalize();
    return chute.getPointAt(t).addScaledVector(up, height)
      .addScaledVector(side, Math.cos(angle) * (width - (inner ? 0.06 : 0) + offset))
      .addScaledVector(normal, Math.sin(angle) * (height - (inner ? 0.02 : 0) + offset));
  };
  const sweep = (inner: boolean) => {
    const segments = 80;
    const sides = 16;
    const vertices: number[] = [];
    const indices: number[] = [];
    for (let i = 0; i <= segments; i++) {
      for (let j = 0; j <= sides; j++) {
        const p = surfacePoint(i / segments, startAngle + (endAngle - startAngle) * j / sides, inner);
        vertices.push(p.x, p.y, p.z);
      }
    }
    for (let i = 0; i < segments; i++) for (let j = 0; j < sides; j++) {
      const a = i * (sides + 1) + j;
      const b = a + sides + 1;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
  };
  const shell = new THREE.Mesh(sweep(false), copper);
  shell.castShadow = true;
  shell.receiveShadow = true;
  group.add(shell);
  const bed = new THREE.Mesh(sweep(true), metal);
  bed.receiveShadow = true;
  group.add(bed);

  // Rolled edges and open crosswise seams keep the shape clear from above and below.
  for (const angle of [startAngle, endAngle]) {
    const points = Array.from({ length: 49 }, (_, i) => surfacePoint(i / 48, angle, false));
    group.add(mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 48, 0.035, 6, false), dark, 0, 0, 0, false));
  }
  const edge = (t: number) => new THREE.CatmullRomCurve3(Array.from({ length: 17 }, (_, i) => surfacePoint(t, startAngle + (endAngle - startAngle) * i / 16, false, 0.01)));
  // Two yellow racing stripes down the riding surface, and a cream lip at the top where riders sit down.
  const mid = (startAngle + endAngle) / 2;
  for (const lane of [-0.42, 0.42]) {
    const pts = Array.from({ length: 61 }, (_, i) => surfacePoint(0.02 + 0.9 * i / 60, mid + lane, true, 0.012));
    group.add(mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 60, 0.025, 6, false), stripe, 0, 0, 0, false));
  }
  group.add(mesh(new THREE.TubeGeometry(edge(0), 16, 0.055, 8, false), dark, 0, 0, 0, false));

  const colliders: Collider[] = [];
  // Round-footed posts with cream collars, and a pink mat where the ride ends.
  for (const t of [0.22, 0.42, 0.62, 0.8]) {
    const p = chute.getPointAt(t);
    const height = Math.max(0.3, p.y - 0.06);
    if (height < 0.35) continue;
    group.add(mesh(new THREE.CylinderGeometry(0.05, 0.06, height, 10), toon('#4ecdc4'), p.x, height / 2, p.z, false));
    group.add(mesh(new THREE.CylinderGeometry(0.15, 0.17, 0.05, 14), dark, p.x, 0.025, p.z, false));
    group.add(mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.06, 10), dark, p.x, p.y - 0.08, p.z, false));
  }
  const end = chute.getPointAt(1);
  const endDir = chute.getTangentAt(1);
  const mat = mesh(new THREE.CylinderGeometry(0.9, 0.95, 0.03, 28), pink, end.x - endDir.x * 0.1, 0.016, end.z - endDir.z * 0.1, false);
  mat.scale.set(1, 1, 1.15);
  mat.castShadow = false;
  group.add(mat);
  // A grab bar at the top, over the loft opening.
  const top = chute.getPointAt(0.03);
  for (const sideSign of [-1, 1]) {
    group.add(mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.55, 8), dark, top.x, top.y + 0.55, top.z + sideSign * 0.68, false));
  }
  const bar = mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.36, 8), copper, top.x, top.y + 0.82, top.z, false);
  bar.rotation.x = Math.PI / 2;
  group.add(bar);

  // Closely spaced walkable sections support feet along the trough. Each rise is small enough for
  // the player's normal stair stepping, including when approaching the flared mouth from the floor.
  // Their undersides still leave room to walk beneath the elevated part of the slide.
  const sections = 72;
  const footprint = (t: number) => {
    const p = chute.getPointAt(t);
    const side = new THREE.Vector3().crossVectors(chute.getTangentAt(t), up).normalize();
    const half = THREE.MathUtils.lerp(0.43, 0.7, THREE.MathUtils.smoothstep(t, 0.72, 1));
    return [p.clone().addScaledVector(side, half), p.clone().addScaledVector(side, -half)];
  };
  for (let i = 1; i <= sections; i++) {
    const a = chute.getPointAt((i - 1) / sections);
    const b = chute.getPointAt(i / sections);
    const corners = [...footprint((i - 1) / sections), ...footprint(i / sections)];
    colliders.push({
      minX: Math.min(...corners.map((p) => p.x)) - 0.02,
      maxX: Math.max(...corners.map((p) => p.x)) + 0.02,
      minZ: Math.min(...corners.map((p) => p.z)) - 0.02,
      maxZ: Math.max(...corners.map((p) => p.z)) + 0.02,
      bottom: Math.max(0, Math.min(a.y, b.y) - 0.3),
      top: Math.max(a.y, b.y) + 0.02,
    });
  }

  const interactable: Interactable = { kind: 'slide', x: ROUTE[0][0], y: LOFT.y, z: ROUTE[0][2], radius: 1.25 };
  const mouth = mesh(new THREE.TubeGeometry(edge(0), 16, 0.07, 8, false), dark, 0, 0, 0, false);
  mouth.userData.interact = interactable;
  group.add(mouth);
  return { group, path, interactable, colliders };
}
