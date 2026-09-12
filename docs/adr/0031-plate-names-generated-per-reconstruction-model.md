# Plate Names Are Generated Per Reconstruction Model, Not Hand-Curated

Supersedes the plate-name half of ADR-0030's "Consequences" section, which
chose a hand-curated, client-side, model-independent id → name table for
the Reference Plate autocomplete. That table was, in practice, invented
from unverified recollection of "typical" GPlates plate-id numbering (one
entry, Antarctica = 301, was simply wrong — see
`docs/plans/reference-plate.md`'s correction) and could never be correct
for more than one Reconstruction Model at a time regardless of how
carefully it was curated, since a plate id's meaning is model-specific.

Checked directly against gprm's actual source files for each Reconstruction
Model already in the archive: Müller 2019 and Seton 2012's static-polygon
shapefiles both carry a genuine `NAME` attribute (verified empirically:
801 → "Australia", 802 → "Antarctica"/"East Antarctica", 701 → "Africa").
Scotese's does not — confirmed empirically too (0 of 240 features named).
So a real, non-invented name table is only sometimes derivable, and only
from a specific model's own source data — never from a shared, generic
convention.

**Decision:** generate `plate_names.json` at prep time
(`prep_plate_names.py`), from the SAME static-polygon source feature
collection each model's `staticpolygons/geometry.bin` already comes from
(see `prep_staticpolygons.py`). A plate id typically owns several named
features at different scales (a whole continent plus cratons/fragments);
the canonical name is the name of the LARGEST-area feature assigned to
that id — the same "largest polygon wins" tie-break `assignPlate()`
already uses for an analogous problem (ADR-0025), not a new invented rule.
A model whose source data has no name attribute at all (Scotese) simply
gets no `plate_names.json` and `has_plate_names: false` in its manifest —
mirrored up to `ArchiveIndex.reconstruction_models[]` the same way
`has_boundaries`/`has_static_polygons` already are.

Client-side, `core/plateNames.ts`'s hand-curated `PLATE_NAMES` constant is
replaced by `fetchPlateNames()`, fetched alongside a Reconstruction
Model's static-polygon data (`StaticPolygonData.plateNames`) and passed
through to the Reference Plate autocomplete. A model with no name data —
Scotese, the one backing the climate viewer today — genuinely offers no
name-based autocomplete at all; only bare numeric plate-id entry works
there, which the UI now signals via its placeholder text rather than
silently degrading.

## Consequences

- The climate viewer's Reference Plate control loses name-based
  autocomplete entirely (Scotese has no name data) — a real behavior
  change from the hand-curated table it briefly had, but the honest one.
- Extending name coverage to a new Reconstruction Model requires re-running
  `prep_reconstruction.py` (which now also runs `prep_plate_names.py`), not
  editing a client-side table.
- The "largest feature wins" name can be a qualified variant (e.g. "East
  Antarctica", "North America Craton") rather than the plainest continent
  name — acceptable since autocomplete matching is substring-based, so a
  user typing "Antarctica" or "North America" still finds it.
