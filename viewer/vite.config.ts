import { defineConfig } from 'vite';

// The generated archive is served from viewer/public/archive, which is a
// symlink to ../archive at the repo root -- the volumes are ~60 MB and do not
// belong inside the app source.
export default defineConfig({
  server: { port: 5173 },
  build: { target: 'es2022' },
});
