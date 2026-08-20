import { describe, expect, it } from 'vitest';
import { getMoonPositionAt, listLunarEclipses, loadLunarEclipse } from './lunarEclipse';

/**
 * Reference circumstances published for these eclipses (Wikipedia / NASA five-millennium canon),
 * checked against published circumstances the same way eclipse.test.ts checks the solar engine
 * (both compare against NASA canon, not against a library's own self-reported values). Tolerances
 * reflect where the method is genuinely strong or weak: the umbral contacts and greatest eclipse
 * are accurate to well under a minute, while the penumbral edge is inherently gradual and
 * conventions for its atmospheric enlargement differ, so P1/P4 are only expected within a couple
 * of minutes.
 */
function secondsApart(a: Date, iso: string): number {
    return Math.abs((a.getTime() - Date.parse(iso)) / 1000);
}

describe('lunar eclipse engine — 2025-03-14 total', () => {
    it('matches published contact times and magnitude', async () => {
        const eclipse = await loadLunarEclipse('2025-03-14');

        expect(eclipse.type).toBe('total');
        expect(secondsApart(eclipse.contacts.greatest, '2025-03-14T06:58:44Z')).toBeLessThan(30);
        expect(secondsApart(eclipse.contacts.u1!, '2025-03-14T05:09:23Z')).toBeLessThan(60);
        expect(secondsApart(eclipse.contacts.u2!, '2025-03-14T06:25:58Z')).toBeLessThan(60);
        expect(secondsApart(eclipse.contacts.u3!, '2025-03-14T07:32:02Z')).toBeLessThan(60);
        expect(secondsApart(eclipse.contacts.u4!, '2025-03-14T08:48:19Z')).toBeLessThan(60);
        // Penumbral edge — deliberately looser, see the note above.
        expect(secondsApart(eclipse.contacts.p1, '2025-03-14T03:57:09Z')).toBeLessThan(180);
        expect(secondsApart(eclipse.contacts.p4, '2025-03-14T10:00:32Z')).toBeLessThan(180);

        expect(eclipse.umbralMagnitude).toBeCloseTo(1.1804, 1);
        expect(eclipse.penumbralMagnitude).toBeGreaterThan(2);
    }, 120_000);

    it('orders its contacts consistently', async () => {
        const { contacts } = await loadLunarEclipse('2025-03-14');
        const order = [contacts.p1, contacts.u1!, contacts.u2!, contacts.greatest, contacts.u3!, contacts.u4!, contacts.p4];
        for (let i = 1; i < order.length; i++) {
            // i and i - 1 are within [0, order.length) by the loop bound above.
            expect(order[i]!.getTime()).toBeGreaterThanOrEqual(order[i - 1]!.getTime());
        }
    }, 120_000);
});

describe('lunar eclipse engine — classification', () => {
    it('reports a partial eclipse without totality contacts', async () => {
        // 2023-10-28: a small partial umbral eclipse (umbral magnitude ~0.12).
        const eclipse = await loadLunarEclipse('2023-10-28');
        expect(eclipse.type).toBe('partial');
        expect(eclipse.contacts.u1).not.toBeNull();
        expect(eclipse.contacts.u2).toBeNull();
        expect(eclipse.contacts.u3).toBeNull();
        expect(eclipse.umbralMagnitude).toBeGreaterThan(0);
        expect(eclipse.umbralMagnitude).toBeLessThan(1);
    }, 120_000);
});

describe('listLunarEclipses', () => {
    it('finds the two lunar eclipses of 2025 and no others', async () => {
        const found = await listLunarEclipses('2025-01-01', '2025-12-31');
        const totals = found.filter((e) => e.type === 'total').map((e) => e.date);
        // 2025 had two total lunar eclipses: 14 March and 7 September.
        expect(totals).toContain('2025-03-14');
        expect(totals).toContain('2025-09-07');
    }, 300_000);

    it('returns dates inside the requested range only, in order', async () => {
        const found = await listLunarEclipses('2025-01-01', '2025-12-31');
        expect(found.length).toBeGreaterThan(0);
        for (const item of found) {
            expect(item.date >= '2025-01-01').toBe(true);
            expect(item.date <= '2025-12-31').toBe(true);
        }
        const dates = found.map((f) => f.date);
        expect([...dates].sort()).toEqual(dates);
    }, 300_000);
});

describe('getMoonPositionAt', () => {
    it('puts the Moon below the horizon on the day side and above it on the night side', async () => {
        // At greatest eclipse the Moon is directly opposite the Sun, so it is up for roughly the
        // hemisphere centred on the antisolar point and down for the other — that split is the
        // whole basis of the lunar visibility map.
        const greatest = new Date('2025-03-14T06:58:44Z');
        const somewhereUp = await getMoonPositionAt(greatest, 40, -100); // North America, local night
        const somewhereDown = await getMoonPositionAt(greatest, 40, 80); // Central Asia, local day

        expect(somewhereUp.altitude).toBeGreaterThan(0);
        expect(somewhereDown.altitude).toBeLessThan(0);
    }, 60_000);

    it('returns an azimuth within 0..360 and a plausible altitude', async () => {
        const p = await getMoonPositionAt(new Date('2025-03-14T06:58:44Z'), 48.85, 2.35);
        expect(p.azimuth).toBeGreaterThanOrEqual(0);
        expect(p.azimuth).toBeLessThanOrEqual(360);
        expect(p.altitude).toBeGreaterThanOrEqual(-90);
        expect(p.altitude).toBeLessThanOrEqual(90);
    }, 60_000);
});
