// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// CPU-only check of the shadow twins on a synthetic mosaic: the horizon-map twin against a direct
// double-precision march, shade monotonic in sun elevation, ambient in [0, 1], quantise round trip.

import assert from 'node:assert/strict';
import {
  ambientCpu,
  ANGLE_RANGE,
  ANGLE_STEP,
  computeHorizonMapCpu,
  dequantizeAngle,
  HORIZON_MAP_AZIMUTHS,
  HORIZON_MAP_SAMPLES,
  makeShadowWindow,
  quantizeAngle,
  shadeAtTimeCpu
} from '../compute/cpu-twins';
import {compareParity, marchCellF64} from '../compute/parity';
import type {Mosaic} from '../types';

const SIZE = 640;
const MPP = 26;

// Smooth hills, a sharp ridge and a pit, so horizons are non-trivial in every direction.
function makeSyntheticMosaic(): Mosaic {
  const heights = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = x - SIZE / 2;
      const dy = y - SIZE / 2;
      const hills = 400 * Math.sin(x / 41) * Math.cos(y / 53) + 250 * Math.sin((x + y) / 97);
      const peak = 900 * Math.exp(-((dx - 60) ** 2 + (dy + 40) ** 2) / 2500);
      const ridge = x > 400 && x < 410 ? 500 : 0;
      const pit = -300 * Math.exp(-(dx ** 2 + dy ** 2) / 400);
      heights[y * SIZE + x] = 1500 + hills + peak + ridge + pit;
    }
  }
  return {
    zoom: 11,
    width: SIZE,
    height: SIZE,
    pixels: new Uint32Array(0),
    heights,
    metersPerPixel: MPP,
    originEnu: [(-SIZE * MPP) / 2, (SIZE * MPP) / 2]
  };
}

const mosaic = makeSyntheticMosaic();
const azimuths = HORIZON_MAP_AZIMUTHS;
const samples = HORIZON_MAP_SAMPLES;

// 1. Quantise round trip.
{
  let worst = 0;
  for (let i = 0; i <= 2000; i++) {
    const angle = -0.25 + (ANGLE_RANGE * i) / 2000;
    const back = dequantizeAngle(quantizeAngle(angle));
    worst = Math.max(worst, Math.abs(back - angle));
  }
  assert.ok(worst <= ANGLE_STEP / 2 + 1e-12, `round trip ${worst}`);
  assert.equal(quantizeAngle(-1), 0);
  assert.equal(quantizeAngle(2), 65535);
  for (const value of [0, 1, 12345, 65534, 65535]) {
    assert.equal(quantizeAngle(dequantizeAngle(value)), value);
  }
  console.log(
    `PASS quantise round trip: worst ${worst.toExponential(2)} rad (step ${ANGLE_STEP.toExponential(2)})`
  );
}

// 2. Horizon-map twin versus the direct f64 march, 64 x 64 window (stride 4 = 256 pixels wide).
const window = makeShadowWindow(mosaic, 64, 4);
assert.ok(window.column > 0 && window.row > 0, 'window inside mosaic');
const start = Date.now();
const map = computeHorizonMapCpu(mosaic, window, azimuths, samples);
const twinMs = Date.now() - start;
{
  const tolerance = ANGLE_STEP + 1e-4;
  let worst = 0;
  let count = 0;
  for (let row = 0; row < window.size; row++) {
    for (let col = 0; col < window.size; col++) {
      for (let a = 0; a < azimuths; a++) {
        const reference = marchCellF64(
          mosaic,
          window,
          col,
          row,
          (a * 2 * Math.PI) / azimuths,
          samples
        );
        const clamped = Math.min(Math.max(reference, -0.25), Math.PI / 2);
        const diff = Math.abs(
          dequantizeAngle(map[(row * window.size + col) * azimuths + a]) - clamped
        );
        worst = Math.max(worst, diff);
        assert.ok(diff <= tolerance, `cell ${col},${row} az ${a}: ${diff} > ${tolerance}`);
        count++;
      }
    }
  }
  console.log(
    `PASS horizon map twin vs f64 march: ${count} angles, max ${worst.toExponential(2)} rad ` +
      `(tolerance ${tolerance.toExponential(2)}), twin ${twinMs} ms`
  );
  const report = compareParity({
    horizonGpu: map,
    horizonCpu: map,
    toleranceDeg: 0.005,
    cpuMs: twinMs,
    gpuMs: 0
  });
  assert.equal(report.bitIdentical, report.total);
  assert.equal(report.overTolerance, 0);
  console.log(
    `PASS compareParity on identical maps: ${report.bitIdentical}/${report.total} identical`
  );
}

// 3. Shade is monotonic in sun elevation, bounded, and dark at night.
{
  let checked = 0;
  for (const azimuth of [0, 33, 90, 180, 222.14, 269.16, 359]) {
    let previous: Uint8Array | null = null;
    for (let elevation = -3; elevation <= 60; elevation += 0.25) {
      const shade = shadeAtTimeCpu(map, window, azimuths, azimuth, elevation);
      if (elevation <= -1)
        assert.ok(
          shade.every(value => value === 0),
          'night is dark'
        );
      if (previous) {
        for (let cell = 0; cell < shade.length; cell++) {
          assert.ok(shade[cell] >= previous[cell], `az ${azimuth} el ${elevation} cell ${cell}`);
        }
      }
      previous = shade;
      checked++;
    }
    assert.ok(
      previous?.some(value => value === 255),
      'high sun lights some cells'
    );
  }
  const low = shadeAtTimeCpu(map, window, azimuths, 222, 2);
  const high = shadeAtTimeCpu(map, window, azimuths, 222, 40);
  const litFraction = (data: Uint8Array) =>
    data.reduce((sum, value) => sum + value, 0) / (255 * data.length);
  assert.ok(litFraction(low) < litFraction(high), 'more light at higher sun');
  console.log(
    `PASS shade monotonic: ${checked} sun positions, lit ${litFraction(low).toFixed(3)} at 2 deg, ` +
      `${litFraction(high).toFixed(3)} at 40 deg`
  );
}

// 4. Ambient in [0, 1]: a flat plain sees the whole sky, a pit sees less.
{
  const ambient = ambientCpu(map, window, azimuths);
  let minimum = 1;
  let maximum = 0;
  for (const value of ambient) {
    const unit = value / 255;
    assert.ok(unit >= 0 && unit <= 1);
    minimum = Math.min(minimum, unit);
    maximum = Math.max(maximum, unit);
  }
  const flat = makeSyntheticMosaic();
  flat.heights.fill(1000);
  const flatMap = computeHorizonMapCpu(flat, makeShadowWindow(flat, 8, 4), azimuths, samples);
  const flatAmbient = ambientCpu(flatMap, makeShadowWindow(flat, 8, 4), azimuths);
  assert.ok(
    flatAmbient.every(value => value >= 253),
    'flat ground sees the sky'
  );
  assert.ok(minimum < maximum, 'relief changes the sky-view factor');
  console.log(
    `PASS ambient in [0,1]: relief ${minimum.toFixed(3)}..${maximum.toFixed(3)}, flat ${Math.min(...flatAmbient) / 255}`
  );
}

// 5. Orientation, independent of the f64 reference: a 600 m wall on the north side (row 0 = north)
// raises the horizon at azimuth 0 only, and a wall on the east raises it at azimuth 90 only.
{
  const wallMosaic = makeSyntheticMosaic();
  const wallRow = 200;
  const wallColumn = 440;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const northWall = y < wallRow;
      const eastWall = x > wallColumn && y >= wallRow;
      wallMosaic.heights[y * SIZE + x] = 1000 + (northWall || eastWall ? 600 : 0);
    }
  }
  const wallWindow = makeShadowWindow(wallMosaic, 8, 4);
  const wallMap = computeHorizonMapCpu(wallMosaic, wallWindow, azimuths, samples);
  // Window centre: pixel 320, so 120 px (3.1 km) south of the northern wall, 120 px west of the eastern one.
  const cell = 4 * wallWindow.size + 4;
  const angleDeg = (a: number) => (dequantizeAngle(wallMap[cell * azimuths + a]) * 180) / Math.PI;
  const north = angleDeg(0);
  const east = angleDeg(4);
  const south = angleDeg(8);
  const west = angleDeg(12);
  assert.ok(north > 10 && east > 10, `walls raise the horizon: north ${north}, east ${east}`);
  assert.ok(south < 1 && west < 1, `open sides stay low: south ${south}, west ${west}`);
  console.log(
    `PASS orientation: horizon N ${north.toFixed(1)} E ${east.toFixed(1)} S ${south.toFixed(1)} ` +
      `W ${west.toFixed(1)} deg`
  );
}
