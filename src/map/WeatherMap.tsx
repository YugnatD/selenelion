import type { MapLibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import { useEclipseStore } from '../state/eclipseStore';
import { CLIMATOLOGY_BASELINE_LABEL } from '../weather/climatologyTiles';
import { getWeatherGrid } from '../weather/weather';
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

/** Climatology is read from precomputed static tiles already in the browser's cache: the tiles
 *  covering a viewport get fetched regardless, and each extra point is a bilinear read of four
 *  bytes already in memory. So density here is essentially free, and the grid is sized for the
 *  0.25° data behind it rather than for an API's request limits. */
const CELL_PX = 24;
const GRID_BOUNDS = { minCols: 12, maxCols: 60, minRows: 8, maxRows: 40 };

const WEATHER_SOURCE_ID = 'weather-bands';

interface WeatherMapProps {
    /** Whether this tab is the one currently shown (the component itself stays mounted-but-
     *  hidden when switching away, so this drives the "resync when shown again" effect below). */
    visible: boolean;
}

export function WeatherMap({ visible }: WeatherMapProps) {
    const t = useT();
    const containerRef = useRef<HTMLDivElement | null>(null);
    const mapRef = useRef<MapLibreMap | null>(null);
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const requestIdRef = useRef(0);
    const recomputeRef = useRef<() => void>(() => {});
    const abortControllerRef = useRef<AbortController | null>(null);
    const lastBoundsRef = useRef<{ west: number; south: number; east: number; north: number } | null>(null);
    // Tracks completion of the map's 'load' event independently of map.isStyleLoaded(): adding
    // the contour/path GeoJSON sources (even with empty data) right after 'load' fires transiently
    // un-sets MapLibre's "all sources loaded" state for a tick, so a live isStyleLoaded() check
    // done synchronously afterward (e.g. inside the first recompute()) incorrectly reads false.
    const hasLoadedRef = useRef(false);

    const path = useEclipseStore((s) => s.path);
    const selectedDate = useEclipseStore((s) => s.selectedDate);
    const summary = useEclipseStore((s) => s.summary);
    const eclipseMode = useEclipseStore((s) => s.eclipseMode);
    const lunarSummary = useEclipseStore((s) => s.lunarSummary);
    const selectedPoint = useEclipseStore((s) => s.selectedPoint);
    const selectPoint = useEclipseStore((s) => s.selectPoint);
    const weatherDayWindow = useEclipseStore((s) => s.weatherDayWindow);

    const [loading, setLoading] = useState(false);
    const [gridError, setGridError] = useState<string | null>(null);
    const [mapLoadError, setMapLoadError] = useState(false);

    /** Whichever body is selected, the moment the climatology is sampled at. */
    const uiReferenceTime =
        eclipseMode === 'lunar' ? lunarSummary?.contacts.greatest : summary && new Date(summary.greatestEclipse.time);

    useEffect(() => {
        if (!containerRef.current || mapRef.current) return;

        const { map, cleanup, isSyncing } = createSyncedMap(containerRef.current, STYLE_URL);
        mapRef.current = map;
        registerExportableMap('weather', map);
        attachMapErrorHandler(map, () => setMapLoadError(true));

        // Below this fraction of the viewport's own span, a pan/zoom is treated as "didn't
        // really move" and skips a recompute entirely — scroll-wheel jitter and tiny drags would
        // otherwise re-run marching squares over the whole grid for a visually identical result,
        // at the cost of the grid lagging slightly behind truly marginal moves.
        const SKIP_THRESHOLD = 0.03;

        async function recompute(skipIfBoundsBarelyChanged: boolean) {
            const requestId = ++requestIdRef.current;
            // Uses one reference time (the moment of greatest eclipse) for every cell, rather
            // than each cell's own local eclipse time — for a wide path this can be off by an
            // hour or so at the far east/west edges. A deliberate simplification: computing
            // per-cell local time would need per-cell astronomy, and cloud cover is already
            // only a coarse regional signal, not a precise forecast for one instant.
            // Cloud cover is asked the same question for either body — "will the sky be clear
            // here, at that moment" — but the moment comes from a different place: a lunar
            // eclipse has no `summary`, its single global maximum lives on lunarSummary.
            const state = useEclipseStore.getState();
            const referenceTime =
                state.eclipseMode === 'lunar' ? state.lunarSummary?.contacts.greatest : state.summary?.greatestEclipse.time;
            if (!referenceTime || !hasLoadedRef.current) {
                setLoading(false);
                return;
            }

            const b = map.getBounds();
            const bounds = { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() };

            if (skipIfBoundsBarelyChanged && lastBoundsRef.current) {
                const prev = lastBoundsRef.current;
                const spanLon = Math.max(bounds.east - bounds.west, 1e-9);
                const spanLat = Math.max(bounds.north - bounds.south, 1e-9);
                const barelyMoved =
                    Math.abs(bounds.west - prev.west) / spanLon < SKIP_THRESHOLD &&
                    Math.abs(bounds.east - prev.east) / spanLon < SKIP_THRESHOLD &&
                    Math.abs(bounds.south - prev.south) / spanLat < SKIP_THRESHOLD &&
                    Math.abs(bounds.north - prev.north) / spanLat < SKIP_THRESHOLD;
                // This request wins the requestId race regardless of whether it does real work
                // (see the requestId check after the fetch below), so any earlier request still
                // in flight is already destined to be discarded — safe to also stop showing it
                // as loading here instead of leaving the indicator stuck until that discarded
                // request happens to resolve.
                if (barelyMoved) {
                    setLoading(false);
                    return;
                }
            }

            abortControllerRef.current?.abort();
            const controller = new AbortController();
            abortControllerRef.current = controller;

            setLoading(true);
            setGridError(null);
            try {
                const { cols, rows } = gridDimsFromContainer(containerRef.current, CELL_PX, GRID_BOUNDS);

                const points: Array<{ lat: number; lon: number }> = [];
                // If bounds ever cross the antimeridian (west > east, e.g. west=179, east=-179),
                // interpolating east-west directly would sweep backwards since (east - west) goes
                // negative. Not reachable with this MapLibre version today, but the tile reader
                // (climatologyTiles.ts) already treats this as a real case, so match it here too:
                // add 360 to east before interpolating, then wrap the result back into [-180,180].
                const eastForInterp = bounds.east < bounds.west ? bounds.east + 360 : bounds.east;
                for (let r = 0; r < rows; r++) {
                    for (let c = 0; c < cols; c++) {
                        const lon = bounds.west + ((c + 0.5) / cols) * (eastForInterp - bounds.west);
                        points.push({
                            lon: (((lon + 180) % 360) + 360) % 360 - 180,
                            lat: bounds.north - ((r + 0.5) / rows) * (bounds.north - bounds.south),
                        });
                    }
                }

                const cloudCover = await getWeatherGrid(
                    points,
                    bounds,
                    referenceTime,
                    controller.signal,
                    useEclipseStore.getState().weatherDayWindow,
                );
                if (requestId !== requestIdRef.current) return; // superseded by a newer request
                lastBoundsRef.current = bounds;

                const bands = valueGridToContourBands(
                    cloudCover.map((percent) => (percent === null ? null : 1 - percent / 100)),
                    { cols, rows, bounds },
                );
                setContourData(map, WEATHER_SOURCE_ID, bands);
            } catch (err) {
                if (requestId === requestIdRef.current && !(err instanceof DOMException && err.name === 'AbortError')) {
                    setGridError(err instanceof Error ? err.message : String(err));
                }
            } finally {
                if (requestId === requestIdRef.current) setLoading(false);
            }
        }
        recomputeRef.current = () => void recompute(false);

        map.on('load', () => {
            hasLoadedRef.current = true;
            setupContourMapView(map, WEATHER_SOURCE_ID, useEclipseStore.getState().path, () => recomputeRef.current(), selectPoint);
        });

        const onMoveEnd = () => {
            // A programmatic jumpTo from another (possibly hidden) view being panned also fires
            // 'moveend' — without this check, panning any other tab would recompute the whole
            // Météo grid for a view nobody's even looking at.
            if (isSyncing()) return;
            if (debounceRef.current) clearTimeout(debounceRef.current);
            // Same debounce as the obstruction map. It used to be 900ms because each recompute
            // was a round trip against a rate-limited forecast API; the climatology tiles are
            // static and usually already cached, so there is nothing left to pace against and
            // the extra half-second was pure lag.
            debounceRef.current = setTimeout(() => void recompute(true), 350);
        };
        map.on('moveend', onMoveEnd);

        return () => {
            unregisterExportableMap('weather');
            if (debounceRef.current) clearTimeout(debounceRef.current);
            abortControllerRef.current?.abort();
            cleanup();
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
    }, [path, selectedDate, summary, eclipseMode, lunarSummary]);

    // The day-window setting doesn't affect the path/context layers, just the grid values.
    useEffect(() => {
        if (!hasLoadedRef.current) return;
        recomputeRef.current();
    }, [weatherDayWindow]);

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
            {loading && <div className="obstruction-loading">{t('map.computingWeather')}</div>}
            {!loading && gridError && (
                <div className="obstruction-hint">{t('map.weatherError')}</div>
            )}
            {mapLoadError && <div className="obstruction-hint">{t(MAP_LOAD_ERROR_KEY)}</div>}
            {uiReferenceTime && (
                // Stacked directly above the legend (same left edge) rather than bottom-right,
                // which overlaps MapLibre's attribution control and silently eats clicks there.
                <div className="day-window-toggle" style={{ position: 'absolute', bottom: 108, left: 14, zIndex: 5 }} role="group" aria-label={t('weather.dayWindowGroup')}>
                    {[1, 5, 7].map((days) => (
                        <button
                            key={days}
                            type="button"
                            className={weatherDayWindow === days ? 'active' : ''}
                            onClick={() => useEclipseStore.getState().setWeatherDayWindow(days)}
                        >
                            {days === 1 ? t('weather.day') : t('weather.days', { count: days })}
                        </button>
                    ))}
                </div>
            )}
            <ContourLegend
                lowLabel={t('legend.covered')}
                highLabel={t('legend.clearSky')}
                note={t('legend.weatherNote', { window: weatherDayWindow, baseline: CLIMATOLOGY_BASELINE_LABEL })}
            />
        </div>
    );
}
