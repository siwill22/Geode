# Provenance figures carry their own honesty

ADR-0050 added `steps` — author-written testimony about what the analysis
block does. The first real use case immediately raised the next question: a
reader curious about a specific step wants to see evidence for it, not just
read a claim. `view.notebook(path, steps=[...])`'s testimony has no way to
show its work.

**Decision: `view.notebook(path, figures=[{"path": ..., "caption": ...}, ...])`
bundles static images as supporting evidence, rendered under "What the
analysis does" right after `steps`. Nothing checks a figure against `steps`,
against the view, or against anything else — the caption is the only thing
that can make the claim honest.**

## Why this needed its own decision, not just a schema field

The zircons case study's first real figures are not a demonstration case
picked for convenience — they expose the sharpest version of the problem.
Four heatmaps (mafic/felsic × convergent/rift distance-to-subduction-zone)
were built from `zircons/distance_to_subduction_zone.py`, against a whole-rock
compilation that is soon to be published and is **not** the dataset
`igneous_zircons.py` itself uses (`gprm.datasets.Zircons`, which has no
tectonic-setting field at all). Bundling those images into
`igneous_zircons.py`'s own provenance without saying so would let a reader
reasonably assume the figures are evidence for *this* notebook's *own* steps —
they are not. They are evidence for a claim about the same broader question,
made from different data, by different code, in a different repository.

This is exactly the failure ADR-0048 named for the View Script and ADR-0050
extended to `steps`: a provenance panel that looks like it covers more than it
does. A figure is worse than either of those in one respect — an image reads
as unambiguous evidence to a casual viewer in a way a sentence does not, so
the temptation to let it stand without qualification is stronger, and the
cost of not qualifying it is higher.

## Why the caption, and not a schema field, carries this

An earlier draft considered adding a `source` field — `"same"` or
`"external"` — so the host could render a warning automatically. That would
have been the wrong fix: it moves the honesty into a checkbox an author can
tick without thinking, rather than into the sentence they have to actually
write. `steps` and `requirements` already rely on the author writing true
things in plain language; `figures` keeps that same contract instead of
inventing a second, weaker one next to it.

## Consequences

- A figure with a misleading or absent caption is not caught by anything in
  this library — the same accepted cost `steps` already carries, for the same
  reason: the only honest source is the person who made the figure.
- The zircons case study's own captions state the different dataset directly,
  as the working example of what this decision requires in practice.
- `figures` sits inside the same `.notebook()` call as `steps` and
  `requirements` rather than becoming a new verb, for the same reason ADR-0050
  gave: it describes the notebook, not the view.
