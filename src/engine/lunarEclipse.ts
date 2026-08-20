import { EARTH_EQUATORIAL_RADIUS_KM, Location, MOON_RADIUS_KM, SUN_RADIUS_KM, TimeOfInterest } from '@astronomy-bundle/core';
import { Moon } from '@astronomy-bundle/moon';
import { Sun } from '@astronomy-bundle/sun';
import { t } from '../i18n';

/**
 * Lunar eclipse circumstances, derived from the bundle's own Sun/Moon ephemerides rather than
 * from a shipped catalogue (unlike the solar side, which needs Besselian elements — there is no
 * `@astronomy-bundle/lunar-eclipse` package). A lunar eclipse is simply the Moon crossing Earth's
 * shadow, so everything follows from one quantity: the angular separation between the Moon and the
 * antisolar point (the shadow axis), compared against the shadow's angular radius at the Moon's
 * distance.
 *
 * The crucial difference from a solar eclipse, which shapes the whole feature: **there is no
 * path**. Earth's shadow falls on the Moon, not on Earth, so every contact time below is a single
 * universal instant — identical for every observer on the planet. What varies by location is only
 * whether the Moon happens to be above your horizon (and above the terrain) at those instants.
 *
 * Validated against the published circumstances for the 2025-03-14 total eclipse: greatest eclipse
 * within 3s, umbral contacts (U1-U4) within 46s, umbral magnitude within 0.5%. The penumbral
 * contacts (P1/P4) land ~90s out, which is expected — the penumbral shadow edge is inherently
 * gradual and conventions for its enlargement differ; those phases are in any case invisible to
 * the naked eye.
 */

export type LunarEclipseType = 'penumbral' | 'partial' | 'total';

export interface LunarEclipseContacts {
    /** Penumbral phase begins/ends — always present for an eclipse. */
    p1: Date;
    p4: Date;
    /** Umbral (partial) phase — null for a purely penumbral eclipse. */
    u1: Date | null;
    u4: Date | null;
    /** Totality — null unless the eclipse is total. */
    u2: Date | null;
    u3: Date | null;
    greatest: Date;
}

export interface LunarEclipseSummary {
    /** UTC calendar date of greatest eclipse, `YYYY-MM-DD`. */
    date: string;
    type: LunarEclipseType;
    contacts: LunarEclipseContacts;
    /** Fraction of the Moon's diameter inside the umbra at greatest eclipse (>= 1 means total). */
    umbralMagnitude: number;
    penumbralMagnitude: number;
}

const DEG = Math.PI / 180;
/** Conventional Danjon enlargement of Earth's shadow, accounting for the atmosphere. */
const SHADOW_ENLARGEMENT = 1.02;
const SYNODIC_MONTH_MS = 29.530588853 * 86_400_000;
/** A reference full moon (2000-01-21 04:41 UTC), used to step lunation by lunation. */
const REFERENCE_FULL_MOON_MS = Date.UTC(2000, 0, 21, 4, 41);

interface ShadowGeometry {
    /** Moon centre to shadow axis, degrees. */
    separation: number;
    umbraRadius: number;
    penumbraRadius: number;
    /** The Moon's own angular semidiameter, degrees. */
    moonRadius: number;
}

function asinDeg(x: number): number {
    return Math.asin(Math.max(-1, Math.min(1, x))) / DEG;
}

function angularSeparationDeg(ra1: number, dec1: number, ra2: number, dec2: number): number {
    const a1 = ra1 * DEG;
    const d1 = dec1 * DEG;
    const a2 = ra2 * DEG;
    const d2 = dec2 * DEG;
    const cos = Math.sin(d1) * Math.sin(d2) + Math.cos(d1) * Math.cos(d2) * Math.cos(a1 - a2);
    return Math.acos(Math.max(-1, Math.min(1, cos))) / DEG;
}

async function shadowGeometryAt(date: Date): Promise<ShadowGeometry> {
    const toi = TimeOfInterest.fromDate(date);
    const [moon, sun] = await Promise.all([Moon.create(toi), Sun.create(toi)]);
    const [moonCoords, sunCoords, moonDistanceKm, sunDistanceKm] = await Promise.all([
        moon.getApparentGeocentricEquatorialSphericalCoordinates(),
        sun.getApparentGeocentricEquatorialSphericalCoordinates(),
        moon.getDistanceToEarth(),
        sun.getDistanceToEarth(),
    ]);

    // The shadow axis points exactly opposite the Sun as seen from Earth's centre.
    const shadowRightAscension = (sunCoords.rightAscension + 180) % 360;
    const shadowDeclination = -sunCoords.declination;

    const moonParallax = asinDeg(EARTH_EQUATORIAL_RADIUS_KM / moonDistanceKm);
    const sunParallax = asinDeg(EARTH_EQUATORIAL_RADIUS_KM / sunDistanceKm);
    const sunSemidiameter = asinDeg(SUN_RADIUS_KM / sunDistanceKm);

    return {
        separation: angularSeparationDeg(moonCoords.rightAscension, moonCoords.declination, shadowRightAscension, shadowDeclination),
        umbraRadius: SHADOW_ENLARGEMENT * (moonParallax + sunParallax - sunSemidiameter),
        penumbraRadius: SHADOW_ENLARGEMENT * (moonParallax + sunParallax + sunSemidiameter),
        moonRadius: asinDeg(MOON_RADIUS_KM / moonDistanceKm),
    };
}

function yieldToMain(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

const YIELD_EVERY = 4;

// Ternary search shrinks the interval by 1/3 per iteration (vs. bisection's 1/2), so over the
// ~17.7-day window this runs across it needs the full 40 to land near the millisecond; cutting it
// down the way findCrossing's below is safe would leave the "greatest eclipse" instant off by
// minutes.
const FIND_GREATEST_ITERATIONS = 40;

// A 5-hour bisection window shrinks by half per iteration, so it's sub-millisecond well before 40
// — 24 already lands under 1.1ms, far more precision than an eclipse contact time is ever
// displayed at, so trimming this loop is free.
const FIND_CROSSING_ITERATIONS = 24;

/** Time of closest approach to the shadow axis within a window, by ternary search — the
 *  separation curve is smooth and single-minimum across one lunation's worth of window. */
async function findGreatest(startMs: number, endMs: number): Promise<{ timeMs: number; geometry: ShadowGeometry }> {
    let low = startMs;
    let high = endMs;
    for (let i = 0; i < FIND_GREATEST_ITERATIONS; i++) {
        const third = (high - low) / 3;
        const m1 = low + third;
        const m2 = high - third;
        const [g1, g2] = await Promise.all([shadowGeometryAt(new Date(m1)), shadowGeometryAt(new Date(m2))]);
        if (g1.separation < g2.separation) high = m2;
        else low = m1;
        // shadowGeometryAt does its work synchronously behind these awaits, so without a periodic
        // macrotask yield this loop (and findCrossing's, chained six-wide in resolveEclipseNear)
        // runs to completion before the browser can paint the "loading" state a caller just set.
        if (i % YIELD_EVERY === YIELD_EVERY - 1) await yieldToMain();
    }
    const timeMs = (low + high) / 2;
    return { timeMs, geometry: await shadowGeometryAt(new Date(timeMs)) };
}

/** Bisects for the instant `signedGap` crosses zero, or null if it never does in the window. */
async function findCrossing(fromMs: number, toMs: number, signedGap: (g: ShadowGeometry) => number): Promise<Date | null> {
    let a = fromMs;
    let b = toMs;
    const fa = signedGap(await shadowGeometryAt(new Date(a)));
    const fb = signedGap(await shadowGeometryAt(new Date(b)));
    // `fa * fb > 0` is false whenever either value is NaN (NaN comparisons are always false), so
    // without an explicit finiteness check a NaN endpoint would fall through to the bisection below
    // and return an arbitrary, silently-wrong Date instead of null.
    if (!Number.isFinite(fa) || !Number.isFinite(fb)) return null;
    if (fa * fb > 0) return null;
    for (let i = 0; i < FIND_CROSSING_ITERATIONS; i++) {
        const mid = (a + b) / 2;
        const fm = signedGap(await shadowGeometryAt(new Date(mid)));
        if (fa * fm <= 0) b = mid;
        else a = mid;
        if (i % YIELD_EVERY === YIELD_EVERY - 1) await yieldToMain();
    }
    return new Date((a + b) / 2);
}

const HOUR_MS = 3_600_000;

/** Full circumstances for the eclipse nearest `nearMs`, or null if that lunation has none. */
async function resolveEclipseNear(nearMs: number): Promise<LunarEclipseSummary | null> {
    const { timeMs, geometry } = await findGreatest(nearMs - 0.6 * SYNODIC_MONTH_MS / 2, nearMs + 0.6 * SYNODIC_MONTH_MS / 2);

    // No contact with the penumbra at closest approach means no eclipse this lunation at all.
    if (geometry.separation > geometry.penumbraRadius + geometry.moonRadius) return null;

    const umbralMagnitude = (geometry.umbraRadius + geometry.moonRadius - geometry.separation) / (2 * geometry.moonRadius);
    const penumbralMagnitude = (geometry.penumbraRadius + geometry.moonRadius - geometry.separation) / (2 * geometry.moonRadius);
    const type: LunarEclipseType = umbralMagnitude >= 1 ? 'total' : umbralMagnitude > 0 ? 'partial' : 'penumbral';

    const window = 5 * HOUR_MS;
    const [p1, u1, u2, u3, u4, p4] = await Promise.all([
        findCrossing(timeMs - window, timeMs, (g) => g.separation - (g.penumbraRadius + g.moonRadius)),
        findCrossing(timeMs - window, timeMs, (g) => g.separation - (g.umbraRadius + g.moonRadius)),
        findCrossing(timeMs - window, timeMs, (g) => g.separation - (g.umbraRadius - g.moonRadius)),
        findCrossing(timeMs, timeMs + window, (g) => g.separation - (g.umbraRadius - g.moonRadius)),
        findCrossing(timeMs, timeMs + window, (g) => g.separation - (g.umbraRadius + g.moonRadius)),
        findCrossing(timeMs, timeMs + window, (g) => g.separation - (g.penumbraRadius + g.moonRadius)),
    ]);

    const greatest = new Date(timeMs);
    // P1/P4 always exist for a real eclipse; the bisection only fails if the window was too tight.
    if (!p1 || !p4) return null;

    return {
        date: greatest.toISOString().slice(0, 10),
        type,
        contacts: { p1, u1, u2, greatest, u3, u4, p4 },
        umbralMagnitude,
        penumbralMagnitude,
    };
}

/** Circumstances for the lunar eclipse on `date` (`YYYY-MM-DD`), as listed by listLunarEclipses. */
export async function loadLunarEclipse(date: string): Promise<LunarEclipseSummary> {
    const target = Date.parse(`${date}T12:00:00Z`);
    const summary = await resolveEclipseNear(target);
    if (!summary) throw new Error(t('error.noLunarEclipse', { date }));
    return summary;
}

export interface LunarEclipseListItem {
    date: string;
    type: LunarEclipseType;
}

/**
 * Every lunar eclipse between two dates. Lunar eclipses only happen at full moon, so rather than
 * scanning continuously this steps lunation by lunation from a reference full moon and tests each
 * one — roughly 12 checks per year instead of thousands.
 *
 * Yields between lunations so a multi-year scan doesn't block the main thread, mirroring
 * listStandardEclipsesChunked on the solar side.
 */
export async function listLunarEclipses(fromDate: string, toDate: string): Promise<LunarEclipseListItem[]> {
    const fromMs = Date.parse(`${fromDate}T00:00:00Z`);
    const toMs = Date.parse(`${toDate}T23:59:59Z`);
    const firstIndex = Math.floor((fromMs - REFERENCE_FULL_MOON_MS) / SYNODIC_MONTH_MS);
    const lastIndex = Math.ceil((toMs - REFERENCE_FULL_MOON_MS) / SYNODIC_MONTH_MS);

    const items: LunarEclipseListItem[] = [];
    for (let n = firstIndex; n <= lastIndex; n++) {
        const summary = await resolveEclipseNear(REFERENCE_FULL_MOON_MS + n * SYNODIC_MONTH_MS);
        if (summary) {
            const ms = summary.contacts.greatest.getTime();
            if (ms >= fromMs && ms <= toMs) items.push({ date: summary.date, type: summary.type });
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return items;
}

export interface MoonPosition {
    azimuth: number;
    altitude: number;
}

/** Apparent topocentric position of the Moon as seen from a point on Earth — the lunar analogue
 *  of getSunPositionAt, and the only thing that varies by location during a lunar eclipse.
 *  Refraction-corrected, matching the solar side (localCircumstances.ts uses
 *  getRefractionCorrectedTopocentricHorizontalCoordinates too) and every other "is the Moon above
 *  the horizon" check in this app — terrain/lunarVisibility.ts and terrain/lunarVisibilityGrid.ts
 *  both compare against this altitude, so they inherit the correction automatically. */
export async function getMoonPositionAt(date: Date, lat: number, lon: number, elevation = 0): Promise<MoonPosition> {
    const moon = await Moon.create(TimeOfInterest.fromDate(date));
    const { azimuth, altitude } = await moon.getRefractionCorrectedTopocentricHorizontalCoordinates(Location.create(lat, lon, elevation));
    return { azimuth, altitude };
}

/**
 * The boundary on Earth where the Moon sits exactly on the horizon at `date` — inside it the Moon
 * is up, outside it is down. This is the closest thing a lunar eclipse has to the solar path, and
 * it is what makes the 2D map useful in lunar mode.
 *
 * Returned as a LineString rather than a filled polygon on purpose: the region is a hemisphere, so
 * it always encloses one of the poles and almost always crosses the antimeridian — both cases
 * where a naive GeoJSON polygon renders as garbage. The shaded version of the same information is
 * the visibility grid (lunarVisibilityGrid.ts), which is computed per cell and has no such issue.
 *
 * Longitudes are emitted unwrapped (continuing past ±180 rather than jumping) so the line draws as
 * one continuous curve instead of a stripe across the whole map.
 */
/** The point on Earth with the Moon straight overhead. Latitude is simply the Moon's declination;
 *  the longitude would need sidereal time, which is easier to sidestep by scanning for where the
 *  Moon is highest along that parallel (a single clean maximum) and refining. */
export async function getSubLunarPoint(date: Date): Promise<{ lat: number; lon: number }> {
    const toi = TimeOfInterest.fromDate(date);
    const moon = await Moon.create(toi);
    const coords = await moon.getApparentGeocentricEquatorialSphericalCoordinates();
    const subLat = coords.declination;

    let bestLon = -180;
    let bestAltitude = -Infinity;
    for (let lon = -180; lon < 180; lon += 10) {
        const { altitude } = await getMoonPositionAt(date, subLat, lon);
        if (altitude > bestAltitude) {
            bestAltitude = altitude;
            bestLon = lon;
        }
    }
    let low = bestLon - 10;
    let high = bestLon + 10;
    for (let i = 0; i < 30; i++) {
        const m1 = low + (high - low) / 3;
        const m2 = high - (high - low) / 3;
        const [a1, a2] = await Promise.all([getMoonPositionAt(date, subLat, m1), getMoonPositionAt(date, subLat, m2)]);
        if (a1.altitude > a2.altitude) high = m2;
        else low = m1;
    }
    return { lat: subLat, lon: (low + high) / 2 };
}

/** Great-circle destination point at an arbitrary angular distance (degrees) from a start point,
 *  along a bearing — the general form of the "exactly 90°" formula this replaces below. */
function destinationAtAngularDistance(
    latDeg: number,
    lonDeg: number,
    bearingDeg: number,
    angularDistanceDeg: number,
): { lat: number; lon: number } {
    const lat1 = latDeg * DEG;
    const lon1 = lonDeg * DEG;
    const bearing = bearingDeg * DEG;
    const d = angularDistanceDeg * DEG;
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(bearing));
    const lon2 = lon1 + Math.atan2(Math.sin(bearing) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
    return { lat: lat2 / DEG, lon: (((lon2 / DEG + 540) % 360) - 180) };
}

/**
 * The true angular distance from the sub-lunar point at which the Moon's refraction-corrected
 * apparent altitude crosses zero — not exactly 90° like the purely geometric horizon, because
 * topocentric lunar parallax (~1°, non-negligible at the Moon's distance) and horizon refraction
 * (~0.57°) both shift the crossing, and don't cancel out. Measured along one bearing and treated
 * as isotropic: both effects are radial functions of angular distance from the sub-lunar point to
 * first order, so a single bearing is representative of the whole boundary (verified for
 * 2025-03-14: ~89.70° everywhere the terrain grid and world map used to disagree by up to 0.9°).
 */
async function moonUpRadiusDeg(date: Date, subLat: number, subLon: number): Promise<number> {
    let lo = 85;
    let hi = 95;
    for (let i = 0; i < 20; i++) {
        const mid = (lo + hi) / 2;
        const { lat, lon } = destinationAtAngularDistance(subLat, subLon, 0, mid);
        const { altitude } = await getMoonPositionAt(date, lat, lon);
        if (altitude > 0) lo = mid;
        else hi = mid;
    }
    return (lo + hi) / 2;
}

export async function getMoonHorizonBoundary(date: Date): Promise<GeoJSON.Feature<GeoJSON.LineString>> {
    const { lat: subLat, lon: subLon } = await getSubLunarPoint(date);
    const radiusDeg = await moonUpRadiusDeg(date, subLat, subLon);

    const ring: GeoJSON.Position[] = [];
    let previousLon: number | null = null;
    let wraps = 0;
    for (let bearingDeg = 0; bearingDeg <= 360; bearingDeg += 2) {
        const { lat: latDeg, lon: rawLonDeg } = destinationAtAngularDistance(subLat, subLon, bearingDeg, radiusDeg);
        let lonDeg = rawLonDeg;
        if (previousLon !== null) {
            // Keep the polyline continuous across the ±180 seam instead of jumping the map width.
            if (lonDeg - previousLon > 180) wraps -= 1;
            else if (lonDeg - previousLon < -180) wraps += 1;
        }
        previousLon = lonDeg;
        lonDeg += wraps * 360;
        ring.push([lonDeg, latDeg]);
    }

    return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: ring } };
}

/** How much of a lunar eclipse is visible from every point on Earth, as a world grid of 0-1
 *  fractions ready for the shared contour-band renderer. */
export interface LunarVisibilityField {
    cols: number;
    rows: number;
    bounds: { west: number; south: number; east: number; north: number };
    /** Row-major, length cols*rows. Fraction of the eclipse with the Moon above the horizon. */
    values: number[];
}

/**
 * The zones a lunar eclipse map is really about: where the whole thing is visible, where the Moon
 * rises or sets partway through, and where none of it can be seen. Boundary lines alone only mark
 * the edges of those zones without saying which side is which.
 *
 * Cheap to compute despite covering the globe, because the Moon is above the horizon at a point
 * exactly when that point lies within `moonUpRadiusDeg` of the sub-lunar point — very close to 90°
 * but not exactly, since refraction and topocentric parallax shift the true crossing (see
 * moonUpRadiusDeg). So this needs only one ephemeris lookup per time sample plus one radius
 * bisection — still a couple dozen ephemeris calls in total — after which every grid cell is a
 * cheap spherical distance comparison. This uses the refraction-corrected criterion but no terrain;
 * the terrain-aware version is the visibility grid in terrain/lunarVisibilityGrid.ts, which is what
 * the Obstruction and Qualité views draw when you zoom in — both now agree with this to a fraction
 * of a degree instead of disagreeing by up to 0.9°.
 *
 * Computed once per eclipse over the whole world rather than per viewport, since unlike the solar
 * overlays there is nothing here that changes as you pan.
 */
export async function computeLunarVisibilityField(summary: LunarEclipseSummary, cols = 240, rows = 120): Promise<LunarVisibilityField> {
    const { p1, p4, u1, u4 } = summary.contacts;
    // Measured over the umbral phase when there is one — the penumbral shading is invisible, so
    // "visible" should mean the part anyone could actually notice.
    const startMs = (u1 ?? p1).getTime();
    const endMs = (u4 ?? p4).getTime();

    const SAMPLES = 13;
    const prepared: Array<{ sinLat: number; cosLat: number; lon: number; cosRadius: number }> = [];
    for (let i = 0; i < SAMPLES; i++) {
        const t = new Date(startMs + ((endMs - startMs) * i) / (SAMPLES - 1));
        const sub = await getSubLunarPoint(t);
        const radiusDeg = await moonUpRadiusDeg(t, sub.lat, sub.lon);
        prepared.push({ sinLat: Math.sin(sub.lat * DEG), cosLat: Math.cos(sub.lat * DEG), lon: sub.lon * DEG, cosRadius: Math.cos(radiusDeg * DEG) });
    }

    // ±85° matches Web Mercator's usable range, which is all the base map can show anyway.
    const bounds = { west: -180, east: 180, south: -85, north: 85 };

    const values: number[] = new Array(cols * rows);
    for (let r = 0; r < rows; r++) {
        const lat = bounds.north - ((r + 0.5) / rows) * (bounds.north - bounds.south);
        const sinLat = Math.sin(lat * DEG);
        const cosLat = Math.cos(lat * DEG);
        for (let c = 0; c < cols; c++) {
            const lon = (bounds.west + ((c + 0.5) / cols) * (bounds.east - bounds.west)) * DEG;
            let up = 0;
            for (const sub of prepared) {
                // cos(angular distance) > cos(radius) means closer than the refraction-corrected
                // horizon radius, i.e. the Moon is above the apparent horizon there.
                if (sinLat * sub.sinLat + cosLat * sub.cosLat * Math.cos(lon - sub.lon) > sub.cosRadius) up++;
            }
            values[r * cols + c] = up / SAMPLES;
        }
    }

    return { cols, rows, bounds, values };
}
