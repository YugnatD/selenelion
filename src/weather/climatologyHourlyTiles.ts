/**
 * Reads the static day×2h-bucket cloud-cover climatology tiles produced by
 * scripts/buildClimatologyCombinedTiles.ts — the "at the eclipse's actual hour" option, as
 * opposed to climatologyTiles.ts's whole-day average. Same grid/tiling as climatologyTiles.ts
 * (see climatologyGrid.ts), just a different time axis: 12 buckets of 2 hours each, per 10-day
 * period of the year rather than per day (see HOURLY_DAY_GROUPS — the daily set already carries
 * day-of-year precision, and the diurnal shape drifts across a season rather than day to day).
 * Under public/climatology-hourly/, fetched only for single-point lookups, never the WeatherMap
 * grid overview.
 */
import {
    DAYS,
    HOURLY_DAY_GROUPS,
    NO_DATA,
    POINTS_PER_TILE,
    bilinearBlend,
    climatologyBaseUrl,
    createTileFetcher,
    dayOfYearSlot,
    daySlotsForWindow,
    hourlyDayGroup,
    surroundingCorners,
} from './climatologyGrid';

const BUCKET_HOURS = 2;
/** Exported so UI code (WeatherSection.tsx) can build one local-time label per UTC bucket without
 *  duplicating this constant. */
export const BUCKETS_PER_DAY = 24 / BUCKET_HOURS; // 12
const HOURLY_SLOTS = HOURLY_DAY_GROUPS * BUCKETS_PER_DAY; // 444 — see HOURLY_DAY_GROUPS

// 0.69 MB per tile (40×40 points × 444 group-bucket slots) once the year is grouped into 10-day
// periods — comparable to the daily set, so the cache can hold far more than the 12 entries that
// 7 MB tiles allowed. 96 entries is roughly a 66 MB budget.
const fetchTile = createTileFetcher(climatologyBaseUrl('/climatology-hourly'), 96);

/** Which 2-hour bucket (0-11) a date's UTC hour falls into. Exported so UI code can compute the
 *  same bucket index as this module (e.g. to label which hour range is actually being used). */
export function hourBucket(date: Date): number {
    return Math.floor(date.getUTCHours() / BUCKET_HOURS);
}

/** Cloud cover (%) at the exact native grid point, at the given hour bucket, averaged over
 *  `days` (skipping no-data slots) — same day-window smoothing as the daily tiles, but only the
 *  one bucket matching the reference hour on each of those days, not the whole day. */
async function readGridPoint(latIdx: number, lonIdx: number, days: number[], bucket: number, signal?: AbortSignal): Promise<number | null> {
    const latTile = Math.floor(latIdx / POINTS_PER_TILE);
    const lonTile = Math.floor(lonIdx / POINTS_PER_TILE);
    const tile = await fetchTile(lonTile, latTile, signal).catch(() => null);
    if (!tile) return null;
    const localLat = latIdx - latTile * POINTS_PER_TILE;
    const localLon = lonIdx - lonTile * POINTS_PER_TILE;
    const base = (localLat * POINTS_PER_TILE + localLon) * HOURLY_SLOTS;
    let sum = 0;
    let count = 0;
    for (const day of days) {
        const value = tile.bytes[base + hourlyDayGroup(day) * BUCKETS_PER_DAY + bucket];
        if (value !== NO_DATA && value !== undefined) {
            sum += value;
            count++;
        }
    }
    return count === 0 ? null : sum / count;
}

/** Bilinear-interpolated cloud cover (%) at an arbitrary lat/lon, for the 2-hour bucket
 *  containing `date`'s UTC hour, averaged over a `dayWindow`-day window around `date`'s calendar
 *  day (same hour bucket on each of those days — e.g. "around 10-12h, averaged over the 7 days
 *  centered on Aug 2nd"). Falls back to averaging whichever corners have data if some are
 *  missing, like getClimatologyFromTiles. */
export async function getClimatologyHourlyFromTiles(
    lat: number,
    lon: number,
    date: Date,
    signal?: AbortSignal,
    dayWindow = 1,
): Promise<number | null> {
    const days = daySlotsForWindow(dayOfYearSlot(date), dayWindow);
    const bucket = hourBucket(date);
    const { lat0, lat1, lon0, lon1, fLat, fLon } = surroundingCorners(lat, lon);

    const [v00, v01, v10, v11] = await Promise.all([
        readGridPoint(lat0, lon0, days, bucket, signal),
        readGridPoint(lat0, lon1, days, bucket, signal),
        readGridPoint(lat1, lon0, days, bucket, signal),
        readGridPoint(lat1, lon1, days, bucket, signal),
    ]);
    return bilinearBlend(v00, v01, v10, v11, fLat, fLon);
}

/** Fetches the (up to) 4 tiles surrounding a point once, and returns a function that reads the
 *  bilinear-blended value for any (day, bucket) pair against them — shared by
 *  getClimatologyHourlyYearCurve (365 days, one fixed bucket) and getClimatologyHourlyWeekCurve
 *  (a handful of days, one fixed bucket each), so both only fetch each tile once regardless of
 *  how many days they read from it. */
async function pointReader(lat: number, lon: number, signal?: AbortSignal) {
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
        bucket: number,
    ): number | null {
        if (!tile) return null;
        const localLat = latIdx - latTile * POINTS_PER_TILE;
        const localLon = lonIdx - lonTile * POINTS_PER_TILE;
        const value = tile.bytes[(localLat * POINTS_PER_TILE + localLon) * HOURLY_SLOTS + hourlyDayGroup(day) * BUCKETS_PER_DAY + bucket];
        return value === NO_DATA || value === undefined ? null : value;
    }

    return function readAt(day: number, bucket: number): number | null {
        return bilinearBlend(
            valueAt(t00, lat0, lon0, latTile0, lonTile0, day, bucket),
            valueAt(t01, lat0, lon1, latTile0, lonTile1, day, bucket),
            valueAt(t10, lat1, lon0, latTile1, lonTile0, day, bucket),
            valueAt(t11, lat1, lon1, latTile1, lonTile1, day, bucket),
            fLat,
            fLon,
        );
    };
}

/** The full 365-day climatology curve at a single point, like climatologyTiles.ts's
 *  getClimatologyYearCurve, but for one fixed hour bucket instead of the whole day — the
 *  seasonal-context chart's "Heure de l'éclipse" mode, so the chart matches what the headline
 *  number above it is actually showing. */
export async function getClimatologyHourlyYearCurve(lat: number, lon: number, bucket: number, signal?: AbortSignal): Promise<Array<number | null>> {
    const readAt = await pointReader(lat, lon, signal);
    const curve: Array<number | null> = new Array(DAYS);
    for (let day = 0; day < DAYS; day++) curve[day] = readAt(day, bucket);
    return curve;
}

/** One value per day for the `window`-day span centered on `date`'s calendar day (default 7 —
 *  "the week"), each read individually (not averaged together) at the 2-hour bucket containing
 *  `date`'s UTC hour — shows how cloud cover at the eclipse's actual hour trends day-to-day
 *  across the surrounding week, as opposed to getClimatologyHourlyFromTiles's single blended
 *  number for the same window. */
export async function getClimatologyHourlyWeekCurve(
    lat: number,
    lon: number,
    date: Date,
    signal?: AbortSignal,
    window = 7,
): Promise<Array<{ dayOffset: number; value: number | null }>> {
    const centerDay = dayOfYearSlot(date);
    const bucket = hourBucket(date);
    const days = daySlotsForWindow(centerDay, window);
    const readAt = await pointReader(lat, lon, signal);
    const half = Math.floor(window / 2);
    return days.map((day, i) => ({ dayOffset: i - half, value: readAt(day, bucket) }));
}

/** All 12 two-hour buckets for `date`'s calendar day at this point, so a user can see whether the
 *  eclipse's hour falls in a historically clearer or cloudier stretch of that day (e.g. morning
 *  coastal fog that typically burns off by early afternoon). Despite taking a single `date`, this
 *  is NOT single-day precision underneath: like every other reader here it goes through
 *  hourlyDayGroup(), so the values returned are actually the ~10-day climatological window's mean
 *  containing `date`, not that literal calendar day alone (see HOURLY_DAY_GROUP_DAYS in
 *  climatologyGrid.ts). UI copy describing this chart should say "the ~10-day period around the
 *  eclipse date", not "the eclipse's own day". */
export async function getClimatologyHourlyDayProfile(lat: number, lon: number, date: Date, signal?: AbortSignal): Promise<Array<{ bucket: number; value: number | null }>> {
    const day = dayOfYearSlot(date);
    const readAt = await pointReader(lat, lon, signal);
    return Array.from({ length: BUCKETS_PER_DAY }, (_, bucket) => ({ bucket, value: readAt(day, bucket) }));
}
