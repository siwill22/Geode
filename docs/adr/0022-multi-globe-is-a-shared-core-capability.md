# Multi-Globe becomes a shared core/ capability, not a third hand-rolled copy

`tomography/main.ts` and `climate/main.ts` each independently implement
Multi-Globe: an `instances[]` array, `createInstance`/`addInstance`/
`removeInstance`, a `focusedInstance`, `lastEdit` tracking per Synced Field,
and a `broadcastX(source)` function per field — duplicated near-verbatim
(the two files' own comments cross-reference each other's identical
reasoning) around one thing they DO already share, `core/layout.ts`'s
`tileGrid()`. None of the generator's four wrapper types
(`single-model-globe`, `model-group-globe`, `single-reconstruction-globe`,
`reconstruction-group-globe`) support Multi-Globe at all, and their
`Instance` classes lack the hooks the pattern needs (`applyLayout`,
`onFocus`, `onRemove`, `onAgeChange` — they only have `boot`/`dispose`
today).

## The decision

Extract the duplicated orchestration into a real `core/` abstraction —
generic over which Synced Fields exist and over the wrapper's own Instance
type — refactor `tomography/main.ts` and `climate/main.ts` onto it
(behaviour unchanged), and give all four generator wrapper types the same
small hook interface so `scaffoldRepo.mjs` can offer Multi-Globe honestly.
The alternative (a separate, simpler implementation scoped only to the
generator) was rejected: it would have made this a *third* independent copy
of the same pattern, in the one part of the codebase (`generator/`) most
exposed to being read and extended by future requests.

Multi-Globe is kept as its own recipe-level setting, not a fifth entry in
`ui.tools` (`GlobeTool`) — it changes how many globe instances exist and
which fields broadcast between them, which is a different kind of thing
from a checkbox on one globe's own panel (legend, age-slider, no-data-
toggle, query-point all describe ONE instance's display).

Per docs/adr/0017, no wrapper type is excluded from Multi-Globe on grounds
of "can't see why anyone would compare two of these side by side" — the
only per-Model constraint that survives is compatibility already declared
by the catalog (e.g. a synced age still has to mean something for each
instance's own Model, which it always does — Reconstruction Age is
meaningful for every Model per CONTEXT.md).

## Consequences

- Every wrapper type's `Instance` class needs `applyLayout()` (new for the
  four generator types; already exists for `GlobeInstance`/
  `ClimateInstance`) and constructor-injected `onFocus`/`onRemove`/
  `onAgeChange` hooks, matching the shape `tomography/main.ts` and
  `climate/main.ts` already use.
- Age is the only Synced Field the generator exposes in this first pass —
  depth-slice and month aren't in the fixed `GlobeTool` vocabulary at all,
  so there's nothing else to broadcast yet. The `core/` host is generic
  enough that a future Synced Field just needs its own `broadcastX`
  registered, not a new orchestration layer.
- `tomography/main.ts` and `climate/main.ts` get refactored as part of this
  work, not left as-is beside a new parallel implementation — their
  existing behaviour (verified by `scripts/shoot.mjs`'s multi-globe-sync
  checks) is the regression bar.
