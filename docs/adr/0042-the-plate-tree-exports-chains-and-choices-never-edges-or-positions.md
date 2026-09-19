# The Plate Tree exports chains and choices, never edges or positions

Grilling `docs/plans/plate-tree-viewer.md` before any of it was built. A Plate
Tree is derived from a Reconstruction Model's rotation hierarchy by
`gprm.utils.platetree`, and there are several defensible places to cut between
what prep computes and what the browser does. This ADR picks the cut.

## The decision

**Export chains, not the reconstruction tree's edges.** Measured per age over
0–240 Ma: Müller 2019's full tree carries 2520–4704 edges, Seton 2012 carries
27–692, Merdith 2021 carries 726–1070. The overwhelming majority are plate ids
that carry no polygon at that age and therefore have no position to draw. The
reduced chain set — what `get_plate_chains()` returns, which is what the viewer
actually renders — is 397/273/477 entries at 0 Ma respectively, and the whole
241-age chain export for Müller 2019 measures **213 381 int32, 0.81 MB**. The
raw edge list would be roughly 4 MB for the same model to deliver a strictly
smaller rendered result.

**Export each Root Plate's own path to the anchor alongside the roots.** This
was nearly missed. The plan asserted that concatenating chains recovers a full
Plate Circuit; checked directly at 100 Ma, it recovers every intermediate plate
id correctly but stops one hop short every time — `801 → 802 → 701` where the
truth is `801 → 802 → 701 → 0`, and `901` where the truth is `901 → 0`. The
cause is structural, not a sampling artefact: `patch_links_between_polygon()`
returns `None` when it reaches the anchor without finding geometry, so a Root
Plate has no chain at all. Without the root's own path the circuit panel silently
under-reports every plate in the model by one plate.

**Export which polygon defines each Tree Node, not where that node is.** A node
is the boundary centroid of the plate's largest polygon (see ADR-0043 for why
that definition and not a better-behaved one). Which polygon is largest changes
only 94 times across 397 plates over 241 ages, so run-length encoding the choice
costs about a thousand entries — a few KB. The client then rotates that one
ring to the exact Reconstruction Age and takes its centroid.

Rejected: exporting node lon/lat per age (~770 kB). Not primarily on size — it
would pin node positions to the 1 Myr export grid, so nodes would jog between
exported ages while the coastlines beneath them moved smoothly, reproducing the
Frame-Index-versus-Reconstruction-Age confusion CONTEXT.md exists to keep apart.
Exporting the *choice* rather than the *position* keeps the discrete thing
discrete and the continuous thing continuous.

Rejected: computing the choice in the browser too, as the plan originally
proposed. Parity with gprm is the entire correctness story here, and the choice
is a tie-break among near-equal areas — 94 observed flips means ties are real,
and a float32 ring in JS could break one the other way from pygplates' float64.
Exporting the choice makes parity a fact rather than a hope; exporting the
position would have made it a fact at the cost above.

**Export one Locked Group id per plate per age (~0.4 MB), and derive Locked
Links from it.** A Tree Link is locked exactly when its two endpoints share a
group id — identical by transitivity, see ADR-0044 — so a separate per-link
locked bit would be the same fact stored twice, with the usual consequence that
a later prep change lets the two drift apart.

## Consequences

- `prep_reconstruction.py` gains a `prep_platetree.py` step writing
  `platetree/chains.bin` wherever a Reconstruction Model has static polygons
  (Müller 2019, Seton 2012, Merdith 2021, Scotese). Manifest gains
  `plate_tree` and `has_plate_tree`, following the optional-asset convention
  `static_polygons` and `boundaries` already use.
- The export step matches each model's own rotation sampling (1 Myr) so tree
  ages and rotation ages coincide exactly and no interpolation question arises
  for the discrete half of a Tree Node.
- The client needs `staticpolygons/geometry.bin` and `coastlines/rotations.json`
  loaded to draw a Plate Tree at all. Both are already fetched by existing
  consumers; nothing new is downloaded for the node positions.
- A check script compares the exported chains, roots, root paths and polygon
  choices against `gprm.utils.platetree.tree_snapshot()` run live. Because the
  choice is exported rather than recomputed, node positions are checkable
  against `get_polygon_centroids()` to a tolerance rather than being
  structurally unverifiable.
