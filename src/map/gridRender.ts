// `ValueCell`/`valueGridToCanvas`/`colorStopsToCssGradient` are unused since the obstruction and
// weather overlays switched to contourRender.ts's marching-squares band renderer — kept
// deliberately (not dead code to clean up) as a fallback continuous-gradient renderer, in case
// the isopleth-band look gets reverted or revisited later. `colormapColor`/`INFERNO_STOPS` are
// still live, reused by contourRender.ts.
export interface ValueCell {
    /** 0 (worst) to 1 (best); null = no data (rendered fully transparent). */
    value: number | null;
}

export interface GridRenderOptions {
    cols: number;
    rows: number;
    /** 0-255. */
    opacity?: number;
    stops?: ColorStop[];
}

export type ColorStop = [number, [number, number, number]];

/** Dark purple → magenta → orange → yellow: a magma/inferno-style perceptually-ordered ramp
 *  (not a hue-cycling "rainbow" — low-to-high reads as a single consistent direction), matching
 *  eclipsemap.xyz's own obstruction map. Used as the default for both grid overlays.
 *
 *  Sampled from matplotlib's `inferno` at nine points rather than the four it used to carry: the
 *  colours between control points are interpolated linearly in RGB, which only tracks inferno's
 *  actual (perceptually uniform) curve while the stops stay close together. With four stops and
 *  the overlay's previous six bands that was invisible; at fourteen bands the long straight
 *  segments showed up as visible kinks — two adjacent bands nearly identical, then a jump.
 *
 *  Deliberately spans inferno's 0.10-0.87 rather than its full range: the true endpoints are
 *  near-black and near-white, and both disappear — black into FocusMap's dark mask, and the pale
 *  end into the light basemap. The top stop was pulled back further after seeing it in place: at
 *  inferno 0.95 a fully-clear region rendered as washed-out cream over the basemap at the
 *  overlay's 0.82 opacity, reading as "nothing here" rather than as the best value on the scale.
 *  Ending on saturated amber keeps the high end assertive. Lightness still increases
 *  monotonically across the ramp, which is what makes a sequential scale readable for
 *  colour-vision deficiencies and in greyscale. */
export const INFERNO_STOPS: ColorStop[] = [
    [0, [22, 11, 57]],
    [0.125, [64, 10, 103]],
    [0.25, [103, 22, 110]],
    [0.375, [143, 36, 104]],
    [0.5, [182, 53, 86]],
    [0.625, [215, 76, 62]],
    [0.75, [239, 108, 36]],
    [0.875, [250, 152, 10]],
    [1, [252, 193, 40]],
];

/** Exported so other renderers (e.g. the contour-band renderer) can derive discrete colors from
 *  the same continuous ramp without duplicating the interpolation logic. */
export function colormapColor(t: number, stops: ColorStop[]): [number, number, number] {
    const clamped = Math.max(0, Math.min(1, t));
    let i = 0;
    while (i < stops.length - 2 && clamped > stops[i + 1]![0]) i++;
    // Loop-bounded: i only ever increments up to stops.length - 2, so both stops[i] and
    // stops[i + 1] stay within bounds (the latter at most the final entry). Callers always pass
    // at least INFERNO_STOPS-sized arrays (>=2 entries), never an empty stops list.
    const [t0, c0] = stops[i]!;
    const [t1, c1] = stops[i + 1]!;
    const localT = t1 === t0 ? 0 : (clamped - t0) / (t1 - t0);
    return [
        Math.round(c0[0] + (c1[0] - c0[0]) * localT),
        Math.round(c0[1] + (c1[1] - c0[1]) * localT),
        Math.round(c0[2] + (c1[2] - c0[2]) * localT),
    ];
}

/** CSS gradient string for a legend swatch, using the same stops as the canvas renderer so the
 *  legend and the map overlay never drift apart. */
export function colorStopsToCssGradient(stops: ColorStop[] = INFERNO_STOPS): string {
    const parts = stops.map(([t, [r, g, b]]) => `rgb(${r}, ${g}, ${b}) ${Math.round(t * 100)}%`);
    return `linear-gradient(to right, ${parts.join(', ')})`;
}

/** Renders a grid of 0-1 values to a small canvas (one pixel per cell) through a continuous
 *  colormap; MapLibre's raster layer bilinearly scales it up when draping it over the map,
 *  which is what gives the smooth gradient look. Shared by the obstruction and weather
 *  overlays — only the input values and stops differ. */
export function valueGridToCanvas(cells: ValueCell[], options: GridRenderOptions): HTMLCanvasElement {
    const { cols, rows, opacity = 235, stops = INFERNO_STOPS } = options;
    const canvas = document.createElement('canvas');
    canvas.width = cols;
    canvas.height = rows;
    const ctx = canvas.getContext('2d')!;
    const imageData = ctx.createImageData(cols, rows);

    cells.forEach((cell, i) => {
        const o = i * 4;
        if (cell.value === null) {
            imageData.data[o + 3] = 0;
            return;
        }
        const [r, g, b] = colormapColor(cell.value, stops);
        imageData.data[o] = r;
        imageData.data[o + 1] = g;
        imageData.data[o + 2] = b;
        imageData.data[o + 3] = opacity;
    });

    ctx.putImageData(imageData, 0, 0);
    return canvas;
}
