# A Theme assigns colours to roles, not to elements — and PALETTE is deleted to force it

`core/` holds nine drawable layers — `aggregateOverlay`, `boundaries`,
`coastlines`, `pointOverlay`, `queryPoint`, `trackedParticles`, `windGlyphs`,
`windStreaks`, and the volume surface itself. **Exactly one of them
(`coastlines.ts`) reads `PALETTE`.** The rest either hardcode a literal or
inherit from the vendored library.

That ratio is the whole argument. `CONTEXT.md` already names drawable things
that are designed but not built — Virtual Geomagnetic Poles, Occurrences,
Orogen Candidates, Aggregation Cells — so a Theme defined as a flat record of
today's colours (`background, ocean, land, coastline, subduction, ridge,
transform, other, velocity, calm, fast`) would be stale on arrival, and adding
a slot would mean hand-editing every Theme.

**Decision: a Theme assigns one colour per *role*. An element claims a role and
never names a colour.** A new overlay picks an existing role and inherits every
Theme for free.

## The roles are named for visual character, not domain meaning

The accents are `accentHot`, `accentWarm`, `accentBright`, `accentMuted`,
`accentCool`, over a substrate of `page`, `water`, `land`, `outline`.
`deep-time-map` maps its own boundary types onto them inside its style resolver
— subduction→warm, ridge→hot, transform→bright, other→muted, velocity→cool — so
the four boundary types keep their individual identity without each becoming a
role that every Theme must fill.

Two alternatives were rejected. **Domain-named roles** (`boundarySubduction`,
`boundaryRidge`, …) are honest about those types having real identity, but they
are flat slots wearing a role costume: a Geode overlay like a VGP glyph has no
role to claim without adding one to every Theme, which is the problem this ADR
exists to solve. **Indexed roles** (`accent1..accent5`) give a Theme author the
most freedom, but nothing then stops ridge and transform swapping visual
character between two Themes, so the map's emphasis would silently reshuffle on
a Theme change.

Character names survive a light Theme because character is relative: what is
"hot" on parchment is a deep vermillion, not the same hex as on navy.

## Two speed ramps, not one

`rampFlow` and `rampTrack` are separate role pairs. This is not redundancy:
`TrackedParticles` and `windStreaks` are both live in the Valdes and climate
instances and **can be on screen simultaneously** — a user drops tracked
particles onto a streaming wind field. Their current blue/green split
(`windStreaks.ts` `#1f5c7a`→`#eaffff`, `trackedParticles.ts` `#2ea043`→`#e6ffe9`)
looks like two modules that never talked to each other, and partly is, but the
distinguishability it produces is load-bearing and a Theme must preserve it.

## Enforcement: delete `PALETTE`, and allowlist the exceptions

Convention alone produced the current state, and a type-level requirement alone
would not have stopped it — `windStreaks` and `trackedParticles` would each have
happily accepted a theme and then hardcoded one extra ramp anyway. So:

- **`PALETTE` stops existing.** There is nothing left to import; an element
  receives resolved role colours or it renders nothing.
- **A test greps `core/` render paths for colour literals against a small
  allowlist**, each entry carrying a one-line reason — tomography's core brown
  (deliberately outside the surface palette, see ADR-0038), the no-data grey,
  the UI chrome CSS. New hardcoding fails CI; a deliberate exception is a
  reviewed one-line diff.

The allowlist is the useful half. It turns "this element should *not* be themed"
from a comment in `palette.ts` into a fact something checks.
