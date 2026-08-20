import type { GeoJSONSource, MapLibreMap } from 'maplibre-gl';
import type { EclipsePathGeoJSON } from '../engine/eclipse';
import type { LatLon } from '../engine/types';
import { bandColors } from './contourRender';
import { addPathOutlineLayers, addPathSources, attachSelectPointOnClick, setPathSourceData } from './sharedMapSetup';

export interface ContourLayerIds {
    sourceId: string;
    fillLayerId: string;
    lineLayerId: string;
}

/** The first symbol (label) layer in the loaded style, if any — used as the default insertion
 *  point for the contour layers so place names and road labels stay legible on top of the
 *  colour bands instead of being buried under an opaque fill. */
export function findFirstSymbolLayerId(map: MapLibreMap): string | undefined {
    return map.getStyle()?.layers?.find((layer) => layer.type === 'symbol')?.id;
}

/** Adds an (initially empty) GeoJSON source plus a single fill layer, coloured per-feature by a
 *  `step` expression on `bandIndex`, plus a shared outline layer on top — giving the classic
 *  isopleth-map look: flat colour bands with visible contour lines between them, instead of a
 *  blurred continuous gradient.
 *
 *  One layer, not one per band: MapLibre (like Mapbox GL) renders a fill layer's features from a
 *  GeoJSON source in the order they appear in the data, which is exactly the order
 *  `valueGridToContourBands` already relies on for its "higher/smaller polygon paints over the
 *  previous one" isoband stacking — the standard technique for isoband choropleths, and no less
 *  correct than filtering into N layers, just without paying for N filter evaluations and N draw
 *  calls against the same source every frame.
 *
 *  `beforeId`, if given, keeps these layers under an existing one (e.g. the eclipse path lines,
 *  so they stay crisp on top of the colour wash rather than tinted through it). */
export function addContourLayers(map: MapLibreMap, sourceId: string, beforeId?: string): ContourLayerIds {
    map.addSource(sourceId, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

    const colors = bandColors();
    const fillColorExpression: unknown[] = ['step', ['get', 'bandIndex'], colors[0]];
    for (let bandIndex = 1; bandIndex < colors.length; bandIndex++) {
        fillColorExpression.push(bandIndex, colors[bandIndex]);
    }

    const fillLayerId = `${sourceId}-fill`;
    map.addLayer(
        {
            id: fillLayerId,
            type: 'fill',
            source: sourceId,
            paint: { 'fill-color': fillColorExpression as any, 'fill-opacity': 0.82 },
        },
        beforeId,
    );

    const lineLayerId = `${sourceId}-lines`;
    map.addLayer(
        {
            id: lineLayerId,
            type: 'line',
            source: sourceId,
            // Lighter and thinner than when the overlay had six bands: the same stroke repeated
            // across fourteen closely-spaced isolines reads as hatching rather than as contours,
            // and fights the basemap labels underneath. Kept rather than dropped because the
            // lines are what distinguish an isopleth map from a blurred gradient.
            paint: { 'line-color': 'rgba(255, 255, 255, 0.22)', 'line-width': 0.5 },
        },
        beforeId,
    );

    return { sourceId, fillLayerId, lineLayerId };
}

export function setContourData(map: MapLibreMap, sourceId: string, data: GeoJSON.FeatureCollection): void {
    (map.getSource(sourceId) as GeoJSONSource | undefined)?.setData(data);
}

/** Full bootstrap for a contour-overlay map view (Obstruction/Weather): contour bands, then the
 *  shared path sources/outlines on top, the initial path data, the first recompute, and
 *  click-to-select — both overlay views need this exact sequence in this exact order (contour
 *  layers must go in before the outlines so those render crisply on top of the colour wash, and
 *  before the base style's labels so place names stay legible), so it's factored out here after
 *  it had been duplicated verbatim between the two. */
export function setupContourMapView(
    map: MapLibreMap,
    sourceId: string,
    path: EclipsePathGeoJSON | null,
    recompute: () => void,
    selectPoint: (point: LatLon) => void,
): void {
    addContourLayers(map, sourceId, findFirstSymbolLayerId(map));
    addPathSources(map);
    addPathOutlineLayers(map);
    setPathSourceData(map, path);
    recompute();
    attachSelectPointOnClick(map, selectPoint);
}
