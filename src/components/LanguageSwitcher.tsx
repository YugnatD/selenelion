import { LANG_LABELS, LANGS, useLangStore, useT } from '../i18n';
import { useEclipseStore } from '../state/eclipseStore';

/**
 * English / Français toggle. Sits at the very top of the sidebar rather than behind a settings
 * menu: someone who lands on a language they cannot read needs to find it without reading anything,
 * and each button is labelled in its own language for exactly that reason.
 */
export function LanguageSwitcher() {
    const t = useT();
    const lang = useLangStore((s) => s.lang);
    const setLang = useLangStore((s) => s.setLang);
    // A PDF export snapshots strings page by page as it runs, so switching language halfway
    // through would produce a document in two languages.
    const isExporting = useEclipseStore((s) => s.isExporting);

    return (
        <div className="day-window-toggle lang-switcher" role="group" aria-label={t('lang.label')}>
            {LANGS.map((code) => (
                <button
                    key={code}
                    type="button"
                    lang={code}
                    className={lang === code ? 'active' : ''}
                    disabled={isExporting}
                    aria-pressed={lang === code}
                    onClick={() => setLang(code)}
                >
                    {LANG_LABELS[code]}
                </button>
            ))}
        </div>
    );
}
