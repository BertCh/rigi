// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// CPU twin of the GPU graph in `horizon-graph.ts`. Every arithmetic step that the WGSL performs in
// f32 is rounded with `Math.fround` in the same order (an f64 operation on f32 inputs rounded once
// to f32 is the correctly rounded f32 result). The GPU may still fuse multiply-adds under fast math,
// so the two agree to a few f32 ULP rather than bit for bit. See README "Verification".

/** Standard terrestrial refraction coefficient. */
export const REFRACTION_COEFFICIENT = 0.13;
/** Bins whose GPU and CPU elevation angles differ by more than this count as mismatched. */
export const MISMATCH_TOLERANCE_DEGREES = 1e-3;

/** Inputs shared bit-for-bit by the GPU graph and the CPU twin. All scalars are f32 values. */
export type HorizonSetup = {
  mosaicWidth: number;
  mosaicHeight: number;
  /** Integer mosaic pixel containing the eye. */
  eyeColumnIndex: number;
  eyeRowIndex: number;
  /** Eye position within that pixel, in [0, 1). */
  eyeColumnFraction: number;
  eyeRowFraction: number;
  /** Eye altitude in metres above sea level. */
  eyeAltitude: number;
  /** Mercator pixels per ground metre at the eye. */
  pixelsPerMeter: number;
  /** tan(latitude) / R: growth of the Mercator scale per metre northwards. */
  mercatorGrowth: number;
  /** Half of `mercatorGrowth`, the second-order term of the northward pixel offset. */
  halfMercatorGrowth: number;
  /** (1 - k) / 2R: earth curvature reduced by refraction, per metre of distance. */
  curvature: number;
  binCount: number;
  /** Interleaved `[sin(azimuth), cos(azimuth)]` per bin. */
  azimuthDirections: Float32Array;
  /** Interleaved `[distance, 1 / distance]` ray-march samples in metres, shared by every azimuth. */
  samples: Float32Array;
  /** Number of samples used (those within the maximum distance). */
  sampleCount: number;
};

/** One horizon profile: max tangent of the elevation angle and its distance, per azimuth bin. */
export type HorizonProfile = {
  tangents: Float32Array;
  distances: Float32Array;
};

export type HorizonComparison = {
  maxAbsDeltaDegrees: number;
  /** Largest distance between GPU and CPU tangents in f32 units in the last place. */
  maxTangentUlps: number;
  mismatchedBins: number;
  identicalBins: number;
};

/** Returns `[sin, cos]` pairs for `binCount` azimuths clockwise from north, bin 0 = north. */
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
 * Returns interleaved `[distance, 1 / distance]` samples with steps of 5% of the distance near the
 * eye, half a DEM pixel in the middle field and 0.2% of the distance far away.
 */
export function makeSamples(maximumDistance: number, pixelSizeMeters: number): Float32Array {
  const samples: number[] = [];
  for (let distance = 5; distance <= maximumDistance; ) {
    // Round first so that the reciprocal belongs to the stored f32 distance.
    const roundedDistance = Math.fround(distance);
    samples.push(roundedDistance, 1 / roundedDistance);
    const nearStep = Math.min(Math.max(distance * 0.05, 1), pixelSizeMeters / 2);
    distance += Math.max(nearStep, distance * 0.002);
  }
  return Float32Array.from(samples);
}

/** Returns how many of the increasing samples lie within `maximumDistance`. */
export function getSampleCount(samples: Float32Array, maximumDistance: number): number {
  let count = 0;
  while (2 * count < samples.length && samples[2 * count] <= maximumDistance) count++;
  return count;
}

/** Decodes Terrarium pixels to metres: `r * 256 + g + b / 256 - 32768` (exact in f32). */
export function decodeTerrariumHeights(pixels: Uint32Array): Float32Array {
  const heights = new Float32Array(pixels.length);
  for (let index = 0; index < pixels.length; index++) {
    const packed = pixels[index];
    const red = packed & 255;
    const green = (packed >>> 8) & 255;
    const blue = (packed >>> 16) & 255;
    heights[index] = red * 256 + green + blue / 256 - 32768;
  }
  return heights;
}

/** Bilinear height in f64, used only to place the eye above the ground. */
export function getHeightAt(
  heights: Float32Array,
  width: number,
  column: number,
  row: number
): number {
  const x = Math.floor(column);
  const y = Math.floor(row);
  const fractionX = column - x;
  const fractionY = row - y;
  const index = y * width + x;
  const top = heights[index] + (heights[index + 1] - heights[index]) * fractionX;
  const bottom =
    heights[index + width] + (heights[index + width + 1] - heights[index + width]) * fractionX;
  return top + (bottom - top) * fractionY;
}

/** The horizon ray march of `HORIZON_MARCH_WGSL`, one azimuth at a time, in f32 arithmetic. */
export function computeHorizonOnCPU(heights: Float32Array, setup: HorizonSetup): HorizonProfile {
  const round = Math.fround;
  const {mosaicWidth: width, mosaicHeight: height, azimuthDirections, samples} = setup;
  const tangents = new Float32Array(setup.binCount);
  const distances = new Float32Array(setup.binCount);
  const one = 1;
  for (let bin = 0; bin < setup.binCount; bin++) {
    const sine = azimuthDirections[2 * bin];
    const cosine = azimuthDirections[2 * bin + 1];
    let bestTangent = round(-1e30);
    let bestDistance = 0;
    for (let sampleIndex = 0; sampleIndex < setup.sampleCount; sampleIndex++) {
      const distance = samples[2 * sampleIndex];
      const inverseDistance = samples[2 * sampleIndex + 1];
      const north = round(cosine * distance);
      const east = round(sine * distance);
      const column = round(
        setup.eyeColumnFraction +
          round(
            round(east * setup.pixelsPerMeter) * round(one + round(north * setup.mercatorGrowth))
          )
      );
      const row = round(
        setup.eyeRowFraction -
          round(
            round(north * setup.pixelsPerMeter) *
              round(one + round(north * setup.halfMercatorGrowth))
          )
      );
      const columnFloor = Math.floor(column);
      const rowFloor = Math.floor(row);
      const x = setup.eyeColumnIndex + columnFloor;
      const y = setup.eyeRowIndex + rowFloor;
      if (x < 0 || y < 0 || x >= width - 1 || y >= height - 1) {
        break;
      }
      const fractionX = round(column - columnFloor);
      const fractionY = round(row - rowFloor);
      const index = y * width + x;
      const height00 = round(heights[index] - setup.eyeAltitude);
      const height10 = round(heights[index + 1] - setup.eyeAltitude);
      const height01 = round(heights[index + width] - setup.eyeAltitude);
      const height11 = round(heights[index + width + 1] - setup.eyeAltitude);
      const top = round(height00 + round(round(height10 - height00) * fractionX));
      const bottom = round(height01 + round(round(height11 - height01) * fractionX));
      const relativeHeight = round(top + round(round(bottom - top) * fractionY));
      const tangent = round(
        round(relativeHeight * inverseDistance) - round(distance * setup.curvature)
      );
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

/** Compares two profiles by elevation angle in degrees. */
export function compareHorizons(
  gpuProfile: HorizonProfile,
  cpuProfile: HorizonProfile
): HorizonComparison {
  let maxAbsDeltaDegrees = 0;
  let maxTangentUlps = 0;
  let mismatchedBins = 0;
  let identicalBins = 0;
  for (let bin = 0; bin < gpuProfile.tangents.length; bin++) {
    const gpuTangent = gpuProfile.tangents[bin];
    const cpuTangent = cpuProfile.tangents[bin];
    if (gpuTangent === cpuTangent) identicalBins++;
    maxTangentUlps = Math.max(maxTangentUlps, getUlpDistance(gpuTangent, cpuTangent));
    const delta = Math.abs(getElevationDegrees(gpuTangent) - getElevationDegrees(cpuTangent));
    maxAbsDeltaDegrees = Math.max(maxAbsDeltaDegrees, delta);
    if (!(delta <= MISMATCH_TOLERANCE_DEGREES)) mismatchedBins++;
  }
  return {maxAbsDeltaDegrees, maxTangentUlps, mismatchedBins, identicalBins};
}

/** Number of representable f32 values between two f32 numbers. */
function getUlpDistance(first: number, second: number): number {
  const integers = new Int32Array(new Float32Array([first, second]).buffer);
  // Map the sign-magnitude bit patterns onto one monotonic integer line.
  const toOrdered = (bits: number) => (bits < 0 ? -2147483648 - bits : bits);
  return Math.abs(toOrdered(integers[0]) - toOrdered(integers[1]));
}

/** Converts a curvature-corrected tangent to an elevation angle in degrees. */
export function getElevationDegrees(tangent: number): number {
  return (Math.atan(tangent) * 180) / Math.PI;
}
