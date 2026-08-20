import type { ErrorEvent, GeoJSONSource, MapMouseEvent } from 'maplibre-gl';
import { MapLibreMap, Marker, NavigationControl } from 'maplibre-gl';
import { useEffect, useRef } from 'react';
import type { EclipsePathGeoJSON } from '../engine/eclipse';
import type { LatLon } from '../engine/types';
import { useEclipseStore } from '../state/eclipseStore';
import { attachMapViewSync } from './mapViewSync';

/** Shared by every map view that draws the eclipse path — factored out here (rather than
 *  duplicated per file) after the obstruction/weather overlays and the classic 2D map drifted
 *  out of sync once already. */
export const EMPTY_FEATURE_COLLECTION: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

export function toFeatureCollection(feature: GeoJSON.Feature | null): GeoJSON.FeatureCollection {
    return feature ? { type: 'FeatureCollection', features: [feature] } : EMPTY_FEATURE_COLLECTION;
}

/** Constructs a MapLibre map with the app's standard style/controls/shared-view-sync wiring.
 *  Returns a single cleanup function covering everything this created, plus `isSyncing` so a
 *  caller's own 'moveend' handler can tell a programmatic view-sync jump (from another,
 *  possibly hidden, view being panned) apart from a real user pan on this map. */
export function createSyncedMap(
    container: HTMLDivElement,
    styleUrl: string,
): { map: MapLibreMap; cleanup: () => void; isSyncing: () => boolean } {
    // Seeded from the shared view if one already exists (i.e. this isn't the very first map the
    // app has ever created) rather than always starting at the hardcoded default — a map that's
    // mounting for the first time well into a session (e.g. a tab the user only opens via PDF
    // export, long after panning the 2D map elsewhere) would otherwise sit at [0, 30]/zoom 2 for
    // the window between construction and its own 'load'-triggered sync, and `resize()` firing a
    // `moveend` inside that window would write that wrong default straight back into the shared
    // store — resetting every *other* already-open, correctly-positioned map too, not just this
    // new one. Starting pre-seeded closes that window rather than racing to fix it after the fact.
    const initialView = useEclipseStore.getState().mapView;
    // preserveDrawingBuffer: the PDF export reads each map's canvas via toDataURL() well after
    // its own render call returns — without this, WebGL is free to clear the drawing buffer
    // right after presenting a frame, and the captured image comes back blank.
    const map = new MapLibreMap({
        container,
        style: styleUrl,
        center: initialView ? initialView.center : [0, 30],
        zoom: initialView ? initialView.zoom : 2,
        canvasContextAttributes: { preserveDrawingBuffer: true },
    });
    map.addControl(new NavigationControl(), 'top-right');
    const viewSync = attachMapViewSync(map);

    return {
        map,
        cleanup: () => {
            viewSync.cleanup();
            map.remove();
        },
        isSyncing: viewSync.isSyncing,
    };
}

/** The three empty GeoJSON sources every path-drawing map view needs, populated later via
 *  setPathSourceData once real path data is available. */
export function addPathSources(map: MapLibreMap): void {
    map.addSource('penumbra', { type: 'geojson', data: EMPTY_FEATURE_COLLECTION });
    map.addSource('umbra', { type: 'geojson', data: EMPTY_FEATURE_COLLECTION });
    map.addSource('central-line', { type: 'geojson', data: EMPTY_FEATURE_COLLECTION });
}

/** The path outline layers shared by every map view: a thin penumbra boundary, a heavier umbra
 *  boundary, and the red central line. `beforeId`, if given, keeps these under an existing
 *  layer (e.g. a contour-band overlay's own fill/line layers). */
export function addPathOutlineLayers(map: MapLibreMap, beforeId?: string): void {
    map.addLayer(
        { id: 'penumbra-outline', type: 'line', source: 'penumbra', paint: { 'line-color': '#4a5568', 'line-width': 1, 'line-opacity': 0.5 } },
        beforeId,
    );
    map.addLayer(
        { id: 'umbra-outline', type: 'line', source: 'umbra', paint: { 'line-color': '#1a202c', 'line-width': 1.5 } },
        beforeId,
    );
    map.addLayer(
        { id: 'central-line-layer', type: 'line', source: 'central-line', paint: { 'line-color': '#e53e3e', 'line-width': 2 } },
        beforeId,
    );
}

/** Pushes path polygon/line data into the shared sources — safe to call even on a map that
 *  doesn't have a given source (e.g. only EclipseMap has 'time-ticks'), since a missing
 *  source's setData is just a no-op via the optional chain. */
export function setPathSourceData(map: MapLibreMap, path: EclipsePathGeoJSON | null): void {
    (map.getSource('penumbra') as GeoJSONSource | undefined)?.setData(toFeatureCollection(path?.penumbraPolygon ?? null));
    (map.getSource('umbra') as GeoJSONSource | undefined)?.setData(toFeatureCollection(path?.umbraPolygon ?? null));
    (map.getSource('central-line') as GeoJSONSource | undefined)?.setData(toFeatureCollection(path?.centralLine ?? null));
}

/** World-covering exterior ring (clamped to ±85° — Web Mercator's own usable range, same as the
 *  base map itself) for the mask polygon below. */
const WORLD_RING: GeoJSON.Position[] = [
    [-180, -85],
    [180, -85],
    [180, 85],
    [-180, 85],
    [-180, -85],
];

/** Adds an (initially empty) dark overlay source+layer that, once given a polygon via
 *  setFocusMaskData, covers the whole world except that polygon's interior — used by FocusMap to
 *  visually de-emphasize everything outside the eclipse's own penumbra, so its composite quality
 *  grid reads as the sole focus of the view. */
export function addFocusMaskLayer(map: MapLibreMap, sourceId: string, beforeId?: string): void {
    map.addSource(sourceId, { type: 'geojson', data: EMPTY_FEATURE_COLLECTION });
    map.addLayer(
        { id: `${sourceId}-fill`, type: 'fill', source: sourceId, paint: { 'fill-color': '#0a0a12', 'fill-opacity': 0.72 } },
        beforeId,
    );
}

/** Twice the signed area of a ring (shoelace formula) — sign alone tells winding direction
 *  (positive = counter-clockwise in a standard x-right/y-up plane), which is all setFocusMaskData
 *  below needs. */
function signedRingArea(ring: GeoJSON.Position[]): number {
    let sum = 0;
    // Loop-bounded: i stays within [0, ring.length - 2], so both ring[i] and ring[i + 1] (at most
    // the last element) are always in range. Position is plain number[], but every ring here
    // comes from our own geometry (WORLD_RING, or a polygon's own coordinate ring) — always
    // [lon, lat] pairs, never a sparser point.
    for (let i = 0; i < ring.length - 1; i++) {
        const p1 = ring[i]!;
        const p2 = ring[i + 1]!;
        sum += p1[0]! * p2[1]! - p2[0]! * p1[1]!;
    }
    return sum;
}

const WORLD_RING_WINDING = Math.sign(signedRingArea(WORLD_RING));

/** "Punch a hole" technique: the world rectangle as the exterior ring, the given polygon's own
 *  ring as the interior (hole) ring. A hole must wind opposite to its exterior ring for
 *  MapLibre's tessellation to cut it out rather than union it in — checked via signed area
 *  rather than assumed, since the source polygon's own winding isn't otherwise documented here. */
export function setFocusMaskData(map: MapLibreMap, sourceId: string, polygon: GeoJSON.Feature<GeoJSON.Polygon> | null): void {
    const source = map.getSource(sourceId) as GeoJSONSource | undefined;
    if (!source) return;
    if (!polygon) {
        source.setData(EMPTY_FEATURE_COLLECTION);
        return;
    }
    // coordinates[0] is a Polygon's outer ring, which the GeoJSON spec guarantees exists whenever
    // the polygon itself does — a Polygon never has zero rings.
    let hole = polygon.geometry.coordinates[0]!;
    if (Math.sign(signedRingArea(hole)) === WORLD_RING_WINDING) hole = [...hole].reverse();
    source.setData({
        type: 'FeatureCollection',
        features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [WORLD_RING, hole] } }],
    });
}

/** Grid column/row count from a container's pixel size — shared by the obstruction and weather
 *  overlays, which both derive their grid resolution from roughly one cell per `cellPx` CSS
 *  pixels, clamped to a view-specific min/max. */
export function gridDimsFromContainer(
    container: HTMLElement | null,
    cellPx: number,
    bounds: { minCols: number; maxCols: number; minRows: number; maxRows: number },
): { cols: number; rows: number } {
    return {
        cols: Math.min(bounds.maxCols, Math.max(bounds.minCols, Math.round((container?.clientWidth ?? 800) / cellPx))),
        rows: Math.min(bounds.maxRows, Math.max(bounds.minRows, Math.round((container?.clientHeight ?? 600) / cellPx))),
    };
}

/** Message shown by every map view when its underlying MapLibre instance fires an 'error' event
 *  (failed style/tile load — offline, a blocked CDN, a bad style URL, ...). Without any handler
 *  at all, that failure is silent: the map container just stays blank forever with nothing to
 *  tell the user why. Shared here (rather than four slightly different strings) so the message
 *  reads the same regardless of which view happened to fail. A translation key rather than a
 *  literal, since this module has no `t` of its own — the views resolve it when they render it. */
export const MAP_LOAD_ERROR_KEY = 'map.loadError' as const;

/** Wires a `map.on('error', …)` handler that logs the underlying error and calls `onError()` —
 *  callers render their own small overlay off whatever state `onError` sets, since each view's
 *  overlay sits alongside its own other status messages (zoom hints, loading spinners, …) rather
 *  than through one shared component. Errors can fire more than once (e.g. a flaky connection
 *  retrying several failed tile requests), so `onError` is called every time rather than once. */
export function attachMapErrorHandler(map: MapLibreMap, onError: (event: ErrorEvent) => void): void {
    map.on('error', (e) => {
        console.error('MapLibre error:', e.error ?? e);
        onError(e);
    });
}

/** Wires the standard "click the map to select a point" behaviour shared by every view. */
export function attachSelectPointOnClick(map: MapLibreMap, selectPoint: (point: LatLon) => void): void {
    map.on('click', (e: MapMouseEvent) => {
        selectPoint({ lat: e.lngLat.lat, lon: e.lngLat.lng });
    });
}

/** Keeps a single marker on `map` at the selected point, replacing/removing it as the
 *  selection changes — identical across every map view, so shared here rather than
 *  copy-pasted (as it was until three components' copies had already drifted apart once). */
export function useSelectedPointMarker(mapRef: React.RefObject<MapLibreMap | null>, selectedPoint: LatLon | null): void {
    const markerRef = useRef<Marker | null>(null);

    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;

        markerRef.current?.remove();
        markerRef.current = null;

        if (selectedPoint) {
            markerRef.current = new Marker({ color: '#e53e3e' }).setLngLat([selectedPoint.lon, selectedPoint.lat]).addTo(map);
        }
        // Explicit cleanup rather than relying on map.remove() tearing down the whole container
        // on unmount (true today, but only incidentally — this marker's own DOM node/listeners
        // should be released on unmount regardless of whether the map itself is going away at the
        // same time).
        return () => {
            markerRef.current?.remove();
            markerRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedPoint]);
}
