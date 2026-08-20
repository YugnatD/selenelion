import { describe, expect, it, vi } from 'vitest';

// Counts real getLocalEclipse calls (the dominant per-cell cost, ~94% of it) without faking its
// results, so these tests check the interpolation's *effect* — far fewer astronomy calls — while
// still exercising the genuine astronomy underneath.
const astro = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../engine/localCircumstances', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../engine/localCircumstances')>();
    return {
        ...actual,
        getLocalEclipse: (...args: Parameters<typeof actual.getLocalEclipse>) => {
            astro.calls++;
            return actual.getLocalEclipse(...args);
        },
    };
});

// Deterministic synthetic terrain: a broad ridge, so visibleFraction actually varies instead of
// being trivially 1 everywhere.
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
            result[i] = 200 + 900 * Math.max(0, Math.sin(lat * 0.7) * Math.cos(lon * 0.5));
        }
        return result;
    }),
}));

const { computeObstructionGrid } = await import('./obstructionGrid');
const { loadEclipse } = await import('../engine/eclipse');

/** Well inside the 2027-08-02 penumbra over North Africa. */
const BOUNDS = { west: 0, east: 12, south: 20, north: 32 };
const COLS = 40;
const ROWS = 30;

describe('computeObstructionGrid — astronomy sub-grid interpolation', () => {
    it('resolves the grid with far fewer astronomy calls than cells', async () => {
        const eclipse = await loadEclipse('2027-08-02');
        astro.calls = 0;

        const grid = await computeObstructionGrid(eclipse, BOUNDS, COLS, ROWS);

        expect(grid.cells).toHaveLength(COLS * ROWS);
        // Per-cell astronomy would be one call per cell (1200). The sub-grid plus whatever
        // discontinuity fallbacks the penumbra/umbra edges force must come in far below that.
        expect(astro.calls).toBeLessThan((COLS * ROWS) / 4);
    });

    it('produces valid visibleFraction values everywhere it reports one', async () => {
        const eclipse = await loadEclipse('2027-08-02');
        const grid = await computeObstructionGrid(eclipse, BOUNDS, COLS, ROWS);

        let scored = 0;
        for (const cell of grid.cells) {
            if (cell.visibleFraction === null) continue;
            scored++;
            expect(Number.isFinite(cell.visibleFraction)).toBe(true);
            expect(cell.visibleFraction).toBeGreaterThanOrEqual(0);
            expect(cell.visibleFraction).toBeLessThanOrEqual(1);
            expect(Number.isFinite(cell.magnitude!)).toBe(true);
            expect(cell.magnitude!).toBeGreaterThan(0);
            expect(Number.isFinite(cell.centralDurationSeconds!)).toBe(true);
            expect(cell.centralDurationSeconds!).toBeGreaterThanOrEqual(0);
        }
        expect(scored).toBeGreaterThan(0);
    });

    it('keeps interpolated values close to the exact per-cell astronomy', async () => {
        const eclipse = await loadEclipse('2027-08-02');
        const { getLocalEclipse, summarizeLocal } = await import('../engine/localCircumstances');
        const grid = await computeObstructionGrid(eclipse, BOUNDS, COLS, ROWS);

        // Spot-check magnitude (a smooth, interpolated quantity) against the real value at the
        // same coordinate — this is what would drift if the interpolation were wrong.
        let checked = 0;
        let maxDelta = 0;
        for (let i = 0; i < grid.cells.length; i += 37) {
            const cell = grid.cells[i]!; // i < grid.cells.length by the loop bound
            if (cell.magnitude === null) continue;
            const exact = summarizeLocal(getLocalEclipse(eclipse, cell.lat, cell.lon)).maxMagnitude;
            maxDelta = Math.max(maxDelta, Math.abs(exact - cell.magnitude));
            checked++;
        }
        expect(checked).toBeGreaterThan(5);
        // Magnitude runs 0..~1.03 across the whole path; anything at the third decimal is far
        // below the accuracy the terrain data itself supports.
        expect(maxDelta).toBeLessThan(0.005);
    });

    it('keeps the penumbra edge sharp rather than smearing it into a gradient', async () => {
        const eclipse = await loadEclipse('2027-08-02');
        // A viewport straddling the northern penumbra edge, where naive interpolation across the
        // "no eclipse" boundary would invent faint eclipse values outside the real limit.
        const edgeBounds = { west: -10, east: 20, south: 55, north: 85 };
        const grid = await computeObstructionGrid(eclipse, edgeBounds, 30, 30);

        const withEclipse = grid.cells.filter((c) => c.visibleFraction !== null);
        const withoutEclipse = grid.cells.filter((c) => c.visibleFraction === null);
        // Both sides of the edge must be represented — otherwise this test proves nothing.
        expect(withEclipse.length).toBeGreaterThan(0);
        expect(withoutEclipse.length).toBeGreaterThan(0);
        // Every cell that does report an eclipse must report a real magnitude, not a blended
        // fraction of one leaking across the boundary.
        for (const cell of withEclipse) expect(cell.magnitude!).toBeGreaterThan(0);
    });
});
