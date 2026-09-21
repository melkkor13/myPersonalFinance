import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Vite config for the SPA.
 *
 * Tailwind v4 (C13): integration is the first-party `@tailwindcss/vite` plugin.
 * There is deliberately **no `tailwind.config.js`, no `postcss.config.js`, no
 * autoprefixer and no `postcss-import`** — `src/index.css` is a single
 * `@import "tailwindcss"` plus `@theme` blocks. `@tailwindcss/postcss` is for
 * non-Vite bundlers and must not be used here.
 *
 * Dev proxy (C15): `/api` is proxied to the API, so requests are same-origin and
 * the API needs no CORS plugin. Nothing here may paper over a broken proxy — a
 * misconfiguration must surface as a failed request.
 */

/** Vite default; FR12 pins the web dev server to it. */
const WEB_DEV_PORT = 5173;

/** Fail loudly rather than silently moving to 5174 and breaking the proxy story. */
const USE_STRICT_PORT = true;

/** The API's dev origin (`PORT` default 3000, FR12). */
const API_DEV_ORIGIN = 'http://localhost:3000';

/** Everything under this prefix is proxied; it covers `/api/v1/**`. */
const API_PROXY_PREFIX = '/api';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: WEB_DEV_PORT,
    strictPort: USE_STRICT_PORT,
    proxy: {
      [API_PROXY_PREFIX]: {
        target: API_DEV_ORIGIN,
        changeOrigin: true,
      },
    },
  },
});
