// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// CPU twins of the shadow graph (WebGL2 has no compute): the horizon map, the shade-at-time lookup
// and the sky-view ambient, plus `createCpuShadowSource`, which fills the same `ShadowField` the
// WebGPU graph does. The horizon map is built once in a worker; shading a sun position is a cheap
// lookup done on the main thread.
//
// The arithmetic uses Math.fround in the order of the GPU kernel so the twin and the graph agree to
// within the u16 quantisation step. That is a tolerance, not a claim of bit-identical floats.

import type {Device, Texture} from '@luma.gl/core';
import {Texture as LumaTexture} from '@luma.gl/core';
import type {Mosaic, NodeRow, ShadowField, ShadowSource, ShadowWindow, SunSample} from '../types';
import {
  computeHorizonMapCpu,
  computeHorizonRowsCpu,
  horizonDistances,
  type TerrainHeights
} from './horizon-cpu';
import {
  ANGLE_MIN,
  ANGLE_SPAN,
  azimuthBlend,
  dequantizeAngle,
  HORIZON_MAP_AZIMUTHS,
  HORIZON_MAP_SAMPLES,
  HORIZON_MAX_DISTANCE,
  HORIZON_MIN_DISTANCE,
  makeShadowWindow,
  PENUMBRA_RAD,
  quantizeAngle,
  SUN_FLOOR_RAD
} from './shadow-shaders';

// One source of truth: the constants and the quantiser live in shadow-shaders.ts (pure, no luma),
// which the graph also uses, so the twin cannot drift from the kernels.
export {
  ANGLE_MIN,
  dequantizeAngle,
  HORIZON_MAP_AZIMUTHS,
  HORIZON_MAP_SAMPLES,
  HORIZON_MAX_DISTANCE,
  HORIZON_MIN_DISTANCE,
  makeShadowWindow,
  PENUMBRA_RAD,
  quantizeAngle
};
/** u16 angles cover [ANGLE_MIN, pi/2] radians. */
export const ANGLE_RANGE = ANGLE_SPAN;
/** One quantisation step, radians (about 2.8e-5). */
export const ANGLE_STEP = ANGLE_RANGE / 65535;
/** At or below this sun elevation (degrees) nothing is lit. */
export const NIGHT_ELEVATION_DEG = (SUN_FLOOR_RAD * 180) / Math.PI;

// The horizon-map twin lives in horizon-cpu.ts (no luma import, so the worker stays light).
export {computeHorizonMapCpu, computeHorizonRowsCpu, horizonDistances, type TerrainHeights};

const DEG = Math.PI / 180;

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}

/** Half-up rounding of a 0..1 value to a byte, as the kernel's toByte does. */
function toByte(value: number): number {
  return Math.floor(Math.min(Math.max(value, 0), 1) * 255 + 0.5);
}

/**
 * Lit fraction (0..255) per texel for a sun at `azimuth`/`elevation` degrees: smoothstep across a
 * 0.27 degree penumbra around the horizon angle, which is interpolated linearly between the two
 * neighbouring azimuths of the map.
 */
export function shadeAtTimeCpu(
  map: Uint16Array,
  window: ShadowWindow,
  azimuths: number,
  azimuth: number,
  elevation: number
): Uint8Array {
  const cells = window.size * window.size;
  const out = new Uint8Array(cells);
  if (elevation * DEG <= SUN_FLOOR_RAD) return out;
  let low: number;
  let high: number;
  let mix: number;
  if (azimuths === HORIZON_MAP_AZIMUTHS) {
    ({low, high, blend: mix} = azimuthBlend(azimuth));
  } else {
    const slot = ((((azimuth % 360) + 360) % 360) / 360) * azimuths;
    low = Math.floor(slot) % azimuths;
    high = (low + 1) % azimuths;
    mix = slot - Math.floor(slot);
  }
  const sun = elevation * DEG;
  for (let cell = 0; cell < cells; cell++) {
    const lowAngle = dequantizeAngle(map[cell * azimuths + low]);
    const horizon = lowAngle + (dequantizeAngle(map[cell * azimuths + high]) - lowAngle) * mix;
    out[cell] = toByte(smoothstep(horizon - PENUMBRA_RAD, horizon + PENUMBRA_RAD, sun));
  }
  return out;
}

/** Day-table steps accumulated between yields to the event loop (about 20 ms each). */
const SUN_HOURS_CHUNK_STEPS = 8;

/**
 * Adds `litFraction * stepHours` of one sun sample to `hours` (f32, like the sun-hours kernel).
 * Samples at or below the sun floor add nothing and cost nothing.
 */
function addSunHoursStep(
  hours: Float32Array,
  map: Uint16Array,
  window: ShadowWindow,
  azimuths: number,
  sample: SunSample,
  stepHours: number
): void {
  const sun = sample.elevation * DEG;
  if (sun <= SUN_FLOOR_RAD) return;
  const {low, high, blend} = azimuthBlend(sample.azimuth);
  const cells = window.size * window.size;
  for (let cell = 0; cell < cells; cell++) {
    const lowAngle = dequantizeAngle(map[cell * azimuths + low]);
    const horizon = lowAngle + (dequantizeAngle(map[cell * azimuths + high]) - lowAngle) * blend;
    const lit = smoothstep(horizon - PENUMBRA_RAD, horizon + PENUMBRA_RAD, sun);
    hours[cell] += lit * stepHours;
  }
}

/** Sky-view factor 1 - mean_j sin(max(H_j, 0)) per texel, 0..255 (Kennelly and Stewart). */
export function ambientCpu(map: Uint16Array, window: ShadowWindow, azimuths: number): Uint8Array {
  const cells = window.size * window.size;
  const out = new Uint8Array(cells);
  for (let cell = 0; cell < cells; cell++) {
    let sum = 0;
    for (let a = 0; a < azimuths; a++) {
      sum += Math.sin(Math.max(dequantizeAngle(map[cell * azimuths + a]), 0));
    }
    out[cell] = toByte(1 - sum / azimuths);
  }
  return out;
}

/** Messages between the main thread and shadow-cpu.worker.ts. */
export type ShadowWorkerRequest = {
  terrain: TerrainHeights;
  window: ShadowWindow;
  azimuths: number;
  samples: number;
  chunkRows: number;
};
export type ShadowWorkerResponse = {type: 'done'; map: Uint16Array; ms: number};

const FIELD_SIZE = 256;
const FIELD_STRIDE = 4;

/** Runs the horizon-map build off the main thread, or in idle-time chunks where Worker is missing. */
function buildHorizonMapAsync(
  terrain: TerrainHeights,
  window: ShadowWindow,
  azimuths: number,
  samples: number,
  onWorker: (worker: Worker | null) => void,
  isCancelled: () => boolean
): Promise<{map: Uint16Array; ms: number}> {
  // The worker does one pass; the main-thread fallback uses one-row chunks (about 1M taps each).
  const chunkRows = typeof Worker === 'undefined' ? 1 : window.size;
  if (typeof Worker === 'undefined') {
    return new Promise(resolve => {
      const start = Date.now();
      const map = new Uint16Array(window.size * window.size * azimuths);
      let row = 0;
      const step = () => {
        // destroy() cannot stop a timer chain: stop here and let `.then` see `destroyed`.
        if (isCancelled()) return resolve({map, ms: Date.now() - start});
        const end = Math.min(row + chunkRows, window.size);
        computeHorizonRowsCpu(terrain, window, azimuths, samples, row, end, map);
        row = end;
        if (row < window.size) setTimeout(step, 0);
        else resolve({map, ms: Date.now() - start});
      };
      step();
    });
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./shadow-cpu.worker.ts', import.meta.url), {type: 'module'});
    onWorker(worker);
    worker.onmessage = (event: MessageEvent<ShadowWorkerResponse>) => {
      if (event.data.type === 'done') {
        worker.terminate();
        onWorker(null);
        resolve({map: event.data.map, ms: event.data.ms});
      }
    };
    worker.onmessageerror = () => {
      worker.terminate();
      onWorker(null);
      reject(new Error('shadow worker sent an unreadable message'));
    };
    worker.onerror = event => {
      worker.terminate();
      onWorker(null);
      reject(new Error(event.message || 'shadow worker failed'));
    };
    const request: ShadowWorkerRequest = {terrain, window, azimuths, samples, chunkRows};
    worker.postMessage(request);
  });
}

/**
 * The WebGL2 shadow source: a 256^2 x 16 horizon map from a stride-4 window, built once in a
 * worker, then re-shaded into an r8unorm texture on every `setSun`. A failure leaves `field` null
 * (no cast shadow) and `ready` still resolves, so rendering never waits on or breaks from compute.
 */
export function createCpuShadowSource(device: Device, mosaic: Mosaic): ShadowSource {
  const window = makeShadowWindow(mosaic, FIELD_SIZE, FIELD_STRIDE);
  // Clone only the heights into the worker, not the raw Terrarium pixels.
  const terrain: TerrainHeights = {
    heights: mosaic.heights,
    width: mosaic.width,
    height: mosaic.height,
    metersPerPixel: mosaic.metersPerPixel
  };
  const azimuths = HORIZON_MAP_AZIMUTHS;
  const sizeMeters = FIELD_SIZE * FIELD_STRIDE * mosaic.metersPerPixel;
  let map: Uint16Array | null = null;
  let worker: Worker | null = null;
  let destroyed = false;
  let shadowTexture: Texture | null = null;
  let ambientTexture: Texture | null = null;
  let pendingSun = {azimuth: 0, elevation: -90};
  let lastShadow: Uint8Array | null = null;
  let resolveReady: () => void = () => {};

  const writeBytes = (texture: Texture, data: Uint8Array) => {
    texture.writeData(data, {bytesPerRow: FIELD_SIZE, rowsPerImage: FIELD_SIZE});
  };
  const makeTexture = (id: string) =>
    device.createTexture({
      id,
      format: 'r8unorm',
      width: FIELD_SIZE,
      height: FIELD_SIZE,
      usage: LumaTexture.SAMPLE | LumaTexture.COPY_DST
    });

  const applySun = () => {
    if (!map || !shadowTexture) return;
    lastShadow = shadeAtTimeCpu(map, window, azimuths, pendingSun.azimuth, pendingSun.elevation);
    writeBytes(shadowTexture, lastShadow);
  };

  const source: ShadowSource = {
    field: null,
    window,
    azimuths,
    ready: new Promise<void>(resolve => {
      resolveReady = resolve;
    }),
    setSun(azimuth, elevation) {
      pendingSun = {azimuth, elevation};
      applySun();
    },
    async sunHours(table: SunSample[]) {
      await source.ready;
      const hours = new Float32Array(FIELD_SIZE * FIELD_SIZE);
      if (!map || table.length < 2) return hours;
      const stepHours = (table[1].minutes - table[0].minutes) / 60;
      // Float lit fraction straight from the horizon map (no byte round trip), accumulated in f32
      // like the kernel, in yielded chunks so the main thread never stalls for the whole day.
      for (let index = 0; index < table.length; index++) {
        if (destroyed) break;
        addSunHoursStep(hours, map, window, azimuths, table[index], stepHours);
        if (index % SUN_HOURS_CHUNK_STEPS === SUN_HOURS_CHUNK_STEPS - 1) {
          await new Promise<void>(resolve => setTimeout(resolve, 0));
        }
      }
      return hours;
    },
    async readHorizonMap() {
      await source.ready;
      return map ? map.slice() : new Uint16Array(0);
    },
    inspectorRows(): NodeRow[] {
      return [
        {
          graph: 'shadow',
          id: 'horizon-map-cpu',
          type: 'worker',
          outcome: map ? 'executed' : 'skipped'
        },
        {
          graph: 'shadow',
          id: 'shade-at-time-cpu',
          type: 'main',
          outcome: lastShadow ? 'executed' : 'skipped'
        }
      ];
    },
    destroy() {
      destroyed = true;
      worker?.terminate();
      worker = null;
      shadowTexture?.destroy();
      ambientTexture?.destroy();
      shadowTexture = null;
      ambientTexture = null;
      source.field = null;
      // A terminated worker never answers: settle `ready` so awaiting callers do not hang.
      resolveReady();
    }
  };

  buildHorizonMapAsync(
    terrain,
    window,
    azimuths,
    HORIZON_MAP_SAMPLES,
    w => {
      worker = w;
    },
    () => destroyed
  )
    .then(result => {
      if (destroyed) return;
      map = result.map;
      shadowTexture = makeTexture('shadow-cpu');
      ambientTexture = makeTexture('ambient-cpu');
      writeBytes(ambientTexture, ambientCpu(map, window, azimuths));
      const field: ShadowField = {
        shadow: shadowTexture,
        ambient: ambientTexture,
        size: FIELD_SIZE,
        sizeMeters,
        originEnu: [
          mosaic.originEnu[0] + window.column * mosaic.metersPerPixel,
          mosaic.originEnu[1] - window.row * mosaic.metersPerPixel
        ],
        backend: 'cpu-twin'
      };
      applySun();
      source.field = field;
    })
    .catch(error => {
      console.warn('CPU shadow twin failed; rendering without cast shadows', error);
    })
    .finally(resolveReady);
  return source;
}
