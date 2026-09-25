# Archives are standalone, and copy what they need from a published release

A viewer built around someone's own data — the first is DETOX-P2 — needs
supporting layers it does not produce itself: coastlines, rotations and
boundaries from a Reconstruction Model, colour ramps, the surface texture.
The obvious design is to reference those from the main Geode Archive, which
already has them.

**Decision: an Archive never refers to another Archive. Anything it needs
from elsewhere is copied in, and copied as the packed bytes of a named data
release of the source Archive (e.g. "coastlines: copied from Geode
data-v22"), with that origin recorded beside the provenance the layer
already carries (`source.json`).**

## Why not reference the main Archive

A reference makes every other Archive depend on the main one's layout, its
host and its release cadence. Renaming a directory, repacking, or moving the
main Archive to object storage (issue #9) would break sites that have
nothing to do with the change, and an Archive could no longer be verified,
hosted or rebuilt on its own. The duplication costs about 12 MB of copied
layers against a 1 GB Pages cap — nothing.

## Why copy from a release, not rebuild from sources

Rebuilding the layers from first principles (gprm fetch, `prep_coastlines.py`,
the petrify boundary export) is more "pure" but needs earthbyte.org, which
sandboxed environments such as a Claude Cowork VM have been observed to
block, takes far longer, and can drift from what the main viewers show. A
copied layer is byte-identical to the one already published and reviewed.
Only the new Model is built from source, under its Ingest Config.

## Consequence

Copied layers arrive already packed (`.gz` names in their index entries),
so a standalone Archive is assembled by grafting those index sections
verbatim, not by `build_archive_index.py`, which stays the tool for raw
archives and refuses packed ones.
