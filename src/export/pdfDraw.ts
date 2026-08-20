import type { MapLibreMap } from 'maplibre-gl';
import type { jsPDF } from 'jspdf';
import { bandColors } from '../map/contourRender';

export interface LegendSpec {
    lowLabel: string;
    highLabel: string;
    note?: string;
    /** Optional highlighted single value (e.g. Focus's selected-point score), 0-1. */
    value?: { fraction: number; label: string } | null;
}

const LEGEND_WIDTH = 118;
const LEGEND_PAD = 7;

// Kept in sync with map/contourRender.ts's own band count/ramp by construction: both read the
// same DEFAULT_THRESHOLDS/INFERNO_STOPS. Re-derived here (rather than imported) only because the
// legend needs plain RGB triples for jsPDF's setFillColor, not the CSS strings bandColors()
// returns — the values themselves are identical.
function parseRgb(css: string): [number, number, number] {
    const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(css);
    if (!m) return [128, 128, 128];
    return [Number(m[1]), Number(m[2]), Number(m[3])];
}

const BAND_COLORS = bandColors().map(parseRgb);

/** Small swatches-and-labels box mirroring the on-screen ContourLegend, drawn directly onto the
 *  page rather than captured from the DOM — independent of whatever resolution the on-screen
 *  version happened to be at. An opaque background goes down first: this can land on top of a
 *  dark contour band or the Focus mask, where its muted text would otherwise disappear. */
export function drawLegend(doc: jsPDF, x: number, y: number, legend: LegendSpec): number {
    const height = LEGEND_PAD * 2 + 10 + 9 + (legend.note ? 9 : 0) + (legend.value ? 11 : 0);
    doc.setFillColor(255, 255, 255);
    doc.setDrawColor(210, 210, 210);
    doc.setLineWidth(0.5);
    doc.roundedRect(x, y, LEGEND_WIDTH, height, 4, 4, 'FD');

    let cursorY = y + LEGEND_PAD;
    const bandW = (LEGEND_WIDTH - LEGEND_PAD * 2) / BAND_COLORS.length;
    BAND_COLORS.forEach(([r, g, b], i) => {
        doc.setFillColor(r, g, b);
        doc.rect(x + LEGEND_PAD + i * bandW, cursorY, bandW, 7, 'F');
    });
    cursorY += 7 + 3;

    doc.setFontSize(6.5);
    doc.setTextColor(90, 90, 90);
    doc.text(legend.lowLabel, x + LEGEND_PAD, cursorY, { baseline: 'top' });
    doc.text(legend.highLabel, x + LEGEND_WIDTH - LEGEND_PAD, cursorY, { align: 'right', baseline: 'top' });
    cursorY += 9;

    if (legend.note) {
        doc.setFontSize(6);
        doc.text(legend.note, x + LEGEND_WIDTH / 2, cursorY, { align: 'center', baseline: 'top', maxWidth: LEGEND_WIDTH - LEGEND_PAD * 2 });
        cursorY += 9;
    }

    if (legend.value) {
        const [r, g, b] = colormapColorForFraction(legend.value.fraction);
        doc.setFillColor(r, g, b);
        doc.rect(x + LEGEND_PAD, cursorY + 1, 6, 6, 'F');
        doc.setFontSize(7);
        doc.setTextColor(20, 20, 20);
        doc.text(legend.value.label, x + LEGEND_PAD + 9, cursorY + 6.5, { baseline: 'alphabetic' });
        cursorY += 11;
    }

    return cursorY + LEGEND_PAD - y;
}

// Local re-implementation rather than importing gridRender.ts's colormapColor: that module also
// pulls in canvas-oriented rendering helpers with no purpose in a PDF-drawing context, and this
// legend only ever needs the one INFERNO-ramp colour lookup, already duplicated below in full.
const INFERNO: Array<[number, [number, number, number]]> = [
    [0, [26, 9, 51]],
    [0.25, [110, 26, 96]],
    [0.5, [200, 60, 55]],
    [0.75, [240, 140, 30]],
    [1, [255, 210, 70]],
];

function colormapColorForFraction(t: number): [number, number, number] {
    const clamped = Math.max(0, Math.min(1, t));
    let i = 0;
    while (i < INFERNO.length - 2 && clamped > INFERNO[i + 1]![0]) i++;
    // Loop-bounded: i only ever increments up to INFERNO.length - 2, so both INFERNO[i] and
    // INFERNO[i + 1] stay within bounds (the latter at most the final entry).
    const [t0, c0] = INFERNO[i]!;
    const [t1, c1] = INFERNO[i + 1]!;
    const localT = t1 === t0 ? 0 : (clamped - t0) / (t1 - t0);
    return [
        Math.round(c0[0] + (c1[0] - c0[0]) * localT),
        Math.round(c0[1] + (c1[1] - c0[1]) * localT),
        Math.round(c0[2] + (c1[2] - c0[2]) * localT),
    ];
}

/** Ceiling on the captured canvas's longer device-pixel edge before it's embedded in the PDF.
 *  MapLibre renders at devicePixelRatio, so on a high-DPI screen the raw capture can be 2-3x
 *  denser than this — well past what's visible once scaled down into the ~790×500pt content box
 *  the map actually occupies on the page, but still fully paid for in file size. */
const MAX_CAPTURE_EDGE_PX = 2000;

/** JPEG quality for the rasterized map background. The map is a photographic/vector basemap
 *  render, not something that benefits from lossless PNG, and switching formats plus capping
 *  resolution together cut a multi-view export from tens of MB down substantially with no
 *  visible loss at normal viewing zoom. Everything drawn is now baked into this same raster by
 *  MapLibre itself (see exportPdf.ts's temporary fine-resolution layer) — labels, borders,
 *  contour fill and the eclipse path all composite in the browser's own correct z-order, so
 *  there's no separate vector overlay left to stay crisp independent of this setting; the legend
 *  and title/subtitle text are the only things still drawn as real PDF vector/text operators. */
const CAPTURE_JPEG_QUALITY = 0.92;

/** Data URL for `canvas`, downscaled first (via an offscreen canvas) if its device-pixel
 *  dimensions exceed MAX_CAPTURE_EDGE_PX on the long edge, and always re-encoded as JPEG rather
 *  than PNG — see the constants above for why. */
function captureMapImage(canvas: HTMLCanvasElement): string {
    const longEdge = Math.max(canvas.width, canvas.height);
    if (longEdge <= MAX_CAPTURE_EDGE_PX || longEdge === 0) {
        return canvas.toDataURL('image/jpeg', CAPTURE_JPEG_QUALITY);
    }
    const scale = MAX_CAPTURE_EDGE_PX / longEdge;
    const targetW = Math.max(1, Math.round(canvas.width * scale));
    const targetH = Math.max(1, Math.round(canvas.height * scale));
    const offscreen = document.createElement('canvas');
    offscreen.width = targetW;
    offscreen.height = targetH;
    const ctx = offscreen.getContext('2d');
    if (!ctx) return canvas.toDataURL('image/jpeg', CAPTURE_JPEG_QUALITY);
    ctx.drawImage(canvas, 0, 0, targetW, targetH);
    return offscreen.toDataURL('image/jpeg', CAPTURE_JPEG_QUALITY);
}

export interface MapPageOptions {
    map: MapLibreMap;
    title: string;
    subtitle?: string;
    legend?: LegendSpec | null;
}

/** Draws one full page onto `doc` (call `doc.addPage()` beforehand for every page but the
 *  first): a title, the map's own captured canvas scaled to fit the content box, and a legend.
 *  The map's canvas is expected to already show everything relevant — base style, contour fill
 *  (if any), and the eclipse path — composited by MapLibre itself in its normal z-order (labels
 *  and borders on top of the fill, exactly as on screen) before this is called; see
 *  exportPdf.ts's per-page capture sequence for how that's arranged. */
export function drawMapPage(doc: jsPDF, options: MapPageOptions): void {
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 24;

    doc.setFontSize(14);
    doc.setTextColor(20, 20, 20);
    doc.text(options.title, margin, margin, { baseline: 'top' });
    if (options.subtitle) {
        doc.setFontSize(9);
        doc.setTextColor(100, 100, 100);
        doc.text(options.subtitle, margin, margin + 18, { baseline: 'top' });
    }

    const contentTop = margin + 34;
    const contentBox = { x: margin, y: contentTop, w: pageWidth - margin * 2, h: pageHeight - contentTop - margin };

    const container = options.map.getContainer();
    const cssWidth = container.clientWidth;
    const cssHeight = container.clientHeight;
    if (cssWidth === 0 || cssHeight === 0) return;

    const scale = Math.min(contentBox.w / cssWidth, contentBox.h / cssHeight);
    const imgW = cssWidth * scale;
    const imgH = cssHeight * scale;
    const originX = contentBox.x + (contentBox.w - imgW) / 2;
    const originY = contentBox.y + (contentBox.h - imgH) / 2;

    const dataUrl = captureMapImage(options.map.getCanvas());
    doc.addImage(dataUrl, 'JPEG', originX, originY, imgW, imgH);

    if (options.legend) {
        drawLegend(doc, originX + 10, originY + imgH - 70, options.legend);
    }
}
