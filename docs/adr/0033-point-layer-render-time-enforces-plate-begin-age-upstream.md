# PointLayer itself enforces plate_begin_age, not each consumer

A user reported the Boucot paleolithology layer (`core/pointOverlay.ts`)
showing points frozen in the middle of the Pacific across the whole
Cretaceous. Investigation found real data, not a bug in `prep_boucot.py`:
several samples (e.g. a Resolution Guyot reef-limestone site, genuinely a
Cretaceous mid-Pacific seamount sample) fall outside every static polygon in
this archive's Scotese model — no oceanic Pacific-plate polygon exists in
it at all — so `points_from_dataframe()` assigns `plate_id: 0`, which
carries an identity rotation forever. A further 115 of 8698 points in the
same dataset were assigned a real plate whose own polygon begins later than
the point's own age — the same silent freeze ADR-0032 already named,
just less obviously wrong since the plate id isn't 0.

ADR-0032 added `plate_begin_age` to `points_from_dataframe()`'s output
specifically so a consumer could check this, but deliberately stopped at
"mechanism, not policy" — nothing was ever wired up to actually read the
field at render time. The user's assumption going in was that this had
already been fixed everywhere; reviewing every consumer found it hadn't:
Plate-Frame Point enforces the equivalent rule today, but via its own
bespoke, independently-derived TypeScript code path (`staticPolygons.ts`)
that never goes through `PointLayer` at all. `js/points.js`'s own
`isLive()` — the one renderer every `PointLayer` consumer shares, in either
transport — never checked `plate_begin_age`. Boucot is simply the first
real `PointLayer` dataset consumer in this repo, so it's the first to have
exposed the gap; VGP (ADR-0029, unbuilt) would have hit it too.

## The decision

**The check belongs in `deep-time-map`'s `PointLayer.isLive()`, not in
Geode's wrapper.** Per `deep-time-map`'s own ADR-0001 scope rule (pure
sphere-geometry/plate-validity logic, no consumer-specific knowledge) and
the exact reasoning ADR-0032 already used to justify moving
`plate_begin_age` itself upstream: fixing it once in the shared renderer
means every future `PointLayer` consumer (in Geode or any sibling repo)
gets it for free, rather than re-deriving the same check per feature.

`isLive()` now also enforces `_plateValidAt(point, time)`: never live at a
time older than `plate_begin_age`, and for `plate_id: 0` (no polygon at
all), never live at any time but the present. Backward compatible — a
dataset that never went through `points_from_dataframe()` has neither field
(`undefined`, not `null`), so behavior is unchanged for it.
`viewer/vendor/deep-time-map` submodule bumped to `v0.4.0`.

## Consequences

- Every `lifespan` mode and both transports get this for free, not just
  Boucot's `'range'` mode — the check runs before the `lifespan` switch in
  `isLive()`.
- Measured effect on the Boucot dataset alone: 10–33 of several hundred
  live points suppressed at any given age (peak at ~145–200 Ma), previously
  shown frozen in a geologically meaningless position.
- Plate-Frame Point's own `staticPolygons.ts` implementation is untouched —
  it is a different feature (click-time single-point assignment) with a
  different data path, not a `PointLayer` consumer, and this ADR does not
  change it.
- `prep_paleomag.py` (ADR-0029, still unbuilt) now gets this rule enforced
  automatically once it ships, with no code of its own needed for it.
