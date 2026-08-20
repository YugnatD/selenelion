import type { ReactNode } from 'react';
import { bandColors } from './contourRender';

// bandColors() takes no arguments and its output never changes — computed once for the whole
// app lifetime rather than on every render of every ContourLegend instance (both ObstructionMap
// and WeatherMap render one, and each re-renders on every loading/error state flip).
const BAND_COLORS = bandColors();

interface ContourLegendProps {
    lowLabel: string;
    highLabel: string;
    note?: string;
    /** Extra content appended below the note — e.g. FocusMap's own selected-point score readout.
     *  Optional so ObstructionMap/WeatherMap's plain legend is unaffected. */
    children?: ReactNode;
}

/** Legend swatches for a contour-band overlay — shared by the Obstruction and Weather views,
 *  which differ only in their two label strings and an optional note line. */
export function ContourLegend({ lowLabel, highLabel, note, children }: ContourLegendProps) {
    return (
        <div className="obstruction-legend">
            <div className="obstruction-legend-bands">
                {BAND_COLORS.map((color, i) => (
                    <span key={i} className="obstruction-legend-band" style={{ background: color }} />
                ))}
            </div>
            <div className="obstruction-legend-labels">
                <span>{lowLabel}</span>
                <span>{highLabel}</span>
            </div>
            {note && <div className="obstruction-legend-note">{note}</div>}
            {children}
        </div>
    );
}
