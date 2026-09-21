# A Theme governs map furniture, and never the ramp a Variable is painted with

Every viewer in the repo shares one implicit look — a navy globe, an olive-grey
land fill, pale cyan coastlines, warm boundary accents — and there was no way to
ask for a different one. Themes exist to make that look a *choice*, offered as a
handful of coherent named sets so a view can be requested in plain language
("something light and warm") instead of assembled colour by colour.

The first question a Theme raises is how far it reaches, and the answer is a hard
boundary rather than a matter of current scope: **a Theme sets the colour of map
furniture only — page, water, land, outline, boundary strokes, velocity arrows,
speed ramps — and can never touch the colour ramp a Variable is painted with.**

## Why that boundary is not negotiable

`CONTEXT.md` defines **Colour Polarity** precisely because which end of a
diverging ramp is warm encodes whether a positive anomaly is cold (a velocity
anomaly) or hot (a temperature anomaly), and it records that this cannot be
derived from the Model, the units, or the data — it is declared per Variable.

A Theme that could reach the ramp would be a decorative control wired to a
scientific one. "Make it light and warm" would then be capable of inverting what
a reader takes off the mantle, and it would do so invisibly, because a slab
rendered in the wrong polarity looks entirely plausible — the same failure mode
the vendored boundary library warns about for subduction triangles.

Keeping the boundary absolute is what makes offering eight or nine Themes safe.
A user can try every one of them, in any order, and cannot produce a wrong map —
only a map they like less. That property is worth more than the extra coherence
a ramp-aware Theme would buy.

## What follows from it

- **Themes are always available, never gated.** There is no viewer where
  furniture is absent, so unlike `time-series` (meaningless for a catalog entry
  declaring no series) a Theme is never inapplicable. It is therefore *not* a
  sixth `GlobeTool`, and a recipe cannot switch the control off — a recipe names
  only which Theme a generated site starts on. This follows ADR-0017: the
  capability is not gated on whether it seems useful for a given viewer.
- **A Theme is global to the page, like Projection — except in the theme lab.**
  It is not a Synced Field. Per `CONTEXT.md`, a Synced Field is one with an
  independent per-instance value worth broadcasting; in an ordinary viewer a
  Theme has no such value, because it is not part of what two tiled globes are
  comparing.

  `src/themelab/` is the one exception, and it is the same rule rather than a
  breach of it: the Synced Field entry says a field that *defines what is being
  compared* is never shared, and in a viewer whose subject IS the Theme, the
  Theme is that field. So it is per-instance there and deliberately has no sync
  toggle. Nothing else is expected to follow — a wrapper wanting per-instance
  Themes has to be able to say what the second palette is *for*.

  The renderer-global clear colour is a real obstacle rather than a reason: one
  canvas with `setViewport`/`setScissor` per tile (`core/layout.ts`) means
  `setClearColor` cannot differ per tile on its own. The lab gets round it by
  turning `autoClear` off and having each instance clear inside its own scissor
  rect, which is why that wrapper is the only one where it is worth the trouble.
- **The ocean is always solid, and `water` is always rendered.** The
  reconstruction-only wrappers had no surface at all: continents were drawn
  straight onto the page colour, so a Theme's `water` role went unrendered, the
  globe read as a flat cut-out, and the far hemisphere's coastlines showed
  through the near one. `core/oceanSurface.ts` is an opaque sphere at
  `R_SURFACE` carrying that role, added by default. Wrappers that already paint
  an opaque surface (a Volume raster, Valdes' relief, tomography's own sphere)
  keep it — that surface is a Model, not furniture, and a Theme must not touch
  it. Adding the ocean forced those wrappers off `LAND_R_UNDER_SURFACE`, which
  exists for land as a backdrop *beneath* a data sphere and would now bury the
  continents inside the ocean.
- **Scientific colormaps, isosurface colours and the tomography core's brown
  stay outside.** `core/palette.ts` already records that the core "keeps its own
  brown — it is the one element that should not read as part of the surface
  palette." Under Themes that stops being a comment and becomes a checked
  exception; see ADR-0040's allowlist.

## Not everything is colour: `weight` and `outline`

A first draft of this ADR closed the door on non-colour style entirely. That was
wrong, and the counter-example is concrete: a "for kids" aesthetic means thicker
boundary lines and bigger subduction triangles, and no choice of hue produces
it. Two coherent looks can differ in ink weight alone.

So a Theme carries two non-colour properties beyond `lightness`, both chosen to
be *bounded* rather than expressive, for the same reason roles beat colour slots
(ADR-0040):

- **`weight`** — a single scalar multiplying every stroke width and decoration
  size uniformly. "For kids" is roughly 1.6; a dense analytical look is 0.75.
  Because it is one multiplier it preserves the tuned ratios already in
  `DEFAULT_STYLE` (subduction 1.9 > ridge 1.5 > transform 1.3), cannot make a
  Theme internally inconsistent, and is inherited automatically by any line-
  drawing element added later. It is also uniform across mark sizes, so it
  cannot distort a size-based data encoding.
- **`outline`** — how the coastline pen relates to the land fill: `'contrast'`
  (a bright accent, today's look), `'shade'` (derived from the fill, the classic
  atlas look), or `'none'`. This was already *possible* — `land` `#33566f` and
  `coastline` `#8fd4f0` are separate values — but the relationship was fixed;
  making it a named choice is what lets an atlas look and an annotated-diagram
  look both be Themes.

`'shade'` derives its colour rather than declaring one: the land fill moved away
from the `page` colour in L\*. The direction therefore follows `lightness` — on a
dark Theme the pen comes out lighter than the fill, on a light Theme darker —
which keeps the outline readable against the page in both, and is the first real
use of the `lightness` flag beyond chrome.

Two consequences worth stating. **`outline: 'none'` changes what the legibility
gate must check** (ADR-0041): with no pen, land is separated from water by fill
alone, so `land`/`water` joins the co-occurring set for such a Theme when it
otherwise would not. And **the gate stays weight-independent** — a thicker line
is genuinely easier to tell apart, but letting a high `weight` buy a lower ΔE
threshold trades a guarantee for a fudge factor.

What stays closed is texture and idiom. Old Map is the answer to "I want a
genuinely different kind of mark", and it is a wrapper with its own renderer,
not a palette. A Theme that grows paper grain, engraving hatch or per-element
numeric knobs is a second Old Map arriving by accident; two bounded scalars are
not that.
