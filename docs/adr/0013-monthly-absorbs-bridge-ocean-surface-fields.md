# Atmosphere renamed to Monthly; BRIDGE's ocean-surface fields folded in

ADR-0008 split Valdes/BRIDGE into two Layers — Atmosphere and Ocean — and
deliberately left BRIDGE's monthly, single-level ocean-surface fields
(`o.pfcl*`: sea surface temperature/salinity, surface current, sea-ice
drift, barotropic streamfunction, mixed-layer depth) unassigned to either,
since they share Atmosphere's grid and axis but Ocean's physical domain.

They're folded into what was Atmosphere, now renamed **Monthly**. The
Variable rule ("share a grid and a depth range") never mentioned physical
domain — `pfcl` genuinely qualifies as more Variables of that Model, grid
and Month axis identical, same file-per-suffix stacking `load_run()`
already does for the existing atmosphere fields. What didn't qualify was
the name: "Atmosphere" stops being true the moment it carries sea surface
temperature and sea-ice drift. Renaming to Monthly — naming the axis
instead of a domain, the same move Ocean Depth's name already makes on the
other side of the split — fixes that without inventing a third Layer that
would have duplicated Atmosphere's plumbing for no structural reason.

Included, selected for being "major" rather than exhaustive: SST, SSS,
ocean surface current (a new Vector Field), sea-ice drift (another new
Vector Field), barotropic streamfunction, mixed-layer depth. Excluded:
`temp_mm_uo` (redundant with SST, and carries a units/long_name mismatch in
BRIDGE's own file — `degC` attribute, `K` in the long name), the ocean-grid
copies of sea-ice concentration/depth (redundant with the atmosphere-grid
ones Monthly already had), the single-level copy of vertical velocity
(redundant with Ocean Depth's real, depth-resolved one), and the
freshwater/salt-budget bookkeeping terms (`srfSalFlux`, `PLE`, `outflow`,
`snowfall`, `anomSaltFlux`, `interactive_waterfix`) — model-internal
correction terms, not something worth a Variable slot in a viewer.

## Consequences

Monthly now declares three Vector Fields (Wind, Ocean Surface Current,
Sea-Ice Drift) where Atmosphere declared exactly one (Wind) — see
ADR-0014 for how that's selected.
