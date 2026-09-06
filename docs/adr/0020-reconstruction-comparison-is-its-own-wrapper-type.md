# Reconstruction comparison is its own wrapper type, not a variant of model-group-globe

A real request surfaced that neither existing wrapper type can serve:
compare two Reconstruction Models' own geometry directly — e.g. Müller
2019's continent polygons and resolved topologies against Scotese's
continent polygons alone (see ADR-0019: Scotese structurally has no
topology to compare) — with no numerical Model, no painted Variable,
involved at all. `model-group-globe`'s grid (`resolveModelGroup()` in
`generator/validateRecipe.mjs`) is built entirely around a numerical
Model's own declared axes (`reconstruction_model`, `comparison_role`) and
assumes every grid cell has a manifest with `variables`/`frames` to
validate against — there is no cell to put in that grid when the thing
being compared has no manifest at all.

Two considered shapes:

**Extend `model-group-globe` with a "bare reconstruction" grid entry** that
carries a Reconstruction Model id and no Variable. Rejected: it blurs
`CONTEXT.md`'s own definition of Model ("a Model is never itself a
Reconstruction Model") by letting one masquerade as a zero-variable Model,
and it would need `resolveModelGroup()`'s variable-vocabulary-agreement
check (every reconstruction in a role must expose the same Variables) to
special-case an entry that has none — a special case for the common path,
not the new one.

**A new, separate wrapper pair**: `single-reconstruction-globe` and
`reconstruction-group-globe`, paralleling the existing
`single-model-globe`/`model-group-globe` split but comparing Reconstruction
Models directly. Chosen.

## The rule

`single-reconstruction-globe` / `reconstruction-group-globe` show ONLY
reconstruction geometry — coastlines, and Boundary Frames where available
(ADR-0019) — never a painted numerical field, on principle, not as a
temporary limitation: adding one would reopen the arbitrary-mix question
ADR-0017 already deferred, and this wrapper pair exists specifically to be
the clean, separate case instead. The comparison is along exactly ONE axis
(which Reconstruction Model) — there is no second axis analogous to
`comparison_role` here, so `reconstruction-group-globe`'s grid is a flat
list switched by one dropdown, not a 2-D grid. Do not build N-axis
generality this doesn't need.

Because there is no Variable, the existing fixed four-tool menu (`legend`,
`age-slider`, `no-data-toggle`, `query-point`) mostly does not apply:
`legend` and `no-data-toggle` describe a painted field that doesn't exist
here, and `query-point` reads Variable values at a clicked point, which
also doesn't exist here. Only `age-slider` survives unchanged (it already
means Reconstruction Age, which still drives coastline/Boundary Frame
scrubbing with no Model loaded — see `CONTEXT.md`'s Reconstruction Age
entry, which already states this holds "even when the loaded Model is a
static Tomography Model"; the same is true with no Model loaded at all).
This wrapper pair needs its own, smaller tool vocabulary — at minimum a
boundary-visibility toggle, offered only when the selected Reconstruction
Model actually has Boundary Frames (ADR-0019) — designed and named when the
wrapper is actually built, not assumed to be the existing four minus some.

## Consequences

**Catalog schema stays additive, not migrated.** `archive.json`'s existing
`coastlines` / `scotese_coastlines` / `native_coastlines` buckets are left
exactly as they are — none of the four existing viewers' coastline-
resolution call sites change. Two additive changes are needed:

1. `boundaries` (today a single bare string, Müller 2022 only) becomes
   keyed by Reconstruction Model id, the same shape `native_coastlines`
   already uses (e.g. `{ muller2022: "...", muller2019: "..." }`). This is
   a narrow breaking change with exactly one existing call site
   (`tomography/main.ts`'s read of `archive.boundaries`), not a wider
   migration.
2. A new, purely additive `reconstruction_models` metadata section is
   added — one entry per Reconstruction Model (`id`, display `name`,
   citation, age range, a pointer to which existing coastline bucket/key
   holds its geometry, and a nullable pointer to its `boundaries` entry).
   This is the first-class catalog entity `CONTEXT.md`'s own
   `Reconstruction Model` entry already flagged as missing — but arrived
   at as new metadata pointing at the existing buckets, not by replacing
   them. Nothing existing reads this section yet; only the new wrapper
   pair and its generator/validator support (not built in this pass) will.

**Not built in this pass.** This ADR and ADR-0019 record the scoping
decisions only. The wrapper pair's `Instance`/`UI`/`main.ts` triad, the
`reconstruction_models` catalog section, the Müller 2019 boundary export,
and `generator/recipeTypes.ts`/`validateRecipe.mjs`/`SKILL.md` support for
the new wrapper types are all real follow-up work, not done here.

**Amended by ADR-0021**: the schema plan above (turning `archive.boundaries`
into a keyed map) assumed only one more Reconstruction Model needed to fit
into the existing ad hoc buckets. Realizing there are a dozen-plus
potential Reconstruction Models (`gprm.datasets.Reconstructions`), not two,
made that not scale — ADR-0021 replaces it with a real per-Reconstruction-
Model catalog section, entirely additive, requiring no change to any
existing bucket or call site. This ADR's other decisions (pure geometry,
one axis, separate wrapper pair, own tool vocabulary) are unaffected.
