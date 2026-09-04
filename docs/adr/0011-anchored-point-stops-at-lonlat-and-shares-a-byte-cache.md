# Anchored Point takes a LonLat, not a click, and shares a byte cache with Time Series

Geode is adding an engine-level point query (Query Point / Anchored Point,
see `CONTEXT.md`) so a viewer can click a location and read a Variable's
value there — either across the Months within one Frame (Month Profile) or
across every Frame of the active Model (Age Series). Two decisions define
its shape.

**The engine boundary starts at a `LonLat`.** Anchored Point never touches a
`Raycaster`, an NDC coordinate, or a pointer event. Turning a screen click
into a `LonLat` stays each viewer's own code, the same way the tomography
viewer's Cutaway tool already does it (`pickLonLat()` in
`viewer/src/tomography/instance.ts`) — which mesh is currently pickable is a
scene-graph fact specific to that viewer (a cutaway wall, a plain data
sphere, or whatever a future viewer adds), not a generic one, so the
engine has no business owning it.

**Age Series shares a fetch with Time Series (climate) instead of running
its own.** Both need the identical thing — every Frame's raw bytes for one
Variable, CPU-only, via `fetchVariableBytes` — and today neither one caches
those bytes at all; `computeTimeSeries` (`core/timeSeries.ts`) re-fetches on
every call, relying on the *caller* (`ClimateInstance.timeSeriesCache`) to
avoid repeat work, keyed to the computed `TimeSeriesPoint[]` rather than the
raw bytes. A user with a Time Series panel open on Temperature who then
clicks an Anchored Point on Temperature would otherwise download every
Frame's bytes a second time. Introduce one shared per-Frame byte cache
(keyed `model/variable/resolution/frame`, the same key shape `FrameCache`
already uses, but holding decoded `Uint8Array`s rather than GPU textures)
that both Time Series's mean/percentile reduction and Anchored Point's
single-cell read draw from.

## Consequences

Follow-on decisions, small individually, recorded together for the same
reason ADR-0007 grouped its own three:

- **No categorical exclusion.** Time Series excludes categorical Variables
  (Köppen) because averaging class indices is meaningless — a property of
  its *mean* reducer, not of the Variable. Anchored Point never combines
  cells, so nothing stops a categorical Variable from being queried; porting
  Time Series's `pickableTimeSeriesVariables()` filter verbatim would be a
  copy-paste bug here, not a safe default.
- **Validity mask honoured per cell**, mirroring Time Series exactly: a
  masked cell reports no value for that Frame rather than whatever bytes
  happen to fill an unmasked-in-name-only texel.
- **Nearest-cell snapping, with the sampled cell reported back.**
  `texelIndex()`'s existing nearest-neighbour convention decides which cell
  answers a click; the result carries that cell's own centre `LonLat`, not
  just the raw click coordinate, since at 1° resolution the two can visibly
  disagree.
- **Interpolation is future work, not this decision.** Continuous Variables
  would be better served by bilinear interpolation over the four nearest
  cells than nearest-neighbour snapping. Deferred, but already known to
  require gating on the same `categorical` / `no_data_sentinel` flags the
  manifest already carries for GPU texture filtering (`loadVolume` picks
  `NearestFilter` vs `LinearFilter` off exactly those two conditions) —
  blending across a class boundary or a no-data sentinel fabricates a value
  the same way ADR-0005 already forbids on the GPU path.

This ADR is scoped to Anchored Point only. The moving-point mode
(Plate-Frame Point) needs plate-polygon data the archive does not yet carry,
and a "cannot answer for this age" outcome with no precedent in the
codebase; it is deliberately out of scope here — see
`docs/plans/plate-frame-point.md`.
