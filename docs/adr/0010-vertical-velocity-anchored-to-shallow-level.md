# Ocean vertical velocity anchored to the shallow level of its interface

BRIDGE's vertical velocity (`W_ym_dpth` — upward/downward flow, i.e.
upwelling/downwelling) is physically defined at 19 depth *interfaces*,
distinct from the 20-level grid temperature, salinity, and horizontal
current sit on. Confirmed directly: each interface depth is the midpoint of
the two tracer levels it sits between (e.g. the 10m interface sits between
the 5m and 15m tracer levels).

Putting it on its own 19-level grid would give the Ocean Layer two
different depth axes, contradicting the one-shared-axis-per-Model split
ADR-0008 is built on. We're instead storing it on the *same* 20-level grid
as everything else, anchored to the shallower level of each interface:
level `i`'s stored value is the flow crossing into the level below it. This
leaves the deepest level (~5193m) with no vertical-velocity value — nothing
lies below it to flux into.

This is a deliberate visual-completeness-over-physical-precision trade-off:
anchoring shallow keeps the scientifically and visually interesting
near-surface upwelling patterns (equatorial, coastal) intact, at the cost
of the physically quiet abyssal bottom losing its one value instead. The
alternative anchoring (deep) would have made the opposite trade — full
bottom coverage, no surface value — which loses more than it saves. The
half-level offset this introduces is not hidden: it's recorded in the
variable's own metadata (see `CONTEXT.md`'s Vertical Velocity entry) so a
future consumer doing something precision-sensitive (a vertical profile,
say) can correct for it instead of silently assuming co-location with
temperature/salinity/current.
