import {
  BufferGeometry, ConeGeometry, CylinderGeometry, InstancedMesh, MeshBasicMaterial,
  Object3D, Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { DEG, R_SURFACE, eastNorthAt, lonLatToVec3 } from './constants';
import { texelToPhysical } from './volume';
import type { VariableInfo } from './types';

// Just clear of the overlay sphere (R_SURFACE * 1.0006, see
// climateInstance.ts's OVERLAY_R) -- arrows are real 3D geometry, not a
// second coincident sphere surface, so there is no z-fighting concern here;
// this only needs to clear the surface visually.
const GLYPH_R = R_SURFACE * 1.001;

// Half the previous step in BOTH directions (rings and per-ring count each
// double, see buildLattice) -- 4x the arrow count for 2x the linear density.
const LAT_STEP_DEG = 7.5;
const HEAD_RADIUS = 0.005;
const SHAFT_RADIUS = 0.0018;
// Fraction of an arrow's total length given to the head -- the rest is shaft.
const HEAD_FRACTION = 0.35;
const MIN_ARROW_LEN = 0.012;
const MAX_ARROW_LEN = 0.045;
// m/s beyond which an arrow's length stops growing. 1000 hPa wind at this
// clip is already brisk; without it, one storm-force outlier in 55 ages
// would compress every other arrow on the whole globe toward invisibility --
// the same "one outlier distorts the whole shared scale" failure mode fixed
// for the hillshade overlay, avoided here the same way: clip, don't rescale
// to the extremum.
const SPEED_CLIP_MS = 20;

interface Sample { lon: number; lat: number; }

/**
 * A coarse lon/lat sample lattice for the glyph field.
 *
 * Excludes the rows within one lat-step of either pole outright -- "east" is
 * undefined exactly at lat=+-90 (every longitude is the same physical
 * point there; see eastNorthAt's own doc comment), so there is no
 * physically meaningful arrow to draw on those rows at all, not just a
 * numerically awkward one. Longitude spacing widens toward the poles
 * (divided by cos(lat)) so the lattice stays roughly even in physical area
 * rather than clustering where meridians converge -- a uniform lon/lat step
 * would put far more arrows per unit ground area near +-75 deg than at the
 * equator.
 */
function buildLattice(latStep = LAT_STEP_DEG): Sample[] {
  const samples: Sample[] = [];
  for (let lat = -90 + latStep; lat <= 90 - latStep + 1e-6; lat += latStep) {
    const nLon = Math.max(4, Math.round(360 / Math.min(180, latStep / Math.cos(lat * DEG))));
    for (let i = 0; i < nLon; i++) {
      samples.push({ lon: -180 + (360 * i) / nLon, lat });
    }
  }
  return samples;
}

/** A thin shaft (cylinder) with a cone head on top, merged into one
 *  geometry so a single InstancedMesh instance -- and a single per-instance
 *  matrix -- draws both: root at local +Y=0, tip at local +Y=1, oriented
 *  per-instance by rotating +Y onto the wind direction (see update()).
 *  Radii are baked in absolute (not unit) so only the Y axis needs scaling
 *  per instance for length -- the line stays a constant thickness regardless
 *  of wind speed, only its length changes. */
function makeArrowGeometry(): BufferGeometry {
  const shaftHeight = 1 - HEAD_FRACTION;
  const shaft = new CylinderGeometry(SHAFT_RADIUS, SHAFT_RADIUS, shaftHeight, 6);
  shaft.translate(0, shaftHeight / 2, 0);
  const head = new ConeGeometry(HEAD_RADIUS, HEAD_FRACTION, 6);
  head.translate(0, shaftHeight + HEAD_FRACTION / 2, 0);
  const merged = mergeGeometries([shaft, head]);
  shaft.dispose();
  head.dispose();
  if (!merged) throw new Error('windGlyphs: failed to merge shaft+head arrow geometry');
  return merged;
}

/** (lon, lat) -> the flat index into one month's (nlat, nlon) plane. Mirrors
 *  geographic.ts's volumeUVW mapping exactly (see GEOGRAPHIC_GLSL): no
 *  half-texel offset on longitude (it wraps, no duplicate column), nearest
 *  gridline-registered row on latitude. */
function texelIndex(nlon: number, nlat: number, lon: number, lat: number): number {
  const pLon = (lon + 180) / 360;
  let iLon = Math.floor(pLon * nlon) % nlon;
  if (iLon < 0) iLon += nlon;
  const pLat = (lat + 90) / 180;
  const jLat = Math.min(nlat - 1, Math.max(0, Math.round(pLat * (nlat - 1))));
  return jLat * nlon + iLon;
}

const UP = new Vector3(0, 1, 0);

/**
 * A vector field of arrow glyphs on the globe's surface -- generic, no
 * paleoclimate-specific knowledge (mirrors DepthSlice/FrameCache as a shared
 * engine primitive). One InstancedMesh, built once; update() re-poses every
 * instance from a pair of decoded scalar planes (u, v components) without
 * touching geometry or material.
 */
export class WindGlyphs {
  readonly mesh: InstancedMesh;
  private readonly lattice = buildLattice();
  private readonly tmp = new Object3D();
  private readonly dir = new Vector3();
  /** Uniform multiplier on top of the speed-driven length (and, unlike
   *  speed, the thickness too) -- a user-facing "how big" control,
   *  independent of the physical wind magnitude. See setSize(). */
  private sizeScale = 1;

  constructor() {
    const geo = makeArrowGeometry();
    const mat = new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 });
    this.mesh = new InstancedMesh(geo, mat, this.lattice.length);
    this.mesh.visible = false;
  }

  setVisible(v: boolean): void {
    this.mesh.visible = v;
  }

  /** Set the size multiplier applied on the NEXT update() -- does not repose
   *  existing instances itself, since it has no data of its own to repose
   *  them from (see ClimateInstance.setWindScale, which follows this with a
   *  refreshWindGlyphs() using whatever U/V frame is already held). */
  setSize(scale: number): void {
    this.sizeScale = scale;
  }

  /** uData/vData: ONE month's plane, nlon*nlat bytes each, lon-fastest --
   *  a slice of the volume's raw backing buffer (see loadVolume's own doc
   *  comment on that memory order), not a whole Data3DTexture. Decoded
   *  through uVar/vVar's own encode range: the raw byte alone means nothing
   *  without it (see texelToPhysical). */
  update(
    uData: Uint8Array, vData: Uint8Array, nlon: number, nlat: number,
    uVar: VariableInfo, vVar: VariableInfo,
  ): void {
    for (let i = 0; i < this.lattice.length; i++) {
      const { lon, lat } = this.lattice[i];
      const texel = texelIndex(nlon, nlat, lon, lat);
      const u = texelToPhysical(uVar, uData[texel]);
      const v = texelToPhysical(vVar, vData[texel]);
      const speed = Math.hypot(u, v);

      // u/v are already components in the local east/north tangent frame --
      // eastNorthAt supplies that frame's actual 3D directions AT THIS POINT
      // (which rotate with position on a sphere), so this sum is a real 3D
      // tangent-plane direction, not a flat (u, v) -> (x, y) guess.
      const { east, north } = eastNorthAt(lon, lat);
      this.dir.set(
        u * east[0] + v * north[0],
        u * east[1] + v * north[1],
        u * east[2] + v * north[2],
      );
      if (this.dir.lengthSq() < 1e-8) this.dir.set(0, 1, 0); // calm: length ~0 makes orientation invisible anyway
      else this.dir.normalize();

      const [px, py, pz] = lonLatToVec3(lon, lat, GLYPH_R);
      this.tmp.position.set(px, py, pz);
      this.tmp.quaternion.setFromUnitVectors(UP, this.dir);
      const len = (MIN_ARROW_LEN
        + (Math.min(speed, SPEED_CLIP_MS) / SPEED_CLIP_MS) * (MAX_ARROW_LEN - MIN_ARROW_LEN))
        * this.sizeScale;
      // Thickness scales too (not just length): a bigger arrow should look
      // like the same arrow zoomed in, not a longer thin one.
      this.tmp.scale.set(this.sizeScale, len, this.sizeScale);
      this.tmp.updateMatrix();
      this.mesh.setMatrixAt(i, this.tmp.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
