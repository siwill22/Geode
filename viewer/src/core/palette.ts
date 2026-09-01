/**
 * Scene colours, taken from deep-time-map so the two agree where they overlap.
 *
 * The plate boundaries are drawn by that library using its own defaults
 * (subduction #ffd8c2, ridge #ff6b6b, transform #ffc857, velocities
 * rgba(190,228,255,0.9)) and Geode does not override them. Everything Geode
 * draws underneath had been picked independently -- an olive land fill on a
 * pale blue-grey ocean -- so the boundaries sat on a background from a
 * different palette. These values put the rest of the scene in the library's
 * family: a dark navy globe with a pale cyan limb, warm accents reserved for
 * the boundaries, which is what makes them read as the annotation layer.
 *
 * Sources, all in viewer/vendor/deep-time-map:
 *   examples/globe.html:11  page background      #070c16
 *   examples/globe.html:77  the globe disc       #0d1b2e
 *   examples/globe.html:25  accent               #8fd4f0
 *   examples/globe.html:79  disc outline         rgba(143,212,240,0.25)
 *
 * LAND IS NOT FROM deep-time-map. That library draws a plain disc with no
 * continents, so there is no default to copy and this one is derived: the
 * ocean's hue lifted in value until it separates from it under the land fill's
 * own shading, which darkens it by up to half. Anything warm here would
 * compete with the boundary colours.
 *
 * The core is also not from deep-time-map and keeps its own brown -- it is the
 * one element that should not read as part of the surface palette.
 */
export const PALETTE = {
  background: 0x070c16,
  ocean: 0x0d1b2e,
  land: 0x33566f,
  coastline: 0x8fd4f0,
} as const;
