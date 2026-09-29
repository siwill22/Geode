/**
 * SH Lab: a bench for the browser-side spherical-harmonic pieces in core/
 * (shSynthesis, its worker client, fieldTexture, the material's swipe) before
 * any viewer uses them. Not a viewer: no Archive, no coastlines.
 *
 * Coefficients come from the parity fixture (test-data/make_sh_fixture.py),
 * fetched from ?fixture=<url> (default ./sh-fixture.json). Everything the
 * page is showing is mirrored on window.__shlab for the render check.
 *
 * URL parameters (all optional): a, b (model ids), mode (single | difference
 * | swipe), component, alt (km), lmin, lmax, lon, lat (camera centre),
 * swipe (divider position 0..1 of the width), dist (camera distance in Earth
 * radii), overlay (name of an overlays/<name>.json, e.g. freeair), ovOpacity,
 * ovOrder (top | under), fieldOpacity.
 */
import { Scene, WebGLRenderer, type PerspectiveCamera } from 'three';
import GUI from 'lil-gui';
import { createProjectionCamera, createProjectionControls } from '../core/projection';
import { DepthSlice } from '../core/depthSlice';
import { setSwipe } from '../core/material';
import { makeColormapTexture } from '../core/volume';
import {
  bindFieldTexture, makeFieldTexture, niceSymmetricRange, setFieldRange, type FieldTexture,
} from '../core/fieldTexture';
import { ShSynthesisClient } from '../core/shSynthesisClient';
import { ImageOverlay, chooseOverlayLevel, loadOverlayTexture, type Extent } from '../core/imageOverlay';
import { R_SURFACE } from '../core/constants';
import type { FieldComponent, FieldResult, FieldSpec, ShCoeffs } from '../core/shSynthesis';

const R_REF = 6371.2e3;
const GRID = { nlon: 1440, nlat: 721 };
const q = new URLSearchParams(location.search);
const status = document.getElementById('status')!;
const divider = document.getElementById('divider')!;

/** GMT polar, reversed -- red negative, blue positive, the curiesphere
 *  figures' convention. */
function polarReversed(n = 256): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    out.push(t < 0.5
      ? [255, Math.round(510 * t), Math.round(510 * t)]
      : [Math.round(510 * (1 - t)), Math.round(510 * (1 - t)), 255]);
  }
  return out;
}

const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(0x0b0d10);
document.body.appendChild(renderer.domElement);

const camera = createProjectionCamera('globe', innerWidth / innerHeight) as PerspectiveCamera;
const controls = createProjectionControls('globe', camera, renderer.domElement);
{
  const lon = (Number(q.get('lon') ?? 115) * Math.PI) / 180;
  const lat = (Number(q.get('lat') ?? -50) * Math.PI) / 180;
  const d = Number(q.get('dist') ?? 3.2);
  camera.position.set(d * Math.cos(lat) * Math.cos(lon), d * Math.sin(lat), -d * Math.cos(lat) * Math.sin(lon));
  camera.lookAt(0, 0, 0);
}

const scene = new Scene();
const ramp = makeColormapTexture(polarReversed());
const sliceA = new DepthSlice();
const sliceB = new DepthSlice();
for (const s of [sliceA, sliceB]) {
  s.material.uniforms.uColormap.value = ramp;
  scene.add(s.mesh);
}
const overlay = new ImageOverlay();
scene.add(overlay.mesh);

const view = {
  a: q.get('a') ?? 'LCS-1',
  b: q.get('b') ?? 'MLI_2D_0501',
  mode: (q.get('mode') ?? 'single') as 'single' | 'difference' | 'swipe',
  component: (q.get('component') ?? 'br') as FieldComponent,
  altitudeKm: Number(q.get('alt') ?? 0),
  lmin: Number(q.get('lmin') ?? 16),
  lmax: Number(q.get('lmax') ?? 133),
  swipe: Number(q.get('swipe') ?? 0.5),
  autoRange: true,
  cmax: 50,
  overlay: q.get('overlay') ?? 'none',
  ovOpacity: Number(q.get('ovOpacity') ?? 0.5),
  ovOrder: (q.get('ovOrder') ?? 'top') as 'top' | 'under',
  fieldOpacity: Number(q.get('fieldOpacity') ?? 1),
};

const shlab: Record<string, unknown> = { view, ready: false };
(window as unknown as { __shlab: unknown }).__shlab = shlab;

const client = new ShSynthesisClient();
let texA: FieldTexture | null = null;
let texB: FieldTexture | null = null;
let generation = 0;

function spec(model: FieldSpec['model']): FieldSpec {
  return {
    model, component: view.component, r: R_REF + view.altitudeKm * 1e3,
    window: { lmin: view.lmin, lmax: view.lmax }, grid: GRID,
  };
}

function place(slice: DepthSlice, res: FieldResult, old: FieldTexture | null): FieldTexture {
  old?.texture.dispose();
  const tex = makeFieldTexture(res.values, res.nlon, res.nlat);
  bindFieldTexture(slice.material, tex, res.nlon, res.nlat);
  slice.mesh.visible = true;
  return tex;
}

/** Auto range from the whole map, so it follows the menu settings only and
 *  never moves with the camera. */
function applyRange(values: Float32Array): void {
  if (view.autoRange) view.cmax = niceSymmetricRange(values, GRID.nlon, GRID.nlat);
  if (texA) setFieldRange(sliceA.material, texA, -view.cmax, view.cmax);
  if (texB) setFieldRange(sliceB.material, texB, -view.cmax, view.cmax);
  shlab.cmax = view.cmax;
  gui.controllersRecursive().forEach((c) => c.updateDisplay());
}

function applySwipe(): void {
  const on = view.mode === 'swipe';
  const x = view.swipe * innerWidth * renderer.getPixelRatio();
  setSwipe(sliceA.material, on ? 'left' : 'off', x);
  setSwipe(sliceB.material, on ? 'right' : 'off', x);
  divider.hidden = !on;
  divider.style.left = `${view.swipe * innerWidth - 1}px`;
}

async function refresh(): Promise<void> {
  const gen = ++generation;
  shlab.ready = false;
  const t0 = performance.now();
  status.textContent = 'synthesising...';
  applySwipe();
  let bandText: string;
  if (view.mode === 'difference') {
    const r = await client.request('A', spec([view.a, view.b]));
    if (!r || gen !== generation) return;
    texA = place(sliceA, r, texA);
    sliceB.mesh.visible = false;
    bandText = `${view.a} - ${view.b}, compared over degrees ${r.band.lmin}-${r.band.lmax}`;
    shlab.band = r.band;
    applyRange(r.values);
  } else if (view.mode === 'swipe') {
    // Both halves over the common band, so the divider never splits a
    // truncated model from a full one.
    const [ra, rb] = await Promise.all([
      client.request('A', { ...spec(view.a), window: commonWindow() }),
      client.request('B', { ...spec(view.b), window: commonWindow() }),
    ]);
    if (!ra || !rb || gen !== generation) return;
    texA = place(sliceA, ra, texA);
    texB = place(sliceB, rb, texB);
    bandText = `${view.a} | ${view.b}, compared over degrees ${ra.band.lmin}-${ra.band.lmax}`;
    shlab.band = ra.band;
    applyRange(ra.values);
  } else {
    const r = await client.request('A', spec(view.a));
    if (!r || gen !== generation) return;
    texA = place(sliceA, r, texA);
    sliceB.mesh.visible = false;
    bandText = `${view.a}, degrees ${r.band.lmin}-${r.band.lmax}`;
    shlab.band = r.band;
    applyRange(r.values);
  }
  const ms = performance.now() - t0;
  status.textContent = `${bandText} | ${view.component} at ${view.altitudeKm} km | +-${view.cmax} nT | ${ms.toFixed(0)} ms`;
  shlab.status = status.textContent;
  shlab.ms = ms;
  requestAnimationFrame(() => requestAnimationFrame(() => { shlab.ready = true; }));
}

/** Paper recipes: figs 3-6 put gravity on top of an opaque field; LIP_tests
 *  puts the grey grid underneath and the field on top at 50 %. On top, the
 *  overlay sits just outside the field; underneath, just inside it, and the
 *  field turns translucent so the grid shows through. */
function applyLayering(): void {
  const top = view.ovOrder === 'top';
  overlay.setRadius(R_SURFACE * (top ? 1.0006 : 0.9994));
  overlay.mesh.renderOrder = top ? 2 : 0;
  overlay.setOpacity(view.ovOpacity);
  for (const s of [sliceA, sliceB]) {
    s.material.transparent = view.fieldOpacity < 1;
    s.material.uniforms.uOpacity.value = view.fieldOpacity;
    s.material.needsUpdate = true;
  }
}

async function loadOverlay(name: string): Promise<void> {
  const old = overlay.material.uniforms.uImage.value;
  if (name === 'none') { overlay.setImage(null); old?.dispose(); shlab.overlay = null; return; }
  const base = `${import.meta.env.BASE_URL}overlays/`;
  const meta = await (await fetch(`${base}${name}.json`)).json();
  const level = chooseOverlayLevel(renderer, meta.levels);
  const t0 = performance.now();
  const tex = await loadOverlayTexture(`${base}${level.file}`);
  overlay.setImage(tex, meta.extent as Extent);
  old?.dispose();
  shlab.overlay = { name, file: level.file, maxTextureSize: renderer.capabilities.maxTextureSize,
    loadMs: performance.now() - t0 };
}

const lmaxOf = new Map<string, number>();
function commonWindow() {
  return { lmin: view.lmin, lmax: Math.min(view.lmax, lmaxOf.get(view.a) ?? 0, lmaxOf.get(view.b) ?? 0) };
}

const gui = new GUI({ title: 'SH Lab' });

async function boot(): Promise<void> {
  const url = q.get('fixture') ?? `${import.meta.env.BASE_URL}sh-fixture.json`;
  const res = await fetch(url);
  if (!res.ok) {
    status.textContent = `no coefficients at ${url} -- run test-data/make_sh_fixture.py and serve it there`;
    return;
  }
  const fx = await res.json();
  const toC = (m: { lmax: number; r0: number; g: number[]; h: number[] }): ShCoeffs =>
    ({ lmax: m.lmax, r0: m.r0, g: Float64Array.from(m.g), h: Float64Array.from(m.h) });
  const ids = Object.keys(fx.models);
  for (const id of ids) {
    client.register(id, toC(fx.models[id]));
    lmaxOf.set(id, fx.models[id].lmax);
  }
  client.register('IGRF-13', toC(fx.igrf));
  client.setMainField('IGRF-13');

  const go = () => void refresh();
  gui.add(view, 'a', ids).name('model A').onChange(go);
  gui.add(view, 'b', ids).name('model B').onChange(go);
  gui.add(view, 'mode', ['single', 'difference', 'swipe']).onChange(go);
  gui.add(view, 'component', ['br', 'btheta', 'bphi', 'intensity', 'tmi']).onChange(go);
  gui.add(view, 'altitudeKm', 0, 500, 1).name('altitude (km)').onChange(go);
  gui.add(view, 'lmin', 1, 100, 1).onChange(go);
  gui.add(view, 'lmax', 16, 300, 1).onChange(go);
  gui.add(view, 'swipe', 0, 1, 0.01).name('swipe position').onChange(applySwipe);
  gui.add(view, 'autoRange').name('auto range').onChange(go);
  gui.add(view, 'cmax', 1, 1000, 1).name('+- range (nT)').onChange(() => {
    view.autoRange = false;
    if (texA) setFieldRange(sliceA.material, texA, -view.cmax, view.cmax);
    if (texB) setFieldRange(sliceB.material, texB, -view.cmax, view.cmax);
  });
  const ov = gui.addFolder('Overlay');
  ov.add(view, 'overlay', ['none', 'freeair', 'vgg']).onChange((n: string) => void loadOverlay(n));
  ov.add(view, 'ovOpacity', 0, 1, 0.05).name('overlay opacity').onChange(applyLayering);
  ov.add(view, 'ovOrder', ['top', 'under']).name('overlay order').onChange(applyLayering);
  ov.add(view, 'fieldOpacity', 0, 1, 0.05).name('field opacity').onChange(applyLayering);
  applyLayering();
  await Promise.all([loadOverlay(view.overlay), refresh()]);
}

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  applySwipe();
});

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});

void boot();
