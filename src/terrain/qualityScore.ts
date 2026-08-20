/** Combines terrain visibility, climatology cloud cover, and duration (central duration when the
 *  eclipse has a real total/annular phase, magnitude otherwise) into one 0-1 "how good is this
 *  spot" score. All three factors are already 0-1 fractions of their own best case, so a plain
 *  product is a natural AND-like combination — a location only scores well if it's genuinely good
 *  on every axis, not just on average.
 *
 *  For an eclipse with a real central phase somewhere, points with no centrality of their own are
 *  excluded (null) rather than scored low, since this score is specifically about "where should I
 *  stand for totality" — shared between the Focus map's per-cell grid and the selected point's own
 *  score readout, so both always agree on the same number for the same spot. */
export interface QualityScoreInputs {
    visibleFraction: number | null;
    magnitude: number | null;
    centralDurationSeconds: number | null;
    cloudCoverPercent: number | null;
    maxCentralDurationSeconds: number;
    maxMagnitude: number;
    /** When false, the duration factor is left out and the score becomes relief × météo alone.
     *  Duration dominates the product near the edges of the umbra — a spot with perfectly clear
     *  sky and an open horizon still scores low simply for sitting off the centre line — which is
     *  the right default for "where do I get the longest totality", but hides the answer to a
     *  different and equally reasonable question: "of the places I could actually reach, which
     *  has the best chance of *seeing* it at all". Turning this off answers the second.
     *
     *  It does NOT widen the scope: cells with no central phase are still excluded whenever the
     *  eclipse has one somewhere, because that scope (totality only, not the partial zone) is what
     *  this score is about. Only the weighting by *how long* changes. */
    includeDuration?: boolean;
}

export function combineQualityScore({
    visibleFraction,
    magnitude,
    centralDurationSeconds,
    cloudCoverPercent,
    maxCentralDurationSeconds,
    maxMagnitude,
    includeDuration = true,
}: QualityScoreInputs): number | null {
    if (visibleFraction === null || magnitude === null || cloudCoverPercent === null) return null;
    const clarity = Math.max(0, Math.min(1, 1 - cloudCoverPercent / 100));

    if (maxCentralDurationSeconds > 0) {
        if (!centralDurationSeconds || centralDurationSeconds <= 0) return null;
        if (!includeDuration) return visibleFraction * clarity;
        const durationFactor = Math.max(0, Math.min(1, centralDurationSeconds / maxCentralDurationSeconds));
        return visibleFraction * clarity * durationFactor;
    }
    // Purely partial eclipse: there is no centrality to measure, so magnitude stands in for
    // "how much of an eclipse you get" and is what the duration switch turns off here.
    if (!includeDuration) return visibleFraction * clarity;
    // Guard against a zero divisor the same way the centralDuration branch above is guarded by
    // its own `maxCentralDurationSeconds > 0` check — without it, `magnitude / 0` is Infinity (or
    // NaN if magnitude is also 0), and `Math.max(0, Math.min(1, NaN))` is NaN, which would then
    // silently survive as this function's return value instead of a clamped number.
    if (maxMagnitude <= 0) return visibleFraction * clarity;
    const durationFactor = Math.max(0, Math.min(1, magnitude / maxMagnitude));
    return visibleFraction * clarity * durationFactor;
}
