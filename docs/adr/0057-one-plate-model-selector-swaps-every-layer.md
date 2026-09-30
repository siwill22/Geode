# In the RiftsClimate deposit viewer, one plate-model selector swaps every layer together

`riftsclimate.html` has a control no other Geode viewer has: a plate-model
selector (Scotese | Merdith 2021). ADR-0034 said the paleobiology viewer must
*not* have one, because a dataset of reconstructed points belongs to exactly one
Reconstruction Model and a second choice would only be a way to draw it wrong.
This viewer looks like it breaks that rule. It does not, and the reason decides
how the selector has to behave.

## Why a selector here

The RiftsClimate deposits were reconstructed **twice** by the analysis itself,
once in each model, and the analysis values depend on which: the climate
values are Scotese (BRIDGE and the other climate models were run on Scotese
geography), the Jackson & MacDonald rift distances are Merdith 2021 (the rift
database carries Merdith 2021 plate IDs), and the defamation distances exist in
both, from two separate defamation runs. So there is no single correct model
for the deposits: there are two correct *sets*, each internally consistent. The
selector chooses a set; it never chooses a model for one layer.

## What the selector swaps, all at once

| layer | Scotese | Merdith 2021 |
|---|---|---|
| deposits | reconstructed on the plates the analysis gave them in Scotese | the same, in Merdith 2021 |
| continents | the archive's Scotese reconstruction | the archive's Merdith 2021 reconstruction |
| deformation | defamation run in Scotese | defamation run in Merdith 2021 |
| climate (BRIDGE) | shown | **not offered** |
| Jackson & MacDonald margins | **not offered** | shown |

A layer with no version in the selected model is hidden, not substituted, and
the caption says why ("BRIDGE climate was run on Scotese geography, so it is
shown only with Scotese"). Drawing BRIDGE rainfall under Merdith coastlines, or
Merdith-frame rift margins over Scotese continents, would put features
hundreds of kilometres from the deposits they are meant to explain, with nothing
on screen to show it — the ADR-0004 failure.

The deposit panel shows every value regardless of the selected model (a
Scotese deposit's Merdith 2021 rift distance is still one of its values), with
the rift values of the model on screen opened first.

## How the deposits are placed

Each deposit is put on the plate the **analysis** assigned it (RiftsClimate's
continent-polygon assignment, exported with its polygon's begin age), not on a
plate Geode assigns afresh from static polygons. Otherwise the map could show a
deposit somewhere other than where its distances and climate were measured.
The page reports, per model, how many deposits can be drawn at their own age
and how many cannot, and why (on no plate; older than its plate's polygon).

## Consequences

- One load, guarded by a token like paleobio's dataset switch, replaces the
  deposits, coastlines, deformation Model, climate Model and margins together.
- The archive's own reconstructions stop at 540 Ma; the deposits reach 1000 Ma.
  The coastline geometry and 0–540 Ma rotations are read from the archive
  unchanged, and only the 540–1000 Ma rotations for the same plates are added
  (under `archive/riftsclimate/`), checked to agree with the archive's table at
  540 Ma so they are known to be the same rotation model.
- The defamation Models live under `archive/riftsclimate/models/`, outside
  `archive.json`'s catalogue: they are run-specific inputs to one project, not
  general Models for other viewers.
- Adding a third plate model means adding an entry to
  `archive/riftsclimate/index.json` with its own layers, not adding per-layer
  model choices.
