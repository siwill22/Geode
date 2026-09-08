# Anchored Point query

**Status: implemented.** `core/queryPoint.ts`'s `monthProfile()`/`ageSeries()`
are the engine-level primitives this doc specifies, shift-click-driven in
both the mantle/generic globe viewer (`globe/globeInstance.ts`) and the
climate viewer (`climate/climateInstance.ts`, which also layers Plate-Frame
Point on top — see `docs/plans/plate-frame-point.md`). See ADR-0011 for the
two architectural decisions and their consequences; this doc is the
implementation shape it was built from. Terms (Query Point, Anchored Point,
Month Profile, Age Series) are defined in `CONTEXT.md`.

## What it is

A generic, engine-level (`core/`) query: given a `LonLat`, read a Variable's
value at the nearest grid cell. Not specific to any one viewer — any Layer
in any viewer can offer a click-to-query affordance by getting a `LonLat`
from its own scene (however it likes) and calling into this.

Two shapes, kept separate rather than one combined (Frame × Month) query:

- **Month Profile** — all layers of the currently-loaded Frame's depth axis
  (Months + Annual, or just Annual for a Model with no month axis) at one
  cell. Reads the texture already resident in `FrameCache` for display — no
  network request of its own.
- **Age Series (point)** — one value per Frame of the active Model, Annual
  layer only, at one cell. Needs every Frame's bytes, same shape as the
  existing global Time Series feature.

## API shape

```ts
// core/queryPoint.ts

interface CellSample {
  cell: LonLat;       // the sampled cell's own centre, not the raw click
  value: number;       // NaN if masked/no-data at this cell+frame
}

function monthProfile(
  volume: Data3DTexture, res: ResolutionInfo, variable: VariableInfo, at: LonLat,
): CellSample[];       // length = res.ndepth

async function ageSeries(
  archiveBase: string, modelId: string, manifest: Manifest, variable: VariableInfo, at: LonLat,
  resolutionId?: string,
): Promise<(CellSample & { age: number })[]>;   // one per manifest.frames entry
```

`monthProfile` is synchronous and pure CPU — it takes the same `Data3DTexture`
(or its backing buffer) `FrameCache` already handed the caller for rendering.
`ageSeries` is async, mirroring `computeTimeSeries`'s signature.

Neither function takes a `Raycaster`, an NDC point, or a DOM event — see
ADR-0011. A viewer wanting Anchored Point support does its own
`raycaster.intersectObject(...)` → `vec3ToLonLat()` (already in
`core/constants.ts`), the same pattern `tomography/instance.ts`'s
`pickLonLat()` already establishes, and passes the result in.

## The shared byte cache

New module, `core/frameByteCache.ts`:

```ts
function getFrameBytes(
  archiveBase: string, modelId: string, manifest: Manifest, variableId: string, frameId: string,
  resolutionId: string,
): Promise<Uint8Array>;   // memoises on model/variable/resolution/frame
```

`fetchVariableBytes` stays the uncached primitive (it's also used for the
one-off mask fetch); `getFrameBytes` wraps it with a `Map<string,
Promise<Uint8Array>>` the same shape as `FrameCache`'s own LRU, but keyed to
raw bytes rather than GPU textures, with no eviction — the per-Frame payload
is small (~200 KB gzipped, less on the wire, decoded to ~830 KB) compared to
a GPU texture, and a session that opens both a Time Series panel and several
Anchored Points on the same (model, variable) is exactly the case this
exists to not re-fetch for.

`computeTimeSeries` and `ageSeries` both call `getFrameBytes` instead of
`fetchVariableBytes` directly. `loadMask2D`'s mask fetch can route through it
too, for the same reason — a Model with `mask_variable` set pays for that
fetch once per Frame today across every Time-Series-consuming Variable.

## Cell lookup

`texelIndex()` and `texelToPhysical()` (`core/volume.ts`) already do
everything `monthProfile`/`ageSeries` need per cell — no new indexing logic,
just a new caller. The only addition is deriving the sampled cell's own
`LonLat` back from `(iLon, jLat)`, the inverse of `texelIndex`'s own mapping,
for the "which cell actually answered" report ADR-0011 calls for.

## Sequencing

1. `core/frameByteCache.ts` — pure refactor, `computeTimeSeries` gains no
   new behaviour, only a cache it didn't have before.
2. `monthProfile` — cheapest, no network, exercises `texelIndex` reverse
   mapping and the categorical-is-fine rule.
3. `ageSeries` — same fetch/mask/sentinel handling as `computeTimeSeries`,
   parameterised by cell instead of area weight.
4. Per-viewer wiring (click → `LonLat` → call → display) is out of scope for
   this doc — a UI concern per viewer, not an engine one.

## Verification

- `monthProfile` against a fixture volume with a known per-layer pattern —
  confirms `texelIndex`'s nearest-neighbour convention and layer ordering.
- `ageSeries` against a `mask_variable` fixture with at least one Frame
  fully masked at the query cell — must return `NaN` for that Frame, not a
  fabricated value or a skipped entry (a gap, not a shorter array).
- Cache-sharing: calling `computeTimeSeries` then `ageSeries` (or the
  reverse) for the same (model, variable, resolution) fires the underlying
  fetch once, not twice — a network-call-count assertion, not a screenshot.
