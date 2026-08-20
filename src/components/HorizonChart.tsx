import { useMemo, useState } from 'react';
import { formatLocalTimeShort } from '../engine/timezone';
import { useT } from '../i18n';
import type { HorizonPoint } from '../terrain/horizon';
import { horizonAltitudeAt } from '../terrain/horizon';
import type { VisibilitySample } from '../terrain/visibility';

interface HorizonChartProps {
    horizonProfile: HorizonPoint[];
    samples: VisibilitySample[];
    timeZone: string;
    /** Which body the orange curve is tracking. The chart is reused as-is for lunar eclipses, where
     *  labelling that curve "Sun" was simply wrong — the panel had to add a sentence underneath
     *  correcting its own legend. */
    body?: 'sun' | 'moon';
}

const WIDTH = 300;
const HEIGHT = 170;
const MARGIN = { top: 10, right: 8, bottom: 20, left: 26 };
const INNER_WIDTH = WIDTH - MARGIN.left - MARGIN.right;
const INNER_HEIGHT = HEIGHT - MARGIN.top - MARGIN.bottom;

/** Cardinal points differ by language (west is O in French, W in English), so they are keys
 *  resolved at render time rather than baked-in letters. */
const COMPASS_TICKS = [
    { azimuth: 0, key: 'chart.compassN' },
    { azimuth: 90, key: 'chart.compassE' },
    { azimuth: 180, key: 'chart.compassS' },
    { azimuth: 270, key: 'chart.compassW' },
    { azimuth: 360, key: 'chart.compassN' },
] as const;

/** Shortest angular distance between two azimuths (0-360°), correctly handling the wrap past
 *  north (e.g. 358° and 2° are 4° apart, not 356°). */
function azimuthDistance(a: number, b: number): number {
    const diff = Math.abs(a - b) % 360;
    return diff > 180 ? 360 - diff : diff;
}

/** Where the Sun actually is only ever spans a slice of the compass during one eclipse;
 *  zooming the x-axis to that slice (with padding) keeps the path legible instead of a
 *  sliver on a full 360° dial. */
function computeAzimuthDomain(samples: VisibilitySample[]): [number, number] {
    if (samples.length === 0) return [0, 360];
    let rawMin = Infinity;
    let rawMax = -Infinity;
    for (const s of samples) {
        if (s.azimuth < rawMin) rawMin = s.azimuth;
        if (s.azimuth > rawMax) rawMax = s.azimuth;
    }
    if (rawMax - rawMin >= 180) return [0, 360]; // likely wraps past N; fall back to the full dial
    const pad = Math.max(5, (rawMax - rawMin) * 0.25);
    return [Math.max(0, rawMin - pad), Math.min(360, rawMax + pad)];
}

export function HorizonChart({ horizonProfile, samples, timeZone, body = 'sun' }: HorizonChartProps) {
    const t = useT();
    const bodyLabel = body === 'moon' ? t('chart.moon') : t('chart.sun');
    const [hoverAzimuth, setHoverAzimuth] = useState<number | null>(null);

    const { xMin, xMax, xScale, yScale, areaPath, horizonLinePath, sunPath, yTicks, xTicks } = useMemo(() => {
        const [xMin, xMax] = computeAzimuthDomain(samples);

        const altitudes = [
            ...horizonProfile.filter((p) => p.azimuth >= xMin && p.azimuth <= xMax).map((p) => p.altitude),
            ...samples.map((s) => s.altitude),
            0,
        ];
        const rawMin = Math.min(...altitudes);
        const rawMax = Math.max(...altitudes);
        const yMin = Math.floor((rawMin - 2) / 5) * 5;
        const yMax = Math.ceil((rawMax + 2) / 5) * 5;

        const xScale = (azimuth: number) => MARGIN.left + ((azimuth - xMin) / (xMax - xMin)) * INNER_WIDTH;
        const yScale = (altitude: number) => MARGIN.top + (1 - (altitude - yMin) / (yMax - yMin)) * INNER_HEIGHT;

        const visibleProfile = [
            { azimuth: xMin, altitude: horizonAltitudeAt(horizonProfile, xMin) },
            ...horizonProfile.filter((p) => p.azimuth > xMin && p.azimuth < xMax),
            { azimuth: xMax, altitude: horizonAltitudeAt(horizonProfile, xMax) },
        ];

        const baseline = yScale(yMin);
        const areaPath =
            `M ${xScale(xMin).toFixed(1)},${baseline.toFixed(1)} ` +
            visibleProfile.map((p) => `L ${xScale(p.azimuth).toFixed(1)},${yScale(p.altitude).toFixed(1)}`).join(' ') +
            ` L ${xScale(xMax).toFixed(1)},${baseline.toFixed(1)} Z`;
        const horizonLinePath = visibleProfile
            .map((p, i) => `${i === 0 ? 'M' : 'L'} ${xScale(p.azimuth).toFixed(1)},${yScale(p.altitude).toFixed(1)}`)
            .join(' ');

        const sunPath = samples
            .map((s, i) => `${i === 0 ? 'M' : 'L'} ${xScale(s.azimuth).toFixed(1)},${yScale(s.altitude).toFixed(1)}`)
            .join(' ');

        const yTicks: number[] = [];
        for (let v = Math.ceil(yMin / 10) * 10; v <= yMax; v += 10) yTicks.push(v);

        const xRange = xMax - xMin;
        const xStep = xRange <= 40 ? 5 : xRange <= 100 ? 10 : xRange <= 200 ? 30 : 60;
        const xTicks: number[] = [];
        for (let v = Math.ceil(xMin / xStep) * xStep; v <= xMax; v += xStep) xTicks.push(v);

        return { xMin, xMax, xScale, yScale, areaPath, horizonLinePath, sunPath, yTicks, xTicks };
    }, [horizonProfile, samples]);

    const isFullCircle = xMax - xMin >= 360;

    // Memoized so a re-render triggered by something other than the hover position itself (e.g.
    // a parent state change while the mouse sits still) doesn't redo this reduce over every
    // sample — matches how the (cheaper) path math above is already memoized.
    const hovered = useMemo(
        () =>
            hoverAzimuth === null
                ? null
                : {
                      azimuth: hoverAzimuth,
                      horizonAltitude: horizonAltitudeAt(horizonProfile, hoverAzimuth),
                      sample: samples.reduce<VisibilitySample | null>((closest, s) => {
                          if (!closest) return s;
                          const d = azimuthDistance(s.azimuth, hoverAzimuth);
                          const dClosest = azimuthDistance(closest.azimuth, hoverAzimuth);
                          return d < dClosest ? s : closest;
                      }, null),
                  },
        [hoverAzimuth, horizonProfile, samples],
    );

    function handleMouseMove(e: React.MouseEvent<SVGRectElement>) {
        const rect = e.currentTarget.getBoundingClientRect();
        const fraction = (e.clientX - rect.left) / rect.width;
        setHoverAzimuth(Math.max(xMin, Math.min(xMax, xMin + fraction * (xMax - xMin))));
    }

    return (
        <div className="horizon-chart">
            <svg
                viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
                width="100%"
                height={HEIGHT}
                role="img"
                aria-label={t('chart.horizonAria')}
            >
                {yTicks.map((v) => (
                    <line
                        key={v}
                        x1={MARGIN.left}
                        x2={WIDTH - MARGIN.right}
                        y1={yScale(v)}
                        y2={yScale(v)}
                        stroke="var(--grid)"
                        strokeWidth={1}
                    />
                ))}
                <line
                    x1={MARGIN.left}
                    x2={WIDTH - MARGIN.right}
                    y1={yScale(0)}
                    y2={yScale(0)}
                    stroke="var(--text-muted)"
                    strokeWidth={1}
                    strokeDasharray="2 2"
                />

                <path d={areaPath} fill="var(--series-horizon)" fillOpacity={0.18} />
                <path d={horizonLinePath} fill="none" stroke="var(--series-horizon)" strokeWidth={2} strokeLinejoin="round" />
                <path d={sunPath} fill="none" stroke="var(--series-sun)" strokeWidth={2} strokeLinejoin="round" />

                {samples
                    .filter((s) => s.inCentralEclipse)
                    .map((s) => (
                        <circle
                            key={s.time.getTime()}
                            cx={xScale(s.azimuth)}
                            cy={yScale(s.altitude)}
                            r={1.6}
                            fill="var(--series-sun)"
                        />
                    ))}

                {isFullCircle
                    ? COMPASS_TICKS.map((tick) => (
                          <text key={tick.azimuth} x={xScale(tick.azimuth)} y={HEIGHT - 5} fontSize={10} fill="var(--text-muted)" textAnchor="middle">
                              {t(tick.key)}
                          </text>
                      ))
                    : xTicks.map((v) => (
                          <text key={v} x={xScale(v)} y={HEIGHT - 5} fontSize={9} fill="var(--text-muted)" textAnchor="middle">
                              {v}°
                          </text>
                      ))}
                {yTicks.map((v) => (
                    <text key={v} x={MARGIN.left - 4} y={yScale(v) + 3} fontSize={9} fill="var(--text-muted)" textAnchor="end">
                        {v}°
                    </text>
                ))}

                <text x={WIDTH - MARGIN.right} y={MARGIN.top + 10} fontSize={10} fill="var(--series-horizon)" textAnchor="end">
                    {t('chart.terrain')}
                </text>
                <text x={WIDTH - MARGIN.right} y={MARGIN.top + 22} fontSize={10} fill="var(--series-sun)" textAnchor="end">
                    {bodyLabel}
                </text>

                {hovered && (
                    <line
                        x1={xScale(hovered.azimuth)}
                        x2={xScale(hovered.azimuth)}
                        y1={MARGIN.top}
                        y2={HEIGHT - MARGIN.bottom}
                        stroke="var(--text-muted)"
                        strokeWidth={1}
                    />
                )}

                <rect
                    x={MARGIN.left}
                    y={MARGIN.top}
                    width={INNER_WIDTH}
                    height={INNER_HEIGHT}
                    fill="transparent"
                    onMouseMove={handleMouseMove}
                    onMouseLeave={() => setHoverAzimuth(null)}
                />
            </svg>
            {hovered && (
                <div className="horizon-chart-tooltip">
                    {t('chart.horizonTooltip', { azimuth: Math.round(hovered.azimuth), terrain: hovered.horizonAltitude.toFixed(1) })}
                    {hovered.sample &&
                        t('chart.horizonTooltipBody', {
                            body: bodyLabel.toLocaleLowerCase(),
                            altitude: hovered.sample.altitude.toFixed(1),
                            time: formatLocalTimeShort(hovered.sample.time, timeZone),
                        })}
                </div>
            )}
        </div>
    );
}
