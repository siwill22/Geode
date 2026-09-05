/** The fixed v1 UI-tool menu a recipe's `ui.tools` can draw from -- see
 *  generator/validateRecipe.mjs's TOOL_ALLOWLIST (kept in sync by
 *  inspection; that script runs standalone under plain Node and can't
 *  import this file directly -- see its own doc comment on
 *  resolveCoastlines() for why). Shared by every wrapper type
 *  (`globe/`, `groupGlobe/`, ...) so none of them depend on each other --
 *  a generated repo only ever copies the one wrapper directory its recipe
 *  needs, plus `core/`. */
export type GlobeTool = 'legend' | 'age-slider' | 'no-data-toggle' | 'query-point';
