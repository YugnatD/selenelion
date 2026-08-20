import type { LunarEclipseSummary } from '../engine/lunarEclipse';
import { getMoonPositionAt } from '../engine/lunarEclipse';
import { getElevationsBatch } from './elevationTiles';
import { apparentAltitudeDeg, destinationPoint, EYE_HEIGHT_M } from './horizon';

/**
 * "How much of the lunar eclipse actually clears the horizon here" over a map viewport — the
 * lunar counterpart of computeObstructionGrid, and the closest thing a lunar eclipse has to the
 * solar path: it draws the region of Earth where the Moon is up during the event, shaded by how
 * much of it you get.
 *
 * Structurally simpler than the solar grid in one important way. The solar version has to treat
 * the penumbra edge as a discontinuity (a cell either sees an eclipse or does not, and
 * interpolating across that boundary invents eclipses where there are none). Here the eclipse is
 * global — every cell on Earth is "in" it — and the only thing that varies is the Moon's altitude,
 * which is a smooth function of position. So the sub-grid interpolation needs no exact-fallback
 * cases: it is safe everywhere, including across the horizon crossing itself.
 */

/** Moon positions are shared across the whole grid per time sample, so this can be generous. */
const TIME_SAMPLES = 13;
/** Same coupling rule as the solar grid: sample density and tile zoom scale together. */
const RAY_DISTANCES_M = [150, 300, 500, 800, 1200, 1800, 3000, 5000, 8000, 12000, 20000, 30000, 45000, 60000];
const NEAR_FIELD_METERS = 2_000;
const RAY_FAR_ZOOM = 9;
const RAY_NEAR_MAX_ZOOM = 12;
const NEAR_TILE_BUDGET = 64;
const CHUNK_SIZE = 150;
/** Max angular spacing between Moon-position sub-grid nodes. The Moon's apparent altitude changes
 *  by roughly one degree per degree of observer position, smoothly, so this is ample. */
const MOON_STEP_MAX_DEG = 2.5;
const MOON_NODES_MIN = 3;
const MOON_NODES_MAX = 33;

export interface LunarVisibilityCell {
    lat: number;
    lon: number;
    /** Fraction (0-1) of the sampled eclipse window during which the Moon clears the terrain.
     *  Never null: unlike a solar eclipse there is nowhere on Earth that is "outside" it. */
    visibleFraction: number;
    /** The Moon's altitude at greatest eclipse — negative means it is below the horizon then. */
    altitudeAtGreatest: number;
}

export interface LunarVisibilityGrid {
    cols: number;
    rows: number;
    bounds: { west: number; south: number; east: number; north: number };
    cells: LunarVisibilityCell[];
}

function yieldToMain(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

function nearFieldZoom(bounds: { west: number; south: number; east: number; north: number }): number {
    const lonSpan = Math.max(1e-6, Math.abs(bounds.east - bounds.west));
    const latSpan = Math.max(1e-6, Math.abs(bounds.north - bounds.south));
    for (let zoom = RAY_NEAR_MAX_ZOOM; zoom > RAY_FAR_ZOOM; zoom--) {
        const across = Math.ceil((lonSpan * 2 ** zoom) / 360) + 1;
        const down = Math.ceil((latSpan * 2 ** zoom) / 180) + 1;
        if (across * down <= NEAR_TILE_BUDGET) return zoom;
    }
    return RAY_FAR_ZOOM;
}

function metersPerPixel(zoom: number, lat: number): number {
    return (156543.03 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
}

function bilinear(v00: number, v01: number, v10: number, v11: number, fx: number, fy: number): number {
    return v00 * (1 - fx) * (1 - fy) + v01 * fx * (1 - fy) + v10 * (1 - fx) * fy + v11 * fx * fy;
}

/** Azimuths live on a circle — blended as unit vectors so corners straddling north don't average
 *  to the opposite direction (same reasoning as the solar grid's bilinearAzimuth). */
function bilinearAzimuth(a00: number, a01: number, a10: number, a11: number, fx: number, fy: number): number {
    const rad = Math.PI / 180;
    const sin = bilinear(Math.sin(a00 * rad), Math.sin(a01 * rad), Math.sin(a10 * rad), Math.sin(a11 * rad), fx, fy);
    const cos = bilinear(Math.cos(a00 * rad), Math.cos(a01 * rad), Math.cos(a10 * rad), Math.cos(a11 * rad), fx, fy);
    return (((Math.atan2(sin, cos) / rad) % 360) + 360) % 360;
}

export async function computeLunarVisibilityGrid(
    summary: LunarEclipseSummary,
    bounds: { west: number; south: number; east: number; north: number },
    cols: number,
    rows: number,
    shouldAbort?: () => boolean,
    onProgress?: (fraction: number) => void,
): Promise<LunarVisibilityGrid> {
    const { p1, p4, u1, u4, greatest } = summary.contacts;
    const startMs = (u1 ?? p1).getTime();
    const endMs = (u4 ?? p4).getTime();
    const times: number[] = [];
    for (let i = 0; i < TIME_SAMPLES; i++) times.push(startMs + ((endMs - startMs) * i) / (TIME_SAMPLES - 1));
    const greatestIndex = times.reduce(
        // `best` is always either the initial 0 or a previously-returned `i`, both valid indices
        // into `times` (TIME_SAMPLES > 0 guarantees times is non-empty), so times[best] is defined.
        (best, t, i) => (Math.abs(t - greatest.getTime()) < Math.abs(times[best]! - greatest.getTime()) ? i : best),
        0,
    );

    const cellLatLon: Array<{ lat: number; lon: number }> = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            cellLatLon.push({
                lon: bounds.west + ((c + 0.5) / cols) * (bounds.east - bounds.west),
                lat: bounds.north - ((r + 0.5) / rows) * (bounds.north - bounds.south),
            });
        }
    }

    // Moon positions on a coarse sub-grid, one set per time sample, interpolated per cell.
    const lonSpan = Math.abs(bounds.east - bounds.west);
    const latSpan = Math.abs(bounds.north - bounds.south);
    const clamp = (n: number) => Math.max(MOON_NODES_MIN, Math.min(MOON_NODES_MAX, n));
    const subCols = clamp(Math.ceil(lonSpan / MOON_STEP_MAX_DEG) + 1);
    const subRows = clamp(Math.ceil(latSpan / MOON_STEP_MAX_DEG) + 1);

    const nodePositions: Array<Array<{ azimuth: number; altitude: number }>> = [];
    for (let n = 0; n < subCols * subRows; n++) {
        // cols/rows are zeroed alongside the empty cells array so cells.length === cols*rows
        // still holds for an aborted result — obstructionGrid.ts's own abort return leaves
        // cols/rows non-zero with cells: [], which is the same inconsistency this avoids.
        if (shouldAbort?.()) return { cols: 0, rows: 0, bounds, cells: [] };
        const sc = n % subCols;
        const sr = Math.floor(n / subCols);
        const lon = bounds.west + (sc / (subCols - 1)) * (bounds.east - bounds.west);
        const lat = bounds.north - (sr / (subRows - 1)) * (bounds.north - bounds.south);
        nodePositions.push(await Promise.all(times.map((t) => getMoonPositionAt(new Date(t), lat, lon))));
        if (n % 8 === 7) {
            onProgress?.((n / (subCols * subRows)) * 0.4);
            await yieldToMain();
        }
    }
    onProgress?.(0.4);

    const centreLat = (bounds.north + bounds.south) / 2;
    const nearZoom = nearFieldZoom(bounds);
    const rayPlan = RAY_DISTANCES_M.map((distance) => ({
        distance,
        zoom: distance <= NEAR_FIELD_METERS ? nearZoom : RAY_FAR_ZOOM,
    })).filter((step) => step.distance >= metersPerPixel(step.zoom, centreLat));

    // Per-cell Moon samples by interpolation, then the elevation points each ray needs.
    const cellSamples: Array<Array<{ azimuth: number; altitude: number }>> = [];
    const elevationPoints: Array<{ lat: number; lon: number }> = [];
    const elevationZoomFor: number[] = [];
    const observerIdx: number[] = [];
    const rayIdx: number[][][] = [];

    for (let start = 0; start < cellLatLon.length; start += CHUNK_SIZE) {
        // cols/rows are zeroed alongside the empty cells array so cells.length === cols*rows
        // still holds for an aborted result — obstructionGrid.ts's own abort return leaves
        // cols/rows non-zero with cells: [], which is the same inconsistency this avoids.
        if (shouldAbort?.()) return { cols: 0, rows: 0, bounds, cells: [] };
        const end = Math.min(start + CHUNK_SIZE, cellLatLon.length);
        for (let cellIndex = start; cellIndex < end; cellIndex++) {
            // cellIndex ranges over [start, end) and end <= cellLatLon.length here.
            const { lat, lon } = cellLatLon[cellIndex]!;
            const col = cellIndex % cols;
            const row = Math.floor(cellIndex / cols);
            const gx = ((col + 0.5) / cols) * (subCols - 1);
            const gy = ((row + 0.5) / rows) * (subRows - 1);
            const x0 = Math.min(subCols - 2, Math.floor(gx));
            const y0 = Math.min(subRows - 2, Math.floor(gy));
            const fx = gx - x0;
            const fy = gy - y0;
            // x0 is clamped to [0, subCols-2] and y0 to [0, subRows-2] (MOON_NODES_MIN=3 keeps
            // both bounds >= 0), and nodePositions has exactly subCols*subRows entries, so all
            // four corner indices below are always in range.
            const n00 = nodePositions[y0 * subCols + x0]!;
            const n01 = nodePositions[y0 * subCols + x0 + 1]!;
            const n10 = nodePositions[(y0 + 1) * subCols + x0]!;
            const n11 = nodePositions[(y0 + 1) * subCols + x0 + 1]!;

            const samples = times.map((_, i) => {
                // Each node array has one entry per time sample (built via `times.map` when
                // nodePositions was populated above), and `i` here ranges over that same
                // `times` array, so n00[i]..n11[i] are always defined.
                const p00 = n00[i]!;
                const p01 = n01[i]!;
                const p10 = n10[i]!;
                const p11 = n11[i]!;
                return {
                    azimuth: bilinearAzimuth(p00.azimuth, p01.azimuth, p10.azimuth, p11.azimuth, fx, fy),
                    altitude: bilinear(p00.altitude, p01.altitude, p10.altitude, p11.altitude, fx, fy),
                };
            });
            cellSamples.push(samples);

            observerIdx.push(elevationPoints.length);
            elevationPoints.push({ lat, lon });
            elevationZoomFor.push(nearZoom);

            const sampleRays: number[][] = [];
            for (const sample of samples) {
                const idxs: number[] = [];
                for (const step of rayPlan) {
                    idxs.push(elevationPoints.length);
                    elevationPoints.push(destinationPoint(lat, lon, sample.azimuth, step.distance));
                    elevationZoomFor.push(step.zoom);
                }
                sampleRays.push(idxs);
            }
            rayIdx.push(sampleRays);
        }
        if (end < cellLatLon.length) {
            onProgress?.(0.4 + (end / cellLatLon.length) * 0.3);
            await yieldToMain();
        }
    }
    onProgress?.(0.7);

    // Same cols:0/rows:0 convention as the other abort returns below/above.
    if (shouldAbort?.()) return { cols: 0, rows: 0, bounds, cells: [] };
    const elevations = new Float32Array(elevationPoints.length);
    if (elevationPoints.length > 0) {
        const byZoom = new Map<number, number[]>();
        for (let i = 0; i < elevationPoints.length; i++) {
            // elevationZoomFor is pushed in lockstep with elevationPoints (one push per point,
            // same call sites above), so it has exactly elevationPoints.length entries.
            const zoom = elevationZoomFor[i]!;
            let slots = byZoom.get(zoom);
            if (!slots) {
                slots = [];
                byZoom.set(zoom, slots);
            }
            slots.push(i);
        }
        await Promise.all(
            Array.from(byZoom.entries()).map(async ([zoom, slots]) => {
                // `slots` only ever contains indices `i` pushed while iterating
                // `i < elevationPoints.length` above, so elevationPoints[i] is always defined.
                const values = await getElevationsBatch(
                    slots.map((i) => elevationPoints[i]!),
                    zoom,
                );
                // getElevationsBatch resolves one elevation per input point, so `values` has the
                // same length as `slots`, and k < slots.length indexes both safely.
                for (let k = 0; k < slots.length; k++) elevations[slots[k]!] = values[k]!;
            }),
        );
    }

    const cells: LunarVisibilityCell[] = [];
    for (let start = 0; start < cellLatLon.length; start += CHUNK_SIZE) {
        // cols/rows are zeroed alongside the empty cells array so cells.length === cols*rows
        // still holds for an aborted result — obstructionGrid.ts's own abort return leaves
        // cols/rows non-zero with cells: [], which is the same inconsistency this avoids.
        if (shouldAbort?.()) return { cols: 0, rows: 0, bounds, cells: [] };
        const end = Math.min(start + CHUNK_SIZE, cellLatLon.length);
        for (let cellIndex = start; cellIndex < end; cellIndex++) {
            // cellSamples/observerIdx/rayIdx/cellLatLon were each pushed/filled once per cell
            // over this same cellLatLon range, so all have length === cellLatLon.length and
            // cellIndex (bounded by end <= cellLatLon.length) indexes them safely.
            const samples = cellSamples[cellIndex]!;
            // observerIdx[cellIndex] was pushed as a valid elevationPoints index, and elevations
            // has one entry per elevationPoints entry, so this read is always defined.
            const eyeElevation = elevations[observerIdx[cellIndex]!]! + EYE_HEIGHT_M;
            const planRays = rayIdx[cellIndex]!;
            let visibleCount = 0;
            for (let s = 0; s < samples.length; s++) {
                const sample = samples[s]!; // s < samples.length
                // Below the horizon by a wide margin: skip the ray maths, no terrain can help.
                if (sample.altitude <= -5) continue;
                let maxHorizon = -90;
                // planRays has one entry per sample, pushed 1:1 with `samples` above.
                const sampleRays = planRays[s]!;
                for (let d = 0; d < rayPlan.length; d++) {
                    // sampleRays has one entry per ray step, pushed 1:1 with rayPlan above, and
                    // each is a valid elevationPoints index, so both sampleRays[d] and the
                    // resulting elevations read are defined for d < rayPlan.length.
                    const altitude = apparentAltitudeDeg(eyeElevation, elevations[sampleRays[d]!]!, rayPlan[d]!.distance);
                    if (altitude > maxHorizon) maxHorizon = altitude;
                }
                if (sample.altitude > maxHorizon) visibleCount++;
            }
            const cellLoc = cellLatLon[cellIndex]!;
            cells.push({
                lat: cellLoc.lat,
                lon: cellLoc.lon,
                visibleFraction: visibleCount / samples.length,
                // greatestIndex < times.length === samples.length (samples is built from times.map).
                altitudeAtGreatest: samples[greatestIndex]!.altitude,
            });
        }
        if (end < cellLatLon.length) {
            onProgress?.(0.7 + (end / cellLatLon.length) * 0.3);
            await yieldToMain();
        }
    }
    onProgress?.(1);

    return { cols, rows, bounds, cells };
}
