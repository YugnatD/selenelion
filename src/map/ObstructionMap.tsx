import type { MapLibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import { useEclipseStore } from '../state/eclipseStore';
import { computeLunarVisibilityGrid } from '../terrain/lunarVisibilityGrid';
import { ObstructionWorkerClient } from '../terrain/obstructionWorkerClient';
import { setContourData, setupContourMapView } from './contourLayers';
import { ContourLegend } from './ContourLegend';
import { valueGridToContourBands } from './contourRender';
import { registerExportableMap, unregisterExportableMap } from './mapRegistry';
import {
    attachMapErrorHandler,
    createSyncedMap,
    gridDimsFromContainer,
    MAP_LOAD_ERROR_KEY,
    setPathSourceData,
    useSelectedPointMarker,
} from './sharedMapSetup';

const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const MIN_ZOOM = 5;
/** Roughly one grid cell per this many CSS pixels, capped so cost stays bounded on huge screens.
 *  The computation runs in a Web Worker (off the main thread), so this can afford to be finer
 *  than a main-thread version could without janking the map. */
const CELL_PX = 15;
const GRID_BOUNDS = { minCols: 20, maxCols: 110, minRows: 14, maxRows: 70 };
const OBSTRUCTION_SOURCE_ID = 'obstruction-bands';

interface ObstructionMapProps {
    /** Whether this tab is the one currently shown (the component itself stays mounted-but-
     *  hidden when switching away, so this drives the "resync when shown again" effect below). */
    visible: boolean;
}

export function ObstructionMap({ visible }: ObstructionMapProps) {
    const t = useT();
    const containerRef = useRef<HTMLDivElement | null>(null);
    const mapRef = useRef<MapLibreMap | null>(null);
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const requestIdRef = useRef(0);
    const recomputeRef = useRef<() => void>(() => {});
    const workerClientRef = useRef<ObstructionWorkerClient | null>(null);
    // Tracks completion of the map's 'load' event independently of map.isStyleLoaded(): adding
    // the contour/path GeoJSON sources (even with empty data) right after 'load' fires transiently
    // un-sets MapLibre's "all sources loaded" state for a tick, so a live isStyleLoaded() check
    // done synchronously afterward (e.g. inside the first recompute()) incorrectly reads false.
    const hasLoadedRef = useRef(false);

    const path = useEclipseStore((s) => s.path);
    const eclipseMode = useEclipseStore((s) => s.eclipseMode);
    const lunarSummary = useEclipseStore((s) => s.lunarSummary);
    const selectedDate = useEclipseStore((s) => s.selectedDate);
    const selectedPoint = useEclipseStore((s) => s.selectedPoint);
    const selectPoint = useEclipseStore((s) => s.selectPoint);

    const [zoomTooLow, setZoomTooLow] = useState(false);
    const [loading, setLoading] = useState(false);
    const [mapLoadError, setMapLoadError] = useState(false);

    useEffect(() => {
        if (!containerRef.current || mapRef.current) return;

        const { map, cleanup, isSyncing } = createSyncedMap(containerRef.current, STYLE_URL);
        mapRef.current = map;
        registerExportableMap('obstruction', map);
        attachMapErrorHandler(map, () => setMapLoadError(true));
        const workerClient = new ObstructionWorkerClient();
        workerClientRef.current = workerClient;

        async function recompute() {
            const requestId = ++requestIdRef.current;
            const zoom = map.getZoom();
            if (zoom < MIN_ZOOM) {
                setZoomTooLow(true);
                setLoading(false);
                return;
            }
            setZoomTooLow(false);

            const { selectedDate: date, eclipseMode, lunarSummary } = useEclipseStore.getState();
            if (!date || !hasLoadedRef.current) {
                setLoading(false);
                return;
            }
            if (eclipseMode === 'lunar' && !lunarSummary) {
                setLoading(false);
                return;
            }

            setLoading(true);
            try {
                const b = map.getBounds();
                const bounds = { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() };
                const { cols, rows } = gridDimsFromContainer(containerRef.current, CELL_PX, GRID_BOUNDS);

                // For a lunar eclipse this is the visibility map: where on Earth the Moon clears
                // the horizon during the event. Same "fraction of the eclipse you actually get"
                // quantity as the solar obstruction grid, so it feeds the identical contour bands.
                const values =
                    eclipseMode === 'lunar'
                        ? (await computeLunarVisibilityGrid(lunarSummary!, bounds, cols, rows)).cells.map((c) => c.visibleFraction)
                        : (await workerClient.compute(date, bounds, cols, rows)).cells.map((c) => c.visibleFraction);
                if (requestId !== requestIdRef.current) return; // superseded by a newer request

                const bands = valueGridToContourBands(values, { cols, rows, bounds });
                setContourData(map, OBSTRUCTION_SOURCE_ID, bands);
            } catch (err) {
                // A SUPERSEDED rejection just means a newer pan/zoom replaced this request
                // before it finished — expected and not worth logging.
                if (requestId === requestIdRef.current && !(err instanceof Error && err.message === 'SUPERSEDED')) {
                    console.error('Obstruction grid computation failed:', err);
                }
            } finally {
                if (requestId === requestIdRef.current) setLoading(false);
            }
        }
        recomputeRef.current = () => void recompute();

        map.on('load', () => {
            hasLoadedRef.current = true;
            setupContourMapView(map, OBSTRUCTION_SOURCE_ID, useEclipseStore.getState().path, () => recomputeRef.current(), selectPoint);
        });

        const onMoveEnd = () => {
            // A programmatic jumpTo from another (possibly hidden) view being panned also fires
            // 'moveend' — recomputing for that would burn a worker computation for a view
            // nobody's even looking at, every time the user pans a *different* tab.
            if (isSyncing()) return;
            if (debounceRef.current) clearTimeout(debounceRef.current);
            debounceRef.current = setTimeout(() => recomputeRef.current(), 350);
        };
        map.on('moveend', onMoveEnd);

        return () => {
            unregisterExportableMap('obstruction');
            if (debounceRef.current) clearTimeout(debounceRef.current);
            cleanup();
            workerClient.terminate();
            workerClientRef.current = null;
            mapRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // When the selected eclipse changes, redraw the context layers and recompute the grid.
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !hasLoadedRef.current) return;

        setPathSourceData(map, path);
        recomputeRef.current();
    }, [path, selectedDate, eclipseMode, lunarSummary]);

    // The map's own moveend handler ignores programmatic view-sync jumps that happen while this
    // tab is hidden (see isSyncing above), so the grid can be stale relative to the synced view
    // by the time the user switches back — catch up here instead.
    useEffect(() => {
        if (!visible) return;
        const map = mapRef.current;
        if (!map || !hasLoadedRef.current) return;
        recomputeRef.current();
    }, [visible]);

    useSelectedPointMarker(mapRef, selectedPoint);

    return (
        <div style={{ position: 'absolute', inset: 0 }}>
            <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
            {zoomTooLow && (
                <div className="obstruction-hint">
                    {t(eclipseMode === 'lunar' ? 'map.zoomForMoon' : 'map.zoomForObstruction')}
                </div>
            )}
            {loading && <div className="obstruction-loading">{t('map.computingTerrain')}</div>}
            {mapLoadError && <div className="obstruction-hint">{t(MAP_LOAD_ERROR_KEY)}</div>}
            <ContourLegend
                lowLabel={t(eclipseMode === 'lunar' ? 'legend.moonNotVisible' : 'legend.blocked')}
                highLabel={t(eclipseMode === 'lunar' ? 'legend.moonVisible' : 'legend.clear')}
                note={eclipseMode === 'lunar' ? t('legend.lunarNote') : undefined}
            />
        </div>
    );
}
