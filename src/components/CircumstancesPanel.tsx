import { buildPeakfinderUrl } from '../engine/peakfinderLink';
import { formatLocalTime, getTimeZone } from '../engine/timezone';
import { useT } from '../i18n';
import { lunarTypeLabel, solarTypeLabel } from '../i18n/labels';
import { useEclipseStore } from '../state/eclipseStore';
import { HorizonChart } from './HorizonChart';
import { WeatherSection } from './WeatherSection';

/** Local wall-clock time at the given place, e.g. "19:47:00 UTC+2". */
function formatAt(date: Date, lat: number, lon: number): string {
    return formatLocalTime(date, getTimeZone(lat, lon));
}

function formatDuration(seconds: number): string {
    // Round the total first: rounding minutes and seconds independently can print "1m 60s"
    // whenever the leftover seconds are within half a second of rolling over.
    const total = Math.round(seconds);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}m ${s.toString().padStart(2, '0')}s`;
}

export function CircumstancesPanel() {
    const t = useT();
    const eclipseMode = useEclipseStore((s) => s.eclipseMode);
    const summary = useEclipseStore((s) => s.summary);
    const loading = useEclipseStore((s) => s.loading);
    const error = useEclipseStore((s) => s.error);
    const selectedPoint = useEclipseStore((s) => s.selectedPoint);
    const local = useEclipseStore((s) => s.localCircumstances);
    const pointOutsideEclipse = useEclipseStore((s) => s.pointOutsideEclipse);
    const horizonProfile = useEclipseStore((s) => s.horizonProfile);
    const terrainVisibility = useEclipseStore((s) => s.terrainVisibility);
    const terrainLoading = useEclipseStore((s) => s.terrainLoading);
    const terrainError = useEclipseStore((s) => s.terrainError);
    // Still needed outside the weather block: the panel distinguishes "still loading" from
    // "couldn't resolve this point at all", and a weather failure counts toward the latter.
    const weatherError = useEclipseStore((s) => s.weatherError);
    const sunPositionAtTotality = useEclipseStore((s) => s.sunPositionAtTotality);
    const comparisonEntries = useEclipseStore((s) => s.comparisonEntries);
    const addCurrentPointToComparison = useEclipseStore((s) => s.addCurrentPointToComparison);

    if (loading) return <div className="panel">{t('panel.loading')}</div>;
    if (error) return <div className="panel panel-error">{t('panel.error', { message: error })}</div>;

    if (eclipseMode === 'lunar') {
        return <LunarCircumstances />;
    }

    if (!summary) return null;

    // `local.type === 'none'` is a real, distinct state from `pointOutsideEclipse`: the point is
    // close enough to the penumbra that getLocalEclipse doesn't throw, but the library still
    // finds no actual contact there (e.g. right at the ragged edge). Both mean the same thing to
    // the user — no eclipse here — and neither should show terrain/weather sections meant for a
    // place that actually sees some part of the eclipse.
    const noEclipseHere = pointOutsideEclipse || local?.type === 'none';
    const hasEclipseHere = !!local && !noEclipseHere;

    return (
        <div className="panel">
            <h2>{solarTypeLabel(t, summary.type)}</h2>
            <dl>
                <dt>{t('panel.saros')}</dt>
                <dd>{summary.saros}</dd>
                <dt>{t('panel.greatestEclipse')}</dt>
                <dd>{formatAt(summary.greatestEclipse.time, summary.greatestEclipse.lat, summary.greatestEclipse.lon)}</dd>
                <dt>{t('panel.maxMagnitude')}</dt>
                <dd>{summary.magnitude.toFixed(3)}</dd>
                <dt>{t('panel.pathWidth')}</dt>
                <dd>{(summary.umbraPathWidthMeters / 1000).toFixed(0)} km</dd>
                <dt>{t('panel.maxCentralDuration')}</dt>
                <dd>{formatDuration(summary.maxCentralDurationSeconds)}</dd>
            </dl>
            <p className="hint">{t('panel.localTimeNote')}</p>

            <h3>{t('panel.selectedPlace')}</h3>
            {!selectedPoint && <p className="hint">{t('panel.clickToSee')}</p>}
            {selectedPoint && noEclipseHere && (
                <p className="hint">{t('panel.notVisibleAt', { lat: selectedPoint.lat.toFixed(3), lon: selectedPoint.lon.toFixed(3) })}</p>
            )}
            {selectedPoint && !local && !pointOutsideEclipse && !terrainError && !weatherError && (
                <p className="hint">{t('panel.computingShort')}</p>
            )}
            {selectedPoint && !local && !pointOutsideEclipse && (terrainError || weatherError) && (
                <p className="hint">{t('panel.localLoadFailed')}</p>
            )}
            {selectedPoint && hasEclipseHere && (
                <>
                    {(() => {
                        const alreadyPinned = comparisonEntries.some((e) => e.point.lat === selectedPoint.lat && e.point.lon === selectedPoint.lon);
                        const full = comparisonEntries.length >= 3;
                        return (
                            <button type="button" className="pin-button" disabled={alreadyPinned || full} onClick={addCurrentPointToComparison}>
                                {alreadyPinned ? t('panel.alreadyPinned') : full ? t('panel.comparisonFull') : t('panel.pin')}
                            </button>
                        );
                    })()}
                    <dl>
                        <dt>{t('panel.coordinates')}</dt>
                        <dd>
                            {selectedPoint.lat.toFixed(3)}, {selectedPoint.lon.toFixed(3)}
                        </dd>
                        <dt>{t('panel.timezone')}</dt>
                        <dd>{getTimeZone(selectedPoint.lat, selectedPoint.lon)}</dd>
                        <dt>{t('panel.localType')}</dt>
                        <dd>{solarTypeLabel(t, local.type)}</dd>
                        {local.contactTimes && (
                            <>
                                <dt>{t('panel.c1')}</dt>
                                <dd>{formatAt(local.contactTimes.c1, selectedPoint.lat, selectedPoint.lon)}</dd>
                                {local.contactTimes.c2 && (
                                    <>
                                        <dt>{t('panel.c2')}</dt>
                                        <dd>{formatAt(local.contactTimes.c2, selectedPoint.lat, selectedPoint.lon)}</dd>
                                    </>
                                )}
                                <dt>{t('panel.max')}</dt>
                                <dd>{formatAt(local.contactTimes.max, selectedPoint.lat, selectedPoint.lon)}</dd>
                                {local.contactTimes.c3 && (
                                    <>
                                        <dt>{t('panel.c3')}</dt>
                                        <dd>{formatAt(local.contactTimes.c3, selectedPoint.lat, selectedPoint.lon)}</dd>
                                    </>
                                )}
                                <dt>{t('panel.c4')}</dt>
                                <dd>{formatAt(local.contactTimes.c4, selectedPoint.lat, selectedPoint.lon)}</dd>
                            </>
                        )}
                        <dt>{t('panel.localMagnitude')}</dt>
                        <dd>{local.maxMagnitude.toFixed(3)}</dd>
                        {local.centralDurationSeconds > 0 && (
                            <>
                                <dt>{t('panel.centralDuration')}</dt>
                                <dd>{formatDuration(local.centralDurationSeconds)}</dd>
                            </>
                        )}
                    </dl>
                </>
            )}

            {selectedPoint && hasEclipseHere && (
                <>
                    <h3>{t('panel.terrainHeading')}</h3>
                    {terrainLoading && <p className="hint">{t('panel.terrainLoading')}</p>}
                    {!terrainLoading && terrainError && <p className="hint">{t('panel.terrainError')}</p>}
                    {!terrainLoading && horizonProfile && terrainVisibility && (
                        <>
                            <dl>
                                <dt>{t('panel.visibleDuration')}</dt>
                                <dd>
                                    {formatDuration(terrainVisibility.visibleDurationSeconds)} /{' '}
                                    {formatDuration(terrainVisibility.theoreticalDurationSeconds)}
                                </dd>
                            </dl>
                            {terrainVisibility.hasCentralPhase && (
                                <span className={`visibility-badge ${terrainVisibility.centralPhaseVisible ? 'ok' : 'blocked'}`}>
                                    {terrainVisibility.centralPhaseVisible ? t('panel.centralClear') : t('panel.centralBlocked')}
                                </span>
                            )}
                            <HorizonChart
                                horizonProfile={horizonProfile}
                                samples={terrainVisibility.samples}
                                timeZone={getTimeZone(selectedPoint.lat, selectedPoint.lon)}
                            />
                        </>
                    )}
                    {sunPositionAtTotality && (
                        <p className="hint">
                            <a
                                href={buildPeakfinderUrl({
                                    lat: selectedPoint.lat,
                                    lon: selectedPoint.lon,
                                    azimuth: sunPositionAtTotality.azimuth,
                                    altitude: sunPositionAtTotality.altitude,
                                    time: sunPositionAtTotality.time,
                                    name: t('panel.peakfinderName', { date: summary.date }),
                                })}
                                target="_blank"
                                rel="noopener noreferrer"
                            >
                                {t('panel.peakfinderLink')}
                            </a>
                            {' — '}
                            {t('panel.peakfinderDetail', {
                                azimuth: sunPositionAtTotality.azimuth.toFixed(0),
                                altitude: sunPositionAtTotality.altitude.toFixed(0),
                                central: !!local?.contactTimes?.c2,
                            })}
                        </p>
                    )}
                </>
            )}

            {selectedPoint && hasEclipseHere && <WeatherSection />}
        </div>
    );
}

/** Lunar circumstances panel. The structure differs from the solar one in a way that matters: the
 *  contact times are *global*, so they sit above the selected-point section rather than inside it,
 *  and the only per-point questions are whether the Moon clears the local terrain and what the sky
 *  is likely to be doing. */
function LunarCircumstances() {
    const t = useT();
    const lunarSummary = useEclipseStore((s) => s.lunarSummary);
    const selectedPoint = useEclipseStore((s) => s.selectedPoint);
    const horizonProfile = useEclipseStore((s) => s.horizonProfile);
    const terrainVisibility = useEclipseStore((s) => s.terrainVisibility);
    const terrainLoading = useEclipseStore((s) => s.terrainLoading);
    const terrainError = useEclipseStore((s) => s.terrainError);
    const sunPositionAtTotality = useEclipseStore((s) => s.sunPositionAtTotality);

    if (!lunarSummary) return null;
    const { contacts, type, umbralMagnitude } = lunarSummary;
    const tz = selectedPoint ? getTimeZone(selectedPoint.lat, selectedPoint.lon) : 'UTC';
    const at = (d: Date) => formatLocalTime(d, tz);

    return (
        <div className="panel">
            <h2>{t('lunar.heading', { type: lunarTypeLabel(t, type) })}</h2>
            <dl>
                <dt>{t('lunar.p1')}</dt>
                <dd>{at(contacts.p1)}</dd>
                {contacts.u1 && (
                    <>
                        <dt>{t('lunar.u1')}</dt>
                        <dd>{at(contacts.u1)}</dd>
                    </>
                )}
                {contacts.u2 && (
                    <>
                        <dt>{t('lunar.u2')}</dt>
                        <dd>{at(contacts.u2)}</dd>
                    </>
                )}
                <dt>{t('panel.max')}</dt>
                <dd>{at(contacts.greatest)}</dd>
                {contacts.u3 && (
                    <>
                        <dt>{t('lunar.u3')}</dt>
                        <dd>{at(contacts.u3)}</dd>
                    </>
                )}
                {contacts.u4 && (
                    <>
                        <dt>{t('lunar.u4')}</dt>
                        <dd>{at(contacts.u4)}</dd>
                    </>
                )}
                <dt>{t('lunar.p4')}</dt>
                <dd>{at(contacts.p4)}</dd>
                <dt>{t('lunar.umbralMagnitude')}</dt>
                <dd>{umbralMagnitude.toFixed(3)}</dd>
            </dl>
            <p className="hint">{t('lunar.globalNote', { hasPoint: !!selectedPoint })}</p>

            <h3>{t('panel.selectedPlace')}</h3>
            {!selectedPoint && <p className="hint">{t('lunar.clickToSee')}</p>}
            {selectedPoint && (
                <>
                    <dl>
                        <dt>{t('panel.coordinates')}</dt>
                        <dd>
                            {selectedPoint.lat.toFixed(3)}, {selectedPoint.lon.toFixed(3)}
                        </dd>
                        <dt>{t('panel.timezone')}</dt>
                        <dd>{getTimeZone(selectedPoint.lat, selectedPoint.lon)}</dd>
                    </dl>

                    <h3>{t('panel.terrainHeading')}</h3>
                    {terrainLoading && <p className="hint">{t('panel.terrainLoading')}</p>}
                    {!terrainLoading && terrainError && <p className="hint">{t('panel.terrainError')}</p>}
                    {!terrainLoading && horizonProfile && terrainVisibility && (
                        <>
                            <dl>
                                <dt>{t('panel.visibleDuration')}</dt>
                                <dd>
                                    {formatDuration(terrainVisibility.visibleDurationSeconds)} /{' '}
                                    {formatDuration(terrainVisibility.theoreticalDurationSeconds)}
                                </dd>
                            </dl>
                            {terrainVisibility.visibleDurationSeconds === 0 ? (
                                <span className="visibility-badge blocked">{t('lunar.moonBelowAll')}</span>
                            ) : terrainVisibility.hasCentralPhase ? (
                                <span className={`visibility-badge ${terrainVisibility.centralPhaseVisible ? 'ok' : 'blocked'}`}>
                                    {terrainVisibility.centralPhaseVisible ? t('lunar.totalityVisible') : t('lunar.totalityNotVisible')}
                                </span>
                            ) : null}
                            <HorizonChart
                                horizonProfile={horizonProfile}
                                samples={terrainVisibility.samples}
                                timeZone={getTimeZone(selectedPoint.lat, selectedPoint.lon)}
                                body="moon"
                            />
                        </>
                    )}
                    {sunPositionAtTotality && (
                        <p className="hint">
                            <a
                                href={buildPeakfinderUrl({
                                    lat: selectedPoint.lat,
                                    lon: selectedPoint.lon,
                                    azimuth: sunPositionAtTotality.azimuth,
                                    altitude: sunPositionAtTotality.altitude,
                                    time: sunPositionAtTotality.time,
                                    name: t('lunar.peakfinderName', { date: lunarSummary.date }),
                                })}
                                target="_blank"
                                rel="noopener noreferrer"
                            >
                                {t('panel.peakfinderLink')}
                            </a>
                            {' — '}
                            {t('lunar.peakfinderDetail', {
                                azimuth: sunPositionAtTotality.azimuth.toFixed(0),
                                altitude: sunPositionAtTotality.altitude.toFixed(0),
                            })}
                        </p>
                    )}

                    <WeatherSection />
                </>
            )}
        </div>
    );
}
