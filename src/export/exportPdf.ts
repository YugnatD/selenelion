import { jsPDF } from 'jspdf';
import type { MapLibreMap } from 'maplibre-gl';
import { t } from '../i18n';
import type { StringKey } from '../i18n';
import { lunarTypeLabel, solarTypeLabel } from '../i18n/labels';
import type { LunarEclipseSummary } from '../engine/lunarEclipse';
import {
    computeFineLunarTerrainGrid,
    computeFineTerrainGrid,
    computeFineWeatherBands,
    focusScoresToBands,
    lunarFocusScoreToBands,
    lunarVisibilityGridToBands,
    obstructionGridToBands,
} from './fineGrid';
import type { Bounds } from './fineGrid';
import { addContourLayers, findFirstSymbolLayerId, setContourData } from '../map/contourLayers';
import type { ExportableView } from '../map/mapRegistry';
import { getExportableMap } from '../map/mapRegistry';
import { getActiveView, setActiveView } from '../map/viewControl';
import type { LegendSpec } from './pdfDraw';
import { drawMapPage } from './pdfDraw';
import { useEclipseStore } from '../state/eclipseStore';

export interface ExportProgress {
    stage: string;
    /** 0-1 overall completion across every page. */
    fraction: number;
}

type ContourBands = GeoJSON.FeatureCollection<GeoJSON.MultiPolygon, { bandIndex: number }>;

/** Runtime shape check for the store's `lunarSummary`, used before trusting it as a
 *  `LunarEclipseSummary` (in particular before reading `.contacts.greatest`, deep inside PDF
 *  generation where a bad shape would otherwise surface as an opaque TypeError or, worse, quietly
 *  wrong output rather than a clear early failure). */
function isLunarEclipseSummary(value: unknown): value is LunarEclipseSummary {
    if (typeof value !== 'object' || value === null) return false;
    const v = value as Record<string, unknown>;
    if (typeof v.type !== 'string' || typeof v.umbralMagnitude !== 'number' || typeof v.penumbralMagnitude !== 'number') return false;
    const contacts = v.contacts as Record<string, unknown> | undefined;
    return typeof contacts === 'object' && contacts !== null && contacts.greatest instanceof Date && contacts.p1 instanceof Date && contacts.p4 instanceof Date;
}

/** Page order, labelled through the same keys as the on-screen tab bar so a PDF page is never
 *  headed differently from the view it was captured from. */
const VIEW_ORDER = [
    { id: '2d', labelKey: 'view.2d' },
    { id: 'obstruction', labelKey: 'view.obstruction' },
    { id: 'weather', labelKey: 'view.weather' },
    { id: 'focus', labelKey: 'view.focus' },
] as const satisfies ReadonlyArray<{ id: ExportableView; labelKey: StringKey }>;

/** At low zoom, MapLibre's own `getBounds()` can report a west/east span wider than the world
 *  itself (the visible viewport wraps more than once around the globe) — left alone, that would
 *  hand the fine-grid computation (and the marching-squares contour it feeds) longitudes running
 *  well outside a sane range. Clamped to a fixed max span, centered on the same midpoint, rather
 *  than trusting the raw bounds — the interactive grids sidestep this instead via a MIN_ZOOM
 *  gate, but export runs at whatever zoom the user happened to leave the view at. Must only be
 *  called on a currently-*visible* map (see activateForCapture) — MapLibre's bounds/transform
 *  are wrong for the whole time a map's container is `display:none`. */
function mapBounds(map: MapLibreMap): Bounds {
    const b = map.getBounds();
    const south = Math.max(-90, b.getSouth());
    const north = Math.min(90, b.getNorth());
    let west = b.getWest();
    let east = b.getEast();
    const MAX_SPAN = 180;
    if (east - west > MAX_SPAN) {
        const centerLon = (west + east) / 2;
        west = centerLon - MAX_SPAN / 2;
        east = centerLon + MAX_SPAN / 2;
    }
    return { west, south, east, north };
}

/** Interactive contour-layer ids to hide from the *captured base image* per view, so the
 *  snapshot underneath doesn't show the coarse on-screen contour at the same time as the fresh,
 *  fine-resolution one temporarily injected for capture (see withFineContourLayer) — both sit at
 *  the same z-position (just under the base style's labels), so only one can be visible at once.
 *  Deliberately does NOT include Focus's own mask layer — that one stays visible throughout,
 *  since hiding it would lose the "everything outside the corridor is de-emphasized" look Focus
 *  mode is specifically for. */
const INTERACTIVE_LAYERS_TO_HIDE: Partial<Record<ExportableView, string[]>> = {
    obstruction: ['obstruction-bands-fill', 'obstruction-bands-lines'],
    weather: ['weather-bands-fill', 'weather-bands-lines'],
    focus: ['focus-bands-fill', 'focus-bands-lines'],
};

/** A view that's never been opened this session has no live MapLibre instance yet — its
 *  component (EclipseMap/ObstructionMap/WeatherMap/FocusMap) has never mounted, so nothing has
 *  called `registerExportableMap`. `setActiveView` (called just before this, in
 *  activateForCapture) drives the same `view` state the sidebar's tab buttons do, so switching to
 *  an unvisited view mounts it for the first time exactly as if the user had clicked its tab —
 *  the mount effect that constructs the map and registers it runs synchronously in React's commit
 *  phase, normally well within the two animation frames already awaited before this runs. Polls
 *  briefly anyway as cheap insurance against a slower first mount, rather than assuming a fixed
 *  frame count is always enough and silently dropping the page. */
function waitForRegisteredMap(view: ExportableView): Promise<MapLibreMap> {
    const POLL_INTERVAL_MS = 50;
    const TIMEOUT_MS = 3000;
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const check = () => {
            const map = getExportableMap(view);
            if (map) {
                resolve(map);
                return;
            }
            if (Date.now() - start >= TIMEOUT_MS) {
                reject(new Error(`View "${view}" did not register a map in time`));
                return;
            }
            setTimeout(check, POLL_INTERVAL_MS);
        };
        check();
    });
}

function waitForMapLoad(map: MapLibreMap): Promise<void> {
    if (map.loaded() && map.isStyleLoaded()) return Promise.resolve();
    // Polls map.loaded()/isStyleLoaded() rather than waiting on a fresh map.once('load', ...):
    // 'load' only ever fires once per map instance, and by the time this runs it has almost
    // always already fired long ago (the map was activated and resize()d just before this call,
    // which itself kicks off new tile requests) — a listener for an event that's already in the
    // past never fires again, so the old code always burned the full timeout on every export.
    // MapLibre's own readiness methods are the correct thing to poll instead: loaded() is false
    // while sources are dirty or tiles are still fetching, exactly the condition worth waiting
    // out, and both are cheap synchronous calls safe to poll frequently.
    const POLL_INTERVAL_MS = 120;
    const TIMEOUT_MS = 10_000;
    return new Promise<void>((resolve) => {
        const start = Date.now();
        const check = () => {
            if ((map.loaded() && map.isStyleLoaded()) || Date.now() - start >= TIMEOUT_MS) {
                resolve();
                return;
            }
            setTimeout(check, POLL_INTERVAL_MS);
        };
        check();
    });
}

/** Waits for `map` to settle after some change (a repaint trigger, a source update, ...): resolves
 *  on the next 'idle' event, or after a fallback timeout — 'idle' has been observed not to
 *  reliably fire in every test harness, and export can't be allowed to hang forever on one page. */
function waitForIdle(map: MapLibreMap, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, timeoutMs);
        map.once('idle', () => {
            clearTimeout(timeout);
            resolve();
        });
    });
}

/** A hidden view's container is `display:none` (0×0) — and MapLibre isn't just unable to
 *  *capture* a canvas at that size, its `getBounds()`/`.project()` are actively wrong the whole
 *  time the map is hidden (its internal transform tracks the container's real size, which a
 *  0×0 container corrupts). So every per-view step — reading bounds, computing the fine grid
 *  *and* capturing the page — has to happen only after this has made the view the active tab,
 *  let React/CSS commit that, and resized MapLibre to pick up its now-real container size again.
 *  Waits for 'load' first (see waitForMapLoad), *then* hides that view's own interactive contour
 *  layer (restored by the returned callback, once capture is done) so the base snapshot doesn't
 *  show the coarse on-screen contour at the same time as the fine one (see
 *  withFineContourLayer), then waits for idle so tiles have actually finished rendering. This
 *  does mean each tab now sits visible for its whole (sometimes multi-second) fine-grid
 *  computation, not just the final capture — a fair trade for correct bounds and a fully-loaded
 *  base map. */
async function activateForCapture(view: ExportableView): Promise<{ map: MapLibreMap; restore: () => void }> {
    setActiveView(view);
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    const map = await waitForRegisteredMap(view);
    map.resize();
    await waitForMapLoad(map);

    const restores: Array<() => void> = [];
    for (const layerId of INTERACTIVE_LAYERS_TO_HIDE[view] ?? []) {
        if (!map.getLayer(layerId)) continue;
        const previous = (map.getLayoutProperty(layerId, 'visibility') as 'visible' | 'none' | undefined) ?? 'visible';
        map.setLayoutProperty(layerId, 'visibility', 'none');
        restores.push(() => map.setLayoutProperty(layerId, 'visibility', previous));
    }

    map.triggerRepaint();
    await waitForIdle(map, 4000);
    return { map, restore: () => restores.forEach((fn) => fn()) };
}

/** Temporarily injects `bands` as a real MapLibre fill+line layer — the exact same visual recipe
 *  as the interactive contour overlay (addContourLayers), positioned under the base style's
 *  labels via the same `findFirstSymbolLayerId` insertion point — lets MapLibre render it, then
 *  removes it again. This is what makes the exported page's captured raster show country
 *  borders/labels correctly on top of the fine data: MapLibre composites them in that order
 *  itself, the same way it already does on screen, rather than this module trying to redraw the
 *  fill as a separate PDF vector layer *after* the raster (where it would sit above, not below,
 *  everything baked into that raster — the bug this replaced). No-op (just runs `draw`) when
 *  there's no data to show, e.g. the 2D page. */
async function withFineContourLayer<T>(map: MapLibreMap, bands: ContourBands | null, draw: () => T): Promise<T> {
    if (!bands) return draw();
    const tempSourceId = `export-fine-${Math.random().toString(36).slice(2)}`;
    const { fillLayerId, lineLayerId } = addContourLayers(map, tempSourceId, findFirstSymbolLayerId(map));
    setContourData(map, tempSourceId, bands);
    map.triggerRepaint();
    await waitForIdle(map, 4000);
    try {
        return draw();
    } finally {
        if (map.getLayer(lineLayerId)) map.removeLayer(lineLayerId);
        if (map.getLayer(fillLayerId)) map.removeLayer(fillLayerId);
        if (map.getSource(tempSourceId)) map.removeSource(tempSourceId);
    }
}

/** Exports a multi-page PDF, one page per map view — including a view the user has never opened
 *  this session, which `activateForCapture`/`waitForRegisteredMap` mount on demand exactly as
 *  clicking its tab would (see mapRegistry.ts for the live-instance registry this relies on). A
 *  view is only left out of the PDF if it genuinely fails to activate or render (map never
 *  registers, a worker/network error mid-computation, ...) — that failure is caught per-view so
 *  one bad view can't blank the pages already captured for the others; `skipped` in the return
 *  value lists which views (if any) that happened to, for the caller to surface. For
 *  Obstruction/Météo/Focus, the contour data is recomputed at a much finer resolution than the
 *  interactive grid specifically for this export (see fineGrid.ts), with `onProgress` reporting
 *  that recomputation's own progress, not just an overall page count. */
export async function exportEclipsePdf(onProgress: (progress: ExportProgress) => void): Promise<{ skipped: string[] }> {
    const { selectedDate, summary, lunarSummary, eclipseMode, weatherDayWindow } = useEclipseStore.getState();
    const lunar = eclipseMode === 'lunar';
    // A lunar eclipse has no `summary` at all — its circumstances live on lunarSummary — so
    // checking only the solar one made the export throw "no eclipse selected" for every lunar
    // export, even though one was plainly selected.
    if (!selectedDate || (lunar ? !lunarSummary : !summary)) throw new Error(t('export.errNoEclipse'));

    if (lunar && !isLunarEclipseSummary(lunarSummary)) {
        throw new Error(t('export.errBadLunarSummary'));
    }

    const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
    // Safe past the guard above: `lunar` true implies `isLunarEclipseSummary(lunarSummary)` held,
    // and TypeScript can't narrow a value captured before an `if` inside a differently-scoped
    // check, so this cast is now backed by an actual runtime check rather than an unchecked one.
    const lunarInfo = lunarSummary as LunarEclipseSummary;
    const referenceTime = lunar ? lunarInfo.contacts.greatest : summary!.greatestEclipse.time;
    const subtitle = lunar
        ? t('export.subtitleLunar', {
              type: lunarTypeLabel(t, lunarInfo.type),
              date: selectedDate,
              magnitude: lunarInfo.umbralMagnitude.toFixed(3),
          })
        : t('export.subtitleSolar', {
              type: solarTypeLabel(t, summary!.type),
              date: selectedDate,
              magnitude: summary!.magnitude.toFixed(3),
          });
    const originalView = getActiveView();
    const skipped: string[] = [];
    let pagesDrawn = 0;

    // Obstruction and Qualité both need the same expensive terrain/horizon grid (Qualité folds it
    // into a composite score) — cached here so that when both pages run in the same export at the
    // same map bounds (the common case: every view is kept in sync unless the user has somehow
    // diverged them), the network-fetching Web Worker pass only happens once instead of twice.
    // Falls back to recomputing if Obstruction was skipped/failed or its bounds don't match —
    // reuse is an optimization, never a correctness requirement.
    let cachedTerrainGrid: { bounds: Bounds; grid: Awaited<ReturnType<typeof computeFineTerrainGrid>> } | null = null;
    let cachedLunarTerrainGrid: { bounds: Bounds; grid: Awaited<ReturnType<typeof computeFineLunarTerrainGrid>> } | null = null;
    const boundsEqual = (a: Bounds, b: Bounds) => a.west === b.west && a.south === b.south && a.east === b.east && a.north === b.north;

    try {
        for (let i = 0; i < VIEW_ORDER.length; i++) {
            const view = VIEW_ORDER[i]!; // i bounded by VIEW_ORDER.length
            const viewLabel = t(view.labelKey);
            const stageBase = i / VIEW_ORDER.length;
            const stageSpan = 1 / VIEW_ORDER.length;
            const reportSubProgress = (fraction: number, label: string) =>
                onProgress({ stage: t('export.stageSub', { label, view: viewLabel }), fraction: stageBase + fraction * stageSpan * 0.85 });

            onProgress({ stage: t('export.stageShowView', { view: viewLabel }), fraction: stageBase });

            let map: MapLibreMap;
            let restore: () => void;
            try {
                ({ map, restore } = await activateForCapture(view.id));
            } catch (err) {
                console.warn(`PDF export: view "${view.id}" unavailable, page skipped.`, err);
                skipped.push(viewLabel);
                continue;
            }

            // Must run even if anything below throws (a worker error, a network hiccup on the
            // weather fetch, ...) — otherwise that view's own interactive contour layer, hidden
            // above for a clean capture, stays hidden for good on the live map too, not just in
            // the failed export. A failure here is caught below rather than aborting the whole
            // export, so one bad view doesn't discard pages already captured for the others.
            try {
                const bounds = mapBounds(map);

                const drawPage = async (titleSuffix: string, legend: LegendSpec | null, bands: ContourBands | null) => {
                    onProgress({ stage: t('export.stageLayout', { view: `${viewLabel}${titleSuffix}` }), fraction: stageBase + stageSpan * 0.97 });
                    await withFineContourLayer(map, bands, () => {
                        if (pagesDrawn > 0) doc.addPage();
                        drawMapPage(doc, {
                            map,
                            title: t('export.pageTitle', { lunar, view: `${viewLabel}${titleSuffix}` }),
                            subtitle,
                            legend,
                        });
                        pagesDrawn++;
                    });
                };

                if (view.id === 'focus') {
                    // Qualité's score depends on whether duration-at-totality is weighted in — a
                    // toggle the on-screen view lets the user flip live (only meaningful for a
                    // solar eclipse; a lunar one's score is always relief × météo). The export
                    // used to just snapshot whichever position that toggle happened to be in, so
                    // the PDF silently reflected a UI state the reader can't see or change.
                    // Drawing both variants for a solar eclipse costs only one extra page layout,
                    // not a second terrain/weather computation: focusScoresToBands derives both
                    // scorings from one grid, and that grid is itself reused from Obstruction's
                    // own pass (below) whenever the bounds match.
                    if (lunar) {
                        const grid =
                            cachedLunarTerrainGrid && boundsEqual(cachedLunarTerrainGrid.bounds, bounds)
                                ? cachedLunarTerrainGrid.grid
                                : await computeFineLunarTerrainGrid(lunarInfo, bounds, (f) => reportSubProgress(f, t('export.stageVisibility')));
                        const bands = await lunarFocusScoreToBands(grid, bounds, referenceTime, weatherDayWindow);
                        await drawPage('', { lowLabel: t('legend.low'), highLabel: t('legend.excellent'), note: t('legend.scoreFormula') }, bands);
                    } else {
                        const grid =
                            cachedTerrainGrid && boundsEqual(cachedTerrainGrid.bounds, bounds)
                                ? cachedTerrainGrid.grid
                                : await computeFineTerrainGrid(selectedDate, bounds, (f) => reportSubProgress(f, t('export.stageTerrain')));
                        const both = await focusScoresToBands(grid, bounds, referenceTime, weatherDayWindow, summary!);
                        const lowHigh = { lowLabel: t('legend.low'), highLabel: t('legend.excellent') };
                        await drawPage(t('export.focusWithDuration'), { ...lowHigh, note: t('legend.scoreFormulaDuration') }, both.withDuration);
                        await drawPage(t('export.focusWithoutDuration'), { ...lowHigh, note: t('legend.scoreFormula') }, both.withoutDuration);
                    }
                    continue;
                }

                let bands: ContourBands | null = null;
                let legend: LegendSpec | null = null;

                if (view.id === 'obstruction') {
                    if (lunar) {
                        const grid = await computeFineLunarTerrainGrid(lunarInfo, bounds, (f) => reportSubProgress(f, t('export.stageVisibility')));
                        cachedLunarTerrainGrid = { bounds, grid };
                        bands = lunarVisibilityGridToBands(grid, bounds);
                        legend = { lowLabel: t('legend.moonNotVisible'), highLabel: t('legend.moonVisible') };
                    } else {
                        const grid = await computeFineTerrainGrid(selectedDate, bounds, (f) => reportSubProgress(f, t('export.stageTerrain')));
                        cachedTerrainGrid = { bounds, grid };
                        bands = obstructionGridToBands(grid, bounds);
                        legend = { lowLabel: t('legend.blocked'), highLabel: t('legend.clear') };
                    }
                } else if (view.id === 'weather') {
                    reportSubProgress(0.3, t('export.stageWeather'));
                    bands = await computeFineWeatherBands(bounds, referenceTime, weatherDayWindow);
                    legend = { lowLabel: t('legend.covered'), highLabel: t('legend.clearSky') };
                }

                await drawPage('', legend, bands);
            } catch (err) {
                console.warn(`PDF export: rendering view "${view.id}" failed, page skipped.`, err);
                skipped.push(viewLabel);
            } finally {
                restore();
            }
        }
    } finally {
        setActiveView(originalView);
    }

    if (pagesDrawn === 0) throw new Error(t('export.errNothingExported'));

    onProgress({ stage: t('export.stageWriting'), fraction: 0.98 });
    doc.save(`eclipse-${selectedDate}.pdf`);
    onProgress({ stage: t('export.stageDone'), fraction: 1 });
    return { skipped };
}
