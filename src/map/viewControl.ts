export type ViewMode = '2d' | 'obstruction' | 'weather' | 'focus' | '3d';

/** Lets the PDF export switch the app's currently-displayed tab (App.tsx registers its own
 *  `setView`/current-view here on mount) — needed because a hidden view's container collapses
 *  to 0×0 (`display:none`), so its map can't be captured or even correctly `.project()`ed
 *  against until it's genuinely on screen again, however briefly. A plain module-level registry
 *  rather than prop-drilling: only the export flow, well outside the normal render tree, needs
 *  this control. */
let setViewFn: ((view: ViewMode) => void) | null = null;
let currentView: ViewMode = '2d';

export function registerViewControl(setView: (view: ViewMode) => void, initialView: ViewMode): void {
    setViewFn = setView;
    currentView = initialView;
}

export function unregisterViewControl(): void {
    setViewFn = null;
}

export function setActiveView(view: ViewMode): void {
    currentView = view;
    setViewFn?.(view);
}

export function getActiveView(): ViewMode {
    return currentView;
}
