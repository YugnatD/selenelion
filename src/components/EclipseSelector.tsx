import { useT } from '../i18n';
import { lunarTypeLabel, solarTypeLabel } from '../i18n/labels';
import { useEclipseStore } from '../state/eclipseStore';

export function EclipseSelector() {
    const t = useT();
    const eclipseMode = useEclipseStore((s) => s.eclipseMode);
    const setEclipseMode = useEclipseStore((s) => s.setEclipseMode);
    const eclipses = useEclipseStore((s) => s.eclipses);
    const lunarEclipses = useEclipseStore((s) => s.lunarEclipses);
    const selectedDate = useEclipseStore((s) => s.selectedDate);
    const selectEclipse = useEclipseStore((s) => s.selectEclipse);
    const selectLunarEclipse = useEclipseStore((s) => s.selectLunarEclipse);
    const isExporting = useEclipseStore((s) => s.isExporting);
    const loading = useEclipseStore((s) => s.loading);

    const lunar = eclipseMode === 'lunar';
    const options = lunar
        ? lunarEclipses.map(({ date, type }) => ({ date, label: lunarTypeLabel(t, type) }))
        : eclipses.map(({ date, type }) => ({ date, label: solarTypeLabel(t, type) }));

    return (
        <div className="eclipse-selector">
            <div className="day-window-toggle" role="group" aria-label={t('selector.modeGroup')}>
                <button type="button" className={lunar ? '' : 'active'} disabled={isExporting} onClick={() => setEclipseMode('solar')}>
                    {t('selector.solar')}
                </button>
                <button type="button" className={lunar ? 'active' : ''} disabled={isExporting} onClick={() => setEclipseMode('lunar')}>
                    {t('selector.lunar')}
                </button>
            </div>

            <label htmlFor="eclipse-date">{t('selector.label')}</label>
            <select
                id="eclipse-date"
                value={selectedDate ?? ''}
                onChange={(e) => void (lunar ? selectLunarEclipse(e.target.value) : selectEclipse(e.target.value))}
                disabled={isExporting || (lunar && options.length === 0)}
                title={isExporting ? t('selector.lockedDuringExport') : undefined}
            >
                {options.length === 0 && <option value="">{loading ? t('selector.computingLunar') : t('selector.empty')}</option>}
                {options.map(({ date, label }) => (
                    <option key={date} value={date}>
                        {date} — {label}
                    </option>
                ))}
            </select>
        </div>
    );
}
