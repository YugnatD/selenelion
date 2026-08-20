import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import './App.css';
import { BestPointsPanel } from './components/BestPointsPanel';
import { CircumstancesPanel } from './components/CircumstancesPanel';
import { ComparisonPanel } from './components/ComparisonPanel';
import { EclipseSelector } from './components/EclipseSelector';
import { ExportButton } from './components/ExportButton';
import { EclipseMap } from './map/EclipseMap';
import { FocusMap } from './map/FocusMap';
import { ObstructionMap } from './map/ObstructionMap';
import { registerViewControl, unregisterViewControl } from './map/viewControl';
import type { ViewMode } from './map/viewControl';
import { WeatherMap } from './map/WeatherMap';
import { useEclipseStore } from './state/eclipseStore';
import type { StringKey } from './i18n';
import { useT } from './i18n';
import { LanguageSwitcher } from './components/LanguageSwitcher';

// Three.js is a sizeable chunk of the app's bundle, and the 3D tab is opt-in — most sessions
// never touch it (the default view is the 2D map). Splitting it out means everyone else's
// first load doesn't pay to download/parse/evaluate a WebGL engine they may never use.
const Scene3DPanel = lazy(() => import('./components/Scene3DPanel').then((m) => ({ default: m.Scene3DPanel })));

/** Tab ids paired with their translation key — the label itself is resolved at render time so a
 *  language switch re-labels the bar without remounting any view. */
const VIEWS = [
    { id: '2d', labelKey: 'view.2d' },
    { id: 'obstruction', labelKey: 'view.obstruction' },
    { id: 'weather', labelKey: 'view.weather' },
    { id: 'focus', labelKey: 'view.focus' },
    { id: '3d', labelKey: 'view.3d' },
] as const satisfies ReadonlyArray<{ id: ViewMode; labelKey: StringKey }>;

/** Views mounted lazily (only once first opened), then kept alive so switching back doesn't
 *  reset their state or recompute from scratch. '2d' mounts immediately since it's the default.
 *  '3d' is deliberately NOT in this list: it runs a continuous WebGL render loop, so keeping it
 *  mounted-but-hidden would keep burning GPU/CPU on an invisible scene instead of freeing it —
 *  unmounting (and recomputing the terrain mesh on return) is the better trade-off there. */
const LAZY_VIEWS: ViewMode[] = ['obstruction', 'weather', 'focus'];

function App() {
    const t = useT();
    const init = useEclipseStore((s) => s.init);
    const isExporting = useEclipseStore((s) => s.isExporting);
    const [view, setView] = useState<ViewMode>('2d');
    const [mountedViews, setMountedViews] = useState<Set<ViewMode>>(new Set(['2d']));
    const didInit = useRef(false);

    useEffect(() => {
        // StrictMode double-invokes effects in dev, which would otherwise run init() (and the
        // whole 1900-2100 eclipse catalogue classification it kicks off) twice on every load.
        if (didInit.current) return;
        didInit.current = true;
        init();
    }, [init]);

    useEffect(() => {
        if (!mountedViews.has(view)) {
            setMountedViews((prev) => new Set(prev).add(view));
        }
    }, [view, mountedViews]);

    // Lets the PDF export switch tabs on the app's behalf (see viewControl.ts) — a hidden view's
    // map can't be captured until it's genuinely on screen again.
    useEffect(() => {
        registerViewControl(setView, view);
        return () => unregisterViewControl();
    }, [view]);

    return (
        <div className="app-layout">
            <aside className="sidebar">
                <h1>Selenelion</h1>
                <LanguageSwitcher />
                <EclipseSelector />
                <BestPointsPanel />
                <ComparisonPanel />
                <CircumstancesPanel />
            </aside>
            <main className="map-container">
                <div className="view-toggle">
                    {VIEWS.map((v) => (
                        <button
                            key={v.id}
                            type="button"
                            className={view === v.id ? 'active' : ''}
                            onClick={() => setView(v.id)}
                            disabled={isExporting}
                            title={isExporting ? t('view.lockedDuringExport') : undefined}
                        >
                            {t(v.labelKey)}
                        </button>
                    ))}
                </div>
                <ExportButton />
                <div style={{ display: view === '2d' ? 'contents' : 'none' }}>
                    <EclipseMap />
                </div>
                {LAZY_VIEWS.map(
                    (v) =>
                        mountedViews.has(v) && (
                            <div key={v} style={{ display: view === v ? 'contents' : 'none' }}>
                                {v === 'obstruction' && <ObstructionMap visible={view === v} />}
                                {v === 'weather' && <WeatherMap visible={view === v} />}
                                {v === 'focus' && <FocusMap visible={view === v} />}
                            </div>
                        ),
                )}
                {view === '3d' && (
                    <Suspense fallback={<div className="scene3d-placeholder">{t('scene3d.loading')}</div>}>
                        <Scene3DPanel />
                    </Suspense>
                )}
            </main>
        </div>
    );
}

export default App;
