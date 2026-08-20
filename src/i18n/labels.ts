import type { StringKey, TFunction } from './index';

/**
 * Eclipse type strings come from two different sources with overlapping vocabulary — the solar
 * library's own type names and our lunar engine's — and "partial" does not mean the same thing for
 * each body. They are therefore mapped to separate key namespaces rather than one shared table,
 * and an unrecognised type falls through to the raw string instead of rendering blank.
 */
const SOLAR_KEYS: Record<string, StringKey> = {
    total: 'type.total',
    annular: 'type.annular',
    partial: 'type.partial',
    hybrid: 'type.hybrid',
    none: 'type.none',
};

const LUNAR_KEYS: Record<string, StringKey> = {
    total: 'lunarType.total',
    partial: 'lunarType.partial',
    penumbral: 'lunarType.penumbral',
};

export function solarTypeLabel(t: TFunction, type: string): string {
    const key = SOLAR_KEYS[type];
    return key ? t(key as 'type.total') : type;
}

export function lunarTypeLabel(t: TFunction, type: string): string {
    const key = LUNAR_KEYS[type];
    return key ? t(key as 'lunarType.total') : type;
}
