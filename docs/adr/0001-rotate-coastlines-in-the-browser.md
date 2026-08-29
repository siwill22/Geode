# Rotate coastlines in the browser rather than pre-baking a GeoJSON per age

The viewer draws reconstructed coastlines at a user-chosen Reconstruction Age.
The obvious approach is to run pygplates offline over a range of ages and emit
one GeoJSON per age, leaving the client to fetch a file. We are instead
shipping the coastline geometry **once** in present-day coordinates — each
polyline tagged with its plate id, appearance age and disappearance age — plus
a table of per-plate absolute finite rotations sampled at 1 Ma, and rotating
the vertices in JavaScript at runtime.

## Considered Options

**Pre-bake one GeoJSON per age.** Trivial prep, dumb client. Rejected on two
grounds. Size: the Müller 2019 v2 low-resolution coastlines are ~1 MB gzipped
per age, so 0–250 Ma at 5 Ma spacing is ~50 MB — unacceptable for the
web-deployment goal, and 5 Ma is already a coarse increment. Correctness:
Reconstruction Age becomes quantised to the bake increment, and the obvious fix
of interpolating between two baked ages is geometrically wrong, because plates
rotate about Euler poles rather than translating linearly, and polyline
topology changes as features appear and vanish.

**Rotate in the browser.** ~2–3 MB total for every age, and Reconstruction Age
is genuinely continuous because we interpolate the *rotation* rather than the
geometry — which is the only correct way to do it in any case.

## Consequences

pygplates resolves the plate circuit to absolute rotations offline, so the
client needs no plate-hierarchy logic — only quaternion slerp and a vector
rotate. That is the main reason this is affordable: the hard part stays in
Python.

The client does take on ~100 lines it would not otherwise need, and coastline
line geometry can no longer be a single static buffer, because the set of
visible features changes with age. Allocate at maximum size and update the draw
range.

Features must be hidden outside their lifespan. Ages increase into the past, so
the appearance age is the *larger* Ma value and the test is
`disappearance_age <= t <= appearance_age`. This is easy to write inverted; see
`CONTEXT.md`.

This decision is only about coastlines. It does not extend to reconstructing
the volume itself, which is not reconstructed at all.
