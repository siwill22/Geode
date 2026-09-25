# Importing a Model is agent-run from a recorded config, with no manual steps

The generator skill used to state that the prep pipeline "requires scientist
judgment and stays a human-run process". That misread the concern. The real
risk was never that a tool makes the judgement calls — it is that those
calls go unrecorded: colour polarity was got backwards twice, by hand.

**Decision: importing a Model has no manual steps. Every judgement call
(polarity, units, depth convention, clip policy, resampling, citation, which
Reconstruction Model it is shown with) is asked as a specific question with
a default derived from the data, and the answer is written into the Model's
Ingest Config. A deterministic tool (`prep_model.py --config`) builds the
Model from that config alone. The judgement a tool cannot check is put in
front of a person as a Verification Card before anything is published; the
mechanical errors it can check — a decoded cell further than half a stored
level from its source — block the import outright.**

Import and site generation are separate skills, handing over an Archive:
one imports and stops at the card for approval; the generator consumes
approved Archives and never imports. They may be merged later if the split
proves awkward.

## Consequences

- An Ingest Config keeps two reconstruction fields apart: the one the data
  was *computed in* (a convection run has one; tomography never does) and
  the one it is *shown with* (e.g. for a sinking-slab view).
- The whole import path must run pip-only, so it works in a sandbox with no
  conda: the Verification Card is drawn with matplotlib against the
  Archive's own coastlines, with no PyGMT and no runtime map downloads.
