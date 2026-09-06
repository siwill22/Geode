# Plate-polygon availability is two independent per-Reconstruction-Model facts, not one

Scoping Plate-Frame Point (`docs/plans/plate-frame-point.md`) and the
GPlates-style features it underlies (velocity arrows, motion paths,
flowlines, reconstructing arbitrary point data), the working assumption was
that plate-id point assignment is gated by the same fact ADR-0019 already
established for Boundary Frames — `has_boundaries` — since both seem to
need "resolved topology." Checked directly against `gprm` rather than
assumed (the same discipline ADR-0019 used for Scotese):

| Reconstruction Model | static polygons | dynamic (resolved) polygons |
|---|---|---|
| Müller 2019 | yes | yes |
| Seton 2012 | yes | yes |
| Scotese | **yes** | no |
| Müller 2022 | **no** | yes |

Scotese — which ADR-0019 established can never gain Boundary Frames —
still has static polygons and so can still support plate-id assignment.
Müller 2022 has Boundary Frames but no static polygons. The two sources
are independent of each other and of `has_boundaries`; assuming otherwise
would have repeated ADR-0019's own lesson a second time, in the opposite
direction (assuming Scotese couldn't support a capability it actually can).

## The rule

Plate-polygon availability for point-in-polygon assignment is TWO
independent, checked, per-Reconstruction-Model facts —
`has_static_polygons` and `has_boundaries`'s existing dynamic-topology
signal — never derived from each other, never assumed present or absent
based on what a Reconstruction Model's other assets look like. A catalog
entry, manifest, or UI that lists what a Reconstruction Model can do for
Plate-Frame Point must check both.

## Consequences

- This is scoping only — `prep_reconstruction.py` doesn't export either
  polygon source yet, and Plate-Frame Point remains "not scheduled" (see
  the plan doc). No manifest field exists yet; when this is built, it
  needs its own `has_static_polygons`-shaped fact alongside
  `has_boundaries`, following ADR-0021's pattern of storing per-
  Reconstruction-Model facts directly rather than inferring them.
- A reconstruction-dependent numerical Model (e.g. Cao2024-deformation)
  never gets its own separate polygon source — it uses whichever source(s)
  its declared Reconstruction Model has, the same inheritance ADR-0004
  already established for coastlines and rotations.
- Which source to prefer when a Reconstruction Model has both (static
  polygons are continuous like coastlines; resolved topology is
  discontinuous but captures actual plate reorganization) is a real
  trade-off, deliberately left open for whichever session actually
  implements Plate-Frame Point.
