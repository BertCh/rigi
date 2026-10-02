// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The horizon-map twin, kept free of luma.gl so the shadow worker bundle never pulls it in. Only
// pure modules (shadow-shaders.ts, geodesy) are imported here. See cpu-twins.ts for the rest.
//
// The arithmetic uses Math.fround in the order of the GPU kernel so the twin and the graph agree to
// within the u16 quantisation step. That is a tolerance, not a claim of bit-identical floats.

import {REFRACTION_K} from '../geo/geodesy';
import type {Mosaic, ShadowWindow} from '../types';
import {
  curvatureCoefficient,
  HORIZON_MAP_AZIMUTHS,
  HORIZON_MAP_SAMPLES,
  HORIZON_MAX_DISTANCE,
  HORIZON_MIN_DISTANCE,
  makeSampleTable,
  quantizeAngle
} from './shadow-shaders';

const f32 = Math.fround;

/** The part of a Mosaic the twin reads: heights only, so a worker never needs the raw pixels. */
export type TerrainHeights = Pick<Mosaic, 'heights' | 'width' | 'height' | 'metersPerPixel'>;

/** Sample distances d_i = 26 (12000 / 26)^(i / (n - 1)), metres, in double precision. */
export function horizonDistances(samples: number): Float64Array {
  const distances = new Float64Array(samples);
  const ratio = HORIZON_MAX_DISTANCE / HORIZON_MIN_DISTANCE;
  for (let i = 0; i < samples; i++) {
    distances[i] = HORIZON_MIN_DISTANCE * ratio ** (i / (samples - 1));
  }
  return distances;
}

/** Bilinear height at continuous pixel coordinates (pixel centres at +0.5), clamped at the edge. */
function sampleHeight(terrain: TerrainHeights, x: number, y: number): number {
  const {heights, width, height} = terrain;
  const u = f32(x - 0.5);
  const v = f32(y - 0.5);
  const x0 = Math.floor(u);
  const y0 = Math.floor(v);
  const fx = f32(u - x0);
  const fy = f32(v - y0);
  const xa = Math.min(Math.max(x0, 0), width - 1);
  const xb = Math.min(Math.max(x0 + 1, 0), width - 1);
  const ya = Math.min(Math.max(y0, 0), height - 1);
  const yb = Math.min(Math.max(y0 + 1, 0), height - 1);
  const h00 = heights[ya * width + xa];
  const h10 = heights[ya * width + xb];
  const h01 = heights[yb * width + xa];
  const h11 = heights[yb * width + xb];
  const top = f32(h00 + f32(f32(h10 - h00) * fx));
  const bottom = f32(h01 + f32(f32(h11 - h01) * fx));
  return f32(top + f32(f32(bottom - top) * fy));
}

/**
 * Horizon angles for window rows [rowStart, rowEnd), written into `out` at
 * `(row * size + col) * azimuths + a` (the layout of the graph's readHorizonMap).
 * Row 0 = north; azimuth a is a * 360 / azimuths degrees clockwise from north.
 */
export function computeHorizonRowsCpu(
  terrain: TerrainHeights,
  window: ShadowWindow,
  azimuths: number,
  samples: number,
  rowStart: number,
  rowEnd: number,
  out: Uint16Array,
  k: number = REFRACTION_K
): void {
  const {size, stride, column, row} = window;
  // The kernel's operands, rounded to f32 the same way: distance and 1/d table, unit ray, curvature.
  // makeSampleTable is the 256-sample table; other counts (parity probes) use the same recipe.
  const table = samples === HORIZON_MAP_SAMPLES ? makeSampleTable() : makeOtherTable(samples);
  const curvature = curvatureCoefficient(k);
  const pixelsPerMeter = f32(1 / terrain.metersPerPixel);
  // One unit ray per azimuth, computed once: not per cell.
  const directions = Array.from({length: azimuths}, (_, index) => rayDirection(index, azimuths));

  for (let r = rowStart; r < rowEnd; r++) {
    const centerY = f32(row + r * stride) + 0.5 * stride;
    for (let c = 0; c < size; c++) {
      const centerX = f32(column + c * stride) + 0.5 * stride;
      const origin = sampleHeight(terrain, centerX, centerY);
      const base = (r * size + c) * azimuths;
      for (let a = 0; a < azimuths; a++) {
        const [directionEast, directionNorth] = directions[a];
        let best = -1e30;
        for (let i = 0; i < samples; i++) {
          const distance = table[2 * i];
          const east = f32(directionEast * distance);
          const north = f32(directionNorth * distance);
          // Row 0 is north, so a northward step decreases y.
          const x = f32(centerX + f32(east * pixelsPerMeter));
          const y = f32(centerY - f32(north * pixelsPerMeter));
          const rise = f32(sampleHeight(terrain, x, y) - origin);
          const tangent = f32(f32(rise * table[2 * i + 1]) - f32(distance * curvature));
          if (tangent > best) best = tangent;
        }
        out[base + a] = quantizeAngle(Math.atan(best));
      }
    }
  }
}

/** Unit (east, north) ray of azimuth index a, rounded to f32 like the kernel's uniform. */
function rayDirection(index: number, azimuths: number): [number, number] {
  const radians = (index * 2 * Math.PI) / azimuths;
  return [f32(Math.sin(radians)), f32(Math.cos(radians))];
}

function makeOtherTable(samples: number): Float32Array {
  const table = new Float32Array(samples * 2);
  const distances = horizonDistances(samples);
  for (let i = 0; i < samples; i++) {
    table[2 * i] = distances[i];
    table[2 * i + 1] = 1 / distances[i];
  }
  return table;
}

export function computeHorizonMapCpu(
  mosaic: TerrainHeights,
  window: ShadowWindow,
  azimuths: number = HORIZON_MAP_AZIMUTHS,
  samples: number = HORIZON_MAP_SAMPLES
): Uint16Array {
  const out = new Uint16Array(window.size * window.size * azimuths);
  computeHorizonRowsCpu(mosaic, window, azimuths, samples, 0, window.size, out);
  return out;
}
