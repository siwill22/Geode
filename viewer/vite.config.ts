import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// The generated archive is served from viewer/public/archive, which is a
// symlink to ../archive at the repo root -- the volumes are ~60 MB and do not
// belong inside the app source.
//
// GitHub Pages serves a project site under /<repo>/, not the domain root, so
// the build needs a base path and every archive URL has to follow it. VITE_BASE
// is set by the deploy workflow; dev and `vite preview` leave it at '/'. Do not
// hardcode '/Geode/' here -- it would break the dev server, and the whole point
// of routing this through import.meta.env.BASE_URL in main.ts is that one knob
// moves both the app assets and the data.
export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
  server: { port: 5173 },
  build: {
    target: 'es2022',
    // three.js alone accounts for most of this and isn't meaningfully
    // tree-shakeable here -- every viewer uses the whole rendering pipeline
    // (Scene/Camera/Renderer/OrbitControls/geometries/materials), and there's
    // no route-based split point in a single-view WebGL app. Raised rather
    // than chased: Vite's default 500 kB warning assumes a splittable app,
    // which this genuinely isn't.
    chunkSizeWarningLimit: 700,
    // Vite's implicit single-entry build only picks up index.html; climate.html
    // needs to be named explicitly or `vite build` never emits it.
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('index.html', import.meta.url)),
        climate: fileURLToPath(new URL('climate.html', import.meta.url)),
        valdes: fileURLToPath(new URL('valdes.html', import.meta.url)),
        globe: fileURLToPath(new URL('globe.html', import.meta.url)),
        groupGlobe: fileURLToPath(new URL('groupGlobe.html', import.meta.url)),
        reconstruction: fileURLToPath(new URL('reconstruction.html', import.meta.url)),
        reconstructionGroup: fileURLToPath(new URL('reconstructionGroup.html', import.meta.url)),
        paleobio: fileURLToPath(new URL('paleobio.html', import.meta.url)),
        oldmap: fileURLToPath(new URL('oldmap.html', import.meta.url)),
        themelab: fileURLToPath(new URL('themelab.html', import.meta.url)),
      },
      output: {
        // Every entry point shares three/lil-gui -- name that shared chunk
        // 'vendor' explicitly rather than letting Rollup pick one of the
        // app modules bundled alongside it (it previously came out as
        // e.g. "clipRange-[hash].js", which reads like a bug report
        // waiting to happen). Splitting vendor out from app code also means
        // a code-only redeploy doesn't invalidate the browser's cached copy
        // of three.js.
        manualChunks(id) {
          if (id.includes('node_modules')) return 'vendor';
        },
      },
    },
  },
});
