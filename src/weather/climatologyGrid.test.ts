import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    bilinearBlend,
    createTileFetcher,
    DAYS,
    dayOfYearSlot,
    daySlotsForWindow,
    LAT_COUNT,
    LON_COUNT,
    latToIndex,
    lonToIndex,
    surroundingCorners,
} from './climatologyGrid';

// Regression coverage for a real bug from earlier in this project: the climatology build script
// and the client-side tile reader disagreed about which end of the latitude axis was index 0
// (assumed North Pole; the actual ERA5 source file has South Pole at index 0), silently reading
// every point's weather data from its mirror-image latitude until caught by cross-checking a
// known point against Open-Meteo's own archive API.
describe('latToIndex', () => {
    it('places the South Pole at index 0, not the North Pole', () => {
        expect(latToIndex(-90)).toBe(0);
    });

    it('places the North Pole at the last index', () => {
        expect(latToIndex(90)).toBe(LAT_COUNT - 1);
    });

    it('places the equator at the midpoint', () => {
        expect(latToIndex(0)).toBe((LAT_COUNT - 1) / 2);
    });

    it('clamps out-of-range latitudes instead of producing an out-of-grid index', () => {
        expect(latToIndex(-95)).toBe(0);
        expect(latToIndex(95)).toBe(LAT_COUNT - 1);
    });
});

describe('lonToIndex', () => {
    it('places -180 at index 0', () => {
        expect(lonToIndex(-180)).toBe(0);
    });

    it('wraps +180 back around to index 0, not off the end of the grid', () => {
        expect(lonToIndex(180)).toBe(0);
    });

    it('wraps a negative-past-the-seam longitude the same as its positive equivalent', () => {
        expect(lonToIndex(-190)).toBeCloseTo(lonToIndex(170), 6);
    });

    it('stays within [0, LON_COUNT) for arbitrary input', () => {
        for (const lon of [-540, -181, -0.1, 0, 359.9, 540]) {
            const idx = lonToIndex(lon);
            expect(idx).toBeGreaterThanOrEqual(0);
            expect(idx).toBeLessThan(LON_COUNT);
        }
    });
});

describe('dayOfYearSlot', () => {
    it('is 0 for January 1st', () => {
        expect(dayOfYearSlot(new Date('2024-01-01T00:00:00Z'))).toBe(0);
    });

    it('is DAYS-1 for December 31st in a non-leap year', () => {
        expect(dayOfYearSlot(new Date('2023-12-31T00:00:00Z'))).toBe(DAYS - 1);
    });

    it('folds Feb 29 into the same slot as Feb 28 (leap year has no 366th slot)', () => {
        const feb28 = dayOfYearSlot(new Date('2024-02-28T00:00:00Z'));
        const feb29 = dayOfYearSlot(new Date('2024-02-29T00:00:00Z'));
        expect(feb29).toBe(feb28);
    });
});

describe('daySlotsForWindow', () => {
    it('wraps around the Dec 31 / Jan 1 boundary', () => {
        expect(daySlotsForWindow(0, 3)).toEqual([DAYS - 1, 0, 1]);
    });

    it('returns `window` slots centered on the given day in the middle of the year', () => {
        expect(daySlotsForWindow(100, 5)).toEqual([98, 99, 100, 101, 102]);
    });
});

describe('bilinearBlend', () => {
    it('weights all four corners by proximity when all are present', () => {
        // Exactly at one corner (fLat=0, fLon=0) should return that corner's value untouched.
        expect(bilinearBlend(10, 20, 30, 40, 0, 0)).toBe(10);
        // Exactly at the opposite corner.
        expect(bilinearBlend(10, 20, 30, 40, 1, 1)).toBe(40);
        // Dead center should be the plain average of all four.
        expect(bilinearBlend(10, 20, 30, 40, 0.5, 0.5)).toBeCloseTo(25, 6);
    });

    it('falls back to a plain average of whichever corners have data', () => {
        expect(bilinearBlend(10, null, 30, null, 0.5, 0.5)).toBeCloseTo(20, 6);
    });

    it('returns null when no corner has data', () => {
        expect(bilinearBlend(null, null, null, null, 0.5, 0.5)).toBeNull();
    });
});

// These tiles are big (584 KB daily, 7 MB hourly) and the cache used to be unbounded, which
// retained ~28 MB per point clicked in hour mode. The cap alone isn't enough though — the
// eviction policy has to be LRU, not FIFO, or the tiles under the area actively being explored
// (the oldest-inserted, most-reused ones) get thrown out first. These tests are written so that
// a FIFO implementation fails them.
describe('createTileFetcher caching', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    /** Counts real fetches so cache hits are observable. Tiny bodies: these tests only assert
     *  fetch/eviction behaviour, never decoded tile values. */
    function stubFetch(): { calls: () => string[] } {
        const calls: string[] = [];
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url: string) => {
                calls.push(url);
                return {
                    ok: true,
                    status: 200,
                    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
                };
            }),
        );
        return { calls: () => calls };
    }

    it('serves a repeated tile request from cache instead of refetching', async () => {
        const { calls } = stubFetch();
        const fetchTile = createTileFetcher('/x', 8);

        await fetchTile(0, 0);
        await fetchTile(0, 0);

        expect(calls()).toHaveLength(1);
    });

    it('evicts once past maxEntries', async () => {
        const { calls } = stubFetch();
        const fetchTile = createTileFetcher('/x', 2);

        await fetchTile(0, 0);
        await fetchTile(1, 0);
        await fetchTile(2, 0); // pushes the cache over the cap, evicting tile 0_0
        expect(calls()).toHaveLength(3);

        await fetchTile(0, 0); // evicted, so this must refetch
        expect(calls()).toHaveLength(4);
    });

    it('evicts least-recently-USED, not first-inserted (a FIFO cache fails this)', async () => {
        const { calls } = stubFetch();
        const fetchTile = createTileFetcher('/x', 2);

        await fetchTile(0, 0);
        await fetchTile(1, 0);
        await fetchTile(0, 0); // hit — refreshes 0_0's recency, so 1_0 is now the LRU entry
        expect(calls()).toHaveLength(2);

        await fetchTile(2, 0); // should evict 1_0 (LRU), NOT 0_0 (oldest-inserted)
        expect(calls()).toHaveLength(3);

        await fetchTile(0, 0); // still cached under LRU; a FIFO cache would have evicted it
        expect(calls()).toHaveLength(3);

        await fetchTile(1, 0); // genuinely evicted, so this refetches
        expect(calls()).toHaveLength(4);
    });

    it('does not cache a failed fetch, so a transient error can be retried', async () => {
        const calls: string[] = [];
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url: string) => {
                calls.push(url);
                return { ok: false, status: 503, arrayBuffer: async () => new ArrayBuffer(0) };
            }),
        );
        const fetchTile = createTileFetcher('/x', 8);

        await expect(fetchTile(0, 0)).rejects.toThrow();
        await expect(fetchTile(0, 0)).rejects.toThrow();

        expect(calls).toHaveLength(2); // retried rather than serving a cached rejection
    });

    it('caches a 404 as "no data" rather than retrying it forever', async () => {
        const calls: string[] = [];
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url: string) => {
                calls.push(url);
                return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
            }),
        );
        const fetchTile = createTileFetcher('/x', 8);

        expect(await fetchTile(5, 5)).toBeNull();
        expect(await fetchTile(5, 5)).toBeNull();

        expect(calls).toHaveLength(1); // a missing tile is permanent, unlike a 5xx
    });
});

// Coordinate edge cases that a lat/lon grid gets wrong most often: the ±180 seam and the poles.
describe('surroundingCorners — coordinate edge cases', () => {
    it('treats +180 and -180 as the same meridian', () => {
        const east = surroundingCorners(0, 180);
        const west = surroundingCorners(0, -180);
        expect(east).toEqual(west);
    });

    it('wraps the longitude corner pair across the antimeridian instead of running off the grid', () => {
        // Just west of the seam: lon1 must wrap back to column 0, not become LON_COUNT.
        const c = surroundingCorners(0, 179.9);
        expect(c.lon0).toBe(LON_COUNT - 1);
        expect(c.lon1).toBe(0);
    });

    it('keeps both latitude corners inside the grid at the poles', () => {
        for (const lat of [-90, 90, -89.99, 89.99]) {
            const c = surroundingCorners(lat, 0);
            expect(c.lat0).toBeGreaterThanOrEqual(0);
            expect(c.lat1).toBeGreaterThanOrEqual(0);
            expect(c.lat0).toBeLessThan(LAT_COUNT);
            expect(c.lat1).toBeLessThan(LAT_COUNT);
        }
    });

    it('produces interpolation fractions within 0..1 for arbitrary coordinates', () => {
        for (let i = 0; i < 200; i++) {
            const lat = -90 + (i / 199) * 180;
            const lon = -180 + ((i * 37) % 360);
            const c = surroundingCorners(lat, lon);
            expect(c.fLat).toBeGreaterThanOrEqual(0);
            expect(c.fLat).toBeLessThanOrEqual(1);
            expect(c.fLon).toBeGreaterThanOrEqual(0);
            expect(c.fLon).toBeLessThanOrEqual(1);
        }
    });
});
