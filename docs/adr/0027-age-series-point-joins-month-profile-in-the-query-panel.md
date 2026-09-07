# Age Series (point) joins Month Profile in the same query panel, for both query modes

A scope chat, once Plate-Frame Point's UI (ADR-0026) was built and confirmed
working: the plan doc's own item 3 ("a time series of values at the point
through time") was flagged as "more complex" and deliberately left open at
the end of that session. This ADR resolves it.

CONTEXT.md already names this concept -- **Age Series (point)**: "how has
this cell changed across geological time," Annual layer only, deliberately
distinct from **Time Series** (the existing whole-globe, multi-variable fan
chart). The engine side already exists for both query modes:
`core/queryPoint.ts`'s `ageSeries()` (Anchored) and `plateFrameAgeSeries()`
(Plate-Frame), both hard-coded to the last depth layer
(`layerOffset = (ndepth - 1) * plane`, i.e. Annual for a 13-layer climate
variable, or paleogeography's one layer) -- never whichever Month happens to
be selected. Only the UI was missing.

## Scope: both query modes

**Decision: both Anchored Point and Plate-Frame Point get an Age Series
chart**, not just Plate-Frame (which motivated the plan doc's original "see
what value this piece of crust carries at other ages" framing). The engine
already supports both symmetrically, and CONTEXT.md's "Age Series (point)"
term already reads generically enough to cover both -- it just hasn't been
updated to *say* Plate-Frame explicitly yet (see "Consequences" below).
Shipping only one mode would leave the UI asymmetric (one mode has two chart
types, the other has one) for no real savings, since the panel code is
identical either way, just fed a different series function.

## Placement: stacked below Month Profile, not a toggle

Initially proposed as a Month/Age tab switch within the existing query
panel. **Rejected**: the two query modes (Anchored, Plate-Frame) already
give shift-click its mode selector (ADR-0026); a second toggle nested inside
the result panel would be one control too many. **Decision: the Age Series
chart renders stacked below the existing Month Profile chart, in the same
`queryPanel` DOM node, always shown together** -- no toggle, no new
open/close state to keep in sync with the panel's own.

## Fetch timing: once per point, not once per Frame load

Month Profile is free: it reads the texture already resident for display
(`FrameCache` already has it). Age Series is not -- it needs every Frame's
bytes for the active variable, which for `climate-540myr` can mean hundreds
of fetches. **Decision: computed eagerly (starts as soon as the point is
assigned/the panel opens), but only ONCE per point** -- recomputed when the
point changes (a new click) or when layer/variable/climate-model changes
(the series is now for a different quantity), but explicitly **not** on
every Frame load the age slider triggers. `refreshAnchoredQuery()`/
`refreshPlateFrameQuery()` already run on every Frame load (they own Month
Profile's live value + Plate-Frame's marker reposition) -- Age Series must
NOT be re-fetched from inside them, or every slider tick during a drag would
re-request the whole series. Only the chart's own **current-age marker**
needs to move on a Frame load, redrawn from the already-held series data --
the same "recompute the value, just redraw the marker" split Month Profile's
own `updateQueryMonth()` already established for the month axis, applied to
the age axis instead.

Practical implementation split this implies:
- **Series fetch** (`ageSeries()`/`plateFrameAgeSeries()`): triggered from
  `queryMonthProfileAt()`/`queryPlateFramePointAt()` (a new click) and from
  whichever methods already run on a layer/variable/climate-model switch
  (`setLayer`/`setVariable`/`setClimateModel`) while a point is active,
  mirroring how Month Profile itself already gets asked to refresh at those
  moments (`loadFrame()` -> `refreshAnchoredQuery()`/`refreshPlateFrameQuery()`).
- **Marker redraw only**: triggered from `applyAge()`/`applyMonth()`
  (`applyMonth()` because Month Profile's own vertical marker also lives on
  this chart's sibling), reading whatever series is already cached on the
  active point -- no fetch.
- Cache lifetime: held on the active point's own local state (like
  `queryMonthProfile` already holds Month Profile's rendered profile/canvas
  for `updateQueryMonth()`), not a cross-click cache keyed by variable --
  discarded the moment the point itself is replaced or cleared, same as
  everything else about an active query point.

## Variable scope: just the active one

**Decision: the currently selected variable only**, matching Month
Profile's own scope exactly -- one variable, whatever's on screen. Not the
existing Time Series panel's curated multi-variable set
(`TIME_SERIES_VARIABLE_IDS`): that would be a bigger fetch (N variables x
every Frame instead of one) and duplicates that panel's own multi-row
layout for a narrower audience (one point, not the whole globe). Follows
automatically from whichever variable is active, the same way Month
Profile already does.

## Rendering: mirrors drawQueryProfile(), full model age range on the x-axis

Same visual language as the existing `drawQueryProfile()` (Month Profile's
own chart): a line + dots, a NaN value breaks the line rather than bridging
across it, a vertical marker at the current position. Age Series' marker
sits at the current AGE instead of the current MONTH.

**X-axis: the full model age range** (`manifest.frames`' own min/max, the
same convention `ClimateUI`'s existing Time Series panel already uses via
`setAgeRange()`/`timeSeriesAgeMin`/`timeSeriesAgeMax`), not auto-scaled to
just whatever data the series happens to return. This matters specifically
for Plate-Frame Point: `plateFrameAgeSeries()` already stops returning
entries past the assigned point's own `beginAge` (ADR-0025's "cutoff
applies once, uniformly" design) -- rendered against the full model range,
that shows up as a short line on a wider axis, visibly communicating "this
piece of crust doesn't reach further back than this," which is exactly the
"show it as a series boundary, not a silent gap" intent that function's own
doc comment already named. Anchored Point's own series always spans the
full range trivially (one entry per Frame, no filtering), so this is a
no-op distinction for that mode -- data range and model range already
coincide.

No new "no data" outcome to model at the panel level either way: a
Plate-Frame Point already swaps the WHOLE panel to a "no plate here"
message (ADR-0026) once the age slider scrubs past its own `beginAge` --
at that point there's no current value OR marker to show, so the chart
doesn't need its own separate handling for that case; it only ever renders
while the point is answerable at all.

## Consequences

- CONTEXT.md's "Age Series (point)" glossary entry has been updated to cover
  the Plate-Frame variant, and its Plate-Frame Point entry's stale "Not yet
  implemented" language is fixed too.
- No engine changes were needed: `ageSeries()`/`plateFrameAgeSeries()`
  already existed and were already tested (`check:query-point`,
  `check:static-polygons`). This was a pure `ClimateInstance`/`ClimateUI`
  addition: `ClimateUI.drawAgeSeriesChart()` (the chart) and
  `ClimateInstance.fetchAgeSeries()` (the once-per-point fetch, wired into
  both click handlers and the layer/variable/climate-model/resolution
  switches), plus a small `showQueryPanel()` signature extension
  (`AgeSeriesPanelData`) to carry the result through to the render. One
  implementation detail worth recording since it wasn't obvious going in:
  the marker needed NO separate update path of its own (unlike the
  speculative "mirrors Month Profile's updateQueryMonth()" framing above) --
  `refreshAnchoredQuery()`/`refreshPlateFrameQuery()` already rebuild the
  whole panel, Age Series chart included, on every Frame load (an age-slider
  tick), so the marker simply moves as a side effect of that existing
  rebuild; only the FETCH needed its own once-per-point guard.
- Verified against a live dev server (Playwright), both modes: the
  "computing…" placeholder while the fetch is in flight, the resolved
  chart's own non-blank pixels, and -- checked via request counts before and
  after several age-slider scrubs -- that scrubbing does not re-trigger the
  fetch.
