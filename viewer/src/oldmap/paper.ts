/**
 * The aged sheet the map is printed on.
 *
 * Built once into an offscreen canvas at boot and blitted each frame, because
 * none of it depends on time, camera or Projection: **the paper is page space,
 * the map is map space.** Stains and folds belong to the sheet, so they must not
 * rotate when the globe is dragged or slide when the Reconstruction Age changes
 * -- a stain that orbits with the continents reads instantly as a rendering
 * artefact rather than as a mark on a page.
 *
 * That separation is also what reconciles the Globe and flat Projections: the
 * sheet is always the full rectangle, and the Projection is merely what is drawn
 * on it. An orthographic globe becomes a disc of ink on a full page, which is
 * how an atlas plate actually looks, and Robinson's curved boundary leaves
 * corners that are simply paper -- correct, rather than a defect to mask.
 *
 * Seeded, so a given seed always produces the same sheet; nothing here calls
 * Math.random() directly.
 */

export interface PaperOptions {
  seed?: number;
  /** Base tint. Deliberately not white -- see docs/plans/old-map-viewer.md. */
  base?: string;
  stains?: number;
  folds?: number;
  /** 0 disables the darkened border. */
  vignette?: number;
  /** Strength of the paper-fibre noise, 0..1. */
  fibre?: number;
}

const DEFAULTS = {
  seed: 20260915,
  base: '#efe3c8',
  stains: 5,
  folds: 3,
  vignette: 0.42,
  fibre: 0.05,
} satisfies Required<PaperOptions>;

/** mulberry32 -- small, fast, and seeded, so a sheet is reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Render a sheet of aged paper at this pixel size.
 *
 * The caller owns the returned canvas and should rebuild it on resize -- the
 * marks are laid out in fractions of the page, so a rebuilt sheet is the same
 * sheet at a new size rather than a different one.
 */
export function makePaper(
  width: number, height: number, options: PaperOptions = {},
): HTMLCanvasElement {
  const o = { ...DEFAULTS, ...options };
  const rand = rng(o.seed);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(width));
  c.height = Math.max(1, Math.round(height));
  const ctx = c.getContext('2d')!;
  const W = c.width;
  const H = c.height;

  ctx.fillStyle = o.base;
  ctx.fillRect(0, 0, W, H);

  // --- fibre ------------------------------------------------------------
  // Per-pixel value noise, written straight into an ImageData rather than
  // drawn: a few hundred thousand tiny fillRects would take longer than the
  // rest of this function put together, for a subtler result.
  if (o.fibre > 0) {
    const img = ctx.getImageData(0, 0, W, H);
    const d = img.data;
    const amp = o.fibre * 255;
    for (let i = 0; i < d.length; i += 4) {
      const n = (rand() - 0.5) * amp;
      d[i] = clamp8(d[i] + n);
      d[i + 1] = clamp8(d[i + 1] + n * 0.95);
      d[i + 2] = clamp8(d[i + 2] + n * 0.8);
    }
    ctx.putImageData(img, 0, 0);
  }

  // --- stains -----------------------------------------------------------
  // Soft ellipses in a browner tint, at low alpha. Each is drawn as a radial
  // gradient on a scaled context so the falloff is elliptical rather than
  // circular -- a perfectly round stain reads as a lens flare.
  for (let i = 0; i < o.stains; i++) {
    const cx = rand() * W;
    const cy = rand() * H;
    const r = (0.08 + rand() * 0.22) * Math.min(W, H);
    const sx = 0.7 + rand() * 0.8;
    const sy = 0.7 + rand() * 0.8;
    const alpha = 0.05 + rand() * 0.09;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rand() * Math.PI);
    ctx.scale(sx, sy);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
    g.addColorStop(0, `rgba(146, 106, 54, ${alpha})`);
    g.addColorStop(0.62, `rgba(146, 106, 54, ${alpha * 0.55})`);
    g.addColorStop(1, 'rgba(146, 106, 54, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // --- folds ------------------------------------------------------------
  // A crease is not a line, it is a narrow band with a bright side and a dark
  // side -- the paper catches the light on one edge of the fold and shades on
  // the other. A single dark line reads as a scratch instead.
  for (let i = 0; i < o.folds; i++) {
    const vertical = rand() < 0.55;
    const at = (0.18 + rand() * 0.64) * (vertical ? W : H);
    const band = Math.max(6, 0.012 * Math.min(W, H));
    const g = vertical
      ? ctx.createLinearGradient(at - band, 0, at + band, 0)
      : ctx.createLinearGradient(0, at - band, 0, at + band);
    g.addColorStop(0, 'rgba(120, 92, 50, 0)');
    g.addColorStop(0.38, 'rgba(120, 92, 50, 0.10)');
    g.addColorStop(0.5, 'rgba(255, 250, 235, 0.16)');
    g.addColorStop(0.62, 'rgba(120, 92, 50, 0.10)');
    g.addColorStop(1, 'rgba(120, 92, 50, 0)');
    ctx.fillStyle = g;
    if (vertical) ctx.fillRect(at - band, 0, band * 2, H);
    else ctx.fillRect(0, at - band, W, band * 2);
  }

  // --- vignette ---------------------------------------------------------
  // Elliptical, reaching the corners; a circular one leaves visibly clean
  // corners on a wide page.
  if (o.vignette > 0) {
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.scale(W / Math.min(W, H), H / Math.min(W, H));
    const r = Math.min(W, H) * 0.75;
    const g = ctx.createRadialGradient(0, 0, r * 0.45, 0, 0, r);
    g.addColorStop(0, 'rgba(92, 68, 34, 0)');
    g.addColorStop(1, `rgba(92, 68, 34, ${o.vignette})`);
    ctx.fillStyle = g;
    ctx.fillRect(-W, -H, W * 2, H * 2);
    ctx.restore();
  }

  return c;
}

function clamp8(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}
