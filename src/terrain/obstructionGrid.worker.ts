import type { SolarEclipse } from '../engine/eclipse';
import { loadEclipse } from '../engine/eclipse';
import type { ObstructionGrid } from './obstructionGrid';
import { computeObstructionGrid } from './obstructionGrid';

export interface ObstructionWorkerRequest {
    requestId: number;
    date: string;
    bounds: { west: number; south: number; east: number; north: number };
    cols: number;
    rows: number;
}

export type ObstructionWorkerResponse =
    | { requestId: number; grid: ObstructionGrid }
    | { requestId: number; error: string }
    | { requestId: number; progress: number };

// Mutated synchronously on every message, so an older in-flight computation's `shouldAbort`
// check (run after each awaited chunk) sees it's no longer the latest and stops early instead
// of racing a newer request to a result nobody will use.
let latestRequestId = -1;

// The controller behind whichever computation is currently running. `shouldAbort` alone stops
// this worker's own CPU-bound loops promptly, but it doesn't reach into `fetch()` — without a
// real AbortSignal a superseded request's in-flight tile downloads kept running to completion in
// the background (and duplicated network work with whatever request replaced it). Aborted, not
// just dropped, whenever a new request arrives before the previous one finished.
let activeController: AbortController | null = null;

// The date practically never changes between successive pans/zooms of the same obstruction
// map, but without this every recompute re-ran the Besselian-element interpolation from
// scratch. Single-entry: this worker only ever serves one map view, one eclipse at a time.
let loadedEclipseCache: { date: string; eclipse: Promise<SolarEclipse> } | null = null;

function loadEclipseCached(date: string): Promise<SolarEclipse> {
    if (loadedEclipseCache?.date !== date) {
        const eclipse = loadEclipse(date).catch((err: unknown) => {
            if (loadedEclipseCache?.date === date) loadedEclipseCache = null;
            throw err;
        });
        loadedEclipseCache = { date, eclipse };
    }
    return loadedEclipseCache.eclipse;
}

self.onmessage = async (event: MessageEvent<ObstructionWorkerRequest>) => {
    const { requestId, date, bounds, cols, rows } = event.data;
    latestRequestId = requestId;

    // A new request always supersedes whatever was running — cancel its network phase instead of
    // letting it keep fetching tiles in the background while this one starts fetching too.
    activeController?.abort();
    const controller = new AbortController();
    activeController = controller;

    try {
        const eclipse = await loadEclipseCached(date);
        if (requestId !== latestRequestId) return;

        const grid = await computeObstructionGrid(
            eclipse,
            bounds,
            cols,
            rows,
            () => requestId !== latestRequestId,
            (progress) => {
                if (requestId === latestRequestId) self.postMessage({ requestId, progress } satisfies ObstructionWorkerResponse);
            },
            controller.signal,
        );
        if (requestId !== latestRequestId) return;

        const response: ObstructionWorkerResponse = { requestId, grid };
        self.postMessage(response);
    } catch (err) {
        if (requestId !== latestRequestId) return;
        const response: ObstructionWorkerResponse = { requestId, error: err instanceof Error ? err.message : String(err) };
        self.postMessage(response);
    } finally {
        if (activeController === controller) activeController = null;
    }
};
