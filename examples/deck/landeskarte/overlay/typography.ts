// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Name typography for the map labels: the tier table, the type families, the thousands format and
// a text-width estimate. Everything here is pure so the label placement can be checked in Node.

import type {PeakTier, RGB} from '../types';

/** Google Fonts families named in index.html. The fallbacks keep an offline render legible. */
export const FONT_SANS = "'Fira Sans', 'Helvetica Neue', Arial, sans-serif";
export const FONT_SERIF = "'Source Serif 4', Georgia, 'Times New Roman', serif";
export const FONT_MONO = "'Fira Mono', ui-monospace, Menlo, monospace";

/** Brezine roles: peak navy, lake water, paper ground (the halo colour). */
export const COLOR_NAVY: RGB = [0, 47, 85];
export const COLOR_WATER: RGB = [48, 98, 107];
export const COLOR_PAPER: RGB = [244, 244, 244];

/** Smallest text the map ever draws, in canvas pixels. */
export const LABEL_FLOOR_PX = 11;

export type NameTier = PeakTier | 'lake';

export type NameStyle = {
  /** Multiplier on the base label size. */
  scale: number;
  weight: number;
  italic: boolean;
  /** Letter spacing in em, applied as hair spaces (see `trackText`). */
  trackingEm: number;
  family: string;
  color: RGB;
  /** Padding multiplier of the declutter: the more important the name, the more air it keeps. */
  padScale: number;
};

/** Imhof's rule: size and weight carry the rank. Lakes are italic serif and letter-spaced. */
export const NAME_TYPO: Record<NameTier, NameStyle> = {
  'peak-major': {
    scale: 1.25,
    weight: 700,
    italic: false,
    trackingEm: 0,
    family: FONT_SANS,
    color: COLOR_NAVY,
    padScale: 1.14
  },
  peak: {
    scale: 1,
    weight: 600,
    italic: false,
    trackingEm: 0,
    family: FONT_SANS,
    color: COLOR_NAVY,
    padScale: 1
  },
  minor: {
    scale: 0.86,
    weight: 500,
    italic: false,
    trackingEm: 0,
    family: FONT_SANS,
    color: COLOR_NAVY,
    padScale: 0.88
  },
  lake: {
    scale: 1.05,
    weight: 400,
    italic: true,
    trackingEm: 0.14,
    family: FONT_SERIF,
    color: COLOR_WATER,
    padScale: 1
  }
};

/** Altitudes are set in the mono face so the digits line up (tabular). */
export const ALTITUDE_STYLE = {family: FONT_MONO, weight: 400, color: COLOR_NAVY};

export const THIN_SPACE = ' ';
export const HAIR_SPACE = ' ';

/** `1963` becomes `1 963` with a thin space (U+2009), the Swiss typographic convention. */
export function formatAltitude(meters: number): string {
  const rounded = Math.round(meters);
  const digits = String(Math.abs(rounded));
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, THIN_SPACE);
  return rounded < 0 ? `−${grouped}` : grouped;
}

/** Spaces the letters of a name with hair spaces: deck's TextLayer has no letter-spacing prop. */
export function trackText(text: string): string {
  return Array.from(text).join(HAIR_SPACE);
}

/**
 * Glyphs the SDF atlas must contain. An explicit set (not 'auto') makes the atlas independent of
 * the data and guarantees the umlauts and accents of Swiss names (Blüemlisalp, Gärstenhörner,
 * Gantrisch, Mönch) plus the spaces and typographic marks we insert ourselves.
 */
export const LABEL_CHARACTER_SET: string[] = (() => {
  const set = new Set<string>();
  const addRange = (from: number, to: number) => {
    for (let code = from; code <= to; code++) {
      set.add(String.fromCharCode(code));
    }
  };
  addRange(0x20, 0x7e);
  // Latin-1 letters (umlauts, accents, ß) without the multiplication and division signs.
  addRange(0xc0, 0xd6);
  addRange(0xd8, 0xf6);
  addRange(0xf8, 0xff);
  for (const extra of [THIN_SPACE, HAIR_SPACE, '−', '–', '’', '°']) {
    set.add(extra);
  }
  return [...set];
})();

export type TextStyle = {weight: number; italic: boolean; trackingEm: number};

/**
 * Approximate advance widths in em for Fira Sans, grouped into a few classes. A canvas could
 * give exact widths but placement must stay pure, so `placeLabels` accepts a `measure` override.
 */
const NARROW = new Set("ijlt|!'.,:;()[]I  ");
const WIDE = new Set('mwMW');

function advanceEm(char: string): number {
  if (char === ' ') return 0.26;
  if (char === THIN_SPACE) return 0.18;
  if (char === HAIR_SPACE) return 0.1;
  if (NARROW.has(char)) return 0.3;
  if (WIDE.has(char)) return 0.84;
  if (char >= '0' && char <= '9') return 0.56;
  if (char !== char.toLowerCase()) return 0.62;
  return 0.53;
}

/** Estimated width in pixels of one line of text. */
export function estimateTextWidth(text: string, sizePx: number, style: TextStyle): number {
  let em = 0;
  let count = 0;
  for (const char of text) {
    em += advanceEm(char);
    count++;
  }
  em += style.trackingEm * count;
  // Heavier cuts are wider, the italic serif is a little narrower than Fira Sans.
  const weightFactor = 1 + (style.weight - 400) * 0.00028;
  const italicFactor = style.italic ? 0.94 : 1;
  return em * sizePx * weightFactor * italicFactor;
}

/** Waits (at most `timeoutMs`) for the label faces so the SDF atlas is not built from fallbacks. */
export async function loadLabelFonts(timeoutMs: number = 3000): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) {
    return;
  }
  const faces = [
    "700 16px 'Fira Sans'",
    "600 16px 'Fira Sans'",
    "500 16px 'Fira Sans'",
    "italic 400 16px 'Source Serif 4'",
    "400 16px 'Fira Mono'"
  ];
  const loads = Promise.allSettled(faces.map(face => document.fonts.load(face, 'Aä1')));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>(resolve => {
    timer = setTimeout(resolve, timeoutMs);
  });
  await Promise.race([loads, timeout]);
  clearTimeout(timer);
}
