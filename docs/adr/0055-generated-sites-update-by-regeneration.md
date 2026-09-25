# Generated Sites update by regeneration, not by depending on a package

`scaffoldRepo.mjs` copies `viewer/src/core/` and one wrapper directory into
every Generated Site, so each is frozen at the Geode commit it was made
from. The 2026-09 reproducibility review proposed the conventional fix:
publish `@geode/core` as a versioned npm package and have Generated Sites
depend on it.

**Decision: keep copying. A Generated Site records the Geode version it was
built from, and is updated by regenerating it from its own recipe at a newer
Geode — never by editing its files. The generator refuses to regenerate over
files that no longer match what it last wrote.**

This is ADR-0049's rule carried to the generator: the recipe is the artifact,
not the generated code, so regenerating is the natural update path. It needs
no package build, no type-declaration publishing, no registry and no release
routine, and it works unchanged in environments without registry access.
A package would add all of that to serve three Generated Sites
(`Geode-GAPWaP`, `Geode-Deformation`, a smoke test), and would still not
stop a site drifting if someone edited it by hand.

Revisit if a Generated Site ever genuinely needs hand edits the recipe
cannot express — that is the case regeneration cannot serve.
