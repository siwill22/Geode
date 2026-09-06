# The generator validates data consistency, never "does this combination make sense"

While designing the guided-selection wizard for the viewer generator (see
`docs/plans/consider-this-general-question-virtual-kay.md` and
`generator/`), it came up twice in the same design conversation that a
reconstruction-independent Model (Tomography today — see `CONTEXT.md`'s
Model entry) and a reconstruction-dependent Model (crustal deformation)
might not be combinable on one globe: first reasoned as a coastline/
reconstruction conflict, then — after that was corrected — reasoned again
as a "different rendering machinery" conflict (whole-sphere paint vs.
depth-slice/cutaway). Both were wrong. `core/depthSlice.ts`'s `DepthSlice`
is a single generic primitive already shared by every wrapper that uses
it, painting the sphere at whatever depth it's told (0 km, whole-sphere,
for `globe`/`groupGlobe` today; a real depth for the mantle viewer) — there
is no second, incompatible rendering path a Tomography Model requires that
a deformation Model doesn't also have access to. Nothing in the code
actually forbade the combination; the belief that it should be forbidden
came from treating a Model's own declared properties (reconstruction-
independence) as if they implied a restriction on what it can be shown
alongside, without checking.

## The rule

The generator/wizard enforces exactly the constraints the catalog itself
declares — a reconstruction-dependent Model's own `reconstruction_model`
field (ADR-0004), a `model-group-globe` grid's completeness requirement
(`generator/validateRecipe.mjs`'s `resolveModelGroup()`) — and nothing else.
It never blocks, warns against, or silently narrows a combination because
an engineer (human or LLM) can't personally see a use for it. A
reconstruction-independent Model has no reconstruction-consistency
constraint at all, in either direction: it isn't restricted to one
reconstruction, and it isn't restricted from appearing alongside one.

## Why this needs to be written down

"I can't see why anyone would want that" is not a data constraint, and
reasoning from it produces exactly the failure mode this ADR exists to
name: an artificial rule that *feels* principled (it can even be dressed up
as a plausible-sounding technical reason, as it was here, twice) but isn't
actually derived from anything the catalog or the code requires. The
correct question is always "does the domain model make a specific claim
this combination would violate?", never "can I imagine a use case for
this?" — the second question has no correct answer for a general-purpose
composition tool, and answering it anyway means deciding, on the user's
behalf and without their agreement, what they're allowed to look at
together.

## Consequences

The wizard's grouping logic (still being designed) must derive which
Models can share one globe instance vs. need separate tiled instances
purely from declared axes (`reconstruction_model`, `comparison_role`) and
shared rendering capability (does `core/` actually support painting both
at once), never from a judgment call about sensible combinations. If a
combination is technically impossible (e.g. two Models needing
contradictory uniform state on one shared `DepthSlice` at the same
instant), the failure must be a specific, checkable technical reason
surfaced to the user — not a blanket "that doesn't make sense."
