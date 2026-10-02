// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The "ring" graph: the 360 degree skyline from the summit eye and the visibility of every peak,
// as one luma.gl GPUCommandGraph (WebGPU only):
//
//   decode-terrarium -> march-horizon (2048 bins) -> peak-visibility (one thread per peak)
//
// Dependencies are inferred from the declared buffer uses. Heights are decoded once and persist;
// every later run only rewrites the uniforms (refraction k, eye height) and re-encodes.

import {Buffer, type Device, type QuerySet} from '@luma.gl/core';
import {Kernel, type KernelProps} from '@luma.gl/engine';
import {
  GPUCommandGraph,
  GPUCommandGraphInspector,
  type GPUCommandGraphComputeExecutable,
  type GPUCommandGraphComputeNode,
  type GraphBufferHandle
} from '@luma.gl/gpgpu/gpu-core';
import type {Frame, Mosaic, NodeRow, Peak, RingGraph, RingResult} from '../types';
import {makeRingResult, makeRingSetup, RING_DEFAULT_BINS, type RingSetup} from './ring-cpu';
import {
  DECODE_TERRARIUM_WGSL,
  PEAK_VISIBILITY_WGSL,
  RING_MARCH_WGSL,
  RING_UNIFORMS_BYTE_LENGTH
} from './ring-shaders';

type RingGraphParameters = {
  /** Decode the Terrarium pixels into `heights`. Only the first encoding needs it. */
  decodeHeights: boolean;
};

const FLOAT32_BYTE_LENGTH = 4;
const WORKGROUP_SIZE = 64;

/** Writes the `RingUniforms` block shared by the three kernels. */
export function writeRingUniforms(buffer: Buffer, setup: RingSetup): void {
  const data = new ArrayBuffer(RING_UNIFORMS_BYTE_LENGTH);
  new Float32Array(data, 0, 9).set([
    setup.eyeColumnFraction,
    setup.eyeRowFraction,
    setup.eyeAltitude,
    setup.pixelsPerMeterEast,
    setup.pixelsPerMeterNorth,
    setup.mercatorGrowth,
    setup.halfMercatorGrowth,
    setup.parallelCurvature,
    setup.curvature
  ]);
  new Uint32Array(data, 36, 1).set([setup.binCount]);
  new Int32Array(data, 40, 2).set([setup.eyeColumnIndex, setup.eyeRowIndex]);
  new Uint32Array(data, 48, 4).set([
    setup.mosaicWidth,
    setup.mosaicHeight,
    setup.sampleCount,
    setup.peakCount
  ]);
  new Float32Array(data, 64, 1).set([setup.peakSkirt]);
  // Bytes 68..72 stay zero: `zero` for opaque().
  new Float32Array(data, 72, 2).set([setup.columnCurvature, setup.rowCubic]);
  buffer.write(new Uint8Array(data));
}

/**
 * Builds, compiles (async, so the first frame never waits on pipeline creation) and uploads the
 * ring graph. `eyeHeight` passed to `run` is the lens altitude above sea level in metres. Peaks
 * farther than 45 km, or whose ray leaves the mosaic before the peak, are reported invisible
 * (`peakMarginDeg` -90).
 */
export async function createRingGraph(
  device: Device,
  mosaic: Mosaic,
  peaks: Peak[],
  frame: Frame,
  opts: {timestamps?: boolean} = {}
): Promise<RingGraph> {
  const bins = RING_DEFAULT_BINS;
  // k and eye height only change uniforms; the tables are fixed for the life of the graph.
  const base = makeRingSetup(mosaic, frame, peaks, 0, frame.origin.h, bins);
  const peakCapacity = Math.max(peaks.length, 1);
  const createStorage = (id: string, byteLength: number, extra = 0) =>
    device.createBuffer({id, byteLength, usage: Buffer.STORAGE | extra});
  const createInput = (id: string, data: Uint32Array | Float32Array) =>
    device.createBuffer({id, usage: Buffer.STORAGE | Buffer.COPY_DST, data});
  const buffers = {
    uniforms: device.createBuffer({
      id: 'ring-uniforms',
      byteLength: RING_UNIFORMS_BYTE_LENGTH,
      usage: Buffer.UNIFORM | Buffer.COPY_DST
    }),
    terrariumPixels: createInput('ring-terrarium-pixels', mosaic.pixels),
    heights: createStorage('ring-heights', mosaic.pixels.byteLength),
    samples: createInput('ring-samples', base.samples),
    azimuthDirections: createInput('ring-azimuth-directions', base.azimuthDirections),
    peakRays: createInput('ring-peak-rays', base.peakRays),
    ringTangents: createStorage('ring-tangents', bins * FLOAT32_BYTE_LENGTH, Buffer.COPY_SRC),
    ringDistances: createStorage('ring-distances', bins * FLOAT32_BYTE_LENGTH, Buffer.COPY_SRC),
    peakResults: createStorage('ring-peak-results', peakCapacity * 16, Buffer.COPY_SRC)
  };

  const graph = declareRingGraph(device, buffers, base, peakCapacity);
  const compiled = await graph.compileAsync();
  const inspector = new GPUCommandGraphInspector({maxSamples: 8});
  const observation = inspector.observeGraph(compiled);

  // Timestamps are optional and need the device feature. Each node takes a begin/end pair.
  let querySet: QuerySet | null = null;
  if (opts.timestamps && device.features.has('timestamp-query')) {
    querySet = device.createQuerySet({id: 'ring-timestamps', type: 'timestamp', count: 16});
  }

  let decoded = false;
  let rows: NodeRow[] = [];
  let destroyed = false;
  // Runs share buffers, so they are serialised.
  let queue: Promise<unknown> = Promise.resolve();

  async function execute(k: number, eyeHeight: number): Promise<RingResult> {
    if (destroyed) throw new Error('The ring graph was destroyed.');
    const setup = makeRingSetup(mosaic, frame, peaks, k, eyeHeight, bins);
    writeRingUniforms(buffers.uniforms, setup);
    const commandEncoder = device.createCommandEncoder({
      id: 'ring-graph',
      timeProfilingQuerySet: querySet
    });
    const encoding = observation.encode(commandEncoder, {
      parameters: {decodeHeights: !decoded}
    });
    device.submit(commandEncoder.finish());
    decoded = true;
    const [tangentBytes, peakBytes] = await Promise.all([
      buffers.ringTangents.readAsync(),
      buffers.peakResults.readAsync()
    ]);
    const timing = encoding.canReadGPUTimings
      ? await observation.recordGPUTimings(encoding)
      : undefined;
    rows = encoding.stats.nodes.map((node, index) => ({
      graph: 'ring',
      id: node.id,
      type: node.type,
      outcome: node.condition?.outcome ?? 'executed',
      gpuMs: timing?.nodes[index]?.gpuTimeMilliseconds
    }));
    return makeRingResult(
      new Float32Array(tangentBytes.slice().buffer),
      new Float32Array(peakBytes.slice().buffer),
      peaks.length
    );
  }

  return {
    run(k, eyeHeight) {
      const result = queue.then(() => execute(k, eyeHeight));
      queue = result.catch(() => undefined);
      return result;
    },
    inspectorRows: () => rows,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      observation.detach();
      compiled.destroy();
      querySet?.destroy();
      for (const buffer of Object.values(buffers)) buffer.destroy();
    }
  };
}

type RingBuffers = {
  uniforms: Buffer;
  terrariumPixels: Buffer;
  heights: Buffer;
  samples: Buffer;
  azimuthDirections: Buffer;
  peakRays: Buffer;
  ringTangents: Buffer;
  ringDistances: Buffer;
  peakResults: Buffer;
};

function declareRingGraph(
  device: Device,
  buffers: RingBuffers,
  setup: RingSetup,
  peakCapacity: number
): GPUCommandGraph<RingGraphParameters> {
  const graph = new GPUCommandGraph<RingGraphParameters>(device, {id: 'ring-graph'});
  const importBuffer = (buffer: Buffer): GraphBufferHandle =>
    graph.importBuffer({id: buffer.id, byteLength: buffer.byteLength, usage: buffer.usage}, buffer);
  const uniforms = importBuffer(buffers.uniforms);
  const terrariumPixels = importBuffer(buffers.terrariumPixels);
  const heights = importBuffer(buffers.heights);
  const samples = importBuffer(buffers.samples);
  const azimuthDirections = importBuffer(buffers.azimuthDirections);
  const peakRays = importBuffer(buffers.peakRays);
  const ringTangents = importBuffer(buffers.ringTangents);
  const ringDistances = importBuffer(buffers.ringDistances);
  const peakResults = importBuffer(buffers.peakResults);
  const pixelCount = setup.mosaicWidth * setup.mosaicHeight;
  const sampleCount = setup.sampleCount;

  graph.addComputePass({
    id: 'decode-terrarium',
    resources: [
      {buffer: uniforms, usage: 'uniform'},
      {buffer: terrariumPixels, usage: 'storage-read'},
      {buffer: heights, usage: 'storage-write'}
    ],
    // Heights persist in a graph-owned buffer, so later encodings skip the decode.
    condition: {
      id: 'heights-stale',
      source: 'cpu',
      evaluate: parameters => parameters.decodeHeights
    },
    workload: {
      operation: 'decode-terrarium',
      maximumInvocationCount: pixelCount,
      readByteLength: pixelCount * 4,
      writeByteLength: pixelCount * 4
    },
    ...makeKernelCompiler({
      kernel: {
        id: 'decode-terrarium',
        source: DECODE_TERRARIUM_WGSL,
        shaderLayout: {
          bindings: [
            {name: 'uniforms', type: 'uniform', group: 0, location: 0},
            {name: 'terrariumPixels', type: 'read-only-storage', group: 0, location: 1},
            {name: 'heights', type: 'storage', group: 0, location: 2}
          ]
        }
      },
      bindings: {uniforms, terrariumPixels, heights},
      workgroupCount: [Math.ceil(setup.mosaicWidth / 16), Math.ceil(setup.mosaicHeight / 16)]
    })
  });

  graph.addComputePass({
    id: 'march-horizon',
    resources: [
      {buffer: uniforms, usage: 'uniform'},
      {buffer: heights, usage: 'storage-read'},
      {buffer: azimuthDirections, usage: 'storage-read'},
      {buffer: samples, usage: 'storage-read'},
      {buffer: ringTangents, usage: 'storage-write'},
      {buffer: ringDistances, usage: 'storage-write'}
    ],
    workload: {
      operation: 'march-horizon',
      maximumInvocationCount: setup.binCount,
      readByteLength: setup.binCount * sampleCount * 6 * FLOAT32_BYTE_LENGTH,
      writeByteLength: setup.binCount * 2 * FLOAT32_BYTE_LENGTH
    },
    ...makeKernelCompiler({
      kernel: {
        id: 'march-horizon',
        source: RING_MARCH_WGSL,
        shaderLayout: {
          bindings: [
            {name: 'uniforms', type: 'uniform', group: 0, location: 0},
            {name: 'heights', type: 'read-only-storage', group: 0, location: 1},
            {name: 'azimuthDirections', type: 'read-only-storage', group: 0, location: 2},
            {name: 'samples', type: 'read-only-storage', group: 0, location: 3},
            {name: 'ringTangents', type: 'storage', group: 0, location: 4},
            {name: 'ringDistances', type: 'storage', group: 0, location: 5}
          ]
        }
      },
      bindings: {uniforms, heights, azimuthDirections, samples, ringTangents, ringDistances},
      workgroupCount: [Math.ceil(setup.binCount / WORKGROUP_SIZE), 1]
    })
  });

  graph.addComputePass({
    id: 'peak-visibility',
    resources: [
      {buffer: uniforms, usage: 'uniform'},
      {buffer: heights, usage: 'storage-read'},
      {buffer: samples, usage: 'storage-read'},
      {buffer: peakRays, usage: 'storage-read'},
      {buffer: peakResults, usage: 'storage-write'}
    ],
    workload: {
      operation: 'peak-visibility',
      maximumInvocationCount: peakCapacity,
      readByteLength: peakCapacity * sampleCount * 6 * FLOAT32_BYTE_LENGTH,
      writeByteLength: peakCapacity * 4 * FLOAT32_BYTE_LENGTH
    },
    ...makeKernelCompiler({
      kernel: {
        id: 'peak-visibility',
        source: PEAK_VISIBILITY_WGSL,
        shaderLayout: {
          bindings: [
            {name: 'uniforms', type: 'uniform', group: 0, location: 0},
            {name: 'heights', type: 'read-only-storage', group: 0, location: 1},
            {name: 'samples', type: 'read-only-storage', group: 0, location: 2},
            {name: 'peakRays', type: 'read-only-storage', group: 0, location: 3},
            {name: 'peakResults', type: 'storage', group: 0, location: 4}
          ]
        }
      },
      bindings: {uniforms, heights, samples, peakRays, peakResults},
      workgroupCount: [Math.ceil(peakCapacity / WORKGROUP_SIZE), 1]
    })
  });
  return graph;
}

/**
 * Returns `compile` / `compileAsync` callbacks for a single-kernel compute node. Bindings are graph
 * handles resolved to concrete buffers at encode time.
 */
function makeKernelCompiler(props: {
  kernel: KernelProps;
  bindings: Record<string, GraphBufferHandle>;
  workgroupCount: [number, number];
}): Pick<GPUCommandGraphComputeNode<RingGraphParameters>, 'compile' | 'compileAsync'> {
  const makeExecutable = (
    kernel: Kernel
  ): GPUCommandGraphComputeExecutable<RingGraphParameters> => ({
    encode: ({computePass, getBuffer}) => {
      const bindings: Record<string, Buffer> = {};
      for (const [name, handle] of Object.entries(props.bindings)) {
        bindings[name] = getBuffer(handle);
      }
      kernel.dispatch(computePass, {
        bindings,
        x: props.workgroupCount[0],
        y: props.workgroupCount[1]
      });
    },
    destroy: () => kernel.destroy()
  });
  return {
    compile: ({device}) => makeExecutable(new Kernel(device, props.kernel)),
    compileAsync: async ({device}) => makeExecutable(await Kernel.createAsync(device, props.kernel))
  };
}
