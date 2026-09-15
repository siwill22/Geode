# Robinson joins Plate Carrée, and land fill finally reprojects with it

ADR-0003 added Plate Carrée as the first alternate Projection and said more were
expected. Robinson is the second. Adding it forced two changes with reach beyond
the paleobiology viewer that asked for it.

## Robinson needs an inverse, and has no closed form

Every flat Projection here is drawn by putting a plane in front of an
orthographic camera and asking, per fragment, "which (lon, lat) am I?". For
Plate Carrée that inverse is `p.xy / R` — linear, exact, free. Robinson has no
closed form in either direction: it is defined by a 19-entry table at 5° steps.

It is still cheap, because of a property worth writing down: **Y(lat) is
strictly increasing**, so latitude comes from an exact table bracket and
longitude from evaluating X at the recovered latitude. No iteration, no
root-finding, nothing that could fail to converge in a fragment shader.

Two consequences that are not obvious:

- **The table is generated from PROJ, not transcribed.** `core/robinson.ts`
  holds it once, and `GEOGRAPHIC_GLSL` builds its GLSL literal *from that array*
  rather than carrying a second copy. Two transcriptions of a 38-number table
  would drift, and the drift would look like a slightly wrong map.
- **Robinson is not onto, so the shader must discard.** Its boundary is a curve,
  so a rectangular plane big enough to hold the map necessarily has corners that
  are not on the Earth. Clamping there grows rectangular ears of smeared polar
  data where the map should simply end.

## `isFlat()`, because "not globe" was being spelled `=== 'plateCarree'`

Several places tested for Plate Carrée by name where they meant "any flat map":
the coastline antimeridian-seam test, the tracked-particle bail-out, the
orthographic frustum. Every one of them was a latent bug that fired the moment a
second flat projection existed.

`ProjectionMode` now has an `isFlat()` predicate and code asks that instead.
Relatedly, an orthographic camera records which Projection it was framed for in
`userData`, because `updateProjectionCameraAspect(camera, aspect)` is called from
every wrapper's resize handler and had no way to ask — Robinson's map is not
2:1, so resizing a Robinson view through Plate Carrée's frustum silently
reframed it.

**This did not catch every case, and the first draft of this ADR claimed it
did.** Two `=== 'plateCarree'` tests survived in climate's and Valdes' page
chrome, where they drove a two-state icon toggle that could not reach a third
Projection at all — which is why Robinson initially shipped visible only in
paleobio. A worse one survived in `core/`: the entire wind path (glyph
positions and directions, streak positions) went through Plate-Carrée-only
helpers. See `docs/plans/robinson-rollout.md` for what was found and fixed
afterwards, and treat "every one of them" above as the intent rather than the
outcome.

## Land fill reprojects now, which it never did

`Coastlines.setProjection()` reprojected the line set only. Land fill vertices
stayed on the sphere in every Projection, so Plate Carrée drew flat coastlines
over a spherical blob of land. That was survivable while the only flat mode was
used with an opaque raster covering the whole sphere. It is not survivable for a
viewer whose land fill *is* the basemap — the Panama dataset has no paleogeography
raster, because the only Phanerozoic one in the catalog carries Scotese's
continent positions and that dataset is reconstructed under Müller 2019
(ADR-0034).

So land is reprojected with the same rotate-then-project step the lines use, and
triangles straddling the antimeridian are **dropped**, not clipped — the same
"drop rather than draw a wrong thing" choice the line seam test already makes. A
few pixels go missing at the map edge; the alternative is a bar of land painted
across the ocean.

Two things this cost, both found only by looking at the render:

- The seam threshold was a hardcoded `π·R`. Robinson's map is narrower, so the
  wrong threshold leaves genuinely-short segments undrawn near the edges.
  `flatHalfWidth(mode)` now supplies it.
- Depth ordering had to be restated. On a sphere, land and lines are separated
  by *radius*; on a plane the same intent is a Z offset, and the sign is easy to
  invert — an orthographic camera looking down −Z means nearer is *larger* z.
  Getting it backwards put land at the same depth as the opaque backdrop, where
  it z-fought and lost, and continents rendered as bare outlines.

## Consequences

- Plate Carrée in the climate and Valdes viewers gains correct land fill as a
  side effect. That is a fix, but it is a visible change to viewers this ADR was
  not written for, and worth knowing about when one of them next looks different.
- A further projection (Mollweide, Spilhaus) needs: a forward/inverse pair, a
  `PROJECTION_UNIFORM` value, a shader branch, and an entry in `flatHalfWidth`.
  Nothing else — the overlays, coastlines and camera all go through
  `lonLatToProjected`/`isFlat` now.
- `createFlatBackdropMaterial()` exists in `core/material.ts` for the
  "opaque fill of the map's own outline" case, which a sphere backdrop cannot
  serve on a flat map.
