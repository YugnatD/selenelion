/**
 * Shared grid geometry for the ERA5-derived climatology tile sets (day-of-year in
 * climatologyTiles.ts, day×2h-bucket in climatologyHourlyTiles.ts) — both use the exact same
 * 0.25° global grid and 10°x10° tiling scheme, produced by scripts/buildClimatologyCombinedTiles.ts.
 * Pulled out here so the lat/lon-to-grid-index math (already the source of one real bug — a
 * flipped latitude axis) and the day-of-year fold logic exist in exactly one place rather than
 * three.
 */

export const LAT_COUNT = 721; // -90° (South Pole, index 0) to 90° (North Pole, index 720), step 0.25°
export const LON_COUNT = 1440; // -180° to 179.75°, step 0.25°
const DEG_STEP = 0.25;
export const DAYS = 365; // day-of-year slots; Feb 29 folds into Feb 28's slot
export const POINTS_PER_TILE = 40;
export const LON_TILES = LON_COUNT / POINTS_PER_TILE; // 36
export const LAT_TILES = Math.ceil(LAT_COUNT / POINTS_PER_TILE); // 19 (18 full + 1 row)
export const NO_DATA = 255;

/** The hourly tile set groups the year into 10-day periods rather than carrying all 365 days.
 *  It answers "how does cloud cover vary through the day at this time of year" — the daily set
 *  already gives day-of-year precision, and the diurnal shape drifts across a season rather than
 *  day to day, so per-day resolution here cost 10x the payload for detail nothing reads (7 MB per
 *  tile, 4.8 GB in total, 28 MB fetched for a single point lookup). Must stay in sync with the
 *  grouping in scripts/buildClimatologyCombinedTiles.ts, which writes these files. */
export const HOURLY_DAY_GROUP_DAYS = 10;
export const HOURLY_DAY_GROUPS = Math.ceil(DAYS / HOURLY_DAY_GROUP_DAYS); // 37

/** Which 10-day group a day-of-year slot falls in. */
export function hourlyDayGroup(daySlot: number): number {
    return Math.min(HOURLY_DAY_GROUPS - 1, Math.max(0, Math.floor(daySlot / HOURLY_DAY_GROUP_DAYS)));
}

export function latRowsInTile(latTileIdx: number): number {
    return Math.min(POINTS_PER_TILE, LAT_COUNT - latTileIdx * POINTS_PER_TILE);
}

/** Non-leap cumulative day-of-year at the start of each month (0-indexed month) — mirrors the
 *  build script's mapping, applied here to a JS Date instead of an hour-of-year index. */
const CUMULATIVE_DAYS = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

/** 0-364 day slot for a date's UTC calendar day, folding Feb 29 into Feb 28's slot — same
 *  simplification as the build script (climatology doesn't need true solar/local-day precision). */
export function dayOfYearSlot(date: Date): number {
    const month = date.getUTCMonth();
    const day = date.getUTCDate();
    if (month === 1 && day === 29) return CUMULATIVE_DAYS[1]! + 27; // fold into Feb 28 (CUMULATIVE_DAYS has 12 fixed entries)
    return CUMULATIVE_DAYS[month]! + (day - 1); // getUTCMonth() always returns 0-11, within CUMULATIVE_DAYS's 12 entries
}

/** `window` consecutive day-of-year slots centered on `centerDay` (wrapping around the Dec
 *  31/Jan 1 boundary), used to smooth a single day's climatology noise by blending in its
 *  nearest neighbors. `window` should be odd so the center day is evenly flanked; an even value
 *  biases one extra day onto the later side. */
export function daySlotsForWindow(centerDay: number, window: number): number[] {
    const half = Math.floor(window / 2);
    const days: number[] = [];
    for (let d = -half; d < window - half; d++) {
        days.push(((centerDay + d) % DAYS + DAYS) % DAYS);
    }
    return days;
}

/** Fractional grid index (not rounded) along latitude: 0 at -90° (South Pole), LAT_COUNT-1 at
 *  +90° (North Pole) — confirmed against the source ERA5 file's real axis orientation by
 *  cross-checking a known point/hour against Open-Meteo's own archive API (index 0 is NOT the
 *  North Pole, despite that being the more common convention in other gridded datasets). */
export function latToIndex(lat: number): number {
    const clamped = Math.max(-90, Math.min(90, lat));
    return (clamped + 90) / DEG_STEP;
}

/** Fractional grid index along longitude, wrapped into [0, LON_COUNT). */
export function lonToIndex(lon: number): number {
    const wrapped = ((lon + 180) % 360 + 360) % 360;
    return wrapped / DEG_STEP;
}

/** Distance-weighted blend of the (up to) 4 grid points surrounding a fractional coordinate,
 *  falling back to a plain average of whichever corners have data if some are missing (e.g. at
 *  a tile boundary where a neighbor tile failed to load), and to null if none do. */
export function bilinearBlend(v00: number | null, v01: number | null, v10: number | null, v11: number | null, fLat: number, fLon: number): number | null {
    const corners: Array<{ value: number; weight: number }> = [];
    if (v00 !== null) corners.push({ value: v00, weight: (1 - fLat) * (1 - fLon) });
    if (v01 !== null) corners.push({ value: v01, weight: (1 - fLat) * fLon });
    if (v10 !== null) corners.push({ value: v10, weight: fLat * (1 - fLon) });
    if (v11 !== null) corners.push({ value: v11, weight: fLat * fLon });
    if (corners.length === 0) return null;

    const totalWeight = corners.reduce((s, c) => s + c.weight, 0);
    if (totalWeight === 0) return corners.reduce((s, c) => s + c.value, 0) / corners.length;
    return corners.reduce((s, c) => s + c.value * c.weight, 0) / totalWeight;
}

/** The 4 grid-index corners and interpolation fractions surrounding an arbitrary lat/lon. */
export function surroundingCorners(lat: number, lon: number) {
    const latF = latToIndex(lat);
    const lonF = lonToIndex(lon);
    const lat0 = Math.min(LAT_COUNT - 1, Math.floor(latF));
    const lat1 = Math.min(LAT_COUNT - 1, lat0 + 1);
    const lon0 = Math.floor(lonF) % LON_COUNT;
    const lon1 = (lon0 + 1) % LON_COUNT;
    return { lat0, lat1, lon0, lon1, fLat: latF - lat0, fLon: lonF - lon0 };
}

export interface TileData {
    rows: number; // POINTS_PER_TILE, except the last latitude band
    bytes: Uint8Array;
}

export function tileKey(lonTile: number, latTile: number): string {
    return `${lonTile}_${latTile}`;
}

/** Prefixes a same-origin tile path (`/climatology`, `/climatology-hourly`) with
 *  `VITE_CLIMATOLOGY_BASE_URL` when set, so the ~800MB tile set can be hosted separately from the
 *  app bundle (e.g. an R2/S3 bucket behind its own CDN) instead of shipping through the same
 *  git-based deploy as the rest of the site. Unset (the default) reproduces today's behaviour
 *  exactly: a plain relative path, served from wherever the app itself is hosted. The env var
 *  must be a full origin with no trailing slash, e.g. `https://climatology.example.com`. */
export function climatologyBaseUrl(path: string): string {
    const base = import.meta.env.VITE_CLIMATOLOGY_BASE_URL ?? '';
    return `${base}${path}`;
}

/** A tile fetcher+cache bound to one tile set's URL prefix (e.g. `/climatology` or
 *  `/climatology-hourly`) — each tile set gets its own cache instance so the two don't collide
 *  or evict each other.
 *
 *  `maxEntries` is required, not optional: these tiles are big and long-lived, and an unbounded
 *  cache here is a real memory problem rather than a theoretical one. A tile holds one byte per
 *  (point × time slot), so a daily tile is 40×40×365 = 584 KB and an hourly one 40×40×444 =
 *  711 KB — and a single point lookup pulls the 4 tiles surrounding it. The hourly set used to
 *  carry all 365 days rather than 37 ten-day groups, at 7 MB per tile: left uncapped, exploring
 *  in hour mode then retained ~28 MB per clicked point permanently (~1.4 GB after 50 points).
 *  Callers pick a cap from their own entry size; see the call sites for the chosen byte budgets. */
export function createTileFetcher(urlPrefix: string, maxEntries: number) {
    const cache = new Map<string, Promise<TileData | null>>();
    return function fetchTile(lonTile: number, latTile: number, signal?: AbortSignal): Promise<TileData | null> {
        const key = tileKey(lonTile, latTile);
        const cached = cache.get(key);
        if (cached) {
            // Re-insert so the Map's insertion order (which drives eviction below) tracks
            // recency — otherwise eviction is FIFO, and the tiles under the area currently being
            // explored, i.e. exactly the hot ones, get discarded while stale ones survive.
            cache.delete(key);
            cache.set(key, cached);
            // A cache hit joins a fetch already in flight (or already resolved): there's only one
            // underlying request per key, so only the caller who actually triggers it can abort
            // it. Later joiners' signals are not attached — see the eviction note below for why
            // that's fine (the request still resolves normally for everyone awaiting it).
            return cached;
        }

        const promise = (async () => {
            const response = await fetch(`${urlPrefix}/${key}.bin`, signal ? { signal } : undefined);
            if (response.status === 404) return null;
            if (!response.ok) throw new Error(`Climatology tile fetch failed: ${response.status}`);
            const buf = new Uint8Array(await response.arrayBuffer());
            return { rows: latRowsInTile(latTile), bytes: buf };
        })().catch((err: unknown) => {
            cache.delete(key); // transient failure — allow a retry on the next request
            throw err;
        });
        cache.set(key, promise);

        // Evicting only drops this cache's reference: any lookup already awaiting an evicted
        // tile holds its own reference to the promise and still resolves normally.
        while (cache.size > maxEntries) {
            const oldestKey = cache.keys().next().value;
            if (oldestKey === undefined) break;
            cache.delete(oldestKey);
        }
        return promise;
    };
}
