# A Python-first way in: `geode` as a notebook API

**Status:** built, for the igneous zircons case. deep-time-map v0.9.0 ships the
renderer, the Explorer host and `python/geode/`; the worked example is
`GeodeViewers/IgneousZircons/`. Decisions in ADR-0046 through ADR-0049, with
ADR-0047 amended by what the migration actually turned out to be. §11's staging
was not followed in order — see the note there.

The audience is a scientist who works in Python notebooks with matplotlib and
PyGMT, has a DataFrame of results, and wants it on a reconstructed globe. Today
there is no path for them: the data half is solved and the viewer half is 583
lines of hand-written JavaScript per viewer.

Worked case study throughout: `StoryMaps/zircons/`. Every number below is
measured from it, not estimated.

---

## 1. The case study, measured

| part | size | verdict |
|---|---|---|
| `build/*.py` (5 scripts) | **341 lines** | the science + wrangling. **Stays.** |
| `js/story.js` | **583 lines** | viewer plumbing. **Should not exist.** |

`build_zircons.py` (138 lines) is ~25 lines of provenance docstring, ~25 of
constants and column mapping, ~30 of fetch-and-normalise, a 10-line workaround
for Excel mangling four `Sample_ID` values into dates — and then **one call** to
`export_points(...)`. The data half is already a one-liner; the rest is
wrangling, which is irreducible and belongs to the user.

`story.js` inverts that. Roughly 60–80 of its 583 lines are genuine decisions
(projection, layer draw order, size 3.1, the bright/faint rule, the palette, the
hover fields, scale-bar speeds). The other ~500 are `scheduleRender`, `setTime`,
`buildLegend`, `buildZirconLegend`, `legendSymbol`, `attachHover`,
`attachControls`, `attachCollapse`, `parseHash`, `updateScaleLabel`,
`prefetchAll`. **Roughly 8:1 plumbing to decisions.**

The plumbing genuinely repeats across the family — `setTime` and `prefetchAll`
appear in 7/7 pages, `scheduleRender` 5/7, `parseHash` and `attachCollapse` 4/7 —
across 4,773 lines of `story.js` in total.

---

## 2. Scope: Explorers only (ADR-0046)

The seven pages split by kind, not size:

| page | lines | scrolly | layers |
|---|---|---|---|
| southeast-tasmania | 219 | yes | 1 |
| southern-ocean-gateways | 297 | yes | 1 |
| plate-boundaries | 579 | no | 9 |
| **zircons** | **583** | no | 10 |
| detrital-zircons | 908 | no | 11 |
| lips | 1003 | yes | 8 |
| tectonic-co2 | 1184 | no | 7 |

The API targets **Explorers** — a globe, standard layers, time slider, legend,
hover, no authored narrative. Zircons and plate-boundaries are near-twins
(583/579) and are the two case studies.

The three large pages are large for three *unrelated* reasons —
detrital-zircons for bespoke pie glyphs, tectonic-co2 for heavy charting, lips
for narrative choreography — so absorbing them would mean three different
escape hatches. They stay hand-written. That is a stated ceiling, not a gap.

---

## 3. The renderer (ADR-0047)

Precisely: `StoryMaps/shared/js/globe.js` is **710 lines of WebGL** — a
projection host offering orthographic, Spilhaus and Robinson, sampling an
equirectangular paleogeography texture. deep-time-map's layers
(`BoundarySeries`, `PointLayer`, `PolygonLayer`, `VelocityField`, `hover`,
`timeseries-panel`) draw *over* it as 2-D canvas overlays.

`globe.js`, `geo.js` and `robinsonSeams.js` (~1,250 lines) contain **no
StoryMaps-specific references** and **move into deep-time-map**, which then
becomes self-sufficient: export a reconstruction and draw it. The Python API
ships beside them in `deep-time-map/python/`. Both Geode and StoryMaps already
vendor deep-time-map as a submodule of `github.com/siwill22/deep-time-map`, so
both get it by advancing a pin.

Geode's three.js `viewer/src/` stays the answer for gridded Models — volumes,
cutaways, isosurfaces — which this renderer cannot draw at all. Geode's own
`generator/` (`ViewerRecipe`, `validateRecipe.mjs`) is that other path and is
**not** what this targets. The two should converge on a shared recipe vocabulary
eventually; forcing it now blocks this on a refactor it does not need.

---

## 4. The target notebook

Two blocks, split by cost. The split survives because of the cache (§6).

```python
# %% [markdown]
# # Igneous zircons through deep time
# Puetz et al. (2026), Geoscience Frontiers, doi:10.1016/j.gsf.2026.102416

# %% --- data: pandas + gprm ------------------------------------------------
import pandas as pd
from gprm.datasets import Zircons

frames = []
for rock_type in ("Felsic", "Mafic"):
    gdf = Zircons.get_mafic_felsic_samples(rock_type=rock_type)
    gdf = gdf.drop(columns="geometry")
    gdf = gdf.rename(columns={"Sample_ID from publication": "Sample_ID"})
    gdf["type"] = rock_type
    frames.append(gdf)

zircons = pd.concat(frames, ignore_index=True, sort=False)
zircons = zircons.rename(columns={"Magm. / crystal age (Ma)": "age"})
zircons = zircons.dropna(subset=["age"])
kept = zircons[zircons.age <= 1000]

# %% --- view ----------------------------------------------------------------
import geode

v = geode.globe(reconstruction="Merdith2021", times=(0, 1000, 1))

v.continents()
v.boundaries()
v.velocities(scale_bar=True)

v.points(
    kept,
    age="age",
    group="type",
    labels={"Felsic": "Felsic igneous zircon", "Mafic": "Mafic igneous zircon"},
    lifespan="since",
    highlight=geode.age_window(50),
    size=3.1,
    hover=["Sample_ID", "Reference", "Country/Small Region", "Locality",
           "Type of age", "2σ error  (myr)", "Class-3 Rock Type"],
)

v.theme("abyssal")
v.caption(f"Igneous zircon samples, mafic and felsic, Puetz et al. (2026). "
          f"{len(kept)} of {len(zircons)} samples have a magmatic age of "
          f"1000 Ma or younger and appear here.")

v.show()
v.export("zircons/")
```

What the user never writes: no `sys.path` insert, no `out_dir`, no
`transport="rotations"` choice (a performance decision derivable from point and
plate counts — `build_zircons.py` currently spends a docstring paragraph
explaining it), no `fields`/`categories` payload construction.

---

## 5. The API surface

Nine verbs. If this grows past about a dozen, the "generated code teaches the
API" property breaks and the design has failed regardless of how useful the
extras are.

```
geode.globe(reconstruction, times=, projection=)   -> View
View.continents() / .boundaries() / .velocities()
View.points(df, ...)        the main verb
View.timeseries(...)        a chart sharing the map's clock
View.theme(id)              a named Theme (ADR-0038)
View.caption(text)
View.show()                 coarse inline preview
View.export(dir)            the full standalone artifact
```

`View.points()` maps onto `points.json`'s existing schema and `PointLayer`'s
options, so it needs nothing new from either: `age`/`lon`/`lat` are column
names; `group` is `points[].type` + `categories` (one **Grouping**, CONTEXT.md);
`labels` is `categories[].label`; `lifespan` is `'since'`/`'window'`/`'range'`,
already a `PointLayer` concept; `size`/`keyline` pass through; `hover` selects
payload fields.

### Display Rules — exactly two

Measured from the two target pages:

- **zircons**: `dist <= ZIRCON_WINDOW ? bright : faint` — a function of
  `(point, current_time)`, re-evaluated on every scrub. A Python callback cannot
  express this; it has to run in the browser.
- **plate-boundaries**: `{ fill: FAMILY_COLOUR[cat.family] }` — no time
  dependence at all.

So: `geode.constant()` (default) and `geode.age_window(n)`. Both serialise into
the record and are readable by someone who does not write JavaScript. A third
rule ships only when a real page needs it — every rule justified by a page that
exists is the discipline that stops this becoming a DSL with bad syntax.

**Escape hatch, documented as a supported path rather than a failure:**

```python
v.points(df, ..., style_js="js/custom_style.js")
```

`detrital-zircons` is the known case that needs it, and should stay
hand-written.

---

## 6. The heavy/light seam: `points()` caches

Turning 14k rows into `points.json` needs plate assignment against static
polygons, which needs pygplates and `gprm`. Left naked, that would make the view
block heavy and destroy the "fork this viewer" story.

So `v.points(df, ...)` runs assignment **once** and caches it next to the
notebook; `export()` bundles the cache. A reader re-running the view block
against the exported artifact hits the cache and **needs no pygplates**.

The boundary this draws is the honest one: a reader can freely change colours,
grouping, sizes, hover fields and theme. They cannot change the reconstruction
model or extend the time range without the scientific stack — which is correct,
because those are data decisions, not display ones.

---

## 7. `show()` vs `export()`

A full page is large (§9), so these cannot be the same artifact rendered two
ways.

- **`show()`** — a coarse preview: reduced time step, capped point count,
  self-contained inline at a few MB, **labelled on the figure** ("preview, 10 Ma
  steps"). Iterating on colour, grouping and size needs a handful of frames, not
  1001.
- **`export()`** — ships exactly what `times=` asked for.

What you see is therefore not byte-identical to what you ship. The label is
load-bearing, not decoration.

---

## 8. The provenance panel (ADR-0048)

A tab in the exported viewer, containing two clearly-separated things:

1. **The View Script** — generated. The `View` logs its own calls, so `export()`
   emits a canonical, ordered, minimal script that provably reproduces the view.
   Always available, always faithful, immune to out-of-order notebook execution,
   and works identically whether the calls came from a notebook, a script, or a
   chat session.
2. **The author's notebook** — optional, if they point at one. Carries the
   wrangling half and their markdown.

**What it cannot contain, and says so:** the analysis libraries. `gprm` cannot be
pasted into a panel. The record instead names and pins the call — *this used
`gprm 0.x`'s `Zircons.get_mafic_felsic_samples()`* — with the citation. A panel
claiming to show "the code" while silently omitting the science implies an audit
trail it does not have.

This is also what makes a published viewer teach the API to a stranger, which is
the discoverability problem the whole exercise started from.

---

## 9. Size, measured

Corrects an earlier claim in this document that the 2-D path is small and only
gridded Volumes need a size story. It is not small.

| | raw | gzipped |
|---|---|---|
| `points.json` (14k zircons) | 11.4 MB | 3.0 MB |
| `continents.json` | 11.3 MB | 3.5 MB |
| `velocities.json` | 7.9 MB | 1.4 MB |
| `frames/` — 1001 files at **1 Ma** | 90.1 MB | **27.1 MB** |
| **total** | **121 MB** | **35 MB** |

Boundary frames are 77% of it. **The default stays 1 Ma**: Boundary Frames are
not interpolatable (CONTEXT.md), so coarsening produces a visible jump every
step rather than a smooth approximation, and scrub quality was judged worth the
bytes.

`export()` always reports what it wrote and names the dominant term, so the
trade is visible and reversible in one argument. It does not warn, refuse, or
hold an opinion.

Consequence to accept: a default viewer is ~35 MB gzipped, and a shelf of ten is
a third of a gigabyte.

---

## 10. The test

**Rebuild `StoryMaps/zircons/` from a notebook, with no `story.js`.**

Pass condition: the exported viewer has the legend, hover, time slider, velocity
arrows and scale bar, the bright/faint age rule and deep-linking — and the
notebook that produced it is shorter and more readable than `build_zircons.py` +
`story.js` together. The two shipped Display Rules mean this must pass *without*
touching `style_js`, which is what makes the claim meaningful.

Named failure modes:

- The rule set grows a special case for zircons → it is a DSL, not an API.
- The notebook exceeds 341 + 583 lines → the abstraction is not paying.
- `show()` is too slow to iterate with → people will export-and-refresh, which is
  the workflow this exists to replace.

Second case study: **`plate-boundaries/`**, which shares `story.js`'s lineage
and would show whether the plumbing is genuinely common or merely looked it.
`detrital-zircons/` is deliberately not a target (§5).

---

## 11. Staging

1. Move `globe.js`/`geo.js`/`robinsonSeams.js` into deep-time-map; re-point the
   seven StoryMaps pages. No behaviour change — a pure migration, verifiable by
   screenshot diff.
2. Extract the generated plumbing from `story.js` into deep-time-map as a
   configurable Explorer host. Verify by rebuilding zircons' page against it with
   its existing data and hand-written config.
3. Add the Python `View` + recipe + exporter. Verify by the §10 test.
4. Second case study: plate-boundaries.

Step 2 is the one that can be validated without any Python at all, and it is
where most of the risk lives.

### What was actually done, and in what order

Steps 1–3 were built together and verified by one end-to-end run, rather than
separately. That was the wrong-looking call and the right one: the migration's only
honest test is a consumer that renders, and until the Explorer host existed there
was nothing to be a consumer. Building all three meant the first thing to exercise
the moved renderer was a working viewer rather than a screenshot diff.

The cost is that **step 1's second half is still outstanding**: the seven StoryMaps
pages have not been re-pointed and still import from `shared/js/globe.js`. Nothing
is broken — there are now two copies of the renderer, one of them stale — but that
is a duplication with a shelf life, and it is the next thing to do.

Two things the spec did not anticipate, both now recorded as decisions:

- `robinsonSeams.js` did not move, because it pulls a vendored d3-geo subtree with
  it (ADR-0047, amended).
- The exporter emits **no JavaScript at all** — `view.json` is the artifact, read at
  run time by one shared host (ADR-0049). The spec was silent on this and the
  obvious implementation would have generated a `story.js` per viewer.
