import { useT } from '../i18n';
import { useEclipseStore } from '../state/eclipseStore';

/** Button + ranked list: samples points along the eclipse's central line, drops any that land in
 *  open water (via an elevation-based land/water heuristic) or where terrain blocks the central
 *  phase, and ranks the remaining candidates by climatology cloud cover — see
 *  findBestPointsAlongPath. Uses whatever weatherDayWindow/weatherTimeMode are currently
 *  selected. */
export function BestPointsPanel() {
    const t = useT();
    const eclipseMode = useEclipseStore((s) => s.eclipseMode);
    const path = useEclipseStore((s) => s.path);
    const bestPointsAlongPath = useEclipseStore((s) => s.bestPointsAlongPath);
    const bestPointsLoading = useEclipseStore((s) => s.bestPointsLoading);
    const findBestPointsAlongPath = useEclipseStore((s) => s.findBestPointsAlongPath);
    const selectPoint = useEclipseStore((s) => s.selectPoint);

    // No central line to search along for a lunar eclipse — it has no path at all.
    if (eclipseMode === 'lunar' || !path?.centralLine) return null;

    return (
        <div className="panel best-points-panel">
            <h3>{t('best.heading')}</h3>
            {!bestPointsLoading && (
                <button type="button" className="best-points-search" onClick={() => void findBestPointsAlongPath()}>
                    {bestPointsAlongPath ? t('best.searchAgain') : t('best.search')}
                </button>
            )}
            {bestPointsLoading && <p className="hint">{t('best.loading')}</p>}
            {!bestPointsLoading && bestPointsAlongPath && bestPointsAlongPath.length === 0 && (
                <p className="hint">{t('best.none')}</p>
            )}
            {!bestPointsLoading && bestPointsAlongPath && bestPointsAlongPath.length > 0 && (
                <ol className="best-points-list">
                    {bestPointsAlongPath.map((candidate, i) => (
                        <li key={`${candidate.point.lat},${candidate.point.lon}`}>
                            <button type="button" onClick={() => selectPoint(candidate.point)}>
                                <span className="best-points-rank">#{i + 1}</span>
                                <span>
                                    {t('best.item', {
                                        lat: candidate.point.lat.toFixed(2),
                                        lon: candidate.point.lon.toFixed(2),
                                        cloud: Math.round(candidate.cloudCoverPercent),
                                        magnitude: candidate.magnitude.toFixed(2),
                                        visible: Math.round(candidate.visibleFraction * 100),
                                    })}
                                </span>
                            </button>
                        </li>
                    ))}
                </ol>
            )}
            {!bestPointsLoading && bestPointsAlongPath && bestPointsAlongPath.length > 0 && (
                <p className="hint">{t('best.note')}</p>
            )}
        </div>
    );
}
