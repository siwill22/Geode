# A reconstructed point never precedes its assigned plate's begin age

While fixing an unrelated bug in the sibling StoryMaps `detrital-zircons`
prototype (not part of this repo), some sample points were found visibly not
moving as reconstruction time changed. Root cause: the sample's plate id came
from a static polygon whose own begin age was younger than the sample itself
— the crust wasn't that block yet at the sample's age, but `pygplates` does
not error on that, it silently holds the plate's oldest defined rotation
pole fixed, so the point just stops moving instead of reporting anything
wrong. The fix there was a page-local Python filter, written ad hoc.

Checking whether Geode already had this written down as a rule found: yes,
but only as a Plate-Frame Point implementation detail, not a named general
one — and the one place that would let every future consumer get it for
free didn't have it at all.

## The decision

**A point/sample assigned a plate id by static-polygon point-in-polygon
testing is never validly reconstructed at an age older than that polygon's
own begin age.** This is not a new rule — it is ADR-0025's own finding
(*"the point's valid age range is exactly `[0, assignedFeature.beginAge]`"*),
correctly implemented today in `viewer/src/core/staticPolygons.ts`'s
`positionAt()` — generalized and given a name so it is a citable principle
any future point-dataset feature must satisfy, not something to re-derive
per feature the way it was derived once already for Plate-Frame Point and
would otherwise have to be re-derived again for the next one.
`CONTEXT.md`'s Plate-Frame Point entry already anticipated this
generalization (*"loading an arbitrary point dataset and reconstructing it
consistently with whatever Reconstruction Model is on screen is the same
per-point assignment-and-rotation applied to many points instead of
one"*) without it ever being written as its own rule.

**Not the same mechanism as ADR-0029's VGP window.** A Virtual Geomagnetic
Pole is shown only within a fixed ±5 Ma of its own recorded age — a
proximity window, unrelated to any polygon's begin age. The two are easy to
conflate (both are "an age-validity rule for a plate-assigned point") but
answer different questions: this rule bounds how far back a plate id
assignment remains geologically meaningful at all; ADR-0029's window bounds
how far a VGP may be shown from the one age it was ever computed for. A VGP
sample site is still subject to *this* rule too (see Consequences) — the two
compose, they don't substitute for each other.

**The mechanism lives upstream, in `deep-time-map`, not duplicated per
consumer.** `viewer/vendor/deep-time-map`'s `python/deep_time_map/points.py`
(`points_from_dataframe()`) is the one shared, generic "assign plate id via
static polygon, reconstruct through time" pipeline — used by Geode's planned
`prep_paleomag.py` (ADR-0029) and vendored independently by the sibling
StoryMaps prototypes. It did not expose the assigned polygon's begin age at
all; only `plate_id` was copied via `pygplates.partition_into_plates`. That
gap is exactly what let the StoryMaps bug happen, and it was a live gap for
`prep_paleomag.py` too. Per deep-time-map's own `docs/adr/0001` scope rule
(pure `pygplates` geometry, no consumer-specific knowledge required) and its
"split features" pattern, the fix belongs upstream: `points_from_dataframe()`
now also copies `pygplates.PartitionProperty.valid_time_begin` and returns it
as `plate_begin_age` on every record (`deep-time-map` v0.3.0, this repo's
submodule pin bumped to match). This is a **mechanism, not a policy** — the
field is exposed, nothing is filtered or nulled by the library itself, the
same "export carries WHERE, the renderer decides WHEN" split
`points_from_dataframe()`'s own `age` field already follows. Whether a given
consumer excludes an over-old point at build time (as the StoryMaps fix
does), returns null per-frame (as `staticPolygons.ts` does), or does
something else entirely stays that consumer's own choice.

## Consequences

- No code change needed in `viewer/src` today. Plate-Frame Point already
  independently implements this rule correctly, via a different code path
  (live, click-time, TypeScript-side assignment in `staticPolygons.ts`, not
  a `points_from_dataframe()` consumer) — this ADR does not change that
  behavior, it gives it a name and states it as a general rule other
  point-dataset features must also satisfy, closing the gap between the
  feature-specific implementation and the general principle `CONTEXT.md`
  had already anticipated but never written down.
- `prep_paleomag.py` (ADR-0029, not yet written) should read
  `plate_begin_age` from `points_from_dataframe()`'s output when it is
  eventually implemented, rather than re-deriving its own begin-age check —
  a VGP reconstructed to its own `averageAge` has exactly the same failure
  mode as a Plate-Frame Point or a detrital zircon sample if that age
  exceeds its sample site's assigned polygon's begin age. Flagged here as a
  known follow-up, not implemented in this pass.
- `viewer/vendor/deep-time-map` submodule pin bumped to `v0.3.0` (was
  `v0.2.0`), per ADR-0028's own rule: `CHANGELOG.md` read first, `npm run
  typecheck` and `npm run check:boundaries` both pass unchanged (the bump
  touches only `python/deep_time_map/points.py`, which nothing in
  `viewer/src` or `prep/` calls yet).
- StoryMaps' own vendored `deep-time-map` copy is a separate, independently
  versioned checkout, not this submodule, and is **not** updated by this
  change — explicitly out of scope. Its existing ad hoc
  `filter_reconstructable_samples()` fix in `build_detrital_zircons.py`
  remains correct and untouched; it now simply duplicates logic that has a
  proper upstream home, which is a follow-up for that project, not this one.
- `CONTEXT.md`'s Plate-Frame Point entry is updated alongside this ADR: the
  underlying validity-rule *data* (`plate_begin_age`) is now available
  upstream to any consumer, though the "load an arbitrary point dataset"
  *feature* itself remains unbuilt — not to be conflated.
