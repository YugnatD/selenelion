import { create } from 'zustand';
import type { EclipseListItem } from '../engine/catalogue';
import { listStandardEclipseDates, listStandardEclipsesChunked } from '../engine/catalogue';
import type { EclipsePathGeoJSON, SolarEclipse } from '../engine/eclipse';
import { getPathGeoJSON, loadEclipse, summarizeEclipse } from '../engine/eclipse';
import type { LocalCircumstancesSummary } from '../engine/localCircumstances';
import { getLocalEclipse, getSunPositionAt, summarizeLocal } from '../engine/localCircumstances';
import type { EclipseSummary, LatLon } from '../engine/types';
import type { LunarEclipseListItem, LunarEclipseSummary } from '../engine/lunarEclipse';
import { listLunarEclipses, loadLunarEclipse } from '../engine/lunarEclipse';
import { computeLunarVisibility } from '../terrain/lunarVisibility';
import type { HorizonPoint } from '../terrain/horizon';
import { computeHorizonProfile, ELEVATION_ZOOM } from '../terrain/horizon';
import { getElevation } from '../terrain/elevationTiles';
import type { EclipseVisibilityResult } from '../terrain/visibility';
import { computeEclipseVisibility } from '../terrain/visibility';
import type { CloudCoverEstimate, WeatherTimeMode } from '../weather/weather';
import { getCloudCoverEstimate } from '../weather/weather';
import { getClimatologyYearCurve } from '../weather/climatologyTiles';
import { getClimatologyHourlyDayProfile, getClimatologyHourlyWeekCurve, getClimatologyHourlyYearCurve, hourBucket } from '../weather/climatologyHourlyTiles';

/** A snapshot of one point's key circumstances, pinned for side-by-side comparison — captured
 *  from whatever selectedPoint/localCircumstances/cloudCover already loaded (no separate fetch),
 *  so it reflects exactly what the user was looking at when they pinned it. Doesn't live-update
 *  if weatherDayWindow/weatherTimeMode change afterward — "what I saw when I pinned it", not a
 *  second set of reactive subscriptions to keep in sync for a handful of comparison rows. */
export interface ComparisonEntry {
    id: number;
    point: LatLon;
    local: LocalCircumstancesSummary;
    cloudCover: CloudCoverEstimate | null;
}

const MAX_COMPARISON_ENTRIES = 3;

export type EclipseMode = 'solar' | 'lunar';

interface EclipseStoreState {
    /** Solar and lunar eclipses are different enough that they are separate modes rather than
     *  entries in one list: a lunar eclipse has no path, no umbra polygon and no local contact
     *  times, so several panels and map layers simply do not apply to it (see lunarEclipse.ts). */
    eclipseMode: EclipseMode;
    lunarEclipses: LunarEclipseListItem[];
    /** Circumstances of the selected lunar eclipse — global, identical for every observer. */
    lunarSummary: LunarEclipseSummary | null;

    eclipses: EclipseListItem[];
    selectedDate: string | null;
    summary: EclipseSummary | null;
    path: EclipsePathGeoJSON | null;
    loading: boolean;
    error: string | null;

    selectedPoint: LatLon | null;
    localCircumstances: LocalCircumstancesSummary | null;
    /** True once we've determined the selected point never sees any part of the eclipse. */
    pointOutsideEclipse: boolean;

    horizonProfile: HorizonPoint[] | null;
    terrainVisibility: EclipseVisibilityResult | null;
    terrainLoading: boolean;
    /** Set when the terrain/elevation fetch itself failed (e.g. network issue) — distinct
     *  from pointOutsideEclipse, which means the point legitimately never sees the eclipse. */
    terrainError: string | null;
    /** Index into terrainVisibility.samples currently shown in the 3D view. */
    sceneTimeIndex: number;

    cloudCover: CloudCoverEstimate | null;
    weatherLoading: boolean;
    weatherError: string | null;
    /** 1, 5, or 7 — days averaged together (centered on the reference date) for the climatology
     *  weather estimate, to smooth out single-day noise in the 20-year average. */
    weatherDayWindow: number;
    /** 'day' averages the whole day; 'hour' averages only the 2-hour bucket around the eclipse's
     *  actual reference time, across the same day window — needs the separate, larger hourly
     *  tile set (climatologyHourlyTiles.ts), only fetched for this single selected point. */
    weatherTimeMode: WeatherTimeMode;
    /** The reference time weather was last computed for, so changing weatherDayWindow/weatherTimeMode
     *  can re-fetch for the current point without redoing the whole local-circumstances resolution. */
    weatherReferenceTime: Date | null;
    /** Full 365-day climatology curve at the selected point, for the small seasonal-context
     *  chart — is the eclipse date unusually clear/cloudy here, or a typical day? Doesn't depend
     *  on weatherDayWindow (that only smooths the single headline number), so it's fetched once
     *  per point rather than re-fetched when the window changes. */
    cloudCoverYearCurve: Array<number | null> | null;
    /** Day-by-day (not averaged) cloud cover at the eclipse's actual hour, for the week centered
     *  on the eclipse date — shows the day-to-day trend at that specific hour, as opposed to
     *  weatherDayWindow's single blended number for the same span. Always hour-specific and
     *  always a fixed 7-day span, so unlike cloudCoverYearCurve it doesn't depend on
     *  weatherTimeMode/weatherDayWindow and is only ever fetched once per point selection. */
    cloudCoverWeekCurve: Array<{ dayOffset: number; value: number | null }> | null;
    /** All 12 two-hour buckets for the eclipse's own calendar day — the diurnal profile ("is the
     *  eclipse's hour historically clearer or cloudier than the rest of that day"). Same
     *  fetch-once-per-point-selection treatment as cloudCoverWeekCurve. */
    cloudCoverDayProfile: Array<{ bucket: number; value: number | null }> | null;

    /** Sun's apparent position at the selected point, at the moment of totality/annularity if
     *  this location gets one, otherwise at the moment of greatest (partial) eclipse — used
     *  for the PeakFinder deep link, so it opens already aimed where the eclipsed Sun will be. */
    sunPositionAtTotality: { azimuth: number; altitude: number; time: Date } | null;

    /** Shared camera position between the 2D map and the obstruction map, so switching
     *  between them doesn't reset your position. */
    mapView: { center: [number, number]; zoom: number } | null;

    /** Up to MAX_COMPARISON_ENTRIES pinned points, for side-by-side comparison. */
    comparisonEntries: ComparisonEntry[];

    /** Ranked candidate points along the current eclipse's central line — clearest first among
     *  those that are on land and don't have centrality blocked by terrain, see
     *  findBestPointsAlongPath. */
    bestPointsAlongPath: Array<{
        point: LatLon;
        magnitude: number;
        cloudCoverPercent: number;
        visibleFraction: number;
    }> | null;
    bestPointsLoading: boolean;

    /** True while a PDF export is in progress — exportPdf.ts snapshots selectedDate/summary/path
     *  once at the start and runs for a while (multiple map views, each recomputed at a finer
     *  resolution), so switching to a different eclipse mid-export would mix the old snapshot's
     *  path/labels with the live map's new content. EclipseSelector disables itself on this flag
     *  rather than the export silently producing a page that describes the wrong eclipse. */
    isExporting: boolean;

    /** Whether the Focus view's composite score multiplies in the duration factor. Off answers
     *  "where am I most likely to actually see totality" rather than "where does it last longest"
     *  — see combineQualityScore's includeDuration. Lives in the store rather than FocusMap's own
     *  state because the PDF export reads it too, so an exported page matches what's on screen. */
    focusIncludeDuration: boolean;

    init: () => void;
    selectEclipse: (date: string) => Promise<void>;
    selectPoint: (point: LatLon) => void;
    setSceneTimeIndex: (index: number) => void;
    setMapView: (view: { center: [number, number]; zoom: number }) => void;
    setWeatherDayWindow: (days: number) => void;
    setWeatherTimeMode: (mode: WeatherTimeMode) => void;
    addCurrentPointToComparison: () => void;
    removeFromComparison: (id: number) => void;
    findBestPointsAlongPath: () => Promise<void>;
    setExporting: (value: boolean) => void;
    setFocusIncludeDuration: (value: boolean) => void;
    setEclipseMode: (mode: EclipseMode) => void;
    selectLunarEclipse: (date: string) => Promise<void>;
}

/** Defaults the 3D time scrubber to the most interesting moment: mid-totality if visible, else greatest eclipse. */
function defaultSceneTimeIndex(visibility: EclipseVisibilityResult): number {
    const centralIndices = visibility.samples
        .map((s, i) => (s.inCentralEclipse && s.visible ? i : -1))
        .filter((i) => i >= 0);
    // centralIndices.length > 0 was just checked, and floor(length / 2) is always within
    // [0, length - 1] for a positive length, so this index is always in range.
    if (centralIndices.length > 0) return centralIndices[Math.floor(centralIndices.length / 2)]!;
    return Math.floor(visibility.samples.length / 2);
}

/** Today's date, used to default the picker to upcoming eclipses. */
function today(): string {
    return new Date().toISOString().slice(0, 10);
}

/** Evenly-spaced sample of `count` points from a (typically much longer) central-line
 *  coordinate list, for findBestPointsAlongPath — checking every point on the line (the path
 *  GeoJSON is built at a 20s step, so it can have hundreds of points) would mean hundreds of
 *  climatology lookups for one button click. */
function samplePathPoints(coordinates: GeoJSON.Position[], count: number): LatLon[] {
    if (coordinates.length === 0) return [];
    // Position is plain number[], but every coordinate here comes from the eclipse path's own
    // central-line geometry, always emitted as [lon, lat] pairs.
    if (coordinates.length <= count) return coordinates.map((pos) => ({ lat: pos[1]!, lon: pos[0]! }));
    const step = (coordinates.length - 1) / (count - 1);
    const points: LatLon[] = [];
    for (let i = 0; i < count; i++) {
        // i ranges 0..count-1, so Math.round(i * step) ranges 0..coordinates.length-1 — always
        // in bounds (step is chosen exactly so the last sample lands on the last coordinate).
        const pos = coordinates[Math.round(i * step)]!;
        points.push({ lat: pos[1]!, lon: pos[0]! });
    }
    return points;
}

/** Small LRU: `selectPoint` re-loads the currently selected eclipse on every click (to resolve
 *  local circumstances for the clicked point), even though `selectEclipse` already built the
 *  exact same object moments earlier. Reusing it turns repeated clicks around the map into free
 *  cache hits instead of re-running the Besselian-element interpolation each time. More than one
 *  entry so comparing 2-3 candidate eclipses (switching back and forth) doesn't thrash a
 *  single-entry cache down to zero hits. */
const LOADED_ECLIPSE_CACHE_MAX = 3;
const loadedEclipseCache = new Map<string, Promise<SolarEclipse>>();

function loadEclipseCached(date: string): Promise<SolarEclipse> {
    const cached = loadedEclipseCache.get(date);
    if (cached) {
        // Re-insert so the Map's insertion order (used for LRU eviction below) reflects recency.
        loadedEclipseCache.delete(date);
        loadedEclipseCache.set(date, cached);
        return cached;
    }

    const eclipse = loadEclipse(date).catch((err: unknown) => {
        // Don't cache a failure (transient network/chunk-load issue) forever — evict so the
        // next call for this date retries instead of rejecting indefinitely.
        loadedEclipseCache.delete(date);
        throw err;
    });
    loadedEclipseCache.set(date, eclipse);
    if (loadedEclipseCache.size > LOADED_ECLIPSE_CACHE_MAX) {
        const oldestKey = loadedEclipseCache.keys().next().value;
        if (oldestKey !== undefined) loadedEclipseCache.delete(oldestKey);
    }
    return eclipse;
}

/** Aborted at the start of every selectPoint call, so a burst of clicks around the map cancels
 *  the previous point's still-in-flight weather work instead of leaving it to complete uselessly.
 *  Since the live-forecast path was removed this is belt-and-braces rather than load-bearing —
 *  the climatology tile readers currently ignore the signal, and correctness already rests on the
 *  `isStale()` checks — but the plumbing stays so a future abort-aware source is wired up right. */
let weatherAbortController: AbortController | null = null;

/** Everything about the currently selected point, reset to empty. Selecting a different eclipse
 *  (solar or lunar) or switching mode invalidates every one of these: they were all resolved
 *  against the previous eclipse's geometry and times. Clearing `selectedPoint` alone hides them
 *  from the panels, which is why leaving the rest stale was never visible — but it also meant a
 *  full horizon profile and three climatology curves stayed retained for an eclipse nobody is
 *  looking at, and any future reader that didn't happen to gate on `selectedPoint` would quietly
 *  show one eclipse's numbers under another's heading. */
const CLEARED_POINT_STATE: Partial<EclipseStoreState> = {
    selectedPoint: null,
    localCircumstances: null,
    pointOutsideEclipse: false,
    horizonProfile: null,
    terrainVisibility: null,
    terrainLoading: false,
    terrainError: null,
    cloudCover: null,
    weatherLoading: false,
    weatherError: null,
    weatherReferenceTime: null,
    cloudCoverYearCurve: null,
    cloudCoverWeekCurve: null,
    cloudCoverDayProfile: null,
    sunPositionAtTotality: null,
    comparisonEntries: [],
    bestPointsAlongPath: null,
};

/** The solar eclipse that was selected before switching to lunar mode, so switching back restores
 *  it instead of leaving the app on a lunar date it cannot load Besselian elements for. */
let lastSolarDate: string | null = null;

/** Incremented at the start of every selectEclipse/selectLunarEclipse call, so a late-resolving
 *  load can tell whether it's still the current selection by the time it resolves and skip
 *  applying its result if a newer call has since superseded it (e.g. the user clicking through
 *  several eclipses in quick succession). Currently latent rather than fixing an observed bug —
 *  every load path today resolves synchronously/in a microtask before any further user input can
 *  interleave — but becomes load-bearing the moment an async source (e.g. a future
 *  out-of-range-date dynamic import) is reachable from either function. */
let eclipseSelectionRequestId = 0;

export const useEclipseStore = create<EclipseStoreState>((set, get) => {
    /** Re-fetches both the headline weather figure and the seasonal-context curve for the
     *  currently selected point, using whatever weatherReferenceTime/weatherDayWindow/
     *  weatherTimeMode are current in the store — shared by selectPoint and both setters below,
     *  so a point selection or a settings change all go through the same fetch/abort/error
     *  handling instead of three near-duplicates of it. The curve doesn't actually depend on
     *  weatherDayWindow, so setWeatherDayWindow re-fetching it too is a little redundant, but
     *  it's a tile-cache hit in that case (same tiles the headline fetch just used), not a real
     *  extra network cost — simpler than threading a "skip the curve" flag through for that. */
    function refetchWeatherForCurrentPoint(): AbortController | null {
        const { selectedPoint, weatherReferenceTime, weatherDayWindow, weatherTimeMode } = get();
        if (!selectedPoint || !weatherReferenceTime) return null;

        weatherAbortController?.abort();
        const weatherController = new AbortController();
        weatherAbortController = weatherController;
        const point = selectedPoint;
        // Captured at request-start so a weatherDayWindow/weatherTimeMode change while this
        // request is still in flight is also treated as stale — previously only `selectedPoint`
        // was compared, so two overlapping requests for different windows/modes could race and
        // whichever happened to resolve last would win, regardless of which one the user actually
        // has selected by the time it resolves.
        const requestDayWindow = weatherDayWindow;
        const requestTimeMode = weatherTimeMode;
        const isStale = () => {
            const s = get();
            return s.selectedPoint !== point || s.weatherDayWindow !== requestDayWindow || s.weatherTimeMode !== requestTimeMode;
        };

        set({ weatherLoading: true, weatherError: null });
        void (async () => {
            try {
                const cloudCover = await getCloudCoverEstimate(
                    point.lat,
                    point.lon,
                    weatherReferenceTime,
                    weatherController.signal,
                    weatherDayWindow,
                    weatherTimeMode,
                );
                if (!isStale()) set({ cloudCover, weatherLoading: false });
            } catch (err) {
                if (!isStale() && !(err instanceof DOMException && err.name === 'AbortError')) {
                    set({ weatherLoading: false, weatherError: err instanceof Error ? err.message : String(err) });
                }
            }

            if (isStale()) return;

            // Fetched independently of the headline cloudCover value above, so it's still worth
            // doing even if that one failed — it's the whole-year context curve ("is this
            // date/hour typical for this place?") rather than the single figure. Matches
            // weatherTimeMode so the chart shows the same kind of average ("whole day" vs "around
            // this hour") as the headline figure above it.
            try {
                const curve =
                    weatherTimeMode === 'hour'
                        ? await getClimatologyHourlyYearCurve(point.lat, point.lon, hourBucket(weatherReferenceTime), weatherController.signal)
                        : await getClimatologyYearCurve(point.lat, point.lon, weatherController.signal);
                if (!isStale()) set({ cloudCoverYearCurve: curve });
            } catch {
                // silently leave cloudCoverYearCurve null — the mini-chart just won't render
            }
        })();

        return weatherController;
    }

    return {
    eclipseMode: 'solar',
    lunarEclipses: [],
    lunarSummary: null,
    eclipses: [],
    selectedDate: null,
    summary: null,
    path: null,
    loading: false,
    error: null,
    selectedPoint: null,
    localCircumstances: null,
    pointOutsideEclipse: false,
    horizonProfile: null,
    terrainVisibility: null,
    terrainLoading: false,
    terrainError: null,
    sceneTimeIndex: 0,
    mapView: null,
    comparisonEntries: [],
    bestPointsAlongPath: null,
    bestPointsLoading: false,
    isExporting: false,
    focusIncludeDuration: true,
    cloudCover: null,
    weatherLoading: false,
    weatherError: null,
    weatherDayWindow: 1,
    weatherTimeMode: 'day',
    weatherReferenceTime: null,
    cloudCoverYearCurve: null,
    cloudCoverWeekCurve: null,
    cloudCoverDayProfile: null,
    sunPositionAtTotality: null,

    init: () => {
        const yearStart = `${new Date().getFullYear()}-01-01`;
        const todayStr = today();

        // The plain date list is cheap (no Besselian-element computation), so pick and start
        // loading the default eclipse from it immediately rather than waiting on the full
        // classified list below.
        const dates = listStandardEclipseDates(yearStart);
        const defaultDate = dates.find((d) => d >= todayStr) ?? dates.at(-1);
        if (defaultDate) {
            void get().selectEclipse(defaultDate);
        }

        // The full {date, type} list (only needed for the picker dropdown) is classified in
        // yielding chunks rather than one long synchronous pass over the whole standard range,
        // so it doesn't block the app's very first render to do it.
        void listStandardEclipsesChunked(yearStart)
            .then((eclipses) => set({ eclipses }))
            .catch((err: unknown) => console.error('Failed to build the eclipse picker list:', err));
    },

    selectEclipse: async (date: string) => {
        weatherAbortController?.abort();
        const requestId = ++eclipseSelectionRequestId;
        set({ loading: true, error: null, ...CLEARED_POINT_STATE });
        try {
            const eclipse = await loadEclipseCached(date);
            const summary = summarizeEclipse(date, eclipse);
            const path = getPathGeoJSON(eclipse, { stepsInSeconds: 20 });
            if (requestId !== eclipseSelectionRequestId) return; // a newer selection superseded this one
            set({ selectedDate: date, summary, path, loading: false });
        } catch (err) {
            if (requestId !== eclipseSelectionRequestId) return;
            set({ error: err instanceof Error ? err.message : String(err), loading: false });
        }
    },

    selectPoint: (point: LatLon) => {
        weatherAbortController?.abort();
        const weatherController = new AbortController();
        weatherAbortController = weatherController;

        set({
            selectedPoint: point,
            localCircumstances: null,
            pointOutsideEclipse: false,
            horizonProfile: null,
            terrainVisibility: null,
            terrainLoading: true,
            terrainError: null,
            cloudCover: null,
            weatherLoading: true,
            weatherError: null,
            weatherReferenceTime: null,
            cloudCoverYearCurve: null,
            cloudCoverWeekCurve: null,
            cloudCoverDayProfile: null,
            sunPositionAtTotality: null,
        });
        const { selectedDate, eclipseMode, lunarSummary } = get();
        if (!selectedDate) {
            // Shouldn't normally happen (the map's click handler only attaches after an
            // eclipse is loaded), but if it ever does, don't leave the panel stuck spinning.
            set({ terrainLoading: false, weatherLoading: false });
            return;
        }

        if (eclipseMode === 'lunar') {
            if (!lunarSummary) {
                set({ terrainLoading: false, weatherLoading: false });
                return;
            }
            // A lunar eclipse has no local circumstances to resolve — the contact times are the
            // same everywhere — so the only per-point questions are "is the Moon above the terrain
            // here" and "will it be cloudy".
            void (async () => {
                const isStale = () => get().selectedPoint !== point;
                const referenceTime = lunarSummary.contacts.greatest;
                set({ weatherReferenceTime: referenceTime });
                // refetchWeatherForCurrentPoint aborts+replaces the shared weatherAbortController
                // itself, so the outer `weatherController` created at the top of selectPoint would
                // already be aborted by the time these two fetches ran if we used it here — use
                // the fresh controller it just created and stored instead.
                const weatherRequestController = refetchWeatherForCurrentPoint();
                void getClimatologyHourlyWeekCurve(point.lat, point.lon, referenceTime, weatherRequestController?.signal)
                    .then((weekCurve) => { if (!isStale()) set({ cloudCoverWeekCurve: weekCurve }); })
                    .catch(() => {});
                void getClimatologyHourlyDayProfile(point.lat, point.lon, referenceTime, weatherRequestController?.signal)
                    .then((dayProfile) => { if (!isStale()) set({ cloudCoverDayProfile: dayProfile }); })
                    .catch(() => {});

                try {
                    const elevation = await getElevation(point.lat, point.lon, ELEVATION_ZOOM).catch(() => 0);
                    if (isStale()) return;
                    const horizonProfile = await computeHorizonProfile(point.lat, point.lon);
                    if (isStale()) return;
                    const terrainVisibility = await computeLunarVisibility(lunarSummary, point.lat, point.lon, horizonProfile, elevation);
                    if (isStale()) return;
                    // Aim the PeakFinder link at the Moon at greatest eclipse, the lunar analogue
                    // of pointing it at the eclipsed Sun.
                    const atGreatest = terrainVisibility.samples.reduce((best, s2) =>
                        Math.abs(s2.time.getTime() - referenceTime.getTime()) < Math.abs(best.time.getTime() - referenceTime.getTime()) ? s2 : best,
                    );
                    set({
                        horizonProfile,
                        terrainVisibility,
                        terrainLoading: false,
                        sceneTimeIndex: terrainVisibility ? defaultSceneTimeIndex(terrainVisibility) : 0,
                        sunPositionAtTotality: { azimuth: atGreatest.azimuth, altitude: atGreatest.altitude, time: atGreatest.time },
                    });
                } catch (err) {
                    if (!isStale()) set({ terrainLoading: false, terrainError: err instanceof Error ? err.message : String(err) });
                }
            })();
            return;
        }

        void (async () => {
            const isStale = () => get().selectedPoint !== point;

            // Runs alongside the eclipse load below rather than after it: the observer's own
            // elevation shifts contact times/magnitude by a non-trivial amount for the kind of
            // elevated sites eclipse chasers actually pick (extended totality, graze-limit
            // visibility), so it's worth fetching before resolving local circumstances — but
            // sea level (0) is still a fine fallback if the tile lookup fails.
            const elevationPromise = getElevation(point.lat, point.lon, ELEVATION_ZOOM).catch(() => 0);

            let eclipse;
            try {
                eclipse = await loadEclipseCached(selectedDate);
            } catch (err) {
                // A real failure loading the eclipse itself (network/catalogue error) — distinct
                // from the "point outside the eclipse" case below, so it shouldn't be reported
                // as if this location simply never sees the eclipse.
                if (!isStale()) {
                    const message = err instanceof Error ? err.message : String(err);
                    set({ terrainLoading: false, terrainError: message, weatherLoading: false, weatherError: message });
                }
                return;
            }
            if (isStale()) return;

            const elevation = await elevationPromise;
            if (isStale()) return;

            let local;
            try {
                local = getLocalEclipse(eclipse, point.lat, point.lon, elevation);
            } catch {
                // The astronomy-bundle library throws when a point never sees any part
                // of the eclipse (fully outside the penumbra), rather than returning null.
                if (!isStale()) set({ pointOutsideEclipse: true, terrainLoading: false, weatherLoading: false });
                return;
            }
            if (isStale()) return;

            try {
                set({ localCircumstances: summarizeLocal(local) });

                const contacts = local.getContactTimes();
                if (contacts) {
                    const targetTime =
                        contacts.c2 && contacts.c3
                            ? new Date((contacts.c2.getDate().getTime() + contacts.c3.getDate().getTime()) / 2)
                            : contacts.max.getDate();
                    const position = getSunPositionAt(local, targetTime);
                    set({ sunPositionAtTotality: { azimuth: position.azimuth, altitude: position.altitude, time: targetTime } });
                }
            } catch (err) {
                // Unlikely (getLocalEclipse just succeeded moments ago), but without this an
                // exception here would be an unhandled rejection *and* leave both loading flags
                // stuck true forever, since neither the weather nor terrain fetch below would
                // ever even start.
                if (!isStale()) {
                    const message = err instanceof Error ? err.message : String(err);
                    set({ terrainLoading: false, terrainError: message, weatherLoading: false, weatherError: message });
                }
                return;
            }

            // Weather runs independently of the terrain analysis below — neither should block
            // or fail because of the other. refetchWeatherForCurrentPoint fires its own async
            // work and returns immediately, matching that independence.
            const referenceTime = local.getContactTimes()?.max.getDate();
            if (referenceTime) {
                set({ weatherReferenceTime: referenceTime });
                // refetchWeatherForCurrentPoint aborts+replaces the shared weatherAbortController
                // itself, so the outer `weatherController` created at the top of selectPoint would
                // already be aborted by the time these two fetches ran if we used it here — use
                // the fresh controller it just created and stored instead.
                const weatherRequestController = refetchWeatherForCurrentPoint();

                // Always hour-specific and a fixed 7-day span — unlike cloudCoverYearCurve, this
                // doesn't depend on weatherTimeMode/weatherDayWindow, so it's fetched once here
                // rather than through refetchWeatherForCurrentPoint.
                void getClimatologyHourlyWeekCurve(point.lat, point.lon, referenceTime, weatherRequestController?.signal)
                    .then((weekCurve) => {
                        if (!isStale()) set({ cloudCoverWeekCurve: weekCurve });
                    })
                    .catch(() => {
                        // silently leave cloudCoverWeekCurve null — the chart just won't render
                    });

                // Same fetch-once treatment: the diurnal profile doesn't depend on the toggles.
                void getClimatologyHourlyDayProfile(point.lat, point.lon, referenceTime, weatherRequestController?.signal)
                    .then((dayProfile) => {
                        if (!isStale()) set({ cloudCoverDayProfile: dayProfile });
                    })
                    .catch(() => {
                        // silently leave cloudCoverDayProfile null — the chart just won't render
                    });
            } else if (!isStale()) {
                set({ weatherLoading: false, weatherReferenceTime: null });
            }

            try {
                const horizonProfile = await computeHorizonProfile(point.lat, point.lon);
                if (isStale()) return;
                const terrainVisibility = computeEclipseVisibility(local, horizonProfile);
                set({
                    horizonProfile,
                    terrainVisibility,
                    terrainLoading: false,
                    sceneTimeIndex: terrainVisibility ? defaultSceneTimeIndex(terrainVisibility) : 0,
                });
            } catch (err) {
                // Distinct from the "outside the eclipse" case above: the point is valid,
                // but fetching/decoding elevation tiles failed (e.g. a network hiccup).
                if (!isStale()) {
                    set({ terrainLoading: false, terrainError: err instanceof Error ? err.message : String(err) });
                }
            }
        })();
    },

    setSceneTimeIndex: (index: number) => set({ sceneTimeIndex: index }),
    setMapView: (view) => set({ mapView: view }),
    setExporting: (value: boolean) => set({ isExporting: value }),
    setFocusIncludeDuration: (value: boolean) => set({ focusIncludeDuration: value }),

    setEclipseMode: (mode: EclipseMode) => {
        if (get().eclipseMode === mode) return;
        // Everything about the selected point is mode-specific (it was resolved against the Sun
        // or the Moon), so it is cleared rather than left showing figures for the other body.
        weatherAbortController?.abort();
        if (mode === 'lunar') lastSolarDate = get().selectedDate;
        set({
            eclipseMode: mode,
            // The solar path/umbra geometry means nothing for a lunar eclipse; left in place it
            // would keep drawing the previous solar eclipse's track over every lunar map.
            path: null,
            summary: null,
            lunarSummary: mode === 'lunar' ? get().lunarSummary : null,
            ...CLEARED_POINT_STATE,
        });

        if (mode === 'solar') {
            const date = lastSolarDate ?? listStandardEclipseDates(`${new Date().getFullYear()}-01-01`).find((d) => d >= today());
            if (date) void get().selectEclipse(date);
            return;
        }

        {
            const { lunarEclipses } = get();
            if (lunarEclipses.length > 0) {
                const todayStr = today();
                const next = lunarEclipses.find((e) => e.date >= todayStr) ?? lunarEclipses.at(-1);
                if (next) void get().selectLunarEclipse(next.date);
                return;
            }
            set({ loading: true, error: null });
            // Lunar eclipses are computed rather than read from a catalogue, so the list is built
            // on first switch into the mode and then kept (see listLunarEclipses — a few hundred
            // ms for a decade, cheap enough not to need precomputing).
            const year = new Date().getFullYear();
            void listLunarEclipses(`${year}-01-01`, `${year + 10}-12-31`)
                .then((items) => {
                    set({ lunarEclipses: items, loading: false });
                    const todayStr = today();
                    const next = items.find((e) => e.date >= todayStr) ?? items.at(-1);
                    if (next) void get().selectLunarEclipse(next.date);
                })
                .catch((err: unknown) => {
                    set({ error: err instanceof Error ? err.message : String(err), loading: false });
                });
        }
    },

    selectLunarEclipse: async (date: string) => {
        weatherAbortController?.abort();
        const requestId = ++eclipseSelectionRequestId;
        set({ loading: true, error: null, ...CLEARED_POINT_STATE });
        // Yield a macrotask so React can commit/paint the `loading: true` state above before the
        // heavy, uninterrupted synchronous work inside resolveEclipseNear (lunarEclipse.ts) runs
        // — roughly 330 back-to-back shadowGeometryAt calls with no yield point between them,
        // unlike listLunarEclipses which yields per lunation. This does NOT fix the freeze itself
        // (that needs a yield point added inside findCrossing/findGreatest in lunarEclipse.ts,
        // which this file doesn't own — see the audit note); it only ensures the user sees a
        // loading indicator instead of the tab going unresponsive with no warning at all.
        await new Promise((resolve) => setTimeout(resolve, 0));
        try {
            const lunarSummary = await loadLunarEclipse(date);
            if (requestId !== eclipseSelectionRequestId) return; // a newer selection superseded this one
            set({ selectedDate: date, lunarSummary, loading: false });
        } catch (err) {
            if (requestId !== eclipseSelectionRequestId) return;
            set({ error: err instanceof Error ? err.message : String(err), loading: false });
        }
    },

    setWeatherDayWindow: (days: number) => {
        set({ weatherDayWindow: days });
        refetchWeatherForCurrentPoint();
    },

    setWeatherTimeMode: (mode: WeatherTimeMode) => {
        set({ weatherTimeMode: mode });
        refetchWeatherForCurrentPoint();
    },

    addCurrentPointToComparison: () => {
        const { selectedPoint, localCircumstances, cloudCover, comparisonEntries } = get();
        if (!selectedPoint || !localCircumstances) return;
        if (comparisonEntries.length >= MAX_COMPARISON_ENTRIES) return;
        if (comparisonEntries.some((e) => e.point.lat === selectedPoint.lat && e.point.lon === selectedPoint.lon)) return;
        const entry: ComparisonEntry = { id: Date.now(), point: selectedPoint, local: localCircumstances, cloudCover };
        set({ comparisonEntries: [...comparisonEntries, entry] });
    },

    removeFromComparison: (id: number) => {
        set({ comparisonEntries: get().comparisonEntries.filter((e) => e.id !== id) });
    },

    findBestPointsAlongPath: async () => {
        const { selectedDate, path, weatherDayWindow, weatherTimeMode } = get();
        const coordinates = path?.centralLine?.geometry.coordinates;
        if (!selectedDate || !coordinates || coordinates.length === 0) {
            set({ bestPointsAlongPath: [] });
            return;
        }

        set({ bestPointsLoading: true });
        const requestDate = selectedDate; // isStale check below: bail if the eclipse changed mid-search
        try {
            const eclipse = await loadEclipseCached(selectedDate);
            // Oversampled relative to the 5 results actually shown: a real fraction of samples
            // typically land in the ocean (central lines cross a lot of open water) and get
            // filtered out below, so sampling only 5-10 points could leave too few land
            // candidates even when the path does cross plenty of land elsewhere. Kept lower than
            // a weather-only search would use (was 30) since each candidate now also computes a
            // full horizon profile — real elevation-tile fetches, not just one point lookup —
            // making this search meaningfully heavier per candidate than before.
            const SAMPLE_COUNT = 16;
            const samples = samplePathPoints(coordinates, SAMPLE_COUNT);

            const results = await Promise.all(
                samples.map(async (point) => {
                    // Sea-level elevation for the astronomy, not the point's real elevation —
                    // same simplification already used for the central-line time-tick labels in
                    // engine/eclipse.ts: a marginal accuracy gain on what's already a coarse
                    // "which town looks promising" scan, not a precise circumstances readout.
                    let local;
                    try {
                        local = getLocalEclipse(eclipse, point.lat, point.lon);
                    } catch {
                        return null; // outside the penumbra at this sample point
                    }
                    const contacts = local.getContactTimes();
                    if (!contacts) return null;
                    const referenceTime = contacts.max.getDate();
                    const [cloudCover, elevation] = await Promise.all([
                        getCloudCoverEstimate(point.lat, point.lon, referenceTime, undefined, weatherDayWindow, weatherTimeMode),
                        // No proper land/sea mask available — elevation tiles include bathymetry,
                        // so a reading at or below 0m is treated as water and excluded. Imperfect
                        // (a few real below-sea-level places exist, e.g. parts of the
                        // Netherlands) but avoids the much more common false positive of
                        // recommending a point out in open ocean, which central lines cross a lot.
                        getElevation(point.lat, point.lon, ELEVATION_ZOOM).catch(() => 0),
                    ]);
                    if (!cloudCover || elevation <= 0) return null;

                    // Terrain: exclude candidates where the terrain blocks the central phase
                    // (a clear-sky spot with the totality/annularity hidden behind a ridge isn't
                    // actually a good recommendation) — mirrors the same check already shown for
                    // the manually-selected point ("Centralité masquée par le relief").
                    let visibleFraction = 1;
                    try {
                        const horizonProfile = await computeHorizonProfile(point.lat, point.lon);
                        const terrainVisibility = computeEclipseVisibility(local, horizonProfile);
                        if (!terrainVisibility) return null;
                        if (terrainVisibility.hasCentralPhase && !terrainVisibility.centralPhaseVisible) return null;
                        visibleFraction = terrainVisibility.visibleDurationSeconds / terrainVisibility.theoreticalDurationSeconds;
                    } catch {
                        return null; // couldn't resolve terrain for this candidate — skip rather than recommend blind
                    }

                    return { point, magnitude: summarizeLocal(local).maxMagnitude, cloudCoverPercent: cloudCover.percent, visibleFraction };
                }),
            );

            if (get().selectedDate !== requestDate) return; // a different eclipse was selected meanwhile — discard the RESULT only

            const ranked = results
                .filter((r): r is { point: LatLon; magnitude: number; cloudCoverPercent: number; visibleFraction: number } => r !== null)
                .sort((a, b) => a.cloudCoverPercent - b.cloudCoverPercent)
                .slice(0, 5);
            set({ bestPointsAlongPath: ranked });
        } catch (err) {
            if (get().selectedDate === requestDate) {
                console.error('Failed to search for the clearest points along the path:', err);
                set({ bestPointsAlongPath: [] });
            }
        } finally {
            // Always cleared, regardless of whether the eclipse changed mid-search: otherwise a
            // stale request that gets its result/error discarded above would leave the panel
            // stuck on "Recherche…" forever with no way to retry (see BestPointsPanel, which only
            // shows the search button again once this flips back to false).
            set({ bestPointsLoading: false });
        }
    },
    };
});
