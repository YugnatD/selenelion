import { create } from 'zustand';
import type { Dict, StringKey } from './strings';
import { EN, FR } from './strings';

export type { StringKey } from './strings';

export type Lang = 'en' | 'fr';
export const LANGS: Lang[] = ['en', 'fr'];

/** Shown in the language switcher. Each language names itself, so a reader who cannot read the
 *  current UI language can still find their own. */
export const LANG_LABELS: Record<Lang, string> = { en: 'English', fr: 'Français' };

const STORAGE_KEY = 'eclipse-planner.lang';

/**
 * English is the default, unconditionally — deliberately *not* sniffed from `navigator.language`.
 * The app is published for an international audience, so a first-time visitor anywhere should land
 * on the same page; auto-switching would also make the default depend on the reader's browser
 * settings, which is exactly the kind of thing that makes a shared link show two different things
 * to two people. A reader who picks French keeps it, on this browser, until they change it back.
 */
function initialLang(): Lang {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored === 'en' || stored === 'fr') return stored;
    } catch {
        // Private mode / storage disabled — fall through to the default rather than failing to boot.
    }
    return 'en';
}

/** BCP 47 tag for Intl formatters. `en-GB` rather than `en-US` so English keeps the 24-hour clock
 *  the whole app is built around (contact times, chart axes, the 3D scrubber) instead of switching
 *  half the readouts to AM/PM while the rest stay 24h. */
export function localeTag(lang: Lang): string {
    return lang === 'fr' ? 'fr-FR' : 'en-GB';
}

interface LangState {
    lang: Lang;
    setLang: (lang: Lang) => void;
}

export const useLangStore = create<LangState>((set) => ({
    lang: initialLang(),
    setLang: (lang: Lang) => {
        try {
            localStorage.setItem(STORAGE_KEY, lang);
        } catch {
            // Not being able to remember the choice is not a reason to refuse to apply it.
        }
        document.documentElement.lang = lang;
        set({ lang });
    },
}));

// Keep the document in sync from the very first paint, so screen readers and the browser's own
// translation prompt see the right language rather than whatever index.html was authored in.
if (typeof document !== 'undefined') document.documentElement.lang = useLangStore.getState().lang;

type ParamsOf<K extends StringKey> = Dict[K] extends (p: infer P) => string ? P : never;
type Args<K extends StringKey> = Dict[K] extends (p: never) => string ? [ParamsOf<K>] : [];

export interface TFunction {
    <K extends StringKey>(key: K, ...args: Args<K>): string;
}

function makeT(lang: Lang): TFunction {
    const dict: Dict = lang === 'fr' ? FR : EN;
    return (<K extends StringKey>(key: K, params?: unknown) => {
        const value = dict[key];
        return typeof value === 'function' ? (value as (p: unknown) => string)(params) : (value as string);
    }) as TFunction;
}

// One translator per language, built once: `useT` returns the same function reference for the same
// language on every render, so it is safe in a hook dependency array (a fresh closure per render
// would silently invalidate every useMemo that depends on it).
const TRANSLATORS: Record<Lang, TFunction> = { en: makeT('en'), fr: makeT('fr') };

/** React hook: the translator for the current language, re-rendering the component on change. */
export function useT(): TFunction {
    return TRANSLATORS[useLangStore((s) => s.lang)];
}

export function getLang(): Lang {
    return useLangStore.getState().lang;
}

/** Non-React translator, for code that runs outside the render tree (the PDF export, thrown engine
 *  errors). Reads the current language at call time, so it follows the switcher like everything else. */
export const t: TFunction = (<K extends StringKey>(key: K, ...args: Args<K>) =>
    TRANSLATORS[getLang()](key, ...args)) as TFunction;
