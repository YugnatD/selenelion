/**
 * Precomputes BOTH the daily and the 2-hour-bucket cloud-cover climatology from Open-Meteo's
 * ERA5 archive in a single pass — supersedes running buildClimatologyTiles.ts and
 * buildClimatologyHourlyTiles.ts separately, which would each download the exact same ~5GB/year
 * source files independently (each year fetched twice for no reason, since download time
 * dominates total runtime, not the ~70s/year local processing). Publishes two tile sets:
 * `public/climatology/` (day-of-year, 365 slots/point — WeatherMap's grid overview) and
 * `public/climatology-hourly/` (day × 2h-bucket, 4380 slots/point — CircumstancesPanel's
 * "at the eclipse's actual hour" single-point option).
 *
 * See buildClimatologyTiles.ts and buildClimatologyHourlyTiles.ts (both superseded by this file)
 * for the background on: local-file vs HTTP-range reads, the ERA5 grid's real axis orientation,
 * the count-overflow bug that motivated integer/wide-enough accumulator types, and why 2-hour
 * (not 1-hour) buckets — this file assumes that context and doesn't re-derive it.
 *
 * Usage:
 *   npx tsx scripts/buildClimatologyCombinedTiles.ts [--year-start=2001] [--year-end=2023]
 *     [--daily-out=public/climatology] [--hourly-out=public/climatology-hourly]
 *     [--cache-dir=.climatology-combined-cache] [--force] [--keep-downloads] [--tiles-only]
 *     [--sample]
 */
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { FileBackend, OmDataType, OmFileReader } from '@openmeteo/file-reader';

// --- Same ERA5 native grid as the two superseded scripts. ---
const LAT_COUNT = 721; // -90° (South Pole, index 0) to 90° (North Pole, index 720), step 0.25°
const LON_COUNT = 1440; // -180° to 179.75°, step 0.25°

const DAYS = 365; // day-of-year slots; Feb 29 folds into Feb 28's slot
const BUCKET_HOURS = 2;
const BUCKETS_PER_DAY = 24 / BUCKET_HOURS; // 12
/** Resolution the *accumulator* keeps: every day of the year, every 2h bucket. The checkpoint
 *  files on disk are sized from this, so it must not change or an existing run can't be resumed. */
const ACCUM_HOURLY_SLOTS = DAYS * BUCKETS_PER_DAY; // 4380

/** Resolution the *published tiles* use. The hourly set answers "how does cloud cover vary through
 *  the day at this time of year" — the daily set already provides day-of-year precision, so
 *  carrying all 365 days here as well multiplied the payload for detail nobody reads: the diurnal
 *  shape drifts slowly across a season, not day to day. Grouping into 10-day periods cuts a 7 MB
 *  tile to 0.69 MB (4.8 GB -> 0.47 GB overall, and 28 MB -> 2.8 MB per point looked up in hour
 *  mode) while keeping the seasonal variation. Must stay in sync with hourlyDayGroup() in
 *  src/weather/climatologyGrid.ts, which is what reads these files back. */
const HOURLY_DAY_GROUP_DAYS = 10;
const HOURLY_DAY_GROUPS = Math.ceil(DAYS / HOURLY_DAY_GROUP_DAYS); // 37
const OUT_HOURLY_SLOTS = HOURLY_DAY_GROUPS * BUCKETS_PER_DAY; // 444

const POINTS_PER_TILE = 40;
const LON_TILES = LON_COUNT / POINTS_PER_TILE; // 36
const LAT_TILES = Math.ceil(LAT_COUNT / POINTS_PER_TILE); // 19 (18 full + 1 row)

function latRowsInTile(latTileIdx: number): number {
    return Math.min(POINTS_PER_TILE, LAT_COUNT - latTileIdx * POINTS_PER_TILE);
}

const YEAR_FILE_URL = (year: number) => `https://openmeteo.s3.amazonaws.com/data/copernicus_era5/cloud_cover/year_${year}.om`;

function argValue(name: string, fallback: string): string {
    const prefix = `--${name}=`;
    const found = process.argv.find((a) => a.startsWith(prefix));
    return found ? found.slice(prefix.length) : fallback;
}
const FORCE = process.argv.includes('--force');
const KEEP_DOWNLOADS = process.argv.includes('--keep-downloads');
const SAMPLE = process.argv.includes('--sample');
const TILES_ONLY = process.argv.includes('--tiles-only');

const DAILY_OUT_DIR = argValue('daily-out', 'public/climatology');
const HOURLY_OUT_DIR = argValue('hourly-out', 'public/climatology-hourly');
const CACHE_DIR = argValue('cache-dir', '.climatology-combined-cache');
const YEAR_START = SAMPLE ? 2020 : Number(argValue('year-start', '2001'));
// Matches CLIMATOLOGY_BASELINE_LABEL ('ERA5, 2001-2023') in src/weather/climatologyTiles.ts — the
// on-disk cache was already built through 2023, so the default here should reflect that rather
// than silently under-representing what a fresh non-sample build actually covers.
const YEAR_END = SAMPLE ? 2020 : Number(argValue('year-end', '2023'));

// Same Sahara/Gibraltar sample region used to validate both superseded scripts.
const LAT_RANGE = SAMPLE ? [420, 530] : [0, LAT_COUNT];
const LON_RANGE = SAMPLE ? [680, 760] : [0, LON_COUNT];

const CUMULATIVE_DAYS = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

function isLeapYear(year: number): boolean {
    return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Per-hour-of-year lookup tables for both the day-of-year slot (daily accumulator) and the
 *  day×bucket slot (hourly accumulator), built once per year. */
function buildHourToSlots(year: number): { dayOf: Uint16Array; hourlyOf: Uint16Array } {
    const hours = isLeapYear(year) ? 8784 : 8760;
    const dayOf = new Uint16Array(hours);
    const hourlyOf = new Uint16Array(hours);
    const leap = isLeapYear(year);
    for (let h = 0; h < hours; h++) {
        let rawDay = Math.floor(h / 24);
        if (leap) {
            const feb29Index = CUMULATIVE_DAYS[1] + 28; // 59
            if (rawDay === feb29Index) rawDay = feb29Index - 1;
            else if (rawDay > feb29Index) rawDay -= 1;
        }
        dayOf[h] = rawDay;
        const bucket = Math.floor((h % 24) / BUCKET_HOURS);
        hourlyOf[h] = rawDay * BUCKETS_PER_DAY + bucket;
    }
    return { dayOf, hourlyOf };
}

async function downloadYearFile(year: number): Promise<string> {
    mkdirSync(CACHE_DIR, { recursive: true });
    const dest = path.join(CACHE_DIR, `year_${year}.om`);
    if (existsSync(dest)) {
        console.log(`  [${year}] already downloaded, reusing ${dest}`);
        return dest;
    }
    const url = YEAR_FILE_URL(year);
    console.log(`  [${year}] downloading ${url} ...`);
    const start = Date.now();
    const response = await fetch(url);
    if (!response.ok || !response.body) throw new Error(`Download failed for ${year}: ${response.status}`);
    const tmpDest = `${dest}.part`;
    const fileHandle = await open(tmpDest, 'w');
    const writeStream = fileHandle.createWriteStream();
    await finished(Readable.fromWeb(response.body as never).pipe(writeStream));
    await fileHandle.close();
    renameSync(tmpDest, dest);
    console.log(`  [${year}] downloaded in ${((Date.now() - start) / 1000).toFixed(0)}s`);
    return dest;
}

interface Accumulators {
    dailySum: Float64Array;
    dailyCount: Uint16Array;
    hourlySum: Uint32Array; // integer accumulation — see file header
    hourlyCount: Uint16Array;
}

function dailyIndex(latIdx: number, lonIdx: number, day: number): number {
    return (latIdx * LON_COUNT + lonIdx) * DAYS + day;
}
function hourlyIndex(latIdx: number, lonIdx: number, slot: number): number {
    return (latIdx * LON_COUNT + lonIdx) * ACCUM_HOURLY_SLOTS + slot;
}

function checkpointPath(year: number): string {
    return path.join(CACHE_DIR, `checkpoint_through_${year}.json`);
}

const IO_CHUNK_BYTES = 512 * 1024 * 1024; // 512MB, safely under the 2^31-1 per-syscall cap

/** Writes via a `.tmp` sibling + atomic rename, same pattern as downloadYearFile's `.part` file —
 *  so a crash mid-write leaves the previous, still-valid target file in place (the rename either
 *  fully happens or fully doesn't) instead of a partially-overwritten one. Each of the 4
 *  accumulator files is rewritten this way in processYear, and the year's checkpoint marker is
 *  only written after all 4 renames succeed — see processYear for why that ordering matters. */
function writeLargeFileSync(filePath: string, buffer: Buffer): void {
    const tmpPath = `${filePath}.tmp`;
    const fd = openSync(tmpPath, 'w');
    try {
        let offset = 0;
        while (offset < buffer.length) {
            const length = Math.min(IO_CHUNK_BYTES, buffer.length - offset);
            offset += writeSync(fd, buffer, offset, length);
        }
    } finally {
        closeSync(fd);
    }
    renameSync(tmpPath, filePath);
}

function readLargeFileSync(filePath: string, byteLength: number): Buffer {
    // Validate size up front rather than discovering a short read partway through: a truncated
    // file (e.g. from a crash before the writeLargeFileSync rewrite in this codebase, or from
    // manual tampering) would otherwise silently zero-fill the remainder via the old
    // `if (bytesRead === 0) break` behavior, producing a plausible-looking but wrong accumulator.
    const actualSize = statSync(filePath).size;
    if (actualSize !== byteLength) {
        throw new Error(
            `Accumulator file ${filePath} is ${actualSize} bytes, expected ${byteLength} — likely truncated by a previous crash; ` +
                'delete stale checkpoint markers or restore from backup.',
        );
    }
    const fd = openSync(filePath, 'r');
    try {
        const buffer = Buffer.alloc(byteLength);
        let offset = 0;
        while (offset < byteLength) {
            const length = Math.min(IO_CHUNK_BYTES, byteLength - offset);
            const bytesRead = readSync(fd, buffer, offset, length, null);
            if (bytesRead === 0) break;
            offset += bytesRead;
        }
        // Second line of defense: the size check above should already guarantee this, but if the
        // file changed size between the statSync and the read (or the read loop otherwise came up
        // short), fail loudly instead of returning a partially zero-filled buffer.
        if (offset !== byteLength) {
            throw new Error(`Accumulator file ${filePath}: read ${offset} of ${byteLength} expected bytes — truncated mid-read.`);
        }
        return buffer;
    } finally {
        closeSync(fd);
    }
}

// Set once a non-integer or negative cloud_cover reading is seen, so the warning below fires
// once per run instead of potentially once per hour across a 30GB pass.
let warnedNonIntegerCloudCover = false;

async function processYear(year: number, acc: Accumulators): Promise<void> {
    const filePath = await downloadYearFile(year);
    const { dayOf, hourlyOf } = buildHourToSlots(year);

    const backend = new FileBackend(filePath);
    const reader = await OmFileReader.create(backend);
    const dims = reader.getDimensions();
    if (dims[0] !== LAT_COUNT || dims[1] !== LON_COUNT) {
        throw new Error(`Unexpected ERA5 grid dims for ${year}: ${dims.join('x')} (expected ${LAT_COUNT}x${LON_COUNT}x*)`);
    }

    console.log(`  [${year}] processing ${LAT_RANGE[1] - LAT_RANGE[0]} rows ...`);
    const rowStart = Date.now();
    for (let lat = LAT_RANGE[0]; lat < LAT_RANGE[1]; lat++) {
        const ranges = [
            { start: lat, end: lat + 1 },
            { start: LON_RANGE[0], end: LON_RANGE[1] },
            { start: 0, end: dims[2] },
        ];
        const row = await reader.read({ type: OmDataType.FloatArray, ranges });
        const lonSpan = LON_RANGE[1] - LON_RANGE[0];
        for (let lonOffset = 0; lonOffset < lonSpan; lonOffset++) {
            const lon = LON_RANGE[0] + lonOffset;
            const base = lonOffset * dayOf.length;
            for (let h = 0; h < dayOf.length; h++) {
                const value = row[base + h];
                if (!Number.isFinite(value)) continue;
                // Same source value feeds both accumulators — the whole point of combining
                // these two scripts, since fetching it (the expensive part) only happens once.
                const dIdx = dailyIndex(lat, lon, dayOf[h]);
                acc.dailySum[dIdx] += value;
                acc.dailyCount[dIdx] += 1;
                // hourlySum is a Uint32Array (see file header for why an integer accumulator was
                // chosen over float): a non-integer value would silently truncate, and a negative
                // one would wrap to ~4.29e9 and poison that cell permanently. ERA5 cloud_cover has
                // always arrived as whole non-negative percents, but if that ever changes upstream
                // this should fail loudly (via the warning) rather than corrupt data silently.
                if (Number.isInteger(value) && value >= 0) {
                    const hIdx = hourlyIndex(lat, lon, hourlyOf[h]);
                    acc.hourlySum[hIdx] += value;
                    acc.hourlyCount[hIdx] += 1;
                } else if (!warnedNonIntegerCloudCover) {
                    warnedNonIntegerCloudCover = true;
                    console.warn(
                        `Warning: [${year}] cloud_cover value ${value} at lat ${lat}, lon ${lon} is not a non-negative integer — ` +
                            'skipping this reading for the hourly (Uint32Array) accumulator to avoid wraparound corruption ' +
                            '(the daily Float64Array accumulator is unaffected). This suggests the upstream ERA5 data format ' +
                            'changed; further such values this run will be skipped silently.',
                    );
                }
            }
        }
        if ((lat - LAT_RANGE[0]) % 50 === 0) {
            const elapsed = (Date.now() - rowStart) / 1000;
            console.log(`    row ${lat - LAT_RANGE[0]}/${LAT_RANGE[1] - LAT_RANGE[0]} (${elapsed.toFixed(0)}s elapsed)`);
        }
    }
    await backend.close();

    // Each of these 4 rewrites is individually atomic (write-then-rename, see writeLargeFileSync)
    // and the checkpoint marker is written only after ALL 4 have landed — so a crash at any point
    // up through here leaves the previous year's still-fully-valid accumulator files in place and
    // no marker claiming `year` is done, and resume logic (latestCheckpointedYear /
    // loadOrCreateAccumulators) reprocesses `year` from that last-good state rather than silently
    // double-counting it.
    writeLargeFileSync(path.join(CACHE_DIR, 'daily-sum.f64'), Buffer.from(acc.dailySum.buffer));
    writeLargeFileSync(path.join(CACHE_DIR, 'daily-count.u16'), Buffer.from(acc.dailyCount.buffer));
    writeLargeFileSync(path.join(CACHE_DIR, 'hourly-sum.u32'), Buffer.from(acc.hourlySum.buffer));
    writeLargeFileSync(path.join(CACHE_DIR, 'hourly-count.u16'), Buffer.from(acc.hourlyCount.buffer));
    writeFileSync(checkpointPath(year), JSON.stringify({ throughYear: year }));
    console.log(`  [${year}] done, checkpointed`);

    if (!KEEP_DOWNLOADS) rmSync(filePath, { force: true });
}

function accumulatorPaths(): Array<{ path: string; expectedBytes: number }> {
    const dailySize = LAT_COUNT * LON_COUNT * DAYS;
    const hourlySize = LAT_COUNT * LON_COUNT * ACCUM_HOURLY_SLOTS;
    return [
        { path: path.join(CACHE_DIR, 'daily-sum.f64'), expectedBytes: dailySize * 8 },
        { path: path.join(CACHE_DIR, 'daily-count.u16'), expectedBytes: dailySize * 2 },
        { path: path.join(CACHE_DIR, 'hourly-sum.u32'), expectedBytes: hourlySize * 4 },
        { path: path.join(CACHE_DIR, 'hourly-count.u16'), expectedBytes: hourlySize * 2 },
    ];
}

/** Whether all 4 accumulator files exist AND are exactly the expected size for the current grid
 *  constants — the on-disk state that any checkpoint marker actually describes. Checkpoint markers
 *  are tiny 20-byte files fully decoupled from the ~30GB of accumulator state they claim to
 *  summarize, which opens two silent-corruption paths this guards against:
 *    - the (gitignored) accumulator binaries get deleted to reclaim disk while markers survive,
 *      so loadOrCreateAccumulators would otherwise hand back all-zero arrays while every year still
 *      reports "already checkpointed, skipping";
 *    - an interrupted `--force` run resets the accumulators but an older run's marker for a later
 *      year is still lying around, so a subsequent non-forced run would trust it.
 *  Callers must verify this BEFORE trusting any checkpoint marker. */
function accumulatorFilesPresentAndValid(): boolean {
    return accumulatorPaths().every(({ path: p, expectedBytes }) => {
        if (!existsSync(p)) return false;
        try {
            return statSync(p).size === expectedBytes;
        } catch {
            return false;
        }
    });
}

function loadOrCreateAccumulators(): Accumulators {
    const dailySize = LAT_COUNT * LON_COUNT * DAYS;
    const hourlySize = LAT_COUNT * LON_COUNT * ACCUM_HOURLY_SLOTS;
    const [dailySumFile, dailyCountFile, hourlySumFile, hourlyCountFile] = accumulatorPaths();
    if (!FORCE && accumulatorFilesPresentAndValid()) {
        console.log('Resuming from existing checkpoint accumulators.');
        return {
            dailySum: new Float64Array(readLargeFileSync(dailySumFile.path, dailySize * 8).buffer, 0, dailySize),
            dailyCount: new Uint16Array(readLargeFileSync(dailyCountFile.path, dailySize * 2).buffer, 0, dailySize),
            hourlySum: new Uint32Array(readLargeFileSync(hourlySumFile.path, hourlySize * 4).buffer, 0, hourlySize),
            hourlyCount: new Uint16Array(readLargeFileSync(hourlyCountFile.path, hourlySize * 2).buffer, 0, hourlySize),
        };
    }
    return {
        dailySum: new Float64Array(dailySize),
        dailyCount: new Uint16Array(dailySize),
        hourlySum: new Uint32Array(hourlySize),
        hourlyCount: new Uint16Array(hourlySize),
    };
}

/** Deletes every checkpoint_through_*.json marker in CACHE_DIR. Called for `--force` so an
 *  interrupted forced run can't leave a stale marker (pointing at data that was reset) for a
 *  later non-forced run to wrongly trust. */
function deleteAllCheckpointMarkers(): void {
    if (!existsSync(CACHE_DIR)) return;
    for (const entry of readdirSync(CACHE_DIR)) {
        if (/^checkpoint_through_\d+\.json$/.test(entry)) {
            rmSync(path.join(CACHE_DIR, entry), { force: true });
        }
    }
}

/** The latest year N such that EVERY year from YEAR_START through N has a (size-verified) valid
 *  checkpoint marker — not just the overall maximum marker year. Markers for e.g. 2001-2005 plus
 *  2010 (producible by mixing --year-start/--year-end across runs) must resume at 2005, reprocessing
 *  2006-2009, rather than trusting 2010 and silently skipping the gap forever. */
function latestCheckpointedYear(): number | null {
    if (FORCE) return null;
    if (!accumulatorFilesPresentAndValid()) {
        // Markers describe accumulator state that no longer exists on disk (deleted, or reset by
        // an interrupted --force run) — trusting them would skip years whose data isn't actually
        // there. loadOrCreateAccumulators independently arrives at the same "start fresh" call.
        return null;
    }

    let latest: number | null = null;
    for (let y = YEAR_START; y <= YEAR_END; y++) {
        if (!existsSync(checkpointPath(y))) break; // first gap ends the contiguous run from the start
        latest = y;
    }

    // Warn about any "orphan" markers beyond the contiguous run — they exist on disk but will be
    // silently reprocessed and overwritten, which is correct but worth flagging as an incomplete
    // cache (e.g. from a previous run that used different --year-start/--year-end values).
    const firstGapYear = latest === null ? YEAR_START : latest + 1;
    const orphanYears: number[] = [];
    for (let y = firstGapYear + 1; y <= YEAR_END; y++) {
        if (existsSync(checkpointPath(y))) orphanYears.push(y);
    }
    if (orphanYears.length > 0) {
        console.warn(
            `Warning: checkpoint markers exist for year(s) ${orphanYears.join(', ')} but year ${firstGapYear} has no marker — ` +
                `resuming from ${latest ?? 'the start'} and reprocessing the gap. This can happen when --year-start/--year-end ` +
                'were mixed across runs; the cache is currently incomplete for the configured range.',
        );
    }
    return latest;
}

function writeTiles(acc: Accumulators): void {
    mkdirSync(DAILY_OUT_DIR, { recursive: true });
    mkdirSync(HOURLY_OUT_DIR, { recursive: true });
    let written = 0;
    for (let latTile = 0; latTile < LAT_TILES; latTile++) {
        const rows = latRowsInTile(latTile);
        for (let lonTile = 0; lonTile < LON_TILES; lonTile++) {
            const dailyBuf = Buffer.alloc(rows * POINTS_PER_TILE * DAYS);
            const hourlyBuf = Buffer.alloc(rows * POINTS_PER_TILE * OUT_HOURLY_SLOTS);
            let dbi = 0;
            let hbi = 0;
            for (let r = 0; r < rows; r++) {
                const lat = latTile * POINTS_PER_TILE + r;
                for (let c = 0; c < POINTS_PER_TILE; c++) {
                    const lon = lonTile * POINTS_PER_TILE + c;
                    for (let day = 0; day < DAYS; day++) {
                        const idx = dailyIndex(lat, lon, day);
                        const count = acc.dailyCount[idx];
                        dailyBuf[dbi++] = count === 0 ? 255 : Math.round(acc.dailySum[idx] / count);
                    }
                    // Aggregate the accumulator's per-day slots into the published day groups.
                    // Summing sums and counts (rather than averaging averages) keeps this an exact
                    // mean over every contributing hour, with days that had no data simply absent.
                    for (let group = 0; group < HOURLY_DAY_GROUPS; group++) {
                        const firstDay = group * HOURLY_DAY_GROUP_DAYS;
                        const lastDay = Math.min(DAYS, firstDay + HOURLY_DAY_GROUP_DAYS);
                        for (let bucket = 0; bucket < BUCKETS_PER_DAY; bucket++) {
                            let sum = 0;
                            let count = 0;
                            for (let day = firstDay; day < lastDay; day++) {
                                const idx = hourlyIndex(lat, lon, day * BUCKETS_PER_DAY + bucket);
                                const c = acc.hourlyCount[idx];
                                if (c === 0) continue;
                                sum += acc.hourlySum[idx];
                                count += c;
                            }
                            hourlyBuf[hbi++] = count === 0 ? 255 : Math.round(sum / count);
                        }
                    }
                }
            }
            writeFileSync(path.join(DAILY_OUT_DIR, `${lonTile}_${latTile}.bin`), dailyBuf);
            writeFileSync(path.join(HOURLY_OUT_DIR, `${lonTile}_${latTile}.bin`), hourlyBuf);
            written++;
        }
    }
    console.log(`Wrote ${written} daily tiles to ${DAILY_OUT_DIR} and ${written} hourly tiles to ${HOURLY_OUT_DIR}`);
}

async function main() {
    if (TILES_ONLY) {
        console.log(`--tiles-only: writing tiles from the existing checkpoint in ${CACHE_DIR} (no download/processing).`);
        const acc = loadOrCreateAccumulators();
        writeTiles(acc);
        console.log('Done.');
        return;
    }

    console.log(`Combined climatology build: years ${YEAR_START}-${YEAR_END}${SAMPLE ? ' (SAMPLE MODE)' : ''}`);
    if (FORCE) {
        // Not just resetting the accumulator contents: a marker left over from before this
        // --force run (or from an interrupted one) would otherwise let a later non-forced run
        // trust a year as done when the data behind it was actually wiped.
        console.log('--force: deleting existing checkpoint markers.');
        deleteAllCheckpointMarkers();
    }
    const acc = loadOrCreateAccumulators();
    const resumeFrom = latestCheckpointedYear();
    for (let year = YEAR_START; year <= YEAR_END; year++) {
        if (resumeFrom !== null && year <= resumeFrom) {
            console.log(`  [${year}] already checkpointed, skipping`);
            continue;
        }
        await processYear(year, acc);
    }
    writeTiles(acc);
    console.log('Done.');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
