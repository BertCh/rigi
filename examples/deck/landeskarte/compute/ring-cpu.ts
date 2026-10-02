// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// CPU twin of the ring graph (`ring-graph.ts`, kernels in `ring-shaders.ts`). Every f32 operation
// of the WGSL is rounded with `Math.fround` in the same order, so GPU and twin agree to a few ULP
// (the GPU may still fuse multiply-adds). `opaque()` in the kernels only hides values from the
// compiler, so it is the identity here.
//
// One convention everywhere: tangent = (h - h_eye) / d - d (1 - k) / (2R), with R = EARTH_R.

import {EARTH_R} from '../geo/geodesy';
import type {Frame, Mosaic, Peak, RingResult} from '../types';
import {getMosaicPlacement, MOSAIC_TILE_SIZE} from './mosaic';

/**
 * Longest ray, metres. The 7 x 7 z11 mosaic is 94 km wide, so a ray is at least about 40 km long
 * wherever the eye sits in the centre tile; a ray that leaves the mosaic simply ends there.
 */
export const RING_MAXIMUM_DISTANCE = 45_000;
export const RING_DEFAULT_BINS = 2048;
/** A peak this far below the horizon in front of it still counts as visible, degrees. */
export const RING_PEAK_TOLERANCE_DEG = 0.1;
/**
 * `peakMarginDeg` of a peak beyond `RING_MAXIMUM_DISTANCE`, or whose ray leaves the mosaic before
 * the peak: it is reported invisible.
 */
export const RING_OUT_OF_RANGE_MARGIN_DEG = -90;

/** Inputs shared bit for bit by the GPU graph and the twin. Every scalar is an f32 value. */
export type RingSetup = {
  mosaicWidth: number;
  mosaicHeight: number;
  /** Integer mosaic pixel containing the eye, and the position within it in [0, 1). */
  eyeColumnIndex: number;
  eyeRowIndex: number;
  eyeColumnFraction: number;
  eyeRowFraction: number;
  /** Eye altitude above sea level, metres. */
  eyeAltitude: number;
  /** Web Mercator pixels per ground metre at the eye, east and north (the ellipsoid is not conformal). */
  pixelsPerMeterEast: number;
  pixelsPerMeterNorth: number;
  /** tan(lat) / M: growth of the Mercator scale per metre northwards. */
  mercatorGrowth: number;
  halfMercatorGrowth: number;
  /** Second-order growth of the east scale, and the cubic term of the northing (Mercator series). */
  columnCurvature: number;
  rowCubic: number;
  /** tan(lat) / (2 N): a parallel bends north of the tangent plane by east^2 times this. */
  parallelCurvature: number;
  /** (1 - k) / 2R, per metre of distance. */
  curvature: number;
  binCount: number;
  /** Interleaved [sin(azimuth), cos(azimuth)] per bin, bin 0 = north, clockwise. */
  azimuthDirections: Float32Array;
  /** Interleaved [distance, 1 / distance], shared by every azimuth. */
  samples: Float32Array;
  sampleCount: number;
  /** Two vec4 per peak: [sin, cos, distance, 1 / distance], [elevation, 0, 0, 0]. */
  peakRays: Float32Array;
  peakCount: number;
  /** Samples closer than this to a peak are its own shoulder, not a blocker (two DEM pixels). */
  peakSkirt: number;
};

/** Raw per-peak kernel output: [peakTangent, blockerTangent, outOfRange (0 or 1), blockerDistance]. */
export type RingPeakRaw = Float32Array;

/** `[sin, cos]` per bin; bin i points at azimuth i / binCount of a turn. */
export function makeAzimuthDirections(binCount: number): Float32Array {
  const directions = new Float32Array(binCount * 2);
  for (let bin = 0; bin < binCount; bin++) {
    const azimuth = (bin / binCount) * 2 * Math.PI;
    directions[2 * bin] = Math.sin(azimuth);
    directions[2 * bin + 1] = Math.cos(azimuth);
  }
  return directions;
}

/**
 * Interleaved `[distance, 1 / distance]` samples from 5 m: 5% of the distance near the eye, half a
 * DEM pixel mid-field, 0.2% of the distance far away (the larger step wins past 1.3 km).
 */
export function makeRingSamples(maximumDistance: number, pixelSizeMeters: number): Float32Array {
  const samples: number[] = [];
  for (let distance = 5; distance <= maximumDistance; ) {
    // Round first so the reciprocal belongs to the stored f32 distance. The kernels multiply by
    // it because WGSL division is only accurate to 2.5 ULP.
    const stored = Math.fround(distance);
    samples.push(stored, 1 / stored);
    const nearStep = Math.min(Math.max(distance * 0.05, 1), pixelSizeMeters / 2);
    distance += Math.max(nearStep, distance * 0.002);
  }
  return Float32Array.from(samples);
}

export function makePeakRays(frame: Frame, peaks: Peak[]): Float32Array {
  const rays = new Float32Array(Math.max(peaks.length, 1) * 8);
  peaks.forEach((peak, index) => {
    // Ground-level ENU, like the terrain pixels the ray samples (the frame scales east/north by
    // 1 + h / R, which would put a 4 km summit 20 m off its own ray at 30 km).
    const [east, north] = frame.toEnu(peak.lat, peak.lon, 0);
    const distance = Math.hypot(east, north);
    const stored = Math.fround(distance);
    rays.set([east / distance, north / distance, stored, 1 / stored, peak.ele, 0, 0, 0], index * 8);
  });
  return rays;
}

/** Builds the shared inputs. `eyeHeight` is the lens altitude above sea level in metres. */
export function makeRingSetup(
  mosaic: Mosaic,
  frame: Frame,
  peaks: Peak[],
  k: number,
  eyeHeight: number,
  bins = RING_DEFAULT_BINS
): RingSetup {
  const f32 = Math.fround;
  const placement = getMosaicPlacement(mosaic, frame);
  const worldSize = MOSAIC_TILE_SIZE * 2 ** mosaic.zoom;
  const pixelsPerRadian = worldSize / (2 * Math.PI);
  const tanLat = frame.sinLat / frame.cosLat;
  const mercatorGrowth = tanLat / frame.meridionalRadius;
  // d2(sec)/dphi2 = sec (tan^2 + sec^2), per metre^2 of northing.
  const seriesSecond = (tanLat * tanLat + 1 + tanLat * tanLat) / frame.meridionalRadius ** 2;
  const samples = makeRingSamples(RING_MAXIMUM_DISTANCE, mosaic.metersPerPixel);
  // Terrarium pixel (i, j) describes the square [i, i + 1) x [j, j + 1): its height belongs at the
  // centre, so the bilinear lattice of height samples is offset by half a pixel.
  const eyeColumn = placement.eyeColumn - 0.5;
  const eyeRow = placement.eyeRow - 0.5;
  const eyeColumnIndex = Math.floor(eyeColumn);
  const eyeRowIndex = Math.floor(eyeRow);
  return {
    mosaicWidth: mosaic.width,
    mosaicHeight: mosaic.height,
    eyeColumnIndex,
    eyeRowIndex,
    eyeColumnFraction: f32(eyeColumn - eyeColumnIndex),
    eyeRowFraction: f32(eyeRow - eyeRowIndex),
    eyeAltitude: f32(eyeHeight),
    pixelsPerMeterEast: f32(pixelsPerRadian / (frame.primeVerticalRadius * frame.cosLat)),
    pixelsPerMeterNorth: f32(pixelsPerRadian / (frame.cosLat * frame.meridionalRadius)),
    mercatorGrowth: f32(mercatorGrowth),
    halfMercatorGrowth: f32(mercatorGrowth / 2),
    columnCurvature: f32(seriesSecond / 2),
    rowCubic: f32(seriesSecond / 6),
    parallelCurvature: f32(tanLat / (2 * frame.primeVerticalRadius)),
    curvature: f32((1 - k) / (2 * EARTH_R)),
    binCount: bins,
    azimuthDirections: makeAzimuthDirections(bins),
    samples,
    sampleCount: samples.length / 2,
    peakRays: makePeakRays(frame, peaks),
    peakCount: peaks.length,
    peakSkirt: f32(2 * mosaic.metersPerPixel)
  };
}

/**
 * One ray sample: the curvature-corrected tangent at `distance` along `direction`, or NaN once the
 * ray leaves the mosaic. Mirrors `sampleTangent` in ring-shaders.ts operation by operation.
 */
export function sampleRingTangent(
  heights: Float32Array,
  setup: RingSetup,
  sine: number,
  cosine: number,
  distance: number,
  inverseDistance: number
): number {
  const round = Math.fround;
  const north = round(cosine * distance);
  const east = round(sine * distance);
  const column = round(
    setup.eyeColumnFraction +
      round(
        round(east * setup.pixelsPerMeterEast) *
          round(
            1 + round(north * round(setup.mercatorGrowth + round(north * setup.columnCurvature)))
          )
      )
  );
  const northTerm = round(
    north *
      round(1 + round(north * round(setup.halfMercatorGrowth + round(north * setup.rowCubic))))
  );
  const eastTerm = round(round(east * east) * setup.parallelCurvature);
  const row = round(
    setup.eyeRowFraction - round(round(northTerm - eastTerm) * setup.pixelsPerMeterNorth)
  );
  const columnFloor = Math.floor(column);
  const rowFloor = Math.floor(row);
  const x = setup.eyeColumnIndex + columnFloor;
  const y = setup.eyeRowIndex + rowFloor;
  const width = setup.mosaicWidth;
  if (x < 0 || y < 0 || x >= width - 1 || y >= setup.mosaicHeight - 1) return Number.NaN;
  const fractionX = round(column - columnFloor);
  const fractionY = round(row - rowFloor);
  const index = y * width + x;
  // Heights relative to the eye: exact near the eye (Sterbenz), where an absolute-height rounding
  // error would be magnified by the short distance.
  const height00 = round(heights[index] - setup.eyeAltitude);
  const height10 = round(heights[index + 1] - setup.eyeAltitude);
  const height01 = round(heights[index + width] - setup.eyeAltitude);
  const height11 = round(heights[index + width + 1] - setup.eyeAltitude);
  const top = round(height00 + round(round(height10 - height00) * fractionX));
  const bottom = round(height01 + round(round(height11 - height01) * fractionX));
  const relativeHeight = round(top + round(round(bottom - top) * fractionY));
  return round(round(relativeHeight * inverseDistance) - round(distance * setup.curvature));
}

/** The skyline march: largest tangent per azimuth bin, in f32 operation order. */
export function marchRingCpu(
  heights: Float32Array,
  setup: RingSetup
): {tangents: Float32Array; distances: Float32Array} {
  const tangents = new Float32Array(setup.binCount);
  const distances = new Float32Array(setup.binCount);
  for (let bin = 0; bin < setup.binCount; bin++) {
    const sine = setup.azimuthDirections[2 * bin];
    const cosine = setup.azimuthDirections[2 * bin + 1];
    let bestTangent = Math.fround(-1e30);
    let bestDistance = 0;
    for (let index = 0; index < setup.sampleCount; index++) {
      const distance = setup.samples[2 * index];
      const tangent = sampleRingTangent(
        heights,
        setup,
        sine,
        cosine,
        distance,
        setup.samples[2 * index + 1]
      );
      if (Number.isNaN(tangent)) break;
      if (tangent > bestTangent) {
        bestTangent = tangent;
        bestDistance = distance;
      }
    }
    tangents[bin] = bestTangent;
    distances[bin] = bestDistance;
  }
  return {tangents, distances};
}

/** Peak visibility kernel twin. Four floats per peak, see `RingPeakRaw`. */
export function marchPeaksCpu(heights: Float32Array, setup: RingSetup): RingPeakRaw {
  const round = Math.fround;
  const raw = new Float32Array(Math.max(setup.peakCount, 1) * 4);
  const lastDistance = setup.samples[setup.samples.length - 2];
  for (let peak = 0; peak < setup.peakCount; peak++) {
    const [sine, cosine, distance, inverseDistance, elevation] = setup.peakRays.subarray(
      peak * 8,
      peak * 8 + 5
    );
    const peakTangent = round(
      round(round(elevation - setup.eyeAltitude) * inverseDistance) -
        round(distance * setup.curvature)
    );
    const limit = round(distance - setup.peakSkirt);
    let blocker = round(-1e30);
    let blockerDistance = 0;
    let leftMosaic = false;
    for (let index = 0; index < setup.sampleCount; index++) {
      const sampleDistance = setup.samples[2 * index];
      if (sampleDistance >= limit) break;
      const tangent = sampleRingTangent(
        heights,
        setup,
        sine,
        cosine,
        sampleDistance,
        setup.samples[2 * index + 1]
      );
      if (Number.isNaN(tangent)) {
        // The line of sight ran off the DEM before reaching the peak: it was never fully tested.
        leftMosaic = true;
        break;
      }
      if (tangent > blocker) {
        blocker = tangent;
        blockerDistance = sampleDistance;
      }
    }
    const outOfRange = leftMosaic || distance > lastDistance ? 1 : 0;
    raw.set([peakTangent, blocker, outOfRange, blockerDistance], peak * 4);
  }
  return raw;
}

const toDegrees = (tangent: number) => (Math.atan(tangent) * 180) / Math.PI;

/** Turns kernel outputs into the public `RingResult`. Shared by the GPU readback and the twin. */
export function makeRingResult(
  tangents: Float32Array,
  peakRaw: RingPeakRaw,
  peakCount: number
): RingResult {
  const elevationDeg = new Float32Array(tangents.length);
  for (let bin = 0; bin < tangents.length; bin++) elevationDeg[bin] = toDegrees(tangents[bin]);
  const peakVisible = new Uint32Array(peakCount);
  const peakMarginDeg = new Float32Array(peakCount);
  for (let peak = 0; peak < peakCount; peak++) {
    if (peakRaw[4 * peak + 2] !== 0) {
      peakMarginDeg[peak] = RING_OUT_OF_RANGE_MARGIN_DEG;
      continue;
    }
    const margin = toDegrees(peakRaw[4 * peak]) - toDegrees(peakRaw[4 * peak + 1]);
    peakMarginDeg[peak] = margin;
    // A rounded summit sits behind its own shoulder by a fraction of a degree, and OSM heights
    // differ from the DEM by metres: "clears" means within the tolerance below the horizon.
    peakVisible[peak] = margin >= -RING_PEAK_TOLERANCE_DEG ? 1 : 0;
  }
  return {tangents, elevationDeg, peakVisible, peakMarginDeg, bins: tangents.length};
}

/** Skyline ring and peak visibility in f32 operation order: the twin of `RingGraph.run`. */
export function computeRingCpu(
  mosaic: Mosaic,
  frame: Frame,
  peaks: Peak[],
  k: number,
  eyeHeight: number,
  bins = RING_DEFAULT_BINS
): RingResult {
  const setup = makeRingSetup(mosaic, frame, peaks, k, eyeHeight, bins);
  const {tangents} = marchRingCpu(mosaic.heights, setup);
  return makeRingResult(tangents, marchPeaksCpu(mosaic.heights, setup), peaks.length);
}
