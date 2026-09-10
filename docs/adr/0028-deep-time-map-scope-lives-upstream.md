# deep-time-map's scope and versioning rules live upstream, not here

Geode's plate-boundary rendering is `viewer/src/core/boundaries.ts` wrapping
a three.js camera in deep-time-map's own `project(vec3)` contract — see the
file's own comments for the frame-rotation and perspective-horizon detail.
A coastline/land-fill pipeline was later built independently in
`core/coastlines.ts` (lit triangulated 3D mesh, not a canvas overlay)
without ever checking whether that capability belonged in deep-time-map
instead. It didn't — the two are genuinely different rendering technology —
but that was the right answer by luck, not by process: nobody asked the
question, because there was nowhere written down to ask it.

## The rule

Before building new sphere-geometry or time-axis-widget capability in
`core/`, check deep-time-map's own `docs/adr/0001-scope-versioning-and-
what-belongs-here.md` (in `viewer/vendor/deep-time-map`, or
<https://github.com/siwill22/deep-time-map>). It owns the actual scope
rule, the split-features sub-rule for capability that mixes generic
geometry with Geode-specific data, and the versioning contract this repo
depends on. Duplicating that rule here would let the two drift; this file
is a pointer, not a second copy.

The one rule that's Geode-specific: `viewer/vendor/deep-time-map` pins to a
git **tag**, never a branch tip. `git -C viewer/vendor/deep-time-map
describe --tags` should always resolve cleanly — if it doesn't, the pin is
wrong. Bumping it means reading deep-time-map's `CHANGELOG.md` for what
changed, then running `npm run typecheck` and `npm run check:boundaries`
before committing the new pin.

## Consequences

- New `core/` work involving sphere geometry or a time-axis widget checks
  deep-time-map's ADR-0001 first, rather than reasoning scope from
  scratch.
- The submodule pin is a tag (`v0.1.0` as of this ADR), not a commit SHA
  chosen for any other reason.
