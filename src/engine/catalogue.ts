import { SolarEclipse } from '@astronomy-bundle/solar-eclipse';
import { Catalogue as StandardCatalogue } from '@astronomy-bundle/solar-eclipse/catalogue';
import type { SolarEclipseType } from './types';

export type BesselianElements = ReturnType<typeof StandardCatalogue.getBesselianElements>;

export interface EclipseListItem {
    date: string;
    type: SolarEclipseType;
}

const STANDARD_RANGE = { from: '1900-05-28', to: '2100-09-04' };

type FullCatalogueModule = typeof import('@astronomy-bundle/solar-eclipse/catalogue-full');

let fullCataloguePromise: Promise<FullCatalogueModule> | null = null;

function loadFullCatalogue(): Promise<FullCatalogueModule> {
    if (!fullCataloguePromise) {
        fullCataloguePromise = import('@astronomy-bundle/solar-eclipse/catalogue-full').catch((err: unknown) => {
            // Don't permanently poison this on a transient failure (offline blip, chunk load
            // error) — clear it so the next call retries instead of rejecting forever.
            fullCataloguePromise = null;
            throw err;
        });
    }
    return fullCataloguePromise;
}

export function isWithinStandardRange(date: string): boolean {
    return date >= STANDARD_RANGE.from && date <= STANDARD_RANGE.to;
}

/** Synchronous, no network/chunk cost: dates between 1900-05-28 and 2100-09-04. */
export function listStandardEclipseDates(from?: string, to?: string): string[] {
    return StandardCatalogue.getAvailableEclipseDates(from, to);
}

const CATALOGUE_CHUNK_SIZE = 40;

function yieldToMain(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Same result as listStandardEclipses, but classifying each date's Besselian elements in small
 *  yielding chunks instead of one long synchronous pass — this is the whole standard range
 *  (1900-2100, a few hundred eclipses) run on every app startup, purely to populate the date
 *  picker, and shouldn't block the very first render to do it. */
export async function listStandardEclipsesChunked(from?: string, to?: string): Promise<EclipseListItem[]> {
    const dates = listStandardEclipseDates(from, to);
    const items: EclipseListItem[] = [];
    for (let start = 0; start < dates.length; start += CATALOGUE_CHUNK_SIZE) {
        const end = Math.min(start + CATALOGUE_CHUNK_SIZE, dates.length);
        for (let i = start; i < end; i++) {
            // i < end <= dates.length by the loop bound above.
            const date = dates[i]!;
            const elements = StandardCatalogue.getBesselianElements(date);
            const type = SolarEclipse.createFromBesselianElements(elements).getType();
            items.push({ date, type });
        }
        if (end < dates.length) await yieldToMain();
    }
    return items;
}

/** Lazily loads the ~1MB full catalogue (-1999 to 3000) as a separate chunk. */
export async function listAllEclipseDates(from?: string, to?: string): Promise<string[]> {
    const { Catalogue: FullCatalogue } = await loadFullCatalogue();
    return FullCatalogue.getAvailableEclipseDates(from, to);
}

export async function getBesselianElementsForDate(date: string): Promise<BesselianElements> {
    if (isWithinStandardRange(date)) {
        return StandardCatalogue.getBesselianElements(date);
    }
    const { Catalogue: FullCatalogue } = await loadFullCatalogue();
    return FullCatalogue.getBesselianElements(date);
}
