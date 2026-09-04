# Anchored Point's click gesture is Shift-click, disabling OrbitControls only for the held gesture

The climate viewer had no raycasting at all before Anchored Point's Month
Profile query needed a click-to-query gesture (`viewer/src/climate/main.ts`'s
own prior comment: "OrbitControls already owns 100% of pointer interaction
with nothing to fight it"). The design session that scoped this (see
`docs/plans/anchored-point-query.md`) originally planned to reuse
Ctrl/Cmd, mirroring tomography's own modifier-key convention
(`isModifier()` in `viewer/src/tomography/main.ts`) — but tomography's Ctrl
means "let me rotate DESPITE an active tool" (it *enables* orbiting),
whereas a query gesture here needs the opposite shape: "stop orbiting,
query instead." Reusing Ctrl would have made the same key mean opposite
things in two viewers of the same app. **Shift** was picked instead
specifically to sidestep that collision — it was unbound in both viewers
at the time.

`OrbitControls` is disabled only for the duration of a Shift-held pointer
gesture (`pointerdown` to `pointerup`), not via a persistent "tool mode"
the way tomography's draw/edit tools work. Because nothing else competes
for the gesture once orbiting is off, no click-vs-drag movement-distance
heuristic (tomography's own `moved > 5px` check) was needed: any pointerup
while Shift is held fires the query, regardless of how far the pointer
moved while held.

## Consequences

`OrbitControls` is re-enabled unconditionally on every `pointerup`, not
conditioned on `ev.shiftKey` being true at that exact moment — a Shift-key
release mid-drag (releasing Shift before releasing the mouse button,
switching apps) must not leave orbiting permanently disabled, and checking
the gesture's *start* state (captured implicitly by having disabled it on
`pointerdown`) rather than its end state is what guarantees that.

This is scoped to the climate viewer only. If Plate-Frame Point or another
click-driven feature lands in the tomography or deformation viewers later,
each should re-derive its own gesture rather than assume this precedent —
tomography's own pointer model (persistent tool modes, continuous drag
gestures) is different enough that Shift-only-for-the-held-gesture may not
fit there the same way.
