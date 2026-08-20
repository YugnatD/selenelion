import { getElevation, getElevationsBatch } from './elevationTiles';

const EARTH_RADIUS_M = 6371000;
/** Standard atmospheric refraction coefficient: raises the effective Earth radius, reducing curvature drop. */
const REFRACTION_COEFFICIENT = 0.13;
const EFFECTIVE_EARTH_RADIUS_M = EARTH_RADIUS_M / (1 - REFRACTION_COEFFICIENT);
export const EYE_HEIGHT_M = 1.6;

const AZIMUTH_STEP_DEG = 5;

/**
 * How far out each azimuth ray is sampled, and at which elevation-tile zoom. Step size and tile
 * resolution are deliberately tied together: what matters to a horizon profile is *angular*
 * resolution along the ray, and both the gap between samples and the width of a tile pixel shrink
 * in angular terms as distance grows. One pixel at zoom 9 spans ~41° of sky at 250m but only
 * ~0.2° at 64km.
 *
 * Getting that coupling wrong fails in both directions, measured against apparent altitudes
 * computed independently from published summit coordinates (deltas are ours − expected, so
 * negative = under-reading the real skyline, the optimistic direction):
 *
 *                                       Gibraltar 0.5km   MontBlanc 10km   Matterhorn 8.6km
 *   coarse steps, zoom 9 everywhere          −2.47°           −3.31°            −3.35°
 *   coarse steps, multi-resolution           +1.05°           −3.00°            −3.39°
 *   dense steps, zoom 9 everywhere          +22.91°           −0.26°            −1.72°
 *   dense steps, multi-resolution (this)     +0.71°           −0.29°            −1.32°
 *
 * Coarse steps miss distant summits entirely — the Matterhorn sits at 8.55km, between the old
 * 8km and 16km samples, so the ray read its lower flank and never touched the peak. But dense
 * steps against coarse tiles are far worse: a 100m sample lands inside a ~300m pixel that already
 * contains the cliff above it, reporting a 23°-too-high horizon. Only scaling both together is
 * stable at every distance.
 *
 * This applies to the single-point profile, which runs once per selected location and can afford
 * ~9k elevation lookups. The map-grid equivalent in obstructionGrid.ts keeps a much coarser
 * ladder on purpose — it pays that cost per cell, thousands of times over.
 */
const SAMPLE_BANDS: Array<{ untilMeters: number; stepMeters: number; zoom: number }> = [
    { untilMeters: 2_000, stepMeters: 100, zoom: 12 },
    { untilMeters: 16_000, stepMeters: 250, zoom: 11 },
    { untilMeters: 64_000, stepMeters: 1_000, zoom: 9 },
];

interface SampleStep {
    distance: number;
    zoom: number;
}

/** The (distance, zoom) ladder built once from SAMPLE_BANDS — ~124 steps per azimuth. */
const SAMPLE_STEPS: SampleStep[] = (() => {
    const steps: SampleStep[] = [];
    let from = 0;
    for (const band of SAMPLE_BANDS) {
        for (let d = from + band.stepMeters; d <= band.untilMeters; d += band.stepMeters) {
            steps.push({ distance: d, zoom: band.zoom });
        }
        from = band.untilMeters;
    }
    return steps;
})();

/** Zoom used for a single point's own elevation (the observer's ground height). The finest band's
 *  zoom, so the eye height that every apparent-altitude comparison is measured against comes from
 *  the same resolution as the nearby terrain it is compared to — mixing a coarse observer
 *  elevation with fine surroundings biases the whole profile up or down. Exported so callers
 *  needing just an elevation (the astronomy's observer height, the land/water check) agree with
 *  this module and share its tile cache. */
export const ELEVATION_ZOOM = 12;

export interface HorizonPoint {
    azimuth: number;
    /** Angle above (or below, if negative) the geometric horizontal, in degrees. */
    altitude: number;
}

/** Great-circle destination point, given a start point, bearing and distance. */
export function destinationPoint(lat: number, lon: number, bearingDeg: number, distanceM: number): { lat: number; lon: number } {
    const angularDistance = distanceM / EARTH_RADIUS_M;
    const bearing = (bearingDeg * Math.PI) / 180;
    const lat1 = (lat * Math.PI) / 180;
    const lon1 = (lon * Math.PI) / 180;

    // Clamped: floating-point error can push this a hair past ±1 (e.g. 1.0000000000000002),
    // which would make asin return NaN and poison every downstream elevation lookup — a real
    // risk near the poles, which this app's own near-polar eclipse paths do reach.
    const sinLat2 = Math.max(
        -1,
        Math.min(1, Math.sin(lat1) * Math.cos(angularDistance) + Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing)),
    );
    const lat2 = Math.asin(sinLat2);
    const lon2 =
        lon1 +
        Math.atan2(
            Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
            Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2),
        );

    return { lat: (lat2 * 180) / Math.PI, lon: (((lon2 * 180) / Math.PI + 540) % 360) - 180 };
}

/** Apparent altitude angle (degrees) of a terrain point, from an observer's eye, accounting for Earth curvature + refraction. */
export function apparentAltitudeDeg(eyeElevationM: number, targetElevationM: number, distanceM: number): number {
    if (distanceM === 0) return 90;
    const curvatureDrop = distanceM ** 2 / (2 * EFFECTIVE_EARTH_RADIUS_M);
    const apparentHeight = targetElevationM - eyeElevationM - curvatureDrop;
    return (Math.atan2(apparentHeight, distanceM) * 180) / Math.PI;
}

/**
 * Horizon altitude profile around a point: for each azimuth (stepped by `AZIMUTH_STEP_DEG`),
 * the angle above horizontal that terrain blocks up to, found by sampling elevation outward along
 * the ray (see SAMPLE_BANDS) and keeping the steepest apparent angle. Mirrors what
 * eclipsemap.xyz computes from the same AWS Terrarium elevation tiles.
 *
 * Sample points are grouped by the zoom their band calls for and resolved with one
 * `getElevationsBatch` per zoom, rather than one `getElevation` per point — so tile fetches are
 * still deduplicated and awaited together, just per resolution instead of globally. The near
 * bands cover only a small radius, so their finer tiles stay to a handful of files.
 */
export async function computeHorizonProfile(lat: number, lon: number): Promise<HorizonPoint[]> {
    const azimuths: number[] = [];
    for (let az = 0; az < 360; az += AZIMUTH_STEP_DEG) azimuths.push(az);

    // One bucket of sample points per zoom level, each remembering where its results belong.
    const byZoom = new Map<number, { points: Array<{ lat: number; lon: number }>; slots: number[] }>();
    const bucketFor = (zoom: number) => {
        let bucket = byZoom.get(zoom);
        if (!bucket) {
            bucket = { points: [], slots: [] };
            byZoom.set(zoom, bucket);
        }
        return bucket;
    };

    const stepCount = SAMPLE_STEPS.length;
    for (let a = 0; a < azimuths.length; a++) {
        // a is bounded by azimuths.length via the loop condition, so this index is always valid.
        const az = azimuths[a]!;
        for (let s = 0; s < stepCount; s++) {
            // s is bounded by stepCount === SAMPLE_STEPS.length, so this index is always valid.
            const step = SAMPLE_STEPS[s]!;
            const bucket = bucketFor(step.zoom);
            bucket.points.push(destinationPoint(lat, lon, az, step.distance));
            bucket.slots.push(a * stepCount + s);
        }
    }

    const observerPromise = getElevation(lat, lon, ELEVATION_ZOOM);
    const bucketPromises = Array.from(byZoom.entries()).map(async ([zoom, bucket]) => ({
        slots: bucket.slots,
        elevations: await getElevationsBatch(bucket.points, zoom),
    }));
    const [observerElevation, resolved] = await Promise.all([observerPromise, Promise.all(bucketPromises)]);

    const elevations = new Float32Array(azimuths.length * stepCount);
    for (const { slots, elevations: values } of resolved) {
        // slots/values come from the same zip (bucketFor + getElevationsBatch) at matching
        // lengths, and i is bounded by slots.length, so both indices are always valid.
        for (let i = 0; i < slots.length; i++) elevations[slots[i]!] = values[i]!;
    }
    const eyeElevation = observerElevation + EYE_HEIGHT_M;

    const profile: HorizonPoint[] = [];
    for (let a = 0; a < azimuths.length; a++) {
        // a is bounded by azimuths.length via the loop condition, so this index is always valid.
        const az = azimuths[a]!;
        let maxAltitude = -90;
        for (let s = 0; s < stepCount; s++) {
            // s is bounded by stepCount === SAMPLE_STEPS.length, and a*stepCount+s stays within
            // elevations' azimuths.length*stepCount length for the same reason.
            const altitude = apparentAltitudeDeg(eyeElevation, elevations[a * stepCount + s]!, SAMPLE_STEPS[s]!.distance);
            if (altitude > maxAltitude) maxAltitude = altitude;
        }
        profile.push({ azimuth: az, altitude: maxAltitude });
    }
    return profile;
}

/** Horizon altitude at an arbitrary azimuth, linearly interpolated between the two nearest sampled directions. */
export function horizonAltitudeAt(profile: HorizonPoint[], azimuth: number): number {
    if (profile.length === 0) return 0;
    const normalized = ((azimuth % 360) + 360) % 360;
    // Derived from the profile's own length rather than assuming AZIMUTH_STEP_DEG: correct only
    // as long as computeHorizonProfile always returns exactly 360/AZIMUTH_STEP_DEG evenly-spaced
    // points, which this makes true by construction instead of by coincidence.
    const step = 360 / profile.length;
    const i0 = Math.floor(normalized / step) % profile.length;
    const i1 = (i0 + 1) % profile.length;
    const t = (normalized % step) / step;
    // i0 and i1 are both computed mod profile.length (checked non-zero above), so they're
    // always valid indices into profile.
    return profile[i0]!.altitude * (1 - t) + profile[i1]!.altitude * t;
}
