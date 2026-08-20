import { beforeAll, describe, expect, it, vi } from 'vitest';
import { DAYS, POINTS_PER_TILE, dayOfYearSlot, latRowsInTile } from './climatologyGrid';
import { getClimatologyFromTiles, getClimatologyGridFromTiles, getClimatologyYearCurve } from './climatologyTiles';

/**
 * Differential tests. getClimatologyFromTiles (one point), getClimatologyGridFromTiles (a whole
 * viewport at once) and getClimatologyYearCurve (all 365 days at one point) are three
 * independently-written readers over the same tile bytes — so wherever they disagree about the
 * same coordinate and day, at least one of them is wrong. That's a much sharper check than
 * asserting any single one against a hand-computed constant.
 *
 * Tiles are served synthetically: a deterministic value per (latIdx, lonIdx, day) that stays
 * inside 0..100 and so never collides with the 255 no-data sentinel.
 */
function syntheticValue(latIdx: number, lonIdx: number, day: number): number {
    return (latIdx * 31 + lonIdx * 17 + day * 7) % 101;
}

function buildTile(lonTile: number, latTile: number): Uint8Array {
    const rows = latRowsInTile(latTile);
    const bytes = new Uint8Array(rows * POINTS_PER_TILE * DAYS);
    let i = 0;
    for (let r = 0; r < rows; r++) {
        const latIdx = latTile * POINTS_PER_TILE + r;
        for (let c = 0; c < POINTS_PER_TILE; c++) {
            const lonIdx = lonTile * POINTS_PER_TILE + c;
            for (let day = 0; day < DAYS; day++) bytes[i++] = syntheticValue(latIdx, lonIdx, day);
        }
    }
    return bytes;
}

beforeAll(() => {
    const built = new Map<string, Uint8Array>();
    vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
            const m = /\/climatology\/(\d+)_(\d+)\.bin$/.exec(url);
            if (!m) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
            const key = `${m[1]}_${m[2]}`;
            let bytes = built.get(key);
            if (!bytes) {
                bytes = buildTile(Number(m[1]), Number(m[2]));
                built.set(key, bytes);
            }
            return { ok: true, status: 200, arrayBuffer: async () => bytes!.buffer };
        }),
    );
});

const DATE = new Date('2027-08-02T10:00:00Z');

/** Tight bounds around a single point, as a viewport containing just that point. */
function boundsAround(lat: number, lon: number) {
    return { west: lon - 0.05, east: lon + 0.05, south: lat - 0.05, north: lat + 0.05 };
}

describe('single-point vs grid reader agreement', () => {
    const cases: Array<[string, number, number]> = [
        ['mid-tile point', 12.3, 45.7],
        ['southern hemisphere', -33.9, 18.4],
        ['tile-boundary point', 10.0, 10.0],
        ['near the north pole', 89.6, 23.0],
        ['near the south pole', -89.6, -140.0],
        ['just west of the antimeridian', 5.0, 179.9],
        ['just east of the antimeridian', 5.0, -179.9],
    ];

    for (const [name, lat, lon] of cases) {
        it(`agrees at ${name} (${lat}, ${lon})`, async () => {
            const single = await getClimatologyFromTiles(lat, lon, DATE);
            const [grid] = await getClimatologyGridFromTiles([{ lat, lon }], boundsAround(lat, lon), DATE);

            expect(single).not.toBeNull();
            expect(grid).not.toBeNull();
            expect(grid!).toBeCloseTo(single!, 9);
        });
    }

    it('agrees with a multi-day averaging window too', async () => {
        const lat = 43.2;
        const lon = -1.5;
        for (const dayWindow of [1, 5, 7]) {
            const single = await getClimatologyFromTiles(lat, lon, DATE, undefined, dayWindow);
            const [grid] = await getClimatologyGridFromTiles([{ lat, lon }], boundsAround(lat, lon), DATE, undefined, dayWindow);
            expect(grid!).toBeCloseTo(single!, 9);
        }
    });
});

describe('year-curve vs single-point reader agreement', () => {
    it('curve[daySlot] matches the single-day lookup for the same date', async () => {
        const lat = 36.1;
        const lon = -5.3;
        const curve = await getClimatologyYearCurve(lat, lon);
        const single = await getClimatologyFromTiles(lat, lon, DATE, undefined, 1);

        expect(curve[dayOfYearSlot(DATE)]).not.toBeNull();
        expect(curve[dayOfYearSlot(DATE)]!).toBeCloseTo(single!, 9);
    });

    it('returns one entry per day-of-year slot', async () => {
        const curve = await getClimatologyYearCurve(36.1, -5.3);
        expect(curve).toHaveLength(DAYS);
    });
});

// The grid reader derives its tile range from bounds.west/east. A viewport straddling the
// antimeridian has a west that is numerically greater than its east (or an unwrapped east past
// +180), which naive min..max loop bounds turn into an empty range — loading no tiles at all and
// silently rendering the whole overlay as "no data".
describe('grid reader across the antimeridian', () => {
    it('still returns values for a viewport straddling +/-180', async () => {
        const points = [
            { lat: 5, lon: 179.5 },
            { lat: 5, lon: -179.5 },
        ];
        const straddling = { west: 179.0, east: -179.0, south: 4.5, north: 5.5 };

        const values = await getClimatologyGridFromTiles(points, straddling, DATE);

        expect(values).toHaveLength(2);
        for (const v of values) expect(v).not.toBeNull();
    });

    it('matches the single-point reader across that seam', async () => {
        const points = [
            { lat: 5, lon: 179.5 },
            { lat: 5, lon: -179.5 },
        ];
        const straddling = { west: 179.0, east: -179.0, south: 4.5, north: 5.5 };

        const values = await getClimatologyGridFromTiles(points, straddling, DATE);
        for (let i = 0; i < points.length; i++) {
            const point = points[i]!; // loop is bounded by points.length
            const single = await getClimatologyFromTiles(point.lat, point.lon, DATE);
            expect(values[i]!).toBeCloseTo(single!, 9);
        }
    });

    it('still resolves points when the viewport is wider than the whole world', async () => {
        // Zoomed far out, MapLibre reports a span past 360deg; west and east then land on the
        // same tile column, which the wrap arithmetic alone would read as a 1-column viewport.
        const points = [
            { lat: 5, lon: -170 },
            { lat: 5, lon: 0 },
            { lat: 5, lon: 170 },
        ];
        const whole = { west: -200, east: 200, south: 0, north: 10 };

        const values = await getClimatologyGridFromTiles(points, whole, DATE);
        for (let i = 0; i < points.length; i++) {
            const point = points[i]!; // loop is bounded by points.length
            const single = await getClimatologyFromTiles(point.lat, point.lon, DATE);
            expect(values[i]).not.toBeNull();
            expect(values[i]!).toBeCloseTo(single!, 9);
        }
    });

    it('handles an unwrapped viewport (east past +180) the same way', async () => {
        // MapLibre reports a westward-panned viewport as e.g. west=179, east=181 rather than
        // wrapping east back to -179.
        const points = [{ lat: 5, lon: 179.5 }];
        const unwrapped = { west: 179.0, east: 181.0, south: 4.5, north: 5.5 };

        const [value] = await getClimatologyGridFromTiles(points, unwrapped, DATE);
        const single = await getClimatologyFromTiles(5, 179.5, DATE);

        expect(value).not.toBeNull();
        expect(value!).toBeCloseTo(single!, 9);
    });
});
