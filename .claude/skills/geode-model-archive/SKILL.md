---
name: geode-model-archive
description: Import a published gridded Earth model (seismic tomography or mantle convection volume) into a standalone Geode Archive, recording every judgement call in an Ingest Config and stopping at a Verification Card for the user's approval. Use when the user wants a Geode viewer for a model that is not already in the Geode catalog ("make a viewer for DETOX-P1", "import this tomography model", "add SAVANI"), before the geode-globe-viewer Skill builds the site.
---

# Geode model import

Turns a published model into a **standalone Archive** (CONTEXT.md;
ADR-0054) that the `geode-globe-viewer` Skill can publish as a site. There
are no manual steps (ADR-0056): you probe the source, put the judgement
calls to the user with evidence, record their answers in an **Ingest
Config**, and deterministic tools do the rest. The user's one job is to
look at the **Verification Card** and approve it.

`archives/detox/` is the worked example: read its `detox-p2.ingest.json`
(especially `evidence`) and `README.md` before starting. The format spec
is `docs/ARCHIVE_FORMAT.md`.

**Scope, v1**: 3-D volumes on a regular lon/lat/depth grid, as one netCDF
volume or a directory of per-depth 2-D grids (netCDF / GMT `.grd`),
`type` `tomography` or `convection`. The reconstruction the site shows it
with is Müller et al. 2022, copied from a Geode data release; importing a
different reconstruction is not supported yet. For anything else (point
data, unstructured meshes, a time-dependent volume, another
reconstruction), say so plainly and stop.

## Environment

Everything runs with the pip baseline (`requirements.txt`; no conda, no
GMT needed on this path). Use whichever Python has it installed — a venv,
or the user's own environment if they have one; never assume a conda env
exists. `python prep/assemble_archive.py --help` failing on an import means
the environment isn't set up: `pip install -r requirements.txt`.

## Step by step

1. **Identify the source.** Find the model's paper (citation, DOI) and
   its data release (Zenodo, IRIS EMC, a lab page), and the license. A
   model with no stated license: tell the user before going further.
   Prefer the authors' own release to a re-hosted copy.

2. **Probe the files.** Download (to the cache: `prep/_inputs.py`'s
   fetchers do this) and inspect with xarray: variables, dims, coordinate
   ranges and spacing, units attributes, fill values, longitude convention
   (0–360 or −180–180, seam duplicated or not), depth vs radius, and depth
   spacing (the slice loader refuses uneven spacing). Measure; don't guess
   from file names. Write small probe scripts in the scratchpad, not the
   repo.

3. **Settle each judgement call with evidence**, then put the ones that
   are genuinely the user's to them (AskUserQuestion, one decision at a
   time, your recommendation first). Record the evidence for every one in
   the config's `evidence` block — a future reader must be able to check
   it without redoing your probe:
   - **Which variant** if the release has several (P vs P+Pdiff, etc.) —
     cite what the paper says each is good for.
   - **Units and scaling**: % vs fraction, dlnV vs absolute. If the files
     don't say, test against another representation in the same release
     (DETOX: regression against the native-node file gave slope ≈ 100).
   - **Depth reference**: depth below 6371 km or a model-specific radius.
   - **Polarity** (`high_means`: `fast` for velocity, `hot` for
     temperature): which sign subducted slabs take.
   - **Resolution**: default to native (`nlon`/`nlat`/`ndepth` matching
     the source after seam handling); resample only if Pages size forces
     it, and say by how much.
   - **Encode range** (`clip_percentile`, default 99.5): the Verification
     Card reports the clamped fraction by depth. If strong structure is
     clamped (percent-level at any depth band), raise it and record why.
   - **Default display range** (`default_clip`): what the viewer opens
     at. Look at the distribution (e.g. the 95th percentile of |value|)
     and at a rendered slice; record the number and the reason.
   - **Reconstruction**: `computed_in` (the reconstruction the model was
     built in, if any; `null` for present-day tomography) and
     `shown_with` (`muller2022` in v1).

4. **Write the Ingest Config** at `archives/<family>/<id>.ingest.json`,
   in the shape of `archives/detox/detox-p2.ingest.json`: `"ingest": 1`,
   `id` (lowercase, hyphenated, unique in the catalog), `name`, `type`,
   `source` (full citation), `doi`, `license`, `input` (`zip_url` +
   `members` regex, or a fetcher you add to `prep/_inputs.py` — never a
   local path, which can't be rebuilt elsewhere), the prep options, and
   `evidence`. Unknown keys are an error in `prep_model.py --config`; that
   is deliberate. Add a `README.md` beside it with the one rebuild command.

5. **Assemble**:
   ```
   python prep/assemble_archive.py --out <scratch>/archive-<id> --from-release <data-vN> \
       --copy colormaps.json coastlines boundaries surface \
       --model archives/<family>/<id>.ingest.json
   ```
   `<data-vN>`: the `DATA_RELEASE` in `.github/workflows/deploy.yml`. It
   copies the reconstruction layers from that release, imports the Model,
   packs it, verifies the Archive and draws the card. Exit 1 means the
   Archive check or the card's gate failed: read why, fix the config (or
   the tool, if it's a tool bug — then say so), rebuild. Never loosen the
   gate to pass.

6. **Stop at the Verification Card.** Show the user
   `models/<id>/verification/card.png` (Read it yourself first) and the
   numbers from `card.json`: gate result, clamped fraction, worst error.
   Also show what the site will look like: scaffold a draft `mantle-globe`
   site into the scratchpad (the `geode-globe-viewer` Skill's steps 6–9:
   recipe, validate against this Archive, scaffold, unpack, build,
   checkSite — nothing is published), serve it with `npx vite preview`,
   and screenshot its View Presets (Playwright, from `viewer/node_modules`).
   Don't swap this repo's own `archive/` to preview. Say which judgement calls the
   card bears on. Do not continue until the user approves. A change they
   ask for goes into the config, then back to step 5.

7. **Hand off.** Commit the Ingest Config and README (explicit paths only;
   other work may be in the tree), then build the site with the
   `geode-globe-viewer` Skill: `wrapperType` `mantle-globe`, `dataHost`
   `{ "release": { "tag": "archive-v1", "asset": "archive.tar.gz" } }`,
   validated against the assembled Archive directory.

## What this is not

Don't hand-edit anything in an assembled Archive, and don't write an
Archive's files by any other route than `assemble_archive.py`: the
Archive is rebuilt from its config, so an edit that isn't in the config
is lost and unrecorded. Don't pick a judgement call silently because it
"looks right" — if the evidence is ambiguous, it's the user's decision.
