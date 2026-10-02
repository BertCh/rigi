// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// GPU-versus-CPU parity for the shadow graph, and the double-precision reference the CPU twin is
// itself checked against. Parity here means "within a stated tolerance", never bit-identical floats.

import {EARTH_R, REFRACTION_K} from '../geo/geodesy';
import type {ParityReport, ShadowWindow} from '../types';
import {ANGLE_STEP, dequantizeAngle, horizonDistances, type TerrainHeights} from './cpu-twins';

/** A shadow bit may differ only this close to the threshold (degrees), per the spec's table. */
export const SHADOW_FLIP_BAND_DEG = 0.05;

function bilinearF64(terrain: TerrainHeights, x: number, y: number): number {
  const {heights, width, height} = terrain;
  const u = x - 0.5;
  const v = y - 0.5;
  const x0 = Math.floor(u);
  const y0 = Math.floor(v);
  const fx = u - x0;
  const fy = v - y0;
  const clampX = (value: number) => Math.min(Math.max(value, 0), width - 1);
  const clampY = (value: number) => Math.min(Math.max(value, 0), height - 1);
  const at = (xi: number, yi: number) => heights[clampY(yi) * width + clampX(xi)];
  const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
  const bottom = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
  return top * (1 - fy) + bottom * fy;
}

/**
 * Direct double-precision march for one window cell and azimuth: the unquantised horizon angle in
 * radians, using the formulas of the twin without any Math.fround.
 */
export function marchCellF64(
  terrain: TerrainHeights,
  window: ShadowWindow,
  col: number,
  row: number,
  azimuthRad: number,
  samples: number,
  k: number = REFRACTION_K
): number {
  const px = window.column + (col + 0.5) * window.stride;
  const py = window.row + (row + 0.5) * window.stride;
  const origin = bilinearF64(terrain, px, py);
  const distances = horizonDistances(samples);
  let best = -Infinity;
  for (let i = 0; i < samples; i++) {
    const d = distances[i];
    const h = bilinearF64(
      terrain,
      px + (d * Math.sin(azimuthRad)) / terrain.metersPerPixel,
      py - (d * Math.cos(azimuthRad)) / terrain.metersPerPixel
    );
    best = Math.max(best, (h - origin) / d - (d * (1 - k)) / (2 * EARTH_R));
  }
  return Math.atan(best);
}

export type ParityInput = {
  /** Horizon maps in the readHorizonMap layout. */
  horizonGpu: Uint16Array;
  horizonCpu: Uint16Array;
  toleranceDeg: number;
  cpuMs: number;
  gpuMs: number;
  /** Optional shaded fields for one sun, to count differing shadow bits. */
  shadow?: {
    gpu: Uint8Array;
    cpu: Uint8Array;
    azimuths: number;
    /** Sun azimuth and elevation in degrees, as passed to setSun. */
    sunAzimuth: number;
    sunElevation: number;
  };
};

/**
 * Compares two horizon maps in degrees and, when given, the shadow bits (value >= 128). A flipped
 * bit is excused when the sun lies within SHADOW_FLIP_BAND_DEG of the horizon at that cell.
 */
export function compareParity(input: ParityInput): ParityReport {
  const {horizonGpu, horizonCpu, toleranceDeg} = input;
  const total = Math.min(horizonGpu.length, horizonCpu.length);
  let maxAbsDeg = 0;
  let overTolerance = 0;
  let bitIdentical = 0;
  for (let i = 0; i < total; i++) {
    if (horizonGpu[i] === horizonCpu[i]) bitIdentical++;
    const diff = Math.abs(dequantizeAngle(horizonGpu[i]) - dequantizeAngle(horizonCpu[i]));
    const diffDeg = (diff * 180) / Math.PI;
    if (diffDeg > maxAbsDeg) maxAbsDeg = diffDeg;
    if (diffDeg > toleranceDeg) overTolerance++;
  }

  let shadowFlips = 0;
  let flipsWithinUlpBand = true;
  const shadow = input.shadow;
  if (shadow) {
    const {azimuths} = shadow;
    const position = ((((shadow.sunAzimuth / 360) * azimuths) % azimuths) + azimuths) % azimuths;
    const lower = Math.floor(position);
    const upper = (lower + 1) % azimuths;
    const mix = position - lower;
    for (let cell = 0; cell < shadow.gpu.length; cell++) {
      if (shadow.gpu[cell] >= 128 === shadow.cpu[cell] >= 128) continue;
      shadowFlips++;
      const horizon =
        dequantizeAngle(horizonCpu[cell * azimuths + lower]) * (1 - mix) +
        dequantizeAngle(horizonCpu[cell * azimuths + upper]) * mix;
      const marginDeg = Math.abs(shadow.sunElevation - (horizon * 180) / Math.PI);
      if (marginDeg > SHADOW_FLIP_BAND_DEG) flipsWithinUlpBand = false;
    }
  }

  return {
    subject: shadow ? 'horizon-map+shadow' : 'horizon-map',
    maxAbsDeg,
    overTolerance,
    toleranceDeg,
    bitIdentical,
    total,
    shadowFlips,
    flipsWithinUlpBand,
    cpuMs: input.cpuMs,
    gpuMs: input.gpuMs
  };
}

/** One u16 quantisation step in degrees, the floor for any horizon-map tolerance. */
export const ANGLE_STEP_DEG = (ANGLE_STEP * 180) / Math.PI;
