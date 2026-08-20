import { getClimatologyFromTiles, getClimatologyGridFromTiles } from './climatologyTiles';
import { getClimatologyHourlyFromTiles } from './climatologyHourlyTiles';

/**
 * Cloud cover for the app, always from the precomputed ERA5 climatology tiles.
 *
 * This deliberately has no live-forecast path. The app answers a statistical question — "what are
 * the odds of clear sky at this spot, at this time of year" — which is the useful one when you are
 * choosing where to travel months or years ahead. Anyone watching an eclipse in the next fortnight
 * will check a real forecast, and no planning tool should try to compete with that.
 *
 * Dropping the live branch removed a surprising amount: an API dependency with a rate limit,
 * request pacing and exponential backoff, a per-hour response cache, and — most visibly — the
 * grid-size caps that existed only to keep forecast requests small. Those caps were why the
 * weather overlay used to render as coarse blobs, and why the PDF export quietly reduced its
 * terrain resolution for any eclipse falling inside the forecast window.
 */

/** 'climatology' always, kept as a field so callers (and the UI copy) stay explicit about where a
 *  number came from rather than assuming. */
export interface CloudCoverEstimate {
    source: 'climatology';
    /** 0-100. */
    percent: number;
}

/** 'day' averages the whole day's cloud cover; 'hour' averages only the 2-hour bucket containing
 *  the reference time, across the same day window — "was it usually clear around 10am here in
 *  early August" instead of "was the whole day usually clear". */
export type WeatherTimeMode = 'day' | 'hour';

/**
 * Cloud cover (%) at a single point for the given moment. `dayWindow` widens the averaging window
 * around the target calendar day to smooth single-day noise in the multi-year mean.
 */
export async function getCloudCoverEstimate(
    lat: number,
    lon: number,
    date: Date,
    signal?: AbortSignal,
    dayWindow = 1,
    timeMode: WeatherTimeMode = 'day',
): Promise<CloudCoverEstimate | null> {
    const percent =
        timeMode === 'hour'
            ? await getClimatologyHourlyFromTiles(lat, lon, date, signal, dayWindow)
            : await getClimatologyFromTiles(lat, lon, date, signal, dayWindow);
    return percent === null ? null : { source: 'climatology', percent };
}

/** Grid version of getCloudCoverEstimate — one value (0-100, or null) per input point. */
export async function getWeatherGrid(
    points: Array<{ lat: number; lon: number }>,
    bounds: { west: number; south: number; east: number; north: number },
    date: Date,
    signal?: AbortSignal,
    dayWindow = 1,
): Promise<Array<number | null>> {
    if (points.length === 0) return [];
    return getClimatologyGridFromTiles(points, bounds, date, signal, dayWindow);
}
