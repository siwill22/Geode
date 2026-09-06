# Reconstruction Models get their own catalog section, one directory each, from one fetch call

ADR-0020 scoped a reconstruction-comparison wrapper assuming only one more
entry (Müller 2019) needed to squeeze into the existing ad hoc coastline
buckets (`coastlines`, `scotese_coastlines`, `native_coastlines`,
`boundaries`). That assumption doesn't hold: `gprm.datasets.Reconstructions`
already exposes over a dozen fetchable reconstructions (`fetch_Cao2024`,
`fetch_Merdith2021`, `fetch_Muller2016/2019/2022`, `fetch_Scotese`,
`fetch_Seton2012`, `fetch_TorsvikCocks2017`, and others), and the whole
point of the new wrapper is to let a user pick *any* of them as a
comparison option — "lots of potential reconstruction models," not two.
Four differently-shaped top-level buckets do not scale to that; this ADR
replaces ADR-0020's storage plan (its Consequences section) with a real,
scalable design, narrowing what was previously a breaking change into a
purely additive one.

## What "coherent, cannot be mixed" actually means

Each `gprm.fetch_X()` call returns one `ReconstructionModel` object
bundling a rotation model with whichever of coastlines/continent-polygons
and static/dynamic polygons that reconstruction actually has — confirmed
directly: `fetch_Scotese()` returns `coastlines_files: []` but populated
`continent_polygons_files` (see ADR-0019), while the Müller-family models
populate `coastlines_files` instead. The two present-day geometry kinds are
not interchangeable across reconstructions, and neither are rotation files
(ADR-0004's whole reason for existing). Today's prep step
(`prep_coastlines.py`) takes `--rotations`/`--coastlines` as independent
CLI file paths a human locates by hand from a `gprm` cache directory — nothing
stops those paths coming from two different `fetch_X()` calls by mistake.

## The rule

**Storage**: each Reconstruction Model gets its own directory and its own
`manifest.json`, exactly mirroring how numerical Models already work:

```
archive/reconstructions/<recon-id>/
  manifest.json   -- id, name, citation, age_min, age_max,
                      source_fetch (e.g. "fetch_Muller2019"),
                      has_boundaries (see ADR-0019)
  coastlines/{geometry.bin, rotations.json}
  boundaries/{boundaries.json, frames/*.geojson}   -- present only if has_boundaries
```

`archive.json` gets one new top-level array, `reconstruction_models`,
shaped exactly like the existing `models[]` array (`id`, `name`, `source`,
`path` to that reconstruction's own manifest, plus `has_boundaries`
mirrored up so a consumer can filter without a second fetch — the same
reason `reconstruction_model`/`comparison_role` are already mirrored onto
`models[]` entries, see `viewer/src/core/types.ts`). This is the
first-class catalog entity `CONTEXT.md`'s `Reconstruction Model` entry has
flagged as missing since it was written.

**Non-breaking, unlike ADR-0020's plan**: nothing about the existing
`coastlines` / `scotese_coastlines` / `native_coastlines` / `boundaries`
buckets changes, and none of the four existing viewers' coastline-
resolution call sites need to change at all — `archive.boundaries` stays
exactly the single bare Müller-2022 string it already is, read by
`tomography/main.ts` exactly as today. Already-exported reconstructions
(Müller 2022, Scotese, Cao2024, Müller 2019's existing coastline-only
export) get a `reconstruction_models[]` entry whose `manifest.json` points
at their *existing* files in place — no re-export, no data movement, purely
a new index layered on top. Only newly-exported reconstructions (Müller
2019's boundary topology, and any future addition from the `gprm` list)
land directly in the new per-directory layout.

**Prep tooling derives every asset from one fetch call.** Exporting a
Reconstruction Model takes a model name, calls the matching
`gprm.datasets.Reconstructions.fetch_X()` once, and derives rotation model,
present-day geometry (coastlines if populated, else continent_polygons —
an explicit, scripted fallback, never a human's choice of file), and
topology (present only if `dynamic_polygons` is non-empty) from that single
object. This makes the "coherent, cannot be mixed" property structural —
impossible to accidentally pair one reconstruction's rotations with
another's geometry — rather than a discipline every future invocation has
to individually remember, and it makes exporting any of the dozen-plus
`gprm`-backed reconstructions a uniform operation instead of bespoke
per-model scripting.

## Consequences

Supersedes ADR-0020's Consequences section entirely (that section's plan
to turn `archive.boundaries` into a keyed map is no longer needed — the new
`reconstruction_models[]` index replaces that role). ADR-0020's other
decisions stand unchanged: pure geometry, one axis, new wrapper pair, own
tool vocabulary.

Not built in this pass — this is storage/schema design only. Real
follow-up work: the new prep script (extending or replacing
`prep_coastlines.py`'s CLI), `reconstruction_models[]` entries for the
already-exported reconstructions (pointing at existing files), a fresh
Müller 2019 export including boundaries into the new layout, and
`viewer/src/core/types.ts`'s `ArchiveIndex` gaining the new array's type.
