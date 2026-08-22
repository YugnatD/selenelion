import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { setWorkerUrl } from 'maplibre-gl'
import './index.css'
import App from './App.tsx'

// maplibre-gl's own Worker-URL auto-detection doesn't survive a production build (see
// scripts/copyMaplibreWorker.mjs for why) — pointed instead at the two files that script copies
// into public/, served as plain static assets under a stable path. Must run before any MapLibre
// Map is constructed, so it's set here at the app's own entry point rather than in a component.
setWorkerUrl('/maplibre-gl-worker.mjs')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
