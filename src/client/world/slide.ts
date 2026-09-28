import * as THREE from 'three';
import { LOFT } from '../../shared/layout';
import { mesh, toon } from './toon';
import type { Collider, Interactable } from './office';

/** The feet's route, from the boss's office to the open floor beside the stairs. */
const ROUTE: readonly (readonly [number, number, number])[] = [
  [LOFT.minX + 0.7, LOFT.y, 9.65],
  [8.8, 2.9, 9.6],
  [7.9, 2.62, 9.25],
  [7.15, 2.28, 8.6],
  [6.8, 1.95, 7.7],
  [6.15, 1.58, 6.9],
  [5.2, 1.25, 6.75],
  [4.2, 0.92, 7.15],
  [3.5, 0.57, 7.85],
  [2.9, 0.26, 8.3],
  [2.15, 0.09, 8.45],
  [1.3, 0.02, 8.45],
];

export interface OfficeSlide {
  group: THREE.Group;
  path: THREE.Curve<THREE.Vector3>;
  interactable: Interactable;
  colliders: Collider[];
}

/** A half-open slide with a copper shell, a silver riding surface and two supports. */
export function buildSlide(): OfficeSlide {
  const group = new THREE.Group();
  const chute = new THREE.CatmullRomCurve3(ROUTE.map(([x, y, z]) => new THREE.Vector3(x, y, z)), false, 'centripetal');
  // Carry riders beyond the open end so walking back into the chute meets its collision boundary.
  const path = new THREE.CurvePath<THREE.Vector3>();
  path.add(chute);
  path.add(new THREE.LineCurve3(chute.getPoint(1), new THREE.Vector3(-0.35, 0.02, 8.45)));
  const metal = toon('#cbd5d8');
  const copper = toon('#aa624b');
  const dark = toon('#52616b');
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
  for (let i = 0; i <= 10; i++) {
    const seam = mesh(new THREE.TubeGeometry(edge(i / 10), 16, i === 0 ? 0.05 : 0.018, 6, false), i === 0 ? dark : copper, 0, 0, 0, false);
    group.add(seam);
  }

  const colliders: Collider[] = [];
  for (const t of [0.38, 0.7]) {
    const p = chute.getPointAt(t);
    const height = Math.max(0.35, p.y - 0.06);
    group.add(mesh(new THREE.CylinderGeometry(0.055, 0.075, height, 8), dark, p.x, height / 2, p.z, false));
  }

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
  const mouth = mesh(new THREE.TubeGeometry(edge(0), 16, 0.055, 8, false), dark, 0, 0, 0, false);
  mouth.userData.interact = interactable;
  group.add(mouth);
  return { group, path, interactable, colliders };
}
