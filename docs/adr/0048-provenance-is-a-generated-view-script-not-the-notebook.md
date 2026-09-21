# Provenance is a generated View Script, not the captured notebook

Every viewer the Python API exports carries a provenance panel, so a reader can
see how it was made and a stranger can learn the API from a published page. The
question is what, exactly, gets captured.

The obvious answer — save the notebook — is wrong, and the reason is worth
recording because it will be re-proposed.

**Decision: `export()` emits a *View Script*, generated from the calls the
`View` itself recorded. The author's notebook may accompany it, clearly
labelled as a separate thing.**

## Why not the notebook

**Notebooks execute out of order.** IPython's `In` history is execution order,
not document order, and it includes re-runs, edited-and-rerun cells, and
abandoned attempts. A reader handed that sees a log of someone's afternoon, not
a method.

Capturing the saved `.ipynb` instead gives document order, but it has to *find*
the file — fragile across Jupyter, JupyterLab, VSCode and Colab — it silently
omits unsaved cells, and it fails entirely for a plain script or a chat session.

The `View` already knows everything that shaped it. Reconstructing the script
from its own call log is faithful by construction, always available, and
identical whether the calls arrived from a notebook, a `.py` file, or a
conversation.

## A constraint this dissolves

An earlier draft of the plan asserted that a chat-driven session "must write a
file" for provenance to work. It need not. The record comes from the `View`, not
from how the `View` was driven — so chat, script and notebook all produce the
same artifact with no special handling. One less rule, and a better one.

## What it must not claim

The panel cannot contain the analysis. `gprm` is not pasteable into a tab, and
the zircon work depends on it substantially. So the View Script **names and pins
the calls it made** — *this used `gprm 0.x`'s
`Zircons.get_mafic_felsic_samples()`* — with citations, and states that it is
doing so.

This matters more than it sounds. A panel that presents itself as "the code"
while silently omitting the science implies an audit trail it does not have,
which is worse than no panel. The relevant precedent is in this repo's own
history: `tectonic_fingerprint()` and `chi_square()` were audited against the
Barham paper and **real bugs were found**. Black-box trust failed on the science
and holds fine on the plumbing — the record should be honest about which side of
that line each part sits on.

## Consequences

- **The View Script is checkable against what is on screen**, because it is
  minimal and contains only what determines the view. The notebook is not, and
  is not meant to be — it holds the wrangling and the reasoning.
- **A published viewer teaches the API.** This is the answer to the
  discoverability problem the whole exercise started from: someone who knows
  Geode can imagine what is possible, and nobody else can. A View Script on every
  published page is how a stranger finds out without asking.
- **It constrains the API surface.** A generated script only works as
  documentation if the surface it calls is small enough to enumerate — nine verbs
  today. If that grows past roughly a dozen this property quietly dies, which is
  a real cost to weigh against any proposed addition.
- The view half of the script must be re-runnable by a reader without pygplates,
  which is what the `points()` cache exists to guarantee (see the plan, §6).
