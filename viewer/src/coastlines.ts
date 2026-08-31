import {
  BufferGeometry, BufferAttribute, LineSegments, Mesh, ShaderMaterial,
  DoubleSide, type Texture,
} from 'three';
import { passthroughColor } from './material';
import { GEOGRAPHIC_GLSL } from './glsl/geographic';
import { LIGHT_DIR } from './globe';
import { R_SURFACE } from './constants';
import { PALETTE } from './palette';
import type { CoastlineLine, RotationTable } from './types';

const LAND_R = R_SURFACE * 1.0006;      // just clear of the surface sphere
const COASTLINE_R = R_SURFACE * 1.0014; // and the lines just clear of the land

/** Parse geometry.bin (see prep_coastlines.py for the layout). */
export function parseGeometry(buf: ArrayBuffer): CoastlineLine[] {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(
    dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3),
  );
  if (magic !== 'ESCL') throw new Error(`bad coastline magic: ${magic}`);
  const version = dv.getUint32(4, true);
  if (version !== 3) {
    throw new Error(
      `coastline geometry is version ${version}, expected 3 -- re-run prep_coastlines.py`,
    );
  }
  const nLines = dv.getUint32(8, true);

  const lines: CoastlineLine[] = [];
  let o = 12;
  for (let i = 0; i < nLines; i++) {
    const plateId = dv.getInt32(o, true); o += 4;
    const appearAge = dv.getFloat32(o, true); o += 4;
    const disappearAge = dv.getFloat32(o, true); o += 4;
    const nPts = dv.getUint32(o, true); o += 4;
    const nLand = dv.getUint32(o, true); o += 4;
    const nTris = dv.getUint32(o, true); o += 4;

    const points = new Float32Array(buf, o, nPts * 3);
    o += nPts * 3 * 4;
    const landPoints = nLand ? new Float32Array(buf, o, nLand * 3) : null;
    o += nLand * 3 * 4;
    const triangles = nTris
      ? new Uint32Array(buf.slice(o, o + nTris * 3 * 4))
      : null;
    o += nTris * 3 * 4;

    lines.push({ plateId, appearAge, disappearAge, points, landPoints, triangles });
  }
  return lines;
}

/** Slerp a plate's rotation between the bracketing 1 Ma samples. */
function rotationAt(
  table: RotationTable,
  plateId: number,
  age: number,
): [number, number, number, number] {
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

const VERT = /* glsl */ `
varying vec3 vWorldPos;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const LINE_FRAG = /* glsl */ `
${GEOGRAPHIC_GLSL}

uniform sampler2D uMask;
uniform vec3 uColor;
uniform float uUseMask;
uniform float uOpacity;
varying vec3 vWorldPos;
void main() {
  if (uUseMask > 0.5) {
    vec2 uv = geographicToUV(worldToGeographic(vWorldPos));
    if (texture2D(uMask, uv).r > 0.5) discard;
  }
  gl_FragColor = vec4(uColor, uOpacity);
}
`;

/** Land fill takes the same key light as the globe so it sits on the sphere. */
const LAND_FRAG = /* glsl */ `
${GEOGRAPHIC_GLSL}

uniform sampler2D uMask;
uniform vec3 uColor;
uniform float uUseMask;
uniform float uOpacity;
uniform vec3 uLightDir;
varying vec3 vWorldPos;
void main() {
  if (uUseMask > 0.5) {
    vec2 uv = geographicToUV(worldToGeographic(vWorldPos));
    if (texture2D(uMask, uv).r > 0.5) discard;
  }
  vec3 n = normalize(vWorldPos);
  float ndl = dot(n, normalize(uLightDir)) * 0.5 + 0.5;
  gl_FragColor = vec4(uColor * (0.5 + 0.5 * ndl * ndl), uOpacity);
}
`;

/**
 * Coastlines reconstructed in the browser.
 *
 * Geometry is stored once in present-day coordinates; each age we slerp the
 * plate rotations and rotate the vertices. We interpolate the ROTATION, never
 * the geometry -- plates rotate about Euler poles rather than translating, so
 * interpolating vertex positions between two baked ages is simply wrong.
 *
 * Points arrive in the geographic frame (X to 0N/0E, Y to 0N/90E, Z to the
 * pole) and the quaternions act in that frame, so we rotate there and convert
 * to the viewer's (X, Z, -Y) frame afterwards -- see constants.ts.
 */
export class Coastlines {
  readonly lines: LineSegments;
  readonly land: Mesh;

  private lineGeom: BufferGeometry;
  private linePos: Float32Array;
  private landGeom: BufferGeometry;
  private landPos: Float32Array;
  private landIdx: Uint32Array;
  private lineMat: ShaderMaterial;
  private landMat: ShaderMaterial;

  constructor(
    private data: CoastlineLine[],
    private table: RotationTable,
    maskTexture: Texture,
  ) {
    // Allocate once at maximum size. The visible set changes with age, so we
    // update the draw range rather than rebuilding the buffers.
    let maxSegments = 0;
    let maxLandPts = 0;
    let maxTris = 0;
    for (const l of data) {
      maxSegments += l.points.length / 3 - 1;
      if (l.triangles && l.landPoints) {
        maxLandPts += l.landPoints.length / 3;
        maxTris += l.triangles.length / 3;
      }
    }

    this.linePos = new Float32Array(maxSegments * 2 * 3);
    this.lineGeom = new BufferGeometry();
    this.lineGeom.setAttribute('position', new BufferAttribute(this.linePos, 3));

    this.landPos = new Float32Array(maxLandPts * 3);
    this.landIdx = new Uint32Array(maxTris * 3);
    this.landGeom = new BufferGeometry();
    this.landGeom.setAttribute('position', new BufferAttribute(this.landPos, 3));
    this.landGeom.setIndex(new BufferAttribute(this.landIdx, 1));

    this.lineMat = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: LINE_FRAG,
      uniforms: {
        uMask: { value: maskTexture },
        uColor: { value: passthroughColor(PALETTE.coastline) },
        uUseMask: { value: 1 },
        uOpacity: { value: 1 },
      },
    });
    this.landMat = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: LAND_FRAG,
      // Delaunay returns simplices in arbitrary winding order, so about half
      // the land triangles face inward. With front-face culling they vanish and
      // the continents come out full of holes.
      side: DoubleSide,
      uniforms: {
        uMask: { value: maskTexture },
        uColor: { value: passthroughColor(PALETTE.land) },
        uUseMask: { value: 1 },
        uOpacity: { value: 1 },
        uLightDir: { value: LIGHT_DIR.clone() },
      },
    });

    this.lines = new LineSegments(this.lineGeom, this.lineMat);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 3;

    this.land = new Mesh(this.landGeom, this.landMat);
    this.land.frustumCulled = false;
    this.land.renderOrder = 2;

    this.setAge(0);
  }

  set landVisible(v: boolean) { this.land.visible = v; }

  /** Rebuild the visible line and land sets for a reconstruction age. */
  setAge(age: number): void {
    let lw = 0;   // line float cursor
    let vw = 0;   // land vertex count
    let iw = 0;   // land index cursor

    for (const line of this.data) {
      // Ages increase into the past, so appearAge is the LARGER value. A
      // feature appearing at 100 Ma must be absent at 150 Ma.
      if (age > line.appearAge || age < line.disappearAge) continue;

      const [qx, qy, qz, qw] = rotationAt(this.table, line.plateId, age);
      const p = line.points;
      const n = p.length / 3;
      const base = vw;

      let px = 0, py = 0, pz = 0;
      for (let i = 0; i < n; i++) {
        const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];

        // v' = q * v * q^-1, expanded.
        const tx = 2 * (qy * z - qz * y);
        const ty = 2 * (qz * x - qx * z);
        const tz = 2 * (qx * y - qy * x);
        const rx = x + qw * tx + (qy * tz - qz * ty);
        const ry = y + qw * ty + (qz * tx - qx * tz);
        const rz = z + qw * tz + (qx * ty - qy * tx);

        // Geographic (X, Y, Z) -> viewer (X, Z, -Y).
        const lx = rx * COASTLINE_R, ly = rz * COASTLINE_R, lz = -ry * COASTLINE_R;

        if (i > 0) {
          this.linePos[lw++] = px; this.linePos[lw++] = py; this.linePos[lw++] = pz;
          this.linePos[lw++] = lx; this.linePos[lw++] = ly; this.linePos[lw++] = lz;
        }
        px = lx; py = ly; pz = lz;
      }

      if (line.triangles && line.landPoints) {
        const lp = line.landPoints;
        const m = lp.length / 3;
        for (let i = 0; i < m; i++) {
          const x = lp[i * 3], y = lp[i * 3 + 1], z = lp[i * 3 + 2];
          const tx = 2 * (qy * z - qz * y);
          const ty = 2 * (qz * x - qx * z);
          const tz = 2 * (qx * y - qy * x);
          const rx = x + qw * tx + (qy * tz - qz * ty);
          const ry = y + qw * ty + (qz * tx - qx * tz);
          const rz = z + qw * tz + (qx * ty - qy * tx);
          this.landPos[vw * 3] = rx * LAND_R;
          this.landPos[vw * 3 + 1] = rz * LAND_R;
          this.landPos[vw * 3 + 2] = -ry * LAND_R;
          vw++;
        }
        const t = line.triangles;
        for (let k = 0; k < t.length; k++) this.landIdx[iw++] = base + t[k];
      }
    }

    this.lineGeom.setDrawRange(0, lw / 3);
    (this.lineGeom.getAttribute('position') as BufferAttribute).needsUpdate = true;

    this.landGeom.setDrawRange(0, iw);
    (this.landGeom.getAttribute('position') as BufferAttribute).needsUpdate = true;
    this.landGeom.getIndex()!.needsUpdate = true;
  }

  setMaskEnabled(on: boolean): void {
    this.lineMat.uniforms.uUseMask.value = on ? 1 : 0;
    this.landMat.uniforms.uUseMask.value = on ? 1 : 0;
  }

  dispose(): void {
    this.lineGeom.dispose();
    this.landGeom.dispose();
    this.lineMat.dispose();
    this.landMat.dispose();
  }

  /**
   * Fade with the globe surface.
   *
   * The land fill sits a fraction above the surface sphere and is opaque, so
   * without this, turning the surface down to see the isosurfaces leaves the
   * continents painted solidly over them -- the control appears to half-work,
   * which is worse than not working.
   *
   * `transparent` is only switched on when it is actually needed. Left on
   * permanently it would move these meshes into the sorted transparent pass at
   * full opacity too, and that changes what the existing renders look like for
   * no reason.
   */
  setOpacity(v: number): void {
    for (const m of [this.lineMat, this.landMat]) {
      m.uniforms.uOpacity.value = v;
      const wantTransparent = v < 1;
      if (m.transparent !== wantTransparent) {
        m.transparent = wantTransparent;
        m.needsUpdate = true;
      }
    }
  }
}

export interface CoastlineData {
  lines: CoastlineLine[];
  table: RotationTable;
}

/**
 * Fetch and parse the coastline geometry and rotation table, without building
 * any GPU-side `Coastlines` instance.
 *
 * Split out so multiple globes can share one fetch: the parsed data is
 * immutable and present-day, so every instance's `Coastlines` object can be
 * built from the same `CoastlineData` without re-downloading or re-parsing it.
 */
export async function fetchCoastlineData(
  base: string,
  geometryPath: string,
  rotationsPath: string,
): Promise<CoastlineData> {
  const [gRes, rRes] = await Promise.all([
    fetch(`${base}/${geometryPath}`),
    fetch(`${base}/${rotationsPath}`),
  ]);
  if (!gRes.ok) throw new Error(`${geometryPath}: ${gRes.status}`);
  if (!rRes.ok) throw new Error(`${rotationsPath}: ${rRes.status}`);
  const lines = parseGeometry(await gRes.arrayBuffer());
  const table: RotationTable = await rRes.json();
  return { lines, table };
}

export async function loadCoastlines(
  base: string,
  geometryPath: string,
  rotationsPath: string,
  maskTexture: Texture,
): Promise<Coastlines> {
  const { lines, table } = await fetchCoastlineData(base, geometryPath, rotationsPath);
  return new Coastlines(lines, table, maskTexture);
}
