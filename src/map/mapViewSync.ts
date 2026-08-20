import type { MapLibreMap } from 'maplibre-gl';
import { useEclipseStore } from '../state/eclipseStore';

export interface MapViewSync {
    cleanup: () => void;
    /** True while the map's *current* view matches the most recent programmatic `jumpTo` this
     *  sync applied (i.e. its resulting 'moveend' — whenever it actually fires — corresponds to
     *  another view's pan, not a real user gesture on this map). Deliberately a value comparison
     *  rather than a "just called jumpTo" timing flag: `jumpTo` is documented as instant, but
     *  nothing guarantees its 'moveend' is dispatched synchronously before the call returns, and
     *  a timing flag reset right after the call missed that event in practice. Comparing views
     *  instead works regardless of when the event fires. Lets a map's *other* 'moveend' listeners
     *  (e.g. "recompute the obstruction/weather grid") skip programmatic syncs instead of
     *  recomputing every time some other, possibly hidden, view gets panned. */
    isSyncing: () => boolean;
}

/**
 * Keeps a MapLibre map's center/zoom mirrored with the shared store value, so switching
 * between the 2D map and the obstruction map preserves your position. Guards against feedback
 * loops: applying an incoming view records it as "already synced" before the resulting
 * moveend fires, so that moveend doesn't write the exact same value straight back.
 */
export function attachMapViewSync(map: MapLibreMap): MapViewSync {
    const viewKey = (view: { center: [number, number]; zoom: number }) => JSON.stringify(view);

    const currentViewKey = () => {
        const center = map.getCenter();
        return viewKey({ center: [center.lng, center.lat], zoom: map.getZoom() });
    };

    // Seeded from the map's own just-constructed view (which createSyncedMap already seeds from
    // the shared store when one exists) rather than left null — a null starting point means the
    // very first 'moveend' this map ever fires, for *any* reason, including `resize()` (called by
    // the PDF export right after activating a freshly-mounted view, well before this map's style
    // has loaded and syncFromStore has run), looks exactly like a real user pan and gets written
    // straight back to the shared store, resetting every other already-open map to wherever this
    // one happened to be sitting at that instant. Starting both keys at the map's real initial
    // view means that exact case is recognized as "already synced" and skipped.
    let lastSynced: string | null = currentViewKey();
    // Only ever written by applyView, right before the jumpTo whose resulting view it names —
    // never by a real user pan (see onMoveEnd below) — so comparing the map's live view against
    // it is a reliable "was the current position reached programmatically" check.
    let lastAppliedSyncKey: string | null = lastSynced;

    const applyView = (view: { center: [number, number]; zoom: number }) => {
        const key = viewKey(view);
        if (key === lastSynced) return;
        lastSynced = key;
        lastAppliedSyncKey = key;
        map.jumpTo({ center: view.center, zoom: view.zoom });
    };

    const syncFromStore = () => {
        const view = useEclipseStore.getState().mapView;
        if (view) applyView(view);
    };

    if (map.isStyleLoaded()) syncFromStore();
    else map.once('load', syncFromStore);

    const onMoveEnd = () => {
        const center = map.getCenter();
        const view: { center: [number, number]; zoom: number } = { center: [center.lng, center.lat], zoom: map.getZoom() };
        const key = viewKey(view);
        if (key === lastSynced) return;
        lastSynced = key;
        useEclipseStore.getState().setMapView(view);
    };
    map.on('moveend', onMoveEnd);

    const unsubscribe = useEclipseStore.subscribe((state, prevState) => {
        if (state.mapView && state.mapView !== prevState.mapView) applyView(state.mapView);
    });

    return {
        cleanup: () => {
            map.off('moveend', onMoveEnd);
            unsubscribe();
        },
        isSyncing: () => currentViewKey() === lastAppliedSyncKey,
    };
}
