# Vertical-Profile Clustering (k-means)

**Status: proposed, not started.** Written up from a scoping conversation
(2026-09-09) to be revisited later — no code, no ADR yet. This doc captures
what was actually resolved so the next session doesn't re-derive it.

## What it is

Client-side k-means clustering of vertical profiles at every lat/lon grid
point of a Model, the way Lekic et al. (2012, *EPSL* 357-358:68-77) cluster
global lower-mantle tomography and Flament et al. do for mantle convection
model output. The user picks a number of clusters _k_; the viewer paints
each grid point by its cluster label instead of (or alongside) the raw
scalar field. Two extensions beyond a single-model clustering: a **vote
map** (agreement/consensus across several models' independent cluster
runs) and a **cross-analysis** between a tomography model and a convection
model's clusters.

## Why client-side, not a `prep/` step

Geode's default pattern for anything numerically heavy is an offline
Python step in `prep/` that ships a precomputed archive layer (see
`geode-viewer-generator-plan`'s "catalog composition only" rule). This
feature is the deliberate exception: the user wants _k_ chosen and changed
interactively in the browser, which precomputing a fixed grid of _k_ values
would only approximate.

## Why this is feasible: the data is already there

`viewer/src/core/volume.ts`'s `loadVolume()` fetches a Model's **entire**
3D field in one request and uploads it whole as a `Data3DTexture`
(`volume.ts:109-137`) — there is no per-depth-slice fetch path today, so
every grid point's full depth profile is already resident in browser
memory the moment a Model loads, for rendering reasons that have nothing
to do with this feature. Building the per-point feature matrix for k-means
costs **zero additional network requests**.

Confirmed grid sizes (`archive/models/{semucb,uup07,reveal,opt1}/manifest.json`):
360×181 lat/lon points (65,160) × 192 depth levels, ~12 MB/frame uncompressed.
`FrameByteCache` (`viewer/src/core/frameByteCache.ts`) already caches every
frame's raw bytes for a session with no eviction ("a few hundred MB is an
acceptable session-lifetime cost") — holding two or three models at once
for a vote map or cross-analysis is well inside what's already tolerated.

## The real cost: main-thread compute, and it shrinks a lot with two scope cuts

There are currently **zero Web Workers or WASM** anywhere in `viewer/src`
(grepped, no hits). A naive k-means over the full 65,160-point × 192-level
grid would block the main thread for the whole fit. Two changes, both
taken from how Lekic et al. actually scope their own analysis, shrink this
substantially:

1. **Restrict to a depth range of interest** (e.g. lower mantle only, ~30-40
   levels) instead of clustering on the whole 192-level column. This is a
   plain index-range slice on the already-decoded volume
   (`texelToPhysical()`, `volume.ts:314-316`, over depth indices `[d0..d1]`
   instead of `[0..191]`) — no numerical normalization decision required.
   Checked: `encode_min`/`encode_max` decoding is one global linear scale
   per variable, uniform across all depth levels (`types.ts:19-20`), so
   there is no existing per-depth normalization to account for or undo.
2. **Downsample the lat/lon grid** toward the model's actual resolving
   power rather than clustering at the full 1° raster. Lekic et al. cluster
   ~2,700 independent points — global tomography models don't resolve
   structure anywhere near a 65,160-point 1° grid, so most of that raster
   is spatially autocorrelated, not independent information. Downsampling
   (e.g. every 3rd-4th point) both respects that and cuts compute
   proportionally.

Net effect: workload can land within roughly an order of magnitude of
Lekic's own scale rather than the raw-raster worst case (which was ~20-50x
larger). At that size a Web Worker keeps the UI responsive during the fit
without heroics — new infrastructure for this codebase, but a small,
standard addition, not a blocker.

## Open design questions (not resolved yet)

- **Depth range selection**: fixed per Model family (e.g. hardcoded lower-
  mantle cutoffs for tomography/convection) vs. a user-adjustable range
  control. Needs a decision per Model type, not assumed uniform.
- **Choosing/validating k**: expose a plain slider, or surface an
  elbow/silhouette diagnostic (closer to what Lekic et al. use to justify
  their chosen k) alongside it.
- **Vote map label reconciliation**: k-means cluster labels are arbitrary
  per run — "cluster 2" in one model's fit has no relationship to "cluster
  2" in another's. A vote/consensus map needs some matching step (e.g.
  centroid-distance matching, or a fixed reference clustering) before
  labels from independent runs can be combined or voted on. This is
  probably the least trivial part of the whole feature and hasn't been
  designed at all yet.
- **Cross-analysis with a convection model**: what "cross-analysis" means
  concretely — same-point label correlation? Joint clustering on a
  concatenated feature vector (tomography profile + convection profile at
  the same point)? Not scoped.
- **Where this lives**: a new tool on an existing wrapper (`globe`/
  `groupGlobe`) vs. a new wrapper type, and whether/how it interacts with
  the generator's recipe system at all (it may be a "test viewer only"
  feature for now, not a generator-exposed one — cf. how
  `reconstructionGroup` started as a one-file harness before being
  promoted).
- **No-data handling**: land/no-data sentinel texels (`types.ts:139`,
  `no_data_sentinel`) need to be excluded from the point set fed to
  k-means, not clustered as if they were real values.

## Explicitly not decided

Whether this becomes a fifth wrapper type, a mode on an existing one, or
something smaller — deliberately left open. This doc is a scoping record
to revisit, not a committed architecture.
