# Old Map viewer — spec

Status: **built** (2026-09-15). `viewer/oldmap.html`, verified by
`npm run check:oldmap`. The spec below is the design as resolved in the grilling
session; where the build departed from it, the "What changed in the building"
section at the end says so and why. Nothing above that section has been
rewritten to match the outcome.

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

---

# What changed in the building

Five things came out differently from the spec above. Four were forced by
measurement; one is a limitation now filed upstream.

## 1. The mountain rule is a nearest-neighbour query, not a raster scan

The spec assumed prep would reuse the notebook's `xrspatial.proximity` distance
transforms. It does not, because those are **wrong**, and not subtly:
`prep/prep_oldmap.py --check-distances` measures them against brute force at
100 Ma and reports a mean error of **+112 km, reaching 4432 km**.

Two independent causes. The scan does not wrap at ±180, so cells near the
antimeridian cannot see sources across the seam — mean error there is +926 km,
and that is exactly where Mesozoic mountains live (Aleutians, Kamchatka, the
Antarctic–Pacific margin). The notebook's `mask_to_da` patches the *mask* seam
and does nothing for the distance search that runs afterwards. But the scan is
also order-dependent in the interior: +55 km mean away from the seam, and 13% of
cells move by more than a kilometre if the grid is merely rolled.

None of it needed solving, because the field was never needed as a field. Only
~2000 candidate points are ever interrogated, so prep queries a KD-tree of source
positions in 3D unit-vector space. Chord distance there is monotonic in
great-circle distance, so the nearest neighbour is **exact** — the check reports
0.000000 m against brute force — and the antimeridian stops being a special
place, because it is only special on a grid.

What stays approximate is the source set, not the search, and only on one side:
trench sources are the tessellated subduction geometry itself (no rasterization
at all), while coast sources are ocean cell centres from a rasterized land mask,
quantized to ±14 km at 0.25°. Rasterizing is unavoidable there — the model's
continent polygons overlap when reconstructed, and the coastline wanted is the
outline of their merged union.

## 2. The ink is a distance field, not repeated strokes

ADR-0037's screen-space decision stands. Its *implementation* does not: stroking
the coastline path repeatedly at growing `lineWidth` was the first version and it
ran at **seconds per frame** — 26 strokes of a ~32,000-vertex path at widths up
to 96 px, with round joins. It starved the main thread badly enough that
Playwright could not take a screenshot.

Both elements now come from one chamfer distance field computed at half
resolution from the land silhouette. The wash reads it on the land side, the
rings on the ocean side. Cost scales with pixels rather than with vertices ×
width. This is still screen space and still not a distance, so ADR-0037 is
unaffected — see `oldMapOverlay.ts` for the full note.

## 3. The globe camera is orthographic, and that is load-bearing

The spec did not say which camera. It has to be orthographic, for a reason that
is not only aesthetic: `PolygonLayer` fills a limb-straddling continent by
clamping hidden vertices onto the **great circle** perpendicular to the view
axis, which is the horizon only under an orthographic camera. Under perspective
the horizon is a smaller circle at `dot = R/d`, clamped vertices are still behind
it, and the ring closes across the globe. `ThreeProjector.axis` therefore returns
`undefined` for a perspective camera on purpose rather than handing back an axis
that would be silently misused.

This matters more here than it would elsewhere: the coastline path is not merely
drawn, it is also the clip for the wash and the rings, so a malformed ring puts
the ink in the wrong place rather than just drawing a wrong outline.

## 4. Two core projectors gained the rest of the contract

`PolygonLayer` needs `axis` (limb clamping) and `mapHalfWidth` (seam detection),
and Geode's projectors implemented neither — so a seam-crossing ring would have
been *filled* straight across the map, which `seamSplit` alone does not prevent
because a fill never consults it. Both are now implemented, in `core/`, and
`FlatProjector` also grew `mapOutline()`.

That last one fixed a bug visible in the first screenshots: the distance field
treats "off the map" as ocean, so rings spread across the paper beyond the
globe's limb and past Robinson's curved boundary. Everything is now clipped to
the Earth's own outline — except the mountain glyphs, which are symbols standing
at points and would be sliced in half by it.

Upstream, `PolygonLayer.projectRings()` was added (deep-time-map v0.7.0) so the
traced rings can be had without the drawing. A recording shim around `draw()`
cannot work: it cannot separate fillable rings from seam-diverted ones, which is
the distinction that decides whether a ring may be closed.

## 5. Known gap: rings that enclose a pole

Visible as a smeared band along lat ±90 on both flat Projections. A polygon
covering a pole has no closed boundary in (lon, lat) — its true boundary runs
along the pole itself, a segment absent from the source geometry — so it
projects as a strip across the full width of the map. The globe view of the same
data is correct, so it is the projection, not the data.

The v0.6.0 seam fix does not catch it: `mapHalfWidth` spots a jump between
consecutive vertices, and a pole-enclosing ring need not have one. Filed as
[deep-time-map#11](https://github.com/siwill22/deep-time-map/issues/11); it
belongs there rather than here, since it affects every flat-map consumer of that
layer and deep-time reconstructions have polar continents at most ages.

## 6. Five fixes from the first review

All five came from looking at the built page, and two were real bugs rather than
taste.

**The coastal wash flickered where terranes overlap — a fill-rule bug.** The
coastline was stroked inside a clip of "viewport minus land" built with the
`evenodd` rule. Under even-odd, a region covered by *two* overlapping terranes
has even winding and counts as **outside**, so every overlap between neighbouring
polygons read as ocean and the interior boundaries reappeared there as slivers
that popped in and out as the geometry moved. Land is a `nonzero` union — that is
what makes abutting terranes one landmass — and canvas allows only one fill rule
per path, so the complement cannot be expressed as a clip at all. It is now
stroked onto its own layer and the land erased from under it with
`destination-out`, which does respect nonzero.

**Mountains could stand in the sea.** Prep guarantees >300 km inland *at the age
the rule last held*, but a glyph persists for up to the decay constant after
that, and in that time its plate can carry it offshore or the margin can retreat
past it. Measured: **72 of 305 glyphs at 100 Ma**. The viewer now re-tests every
glyph against the same land raster the wash is clipped to, so one can never
appear in ocean the viewer is drawing. `npm run check:oldmap` reports the cull.

**The rings were angular**, because a ring's shape *is* a level set of the
distance field and the field was at half resolution. Now full resolution. The
wash never had the problem — it is a soft gradient, which is what made half
resolution look acceptable in the first place.

**The coastline pen is heavier** (1.3 px, not 0.75). The erase above is
antialiased and eats into whatever survives it, and at 0.75 px the line read as
absent.

**Robinson is the default Projection**, since it is what the reference notebook
renders (pygmt `N25c`) — the page now opens on the look it reproduces.

**A subduction-zone debug toggle** was added, off by default and loaded on first
use. The mountain rule's second criterion is "<800 km from a subduction zone",
and without the trenches on screen there is no way to see whether a glyph is
where the rule says it should be. It reuses `BoundaryOverlay` rather than drawing
its own lines, so it is necessarily the same geometry every other viewer shows.

One thing that fix found: `check_oldmap.mjs` was reading the canvas on a fixed
delay after switching Projection, catching the *previous* projection's ink —
which is how Robinson and Plate Carrée came to report byte-identical coverage
while their screenshots plainly differed. It now waits for two consecutive
identical reads, and prints the painted bounding box so a stale frame cannot hide.

## 7. Second review: the bands are kilometres again

Three more, and the third reversed a decision.

**The ink is measured in kilometres, not screen pixels.** Pixel-fixed bands kept
the same size at every zoom, so the ground distance they represented changed as
you scrolled — the map quietly said something different depending on how closely
you looked at it. The constants are now the notebook's own values (400 km wash;
100/200/350/550/800/1200 km rings) converted through one scale taken from the
projection's live geometry. ADR-0037 is rewritten to record the reversal, and
`check:oldmap` asserts a 2.5× zoom gives 2.5× the pixels per kilometre in both
Robinson and the globe. This also made the code smaller, not larger: the pixel
constants had needed per-projection tuning that kilometres do not.

**The rings were still faceted because the metric was wrong, not the
resolution.** A ring is a level set of the distance field, so a chamfer's
octagonal error *is* the ring's shape — raising resolution (the previous round's
fix) could never help. Replaced with Felzenszwalb's exact Euclidean transform,
same O(n).

**The flicker was hairline gaps between abutting terranes**, each rasterizing as
an enclosed sea that grows its own wash and rings and blinks as sub-pixel
geometry shifts. The previous round's fill-rule fix was real but addressed a
different symptom. The mask is now morphologically closed first: **61 enclosed
bodies of ocean at 100 Ma before, 10 after**, the survivors being genuine inland
seas. `check:oldmap` reports both numbers rather than asserting the fix.

## Still open from the spec

The four tuning items above are untouched beyond a first pass — the ring offsets,
wash reach, paper parameters and pen weight are all single constants at the top
of their modules, which is the payoff ADR-0037 predicted. Sutures and
collisional orogens remain out of scope, as does 200–1000 Ma.
