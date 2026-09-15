# Old Map viewer — spec

Status: **proposed**, resolved through a grilling session 2026-09-15. Nothing built.

A new Geode wrapper that draws a plate reconstruction as an aged engraved
chart: pen lines, a graded coastal wash, hachured mountain ranges standing
where the reconstruction says an orogen should be, all on a stained and
folded sheet of paper. One time slider.

The reference implementation is `~/GIT/degenerative_art/withMountains.ipynb`,
which already works — see the 100 Ma render in its cell 5. This spec is about
what changes when the output is an interactive page instead of a JPEG, and
the answer turned out to be "less than expected": most of the notebook's
computation doesn't need to be ported at all.

## The three style elements, precisely

The notebook's variable names are inverted relative to what they hold, so
state them by what they are. All derive from two great-circle distance fields
over a rasterized land/ocean mask (`map_effects.raster_buffer(rp,
inside='both')`):

| Element | Field | Extent | Notebook |
|---|---|---|---|
| **Wash** — orange→white fringe | distance **inland from the coast** | 0–400 km, on land | `draw_coastline_blur(prox_ocean, dist_max=400000)` |
| **Rings** — nested "bathymetric" lines | distance **offshore to nearest land** | 100/200/350/550/800/1200 km, in ocean | `draw_coastline_contours(prox_land, ...)` |
| **Mountains** — hachure glyphs | both, plus trenches | >300 km inland **and** <800 km from a subduction zone | `mountain_points()` |

The wash sits on the continental side of the coastline; the rings sit on the
ocean side. Mountains are the only element needing plate topologies rather
than just the landmask.

## The principle that decides everything else

**The wash and rings are decoration. The mountains are a claim.**

A wash whose width is measured in screen pixels is a stylistic choice. A
mountain whose position is measured in screen pixels is a lie. Those deserve
different standards, and once they get different standards the whole design
falls out:

- **Wash and rings: drawn in the browser, in screen space.** Stroke the
  coastline path repeatedly at increasing `lineWidth`. No prep, no payload,
  and they track the coastline exactly at every age because they *are* the
  coastline. See ADR-0037 for why this is deliberate rather than sloppy.
- **Mountains: computed in prep, in true great-circle distance.** The rule
  needs resolved subduction topologies tessellated to 0.1° and two distance
  transforms over a global raster. That cannot run per-frame in a browser,
  and its output — a few hundred points per frame — is tiny.

This deletes most of the first draft of this spec: no contour prep, no
per-frame GeoJSON, no series manifest, no gzip pipeline.

## Reconstruction Model — Merdith2021, newly cataloged

Merdith2021 is what the notebook uses, so prep output can be checked against
its existing `animation/withMountains_*.jpg` frames. It is **not** currently
in Geode's catalog (only `muller2019`, `scotese`, `seton2012` are), so it
gets ingested as a first-class Reconstruction Model per ADR-0021:

```
prep/prep_reconstruction.py --model Merdith2021
```

This is worth doing regardless of this viewer: Merdith2021's topologies reach
1000 Ma, making it the deepest Reconstruction Model in the repo by 460 Myr
(Scotese caps at 540). Every other viewer gains access to it.

An earlier draft claimed the choice was *forced* to Müller 2019 by
`has_boundaries`. That was wrong, and the error is worth recording: prep
resolves topologies directly through pygplates, and never reads the archive's
exported Boundary Frames. `has_boundaries` is a browser-side fact about what
the archive ships, not a constraint on what prep can compute.

Note `prep_reconstruction.py` already handles the coastlines-vs-continent-
polygons split across gprm models. Check which Merdith2021 exposes rather
than assuming from the Scotese case.

## Data

Two files, both deep-time-map format, hung off the new Merdith2021 manifest:

```
archive/reconstructions/merdith2021/
  oldmap/continents.json     python -m deep_time_map.export --model Merdith2021 \
                               --start 0 --end 200 --step 1 --polygons continents
  oldmap/mountains.json      prep/prep_oldmap.py
```

`continents.json` already exists for Merdith2021 at 0–1000 Ma / 5 Myr in
`~/GIT/StoryMaps/tectonic-co2/data/Merdith2021/` if a quick prototype is
wanted before re-exporting — `PolygonLayer.setTime` slerps between rotation
frames ([polygons.js:122](../../viewer/vendor/deep-time-map/js/polygons.js#L122)),
so a 5 Myr export still glides smoothly. The 1 Myr re-export is for the
mountain clock, not the coastline.

`mountains.json` carries the whole series in one small file:

```json
{ "model": "Merdith2021", "time_step": 1,
  "frames": { "100": { "id": [12, 47, ...],
                       "lonlat": [-58.1, -22.4, ...],
                       "orogenAge": [0, 34, ...] } } }
```

`id` is the stable Orogen Candidate id; `orogenAge` is Myr since that
candidate last satisfied the rule, and drives the fade.

## The mountain rule

`inland > 300 km AND trench < 800 km`, evaluated per frame — **plus memory**.
A glyph switches on when the rule is satisfied, then persists and fades over
a decay constant (start at 100 Myr) after the trench leaves, so orogens age
out rather than blink off. A real engraved map still draws the Appalachians.

Prep, per frame, old → young:

1. Reconstruct the fixed candidate set to this age (see below).
2. Test both criteria against this frame's distance fields.
3. For each candidate, `orogenAge = lastSatisfiedTime − t`. Emit every
   candidate with `orogenAge` under the decay cutoff, at its *reconstructed*
   lon/lat.

**Cold start.** The oldest displayed frame has no history behind it, so prep
runs to ~250 Ma while the viewer displays 0–200 Ma. Without the margin every
orogen comes up at age zero in the first frame.

**Known gap, accepted for v1.** The rule has no collisional term — a belt
fades as its trench is consumed, which is weakest exactly where the most
famous mountains are. `~/GIT/StoryMaps/tectonic-co2/data/Merdith2021/sutures.json`
is a 115-suture compilation, reconstructed 0–1000 Ma, each named, referenced
and carrying magmatic/metamorphic age windows. That is the obvious v2, and
the reason to note it here is that the data already exists for the model we
just committed to.

## Two notebook bugs that must not be ported

Both are invisible in a static JPEG and would be obvious in a scrub.

**1. The mountains flicker.** `points_on_sphere()` is regenerated identically
every frame in present-day absolute coordinates, so glyphs sit on a fixed
global lattice and blink as the orogen band sweeps past — they do not ride
the plates. The decay rule makes fixing this mandatory rather than optional,
since a fade needs a stable identity to fade:

1. Generate ~5000 spiral candidates **once**; assign each a plate id from
   static polygons.
2. Reconstruct all candidates per frame; test the criteria there.
3. Emit survivors' reconstructed positions plus their stable id.

One extra pygplates reconstruct per frame. A decayed Appalachian glyph then
correctly rides North America.

**2. Distances are wrong near the dateline.** xrspatial's `proximity` is a
raster scan that does not wrap at ±180°, so distances within a few hundred km
of the antimeridian come out systematically too large. `mask_to_da`'s
`mask[:,0] = mask[:,-1]` patches the *mask* seam, not the distance search.
This bites where the 100 Ma frame carries glyphs (Aleutians/Kamchatka,
Antarctic–Pacific margin). Fix: pad ~10° of longitude both sides before
`proximity`, crop after.

Polar anisotropy (0.25° is ~28 km in longitude at the equator, ~2 km at 85°N)
is a real limitation of the same approach, not worth fixing for v1 — note it
in the script and treat high-latitude placement as decorative.

## Rendering

`viewer/oldmap.html` + `viewer/src/oldmap/`, cloning the **reconstruction**
wrapper — the closest existing thing (115-line instance, one time slider, no
numerical Model). A new wrapper, not a branch in an existing one.

Three layers, bottom to top:

1. **Paper** — a procedural aged sheet, built once into an offscreen canvas
   at boot and blitted each frame. Base tint, value-noise fibre, four to six
   soft elliptical stains, two or three fold creases as faint linear
   gradients, edge vignette. Seedable.
2. **WebGL scene** — supplies the camera and, on a flat Projection, the map's
   own outline via `createFlatBackdropMaterial()` (ADR-0036). Draws no
   geography.
3. **Ink overlay** — a 2D canvas carrying every mark: wash, rings, coastline
   pen line, mountain glyphs. Projected through `core/`'s existing
   `ThreeProjector`/`FlatProjector` pair, exactly as `core/pointOverlay.ts`
   already does it.

**Paper is page space; geography is map space.** Stains and folds belong to
the sheet, so they never rotate when the globe is dragged or time is scrubbed.
This is also what reconciles the globe and flat views: the sheet is always a
rectangle and the Projection is merely what is drawn on it. An orthographic
globe becomes a disc of ink on a full-page sheet, which is how an atlas plate
actually looks. Robinson is the closest match to the notebook's own output —
and, since its boundary is a curve, its corners are simply paper, which is
correct rather than a defect.

### Two things this wrapper owns rather than core

- **`oldMapOverlay.ts`** — the ink layer. One consumer; promote to `core/` if
  a second viewer wants it, not before.
- **The coastline, from deep-time-map's `PolygonLayer`**, not
  `core/coastlines.ts`. This is a deliberate second coastline pipeline for
  one reconstruction, and the justification is the same one ADR-0028 already
  accepted: a lit triangulated mesh and a canvas path are genuinely different
  rendering technology. Variable-width ink bands need a `Path2D` to stroke;
  a mesh cannot produce one.

The mountain glyph is a straight port of the notebook's `drawing.eps` — 29
cairo path ops (`m`/`l`/`c` → `moveTo`/`lineTo`/`bezierCurveTo`), bbox
451×297 — into one `Path2D`. It does **not** go into deep-time-map:
`points.js` ships six abstract symbols at ~3.4 px, and the glyphs are already
per-frame paleo-coordinate lists needing none of `PointLayer`'s rotation or
lifespan machinery.

## Theme

Light, and deliberately not pure white: aged paper. Geode's palette is dark
(`background #070c16`) and `core/lilgui-theme.css` assumes `color-scheme:
dark`, so this is the repo's first light viewer. The cost is small because
each viewer's html already owns its `<style>` block — it means writing that
block differently and overriding lil-gui rather than importing the shared
theme. Ink and wash should be tinted toward sepia to sit on the paper rather
than on white.

## Scope

**In:** Merdith2021 ingest, 0–200 Ma at 1 Myr, time slider, Globe + Plate
Carrée + Robinson, the three style elements, procedural aged paper, mountain
decay.

**Out:** Multi-Globe (free later via `MultiInstanceHost`, but two globes on
one aged sheet is a look to decide on deliberately), 200–1000 Ma, sutures and
collisional orogens, labels and cartouches, any numerical Model.

## Dependency

Robinson support is **in flight and untracked** as of writing —
`viewer/src/core/robinson.ts` and `docs/adr/0036` exist, but
`ProjectionMode` in `core/projection.ts` is still `'globe' | 'plateCarree'`
and `isFlat()` is not there yet. This viewer wants Robinson but does not
block on it: build against Globe + Plate Carrée, add Robinson when core
lands it.

## Open — tuning, not architecture

1. **Decay constant.** 100 Myr to start.
2. **Band widths in px.** Six numbers; the notebook's km values are a
   starting ratio, not a conversion.
3. **Paper parameters.** Stain count, fold placement, vignette strength.
4. **Pen line quality.** A clean stroke will read as CAD, not engraving.
   Whether the coastline needs weight variation is worth a look before
   deciding it needs code.
