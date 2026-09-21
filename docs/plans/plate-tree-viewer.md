# Plate Tree viewer — resolved design

Status: **proposed, not built.** Nothing in `viewer/src` or `prep/` implements
this yet. Resolved in a grilling session; ADR-0042, ADR-0043 and ADR-0044 record
the three decisions that needed it, and CONTEXT.md carries the vocabulary.

A new Geode wrapper built around one idea every other viewer here hides: a plate
reconstruction is not a list of plate positions, it is a **hierarchy of relative
rotations**. Every plate's motion is defined relative to another, up to the
anchor. That hierarchy is what `gprm.utils.platetree` computes and what
`GPlatesReconstructionModel.PlateTree` plots. It is invisible on a normal map —
nothing about Africa and South America at 120 Ma tells you that one is being
positioned *through* the other.

## What gprm already does

`gprm/utils/platetree.py` is small and worth reading whole. At one age:

1. `pygplates.reconstruct(static_polygons, rotation_model, t)` → reconstructed
   polygons, and the set of plate ids that actually have geometry at `t`.
2. `rotation_model.get_reconstruction_tree(t)` → every edge as
   (moving plate, fixed plate).
3. `get_plate_chains()` — for each plate with geometry, walk up the tree until
   the fixed plate also has geometry. Usually `[child, parent]`, longer when the
   circuit passes through plate ids carrying no polygon at that age.
4. `get_polygon_centroids()` — one centroid per plate id, from that plate's
   largest polygon at that age.
5. `get_root_static_polygon_plate_ids()` — the plates closest to the anchor that
   do have geometry (the anchor itself usually has none).

`plot_snapshot()` draws a link between the endpoint centroids of each chain, red
for direct and grey for patched, with a marker on each root. `plot_gmt()` is the
same via PyGMT; `write_trees_to_file()` is the same looped over ages, written as
GPML with `valid_time` per frame.

gprm gives us the algorithm, verified, and a reference rendering to match. What
it does not give is any way to *interrogate* the tree: you cannot ask which
plates a given plate depends on, and you cannot see the structure change.

## Measured first

Everything below rests on these, run against the real models in `pygmt17`.

| | Müller 2019 | Seton 2012 | Merdith 2021 |
|---|---|---|---|
| tree edges per age (min–max) | 2520–4704 | 27–692 | 726–1070 |
| plates **with geometry** at 0 Ma | 399 | 274 | 478 |
| chains at 0 Ma | 397 | 273 | 477 |
| patched chains (len > 2) at 0 Ma | 40 | 15 | 29 |
| Locked Links at 0 Ma | 310 / 397 | — | 407 / 477 |
| root plates at 0 Ma | [701] | [701] | [701] |
| root plates at 100 Ma | [701, 901] | [701, 901] | [701] |

Müller 2019 in detail:

- Full chain set for 241 ages: **213 381 int32, 0.81 MB** binary.
- **98 of 397 plates change effective parent**, over **134 events** in 0–240 Ma.
- The reduced tree changes at all at **99 of 241 ages**.
- Hierarchy Depth at 0 Ma: min 2, **max 37**, median 7.
- Node-defining polygon switches **94 times across 55 plates**, jumping up to
  **58.81°** of arc where ordinary motion is 0.23° per Myr.
- Locked Groups: **89** among 399 plates at 0 Ma → **32** at 100 Ma → **16**
  among 232 plates at 200 Ma, the two largest then holding 90 and 85 plates.

Five things fall out.

**The full edge list is the wrong export.** An order of magnitude more data than
the ~400 chains actually drawn, almost all of it plate ids that never carry a
polygon. See ADR-0042.

**The root is not always single.** `[701, 901]` at 100 Ma in two independent
models. Any UI saying "the root plate" is already wrong. Roots are plural in
CONTEXT.md and in every type.

**Depth 37 is the headline.** A plate positioned through 37 composed rotations
is a real property of a published model and nobody reading a normal
reconstruction map can see it.

**Nodes teleport, and that is gprm's definition, not a bug we introduced.** Kept
deliberately — ADR-0043.

**Most links carry no motion at all.** 310 of 397 at 0 Ma are Locked Links.
A Plate Tree drawn without that distinction shows mostly plates that are not
moving relative to anything.

## Resolved

### Home — a new wrapper, `viewer/platetree.html` + `viewer/src/platetree/`

Per the engine-vs-wrapper rule: reusable parts in `core/`, the plate-tree UI in
the wrapper, and not a branch of `reconstruction/`. No numerical Model, no
Variable, no Cutaway, no Vector Field — like `paleobio/`, it deliberately
exposes less than `core/` offers.

Most of what it needs exists: `core/coastlines.ts` (base map),
`core/staticPolygons.ts` (geometry, area, rotation round-trip),
`core/plateNames.ts` (per-model names, ADR-0031; Scotese has none, so the UI
must work on bare ids), `core/rotation.ts`, `core/boundaries.ts`'s 2D-canvas
overlay pattern with `ThreeProjector`/`FlatProjector`, plus
`core/referencePlateControl.ts`, `core/multiInstanceHost.ts`, `core/theme.ts`.

### Anchor — fixed at plate 0, never user-facing

ADR-0001/0004's invariant holds. Re-rooting the tree at another anchor is not a
view transform — it changes which chains exist, which plates are roots and every
Hierarchy Depth — and it would produce a hierarchy that is positionally
equivalent but that nobody wrote, which defeats the point of showing the
hierarchy as published. It would also force one chains export per offered anchor,
or the full edge list we rejected. Measurement makes the cost small: 701 is
already the root below the anchor in all three models.

Distinct from Reference Plate, which stays available and does what it always
does — holds a plate still on screen without touching the tree.

### Data — `platetree/chains.bin`, per Reconstruction Model

Written by `prep/prep_platetree.py`, called from `prep_reconstruction.py`
alongside `export_static_polygons()`, wherever a model has static polygons
(Müller 2019, Seton 2012, Merdith 2021, Scotese). Per age, at the model's own
1 Myr rotation step:

- **chains** — each a list of plate ids, first and last both carrying geometry
- **roots** — plural, plus **each root's own path to the anchor** (without it
  every Plate Circuit stops one plate short; see ADR-0042)
- **node polygon choice** — which polygon defines each plate's Tree Node,
  run-length encoded, since it changes only 94 times across 397 plates
- **Locked Group id** per plate (~0.4 MB); Locked Links are derived as
  "endpoints share an id", so the fact is stored once

Manifest gains `plate_tree` and `has_plate_tree`, following the optional-asset
convention `static_polygons` and `boundaries` already use.

Node *positions* are not exported. The client rotates the chosen ring to the
exact continuous Reconstruction Age and takes its boundary centroid, so nodes
move smoothly between exported ages while the *choice* stays discrete — the two
halves of a Tree Node, kept apart (ADR-0043). This needs a
`polygonBoundaryCentroid()` in `core/staticPolygons.ts` alongside the existing
vertex-mean `polygonCentroid()`, since pygplates' is arc-length weighted and the
two differ on unevenly-spaced rings.

### Locked Groups — membership from `defamation`, procedure changed

The membership test is `get_plate_motion_groups`' (sibling `defamation`
pipeline, where the same groups generate deformation zones): identity first,
then optionally a threshold expressed as maximum relative surface velocity.
Default identity-only.

The procedure is Geode's own, for reasons ADR-0044 records: group by equality of
each plate's anchor-relative rotation, via a sort-by-angle sweep that unions
every pair within an epsilon window. Canonical, order-independent, validated
against exhaustive all-pairs at every age tested, ~400 rotation queries per age
instead of up to 35 000.

Windows are clamped at the range ends. A forward step at `age_max` reads past
the model, where rotations flatten and everything appears locked — it reported a
spurious 150-plate group where a backward step reports 78.

### v1 — four things, two surfaces

1. **Map with Tree Links.** Great-circle arcs between endpoint centroids (gprm
   draws straight lon/lat lines, which are wrong on a sphere and visibly so for
   a long link; `create_hierarchy_features` has `to_tessellated` for exactly
   this). Patched Links distinguished, as gprm does. **Locked Links drawn as
   faint hairlines**, so the ~89 links that represent real relative motion stop
   being lost among the 310 that do not. Everything claims a Theme Role
   (ADR-0040) — the tree is furniture, not data.
2. **Nodes coloured by Locked Group.** Essentially `group_features_by_motion(
   plot=True)` on a globe, scrubbable: 89 colours speckled at 0 Ma coalescing to
   16 at 200 Ma, two of which hold 90 and 85 plates. Pangea on the map, needing
   no geometry beyond the node marks.
3. **Circuit panel.** Click the globe → `assignPlate()` (already built,
   ADR-0025) gives the plate under the cursor; its Plate Circuit is listed in
   order with names where the model has them (`801 → 802 → 701 → 0`), patched
   hops marked, and every link on the path highlighted. The question working
   plate modellers currently answer by reading rotation files by hand.
4. **Multi-Globe**, per ADR-0017/0022, following `reconstructionGroup/`'s shape
   so each instance can hold a different Reconstruction Model. The sharpest use
   of it in the project: the same continents reach the anchor through very
   different circuits in Müller 2019 and Seton 2012. Reconstruction Age is a
   Synced Field; the model is not — that is the comparison.

### Correctness — against gprm, not against the screen

`viewer/scripts/check_platetree.mjs` (house pattern) loads `chains.bin` and
compares chains, roots, root paths and polygon choices against
`gprm.utils.platetree.tree_snapshot()` run live at a sample of ages, and node
positions against `get_polygon_centroids()` to a tolerance. Node parity is only
checkable *because* the defining polygon is exported rather than re-chosen in
the browser.

## v2 — the Sankey

Locked Groups merging and splitting through time, as an alluvial diagram. This
is supercontinent assembly and dispersal read straight out of a rotation file,
and it is the reason the group id ships in v1's export rather than waiting: the
flows are set intersections between consecutive ages, needing nothing further
from prep.

It also connects two projects. The same groups are what generate deformation
zones in `defamation`, so a Sankey flow splitting is the moment a deformation
zone opens between the two halves.

## Where the code lands

| Path | New? | What |
|---|---|---|
| `prep/prep_platetree.py` | new | chains, roots + root paths, node choices, group ids → `platetree/chains.bin` |
| `prep/prep_reconstruction.py` | edit | call it; `plate_tree` / `has_plate_tree` |
| `viewer/src/core/plateTree.ts` | new | parse `chains.bin`; chain/node/group model; canvas overlay via Three/Flat projector |
| `viewer/src/core/staticPolygons.ts` | edit | `polygonBoundaryCentroid()`; largest-valid-polygon helper |
| `viewer/src/core/types.ts` | edit | `PlateChainSet`, manifest fields |
| `viewer/src/platetree/{main,plateTreeInstance,plateTreeUi}.ts` | new | the wrapper |
| `viewer/platetree.html`, `viewer/vite.config.ts` | new/edit | entry |
| `viewer/scripts/check_platetree.mjs` | new | export vs. live gprm |

## Deferred

- **Dendrogram.** Would show depth 37 far better than a map can, and needs no
  new WebGL. Low priority — the circuit panel answers most of the same question.
- **Depth as polygon fill.** Dropped from v1: it is the largest new render task
  (nothing triangulates static-polygon rings today) and reads depth worse than
  either the circuit panel or a dendrogram would.
- **Reorganisation strip.** Ticks under the age slider at the 99 ages where the
  tree changes, filtering to a selected plate's own 134 parent-change events.
  Diagnostic value — a parent change is where computed velocity can step, and
  where rotation-file crossovers live. Derivable in the browser from data v1
  already ships, so this needs no export change whenever it lands.
- **Dynamic (resolved-topology) polygons.** gprm's `write_trees_to_file()` takes
  `polygon_type='topological'` and `PlateTree` carries a `#TODO`. Static only for
  v1 — the line ADR-0025 already drew, for the same reasons.
- **The velocity threshold as a UI control.** Ported and documented, defaults to
  zero. Exposing it turns Locked Groups from a partition into the output of a
  procedure (ADR-0044), so any control offering it has to say so.

## Still open

- **Whether the anchor should be drawn at all.** It has no geometry and so no
  position; gprm never draws it. A circuit panel ending `→ 0` with no
  corresponding mark may read as a broken link.
- **Scotese's range.** 0–540 Ma at 1 Myr is 541 ages, the largest export here,
  and it has no plate names — worth measuring before assuming the format scales
  unchanged.

## Measurement scripts

Five probes produced every number above and should move into `prep/` as
`check_platetree_sizes.py` if this is built, since the export format rests on
them: edge/chain/root counts per model and age; chain byte totals and
parent-change events; circuit completeness against the raw reconstruction tree;
node-jump distribution; Locked Group counts with tolerance sensitivity and a
sweep-vs-all-pairs validation.

Run under `conda run -n pygmt17` against
`gprm.datasets.Reconstructions.fetch_<model>()` — never hand-picked file paths
(ADR-0021).
