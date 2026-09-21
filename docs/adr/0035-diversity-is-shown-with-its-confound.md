# Diversity is plotted next to its sampling proxy, not corrected for it

The paleobiology viewer's richness curve is raw sampled-in-bin genus counts,
drawn on the same panel as the number of occurrences and the number of
collections in each bin. No subsampling, no shareholder quorum, no correction
of any kind.

A reader who knows the field will ask why, because sampling standardisation is
what the modern literature does. This is the answer.

## The problem is real

Raw Phanerozoic richness substantially tracks how much rock survived and how
many people looked at it, not how many genera lived. That is not in dispute and
it is not something the viewer can duck: the whole point of the coral case
study is a diversity curve across four mass extinctions.

## Why not correct it

Three reasons, in order of weight.

1. **A wrong SQS is worse than an honest raw curve.** Implementing shareholder
   quorum subsampling correctly is a research task with its own validation
   burden. An unvalidated implementation would produce a curve that *looks*
   corrected, which removes the reader's ability to apply their own judgement
   while adding no trustworthy information.

2. **It introduces a knob that changes the answer.** The quorum is a tuning
   parameter. A viewer that ships one quorum silently asserts it, and a viewer
   that exposes it hands the reader a control they cannot calibrate.

3. **The confound is legible if you draw it.** Occurrences-per-bin and
   collections-per-bin are both computable from data already fetched. Drawn
   beside the richness curve on a shared age axis, the correlation is something
   the reader sees rather than something they are told was handled.

This is the same discipline as showing a map rather than asserting that two
things agree.

## What is computed, and under one rule

Everything on the panel comes from the same single-stage-assigned records the
latitude panel uses:

- **richness** — distinct genera in the bin
- **occurrences**, **collections** — the sampling proxy
- ICS stages as bins, with each record counted in **exactly one** or none

PBDB's own `occs/diversity.json` would have supplied a sampled-in-bin count
(`dsb`) plus Foote boundary-crosser categories for free, and the plan originally
said to use them. It does not, because PBDB bins by its own rule: putting its
counts and our occurrence counts on one axis would put two different
denominators on one chart. One rule, stated, beats two better ones mixed.

The cost is stated in the UI rather than buried: the caption reports how many
records resolve to no single stage and are therefore absent from the panels —
31.3% for corals, 48.6% for Panama. Those are large numbers and the reader is
told them.

## Two related decisions the same reasoning produced

- **Stage columns keep their true widths** in the latitude panel. ICS stages run
  from under 1 Myr to 21.6 Myr, and equal-width columns would hide that a long
  bin accumulates more taxa purely by lasting longer.
- **A blank is not a zero.** The Panama basin-similarity series is left empty
  where either basin has no sampled genera in a stage. Writing 0 there — which
  an earlier version did — draws a flat line through the pre-closure stages that
  reads as the strongest possible evidence for a separation nobody measured.
  Jaccard 0 means "these faunas share nothing"; no record on one side means
  nothing at all.

## Consequences

- The diversity panel is a CSV read by deep-time-map's existing
  `timeseries-panel.js`. No new widget was needed, and adding SQS later means
  adding a column, not rebuilding the panel.
- Any future claim made from this curve has to survive the sampling series
  drawn next to it. That is the intent.
