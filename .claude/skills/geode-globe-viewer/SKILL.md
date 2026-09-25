---
name: geode-globe-viewer
description: Generate a standalone, deployable Geode globe-viewer website from a plain-language request and publish it to the user's own GitHub Pages. Use when the user says something like "use Geode to create a website/viewer with model X, dataset Y, deployed to my GitHub Pages" — a request for a new, personal, no-code viewer site, not a change to this monorepo's own viewers.
---

# Geode globe-viewer generator

Turns a plain-language request into a new GitHub repo containing a minimal,
standalone globe viewer, deployed to the requesting user's own GitHub Pages.
See ADR-0017 (composability), ADR-0018 (reconstruction-override friction),
ADR-0020 (reconstruction comparison as its own wrapper type), ADR-0021
(Reconstruction Models as a catalog section) and ADR-0022 (Multi-Globe) for
the design decisions behind this, and `generator/recipeTypes.ts` for the
recipe shape itself — read them if anything below is unclear or if the
catalog/tooling has visibly moved on since this was written.

**Scope**: v1.9 only composes from the existing, pre-vetted data catalog
(`archive/archive.json`, served live from
`https://siwill22.github.io/Geode/archive`). It never imports data itself
or invents a colormap/clip-range/coastline pairing. Importing a Model is a
separate step with no manual parts (docs/adr/0056): its judgement calls are
asked, recorded in an Ingest Config and shown on a Verification Card for
approval, producing an Archive this Skill then consumes.

**Vocabulary** (see `CONTEXT.md` — this Skill uses its terms precisely, not
loosely): a **Model** is one named field from one published source (a
seismic tomography inversion, a mantle convection run, a paleoclimate
simulation, a crustal deformation run — never say "dataset" to the user,
that word was tried and retired, see `generator/recipeTypes.ts`'s own
doc-comment history of getting this wrong). A **reconstruction-dependent**
Model (everything except Tomography today — yes, including mantle
convection, which shares a `resolveCoastlineSet()` code branch with
Tomography for incidental reasons but is NOT reconstruction-independent,
see `docs/adr/0018`) declares exactly one **Reconstruction Model** and may
never be shown under a different one. Several reconstruction-dependent
Models sharing a `reconstruction_model` and/or `comparison_role` form a
**comparison family** (e.g. Cao2024/Muller2019 × Deformation/Age & Heat
Flux) — not a fixed, pre-listed catalog entity, just whichever Models
happen to share a declared axis, discovered live each time (see step 2).

A **Reconstruction Model** is ALSO a first-class catalog entity in its own
right (`archive.reconstruction_models[]`, see `docs/adr/0021`) —
independent of whether any numerical Model uses it. Each entry carries its
own coastlines and, only if that reconstruction genuinely resolves plate
topologies, Boundary Frames (`has_boundaries` — check this field, never
assume every Reconstruction Model has or will eventually have Boundary
Frames: Scotese permanently never will, see `docs/adr/0019`). A request
about comparing/exploring Reconstruction Models' own geometry — no
numerical field, no Variable, at all — is asking about this list, a
different thing from a comparison family above (see step 3).

A fixed menu of four bundled UI tools (`legend`/`age-slider`/
`no-data-toggle`/`query-point`, offered together, pre-selected by default)
plus one opt-in `time-series` panel — asked about separately, the same way
Multi-Globe is (see step 4/5), never silently bundled into the other
four's default — applies to the two numerical-Model wrapper types only.
Four wrapper types total (see step 3 for how to choose):
- `single-model-globe` — exactly one Model, no comparison controls.
- `model-group-globe` — several Models from ONE comparison family, varying
  along at least one shared axis (which reconstruction; which role),
  switched between via dropdowns, forming a COMPLETE grid (every
  combination present — see `resolveModelGroup()`'s exact rule in step 7).
- `single-reconstruction-globe` — exactly one Reconstruction Model's own
  coastlines (and Boundary Frames, if it has any), no numerical field,
  ever — on principle, not as a gap (see `docs/adr/0020`).
- `reconstruction-group-globe` — two or more Reconstruction Models switched
  via ONE dropdown (their own geometry only, never a numerical field) —
  e.g. "compare Müller 2019's continent polygons and plate boundaries
  against Scotese's continent polygons alone," the actual request that
  motivated building this pair.

**Multi-Globe** (see `docs/adr/0022`, `CONTEXT.md`'s Multi-Globe / Synced
Field entries) is available on all four wrapper types: an opt-in
`"+ Add globe"` toolbar that tiles N copies of the SAME recipe's globe side
by side, with Reconstruction Age optionally synced between them
(`multiGlobe.syncAge` — the only Synced Field this menu offers; there is no
depth-slice/month sync, since neither is in the fixed tool vocabulary). It
is orchestration only, never a way to show DIFFERENT things together on one
tile: each tile still shows exactly what that wrapper type already
supports (a `model-group-globe` tile can independently switch its own
dropdowns; a `single-model-globe` tile always shows the same Model). Two
distinct things still cannot be built today, for two different reasons
unrelated to Multi-Globe: (a) an arbitrary mix of Models that share no
common axis on one tile (e.g. a Tomography Model plus a Deformation Model)
— no wrapper type has a plain "pick one of these unrelated things"
selector (see `docs/adr/0017`); (b) a numerical Model shown together with a
Reconstruction-Model comparison on one tile —
`single-reconstruction-globe`/`reconstruction-group-globe` never paint a
field, deliberately, not because nobody's built it yet (see
`docs/adr/0020`). Say so plainly and explain which of the two reasons
applies, rather than forcing a request like that into Multi-Globe or one of
the four existing shapes.

If a request needs something else none of the four wrapper types can do
(an arbitrary multi-Model mix, three+ axes, on-the-fly data prep), say so
plainly rather than attempting it.

## Prerequisites

This skill shells out to `generator/validateRecipe.mjs` and
`generator/scaffoldRepo.mjs` and copies from `viewer/src/core/` (which now
unconditionally includes the tiny vendored `petrify` JS library —
see `core/boundaries.ts` — regardless of wrapperType) plus whichever
wrapper directory the recipe needs (`viewer/src/globe/` + `viewer/globe.html`
for `single-model-globe`; `viewer/src/groupGlobe/` + `viewer/groupGlobe.html`
for `model-group-globe`; `viewer/src/reconstruction/` + `viewer/reconstruction.html`
for `single-reconstruction-globe`; `viewer/src/reconstructionGroup/` +
`viewer/reconstructionGroup.html` for `reconstruction-group-globe`) — it
needs to be run with a checkout of the Geode repo (github.com/siwill22/Geode) available on
disk. If the current working directory isn't inside one, clone it to a
temp directory first (read-only use — never push to it).

The `gh` CLI must be authenticated as the user who will own the new repo
(`gh auth status`); if not, stop and ask the user to run `gh auth login`.

## Step by step

1. **Parse the request** into: which model(s)/author the user named, a
   description of the variable they want, which "tools" they asked for, and
   a desired repo name (if given). Don't try to force whatever the user
   said into a single Model or a single family yet — that's step 3.

2. **Fetch the live catalog**: `GET https://siwill22.github.io/Geode/archive/archive.json`,
   and each candidate model's own `manifest.json` (`archive.json`'s
   `models[].path`, same base URL). Do NOT use a local `archive/` directory
   even if one exists in the checkout — it can be ahead of what's actually
   deployed (this bit a real test: a model present locally 404'd against
   the live host). The live catalog is always the source of truth for what
   a generated site can actually show.

   Group the catalog into **comparison families** before doing anything
   else with it: any Models sharing a non-null `reconstruction_model` or
   `comparison_role` (both on `archive.json`'s own model summary, no extra
   fetch needed) with at least one other Model belong to the same family;
   every other Model stands alone. This grouping is discovered fresh from
   the live catalog every time — never hardcode today's one family
   (Cao2024/Muller2019 deformation) as if it were the only one that will
   ever exist.

   Also read `archive.json`'s own `reconstruction_models[]` array (see
   `docs/adr/0021`) — a separate, parallel catalog of Reconstruction Models
   in their own right (`id`/`name`/`source`/`has_boundaries`), independent
   of the `models[]` array above and requiring no extra fetch either. A
   request naming a Reconstruction Model with no numerical field involved
   is asking about THIS list, not a comparison family (see step 3).

3. **First decide which catalog the request is actually about** — these
   are two different lists, and conflating them is exactly the mistake
   `docs/adr/0020` exists to prevent:
   - The request names or implies a numerical Model's own data (a
     Variable, a simulation, an inversion, "temperature", "deformation",
     "tomography," any Model-family name) → it's about `models[]` — use
     the comparison-family rules below.
   - The request is about Reconstruction Models' own geometry with NO
     numerical field at all — comparing plate reconstructions, continent
     polygons, plate boundaries/topology through time (e.g. "compare
     Müller 2019 and Scotese," "show me how Pangea breaks apart," "let me
     switch between reconstructions with nothing plotted on them") → it's
     about `reconstruction_models[]` instead:
     - Exactly one Reconstruction Model named or implied →
       `single-reconstruction-globe`.
     - Two or more named, or "compare"/"switch between" wording →
       `reconstruction-group-globe`, including every named Reconstruction
       Model. There is no completeness-grid concept here (unlike
       `model-group-globe`) — any subset of the catalog is a valid
       comparison, since the only axis is "which Reconstruction Model" and
       every value of it is independently meaningful.
     - Skip straight to steps 4/5 using these rules — the comparison-family
       rules, variable matching, and `ui.tools` menu below don't apply to
       either reconstruction wrapper type at all.
   - The wording plausibly names something that is BOTH a
     `reconstruction_models[]` entry AND the reconstruction a numerical
     Model/family runs on (e.g. "Müller 2019" alone names both the bare
     `muller2019` reconstruction and the deformation family built on it) —
     this is genuinely ambiguous, not something to guess: go to step 5 and
     ask which was meant.

   **For a `models[]`-based request**, match against the grouped catalog:
   - If wording confidently matches exactly one standalone Model (by
     `models[].id`/`.name`/`.source`, or a manifest `variables[].id`/`.name`
     for the variable), and it stands alone (not part of a family) →
     `single-model-globe`.
   - If wording matches a Model that's part of a family, or clearly names
     more than one Model/reconstruction ("compare X and Y", "let me switch
     between reconstructions") → `model-group-globe`, scoped to that ONE
     family. Which Models from the family to actually include (the whole
     grid, or a narrower sub-grid — see step 7's exact completeness rule,
     only one axis needs to vary) is resolved in step 4/5, not assumed
     here.
   - If wording plausibly spans **more than one family**, or a family plus
     a standalone Model (e.g. "compare REVEAL with the Cao2024
     deformation") — stop. Say plainly that combining unrelated Models
     without a shared axis isn't something either wrapper type can do yet
     (see Scope above), and ask the user to narrow to one family or one
     standalone Model, rather than picking one side of the request for
     them or forcing a shape that will fail validation.
   - If wording is too vague to match anything with confidence ("show me
     something interesting", no model named at all) → go to step 5 and
     present the catalog as a real menu rather than guessing.

4. **Decide autonomously** (no question needed) when:
   - Exactly one standalone Model, or exactly one family, clearly matches
     the request, per step 3.
   - Exactly one Reconstruction Model, or an unambiguous list of two or
     more, clearly matches a reconstruction-only request, per step 3.
   - Whether a Reconstruction Model has Boundary Frames to show
     (`has_boundaries`) — this is NEVER decided by you or asked of the
     user, and never framed as "not yet available": it's a real, permanent
     property of some Reconstruction Models (Scotese, structurally — see
     `docs/adr/0019`), automatically shown when present and automatically
     absent when not. The generated wrapper handles this itself at runtime
     (a Boundary Frame toggle only appears when the loaded reconstruction
     actually has one) — nothing about it belongs in the recipe.
   - Within a matched family, whether to include the WHOLE family (every
     Model, forming the complete grid) or just the axis values the user
     actually named: default to the whole family when the request didn't
     say otherwise (e.g. "Cao2024 deformation" pulls in Age & Heat Flux
     too) — a comparison viewer with an unexpectedly-included extra role is
     a smaller failure than a silently narrower site. Mention what was
     included when reporting back (step 13).
   - The Model's own `default_variable` is a reasonable fit for what the
     user asked for (most requests don't name a specific variable — that's
     fine, the model's default is a sensible choice).
   - The requested "tools" map cleanly onto the fixed menu: `legend`,
     `age-slider` (only if at least one Model in the group has more than
     one frame — see `validateRecipe.mjs`'s check), `no-data-toggle`,
     `query-point`. A vague request ("let me explore it", "add some
     controls") gets all four that apply; a specific request gets just
     what maps. `time-series` is handled separately (below and in step 5),
     never silently folded into this "all four" default.
   - Whether to include `time-series` (a standalone fan-chart panel
     showing how a Model's own variable trends across Reconstruction Age —
     the Field Aggregate Series Source, see CONTEXT.md and
     `docs/adr/0023`): include it, without asking, when the request
     explicitly asks for it in terms that map cleanly ("show me how this
     changes over time," "a time series," "a trend chart," "summarize
     across ages") AND at least one Model in the group has a variable a
     Field Aggregate series can be computed for (excludes overlay-only/
     vector-only/mask-only/categorical variables — see
     `validateRecipe.mjs`'s check). Omit it, without asking, when the
     request explicitly asks for something minimal/simple (same wording as
     Multi-Globe's rule below), or when no Model in the group has a
     computable variable at all (nothing to offer). Otherwise — the common
     case, no signal either way — this is a guided-menu question (step 5),
     asked the same way Multi-Globe is.
   - Which coastlines pair with each model — this is NEVER decided by you
     or asked of the user. It's derived automatically (see ADR-0004 and
     `core/coastlines.ts`'s `resolveCoastlineSet()`) from the manifest's own
     `reconstruction_model` field, and `generator/validateRecipe.mjs`
     computes and reports it. If you find yourself about to guess a
     coastline/rotation pairing, stop — that is exactly the mistake
     ADR-0004 exists to prevent. Neither wrapper type has any control that
     lets a user pick a DIFFERENT reconstruction than a Model's own declared
     one — there is nothing to gate here yet (see `docs/adr/0018`); if a
     future wrapper ever adds such a control for a reconstruction-
     independent Model, re-read that ADR before wiring it up anywhere near
     a reconstruction-dependent one.
   - Whether to include Multi-Globe (`"+ Add globe"`, see Vocabulary above):
     include it, without asking, when the request explicitly asks for it in
     terms that map cleanly ("let me add more globes," "compare two ages
     side by side," "a split view") — default `syncAge` to `true` only if
     the wording also implies starting linked ("keep them in sync,"
     "linked"), otherwise `false`, matching the two hand-built viewers' own
     default. Omit it, without asking, when the request explicitly asks for
     something minimal/simple ("just a simple viewer," "nothing fancy," "as
     basic as possible"). Otherwise — the common case, no signal either way
     — this is a guided-menu question (step 5), never a silent default.

5. **Present a guided menu with `AskUserQuestion`** whenever step 3/4 didn't
   fully resolve what to build — don't fall back to free-text re-guessing,
   and don't ask an open-ended question the user has to answer from
   memory of the catalog's own id scheme. Cover, in as few rounds as
   needed:
   - **Which standalone Model or family**, when nothing matched
     confidently: list real candidates from the live catalog (grouped by
     scientific domain if there are more than fit in one question's 4
     options — e.g. "mantle/seismic," "paleoclimate," "crustal
     deformation" — a family appears as ONE option, e.g. "Crustal
     Deformation Comparison (Cao2024/Muller2019)," not as 4 separate
     Models). Pre-highlight the option that best matches the original
     wording as the recommended one, per the tool's own convention for
     surfacing a default.
   - **Which axis values within a family**, once a family is chosen and
     the request didn't already say: multi-select the reconstructions and
     roles to include, defaulting to "all" (the complete grid) pre-selected
     — the user narrowing down is a deliberate override of that default,
     not the assumed starting point. Confirm the result still forms a
     complete grid (it always will if the defaults are "all" or any
     rectangular subset; step 7 catches it either way if not).
   - **Which Reconstruction Model(s)**, when a reconstruction-only request
     (step 3) didn't clearly name enough: list real candidates from
     `archive.reconstruction_models[]`, naming whether each has Boundary
     Frames so the user isn't choosing blind (e.g. "Müller et al. 2019
     (coastlines + plate boundaries)" vs. "Scotese (coastlines only)").
     Single-select if the wording clearly wants to explore just one;
     multi-select (2+) if it's a comparison. Also use this to resolve the
     ambiguous case from step 3 (a name that's both a Reconstruction Model
     and a numerical-Model family) — offer both readings as options rather
     than picking one.
   - **Which tools** (only for `single-model-globe`/`model-group-globe` —
     the two reconstruction wrapper types have no tools menu, see Scope):
     multi-select from the FOUR bundled tools (`legend`/`age-slider`/
     `no-data-toggle`/`query-point`), all four pre-selected that
     structurally apply (per step 4's rule), for the user to deselect
     rather than assemble from nothing. `time-series` is never one of the
     pre-selected options here — see the next bullet.
   - **Whether to include `time-series`**, whenever step 4 didn't already
     decide it one way or the other, and at least one Model in the group
     has a computable variable (per step 4's rule): single-select yes/no,
     "No" pre-highlighted as the recommended default (same conservative-
     default reasoning as Multi-Globe below) — fold this into the SAME
     round as tools/Multi-Globe/repo-name, not a separate round trip.
   - **Whether to include Multi-Globe**, whenever step 4 didn't already
     decide it one way or the other: single-select yes/no, "No" pre-
     highlighted as the recommended default (a second globe/toolbar is a
     bigger structural addition than a checkbox tool, so the conservative
     default is to leave it out absent a signal either way) — fold this
     into the SAME round of questions as tools/repo-name, not a separate
     round trip. If "yes," also ask whether it should start synced (default
     "No," matching the two hand-built viewers' own default).
   - **Repo name and visibility**: always ask if not given, and ALWAYS
     confirm public vs. private before creating anything — this is the one
     guaranteed round-trip even when everything else was resolved
     autonomously.

   A same-author, different-type catalog collision, or a name that already
   exists in the user's account (`gh repo view <name>`, expect "not found"
   for a free name), belongs in this same round of questions, not a
   separate follow-up — resolve everything unresolved in as few
   back-and-forths as the tool's question/option limits allow, not one
   round trip per issue.

6. **Build the recipe** as a JSON object. Single model:
   ```jsonc
   {
     "recipeVersion": 1,
     "site": { "repoName": "...", "title": "...", "description": "..." },
     "wrapperType": "single-model-globe",
     "datasets": [{ "modelId": "..." }],
     "ui": { "tools": ["legend", "age-slider", "no-data-toggle", "query-point"] },
     "dataHost": { "archiveBase": "https://siwill22.github.io/Geode/archive" }
   }
   ```
   Comparison group — `datasets` lists every model in the full grid (order
   doesn't matter, the validator derives the grid from each model's own
   declared fields):
   ```jsonc
   {
     "recipeVersion": 1,
     "site": { "repoName": "...", "title": "...", "description": "..." },
     "wrapperType": "model-group-globe",
     "datasets": [
       { "modelId": "..." }, { "modelId": "..." },
       { "modelId": "..." }, { "modelId": "..." }
     ],
     "ui": { "tools": ["legend", "age-slider", "no-data-toggle", "query-point"] },
     "dataHost": { "archiveBase": "https://siwill22.github.io/Geode/archive" }
   }
   ```
   Single Reconstruction Model — no `datasets`, no `ui`, just
   `reconstructionIds` (exactly one):
   ```jsonc
   {
     "recipeVersion": 1,
     "site": { "repoName": "...", "title": "...", "description": "..." },
     "wrapperType": "single-reconstruction-globe",
     "reconstructionIds": ["muller2019"],
     "dataHost": { "archiveBase": "https://siwill22.github.io/Geode/archive" }
   }
   ```
   Reconstruction comparison — `reconstructionIds` lists every Reconstruction
   Model to compare (2+, any subset of the catalog, no completeness rule):
   ```jsonc
   {
     "recipeVersion": 1,
     "site": { "repoName": "...", "title": "...", "description": "..." },
     "wrapperType": "reconstruction-group-globe",
     "reconstructionIds": ["muller2019", "seton2012"],
     "dataHost": { "archiveBase": "https://siwill22.github.io/Geode/archive" }
   }
   ```
   Always use `https://siwill22.github.io/Geode/archive` as `dataHost.archiveBase`
   unless the user explicitly names a different Geode data host.

   Any of the four shapes above may add a top-level `multiGlobe` field when
   step 4/5 included it — never inside `ui`, and valid regardless of
   `wrapperType`:
   ```jsonc
   "multiGlobe": { "syncAge": false }
   ```
   The two numerical-Model shapes' `ui.tools` may also include
   `"time-series"` when step 4/5 included it:
   ```jsonc
   "ui": { "tools": ["legend", "age-slider", "no-data-toggle", "query-point", "time-series"] }
   ```

7. **Validate**: `node generator/validateRecipe.mjs <recipe.json>` (no
   third argument — let it check against the live host, per step 2's
   reasoning). On failure, read the structured errors: each one may include
   `suggestions` (near-matches) you can silently apply and re-validate, or
   may need a question back to the user (step 5) — a "datasets must form a
   COMPLETE grid" error means step 3's family assembly missed a member;
   re-check step 2's catalog scan rather than dropping datasets to make the
   error go away. Never proceed past a failed validation.

8. **Scaffold**: `node generator/scaffoldRepo.mjs <recipe.json> <tmpDir>`.
   This produces a complete, standalone repo (its own `package.json`,
   `vite.config.ts`, `.github/workflows/deploy.yml`, `README.md` with
   auto-generated attribution, `LICENSE`) with no dependency on this
   monorepo beyond the files it copied — exactly one wrapper directory
   (`globe/`, `groupGlobe/`, `reconstruction/`, or `reconstructionGroup/`,
   per `wrapperType`) plus `core/` (which always brings the small vendored
   `petrify` library along, whether or not this recipe's wrapper
   type uses it).

9. **Sanity-check it locally** before publishing anything: in `<tmpDir>`,
   `npm install && npm run build`, then from this repo
   `node generator/checkSite.mjs <tmpDir>`. The second step serves the
   built site and passes only if it reaches `ready` with no failed archive
   requests — a build alone cannot tell a working site from one that
   cannot find its data. If either fails, something is wrong with the
   generator itself (a bug, not a bad recipe — validation already passed) —
   stop and report it, with checkSite's output, rather than pushing a
   broken repo.

10. **Create the GitHub repo**: `gh repo create <repoName> --source=<tmpDir> --push`
    with `--public` or `--private` per step 5's confirmed answer.

11. **Enable Pages**: `gh api -X POST repos/<owner>/<repoName>/pages -f build_type=workflow`.
    Check GitHub's current REST API docs for this endpoint's exact shape if
    it errors — Pages-with-Actions-source payloads have changed across API
    versions and shouldn't be assumed stable from memory.

12. **Watch the deploy**: the push already triggered
    `.github/workflows/deploy.yml`. `gh run watch` (or `gh run list` +
    poll) until it finishes. On failure, fetch and read the log
    (`gh run view --log-failed`) and report what broke rather than guessing.

13. **Report back**: the live URL (`https://<owner>.github.io/<repoName>/`),
    a one-line summary of what's on it (model(s) or Reconstruction Model(s),
    axes if a comparison group, variable, tools, whether `time-series` was
    included, whether Boundary Frames are included, whether Multi-Globe was
    included and whether it starts synced — including anything
    auto-included per step 4 that the user didn't explicitly ask for), and
    a pointer to `recipe.json` in the new repo for
    anyone who wants to see exactly what was requested.

## What this is not

Don't hand-write Three.js, shaders, or a new `main.ts`/`Instance`/`UI`
triad for a generated site — that defeats the entire point of the recipe
+ generator (deterministic, tested output vs. an LLM re-deriving
domain-specific footguns like ADR-0004/0005 from scratch each time). If a
request needs something none of the four wrapper types genuinely can do,
say so and suggest it as a future enhancement to this skill/generator
rather than improvising code around it.
