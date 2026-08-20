import type { MapLibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../i18n';
import { useEclipseStore } from '../state/eclipseStore';
import { computeLunarVisibilityGrid } from '../terrain/lunarVisibilityGrid';
import { ObstructionWorkerClient } from '../terrain/obstructionWorkerClient';
import type { ObstructionCell } from '../terrain/obstructionGrid';
import { combineQualityScore } from '../terrain/qualityScore';
import { getWeatherGrid } from '../weather/weather';
import { setContourData, setupContourMapView } from './contourLayers';
import { ContourLegend } from './ContourLegend';
import { valueGridToContourBands } from './contourRender';
import { colormapColor, INFERNO_STOPS } from './gridRender';
import { registerExportableMap, unregisterExportableMap } from './mapRegistry';
import {
    addFocusMaskLayer,
    attachMapErrorHandler,
    createSyncedMap,
    gridDimsFromContainer,
    MAP_LOAD_ERROR_KEY,
    setFocusMaskData,
    setPathSourceData,
    useSelectedPointMarker,
} from './sharedMapSetup';

const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const MIN_ZOOM = 5;
// A bit denser than ObstructionMap's own grid (CELL_PX 15, up to 110x70): this view is
// specifically meant as a focused "where's genuinely best" search, so it's worth spending more
// on resolution than the general obstruction overview. The dominant cost either way is the same
// Web Worker terrain computation, not the (cheap, static-tile) weather fetch added on top.
const CELL_PX = 12;
const GRID_BOUNDS = { minCols: 24, maxCols: 130, minRows: 16, maxRows: 85 };
const FOCUS_SOURCE_ID = 'focus-bands';
const MASK_SOURCE_ID = 'focus-mask';

interface FocusMapProps {
    visible: boolean;
}

/** Combines terrain visibility, climatology cloud cover, and each cell's own eclipse duration
 *  (or magnitude, for eclipses with no central phase anywhere) into one 0-1 "how good is this
 *  spot, all things considered" score. All three factors are already 0-1 fractions of their own
 *  best case, so a plain product is a natural AND-like combination: a cell only scores well if
 *  it's genuinely good on every axis, not just on average.
 *
 *  For an eclipse with a real total/annular phase somewhere, cells with no centrality of their
 *  own are excluded entirely (null) rather than scored — this view is specifically about "where
 *  should I stand for totality", not a general partial-eclipse quality map, so a partial-only
 *  cell showing up as a (correctly low, but still visibly present) "Faible" band would be
 *  misleading rather than just unhelpful. Purely partial eclipses (no central phase anywhere)
 *  fall back to magnitude, since there's no centrality to require. */
function combineScore(
    cell: ObstructionCell,
    cloudCoverPercent: number | null,
    maxCentralDurationSeconds: number,
    maxMagnitude: number,
    includeDuration: boolean,
): number | null {
    return combineQualityScore({
        visibleFraction: cell.visibleFraction,
        magnitude: cell.magnitude,
        centralDurationSeconds: cell.centralDurationSeconds,
        cloudCoverPercent,
        maxCentralDurationSeconds,
        maxMagnitude,
        includeDuration,
    });
}

/** "Qualité" view (internally still `focus` — the id threads through mapRegistry, viewControl
 *  and the `focus-bands`/`focus-mask` layer ids, so renaming it would be churn with no user-facing
 *  benefit): a single composite quality score (relief + weather + eclipse duration) over a
 *  fixed-size grid recomputed on pan/zoom like Obstruction/Météo — not a separate one-off
 *  whole-path precompute, just those same two overlays' data combined into one number, at a
 *  denser base resolution — plus a dark mask outside the eclipse's own penumbra so the view
 *  reads as "just this", not a normal world map with an overlay. */
export function FocusMap({ visible }: FocusMapProps) {
    const t = useT();
    const containerRef = useRef<HTMLDivElement | null>(null);
    const mapRef = useRef<MapLibreMap | null>(null);
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const requestIdRef = useRef(0);
    const recomputeRef = useRef<() => void>(() => {});
    const workerClientRef = useRef<ObstructionWorkerClient | null>(null);
    const hasLoadedRef = useRef(false);

    const path = useEclipseStore((s) => s.path);
    const summary = useEclipseStore((s) => s.summary);
    const selectedDate = useEclipseStore((s) => s.selectedDate);
    const selectedPoint = useEclipseStore((s) => s.selectedPoint);
    const selectPoint = useEclipseStore((s) => s.selectPoint);
    // Only the day-window setting applies here — the grid-wide weather fetch, like WeatherMap's
    // own, has no hour-precision variant (that tile set is only fetched for single-point
    // lookups; fetching it across a whole grid of cells would be far too heavy).
    const weatherDayWindow = useEclipseStore((s) => s.weatherDayWindow);
    const eclipseMode = useEclipseStore((s) => s.eclipseMode);
    const lunarSummary = useEclipseStore((s) => s.lunarSummary);
    const focusIncludeDuration = useEclipseStore((s) => s.focusIncludeDuration);
    const setFocusIncludeDuration = useEclipseStore((s) => s.setFocusIncludeDuration);

    // Everything below is already computed by the shared selectPoint flow (every map view wires
    // clicks to it) — reused here as-is rather than re-fetched, so the same click that places the
    // marker also yields this exact score with no extra work.
    const localCircumstances = useEclipseStore((s) => s.localCircumstances);
    const terrainVisibility = useEclipseStore((s) => s.terrainVisibility);
    const terrainLoading = useEclipseStore((s) => s.terrainLoading);
    const cloudCover = useEclipseStore((s) => s.cloudCover);
    const weatherLoading = useEclipseStore((s) => s.weatherLoading);
    const pointOutsideEclipse = useEclipseStore((s) => s.pointOutsideEclipse);

    const [zoomTooLow, setZoomTooLow] = useState(false);
    const [loading, setLoading] = useState(false);
    /** Every cell in view was excluded for having no central phase. Distinct from "still loading"
     *  and from "zoom in": the grid computed fine, the answer is genuinely "nothing here". Without
     *  saying so the view is just a blank map, which reads as broken rather than as an answer. */
    const [outsideCentrality, setOutsideCentrality] = useState(false);
    const [mapLoadError, setMapLoadError] = useState(false);

    const pointScore = useMemo(() => {
        if (!selectedPoint || !terrainVisibility || !cloudCover) return null;
        const visibleFraction =
            terrainVisibility.theoreticalDurationSeconds > 0
                ? terrainVisibility.visibleDurationSeconds / terrainVisibility.theoreticalDurationSeconds
                : 0;
        // A lunar eclipse has no `summary` (that's the solar Besselian one) and no duration term —
        // it lasts the same everywhere — so its score is relief × météo, exactly what the grid
        // underneath computes. Routing it through the solar branch instead made this readout
        // *always* null in lunar mode, so every clicked point reported "hors zone de totalité"
        // while the map beneath it was painting a perfectly good score at that very spot.
        if (eclipseMode === 'lunar') {
            return visibleFraction * Math.max(0, Math.min(1, 1 - cloudCover.percent / 100));
        }
        if (!localCircumstances || !summary) return null;
        return combineQualityScore({
            visibleFraction,
            magnitude: localCircumstances.maxMagnitude,
            centralDurationSeconds: localCircumstances.centralDurationSeconds,
            cloudCoverPercent: cloudCover.percent,
            maxCentralDurationSeconds: summary.maxCentralDurationSeconds,
            maxMagnitude: summary.magnitude,
            includeDuration: focusIncludeDuration,
        });
    }, [selectedPoint, localCircumstances, terrainVisibility, cloudCover, summary, focusIncludeDuration, eclipseMode]);

    useEffect(() => {
        if (!containerRef.current || mapRef.current) return;

        const { map, cleanup, isSyncing } = createSyncedMap(containerRef.current, STYLE_URL);
        mapRef.current = map;
        registerExportableMap('focus', map);
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

            const state = useEclipseStore.getState();
            const { selectedDate: date, summary: currentSummary, eclipseMode: mode, lunarSummary: lunar, weatherDayWindow: currentWeatherDayWindow } = state;
            // For a lunar eclipse there is no duration factor to apply (the eclipse lasts the same
            // everywhere), so the score is relief × météo — exactly what the "Sans durée" switch
            // already computes on the solar side.
            const referenceTime = mode === 'lunar' ? lunar?.contacts.greatest : currentSummary?.greatestEclipse.time;
            if (!date || !referenceTime || !hasLoadedRef.current || (mode === 'lunar' ? !lunar : !currentSummary)) {
                setLoading(false);
                return;
            }

            setLoading(true);
            try {
                const b = map.getBounds();
                const bounds = { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() };
                const { cols, rows } = gridDimsFromContainer(containerRef.current, CELL_PX, GRID_BOUNDS);

                const points: Array<{ lat: number; lon: number }> = [];
                for (let r = 0; r < rows; r++) {
                    for (let c = 0; c < cols; c++) {
                        points.push({
                            lon: bounds.west + ((c + 0.5) / cols) * (bounds.east - bounds.west),
                            lat: bounds.north - ((r + 0.5) / rows) * (bounds.north - bounds.south),
                        });
                    }
                }

                // Same simplification already used by WeatherMap: one reference time for the
                // whole grid rather than each cell's own local eclipse time.
                const [visibleFractions, cloudCover] = await Promise.all([
                    mode === 'lunar'
                        ? computeLunarVisibilityGrid(lunar!, bounds, cols, rows).then((g) => g.cells.map((c) => c.visibleFraction))
                        : workerClient.compute(date, bounds, cols, rows).then((g) => g.cells),
                    getWeatherGrid(points, bounds, referenceTime, undefined, currentWeatherDayWindow),
                ]);
                if (requestId !== requestIdRef.current) return;

                const includeDuration = useEclipseStore.getState().focusIncludeDuration;
                const scores =
                    mode === 'lunar'
                        ? (visibleFractions as number[]).map((fraction, i) => {
                              const percent = cloudCover[i];
                              // points/cloudCover and visibleFractions/scores all come from the same
                              // cols*rows grid built above, so index i lines up 1:1; `== null` also
                              // catches the (unexpected) undefined case from noUncheckedIndexedAccess
                              // the same way an explicit null (no data) is already handled.
                              if (percent == null) return null;
                              return fraction * Math.max(0, Math.min(1, 1 - percent / 100));
                          })
                        : (visibleFractions as ObstructionCell[]).map((cell, i) =>
                              combineScore(cell, cloudCover[i] ?? null, currentSummary!.maxCentralDurationSeconds, currentSummary!.magnitude, includeDuration),
                          );
                setOutsideCentrality(scores.every((v) => v === null));
                const bands = valueGridToContourBands(scores, { cols, rows, bounds });
                setContourData(map, FOCUS_SOURCE_ID, bands);
            } catch (err) {
                if (requestId === requestIdRef.current && !(err instanceof Error && err.message === 'SUPERSEDED')) {
                    console.error('Focus grid computation failed:', err);
                }
            } finally {
                if (requestId === requestIdRef.current) setLoading(false);
            }
        }
        recomputeRef.current = () => void recompute();

        map.on('load', () => {
            hasLoadedRef.current = true;
            addFocusMaskLayer(map, MASK_SOURCE_ID);
            setupContourMapView(map, FOCUS_SOURCE_ID, useEclipseStore.getState().path, () => recomputeRef.current(), selectPoint);
            const loadedPath = useEclipseStore.getState().path;
            setFocusMaskData(map, MASK_SOURCE_ID, loadedPath?.umbraPolygon ?? loadedPath?.penumbraPolygon ?? null);
        });

        const onMoveEnd = () => {
            if (isSyncing()) return;
            if (debounceRef.current) clearTimeout(debounceRef.current);
            debounceRef.current = setTimeout(() => recomputeRef.current(), 350);
        };
        map.on('moveend', onMoveEnd);

        return () => {
            unregisterExportableMap('focus');
            if (debounceRef.current) clearTimeout(debounceRef.current);
            cleanup();
            workerClient.terminate();
            workerClientRef.current = null;
            mapRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Consolidated: this used to be two separate effects, one keyed on
    // [path, selectedDate, summary, eclipseMode, lunarSummary] and another on
    // [weatherDayWindow, focusIncludeDuration, eclipseMode, lunarSummary] — since eclipseMode and
    // lunarSummary appeared in both, switching solar/lunar mode fired both effects and ran
    // recompute() twice (the requestIdRef guard in recompute() discards the stale one, but that
    // still wastes a full worker computation). One effect with the deduplicated dependency union
    // below runs recompute() exactly once per relevant change.
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !hasLoadedRef.current) return;
        // A lunar eclipse has no umbra polygon to mask against — it is visible from the whole
        // night side — so the mask and path outlines are cleared rather than left showing the
        // previous solar eclipse's geometry.
        const lunar = eclipseMode === 'lunar';
        setPathSourceData(map, lunar ? null : path);
        setFocusMaskData(map, MASK_SOURCE_ID, lunar ? null : (path?.umbraPolygon ?? path?.penumbraPolygon ?? null));
        recomputeRef.current();
    }, [path, selectedDate, summary, eclipseMode, lunarSummary, weatherDayWindow, focusIncludeDuration]);

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
            {zoomTooLow && <div className="obstruction-hint">{t('map.zoomForScore')}</div>}
            {!zoomTooLow && !loading && outsideCentrality && (
                // Same "every cell came back null" state, but it means different things per mode:
                // on the solar side the cells were excluded for having no centrality, while a
                // lunar eclipse excludes nothing — there, an all-null grid can only be missing
                // climatology (e.g. open ocean outside the ERA5 tiles).
                <div className="obstruction-hint">{t(eclipseMode === 'lunar' ? 'focus.noClimatology' : 'focus.outsideCentrality')}</div>
            )}
            {loading && <div className="obstruction-loading">{t('map.computingScore')}</div>}
            {mapLoadError && <div className="obstruction-hint">{t(MAP_LOAD_ERROR_KEY)}</div>}
            <ContourLegend
                lowLabel={t('legend.low')}
                highLabel={t('legend.excellent')}
                note={t(eclipseMode === 'lunar' || !focusIncludeDuration ? 'legend.scoreFormula' : 'legend.scoreFormulaDuration')}
            >
                {eclipseMode !== 'lunar' && (
                <div className="focus-duration-toggle" role="group" aria-label={t('focus.durationGroup')}>
                    <button type="button" className={focusIncludeDuration ? 'active' : ''} onClick={() => setFocusIncludeDuration(true)}>
                        {t('focus.withDuration')}
                    </button>
                    <button type="button" className={focusIncludeDuration ? '' : 'active'} onClick={() => setFocusIncludeDuration(false)}>
                        {t('focus.withoutDuration')}
                    </button>
                </div>
                )}
                {selectedPoint && (
                    <div className="focus-point-score">
                        {terrainLoading || weatherLoading ? (
                            <div className="focus-point-score-message">{t('focus.computingPointScore')}</div>
                        ) : pointScore !== null ? (
                            <>
                                <div className="focus-point-score-label">{t('focus.pointScoreLabel')}</div>
                                <div className="focus-point-score-value">
                                    <span
                                        className="focus-point-score-swatch"
                                        style={{ background: `rgb(${colormapColor(pointScore, INFERNO_STOPS).join(',')})` }}
                                    />
                                    <strong>{Math.round(pointScore * 100)}%</strong>
                                </div>
                            </>
                        ) : pointOutsideEclipse ? (
                            <div className="focus-point-score-message">{t('focus.pointNotSeeing')}</div>
                        ) : (
                            // "Hors zone de totalité" is only ever the reason on the solar side —
                            // a lunar eclipse has no totality zone on Earth at all, so a missing
                            // score there means the relief or the climatology couldn't be resolved.
                            <div className="focus-point-score-message">
                                {t(eclipseMode === 'lunar' ? 'focus.noScoreLunar' : 'focus.noScoreSolar')}
                            </div>
                        )}
                    </div>
                )}
            </ContourLegend>
        </div>
    );
}
