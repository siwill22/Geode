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
  build: { target: 'es2022' },
});
