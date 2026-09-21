# Analysis steps are author-written, not derived

The provenance drawer already had two tiers with real content: `requirements`
(how to set up an environment to re-run the notebook) and the View Script (the
exact `geode` calls that built the viewer, generated from `View`'s own call
log). Neither says what the notebook's own *data block* actually does — fetch,
filter, classify, whatever it really is. A reader asked for exactly that: a
concise account of the analysis, before diving into either the setup steps or
the raw notebook.

The obvious next move is to generate it, the same way the View Script is
generated. That is wrong here, for a reason worth recording because a
reasonable-sounding version of it will be re-proposed.

**Decision: `view.notebook(path, steps=[...])` takes an optional, author-written,
one-line-per-step account of the analysis. Nothing about it is derived from the
notebook, the data, or the `View` object.**

## Why not derived

The View Script can be generated faithfully because `View._log` records every
call `View` actually received — the mechanism is sound because the thing being
summarised is fully inside `View`'s own knowledge (see ADR-0048).

The data block is not. It is arbitrary pandas/numpy/domain code that runs
*before* a single `geode` verb is called, and `View` never sees it — not the
source, not the DataFrame's history, not the reasoning behind a filter
threshold. There is nothing inside this library to derive a summary from. The
only two ways to get one anyway are to parse the notebook's own source or
prose (fragile, and liable to misdescribe what a cell actually does the moment
it is edited without re-running) or to have something summarise it
semantically (a claim about correctness this library has no way to back up).
Either one risks exactly the failure ADR-0048 already ruled out for the View
Script: a panel that looks like it audited something it did not.

The only source that can honestly characterise arbitrary code is the person
who wrote it. So `steps` is opt-in author testimony, the same shape as
`requirements` — a plain list of strings, rendered as a numbered list, absent
entirely if the author supplies none.

## Why a kwarg, not a verb

`View`'s verb surface is capped near a dozen so that a generated View Script
still teaches the API by being readable end to end (ADR-0046). `steps`
describes the notebook, not the view, so it was added to the existing
`.notebook()` call rather than as a new verb — consistent with how
`requirements` was added the same way.

## What it must not claim

`steps` sits inside "Reproduce this yourself," not "View Script," and nothing
about its wording implies it was checked against the actual code. It is
testimony, offered because the alternative — nothing at all — leaves a curious
reader with no way to understand the analysis short of reading it line by
line.

## A case this was validated against, and one it was not

Validated on `GeodeViewers/IgneousZircons/igneous_zircons.py`: a real but
modest analysis (fetch, normalise, filter to <=1000 Ma, bin for a histogram —
four steps). A richer real pipeline exists —
`StoryMaps/detrital-zircons/build/build_detrital_zircons.py` — collapsing grain
rows to samples, two separate reconstructability filters, a lag-time histogram,
and two classifiers (Cawood, Barham) called directly into `gprm`. That viewer
predates `petrify`/`geode`'s Python API entirely (hand-written `build/*.py` +
JS, no `view.json`), so `steps` has nowhere to attach on it yet. Migrating that
viewer onto `geode`'s API — and writing its real `steps` list — is separate,
future work, deliberately not bundled into landing this mechanism.

## Consequences

- `steps` can misrepresent the analysis if the author lets it drift from the
  code (unlike the View Script, nothing keeps it in sync automatically). That
  is the accepted cost of the only honest source being testimony rather than a
  derivation.
- A page with a genuinely rich analysis and no `steps` is not a bug — the
  field is opt-in, and an absent section is the correct behaviour for an author
  who has not written one yet.
