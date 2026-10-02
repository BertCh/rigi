// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The numbers drawer: the picked peak's geometry (haversine distance, bearing, elevation angle,
// curvature drop), the refraction coefficient and the sun. Closed by default. The DOM is built
// once and `update` only rewrites text that changed, so it is cheap to call every frame.

import type {NumbersState} from '../types';
import {h} from './controls';
import {formatHoursMinutes} from './time-axis';

const THIN_SPACE = ' ';
const MINUS = '−';

/** Thousands separated by a thin space from four digits up, as on the map: 1963 -> "1 963". */
function formatThousands(value: number): string {
  const digits = String(Math.round(Math.abs(value)));
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, THIN_SPACE);
  return (value < 0 ? MINUS : '') + grouped;
}

function formatSigned(value: number, digits: number): string {
  const text = Math.abs(value).toFixed(digits);
  return value < 0 && Number(text) !== 0 ? MINUS + text : text;
}

function formatDistance(meters: number): string {
  return meters >= 1000
    ? `${(meters / 1000).toFixed(1)}${THIN_SPACE}km`
    : `${Math.round(meters)}${THIN_SPACE}m`;
}

/** First and last light arrive as CEST strings; the sun-hours figure is formatted here. */
function formatCursor(cursor: NonNullable<NumbersState['cursor']>): string {
  return `Sonne ${formatHoursMinutes(cursor.sunHours)}, erstes Licht ${cursor.firstLight}, letztes Licht ${cursor.lastLight}`;
}

export type NumbersPanel = {
  element: HTMLElement;
  update(state: NumbersState): void;
  setOpen(open: boolean): void;
};

export function createNumbersPanel(host: HTMLElement): NumbersPanel {
  const cells = new Map<string, HTMLElement>();
  const lastText = new Map<string, string>();

  function row(key: string, label: string): HTMLElement[] {
    const term = h('dt', {}, [label]);
    const value = h('dd', {});
    cells.set(key, value);
    return [term, value];
  }
  function set(key: string, text: string): void {
    if (lastText.get(key) === text) return;
    lastText.set(key, text);
    const cell = cells.get(key);
    if (cell) cell.textContent = text;
  }

  const peakTitle = h('div', {class: 'lk-peak-title'}, ['Kein Gipfel gewählt']);
  const peakList = h('dl', {class: 'lk-numbers'}, [
    ...row('ele', 'Höhe'),
    ...row('distance', 'Distanz'),
    ...row('bearing', 'Peilung'),
    ...row('angle', 'Höhenwinkel'),
    ...row('drop', 'Krümmung (1−k)d²/2R'),
    ...row('visible', 'Sichtbar')
  ]);
  const skyList = h('dl', {class: 'lk-numbers'}, [
    ...row('k', 'Refraktion k'),
    ...row('azimuth', 'Sonne Azimut'),
    ...row('elevation', 'Sonne Höhe'),
    ...row('airmass', 'Luftmasse')
  ]);
  const cursorLine = h('p', {class: 'lk-cursor-line'});

  const summary = h('summary', {}, ['Zahlen']);
  const details = h('details', {class: 'lk-drawer lk-numbers-panel'}, [
    summary,
    h('div', {class: 'lk-drawer-body'}, [
      h('div', {class: 'lk-column'}, [peakTitle, peakList]),
      h('div', {class: 'lk-column'}, [
        h('div', {class: 'lk-peak-title'}, ['Himmel']),
        skyList,
        cursorLine
      ])
    ])
  ]);
  host.append(details);

  return {
    element: details,
    setOpen(open) {
      details.open = open;
    },
    update(state) {
      const peak = state.peak;
      const title = peak ? peak.name : 'Kein Gipfel gewählt';
      if (peakTitle.textContent !== title) peakTitle.textContent = title;
      peakList.classList.toggle('lk-empty', !peak);
      set('ele', peak ? `${formatThousands(peak.ele)}${THIN_SPACE}m` : '–');
      set('distance', peak ? formatDistance(peak.distance) : '–');
      set('bearing', peak ? `${peak.bearing.toFixed(1)}°` : '–');
      set('angle', peak ? `${formatSigned(peak.elevationAngle, 2)}°` : '–');
      set('drop', peak ? `${peak.curvatureDrop.toFixed(1)}${THIN_SPACE}m` : '–');
      set('visible', peak ? (peak.visible ? 'ja' : 'nein, Gelände verdeckt') : '–');
      set('k', state.refractionK.toFixed(3));
      set('azimuth', `${state.sun.azimuth.toFixed(1)}°`);
      set('elevation', `${formatSigned(state.sun.elevation, 1)}°`);
      set('airmass', state.sun.elevation > -1 ? state.sun.airMass.toFixed(2) : '–');
      const cursorText = state.cursor ? formatCursor(state.cursor) : '';
      if (cursorLine.textContent !== cursorText) cursorLine.textContent = cursorText;
    }
  };
}
