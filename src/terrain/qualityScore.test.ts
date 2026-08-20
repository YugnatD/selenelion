import { describe, expect, it } from 'vitest';
import { combineQualityScore } from './qualityScore';

// Regression coverage for the Focus-mode scoring bug found this session: a cell with no
// centrality of its own was being scored as a low-but-visible "Faible" band instead of being
// excluded, for eclipses that DO have a real central phase elsewhere — misleading for a view
// specifically about "where should I stand for totality".
describe('combineQualityScore', () => {
    const baseInputs = {
        visibleFraction: 1,
        magnitude: 1,
        centralDurationSeconds: 200,
        cloudCoverPercent: 0,
        maxCentralDurationSeconds: 300,
        maxMagnitude: 1.05,
    };

    it('excludes (null) a cell with no centrality when the eclipse has a real central phase elsewhere', () => {
        expect(combineQualityScore({ ...baseInputs, centralDurationSeconds: null })).toBeNull();
        expect(combineQualityScore({ ...baseInputs, centralDurationSeconds: 0 })).toBeNull();
    });

    it('scores a cell with real centrality as the product of visibility, clarity and duration factor', () => {
        const score = combineQualityScore({
            visibleFraction: 0.8,
            magnitude: 1,
            centralDurationSeconds: 150,
            cloudCoverPercent: 20,
            maxCentralDurationSeconds: 300,
            maxMagnitude: 1.05,
        });
        // clarity = 1 - 20/100 = 0.8; durationFactor = 150/300 = 0.5
        expect(score).toBeCloseTo(0.8 * 0.8 * 0.5, 6);
    });

    it('falls back to magnitude-based duration for a purely partial eclipse (no central phase anywhere)', () => {
        const score = combineQualityScore({
            visibleFraction: 1,
            magnitude: 0.7,
            centralDurationSeconds: null,
            cloudCoverPercent: 0,
            maxCentralDurationSeconds: 0,
            maxMagnitude: 1.0,
        });
        expect(score).toBeCloseTo(0.7, 6);
    });

    it('propagates null for any missing required input, regardless of eclipse type', () => {
        expect(combineQualityScore({ ...baseInputs, visibleFraction: null })).toBeNull();
        expect(combineQualityScore({ ...baseInputs, magnitude: null })).toBeNull();
        expect(combineQualityScore({ ...baseInputs, cloudCoverPercent: null })).toBeNull();
    });

    it('clamps an out-of-range cloud cover percentage rather than producing a negative/over-1 score', () => {
        const overcast = combineQualityScore({ ...baseInputs, cloudCoverPercent: 150 });
        const clear = combineQualityScore({ ...baseInputs, cloudCoverPercent: -10 });
        expect(overcast).toBe(0); // clarity clamped to 0
        expect(clear).toBeCloseTo(1 * 1 * (200 / 300), 6); // clarity clamped to 1
    });

    it('never exceeds 1 even if a duration/magnitude input exceeds its own max (bad upstream data)', () => {
        const score = combineQualityScore({ ...baseInputs, centralDurationSeconds: 999 });
        expect(score).toBeLessThanOrEqual(1);
    });
});

describe('combineQualityScore with includeDuration: false', () => {
    const central = {
        visibleFraction: 0.8,
        magnitude: 1,
        centralDurationSeconds: 150,
        cloudCoverPercent: 20,
        maxCentralDurationSeconds: 300,
        maxMagnitude: 1.05,
    };

    it('drops the duration factor, leaving relief × météo', () => {
        expect(combineQualityScore({ ...central, includeDuration: false })).toBeCloseTo(0.8 * 0.8, 6);
    });

    it('makes two spots with different centrality durations score identically', () => {
        const short = combineQualityScore({ ...central, centralDurationSeconds: 20, includeDuration: false });
        const long = combineQualityScore({ ...central, centralDurationSeconds: 295, includeDuration: false });
        expect(short).toBeCloseTo(long!, 6);
    });

    it('still excludes cells with no centrality when the eclipse has a central phase elsewhere', () => {
        // Turning duration off changes the weighting, not the scope: this view is still about
        // the totality zone, so a partial-only cell stays excluded rather than becoming scoreable.
        expect(combineQualityScore({ ...central, centralDurationSeconds: 0, includeDuration: false })).toBeNull();
        expect(combineQualityScore({ ...central, centralDurationSeconds: null, includeDuration: false })).toBeNull();
    });

    it('drops the magnitude weighting for a purely partial eclipse', () => {
        const inputs = {
            visibleFraction: 1,
            magnitude: 0.5,
            centralDurationSeconds: null,
            cloudCoverPercent: 0,
            maxCentralDurationSeconds: 0,
            maxMagnitude: 1,
        };
        expect(combineQualityScore({ ...inputs, includeDuration: true })).toBeCloseTo(0.5, 6);
        expect(combineQualityScore({ ...inputs, includeDuration: false })).toBeCloseTo(1, 6);
    });

    it('defaults to including duration when the flag is omitted', () => {
        expect(combineQualityScore(central)).toBeCloseTo(combineQualityScore({ ...central, includeDuration: true })!, 9);
    });

    it('still returns null for missing inputs', () => {
        expect(combineQualityScore({ ...central, cloudCoverPercent: null, includeDuration: false })).toBeNull();
        expect(combineQualityScore({ ...central, visibleFraction: null, includeDuration: false })).toBeNull();
    });
});
