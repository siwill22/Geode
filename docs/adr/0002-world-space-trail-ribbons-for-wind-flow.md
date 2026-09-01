# World-space trail ribbons for the wind flow visualization, not screen-space fade

The planned "Perpetual Ocean"-style wind visualization (Phase 4 of the
paleoclimate work) needs fading particle trails. The technique NASA's
original and earth.nullschool.net both use — draw a low-alpha black
rectangle over the whole canvas each tick, then draw new particle segments
on top — assumes the view never moves: the fade only reads as "trailing off
in place" if nothing else on screen shifts between frames. Geode's globe
orbits freely under user control, so that same technique would smear
trails sideways across the screen the instant the camera rotates, rather
than showing them following the wind.

We are instead giving each particle its own short history of 3D surface
positions and drawing a fading, tapered ribbon through them in world space,
fixed to the globe like every other overlay (coastlines, the wall, the
wind arrows it replaces in this mode). It rotates and re-projects with the
globe for free under orbit controls, at the cost of each particle carrying
a small position history instead of a single point.

## Consequences

Particle state is no longer "one position per particle" but "the last N
positions per particle" — more memory and a per-tick history shift, same
shape of cost the existing `WindGlyphs` already pays for one position each,
just larger. Camera freezing during playback (the alternative that would
have let the screen-space technique work) was rejected: it would make
orbiting-while-watching-flow, an expected interaction, silently disable
itself.
