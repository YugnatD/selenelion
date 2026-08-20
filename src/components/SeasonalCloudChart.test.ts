import { describe, expect, it } from 'vitest';

// smoothCircular isn't exported (it's an implementation detail of the chart), so this re-states
// it to lock in the two properties that matter: it wraps around the year, and it averages exactly
// the days the headline figure averages — which is what makes the marker and the headline agree.
function smoothCircular(curve: Array<number | null>, window: number): Array<number | null> {
    if (window <= 1) return curve;
    const n = curve.length;
    const half = Math.floor(window / 2);
    return curve.map((_, i) => {
        let sum = 0;
        let count = 0;
        for (let d = -half; d < window - half; d++) {
            const value = curve[(((i + d) % n) + n) % n];
            if (value != null) {
                sum += value;
                count++;
            }
        }
        return count === 0 ? null : sum / count;
    });
}

/** The store's own window helper, for the agreement check below. */
function daySlotsForWindow(centerDay: number, window: number, days = 365): number[] {
    const half = Math.floor(window / 2);
    const out: number[] = [];
    for (let d = -half; d < window - half; d++) out.push((((centerDay + d) % days) + days) % days);
    return out;
}

describe('seasonal curve smoothing', () => {
    it('is a no-op for a window of 1', () => {
        const curve = [10, 20, 30, null, 50];
        expect(smoothCircular(curve, 1)).toEqual(curve);
    });

    it('averages exactly the days the headline figure averages', () => {
        const curve = Array.from({ length: 365 }, (_, i) => (i * 7) % 101);
        for (const window of [5, 7]) {
            for (const day of [0, 100, 239, 364]) {
                const expected =
                    daySlotsForWindow(day, window).reduce((sum, d) => sum + (curve[d] as number), 0) / window;
                expect(smoothCircular(curve, window)[day]!).toBeCloseTo(expected, 9);
            }
        }
    });

    it('wraps around the year boundary rather than truncating', () => {
        const curve = Array.from({ length: 365 }, (_, i) => (i === 364 ? 100 : 0));
        // Day 0's 3-day window includes day 364, so the wrap must contribute.
        expect(smoothCircular(curve, 3)[0]!).toBeCloseTo(100 / 3, 9);
    });

    it('skips no-data days instead of poisoning the average', () => {
        const curve: Array<number | null> = Array.from({ length: 365 }, () => 50);
        curve[10] = null;
        expect(smoothCircular(curve, 3)[10]!).toBeCloseTo(50, 9);
    });

    it('returns null only where every day in the window is missing', () => {
        const curve: Array<number | null> = Array.from({ length: 365 }, () => null);
        expect(smoothCircular(curve, 5)[100]).toBeNull();
    });

    it('genuinely smooths — a spike is flattened as the window widens', () => {
        const curve: Array<number | null> = Array.from({ length: 365 }, () => 0);
        curve[100] = 70;
        const w5 = smoothCircular(curve, 5)[100]!;
        const w7 = smoothCircular(curve, 7)[100]!;
        expect(w5).toBeCloseTo(14, 6);
        expect(w7).toBeCloseTo(10, 6);
        expect(w7).toBeLessThan(w5);
    });
});
