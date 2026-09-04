# No-Data Style is a runtime toggle, not a fixed per-Variable convention

Every Geode viewer so far draws a cell with no value as solid grey
(`#555555`), a convention deliberate enough to be asserted by
`check:render`: SEMUCB's thin valid-depth band at 48 km is verified partly by
confirming everything outside it is exactly that grey. It works because
no-data is a small fraction of the volume in every existing Model — a
shallow trimmed shell, a polar gap.

The crustal deformation viewer's Deformation Layer variables are ~92% NaN by
construction: deformation only happens in narrow overlap zones between
differentially-moving rigid polygon groups (`defamation`'s own CONTEXT.md
term), so most of the globe genuinely has nothing to show at any given time.
Fixed grey at that fraction stops reading as "no data" and starts reading as
the dominant colour on screen, burying the actual signal — the opposite of
what the grey convention is for.

## Considered Options

**Keep the fixed grey convention, for consistency across viewers.** Rejected:
consistency in the *signifier* ("no data is drawn as X") does not require
consistency in the *chosen colour* — what makes grey work elsewhere is that
it is unmissable against a mostly-populated field, and that property inverts
when the field is mostly empty. Keeping the same RGB value here would be
consistent in name only.

**Pick one different fixed colour for this viewer** (e.g. always
transparent). Simpler than a toggle, but forecloses a real question this
session didn't resolve: whether transparent (showing the surface/coastlines
underneath), light grey (still legible as "no signal" without dominating),
or white reads best is a visual judgement call that needs the real data on
screen to make, not one to lock in from a spec.

**A runtime toggle in the UI: transparent / light grey / white.** Costs a
small material/shader change (a discard path alongside the existing
colour-fill path, or an additional uniform colour) and a control, but defers
the actual choice to when it can be judged against real Frames, and doesn't
prevent a future viewer with a different no-data density from wanting the
same flexibility.

## Consequences

No-Data Style becomes a `core/` concept (see `CONTEXT.md`), available to any
viewer, not special-cased to the deformation viewer — the mantle and climate
viewers keep defaulting to the existing fixed grey, but the toggle is not
architecturally theirs alone.

This is explicitly *not* a per-Variable manifest attribute. A Variable's
no-data pattern (how much of it is NaN, and why) is a fact about the data;
No-Data Style is a fact about how the viewer chooses to draw absence, and the
same person looking at the same Variable may want it to change mid-session
depending on what else is on screen (e.g. transparent to compare against
coastline position, grey to gauge how much of the globe is covered at all).

No `check:render` assertion exists yet for this — the existing SEMUCB grey
check is unaffected since it targets a fixed-grey Layer, but a new check
verifying all three No-Data Style modes render distinctly is follow-up work,
not part of this decision.
