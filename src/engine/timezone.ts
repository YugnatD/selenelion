import tzLookup from 'tz-lookup';
import { getLang, localeTag } from '../i18n';

// tz-lookup does a geo point-in-polygon search — not free, and the same selected point's lat/lon
// gets looked up repeatedly (once per contact-time row in CircumstancesPanel, on every re-render
// triggered by an unrelated field like weatherLoading finishing, plus again from HorizonChart and
// the PeakFinder link) without the coordinates ever changing. Unlike the formatters below, no
// cap: at most one entry per point the user has actually selected in this session.
const timeZoneCache = new Map<string, string>();

/**
 * IANA timezone name for a lat/lon, e.g. "Europe/Madrid". `tz-lookup` assigns every point on Earth
 * — land or ocean — to whichever real IANA zone's maritime boundary covers it (nowhere resolves to
 * a plain `Etc/GMT` offset zone); e.g. (−70, 0) → "Africa/Johannesburg", (10, 170) →
 * "Pacific/Majuro", (0, −150) → "Pacific/Kiritimati". Those can carry UTC offsets and calendar
 * days that don't match the simple nautical-time-zone convention one might expect for open ocean,
 * so don't assume the returned zone's offset is "the" offset for that meridian.
 */
export function getTimeZone(lat: number, lon: number): string {
    // tz-lookup only accepts longitudes in [-180, 180]; a slightly out-of-range value (e.g.
    // 180.0000001, easy to end up with from wrapping/rounding elsewhere) would otherwise throw and
    // silently fall back to UTC below instead of resolving to the real zone at that point.
    const normalizedLon = ((((lon + 180) % 360) + 360) % 360) - 180;
    const key = `${lat},${normalizedLon}`;
    const cached = timeZoneCache.get(key);
    if (cached) return cached;

    let zone: string;
    try {
        zone = tzLookup(lat, normalizedLon);
    } catch {
        zone = 'UTC';
    }
    timeZoneCache.set(key, zone);
    return zone;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();
const shortFormatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
    // Keyed by locale *and* zone: the same zone formatted in two languages is two different
    // formatters, and caching on the zone alone kept serving the previous language's after a switch.
    const locale = localeTag(getLang());
    const cacheKey = `${locale}|${timeZone}`;
    let formatter = formatterCache.get(cacheKey);
    if (!formatter) {
        formatter = new Intl.DateTimeFormat(locale, {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
            timeZone,
            timeZoneName: 'short',
        });
        formatterCache.set(cacheKey, formatter);
    }
    return formatter;
}

function getShortFormatter(timeZone: string): Intl.DateTimeFormat {
    const locale = localeTag(getLang());
    const cacheKey = `${locale}|${timeZone}`;
    let formatter = shortFormatterCache.get(cacheKey);
    if (!formatter) {
        formatter = new Intl.DateTimeFormat(locale, {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
            timeZone,
        });
        shortFormatterCache.set(cacheKey, formatter);
    }
    return formatter;
}

/** Local wall-clock time for a UTC instant in the given IANA zone, e.g. "19:47:00 UTC+2". */
export function formatLocalTime(date: Date, timeZone: string): string {
    return getFormatter(timeZone).format(date);
}

/** Compact "HH:MM" local wall-clock time, for space-constrained labels (e.g. on the map). */
export function formatLocalTimeShort(date: Date, timeZone: string): string {
    return getShortFormatter(timeZone).format(date);
}
