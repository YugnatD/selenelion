import { useT } from '../i18n';
import { useEclipseStore } from '../state/eclipseStore';
import { hourBucket } from '../weather/climatologyHourlyTiles';
import { CLIMATOLOGY_BASELINE_LABEL, dayOfYearSlot } from '../weather/climatologyTiles';
import { DayHourProfileChart } from './DayHourProfileChart';
import { SeasonalCloudChart } from './SeasonalCloudChart';
import { WeeklyHourChart } from './WeeklyHourChart';

/**
 * The weather block of the circumstances panel: headline cloud cover, the averaging controls, and
 * the three climatology charts (seasonal curve, week-by-week at the eclipse's hour, and the
 * diurnal profile).
 *
 * Shared by the solar and lunar panels rather than written twice. Everything it needs already
 * lives in the store and is populated identically for both — a lunar eclipse has a reference time
 * and a location just like a solar one, so "will it be cloudy there, then" is exactly the same
 * question. Keeping it in one place is also what stops the two panels drifting apart: the lunar
 * panel originally shipped with only the headline figure and silently dropped all three charts
 * even though the data behind them was already being fetched.
 */
export function WeatherSection() {
    const t = useT();
    const cloudCover = useEclipseStore((s) => s.cloudCover);
    const weatherLoading = useEclipseStore((s) => s.weatherLoading);
    const weatherError = useEclipseStore((s) => s.weatherError);
    const weatherDayWindow = useEclipseStore((s) => s.weatherDayWindow);
    const setWeatherDayWindow = useEclipseStore((s) => s.setWeatherDayWindow);
    const weatherTimeMode = useEclipseStore((s) => s.weatherTimeMode);
    const setWeatherTimeMode = useEclipseStore((s) => s.setWeatherTimeMode);
    const cloudCoverYearCurve = useEclipseStore((s) => s.cloudCoverYearCurve);
    const cloudCoverWeekCurve = useEclipseStore((s) => s.cloudCoverWeekCurve);
    const cloudCoverDayProfile = useEclipseStore((s) => s.cloudCoverDayProfile);
    const weatherReferenceTime = useEclipseStore((s) => s.weatherReferenceTime);

    const hour = weatherTimeMode === 'hour';
    const baseline = CLIMATOLOGY_BASELINE_LABEL;

    return (
        <>
            <h3>{t('weather.heading')}</h3>
            <div className="day-window-toggle" role="group" aria-label={t('weather.dayWindowGroup')}>
                {[1, 5, 7].map((days) => (
                    <button
                        key={days}
                        type="button"
                        className={weatherDayWindow === days ? 'active' : ''}
                        onClick={() => setWeatherDayWindow(days)}
                    >
                        {days === 1 ? t('weather.day') : t('weather.days', { count: days })}
                    </button>
                ))}
            </div>
            <div className="day-window-toggle" role="group" aria-label={t('weather.hourGroup')}>
                <button type="button" className={hour ? '' : 'active'} onClick={() => setWeatherTimeMode('day')}>
                    {t('weather.wholeDay')}
                </button>
                <button type="button" className={hour ? 'active' : ''} onClick={() => setWeatherTimeMode('hour')}>
                    {t('weather.eclipseHour')}
                </button>
            </div>
            {weatherLoading && <p className="hint">{t('weather.loading')}</p>}
            {!weatherLoading && weatherError && <p className="hint">{t('weather.error')}</p>}
            {!weatherLoading && !weatherError && !cloudCover && <p className="hint">{t('weather.noData')}</p>}
            {!weatherLoading && cloudCover && (
                <>
                    <span
                        className={`visibility-badge ${cloudCover.percent <= 30 ? 'ok' : cloudCover.percent <= 60 ? 'warning' : 'blocked'}`}
                    >
                        {t('weather.cloudCover', { percent: Math.round(cloudCover.percent) })}
                    </span>
                    <p className="hint">{t('weather.headlineNote', { hour, window: weatherDayWindow, baseline })}</p>
                </>
            )}
            {cloudCoverYearCurve && weatherReferenceTime && (
                <>
                    <SeasonalCloudChart
                        curve={cloudCoverYearCurve}
                        highlightDay={dayOfYearSlot(weatherReferenceTime)}
                        smoothingWindow={weatherDayWindow}
                    />
                    <p className="hint">{t('weather.seasonalNote', { hour, window: weatherDayWindow, baseline })}</p>
                </>
            )}
            {cloudCoverWeekCurve && (
                <>
                    <WeeklyHourChart curve={cloudCoverWeekCurve} />
                    <p className="hint">{t('weather.weeklyNote', { baseline })}</p>
                </>
            )}
            {cloudCoverDayProfile && weatherReferenceTime && (
                <>
                    <DayHourProfileChart curve={cloudCoverDayProfile} highlightBucket={hourBucket(weatherReferenceTime)} />
                    <p className="hint">{t('weather.dayProfileNote', { baseline })}</p>
                </>
            )}
        </>
    );
}
