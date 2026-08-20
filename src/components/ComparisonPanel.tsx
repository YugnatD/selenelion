import { useT } from '../i18n';
import { solarTypeLabel } from '../i18n/labels';
import type { ComparisonEntry } from '../state/eclipseStore';
import { useEclipseStore } from '../state/eclipseStore';

function formatDuration(seconds: number): string {
    const total = Math.round(seconds);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}m ${s.toString().padStart(2, '0')}s`;
}

function ComparisonRow({ entry }: { entry: ComparisonEntry }) {
    const t = useT();
    const removeFromComparison = useEclipseStore((s) => s.removeFromComparison);
    const { local, cloudCover, point } = entry;

    return (
        <div className="comparison-row">
            <div className="comparison-row-header">
                <span>
                    {point.lat.toFixed(2)}, {point.lon.toFixed(2)}
                </span>
                <button type="button" className="comparison-remove" onClick={() => removeFromComparison(entry.id)} aria-label={t('comparison.remove')}>
                    ×
                </button>
            </div>
            <dl className="comparison-row-stats">
                <dt>{t('comparison.type')}</dt>
                <dd>{solarTypeLabel(t, local.type)}</dd>
                <dt>{t('comparison.magnitude')}</dt>
                <dd>{local.maxMagnitude.toFixed(3)}</dd>
                {local.centralDurationSeconds > 0 && (
                    <>
                        <dt>{t('comparison.centrality')}</dt>
                        <dd>{formatDuration(local.centralDurationSeconds)}</dd>
                    </>
                )}
                <dt>{t('comparison.cloudCover')}</dt>
                <dd>{cloudCover ? `${Math.round(cloudCover.percent)}%` : '—'}</dd>
            </dl>
        </div>
    );
}

/** Up to 3 pinned points shown side by side — snapshots of what was loaded when each was
 *  pinned (see addCurrentPointToComparison), not live-updating. */
export function ComparisonPanel() {
    const t = useT();
    const comparisonEntries = useEclipseStore((s) => s.comparisonEntries);
    if (comparisonEntries.length === 0) return null;

    return (
        <div className="panel comparison-panel">
            <h3>{t('comparison.heading')}</h3>
            {comparisonEntries.map((entry) => (
                <ComparisonRow key={entry.id} entry={entry} />
            ))}
        </div>
    );
}
