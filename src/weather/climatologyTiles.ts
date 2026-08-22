/**
 * Reads the static day-of-year cloud-cover climatology tiles produced by
 * scripts/buildClimatologyCombinedTiles.ts (from Open-Meteo's ERA5 archive) — the replacement
 * for the old live NASA POWER `climatology` calls. No network rate limit: these are plain static
 * files under public/climatology/, fetched and cached exactly like the AWS Terrarium elevation
 * tiles in src/terrain/elevationTiles.ts.
 *
 * Grid/tiling layout MUST stay in sync with the constants and byte layout documented in
 * scripts/buildClimatologyCombinedTiles.ts — there is no header in the tile files themselves.
 * See climatologyGrid.ts for the geometry shared with climatologyHourlyTiles.ts.
 */
import {
    DAYS,
    LAT_TILES,
    LON_TILES,
    NO_DATA,
    POINTS_PER_TILE,
    bilinearBlend,
    climatologyBaseUrl,
    createTileFetcher,
    dayOfYearSlot,
    daySlotsForWindow,
    latToIndex,
    lonToIndex,
    surroundingCorners,
} from './climatologyGrid';
export { dayOfYearSlot } from './climatologyGrid';

export const CLIMATOLOGY_BASELINE_LABEL = 'ERA5, 2001-2023';

// 584 KB per tile (40×40 points × 365 day slots), so 128 entries ≈ 75 MB — generous enough that
// ordinary panning of the WeatherMap grid (which loads every tile covering the viewport, plus a
// one-tile ring) keeps working out of cache, while still bounding a long session.
const fetchTile = createTileFetcher(climatologyBaseUrl('/climatology'), 128);

/** Cloud cover (%) at the exact native grid point (latIdx, lonIdx), averaged over `days` (skipping
 *  any no-data slots), or null if that cell has no data at all in the window or its tile failed
 *  to load. */
async function readGridPoint(latIdx: number, lonIdx: number, days: number[], signal?: AbortSignal): Promise<number | null> {
    const latTile = Math.floor(latIdx / POINTS_PER_TILE);
    const lonTile = Math.floor(lonIdx / POINTS_PER_TILE);
    const tile = await fetchTile(lonTile, latTile, signal).catch(() => null);
    if (!tile) return null;
    const localLat = latIdx - latTile * POINTS_PER_TILE;
    const localLon = lonIdx - lonTile * POINTS_PER_TILE;
    const base = (localLat * POINTS_PER_TILE + localLon) * DAYS;
    let sum = 0;
    let count = 0;
    for (const day of days) {
        const value = tile.bytes[base + day];
        if (value !== NO_DATA && value !== undefined) {
            sum += value;
            count++;
        }
    }
    return count === 0 ? null : sum / count;
}

/** Bilinear-interpolated cloud cover (%) at an arbitrary lat/lon, blending the (up to) 4
 *  surrounding native 0.25° grid points — smooth even when zoomed in well past that native
 *  resolution, unlike the old nearest-neighbor NASA POWER regional grid. Falls back to
 *  averaging whichever corners actually have data if some are missing. */
export async function getClimatologyFromTiles(
    lat: number,
    lon: number,
    date: Date,
    signal?: AbortSignal,
    dayWindow = 1,
): Promise<number | null> {
    const days = daySlotsForWindow(dayOfYearSlot(date), dayWindow);
    const { lat0, lat1, lon0, lon1, fLat, fLon } = surroundingCorners(lat, lon);

    const [v00, v01, v10, v11] = await Promise.all([
        readGridPoint(lat0, lon0, days, signal),
        readGridPoint(lat0, lon1, days, signal),
        readGridPoint(lat1, lon0, days, signal),
        readGridPoint(lat1, lon1, days, signal),
    ]);
    return bilinearBlend(v00, v01, v10, v11, fLat, fLon);
}

/** The full 365-day climatology curve (day-of-year → cloud cover %) at a single point, bilinear-
 *  interpolated like getClimatologyFromTiles but for every day at once — fetches the same (up to
 *  4) tiles just once rather than once per day. Used for the small seasonal-context chart in
 *  CircumstancesPanel (is the eclipse date unusually clear/cloudy for this place, or typical?). */
export async function getClimatologyYearCurve(lat: number, lon: number, signal?: AbortSignal): Promise<Array<number | null>> {
    const { lat0, lat1, lon0, lon1, fLat, fLon } = surroundingCorners(lat, lon);
    const latTile0 = Math.floor(lat0 / POINTS_PER_TILE);
    const latTile1 = Math.floor(lat1 / POINTS_PER_TILE);
    const lonTile0 = Math.floor(lon0 / POINTS_PER_TILE);
    const lonTile1 = Math.floor(lon1 / POINTS_PER_TILE);

    const [t00, t01, t10, t11] = await Promise.all([
        fetchTile(lonTile0, latTile0, signal),
        fetchTile(lonTile1, latTile0, signal),
        fetchTile(lonTile0, latTile1, signal),
        fetchTile(lonTile1, latTile1, signal),
    ]);

    function valueAt(
        tile: Awaited<ReturnType<typeof fetchTile>>,
        latIdx: number,
        lonIdx: number,
        latTile: number,
        lonTile: number,
        day: number,
    ): number | null {
        if (!tile) return null;
        const localLat = latIdx - latTile * POINTS_PER_TILE;
        const localLon = lonIdx - lonTile * POINTS_PER_TILE;
        const value = tile.bytes[(localLat * POINTS_PER_TILE + localLon) * DAYS + day];
        return value === NO_DATA || value === undefined ? null : value;
    }

    const curve: Array<number | null> = new Array(DAYS);
    for (let day = 0; day < DAYS; day++) {
        curve[day] = bilinearBlend(
            valueAt(t00, lat0, lon0, latTile0, lonTile0, day),
            valueAt(t01, lat0, lon1, latTile0, lonTile1, day),
            valueAt(t10, lat1, lon0, latTile1, lonTile0, day),
            valueAt(t11, lat1, lon1, latTile1, lonTile1, day),
            fLat,
            fLon,
        );
    }
    return curve;
}

/** Grid version for WeatherMap: preloads every tile covering `bounds` once, then resolves every
 *  point synchronously against the loaded tiles (mirrors getElevationsBatch's batch-then-resolve
 *  shape in elevationTiles.ts). */
export async function getClimatologyGridFromTiles(
    points: Array<{ lat: number; lon: number }>,
    bounds: { west: number; south: number; east: number; north: number },
    date: Date,
    signal?: AbortSignal,
    dayWindow = 1,
): Promise<Array<number | null>> {
    if (points.length === 0) return [];
    const days = daySlotsForWindow(dayOfYearSlot(date), dayWindow);

    // min/max via Math.min/max rather than assuming which of north/south is the larger index —
    // that direction depends on latToIndex's orientation, which should not need to be re-derived
    // here (a past version of this code got this backwards after latToIndex's axis direction
    // changed elsewhere, silently loading the wrong tiles).
    const latTileNorth = Math.floor(latToIndex(bounds.north) / POINTS_PER_TILE);
    const latTileSouth = Math.floor(latToIndex(bounds.south) / POINTS_PER_TILE);
    const latTileMin = Math.min(latTileNorth, latTileSouth);
    const latTileMax = Math.max(latTileNorth, latTileSouth);
    const lonTileMin = Math.floor(lonToIndex(bounds.west) / POINTS_PER_TILE);
    const lonTileMax = Math.floor(lonToIndex(bounds.east) / POINTS_PER_TILE);

    // Longitude is a circle, so the tile columns to load are a *walk* from the west column to the
    // east one, not a numeric min..max range. Across the antimeridian lonToIndex wraps and the
    // west column ends up numerically greater than the east one (e.g. 35 → 0), which a min..max
    // loop turns into an empty range: no tiles fetched, every point null, and the whole overlay
    // silently blank exactly when panned over the Pacific. Counting the wrapped distance instead
    // covers the seam and the ordinary case with the same arithmetic. A viewport wider than the
    // world collapses under that wrap (west and east land on the same column), so it's handled
    // separately by just taking every column.
    const spansWholeWorld = bounds.east - bounds.west >= 360;
    const wrappedTileSpan = (((lonTileMax - lonTileMin) % LON_TILES) + LON_TILES) % LON_TILES;
    // +3 = the span itself, plus a one-tile ring on each side (bilinear corners can fall into the
    // neighbouring tile).
    const lonColumnCount = spansWholeWorld ? LON_TILES : Math.min(LON_TILES, wrappedTileSpan + 3);

    const tiles = new Map<string, Awaited<ReturnType<typeof fetchTile>>>();
    const fetches: Promise<void>[] = [];
    for (let lt = Math.max(0, latTileMin - 1); lt <= Math.min(LAT_TILES - 1, latTileMax + 1); lt++) {
        for (let k = 0; k < lonColumnCount; k++) {
            const lonSpan = spansWholeWorld ? k : lonTileMin - 1 + k;
            const lo = ((lonSpan % LON_TILES) + LON_TILES) % LON_TILES;
            const key = `${lo}_${lt}`;
            if (tiles.has(key)) continue;
            tiles.set(key, null);
            fetches.push(
                fetchTile(lo, lt, signal).then(
                    (tile) => void tiles.set(key, tile),
                    () => {},
                ),
            );
        }
    }
    await Promise.all(fetches);

    function readPoint(latIdx: number, lonIdx: number): number | null {
        const latTile = Math.floor(latIdx / POINTS_PER_TILE);
        const lonTile = Math.floor(lonIdx / POINTS_PER_TILE);
        const tile = tiles.get(`${lonTile}_${latTile}`);
        if (!tile) return null;
        const localLat = latIdx - latTile * POINTS_PER_TILE;
        const localLon = lonIdx - lonTile * POINTS_PER_TILE;
        const base = (localLat * POINTS_PER_TILE + localLon) * DAYS;
        let sum = 0;
        let count = 0;
        for (const day of days) {
            const value = tile.bytes[base + day];
            if (value !== NO_DATA && value !== undefined) {
                sum += value;
                count++;
            }
        }
        return count === 0 ? null : sum / count;
    }

    return points.map((p) => {
        const { lat0, lat1, lon0, lon1, fLat, fLon } = surroundingCorners(p.lat, p.lon);
        return bilinearBlend(readPoint(lat0, lon0), readPoint(lat0, lon1), readPoint(lat1, lon0), readPoint(lat1, lon1), fLat, fLon);
    });
}
