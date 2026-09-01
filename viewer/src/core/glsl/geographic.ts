import { EARTH_RADIUS_KM, R_SURFACE } from '../constants';

/**
 * The world -> geographic -> texture mapping, in GLSL, written exactly once.
 *
 * Every shader that reads a raster or the volume needs this, and it used to be
 * copy-pasted into each of them: the cutaway/floor material, the globe surface,
 * the coastline lines and the land fill. The isosurface would have made a sixth
 * copy -- and that is the copy that matters, because an isosurface and the wall
 * it crosses have to agree. Half a texel of disagreement puts a blob visibly
 * beside the colour contour it is supposed to trace, which looks like a
 * rendering nuance rather than a bug.
 *
 * Interpolate GEOGRAPHIC_GLSL into a fragment shader's preamble. The functions
 * take everything as arguments and reference no uniforms, so a shader can use
 * only the parts it needs.
 */
export const GEOGRAPHIC_GLSL = /* glsl */ `
#ifndef GEODE_GEOGRAPHIC
#define GEODE_GEOGRAPHIC

const float PI = 3.141592653589793;
const float R_SURFACE = ${R_SURFACE.toFixed(1)};
const float EARTH_RADIUS_KM = ${EARTH_RADIUS_KM.toFixed(1)};

/**
 * World position -> (lon, lat) in radians.
 *
 * NOTE atan(-p.z, p.x), NOT atan(p.z, p.x). The viewer frame is (X, Z, -Y) of
 * the geographic frame -- see constants.ts. Dropping the minus sign mirrors the
 * Earth and is self-consistent enough to be invisible in blobby data.
 */
vec2 worldToGeographic(vec3 p) {
  float r = length(p);
  return vec2(atan(-p.z, p.x), asin(clamp(p.y / r, -1.0, 1.0)));
}

/** (lon, lat) radians -> equirectangular uv: the layout of every 2D raster here. */
vec2 geographicToUV(vec2 ll) {
  return vec2((ll.x + PI) / (2.0 * PI), (ll.y + PI * 0.5) / PI);
}

/** World position -> depth below the surface, in km. No vertical exaggeration. */
float worldDepthKm(vec3 p) {
  return (R_SURFACE - length(p)) * EARTH_RADIUS_KM;
}

/**
 * (lon, lat, depth) -> volume texture coordinates.
 *
 * Half-texel offsets. Longitude wraps and has no duplicate column, so it needs a
 * +0.5/nlon shift; latitude and depth include both endpoints, so they map to
 * (p*(N-1)+0.5)/N. Sampling at raw p puts every value half a cell off.
 */
vec3 volumeUVW(vec2 ll, float depthKm, float depthMin, float depthMax, vec3 grid) {
  float pLon = (ll.x + PI) / (2.0 * PI);
  float pLat = (ll.y + PI * 0.5) / PI;
  float pDep = clamp((depthKm - depthMin) / (depthMax - depthMin), 0.0, 1.0);
  return vec3(
    pLon + 0.5 / grid.x,
    (pLat * (grid.y - 1.0) + 0.5) / grid.y,
    (pDep * (grid.z - 1.0) + 0.5) / grid.z
  );
}

#endif
`;
