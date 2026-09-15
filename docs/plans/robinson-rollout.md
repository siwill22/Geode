# Robinson rollout — what was left, what was fixed, what is still open

Status: **done**. Robinson is reachable in every viewer that offers a Projection
control, the wind path is mode-aware, Boundary Frames work on a flat map, and
the duplicated projection now lives upstream in deep-time-map v0.6.0.

ADR-0036 landed Robinson as the second flat Projection. This records the sweep
done afterwards, because "a third Projection exists" turned out to be a larger
claim than "the third Projection renders" — several things were still written
as though there were exactly two.

## Fixed

**Robinson was reachable in one viewer.** Paleobio had a three-way lil-gui
dropdown; climate and Valdes had a two-state icon *toggle*, which cannot reach a
third mode however many exist. `core/projectionToggle.ts` now owns that button
as a cycle over `PROJECTION_ORDER`, shared by both wrappers rather than copied
into each with its own duplicate SVGs. Both `PROJECTION_ORDER` and paleobio's
dropdown read the same list, so a fourth Projection appears in every control
without touching a wrapper.

**Two `=== 'plateCarree'` tests survived** ADR-0036's sweep, in climate's and
Valdes' toggle code. Cosmetic in effect — they picked an icon — but the same
latent-bug pattern the ADR was written about. Gone with the toggle rewrite.

**The wind path was Plate-Carrée-only, which was the real bug.**
`referencePlateFlatSample()` returned `lonLatToFlatVec3(...)`, so under Robinson
every wind glyph would have been drawn at its *Plate Carrée* position — not
distorted, simply somewhere else. It is now
`referencePlateProjectedSample(mode, …)`.

Directions were wrong for a subtler reason worth writing down. `FLAT_EAST` /
`FLAT_NORTH` were `[1,0,0]` / `[0,1,0]`, documented as a property of flat maps:
*"the SAME everywhere — no meridian convergence, no pole degeneracy"*. That is
true of Plate Carrée and false of Robinson, whose meridians converge exactly
like the sphere's. East really is +x on both (Robinson's parallels are straight
and horizontal), but north is +y only on the central meridian. They are renamed
`PLATE_CARREE_EAST` / `PLATE_CARREE_NORTH` so the claim is scoped to the
projection that has it.

The replacement is `flatDirection(mode, lon, lat, u, v)`, which steps a short
great-circle distance along the vector's own bearing and differences the two
projected positions. No hand-differentiation, exact for a projection whose
forward transform is a table interpolation with no closed form, and a future
Mollweide needs nothing added.

## Verified, not asserted

`npm run check:flat-direction` drives the real `core/projection.ts` through
Vite's module server — not a reimplementation, so it cannot pass against a copy
that has drifted — and asserts the tilt of north and east at five points in both
flat Projections. `npm run check:projections` cycles climate through all three
and screenshots each.

The measured Robinson north tilt, which is also the clearest statement of the
rule:

| lon | lat | north tilt |
|---:|---:|---:|
| 0 | 45 | 0.00° |
| −150 | 45 | +37.54° |
| +150 | 45 | −37.54° |
| −150 | −60 | **−46.03°** |
| +90 | 10 | −4.91° |

The fourth row is the one to keep. North tilts *toward* the central meridian
when the step is poleward and *away* from it when equatorward, so the sign flips
with hemisphere as well as with longitude. The first version of the check
asserted the northern-hemisphere rule alone, looked correct on half the map, and
failed on the other half — the implementation was right and the expectation was
wrong.

## The table now agrees with PROJ, measurably

`npm run check:robinson` (new — `prep/check_robinson.py`) reads the table out of
the shipped JS, so it cannot pass against a third transcription, and compares it
with PROJ on a unit sphere. At the nodes the two agree to 7.6e-08; between
nodes, below ±85°, to 8.5e-04 of the map's half-width; in the last interval,
85–90°, to 1.4e-03.

The doc comment it was written to back up claimed "well under a pixel at any
zoom", which is false at 85–90° — about 1.5 px on a full-screen map. Corrected
to the measured figures. Both tolerance constants in the script were also
guessed before being measured, and both guesses were optimistic; they are now
ceilings set just above the measurement, to notice a regression against, not
targets that were met.

## Fixed — `BoundaryOverlay` on a flat map

`PointOverlay` and `AggregateOverlay` each carried a `ThreeProjector`/
`FlatProjector` pair; `core/boundaries.ts` had only `ThreeProjector`, so Boundary
Frames were Globe-only.

The obstacle was never the camera, it was the antimeridian. Points and aggregate
cells are single positions; boundaries are **lines**, and deep-time-map
deliberately does not split geometry at ±180° — correct on a sphere, and on a
flat map it draws every dateline-crossing feature straight across the whole map.
`tracePolyline` lifts the pen on a `null` from `project()`, but `project()` sees
one vertex at a time and cannot tell a seam crossing from the gap between two
features, so a stateful test inside it would have dropped the first segment of
all ~248 features per frame.

That is why this waited for the upstream decision rather than being hacked
around: the fix belongs where the runs are known. deep-time-map v0.6.0 added an
optional `seamSplit(a, b)` to the projector contract and `tracePolyline` breaks
the line there; `FlatProjector` supplies it, and `BoundaryOverlay` grew the
`setCamera(camera, mode)` its siblings already had.

`FlatProjector` also moved to its own `core/flatProjector.ts`. It lived in
`pointOverlay.ts`, and `boundaries.ts` importing it from there would have been
circular — `pointOverlay.ts` already imports `ThreeProjector` from `boundaries`.

The seam is at ±180 in the **display** frame, which a Reference Plate rotation
moves away from ±180 in the true frame, so the crossing is found in display
coordinates and the two edge points rotated back before being handed over —
`project()` rotates them forward again. `npm run check:flat-direction` asserts
exactly that: with a 30° Reference Plate, a segment across true 180° must *not*
split, because true 180° is mid-map. Also note the two frames do not share an
up-axis (deep-time-map is z-up, Geode's `constants.ts` is y-up); mixing them
yields a plausible-looking wrong map, so the conversions are explicit.

## Resolved — Robinson moved upstream

Robinson existed twice with the identical 19-entry table and **different
antimeridian behaviour**: Geode dropped the segment, StoryMaps split the
geometry. deep-time-map, which both depend on, had neither copy.

Per its ADR-0001 the split is not wholesale, because Geode's Robinson is mostly
a *shader*:

| | Where it lives now |
|---|---|
| The table, forward + inverse, `meridianCrossing` | deep-time-map — pure sphere geometry |
| `Robinson` canvas projector, `seamSplit` | deep-time-map — sibling of `Orthographic` |
| GLSL generation, world-unit scaling, plane framing, `flatHalfWidth` | Geode — needs its own pipeline |

`core/robinson.ts` is now a thin adapter that scales upstream's projection units
by `R_SURFACE`. The refactor reproduced the measured direction tilts exactly
(37.54° / −46.03° / −4.91°), which is the evidence it was behaviour-preserving.

Released as **v0.6.0** and pushed, with `test/robinson.test.mjs` (10 tests,
Node's built-in runner, so the repo stays dependency-free). `PolygonLayer` also
degrades rather than lies: a ring straddling the seam is outlined, never filled,
while rings clear of it fill as before — which is what the Old Map viewer needs.

Two process notes, both worth keeping:

- **v0.5.0 was tagged on an unmerged branch**, and Geode's working tree was
  mid-way through pinning to it — the `points-and-spiderfy` failure ADR-0001 was
  written to prevent, recurring. Neither had been pushed, so it was fixed by
  fast-forwarding `main` before building on it.
- StoryMaps still has its own copy. It was not touched here, and adopting the
  upstream one is the obvious follow-up — it is the repo whose seam behaviour was
  already correct, so it stands to lose the least and gain a shared home.

## Superseded — the original three options

1. **Promote Robinson upstream**, with the seam splitting, as a second reference
   projector. Unblocks `BoundaryOverlay` for free, since the library would then
   own the split. Largest change; needs a deep-time-map release and a pin bump.
2. **Keep both, record why.** Cheapest, and defensible if the pannable central
   meridian is genuinely a StoryMaps-only need — but then the seam behaviours
   should be reconciled deliberately, not left as an accident.
3. **Port `robinsonSeams.js` into Geode** and keep the projections separate.
   Unblocks `BoundaryOverlay` without touching the submodule, at the cost of a
   third copy of the same idea.

Option 1 was chosen and executed.
