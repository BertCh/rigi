// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The control dock: Plan | Panorama, the time ruler with the Gipfelrast bracket, the sun-arc
// glyph, the refraction slider and the layer toggles. Plain DOM and SVG, styled by controls.css.
// The wheel is never captured: the ruler uses `touch-action: pan-y` and pointer events only, so
// the page always scrolls.

import {formatCest, sunriseSunset} from '../geo/sun';
import type {LayerName, SceneMode, Station, SunSample} from '../types';
import {
  DAY_END_MINUTES,
  DAY_START_MINUTES,
  GIPFELRAST_END_MINUTES,
  GIPFELRAST_START_MINUTES,
  clampMinutes,
  formatHoursMinutes,
  gipfelrastX,
  minutesToX,
  photoTicks,
  rulerValueText,
  steppedMinutes,
  xToMinutes
} from './time-axis';

export type ControlHandlers = {
  onMode: (mode: SceneMode) => void;
  onMinutes: (minutes: number) => void;
  onK: (k: number) => void;
  onLayer: (layer: LayerName, visible: boolean) => void;
  onSnapshot: () => void;
  /** Optional: flat earth (false) versus curved earth (true). */
  onCurvature?: (curved: boolean) => void;
};

export type Controls = {
  element: HTMLElement;
  setMode(mode: SceneMode): void;
  setMinutes(minutes: number): void;
  /** The day's sun samples: drives the arc glyph, the day/night strip and the read-out. */
  setSunTable(table: SunSample[]): void;
  setStations(stations: Station[]): void;
  setK(k: number): void;
  setCurved(curved: boolean): void;
  setLayer(layer: LayerName, visible: boolean): void;
  setLayerAvailable(layer: LayerName, available: boolean): void;
  destroy(): void;
};

/** Slider range for the refraction coefficient k (standard atmosphere 0.13). */
export const K_MIN = 0;
export const K_MAX = 0.2;
export const K_STEP = 0.005;

const LAYER_LABELS: [LayerName, string][] = [
  ['contours', 'Höhenlinien'],
  ['relief', 'Relief'],
  ['rock', 'Fels'],
  ['scree', 'Geröll'],
  ['trails', 'Wege'],
  ['stations', 'Standorte'],
  ['labels', 'Namen'],
  ['shadows', 'Schatten'],
  ['nebelmeer', 'Nebelmeer'],
  ['ring', 'Horizont'],
  ['skyline', 'Skyline (ML)']
];
const LAYERS_OFF_BY_DEFAULT: LayerName[] = ['nebelmeer', 'ring', 'skyline'];

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Tiny DOM builder shared by the three panels. Text goes through textContent only. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, string> = {},
  children: (Node | string)[] = []
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    node.setAttribute(name, value);
  }
  node.append(...children);
  return node;
}

function svgNode<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Record<string, string | number> = {},
  text?: string
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) {
    node.setAttribute(name, String(value));
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

/** Linear interpolation of the sun table at a UTC minute (azimuth unwrapped across north). */
function sunAt(table: SunSample[], minutes: number): {azimuth: number; elevation: number} | null {
  if (table.length === 0) {
    return null;
  }
  const first = table[0];
  const last = table[table.length - 1];
  if (minutes <= first.minutes) {
    return {azimuth: first.azimuth, elevation: first.elevation};
  }
  if (minutes >= last.minutes) {
    return {azimuth: last.azimuth, elevation: last.elevation};
  }
  // The table is uniformly sampled but not assumed so: binary search the bracketing pair.
  let lo = 0;
  let hi = table.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (table[mid].minutes <= minutes) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  const a = table[lo];
  const b = table[hi];
  const t = (minutes - a.minutes) / (b.minutes - a.minutes);
  let azimuthDelta = b.azimuth - a.azimuth;
  if (azimuthDelta > 180) azimuthDelta -= 360;
  if (azimuthDelta < -180) azimuthDelta += 360;
  return {
    azimuth: (((a.azimuth + azimuthDelta * t) % 360) + 360) % 360,
    elevation: a.elevation + (b.elevation - a.elevation) * t
  };
}

export function createControls(host: HTMLElement, handlers: ControlHandlers): Controls {
  let mode: SceneMode = 'plan';
  let minutes = GIPFELRAST_START_MINUTES;
  let table: SunSample[] = [];
  let stations: Station[] = [];
  let trackWidth = 0;

  // Plan | Panorama --------------------------------------------------------------------------
  const modeButtons = (
    [
      ['plan', 'Plan'],
      ['panorama', 'Panorama']
    ] as [SceneMode, string][]
  ).map(([value, label]) =>
    h('button', {type: 'button', role: 'radio', 'data-mode': value, class: 'lk-segment'}, [label])
  );
  const segmented = h(
    'div',
    {class: 'lk-segmented', role: 'radiogroup', 'aria-label': 'Ansicht'},
    modeButtons
  );
  function showMode(next: SceneMode): void {
    mode = next;
    for (const button of modeButtons) {
      const active = button.dataset.mode === next;
      button.setAttribute('aria-checked', String(active));
      // Roving tabindex: one stop for the group, arrows move inside it.
      button.tabIndex = active ? 0 : -1;
    }
  }
  function chooseMode(next: SceneMode, focus: boolean): void {
    if (next === mode) return;
    showMode(next);
    if (focus) modeButtons.find(button => button.dataset.mode === next)?.focus();
    handlers.onMode(next);
  }
  segmented.addEventListener('click', event => {
    const button = (event.target as Element).closest<HTMLButtonElement>('button[data-mode]');
    if (button) chooseMode(button.dataset.mode as SceneMode, false);
  });
  segmented.addEventListener('keydown', event => {
    const keys: Record<string, SceneMode> = {
      ArrowLeft: 'plan',
      ArrowUp: 'plan',
      ArrowRight: 'panorama',
      ArrowDown: 'panorama'
    };
    if (keys[event.key]) {
      event.preventDefault();
      chooseMode(keys[event.key], true);
    }
  });
  showMode(mode);

  // Clock read-out and sun-arc glyph ----------------------------------------------------------
  const clockTime = h('span', {class: 'lk-clock-time'});
  const clockZone = h('span', {class: 'lk-clock-zone'}, ['MESZ']);
  const sunLine = h('span', {class: 'lk-sun-line'});
  const dayLine = h('span', {class: 'lk-sun-line lk-muted'});
  const ARC_W = 76;
  const ARC_H = 34;
  const ARC_HORIZON = 26;
  const arcSvg = svgNode('svg', {
    class: 'lk-arc',
    viewBox: `0 0 ${ARC_W} ${ARC_H}`,
    width: ARC_W,
    height: ARC_H,
    'aria-hidden': 'true'
  });
  const arcHorizon = svgNode('line', {
    class: 'lk-arc-horizon',
    x1: 0,
    x2: ARC_W,
    y1: ARC_HORIZON,
    y2: ARC_HORIZON
  });
  const arcPath = svgNode('path', {class: 'lk-arc-path', fill: 'none'});
  const arcSun = svgNode('circle', {class: 'lk-arc-sun', r: 3, cx: -10, cy: -10});
  arcSvg.append(arcHorizon, arcPath, arcSun);
  const clock = h('div', {class: 'lk-clock'}, [
    arcSvg,
    h('div', {class: 'lk-clock-text'}, [
      h('div', {class: 'lk-clock-main'}, [clockTime, clockZone]),
      sunLine,
      dayLine
    ])
  ]);

  // Time ruler ---------------------------------------------------------------------------------
  const rulerSvg = svgNode('svg', {class: 'lk-ruler-svg', 'aria-hidden': 'true'});
  const thumb = h('div', {class: 'lk-thumb', 'aria-hidden': 'true'});
  const track = h('div', {class: 'lk-track'}, [rulerSvg, thumb]);
  const ruler = h(
    'div',
    {
      class: 'lk-ruler',
      role: 'slider',
      tabindex: '0',
      'aria-label': 'Tageszeit, Gipfelrast gedehnt',
      'aria-orientation': 'horizontal',
      'aria-valuemin': String(DAY_START_MINUTES),
      'aria-valuemax': String(DAY_END_MINUTES)
    },
    [track]
  );

  function drawRuler(): void {
    const width = trackWidth;
    rulerSvg.replaceChildren();
    if (width <= 0) return;
    const BRACKET_Y = 9;
    const BASE_Y = 25;
    rulerSvg.setAttribute('viewBox', `0 0 ${width} 46`);
    rulerSvg.setAttribute('width', String(width));
    rulerSvg.setAttribute('height', '46');
    const px = (utcMinutes: number) => minutesToX(utcMinutes) * width;

    // Day and night: a hairline in the dark, a firm stroke while the sun is up.
    const {rise, set} = table.length > 0 ? sunriseSunset(table) : {rise: NaN, set: NaN};
    const hasDay = Number.isFinite(rise) && Number.isFinite(set);
    rulerSvg.append(svgNode('line', {class: 'lk-night', x1: 0, x2: width, y1: BASE_Y, y2: BASE_Y}));
    if (hasDay) {
      rulerSvg.append(
        svgNode('line', {
          class: 'lk-day',
          x1: px(clampMinutes(rise)),
          x2: px(clampMinutes(set)),
          y1: BASE_Y,
          y2: BASE_Y
        })
      );
    }

    // Candidate labels in priority order; later ones are dropped when they would collide.
    const placedX: number[] = [];
    const MIN_GAP = 34;
    const tryLabel = (x: number, text: string, y: number, className: string) => {
      if (placedX.some(other => Math.abs(other - x) < MIN_GAP)) return;
      placedX.push(x);
      rulerSvg.append(svgNode('text', {class: className, x, y, 'text-anchor': 'middle'}, text));
    };

    // Minute ticks inside the bracket, every 5 min, labelled every 10 min.
    for (let m = Math.ceil(GIPFELRAST_START_MINUTES / 5) * 5; m <= GIPFELRAST_END_MINUTES; m += 5) {
      const x = px(m);
      const major = (m + 120) % 10 === 0;
      rulerSvg.append(
        svgNode('line', {class: 'lk-tick', x1: x, x2: x, y1: BASE_Y, y2: BASE_Y + (major ? 6 : 4)})
      );
      if (major) tryLabel(x, formatCest(m), 40, 'lk-tick-label lk-tick-label-zoom');
    }
    // Hour ticks. CEST hours sit at UTC + 2, so UTC hour h is local h + 2.
    const hourPx = width * (minutesToX(DAY_START_MINUTES + 60) - minutesToX(DAY_START_MINUTES));
    const labelEvery = hourPx >= MIN_GAP ? 1 : hourPx * 2 >= MIN_GAP ? 2 : 3;
    for (let hour = DAY_START_MINUTES / 60; hour <= DAY_END_MINUTES / 60; hour++) {
      const x = px(hour * 60);
      rulerSvg.append(
        svgNode('line', {class: 'lk-tick', x1: x, x2: x, y1: BASE_Y, y2: BASE_Y + 6})
      );
      if ((hour + 2) % labelEvery === 0) {
        tryLabel(x, String((hour + 2) % 24).padStart(2, '0'), 40, 'lk-tick-label');
      }
    }

    // Gipfelrast bracket above the baseline, label centred.
    const {start, end} = gipfelrastX();
    const x0 = start * width;
    const x1 = end * width;
    rulerSvg.append(
      svgNode('path', {
        class: 'lk-bracket',
        d: `M${x0} ${BRACKET_Y + 5} V${BRACKET_Y} H${x1} V${BRACKET_Y + 5}`,
        fill: 'none'
      }),
      svgNode(
        'text',
        {class: 'lk-bracket-label', x: (x0 + x1) / 2, y: BRACKET_Y - 3, 'text-anchor': 'middle'},
        'Gipfelrast'
      )
    );

    // One tick per photo at its true takenAt; they overlap into a cluster by design.
    for (const tick of photoTicks(stations)) {
      const x = tick.x * width;
      rulerSvg.append(
        svgNode('line', {class: 'lk-photo', x1: x, x2: x, y1: BASE_Y - 8, y2: BASE_Y - 1})
      );
    }
  }

  function showMinutes(): void {
    thumb.style.left = `${minutesToX(minutes) * 100}%`;
    clockTime.textContent = formatCest(minutes);
    const sun = sunAt(table, minutes);
    ruler.setAttribute('aria-valuenow', String(Math.round(minutes * 100) / 100));
    ruler.setAttribute('aria-valuetext', rulerValueText(minutes, sun ? sun.elevation : null));
    if (sun) {
      sunLine.textContent = `Azimut ${Math.round(sun.azimuth) % 360}°  Höhe ${sun.elevation.toFixed(1).replace('-', '−')}°`;
      // Arc glyph: x is the day on a linear scale (the glyph is a clock-face, not the ruler).
      const dx = ((minutes - DAY_START_MINUTES) / (DAY_END_MINUTES - DAY_START_MINUTES)) * ARC_W;
      arcSun.setAttribute('cx', dx.toFixed(2));
      arcSun.setAttribute('cy', arcY(sun.elevation).toFixed(2));
    } else {
      sunLine.textContent = '';
    }
  }

  // The glyph's vertical scale: the day's highest sun sits 2 px under the top.
  let arcMaxElevation = 45;
  const arcY = (elevation: number): number =>
    ARC_HORIZON - (Math.max(-8, elevation) / arcMaxElevation) * (ARC_HORIZON - 2);

  function showSunTable(): void {
    const points: string[] = [];
    arcMaxElevation = 1;
    for (const sample of table) arcMaxElevation = Math.max(arcMaxElevation, sample.elevation);
    for (const sample of table) {
      if (sample.minutes < DAY_START_MINUTES || sample.minutes > DAY_END_MINUTES) continue;
      const x =
        ((sample.minutes - DAY_START_MINUTES) / (DAY_END_MINUTES - DAY_START_MINUTES)) * ARC_W;
      points.push(
        `${points.length === 0 ? 'M' : 'L'}${x.toFixed(1)} ${arcY(sample.elevation).toFixed(1)}`
      );
    }
    arcPath.setAttribute('d', points.join(' '));
    if (table.length > 0) {
      const {rise, set} = sunriseSunset(table);
      dayLine.textContent =
        Number.isFinite(rise) && Number.isFinite(set)
          ? `${formatCest(rise)} bis ${formatCest(set)}, ${formatHoursMinutes((set - rise) / 60)}`
          : '';
    } else {
      dayLine.textContent = '';
    }
    drawRuler();
    showMinutes();
  }

  function minutesFromPointer(event: PointerEvent): number {
    const rect = track.getBoundingClientRect();
    return xToMinutes((event.clientX - rect.left) / Math.max(1, rect.width));
  }
  function commitMinutes(next: number): void {
    // 0.01 min (0.6 s) is far below one pixel of the magnified ruler.
    minutes = Math.round(clampMinutes(next) * 100) / 100;
    showMinutes();
    handlers.onMinutes(minutes);
  }
  let dragging = false;
  ruler.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    dragging = true;
    ruler.setPointerCapture(event.pointerId);
    ruler.focus({preventScroll: true});
    commitMinutes(minutesFromPointer(event));
  });
  ruler.addEventListener('pointermove', event => {
    if (dragging) commitMinutes(minutesFromPointer(event));
  });
  const endDrag = (event: PointerEvent) => {
    dragging = false;
    if (ruler.hasPointerCapture(event.pointerId)) ruler.releasePointerCapture(event.pointerId);
  };
  ruler.addEventListener('pointerup', endDrag);
  ruler.addEventListener('pointercancel', endDrag);
  ruler.addEventListener('keydown', event => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const large = event.shiftKey;
    let next: number | null = null;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowUp':
      case 'ArrowLeft':
      case 'ArrowDown':
      case 'PageUp':
      case 'PageDown': {
        const forward =
          event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'PageUp';
        next = steppedMinutes(minutes, forward, large || event.key.startsWith('Page'));
        break;
      }
      case 'Home':
        next = DAY_START_MINUTES;
        break;
      case 'End':
        next = DAY_END_MINUTES;
        break;
      default:
        return;
    }
    event.preventDefault();
    commitMinutes(next);
  });

  // Refraction slider and earth curvature -----------------------------------------------------
  const kInput = h('input', {
    type: 'range',
    class: 'lk-range',
    min: String(K_MIN),
    max: String(K_MAX),
    step: String(K_STEP),
    value: '0.13',
    'aria-label': 'Refraktionskoeffizient k'
  });
  const kValue = h('output', {class: 'lk-k-value'}, ['0.130']);
  kInput.addEventListener('input', () => {
    const k = Number(kInput.value);
    kValue.textContent = k.toFixed(3);
    handlers.onK(k);
  });
  const curvedButton = h('button', {type: 'button', class: 'lk-toggle', 'aria-pressed': 'true'}, [
    'Erdkrümmung'
  ]);
  curvedButton.addEventListener('click', () => {
    const next = curvedButton.getAttribute('aria-pressed') !== 'true';
    curvedButton.setAttribute('aria-pressed', String(next));
    handlers.onCurvature?.(next);
  });
  const horizon = h('div', {class: 'lk-group lk-horizon'}, [
    h('span', {class: 'lk-group-label'}, ['Refraktion k =']),
    kInput,
    kValue,
    ...(handlers.onCurvature ? [curvedButton] : [])
  ]);

  // Layer toggles ------------------------------------------------------------------------------
  const layerButtons = new Map<LayerName, HTMLButtonElement>();
  const layerGroup = h('div', {class: 'lk-group lk-layers', role: 'group', 'aria-label': 'Ebenen'});
  for (const [layer, label] of LAYER_LABELS) {
    const button = h(
      'button',
      {
        type: 'button',
        class: 'lk-toggle',
        'aria-pressed': String(!LAYERS_OFF_BY_DEFAULT.includes(layer))
      },
      [label]
    );
    button.addEventListener('click', () => {
      const next = button.getAttribute('aria-pressed') !== 'true';
      button.setAttribute('aria-pressed', String(next));
      handlers.onLayer(layer, next);
    });
    layerButtons.set(layer, button);
    layerGroup.append(button);
  }

  const snapshotButton = h('button', {type: 'button', class: 'lk-action'}, ['Bild speichern']);
  snapshotButton.addEventListener('click', () => handlers.onSnapshot());

  const root = h('div', {class: 'lk-controls'}, [
    h('div', {class: 'lk-row lk-row-top'}, [segmented, clock]),
    ruler,
    h('div', {class: 'lk-row lk-row-tools'}, [layerGroup, horizon, snapshotButton])
  ]);
  host.append(root);

  // The ruler is drawn in pixels so strokes and type stay crisp at any width.
  const measure = () => {
    const width = Math.round(track.clientWidth);
    if (width !== trackWidth) {
      trackWidth = width;
      drawRuler();
    }
  };
  const resizeObserver =
    typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => measure());
  resizeObserver?.observe(track);
  measure();
  showMinutes();

  return {
    element: root,
    setMode: showMode,
    setMinutes(next) {
      minutes = clampMinutes(next);
      showMinutes();
    },
    setSunTable(next) {
      table = next;
      showSunTable();
    },
    setStations(next) {
      stations = next;
      drawRuler();
    },
    setK(k) {
      kInput.value = String(k);
      kValue.textContent = k.toFixed(3);
    },
    setCurved(curved) {
      curvedButton.setAttribute('aria-pressed', String(curved));
    },
    setLayer(layer, visible) {
      layerButtons.get(layer)?.setAttribute('aria-pressed', String(visible));
    },
    setLayerAvailable(layer, available) {
      const button = layerButtons.get(layer);
      if (button) button.disabled = !available;
    },
    destroy() {
      resizeObserver?.disconnect();
      root.remove();
    }
  };
}
