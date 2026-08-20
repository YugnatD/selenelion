import { useT } from '../i18n';

interface DayHourProfileChartProps {
    /** All 12 two-hour buckets (0-11) for the eclipse's calendar day. */
    curve: Array<{ bucket: number; value: number | null }>;
    /** The bucket (0-11) containing the eclipse's actual hour, highlighted. Bucketing (and this
     *  comparison) is done in UTC — see climatologyHourlyTiles.ts's hourBucket — independently of
     *  the display labels below, which are localized. */
    highlightBucket: number;
    /** Local wall-clock label for each of the 12 UTC buckets (index = bucket), e.g. "14:00", in
     *  the selected point's own timezone rather than UTC — this panel otherwise displays every
     *  other time in local time, and the buckets themselves stay in UTC underneath. Falls back to
     *  a plain UTC "00h"-style label per bucket when the caller can't resolve a timezone yet. */
    bucketLabels?: string[];
}

const WIDTH = 300;
const HEIGHT = 90;
const MARGIN = { top: 6, right: 6, bottom: 16, left: 24 };
const INNER_WIDTH = WIDTH - MARGIN.left - MARGIN.right;
const INNER_HEIGHT = HEIGHT - MARGIN.top - MARGIN.bottom;

/** Diurnal cloud-cover profile (12 two-hour buckets) for the eclipse's own calendar day at this
 *  point — is the eclipse's hour historically in a clearer or cloudier stretch of that same day
 *  (e.g. morning fog that usually burns off by afternoon)? Complements WeeklyHourChart (same
 *  hour, different days) with the reverse view (same day, different hours). */
export function DayHourProfileChart({ curve, highlightBucket, bucketLabels }: DayHourProfileChartProps) {
    const t = useT();
    if (curve.length === 0) return null;

    const barWidth = INNER_WIDTH / curve.length;
    const yScale = (percent: number) => MARGIN.top + (1 - percent / 100) * INNER_HEIGHT;
    const xForIndex = (i: number) => MARGIN.left + i * barWidth;

    return (
        <div className="seasonal-chart">
            <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} width="100%" height={HEIGHT} role="img" aria-label={t('chart.dayProfileAria')}>
                {[0, 50, 100].map((v) => (
                    <line key={v} x1={MARGIN.left} x2={WIDTH - MARGIN.right} y1={yScale(v)} y2={yScale(v)} stroke="var(--grid)" strokeWidth={1} />
                ))}
                {[0, 50, 100].map((v) => (
                    <text key={v} x={MARGIN.left - 4} y={yScale(v) + 3} fontSize={8} fill="var(--text-muted)" textAnchor="end">
                        {v}
                    </text>
                ))}

                {curve.map(({ bucket, value }, i) => {
                    if (value === null) return null;
                    const x = xForIndex(i);
                    const barInset = barWidth * 0.15;
                    const isEclipseHour = bucket === highlightBucket;
                    return (
                        <rect
                            key={bucket}
                            x={x + barInset}
                            y={yScale(value)}
                            width={Math.max(1, barWidth - barInset * 2)}
                            height={Math.max(0, HEIGHT - MARGIN.bottom - yScale(value))}
                            fill={isEclipseHour ? 'var(--series-sun)' : 'var(--series-horizon)'}
                            fillOpacity={isEclipseHour ? 1 : 0.7}
                        />
                    );
                })}

                {curve.map(({ bucket }, i) => (
                    <text key={bucket} x={xForIndex(i) + barWidth / 2} y={HEIGHT - 4} fontSize={7} fill="var(--text-muted)" textAnchor="middle">
                        {bucketLabels?.[bucket] ?? `${(bucket * 2).toString().padStart(2, '0')}:00`}
                    </text>
                ))}
            </svg>
        </div>
    );
}
