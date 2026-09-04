# A pipeline run's coastlines use that run's own rotation model, not a shared archive entry

The crustal deformation viewer (`docs/plans/deformation-viewer.md`) draws
reconstructed coastlines behind reconstructed deformation data. Geode already
has a Müller 2019 v2 coastline entry in the archive — but paired, on purpose,
with Müller **2022**'s `MantleOpt` rotations, because the mantle viewer's
OPT1 convection run was computed on the 2022 model (see "One rotation model,
everywhere" in the README). The `defamation` pipeline's own Muller2019 run
calls `gprm`'s `Reconstructions.fetch_Muller2019()`, which builds its
rotation model from `Global_250-0Ma_Rotations_2019_v2.rot` — the native 2019
file, not 2022's.

Reusing the existing archive entry here would silently put every deformation
zone under continents rotated by up to ~6° (~700 km at the equator, 200 Ma)
from where the pipeline itself placed them when it computed the data — the
same class of error the mantle viewer's own coastline choice was made to
avoid, just inverted: there, the volume dictated the rotation and coastlines
had to follow; here, the deformation data's own rotation is the correct one
and the existing archive entry is now the wrong one to reach for.

## Considered Options

**Reuse the existing Müller 2019 archive entry.** Zero new prep work, but
wrong: it was built to match OPT1's 2022 mantle frame, not this pipeline
run's native 2019 one. Rejected — it would pass every existing check (same
geometry file, plausible age range) while being geometrically wrong in a way
nothing currently in `check:mask` or `check:boundaries` would catch, because
both check topology/point-in-polygon logic, not absolute rotation agreement
against a *different* run's reference.

**Export a second, run-specific coastline set via `prep_coastlines.py`,
pointed at the rotation file the run's own config actually resolves to.**
Same geometry file (`Global_coastlines_2019_v1_low_res.shp`), different
rotations, so this is a rotations-only re-export, not a new geometry source
or a new code path in `prep_coastlines.py` itself — one more invocation with
different `--rotations`, the same pattern already used to produce the
Scotese coastline set for the climate viewer.

## Consequences

**The rule generalizes beyond this one run.** Any future `defamation` run —
Cao2024, TorsvikCocks2017, a Basin & Range benchmark — gets its own
`prep_coastlines.py` invocation naming that run's own fetch model, not a
lookup into whichever coastline entry happens to already exist in the
archive. "Which coastlines does this viewer use" is answered per Model, from
the model's own provenance, never by geometry-file name alone — two entries
can share a `.shp` file and still need different rotations.

**The existing Müller 2019/2022 archive entry is untouched.** This adds a
new, differently-named coastline export (e.g. `muller2019-native`); it does
not modify or replace the mantle viewer's own coastlines, which remain
correctly paired with OPT1.

**A future cross-check should exist but does not yet.** The plan calls for
verifying one sample point's reconstructed position against pygplates using
the 2019-native `.rot` file directly, the same discipline `check:mask` uses
for the cutaway polygon — this catches "the right rotation file was used"
rather than merely "a rotation file was used." Not yet implemented as an
automated check.
