import type { LocalSolarEclipse } from '@astronomy-bundle/solar-eclipse';
import { getSunPositionAt } from '../engine/localCircumstances';
import type { HorizonPoint } from './horizon';
import { horizonAltitudeAt } from './horizon';

export interface VisibilitySample {
    time: Date;
    azimuth: number;
    altitude: number;
    horizonAltitude: number;
    visible: boolean;
    inCentralEclipse: boolean;
    /** Fraction of the Sun's diameter covered by the Moon (can exceed 1 during totality). */
    magnitude: number;
}

export interface EclipseVisibilityResult {
    samples: VisibilitySample[];
    visibleDurationSeconds: number;
    theoreticalDurationSeconds: number;
    /** Whether this location has a total/annular phase at all (as opposed to only ever partial). */
    hasCentralPhase: boolean;
    /** Whether any part of that central phase clears the real terrain horizon. */
    centralPhaseVisible: boolean;
}

const SAMPLE_STEP_SECONDS = 30;

/**
 * Walks the eclipse from first to last contact at this location, sampling the Sun's real
 * position every 30s and comparing it against the terrain horizon profile — the same
 * comparison eclipsemap.xyz performs, telling you how much of the theoretical duration is
 * actually visible once the surrounding relief is accounted for.
 */
export function computeEclipseVisibility(
    local: LocalSolarEclipse,
    horizonProfile: HorizonPoint[],
): EclipseVisibilityResult | null {
    const contacts = local.getContactTimes();
    if (!contacts) return null;

    const start = contacts.c1.getDate().getTime();
    const end = contacts.c4.getDate().getTime();
    const samples: VisibilitySample[] = [];
    let visibleCount = 0;
    let centralPhaseVisible = false;

    for (let t = start; t <= end; t += SAMPLE_STEP_SECONDS * 1000) {
        const position = getSunPositionAt(local, new Date(t));
        const horizonAltitude = horizonAltitudeAt(horizonProfile, position.azimuth);
        const visible = position.altitude > horizonAltitude;
        if (visible) {
            visibleCount++;
            if (position.inCentralEclipse) centralPhaseVisible = true;
        }
        samples.push({
            time: new Date(t),
            azimuth: position.azimuth,
            altitude: position.altitude,
            horizonAltitude,
            visible,
            inCentralEclipse: position.inCentralEclipse,
            magnitude: position.magnitude,
        });
    }

    // Scaled by the *fraction* of samples that cleared the horizon rather than credited
    // SAMPLE_STEP_SECONDS each: the samples are fenceposts across [c1, c4], not slices, so N
    // samples span only N-1 steps (and the last step is usually partial, since the eclipse's
    // duration is rarely an exact multiple of the step). Crediting a full step per sample
    // overcounted by up to one step — enough to report a completely unobstructed point as
    // "140m 30s visible / 140m 03s total", i.e. more visible time than the eclipse itself lasts,
    // and a visibleFraction just above 1. This normalization is also exactly what
    // obstructionGrid.ts already uses per cell (visibleCount / samples.length), so the
    // single-point panel and the map grid now agree on the same definition.
    const theoreticalDurationSeconds = local.getDuration();
    const visibleFraction = samples.length > 0 ? visibleCount / samples.length : 0;

    return {
        samples,
        visibleDurationSeconds: visibleFraction * theoreticalDurationSeconds,
        theoreticalDurationSeconds,
        hasCentralPhase: local.getType() !== 'partial',
        centralPhaseVisible,
    };
}
