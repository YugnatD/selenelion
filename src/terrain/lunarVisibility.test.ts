import { describe, expect, it, vi } from 'vitest';

// Flat terrain: isolates the "is the Moon above the horizon" question from any relief effect.
vi.mock('./elevationTiles', () => ({
    getElevation: vi.fn(async () => 0),
    getElevationsBatch: vi.fn(async (p: Array<unknown>) => new Float32Array(p.length)),
}));

const { computeLunarVisibility } = await import('./lunarVisibility');
const { loadLunarEclipse } = await import('../engine/lunarEclipse');
// Flat *ground*, i.e. a horizon at 0deg — not -90. A -90 profile would mean "nothing blocks at
// all", under which even a Moon 30deg below the horizon counts as visible; that is fine for the
// solar tests (the Sun is above 0 whenever its eclipse is visible) but meaningless here, where
// the Moon being below the horizon is the normal case for half the planet.
const FLAT = Array.from({ length: 72 }, (_, i) => ({ azimuth: i * 5, altitude: 0 }));
const WALLED = Array.from({ length: 72 }, (_, i) => ({ azimuth: i * 5, altitude: 90 }));

describe('computeLunarVisibility', () => {
    it('reports the full eclipse visible where the Moon is up the whole time', async () => {
        const eclipse = await loadLunarEclipse('2025-03-14');
        // Near the sub-lunar point at greatest eclipse (~2N 75W), so the Moon is high throughout.
        const result = await computeLunarVisibility(eclipse, 2, -75, FLAT);
        expect(result.visibleDurationSeconds).toBeCloseTo(result.theoreticalDurationSeconds, 3);
        expect(result.centralPhaseVisible).toBe(true);
        expect(result.hasCentralPhase).toBe(true);
    }, 120_000);

    it('reports nothing visible from the day side, where the Moon is below the horizon', async () => {
        const eclipse = await loadLunarEclipse('2025-03-14');
        // Opposite side of the globe from the sub-lunar point: the Moon is far below the horizon.
        const result = await computeLunarVisibility(eclipse, -2, 105, FLAT);
        expect(result.visibleDurationSeconds).toBe(0);
        expect(result.centralPhaseVisible).toBe(false);
    }, 120_000);

    it('never reports more visible time than the eclipse lasts', async () => {
        const eclipse = await loadLunarEclipse('2025-03-14');
        for (const [lat, lon] of [[2, -75], [-2, 105], [-33, 18], [64, -21]] as Array<[number, number]>) {
            const r = await computeLunarVisibility(eclipse, lat, lon, FLAT);
            expect(r.visibleDurationSeconds).toBeLessThanOrEqual(r.theoreticalDurationSeconds + 1e-6);
            expect(r.visibleDurationSeconds).toBeGreaterThanOrEqual(0);
        }
    }, 200_000);

    it('lets terrain block an otherwise-visible Moon', async () => {
        const eclipse = await loadLunarEclipse('2025-03-14');
        const open = await computeLunarVisibility(eclipse, 2, -75, FLAT);
        const walled = await computeLunarVisibility(eclipse, 2, -75, WALLED);
        expect(open.visibleDurationSeconds).toBeGreaterThan(0);
        expect(walled.visibleDurationSeconds).toBe(0);
    }, 120_000);

    it('measures against the umbral window when there is one', async () => {
        const eclipse = await loadLunarEclipse('2025-03-14');
        const result = await computeLunarVisibility(eclipse, 2, -75, FLAT);
        const umbral = (eclipse.contacts.u4!.getTime() - eclipse.contacts.u1!.getTime()) / 1000;
        // The penumbral phase is invisible to the eye, so it is deliberately excluded.
        expect(result.theoreticalDurationSeconds).toBeCloseTo(umbral, 0);
    }, 120_000);
});
