---
name: geode-globe-viewer
description: Generate a standalone, deployable Geode globe-viewer website from a plain-language request and publish it to the user's own GitHub Pages. Use when the user says something like "use Geode to create a website/viewer with model X, dataset Y, deployed to my GitHub Pages" — a request for a new, personal, no-code viewer site, not a change to this monorepo's own viewers.
---

# Geode globe-viewer generator

Turns a plain-language request into a new GitHub repo containing a minimal,
standalone globe viewer, deployed to the requesting user's own GitHub Pages.
See `docs/plans/consider-this-general-question-virtual-kay.md` for the full
design and rationale — read it if anything below is unclear or if the
catalog/tooling has visibly moved on since this was written.

**Scope**: v1.5 only composes from the existing, pre-vetted data catalog
(`archive/archive.json`, served live from
`https://siwill22.github.io/Geode/archive`). It never runs the raw
`prep/*.py` pipeline or invents a colormap/clip-range/coastline pairing —
those require scientist judgment (see `prep/prep_colormaps.py`'s own
documented history of getting this wrong) and stay a human-run process.
A fixed menu of four UI tools. Two wrapper types (see step 4a for how to
choose):
- `single-model-globe` — exactly one dataset, no comparison controls.
- `model-group-globe` — several datasets that vary along a declared catalog
  axis (which reconstruction; which role within a model family, e.g.
  Deformation vs. Age & Heat Flux), switched between via dropdowns. This is
  the common case for "let me compare model X and model Y" requests — most
  real requests for a viewer are requests to compare runs, not view one in
  isolation, so don't default to `single-model-globe` just because the user
  named one model if it's part of an obvious family (see step 2).

If a request needs something neither wrapper type can do (three+ axes, side
-by-side rather than dropdown-switched comparison, on-the-fly data prep),
say so plainly rather than attempting it.

## Prerequisites

This skill shells out to `generator/validateRecipe.mjs` and
`generator/scaffoldRepo.mjs` and copies from `viewer/src/core/` plus
whichever wrapper directory the recipe needs (`viewer/src/globe/` +
`viewer/globe.html` for `single-model-globe`; `viewer/src/groupGlobe/` +
`viewer/groupGlobe.html` for `model-group-globe`) — it needs to be run with
a checkout of the Geode repo (github.com/siwill22/Geode) available on
disk. If the current working directory isn't inside one, clone it to a
temp directory first (read-only use — never push to it).

The `gh` CLI must be authenticated as the user who will own the new repo
(`gh auth status`); if not, stop and ask the user to run `gh auth login`.

## Step by step

1. **Parse the request** into: which model(s)/author the user named, a
   description of the variable/dataset they want, which "tools" they asked
   for, and a desired repo name (if given).

2. **Fetch the live catalog**: `GET https://siwill22.github.io/Geode/archive/archive.json`,
   and each candidate model's own `manifest.json` (`archive.json`'s
   `models[].path`, same base URL). Match the user's wording against
   `models[].id`, `models[].name`, `models[].source`, and each manifest's
   `variables[].id`/`.name`. Do NOT use a local `archive/` directory even if
   one exists in the checkout — it can be ahead of what's actually
   deployed (this bit a real test: a model present locally 404'd against
   the live host). The live catalog is always the source of truth for what
   a generated site can actually show.

   Also check each candidate's `reconstruction_model` and `comparison_role`
   fields (both on `archive.json`'s own model summary, no extra fetch
   needed). If the model the user named shares one of these with other
   catalog entries, that's a signal a comparison group exists — e.g. a
   request naming "Cao2024 deformation" will find `cao2024-deformation`
   shares `reconstruction_model: "Cao2024"` with `cao2024-age-heatflux`,
   and shares `comparison_role: "Deformation"` with
   `muller2019-deformation`. Surface this rather than silently picking the
   one named model — see step 4a.

3. **Decide the wrapper type and dataset set**:
   - If the request names or clearly implies more than one model run (e.g.
     "compare X and Y", "let me switch between reconstructions", or simply
     names a model that's part of an obvious family per step 2), use
     `model-group-globe`. Assemble `datasets` as the FULL grid: every
     combination of the distinct `reconstruction_model`/`comparison_role`
     values involved, not just the ones the user explicitly named — a
     partial grid is rejected by the validator (step 7), and a dropdown
     offering a combination that 404s is worse than not offering it. If
     the user only named "Cao2024 deformation" but that family also has an
     Age & Heat Flux role, that's exactly the "family member not
     explicitly named" case in step 5 below.
   - Otherwise, use `single-model-globe` with the one matched model.

4. **Decide autonomously** (no question needed) when:
   - Exactly one catalog model clearly matches the request (single-model
     case), or the full grid a comparison group implies is unambiguous
     (group case).
   - Whether an unmentioned family member (e.g. Age & Heat Flux when the
     user only said "deformation") should be pulled into the group
     automatically: default to YES, including the whole family — a
     comparison viewer that's missing a role the user didn't think to
     exclude is a smaller failure than a silent, narrower site than they
     expected. Mention what was included when reporting back (step 12).
   - The dataset's own `default_variable` is a reasonable fit for what the
     user asked for (most requests don't name a specific variable — that's
     fine, the model's default is a sensible choice).
   - The requested "tools" map cleanly onto the fixed v1 menu: `legend`,
     `age-slider` (only if at least one dataset in the group has more than
     one frame — see `validateRecipe.mjs`'s check), `no-data-toggle`,
     `query-point`. A vague request ("let me explore it", "add some
     controls") gets all four that apply; a specific request gets just
     what maps.
   - Which coastlines pair with each model — this is NEVER decided by you
     or asked of the user. It's derived automatically (see ADR-0004 and
     `core/coastlines.ts`'s `resolveCoastlineSet()`) from the manifest's own
     `reconstruction_model` field, and `generator/validateRecipe.mjs`
     computes and reports it. If you find yourself about to guess a
     coastline/rotation pairing, stop — that is exactly the mistake
     ADR-0004 exists to prevent.

5. **Ask exactly one clarifying question** when:
   - More than one catalog model plausibly matches a name the user gave and
     it's genuinely ambiguous which one (not just "part of an obvious
     family", which step 3/4 resolve by including the whole family) — list
     the candidates with their `name`/`source` so the user can pick without
     needing to know the catalog's id scheme.
   - The described variable doesn't confidently match anything in the
     chosen model's manifest — list the manifest's actual `variables[].name`
     options.
   - A requested tool isn't in the v1 menu — say so, offer the closest
     available tool, and don't just drop it silently.
   - A `model-group-globe` candidate set doesn't form a complete grid and
     there's no obvious way to complete or narrow it automatically (this
     should be rare — step 3 already assembles the full family — but if the
     catalog itself has a gap, e.g. one reconstruction is missing a role
     entirely, ask rather than guess what the user would want).
   - No repo name was given, or the name collides with one that already
     exists in the user's account (`gh repo view <name>`, expect it to
     fail with "not found" for a free name).
   - **Always**, before creating anything: confirm public vs. private repo
     visibility. This is the one guaranteed round-trip even on an otherwise
     unambiguous request — don't skip it because everything else was clear.

   Ask ONE question covering everything unresolved at once, not one round
   trip per issue. A same-author, different-type catalog collision is
   normal and expected, not a sign something is wrong — say plainly that
   this is the one case where a fully "one-shot" result isn't realistic.

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
       { "modelId": "cao2024-deformation" }, { "modelId": "cao2024-age-heatflux" },
       { "modelId": "muller2019-deformation" }, { "modelId": "muller2019-age-heatflux" }
     ],
     "ui": { "tools": ["legend", "age-slider", "no-data-toggle", "query-point"] },
     "dataHost": { "archiveBase": "https://siwill22.github.io/Geode/archive" }
   }
   ```
   Always use `https://siwill22.github.io/Geode/archive` as `dataHost.archiveBase`
   unless the user explicitly names a different Geode data host.

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
   (`globe/` or `groupGlobe/`, per `wrapperType`) plus `core/`.

9. **Sanity-build it locally** before publishing anything: in `<tmpDir>`,
   `npm install && npm run build`. If this fails, something is wrong with
   the generator itself (a bug, not a bad recipe — validation already
   passed) — stop and report it rather than pushing a broken repo.

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
    a one-line summary of what's on it (model(s), axes if a comparison
    group, variable, tools — including anything auto-included per step 4
    that the user didn't explicitly ask for), and a pointer to
    `recipe.json` in the new repo for anyone who wants to see exactly what
    was requested.

## What this is not

Don't hand-write Three.js, shaders, or a new `main.ts`/`Instance`/`UI`
triad for a generated site — that defeats the entire point of the recipe
+ generator (deterministic, tested output vs. an LLM re-deriving
domain-specific footguns like ADR-0004/0005 from scratch each time). If a
request needs something neither wrapper type genuinely can do, say so and
suggest it as a future enhancement to this skill/generator rather than
improvising code around it.
