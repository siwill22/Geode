# Plate Carrée as Geode's first alternate Projection

Geode's globe rendering has no projection concept: geometry is always a
sphere, and the shared GLSL `worldToGeographic` inverts a fragment's sphere
position to (lon, lat) for texture sampling. Camera and controls are
similarly sphere-only — a shared `PerspectiveCamera` + `OrbitControls` for
every tiled instance. Extending Geode with flat map projections (starting
with Plate Carrée, with Robinson/Mollweide/Spilhaus expected later) requires
committing to an architecture for how projection-dependent behaviour is
expressed, before a second consumer exists to force the issue.

We're adding Projection as a `core/` concept (not climate-local), switched
globally — every tiled instance shares one Projection the same way they
already share one camera — via a small named registry keyed by Projection
mode (geometry factory, camera/controls factory, shader-mode index), rather
than scattering `if (mode === 'plateCarree')` across each call site. The
volume-draping shader keeps one material with a `uProjectionMode` uniform
branching inside `worldToGeographic`, instead of duplicating the material's
mask/uniform wiring across per-projection shader variants. Plate Carrée gets
its own `OrthographicCamera` + pan/zoom rig, swapped in with the geometry,
because a `PerspectiveCamera` looking down at a flat plane still distorts
away from screen-centre and isn't a genuine undistorted map. Coastlines and
land fill are out of scope for v1: their vertex positions are built on the
CPU from plate-rotation slerp, never passing through `worldToGeographic`, so
reprojecting them is a separate, unrelated piece of work.

## Considered Options

- Keep Projection climate-local until a second consumer needs it — rejected
  because Spilhaus (already planned) will need geometry/camera/shader
  treatment even more different from Plate Carrée than Plate Carrée is from
  Globe, and retrofitting a climate-only implementation into `core/` later is
  costlier than seating the abstraction correctly now.
- Two separate materials/shaders (sphere variant, flat variant) instead of
  one shader with a uniform branch — rejected because it would duplicate
  every future material feature (e.g. the in-progress valid-mask uniform)
  across two shader sources that must be kept in sync.
- Reuse the existing `PerspectiveCamera`/`OrbitControls`, constrained to
  top-down, instead of a dedicated orthographic rig — rejected because it
  still produces perspective distortion away from screen-centre, defeating
  the point of an accurate flat map.
- Reproject coastlines/land fill alongside the surface in v1 — rejected;
  their build pipeline (CPU-side quaternion slerp between baked rotation
  ages) doesn't go through the shader seam at all, so bundling it risks
  turning "add Plate Carrée" into "rebuild the coastline pipeline."

## Consequences

Per tiled instance, geometry is rebuilt (not just hidden/shown) whenever
Projection changes — cheap for a `SphereGeometry`/`PlaneGeometry` pair, so
this is a deliberate simplicity trade, not a performance one. Plate Carrée
ships without coastlines/land fill in v1; the flat view shows only the
Volume-derived surface until coastline reprojection is designed separately.
No projection choice persists across reload yet, consistent with the
existing model/resolution dropdowns.
