// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Hypsometric tint of the Landeskarte example. The palette is our own and follows the Swiss
// (Imhof) idea rather than any published map's colours: pale valley greens climb through cream and
// a muted ochre to a cool rock grey and, above 3000 m, nearly paper white. Saturation stays low on
// purpose, because relief shading, contours and rock ink carry the form and the tint only has to
// tell the altitude belts apart. Lakes are painted by the caller, not by this table.

import type {RGB} from '../types';

export type HypsoStop = {elevation: number; color: RGB};

/** Elevation stops in metres with sRGB colours, 0..255. Colours clamp below the first stop. */
export const HYPSO_STOPS: HypsoStop[] = [
  {elevation: 350, color: [172, 192, 156]},
  {elevation: 600, color: [188, 204, 164]},
  {elevation: 900, color: [206, 214, 170]},
  {elevation: 1250, color: [224, 222, 178]},
  {elevation: 1600, color: [230, 216, 172]},
  {elevation: 2000, color: [224, 205, 168]},
  {elevation: 2400, color: [214, 199, 176]},
  {elevation: 2800, color: [212, 208, 202]},
  {elevation: 3200, color: [232, 232, 232]},
  {elevation: 4000, color: [246, 246, 246]}
];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** CPU mirror of `lk_hypso` without shading (shade at its neutral value). sRGB 0..255. */
export function hypsoColor(elevation: number): RGB {
  const first = HYPSO_STOPS[0];
  let color: RGB = [first.color[0], first.color[1], first.color[2]];
  // Same chained clamp-and-mix as the shader, so both sides agree bit for bit in structure.
  for (let i = 1; i < HYPSO_STOPS.length; i++) {
    const from = HYPSO_STOPS[i - 1];
    const to = HYPSO_STOPS[i];
    const t = Math.min(
      Math.max((elevation - from.elevation) / (to.elevation - from.elevation), 0),
      1
    );
    color = [
      lerp(color[0], to.color[0], t),
      lerp(color[1], to.color[1], t),
      lerp(color[2], to.color[2], t)
    ];
  }
  return color;
}

function formatFloat(value: number): string {
  const text = value.toFixed(5).replace(/0+$/, '');
  return text.endsWith('.') ? `${text}0` : text;
}

/**
 * The tint body shared by the WGSL and GLSL snippets: a piecewise linear ramp written as a chain of
 * clamped mixes, so no array indexing or texture is needed. Colours are emitted as sRGB 0..1.
 * `vec3Name` is the language's vec3 constructor (`vec3` or `vec3<f32>`); `assign` wraps an
 * expression into a statement that sets `tint`; the first statement must declare it.
 */
export function buildHypsoRamp(vec3Name: string, assign: (expression: string) => string): string {
  const vec = (c: RGB) => `${vec3Name}(${c.map(v => formatFloat(v / 255)).join(', ')})`;
  const lines = [assign(vec(HYPSO_STOPS[0].color))];
  for (let i = 1; i < HYPSO_STOPS.length; i++) {
    const from = HYPSO_STOPS[i - 1].elevation;
    const to = HYPSO_STOPS[i].elevation;
    const t = `clamp((elevM - ${formatFloat(from)}) / ${formatFloat(to - from)}, 0.0, 1.0)`;
    lines.push(assign(`mix(tint, ${vec(HYPSO_STOPS[i].color)}, ${t})`));
  }
  return lines.join('\n');
}
