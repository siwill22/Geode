# Wind (glyphs and streaks) reprojects in Plate Carrée

ADR-0003 explicitly scoped wind out of Plate Carrée v1 alongside coastlines,
lumping them together as "CPU-positioned, not shader-reprojected." That
grouping undersold wind's case: unlike coastlines' plate-rotation slerp
(genuinely unrelated machinery), wind's per-sample position and tangent-frame
math (`lonLatToVec3`/`eastNorthAt` in `WindGlyphs.update()` and
`WindStreaks.advect()`/`writeRibbon()`) has a direct flat-plane counterpart
(`lonLatToFlatVec3`/`FLAT_EAST`/`FLAT_NORTH` in `core/projection.ts`) --
simpler than the sphere version, since the flat plane's tangent frame is
constant everywhere rather than position-dependent. We're reprojecting it
properly instead of leaving it hidden.

Two sub-decisions worth recording:

**The glyph lattice is mode-specific, not just repositioned.** `buildLattice()`
narrows longitude spacing near the poles (divided by cos(lat)) to keep even
PHYSICAL-sphere-area coverage. Reusing that same lattice on a flat
equirectangular map -- which has no meridian convergence to compensate for --
would under-populate high latitudes relative to how the map actually reads,
the opposite of its purpose. `buildLatticeFlat()` is a plain uniform grid
instead. `WindGlyphs` tracks `latStep` and rebuilds via whichever builder
`setProjection()` last selected.

**A particle crossing the antimeridian respawns rather than wraps.** On the
globe, `WindStreaks.advect()`'s "step then renormalise onto the sphere" has
no seam -- longitude -180/180 is one continuous meridian in 3D. On the flat
plane, it's a real edge: wrapping longitude naïvely would draw one ribbon
segment stretching across the whole map width, since the trail's previous and
new points are geometrically far apart in world space despite being
physically adjacent on the map. Detecting the crossing (`|nextLon - lon| >
180` after `wrapLon()`) and respawning the particle immediately avoids the
glitch outright, at the cost of that one particle's trail ending abruptly at
the edge -- which reads as the particle leaving the frame, not as a bug.
Latitude has no equivalent seam (it's a real edge, not a wraparound), so it's
simply clamped to [-90, 90] rather than respawned.

## Consequences

`WindGlyphs`'s `InstancedMesh` is now allocated for
`max(buildLattice(MIN_LAT_STEP_DEG).length, buildLatticeFlat(MIN_LAT_STEP_DEG).length)`
rather than just the sphere figure, since the flat lattice has more samples
at the same step (no polar thinning) -- a larger fixed GPU buffer, allocated
once, regardless of which Projection is ever actually used.
`WindStreaks.setProjection()` forces a full `resetAll()` on a real mode
change, since every particle's trail is world positions baked under the OLD
embedding -- meaningless, not just stale, once the embedding changes.
Coastlines and land fill remain out of scope, unchanged from ADR-0003.
