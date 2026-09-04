import type { LonLat } from '../core/constants';

/**
 * One point query's result: the value of the currently-displayed frame at
 * the grid cell nearest a click. Deliberately its own tiny type rather than
 * importing core/queryPoint.ts's CellSample -- that module reduces bytes
 * across ALL Frames (Age Series) or ALL depth layers (Month Profile), which
 * would mean fetching every Frame a model has on a single click (up to
 * ~1000 for a long deformation run) instead of reading the texture already
 * on screen. See globeInstance.ts's pointValue() for the cheap, current-frame-only
 * query this actually backs.
 */
export interface CellSample {
  cell: LonLat;
  /** NaN if this cell held the no-data sentinel at the current Frame. */
  value: number;
}
