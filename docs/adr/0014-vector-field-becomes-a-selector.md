# Vector field selection generalizes from "Wind or nothing" to a per-Layer picker

`resolveWind()` and `manifest.vector_fields?.[0]` were built when at most one
Vector Field could ever exist per Model — wind, or nothing (Pohl). ADR-0013
gives Monthly three at once (Wind, Ocean Surface Current, Sea-Ice Drift);
Ocean Depth adds a fourth, unrelated one (Ocean Current, depth-indexed
rather than single-level). `[0]` stops being a meaningful default once
there's more than one to pick from.

Decision: a single-select dropdown lists whichever Vector Fields the active
Model declares (`manifest.vector_fields`, now read in full rather than only
its first entry); exactly one is active at a time, or none. The existing
Glyph/Streak style toggle (renamed Vector Glyph/Vector Streak, see
`CONTEXT.md`) is unchanged and orthogonal — it picks *how* the currently
active field is drawn, not *which* field is active.

We explicitly rejected showing more than one Vector Field at once (e.g.
wind arrows and ocean-current arrows overlaid). Two arrow fields sharing a
globe read as noise, not signal, and every existing precedent in this
viewer (Layer, Vector Glyph vs Vector Streak) already resolves a "pick one"
question as a dropdown, not a checklist. A user wanting to compare two
Vector Fields side by side uses the existing multi-globe/tiling feature —
one globe per field — rather than the viewer inventing a second, competing
way to compare things that already has an established one.

## Consequences

Every terminology reference to "wind" that meant "the mechanism" rather
than "the specific field" is renamed to "Vector Field"/"Vector
Glyph"/"Vector Streak" (see `CONTEXT.md`) — `hasWind`, `windUTex`/
`windVTex`, and `resolveWind()`'s naming in code should follow the same
generalization when this is implemented, for the same reason Monthly
was renamed in ADR-0013: a name that overclaims domain is exactly the kind
of thing this session kept tripping over.
