# The paleobiology viewer's Reconstruction Model follows the dataset, and is not selectable

Every other Geode viewer lets the reader choose, or at least see, which
Reconstruction Model is in play. `paleobio.html` does not: choosing a dataset
chooses the reconstruction, the coastlines, the base raster and the age range
together, and there is no control for the reconstruction alone.

That will look like an oversight to a future reader, so: it is the whole point,
and the reason is a measurement.

## The measurement

Both case studies were exported under all three cataloged Reconstruction
Models and scored on what `PointLayer.isLive()` (ADR-0032/0033) refuses to
draw — a point assigned no static polygon at all (`plate_id: 0`), or one older
than its assigned polygon's own begin age.

Panama marine box (Scleractinia + Mollusca, 15–0 Ma, n=38,734):

| model | unassigned (plate 0) | never drawable at own age |
|---|---:|---:|
| Scotese 2008 | 5,621 | **14.5%** |
| Müller et al. 2019 | 0 | **0.0%** |
| Seton et al. 2012 | 0 | 17.6% (begin-age failures) |

GABI mammals (n=12,629): Scotese 0.1%, Müller 0.7%, Seton 0.9% — all
negligible.

So Scotese silently deletes one marine occurrence in seven from the case study
built on them. Müller 2019 deletes none. But Müller 2019 stops at 240 Ma, and
the coral case study needs 540 Ma — three of the four mass extinctions it
exists to show are older than 240 Ma, and Scotese is the only cataloged model
that reaches them.

Neither model is right for both. **Corals → Scotese. Panama → Müller 2019.**

## Why that means no control

ADR-0004 already forbids drawing a reconstruction-dependent Model under a
Reconstruction Model other than its own. A dataset of reconstructed points is
the same case: the rotations that moved the fossils and the rotations that
moved the coastlines under them must be the same rotations, or the map shows
fossils in the ocean and nobody can tell from looking.

A selector for the Reconstruction Model would therefore be a selector for
"draw this wrong". There is no correct second choice to offer, so there is no
control. The same reasoning fixes the base raster: `paleogeography-scotese`
carries Scotese's own continent positions, so the Panama dataset has **no**
base raster at all rather than that one. Coastlines and land fill only.

This is the ADR-0017 test applied honestly. That ADR says composability is
never gated by *perceived usefulness* — but it explicitly allows a genuine
technical conflict to prevent a pairing (ADR-0022), and this is one: the
pairing is not less useful, it is wrong.

## A finding worth carrying beyond this viewer

The `plate_begin_age` loss is **inverted from intuition**. Measured across all
68,641 PBDB Anthozoa records against Scotese: Paleozoic 4.3%, Mesozoic 1.9%,
**Cenozoic 27.3%**. True begin-age violations are only 2.0% overall — Scotese's
static polygons are ancient continental blocks (median begin age 600 Ma, p75
4500 Ma). The damage is unassigned points, and they concentrate in the
*Cenozoic*, because young marine occurrences sit on oceanic reefs and islands
that continental static polygons do not cover.

Anyone reaching for Scotese "because it goes deepest" should know it is worst
exactly where the data is densest.

## Consequences

- `PaleobioDataset.reconstruction_model` is required, not optional, and the
  wrapper resolves coastlines by that declared id. It deliberately does **not**
  use `core/staticPolygons.ts`'s `resolveStaticPolygonReconstructionId()`,
  which falls back to `'scotese'` by `manifest.type` — an inference that is
  harmless only while every cataloged climate/paleogeography Model happens to
  be Scotese-based.
- Switching dataset is one decision, not four. `loadDataset()` is guarded by a
  token so two rapid switches cannot leave one dataset's points under the
  other's coastlines.
- Adding a third case study means adding a dataset with its own declared
  Reconstruction Model, not adding a dropdown.
