import type { ObstructionGrid } from './obstructionGrid';
import type { ObstructionWorkerRequest, ObstructionWorkerResponse } from './obstructionGrid.worker';

/** Thin wrapper around the obstruction grid Web Worker: runs the heavy astronomy/horizon-ray
 *  computation off the main thread entirely, so panning and zooming the map stay responsive
 *  no matter how long a grid takes to compute. */
export class ObstructionWorkerClient {
    private worker: Worker;
    private pending = new Map<
        number,
        { resolve: (grid: ObstructionGrid) => void; reject: (err: Error) => void; onProgress?: (fraction: number) => void }
    >();
    private nextRequestId = 0;

    constructor() {
        this.worker = this.spawnWorker();
    }

    private spawnWorker(): Worker {
        const worker = new Worker(new URL('./obstructionGrid.worker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = (event: MessageEvent<ObstructionWorkerResponse>) => {
            const entry = this.pending.get(event.data.requestId);
            if (!entry) return;
            if ('progress' in event.data) {
                entry.onProgress?.(event.data.progress);
                return;
            }
            this.pending.delete(event.data.requestId);
            if ('error' in event.data) entry.reject(new Error(event.data.error));
            else entry.resolve(event.data.grid);
        };
        // Without this, a worker that fails to even start (blocked by CSP, the chunk failing to
        // load, an uncaught exception before it ever registers its own onmessage) leaves every
        // pending compute() promise unsettled forever — the caller's loading state gets stuck
        // with no way to recover short of a page reload. Beyond just rejecting the pending work,
        // the dead worker is torn down and replaced so the *next* compute() call also works
        // normally instead of silently posting into a worker that will never respond again.
        worker.onerror = (event: ErrorEvent) => {
            const message = event.message || 'Obstruction worker failed to load';
            for (const entry of this.pending.values()) entry.reject(new Error(message));
            this.pending.clear();
            worker.terminate();
            if (this.worker === worker) this.worker = this.spawnWorker();
        };
        return worker;
    }

    /** Only one grid is ever useful at a time. Starting a new request abandons any still-pending
     *  older one (rejected, not just dropped, so its awaiter doesn't leak forever). */
    compute(
        date: string,
        bounds: { west: number; south: number; east: number; north: number },
        cols: number,
        rows: number,
        onProgress?: (fraction: number) => void,
    ): Promise<ObstructionGrid> {
        for (const entry of this.pending.values()) entry.reject(new Error('SUPERSEDED'));
        this.pending.clear();

        const requestId = this.nextRequestId++;
        const request: ObstructionWorkerRequest = { requestId, date, bounds, cols, rows };
        return new Promise((resolve, reject) => {
            this.pending.set(requestId, { resolve, reject, onProgress });
            this.worker.postMessage(request);
        });
    }

    terminate() {
        for (const entry of this.pending.values()) entry.reject(new Error('SUPERSEDED'));
        this.pending.clear();
        this.worker.terminate();
    }
}
