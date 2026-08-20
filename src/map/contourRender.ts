import { contours as contourGenerator } from 'd3-contour';
import { colormapColor, INFERNO_STOPS } from './gridRender';
import type { ColorStop } from './gridRender';

/** Cells strictly below the lowest threshold (0) never satisfy `value >= threshold` for any
 *  band, so "no data" (outside the eclipse's penumbra, or no forecast/climatology value) can be
 *  represented by a sentinel below every real value instead of needing a separate mask —
 *  marching squares just naturally excludes it from every band. */
const NO_DATA_SENTINEL = -1;

/** Number of colour bands the 0-1 value range is quantized into. Raised from 6: at that count
 *  each band covered a 17-point spread, so a whole viewport of genuinely varied terrain
 *  collapsed into two or three flat blocks and read as much coarser than the underlying data
 *  actually is. 14 is fine enough to look like a gradient at a glance while staying a *banded*
 *  isopleth map — the bands are what make the contour lines meaningful and keep the whole overlay
 *  exportable as vectors rather than a raster. The cost is one extra marching-squares pass per
 *  band, which measured as a small fraction of the grid computation that feeds it. */
const BAND_COUNT = 14;

/** Evenly spaced band edges; each band [thresholds[i], thresholds[i+1]) — or [thresholds[i], 1]
 *  for the last one — gets one flat, opaque colour, in contrast to the continuous per-pixel
 *  ramp in gridRender.ts. */
const DEFAULT_THRESHOLDS = Array.from({ length: BAND_COUNT }, (_, i) => i / BAND_COUNT);

export interface ContourBandsOptions {
    cols: number;
    rows: number;
    bounds: { west: number; south: number; east: number; north: number };
    thresholds?: number[];
    stops?: ColorStop[];
}

export interface ContourBandProperties {
    bandIndex: number;
}

/** One flat RGB colour per band, sampled at each band's midpoint on the shared colormap so the
 *  bands still read as the same purple→yellow ramp as the continuous version, just quantized. */
export function bandColors(thresholds: number[] = DEFAULT_THRESHOLDS, stops: ColorStop[] = INFERNO_STOPS): string[] {
    return thresholds.map((t, i) => {
        // Bounds already checked one line above (i + 1 < thresholds.length) before indexing.
        const next = i + 1 < thresholds.length ? thresholds[i + 1]! : 1;
        const [r, g, b] = colormapColor((t + next) / 2, stops);
        return `rgb(${r}, ${g}, ${b})`;
    });
}

/**
 * Converts a row-major grid of 0-1 values (null = no data) into discrete filled contour bands
 * via marching squares (d3-contour), one MultiPolygon feature per threshold. Each feature
 * covers "value >= threshold", so stacking them from the lowest threshold up (as separate
 * MapLibre layers, in ascending order) makes each higher, smaller polygon paint over the
 * previous one — the classic isopleth/choropleth "painter's algorithm" technique — leaving each
 * band's own flat colour visible only in the value range it actually owns.
 *
 * Coordinates come out of d3-contour in grid index space (0..cols, 0..rows, row increasing
 * downward) and are transformed into lon/lat here, matching how the source grid's row-major
 * cells were laid out over `bounds` (row 0 = north edge, same "y down" convention as the grid).
 */
export function valueGridToContourBands(
    values: Array<number | null>,
    { cols, rows, bounds, thresholds = DEFAULT_THRESHOLDS }: ContourBandsOptions,
): GeoJSON.FeatureCollection<GeoJSON.MultiPolygon, ContourBandProperties> {
    if (values.length !== cols * rows || cols < 2 || rows < 2) {
        return { type: 'FeatureCollection', features: [] };
    }

    const numeric = values.map((v) => (v === null ? NO_DATA_SENTINEL : v));
    const generator = contourGenerator().size([cols, rows]);

    const toLonLat = (x: number, y: number): GeoJSON.Position => [
        bounds.west + (x / cols) * (bounds.east - bounds.west),
        bounds.north - (y / rows) * (bounds.north - bounds.south),
    ];

    const features: GeoJSON.Feature<GeoJSON.MultiPolygon, ContourBandProperties>[] = [];
    thresholds.forEach((threshold, bandIndex) => {
        const geometry = generator.contour(numeric, threshold);
        // toLonLat mirrors the y-axis (grid row increases southward, latitude decreases), which
        // flips every ring's winding order. Reversing each ring's point order un-flips it back
        // to correct GeoJSON winding (CCW exterior / CW holes) — without this, MapLibre's
        // tessellator silently produces degenerate (invisible) geometry for the mirrored rings.
        // Position is typed as plain number[], but d3-contour's marching-squares output always
        // emits planar [x, y] pairs for every ring point — never a sparser one.
        const coordinates = geometry.coordinates.map((polygon) =>
            polygon.map((ring) => ring.map((pos) => toLonLat(pos[0]!, pos[1]!)).reverse()),
        );
        if (coordinates.length === 0) return;
        features.push({
            type: 'Feature',
            properties: { bandIndex },
            geometry: { type: 'MultiPolygon', coordinates },
        });
    });

    return { type: 'FeatureCollection', features };
}
