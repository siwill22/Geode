# User-Seeded Particle Tracking ("Tracked Particle")

**Status: v1 built** on `feature/tracked-particles` (2026-09-11), covering
2D Vector Fields in climate.html and valdes.html per the scope below. Not
yet merged/reviewed by the user. No `CONTEXT.md`/ADR entry yet — add one if
this lands on `main`. 3D/mantle tracking remains deferred, unbuilt.

## What it is

The user clicks a point on the globe; a particle is seeded there and
advects continuously through the active Vector Field's real (u, v) flow,
leaving a persistent path — as opposed to Vector Streak's ambient, randomly
seeded, finite-lifetime particles (`CONTEXT.md`'s Vector Streak entry,
`viewer/src/core/windStreaks.ts`). This is a query tool ("where does the
water/air starting *here* actually go") layered on the same flow, not a
replacement for the ambient visualization.

## Resolved this session

- **2D surface Vector Fields only, for now.** Mantle/convection models
  (`opt1`, `semucb`, `reveal`, `uup07`, `cao2024-*`,
  `muller2019-deformation`) carry a **scalar** temperature/velocity-anomaly
  field only — confirmed against every convection-type manifest in
  `archive/models/`, none declares `vector_fields`, and `prep_convection.py`
  never writes a velocity component. There is no actual flow vector
  (vx/vy/vz or vr/vθ/vφ) anywhere in the archive today. 3D mantle-flow
  tracking is deferred, not designed here — see "3D follow-up" below. The
  2D fields that DO exist and are in scope: Wind, Ocean Surface Current,
  Sea-Ice Drift, (Ocean Depth's) Ocean Current (`VectorFieldInfo` in
  `viewer/src/core/types.ts`).
- **Live pathline, not frozen streamline.** A tracked particle advects in
  real time as `tick(dt)` fires, riding whichever Frame/month is currently
  loaded, the same integration model Vector Streak already uses — not a
  one-shot integration through a single frozen snapshot drawn instantly.
- **Seeding gesture: single click, repeatable.** Each click adds one more
  tracked particle at the picked (lon, lat); no drag/rake seeding.
- **Lives in core, generic.** A new module sibling to
  `windStreaks.ts` — generic over any 2D Vector Field snapshot, no
  paleoclimate-specific knowledge, wired into `climateInstance`/
  `valdesInstance` the same way Wind Streak already is.

## Why this can't just be "seed WindStreaks manually"

`WindStreaks` is built around three assumptions that a user-tracked
particle needs to break:

1. **Finite lifetime + random respawn** (`PARTICLE_LIFETIME_S`,
   `respawn()`) exists to keep ambient coverage even — a user-seeded
   particle should do the opposite: persist where the user put it,
   indefinitely, never silently relocate.
2. **Fixed-depth ring buffer trail** (`TRAIL_LEN = 12`) exists to draw a
   short fading streak, not a record of where the particle has actually
   been. A tracked particle's whole point is cumulative displacement —
   the path itself is the answer to the query.
3. **Preallocated `MAX_PARTICLES`** sized for a dense ambient cloud
   (thousands) is the wrong shape for a handful of deliberately-placed
   points that need to persist far longer than `TRAIL_LEN * RECORD_INTERVAL_S`
   (~1.5s).

The actual per-particle **advection step** (sample (u, v) at the current
position, step along the local tangent plane, renormalise onto the sphere
or clamp on Plate Carrée) is exactly reusable — that math has nothing to
do with lifetime or trail depth and shouldn't be reimplemented.

## Architecture sketch

- New `core/trackedParticles.ts`, sibling to `windStreaks.ts`. Holds a
  small, growing list (not a fixed-size preallocated pool) of user-seeded
  particles, each keeping a **path history sized for the query, not a
  short ring buffer** — see "path growth" below.
- Advection: factor the tangent-plane-step-then-renormalise logic
  `WindStreaks.advect()` already contains into a shared helper both
  modules call, rather than duplicating it. Same globe/Plate-Carrée branch,
  same sentinel handling — except a tracked particle that lands on a
  sentinel/no-data cell should **freeze in place and flag itself**, not
  retry into a new random spot the way an ambient particle does (its
  position is user-meaningful; silently relocating it defeats the point of
  seeding it there).
- Wiring: same `tick(dt)` call site pattern as Wind Streak
  (`climateInstance.tick()`, `viewer/src/climate/climateInstance.ts:1351`)
  — a sibling `trackedParticles.update(dt, ...)` call alongside the
  existing `windStreaks.update(...)` call, reading the same
  `currentWindPlane()` accessor.
- Rendering: a persistent line/ribbon per particle rather than
  `WindStreaks`' fixed-width fading ribbon — visually distinct from Vector
  Streak (solid/persistent vs. fading/speed-tinted) so the two read as
  different things at a glance when both are visible at once.

## Open questions (not resolved yet)

- **Path growth / memory budget.** An unbounded path on a particle running
  for many minutes accumulates thousands of vertices. Needs either a cap
  (stop recording past N points, or past a max real-time duration) or a
  decimation scheme (keep every Mth point once a threshold is hit) — a
  different tradeoff from Vector Streak's fixed `TRAIL_LEN`, not yet
  chosen.
- **Seeding gesture vs. existing Shift-click.** Anchored Point already
  claims Shift-click for "query here" in climate/valdes
  (ADR-0016). A second click-meaning on the same globe is exactly the
  collision ADR-0016 avoided once already (its own reasoning: reusing one
  modifier for two purposes makes the same key mean different things).
  Needs either a distinct modifier (e.g. Alt/Option-click) or a toggled
  tool mode (mirroring the Vector Glyph/Vector Streak style toggle) that
  puts the globe into "add tracked particle" for the duration, rather than
  assuming Shift is free to reuse.
- **Removing/clearing particles.** Click-to-remove-nearest? A "clear all"?
  A small list/panel of seeded particles, each independently removable?
  Not designed.
- **Frame/month/age changes mid-flight.** Vector Streak's ambient
  particles just keep advecting through whatever Frame is now active when
  the user changes month/age — should a tracked particle behave
  identically (continuous position, new field underneath it), or should
  changing the Frame implicitly pause/reset tracking? Silently continuing
  into a different month's field is probably right (matches Vector
  Streak's own precedent) but hasn't been confirmed as a deliberate
  choice for the tracked case specifically.
- **Multi-Globe interaction** (ADR-0022). If several synced globe
  instances show different Vector Fields at once, does each get its own
  independently-seeded particle set, or does one seed propagate to all?
  Likely independent-per-instance (consistent with ADR-0014's "compare via
  separate globes, not overlay" precedent for Vector Field itself), not
  yet confirmed.
- **Coexistence with Vector Streak.** Working assumption: fully
  independent, simultaneously visible (a user can track a particle with or
  without the ambient streak animation on) — not yet confirmed as a
  deliberate decision.
- **UI home.** `climateUi.ts`/`valdesUi.ts` each need a new control
  surface (seed-mode toggle, particle list, clear). If a lil-gui
  dropdown/toggle drives the seed-mode switch, watch the bound-state guard
  trap already hit once with the Vector Glyph/Streak toggle — never guard
  a no-op check on the same property the dropdown is bound to.

## 3D follow-up (deferred, not designed)

Blocked on data, not viewer architecture: would need a new `prep/`
ingestion step for a geodynamic model that actually publishes a velocity
field (vx/vy/vz or vr/vθ/vφ per depth level, per ADR-0010's kind of
depth-anchoring care), a genuinely 3D advection step (the radial component
moves a particle between depth shells, not just laterally across one), and
a different rendering approach (a 3D curve inside a Volume/Cutaway rather
than a surface-hugging ribbon). Do not start this until a specific
candidate dataset is identified.

## Explicitly not decided

Whether this is exposed via the generator's recipe system for
auto-generated viewers, or stays a hand-wired feature on climate/valdes for
now (same "test viewer only, for now" caveat as
`vertical-profile-clustering.md`). Naming — "Tracked Particle" is a working
name, not yet a committed `CONTEXT.md` term.

## What actually got built (v1)

Implemented autonomously against the resolved decisions above, without
further check-ins, per the user's "go build" instruction. Every open
question below was closed with a specific, documented judgment call rather
than left blocking — flagged here for review, not presented as settled:

- `core/trackedParticles.ts`: the `TrackedParticles` class described in
  "Architecture sketch" above. Duplicates (rather than shares)
  `WindStreaks`' tangent-plane advection step — a deliberate call to avoid
  touching the existing, tuned ambient visualization; see the class's own
  doc comment for the reasoning.
- **Rendering**: a persistent `Line` (vertex-coloured, speed-tinted green,
  solid, growing) plus a small `Points` head marker per particle — not a
  ribbon. Chosen over reusing `WindStreaks`' ribbon geometry for
  visual distinction (persistent line vs. fading ribbon read as different
  things at a glance) and implementation simplicity.
- **Path memory bound**: `MAX_PATH_POINTS = 4000` preallocated per particle;
  `compact()` halves resolution (keeps every 2nd point) once full, so a
  particle can run indefinitely at ever-coarser path resolution rather than
  being capped or dropped. Untuned — 4000 was picked as "clearly enough for
  a demo session," not measured against real advection rates.
- **Seeding gesture resolved to Alt-click** (`ev.altKey`), not a toggled
  tool mode — Shift was already Anchored Point's gesture in climate.html
  (ADR-0016), so Alt was free in both climate.html and valdes.html (neither
  used it previously). Wired identically in both viewers'
  `pointerdown`/`pointerup` handlers.
- **Globe projection only, v1**: seeding requires `projectionMode ===
  'globe'` (mirrors Anchored Point's own restriction) and
  `TrackedParticles.setProjection('plateCarree')` clears every particle
  rather than attempting Plate Carrée's antimeridian-aware multi-stroke
  rendering discussed above — descoped for time, not designed.
- **Stall behaviour**: a particle landing on a no-data/masked texel sets
  `stalled = true` **permanently** — it does not resume even if the
  underlying field later becomes valid there again (e.g. a different
  month). This is stricter than the "freeze in place" language above
  implied and hasn't been checked against a real no-data-heavy model
  (Pohl) for whether permanent-vs-resumable is the right call.
- **Removing particles**: only `clearTrackedParticles()` (a single "clear
  tracked particles" lil-gui button, alongside the wind/vector-field
  controls in both climateUi.ts and valdesUi.ts, hidden when no Vector
  Field is available) — no per-particle removal, no list UI. The open
  question about a removable list is still open.
- **Frame/month/age changes mid-flight, Multi-Globe interaction,
  coexistence with Vector Streak**: built per the working assumptions
  stated above (continues advecting through whatever plane is current;
  each `ClimateInstance`/`ValdesInstance` owns its own independent
  `TrackedParticles`; fully independent of Vector Streak's own
  visibility) — none of these were re-verified by hand beyond the
  automated checks below, since they follow directly from `tick()` reading
  `currentWindPlane()`/`currentVectorPlane()` exactly like the ambient mode
  already does.
- **Verification**: `viewer/scripts/check_tracked_particles.mjs` (pure
  logic — seeding, advection direction, sentinel stall, `clear()`,
  `setProjection()`, compaction — no browser) and
  `viewer/scripts/check_tracked_particles_browser.mjs` (headless
  chromium against climate.html and valdes.html via new
  `window.__climate`/`window.__valdes` test hooks: `addTrackedParticle`,
  `clearTrackedParticles`, `trackedParticleCount`). Both pass; existing
  `check:query-point`, `check:static-polygons`, `check_climate_regression`,
  and `shoot_valdes` suites re-run clean (no regressions, no new console
  errors). Not covered: an actual pointer-drag Alt-click through Playwright
  (the browser check seeds via the test hook directly, bypassing the
  raycast) — the click-to-`LonLat` path itself was only checked by hand via
  ad-hoc screenshots, not scripted.
