/*
 * The engraved volcano glyph.
 *
 * Hand-authored, unlike `mountainGlyph.ts` which is generated from the reference
 * notebook's own EPS. The notebook has no volcano, so there is nothing to port
 * and nothing to match: this is drawn to sit beside the hachured ranges rather
 * than to reproduce a source.
 *
 * Same contract as the mountain glyph, so the two can be scaled and placed by
 * identical code: normalised to unit WIDTH (x spans -0.5..0.5) with the baseline
 * at y = 0 and the summit at -VOLCANO_ASPECT, canvas-style with y growing
 * downward. The glyph stands ON its point rather than being centred on it.
 *
 * Two paths rather than one, because they are inked differently. The cone is
 * filled; the plume of smoke is stroked, so it reads as a wisp at any size
 * instead of a blob. A caller that wants the silhouette alone can draw the cone
 * and skip the smoke -- which is what the small ridge and plume symbols do,
 * since at 6 px a curl of smoke is indistinguishable from a smudge.
 */

/** Height as a fraction of width, cone only -- the smoke rises above this. */
export const VOLCANO_ASPECT = 0.62;

let coneCache: Path2D | null = null;
let smokeCache: Path2D | null = null;

/**
 * The cone: a truncated, slightly concave-flanked peak with a crater notch.
 *
 * Concave flanks are what make it read as a volcano rather than a triangle --
 * a straight-sided cone at this size looks like a tent. The notch is
 * deliberately shallow; a deep V reads as a crack at small sizes.
 */
export function volcanoCone(): Path2D {
  if (coneCache) return coneCache;
  const p = new Path2D();
  p.moveTo(-0.50, 0);
  // Left flank, concave: the control point sits inside the straight line.
  p.quadraticCurveTo(-0.26, -0.20, -0.145, -0.585);
  p.lineTo(-0.075, -0.545);          // crater rim, left lip down into the notch
  p.lineTo(-0.028, -0.60);
  p.lineTo(0.028, -0.60);
  p.lineTo(0.075, -0.545);           // right lip
  p.lineTo(0.145, -0.585);
  p.quadraticCurveTo(0.26, -0.20, 0.50, 0);
  p.closePath();
  coneCache = p;
  return p;
}

/**
 * The smoke: an open curl rising from the crater, to be STROKED not filled.
 *
 * Starts just above the notch so it does not overlap the cone's own ink, which
 * at low alpha would otherwise show as a darker patch at the summit.
 */
export function volcanoSmoke(): Path2D {
  if (smokeCache) return smokeCache;
  const p = new Path2D();
  p.moveTo(0, -0.64);
  p.bezierCurveTo(-0.10, -0.78, 0.10, -0.86, 0.02, -1.00);
  smokeCache = p;
  return p;
}
