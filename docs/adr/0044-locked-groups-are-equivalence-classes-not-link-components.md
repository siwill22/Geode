# A Locked Group is an equivalence class of anchor-relative rotation, not a component of Locked Links

A Locked Group is the set of plates a Reconstruction Model moves as one mass
over a time step. The membership test is borrowed from `get_plate_motion_groups`
in the sibling `defamation` pipeline, where the same concept already drives
deformation zones — two groups moving differentially have overlapping buffered
footprints, and that overlap is where crust is created or consumed. This ADR
records which parts were taken and which were changed.

## Taken unchanged: the membership test

Two plates co-rotate over an interval if their relative rotation is the
identity. Optionally, if a threshold is set, if the **maximum possible relative
surface velocity** — the speed at 90° from the Euler pole,
`R_EARTH_CM * |angle| / delta_time_yr` — falls below it. Expressing the
threshold as a velocity rather than an angle is correct and was not re-derived:
the same Euler angle means different surface motion depending on distance from
the pole.

The default is identity-only, and measurement supports leaving it there. Group
counts barely move under a 10 000× looser threshold: 89 groups at 0 Ma at
1e-6°, 87 at ptt's own `DEFAULT_ROTATION_THRESHOLD_DEGREES` of 0.01°, 82 at
0.05°. At 100 Ma, **241 of 276 links are bit-exactly the identity rotation** —
modellers write literal zeros, so this is the model's own statement rather than
our interpretation of it.

## Changed: the grouping procedure

**A Locked Group is not the connected components of Locked Links.** A Locked
Link relates two plates *adjacent in the Plate Tree*; co-rotation relates any
two plates at all. Plate A can co-rotate with plate Q several hops away while
the plates between them move — and it must, since if A→Q is identity and A→P is
not, then P→Q is exactly the non-identity inverse. Deriving groups from links
therefore under-merges: measured at **57 groups against 59** at 50 Ma in
Müller 2019.

**Groups are defined instead by equality of each plate's own rotation relative
to the anchor over the step.** Co-rotation at threshold zero is transitive, so
this is a genuine equivalence relation and the partition is canonical —
independent of the order plates are visited in, which a prep export needs and
which representative-peeling does not provide.

It is also far cheaper: one rotation query per plate per age rather than
pairwise queries against group representatives — about 400 queries per age
instead of up to 35 000, roughly 96 k across a full 241-age export instead of
8.6 M.

**The grouping sweep must not compare only adjacent entries in sorted order.**
A first attempt sorted plates by (angle, pole lat, pole lon) and merged
neighbours. It disagreed with the exhaustive answer — reporting 16 groups where
all-pairs found 15 at 200 Ma — because stage rotations for plates in the same
group are composed along different paths, agreeing to float dust rather than
bit-exactly, so noise in a three-part sort key reorders a group's own members
and splits it. The working form sorts by angle and unions **every** pair inside
an epsilon angle window, which matches exhaustive all-pairs at every age tested
while making about 6 000 comparisons per age instead of ~80 000.

**At non-zero thresholds there is no canonical partition, and that must be
stated rather than hidden.** Co-rotation stops being transitive the moment
"identity" becomes "below a threshold": union-find chains A~B~C together when
A≁C, representative-peeling avoids chaining but depends on input order, and
neither is more correct. `defamation` can live with this because it wants one
snapshot and a knob to suppress spurious deformation zones. A reproducible
export and a Sankey that links groups across 241 ages cannot.

## A measurement artefact worth recording

The step window reaches past a model's oldest age if it runs forward there.
Rotations flatten beyond a model's range, so every plate appears locked: a
forward step at Müller 2019's `age_max` reported a single spurious **150-plate**
group where a one-sided backward step reports 78. Any per-age derived quantity
of this kind needs its window clamped at the range ends.

## Consequences

- Prep exports one Locked Group id per plate per age (~0.4 MB for Müller 2019).
  Locked Links are derived client-side as "endpoints share a group id" — the
  same fact, stored once (ADR-0042).
- Geode reimplements the membership test rather than importing `defamation`,
  which stays a separate project that Geode only ever consumes the *outputs* of
  (`prep_deformation.py --run-dir`). At the shared default of identity-only the
  two produce the same partition, so a Plate Tree's Locked Groups and a
  deformation run's rigid polygon groups are the same objects and can be
  compared directly.
- The velocity threshold is ported and documented but defaults to zero. Raising
  it is a supported choice that changes the object from a partition into the
  output of a procedure, and any UI offering it has to say so.
