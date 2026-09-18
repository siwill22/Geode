# The distance-heatmap verb takes precomputed data, not raw material

Every other verb that ends up drawing something real — `.points()`,
`.boundaries()`, `.velocities()` — takes raw material (a DataFrame, a
reconstruction model) and does the actual geometry work itself, cached, at
export time. That symmetry is worth keeping unless there's a real reason not
to. `view.distance_heatmap(samples, baseline, ...)` breaks it on purpose.

## What it takes instead

Two already-computed DataFrames: `samples` (one row per real sample — time,
distance, category fields) and `baseline` — not raw random-point distances,
but **deciles of them, one row per reconstruction time**. Neither is raw
material `geode` reduces; both are already the answer.

## Why this one is different

`.points()` can do its own reconstruction because the ingredients are always
the same shape: a DataFrame of located things, a rotation model, pygplates.
The distance-heatmap's numbers come from a proximity analysis instead —
`gprm.utils.molchan`'s subduction-zone raster sequence and per-sample nearest-
distance search — that is:

- **Expensive in a different way.** A masked raster sequence over the whole
  globe per reconstruction time, not a per-point rotation.
- **Exploratory, not settled.** The zircons case study's own version of this
  (`zircons/distance_to_subduction_zone.py`) went through several real bugs
  (a macOS multiprocessing crash, an invisible title, a `Felsic/Mafic` column
  name pandas parsed as division) before it produced correct numbers. Teaching
  `geode` to run this itself would mean maintaining that whole pipeline inside
  the library, for a technique still being worked out in the open, in a
  sibling repository.
- **Often keyed to a different dataset than `.points()`.** The zircons case
  study's own heatmap draws from a whole-rock compilation with a
  `Tectonic Setting` field — `gprm.datasets.Zircons.get_mafic_felsic_samples()`,
  what this same viewer's globe uses, has no such field at all. `geode`
  wrapping the analysis wouldn't even remove the two-dataset problem; it would
  just hide where the second dataset came in.

None of these rule out generalizing this into `geode` itself eventually — they
rule out doing it **now**, before a second consumer exists to prove the
generalization is the right one. Same reasoning as ADR-0050/0051 for `steps`
and `figures`: validate on one real case, generalize once something else
needs it.

## Why deciles, not raw baseline points

The random baseline does not depend on which categories a reader has toggled
on — it is a property of the target geometry (subduction zones) through time,
full stop. Shipping the raw points (tens of thousands per reconstruction time)
so the browser can recompute deciles identically on every toggle click would
be strictly more data and more work for the same number. `artifact.py` reduces
it once, at export time, to nine deciles per time step — a few hundred numbers
total instead of hundreds of thousands.

## The verb-count cost

ADR-0046 caps the verb surface near a dozen so a generated View Script stays
readable end to end. This is a real 14th-ish verb, not a keyword on an
existing one — the honest justification is that it is a genuinely reusable
chart type (like `.timeseries()`), not page-specific, so it earns its place
the same way `.timeseries()` did rather than being a one-off bolted on for
zircons.

## Always-visible, not drawer-only

`note` renders beside the chart itself, not only in the provenance drawer.
`figures` (ADR-0051) could get away with a caption inside a drawer a reader
has to open. This chart sits in primary UI, above the time slider, visible by
default — a cross-dataset caveat hidden behind a click would not meet the same
bar ADR-0051 already set for something far less prominent.
