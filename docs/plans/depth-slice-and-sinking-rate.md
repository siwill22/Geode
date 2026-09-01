# Global depth slice, with depth as time via a sinking rate

**Status: implemented**, on the `multi-globe` branch, ahead of the plate
carrée box view this was originally bundled with -- the `None` surface mode
needed for the multi-globe work turned out to be the missing piece that made
building the slice on its own straightforward. See `viewer/src/core/depthSlice.ts`
for the sinking-rate arithmetic and the tomography/convection guard, and
`viewer/scripts/shoot.mjs`'s "depth slice:" section for the verification this
doc originally specified. Left here as the design record; the plate carrée
view can still reuse the same material path described below.

## What it is

A view mode, not another layer: paint the whole globe with the volume sampled
at one depth, hide the cutaway and isosurfaces, keep coastlines and boundaries
drawn on top. The output is a global map at depth with reconstructed tectonics
over it — the standard tomotectonic figure, and the thing GPlates users do by
setting a thin depth window and rotating to look straight down.

## Why bundle it with plate carrée rather than build it now

On a sphere, "the whole globe at depth d" is a legitimate thing to look at but
an awkward one: half of it is always facing away from the camera, so seeing
the full slice needs either rotation or an orthographic pole view, neither of
which is how the comparison is normally read. Plate carrée gives it for free —
the slice is the box's floor, seen from directly above, with no occlusion at
all. Building the slice mode first would mean re-deriving its presentation
once plate carrée lands; building it after means it needs no new decisions.

## The cheap part: the material already does this

The wall/floor material in `viewer/src/core/material.ts` differs from a depth slice
in exactly one line. It currently derives depth from world position:

```glsl
float depth = worldDepthKm(vWorldPos);
```

A slice supplies depth instead of deriving it:

```glsl
uniform float uSliceDepthKm;
// ... depth = uSliceDepthKm;
```

Everything downstream — mask, `volumeUVW`, clip, colormap, no-data grey, and
the discrete-division quantisation added for the cross-section view — carries
over unchanged. That reuse is not incidental: it is what guarantees a slice at
depth *d* shows the same colour as a cutaway wall crossing *d*, the same way
sharing `volumeUVW` already guarantees the isosurface agrees with the wall.

**Render it on the outer sphere (R = 1), not at the true radius for that
depth.** A true-radius sphere is more physically honest but sits inside the
coastlines and the boundary overlay, defeating the point of comparing the
slice against surface tectonics. Depth belongs in the readout, not the
geometry — same principle the cutaway floor already follows.

## The sinking-rate half

`depth_km = rate_cm_per_yr × age_Ma × 10` — clean because 1 cm/yr = 10 km/Myr.
Literature anchor: van der Meer et al. (2010) and the *Atlas of the
Underworld* (2018) date slabs against palaeo-trenches using a lower-mantle
sinking rate of ~1.2 cm/yr; Domeier et al. (2016) bracket 1.1–1.9 cm/yr.
Proposed default 1.2 cm/yr, slider range 0.5–3.0.

Turning it on makes the age slider drive slice depth: one control moves the
palaeo-trenches (via the existing boundary reconstruction) and the depth their
slabs should have sunk to. Geode is unusually well placed for this because
`check:render`'s check 13 already verifies 100 Ma trenches sit over cold
mantle at fixed depth — sinking rate is the same comparison with depth solved
for age instead of fixed.

### Three things that make this subtler than it looks

**Sinking mode must pin the volume to the present day.** Static tomography
*is* the present-day mantle; under sinking mode the depth axis doubles as the
time axis. A convection run (OPT1) already has real time in it, so letting one
slider move both the loaded frame and the sinking depth double-counts and
produces a figure with no coherent meaning. Restrict sinking mode to
`type: tomography` models; grey it out for `type: convection` with a stated
reason. This is the same class of trap as the existing mantle/boundary age
snapping in the time readout (`age 137.0 Ma · mantle 140 Ma · boundaries
137 Ma`) — it would look completely plausible on screen and be wrong.

**Sinking is not uniform with depth.** Slabs stall near the 660 km transition
and move faster above it, which is why the Atlas rate is specifically a
*lower-mantle* rate. Model it as two linear segments — upper-mantle rate,
lower-mantle rate, break at 660 km — with the single-rate case as the
default (upper = lower). One extra pair of uniforms, and it keeps the mode
from being quietly wrong across the top 660 km, which is where most of the
subducted material actually is.

**Spherical-geometry note, per standing project convention.** The depth
mapping itself is unaffected by sphericity: sinking is purely radial, a change
in *r* with no lateral distortion. The real assumption baked into the whole
approach is that slabs sink **vertically**, ignoring lateral advection with a
migrating trench — exactly the assumption the Atlas of the Underworld makes
when matching slabs to palaeo-trench position, so it is a defensible default,
but it should be stated in the UI copy rather than left implicit. Separately:
equal depth increments are not equal-volume shells on a sphere. Irrelevant for
display; would matter if this were ever extended to estimate subducted slab
volume from the rendered extent.

## The readout

Extends the existing time-readout line rather than replacing it, following the
precedent that silent snapping would let someone misread the state:

```
age 120.0 Ma  ·  slice 1440 km  ·  1.2 cm/yr  ·  mantle present-day
```

`mantle present-day` is the clause that stops the figure being over-read as a
120 Ma mantle snapshot.

## Verification

The fixtures already support an exact prediction, the same discipline used for
the isosurface's ramp check:

1. **`fixture-ramp` is a pure function of depth**, so a slice at depth *d* must
   render as one uniform colour across the entire globe, at the ramp's value
   for *d*. A single-colour-over-the-whole-frame test at several depths catches
   depth inversion, half-texel offsets, and sinking-rate arithmetic errors all
   in one number, the same way the isosurface's flip-depth measurement did.
2. **`fixture-check` gives 30° cells**, catching lon/lat axis swaps that a real
   dataset would hide.
3. **Agreement with the wall.** Where a cutaway wall exists at cut depth *d*,
   probe both it and the slice at the same world point and require identical
   values — the direct test that the shared material code path actually took
   effect, mirroring the existing wall/isosurface agreement check.
4. **Sinking arithmetic is pure** (`depth_km = rate × age × 10`, plus the
   660 km two-segment case) and belongs in a plain unit test, not a screenshot.
5. **The tomography/convection guard**: attempting to enable sinking mode on
   `type: convection` must be rejected or visibly disabled, not silently
   ignored.

## Cost

Roughly half the isosurface effort, and additive rather than multiplicative —
no new geometry, no new sampling path, one material variant plus UI and a
readout line. The two-segment rate and the tomography-only guard are most of
the remaining design work; the material change itself is small precisely
because Part A of the isosurface work (the shared `volumeUVW`) already paid
for it.
