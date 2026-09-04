# NO_DATA fills with paleogeography's shaded relief, not a flat colour or a hole

Both Valdes/BRIDGE Layers reserve a NO_DATA sentinel (ADR-0005) over
substantial parts of the sphere -- land, for every ocean-only Monthly
variable (SST, currents, sea-ice); below the seafloor or off-shelf, for
Ocean Depth. `setNoDataStyle('transparent')` was the default carried over
from prep, and it turned out to be a real bug, not just a look: `discard`
writes no depth, so wherever a NO_DATA hole opened on the near hemisphere,
Vector Streak ribbons drawn on the FAR hemisphere of the same globe (they
cover the whole sphere, DoubleSide, depthWrite:false) showed straight
through it. Distracting, and specifically what motivated this ADR.

The flat alternatives already on the shader (`grey`/`white`) fix the
depth-write problem -- they paint an opaque colour instead of discarding --
but looked exactly like what they are: a flat colour patch, not part of a
globe.

Decision: a second, always-opaque `DepthSlice` (`reliefFill`, see
valdesInstance.ts) sits a hair inside `R_SURFACE` and permanently paints
paleogeography-scotese's own `hillshade` variable -- the same shaded-relief
raster climate.html's overlay already uses, at its own highest available
resolution, reprojected/re-fetched per age exactly like that overlay is.
`field`'s own NO_DATA style stays `'transparent'` (discard); wherever it
discards, the opaque relief sphere immediately behind it is what's actually
seen. No shader change: this is pure scene composition (two spheres, normal
depth testing) rather than teaching the shared `material.ts` fragment
shader about a paleogeography-specific texture.

Consequences:
- Fixes the streak-bleed-through bug as a side effect of fixing the
  cosmetic complaint that prompted it, since both come from the same root
  cause (a discarded, non-opaque hole in the near hemisphere).
- reliefFill degrades gracefully (stays invisible) if the archive somehow
  has no `paleogeography` model; nothing crashes, the underlying hole/bleed
  bug just isn't fixed until one exists.
- reliefFill's own manifest is real paleogeography reconstructed geography,
  not blank grey -- so a NO_DATA area reads as "this Layer doesn't cover
  this ground" against a recognisable Earth, not as an unexplained gap.
