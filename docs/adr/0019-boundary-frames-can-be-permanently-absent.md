# A Reconstruction Model's Boundary Frames can be permanently absent, not just unexported

Scoping a reconstruction-comparison viewer (compare Müller 2019's own
continent polygons and resolved topologies against Scotese's own continent
polygons, no numerical Model involved) raised the question of what it means
for a Reconstruction Model to "not have" Boundary Frames yet. `archive.json`
today exports Boundary Frames (see `Boundary Frame` in `CONTEXT.md`) for
Müller 2022 only — everything else, including Müller 2019, looked like a
todo: run `prep/check_boundaries.py`'s underlying export for it too and the
gap closes.

That assumption is wrong for at least one real Reconstruction Model, checked
directly rather than assumed: `gprm.datasets.Reconstructions.fetch_Scotese()`
returns `dynamic_polygon_files: []` — no topological plates, ever. Only
`static_polygon_files`/`continent_polygons_files` are populated: present-day
continents, rotated back through time by absolute rotation, nothing else.
There is no export to run that would give Scotese Boundary Frames, because
the source reconstruction itself never resolved plate topologies in the
first place. This is a property of the Reconstruction Model, permanent, not
a state Geode's own prep pipeline happens not to have reached yet.

## The rule

A Reconstruction Model's two assets — coastline geometry and Boundary
Frames — are independently optional, and "has Boundary Frames: no" must be
represented and checked as a real, per-Reconstruction-Model fact, never
assumed to be a temporary gap that more prep work eventually closes for
every entry. Every Reconstruction Model that reaches the catalog has
coastline geometry; not every one has, or ever will have, Boundary Frames.

## Consequences

Any catalog metadata that lists Reconstruction Models (see ADR-0020) must
carry a nullable Boundary Frame pointer per entry, not a boolean "exported
yet" flag that implies eventual completion. Any UI offering a Reconstruction
Model that lacks Boundary Frames must say so plainly (no topology available
for this model) rather than framing it as "coming soon" — for Scotese
specifically, and for any future Reconstruction Model whose own source
turns out to be reconstruction-only with no topological plates, it never
will be.
