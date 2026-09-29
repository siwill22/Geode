# Geode-Curiesphere: lithospheric magnetic field comparison viewer

**Status: specced (grilled 2026-09-28); core SH synthesis built and at pyshtools parity, viewer not started.**

## Context

The curiesphere repo (`~/GIT/curiesphere`, package `remit`, public, Williams et al. 2025 JGR) forward-models the lithospheric field from seafloor remanence plus continental induced magnetization. Its notebooks, and `~/GIT/vh0/notebooks/Localisation/SatelliteModelEvaluation.ipynb`, compare those models with satellite field models as static PyGMT panels, with Sandwell & Smith gravity shaded over them.

We want one interactive globe for that comparison:
- observed and forward models, side by side, as differences, and by swipe;
- live control of altitude and degree window;
- gravity and VGG overlays;
- the forward models' input layers;
- tectonic vectors;
- a spectra panel and great-circle profiles.

Nothing in Geode currently does SH synthesis, magnetic or gravity fields, or difference/swipe comparison.

## Decisions (from the grilling)

### Field representation

- **Every magnetic layer ships as spherical-harmonic coefficients.** The browser computes the grids: a Legendre sum per latitude, then an FFT per row, in a Web Worker.
- **Must match pyshtools `SHMagCoeffs.expand` to float precision:**
  - Schmidt semi-normalised, no Condon–Shortley phase;
  - Br = Σ(l+1)(a/r)^(l+2)[g cos mφ + h sin mφ]P_lm, positive outward;
  - degree window: zero every degree below lmin, truncate at lmax.
- **Components:** Br (default), Bθ, Bφ, |B|, and TMI. TMI is |F + b| − |F| in **IGRF-13 @ 2020.0**, the same main field for every model (remit `shmaggrid2tmi` / `components2tmi`).
- **Altitude = a common absolute radius r = 6371.2 km + h, with each model's own r0:**
  - Swarm MLI: 6371.2 km.
  - remit forward models: 6371.0 km.
  - LCS-1 and MF7: the published 6371.2 km. This corrects remit's 6371.0. Confirm it against the original distributed file headers, because the `_mod.cof` copies have none.
  - As a result, LCS-1 maps differ from the paper figures by about 0.6% at degree 185. That is expected; record it in an ADR.
- **Browser lmax cap = 300** for all models. Each model stops at its own maximum degree.
- **Synthesis grid:** fixed 0.25° (1441×721), bilinear for display.
- **Profiles:** evaluated exactly at the sample points, not interpolated from the grid.

### Catalogue (v1)

**Observed** (only the latest release of each):

| Model | Degrees |
|---|---|
| LCS-1 | 1–185 |
| MF7 | 16–133 |
| Swarm MLI_SHA_2C_1101 | 16–120 |
| Swarm MLI_SHA_2D_0501 | 16–133 |
| Swarm MLI_SHA_2E_0901 | 16–1500, **truncated to 300** |

**Forward** (paper presets, about 20 sets, lmax up to 300 where remit supports it, otherwise 185):
- `OCEAN_MODEL_LIST`: DAH981, LR85, HM05, M12, GK07, DAH982, DAH983, VIS. Each is ocean remanence plus Hemant2005+slabs induced.
- The `_noLIPs` variants from `notebooks/basis_models.py`.
- The 4 `manual/LIP_tests` variants: standard, RemanentLIPs, NoLIPs, InducedLIPs.
- No P×λ sweep and no separate components in v1.

### Comparison

- **Side-by-side:** Multi-Globe, reusing core `multiInstanceHost.ts` and `layout.ts`. It gets its own Synced Fields: altitude, degree window, component and colour range. The ADR-0022 rule that model choice is never synced still holds.
- **Difference A−B:** computed in coefficient space, then synthesised, with its own symmetric colour range.
- **Swipe / flicker:** on one globe, a draggable screen-space divider, and a keypress toggle between A and B.
- **Degree band:** difference, swipe, correlation and profile all clamp to the common band [max(lmin), min(lmax_A, lmax_B, slider)], and the UI says which band is in use. Side-by-side tiles show each model over the slider window with a "truncated at l=N" badge.
- **Spectra panel (global only):**
  - Lowes–Mauersberger R_l at the current altitude for A, B and A−B;
  - degree correlation between A and B;
  - the window shaded.
  - Localised spectra (Slepian or cap) are out of v1.
- **Great-circle profile:**
  - The user draws two points, and the profile is sampled along the great-circle arc by slerp. Distance is arc length on the sphere; no planar approximation.
  - It plots every loaded model's current component, plus free-air gravity, VGG and seafloor age along the arc.

### Colours

- **Paper convention:** GMT `polar` reversed, so red is negative and blue positive, over a symmetric ±cmax.
- **Auto range:** cmax is a function of the menu settings only: model(s), mode, component, altitude and degree window. It is the area-weighted global 99th percentile of |field|, rounded to a nice number. It never changes when the camera zooms or pans (decided 2026-09-29, after a view-based range was tried and dropped). For LCS-1 at 0 km this gives ±200 nT, set by the continents.
- **Range lock:** tiles can be locked to share one range.
- **Difference range:** separate from the models' range.
- **Alternatives:** vik, roma, bam and cork.
- Add these colour maps to core `colormaps.json` via `prep/prep_colormaps.py`, since there is no runtime CPT parser.

### Overlay rasters

**Sources:** both from Sandwell et al.'s SWOT release **SWOT_06** (2026-09-15, https://topex.ucsd.edu/pub/global_grav_1min_SWOT/), recorded in `GeodeViewers/Curiesphere/prep/sources.json` with their checksums.
- **Free-air gravity:** `grav_SWOT_06.nc`.
- **VGG:** `curv_SWOT_06.nc`.
- **Cite:** Yu, Sandwell & Dibarboure 2024 (*Science* 386, 1251) and Sandwell et al. 2021 (*Adv. Space Res.* 68, 1059).
- These replace grav_32.1 and curv_SWOT_03, so they differ slightly from the paper figures, which used v29.1 and v32.1.

**Resolution:**
- Global **2′** textures (10800×4800, ±80° only), greyscale, with the self-shading **baked in at prep**, equivalent to GMT `+a-45+nt2+m0`.
- A 4′ fallback when `MAX_TEXTURE_SIZE < 16384`.
- No relief and no GOCE in v1.

**Compositing:**
- Only the existing alpha-over blending.
- Each layer has its own opacity slider, plus an "overlay on top / underneath" toggle.
- Presets for both paper recipes:
  - figs 3–6: Br opaque, gravity ±60 mGal on top at 50%;
  - LIP_tests: VGG ±50 underneath, Br at 50% on top.

### Input layers

These are switchable as the primary scalar layer in place of the field, and use core `DepthSlice` with ndepth=1 and uint8 Archive frames:
- **GPTS polarity** on the age grid: categorical, `hot ±1.5`.
- **Seton 2020 seafloor age:** inferno 0–150.
- **Birth paleolatitude and paleodeclination:** polar ±90.
- **Continental VIS:** Hemant & Maus 2005 plus flat-slab.
- **Slab2 depth:** sequential 0–700 km, transparent off-slab. The source is `~/GIT/Tectonic/pgpslabs/slab2.0/sub_zones_Slab2.nc`, which has an irregular latitude axis, so regrid it at prep.

### Vector overlays

- **Existing core:** coastlines and graticule.
- **New:**
  - Müller 2016 C13y, C34, M0 and ridges (from `curiesphere/notebooks/gis/*.gmt`);
  - GSFML magnetic picks, coloured by chron;
  - GSFML fracture zones;
  - Whittaker and UTIG LIPs (via gprm);
  - Slab2 iso-depth contours every 100 km.

### Landing state

- Side-by-side **LCS-1 | GK07**, Br at 0 km, degrees 16–133.
- Free-air gravity on top at 50%, isochrons and ridges on.
- Orthographic globe.
- Sliders: altitude 0–500 km, lmax 16–300.

### Explicitly out of v1

(Point query, region View Presets and flat projections were offered and not chosen.)

- Point query.
- Region View Presets.
- Flat projections.
- Shaded relief.
- GOCE gradients.
- Localised spectra.
- Full-degree 2E.
- The P×λ sweep.
- Separate remanent/induced components.
- Paleo (time-dependent) fields.
- Browser-side forward modelling.

## Architecture

### Home

- **Repo:** `~/GIT/GeodeViewers/Curiesphere` becomes the new **Geode-Curiesphere** GitHub repo, following the one-repo-per-viewer rule.
- **App:** a hand-built Vite app on a vendored Geode `core/`, the PlateTree, Pangea and LLSVP pattern.
- **Deploy:** its own GitHub Pages, with a hub entry on the deconstructions site (live flag flipped on deploy).

### New generic core modules

These are built in Geode first, then vendored. Commit them separately from the uncommitted density and paleobio work currently in the tree, and stage explicit paths only.
- **`viewer/src/core/shSynthesis.ts`:**
  - Schmidt Legendre recursion and its derivatives;
  - kernels for Br, Bθ and Bφ;
  - a degree window, with (a/r)^(l+2) scaling;
  - grid synthesis by Legendre-per-latitude plus a real FFT;
  - exact point evaluation;
  - coefficient arithmetic: difference, and the R_l spectrum and degree correlation.
  - It runs in a worker (`shSynthesis.worker.ts`).
- **Swipe / flicker:** a screen-space split uniform on the `DepthSlice` material (`core/material.ts`), plus a toggle. This lets the climate and mantle viewers adopt swipe later.
- **Difference layer:** a helper that feeds a synthesised or decoded Float32 grid into a `DepthSlice` without uint8 Archive quantisation, since ±50 nT at uint8 gives 0.4 nT steps. Check whether `material.ts` can take a float `Data3DTexture`, and add a float path if not.
- **`Manifest.type`:** add a potential-field type in `core/types.ts` and `docs/ARCHIVE_FORMAT.md` for the input rasters, if they go through Archives.

### Viewer wrapper (Geode-Curiesphere)

- `src/main.ts`, `src/curiesphereInstance.ts` and `src/curiesphereUi.ts` (lil-gui) follow the climate wrapper pattern.
- The hillshade overlay layers copy the second-`DepthSlice`-at-`R_SURFACE*1.0006` technique (`viewer/src/climate/climateInstance.ts:116,227`).
- Spectra and profile panels: reuse `core/timeSeriesPanel.ts` styling where it fits.

### Data pipeline

1. **`curiesphere/scripts/export_viewer_coeffs.py`** (new, in the curiesphere repo). It deterministically writes every forward preset as coefficients, together with each model's r0 and lmax, plus the input grids (age, paleolat/dec, polarity, VIS). This isolates remit's in-place zeroing quirk. The output goes up as a versioned release asset on `siwill22/curiesphere` (public).
2. **`Geode-Curiesphere/prep/sources.json`** lists each input's canonical URL, version and checksum:
   - the curiesphere export;
   - ESA Swarm dissemination (MLI 2C, 2D, 2E), plus the LCS-1 and MF7 originals;
   - topex.ucsd.edu (grav 32.1, curv SWOT);
   - USGS Slab2;
   - GSFML (picks, fracture zones);
   - gprm (LIPs);
   - IGRF-13.
   Prep fetches and caches these, using local copies as a cache when present. It needs pip only, no conda, so it runs on a bare CI runner (the ADR-0054 and DETOX Archive CI pattern).
3. **Prep outputs:**
   - coefficients as compact binary (float32 is enough for the g/h values, but check parity first);
   - 2′ and 4′ overlay textures (pygmt `grdgradient`, geographic, reusing `compute_hillshade` from `prep/prep_paleogeography.py`);
   - uint8 Archive frames for the input layers (`prep/prep_model.py` helpers: `normalise_longitude`, `drop_duplicate_seam`, `encode_uint8`);
   - vectors, including Slab2 contours from `pygmt.grdcontour`.
4. **Hosting:** a data-vN release asset on Geode-Curiesphere, pulled by the deploy workflow (the generator's release-asset data host pattern). Estimated total is under 100 MB.

### Docs, written during the build (plan mode forbids writing them now)

- ADRs in Geode `docs/adr/`, starting at 0057:
  - SH synthesis in the browser, with pyshtools parity as the acceptance test;
  - the common-radius altitude definition and the r0 correction for LCS-1 and MF7;
  - comparisons clamp to the common degree band;
  - swipe as a generic `DepthSlice` capability.
- CONTEXT.md terms: Difference Field, Swipe, Overlay Raster, Degree Window, Common Band, Reference Radius.
- A plan doc in Geode `docs/plans/curiesphere-viewer.md`, pointing to the GeodeViewers build.

## Spherical-geometry notes

- **Synthesis:** exact on the sphere.
- **Profiles:** great-circle arcs with arc-length distance.
- **Slab2 and age regrids:** done on lon/lat with `-fg`. That is fine for bilinear resampling, but check the pole rows and the 0/360 seam.
- **Gravity and VGG:** undefined poleward of ±80°. Draw as No-Data there; do not stretch the texture.
- **Swipe divider:** screen-space by design. It splits the view, not the Earth.
- **CRS:** everything is geographic WGS84 lon/lat. The SH models are spherical (geocentric radius), which is standard for these products.

## Risks to check early

- **remit units:** induced VIM is VIS×nT and ocean RVIM is in A, and the two are summed directly. Verify that the forward-model amplitudes match the paper figures before presenting them next to observations. Parity with remit shows reproduction, not correctness.
- **2′ texture:** WebGL memory for 10800×4800 × 2 overlays × N globes. Share one texture across Multi-Globe tiles.
- **Worker cost:** re-synthesis time at lmax 300 on 0.25° for up to 6 tiles. Debounce the sliders, and cache by (model, component, altitude, window).

## Verification

1. **Parity test (Node, CI):** for each component, in each of 3 settings (0 km 16–133, 300 km 16–185, 10 km 16–300), compare JS synthesis of LCS-1, 2D_0501 and GK07 against pyshtools reference grids from a fixture script.
   - Br, Bθ, Bφ: max |Δ| < 1e-6 nT.
   - TMI: checked against remit `shmaggrid2tmi`.
2. **Spectrum parity:** R_l and degree correlation against pyshtools `SHMagCoeffs.spectrum` and `remit.utils.region`, globally.
3. **Show verifiable figures:** a Playwright shoot (NODE_PATH to `Geode/viewer/node_modules`, preview build, not the dev server) of the GK07 and LCS-1 SEIR region, set side by side with the corresponding vh0 SatelliteModelEvaluation PNG and paper figures 3–5.
4. **Degree band:** difference LCS-1 − 2C shows the "16–120" band label. Setting lmax to 185 must not change the difference map.
5. **Overlays:** gravity-on-top and VGG-underneath presets visually match the fig 3 and LIP_tests recipes. Gravity and VGG are blank poleward of ±80°.
6. **Leave the preview server running** on localhost for review.

## Progress

- **2026-09-28: `viewer/src/core/shSynthesis.ts`.**
  - What it does: Schmidt Legendre recursion, which carries dP/dθ and P/sinθ through the same recursions, so it is finite at the poles. Also point and grid synthesis of Br, Bθ and Bφ, the (a − b) difference across reference radii, the Lowes spectrum, and degree correlation.
  - Parity:
    - Test: `viewer/scripts/check_sh_synthesis.mjs` against a fixture from `test-data/make_sh_fixture.py` (synthetic lmax-300, LCS-1, MLI_SHA_2D_0501).
    - Points: max error about 2e-8 nT.
    - Grids: at float32 precision.
    - Spectra: about 1e-15 relative.
  - Found along the way: pyshtools' *point* evaluation of Bθ and Bφ loses precision within about 1e-4° of a pole. For LCS-1 at 89.999999°, it gives Bθ = −11.31 nT where the true value is −9.6534. That true value comes from an independent check, a 60-digit finite difference of the potential that uses no derivative recursion, and it matches the JS value to every digit. pyshtools' grid output and every other point agree with JS to about 1e-10 nT. The fixture keeps its reference points at least 0.01° from the poles, and checks the poles on the JS side.
  - Timing: Br at lmax 300 on 1440×721 takes about 1.1 s in Node, single-threaded. That confirms it needs a worker plus caching; an FFT longitude pass is the obvious next optimisation.
- **2026-09-28, later: TMI, worker, float field textures, swipe.**
  - **TMI:** follows remit's definition, T = |F + b| − |F| in IGRF-13 at 2020.0 (`totalFieldAnomaly`). That is not a projection onto the main-field direction, which is what this spec said earlier. It is written in cancellation-free form and matches remit's formula to within 3e-7 nT.
  - **Differences:** in `computeField`, Br, Bθ and Bφ differences are taken in coefficient space, which is exact. |B| and TMI are nonlinear, so their differences are map(A) − map(B) over the common band. `check_sh_client.mjs` guards this.
  - **`core/shSynthesisClient.ts` and `core/shSynthesis.worker.ts`:**
    - a worker pool, and an LRU cache of about 4 MB per 1440×721 map;
    - per-slot request merging: during a drag only the latest request runs, and a stale map is never delivered;
    - a registration generation counter, so a map computed before a re-register is dropped.
  - **`core/fieldTexture.ts`:**
    - half-float field textures normalised to the map's own span, so `material.ts` needs no float path;
    - `niceSymmetricRange`, area-weighted by cos(latitude), so the crowded polar rows don't set the range.
  - **`core/material.ts`:** swipe uniforms `uSwipeSide`/`uSwipeX` and `setSwipe()`. It is a screen-space discard that is off by default, so no existing viewer changes.
  - **`viewer/shlab.html`** (SH Lab, a bench, not a viewer): LCS-1 Br at 0 km, degrees 16–133, matches a PyGMT perspective render from the same viewpoint in pattern, position and sign.
    - Worker timing in Chromium: about 0.47 s for Br at lmax 133 on 1440×721, 1.2 s for TMI.
    - The LCS-1 − MLI 2D difference at 0 km shows north–south stripes over Australia at about ±100 nT. They are in the coefficients, since each model matches pyshtools. They look like along-track noise; which model carries them is not yet established.
- **2026-09-29: free-air gravity overlay.**
  - **Prep:** `GeodeViewers/Curiesphere/prep/prep_gravity_overlay.py` shades grav_32.1 in numpy.
    - The recipe is the paper's: grey ±60 mGal, reversed; lit from −45°; `+nt2`; ambient 0.
    - Checked against GMT's own `grdimage -A` render of a test tile: within one grey level at every pixel.
    - Deliberate difference: the gradient normalisation is global. The notebooks normalised per panel.
    - Outputs: 2′ (10800×4800) and 4′ (5400×2400) greyscale PNGs, ±80° only.
  - **`core/imageOverlay.ts`:** a 2D-texture drape, needed because DepthSlice's 3D texture is limited to MAX_3D_TEXTURE_SIZE, often 2048.
    - Mipmapped R8 texture, sampled with `textureGrad` so there is no antimeridian seam.
    - Transparent outside its latitude extent.
    - Picks the 2′ or 4′ level from MAX_TEXTURE_SIZE.
    - Loads in about 70 ms in Chromium.
  - **Findings:**
    - "Overlay on top" and "underneath" give the same image when both opacities are 0.5, since alpha-over is then symmetric. The opacities are the controls that matter.
    - The global auto range at 0 km is ±200 nT, set by continental anomalies, which makes the oceanic stripes faint. The paper uses ±50.
    - The 2′ PNG is 36.8 MB; WebP lossless barely helps (35.3 MB). WebP q90 is 20.7 MB with a mean error of 1.6 grey levels.
- **2026-09-29, later: WebP overlays, VGG, view-based auto range.**
  - **WebP:** overlays now ship as WebP at quality 90.
    - Free-air: 20.4 MB at 2′, 6.1 MB at 4′.
    - VGG (`curv_SWOT_03`, grey ±50, unshaded as in LIP_tests): 15.7 MB and 4.9 MB.
  - **Auto range:** a view-based range (a spherical cap of the part on screen) was tried and removed. The range must not move with the camera; see Colours above.
- **2026-09-29: SWOT_06 overlays.**
  - Both overlays are rebuilt from `grav_SWOT_06` and `curv_SWOT_06`. They have the same layout as before (1′, pixel-registered, ±80°) and no NaNs; land carries values, because the README's "land mask" applies to near-coast altimetry, not the output grids.
  - Sizes: free-air 18.2 MB at 2′ and 5.7 MB at 4′; VGG 14.6 MB and 4.8 MB.
