# The Python viewer API generates Explorers, never Narratives

The `geode` notebook API (see `docs/plans/python-first-viewer-api.md`) exists so
a scientist with a DataFrame can get a reconstructed globe without writing
JavaScript. The question of *which* pages it should be able to produce was
settled by measuring the seven that exist.

**Decision: it generates Explorers only** — a globe, standard layers, time
slider, legend, hover, no authored narrative. Narrative pages, where scroll
position drives camera and time through a written sequence, stay hand-written.

## What the measurement showed

| page | `story.js` lines | narrative | layers |
|---|---|---|---|
| southeast-tasmania | 219 | yes | 1 |
| southern-ocean-gateways | 297 | yes | 1 |
| plate-boundaries | 579 | no | 9 |
| zircons | 583 | no | 10 |
| detrital-zircons | 908 | no | 11 |
| lips | 1003 | yes | 8 |
| tectonic-co2 | 1184 | no | 7 |

4,773 lines in total, and the plumbing genuinely repeats — `setTime` and
`prefetchAll` in 7/7 pages, `scheduleRender` 5/7, `parseHash` and
`attachCollapse` 4/7. That repetition is the whole case for generating it.

But the pages do not vary by size in any useful way. They vary by **kind**, and
the three large ones are large for three *unrelated* reasons: detrital-zircons
for bespoke pie-chart glyphs, tectonic-co2 for heavy charting with only seven
layers, lips for narrative choreography. Absorbing them would mean three
different escape hatches, and an API that is mostly hatch is a worse version of
writing the JavaScript.

## Why the line is Explorer/Narrative and not something else

An Explorer's structure is derivable from *what it displays*. Given the layers
and the data, the legend, hover, slider and deep-linking all follow. Nothing has
to be decided that the data does not already imply.

A Narrative's structure is prose plus camera choreography. Nothing about a
DataFrame implies where the reader should be looking at 200 Ma or what sentence
belongs there. It is a different authoring problem wearing the same file
extension — and supporting it would roughly double an API surface whose
smallness is load-bearing (see ADR-0048: generated code only functions as
documentation if the surface it calls is enumerable).

## Consequences

- **The stated ceiling is about four of the seven existing pages.** This is
  written down rather than left implied, so nobody later reads the API's
  inability to produce `lips` as a bug.
- `detrital-zircons` is explicitly not a target. Its pie-chart-per-sample glyphs
  are bespoke rendering on a transparent `PointLayer`, not a point dataset being
  displayed. Hand-written is the correct outcome there.
- The two case studies are zircons and plate-boundaries, which are near-twins
  (583/579 lines, one adapted from the other). That similarity is a reason to
  distrust a pass on zircons alone — plate-boundaries is the second test
  precisely because it would show whether the plumbing is genuinely common or
  merely looked common between siblings.
- Nothing here prevents a Narrative API later. It says only that it is a
  separate product with a separate surface, not a flag on this one.
