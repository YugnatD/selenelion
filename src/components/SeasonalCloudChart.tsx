import { useT } from '../i18n';

interface SeasonalCloudChartProps {
    /** 365 values (day-of-year, Feb 29 folded into Feb 28), cloud cover % or null for no-data days. */
    curve: Array<number | null>;
    /** Day-of-year slot (0-364) of the eclipse's reference date, marked on the chart. */
    highlightDay: number;
    /** Days averaged together, matching the panel's 1/5/7 day-window control. Applied here rather
     *  than refetched: the whole year is already in memory, so smoothing is local arithmetic.
     *
     *  Without this the control looked broken — it visibly changed the headline figure while the
     *  chart under it sat still — and worse, the two disagreed: the marker plotted the raw value
     *  for that single day while the number above it was the windowed mean. Smoothing the curve by
     *  the same window makes the marker and the headline the same quantity. */
    smoothingWindow?: number;
}

/** Centred rolling mean that wraps around the year end, skipping no-data days. Mirrors
 *  daySlotsForWindow's circular window so the smoothing and the headline average cover exactly
 *  the same days. */
function smoothCircular(curve: Array<number | null>, window: number): Array<number | null> {
    if (window <= 1) return curve;
    const n = curve.length;
    const half = Math.floor(window / 2);
    return curve.map((_, i) => {
        let sum = 0;
        let count = 0;
        for (let d = -half; d < window - half; d++) {
            const value = curve[(((i + d) % n) + n) % n];
            if (value != null) {
                sum += value;
                count++;
            }
        }
        return count === 0 ? null : sum / count;
    });
}

const WIDTH = 300;
const HEIGHT = 90;
const MARGIN = { top: 6, right: 6, bottom: 16, left: 24 };
const INNER_WIDTH = WIDTH - MARGIN.left - MARGIN.right;
const INNER_HEIGHT = HEIGHT - MARGIN.top - MARGIN.bottom;
const DAYS = 365;

/** Cumulative day-of-year (non-leap) at the start of each month, for tick placement — same
 *  convention as climatologyTiles.ts's CUMULATIVE_DAYS. */
const MONTH_STARTS = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
const MONTH_LABELS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];

/** Small "seasonal context" chart: the full year's climatology curve at one point, so a user can
 *  see at a glance whether the eclipse date falls in a typically clear or typically cloudy
 *  stretch for that specific place — not just its own single value in isolation. */
export function SeasonalCloudChart({ curve: rawCurve, highlightDay, smoothingWindow = 1 }: SeasonalCloudChartProps) {
    const t = useT();
    const curve = smoothCircular(rawCurve, smoothingWindow);
    const xScale = (day: number) => MARGIN.left + (day / (DAYS - 1)) * INNER_WIDTH;
    const yScale = (percent: number) => MARGIN.top + (1 - percent / 100) * INNER_HEIGHT;

    const points = curve.map((v, day) => (v === null ? null : { day, value: v }));
    const segments: Array<{ day: number; value: number }[]> = [];
    let current: Array<{ day: number; value: number }> = [];
    for (const p of points) {
        if (p === null) {
            if (current.length > 0) segments.push(current);
            current = [];
        } else {
            current.push(p);
        }
    }
    if (current.length > 0) segments.push(current);

    if (segments.length === 0) return null;

    const highlightValue = curve[highlightDay];

    return (
        <div className="seasonal-chart">
            <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} width="100%" height={HEIGHT} role="img" aria-label={t('chart.seasonalAria')}>
                {[0, 50, 100].map((v) => (
                    <line key={v} x1={MARGIN.left} x2={WIDTH - MARGIN.right} y1={yScale(v)} y2={yScale(v)} stroke="var(--grid)" strokeWidth={1} />
                ))}
                {[0, 50, 100].map((v) => (
                    <text key={v} x={MARGIN.left - 4} y={yScale(v) + 3} fontSize={8} fill="var(--text-muted)" textAnchor="end">
                        {v}
                    </text>
                ))}

                {segments.map((seg, i) => (
                    <path
                        key={i}
                        d={seg.map((p, j) => `${j === 0 ? 'M' : 'L'} ${xScale(p.day).toFixed(1)},${yScale(p.value).toFixed(1)}`).join(' ')}
                        fill="none"
                        stroke="var(--series-horizon)"
                        strokeWidth={1.5}
                        strokeLinejoin="round"
                    />
                ))}

                {highlightValue !== null && highlightValue !== undefined && (
                    <>
                        <line
                            x1={xScale(highlightDay)}
                            x2={xScale(highlightDay)}
                            y1={MARGIN.top}
                            y2={HEIGHT - MARGIN.bottom}
                            stroke="var(--series-sun)"
                            strokeWidth={1}
                            strokeDasharray="2 2"
                        />
                        <circle cx={xScale(highlightDay)} cy={yScale(highlightValue)} r={2.5} fill="var(--series-sun)" />
                    </>
                )}

                {MONTH_STARTS.map((day, i) => (
                    <text key={day} x={xScale(day)} y={HEIGHT - 4} fontSize={8} fill="var(--text-muted)" textAnchor="middle">
                        {MONTH_LABELS[i]}
                    </text>
                ))}
            </svg>
        </div>
    );
}
