import { getElevationsBatchFlat } from '../terrain/elevationTiles';

export interface TerrainMeshData {
    /** x=east, y=elevation relative to the observer, z=south (meters) — a right-handed frame
     *  (east × up = south), matching Three.js's Y-up convention so camera/cross-product math
     *  (OrbitControls, sun-direction offsets) comes out at the correct real-world compass angle. */
    positions: Float32Array;
    colors: Float32Array;
    indices: Uint32Array;
    gridSize: number;
    radiusMeters: number;
    observerElevation: number;
}

const MESH_RADIUS_M = 5000;
/** Odd, deliberately: with an even size there is no vertex exactly at the grid's geometric
 *  center (x=0,z=0, i.e. the observer's own position) — the nearest one sits a full half-cell
 *  away, which silently offset the observer's sampled elevation. An odd size guarantees the
 *  middle index lands exactly on i=j=(GRID_SIZE-1)/2, x=z=0. */
const GRID_SIZE = 97;
/** Web Mercator zoom for the close-up mesh: denser than the wide horizon-check sampling. */
const MESH_ZOOM = 11;

/** Sea level: below this, terrain is flattened and coloured as water instead of following
 *  (often noisy/irrelevant) bathymetry from the elevation tiles. */
const WATER_LEVEL_M = 0;
const WATER_COLOR: [number, number, number] = [0.13, 0.32, 0.55];

const METERS_PER_DEGREE_LAT = 110540;
function metersPerDegreeLon(lat: number): number {
    return 111320 * Math.cos((lat * Math.PI) / 180);
}

/** Sandy shoreline, through grass and rock, to snow-capped peaks. Module-level: `landColor` runs
 *  once per non-water grid vertex (up to GRID_SIZE², thousands per mesh build), so this must not
 *  be re-allocated on every call. */
const LAND_COLOR_STOPS: Array<[number, [number, number, number]]> = [
    [0, [0.78, 0.71, 0.5]],
    [20, [0.6, 0.62, 0.36]],
    [300, [0.36, 0.52, 0.28]],
    [900, [0.55, 0.47, 0.35]],
    [1700, [0.6, 0.58, 0.55]],
    [2500, [0.95, 0.95, 0.97]],
];

function landColor(absoluteElevation: number, out: Float32Array, offset: number): void {
    const stops = LAND_COLOR_STOPS;
    let i = 0;
    // LAND_COLOR_STOPS is a fixed nonempty literal array; the `&&` short-circuits stops[i + 1]
    // to only ever be read while i + 1 <= stops.length - 1, and i itself only ever advances
    // within that same bound — so every index below is always in range.
    while (i < stops.length - 1 && absoluteElevation > stops[i + 1]![0]) i++;
    const [h0, c0] = stops[i]!;
    const [h1, c1] = stops[Math.min(i + 1, stops.length - 1)]!;
    const t = h1 === h0 ? 0 : Math.max(0, Math.min(1, (absoluteElevation - h0) / (h1 - h0)));
    out[offset] = c0[0] + (c1[0] - c0[0]) * t;
    out[offset + 1] = c0[1] + (c1[1] - c0[1]) * t;
    out[offset + 2] = c0[2] + (c1[2] - c0[2]) * t;
}

/**
 * A close-up terrain mesh centered on (lat0, lon0), built from the same AWS Terrarium
 * elevation tiles used for the horizon profile, at a denser zoom level suited to a 3D
 * close-up rather than a wide horizon scan.
 */
export async function buildTerrainMesh(lat0: number, lon0: number): Promise<TerrainMeshData> {
    const mLon = metersPerDegreeLon(lat0);

    // Flat, interleaved [lat0, lon0, lat1, lon1, ...] rather than one {lat, lon} object per grid
    // vertex — same rationale as obstructionGrid.ts's export-grid path, just at a smaller scale
    // here (GRID_SIZE² points).
    const coords = new Float64Array(GRID_SIZE * GRID_SIZE * 2);
    const gridX = new Float32Array(GRID_SIZE * GRID_SIZE);
    const gridZ = new Float32Array(GRID_SIZE * GRID_SIZE);
    for (let j = 0; j < GRID_SIZE; j++) {
        for (let i = 0; i < GRID_SIZE; i++) {
            const idx = j * GRID_SIZE + i;
            const x = (i / (GRID_SIZE - 1) - 0.5) * 2 * MESH_RADIUS_M; // east
            const z = (j / (GRID_SIZE - 1) - 0.5) * 2 * MESH_RADIUS_M; // south
            gridX[idx] = x;
            gridZ[idx] = z;
            coords[idx * 2] = lat0 - z / METERS_PER_DEGREE_LAT;
            coords[idx * 2 + 1] = lon0 + x / mLon;
        }
    }

    const elevations = await getElevationsBatchFlat(coords, MESH_ZOOM);
    // The observer stands at (lat0, lon0), i.e. the grid's exact geometric center — NOT at
    // index points.length/2, which for a row-major i,j grid lands on the west edge instead.
    // GRID_SIZE being odd guarantees this index is the true center vertex (x=z=0), not just the
    // nearest one.
    const centerIndex = Math.floor(GRID_SIZE / 2) * GRID_SIZE + Math.floor(GRID_SIZE / 2);
    // elevations has exactly GRID_SIZE*GRID_SIZE entries (getElevationsBatchFlat's return length
    // is coords.length/2, and coords was sized GRID_SIZE*GRID_SIZE*2 above), and centerIndex is
    // < GRID_SIZE*GRID_SIZE by construction, so this index is always valid.
    let observerElevation = elevations[centerIndex]!;
    // A failed tile fetch resolves to NaN rather than a false 0m/sea-level reading (see
    // getElevationsBatchFlat) — propagating that into every vertex position below would corrupt
    // the whole mesh (three.js's computeVertexNormals spreads a single NaN vertex to its
    // neighbours). Fall back to flat-relative-to-sea-level instead, and say so once in dev.
    let hadMissingData = Number.isNaN(observerElevation);
    if (hadMissingData) observerElevation = 0;

    const positions = new Float32Array(GRID_SIZE * GRID_SIZE * 3);
    const colors = new Float32Array(GRID_SIZE * GRID_SIZE * 3);
    // idx ranges over [0, GRID_SIZE*GRID_SIZE), and elevations/gridX/gridZ were all sized
    // GRID_SIZE*GRID_SIZE above, so every indexed read below is always in range.
    for (let idx = 0; idx < GRID_SIZE * GRID_SIZE; idx++) {
        let absoluteElevation = elevations[idx]!;
        if (Number.isNaN(absoluteElevation)) {
            hadMissingData = true;
            absoluteElevation = observerElevation; // flat fallback: avoids injecting NaN into the mesh
        }
        const isWater = absoluteElevation <= WATER_LEVEL_M;
        const height = isWater ? WATER_LEVEL_M : absoluteElevation;

        positions[idx * 3] = gridX[idx]!;
        positions[idx * 3 + 1] = height - observerElevation;
        positions[idx * 3 + 2] = gridZ[idx]!;

        if (isWater) {
            colors[idx * 3] = WATER_COLOR[0];
            colors[idx * 3 + 1] = WATER_COLOR[1];
            colors[idx * 3 + 2] = WATER_COLOR[2];
        } else {
            landColor(absoluteElevation, colors, idx * 3);
        }
    }

    if (hadMissingData) {
        console.warn('Terrain mesh: some elevation tiles failed to load; affected vertices were filled in flat rather than left as sea level.');
    }

    const indices = new Uint32Array((GRID_SIZE - 1) * (GRID_SIZE - 1) * 6);
    let p = 0;
    for (let j = 0; j < GRID_SIZE - 1; j++) {
        for (let i = 0; i < GRID_SIZE - 1; i++) {
            const a = j * GRID_SIZE + i;
            const b = a + 1;
            const c = a + GRID_SIZE;
            const d = c + 1;
            indices[p++] = a;
            indices[p++] = c;
            indices[p++] = b;
            indices[p++] = b;
            indices[p++] = c;
            indices[p++] = d;
        }
    }

    return { positions, colors, indices, gridSize: GRID_SIZE, radiusMeters: MESH_RADIUS_M, observerElevation };
}
