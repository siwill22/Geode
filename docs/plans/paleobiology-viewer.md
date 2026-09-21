# Paleobiology viewer — resolved design

Status: **built**. See `viewer/paleobio.html`, `viewer/src/paleobio/`, `viewer/src/core/aggregateOverlay.ts`, `prep/prep_pbdb.py`, and
deep-time-map v0.5.0. ADR-0034 and ADR-0035 record the two decisions that needed it.

Everything below is the resolved design; the **Built** section at the end records where it
changed on contact with the data.

A new Geode wrapper for fossil-occurrence data through geological time, built
around two case studies:

1. **Corals through the Phanerozoic** — latitudinal distribution, diversity, and
   turnover in dominant taxa across mass extinctions.
2. **Biotic interchange** — a dispersal/vicariance event where the plate
   reconstruction itself is the explanation. Candidate not yet chosen.

## Resolved

### Home — a new Geode wrapper, deliberately narrow

`viewer/paleobio.html` + `viewer/src/paleobio/`, reusing `core/` (per the
engine-vs-wrapper rule) rather than branching an existing viewer.

It does **not** inherit core's full toolset by default. Variable selectors,
Vector Field, Cutaway, the month slider and the rest stay out unless a fossil
question needs them. This is a deliberate choice, not an omission — ADR
candidate, because "the wrapper exposes less than core offers" is exactly the
kind of thing a future reader would otherwise try to 'fix'.

### Mark — two views on a toggle

- **Aggregate glyph per equal-area cell** (default). Occurrences binned on the
  sphere, one glyph per occupied cell: pie by Grouping and/or sized by richness.
  Equal-area is load-bearing, not incidental: a lon/lat grid inflates polar
  cells, which would bias the latitudinal-diversity reading the coral case study
  exists to produce. (Built as an equal-area ring grid rather than HEALPix —
  see **Built** below.)
  Binning is computed in **paleo** coordinates per time step, at prep time.
- **Individual occurrence symbols** (on demand). What `PointLayer` ships today:
  ~3.4 px abstract symbols, `lifespan: 'range'` driven by each occurrence's own
  age interval. Answers "is that aggregate pattern real, or three sites in
  Belgium".

Pictorial per-genus artwork per occurrence was rejected on mechanical grounds:
`points.js` supports seven abstract symbols at ~3.4 px, and a recognisable
pictorial glyph needs ~12–20 px, which at global extent overlaps into mush.
Pictorial glyphs remain viable at the **aggregate-cell** scale.

### Grouping — several declared, one active

A dataset declares 2–3 named categorical partitions of its occurrences, each
with its own curated palette; the viewer shows exactly one at a time from a
dropdown. Forced by aggregation: a pie needs a bounded category set (≤6), which
rules out a runtime taxonomic-rank switcher over an unbounded, unstable set.

Maps onto deep-time-map's existing `points[].type` + `categories` with no
upstream change. Same shape as ADR-0014's Vector Field selector — several
declared, exactly one shown, never overlaid.

The Grouping is **not necessarily taxonomic**: corals want subclass
(Rugosa / Tabulata / Scleractinia), the interchange case wants continent of
origin, which cuts across taxonomy entirely.

### Reconstruction Model — Scotese, full Phanerozoic

Scotese 2008 (0–540 Ma) is the **only** cataloged Reconstruction Model reaching
the Paleozoic; Müller 2019 stops at 240 Ma and Seton 2012 at 200 Ma (measured
from `archive/reconstructions/*/manifest.json`). Three of the four mass
extinctions the coral story needs are older than 240 Ma, so the choice is
forced. Costs, accepted: no Boundary Frames (structurally impossible for
Scotese per ADR-0019) and no plate names (ADR-0031). Neither adds much to a
coral map — palaeolatitude and shelf extent are what matter — and Scotese is
already what `climate.html` and the Boucot paleolithology layer use, so the
base rasters line up.

### Data source — PBDB, paleocoordinates recomputed locally

Measured against the live API (`paleobiodb.org/data1.2`):

| | occurrences |
|---|---:|
| Anthozoa (all) | 45,602 |
| Scleractinia | 21,714 |
| Rugosa | 13,516 |
| Tabulata | 9,236 |
| Octocorallia | 261 |

`gprm.datasets` has no fossil module, so PBDB is the source. Each occurrence
carries `lng`/`lat` (present-day), `eag`/`lag` (max/min age — a direct
`lifespan: 'range'` fit) and `phl/cll/odl/fml/gnl` taxonomy.

The coral Grouping is derived from **PBDB's own hierarchy** via `base_name`
queries (Rugosa / Tabulata / Scleractinia / Octocorallia), never a hand-written
order→subclass table — the four `base_name` counts above sum to 44,727 of
45,602, so the partition is bounded and nearly complete without inventing
anything.

**Paleocoordinates are recomputed under Geode's own Scotese**, from present-day
`lng`/`lat`, via `points_from_dataframe` against Scotese static polygons — the
`prep_boucot.py` path. PBDB's own `pln`/`pla` are *not* used as the data path
for a decisive reason: they are computed at **one age only** (`ps1: "mid"`, the
midpoint of that occurrence's age range), so they are a single frozen position
per point, and a map built from them would silently mix reference frames.
PointLayer needs a rotation series. PBDB's `gpl` plate id is likewise ignored —
it belongs to PBDB's model, not ours (ADR-0004 discipline).

PBDB *does* offer `pgm=scotese` as one of three paleomodels, so its
mid-age paleocoords become an independent **cross-check** on our own pipeline —
two implementations of nominally the same model that should agree. (PBDB's
`pgm=seton` returns *"not computable using this model"* for a 312 Ma record,
independently confirming the coverage table above.)

### Time — Sampling Step and Time Bin are different things

Deliberately two terms, never one:

- **The map needs no bins at all.** At a continuous Reconstruction Age *t*, a
  cell holds every occurrence whose own `[lag, eag]` contains *t* — that is
  `lifespan: 'range'`, already implemented.
- **Sampling Step** — the uniform interval the aggregate-glyph export is
  precomputed at, a rendering convenience (cf. `prep_boucot.py`'s 5 Myr
  rotation sampling).
- **Time Bin** — the stratigraphic unit the *diversity curve* is computed over,
  an analytic unit. **ICS stages**: 101 across the Phanerozoic (PBDB calls them
  `age`), median duration 4.38 Myr, range 0.00–21.6 Myr.

An occurrence counts toward the curve only if its `eag`/`lag` resolves to
exactly one stage, and the viewer reports how many were dropped rather than
hiding it — matching what PBDB-based diversity studies do, so the curve is
comparable to published ones. Stage-duration unevenness is shown, not smoothed:
a 21.6 Myr bin accumulates more genera than a 2 Myr bin purely by lasting
longer.

### Diversity — show the confound, don't correct it

The curve plots sampled-in-bin genus richness **and** the sampling proxy
(occurrences and collections per bin) on the same panel, both straight from
PBDB's `occs/diversity.json` (`dsb`, `noc`). Boundary-crosser counts
(`xft`/`xbl`/`xfl`/`xbt`) arrive in the same response, so a second, less
sampling-sensitive series is nearly free.

No sampling standardisation (SQS) is implemented. Raw Phanerozoic richness
substantially tracks how much rock and how many workers there were, and the
answer to that is to show the reader the correlation rather than tell them it
was handled — the same discipline as showing a map instead of asserting
agreement. A wrong SQS is worse than an honest raw curve, and its quorum
parameter would be a tuning knob that changes the answer.

### Panels — latitude–age plot + diversity curve

Two stacked panels sharing one age axis, with a cursor tied to the
Reconstruction Age slider so scrubbing the globe moves a line across both.

1. **Latitude–age plot.** Paleolatitude vs age, cells shaded by occurrence
   density or dominant Grouping category. This is what actually answers
   "latitudinal distribution through time"; the P–Tr and K–Pg events should
   read as horizontal breaks.
2. **Diversity curve**, as above.

Both precomputed per Grouping category at prep time (101 stages × ~18 latitude
bands × ≤6 categories is tiny), so switching Grouping is instant.

The latitude–age panel is **not** coral-specific: for case study 2 the same
panel, shaded by origin category, *is* the migration picture — the
North-origin colour visibly extends southward once the isthmus forms.

## Case study 2 — Panama, both signs

The isthmus closing is a **join and a split at the same moment**: it connects
two land faunas while severing two marine ones. One region, one time window,
one gateway, opposite signs — and the marine half is corals, so it runs on case
study 1's prep script with only a different Grouping.

Measured coverage (occurrences):

| pool | count |
|---|---:|
| N. American mammals 12–2 Ma | 9,436 |
| S. American mammals 12–2 Ma | 3,193 |
| Molluscs, Caribbean/E-Pacific box, 15–0 Ma | 14,570 |
| Scleractinia, same box/time | 2,873 |

Rejected alternatives, with the measurement that killed them: Out-of-India
(656 occurrences), austral *Nothofagus* (335), *Lystrosaurus* (95) — all too
thin to carry a map. Tethys seaway closure (2,306 Scleractinia) is viable and
has genuinely active tectonics, kept as a future third case study. Pangaea
distribution (*Glossopteris* 1,320 + therapsids 1,458) has the strongest
"the reconstruction explains the data" payoff and meets case study 1 at the
end-Permian, but it is vicariance, not exchange.

**Stated honestly:** over 12 Myr the plates barely move, so the reconstruction
is the stage, not the actor. The story is carried by the data and the Grouping.
This is the inverse of the Pangaea option and the viewer should not pretend
otherwise.

### Origin is derived, not observed — and the UI must say so

An asymmetry that goes in the glossary, because a derived category that looks
like an observed one is how a viewer ends up asserting what it cannot support:

- **Marine Grouping is observed.** "Caribbean side or Pacific side" comes
  straight from `lng`/`lat`.
- **Terrestrial Grouping is derived.** PBDB gives taxonomy and coordinates; it
  does not record where a lineage came from. A genus is assigned to whichever
  continent holds its **oldest PBDB occurrence**; ties and overlapping first
  appearances go to an explicit `ambiguous` category rather than being forced.
  The legend states the rule in one line, and the UI says **"first appears
  in"**, never "originated in".

### Exchange — no new grammar

Nothing new is drawn. The latitude–age panel shaded by origin shows the
terrestrial spread; the curve panel carries two derived series on one age axis:

- **immigrant fraction** per bin on each side of the gateway (rises), and
- **Caribbean–Pacific faunal similarity** per bin (falls as the seaway closes).

Two curves moving in opposite directions on the same axis *is* the "both signs"
story stated quantitatively. Both computable from data already fetched; zero
new rendering, zero new controls.

Rejected: flow arrows between regions (an inference drawn as geography —
implies a route nobody observed) and per-genus trajectory paths (a centroid of
a patchy fossil record jumps around for sampling reasons, so most paths would
be noise).

### Counting unit — genus

Measured on all 68,641 PBDB Anthozoa records, `accepted_rank`:

| rank | n |
|---|---:|
| species | 35,163 |
| genus | 30,170 |
| subclass | 1,015 |
| class | 808 |
| family | 681 |
| order | 451 |
| subgenus | 252 |
| subspecies | 59 |

Counting at genus retains **95.2%** of records; counting at species retains
51%. That, not convention, is the argument. Species identifications are also
inconsistent between workers and regions, so a species-level curve substantially
measures who described the fauna. The finest identification each occurrence
carries is kept as metadata for the hover popup; it is never the analytic unit.

### Reconstruction Model — per case study, not per viewer

Measured, on the actual Panama-window data, what each cataloged model loses to
`PointLayer.isLive()` (ADR-0032/0033):

Marine box (Scleractinia + Mollusca, 15–0 Ma, n=38,734):

| model | unassigned (plate 0) | not drawable at own age |
|---|---:|---:|
| Scotese 2008 | 5,621 | **14.5%** |
| Müller et al. 2019 | 0 | **0.0%** |
| Seton et al. 2012 | 0 | 17.6% (begin-age failures) |

GABI mammals (12–2 Ma, n=12,629): Scotese 0.1%, Müller 0.7%, Seton 0.9% — all
negligible.

So:

- **Case study 1 (corals) → Scotese 2008.** The only cataloged model reaching
  540 Ma. Whole-dataset exclusion by era, measured: Paleozoic 4.3%, Mesozoic
  1.9%, Cenozoic 27.3%.
- **Case study 2 (Panama) → Müller et al. 2019.** Zero loss where Scotese loses
  one marine occurrence in seven, *and* it restores Boundary Frames and plate
  names, which Scotese structurally cannot have (ADR-0019/0031). The 0.6-point
  terrestrial penalty is nothing against a 14.5-point marine one.

The **Reconstruction Model follows the loaded dataset** and is not freely
selectable — the wrapper enforces the pairing so a dataset is never drawn under
a model other than the one it was reconstructed with. ADR candidate.

Two findings worth carrying forward beyond this viewer:

1. **The `plate_begin_age` risk is inverted from intuition.** True begin-age
   violations are rare (2.0% overall) because Scotese's static polygons are
   ancient continental blocks (median begin age 600 Ma, p75 4500 Ma). The real
   loss is *unassigned* points — plate 0, which `isLive()` never draws older
   than present day — and those concentrate in the **Cenozoic**, because young
   occurrences sit on oceanic reefs and islands that continental static
   polygons do not cover. Anyone reaching for Scotese "because it goes deepest"
   should know it is worst exactly where the data is densest.
2. **PBDB's API disagrees with itself.** `occs/list.json?base_name=Anthozoa
   &rowcount` reports 45,602; `occs/list.csv?...&limit=all` returns 68,641
   rows. Must be resolved before any export. Every measurement in this document
   used the larger CSV set.

### Base map — PaleoDEM, plus one temperature toggle

Scotese & Wright 2018 paleogeography (`paleogeography-scotese`:
`elevation`, `hillshade`) as the fixed base, with no selector — shelf vs deep
ocean is the context a coral occurrence needs and the main sanity check a
reader has on the reconstruction.

One on/off toggle for Pohl et al. 2022 surface temperature
(`climate-pohl2022`). Pohl is the correct pairing because it is built on
Scotese; `climate-540myr` (Li et al. 2022) is also Phanerozoic but carries its
own paleogeography, so showing it under Scotese coastlines is precisely the
ADR-0004 misplacement. Corals tracking the warm belt is the one overlay that
explains the latitudinal story; nothing else is exposed.

**Requirement, independent of the above.** All three of these models carry
`reconstruction_model: null` in `archive.json`, and
`core/staticPolygons.ts`'s `resolveStaticPolygonReconstructionId()` falls back
to `'scotese'` **by `manifest.type`**. That is an inference of exactly the kind
ADR-0004 forbids; it is currently harmless only because every cataloged
climate/paleogeography model happens to be Scotese-based. The paleobio wrapper
must require an explicit `reconstruction_model` and refuse the type-based
fallback, so that cataloging one non-Scotese climate model later cannot
silently draw fossils under the wrong reconstruction.

### Where the code lands

Governed by `deep-time-map`'s own scope ADR-0001, which names *"querying a live
species database"* as a split feature and states that nothing in its `js/`
should ever need to know what a "species" is.

| capability | test | lands |
|---|---|---|
| PBDB fetch, Grouping rules, origin rule, stage binning | domain-specific | `prep/prep_pbdb.py`, emitting plain `points.json` |
| Aggregate glyph at a projected position | sphere geometry + `project()` only | **upstream** (scope test 1) |
| Latitude–age panel | host-agnostic time-axis widget, no WebGL | **upstream** (scope test 2, same basis as `timeseries-panel.js`) |
| Occurrence loading, toggles, layout, model pairing | Geode's own data model | `viewer/src/paleobio/` |

**Upstream first, then the wrapper.** Both upstream capabilities are built and
released in `deep-time-map` (changelog, tag, `npm run typecheck` +
`npm run check:boundaries`, pin bump per ADR-0028) *before* Geode work starts —
following the rule rather than relying on luck, which is the stated reason
ADR-0028 and its upstream counterpart exist. It also gives the detrital-zircons
pie hack a real home instead of leaving it a one-off reach-in overlay.

## Still open

- Whether the aggregate glyph is a pie, a dominant-category symbol sized by
  richness, or both — unsettled, and deliberately so until something is on
  screen.
- HEALPix `n` for the Aggregation Cell (n=8 → 768 cells, ~7° is the
  `velocities.json` precedent; may be too coarse for the Panama box).
- Resolving the PBDB count discrepancy.
- Sampling Step for the aggregate export.
- Whether the diversity curve registers as a new Time Series **Series Source**
  under ADR-0023, or stays a wrapper-local panel.

## Measurement scripts

Kept out of the repo; rerun from
`scratchpad/measure_begin_age.py` and `scratchpad/measure_panama.py` (session
scratchpad) if any number here needs re-checking.
- Which interchange event.
- How "migration" is actually depicted (static occurrences do not show motion).
- Whether the diversity curve is a new Time Series **Series Source** (ADR-0023).


## Built — where this changed on contact with the data

Seven things moved between the design above and what shipped. All were found by
measuring, and each is recorded where it matters in code as well as here.

### 1. The grid is an equal-area ring grid, not HEALPix

`healpy` is not installed in the `pygmt17` environment, and adding a dependency
to get a better *aspect ratio* was not worth it when the property that actually
matters — exact equality of area — takes five lines without it. `EqualAreaGrid`
divides the sphere into rings of equal area (equal steps in sin φ), each cut
into the same number of longitude divisions, so every cell is exactly
`4π / (rings × lon_cells)` steradians. `verify_equal_area()` confirms it by
Monte Carlo; centres round-trip exactly and `cells × area == 4π` to machine
precision. Cost: polar cells are elongated north–south. Swapping in HEALPix
later is an exporter-only change, because the renderer never implements the
grid — cell centres ship in the payload.

### 2. Panama moved to Müller 2019, reopening a settled decision

Measured after the plan was agreed: Scotese loses **14.5%** of the Panama marine
record to unassigned plates where Müller 2019 loses **0.0%**. See ADR-0034,
including the finding that `plate_begin_age` loss is inverted from intuition
(Cenozoic 27.3% vs Paleozoic 4.3%).

Consequence not in the original plan: Panama gets **no base raster**. The only
Phanerozoic paleogeography in the catalog is Scotese & Wright's, which carries
Scotese's continent positions; drawing it under Müller 2019 coastlines is the
ADR-0004 misplacement. Coastlines and land fill only — which then required an
opaque backdrop sphere, since land polygons do not cover ocean and the first
build showed the far hemisphere's coastlines through the globe.

### 3. The mammal window was wrong, and the export's own output said so

The plan sized the GABI pool at 12–2 Ma. The first export's diversity table came
back with `richness_north_america == 0` for every stage younger than the
Gelasian and immigrant fractions pinned near zero — because the interchange
peaks *after* ~2.7 Ma. The bound had been chosen to size a download, which is
not a reason. Widened to 12–0 Ma, after which the immigrant fractions rise
through the Pliocene–Pleistocene as expected.

### 4. The marine box was clipping the Pacific, and the divide rule was wrong

The plan's box (−100..−55, −5..30) left the eastern Pacific with 2,789 records
against the Caribbean's 35,945, and **five of ten stages had zero sampled
Pacific genera** — because `latmin=-5` cut off the Ecuador/Peru Neogene
molluscs. Widened to (−110..−55, −20..30).

That widening broke the original straight-line basin rule: any line through
Central America puts the Atlantic coast of Brazil on the "Pacific" side. Replaced
with a piecewise continental-divide polyline, and — because those vertices are
hand-specified, unlike everything else in the pipeline — `prep_pbdb.py
--verify-basins` renders `archive/paleobio/basin_check.png` so the split can be
checked by eye. It was checked; the divide tracks the coast, Galápagos
classifies Pacific, and the sub-Andean Pebas records classify with the
Caribbean.

**The limitation that survives:** 3,030 Pacific against 36,524 Caribbean
occurrences. That is PBDB's sampling, not the classification, and it caps how
strong the marine half of the case study can be. The basin-similarity series has
five usable stages.

### 5. Continent membership comes from two queries, not a lookup table

PBDB's response `cc` is a **country** code (US, AR) while the query's `cc=`
accepts **continent** codes (NOA, SOA) — not the same vocabulary. Deriving one
from the other would have meant inventing a country→continent table, so the
mammal pool is two queries, each tagged.

### 6. Diversity is computed locally under one rule

The plan said to use PBDB's `occs/diversity.json` (`dsb`, `noc`). It is not
used: PBDB bins by its own rule, and mixing its counts with ours would put two
denominators on one axis. See ADR-0035, which also records why a blank is not a
zero in the basin-similarity series — writing 0 there was a real bug that would
have drawn the case study's headline claim out of missing data.

### 7. No new time-series widget was needed

A diversity curve is a CSV and `timeseries-panel.js` already reads those. Only
two things went upstream: `AggregateLayer` and `attachLatitudePanel`.

## Verification

`npm run check:paleobio` drives the real page in a browser and shoots seven
states, printing the legend counts beside each. What it showed:

- **0 Ma** — 1,052 scleractinian, 13 octocoral, **zero** rugose/tabulate.
- **380 Ma** — 778 rugose, 441 tabulate, **zero** scleractinian.
- The latitude–age panel resolves the end-Permian as a hard colour break at
  ~250 Ma without anyone having asked it to.
- Panama at 0 Ma — red (North-origin) pies across North America, blue across
  southern South America, and **mixed pies through Central America and the
  Caribbean**, which is the interchange.

Two anomalies the viewer surfaced, both real and both explicable:

- Three post-Permian "Rugosa" records are all *Mesophyllum*, a name shared by a
  rugose coral genus and a genus of coralline red algae; PBDB's hierarchy pulls
  the Oligocene/Miocene algal records into Rugosa.
- One record identified only as "Rugosa" is dated *Paleozoic–Mesozoic*
  (538.8–66.0 Ma), a 473 Myr range, so `lifespan: 'range'` correctly draws it at
  every age in that span. The single-stage rule drops it from the panels.

## Added after first review

Two things came out of looking at the built viewer.

### The two panels ran in opposite directions

`timeseries.js` put the oldest age on the left; the latitude panel I added to
the same library put the present there. Stacked on what reads as one shared
axis, that is not a misconfiguration anyone spots — it just looks like the data
is wrong. Both now take an explicit `timeDirection`, defaulting to
deep-time-map's original, and the wrapper sets both to Geode's `present-left`
(which is what `core/timeSeriesPanel.ts` and every age slider already use).

Direction alone was not enough: the latitude panel also reserved a 30 px label
gutter while the series panel insets by half a thumb width, so a given age still
landed up to 23 px apart. Labels moved inside the plot; both now inset
identically. `npm run check:paleobio` measures the two cursors at five ages and
reports the delta — ≤1 px across the full range.

### Robinson projection

A third Projection, and the first needing a tabulated inverse and an off-map
discard — see ADR-0036. It also forced land fill to reproject for the first
time, which Plate Carrée had never done; the Panama dataset has no base raster,
so its land fill IS the basemap and a spherical blob of land over a flat map was
not survivable.

Worth stating: adding Robinson exposed a bug that had nothing to do with it.
`Coastlines.dispose()` frees GPU resources but never unparents its meshes, and
the wrapper was disposing without removing — so every dataset reload left the
previous globe-mode land mesh in the scene. Invisible on a globe (it coincided
with the new one) and obvious the moment a flat projection put it somewhere
else.

## Still open

- Whether the aggregate glyph should also offer 'dominant' mode in the UI (the
  layer supports it; the wrapper does not expose it).
- Antarctica's land fill in a flat projection is a wide band with a seam gap in
  it. Correct in principle for a world map, imperfect in detail.
- HEALPix, if a dependency ever becomes acceptable — exporter-only change.
- Tethys seaway closure as a third case study (2,306 Scleractinia, genuinely
  active tectonics, full pipeline reuse).
- Whether the diversity curve should register as an ADR-0023 Series Source.
- deep-time-map v0.5.0 is tagged locally and **not pushed**.
