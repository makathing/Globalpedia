import { defineConfig } from 'vite';

// base './' so the site works on GitHub Pages under a sub-path.
export default defineConfig({
  base: './',
  build: {
    target: 'es2020',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
  server: { port: 5173, strictPort: false },
});
