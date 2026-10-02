// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Builds the CPU twin's horizon map off the main thread. 256^2 cells x 16 azimuths x 256 samples is
// about 2.7e8 bilinear taps, so it runs in row chunks and reports progress between them.

import {computeHorizonRowsCpu} from './cpu-twins';
import type {ShadowWorkerRequest, ShadowWorkerResponse} from './cpu-twins';

type WorkerScope = {
  onmessage: ((event: MessageEvent<ShadowWorkerRequest>) => void) | null;
  postMessage(message: ShadowWorkerResponse, transfer?: Transferable[]): void;
};
const scope = self as unknown as WorkerScope;

scope.onmessage = event => {
  const {terrain, window, azimuths, samples, chunkRows} = event.data;
  const start = performance.now();
  const map = new Uint16Array(window.size * window.size * azimuths);
  for (let row = 0; row < window.size; row += chunkRows) {
    const end = Math.min(row + chunkRows, window.size);
    computeHorizonRowsCpu(terrain, window, azimuths, samples, row, end, map);
    scope.postMessage({type: 'progress', rows: end});
  }
  scope.postMessage({type: 'done', map, ms: performance.now() - start}, [map.buffer]);
};
