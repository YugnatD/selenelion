/**
 * A deep link to PeakFinder (peakfinder.com) — a mountain-panorama viewer — aimed at the point
 * on the horizon where the eclipsed Sun (and Moon, at the same position) will be. Useful to
 * cross-check our own horizon-obstruction estimate against PeakFinder's own named-peak skyline.
 *
 * Parameters per https://github.com/Fabiz/PeakFinder-API: lat/lng (required), azi/alt aim the
 * initial view, fov sets the zoom, and date drives PeakFinder's own Sun/Moon calculations for the
 * same moment.
 *
 * The API also has teleazi/telealt, which draw a "telescope" reticle at an exact point. Those were
 * set here and are deliberately not any more: the reticle sits on top of the panorama and gets in
 * the way of reading the skyline, which is the entire reason for opening PeakFinder from here. The
 * view is still aimed at the eclipsed body through azi/alt, and `date` still lets PeakFinder draw
 * its own Sun/Moon track, so nothing is lost but the overlay. Re-adding them is two lines if the
 * marker turns out to be wanted.
 */
export function buildPeakfinderUrl(params: {
    lat: number;
    lon: number;
    azimuth: number;
    altitude: number;
    time: Date;
    name?: string;
}): string {
    const url = new URL('https://www.peakfinder.com/');
    url.searchParams.set('lat', params.lat.toFixed(5));
    url.searchParams.set('lng', params.lon.toFixed(5));
    // PeakFinder's documented range for the initial view tilt is -25..25°, but the body can sit
    // much higher, so the tilt is clamped. The azimuth is unaffected, so the view still faces the
    // right direction — you may just have to look up once there.
    url.searchParams.set('alt', Math.max(-25, Math.min(25, params.altitude)).toFixed(1));
    url.searchParams.set('azi', params.azimuth.toFixed(1));
    url.searchParams.set('fov', '65');
    // PeakFinder's documented date format has no milliseconds; toISOString() always emits
    // ".SSSZ", so strip that down to a bare-seconds ISO timestamp before it goes in the URL.
    url.searchParams.set('date', params.time.toISOString().replace(/\.\d{3}Z$/, 'Z'));
    if (params.name) url.searchParams.set('name', params.name);
    return url.toString();
}
