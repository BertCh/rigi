// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import {Buffer, type Device} from '@luma.gl/core';
import {Kernel, type KernelProps} from '@luma.gl/engine';
import {
  GPUCommandGraph,
  GPUReduction,
  type GPUCommandGraphComputeExecutable,
  type GPUCommandGraphComputeNode,
  type GraphBufferHandle
} from '@luma.gl/gpgpu/gpu-core';
import type {HorizonSetup} from './horizon-cpu';
import {
  DECODE_TERRARIUM_WGSL,
  HORIZON_MARCH_WGSL,
  HORIZON_UNIFORMS_BYTE_LENGTH
} from './horizon-shaders';

/** Per-encoding graph parameters. */
export type HorizonGraphParameters = {
  /** Decode the Terrarium mosaic into `heights`. Only the first encoding needs it. */
  decodeHeights: boolean;
};

/** Caller-owned buffers that live as long as the terrain mosaic. */
export type HorizonTerrainBuffers = {
  uniforms: Buffer;
  terrariumPixels: Buffer;
  heights: Buffer;
  samples: Buffer;
};

/** Caller-owned buffers whose size depends on the azimuth bin count. */
export type HorizonBinBuffers = {
  azimuthDirections: Buffer;
  horizonTangents: Buffer;
  horizonDistances: Buffer;
  /** Two f32 rows: minimum and maximum horizon tangent. */
  tangentExtent: Buffer;
};

const FLOAT32_BYTE_LENGTH = 4;

/** Creates the mosaic-sized buffers and uploads the raw Terrarium pixels and distance table. */
export function createHorizonTerrainBuffers(
  device: Device,
  props: {terrariumPixels: Uint32Array; samples: Float32Array}
): HorizonTerrainBuffers {
  return {
    uniforms: device.createBuffer({
      id: 'horizon-uniforms',
      byteLength: HORIZON_UNIFORMS_BYTE_LENGTH,
      usage: Buffer.UNIFORM | Buffer.COPY_DST
    }),
    terrariumPixels: device.createBuffer({
      id: 'terrarium-pixels',
      usage: Buffer.STORAGE | Buffer.COPY_DST,
      data: props.terrariumPixels
    }),
    heights: device.createBuffer({
      id: 'heights',
      byteLength: props.terrariumPixels.byteLength,
      usage: Buffer.STORAGE
    }),
    samples: device.createBuffer({
      id: 'samples',
      usage: Buffer.STORAGE | Buffer.COPY_DST,
      data: props.samples
    })
  };
}

/** Creates the per-bin buffers and uploads the azimuth direction table. */
export function createHorizonBinBuffers(
  device: Device,
  azimuthDirections: Float32Array
): HorizonBinBuffers {
  const binCount = azimuthDirections.length / 2;
  const createOutput = (id: string, length: number) =>
    device.createBuffer({
      id,
      byteLength: length * FLOAT32_BYTE_LENGTH,
      usage: Buffer.STORAGE | Buffer.COPY_SRC
    });
  return {
    azimuthDirections: device.createBuffer({
      id: 'azimuth-directions',
      usage: Buffer.STORAGE | Buffer.COPY_DST,
      data: azimuthDirections
    }),
    horizonTangents: createOutput('horizon-tangents', binCount),
    horizonDistances: createOutput('horizon-distances', binCount),
    tangentExtent: createOutput('tangent-extent', 2)
  };
}

/** Writes the `HorizonUniforms` block shared by the decode and march kernels. */
export function writeHorizonUniforms(buffer: Buffer, setup: HorizonSetup): void {
  const data = new ArrayBuffer(HORIZON_UNIFORMS_BYTE_LENGTH);
  new Float32Array(data, 0, 7).set([
    setup.eyeColumnFraction,
    setup.eyeRowFraction,
    setup.eyeAltitude,
    setup.pixelsPerMeter,
    setup.mercatorGrowth,
    setup.halfMercatorGrowth,
    setup.curvature
  ]);
  new Uint32Array(data, 28, 1).set([setup.binCount]);
  new Int32Array(data, 32, 2).set([setup.eyeColumnIndex, setup.eyeRowIndex]);
  new Uint32Array(data, 40, 3).set([setup.mosaicWidth, setup.mosaicHeight, setup.sampleCount]);
  buffer.write(new Uint8Array(data));
}

/**
 * Declares the horizon graph:
 *
 *   decode-terrarium → march-horizon → tangent-extent (GPUReduction, one or more passes)
 *
 * Dependencies are inferred from the declared buffer uses. The graph only records commands;
 * the caller encodes, submits and reads back.
 */
export function createHorizonGraph(
  device: Device,
  props: {
    terrain: HorizonTerrainBuffers;
    bins: HorizonBinBuffers;
    mosaicWidth: number;
    mosaicHeight: number;
    binCount: number;
    sampleCapacity: number;
  }
): GPUCommandGraph<HorizonGraphParameters> {
  const {terrain, bins, mosaicWidth, mosaicHeight, binCount} = props;
  const graph = new GPUCommandGraph<HorizonGraphParameters>(device, {id: 'horizon-graph'});
  const pixelCount = mosaicWidth * mosaicHeight;
  const importBuffer = (buffer: Buffer): GraphBufferHandle =>
    graph.importBuffer({id: buffer.id, byteLength: buffer.byteLength, usage: buffer.usage}, buffer);
  const uniforms = importBuffer(terrain.uniforms);
  const terrariumPixels = importBuffer(terrain.terrariumPixels);
  const heights = importBuffer(terrain.heights);
  const samples = importBuffer(terrain.samples);
  const azimuthDirections = importBuffer(bins.azimuthDirections);
  const horizonTangents = importBuffer(bins.horizonTangents);
  const horizonDistances = importBuffer(bins.horizonDistances);
  const tangentExtent = importBuffer(bins.tangentExtent);

  graph.addComputePass({
    id: 'decode-terrarium',
    resources: [
      {buffer: uniforms, usage: 'uniform'},
      {buffer: terrariumPixels, usage: 'storage-read'},
      {buffer: heights, usage: 'storage-write'}
    ],
    // Heights persist in a caller-owned buffer, so later encodings skip the decode.
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
      workgroupCount: [Math.ceil(mosaicWidth / 16), Math.ceil(mosaicHeight / 16)]
    })
  });

  graph.addComputePass({
    id: 'march-horizon',
    resources: [
      {buffer: uniforms, usage: 'uniform'},
      {buffer: heights, usage: 'storage-read'},
      {buffer: azimuthDirections, usage: 'storage-read'},
      {buffer: samples, usage: 'storage-read'},
      {buffer: horizonTangents, usage: 'storage-write'},
      {buffer: horizonDistances, usage: 'storage-write'}
    ],
    workload: {
      operation: 'march-horizon',
      maximumInvocationCount: binCount,
      readByteLength: binCount * props.sampleCapacity * 6 * FLOAT32_BYTE_LENGTH,
      writeByteLength: binCount * 2 * FLOAT32_BYTE_LENGTH
    },
    ...makeKernelCompiler({
      kernel: {
        id: 'march-horizon',
        source: HORIZON_MARCH_WGSL,
        shaderLayout: {
          bindings: [
            {name: 'uniforms', type: 'uniform', group: 0, location: 0},
            {name: 'heights', type: 'read-only-storage', group: 0, location: 1},
            {name: 'azimuthDirections', type: 'read-only-storage', group: 0, location: 2},
            {name: 'samples', type: 'read-only-storage', group: 0, location: 3},
            {name: 'horizonTangents', type: 'storage', group: 0, location: 4},
            {name: 'horizonDistances', type: 'storage', group: 0, location: 5}
          ]
        }
      },
      bindings: {
        uniforms,
        heights,
        azimuthDirections,
        samples,
        horizonTangents,
        horizonDistances
      },
      workgroupCount: [Math.ceil(binCount / 64), 1]
    })
  });

  // The min/max tangent sets the panorama's vertical range. GPUReduction expands into one or
  // more hierarchical passes with graph-owned scratch.
  graph.add(
    new GPUReduction({
      id: 'tangent-extent',
      input: graph.createDataView(horizonTangents, {format: 'float32', length: binCount}),
      output: graph.createDataView(tangentExtent, {format: 'float32', length: 2}),
      operation: 'extent'
    })
  );
  return graph;
}

/**
 * Returns `compile` / `compileAsync` callbacks for a single-kernel compute node. Bindings are graph
 * handles resolved to concrete buffers at encode time, so imports can be swapped per encoding.
 */
function makeKernelCompiler(props: {
  kernel: KernelProps;
  bindings: Record<string, GraphBufferHandle>;
  workgroupCount: [number, number];
}): Pick<GPUCommandGraphComputeNode<HorizonGraphParameters>, 'compile' | 'compileAsync'> {
  const makeExecutable = (
    kernel: Kernel
  ): GPUCommandGraphComputeExecutable<HorizonGraphParameters> => ({
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
