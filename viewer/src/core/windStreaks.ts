import {
  BufferAttribute, BufferGeometry, Color, DoubleSide, Mesh, MeshBasicMaterial,
} from 'three';
import {
  DEG, EARTH_RADIUS_KM, R_SURFACE, eastNorthAt, lonLatToVec3, vec3ToLonLat,
} from './constants';
import { texelIndex, texelToPhysical } from './volume';
import type { VariableInfo } from './types';

// Same clearance reasoning as windGlyphs.ts's GLYPH_R -- just clear of the
// overlay sphere so there is no z-fighting concern.
const RIBBON_R = R_SURFACE * 1.001;

// Trail points per particle -- the ring buffer DEPTH, not a time duration by
// itself. How much real time a trail visually spans is TRAIL_LEN *
// RECORD_INTERVAL_S (below), since a fresh ring slot is only committed on
// that slower cadence, not every animation frame -- see advect()'s doc
// comment for why a per-frame commit (~12 frames = ~0.2s at 60fps) would be
// far too short a trail to read as a streak at all.
const TRAIL_LEN = 12;
const INDICES_PER_PARTICLE = (TRAIL_LEN - 1) * 6; // 2 triangles per segment
// ~1.5s of visible trail (TRAIL_LEN * RECORD_INTERVAL_S) against a 6s
// particle lifetime -- a trail that is a large minority, not the whole, of
// how long a particle lives, tuned by eye alongside STREAK_SPEED_SCALE.
const RECORD_INTERVAL_S = 0.125;

// setDensity()'s allowed range and the count at density=1 -- same
// "allocate for the densest setting, draw fewer via a range" pattern as
// WindGlyphs' InstancedMesh.count, but via BufferGeometry.setDrawRange()
// since this isn't instanced geometry (each particle's ribbon has its own
// vertices, not a shared mesh repeated by a per-instance matrix).
const BASE_PARTICLES = 2000;
const MIN_DENSITY = 0.5;
const MAX_DENSITY = 3;
const MAX_PARTICLES = Math.round(BASE_PARTICLES * MAX_DENSITY);

// Seconds a particle lives before respawning elsewhere. Finite lifetime +
// respawn (rather than particles living forever) keeps coverage even: wind
// continuously concentrates real air (and, without this, particles) toward
// convergence zones like the ITCZ while divergent regions empty out.
const PARTICLE_LIFETIME_S = 6;
const BASE_HALF_WIDTH = 0.0025; // ribbon half-width in scene units at size=1
// m/s beyond which colour stops getting brighter -- same "one outlier
// shouldn't wash out the whole scale" reasoning as windGlyphs.ts's own
// SPEED_CLIP_MS, independently tunable since it drives colour here, not length.
const SPEED_CLIP_MS = 20;

// Real wind speeds take DAYS to circle the globe -- a 10 m/s wind against
// EARTH_RADIUS_KM=6371 needs ~7 days to circumnavigate, which is invisible
// over a several-second trail lifetime. This is a deliberate artistic time
// compression, the same thing the Godot prototype's `speed: 50.0` and the
// real NASA/earth.nullschool renderings do -- tuned by eye (see README) so a
// ~10 m/s particle sweeps roughly 10-20 degrees of arc over its lifetime,
// not derived from anything physical.
const STREAK_SPEED_SCALE = 45000;
const EARTH_RADIUS_M = EARTH_RADIUS_KM * 1000;

const CALM_COLOR = new Color(0x1f5c7a);
const FAST_COLOR = new Color(0xeaffff);

/** Static (built once) index buffer: 2 triangles per trail segment, for
 *  every particle slot up to MAX_PARTICLES. Vertex data changes every tick;
 *  this topology never does, so it's built once and reused, mirroring how
 *  WindGlyphs' geometry is built once and only its instance matrices move. */
function buildIndex(): Uint32Array {
  const idx = new Uint32Array(MAX_PARTICLES * INDICES_PER_PARTICLE);
  let o = 0;
  for (let p = 0; p < MAX_PARTICLES; p++) {
    const base = p * TRAIL_LEN * 2;
    for (let i = 0; i < TRAIL_LEN - 1; i++) {
      const l0 = base + i * 2;
      const r0 = l0 + 1;
      const l1 = l0 + 2;
      const r1 = l0 + 3;
      idx[o++] = l0; idx[o++] = r0; idx[o++] = l1;
      idx[o++] = r0; idx[o++] = r1; idx[o++] = l1;
    }
  }
  return idx;
}

/**
 * A "Perpetual Ocean"-style particle flow field -- generic, no
 * paleoclimate-specific knowledge, sibling to WindGlyphs (see
 * docs/adr/0002-world-space-trail-ribbons-for-wind-flow.md for why this
 * exists as a distinct mode rather than an option on WindGlyphs).
 *
 * Each particle advects along a STATIC (u, v) snapshot -- whichever plane
 * the caller passes to update() -- leaving a fading, tapered ribbon of its
 * last TRAIL_LEN surface positions, fixed in world space so it survives
 * camera orbiting (ADR-0002). Particle state lives in flat typed arrays,
 * not objects, and the per-particle advection step is a self-contained
 * piece of the update loop below -- the seam a future GPU
 * (GPUComputationRenderer) version would replace, without touching how the
 * resulting positions become ribbon geometry.
 */
export class WindStreaks {
  readonly mesh: Mesh;
  private readonly geometry: BufferGeometry;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;

  // Per-particle state, indexed 0..MAX_PARTICLES-1. Only the first
  // activeCount are advected/drawn -- see setDensity().
  private readonly lon: Float32Array;
  private readonly lat: Float32Array;
  private readonly age: Float32Array; // seconds remaining until respawn
  private readonly speed: Float32Array; // most recent |wind|, m/s, for colour
  private readonly cursor: Uint8Array; // ring-buffer write position, 0..TRAIL_LEN-1
  private readonly trail: Float32Array; // MAX_PARTICLES * TRAIL_LEN * 3 (xyz)

  private activeCount = BASE_PARTICLES;
  private sizeScale = 1;
  /** Seconds accumulated since the trail ring buffers last advanced to a
   *  fresh slot -- see update()'s `commit` flag and advect()'s doc comment
   *  for why this is decoupled from the per-frame advection step. */
  private recordAccum = 0;

  constructor() {
    this.geometry = new BufferGeometry();
    const posArray = new Float32Array(MAX_PARTICLES * TRAIL_LEN * 2 * 3);
    const colArray = new Float32Array(MAX_PARTICLES * TRAIL_LEN * 2 * 4);
    this.positions = posArray;
    this.colors = colArray;
    this.geometry.setAttribute('position', new BufferAttribute(posArray, 3));
    this.geometry.setAttribute('color', new BufferAttribute(colArray, 4));
    this.geometry.setIndex(new BufferAttribute(buildIndex(), 1));
    this.geometry.setDrawRange(0, this.activeCount * INDICES_PER_PARTICLE);

    // depthWrite: false avoids z-fighting artefacts between many
    // overlapping translucent ribbons; side: DoubleSide because a ribbon's
    // winding flips with its travel direction and there is no lighting here
    // to make winding otherwise matter.
    const mat = new MeshBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false, side: DoubleSide,
    });
    this.mesh = new Mesh(this.geometry, mat);
    this.mesh.visible = false;
    this.mesh.frustumCulled = false; // particles range over the whole globe every frame

    this.lon = new Float32Array(MAX_PARTICLES);
    this.lat = new Float32Array(MAX_PARTICLES);
    this.age = new Float32Array(MAX_PARTICLES);
    this.speed = new Float32Array(MAX_PARTICLES);
    this.cursor = new Uint8Array(MAX_PARTICLES);
    this.trail = new Float32Array(MAX_PARTICLES * TRAIL_LEN * 3);

    // Seed every slot up front (not lazily on density increase -- it's
    // cheap and this way setDensity() never needs a special first-activation
    // branch). Ages are randomised on this COLD START only, so respawns
    // stay staggered across the whole particle set forever after; a natural
    // mid-simulation respawn always resets to the FULL lifetime, which
    // preserves the phase offset each particle was seeded with rather than
    // resynchronising it. Without the initial randomisation every particle
    // would respawn in the same visible pulse every PARTICLE_LIFETIME_S.
    for (let p = 0; p < MAX_PARTICLES; p++) this.respawn(p, true);
  }

  setVisible(v: boolean): void {
    this.mesh.visible = v;
  }

  setSize(scale: number): void {
    this.sizeScale = scale;
  }

  setDensity(density: number): void {
    const clamped = Math.min(MAX_DENSITY, Math.max(MIN_DENSITY, density));
    this.activeCount = Math.min(MAX_PARTICLES, Math.round(BASE_PARTICLES * clamped));
    this.geometry.setDrawRange(0, this.activeCount * INDICES_PER_PARTICLE);
  }

  /** Respawn every active particle at a fresh random position with a full
   *  lifetime -- used when the mode becomes visible again after being
   *  hidden, so stale state (and the large dt that hiding accumulates)
   *  never produces a single huge, wrong-looking jump on the next update(). */
  resetAll(): void {
    for (let p = 0; p < this.activeCount; p++) this.respawn(p, false);
  }

  /** Uniform-area random respawn: `lat` must be drawn via asin(uniform(-1,1)),
   *  NOT a uniform draw over [-90, 90] -- the latter clusters samples toward
   *  the poles, because the area a degree of latitude covers shrinks by
   *  cos(lat) away from the equator. `randomiseAge` is true only for the
   *  one-time cold-start seeding in the constructor; see its comment there. */
  private respawn(p: number, randomiseAge: boolean): void {
    const lat = Math.asin(Math.random() * 2 - 1) / DEG;
    const lon = Math.random() * 360 - 180;
    this.lat[p] = lat;
    this.lon[p] = lon;
    this.age[p] = randomiseAge ? PARTICLE_LIFETIME_S * Math.random() : PARTICLE_LIFETIME_S;
    this.speed[p] = 0;

    const [x, y, z] = lonLatToVec3(lon, lat, RIBBON_R);
    for (let k = 0; k < TRAIL_LEN; k++) {
      const base = (p * TRAIL_LEN + k) * 3;
      this.trail[base] = x; this.trail[base + 1] = y; this.trail[base + 2] = z;
    }
    this.cursor[p] = 0;
  }

  /** uData/vData: ONE month's plane, nlon*nlat bytes each, lon-fastest --
   *  see WindGlyphs.update()'s own doc comment; the two share the exact
   *  same plane-decoding contract. dtSeconds is real wall-clock time since
   *  the last tick (see STREAK_SPEED_SCALE for why it is NOT applied 1:1
   *  to physical wind speed). */
  update(
    dtSeconds: number,
    uData: Uint8Array, vData: Uint8Array, nlon: number, nlat: number,
    uVar: VariableInfo, vVar: VariableInfo,
  ): void {
    const dt = Math.min(dtSeconds, 0.25); // guard a tab-backgrounded huge dt spike
    this.recordAccum += dt;
    const commit = this.recordAccum >= RECORD_INTERVAL_S;
    if (commit) this.recordAccum -= RECORD_INTERVAL_S;

    for (let p = 0; p < this.activeCount; p++) {
      this.age[p] -= dt;
      let justRespawned = false;
      if (this.age[p] <= 0) {
        this.respawn(p, false);
        justRespawned = true;
      } else {
        this.advect(p, dt, uData, vData, nlon, nlat, uVar, vVar, commit);
      }
      // A respawn touches every trail slot (see respawn()'s doc comment),
      // so it needs the full rebuild below regardless of `commit`.
      this.writeRibbon(p, commit || justRespawned);
    }

    // Buffers are allocated for MAX_PARTICLES (setDensity()'s capacity, see
    // the constructor), but plain needsUpdate=true re-uploads the WHOLE
    // buffer to the GPU regardless of activeCount -- at density=1 that is
    // 3x more data transferred every frame than is actually active.
    // addUpdateRange() scopes the upload to just the active particles'
    // vertices, which are always the first activeCount (setDensity() never
    // reorders particles, only changes how many of the leading ones count).
    const activeFloats3 = this.activeCount * TRAIL_LEN * 2 * 3;
    const activeFloats4 = this.activeCount * TRAIL_LEN * 2 * 4;
    const posAttr = this.geometry.attributes.position as BufferAttribute;
    const colAttr = this.geometry.attributes.color as BufferAttribute;
    posAttr.clearUpdateRanges();
    posAttr.addUpdateRange(0, activeFloats3);
    posAttr.needsUpdate = true;
    colAttr.clearUpdateRanges();
    colAttr.addUpdateRange(0, activeFloats4);
    colAttr.needsUpdate = true;
  }

  /** The advection step, isolated from ribbon-building on either side of it
   *  (see the class doc comment): sample (u, v) at the particle's current
   *  position, take one small spherical-Euler step along the local tangent
   *  plane, and re-derive lon/lat for the next tick's lookup. Steps stay
   *  small (dt is one animation frame), which is what makes "step then
   *  renormalise onto the sphere" a valid substitute for exact geodesic
   *  integration here -- the flat Godot prototype's plain
   *  `position += velocity * dt` has no sphere to renormalise onto and
   *  cannot be reused as-is. */
  private advect(
    p: number, dt: number,
    uData: Uint8Array, vData: Uint8Array, nlon: number, nlat: number,
    uVar: VariableInfo, vVar: VariableInfo,
    commit: boolean,
  ): void {
    const lon = this.lon[p];
    const lat = this.lat[p];
    const texel = texelIndex(nlon, nlat, lon, lat);
    const u = texelToPhysical(uVar, uData[texel]);
    const v = texelToPhysical(vVar, vData[texel]);
    this.speed[p] = Math.hypot(u, v);

    const { east, north } = eastNorthAt(lon, lat);
    const [px, py, pz] = lonLatToVec3(lon, lat, RIBBON_R);
    const step = (dt * STREAK_SPEED_SCALE) / EARTH_RADIUS_M;
    let nx = px + (u * east[0] + v * north[0]) * step;
    let ny = py + (u * east[1] + v * north[1]) * step;
    let nz = pz + (u * east[2] + v * north[2]) * step;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx = (nx / len) * RIBBON_R; ny = (ny / len) * RIBBON_R; nz = (nz / len) * RIBBON_R;

    const next = vec3ToLonLat(nx, ny, nz);
    this.lon[p] = next.lon;
    this.lat[p] = next.lat;

    // Advection runs every frame so the HEAD moves smoothly, but committing
    // a new ring-buffer slot every frame would make the trail span only
    // TRAIL_LEN frames (~0.2s at 60fps) of real time -- far too short to
    // read as a streak. Instead the current slot is simply overwritten each
    // frame until `commit` (driven by a slower cadence in update(), see
    // RECORD_INTERVAL_S) says to advance to a fresh slot -- see writeRibbon
    // and its call site.
    const c = commit ? (this.cursor[p] + 1) % TRAIL_LEN : this.cursor[p];
    this.cursor[p] = c;
    const base = (p * TRAIL_LEN + c) * 3;
    this.trail[base] = nx; this.trail[base + 1] = ny; this.trail[base + 2] = nz;
  }

  /** Walk one particle's trail ring in chronological order (oldest to
   *  newest) and write its ribbon's vertex positions and colours. Width and
   *  alpha both taper toward the tail (ADR-0002's "fading, tapered ribbon");
   *  colour is speed-tinted by whatever the particle's speed was AT THE TIME
   *  each point committed (see below), not repainted retroactively.
   *
   *  Performance: k=TRAIL_LEN-1 (the head, see the ring-index formula below)
   *  is the only point that moves on a non-commit frame -- advect() only
   *  overwrites the current cursor slot, and every OTHER trail point's
   *  ring index is unchanged until the cursor itself advances. So a
   *  non-commit tick only recomputes that one vertex pair rather than
   *  redoing the whole TRAIL_LEN loop; this is what keeps the per-frame CPU
   *  cost proportional to particle count rather than particle count *
   *  TRAIL_LEN for the common (7 out of 8, at RECORD_INTERVAL_S=0.125s and
   *  60fps) case. `full` forces the whole loop: on a commit (the ring index
   *  mapping shifts for every k) or a respawn (every trail slot changed). */
  private writeRibbon(p: number, full: boolean): void {
    const c = this.cursor[p];
    const halfWidth = BASE_HALF_WIDTH * this.sizeScale;
    const t = Math.min(this.speed[p], SPEED_CLIP_MS) / SPEED_CLIP_MS;
    const r = CALM_COLOR.r + (FAST_COLOR.r - CALM_COLOR.r) * t;
    const g = CALM_COLOR.g + (FAST_COLOR.g - CALM_COLOR.g) * t;
    const b = CALM_COLOR.b + (FAST_COLOR.b - CALM_COLOR.b) * t;

    for (let k = full ? 0 : TRAIL_LEN - 1; k < TRAIL_LEN; k++) {
      const ringIdx = (c + 1 + k) % TRAIL_LEN; // k=0 oldest (tail) .. k=TRAIL_LEN-1 newest (head)
      const base = (p * TRAIL_LEN + ringIdx) * 3;
      const x = this.trail[base]; const y = this.trail[base + 1]; const z = this.trail[base + 2];

      // Central difference for an interior direction estimate; one-sided at
      // the ends of the ring's chronological order (not the ring's raw
      // index order, which wraps arbitrarily).
      const kPrev = Math.max(0, k - 1);
      const kNext = Math.min(TRAIL_LEN - 1, k + 1);
      const prevBase = (p * TRAIL_LEN + ((c + 1 + kPrev) % TRAIL_LEN)) * 3;
      const nextBase = (p * TRAIL_LEN + ((c + 1 + kNext) % TRAIL_LEN)) * 3;
      let dx = this.trail[nextBase] - this.trail[prevBase];
      let dy = this.trail[nextBase + 1] - this.trail[prevBase + 1];
      let dz = this.trail[nextBase + 2] - this.trail[prevBase + 2];
      const dirLen = Math.hypot(dx, dy, dz);
      // Degenerate (freshly spawned or perfectly calm): fall back to the
      // local east direction rather than propagate a NaN from normalising
      // a zero vector -- it self-corrects within a few ticks as the
      // particle actually moves.
      if (dirLen < 1e-9) {
        const { east } = eastNorthAt(this.lon[p], this.lat[p]);
        [dx, dy, dz] = east;
      } else {
        dx /= dirLen; dy /= dirLen; dz /= dirLen;
      }

      // Perpendicular to travel direction, in the local tangent plane
      // (radial = the position itself, since the sphere is centred on the
      // origin) -- this is what keeps the ribbon lying flush against the
      // globe's surface regardless of camera angle, the same tangent-frame
      // reasoning WindGlyphs uses for arrow orientation.
      const rl = Math.hypot(x, y, z) || 1;
      const rx = x / rl; const ry = y / rl; const rz = z / rl;
      let sx = dy * rz - dz * ry;
      let sy = dz * rx - dx * rz;
      let sz = dx * ry - dy * rx;
      const sLen = Math.hypot(sx, sy, sz) || 1;
      const fade = k / (TRAIL_LEN - 1); // 0 at tail, 1 at head
      const w = (halfWidth * fade) / sLen;
      sx *= w; sy *= w; sz *= w;

      const vBase = (p * TRAIL_LEN + k) * 2; // 2 vertices (left, right) per trail point
      const posL = vBase * 3;
      const posR = posL + 3;
      this.positions[posL] = x + sx; this.positions[posL + 1] = y + sy; this.positions[posL + 2] = z + sz;
      this.positions[posR] = x - sx; this.positions[posR + 1] = y - sy; this.positions[posR + 2] = z - sz;

      const colL = vBase * 4;
      const colR = colL + 4;
      this.colors[colL] = r; this.colors[colL + 1] = g; this.colors[colL + 2] = b; this.colors[colL + 3] = fade;
      this.colors[colR] = r; this.colors[colR + 1] = g; this.colors[colR + 2] = b; this.colors[colR + 3] = fade;
    }
  }
}
