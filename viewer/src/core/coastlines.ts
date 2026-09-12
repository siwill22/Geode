import {
  BufferGeometry, BufferAttribute, LineSegments, Mesh, ShaderMaterial,
  DoubleSide, type Texture,
} from 'three';
import { passthroughColor } from './material';
import { GEOGRAPHIC_GLSL } from './glsl/geographic';
import { R_SURFACE, LIGHT_DIR, vec3ToLonLat } from './constants';
import { PALETTE } from './palette';
import { fetchVolumeBytes } from './volume';
import { composeQuaternions, referenceRotationAt, rotationAt } from './rotation';
import { lonLatToFlatVec3, type ProjectionMode } from './projection';
import type { ArchiveIndex, CoastlineLine, CoastlineSet, Manifest, RotationTable } from './types';

const LAND_R = R_SURFACE * 1.0006;      // just clear of the surface sphere
const COASTLINE_R = R_SURFACE * 1.0014; // and the lines just clear of the land
// The Plate Carrée equivalent, same derivation as windGlyphs.ts's FLAT_GLYPH_Z.
const FLAT_COASTLINE_Z = COASTLINE_R - R_SURFACE;

/** Symmetric offset below R_SURFACE, for a caller that wants land to sit
 *  UNDER a data sphere rather than above it -- see Coastlines' `landRadius`
 *  constructor option. Depth-tested against the data sphere in front of it,
 *  so it only shows through wherever that sphere discards (e.g. a no-data
 *  sentinel, see ADR-0005), the same way any other occluded geometry would. */
export const LAND_R_UNDER_SURFACE = R_SURFACE * (1 - 0.0006);

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
 * to the viewer's (X, Z, -Y) frame afterwards -- see constants.ts. Under
 * Plate Carrée (setProjection()), that viewer-frame point is then reprojected
 * onto the flat map via (lon, lat) rather than used directly -- see setAge()'s
 * mode branch and docs/plans/reference-plate.md.
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
  /** See CONTEXT.md's Reference Plate entry and docs/adr/0030 -- 0 (the
   *  prep-time anchor) reduces every composeQuaternions() below to a no-op
   *  extra multiply by identity, so this never needs its own branch in
   *  setAge(). Set via setReferencePlate(), which also re-renders the
   *  current age. */
  private referencePlateId = 0;
  private currentAge = 0;
  /** Only affects the LINE set (see setAge()'s mode branch) -- land fill is
   *  never shown in a wrapper that also offers Plate Carrée today (climate.html
   *  always sets landVisible false, see climateInstance.ts), so its geometry
   *  is left on the sphere unconditionally rather than build flat-map
   *  polygon-clipping (a materially bigger job than the line case below,
   *  which can just drop a seam-crossing segment) for a mesh nothing draws. */
  private mode: ProjectionMode = 'globe';

  constructor(
    private data: CoastlineLine[],
    private table: RotationTable,
    maskTexture: Texture,
    /** Defaults match every existing caller (land just clear of R_SURFACE,
     *  drawn OVER the data sphere -- the mantle/climate viewers' "land fill
     *  substitutes for missing data" use). A caller that wants land as a
     *  backdrop UNDER a data sphere instead (e.g. the deformation viewer's
     *  grey continents, see docs/plans/deformation-viewer.md) passes
     *  LAND_R_UNDER_SURFACE and a plain grey landColor. */
    private readonly landRadius: number = LAND_R,
    private readonly landColor: number = PALETTE.land,
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
        uColor: { value: passthroughColor(this.landColor) },
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

  /** Change which plate the whole set reanchors around, and re-render the
   *  current age with it -- see CONTEXT.md's Reference Plate entry. */
  setReferencePlate(plateId: number): void {
    this.referencePlateId = plateId;
    this.setAge(this.currentAge);
  }

  /** Switch the LINE set's positions between Globe and Plate Carrée -- see
   *  `mode`'s own doc comment for why only the lines, not land. Rebuilds via
   *  setAge() rather than reprojecting the existing buffer in place, same
   *  "cheap enough to redo from source" precedent as DepthSlice.setProjection(). */
  setProjection(mode: ProjectionMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.setAge(this.currentAge);
  }

  /** Rebuild the visible line and land sets for a reconstruction age. */
  setAge(age: number): void {
    this.currentAge = age;
    let lw = 0;   // line float cursor
    let vw = 0;   // land vertex count
    let iw = 0;   // land index cursor

    const qRef = referenceRotationAt(this.table, this.referencePlateId, age);

    for (const line of this.data) {
      // Ages increase into the past, so appearAge is the LARGER value. A
      // feature appearing at 100 Ma must be absent at 150 Ma.
      if (age > line.appearAge || age < line.disappearAge) continue;

      const [qx, qy, qz, qw] = composeQuaternions(qRef, rotationAt(this.table, line.plateId, age));
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
        const gx = rx * COASTLINE_R, gy = rz * COASTLINE_R, gz = -ry * COASTLINE_R;

        let cx: number, cy: number, cz: number;
        if (this.mode === 'globe') {
          cx = gx; cy = gy; cz = gz;
        } else {
          // Recover (lon, lat) from the already-fully-rotated (reconstruction
          // + Reference Plate) viewer-frame point and reproject onto the flat
          // map -- the same "rotate the true point forward, then reproject"
          // direction as windGlyphs.ts/windStreaks.ts's referencePlateFlat*
          // helpers, just computed via this class's own CPU rotation instead
          // of calling them (the composed quaternion above already bakes in
          // BOTH rotations at once, which those helpers don't need to since
          // they're only ever given one).
          const { lon, lat } = vec3ToLonLat(gx, gy, gz);
          [cx, cy, cz] = lonLatToFlatVec3(lon, lat, FLAT_COASTLINE_Z);
        }

        if (i > 0) {
          // Plate Carrée: a non-zero Reference Plate can put the antimeridian
          // seam at a different TRUE longitude than the map's own fixed
          // edges (see docs/plans/reference-plate.md), so an ordinary short
          // segment in the reconstructed geometry can land on opposite
          // DISPLAY edges of the flat map. Same "drop rather than draw a
          // wrong line" choice as windStreaks.ts's advect() -- one skipped
          // segment (a handful of pixels, given prep_coastlines.py's sampling
          // density) is invisible; a line spanning the whole map width isn't.
          if (this.mode !== 'plateCarree' || Math.abs(cx - px) <= Math.PI * R_SURFACE) {
            this.linePos[lw++] = px; this.linePos[lw++] = py; this.linePos[lw++] = pz;
            this.linePos[lw++] = cx; this.linePos[lw++] = cy; this.linePos[lw++] = cz;
          }
        }
        px = cx; py = cy; pz = cz;
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
          this.landPos[vw * 3] = rx * this.landRadius;
          this.landPos[vw * 3 + 1] = rz * this.landRadius;
          this.landPos[vw * 3 + 2] = -ry * this.landRadius;
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
 * Which coastline set belongs on this Model's globe, generalized from the
 * four hand-written versions of this same decision that predate it
 * (tomography/main.ts, climate/main.ts, valdes/main.ts, deformation/main.ts).
 *
 * 1. A Manifest with its own `reconstruction_model` (ADR-0004) is looked up
 *    in `archive.native_coastlines` -- never guessed from the model's id or
 *    name, and never falls back to (2) even if the lookup misses, since a
 *    run's own reconstruction is the only correct pairing for it.
 * 2. Otherwise, by Manifest type: the climate family sits on the Scotese
 *    plate model (Li et al. and the Scotese & Wright PaleoDEMs both do);
 *    tomography/convection sit on Muller et al. (`archive.coastlines`).
 * 3. Otherwise null -- a bare globe, tolerated everywhere already.
 */
export function resolveCoastlineSet(archive: ArchiveIndex, manifest: Manifest): CoastlineSet | null {
  if (manifest.reconstruction_model) {
    return archive.native_coastlines?.[manifest.reconstruction_model.toLowerCase()] ?? null;
  }
  switch (manifest.type) {
    case 'climate':
    case 'climate-monthly':
    case 'climate-ocean-depth':
    case 'paleogeography':
      return archive.scotese_coastlines ?? null;
    case 'tomography':
    case 'convection':
      return archive.coastlines ?? null;
    default:
      return null;
  }
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
  const [gBytes, rBytes] = await Promise.all([
    fetchVolumeBytes(`${base}/${geometryPath}`),
    fetchVolumeBytes(`${base}/${rotationsPath}`),
  ]);
  const lines = parseGeometry(gBytes.buffer.slice(gBytes.byteOffset, gBytes.byteOffset + gBytes.byteLength) as ArrayBuffer);
  const table: RotationTable = JSON.parse(new TextDecoder().decode(rBytes));
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
