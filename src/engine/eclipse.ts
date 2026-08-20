import { SolarEclipse } from '@astronomy-bundle/solar-eclipse';
import type { BesselianElements } from './catalogue';
import { getBesselianElementsForDate } from './catalogue';
import { getLocalEclipse } from './localCircumstances';
import { formatLocalTimeShort, getTimeZone } from './timezone';
import type { EclipseSummary } from './types';

export async function loadEclipse(date: string): Promise<SolarEclipse> {
    const elements: BesselianElements = await getBesselianElementsForDate(date);
    return SolarEclipse.createFromBesselianElements(elements);
}

export function summarizeEclipse(date: string, eclipse: SolarEclipse): EclipseSummary {
    const { lat, lon } = eclipse.getLocationOfGreatestEclipse();
    const type = eclipse.getType();
    // getMaxMagnitude() implements the partial-eclipse formula (l1-distance)/(l1+l2), which is
    // correct only when the point of greatest eclipse sits outside the umbra/antumbra. For a
    // total/annular/hybrid eclipse, greatest eclipse is by definition on the central line, and the
    // standard reported magnitude there is the Moon/Sun diameter ratio (getMaxMoonSunRatio) — using
    // getMagnitude() instead silently collapses to (1+ratio)/2, understating it (e.g. 1.0283 vs the
    // correct 1.0566 for 2024-04-08).
    const isCentral = type === 'total' || type === 'annular' || type === 'hybrid';
    return {
        date,
        type,
        saros: eclipse.getSaros(),
        greatestEclipse: {
            lat,
            lon,
            time: eclipse.getTimeOfGreatestEclipse().getDate(),
        },
        magnitude: isCentral ? eclipse.getMaxMoonSunRatio() : eclipse.getMaxMagnitude(),
        obscuration: eclipse.getMaxObscuration(),
        umbraPathWidthMeters: eclipse.getUmbraPathWidth(),
        maxDurationSeconds: eclipse.getMaxDuration(),
        maxCentralDurationSeconds: eclipse.getMaxCentralDuration(),
    };
}

export interface EclipsePathGeoJSON {
    centralLine: GeoJSON.Feature<GeoJSON.LineString> | null;
    umbraPolygon: GeoJSON.Feature<GeoJSON.Polygon> | null;
    penumbraPolygon: GeoJSON.Feature<GeoJSON.Polygon> | null;
    sunriseBoundary: GeoJSON.Feature<GeoJSON.Polygon> | null;
    sunsetBoundary: GeoJSON.Feature<GeoJSON.Polygon> | null;
    /** Sparse UTC time labels along the central line (local time of greatest eclipse at each point). */
    timeTicks: GeoJSON.FeatureCollection<GeoJSON.Point> | null;
}

/**
 * Coordinates for a plain `LineString` (the central line), with longitudes unwrapped across the
 * antimeridian the same way `toFilledPolygonRing` unwraps a filled ring — consecutive points must
 * never jump by more than 180° in longitude, or the line is drawn as a seam-to-seam streak across
 * the whole map instead of continuing round the back. Unlike a ring, a LineString never needs to
 * close, so there is no pole-closing step here, just the running unwrap relative to the previous
 * point.
 */
function toRing(points: Array<{ lat: number; lon: number }>): GeoJSON.Position[] {
    const ring: GeoJSON.Position[] = [];
    let wraps = 0;
    let previousLon: number | null = null;
    for (const p of points) {
        if (previousLon !== null) {
            if (p.lon - previousLon > 180) wraps -= 1;
            else if (p.lon - previousLon < -180) wraps += 1;
        }
        previousLon = p.lon;
        ring.push([p.lon + wraps * 360, p.lat]);
    }
    return ring;
}

/**
 * Ring for a *filled* polygon (umbra/penumbra/sunrise/sunset), as opposed to a plain line.
 *
 * Two things break a naive lon/lat ring once an eclipse reaches high latitudes, and both show up
 * as large straight-edged wedges smeared across the map rather than as an obviously wrong shape:
 *
 *  - Crossing the antimeridian makes consecutive longitudes jump by ~360°, so the tessellator
 *    draws a band right across the world instead of continuing round the back.
 *  - A penumbra that reaches over a pole produces a ring that winds a full 360° in longitude and
 *    never closes in the plane — there is no way to fill it without saying which pole is inside.
 *
 * The 2027-02-06 annular eclipse hits both: its penumbra ring crosses the seam twice and runs down
 * to −88.3° latitude. So longitudes are unwrapped to stay continuous (running past ±180 rather
 * than jumping), and when the ring has wound all the way round, two points at the enclosed pole
 * are appended to close it over the top. Eclipses that do neither — 2027-08-02, for instance — are
 * unaffected, which is why this only ever misrendered for some of them.
 */
function toFilledPolygonRing(points: Array<{ lat: number; lon: number }>): GeoJSON.Position[] {
    if (points.length === 0) return [];

    // GeoJSON.Position is typed as plain `number[]`, so indexing back into `ring` (e.g. `ring[0][0]`)
    // would be `number | undefined` under noUncheckedIndexedAccess even though every element here is
    // always a 2-tuple by construction. Tracking first/last lon/lat as plain numbers alongside the
    // ring avoids re-indexing into it and sidesteps that false-positive undefined entirely.
    const ring: GeoJSON.Position[] = [];
    let wraps = 0;
    let previousLon: number | null = null;
    let firstLon = 0;
    let firstLat = 0;
    let lastLon = 0;
    let lastLat = 0;
    let latMin = 90;
    let latMax = -90;
    points.forEach((p, i) => {
        if (previousLon !== null) {
            if (p.lon - previousLon > 180) wraps -= 1;
            else if (p.lon - previousLon < -180) wraps += 1;
        }
        previousLon = p.lon;
        const lon = p.lon + wraps * 360;
        const lat = p.lat;
        ring.push([lon, lat]);
        if (i === 0) {
            firstLon = lon;
            firstLat = lat;
        }
        lastLon = lon;
        lastLat = lat;
        if (lat < latMin) latMin = lat;
        if (lat > latMax) latMax = lat;
    });

    // A full turn in longitude means the ring encircles a pole rather than closing on itself.
    if (Math.abs(lastLon - firstLon) > 180) {
        // Whichever pole the ring reaches towards is the one it wraps around.
        const pole = Math.abs(latMin) > Math.abs(latMax) ? -90 : 90;
        ring.push([lastLon, pole], [firstLon, pole]);
        lastLon = firstLon;
        lastLat = pole;
    }
    if (lastLon !== firstLon || lastLat !== firstLat) {
        ring.push([firstLon, firstLat]);
    }
    return ring;
}

/**
 * Coarse local-time labels along the central line (roughly every `stepMinutes` of eclipse
 * duration), used to label the path on the map. `getCentralLine` doesn't expose per-point
 * times, so each sampled point is re-resolved as a local eclipse to read its own moment of
 * greatest eclipse, then formatted in *that point's own* timezone (it changes along the path).
 */
function getCentralLineTimeTicks(eclipse: SolarEclipse, stepMinutes = 10): GeoJSON.FeatureCollection<GeoJSON.Point> {
    const points = eclipse.getCentralLine({ stepsInSeconds: stepMinutes * 60 });
    const features: GeoJSON.Feature<GeoJSON.Point>[] = [];

    for (const { lat, lon } of points) {
        try {
            const max = getLocalEclipse(eclipse, lat, lon).getContactTimes()?.max.getDate();
            if (max) {
                const label = formatLocalTimeShort(max, getTimeZone(lat, lon));
                features.push({
                    type: 'Feature',
                    properties: { label },
                    geometry: { type: 'Point', coordinates: [lon, lat] },
                });
            }
        } catch {
            // Points exactly on the geometric edge of the path can fail local-circumstances
            // resolution; skip them rather than breaking the whole tick set.
        }
    }

    return { type: 'FeatureCollection', features };
}

export function getPathGeoJSON(eclipse: SolarEclipse, opts?: { stepsInSeconds?: number }): EclipsePathGeoJSON {
    const centralLinePoints = eclipse.getCentralLine(opts);
    const umbraPoints = eclipse.getUmbraPathPolygon(opts);
    const penumbraPoints = eclipse.getPenumbraPathPolygon(opts);
    const sunrisePoints = eclipse.getSunriseBoundaryPolygon();
    const sunsetPoints = eclipse.getSunsetBoundaryPolygon();

    return {
        timeTicks: centralLinePoints.length > 1 ? getCentralLineTimeTicks(eclipse) : null,
        centralLine:
            centralLinePoints.length > 1
                ? {
                      type: 'Feature',
                      properties: {},
                      geometry: { type: 'LineString', coordinates: toRing(centralLinePoints) },
                  }
                : null,
        umbraPolygon:
            umbraPoints.length > 3
                ? {
                      type: 'Feature',
                      properties: {},
                      geometry: { type: 'Polygon', coordinates: [toFilledPolygonRing(umbraPoints)] },
                  }
                : null,
        penumbraPolygon:
            penumbraPoints.length > 3
                ? {
                      type: 'Feature',
                      properties: {},
                      geometry: { type: 'Polygon', coordinates: [toFilledPolygonRing(penumbraPoints)] },
                  }
                : null,
        sunriseBoundary:
            sunrisePoints.length > 3
                ? {
                      type: 'Feature',
                      properties: {},
                      geometry: { type: 'Polygon', coordinates: [toFilledPolygonRing(sunrisePoints)] },
                  }
                : null,
        sunsetBoundary:
            sunsetPoints.length > 3
                ? {
                      type: 'Feature',
                      properties: {},
                      geometry: { type: 'Polygon', coordinates: [toFilledPolygonRing(sunsetPoints)] },
                  }
                : null,
    };
}

export type { SolarEclipse };
