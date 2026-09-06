# A reconstruction-dependent Model's pairing can be overridden, but never casually

ADR-0017 established that the generator/wizard must not gate a combination
on perceived usefulness — only on real, declared data constraints. ADR-0004
established that a reconstruction-dependent Model's coastline pairing is
never guessed or inferred, always read from its own declared association.
Neither, on its own, settles what a *user-facing* control should do: once
the wizard offers reconstruction-independent Models (Tomography) a genuine,
correct choice of which Reconstruction Model backs their coastlines (see
CONTEXT.md's Model entry), it becomes tempting to expose that same "pick a
reconstruction" control uniformly for every Model in a selection — which
would let it silently reach a reconstruction-*dependent* Model too, e.g.
building a globe showing Valdes/BRIDGE paleoclimate data under a
reconstruction other than the one it was actually simulated on.

This is not a hypothetical the current hand-written climate viewer allows
in the first place — it has no such control anywhere, and
`resolveCoastlineSet()`'s `manifest.type`-based fallback hardcodes
Valdes/BRIDGE, Li et al. 2022, Pohl et al. 2022, and Scotese paleogeography
onto Scotese's plate model unconditionally (worth noting: this is itself a
gap relative to ADR-0004's own stated rule, since none of these Models
actually declare a `reconstruction_model` field — they predate that ADR and
were grandfathered in via the type-switch rather than retrofitted; real
follow-up work, not addressed here). The risk is specific to the *new*
wizard: it is the first thing in this codebase that would let a reconstruction
choice be a first-class, user-facing control at all, and it must not treat
every Model as equally free to have that choice made for it.

**Mantle convection (OPT1) has the identical gap, and is easy to get wrong
in the same breath as Tomography specifically because of how the code
happens to be arranged**: `resolveCoastlineSet()`'s fallback switch groups
`'tomography'` and `'convection'` in the same case, both resolving to
`archive.coastlines` (confirmed live: `opt1` also declares
`reconstruction_model: null`). That shared branch is a coincidence of the
current fallback's implementation, not a domain fact — OPT1 is
reconstruction-*dependent* (it was run on Müller 2022 specifically, per
ADR-0004's own text) exactly like climate and deformation are, while
Tomography alone is genuinely reconstruction-independent. The wizard must
classify by the actual domain rule (does this Model's own output presuppose
a specific paleogeography?), never by which switch-case branch
`resolveCoastlineSet()` happens to place a Model in today.

## The rule

A reconstruction-dependent Model's pairing is **locked by default** in the
wizard, exactly as ADR-0004 already requires the rendered viewer to enforce
it. An override is not forbidden outright — per ADR-0017, the wizard does
not get to decide the user has no legitimate reason — but it is never a
plain dropdown choice presented at the same friction level as a
reconstruction-independent Model's free selection. Requesting one must:

1. Require the user to say so explicitly (never a default, never
   pre-selected, never inferred from "well they picked a different
   reconstruction for the tomography tile, so probably here too").
2. Surface the concrete consequence before proceeding — that this Model's
   own data was produced under a specific paleogeography, and displaying it
   under a different one will show it with continents somewhere its data
   does not represent — not a generic "are you sure?".
3. Ask the user to confirm a second time after that explanation, rather
   than treating the first request as sufficient. "Overridden, but only
   after being told to think again" is the standard, not "overridden if
   asked once."

## Consequences

The wizard's implementation must distinguish, per Model, whether a
requested reconstruction differs from its own declared/implied pairing, and
route only that case through the extra confirmation step — a
reconstruction-independent Model's own reconstruction choice never touches
this path at all, since it has no "correct" pairing to override in the
first place. This is real design work for the wizard, not yet built: it
needs a way to know a climate-family Model's implied Scotese pairing and
OPT1's implied Müller 2022 pairing even though no manifest field currently
states either, which likely means either fixing the type-fallback gap noted
above (giving these Models a real
declared `reconstruction_model`) or hardcoding the same type-based knowledge
into the wizard that `resolveCoastlineSet()` already has — the former is
more consistent with ADR-0004's own rule and should be preferred if this is
built before that gap is closed some other way.
