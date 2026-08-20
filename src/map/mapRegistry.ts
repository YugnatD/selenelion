import type { MapLibreMap } from 'maplibre-gl';

/** The map views the PDF export can capture. Each of EclipseMap/ObstructionMap/WeatherMap/
 *  FocusMap registers its own live MapLibre instance here on mount and unregisters on unmount —
 *  a plain module-level registry (not Zustand state) since these are imperative WebGL handles,
 *  not serializable app state, and nothing should re-render when one changes. '3d' isn't here:
 *  the Three.js scene is a fundamentally different renderer with no MapLibre instance to grab. */
export type ExportableView = '2d' | 'obstruction' | 'weather' | 'focus';

const registry = new Map<ExportableView, MapLibreMap>();

export function registerExportableMap(id: ExportableView, map: MapLibreMap): void {
    registry.set(id, map);
}

export function unregisterExportableMap(id: ExportableView): void {
    registry.delete(id);
}

export function getExportableMap(id: ExportableView): MapLibreMap | undefined {
    return registry.get(id);
}
