import { describe, expect, it, vi } from 'vitest';

// A synthetic elevation model standing in for the real AWS Terrarium tiles: flat (0m) sea level
// everywhere, except a 300m "cliff" occupying the ring 200-600m due north of the origin — i.e.
// exactly the shape of the real bug this regression-tests: an observer standing right at the
// base of steep terrain a few hundred meters away. `getElevationsBatch` is the only thing
// horizon.ts imports from elevationTiles.ts, so mocking that one function is enough to drive
// computeHorizonProfile through this scenario without any real network/tile access.
const METERS_PER_DEGREE = 111_320;
function syntheticElevation(lat: number, lon: number): number {
    const northMeters = lat * METERS_PER_DEGREE;
    const eastMeters = lon * METERS_PER_DEGREE * Math.cos((lat * Math.PI) / 180);
    const isCliff = northMeters >= 200 && northMeters <= 600 && Math.abs(eastMeters) < 50;
    return isCliff ? 300 : 0;
}
vi.mock('./elevationTiles', () => ({
    // The profile resolves the observer's own ground height separately from the ray samples (at
    // the finest band's zoom), so both entry points have to be mocked.
    getElevation: vi.fn(async (lat: number, lon: number) => syntheticElevation(lat, lon)),
    getElevationsBatch: vi.fn(async (points: Array<{ lat: number; lon: number }>) =>
        new Float32Array(points.map(({ lat, lon }) => syntheticElevation(lat, lon))),
    ),
}));

const { apparentAltitudeDeg, computeHorizonProfile, destinationPoint, horizonAltitudeAt } = await import('./horizon');

describe('apparentAltitudeDeg', () => {
    it('is 90deg looking straight down at distance 0', () => {
        expect(apparentAltitudeDeg(0, 0, 0)).toBe(90);
    });

    it('is ~0deg for a target at the same elevation as the observer, at any real distance', () => {
        // Not exactly 0: Earth's curvature drops the true horizon slightly below flat, even
        // between two points at the same elevation.
        expect(apparentAltitudeDeg(100, 100, 5000)).toBeGreaterThan(-0.5);
        expect(apparentAltitudeDeg(100, 100, 5000)).toBeLessThan(0);
    });

    it('is positive when the target is higher than the observer', () => {
        expect(apparentAltitudeDeg(0, 100, 1000)).toBeGreaterThan(0);
    });
});

describe('destinationPoint', () => {
    it('moving due north increases latitude and leaves longitude ~unchanged', () => {
        const p = destinationPoint(0, 0, 0, 1000);
        expect(p.lat).toBeGreaterThan(0);
        expect(p.lon).toBeCloseTo(0, 3);
    });

    it('moving due east increases longitude and leaves latitude ~unchanged', () => {
        const p = destinationPoint(0, 0, 90, 1000);
        expect(p.lon).toBeGreaterThan(0);
        expect(p.lat).toBeCloseTo(0, 3);
    });
});

describe('computeHorizonProfile — near-field obstruction (Gibraltar regression)', () => {
    it('detects a steep obstruction only a few hundred meters away', async () => {
        const profile = await computeHorizonProfile(0, 0);
        const towardCliff = horizonAltitudeAt(profile, 0); // due north, toward the mocked cliff
        expect(towardCliff).toBeGreaterThan(20);
    });

    it('reads flat in directions away from the obstruction', async () => {
        const profile = await computeHorizonProfile(0, 0);
        const east = horizonAltitudeAt(profile, 90);
        const south = horizonAltitudeAt(profile, 180);
        const west = horizonAltitudeAt(profile, 270);
        for (const altitude of [east, south, west]) {
            expect(altitude).toBeLessThan(5);
        }
    });
});

describe('horizonAltitudeAt', () => {
    it('interpolates linearly between the two nearest sampled azimuths', () => {
        // horizonAltitudeAt derives its step from profile.length (360/length), so the test
        // profile must be full-size (matching computeHorizonProfile's real AZIMUTH_STEP_DEG=5)
        // rather than a toy 2-entry array, or the derived step wouldn't be 5deg.
        const profile = Array.from({ length: 72 }, (_, i) => ({ azimuth: i * 5, altitude: 0 }));
        // Fixed 72-entry literal above, so indices 0 and 1 are always in range.
        profile[0]!.altitude = 0;
        profile[1]!.altitude = 10; // azimuth 5
        expect(horizonAltitudeAt(profile, 2.5)).toBeCloseTo(5, 6);
    });

    it('returns 0 for an empty profile instead of indexing out of bounds', () => {
        expect(horizonAltitudeAt([], 42)).toBe(0);
    });

    it('wraps around the 360/0 boundary', () => {
        // horizonAltitudeAt's index math assumes a full 0..355-by-5deg sweep (matching
        // computeHorizonProfile's own AZIMUTH_STEP_DEG=5), so the wrap case needs a
        // full-size profile, not a toy 2-entry one, to exercise the same modular indexing
        // real callers hit.
        const profile = Array.from({ length: 72 }, (_, i) => ({ azimuth: i * 5, altitude: 0 }));
        // Fixed 72-entry literal above, so indices 71 and 0 are always in range.
        profile[71]!.altitude = 10; // azimuth 355
        profile[0]!.altitude = 20; // azimuth 0
        // Azimuth 358 sits 60% of the way from 355 to 0 (360).
        expect(horizonAltitudeAt(profile, 358)).toBeCloseTo(10 * 0.4 + 20 * 0.6, 6);
    });
});
