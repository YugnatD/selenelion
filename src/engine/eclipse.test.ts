import { describe, expect, it } from 'vitest';
import { getBesselianElementsForDate, listAllEclipseDates } from './catalogue';
import { getPathGeoJSON, loadEclipse, summarizeEclipse } from './eclipse';
import { getLocalEclipse, getSunPositionAt, summarizeLocal } from './localCircumstances';

// Reference values checked against published NASA eclipse circumstances (the five-millennium
// canon), the same honest practice used in lunarEclipse.test.ts — not against the library's own
// README, which documents the raw (l1-distance)/(l1+l2) partial-phase magnitude rather than the
// standard reported magnitude at a central (total/annular) location.
describe('eclipse engine (astronomy-bundle wrapper)', () => {
    it('matches documented global circumstances for the 2019-07-02 total eclipse', async () => {
        const eclipse = await loadEclipse('2019-07-02');
        const summary = summarizeEclipse('2019-07-02', eclipse);

        expect(summary.type).toBe('total');
        expect(summary.saros).toBe(127);
        expect(summary.greatestEclipse.lat).toBeCloseTo(-17.388965, 3);
        expect(summary.greatestEclipse.lon).toBeCloseTo(-108.998853, 3);
        // NASA canon magnitude for greatest eclipse (a central point): the Moon/Sun diameter ratio,
        // not the partial-phase (l1-distance)/(l1+l2) formula.
        expect(summary.magnitude).toBeCloseTo(1.0459, 4);
    });

    it('produces a renderable path (central line + umbra polygon) for a total eclipse', async () => {
        const eclipse = await loadEclipse('2019-07-02');
        const path = getPathGeoJSON(eclipse, { stepsInSeconds: 30 });

        expect(path.centralLine?.geometry.coordinates.length).toBeGreaterThan(10);
        // Polygon coordinates are an array-of-rings; noUncheckedIndexedAccess makes ring[0]
        // `Position[] | undefined`, but a non-null Polygon feature always has at least one ring.
        expect(path.umbraPolygon?.geometry.coordinates[0]!.length).toBeGreaterThan(10);
        expect(path.penumbraPolygon?.geometry.coordinates[0]!.length).toBeGreaterThan(10);
    });

    it('matches documented local circumstances for the 2016-09-01 annular eclipse on Réunion', async () => {
        const eclipse = await loadEclipse('2016-09-01');
        const local = getLocalEclipse(eclipse, -21.32947, 55.45174, 43);
        const summary = summarizeLocal(local);

        expect(summary.type).toBe('annular');
        // Local magnitude at an annular location is the Moon/Sun diameter ratio there, slightly
        // below the eclipse's greatest-eclipse magnitude since Réunion sits a little off the
        // central line.
        expect(summary.maxMagnitude).toBeCloseTo(0.9704, 3);
        expect(summary.contactTimes?.max.toISOString().slice(11, 19)).toBe('10:09:58');
    });

    it('matches documented sun position during totality for Jeddah on 2027-08-02', async () => {
        const eclipse = await loadEclipse('2027-08-02');
        const local = getLocalEclipse(eclipse, 21.52854, 39.14387, 6);
        const position = getSunPositionAt(local, new Date('2027-08-02T10:23:13Z'));

        expect(position.eclipseType).toBe('total');
        expect(position.azimuth).toBeCloseTo(255.664319, 1);
    });

    it('unwraps the central line across the antimeridian instead of jumping ~360° (2028-07-22)', async () => {
        const eclipse = await loadEclipse('2028-07-22');
        const path = getPathGeoJSON(eclipse);
        const coords = path.centralLine?.geometry.coordinates ?? [];

        expect(coords.length).toBeGreaterThan(10);
        for (let i = 1; i < coords.length; i++) {
            // i and i - 1 are within [0, coords.length) by the loop bound above, and every
            // coordinate here is a [lon, lat] pair by construction (toRing pushes 2-tuples).
            const curr = coords[i]!;
            const prev = coords[i - 1]!;
            expect(Math.abs(curr[0]! - prev[0]!)).toBeLessThan(180);
        }
    });

    it('resolves Besselian elements for a date outside the standard 1900-2100 catalogue', async () => {
        const dates = await listAllEclipseDates('1650-01-01', '1650-12-31');
        expect(dates.length).toBeGreaterThan(0);

        // dates is non-empty per the assertion above (which throws otherwise), so index 0 exists.
        const elements = await getBesselianElementsForDate(dates[0]!);
        expect(elements).toBeTruthy();
    });
});
