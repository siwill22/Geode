# Time series computed client-side, not baked into the prep pipeline

The new time-series panel (one area-weighted global-mean sparkline per
pickable Variable, collapsed by default, computed from every Frame in the
active model) needed a summary statistic per Frame that doesn't exist
anywhere in the archive today. Two ways to get it: precompute it in the
Python prep pipeline and bake it into `manifest.json` (the "correct at
scale" answer — one pass over the source data at ingest time, a few numbers
in JSON, nothing for the browser to do), or compute it client-side by
fetching and reducing the already-shipped per-Frame binaries.

We're computing it client-side. Every model's Frame data is already served
as flat byte arrays for rendering; reducing those same bytes to an
area-weighted mean is a few dozen lines against infrastructure that already
exists (`fetchVariableBytes`, `texelToPhysical`, `loadMask2D`'s mask
convention), versus a new Python code path, a manifest schema addition, and
a re-run of ingest for every existing model before this panel could show
anything for them. The panel is also collapsed by default specifically so
this cost is opt-in — a user who never expands it never pays for the
fetches, which a baked-in precomputation couldn't offer (the numbers would
exist whether anyone asked for them or not, at zero *marginal* cost per
session but nonzero cost to the pipeline/manifest for every model,
including ones nobody ever inspects this way).

This does NOT create a GPU texture per Frame the way rendering does
(`fetchVariableBytes` is deliberately the CPU-only twin of `loadVolume`) — a
100+ Frame model would otherwise churn through far more texture
uploads/evictions than `FrameCache`'s `FRAME_LIMIT` is sized for, for data
that only ever needs to live on the CPU.

Three follow-on decisions, each small on its own but worth recording
together since they'd otherwise look arbitrary:

- **Reads the Annual layer (or the only layer), never the currently-selected
  month.** A time-series overview answers "how does the long-term mean move
  through geological time," a different question from "what does this one
  season look like right now" — and tying it to the scrubbable month slider
  would mean recomputing on every drag, for a chart meant to be computed
  once per (model, resolution, variable) and left alone. Read from index
  `ndepth - 1`, which is Annual for a climate manifest (prep_climate.py
  always appends it last) and the only layer for a single-layer one
  (paleogeography) — a rule derivable from grid shape alone, not a
  layer-name special case.
- **Honours the model's own validity mask.** An unmasked mean would silently
  average in whatever bytes fill a continental-only run's ocean texels
  (Pohl) — the same "say so, don't fabricate" principle the shader's own
  `uValidMask` already enforces on screen, just applied to a CPU reduction
  instead of a fragment discard. A Frame where the mask covers every texel
  reports `NaN`, not zero — plotted as a gap in the line, not a fabricated
  low point.
- **Never computed for a categorical Variable.** Averaging Koppen's class
  indices ("mean of class 3 and class 7") produces a number, but not a
  meaningful one — `texelToPhysical()` decodes a class-index byte exactly
  the same as a continuous one, so nothing in the arithmetic itself would
  catch this. The exclusion has to happen before computation is ever
  requested, in both `ClimateInstance.pickableTimeSeriesVariables()` and
  `ClimateUI.setLayerVariables()`'s row-building (which must filter
  identically, or a row gets built that nothing ever arrives to fill).

## Consequences

A model with many Frames (up to several hundred) fires that many requests
the first time its panel is expanded — bounded to 8 concurrent
(`core/timeSeries.ts`'s `CONCURRENCY`), not the whole model at once. Once
computed, a (model, resolution, variable) triple is cached for the rest of
the session (`ClimateInstance.timeSeriesCache`, keyed by promise so two
near-simultaneous expands share one fetch); nothing currently invalidates a
resolution change to an already-open panel's already-computed rows, since
`resolutionId` is only part of the cache key (a cache-correct but
UI-stale gap for the one layer, paleogeography, where resolution is user
-selectable at all). If per-Frame stats are ever needed somewhere that
matters at real scale (many models, every session paying the fetch cost),
that's the point to revisit precomputing them in prep instead.
