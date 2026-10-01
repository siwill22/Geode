import { Vector3, type Camera } from 'three';

import { flatWorldToLonLat, isFlat, type ProjectionMode } from './projection';
import {
  composeQuaternions, deltaRotation, geoVecFromLonLat, quaternionFromAxisAngle, type Quaternion,
} from './rotation';

export interface MapOrientationDragDeps {
  getCamera(): Camera;
  getMode(): ProjectionMode;
  getOrientation(): Quaternion;
}

/**
 * Optional behaviour; leaving it out (every caller before this existed) keeps
 * the full versor drag exactly as it was.
 */
export interface MapOrientationDragOptions {
  /** Drag changes only the map's centre LONGITUDE: the cursor's change in
   *  display longitude becomes a turn about the pole, so a horizontal drag
   *  spins the map around and a vertical one does nothing. The equator stays
   *  where it is. Use with an orientation that is itself a pure longitude
   *  turn (e.g. `orientationQuaternion(lon, 0, 0)`), which then stays one. */
  longitudeOnly?: boolean;
  /** A mostly-sideways wheel/trackpad scroll also turns the centre longitude
   *  (in flat Projections only). Taken before OrbitControls sees the event,
   *  so a vertical scroll still zooms exactly as before. */
  horizontalWheel?: boolean;
}

const DEG = Math.PI / 180;
/** Degrees of centre longitude per pixel of sideways scroll. */
const WHEEL_DEG_PER_PX = 0.25;

/** A longitude difference wrapped into (-180, 180]. */
function wrapDeg(d: number): number {
  return d - 360 * Math.round(d / 360);
}

/**
 * Click-and-drag-the-map itself to change Map Orientation (see CONTEXT.md's
 * Map Orientation entry) -- the linked Observable "versor dragging"
 * notebook's own UX, on the actual map rather than a separate widget (an
 * earlier version of this control put the drag target on a small inset
 * compass instead; confusing on its own terms -- "drag the little globe,
 * not the big one" needed explaining rather than being obvious).
 *
 * Grabs the TRUE (lon, lat) under the cursor at drag start (`flatWorldToLonLat`,
 * the inverse of `lonLatToProjected`) and, on every move, the versor
 * (`deltaRotation`) that would carry that point to wherever the cursor is
 * NOW -- composed onto the orientation captured at drag start, so a
 * continuous drag reads as "grab this point and drag it", exactly like
 * spinning a ball under your finger. Both points are read in DISPLAY space
 * (i.e. already Map-Oriented, not unrotated back to true) -- consistent
 * with how the map itself is drawn, and the only frame in which "the point
 * under the cursor" is meaningful.
 *
 * A no-op outside a flat Projection (Globe already free-orbits via
 * `OrbitControls`) and wherever the cursor falls outside the map's own
 * outline (Robinson's boundary is a curve; `flatWorldToLonLat` returns null
 * there) -- a drag that starts off the map, or wanders off it mid-drag,
 * simply stops updating rather than snapping to a meaningless edge value.
 *
 * The caller is responsible for disabling `OrbitControls`' own pan on the
 * SAME element in flat mode -- otherwise both this and OrbitControls try to
 * interpret the identical drag (docs/plans -- this session's Map
 * Orientation plan's "click-and-drag the main view" follow-up).
 */
export function wireMapOrientationDrag(
  el: HTMLElement,
  deps: MapOrientationDragDeps,
  onChange: (q: Quaternion) => void,
  options: MapOrientationDragOptions = {},
): void {
  let dragStart: [number, number, number] | null = null;
  let qAtDragStart: Quaternion = [0, 0, 0, 1];
  // longitudeOnly: the display longitude last under the cursor, and the
  // orientation built up so far in this drag. Accumulated move by move, so a
  // drag that carries the cursor across the map's edge (display longitude
  // jumping from +180 to -180) still turns smoothly rather than by a full lap.
  let lastLon: number | null = null;
  let qDrag: Quaternion = [0, 0, 0, 1];

  function pointToLonLat(ev: PointerEvent): { lon: number; lat: number } | null {
    const mode = deps.getMode();
    if (!isFlat(mode)) return null;
    const rect = el.getBoundingClientRect();
    const ndcX = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -(((ev.clientY - rect.top) / rect.height) * 2 - 1);
    const world = new Vector3(ndcX, ndcY, 0).unproject(deps.getCamera());
    return flatWorldToLonLat(mode, world.x, world.y);
  }

  function pointToGeoVec(ev: PointerEvent): [number, number, number] | null {
    const ll = pointToLonLat(ev);
    return ll ? geoVecFromLonLat(ll.lon, ll.lat) : null;
  }

  /** `q` turned about the pole by `deg` of display longitude. */
  function turned(q: Quaternion, deg: number): Quaternion {
    return composeQuaternions(quaternionFromAxisAngle([0, 0, 1], deg * DEG), q);
  }

  el.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    if (options.longitudeOnly) {
      const ll = pointToLonLat(ev);
      if (!ll) return;
      lastLon = ll.lon;
      qDrag = deps.getOrientation();
    } else {
      const p = pointToGeoVec(ev);
      if (!p) return;
      dragStart = p;
      qAtDragStart = deps.getOrientation();
    }
    el.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  });

  el.addEventListener('pointermove', (ev) => {
    if (options.longitudeOnly) {
      if (lastLon === null) return;
      const ll = pointToLonLat(ev);
      if (!ll) return;
      const d = wrapDeg(ll.lon - lastLon);
      lastLon = ll.lon;
      if (d === 0) return;
      qDrag = turned(qDrag, d);
      onChange(qDrag);
      return;
    }
    if (!dragStart) return;
    const cur = pointToGeoVec(ev);
    if (!cur) return;
    onChange(composeQuaternions(deltaRotation(dragStart, cur), qAtDragStart));
  });

  const endDrag = (): void => { dragStart = null; lastLon = null; };
  el.addEventListener('pointerup', endDrag);
  el.addEventListener('pointercancel', endDrag);

  if (options.horizontalWheel) {
    // Capture phase on the same element: at the target, capture listeners run
    // before OrbitControls' own (non-capture) wheel listener, so a sideways
    // scroll can be kept from it while an up/down scroll passes through.
    el.addEventListener('wheel', (ev) => {
      if (!isFlat(deps.getMode())) return;
      if (Math.abs(ev.deltaX) <= Math.abs(ev.deltaY)) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      const px = ev.deltaX * (ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? el.clientWidth : 1);
      // Scrolling right brings what is to the east into view: the map moves
      // west under a fixed frame, so display longitudes decrease.
      onChange(turned(deps.getOrientation(), -px * WHEEL_DEG_PER_PX));
    }, { capture: true, passive: false });
  }
}
