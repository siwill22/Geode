# Valdes/BRIDGE gets its own viewer instance, not a slot in the climate viewer

Valdes/BRIDGE (`climate-bridge-valdes2021`) has so far been one of three
selectable models in `climate.html`'s Layer dropdown, alongside Li et al.
2022 and Pohl et al. 2022. We're now adding its depth-resolved ocean fields
(temperature, salinity, current, all at 20 real depth levels, annual mean
only) on top of the existing month-indexed atmosphere fields it already
ships (T, P, MSLP, sea ice, wind).

Forcing both families into the one `climate-bridge-valdes2021` Model would
break `CONTEXT.md`'s own Variable rule — "Variables of a Model share a grid
and a depth range" — since Month (13 layers, every Frame) and Ocean Depth
(20 levels, annual only) share neither. The two families have to be
separate Models, and therefore separate Layers.

We're going further than the minimum fix, though: rather than add a second
Valdes Layer next to the existing one inside `climate.html`, Valdes/BRIDGE
moves to its own dedicated instance — a thin wrapper over the shared core
engine, same as every other Geode viewer — with Atmosphere and Ocean as
its two Layers, and is removed from `climate.html`'s picker entirely: this
is now the sole home for any Valdes/BRIDGE output. Reasons:

- `climate.html`'s cross-source Layer list (Li vs Pohl) stays free of a
  third source whose axis semantics (depth-as-month) don't match either.
- One home for Valdes data means one call site to update the next time this
  dataset changes (a real cost paid twice already in this dataset's short
  life — see the cache-collision fix that preceded this decision — once for
  the fetch/prep pipeline, once again for the viewer if it lived in two
  places).
- It leaves room to grow Valdes-specific UI (a real depth slider, an ocean
  current vector field, whatever else "just the BRIDGE outputs" wants)
  without those choices leaking into or being constrained by the
  Li/Pohl-comparison use case `climate.html` exists for.

## Explicitly deferred, not resolved

BRIDGE also ships ocean-surface fields (top-level temperature, surface
current, sea-ice drift, mixed-layer depth) at monthly resolution, single
level — the *grid* of Atmosphere but the *physical domain* of Ocean. They
fit neither Layer cleanly and are left out of both for now. Whether they
become a third Layer, get folded into Atmosphere despite the domain
mismatch, or something else, is an open question this decision does not
answer.

## Consequences

Any existing link or workflow pointing at Valdes-in-`climate.html` breaks.
Nothing in this repo currently treats that URL as a stable, external
contract, so this is accepted rather than mitigated.
