# The Explorer's recipe is data, and it ships in the viewer

The obvious way to build a viewer generator is to generate code. Take the calls the
user made, emit a `story.js`, write it next to an `index.html`. Every template-based
site generator works that way, and it is the first thing anyone reaches for.

**Decision: `geode.export()` emits no JavaScript at all. It writes `view.json` — a
recipe — which a single shared host module (`deep-time-map/js/explorer.js`) reads at
run time.**

## Why not generate the JavaScript

Three reasons, in increasing order of how much they cost later.

**A bug fix would have to be re-exported.** Generated code is a snapshot. A fix to
the frame-coalescing in `scheduleRender` reaches every recipe-driven viewer by
advancing a pin and re-copying `lib/`; it reaches every *generated* viewer only by
re-running someone's notebook, which needs their data, their conda environment and
them. For an artifact whose whole point is that it outlives the session that made it,
that is the wrong shape.

**The generator would have to be a compiler.** Emitting readable JavaScript from a
Python call log means owning formatting, scoping, name collisions and escaping. That
is a large, dull, permanently half-finished job, and every hour spent on it is an
hour not spent on the thing the API is for.

**Nobody could edit the result.** This is the one that actually matters. A generated
`story.js` is 600 lines a reader has to read before they dare change a colour. A
recipe is a flat object where the colour is called `colours`. Editing it and
reloading is a real workflow that needs no Python, no build step and no
understanding of the renderer — which is exactly the promise made to whoever is
handed the directory.

## The recipe is a published surface, not an implementation detail

`view.json` sits at the top of the exported directory, is documented in
deep-time-map's `SCHEMA.md`, and is version-stamped (`"explorer": 1`) and *checked* —
a recipe from a later release fails loudly rather than rendering three quarters of
itself.

This is what makes the provenance drawer (ADR-0048) honest rather than decorative.
The drawer shows the View Script; the recipe beside it is what the script produced.
A reader can check one against the other. With generated JavaScript the drawer would
be showing Python that claims to have produced 600 lines of code nobody is going to
audit.

It also makes the stated ceiling (ADR-0046: Explorers, never Narratives) enforceable
rather than aspirational. There is no hook where a Narrative could quietly grow,
because there is no generated code to grow it in. The one hatch is `styleJs`, which
is deliberately narrow: a module supplying one point's style, nothing else.

## Consequences

- **Layer order is draw order, stated in the recipe.** "What sits on top of what" is
  a decision the artifact records rather than one buried in the host. Velocity arrows
  over boundaries because where a fast plate meets a trench the arrow is what you
  want to read against the triangles; points over both because they are the only
  interactive layer and a symbol you cannot see you cannot click.

- **Colours can be Theme tokens, not just literals.** `"@boundary.subduction"`
  resolves against the active Theme, so a chart row annotating a map line stays the
  same colour as that line when the Theme changes. A hex literal would silently stop
  matching — which is a real failure mode, since nothing would look broken.

- **The host must not accumulate per-page special cases.** The recipe is the pressure
  valve: anything that looks like it wants a branch in `explorer.js` keyed on the
  page is a sign it should be a recipe field or a `styleJs`. This is the rule the
  design fails by violating, so it is worth naming.

- **Every viewer carries a copy of `lib/`.** About 200 kB of ES modules per exported
  directory, against a payload measured in tens of megabytes. The duplication is the
  price of "works offline, no CDN, no build step", and at that ratio it is not a
  trade worth agonising over.
