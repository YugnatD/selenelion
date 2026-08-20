import type { SolarEclipse } from '@astronomy-bundle/solar-eclipse';
import { getLocalEclipse, getSunPositionAt, summarizeLocal } from '../engine/localCircumstances';
import { getElevationsBatchFlat, latToTileY } from './elevationTiles';
import { apparentAltitudeDeg, destinationPoint, EYE_HEIGHT_M } from './horizon';

export interface ObstructionCell {
    lat: number;
    lon: number;
    /** Fraction (0-1) of the theoretical local eclipse duration that clears the terrain
     *  horizon, estimated from a handful of time samples. Null = no eclipse at all here
     *  (outside the penumbra, or right at its ragged edge). */
    visibleFraction: number | null;
    /** Local max magnitude and central-phase duration — read off the same getLocalEclipse call
     *  already made to resolve contact times for the visibility sampling below, so exposing them
     *  here is free (no second per-cell astronomy pass). Both null alongside visibleFraction when
     *  there's no eclipse at this cell at all. Used by FocusMap's composite quality score. */
    magnitude: number | null;
    centralDurationSeconds: number | null;
}

export interface ObstructionGrid {
    cols: number;
    rows: number;
    bounds: { west: number; south: number; east: number; north: number };
    /** Row-major, length cols*rows. */
    cells: ObstructionCell[];
}

/** Time samples per cell between first and last contact. Too few under-detects real (but brief)
 *  obstruction, making the grid look almost entirely clear even where it isn't. Raised from 9
 *  once the astronomy stopped being computed per cell (see the sub-grid below): the extra samples
 *  now cost only terrain lookups, which measured at ~6% of the old per-cell cost. */
const TIME_SAMPLES = 13;
/** Shorter ray than the single-point horizon profile, since this runs over a whole grid — but
 *  still starts close in (250m/500m), for the same reason horizon.ts's own list does: terrain
 *  nearer than the closest sampled distance is invisible to ray-casting no matter how tall, which
 *  under-detects real obstruction right next to the observer (confirmed against a real case near
 *  the Rock of Gibraltar — see horizon.ts's SAMPLE_DISTANCES_M comment). The mid-range entries
 *  were filled in when the astronomy sub-grid freed up the budget: cross-checks against published
 *  summits showed this ray-casting reads consistently *below* the true skyline, and a coarse
 *  distance ladder is one of the reasons why. */
const RAY_DISTANCES_M = [150, 300, 500, 800, 1200, 1800, 3000, 5000, 8000, 12000, 20000, 30000, 45000, 60000];

/** Distances at or below this are "near field" and may use a finer zoom than the rest of the ray. */
const NEAR_FIELD_METERS = 2_000;
/** Coarse zoom for the far part of every ray, and the ceiling/floor for the near-field zoom. */
const RAY_FAR_ZOOM = 9;
const RAY_NEAR_MAX_ZOOM = 12;
/** Never degrade the far field below this, however large the tile-count estimate — a coarser
 *  world just isn't meaningful terrain data any more. */
const RAY_FAR_ZOOM_FLOOR = 4;
/** Fine tiles needed to cover the viewport's near field, capped so a wide view can't try to fetch
 *  thousands of them. Measured before this cap existed: a fixed zoom 11 cost 20 tiles over a 40km
 *  viewport but 902 over 300km and 7401 at MIN_ZOOM — tens of seconds and hundreds of MB. */
const NEAR_TILE_BUDGET = 64;
/** Same idea as NEAR_TILE_BUDGET, but for the far field: unlike the near field (bounded by the
 *  viewport itself), far rays fan out from *every* cell in *every* sun-sample direction, so their
 *  footprint is the viewport padded by the longest ray distance in every direction — measured at
 *  ~3,876 distinct zoom-9 tiles (~969MB decoded) for a wide viewport at the app's own minimum map
 *  zoom, with zero cap on how many of those were fetched at once. When the estimate exceeds this
 *  budget the far zoom is stepped coarser (see farFieldZoom) until it fits, same strategy as the
 *  near field just applied to the padded footprint instead. */
const FAR_TILE_BUDGET = 512;

const METERS_PER_DEGREE_LAT = 110_540;

/** True Mercator-projected tile count covering `bounds` at `zoom` — the column count is linear in
 *  longitude (Mercator's x-axis is already linear), but the row count is NOT linear in latitude:
 *  it scales with the derivative of the Mercator y-projection, which grows with 1/cos(lat). A
 *  `latSpan / 180` approximation (the previous implementation) is only correct at 60° latitude
 *  and undercounts by ~2.4× at 80°, letting a near-the-pole viewport blow straight through the
 *  budget it's supposed to be enforcing. Using the same `latToTileY` the actual tile-fetch code
 *  path uses keeps this estimate exact, not just closer. */
function estimateTileCount(bounds: { west: number; south: number; east: number; north: number }, zoom: number): number {
    const lonSpan = Math.max(1e-6, Math.abs(bounds.east - bounds.west));
    const across = Math.ceil((lonSpan * 2 ** zoom) / 360) + 1;
    const down = Math.ceil(Math.abs(latToTileY(bounds.south, zoom) - latToTileY(bounds.north, zoom))) + 1;
    return across * down;
}

/**
 * Finest near-field zoom that both fits the tile budget and is actually meaningful at this scale.
 * Terrain detail below the spacing between grid cells can't be represented by the overlay anyway
 * — at a 1300km viewport each cell is ~12km wide, so resolving 150m features would just add noise
 * under a colour band — and it is exactly where the tile count explodes. Never returns coarser
 * than the far zoom, so the near field is never *worse* resolved than the distance beyond it.
 */
function nearFieldZoom(bounds: { west: number; south: number; east: number; north: number }): number {
    for (let zoom = RAY_NEAR_MAX_ZOOM; zoom > RAY_FAR_ZOOM; zoom--) {
        if (estimateTileCount(bounds, zoom) <= NEAR_TILE_BUDGET) return zoom;
    }
    return RAY_FAR_ZOOM;
}

/**
 * Coarsest-acceptable / finest-affordable zoom for the far part of every ray. Unlike the near
 * field, far rays land well outside the viewport itself (up to `maxDistanceM` away in whichever
 * azimuth each sun-sample happens to point), so the relevant footprint for budgeting is the
 * viewport padded by that distance in every direction, not the viewport alone. Steps the zoom
 * coarser (never below RAY_FAR_ZOOM_FLOOR) until the padded footprint's estimated tile count fits
 * FAR_TILE_BUDGET — the same graceful-degradation strategy nearFieldZoom uses, applied to the far
 * field's much larger and viewport-independent footprint.
 */
function farFieldZoom(bounds: { west: number; south: number; east: number; north: number }, maxDistanceM: number): number {
    const centreLat = (bounds.north + bounds.south) / 2;
    const latPad = maxDistanceM / METERS_PER_DEGREE_LAT;
    // Guarded away from 0 so a viewport centred very near the pole doesn't blow this up to an
    // absurd longitude padding — the tile-count estimate below is itself latitude-correct, so an
    // over-generous pad here only costs a slightly coarser (never wrong) far zoom.
    const cosLat = Math.max(0.05, Math.cos((centreLat * Math.PI) / 180));
    const lonPad = maxDistanceM / (111_320 * cosLat);
    const padded = {
        west: bounds.west - lonPad,
        east: bounds.east + lonPad,
        south: Math.max(-85, bounds.south - latPad),
        north: Math.min(85, bounds.north + latPad),
    };
    for (let zoom = RAY_FAR_ZOOM; zoom >= RAY_FAR_ZOOM_FLOOR; zoom--) {
        if (estimateTileCount(padded, zoom) <= FAR_TILE_BUDGET) return zoom;
    }
    return RAY_FAR_ZOOM_FLOOR;
}

/** Metres per elevation pixel at a given zoom/latitude — used to drop ray samples finer than the
 *  data can actually resolve. Sampling closer than one pixel re-reads the pixel the observer is
 *  standing in, which reports the ground *beside* them as a wall: measured at +22.9° of phantom
 *  horizon at Gibraltar when 100m samples were taken against ~250m pixels. */
function metersPerPixel(zoom: number, lat: number): number {
    return (156543.03 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
}
/** Cells (resp. plans) processed per chunk before yielding to the browser, so a big grid
 *  doesn't freeze panning/scrolling for the duration of the whole computation. */
const CHUNK_SIZE = 150;

/** Astronomy sub-grid: the Sun's position and the local contact times vary smoothly and
 *  analytically across a viewport (they come from Besselian elements, not from sampled data), so
 *  resolving them at every cell re-derives the same smooth function thousands of times. Measured
 *  over a 12°x10° viewport, a 5x5 sub-grid reproduced the exact per-cell result to within 0.013°
 *  in altitude and 0.050° in azimuth — against a horizon profile that is itself only accurate to
 *  ~2-3°, so the interpolation error is ~200x smaller than the noise it feeds into.
 *
 *  Nodes are placed by angular spacing rather than by cell count, so accuracy doesn't silently
 *  degrade when the same grid dimensions are used for a much wider viewport. */
const ASTRO_STEP_MAX_DEG = 2.5;
const ASTRO_NODES_MIN = 3;
const ASTRO_NODES_MAX = 33;

interface CellAstronomy {
    /** TIME_SAMPLES sun positions, evenly spaced through *this* location's own c1→c4 window — so
     *  sample i means "fraction i/(n-1) through the local eclipse" and stays comparable, and
     *  therefore interpolatable, between neighbouring cells. */
    samples: Array<{ azimuth: number; altitude: number }>;
    magnitude: number;
    centralDurationSeconds: number;
}

/** Exact astronomy at one location, or null when the location sees no eclipse at all (the
 *  library throws rather than returning null for points outside the penumbra). */
function resolveAstronomy(eclipse: SolarEclipse, lat: number, lon: number): CellAstronomy | null {
    try {
        const local = getLocalEclipse(eclipse, lat, lon);
        const contacts = local.getContactTimes();
        if (!contacts) return null;
        const t0 = contacts.c1.getDate().getTime();
        const t1 = contacts.c4.getDate().getTime();
        if (t1 <= t0) return null;

        const samples: Array<{ azimuth: number; altitude: number }> = [];
        for (let i = 0; i < TIME_SAMPLES; i++) {
            const position = getSunPositionAt(local, new Date(t0 + ((t1 - t0) * i) / (TIME_SAMPLES - 1)));
            samples.push({ azimuth: position.azimuth, altitude: position.altitude });
        }
        const summary = summarizeLocal(local);
        return { samples, magnitude: summary.maxMagnitude, centralDurationSeconds: summary.centralDurationSeconds };
    } catch {
        return null;
    }
}

function bilinear(v00: number, v01: number, v10: number, v11: number, fx: number, fy: number): number {
    return v00 * (1 - fx) * (1 - fy) + v01 * fx * (1 - fy) + v10 * (1 - fx) * fy + v11 * fx * fy;
}

/** Azimuths are angles on a circle, so blending them as plain numbers is wrong wherever the four
 *  corners straddle north — 359° and 1° would average to 180°, pointing the ray-cast in exactly
 *  the opposite direction. Interpolating the unit vectors instead is correct everywhere. */
function bilinearAzimuth(a00: number, a01: number, a10: number, a11: number, fx: number, fy: number): number {
    const rad = Math.PI / 180;
    const sin = bilinear(Math.sin(a00 * rad), Math.sin(a01 * rad), Math.sin(a10 * rad), Math.sin(a11 * rad), fx, fy);
    const cos = bilinear(Math.cos(a00 * rad), Math.cos(a01 * rad), Math.cos(a10 * rad), Math.cos(a11 * rad), fx, fy);
    return ((Math.atan2(sin, cos) / rad) % 360 + 360) % 360;
}

function interpolateAstronomy(
    n00: CellAstronomy,
    n01: CellAstronomy,
    n10: CellAstronomy,
    n11: CellAstronomy,
    fx: number,
    fy: number,
): CellAstronomy {
    const samples: Array<{ azimuth: number; altitude: number }> = [];
    for (let i = 0; i < TIME_SAMPLES; i++) {
        // i < TIME_SAMPLES, and resolveAstronomy always builds `samples` with exactly
        // TIME_SAMPLES entries, so every one of these four indices is guaranteed in bounds.
        samples.push({
            azimuth: bilinearAzimuth(n00.samples[i]!.azimuth, n01.samples[i]!.azimuth, n10.samples[i]!.azimuth, n11.samples[i]!.azimuth, fx, fy),
            altitude: bilinear(n00.samples[i]!.altitude, n01.samples[i]!.altitude, n10.samples[i]!.altitude, n11.samples[i]!.altitude, fx, fy),
        });
    }
    return {
        samples,
        magnitude: bilinear(n00.magnitude, n01.magnitude, n10.magnitude, n11.magnitude, fx, fy),
        centralDurationSeconds: bilinear(
            n00.centralDurationSeconds,
            n01.centralDurationSeconds,
            n10.centralDurationSeconds,
            n11.centralDurationSeconds,
            fx,
            fy,
        ),
    };
}

function yieldToMain(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * A coarse grid of "how much of the eclipse actually clears the terrain horizon" over a map
 * viewport — the wide-area counterpart to the single-point horizon chart. For every cell, a
 * handful of Sun-position samples are checked against a short horizon ray in that sample's
 * own direction, and every elevation lookup across the whole grid is resolved in one batch.
 *
 * There's no geometric pre-filter against the penumbra polygon: eclipses whose penumbra
 * reaches very high latitudes (this one included — 2026-08-12 nearly touches the North Pole)
 * produce a lon/lat ring that wraps the pole, which breaks a standard planar point-in-polygon
 * test (the ring legitimately runs along latitude 90 for a stretch). The astronomy library's
 * own per-point `getLocalEclipse` call is authoritative and has no such issue, so cells with
 * no eclipse are simply identified by it throwing/returning no contacts, at the cost of
 * attempting that (cheap) call for every cell instead of only the relevant ones.
 *
 * The two heaviest loops (per-cell astronomy, per-sample horizon math) are processed in small
 * chunks with a yield in between, and `shouldAbort` is checked at each yield so a superseded
 * request (the user panned again) stops burning CPU instead of racing to a discarded result.
 */
export async function computeObstructionGrid(
    eclipse: SolarEclipse,
    bounds: { west: number; south: number; east: number; north: number },
    cols: number,
    rows: number,
    shouldAbort?: () => boolean,
    /** Approximate 0-1 completion, reported at each chunk yield — phase-weighted (0-0.5 for the
     *  per-cell astronomy pass, 0.5-0.75 for elevation-point batching, 0.75-1 for the final
     *  horizon comparison) rather than exact, since the second and third phases' true size
     *  (`plans.length`) isn't known until the first finishes. Good enough for a progress bar;
     *  not meant as a precise estimate. */
    onProgress?: (fraction: number) => void,
    /** Aborts the network phase's in-flight tile fetches when a computation is superseded (e.g.
     *  the user panned again before this one finished). `shouldAbort` alone stops this function
     *  from doing further *work*, but without a real AbortSignal reaching `fetch()` the stale
     *  request's tile downloads kept running to completion in the background while a new
     *  computation started fetching concurrently in the same worker. */
    signal?: AbortSignal,
): Promise<ObstructionGrid> {
    const cellLatLon: Array<{ lat: number; lon: number }> = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const lon = bounds.west + ((c + 0.5) / cols) * (bounds.east - bounds.west);
            const lat = bounds.north - ((r + 0.5) / rows) * (bounds.north - bounds.south);
            cellLatLon.push({ lat, lon });
        }
    }

    interface CellPlan {
        cellIndex: number;
        lat: number;
        lon: number;
        samples: Array<{ azimuth: number; altitude: number }>;
        magnitude: number;
        centralDurationSeconds: number;
    }
    // Sampling plan: how fine the near field can be resolved for *this* viewport, and which ray
    // distances that zoom can actually support (see nearFieldZoom / metersPerPixel).
    const centreLat = (bounds.north + bounds.south) / 2;
    const nearZoom = nearFieldZoom(bounds);
    const observerZoom = nearZoom;
    // RAY_DISTANCES_M is a non-empty literal array, so its last element always exists.
    const farZoom = farFieldZoom(bounds, RAY_DISTANCES_M[RAY_DISTANCES_M.length - 1]!);
    const rayPlan = RAY_DISTANCES_M.map((distance) => ({
        distance,
        zoom: distance <= NEAR_FIELD_METERS ? nearZoom : farZoom,
    })).filter((step) => step.distance >= metersPerPixel(step.zoom, centreLat));

    // Astronomy sub-grid, resolved exactly, then interpolated across the cells between its nodes.
    const lonSpan = Math.abs(bounds.east - bounds.west);
    const latSpan = Math.abs(bounds.north - bounds.south);
    const clampNodes = (n: number) => Math.max(ASTRO_NODES_MIN, Math.min(ASTRO_NODES_MAX, n));
    const subCols = clampNodes(Math.ceil(lonSpan / ASTRO_STEP_MAX_DEG) + 1);
    const subRows = clampNodes(Math.ceil(latSpan / ASTRO_STEP_MAX_DEG) + 1);

    const nodes: Array<CellAstronomy | null> = new Array(subCols * subRows);
    for (let start = 0; start < nodes.length; start += CHUNK_SIZE) {
        if (shouldAbort?.()) return { cols, rows, bounds, cells: [] };
        const end = Math.min(start + CHUNK_SIZE, nodes.length);
        for (let n = start; n < end; n++) {
            const sc = n % subCols;
            const sr = Math.floor(n / subCols);
            const lon = bounds.west + (sc / (subCols - 1)) * (bounds.east - bounds.west);
            const lat = bounds.north - (sr / (subRows - 1)) * (bounds.north - bounds.south);
            nodes[n] = resolveAstronomy(eclipse, lat, lon);
        }
        if (end < nodes.length) {
            onProgress?.((end / nodes.length) * 0.25);
            await yieldToMain();
        }
    }
    onProgress?.(0.25);

    const plans: CellPlan[] = [];
    for (let start = 0; start < cellLatLon.length; start += CHUNK_SIZE) {
        if (shouldAbort?.()) return { cols, rows, bounds, cells: [] };
        const end = Math.min(start + CHUNK_SIZE, cellLatLon.length);
        for (let cellIndex = start; cellIndex < end; cellIndex++) {
            // cellIndex is bounded by `end <= cellLatLon.length` above, so this is always populated.
            const { lat, lon } = cellLatLon[cellIndex]!;
            const col = cellIndex % cols;
            const row = Math.floor(cellIndex / cols);

            // Position of this cell within the sub-grid, and the four nodes bracketing it.
            const gx = ((col + 0.5) / cols) * (subCols - 1);
            const gy = ((row + 0.5) / rows) * (subRows - 1);
            const x0 = Math.min(subCols - 2, Math.floor(gx));
            const y0 = Math.min(subRows - 2, Math.floor(gy));
            const n00 = nodes[y0 * subCols + x0];
            const n01 = nodes[y0 * subCols + x0 + 1];
            const n10 = nodes[(y0 + 1) * subCols + x0];
            const n11 = nodes[(y0 + 1) * subCols + x0 + 1];

            // Interpolation is only valid where the four corners agree on the *discontinuous*
            // facts — whether there is an eclipse here at all (the penumbra edge) and whether it
            // reaches centrality (the umbra edge). Blending across either would smear a hard
            // boundary into a gradient, inventing a sliver of totality just outside the real
            // umbra. Where the corners disagree, the cell is resolved exactly instead, so those
            // edges stay as sharp as a fully per-cell computation would make them.
            let astronomy: CellAstronomy | null;
            // `if (n00 && ...)` (rather than a boolean stashed in a variable) so TypeScript can
            // actually narrow n00..n11 from `CellAstronomy | null | undefined` down to
            // `CellAstronomy` for use below — nodes[...] is always populated (never left as the
            // `undefined` array hole noUncheckedIndexedAccess warns about) since the sub-grid loop
            // above assigns every index 0..nodes.length-1, but TS can't see that invariant itself.
            if (n00 && n01 && n10 && n11) {
                const centralityAgrees =
                    new Set([n00.centralDurationSeconds > 0, n01.centralDurationSeconds > 0, n10.centralDurationSeconds > 0, n11.centralDurationSeconds > 0])
                        .size === 1;
                astronomy = centralityAgrees ? interpolateAstronomy(n00, n01, n10, n11, gx - x0, gy - y0) : resolveAstronomy(eclipse, lat, lon);
            } else {
                astronomy = resolveAstronomy(eclipse, lat, lon);
            }
            if (!astronomy) continue; // no eclipse visible at all from this cell

            plans.push({
                cellIndex,
                lat,
                lon,
                samples: astronomy.samples,
                magnitude: astronomy.magnitude,
                centralDurationSeconds: astronomy.centralDurationSeconds,
            });
        }
        if (end < cellLatLon.length) {
            onProgress?.(0.25 + (end / cellLatLon.length) * 0.25);
            await yieldToMain();
        }
    }
    onProgress?.(0.5);

    // Flatten every elevation sample point (one observer-eye point, plus a short ray of
    // distances per time sample) into a single batched request. The layout is fully regular —
    // every plan has exactly the same number of samples (TIME_SAMPLES) and rays per sample
    // (rayPlan.length) — so a point's position is a pure function of (planIndex, sampleIndex,
    // distanceIndex) and doesn't need to be recorded per-point in a parallel index structure.
    // Interleaved flat typed arrays throughout (not one {lat, lon} object per point plus a
    // `number[][][]` index alongside it): for a fine export grid this pass alone used to build
    // ~4.7M individual objects and a matching nested-array structure, measured at ~920MB of
    // transient heap. destinationPoint (horizon.ts) still allocates one short-lived {lat, lon}
    // per ray point — that's outside this file — but it's read into the flat array and discarded
    // immediately instead of being retained for the rest of the computation.
    //
    // Chunked like the other two heavy loops in this function: for a large grid, this pass alone
    // can involve tens of thousands of destinationPoint calls, and without a yield+abort check
    // here a superseded request (the user panned again) would burn through all of it before the
    // next request ever gets a chance to start.
    const raysPerSample = rayPlan.length;
    const pointsPerPlan = 1 + TIME_SAMPLES * raysPerSample; // 1 observer point + rays
    const totalPoints = plans.length * pointsPerPlan;
    const elevationCoords = new Float64Array(totalPoints * 2); // interleaved [lat0, lon0, lat1, lon1, ...]
    const elevationZoomFor = new Int32Array(totalPoints); // parallel to elevationCoords, one entry per point

    for (let start = 0; start < plans.length; start += CHUNK_SIZE) {
        if (shouldAbort?.()) return { cols, rows, bounds, cells: [] };
        const end = Math.min(start + CHUNK_SIZE, plans.length);
        for (let planIndex = start; planIndex < end; planIndex++) {
            // planIndex is bounded by `end <= plans.length` above.
            const plan = plans[planIndex]!;
            const base = planIndex * pointsPerPlan;

            elevationCoords[base * 2] = plan.lat;
            elevationCoords[base * 2 + 1] = plan.lon;
            elevationZoomFor[base] = observerZoom;

            for (let sampleIndex = 0; sampleIndex < plan.samples.length; sampleIndex++) {
                // sampleIndex is bounded by plan.samples.length.
                const sample = plan.samples[sampleIndex]!;
                for (let distanceIndex = 0; distanceIndex < raysPerSample; distanceIndex++) {
                    // distanceIndex is bounded by raysPerSample === rayPlan.length.
                    const step = rayPlan[distanceIndex]!;
                    const idx = base + 1 + sampleIndex * raysPerSample + distanceIndex;
                    const point = destinationPoint(plan.lat, plan.lon, sample.azimuth, step.distance);
                    elevationCoords[idx * 2] = point.lat;
                    elevationCoords[idx * 2 + 1] = point.lon;
                    elevationZoomFor[idx] = step.zoom;
                }
            }
        }
        if (end < plans.length) {
            onProgress?.(0.5 + (end / plans.length) * 0.25);
            await yieldToMain();
        }
    }
    onProgress?.(0.75);

    if (shouldAbort?.()) return { cols, rows, bounds, cells: [] };
    // Resolved per zoom level, like the single-point profile: the observer's own elevation and
    // the near rays need finer tiles than the distant ones (see RAY_ZOOM_FOR / horizon.ts).
    const elevations = new Float32Array(totalPoints);
    if (totalPoints > 0) {
        const byZoom = new Map<number, number[]>();
        for (let i = 0; i < totalPoints; i++) {
            // i is bounded by totalPoints, and elevationZoomFor (an Int32Array of that same
            // length) was fully written, one entry per point, by the loop above.
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
                const coordsForZoom = new Float64Array(slots.length * 2);
                for (let k = 0; k < slots.length; k++) {
                    // k is bounded by slots.length, and every value pushed into `slots` is a
                    // valid point index (< totalPoints), so i*2/i*2+1 are in range in elevationCoords.
                    const i = slots[k]!;
                    coordsForZoom[k * 2] = elevationCoords[i * 2]!;
                    coordsForZoom[k * 2 + 1] = elevationCoords[i * 2 + 1]!;
                }
                const values = await getElevationsBatchFlat(coordsForZoom, zoom, signal);
                // values has the same length as slots (one elevation per requested coordinate).
                for (let k = 0; k < slots.length; k++) elevations[slots[k]!] = values[k]!;
            }),
        );
    }
    // Bail out promptly if a newer request superseded this one while the network phase was in
    // flight, before spending time on the (also potentially large) final horizon-comparison pass
    // below. The per-chunk check inside that loop already covers this on its first iteration, but
    // checking here too keeps the "network phase, then a fresh abort check" structure explicit.
    if (shouldAbort?.()) return { cols, rows, bounds, cells: [] };

    const cells: ObstructionCell[] = cellLatLon.map(({ lat, lon }) => ({ lat, lon, visibleFraction: null, magnitude: null, centralDurationSeconds: null }));
    // Elevation samples whose tile fetch genuinely failed (as opposed to a confirmed-absent 404)
    // come back as NaN rather than a false 0m/sea-level reading (see getElevationsBatchFlat).
    // Counted (not logged per-occurrence, which could mean thousands of console lines for one bad
    // tile) and surfaced as a single summary warning below.
    let degradedObserverCells = 0;
    let degradedRaySamples = 0;
    for (let start = 0; start < plans.length; start += CHUNK_SIZE) {
        if (shouldAbort?.()) return { cols, rows, bounds, cells: [] };
        const end = Math.min(start + CHUNK_SIZE, plans.length);
        for (let planIndex = start; planIndex < end; planIndex++) {
            // planIndex is bounded by `end <= plans.length` above.
            const plan = plans[planIndex]!;
            const base = planIndex * pointsPerPlan;
            // base = planIndex * pointsPerPlan < plans.length * pointsPerPlan === totalPoints ===
            // elevations.length, so this is always in bounds.
            const observerElevation = elevations[base]!;
            if (Number.isNaN(observerElevation)) {
                // No reliable elevation for the observer themselves — leave this cell at its
                // default null (same "nothing to report here" the interface already uses for
                // "no eclipse at all"), rather than fabricating a result from missing terrain
                // data. Degrading to "excluded" is safer than degrading to "assume sea level"
                // (falsely clear) or "assume fully obstructed" (falsely blocked).
                degradedObserverCells++;
                continue;
            }
            const eyeElevation = observerElevation + EYE_HEIGHT_M;
            let visibleCount = 0;
            // Plain indexed loops, not forEach: this runs once per (cell × time sample × ray
            // distance) across the whole grid, and forEach's closures were being allocated and
            // discarded on every single one of those iterations for no benefit.
            for (let sampleIndex = 0; sampleIndex < plan.samples.length; sampleIndex++) {
                // sampleIndex is bounded by plan.samples.length.
                const sample = plan.samples[sampleIndex]!;
                let maxHorizonAltitude = -90;
                for (let distanceIndex = 0; distanceIndex < raysPerSample; distanceIndex++) {
                    const idx = base + 1 + sampleIndex * raysPerSample + distanceIndex;
                    // idx ranges over this plan's own point block (base+1 .. base+pointsPerPlan-1),
                    // which is within elevations.length by the same accounting as `base` above.
                    const targetElevation = elevations[idx]!;
                    if (Number.isNaN(targetElevation)) {
                        // Missing terrain data at this one ray distance: skip it rather than
                        // letting NaN silently win comparisons (or lose them) below — the other
                        // ray distances for this same sample still contribute to the horizon
                        // check.
                        degradedRaySamples++;
                        continue;
                    }
                    // distanceIndex is bounded by raysPerSample === rayPlan.length.
                    const altitude = apparentAltitudeDeg(eyeElevation, targetElevation, rayPlan[distanceIndex]!.distance);
                    if (altitude > maxHorizonAltitude) maxHorizonAltitude = altitude;
                }
                if (sample.altitude > maxHorizonAltitude) visibleCount++;
            }
            // plan.cellIndex was assigned from the same cellLatLon/cells index space (0..cells.length-1)
            // when this plan was built above, so it's always a valid index into `cells`.
            const cell = cells[plan.cellIndex]!;
            cell.visibleFraction = visibleCount / plan.samples.length;
            cell.magnitude = plan.magnitude;
            cell.centralDurationSeconds = plan.centralDurationSeconds;
        }
        if (end < plans.length) {
            onProgress?.(0.75 + (end / plans.length) * 0.25);
            await yieldToMain();
        }
    }
    if (degradedObserverCells > 0 || degradedRaySamples > 0) {
        console.warn(
            `computeObstructionGrid: ${degradedObserverCells} cell(s) excluded and ${degradedRaySamples} ray sample(s) ignored ` +
                'due to failed elevation tile fetches (network issue) rather than being read as sea level.',
        );
    }
    onProgress?.(1);

    return { cols, rows, bounds, cells };
}
