import { useState } from 'react';
import type { ExportProgress } from '../export/exportPdf';
import { useT } from '../i18n';
import { useEclipseStore } from '../state/eclipseStore';

/** Floats over the map area (like the view-toggle bar it sits opposite to) rather than living in
 *  the sidebar, since it exports every currently-loaded view's map, not just whichever one the
 *  sidebar's other panels are currently talking about. */
export function ExportButton() {
    const t = useT();
    const selectedDate = useEclipseStore((s) => s.selectedDate);
    const isExporting = useEclipseStore((s) => s.isExporting);
    const setExporting = useEclipseStore((s) => s.setExporting);
    const [progress, setProgress] = useState<ExportProgress | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [warning, setWarning] = useState<string | null>(null);

    async function handleExport() {
        // Lives in the store (not local state) so EclipseSelector can disable itself for the
        // duration — exportEclipsePdf snapshots selectedDate/summary/path once at the start and
        // runs for a while, so switching eclipses mid-export would mix the old snapshot with the
        // live map's new content on whichever pages hadn't been captured yet.
        setExporting(true);
        setError(null);
        setWarning(null);
        setProgress({ stage: t('export.preparing'), fraction: 0 });
        try {
            const { exportEclipsePdf } = await import('../export/exportPdf');
            const { skipped } = await exportEclipsePdf(setProgress);
            if (skipped.length > 0) {
                setWarning(t('export.skippedWarning', { views: skipped }));
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setExporting(false);
            setProgress(null);
        }
    }

    if (!selectedDate) return null;

    return (
        <div className="export-control">
            <button type="button" className="export-button" onClick={() => void handleExport()} disabled={isExporting}>
                {isExporting ? t('export.inProgress') : t('export.button')}
            </button>
            {isExporting && progress && (
                <div className="export-progress">
                    <div className="export-progress-bar">
                        <div className="export-progress-fill" style={{ width: `${Math.round(progress.fraction * 100)}%` }} />
                    </div>
                    <div className="export-progress-label">{progress.stage}</div>
                </div>
            )}
            {error && <div className="export-error">{error}</div>}
            {!error && warning && <div className="export-warning">{warning}</div>}
        </div>
    );
}
