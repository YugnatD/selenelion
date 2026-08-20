import type { GeoJSONSource, MapLibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef, useState } from 'react';
import { computeLunarVisibilityField, getMoonHorizonBoundary } from '../engine/lunarEclipse';
import { addContourLayers, findFirstSymbolLayerId, setContourData } from './contourLayers';
import { valueGridToContourBands } from './contourRender';
import { useT } from '../i18n';
import { useEclipseStore } from '../state/eclipseStore';
import { registerExportableMap, unregisterExportableMap } from './mapRegistry';
import {
    addPathOutlineLayers,
    addPathSources,
    attachMapErrorHandler,
    attachSelectPointOnClick,
    createSyncedMap,
    EMPTY_FEATURE_COLLECTION,
    MAP_LOAD_ERROR_KEY,
    setPathSourceData,
    useSelectedPointMarker,
} from './sharedMapSetup';

const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const LUNAR_FIELD_SOURCE_ID = 'lunar-visibility';

export function EclipseMap() {
    const t = useT();
    const containerRef = useRef<HTMLDivElement | null>(null);
    const mapRef = useRef<MapLibreMap | null>(null);
    // Tracks the map's own 'load' independently of map.isStyleLoaded(). Pushing data into a
    // GeoJSON source transiently un-sets MapLibre's "all sources loaded" flag, so a live
    // isStyleLoaded() check right after one (e.g. when switching eclipse mode, which rewrites
    // these very sources) reads false — and deferring to `once('load')` then waits forever,
    // because load already fired. The other map views keep this same ref for the same reason.
    const hasLoadedRef = useRef(false);

    const path = useEclipseStore((s) => s.path);
    const eclipseMode = useEclipseStore((s) => s.eclipseMode);
    const lunarSummary = useEclipseStore((s) => s.lunarSummary);
    const selectedPoint = useEclipseStore((s) => s.selectedPoint);
    const selectPoint = useEclipseStore((s) => s.selectPoint);
    const [mapLoadError, setMapLoadError] = useState(false);

    useEffect(() => {
        if (!containerRef.current || mapRef.current) return;

        const { map, cleanup } = createSyncedMap(containerRef.current, STYLE_URL);
        mapRef.current = map;
        registerExportableMap('2d', map);
        attachMapErrorHandler(map, () => setMapLoadError(true));

        map.on('load', () => {
            hasLoadedRef.current = true;
            // Shaded lunar-visibility zones, under everything else so the path outlines, the
            // boundary curves and the basemap labels all stay legible on top. Empty (and
            // therefore invisible) in solar mode.
            addContourLayers(map, LUNAR_FIELD_SOURCE_ID, findFirstSymbolLayerId(map));
            // Repainted away from the inferno ramp the other overlays use. Here the useful reading
            // is "how much do I lose", so the region that sees the whole eclipse is left completely
            // clear and shading deepens towards the areas that see none of it — the convention on
            // published lunar eclipse maps, and the only way the geography underneath stays
            // readable across a whole hemisphere of fill.
            //
            // The opacity ramp runs the opposite way to intuition because contour bands are
            // *stacked*: band 0 covers the whole world, each higher band a smaller subset painted
            // on top. So a region's darkness comes from how many bands cover it, not from one
            // colour. Feeding the inverted fraction (see the field below) puts the most bands over
            // the least-visible areas, and starting the ramp at zero opacity leaves the
            // fully-visible region genuinely untouched rather than merely tinted.
            map.setPaintProperty(`${LUNAR_FIELD_SOURCE_ID}-fill`, 'fill-color', '#1e2a44');
            map.setPaintProperty(`${LUNAR_FIELD_SOURCE_ID}-fill`, 'fill-opacity', [
                'interpolate',
                ['linear'],
                ['get', 'bandIndex'],
                0,
                0,
                13,
                0.12,
            ] as never);
            map.setPaintProperty(`${LUNAR_FIELD_SOURCE_ID}-lines`, 'line-color', 'rgba(255,255,255,0.5)');
            map.setPaintProperty(`${LUNAR_FIELD_SOURCE_ID}-lines`, 'line-opacity', 0.3);
            addPathSources(map);
            map.addSource('time-ticks', { type: 'geojson', data: EMPTY_FEATURE_COLLECTION });

            // The classic 2D map is the only view that fills the penumbra/umbra polygons
            // (rather than just outlining them) — the obstruction/weather overlays already
            // draw their own full-area colour wash, so a second fill there would just compete
            // with it. Added before addPathOutlineLayers so the outlines render on top.
            map.addLayer({
                id: 'penumbra-fill',
                type: 'fill',
                source: 'penumbra',
                // Only fill actual polygons. In lunar mode these sources carry LineStrings (the
                // Moon-visibility boundaries), and a fill layer given a LineString closes it and
                // fills the result — which painted large bogus wedges across the map.
                filter: ['==', ['geometry-type'], 'Polygon'],
                paint: { 'fill-color': '#4a5568', 'fill-opacity': 0.15 },
            });
            map.addLayer({
                id: 'umbra-fill',
                type: 'fill',
                source: 'umbra',
                filter: ['==', ['geometry-type'], 'Polygon'],
                paint: { 'fill-color': '#1a202c', 'fill-opacity': 0.35 },
            });
            addPathOutlineLayers(map);
            map.addLayer({
                id: 'time-ticks-point',
                type: 'circle',
                source: 'time-ticks',
                paint: {
                    'circle-radius': 2.5,
                    'circle-color': '#e53e3e',
                    'circle-stroke-color': '#fff',
                    'circle-stroke-width': 1,
                },
            });
            map.addLayer({
                id: 'time-ticks-label',
                type: 'symbol',
                source: 'time-ticks',
                layout: {
                    'text-field': ['get', 'label'],
                    'text-font': ['Noto Sans Regular'],
                    'text-size': 11,
                    'text-offset': [0, 1],
                    'text-anchor': 'top',
                    'text-allow-overlap': false,
                },
                paint: {
                    'text-color': '#742a2a',
                    'text-halo-color': '#fff',
                    'text-halo-width': 1.2,
                },
            });

            attachSelectPointOnClick(map, selectPoint);
        });

        return () => {
            unregisterExportableMap('2d');
            cleanup();
            mapRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;

        let cancelled = false;

        const applySources = () => {
            if (eclipseMode === 'lunar') {
                // A lunar eclipse has no path. What the 2D map can usefully show instead is where
                // on Earth the Moon is above the horizon — drawn as the boundary of that region at
                // three moments, so you can see it sweep across during the eclipse.
                setPathSourceData(map, null);
                (map.getSource('time-ticks') as GeoJSONSource | undefined)?.setData(EMPTY_FEATURE_COLLECTION);
                if (!lunarSummary) {
                    setContourData(map, LUNAR_FIELD_SOURCE_ID, EMPTY_FEATURE_COLLECTION as never);
                    return;
                }
                const { u1, u4, p1, p4, greatest } = lunarSummary.contacts;
                void computeLunarVisibilityField(lunarSummary).then((field) => {
                    if (cancelled) return;
                    setContourData(
                        map,
                        LUNAR_FIELD_SOURCE_ID,
                        // Inverted: the bands should grow towards "none of it visible", not away
                        // from it — see the opacity note where these layers are created.
                        valueGridToContourBands(
                            field.values.map((v) => 1 - v),
                            { cols: field.cols, rows: field.rows, bounds: field.bounds },
                        ),
                    );
                });
                void Promise.all([
                    getMoonHorizonBoundary(u1 ?? p1),
                    getMoonHorizonBoundary(greatest),
                    getMoonHorizonBoundary(u4 ?? p4),
                ]).then(([atStart, atGreatest, atEnd]) => {
                    if (cancelled) return;
                    // The start/end boundaries go in the thin 'penumbra' outline, the greatest-
                    // eclipse one in the heavier 'umbra' outline so it reads as the main line.
                    (map.getSource('penumbra') as GeoJSONSource | undefined)?.setData({
                        type: 'FeatureCollection',
                        features: [atStart, atEnd],
                    });
                    (map.getSource('umbra') as GeoJSONSource | undefined)?.setData({
                        type: 'FeatureCollection',
                        features: [atGreatest],
                    });
                });
                return;
            }
            setContourData(map, LUNAR_FIELD_SOURCE_ID, EMPTY_FEATURE_COLLECTION as never);
            setPathSourceData(map, path);
            (map.getSource('time-ticks') as GeoJSONSource | undefined)?.setData(path?.timeTicks ?? EMPTY_FEATURE_COLLECTION);
        };

        if (hasLoadedRef.current) {
            applySources();
        } else {
            map.once('load', applySources);
        }
        return () => {
            cancelled = true;
            // once('load', ...) only self-removes once 'load' actually fires — if this effect
            // re-runs (path/eclipseMode/lunarSummary changing again) before the style has
            // finished loading, the previous listener would otherwise stay registered and still
            // fire later, alongside the new one it just registered.
            map.off('load', applySources);
        };
    }, [path, eclipseMode, lunarSummary]);

    useSelectedPointMarker(mapRef, selectedPoint);

    return (
        <div style={{ position: 'absolute', inset: 0 }}>
            <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
            {mapLoadError && <div className="obstruction-hint">{t(MAP_LOAD_ERROR_KEY)}</div>}
            {eclipseMode === 'lunar' && lunarSummary && (
                // Without this the shading is just unexplained darkness: it reads as "something is
                // covered" rather than "this is how much of the eclipse you lose there".
                <div className="lunar-legend">
                    <div className="lunar-legend-scale">
                        <span className="lunar-legend-swatch lunar-legend-clear" />
                        <span className="lunar-legend-swatch lunar-legend-mid" />
                        <span className="lunar-legend-swatch lunar-legend-dark" />
                    </div>
                    <div className="lunar-legend-labels">
                        <span>{t('lunarLegend.whole')}</span>
                        <span>{t('lunarLegend.below')}</span>
                    </div>
                    <p className="lunar-legend-note">{t('lunarLegend.note')}</p>
                </div>
            )}
        </div>
    );
}
