import { describe, expect, it, vi } from 'vitest';

// Same regression as horizon.test.ts, for the map-grid version of ray-casting (Obstruction map,
// Focus map, best-points-along-path search) — a separate distances array (RAY_DISTANCES_M) that
// had the identical bug (started too far out to see nearby terrain) and needs its own coverage
// since nothing shares the constant between the two modules.
//
// The mock is an omnidirectional "crater rim" around a fixed reference point: elevated in every
// direction between 200-600m away, flat beyond that — guaranteed to sit under the sun's
// direction at some point during the eclipse regardless of which way the sun happens to swing,
// unlike a one-sided obstruction that could miss depending on geometry. getElevationsBatch only
// ever sees absolute lat/lon points, so the mock keys off this fixed coordinate rather than
// trying to infer "the cell being evaluated" from the batch itself.
const REFERENCE_POINT = { lat: -17.388965, lon: -108.998853 }; // a real eclipse's greatest-eclipse point (see eclipse.test.ts)
const METERS_PER_DEGREE = 111_320;
const RIM_HEIGHT_M = 400;

vi.mock('./elevationTiles', () => ({
    // Real Mercator projection (not a further mock) — obstructionGrid.ts's own tile-count
    // budgeting (nearFieldZoom/farFieldZoom) needs the real thing to make real decisions, and
    // this test doesn't care what zoom ends up being used, only what elevation values come back.
    latToTileY: (lat: number, zoom: number) => {
        const latRad = (lat * Math.PI) / 180;
        return ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * 2 ** zoom;
    },
    getElevationsBatchFlat: vi.fn(async (coords: Float64Array) => {
        const n = coords.length / 2;
        const result = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            // i < n === coords.length / 2, so both indices are always in bounds.
            const lat = coords[i * 2]!;
            const lon = coords[i * 2 + 1]!;
            const dNorth = (lat - REFERENCE_POINT.lat) * METERS_PER_DEGREE;
            const dEast = (lon - REFERENCE_POINT.lon) * METERS_PER_DEGREE * Math.cos((lat * Math.PI) / 180);
            const distance = Math.hypot(dNorth, dEast);
            result[i] = distance >= 200 && distance <= 600 ? RIM_HEIGHT_M : 0;
        }
        return result;
    }),
}));

const { computeObstructionGrid } = await import('./obstructionGrid');
const { loadEclipse } = await import('../engine/eclipse');

describe('computeObstructionGrid — near-field obstruction (Gibraltar-class regression)', () => {
    it('reduces visible fraction when steep terrain sits just outside the old 800m-minimum sample range', async () => {
        const eclipse = await loadEclipse('2019-07-02');
        // A tiny bounding box centered exactly on REFERENCE_POINT, with a 1x1 grid, makes the
        // single cell's center land exactly there (see computeObstructionGrid's cell-center
        // formula: west + 0.5*(east-west), north - 0.5*(north-south)).
        const bounds = {
            west: REFERENCE_POINT.lon - 0.001,
            east: REFERENCE_POINT.lon + 0.001,
            south: REFERENCE_POINT.lat - 0.001,
            north: REFERENCE_POINT.lat + 0.001,
        };

        const grid = await computeObstructionGrid(eclipse, bounds, 1, 1);
        expect(grid.cells).toHaveLength(1);
        const cell = grid.cells[0]!; // just asserted length 1 above

        expect(cell.visibleFraction).not.toBeNull();
        // Full sun-above-flat-horizon visibility (magnitude/centrality present) but the ring
        // should still knock at least some samples below the horizon during the eclipse's less
        // steep-sun moments (near first/last contact) — a value at or above ~0.99 would mean the
        // ring was invisible to the ray-casting, i.e. the bug is back.
        expect(cell.visibleFraction!).toBeLessThan(0.99);
    });
});
