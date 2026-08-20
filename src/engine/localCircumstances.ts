import { Location, TimeOfInterest } from '@astronomy-bundle/core';
import type { LocalSolarEclipse, SolarEclipse } from '@astronomy-bundle/solar-eclipse';

export function getLocalEclipse(eclipse: SolarEclipse, lat: number, lon: number, elevation = 0): LocalSolarEclipse {
    return eclipse.getLocalEclipse(Location.create(lat, lon, elevation));
}

export interface LocalCircumstancesSummary {
    /** null when this location never sees any part of the eclipse. */
    type: 'none' | 'partial' | 'total' | 'annular';
    contactTimes: {
        c1: Date;
        c2: Date | null;
        max: Date;
        c3: Date | null;
        c4: Date;
    } | null;
    maxMagnitude: number;
    maxObscuration: number;
    umbraPathWidthMeters: number;
    durationSeconds: number;
    centralDurationSeconds: number;
}

const NOT_VISIBLE_SUMMARY: LocalCircumstancesSummary = {
    type: 'none',
    contactTimes: null,
    maxMagnitude: 0,
    maxObscuration: 0,
    umbraPathWidthMeters: 0,
    durationSeconds: 0,
    centralDurationSeconds: 0,
};

/**
 * Note on the `type: 'none'` / null-contacts branch below: in practice `LocalSolarEclipse.create`
 * (called by `getLocalEclipse`) throws "No solar eclipse visible at this location" rather than
 * constructing an object whose `getContactTimes()` returns null, so that's the only place the
 * "not visible here" case is actually observable — this ternary is defensive for the (currently
 * unreached, per the library's own type signature) case where a constructed `LocalSolarEclipse`
 * still has no contacts. Use `summarizeLocalAt` below to get the `type: 'none'` sentinel for the
 * common case of a location outside the eclipse entirely, without needing your own try/catch
 * around construction.
 */
export function summarizeLocal(local: LocalSolarEclipse): LocalCircumstancesSummary {
    const contacts = local.getContactTimes();
    if (!contacts) return NOT_VISIBLE_SUMMARY;

    const type = local.getType();
    // Same central-vs-partial magnitude distinction as the world-level summary in eclipse.ts: the
    // library's getMaxMagnitude() is the partial-eclipse formula and understates magnitude at
    // locations where the eclipse is actually total/annular there.
    const isCentral = type === 'total' || type === 'annular';
    return {
        type,
        contactTimes: {
            c1: contacts.c1.getDate(),
            c2: contacts.c2?.getDate() ?? null,
            max: contacts.max.getDate(),
            c3: contacts.c3?.getDate() ?? null,
            c4: contacts.c4.getDate(),
        },
        maxMagnitude: isCentral ? local.getMaxMoonSunRatio() : local.getMaxMagnitude(),
        maxObscuration: local.getMaxObscuration(),
        umbraPathWidthMeters: local.getUmbraPathWidth(),
        durationSeconds: local.getDuration(),
        centralDurationSeconds: local.getCentralDuration(),
    };
}

/**
 * `getLocalEclipse` + `summarizeLocal`, but catching the "not visible at this location" error
 * that `LocalSolarEclipse.create` throws (rather than returning) and turning it into the
 * documented `type: 'none'` sentinel. This is where the `type: 'none'` branch of
 * `LocalCircumstancesSummary` actually becomes reachable — callers no longer need their own
 * try/catch around `getLocalEclipse` just to detect "this point never sees any part of the
 * eclipse".
 */
export function summarizeLocalAt(eclipse: SolarEclipse, lat: number, lon: number, elevation = 0): LocalCircumstancesSummary {
    try {
        return summarizeLocal(getLocalEclipse(eclipse, lat, lon, elevation));
    } catch {
        return NOT_VISIBLE_SUMMARY;
    }
}

export interface SunPositionAtTime {
    azimuth: number;
    altitude: number;
    eclipseType: 'none' | 'partial' | 'total' | 'annular';
    inEclipse: boolean;
    inCentralEclipse: boolean;
    magnitude: number;
    obscuration: number;
}

/** Apparent (refraction-corrected) topocentric Sun azimuth/altitude, plus eclipse state, at a given instant. */
export function getSunPositionAt(local: LocalSolarEclipse, date: Date): SunPositionAtTime {
    const toi = TimeOfInterest.fromDate(date);
    const circumstances = local.getCircumstances(toi);
    const { azimuth, altitude } = circumstances.getApparentTopocentricHorizontalCoordinates();
    return {
        azimuth,
        altitude,
        eclipseType: circumstances.getEclipseType(),
        inEclipse: circumstances.isInEclipse(),
        inCentralEclipse: circumstances.isInCentralEclipse(),
        magnitude: circumstances.getMagnitude(),
        obscuration: circumstances.getObscuration(),
    };
}
