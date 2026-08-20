import { useT } from '../i18n';

interface WeeklyHourChartProps {
    /** One value per day-of-year slot (not averaged together across days), centered on the
     *  eclipse day (dayOffset 0). Note: the underlying hourly tiles group the year into ~10-day
     *  climatological windows rather than 365 individual days (see HOURLY_DAY_GROUP_DAYS in
     *  climatologyGrid.ts), so consecutive days landing in the same window read back the exact
     *  same value — several neighboring bars can legitimately be identical. */
    curve: Array<{ dayOffset: number; value: number | null }>;
}

const WIDTH = 300;
const HEIGHT = 90;
const MARGIN = { top: 6, right: 6, bottom: 16, left: 24 };
const INNER_WIDTH = WIDTH - MARGIN.left - MARGIN.right;
const INNER_HEIGHT = HEIGHT - MARGIN.top - MARGIN.bottom;

/** Day-by-day (not blended into one average) cloud cover at the eclipse's actual hour, across
 *  the week centered on the eclipse date — shows whether that hour trends clearer/cloudier
 *  through the surrounding days, which a single blended "X jours" number can't show. Resolution
 *  is capped at the ~10-day climatological window the source tiles group by (see
 *  WeeklyHourChartProps.curve), so this shows real variation across window boundaries, not true
 *  single-day precision. */
export function WeeklyHourChart({ curve }: WeeklyHourChartProps) {
    const t = useT();
    if (curve.length === 0) return null;

    const barWidth = INNER_WIDTH / curve.length;
    const yScale = (percent: number) => MARGIN.top + (1 - percent / 100) * INNER_HEIGHT;
    const xForIndex = (i: number) => MARGIN.left + i * barWidth;

    return (
        <div className="seasonal-chart">
            <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} width="100%" height={HEIGHT} role="img" aria-label={t('chart.weeklyAria')}>
                {[0, 50, 100].map((v) => (
                    <line key={v} x1={MARGIN.left} x2={WIDTH - MARGIN.right} y1={yScale(v)} y2={yScale(v)} stroke="var(--grid)" strokeWidth={1} />
                ))}
                {[0, 50, 100].map((v) => (
                    <text key={v} x={MARGIN.left - 4} y={yScale(v) + 3} fontSize={8} fill="var(--text-muted)" textAnchor="end">
                        {v}
                    </text>
                ))}

                {curve.map(({ dayOffset, value }, i) => {
                    if (value === null) return null;
                    const x = xForIndex(i);
                    const barInset = barWidth * 0.15;
                    const isEclipseDay = dayOffset === 0;
                    return (
                        <rect
                            key={dayOffset}
                            x={x + barInset}
                            y={yScale(value)}
                            width={Math.max(1, barWidth - barInset * 2)}
                            height={Math.max(0, HEIGHT - MARGIN.bottom - yScale(value))}
                            fill={isEclipseDay ? 'var(--series-sun)' : 'var(--series-horizon)'}
                            fillOpacity={isEclipseDay ? 1 : 0.7}
                        />
                    );
                })}

                {curve.map(({ dayOffset }, i) => (
                    <text key={dayOffset} x={xForIndex(i) + barWidth / 2} y={HEIGHT - 4} fontSize={8} fill="var(--text-muted)" textAnchor="middle">
                        {dayOffset === 0 ? t('chart.eclipseDay') : dayOffset > 0 ? `+${dayOffset}` : dayOffset}
                    </text>
                ))}
            </svg>
        </div>
    );
}
