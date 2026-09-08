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

- This was scoping only at the time -- since resolved, and built:
  `has_static_polygons` is now a real per-Reconstruction-Model manifest
  field (Müller 2019, Seton 2012, and Scotese all `true`; Müller 2022 the
  one known `false`), following ADR-0021's pattern exactly as anticipated
  here. `prep_staticpolygons.py` exports the static-polygon source, and
  Plate-Frame Point is built and live in the climate viewer (ADR-0025/
  0026/0027, `docs/plans/plate-frame-point.md`).
- A reconstruction-dependent numerical Model (e.g. Cao2024-deformation)
  never gets its own separate polygon source — it uses whichever source(s)
  its declared Reconstruction Model has, the same inheritance ADR-0004
  already established for coastlines and rotations.
- Which source to prefer when a Reconstruction Model has both (static
  polygons are continuous like coastlines; resolved topology is
  discontinuous but captures actual plate reorganization) was resolved by
  ADR-0025: static polygons only, for v1 -- dynamic/resolved-topology
  assignment remains deferred, not built.
