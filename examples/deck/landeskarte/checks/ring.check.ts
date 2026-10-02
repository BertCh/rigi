// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Pure CPU checks for compute/ring-cpu.ts on a synthetic mosaic (no network, no GPU). The f32
// twin is compared with an independent f64 brute-force march that maps every sample through the
// frame (`toGeo`) and Web Mercator instead of the kernel's local expansion.
// Run: npx tsx checks/ring.check.ts

import assert from 'node:assert/strict';
import {EARTH_R, makeFrame} from '../geo/geodesy';
import {getMosaicPlacement, getWorldPixel, makeMosaic, MOSAIC_TILE_SIZE} from '../compute/mosaic';
import {
  computeRingCpu,
  makePeakRays,
  makeRingSetup,
  RING_DEFAULT_BINS,
  RING_OUT_OF_RANGE_MARGIN_DEG,
  RING_PEAK_TOLERANCE_DEG,
  type RingSetup
} from '../compute/ring-cpu';
import type {Frame, Mosaic, Peak, RingResult} from '../types';

const ZOOM = 11;
const RADIUS_TILES = 3;
const WIDTH = (2 * RADIUS_TILES + 1) * MOSAIC_TILE_SIZE;
const K = 0.13;
const TOLERANCE_DEG = 1e-3;

function pass(name: string, detail: string): void {
  console.log(`PASS ${name}: ${detail}`);
}

/** Terrarium encoding of metres, quantised to 1/256 m like the real tiles. */
function encodeTerrarium(metres: number): number {
  const value = Math.round((metres + 32768) * 256);
  const red = Math.min(255, Math.floor(value / 65536));
  const green = Math.floor(value / 256) % 256;
  const blue = value % 256;
  return (red | (green << 8) | (blue << 16) | (255 << 24)) >>> 0;
}

type Bump = {lat: number; lon: number; height: number; sigmaMeters: number};

/** Rolling base plus Gaussian hills. Returns the mosaic and the DEM height under each bump. */
function makeSyntheticMosaic(frame: Frame, bumps: Bump[], base: (c: number, r: number) => number) {
  const probe = makeMosaic(frame, ZOOM, WIDTH, new Uint32Array(WIDTH * WIDTH));
  const placement = getMosaicPlacement(probe, frame);
  const pixelMeters = probe.metersPerPixel;
  const centres = bumps.map(bump => {
    const [column, row] = getWorldPixel(bump.lat, bump.lon, ZOOM);
    return {
      column: column - placement.originColumn - 0.5,
      row: row - placement.originRow - 0.5,
      height: bump.height,
      sigma: bump.sigmaMeters / pixelMeters
    };
  });
  const pixels = new Uint32Array(WIDTH * WIDTH);
  for (let row = 0; row < WIDTH; row++) {
    for (let column = 0; column < WIDTH; column++) {
      let metres = base(column, row);
      for (const bump of centres) {
        const d2 = (column - bump.column) ** 2 + (row - bump.row) ** 2;
        if (d2 < 16 * bump.sigma ** 2)
          metres += bump.height * Math.exp(-d2 / (2 * bump.sigma ** 2));
      }
      pixels[row * WIDTH + column] = encodeTerrarium(metres);
    }
  }
  return {mosaic: makeMosaic(frame, ZOOM, WIDTH, pixels), centres};
}

/** Bilinear height at a fractional lattice position (pixel centres at integers), or null outside. */
function bilinear(mosaic: Mosaic, column: number, row: number): number | null {
  const x = Math.floor(column);
  const y = Math.floor(row);
  if (x < 0 || y < 0 || x >= mosaic.width - 1 || y >= mosaic.height - 1) return null;
  const fx = column - x;
  const fy = row - y;
  const h = mosaic.heights;
  const i = y * mosaic.width + x;
  const top = h[i] + (h[i + 1] - h[i]) * fx;
  const bottom = h[i + mosaic.width] + (h[i + mosaic.width + 1] - h[i + mosaic.width]) * fx;
  return top + (bottom - top) * fy;
}

/** Maps ENU metres from the eye to a lattice position in the mosaic (pixel centres at integers). */
type PlaneMapping = (east: number, north: number) => [column: number, row: number];

/** Independent mapping: frame.toGeo (ground at sea-level scale, as the kernels sample it) to Web Mercator. */
function makeExactMapping(mosaic: Mosaic, frame: Frame): PlaneMapping {
  const placement = getMosaicPlacement(mosaic, frame);
  return (east, north) => {
    const geo = frame.toGeo([east, north, -frame.origin.h]);
    const [column, row] = getWorldPixel(geo.lat, geo.lon, mosaic.zoom);
    return [column - placement.originColumn - 0.5, row - placement.originRow - 0.5];
  };
}

/** The kernel's local expansion in f64: isolates f32 rounding from the expansion's truncation. */
function makeExpansionMapping(setup: RingSetup): PlaneMapping {
  return (east, north) => [
    setup.eyeColumnIndex +
      setup.eyeColumnFraction +
      east *
        setup.pixelsPerMeterEast *
        (1 + north * (setup.mercatorGrowth + north * setup.columnCurvature)),
    setup.eyeRowIndex +
      setup.eyeRowFraction -
      (north * (1 + north * (setup.halfMercatorGrowth + north * setup.rowCubic)) -
        east * east * setup.parallelCurvature) *
        setup.pixelsPerMeterNorth
  ];
}

const toDegrees = (tangent: number) => (Math.atan(tangent) * 180) / Math.PI;

/** Brute-force skyline and peak margins in f64 with exact division, for a given plane mapping. */
function bruteRing(
  mosaic: Mosaic,
  frame: Frame,
  peaks: Peak[],
  k: number,
  eyeHeight: number,
  mapping: PlaneMapping
) {
  const setup = makeRingSetup(mosaic, frame, peaks, k, eyeHeight);
  const curvature = (1 - k) / (2 * EARTH_R);
  const march = (east: number, north: number, distance: number): number | null => {
    const [column, row] = mapping(east, north);
    const height = bilinear(mosaic, column, row);
    return height === null ? null : (height - eyeHeight) / distance - distance * curvature;
  };
  const bins = new Float64Array(RING_DEFAULT_BINS);
  for (let bin = 0; bin < RING_DEFAULT_BINS; bin++) {
    const azimuth = (bin / RING_DEFAULT_BINS) * 2 * Math.PI;
    let best = -1e30;
    for (let i = 0; i < setup.sampleCount; i++) {
      const d = setup.samples[2 * i];
      const t = march(Math.sin(azimuth) * d, Math.cos(azimuth) * d, d);
      if (t === null) break;
      best = Math.max(best, t);
    }
    bins[bin] = best;
  }
  const peakMargins = peaks.map(peak => {
    const [east, north] = frame.toEnu(peak.lat, peak.lon, 0);
    const distance = Math.hypot(east, north);
    const limit = distance - setup.peakSkirt;
    let blocker = -1e30;
    for (let i = 0; i < setup.sampleCount; i++) {
      const d = setup.samples[2 * i];
      if (d >= limit) break;
      const t = march((east / distance) * d, (north / distance) * d, d);
      if (t === null) break;
      blocker = Math.max(blocker, t);
    }
    const peakTangent = (peak.ele - eyeHeight) / distance - distance * curvature;
    return toDegrees(peakTangent) - toDegrees(blocker);
  });
  return {bins, peakMargins};
}

function maxBinDelta(result: RingResult, bins: Float64Array): {worst: number; over: number} {
  let worst = 0;
  let over = 0;
  for (let bin = 0; bin < result.bins; bin++) {
    const delta = Math.abs(result.elevationDeg[bin] - toDegrees(bins[bin]));
    worst = Math.max(worst, delta);
    if (!(delta <= TOLERANCE_DEG)) over++;
  }
  return {worst, over};
}

// Scene: the Niederhorn summit, a rolling landscape, and named bumps placed by bearing.
const SUMMIT = {lat: 46.710169, lon: 7.773319, h: 1919};
const frame = makeFrame(SUMMIT.lat, SUMMIT.lon, SUMMIT.h);
const destination = (bearingDeg: number, meters: number): {lat: number; lon: number} => {
  const b = (bearingDeg * Math.PI) / 180;
  const geo = frame.toGeo([Math.sin(b) * meters, Math.cos(b) * meters, 0]);
  return {lat: geo.lat, lon: geo.lon};
};
const bumps: Bump[] = [
  {...SUMMIT, height: 1250, sigmaMeters: 1800},
  {...destination(70, 8_000), height: 2300, sigmaMeters: 900},
  {...destination(70, 24_000), height: 1900, sigmaMeters: 1900},
  {...destination(120, 27_000), height: 2800, sigmaMeters: 1700},
  {...destination(250, 15_000), height: 1400, sigmaMeters: 2500},
  {...destination(320, 38_000), height: 3300, sigmaMeters: 2200}
];
const rolling = (column: number, row: number) =>
  650 + 220 * Math.sin(column / 83) * Math.cos(row / 121) + 90 * Math.sin((column + row) / 29);
const {mosaic, centres} = makeSyntheticMosaic(frame, bumps, rolling);
const groundHeight = bilinear(
  mosaic,
  getWorldPixel(SUMMIT.lat, SUMMIT.lon, ZOOM)[0] -
    getMosaicPlacement(mosaic, frame).originColumn -
    0.5,
  getWorldPixel(SUMMIT.lat, SUMMIT.lon, ZOOM)[1] - getMosaicPlacement(mosaic, frame).originRow - 0.5
)!;
const eyeHeight = Math.max(SUMMIT.h, groundHeight + 1.6);

const demAt = (c: {column: number; row: number}) => bilinear(mosaic, c.column, c.row)!;
const peaks: Peak[] = [
  {
    id: 'hidden',
    name: 'Hidden behind ridge',
    ...destination(70, 24_000),
    ele: demAt(centres[2]),
    tier: 'peak'
  },
  {
    id: 'tall',
    name: 'Tall far peak',
    ...destination(120, 27_000),
    ele: demAt(centres[3]),
    tier: 'peak-major'
  },
  {id: 'near', name: 'Near ridge', ...destination(70, 8_000), ele: demAt(centres[1]), tier: 'peak'},
  {id: 'far', name: 'Beyond 45 km', ...destination(10, 46_000), ele: 4000, tier: 'peak-major'}
].map(peak => peak as Peak);

// 1. f32 twin versus f64 brute force on the kernel's own plane mapping: pure rounding error.
const result = computeRingCpu(mosaic, frame, peaks, K, eyeHeight);
const setup = makeRingSetup(mosaic, frame, peaks, K, eyeHeight);
const bruteSame = bruteRing(mosaic, frame, peaks, K, eyeHeight, makeExpansionMapping(setup));
{
  assert.equal(result.bins, RING_DEFAULT_BINS);
  const {worst, over} = maxBinDelta(result, bruteSame.bins);
  assert.equal(over, 0, `${over} bins over ${TOLERANCE_DEG} deg, worst ${worst}`);
  let worstMargin = 0;
  for (let i = 0; i < 3; i++) {
    worstMargin = Math.max(
      worstMargin,
      Math.abs(result.peakMarginDeg[i] - bruteSame.peakMargins[i])
    );
  }
  assert.ok(worstMargin <= TOLERANCE_DEG, `peak margin error ${worstMargin}`);
  pass(
    'f32 twin vs f64 march',
    `${result.bins} bins, max |delta| = ${worst.toExponential(2)} deg, peak margins ${worstMargin.toExponential(2)} deg (tolerance ${TOLERANCE_DEG})`
  );
}

// 2. Same march with every sample placed through frame.toGeo and Web Mercator: this also measures
//    the kernel's local (third-order) expansion of that mapping, which must stay inside the contract.
{
  const exact = bruteRing(mosaic, frame, peaks, K, eyeHeight, makeExactMapping(mosaic, frame));
  const {worst} = maxBinDelta(result, exact.bins);
  assert.ok(worst <= TOLERANCE_DEG, `exact mapping: worst ${worst}`);
  pass(
    'twin vs exact Mercator mapping',
    `max |delta| = ${worst.toExponential(2)} deg (tolerance ${TOLERANCE_DEG})`
  );
}

// 2b. Peak visibility: constructed answers.
{
  assert.deepEqual(Array.from(result.peakVisible), [0, 1, 1, 0]);
  assert.equal(result.peakMarginDeg[3], RING_OUT_OF_RANGE_MARGIN_DEG);
  assert.ok(result.peakMarginDeg[0] < -RING_PEAK_TOLERANCE_DEG);
  assert.ok(result.peakMarginDeg[1] >= -RING_PEAK_TOLERANCE_DEG);
  pass(
    'peak visibility',
    `visible = [${Array.from(result.peakVisible)}] (hidden, tall, near, beyond 45 km), margins = [${Array.from(result.peakMarginDeg, m => m.toFixed(3))}] deg`
  );
}

// 3. Curvature and refraction: over a flat plain the skyline dip is -2 sqrt(h (1-k) / 2R) at the
//    distance sqrt(2 R h / (1-k)).
{
  const flatFrame = makeFrame(SUMMIT.lat, SUMMIT.lon, 100);
  const plain = makeMosaic(
    flatFrame,
    ZOOM,
    WIDTH,
    new Uint32Array(WIDTH * WIDTH).fill(encodeTerrarium(0))
  );
  for (const k of [0, K]) {
    const ring = computeRingCpu(plain, flatFrame, [], k, 100);
    const curvature = (1 - k) / (2 * EARTH_R);
    const expected = toDegrees(-2 * Math.sqrt(100 * curvature));
    let worst = 0;
    for (const value of ring.elevationDeg) worst = Math.max(worst, Math.abs(value - expected));
    assert.ok(worst < 2e-4, `flat plain k=${k}: ${worst}`);
    pass(
      'flat plain dip',
      `k = ${k}: ${ring.elevationDeg[0].toFixed(4)} deg, analytic ${expected.toFixed(4)}, max |delta| ${worst.toExponential(2)} deg`
    );
  }
}

// 4. Eye geometry: the summit bump puts the eye over a DEM that is not the 1919 m fix.
{
  assert.ok(Math.abs(groundHeight - 1919) < 1500);
  const rays = makePeakRays(frame, peaks);
  assert.ok(Math.abs(Math.hypot(rays[0], rays[1]) - 1) < 1e-6);
  pass(
    'setup',
    `eye ${eyeHeight.toFixed(1)} m over ground ${groundHeight.toFixed(1)} m; peak rays are unit vectors`
  );
}

console.log('ring.check: all passed');
