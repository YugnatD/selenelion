import { describe, expect, it } from 'vitest';
import { loadEclipse } from '../engine/eclipse';
import { getLocalEclipse } from '../engine/localCircumstances';
import type { HorizonPoint } from './horizon';
import { computeEclipseVisibility } from './visibility';

/** A horizon profile that blocks nothing (everything sits below it) resp. everything. */
const FLAT_HORIZON: HorizonPoint[] = Array.from({ length: 72 }, (_, i) => ({ azimuth: i * 5, altitude: -90 }));
const WALLED_HORIZON: HorizonPoint[] = Array.from({ length: 72 }, (_, i) => ({ azimuth: i * 5, altitude: 90 }));

// The real point from the Gibraltar report, whose panel showed "140m 30s / 140m 03s" — i.e. more
// visible time than the eclipse itself lasts. Samples across [c1, c4] are fenceposts, not slices,
// so crediting each one a full SAMPLE_STEP_SECONDS overcounted by up to one step.
const LAT = 36.1238;
const LON = -5.34819;
const ELEVATION = 91;

describe('computeEclipseVisibility — duration accounting', () => {
    it('never reports more visible time than the eclipse actually lasts', async () => {
        const eclipse = await loadEclipse('2027-08-02');
        const local = getLocalEclipse(eclipse, LAT, LON, ELEVATION);
        const result = computeEclipseVisibility(local, FLAT_HORIZON)!;

        expect(result.visibleDurationSeconds).toBeLessThanOrEqual(result.theoreticalDurationSeconds);
    });

    it('reports exactly the full duration when nothing blocks the horizon', async () => {
        const eclipse = await loadEclipse('2027-08-02');
        const local = getLocalEclipse(eclipse, LAT, LON, ELEVATION);
        const result = computeEclipseVisibility(local, FLAT_HORIZON)!;

        expect(result.visibleDurationSeconds).toBeCloseTo(result.theoreticalDurationSeconds, 6);
        expect(result.visibleDurationSeconds / result.theoreticalDurationSeconds).toBeCloseTo(1, 6);
    });

    it('reports zero visible time when terrain blocks every direction', async () => {
        const eclipse = await loadEclipse('2027-08-02');
        const local = getLocalEclipse(eclipse, LAT, LON, ELEVATION);
        const result = computeEclipseVisibility(local, WALLED_HORIZON)!;

        expect(result.visibleDurationSeconds).toBe(0);
        expect(result.centralPhaseVisible).toBe(false);
    });

    it('keeps the visible fraction within 0..1 for a real, partially-obstructed horizon', async () => {
        const eclipse = await loadEclipse('2027-08-02');
        const local = getLocalEclipse(eclipse, LAT, LON, ELEVATION);
        // Blocks only the lower ~30deg, roughly like the Rock of Gibraltar to the east.
        const ridge: HorizonPoint[] = Array.from({ length: 72 }, (_, i) => ({
            azimuth: i * 5,
            altitude: i * 5 >= 60 && i * 5 <= 120 ? 30 : -90,
        }));
        const result = computeEclipseVisibility(local, ridge)!;

        const fraction = result.visibleDurationSeconds / result.theoreticalDurationSeconds;
        expect(fraction).toBeGreaterThanOrEqual(0);
        expect(fraction).toBeLessThanOrEqual(1);
        // The ridge really does block part of this eclipse here — otherwise this test would pass
        // vacuously against a profile that happens to obstruct nothing.
        expect(fraction).toBeLessThan(1);
    });

    it('returns null when the location has no contact times at all', async () => {
        const eclipse = await loadEclipse('2027-08-02');
        // Far outside this eclipse's penumbra — getLocalEclipse resolves but finds no contacts.
        let local;
        try {
            local = getLocalEclipse(eclipse, -70, -170);
        } catch {
            return; // library threw instead, which is the other valid "no eclipse here" signal
        }
        expect(computeEclipseVisibility(local, FLAT_HORIZON)).toBeNull();
    });
});
