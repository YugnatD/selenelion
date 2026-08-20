import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // MapLibre GL ships its own web worker; Vite's dep pre-bundling step
  // has repeatedly produced a worker chunk that 404s (ERR_FAILED) on
  // cold start, silently breaking tile parsing and the "load"/"idle"
  // events. Exclude it so it's served straight from node_modules.
  optimizeDeps: {
    exclude: ['maplibre-gl'],
  },
})
