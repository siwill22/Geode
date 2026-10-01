# Three defaults for every Geode viewer: age at the bottom, flat maps turn, a projection button

The user set three defaults for **any** Geode viewer. They are recorded here
so a new viewer starts from them and an existing one can be brought into line
deliberately, rather than each copying whichever neighbour it was modelled on.

## The three defaults

1. **The age slider sits at the bottom of the screen, apart from the settings
   panel.** Use the existing pattern, not a new one: a `.bottom-bar` holding an
   `.age-slider-wrap` (a native range input) and an `.age-readout` ("N Ma"),
   as in `reconstruction.html`, `climate.html` and `valdes.html`. The settings
   panel (top right) holds what is shown, not when.
2. **In a flat projection (Robinson, Plate Carrée, and any similar one), a
   sideways drag moves the map's centre longitude**, rather than sliding the
   whole map left/right/up/down. OrbitControls' own pan is switched off in flat
   mode (`controls.enablePan = false`); zoom is unchanged. The shared drag is
   `core/mapOrientationDrag.ts`'s `wireMapOrientationDrag()`; its
   `longitudeOnly` option turns the drag into a turn about the pole (the
   equator never tilts), and `horizontalWheel` lets a sideways trackpad scroll
   do the same while an up/down scroll still zooms. Every layer must move
   together: rasters, coastlines, graticule, points and any other overlay, and
   picking must keep hitting what is drawn.
3. **Projection is switched by its own round button** showing the next
   projection as a small stylised graticule (`core/projectionToggle.ts`'s
   `wireProjectionToggle()` on a `#projection-toggle` button), not by a
   dropdown in the settings panel.

## Why

- Age is the one control used constantly while looking at the map; buried
  among layer settings it is the hardest to reach, and it collides with the
  panel growing and shrinking as layers are added.
- Sliding a world map leaves half the screen empty and breaks the world at an
  edge the reader did not choose. Turning it keeps the whole Earth on screen
  and lets the reader put the region they care about (say the Pacific at
  150°E) in the middle. Turning only in longitude keeps the poles at the top
  and bottom, which is what readers of a Robinson map expect.
- A projection button with a picture of the projection is understood without
  reading, and is the same everywhere.

## Which viewers already follow them (checked 2026-10-01)

| viewer | age at bottom | flat drag turns centre longitude | projection button |
|---|---|---|---|
| `riftsclimate.html` | yes | yes (longitude only, plus sideways scroll) | yes |
| `reconstruction.html` | yes | turns, but a full free drag (centre latitude and tilt too), not longitude only | yes |
| `reconstructionGroup.html` | yes | as reconstruction.html | yes |
| `climate.html` | yes | **no** (flat maps pan) | yes |
| `valdes.html` | yes | **no** (flat maps pan) | yes |
| `paleobio.html` | **no** (panel) | **no** (flat maps pan) | **no** (dropdown in panel) |
| `oldmap.html` | **no** (panel) | **no** (pan is off, but no centre-longitude drag) | yes |
| `index.html` (mantle) | **no** (panel) | globe only | globe only |
| `globe.html`, `groupGlobe.html` (generated) | **no** (panel) | globe only | globe only |
| `themelab.html`, `shlab.html` | benches, not viewers; not assessed | | |

None of the non-complying viewers was changed with this decision; each is a
separate piece of work. Generated sites copy these wrappers
(`generator/scaffoldRepo.mjs`), so they follow the defaults only once their
wrapper does.

## Consequences

- `wireMapOrientationDrag()` gained an optional fourth argument. Leaving it
  out, as every existing caller does, keeps the full free drag exactly as
  before.
- The raster shader (`core/material.ts`) already turns a flat map's display
  position back to a true one through its rotation uniform (the Reference
  Plate path, ADR-0030), so rasters follow a turned map with
  `DepthSlice.setReferenceRotation(toRenderFrameRotation(q))`; no shader
  change was needed. As reconstructionInstance.ts warns, the rotation must be
  identity while on the globe.
- A viewer adopting default 2 needs every one of its overlays to take the same
  orientation; a layer that does not will visibly slide against the others,
  which is the check to make.
