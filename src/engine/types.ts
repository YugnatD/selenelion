export type SolarEclipseType = 'partial' | 'total' | 'annular' | 'hybrid';

export interface EclipseSummary {
    date: string;
    type: SolarEclipseType;
    saros: number;
    greatestEclipse: {
        lat: number;
        lon: number;
        time: Date;
    };
    magnitude: number;
    obscuration: number;
    umbraPathWidthMeters: number;
    maxDurationSeconds: number;
    maxCentralDurationSeconds: number;
}

export interface LatLon {
    lat: number;
    lon: number;
}
