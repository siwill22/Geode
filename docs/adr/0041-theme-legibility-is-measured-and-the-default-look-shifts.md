# Theme legibility is a measured gate, and the current look does not pass it unchanged

A Theme's only job is that its colours work *together*. That is a judgement, but
it has a measurable floor, and the floor matters here more than in most palettes
because **the four plate-boundary types are told apart by colour alone** — there
is no second channel (dash pattern, label) carrying which is which.

**Decision: a Theme fails the build if two roles that can appear together fall
below CIEDE2000 ΔE 15 under normal, deuteranopian and protanopian simulation.**
Tritanopia is reported but advisory. The check lives upstream next to the table
(ADR-0039), so both repos inherit it.

## The current palette was measured, and it does not pass

Machado et al. (2009) CVD matrices at severity 1.0 applied in linear RGB,
CIEDE2000 in CIE Lab D65:

| pair | normal | deuteranopia | protanopia |
|---|---|---|---|
| `other` `#c8d6e6` / `velocity` `#bee4ff` | **7.1** | 5.6 | 4.8 |
| `velocity` `#bee4ff` / `coastline` `#8fd4f0` | **7.7** | 5.7 | **4.5** |
| `other` / `coastline` | 12.6 | 8.1 | 5.6 |

The result is not the one expected. The warm accents are **fine** — the worst
boundary-type pair is 19.4 (subduction/transform) under normal vision and 15.0
(ridge/transform) under deuteranopia, so the red/amber confusion that looked
likely on inspection is not real. The problem is three near-interchangeable pale
blues, and it is a problem for *everyone*, not only for CVD viewers. Background
separation is not a concern anywhere: every accent clears ocean, land and page
by ΔE ≥ 42.

Two limits on those numbers, stated so they are not over-read. **Alpha is
ignored** — `other` draws at 0.55 and velocity at 0.9, so composited against a
dark ocean they separate somewhat; the direction is right, the magnitudes are
not what is on screen. And **this barely bites Geode today**, because Geode
draws no velocity arrows (ADR-0039) — the live collision here is
`other`/`coastline` at 12.6. It is StoryMaps, where all three co-occur, that
carries the real version of this.

Tritanopia is the one case where boundary types do collapse
(subduction/transform, ΔE 8.0). At roughly 0.01% prevalence that is reported,
not gated.

## The consequence, stated plainly

**The default Theme is not a byte-for-byte copy of today's look.** The pale
cluster gets nudged apart to clear the gate. A future reader comparing a
screenshot from before this change will find the coastlines and the "other"
boundary class slightly different, and that is deliberate.

The rejected alternative was to set the threshold at ΔE 12 so the existing
palette is grandfathered and nothing regresses visually. It was rejected because
it sets the bar at whatever happens to already exist rather than at what is
legible, and it would enshrine the pale-blue cluster — found by this check, and
missed by the careful hand-tuning that produced it — as acceptable.

## A second gate: Themes must differ from EACH OTHER

The rule above bounds accents *within* a Theme and says nothing across Themes.
The first nine Themes passed it comfortably while sharing, in effect, one set of
boundary inks:

| role | mean pairwise ΔE across the nine Themes |
|---|---|
| `page` | 52.9 |
| `water` | 47.3 |
| `land` | 36.5 |
| `accentHot` | 9.8 |
| `accentMuted` | **5.8** — three Themes byte-identical at `#8a9eaf` |

The substrate varied enormously and the accents varied *below the ΔE 15 floor
required inside a single Theme* — nine backgrounds, one palette. So a second
check runs: a per-role mean across all Theme pairs (floor 12), and a per-Theme-
pair mean across the five accents (floor 9), plus an exact-duplicate test.

Two things that looked like the cause and were not. **It is not the CVD gate.**
Measured directly: dropping deuteranopia and protanopia from the gate moves
mean `accentHot` variation only 10.0 → 12.0 and leaves `accentMuted` unchanged
at 9.1. **It is not an inherent limit of the colour space either.** The real
cause was tying each accent's hue to its role *name* — `accentHot` ≈ red,
`accentMuted` ≈ near-grey — which left only lightness free, and the ladder
already pins that. Loosening hue within each Theme's own authored identity
roughly doubled the variation (means now 15.4–18.1) with every Theme still
passing the within-Theme gate.

That is consistent with ADR-0040 rather than a retreat from it: character is
*relative*, so `accentHot` means "this Theme's most urgent ink", not "red".

The per-Theme-pair form matters. An earlier per-role "closest pair" rule flagged
Frost and Playroom for sharing a red — a coincidence between two Themes nobody
could confuse, since their substrates differ completely. Measuring whole ink
sets instead caught the one real case (Frost and Playroom *did* share a set at
mean 5.4, and Frost was re-authored colder and deeper) without forbidding the
coincidence.

## Consequences

- The Theme set has a **grid floor**: at least one Theme per (`lightness` ×
  `temperature`) cell, six guaranteed, plus two or three characterful extras.
  A coverage test asserts the floor, so a plain-language request can never land
  on an empty cell — which is the point of offering a quick start at all.
  Taste governs everything above the floor.
- An advisory check is not enough for this. The pale-blue collision survived
  exactly that process: careful eyes, a documented rationale, and a palette
  everyone was happy with.
- **"Roles that can appear together" is not a fixed set — it depends on the
  Theme.** A Theme with `outline: 'none'` (ADR-0038) has no coastline pen, so
  `land`/`water` must clear the threshold on its own; with a pen present, the
  outline carries the land-sea distinction and the pair need not. The gate
  therefore derives the co-occurrence set per Theme rather than hardcoding one.
- The gate is deliberately **independent of `weight`**. A thicker line really is
  easier to tell apart, so a heavy Theme could in principle pass at a lower ΔE —
  but making the threshold a function of weight trades a guarantee for a fudge
  factor, and the first Theme to sit just under the line would be the one
  arguing for it.
