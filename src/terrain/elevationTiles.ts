const TILE_SIZE = 256;
const TILE_URL = (z: number, x: number, y: number) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

interface DecodedTile {
    width: number;
    height: number;
    /** Elevation in meters, row-major, one value per pixel. */
    elevations: Float32Array;
}

/** ~256KB per decoded tile (256×256 px × 4-byte float). Capped so a long session spent
 *  exploring many eclipses/regions (horizon profiles, obstruction grids, and 3D terrain meshes
 *  all share this cache) can't grow memory usage unbounded for the life of the tab.
 *
 *  Sized to comfortably cover a full obstruction-grid computation's working set now that the
 *  near-field budget (NEAR_TILE_BUDGET) and far-field budget+concurrency cap (see
 *  obstructionGrid.ts and MAX_CONCURRENT_TILE_FETCHES below) bound how many distinct tiles a
 *  single computation can touch, while keeping a bounded, few-hundred-MB ceiling per module
 *  instance (1024 entries × ~256KB ≈ 256MB). Previously 500 entries (~128MB) — measured as far
 *  below the real working set (up to ~3,876 tiles at map zoom 5), so the LRU cycled fully every
 *  request with near-zero hit rate; raising the cap trades a bit more steady-state memory for
 *  actually getting cache hits during a pan/zoom session. */
const TILE_CACHE_MAX_ENTRIES = 1024;
const tileCache = new Map<number, Promise<DecodedTile | null>>();

/** Numeric tile-cache key instead of a `${z}/${x}/${y}` template-literal string: the batch APIs
 *  below can resolve millions of points in one call (a full-resolution PDF export grid), and a
 *  fresh string allocation (plus string hashing on every Map access) for every single point was
 *  measured as a meaningful share of that path's transient heap. Exact up to zoom 19
 *  (x, y < 2^19 = 524288 < 1e6) — comfortably above any zoom this app ever requests (max 12). */
function tileKey(z: number, x: number, y: number): number {
    return z * 1e12 + x * 1e6 + y;
}

/** Terrarium encoding: elevation(m) = (R * 256 + G + B / 256) - 32768. */
function decodeTerrarium(imageData: ImageData): Float32Array {
    const { data, width, height } = imageData;
    const elevations = new Float32Array(width * height);
    for (let i = 0; i < width * height; i++) {
        // ImageData.data.length === width*height*4 by spec, and i ranges over [0, width*height),
        // so i*4+2 is always a valid index into data.
        const r = data[i * 4]!;
        const g = data[i * 4 + 1]!;
        const b = data[i * 4 + 2]!;
        elevations[i] = r * 256 + g + b / 256 - 32768;
    }
    return elevations;
}

function fetchTile(z: number, x: number, y: number, signal?: AbortSignal): Promise<DecodedTile | null> {
    const key = tileKey(z, x, y);
    const cached = tileCache.get(key);
    if (cached) {
        // Re-insert so insertion order (which drives eviction below) tracks recency rather than
        // first-fetch time. Without this the eviction is FIFO, which is actively the wrong policy
        // here: a horizon profile or obstruction grid re-reads the tiles around the observer over
        // and over, so those hot tiles are precisely the oldest-inserted ones and would be thrown
        // out first while single-use tiles from an earlier pan survive.
        tileCache.delete(key);
        tileCache.set(key, cached);
        return cached;
    }

    {
        const promise = (async () => {
            const maxTile = 2 ** z;
            if (x < 0 || x >= maxTile || y < 0 || y >= maxTile) return null;
            // Shared across every caller currently waiting on this same tile (see the cache
            // dedup above) — only the signal belonging to whichever call first triggered the
            // fetch actually governs it. A later caller aborting doesn't cancel an in-flight
            // fetch started by someone else; it just means a future request for the same tile
            // (after this one is evicted/settles) won't find it cached. Good enough here: the
            // point of threading the signal through is to stop a superseded *computation*'s own
            // network phase from running to completion, not perfect per-caller cancellation of a
            // tile that unrelated callers still want.
            const response = await fetch(TILE_URL(z, x, y), signal ? { signal } : undefined);
            // A 404 means the tile genuinely doesn't exist at this zoom (permanent — fine to
            // cache as null). Anything else non-OK (5xx, 429, ...) is more likely transient, so
            // it throws instead, hitting the same eviction-for-retry path as a network error
            // below rather than being cached as "no data" forever.
            if (response.status === 404) return null;
            if (!response.ok) throw new Error(`Elevation tile fetch failed: ${response.status}`);
            const blob = await response.blob();
            const bitmap = await createImageBitmap(blob);
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            const ctx = canvas.getContext('2d');
            if (!ctx) return null;
            ctx.drawImage(bitmap, 0, 0);
            const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
            return { width: bitmap.width, height: bitmap.height, elevations: decodeTerrarium(imageData) };
        })().catch((err: unknown) => {
            // Don't permanently poison this tile on a transient failure (offline blip, S3
            // hiccup, or an abort): evict it so the next request for the same tile retries from
            // scratch rather than replaying the same failure forever.
            tileCache.delete(key);
            throw err;
        });
        tileCache.set(key, promise);
        // Evict the least-recently-used entry once over the cap (Map preserves insertion order,
        // refreshed on every hit above). Safe even if that tile's fetch is still in flight
        // elsewhere — the caller already holds its own reference to the promise; this only means
        // a future request for the same tile won't find it cached and will re-fetch.
        while (tileCache.size > TILE_CACHE_MAX_ENTRIES) {
            const oldestKey = tileCache.keys().next().value;
            if (oldestKey === undefined) break;
            tileCache.delete(oldestKey);
        }
        return promise;
    }
}

function lonToTileX(lon: number, zoom: number): number {
    return ((lon + 180) / 360) * 2 ** zoom;
}

/** Exported for obstructionGrid.ts's tile-count budgeting (near and far field): the true
 *  Mercator row span for a latitude range is not linear in latitude (it scales with
 *  1/cos(lat)), so budget estimates need this same projection rather than a `latSpan / 180`
 *  approximation to stay accurate away from the mid-latitudes. */
export function latToTileY(lat: number, zoom: number): number {
    const latRad = (lat * Math.PI) / 180;
    return ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * 2 ** zoom;
}

interface TileCoords {
    tileX: number;
    tileY: number;
    px: number;
    py: number;
}

function tileCoords(lat: number, lon: number, zoom: number): TileCoords {
    const tx = lonToTileX(lon, zoom);
    const ty = latToTileY(lat, zoom);
    const tileX = Math.floor(tx);
    const tileY = Math.floor(ty);
    return { tileX, tileY, px: (tx - tileX) * TILE_SIZE, py: (ty - tileY) * TILE_SIZE };
}

function readPixel(tile: DecodedTile | null, px: number, py: number): number {
    if (!tile) return 0;
    const x0 = Math.max(0, Math.min(tile.width - 1, Math.floor(px)));
    const y0 = Math.max(0, Math.min(tile.height - 1, Math.floor(py)));
    // x0/y0 are clamped into [0, width-1]/[0, height-1] above, and elevations has exactly
    // width*height entries, so this index is always in bounds.
    return tile.elevations[y0 * tile.width + x0]!;
}

/** Nearest-pixel elevation (meters) at a lat/lon, fetching (and caching) whichever tile covers it.
 *  Rejects on a genuine fetch failure (network error, non-404 HTTP status, abort) — callers that
 *  want a fallback value instead of a rejected promise should `.catch()` explicitly, so that
 *  choice stays visible at the call site rather than being made silently in here. */
export async function getElevation(lat: number, lon: number, zoom: number, signal?: AbortSignal): Promise<number> {
    const c = tileCoords(lat, lon, zoom);
    const tile = await fetchTile(zoom, c.tileX, c.tileY, signal);
    return readPixel(tile, c.px, c.py);
}

/** How many tile fetches a single batch call will ever have in flight at once. Without this, a
 *  batch that touches many distinct tiles fired every `fetchTile` into one unbounded
 *  `Promise.all` — measured at ~3,900 concurrent fetches (and ~969MB of simultaneously decoded
 *  tiles) for the far-field ray-cast at the app's own minimum map zoom. Excess tile fetches are
 *  queued and started as earlier ones complete instead. 24-32 is comfortably below what browsers
 *  themselves cap concurrent requests-per-origin to, while still keeping decode work bounded. */
const MAX_CONCURRENT_TILE_FETCHES = 28;

/** Runs `worker(i)` for i in [0, taskCount) with at most `limit` calls in flight at once. */
async function runWithConcurrencyLimit(taskCount: number, worker: (index: number) => Promise<void>, limit: number): Promise<void> {
    if (taskCount === 0) return;
    let next = 0;
    const runOne = async () => {
        while (next < taskCount) {
            const i = next++;
            await worker(i);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, taskCount) }, runOne));
}

/**
 * Elevation (meters) for many points at once, given as a flat, interleaved [lat0, lon0, lat1,
 * lon1, ...] array rather than one `{lat, lon}` object per point. Tiles covering the points are
 * fetched only once each (deduplicated), with at most `MAX_CONCURRENT_TILE_FETCHES` requests in
 * flight at a time, then every point is resolved synchronously against the decoded tiles.
 *
 * A point whose tile genuinely failed to fetch (as opposed to a confirmed-absent 404, which is a
 * legitimate "no data here") resolves to `NaN` rather than silently reading as 0m/sea level —
 * callers that feed this into further math should treat NaN as "unknown", not as a real
 * elevation. The first few distinct failures are logged via `console.warn` so a network problem
 * is visible in dev instead of silently degrading results; an aborted fetch (`signal`) is not
 * logged, since that's the expected outcome of superseding a computation, not a failure.
 */
export async function getElevationsBatchFlat(coords: Float64Array, zoom: number, signal?: AbortSignal): Promise<Float32Array> {
    const n = coords.length / 2;
    const result = new Float32Array(n);
    if (n === 0) return result;

    // Per-point tile identity and in-tile pixel offset — flat typed arrays throughout, not one
    // {tileX, tileY, px, py} object per point, which is what turned a multi-million-point export
    // grid into ~900MB of transient allocation before this change.
    const tileXs = new Int32Array(n);
    const tileYs = new Int32Array(n);
    const pxs = new Float32Array(n);
    const pys = new Float32Array(n);
    const keys = new Float64Array(n); // numeric tile keys (zoom is fixed for the whole call)
    for (let i = 0; i < n; i++) {
        // coords.length === n*2 by construction (n = coords.length/2), so i*2 and i*2+1 are
        // always valid indices for i < n.
        const lat = coords[i * 2]!;
        const lon = coords[i * 2 + 1]!;
        const tx = lonToTileX(lon, zoom);
        const ty = latToTileY(lat, zoom);
        const tileX = Math.floor(tx);
        const tileY = Math.floor(ty);
        tileXs[i] = tileX;
        tileYs[i] = tileY;
        pxs[i] = (tx - tileX) * TILE_SIZE;
        pys[i] = (ty - tileY) * TILE_SIZE;
        keys[i] = tileKey(zoom, tileX, tileY);
    }

    const tiles = new Map<number, DecodedTile | null>();
    const failed = new Set<number>();
    const uniqueKeys: number[] = [];
    const uniqueTileX: number[] = [];
    const uniqueTileY: number[] = [];
    for (let i = 0; i < n; i++) {
        // keys/tileXs/tileYs were all sized to n and filled for every i < n in the loop above.
        const key = keys[i]!;
        if (tiles.has(key)) continue;
        tiles.set(key, null); // placeholder so a later duplicate point doesn't queue a second fetch
        uniqueKeys.push(key);
        uniqueTileX.push(tileXs[i]!);
        uniqueTileY.push(tileYs[i]!);
    }

    let warnedFailures = 0;
    await runWithConcurrencyLimit(
        uniqueKeys.length,
        async (u) => {
            // uniqueKeys/uniqueTileX/uniqueTileY are pushed together 1:1 in the loop above, so
            // they share the same length and u < uniqueKeys.length indexes all three safely.
            const key = uniqueKeys[u]!;
            try {
                const tile = await fetchTile(zoom, uniqueTileX[u]!, uniqueTileY[u]!, signal);
                tiles.set(key, tile);
            } catch (err: unknown) {
                failed.add(key);
                const isAbort = err instanceof DOMException && err.name === 'AbortError';
                if (!isAbort && warnedFailures < 5) {
                    warnedFailures++;
                    console.warn(
                        `Elevation tile fetch failed for zoom ${zoom} tile (${uniqueTileX[u]}, ${uniqueTileY[u]}); ` +
                            'points covered by it will resolve to NaN (no data) instead of a false 0m/sea-level reading.',
                        err,
                    );
                }
            }
        },
        MAX_CONCURRENT_TILE_FETCHES,
    );

    for (let i = 0; i < n; i++) {
        // keys/pxs/pys are all sized n and were filled for every i < n in the first loop above.
        const key = keys[i]!;
        result[i] = failed.has(key) ? NaN : readPixel(tiles.get(key) ?? null, pxs[i]!, pys[i]!);
    }
    return result;
}

/**
 * Elevation (meters) for many points at once, given as an array of `{lat, lon}` objects — a thin
 * adapter over `getElevationsBatchFlat` for callers that don't have (or don't need) their points
 * in flat-array form already. The one-time flatten here is proportional to the caller's own point
 * count, which for the callers still using this shape (single-point horizon profiles) is small;
 * the multi-million-point grids (obstruction/export, terrain mesh) call the flat API directly.
 */
export async function getElevationsBatch(
    points: Array<{ lat: number; lon: number }>,
    zoom: number,
    signal?: AbortSignal,
): Promise<Float32Array> {
    const coords = new Float64Array(points.length * 2);
    for (let i = 0; i < points.length; i++) {
        // i < points.length, the same bound the loop iterates over.
        const p = points[i]!;
        coords[i * 2] = p.lat;
        coords[i * 2 + 1] = p.lon;
    }
    return getElevationsBatchFlat(coords, zoom, signal);
}
