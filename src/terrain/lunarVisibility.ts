import type { LunarEclipseSummary } from '../engine/lunarEclipse';
import { getMoonPositionAt } from '../engine/lunarEclipse';
import type { HorizonPoint } from './horizon';
import { horizonAltitudeAt } from './horizon';
import type { EclipseVisibilityResult, VisibilitySample } from './visibility';

/**
 * The lunar counterpart of computeEclipseVisibility: how much of the eclipse actually clears the
 * terrain horizon from one location. Deliberately produces the *same* EclipseVisibilityResult
 * shape as the solar version, so HorizonChart, the 3D time scrubber and the circumstances panel
 * all work on a lunar eclipse without knowing the difference.
 *
 * Two things differ from the solar case, both consequences of the eclipse happening on the Moon
 * rather than on Earth:
 *
 *  - The contact times are global, so this only has to answer "is the Moon above the horizon (and
 *    above the terrain) at those instants" — there are no local contact times to resolve first.
 *  - Being blocked is the normal case, not the exception: for roughly half the planet the Moon is
 *    simply below the horizon for the whole event.
 */

/** Coarser than the solar 30s step: a lunar eclipse runs for hours and the Moon's apparent
 *  position drifts slowly, so 2-minute steps resolve the horizon crossing to well under a degree
 *  while keeping the ephemeris work (one Moon position per sample) modest. */
const SAMPLE_STEP_SECONDS = 120;

/** Umbral magnitude interpolated as a simple triangular profile — peaking at greatest eclipse and
 *  falling to zero at the ends of the sampled window. The real curve is not linear, but this value
 *  is only used to pick the "most interesting" default frame for the 3D scrubber, so re-deriving
 *  the shadow geometry per sample would be a lot of ephemeris work for no visible gain. */
function approximateMagnitude(timeMs: number, startMs: number, greatestMs: number, endMs: number, peak: number): number {
    if (timeMs <= startMs || timeMs >= endMs) return 0;
    const half = timeMs <= greatestMs ? (timeMs - startMs) / Math.max(1, greatestMs - startMs) : (endMs - timeMs) / Math.max(1, endMs - greatestMs);
    return Math.max(0, Math.min(1, half)) * peak;
}

export async function computeLunarVisibility(
    summary: LunarEclipseSummary,
    lat: number,
    lon: number,
    horizonProfile: HorizonPoint[],
    elevation = 0,
): Promise<EclipseVisibilityResult> {
    const { p1, p4, u1, u2, u3, u4, greatest } = summary.contacts;

    // The umbral phase is the part anyone can actually see; the penumbral shading is invisible to
    // the naked eye. Measure against that window when there is one, so "durée visible" means the
    // visible eclipse rather than five hours of imperceptible dimming.
    const startMs = (u1 ?? p1).getTime();
    const endMs = (u4 ?? p4).getTime();
    const greatestMs = greatest.getTime();

    const times: number[] = [];
    for (let t = startMs; t <= endMs; t += SAMPLE_STEP_SECONDS * 1000) times.push(t);
    if (times.length === 0) times.push(greatestMs);

    const positions = await Promise.all(times.map((t) => getMoonPositionAt(new Date(t), lat, lon, elevation)));

    const totalityStart = u2?.getTime() ?? null;
    const totalityEnd = u3?.getTime() ?? null;

    const samples: VisibilitySample[] = [];
    let visibleCount = 0;
    let centralPhaseVisible = false;

    for (let i = 0; i < times.length; i++) {
        // i is bounded by times.length via the loop condition; positions was built by
        // times.map(...) above, so it has exactly the same length — both indices are always valid.
        const timeMs = times[i]!;
        const { azimuth, altitude } = positions[i]!;
        const horizonAltitude = horizonAltitudeAt(horizonProfile, azimuth);
        const visible = altitude > horizonAltitude;
        const inCentralEclipse = totalityStart !== null && totalityEnd !== null && timeMs >= totalityStart && timeMs <= totalityEnd;
        if (visible) {
            visibleCount++;
            if (inCentralEclipse) centralPhaseVisible = true;
        }
        samples.push({
            time: new Date(timeMs),
            azimuth,
            altitude,
            horizonAltitude,
            visible,
            inCentralEclipse,
            magnitude: approximateMagnitude(timeMs, startMs, greatestMs, endMs, summary.umbralMagnitude),
        });
    }

    // Same fencepost-safe accounting as the solar version: scale the fraction of visible samples
    // by the real window length rather than crediting each sample a full step.
    const theoreticalDurationSeconds = (endMs - startMs) / 1000;
    const visibleFraction = samples.length > 0 ? visibleCount / samples.length : 0;

    return {
        samples,
        visibleDurationSeconds: visibleFraction * theoreticalDurationSeconds,
        theoreticalDurationSeconds,
        hasCentralPhase: summary.type === 'total',
        centralPhaseVisible,
    };
}
