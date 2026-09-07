import type { RotationTable } from './types';

export type Quaternion = [number, number, number, number];

/**
 * Slerp a plate's rotation between the bracketing 1 Ma samples. Shared by
 * coastlines.ts and staticPolygons.ts (docs/adr/0025) -- both rotate
 * present-day geometry into an age's position via the same RotationTable
 * (ADR-0001); Plate-Frame Point needs no new rotation mechanism of its own.
 */
export function rotationAt(table: RotationTable, plateId: number, age: number): Quaternion {
  const quats = table.plates[String(plateId)];
  if (!quats) return [0, 0, 0, 1];

  const ages = table.ages;
  const lo = Math.max(0, Math.min(ages.length - 2,
    Math.floor((age - ages[0]) / (ages[1] - ages[0]))));
  const t = Math.max(0, Math.min(1, (age - ages[lo]) / (ages[lo + 1] - ages[lo])));

  let [ax, ay, az, aw] = quats[lo];
  const [bx, by, bz, bw] = quats[lo + 1];

  let d = ax * bx + ay * by + az * bz + aw * bw;
  if (d < 0) { ax = -ax; ay = -ay; az = -az; aw = -aw; d = -d; }

  if (d > 0.9995) {
    const x = ax + t * (bx - ax), y = ay + t * (by - ay);
    const z = az + t * (bz - az), w = aw + t * (bw - aw);
    const n = Math.hypot(x, y, z, w) || 1;
    return [x / n, y / n, z / n, w / n];
  }
  const theta = Math.acos(Math.min(1, d));
  const s = Math.sin(theta);
  const w0 = Math.sin((1 - t) * theta) / s;
  const w1 = Math.sin(t * theta) / s;
  return [
    w0 * ax + w1 * bx, w0 * ay + w1 * by,
    w0 * az + w1 * bz, w0 * aw + w1 * bw,
  ];
}

/** Rotate a vector by a unit quaternion: v' = q*v*q^-1, expanded. Operates in
 *  whatever frame the quaternion and vector were both defined in -- callers
 *  are responsible for using the geographic frame consistently (see
 *  coastlines.ts's module doc comment), never mixing it with the viewer's
 *  (X, Z, -Y) render frame. */
export function rotateVector(
  q: Quaternion, x: number, y: number, z: number,
): [number, number, number] {
  const [qx, qy, qz, qw] = q;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  return [
    x + qw * tx + (qy * tz - qz * ty),
    y + qw * ty + (qz * tx - qx * tz),
    z + qw * tz + (qx * ty - qy * tx),
  ];
}

/** Inverse of a unit quaternion (its conjugate). Used to reconstruct a point
 *  back to present-day coordinates from wherever it was picked -- see
 *  staticPolygons.ts's createPlateFramePoint(). */
export function conjugateQuaternion(q: Quaternion): Quaternion {
  return [-q[0], -q[1], -q[2], q[3]];
}
