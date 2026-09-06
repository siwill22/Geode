# Time Series is a named-Series-Source concept, not hardcoded to Model+Variable

While scoping a "standalone time slider" capability for the generator, the
first-pass assumption was that Time Series inherently means "aggregate a
Model's Variable across its Frames" — the only computation
`core/timeSeries.ts` performs today, and the only thing `climate/`'s
existing panel wires up. On that assumption, `single-reconstruction-globe`
and `reconstruction-group-globe` would simply never offer it: a
Reconstruction Model has no Variable to aggregate.

That was wrong, caught the same way docs/adr/0017 names: reasoning from
"I can't see how this applies" instead of checking whether the domain
actually forbids it. A Reconstruction Model has its own real, standard
derived time series — RMS plate velocity, total boundary length by type,
net rotation — computed directly from its rotation model and Boundary
Frames, with no Variable involved at all. Treating "the only Series Source
built so far" as if it were a constraint on what Time Series *can mean*
would have quietly foreclosed a real, requested use case.

## The decision

Time Series (see CONTEXT.md) generalizes to a concept a catalog entry
declares support for, naming which **Series Source** computes it:

- **Field Aggregate** (Model + Variable) — implemented today, via
  `core/timeSeries.ts`'s existing `computeTimeSeries()`.
- **Plate Kinematics** (Reconstruction Model — RMS velocity, boundary
  length by type, net rotation) — named and reserved, not designed in
  detail or built in this pass.

A recipe may only request a Time Series from a Series Source its chosen
catalog entry actually declares — the same "derive from the catalog, never
invent" rule `resolveCoastlineSet()` already follows for coastline pairing
(ADR-0004).

## Scope of this pass

Only Field Aggregate ships now, wired into `single-model-globe` and
`model-group-globe` (the two wrapper types where a Model+Variable exists).
Plate Kinematics is a name and a reserved slot, not an implementation:
computing it requires new `prep/`-side work (deriving RMS velocity and
per-type boundary length series from a Reconstruction Model's rotation
files and Boundary Frames), which is real scientific derived-data work, not
UI wiring — out of scope here the same way running the raw `prep/*.py`
pipeline is out of scope for the Skill itself.

## Consequences

- `archive.json` / manifest schema for both Models and Reconstruction
  Models should leave room for a Series Source declaration (which kinds a
  given catalog entry supports), so adding Plate Kinematics later is
  additive, not a breaking migration.
- `generator/validateRecipe.mjs`'s eventual time-series tool check must
  read the catalog entry's own declared Series Sources, never assume every
  Model or Reconstruction Model supports every source — the same shape of
  check `resolveModelGroup()` already does for grid completeness.
- Until Plate Kinematics is built, a `reconstruction-group-globe` /
  `single-reconstruction-globe` recipe simply has no Series Source to
  request one from — not a smaller menu offered on purpose, just nothing
  declared yet.
