// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Map-sheet furniture of the Landeskarte example, drawn in the DOM and in one SVG above the canvas:
// neatline with corner ticks, LV95 kilometre ticks and grid crosses (plan) or bearing ticks
// (panorama), scale bar, north arrow, legend of the symbols that are really drawn, elevation key,
// Blatt box, imprint, cartouche and the Wegweiser plate of a photo station.
//
// Everything is true furniture: each number is computed from the camera (the scale bar from the
// metres per pixel at the view centre, the grid from the LV95 projection, the north arrow from the
// yaw), nothing is a hard-coded decoration. The pure helpers are exported and checked in tsx;
// only `createFurniture` and `renderWegweiser` touch the DOM.

import {wgs84ToLv95, lv95ToWgs84} from '../geo/lv95';
import {HYPSO_STOPS, hypsoColor} from '../terrain/lut';
import type {Frame, RGB, SceneMode, Station, SymbolId, ViewPose} from '../types';

const DEG = Math.PI / 180;
const THIN_SPACE = ' ';

/** Summit elevation printed in the cartouche (Niederhorn, metres). */
export const SUMMIT_ELEVATION_M = 1963;

/**
 * Height above sea level of the plane the plan scale refers to. A perspective view of relief has
 * no single scale; from 40 km up at a vertical field of view of 8 degrees the spread over the
 * 560 m to 2 300 m terrain is a few percent, so a mid-height plane is an honest reference.
 */
export const PLAN_REFERENCE_ELEVATION_M = 1000;

/** Neatline inset from the canvas edge in CSS pixels; the tick labels sit in this margin. */
export const NEATLINE_INSET = 26;

/** One CSS pixel in metres at 96 dpi, for the printed-scale estimate. */
const CSS_PIXEL_M = 0.0254 / 96;

export type FurnitureState = {
  pose: ViewPose;
  viewport: {w: number; h: number};
  mode: SceneMode;
  /** Symbols currently drawn: the legend lists exactly these. */
  drawnSymbols: SymbolId[];
  originFrame: Frame;
};

export type Furniture = {
  element: HTMLElement;
  update(state: FurnitureState): void;
  /** 0..1 fade-in for the load reveal (furniture arrives last). */
  setReveal(progress: number): void;
  destroy(): void;
};

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

/** 1 963 with a thin space (U+2009) as the thousands separator, as on Swiss maps. */
export function formatThousands(value: number): string {
  const text = String(Math.round(Math.abs(value)));
  const grouped = text.replace(/\B(?=(\d{3})+(?!\d))/g, THIN_SPACE);
  return value < 0 ? `−${grouped}` : grouped;
}

/** German decimal comma, fixed digits, optional explicit plus sign. */
export function formatDecimalDe(value: number, digits = 1, signed = false): string {
  const rounded = Number(value.toFixed(digits));
  const text = Math.abs(rounded).toFixed(digits).replace('.', ',');
  if (rounded < 0) return `−${text}`;
  return signed && rounded > 0 ? `+${text}` : text;
}

/** Degrees into [0, 360). */
export function normalizeDegrees(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

/** Signed smallest difference a - b in (-180, 180]. */
export function wrapDeltaDegrees(a: number, b: number): number {
  const d = normalizeDegrees(a - b);
  return d > 180 ? d - 360 : d;
}

const COMPASS_DE = [
  'N',
  'NNO',
  'NO',
  'ONO',
  'O',
  'OSO',
  'SO',
  'SSO',
  'S',
  'SSW',
  'SW',
  'WSW',
  'W',
  'WNW',
  'NW',
  'NNW'
];

/** 16-point compass name in German (O for Ost). */
export function compassName(degrees: number): string {
  return COMPASS_DE[Math.round(normalizeDegrees(degrees) / 22.5) % 16];
}

/**
 * The longest 1/2/5 x 10^n scale bar that fits in `maxPx` pixels. Never hard-coded: the pixel
 * length is meters / metersPerPixel, so `px * metersPerPixel === meters` by construction.
 */
export function niceScaleLength(
  metersPerPixel: number,
  maxPx: number
): {meters: number; px: number; label: string} {
  const maxMeters = metersPerPixel * maxPx;
  let decade = 10 ** Math.floor(Math.log10(maxMeters));
  // log10 can round up just below a power of ten; the bar must never exceed the room.
  if (decade > maxMeters) decade /= 10;
  let meters = decade;
  for (const factor of [5, 2, 1]) {
    if (factor * decade <= maxMeters) {
      meters = factor * decade;
      break;
    }
  }
  return {meters, px: meters / metersPerPixel, label: formatLength(meters)};
}

/** 500 m, 2 km, 0,5 km is avoided: below 1 km the unit stays metres. */
export function formatLength(meters: number): string {
  if (meters >= 1000) return `${formatDecimalDe(meters / 1000, 0)}${THIN_SPACE}km`;
  if (meters >= 1) return `${formatDecimalDe(meters, 0)}${THIN_SPACE}m`;
  return `${formatDecimalDe(meters * 100, 0)}${THIN_SPACE}cm`;
}

/**
 * Metres per CSS pixel at the view centre: the centre ray is intersected with the plane at
 * `planeUp` (ENU up of the reference elevation) and the frustum height there is divided by the
 * viewport height. Looking straight down this is exactly (eye.up - planeUp) * 2 tan(vfov/2) / h.
 */
export function metersPerPixelAtCentre(
  pose: ViewPose,
  viewportHeight: number,
  planeUp: number
): number {
  const down = Math.max(Math.sin(-pose.pitch * DEG), 0.05);
  const distance = Math.max(pose.eye[2] - planeUp, 1) / down;
  return (2 * distance * Math.tan((pose.vfov * DEG) / 2)) / viewportHeight;
}

/** Map between ENU east/north metres and canvas pixels (y down) for a top-down plan pose. */
export type PlanBasis = {
  metersPerPixel: number;
  toScreen(east: number, north: number): [number, number];
  toEnu(x: number, y: number): [number, number];
};

export function makePlanBasis(
  pose: ViewPose,
  viewport: {w: number; h: number},
  planeUp: number
): PlanBasis {
  const metersPerPixel = metersPerPixelAtCentre(pose, viewport.h, planeUp);
  // Yaw is clockwise from north: forward is the screen-up direction, right is screen-right.
  const sin = Math.sin(pose.yaw * DEG);
  const cos = Math.cos(pose.yaw * DEG);
  const cx = viewport.w / 2;
  const cy = viewport.h / 2;
  return {
    metersPerPixel,
    toScreen(east, north) {
      const dx = east - pose.eye[0];
      const dy = north - pose.eye[1];
      const right = dx * cos - dy * sin;
      const forward = dx * sin + dy * cos;
      return [cx + right / metersPerPixel, cy - forward / metersPerPixel];
    },
    toEnu(x, y) {
      const right = (x - cx) * metersPerPixel;
      const forward = (cy - y) * metersPerPixel;
      return [pose.eye[0] + right * cos + forward * sin, pose.eye[1] - right * sin + forward * cos];
    }
  };
}

const GRID_STEPS_M = [100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000];

/** Smallest grid step in metres whose lines are at least `minPx` apart. */
export function niceGridStep(metersPerPixel: number, minPx: number): number {
  for (const step of GRID_STEPS_M) if (step / metersPerPixel >= minPx) return step;
  return GRID_STEPS_M[GRID_STEPS_M.length - 1];
}

/**
 * Ticks along a straight edge whose end values are `v0` and `v1` (LV95 metres of the edge's start
 * and end): every multiple of `step` inside, with its position t in 0..1 along the edge. LV95 is
 * near-affine over a sheet, so linear interpolation along the edge is accurate to centimetres.
 */
export function edgeTicks(v0: number, v1: number, step: number): {value: number; t: number}[] {
  const lo = Math.min(v0, v1);
  const hi = Math.max(v0, v1);
  const ticks: {value: number; t: number}[] = [];
  if (hi === lo) return ticks;
  for (let value = Math.ceil(lo / step) * step; value <= hi; value += step) {
    ticks.push({value, t: (value - v0) / (v1 - v0)});
  }
  return ticks;
}

/** Kilometre label of an LV95 value: 2 626 for 2 626 000 m, 1 172,5 for finer grids. */
export function formatGridLabel(value: number, step: number): string {
  const km = value / 1000;
  return step >= 1000
    ? formatThousands(km)
    : formatDecimalDe(km, 1).replace(/^(\d)(\d{3}),/, `$1${THIN_SPACE}$2,`);
}

/** Bearing ticks across the top of a panorama (rectilinear, horizon columns): x as 0..1 of width. */
export function bearingTicks(
  yaw: number,
  vfov: number,
  aspect: number,
  step: number
): {bearing: number; x: number}[] {
  const tanHalfH = Math.tan((vfov * DEG) / 2) * aspect;
  const halfSpanDeg = Math.min(Math.atan(tanHalfH) / DEG, 89);
  const ticks: {bearing: number; x: number}[] = [];
  const first = Math.ceil((yaw - halfSpanDeg) / step) * step;
  for (let b = first; b <= yaw + halfSpanDeg; b += step) {
    const x = 0.5 + Math.tan((b - yaw) * DEG) / (2 * tanHalfH);
    if (x >= 0 && x <= 1) ticks.push({bearing: normalizeDegrees(b), x});
  }
  return ticks;
}

/** Stops of the elevation key from the real hypsometric LUT, as CSS colours. */
export function elevationKeyStops(
  low: number,
  high: number
): {offset: number; elevation: number; color: string}[] {
  const css = (c: RGB) => `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`;
  const stops = [{offset: 0, elevation: low, color: css(hypsoColor(low))}];
  for (const stop of HYPSO_STOPS) {
    if (stop.elevation > low && stop.elevation < high) {
      stops.push({
        offset: (stop.elevation - low) / (high - low),
        elevation: stop.elevation,
        color: css(stop.color)
      });
    }
  }
  stops.push({offset: 1, elevation: high, color: css(hypsoColor(high))});
  return stops;
}

/** Printed-scale denominator for the plan at 96 dpi, rounded to two significant figures. */
export function scaleDenominator(metersPerPixel: number): number {
  const raw = metersPerPixel / CSS_PIXEL_M;
  const magnitude = 10 ** (Math.floor(Math.log10(raw)) - 1);
  return Math.round(raw / magnitude) * magnitude;
}

function sfc32(a: number, b: number, c: number, d: number): () => number {
  return () => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

/**
 * Hand-set look: a deterministic offset of at most `maxPx` per axis, seeded by the element id
 * (FNV-1a into sfc32), so the same element always sits at the same tiny skew. Furniture only.
 */
export function seededJitter(id: string, maxPx = 0.9): [number, number] {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const random = sfc32(hash, hash ^ 0x9e3779b9, hash ^ 0x85ebca6b, 1);
  for (let i = 0; i < 12; i++) random();
  const dx = random() * 2 - 1;
  const dy = random() * 2 - 1;
  // Clamp the vector length, not each axis, so the skew is never more than maxPx in any reading.
  const scale = maxPx / Math.max(Math.hypot(dx, dy), 1);
  return [dx * scale, dy * scale];
}

// ---------------------------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Record<string, string | number> = {},
  className?: string
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  if (className) node.setAttribute('class', className);
  return node;
}

function applyJitter(node: HTMLElement | SVGElement, id: string): void {
  const [dx, dy] = seededJitter(id);
  node.style.translate = `${dx.toFixed(2)}px ${dy.toFixed(2)}px`;
}

// ---------------------------------------------------------------------------------------------
// Legend glyphs: one tiny SVG per symbol, in the same inks the layers use.
// ---------------------------------------------------------------------------------------------

const LEGEND: Record<SymbolId, {label: string; draw: () => SVGElement[]}> = {
  'contour-index': {
    label: 'Höhenkurve 100 m',
    draw: () => [svgEl('path', {d: 'M1 8 H27'}, 'lk-g-contour-index')]
  },
  'contour-minor': {
    label: 'Höhenkurve 20 m',
    draw: () => [svgEl('path', {d: 'M1 8 H27'}, 'lk-g-contour-minor')]
  },
  rock: {
    label: 'Fels',
    draw: () =>
      [3, 7, 11, 15, 19, 23].map(x => svgEl('path', {d: `M${x} 3 L${x - 2} 13`}, 'lk-g-rock'))
  },
  scree: {
    label: 'Schutt',
    draw: () =>
      [
        [4, 4],
        [10, 9],
        [15, 3],
        [20, 10],
        [25, 5],
        [8, 13],
        [18, 14]
      ].map(([cx, cy]) => svgEl('circle', {cx, cy, r: 0.9}, 'lk-g-scree'))
  },
  lake: {
    label: 'See',
    draw: () => [svgEl('rect', {x: 2, y: 3, width: 24, height: 10, rx: 4}, 'lk-g-lake')]
  },
  'trail-hiking': {
    label: 'Wanderweg',
    draw: () => [svgEl('path', {d: 'M1 8 H27'}, 'lk-g-trail lk-g-trail-hiking')]
  },
  'trail-mountain': {
    label: 'Bergwanderweg',
    draw: () => [svgEl('path', {d: 'M1 8 H27'}, 'lk-g-trail lk-g-trail-mountain')]
  },
  'trail-alpine': {
    label: 'Alpinwanderweg',
    draw: () => [svgEl('path', {d: 'M1 8 H27'}, 'lk-g-trail lk-g-trail-alpine')]
  },
  station: {
    // The open triangle of the stations: a camera standpoint, not a closed marker.
    label: 'Aufnahmestandort',
    draw: () => [svgEl('path', {d: 'M14 2.5 L20 13 H8 Z'}, 'lk-g-station')]
  },
  peak: {
    label: 'Gipfel',
    draw: () => [svgEl('path', {d: 'M14 3 L19.5 13 H8.5 Z'}, 'lk-g-peak')]
  },
  shadow: {
    label: 'Schlagschatten',
    draw: () => [svgEl('rect', {x: 2, y: 3, width: 24, height: 10}, 'lk-g-shadow')]
  },
  nebelmeer: {
    label: 'Nebelmeer',
    draw: () => [
      svgEl('path', {d: 'M1 6 Q7 3 14 6 T27 6'}, 'lk-g-fog'),
      svgEl('path', {d: 'M1 11 Q7 8 14 11 T27 11'}, 'lk-g-fog')
    ]
  }
};

const LEGEND_ORDER: SymbolId[] = [
  'contour-index',
  'contour-minor',
  'rock',
  'scree',
  'lake',
  'trail-hiking',
  'trail-mountain',
  'trail-alpine',
  'station',
  'peak',
  'shadow',
  'nebelmeer'
];

// ---------------------------------------------------------------------------------------------
// Wegweiser
// ---------------------------------------------------------------------------------------------

/**
 * The yellow Swiss hiking signpost plate of one photo station: pointed end, black condensed text.
 * `cest` is the local time 'HH:MM'. The text says what the solver produced ("gelöst"), never
 * "verifiziert". Stations below 0.7 confidence get the `lk-dim` class.
 */
export function renderWegweiser(station: Station, cest: string): HTMLElement {
  const plate = el('div', 'lk-wegweiser');
  plate.setAttribute('role', 'note');
  if (station.confidence < 0.7) plate.classList.add('lk-dim');

  const body = el('div', 'lk-wegweiser-body');
  const number = /(\d+)$/.exec(station.id)?.[1];
  const head = el('div', 'lk-wegweiser-head');
  head.append(
    el('span', 'lk-wegweiser-name', number ? `Aufnahme ${number}` : station.id),
    el('span', 'lk-wegweiser-time lk-num', `${cest} MESZ`)
  );

  const heading = `${formatDecimalDe(normalizeDegrees(station.yaw), 1)}° ${compassName(station.yaw)}`;
  const solved = el('div', 'lk-wegweiser-line');
  solved.append(el('span', 'lk-wegweiser-key', 'gelöste Richtung'), el('span', 'lk-num', heading));

  const exif = el('div', 'lk-wegweiser-line');
  exif.append(
    el('span', 'lk-wegweiser-key', 'EXIF-Kompass Δ'),
    el(
      'span',
      'lk-num',
      station.exifHeading === null
        ? 'keine Angabe'
        : `${formatDecimalDe(wrapDeltaDegrees(station.yaw, station.exifHeading), 1, true)}°`
    )
  );

  const confidence = el('div', 'lk-wegweiser-line');
  confidence.append(
    el('span', 'lk-wegweiser-key', station.confidence < 0.7 ? 'Zuversicht (gering)' : 'Zuversicht'),
    el('span', 'lk-num', formatDecimalDe(station.confidence, 2))
  );

  body.append(head, solved, exif, confidence);
  plate.append(body);
  return plate;
}

// ---------------------------------------------------------------------------------------------
// createFurniture
// ---------------------------------------------------------------------------------------------

const KEY_LOW = 500;
const KEY_HIGH = 3000;
const KEY_TICKS = [500, 1500, 3000];
const SCALE_MAX_PX = 140;
const GRID_MIN_PX = 96;

export function createFurniture(host: HTMLElement): Furniture {
  // Tokens live on `.landeskarte`; the host carries the class so the stylesheet applies.
  host.classList.add('landeskarte');
  const root = el('div', 'lk-furniture');
  root.setAttribute('aria-hidden', 'true');

  const svg = svgEl('svg', {width: '100%', height: '100%'}, 'lk-fur-svg');
  const gridCrosses = svgEl('g', {}, 'lk-fur-crosses');
  const neatline = svgEl('rect', {}, 'lk-fur-neatline');
  const cornerGroup = svgEl('g', {}, 'lk-fur-corners');
  const corners = (['nw', 'ne', 'se', 'sw'] as const).map(id => {
    const g = svgEl('path', {}, 'lk-fur-corner');
    applyJitter(g, `corner-${id}`);
    cornerGroup.append(g);
    return g;
  });
  const edgeGroup = svgEl('g', {}, 'lk-fur-edge');
  svg.append(gridCrosses, neatline, cornerGroup, edgeGroup);

  // Cartouche: name, altitude and date, in the title face.
  const cartouche = el('div', 'lk-cartouche');
  cartouche.append(
    el('span', 'lk-cartouche-name', 'Niederhorn'),
    document.createTextNode(' '),
    el('span', 'lk-cartouche-meta', `${formatThousands(SUMMIT_ELEVATION_M)} m · 7. September 2026`)
  );
  applyJitter(cartouche, 'cartouche');

  // North arrow (plan only; a panorama has bearing ticks instead).
  const north = el('div', 'lk-north');
  const northSvg = svgEl('svg', {viewBox: '-14 -22 28 44', width: 28, height: 44});
  const northNeedle = svgEl('g', {}, 'lk-north-needle');
  northNeedle.append(
    svgEl('path', {d: 'M0 -20 L6 14 L0 9 Z'}, 'lk-north-half-ink'),
    svgEl('path', {d: 'M0 -20 L-6 14 L0 9 Z'}, 'lk-north-half-paper')
  );
  northSvg.append(northNeedle);
  const northLabel = el('span', 'lk-north-label', 'N');
  north.append(northSvg, northLabel);
  applyJitter(north, 'north');

  // Legend with the elevation key.
  const legend = el('section', 'lk-legend');
  legend.append(el('h2', 'lk-legend-title', 'Zeichenerklärung'));
  const legendList = el('ul', 'lk-legend-list');
  const legendLight = el('p', 'lk-legend-light');
  const key = el('div', 'lk-key');
  const keySvg = svgEl('svg', {
    viewBox: '0 0 160 8',
    width: 160,
    height: 8,
    preserveAspectRatio: 'none'
  });
  const gradient = svgEl('linearGradient', {id: 'lk-key-gradient', x1: 0, x2: 1, y1: 0, y2: 0});
  for (const stop of elevationKeyStops(KEY_LOW, KEY_HIGH)) {
    gradient.append(svgEl('stop', {offset: stop.offset, 'stop-color': stop.color}));
  }
  keySvg.append(
    svgEl('defs'),
    svgEl('rect', {x: 0, y: 0, width: 160, height: 8, fill: 'url(#lk-key-gradient)'})
  );
  keySvg.firstElementChild?.append(gradient);
  const keyLabels = el('div', 'lk-key-labels');
  for (const tick of KEY_TICKS) {
    const label = el('span', 'lk-num', formatThousands(tick));
    label.style.left = `${((tick - KEY_LOW) / (KEY_HIGH - KEY_LOW)) * 100}%`;
    keyLabels.append(label);
  }
  key.append(el('p', 'lk-key-title', 'Höhe ü. M. (m)'), keySvg, keyLabels);
  legend.append(legendList, key, legendLight);
  applyJitter(legend, 'legend');

  // Scale bar.
  const scale = el('div', 'lk-scale');
  const scaleBar = el('div', 'lk-scale-bar');
  const scaleLabels = el('div', 'lk-scale-labels lk-num');
  const scaleZero = el('span', undefined, '0');
  const scaleHalf = el('span');
  const scaleEnd = el('span');
  scaleLabels.append(scaleZero, scaleHalf, scaleEnd);
  const scaleSegments = [0, 1, 2, 3].map(i => {
    const seg = el('span', i % 2 === 0 ? 'lk-scale-ink' : 'lk-scale-paper');
    scaleBar.append(seg);
    return seg;
  });
  scale.append(scaleBar, scaleLabels);
  applyJitter(scale, 'scale');

  // Blatt box: sheet name and the view centre in LV95, or the heading in a panorama.
  const blatt = el('div', 'lk-blatt');
  const blattTitle = el('p', 'lk-blatt-title');
  const blattLine1 = el('p', 'lk-blatt-line lk-num');
  const blattLine2 = el('p', 'lk-blatt-line lk-num');
  blatt.append(blattTitle, blattLine1, blattLine2);
  applyJitter(blatt, 'blatt');

  const imprint = el('p', 'lk-imprint');
  imprint.textContent =
    'Aufnahme: Mapterhorn, swisstopo, © OpenStreetMap contributors · Revision: luma graph · Stich: luma.gl + deck.gl';
  applyJitter(imprint, 'imprint');

  root.append(svg, cartouche, north, legend, scale, blatt, imprint);
  host.append(root);

  let legendKey = '';

  const rebuildLegend = (symbols: SymbolId[], mode: SceneMode) => {
    const wanted = LEGEND_ORDER.filter(id => symbols.includes(id));
    const nextKey = `${mode}|${wanted.join(',')}`;
    if (nextKey === legendKey) return;
    legendKey = nextKey;
    legendList.replaceChildren(
      ...wanted.map(id => {
        const item = el('li', 'lk-legend-item');
        const glyph = svgEl('svg', {viewBox: '0 0 28 16', width: 28, height: 16});
        glyph.append(...LEGEND[id].draw());
        item.append(glyph, el('span', undefined, LEGEND[id].label));
        return item;
      })
    );
    legendLight.textContent =
      mode === 'plan' ? 'Licht: NW 315°, kein Schatten' : 'Licht: Sonnenstand, mit Schatten';
  };

  const updateSvg = (state: FurnitureState, basis: PlanBasis | null) => {
    const {w, h} = state.viewport;
    const inset = NEATLINE_INSET;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    neatline.setAttribute('x', String(inset));
    neatline.setAttribute('y', String(inset));
    neatline.setAttribute('width', String(Math.max(w - 2 * inset, 0)));
    neatline.setAttribute('height', String(Math.max(h - 2 * inset, 0)));

    // Registration ticks that overshoot each corner of the neatline.
    const overshoot = 10;
    const [x0, y0, x1, y1] = [inset, inset, w - inset, h - inset];
    corners[0].setAttribute(
      'd',
      `M${x0 - overshoot} ${y0} H${x0 + 4} M${x0} ${y0 - overshoot} V${y0 + 4}`
    );
    corners[1].setAttribute(
      'd',
      `M${x1 + overshoot} ${y0} H${x1 - 4} M${x1} ${y0 - overshoot} V${y0 + 4}`
    );
    corners[2].setAttribute(
      'd',
      `M${x1 + overshoot} ${y1} H${x1 - 4} M${x1} ${y1 + overshoot} V${y1 - 4}`
    );
    corners[3].setAttribute(
      'd',
      `M${x0 - overshoot} ${y1} H${x0 + 4} M${x0} ${y1 + overshoot} V${y1 - 4}`
    );

    const edge: SVGElement[] = [];
    const crosses: SVGElement[] = [];
    if (basis) {
      const frame = state.originFrame;
      const lv95At = (x: number, y: number) => {
        const [east, north] = basis.toEnu(x, y);
        const geo = frame.toGeo([east, north, 0]);
        return wgs84ToLv95(geo.lat, geo.lon);
      };
      const nw = lv95At(x0, y0);
      const ne = lv95At(x1, y0);
      const sw = lv95At(x0, y1);
      const se = lv95At(x1, y1);
      const step = niceGridStep(basis.metersPerPixel, GRID_MIN_PX);
      const minorStep = step / 5;
      const tickAlong = (
        a: number,
        b: number,
        stepM: number,
        place: (t: number) => [number, number],
        inward: [number, number],
        length: number,
        labelOf?: (value: number) => SVGElement
      ) => {
        for (const {value, t} of edgeTicks(a, b, stepM)) {
          const [px, py] = place(t);
          edge.push(
            svgEl(
              'path',
              {d: `M${px} ${py} l${inward[0] * length} ${inward[1] * length}`},
              'lk-fur-tick'
            )
          );
          if (labelOf) {
            const label = labelOf(value);
            label.setAttribute('transform', `translate(${px} ${py})`);
            edge.push(label);
          }
        }
      };
      const labelAt =
        (rotate: number, anchor: string, dx: number, dy: number) => (value: number) => {
          const text = svgEl('text', {x: dx, y: dy, 'text-anchor': anchor}, 'lk-fur-label');
          text.textContent = formatGridLabel(value, step);
          const group = svgEl('g');
          group.append(text);
          if (rotate) text.setAttribute('transform', `rotate(${rotate})`);
          return group;
        };
      const top = (t: number): [number, number] => [x0 + (x1 - x0) * t, y0];
      const bottom = (t: number): [number, number] => [x0 + (x1 - x0) * t, y1];
      const left = (t: number): [number, number] => [x0, y0 + (y1 - y0) * t];
      const right = (t: number): [number, number] => [x1, y0 + (y1 - y0) * t];
      // Minor ticks first, then majors with labels in the margin outside the neatline.
      tickAlong(nw.e, ne.e, minorStep, top, [0, 1], 3);
      tickAlong(sw.e, se.e, minorStep, bottom, [0, -1], 3);
      tickAlong(nw.n, sw.n, minorStep, left, [1, 0], 3);
      tickAlong(ne.n, se.n, minorStep, right, [-1, 0], 3);
      tickAlong(nw.e, ne.e, step, top, [0, 1], 7, labelAt(0, 'middle', 0, -6));
      tickAlong(sw.e, se.e, step, bottom, [0, -1], 7, labelAt(0, 'middle', 0, 15));
      tickAlong(nw.n, sw.n, step, left, [1, 0], 7, labelAt(-90, 'middle', 0, -6));
      tickAlong(ne.n, se.n, step, right, [-1, 0], 7, labelAt(90, 'middle', 0, -6));

      // Small crosses where kilometre lines meet, as on a Landeskarte.
      const es = [nw.e, ne.e, sw.e, se.e];
      const ns = [nw.n, ne.n, sw.n, se.n];
      for (let e = Math.ceil(Math.min(...es) / step) * step; e <= Math.max(...es); e += step) {
        for (let n = Math.ceil(Math.min(...ns) / step) * step; n <= Math.max(...ns); n += step) {
          const geo = lv95ToWgs84(e, n);
          const [east, northing] = frame.toEnu(geo.lat, geo.lon, frame.origin.h);
          const [px, py] = basis.toScreen(east, northing);
          if (px > x0 + 8 && px < x1 - 8 && py > y0 + 8 && py < y1 - 8) {
            crosses.push(
              svgEl(
                'path',
                {d: `M${px - 4} ${py} H${px + 4} M${px} ${py - 4} V${py + 4}`},
                'lk-fur-cross'
              )
            );
          }
        }
      }
    } else {
      const aspect = w / h;
      for (const {bearing, x} of bearingTicks(state.pose.yaw, state.pose.vfov, aspect, 5)) {
        const px = x * w;
        if (px < x0 || px > x1) continue;
        const major = bearing % 10 === 0;
        edge.push(svgEl('path', {d: `M${px} ${y0} l0 ${major ? 7 : 3}`}, 'lk-fur-tick'));
        if (major) {
          const cardinal = bearing % 45 === 0 ? `${compassName(bearing)} ` : '';
          const text = svgEl('text', {x: px, y: y0 - 6, 'text-anchor': 'middle'}, 'lk-fur-label');
          text.textContent = `${cardinal}${Math.round(bearing)}°`;
          edge.push(text);
        }
      }
    }
    edgeGroup.replaceChildren(...edge);
    gridCrosses.replaceChildren(...crosses);
  };

  const updateScale = (metersPerPixel: number | null) => {
    scale.hidden = metersPerPixel === null;
    if (metersPerPixel === null) return;
    const bar = niceScaleLength(metersPerPixel, SCALE_MAX_PX);
    scaleBar.style.width = `${bar.px.toFixed(1)}px`;
    scaleLabels.style.width = `${bar.px.toFixed(1)}px`;
    for (const seg of scaleSegments) seg.style.width = '25%';
    scaleHalf.textContent = formatLength(bar.meters / 2);
    scaleEnd.textContent = bar.label;
    scale.dataset.meters = String(bar.meters);
    scale.dataset.px = bar.px.toFixed(2);
  };

  return {
    element: root,
    update(state) {
      const {w, h} = state.viewport;
      if (!(w > 0 && h > 0)) return;
      root.dataset.mode = state.mode;
      const plan = state.mode === 'plan';
      const planeUp = PLAN_REFERENCE_ELEVATION_M - state.originFrame.origin.h;
      const basis = plan ? makePlanBasis(state.pose, state.viewport, planeUp) : null;

      updateSvg(state, basis);
      updateScale(basis ? basis.metersPerPixel : null);
      rebuildLegend(state.drawnSymbols, state.mode);

      north.hidden = !plan;
      northNeedle.setAttribute('transform', `rotate(${(-state.pose.yaw).toFixed(2)})`);

      if (basis) {
        const [centreEast, centreNorth] = basis.toEnu(w / 2, h / 2);
        const geo = state.originFrame.toGeo([centreEast, centreNorth, 0]);
        const lv = wgs84ToLv95(geo.lat, geo.lon);
        blattTitle.textContent = 'Blatt Niederhorn';
        blattLine1.textContent = `E ${formatThousands(Math.round(lv.e / 100) * 100)}`;
        blattLine2.textContent = `N ${formatThousands(Math.round(lv.n / 100) * 100)} · 1 : ${formatThousands(scaleDenominator(basis.metersPerPixel))}`;
      } else {
        blattTitle.textContent = 'Gipfelpanorama';
        blattLine1.textContent = `Blick ${formatDecimalDe(normalizeDegrees(state.pose.yaw), 1)}° ${compassName(state.pose.yaw)}`;
        // The vertical exaggeration is stated, not hidden: the relief is true to scale.
        blattLine2.textContent = 'Überhöhung 1,0×';
      }
    },
    setReveal(progress) {
      root.style.setProperty('--lk-fur-reveal', String(Math.min(Math.max(progress, 0), 1)));
    },
    destroy() {
      root.remove();
    }
  };
}
