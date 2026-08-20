import { useMemo } from 'react';
import { formatLocalTimeShort, getTimeZone } from '../engine/timezone';
import { useT } from '../i18n';
import { Scene3D } from '../scene3d/Scene3D';
import { useEclipseStore } from '../state/eclipseStore';
import type { EclipseVisibilityResult } from '../terrain/visibility';

/** Which sample has the greatest magnitude — the true moment of closest approach, which isn't
 *  necessarily at the time-midpoint between first and last contact (contact times are rarely
 *  symmetric around it, especially off the central line). Scene3D needs to flip the Moon's
 *  crossing side exactly here, not at the naive index midpoint. */
function peakMagnitudeIndex(samples: EclipseVisibilityResult['samples']): number {
    let best = 0;
    for (let i = 1; i < samples.length; i++) {
        // i is bounded by samples.length via the loop condition, and best only ever takes on
        // prior values of i (or the initial 0, valid whenever the loop body runs) — both indices
        // are always in range.
        if (samples[i]!.magnitude > samples[best]!.magnitude) best = i;
    }
    return best;
}

/** Maps the current sample index to a 0-1 progress value anchored at the true peak-magnitude
 *  index (0.5) rather than the array's own midpoint, so Scene3D's `progress < 0.5` side check
 *  flips at the geometrically correct moment even when contact times are asymmetric. */
function progressRelativeToPeak(index: number, peakIndex: number, lastIndex: number): number {
    if (lastIndex <= 0) return 0.5;
    if (index <= peakIndex) return peakIndex <= 0 ? 0 : (index / peakIndex) * 0.5;
    const after = lastIndex - peakIndex;
    return after <= 0 ? 1 : 0.5 + ((index - peakIndex) / after) * 0.5;
}

export function Scene3DPanel() {
    const t = useT();
    const selectedPoint = useEclipseStore((s) => s.selectedPoint);
    const pointOutsideEclipse = useEclipseStore((s) => s.pointOutsideEclipse);
    const terrainVisibility = useEclipseStore((s) => s.terrainVisibility);
    const terrainLoading = useEclipseStore((s) => s.terrainLoading);
    const terrainError = useEclipseStore((s) => s.terrainError);
    const eclipseMode = useEclipseStore((s) => s.eclipseMode);
    const sceneTimeIndex = useEclipseStore((s) => s.sceneTimeIndex);
    const setSceneTimeIndex = useEclipseStore((s) => s.setSceneTimeIndex);

    // Only depends on terrainVisibility, not sceneTimeIndex — without this memo, dragging the
    // time slider (which changes sceneTimeIndex on every tick) would re-scan the whole samples
    // array each time for a result that hasn't changed since the terrain was last computed.
    const peakIndex = useMemo(
        () => (terrainVisibility ? peakMagnitudeIndex(terrainVisibility.samples) : 0),
        [terrainVisibility],
    );

    if (!selectedPoint) {
        return <div className="scene3d-placeholder">{t('scene3d.selectPoint')}</div>;
    }
    // None of these ever produces a terrainVisibility, so without checking them explicitly the
    // final fallback ("Analyse du relief…") would show forever instead of explaining why there's
    // nothing to render.
    if (pointOutsideEclipse) {
        return <div className="scene3d-placeholder">{t('scene3d.notVisible')}</div>;
    }
    if (terrainError) {
        return <div className="scene3d-placeholder">{t('scene3d.terrainError')}</div>;
    }
    if (terrainLoading) {
        return <div className="scene3d-placeholder">{t('scene3d.analysing')}</div>;
    }
    // Loading finished with no error and no "outside the penumbra" exception, yet still no
    // terrainVisibility: computeEclipseVisibility (terrain/visibility.ts) returns null whenever
    // getContactTimes() is null — a point close enough to the edge of the penumbra that
    // getLocalEclipse doesn't throw, but the library still finds no actual contact there. Same
    // "no eclipse here" outcome as pointOutsideEclipse, just reached via a different code path.
    if (!terrainVisibility || terrainVisibility.samples.length === 0) {
        return <div className="scene3d-placeholder">{t('scene3d.notVisible')}</div>;
    }

    // terrainVisibility.samples.length === 0 already returned above, so samples[0] is always
    // defined; sceneTimeIndex itself may be stale/out of range (e.g. right after a new terrain
    // result with fewer samples loads), which is exactly why the `??` fallback exists.
    const sample = terrainVisibility.samples[sceneTimeIndex] ?? terrainVisibility.samples[0]!;
    const timeZone = getTimeZone(selectedPoint.lat, selectedPoint.lon);
    // Visibility is checked *before* centrality, not after: a sample can be in the central phase
    // and still be nowhere in the sky (the Moon well below the horizon for half the planet during
    // a lunar eclipse; the Sun below it for a sunrise/sunset solar eclipse). Reading "centralité"
    // over a black frame at −53° of altitude was the label lying about what the scene is showing.
    const status = !sample.visible
        ? t(sample.altitude < 0 ? 'scene3d.statusBelowHorizon' : 'scene3d.statusBlocked')
        : t(sample.inCentralEclipse ? 'scene3d.statusCentral' : 'scene3d.statusVisible');

    return (
        <div style={{ position: 'absolute', inset: 0 }}>
            <Scene3D
                mode={eclipseMode}
                lat={selectedPoint.lat}
                lon={selectedPoint.lon}
                sunAzimuth={sample.azimuth}
                sunAltitude={sample.altitude}
                magnitude={sample.magnitude}
                inCentralEclipse={sample.inCentralEclipse}
                progress={progressRelativeToPeak(sceneTimeIndex, peakIndex, terrainVisibility.samples.length - 1)}
            />
            <div className="scene3d-hint">{t(eclipseMode === 'lunar' ? 'scene3d.hintLunar' : 'scene3d.hint')}</div>
            {/* Without this the scene is just a dark frame with the body nowhere in it, which
                reads as a rendering failure. Says which it is instead — and it is the *normal*
                case for a lunar eclipse, where half the planet has the Moon under its feet. */}
            {sample.altitude < 0 && (
                <div className="scene3d-below-horizon">
                    {t('scene3d.belowHorizonNote', { lunar: eclipseMode === 'lunar', altitude: sample.altitude.toFixed(0) })}
                </div>
            )}
            <div className="scene3d-time-control">
                <div className="scene3d-time-readout">
                    {formatLocalTimeShort(sample.time, timeZone)} · {status}
                </div>
                <input
                    type="range"
                    min={0}
                    max={terrainVisibility.samples.length - 1}
                    value={sceneTimeIndex}
                    onChange={(e) => setSceneTimeIndex(Number(e.target.value))}
                />
            </div>
        </div>
    );
}
