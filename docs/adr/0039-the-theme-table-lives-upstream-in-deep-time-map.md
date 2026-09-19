# The Theme table lives upstream in deep-time-map, and each repo does its own wiring

The colours a Theme sets are not all Geode's. Of roughly nine themed colours,
**five already belong to the vendored `deep-time-map` library**: the four
boundary strokes in its `DEFAULT_STYLE` (`js/boundaries.js`) and the velocity
arrow colour in `js/velocities.js`. Geode's own four live in
`viewer/src/core/palette.ts`, whose comment records that they were chosen *to
match the library's*:

> These values put the rest of the scene in the library's family: a dark navy
> globe with a pale cyan limb, warm accents reserved for the boundaries.

So the coherence a Theme is meant to deliver already has its centre of gravity
in the library, not in Geode. Two further facts settle where the table goes:

- **Geode draws no velocity arrows at all.** The only occurrence of
  "velocities" in `viewer/src` is that comment in `palette.ts`. Velocity arrows
  are drawn by the StoryMaps pages (`zircons/js/story.js`,
  `detrital-zircons/js/story.js`), which vendor the same library —
  `boundaries.js` is byte-identical between the two copies.
- **Both halves of the palette are already overridable without touching the
  library.** `BoundaryLayer` and `VelocityField` each merge caller `options`
  over their defaults in the constructor, so themed colours can be passed in
  today at zero cost.

That last point means the question was never "can we override" but "where does
the curated table of named Themes live so it is defined once".

**Decision: the Theme table ships as plain data in `deep-time-map`, alongside
the `DEFAULT_STYLE` it generalises. Geode and StoryMaps each vendor it and do
their own wiring** — shaders, `setClearColor`, the dropdown, the CSS class.

## Why not keep it in Geode's `core/`

That was the cheaper option and matches the repo's existing habit of reaching
into the vendored library rather than changing it. It was rejected because a
Geode-local table means "warm parchment" would exist twice, once per family, as
soon as any StoryMaps page wanted Themes — and two hand-tuned copies of a
curated aesthetic drift silently, which is the exact problem Themes are being
built to fix. It would also put a velocity-arrow role in a Geode schema that no
Geode consumer can exercise, so the slot would be unverified in the repo that
defines it.

## How "upstream" actually works here

Worth stating, because it is easy to get wrong and one draft of this ADR did.

`viewer/vendor/deep-time-map` is **a git submodule** of
`github.com/siwill22/deep-time-map`, pinned at v0.7.1. `StoryMaps` vendors the
**same submodule**, pinned at v0.6.0 — the two copies differ only in which
commit each superproject points at, which is why `boundaries.js` is byte-
identical between them. Editing inside Geode's vendor directory therefore *is*
editing upstream; there is no separate copy to reconcile.

There is also a standalone clone at `~/GIT/deep-time-map`, left at v0.2.0. It is
**not** the source of truth — it is a stale checkout, five minor versions behind,
and mistaking it for upstream leads to the conclusion that this ADR's plan
requires a large backport. It does not.

So `themes.js` and `colour.js` were added in the submodule, versioned v0.8.0
there. Making that real is the ordinary submodule dance: commit and push in
`viewer/vendor/deep-time-map`, then commit the superproject's new pin. StoryMaps
picks the Themes up by advancing its own pin, whenever a page wants them.

## Consequences

- A `deep-time-map` release (v0.8.0) and a submodule-pin bump in two repos. Its
  CHANGELOG discipline covers this: consumers decide whether to update by
  reading it. **StoryMaps is untouched** — it stays on its v0.6.0 pin, its pages
  still use the library's own `DEFAULT_STYLE`, and nothing there changes until
  someone advances that pin deliberately.
- Nothing existing changes behaviour. `DEFAULT_STYLE` and the velocity defaults
  are untouched; a consumer only sees a Theme by passing a resolved style in.
- The legibility gate of ADR-0041 runs upstream too, next to the table, so both
  families inherit it rather than each re-implementing a check.
- Wiring stays per-repo and is expected to differ. Geode resolves roles into
  three.js uniforms and a renderer clear colour; StoryMaps resolves them into 2D
  canvas styles. Nothing about that is shared, and pushing it upstream would
  drag a renderer dependency into a library whose stated product is the schema.
