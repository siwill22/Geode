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

**Scope**: v1 only composes from the existing, pre-vetted data catalog
(`archive/archive.json`, served live from
`https://siwill22.github.io/Geode/archive`). It never runs the raw
`prep/*.py` pipeline or invents a colormap/clip-range/coastline pairing —
those require scientist judgment (see `prep/prep_colormaps.py`'s own
documented history of getting this wrong) and stay a human-run process.
Exactly one dataset per generated site, one wrapper type
(`single-model-globe`), and a fixed menu of four UI tools. If the request
needs more than that, say so plainly rather than attempting it.

## Prerequisites

This skill shells out to `generator/validateRecipe.mjs` and
`generator/scaffoldRepo.mjs` and copies from `viewer/src/core/`,
`viewer/src/globe/`, and `viewer/globe.html` — it needs to be run with a
checkout of the Geode repo (github.com/siwill22/Geode) available on disk.
If the current working directory isn't inside one, clone it to a temp
directory first (read-only use — never push to it).

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

3. **Decide autonomously** (no question needed) when:
   - Exactly one catalog model clearly matches the request.
   - The dataset's own `default_variable` is a reasonable fit for what the
     user asked for (most requests don't name a specific variable — that's
     fine, the model's default is a sensible choice).
   - The requested "tools" map cleanly onto the fixed v1 menu: `legend`,
     `age-slider` (only if the model has more than one frame),
     `no-data-toggle`, `query-point`. A vague request ("let me explore it",
     "add some controls") gets all four that apply; a specific request gets
     just what maps.
   - Which coastlines pair with the model — this is NEVER decided by you or
     asked of the user. It's derived automatically (see ADR-0004 and
     `core/coastlines.ts`'s `resolveCoastlineSet()`) from the manifest's own
     `reconstruction_model` field, and `generator/validateRecipe.mjs`
     computes and reports it. If you find yourself about to guess a
     coastline/rotation pairing, stop — that is exactly the mistake
     ADR-0004 exists to prevent.

4. **Ask exactly one clarifying question** when:
   - More than one catalog model plausibly matches (e.g. "the Müller model"
     matching both an age-heatflux and a deformation entry from the same
     author) — list the candidates with their `name`/`source` so the user
     can pick without needing to know the catalog's id scheme.
   - The described variable doesn't confidently match anything in the
     chosen model's manifest — list the manifest's actual `variables[].name`
     options.
   - A requested tool isn't in the v1 menu — say so, offer the closest
     available tool, and don't just drop it silently.
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

5. **Build the recipe** as a JSON object:
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
   Always use `https://siwill22.github.io/Geode/archive` as `dataHost.archiveBase`
   unless the user explicitly names a different Geode data host.

6. **Validate**: `node generator/validateRecipe.mjs <recipe.json>` (no
   third argument — let it check against the live host, per step 2's
   reasoning). On failure, read the structured errors: each one may include
   `suggestions` (near-matches) you can silently apply and re-validate, or
   may need a question back to the user (step 4). Never proceed past a
   failed validation.

7. **Scaffold**: `node generator/scaffoldRepo.mjs <recipe.json> <tmpDir>`.
   This produces a complete, standalone repo (its own `package.json`,
   `vite.config.ts`, `.github/workflows/deploy.yml`, `README.md` with
   auto-generated attribution, `LICENSE`) with no dependency on this
   monorepo beyond the files it copied.

8. **Sanity-build it locally** before publishing anything: in `<tmpDir>`,
   `npm install && npm run build`. If this fails, something is wrong with
   the generator itself (a bug, not a bad recipe — validation already
   passed) — stop and report it rather than pushing a broken repo.

9. **Create the GitHub repo**: `gh repo create <repoName> --source=<tmpDir> --push`
   with `--public` or `--private` per step 4's confirmed answer.

10. **Enable Pages**: `gh api -X POST repos/<owner>/<repoName>/pages -f build_type=workflow`.
    Check GitHub's current REST API docs for this endpoint's exact shape if
    it errors — Pages-with-Actions-source payloads have changed across API
    versions and shouldn't be assumed stable from memory.

11. **Watch the deploy**: the push already triggered
    `.github/workflows/deploy.yml`. `gh run watch` (or `gh run list` +
    poll) until it finishes. On failure, fetch and read the log
    (`gh run view --log-failed`) and report what broke rather than guessing.

12. **Report back**: the live URL (`https://<owner>.github.io/<repoName>/`),
    a one-line summary of what's on it (model, variable, tools), and a
    pointer to `recipe.json` in the new repo for anyone who wants to see
    exactly what was requested.

## What this is not

Don't hand-write Three.js, shaders, or a new `main.ts`/`Instance`/`UI`
triad for a generated site — that defeats the entire point of the recipe
+ generator (deterministic, tested output vs. an LLM re-deriving
domain-specific footguns like ADR-0004/0005 from scratch each time). If a
request needs something the fixed v1 menu or `single-model-globe` wrapper
genuinely can't do, say so and suggest it as a future enhancement to this
skill/generator rather than improvising code around it.
