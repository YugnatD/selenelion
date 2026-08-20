import { valueGridToContourBands } from '../map/contourRender';
import type { EclipseSummary } from '../engine/types';
import { ObstructionWorkerClient } from '../terrain/obstructionWorkerClient';
import type { ObstructionGrid } from '../terrain/obstructionGrid';
import type { LunarEclipseSummary } from '../engine/lunarEclipse';
import { computeLunarVisibilityGrid } from '../terrain/lunarVisibilityGrid';
import type { LunarVisibilityGrid } from '../terrain/lunarVisibilityGrid';
import { combineQualityScore } from '../terrain/qualityScore';
import { getWeatherGrid } from '../weather/weather';

export interface Bounds {
    west: number;
    south: number;
    east: number;
    north: number;
}

/** Denser than the interactive grids (Obstruction tops out at 110x70, Focus at 130x85) — the
 *  whole point of the export path is a noticeably crisper result than what panning/zooming can
 *  afford to recompute on every move. Runs in a Web Worker either way, so the main thread stays
 *  responsive. Deliberately well short of this grid's ceiling (was 200x130 = 26,000 points):
 *  measured end-to-end at ~4 minutes for a full multi-page export dominated by this grid's own
 *  elevation-tile network fetches, which is a lot to sit through for a "click a button" action.
 *  140x90 = 12,600 points is roughly half the network/worker cost while still landing well above
 *  the interactive ceiling. */
const FINE_TERRAIN_GRID = { cols: 140, rows: 90 };

/** Climatology is read from local static tiles at no request cost, so the export grid is sized
 *  for the underlying 0.25° data rather than for any API limit. */
const FINE_WEATHER_GRID = { cols: 40, rows: 26 };

function buildPoints(bounds: Bounds, cols: number, rows: number): Array<{ lat: number; lon: number }> {
    const points: Array<{ lat: number; lon: number }> = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            points.push({
                lon: bounds.west + ((c + 0.5) / cols) * (bounds.east - bounds.west),
                lat: bounds.north - ((r + 0.5) / rows) * (bounds.north - bounds.south),
            });
        }
    }
    return points;
}

/** The single most expensive step in a full export: a Web Worker terrain/horizon pass over the
 *  full FINE_TERRAIN_GRID, fetching whatever elevation tiles it doesn't already have cached. Both
 *  the Obstruction page and the Qualité page need exactly this data (Qualité folds it into a
 *  composite score) — the caller is expected to compute it once per bounds and pass the result to
 *  both `obstructionGridToBands` and the focus-scoring helpers below, rather than letting each
 *  page independently trigger its own full pass over the same date/bounds. */
export async function computeFineTerrainGrid(date: string, bounds: Bounds, onProgress?: (fraction: number) => void): Promise<ObstructionGrid> {
    const client = new ObstructionWorkerClient();
    try {
        const { cols, rows } = FINE_TERRAIN_GRID;
        return await client.compute(date, bounds, cols, rows, onProgress);
    } finally {
        client.terminate();
    }
}

/** Cheap, synchronous: turns an already-computed terrain grid into the Obstruction page's bands. */
export function obstructionGridToBands(grid: ObstructionGrid, bounds: Bounds): GeoJSON.FeatureCollection<GeoJSON.MultiPolygon, { bandIndex: number }> {
    return valueGridToContourBands(
        grid.cells.map((c) => c.visibleFraction),
        { cols: grid.cols, rows: grid.rows, bounds },
    );
}

/** Lunar counterpart of computeFineTerrainGrid: where the Moon clears the terrain, at export
 *  resolution. Runs on the main thread rather than the obstruction Web Worker, which only knows
 *  how to resolve solar eclipses from a date string. */
export async function computeFineLunarTerrainGrid(
    summary: LunarEclipseSummary,
    bounds: Bounds,
    onProgress?: (fraction: number) => void,
): Promise<LunarVisibilityGrid> {
    const { cols, rows } = FINE_TERRAIN_GRID;
    return computeLunarVisibilityGrid(summary, bounds, cols, rows, undefined, onProgress);
}

export function lunarVisibilityGridToBands(grid: LunarVisibilityGrid, bounds: Bounds): GeoJSON.FeatureCollection<GeoJSON.MultiPolygon, { bandIndex: number }> {
    return valueGridToContourBands(
        grid.cells.map((c) => c.visibleFraction),
        { cols: grid.cols, rows: grid.rows, bounds },
    );
}

export async function computeFineWeatherBands(
    bounds: Bounds,
    referenceTime: Date,
    dayWindow: number,
): Promise<GeoJSON.FeatureCollection<GeoJSON.MultiPolygon, { bandIndex: number }>> {
    const { cols, rows } = FINE_WEATHER_GRID;
    const points = buildPoints(bounds, cols, rows);
    const cloudCover = await getWeatherGrid(points, bounds, referenceTime, undefined, dayWindow);
    return valueGridToContourBands(
        cloudCover.map((percent) => (percent === null ? null : 1 - percent / 100)),
        { cols, rows, bounds },
    );
}

/** Cloud cover at the *terrain* grid's resolution (not FINE_WEATHER_GRID's coarser one) so it
 *  lines up index-for-index with a terrain grid's `cells` for combineQualityScore — Qualité's own
 *  requirement, independent of whatever the standalone Météo page needs. Climatology reads local
 *  static tiles at no request cost, so the larger point count costs nothing extra worth caching. */
async function computeFocusCloudCover(bounds: Bounds, referenceTime: Date, dayWindow: number): Promise<Array<number | null>> {
    const { cols, rows } = FINE_TERRAIN_GRID;
    const points = buildPoints(bounds, cols, rows);
    return getWeatherGrid(points, bounds, referenceTime, undefined, dayWindow);
}

/** Both duration variants from one already-computed terrain grid — only the final weighting in
 *  combineQualityScore differs between them, so there's no reason to fetch cloud cover twice
 *  either. */
export async function focusScoresToBands(
    grid: ObstructionGrid,
    bounds: Bounds,
    referenceTime: Date,
    dayWindow: number,
    summary: EclipseSummary,
): Promise<{
    withDuration: GeoJSON.FeatureCollection<GeoJSON.MultiPolygon, { bandIndex: number }>;
    withoutDuration: GeoJSON.FeatureCollection<GeoJSON.MultiPolygon, { bandIndex: number }>;
}> {
    const cloudCover = await computeFocusCloudCover(bounds, referenceTime, dayWindow);
    const { cols, rows } = FINE_TERRAIN_GRID;
    const scoresFor = (includeDuration: boolean) =>
        grid.cells.map((cell, i) =>
            combineQualityScore({
                visibleFraction: cell.visibleFraction,
                magnitude: cell.magnitude,
                centralDurationSeconds: cell.centralDurationSeconds,
                // cloudCover is built from the same point count/order as grid.cells (both derive
                // from buildPoints(bounds, FINE_TERRAIN_GRID) in row-major order), so index i lines
                // up 1:1; the `?? null` is just a graceful fallback consistent with the existing
                // "no data at this cell" meaning of null, not a masked bug.
                cloudCoverPercent: cloudCover[i] ?? null,
                maxCentralDurationSeconds: summary.maxCentralDurationSeconds,
                maxMagnitude: summary.magnitude,
                includeDuration,
            }),
        );
    return {
        withDuration: valueGridToContourBands(scoresFor(true), { cols, rows, bounds }),
        withoutDuration: valueGridToContourBands(scoresFor(false), { cols, rows, bounds }),
    };
}

/** Lunar Qualité score at export resolution: relief × météo. There is no duration term because a
 *  lunar eclipse lasts the same everywhere — the same reasoning the on-screen view applies. */
export async function lunarFocusScoreToBands(
    grid: LunarVisibilityGrid,
    bounds: Bounds,
    referenceTime: Date,
    dayWindow: number,
): Promise<GeoJSON.FeatureCollection<GeoJSON.MultiPolygon, { bandIndex: number }>> {
    const cloudCover = await computeFocusCloudCover(bounds, referenceTime, dayWindow);
    const { cols, rows } = FINE_TERRAIN_GRID;
    const scores = grid.cells.map((cell, i) => {
        const percent = cloudCover[i];
        // `== null` also catches the (unexpected, since both derive from the same buildPoints
        // call — see computeFocusCloudCover) undefined case from noUncheckedIndexedAccess,
        // treating it the same as "no data" like an explicit null.
        if (percent == null) return null;
        return cell.visibleFraction * Math.max(0, Math.min(1, 1 - percent / 100));
    });
    return valueGridToContourBands(scores, { cols, rows, bounds });
}
