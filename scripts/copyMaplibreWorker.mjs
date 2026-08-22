// MapLibre GL JS resolves its own Web Worker script (used off the main thread for vector-tile
// parsing) via a `new Worker(new URL(...))` call inside its own already-bundled dist file. Vite's
// static analysis for turning that pattern into a proper build asset doesn't reach into an
// already-bundled dependency, so a production build silently never emits the worker file — the
// request 404s to index.html instead (same content-type as any other unmatched SPA route), the
// worker never starts, no tiles ever get decoded, and every map view stays visually blank of any
// contour/path data forever, with no error surfaced anywhere.
//
// Fix: serve the two files the worker actually needs (itself, plus the shared chunk it imports)
// as plain static assets from `public/`, and point maplibre-gl at them explicitly via
// `setWorkerUrl()` (see src/main.tsx) instead of relying on its own bundler auto-detection.
// Copied fresh from node_modules on every `npm install` (see package.json's `postinstall`) rather
// than committed, so they can never drift out of sync with whatever maplibre-gl version is
// actually installed.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcDir = join(__dirname, '..', 'node_modules', 'maplibre-gl', 'dist');
const destDir = join(__dirname, '..', 'public');

const files = ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs'];

if (!existsSync(srcDir)) {
    console.warn(`[copyMaplibreWorker] ${srcDir} not found — skipping (maplibre-gl not installed yet?)`);
    process.exit(0);
}

mkdirSync(destDir, { recursive: true });
for (const file of files) {
    const src = join(srcDir, file);
    if (!existsSync(src)) {
        console.error(`[copyMaplibreWorker] ${src} not found — maplibre-gl's dist layout may have changed.`);
        process.exit(1);
    }
    copyFileSync(src, join(destDir, file));
}
console.log(`[copyMaplibreWorker] Copied ${files.join(', ')} to public/`);
