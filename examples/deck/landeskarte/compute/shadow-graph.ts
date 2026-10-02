// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Cast-shadow field on the luma.gl GPUCommandGraph, ported from examples/gpgpu/horizon-graph.
//
//   decode graph   decode-terrarium                        once; the raw pixels are freed after
//   horizon graph  horizon-map (one azimuth per submit)    16 submits, awaited, one per frame
//   shade graph    shade-at-time, ambient-field (once)     per sun change, then buffer -> texture
//   sun-hours      sun-hours (chunks of the day table)     on demand
//
// All graphs only record commands; this file encodes, submits and waits. A dispatch over every
// cell and all 256 samples of one azimuth is the unit of GPU work, which keeps each submit short
// enough for the driver watchdog.

import {Buffer, Texture, type Device, type QuerySet} from '@luma.gl/core';
import {Kernel, type KernelProps} from '@luma.gl/engine';
import {
  GPUCommandGraph,
  type CompiledGPUCommandGraph,
  type GPUCommandGraphComputeExecutable,
  type GPUCommandGraphComputeNode,
  type GPUCommandGraphEncoding,
  type GraphBufferHandle
} from '@luma.gl/gpgpu/gpu-core';
import {REFRACTION_K} from '../geo/geodesy';
import type {Mosaic, NodeRow, ShadowField, ShadowSource, ShadowWindow, SunSample} from '../types';
import {
  AMBIENT_WGSL,
  azimuthBlend,
  azimuthDirection,
  curvatureCoefficient,
  DECODE_TERRARIUM_WGSL,
  DECODE_UNIFORMS_BYTE_LENGTH,
  HORIZON_MAP_AZIMUTHS,
  HORIZON_MAP_SAMPLES,
  HORIZON_MAP_WGSL,
  HORIZON_UNIFORMS_BYTE_LENGTH,
  makeSampleTable,
  SHADE_AT_TIME_WGSL,
  SHADE_UNIFORMS_BYTE_LENGTH,
  SUN_HOURS_STEPS_PER_DISPATCH,
  SUN_HOURS_UNIFORMS_BYTE_LENGTH,
  SUN_HOURS_WGSL
} from './shadow-shaders';

// The CPU twin and the app import the shared constants and helpers from here.
export {
  azimuthBlend,
  azimuthDirection,
  curvatureCoefficient,
  dequantizeAngle,
  HORIZON_MAP_AZIMUTHS,
  HORIZON_MAP_SAMPLES,
  makeSampleTable,
  makeShadowWindow,
  quantizeAngle
} from './shadow-shaders';

export type ShadowGraphOptions = {
  /** Record per-node GPU timings (needs the `timestamp-query` feature; ignored without it). */
  timestamps?: boolean;
  /** Called after each horizon-map azimuth, with (done, total). */
  onProgress?: (done: number, total: number) => void;
  /** Refraction coefficient baked into the horizon map. Defaults to REFRACTION_K. */
  refractionK?: number;
};

/** Per-encoding switches of the shade graph. */
type ShadeParameters = {ambient: boolean};
type NoParameters = Record<string, never>;

const DEGREES_TO_RADIANS = Math.PI / 180;

/**
 * Builds the shadow source. Returns at once; `ready` resolves when the horizon map is built and
 * `field` is valid. If WebGPU compute fails, `ready` still resolves and `field` stays null (the
 * terrain then draws without cast shadow) and the reason goes to the console.
 */
export function createShadowGraph(
  device: Device,
  mosaic: Mosaic,
  window: ShadowWindow,
  opts: ShadowGraphOptions = {}
): ShadowSource {
  const {size, stride} = window;
  // size must be a multiple of 256: the byte buffer is copied to the texture with bytesPerRow = size.
  const cellCount = size * size;
  const refractionK = opts.refractionK ?? REFRACTION_K;
  const mosaicPixels = mosaic.width * mosaic.height;

  const querySet: QuerySet | null =
    opts.timestamps && device.features.has('timestamp-query')
      ? device.createQuerySet({id: 'shadow-timestamps', type: 'timestamp', count: 64})
      : null;

  const createStorage = (id: string, byteLength: number, extra = 0) =>
    device.createBuffer({id, byteLength, usage: Buffer.STORAGE | extra});
  const createUniform = (id: string, byteLength: number) =>
    device.createBuffer({id, byteLength, usage: Buffer.UNIFORM | Buffer.COPY_DST});

  const buffers = {
    decodeUniforms: createUniform('shadow-decode-uniforms', DECODE_UNIFORMS_BYTE_LENGTH),
    pixels: device.createBuffer({
      id: 'shadow-terrarium-pixels',
      usage: Buffer.STORAGE | Buffer.COPY_DST,
      data: mosaic.pixels
    }),
    // COPY_SRC: the decode submit is awaited with a 4-byte readAsync, which stages a copy.
    heights: createStorage('shadow-heights', mosaicPixels * 4, Buffer.COPY_SRC),
    samples: device.createBuffer({
      id: 'shadow-samples',
      usage: Buffer.STORAGE | Buffer.COPY_DST,
      data: makeSampleTable()
    }),
    horizonUniforms: createUniform('shadow-horizon-uniforms', HORIZON_UNIFORMS_BYTE_LENGTH),
    // 16 u16 angles per cell: 33.5 MiB at 1024 x 1024. COPY_SRC for readHorizonMap.
    horizonMap: createStorage(
      'shadow-horizon-map',
      cellCount * HORIZON_MAP_AZIMUTHS * 2,
      Buffer.COPY_SRC
    ),
    shadeUniforms: createUniform('shadow-shade-uniforms', SHADE_UNIFORMS_BYTE_LENGTH),
    shadowBytes: createStorage('shadow-bytes', cellCount, Buffer.COPY_SRC),
    ambientBytes: createStorage('shadow-ambient-bytes', cellCount, Buffer.COPY_SRC)
  };
  const createFieldTexture = (id: string) =>
    device.createTexture({
      id,
      format: 'r8unorm',
      width: size,
      height: size,
      usage: Texture.SAMPLE | Texture.COPY_DST,
      sampler: {
        minFilter: 'linear',
        magFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge'
      }
    });
  const textures = {
    shadow: createFieldTexture('shadow-field'),
    ambient: createFieldTexture('ambient-field')
  };

  // Known approximation: the field uses the east-west metres per pixel for both axes. The mosaic is
  // Web Mercator on an ellipsoid, which is not conformal, so true north-south ground scale is
  // N / M (about 1.003 at 46.7 N) times larger; over the 13 km half-window that is about 40 m
  // (about 1.6 texels) of northing at the window edge, and the same relative error in ray length.
  // Fixing it needs a north scale in Mosaic and ShadowField (types.ts) and in the terrain shader's
  // field lookup, so ring-cpu.ts (which has both scales) and the shadow field stay a known gap.
  const pixelsPerMeter = Math.fround(1 / mosaic.metersPerPixel);
  const sizeMeters = size * stride * mosaic.metersPerPixel;
  const fieldOriginEnu: [number, number] = [
    mosaic.originEnu[0] + window.column * mosaic.metersPerPixel,
    mosaic.originEnu[1] - window.row * mosaic.metersPerPixel
  ];

  const nodeRows = new Map<string, NodeRow>();
  let decodeGraph: CompiledGPUCommandGraph<NoParameters> | null = null;
  let horizonGraph: CompiledGPUCommandGraph<NoParameters> | null = null;
  let shadeGraph: CompiledGPUCommandGraph<ShadeParameters> | null = null;
  let source: ShadowSource;
  let destroyed = false;
  let built = false;
  let ambientDone = false;
  let pendingSun: {azimuth: number; elevation: number} | null = null;
  // Sun-hours and the build both use the horizon map; serialise heavy GPU work.
  let heavyQueue: Promise<unknown> = Promise.resolve();

  /** Records the rows of one encoding, adding GPU time when the timestamp read worked. */
  async function recordRows(encoding: GPUCommandGraphEncoding, graphId: 'shadow'): Promise<void> {
    const report = encoding.canReadGPUTimings
      ? await encoding.readTimings().catch(() => undefined)
      : undefined;
    encoding.stats.nodes.forEach((node, index) => {
      const previous = nodeRows.get(node.id);
      const gpuMs = report?.nodes[index]?.gpuTimeMilliseconds;
      nodeRows.set(node.id, {
        graph: graphId,
        id: node.id,
        type: node.type,
        outcome: node.condition?.outcome ?? 'executed',
        // Horizon-map runs once per azimuth: report the total over the runs.
        gpuMs:
          gpuMs === undefined
            ? previous?.gpuMs
            : node.id === 'horizon-map'
              ? (previous?.gpuMs ?? 0) + gpuMs
              : gpuMs
      });
    });
  }

  /** Resolves once the GPU has finished everything submitted so far. */
  const waitForGpu = (buffer: Buffer) => buffer.readAsync(0, 4);

  // A macrotask, not requestAnimationFrame: rAF never fires in a hidden tab, which would leave
  // `ready` pending. The awaited readAsync already bounds each submit, so this only lets frames run.
  const yieldToRenderer = () => new Promise<void>(resolve => setTimeout(resolve, 0));

  function createEncoder(id: string, profile = true) {
    return device.createCommandEncoder({id, timeProfilingQuerySet: profile ? querySet : null});
  }

  async function build(): Promise<void> {
    const {decodeUniforms, horizonUniforms} = buffers;
    decodeUniforms.write(new Uint32Array([mosaic.width, mosaic.height, 0, 0]));

    // destroy() may land while a compile is pending, when it still sees a null graph: a graph that
    // finishes compiling after that is released here, or its kernels would leak.
    const compile = async <Parameters>(
      graph: GPUCommandGraph<Parameters>
    ): Promise<CompiledGPUCommandGraph<Parameters>> => {
      const compiled = await graph.compileAsync();
      if (destroyed) {
        compiled.destroy();
        throw new Error('shadow graph destroyed during compile');
      }
      return compiled;
    };
    decodeGraph = await compile(createDecodeGraph(device, buffers, mosaic));
    horizonGraph = await compile(createHorizonGraph(device, buffers, size));
    shadeGraph = await compile(createShadeGraph(device, buffers, size));

    const decodeEncoder = createEncoder('shadow-decode');
    const decodeEncoding = decodeGraph.encode(decodeEncoder, {parameters: {}});
    device.submit(decodeEncoder.finish());
    await waitForGpu(buffers.heights);
    await recordRows(decodeEncoding, 'shadow');
    if (destroyed) return;
    // Heights are decoded once; the pixels are the largest buffer, so give them back.
    buffers.pixels.destroy();
    decodeGraph.destroy();
    decodeGraph = null;

    const direction = new Float32Array(2);
    const uniformBytes = new ArrayBuffer(HORIZON_UNIFORMS_BYTE_LENGTH);
    const words = new Uint32Array(uniformBytes);
    const floats = new Float32Array(uniformBytes);
    words.set([
      mosaic.width,
      mosaic.height,
      window.column,
      window.row,
      size,
      stride,
      0,
      HORIZON_MAP_SAMPLES
    ]);
    floats[10] = pixelsPerMeter;
    floats[11] = curvatureCoefficient(refractionK);
    // words[12] is the always-zero guard; the rest is padding.
    for (let azimuth = 0; azimuth < HORIZON_MAP_AZIMUTHS && !destroyed; azimuth++) {
      direction.set(azimuthDirection(azimuth));
      words[6] = azimuth;
      floats.set(direction, 8);
      horizonUniforms.write(uniformBytes);
      const encoder = createEncoder('shadow-horizon-map');
      const encoding = horizonGraph.encode(encoder, {parameters: {}});
      device.submit(encoder.finish());
      await waitForGpu(buffers.horizonMap);
      await recordRows(encoding, 'shadow');
      opts.onProgress?.(azimuth + 1, HORIZON_MAP_AZIMUTHS);
      await yieldToRenderer();
    }
    if (destroyed) return;

    built = true;
    source.field = {
      shadow: textures.shadow,
      ambient: textures.ambient,
      size,
      sizeMeters,
      originEnu: fieldOriginEnu,
      backend: 'graph'
    } satisfies ShadowField;
    // Default sun until the app calls setSun: below the horizon, everything in shadow.
    await shade(pendingSun?.azimuth ?? 180, pendingSun?.elevation ?? -10);
  }

  /** One shade pass: the graph writes bytes, then the encoder copies them into the textures. */
  function shade(azimuthDegrees: number, elevationDegrees: number): Promise<void> | undefined {
    if (!built || destroyed || !shadeGraph) return undefined;
    const {low, high, blend} = azimuthBlend(azimuthDegrees);
    const bytes = new ArrayBuffer(SHADE_UNIFORMS_BYTE_LENGTH);
    new Uint32Array(bytes).set([cellCount / 4, low, high]);
    new Float32Array(bytes).set([blend, Math.fround(elevationDegrees * DEGREES_TO_RADIANS)], 3);
    buffers.shadeUniforms.write(bytes);

    const withAmbient = !ambientDone;
    // Only the first shade is profiled; later ones must not touch the shared query set.
    const encoder = createEncoder('shadow-shade', withAmbient);
    const encoding = shadeGraph.encode(encoder, {parameters: {ambient: withAmbient}});
    const copy = (sourceBuffer: Buffer, destinationTexture: Texture) =>
      encoder.copyBufferToTexture({
        sourceBuffer,
        destinationTexture,
        bytesPerRow: size,
        rowsPerImage: size,
        size: [size, size, 1]
      });
    copy(buffers.shadowBytes, textures.shadow);
    if (withAmbient) copy(buffers.ambientBytes, textures.ambient);
    device.submit(encoder.finish());
    ambientDone = true;
    // Rows (and timings) come from the first shade only: later ones are fire-and-forget, and
    // sharing the timestamp query set between overlapping encodings would corrupt the reads.
    return withAmbient ? recordRows(encoding, 'shadow') : undefined;
  }

  async function computeSunHours(table: SunSample[]): Promise<Float32Array> {
    await ready;
    if (!built || destroyed || table.length === 0) return new Float32Array(cellCount);
    // Sun-hours steps are consumed from a per-call buffer, so the graph is per call too.
    const steps = new Float32Array(table.length * 4);
    table.forEach((sample, index) => {
      const {low, high, blend} = azimuthBlend(sample.azimuth);
      steps.set([low, high, blend, Math.fround(sample.elevation * DEGREES_TO_RADIANS)], index * 4);
    });
    const stepHours = table.length > 1 ? (table[1].minutes - table[0].minutes) / 60 : 5 / 60;
    const stepsBuffer = device.createBuffer({
      id: 'shadow-sun-steps',
      usage: Buffer.STORAGE | Buffer.COPY_DST,
      data: steps
    });
    const hoursBuffer = createStorage('shadow-sun-hours', cellCount * 4, Buffer.COPY_SRC);
    const uniformsBuffer = createUniform(
      'shadow-sun-hours-uniforms',
      SUN_HOURS_UNIFORMS_BYTE_LENGTH
    );
    const graph = await createSunHoursGraph(
      device,
      {
        uniforms: uniformsBuffer,
        horizonMap: buffers.horizonMap,
        steps: stepsBuffer,
        hours: hoursBuffer
      },
      size
    ).compileAsync();
    try {
      for (
        let first = 0;
        first < table.length && !destroyed;
        first += SUN_HOURS_STEPS_PER_DISPATCH
      ) {
        const count = Math.min(SUN_HOURS_STEPS_PER_DISPATCH, table.length - first);
        const bytes = new ArrayBuffer(SUN_HOURS_UNIFORMS_BYTE_LENGTH);
        new Uint32Array(bytes).set([size, first, count]);
        new Float32Array(bytes).set([Math.fround(stepHours)], 3);
        uniformsBuffer.write(bytes);
        const encoder = createEncoder('shadow-sun-hours');
        const encoding = graph.encode(encoder, {parameters: {}});
        device.submit(encoder.finish());
        await waitForGpu(hoursBuffer);
        await recordRows(encoding, 'shadow');
        await yieldToRenderer();
      }
      const bytes = await hoursBuffer.readAsync();
      return new Float32Array(bytes.slice().buffer);
    } finally {
      graph.destroy();
      stepsBuffer.destroy();
      hoursBuffer.destroy();
      uniformsBuffer.destroy();
    }
  }

  const ready: Promise<void> = build().catch(error => {
    // Compute is an enhancement: report, leave `field` null, keep the app drawing.
    if (!destroyed) console.warn('Shadow graph failed; drawing without cast shadow.', error);
    source.field = null;
  });

  source = {
    ready,
    field: null,
    window,
    azimuths: HORIZON_MAP_AZIMUTHS,
    setSun(azimuth, elevation) {
      pendingSun = {azimuth, elevation};
      void shade(azimuth, elevation);
    },
    sunHours(table) {
      const run = heavyQueue.then(() => computeSunHours(table));
      heavyQueue = run.catch(() => undefined);
      return run;
    },
    async readHorizonMap() {
      await ready;
      if (!built || destroyed) return new Uint16Array(0);
      const bytes = await buffers.horizonMap.readAsync();
      return new Uint16Array(bytes.slice().buffer);
    },
    inspectorRows() {
      return [...nodeRows.values()];
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      decodeGraph?.destroy();
      horizonGraph?.destroy();
      shadeGraph?.destroy();
      for (const buffer of Object.values(buffers)) buffer.destroy();
      textures.shadow.destroy();
      textures.ambient.destroy();
      querySet?.destroy();
      source.field = null;
    }
  };
  return source;
}

type ShadowBuffers = {
  decodeUniforms: Buffer;
  pixels: Buffer;
  heights: Buffer;
  samples: Buffer;
  horizonUniforms: Buffer;
  horizonMap: Buffer;
  shadeUniforms: Buffer;
  shadowBytes: Buffer;
  ambientBytes: Buffer;
};

/** Node `decode-terrarium`: the mosaic's RGBA words to f32 heights. */
function createDecodeGraph(device: Device, buffers: ShadowBuffers, mosaic: Mosaic) {
  const graph = new GPUCommandGraph<NoParameters>(device, {id: 'shadow-decode-graph'});
  const importBuffer = makeImporter(graph);
  const uniforms = importBuffer(buffers.decodeUniforms);
  const terrariumPixels = importBuffer(buffers.pixels);
  const heights = importBuffer(buffers.heights);
  const pixelCount = mosaic.width * mosaic.height;
  graph.addComputePass({
    id: 'decode-terrarium',
    resources: [
      {buffer: uniforms, usage: 'uniform'},
      {buffer: terrariumPixels, usage: 'storage-read'},
      {buffer: heights, usage: 'storage-write'}
    ],
    workload: {
      operation: 'decode-terrarium',
      maximumInvocationCount: pixelCount,
      readByteLength: pixelCount * 4,
      writeByteLength: pixelCount * 4
    },
    ...makeKernelCompiler<NoParameters>({
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
      workgroupCount: [Math.ceil(mosaic.width / 16), Math.ceil(mosaic.height / 16)]
    })
  });
  return graph;
}

/** Node `horizon-map`: a single azimuth over every cell; the caller sets the uniform per run. */
function createHorizonGraph(device: Device, buffers: ShadowBuffers, size: number) {
  const graph = new GPUCommandGraph<NoParameters>(device, {id: 'shadow-horizon-graph'});
  const importBuffer = makeImporter(graph);
  const uniforms = importBuffer(buffers.horizonUniforms);
  const heights = importBuffer(buffers.heights);
  const samples = importBuffer(buffers.samples);
  const horizonMap = importBuffer(buffers.horizonMap);
  graph.addComputePass({
    id: 'horizon-map',
    resources: [
      {buffer: uniforms, usage: 'uniform'},
      {buffer: heights, usage: 'storage-read'},
      {buffer: samples, usage: 'storage-read'},
      {buffer: horizonMap, usage: 'storage-read-write'}
    ],
    workload: {
      operation: 'horizon-map',
      maximumInvocationCount: size * size,
      readByteLength: size * size * HORIZON_MAP_SAMPLES * 4 * 4,
      writeByteLength: size * size * 2
    },
    ...makeKernelCompiler<NoParameters>({
      kernel: {
        id: 'horizon-map',
        source: HORIZON_MAP_WGSL,
        shaderLayout: {
          bindings: [
            {name: 'uniforms', type: 'uniform', group: 0, location: 0},
            {name: 'heights', type: 'read-only-storage', group: 0, location: 1},
            {name: 'samples', type: 'read-only-storage', group: 0, location: 2},
            {name: 'horizonMap', type: 'storage', group: 0, location: 3}
          ]
        }
      },
      bindings: {uniforms, heights, samples, horizonMap},
      workgroupCount: [Math.ceil(size / 8), Math.ceil(size / 8)]
    })
  });
  return graph;
}

/**
 * Nodes `shade-at-time` and `ambient-field`. The ambient node carries a CPU condition, so after the
 * first encoding it is recorded as skipped, as the decode node is in the horizon-graph example.
 */
function createShadeGraph(device: Device, buffers: ShadowBuffers, size: number) {
  const graph = new GPUCommandGraph<ShadeParameters>(device, {id: 'shadow-shade-graph'});
  const importBuffer = makeImporter(graph);
  const uniforms = importBuffer(buffers.shadeUniforms);
  const horizonMap = importBuffer(buffers.horizonMap);
  const shadowBytes = importBuffer(buffers.shadowBytes);
  const ambientBytes = importBuffer(buffers.ambientBytes);
  const wordCount = (size * size) / 4;
  const workgroupCount: [number, number] = [Math.ceil(wordCount / 64), 1];
  const bindingLayout = [
    {name: 'uniforms', type: 'uniform', group: 0, location: 0},
    {name: 'horizonMap', type: 'read-only-storage', group: 0, location: 1},
    {name: 'fieldBytes', type: 'storage', group: 0, location: 2}
  ] as const;
  const workload = (operation: string) => ({
    operation,
    maximumInvocationCount: wordCount,
    readByteLength: wordCount * 4 * HORIZON_MAP_AZIMUTHS * 2,
    writeByteLength: wordCount * 4
  });

  graph.addComputePass({
    id: 'shade-at-time',
    resources: [
      {buffer: uniforms, usage: 'uniform'},
      {buffer: horizonMap, usage: 'storage-read'},
      {buffer: shadowBytes, usage: 'storage-write'}
    ],
    workload: workload('shade-at-time'),
    ...makeKernelCompiler<ShadeParameters>({
      kernel: {
        id: 'shade-at-time',
        source: SHADE_AT_TIME_WGSL,
        shaderLayout: {bindings: [...bindingLayout]}
      },
      bindings: {uniforms, horizonMap, fieldBytes: shadowBytes},
      workgroupCount
    })
  });
  graph.addComputePass({
    id: 'ambient-field',
    resources: [
      {buffer: uniforms, usage: 'uniform'},
      {buffer: horizonMap, usage: 'storage-read'},
      {buffer: ambientBytes, usage: 'storage-write'}
    ],
    condition: {
      id: 'ambient-stale',
      source: 'cpu',
      evaluate: parameters => parameters.ambient
    },
    workload: workload('ambient-field'),
    ...makeKernelCompiler<ShadeParameters>({
      kernel: {
        id: 'ambient-field',
        source: AMBIENT_WGSL,
        shaderLayout: {bindings: [...bindingLayout]}
      },
      bindings: {uniforms, horizonMap, fieldBytes: ambientBytes},
      workgroupCount
    })
  });
  return graph;
}

function createSunHoursGraph(
  device: Device,
  props: {uniforms: Buffer; horizonMap: Buffer; steps: Buffer; hours: Buffer},
  size: number
) {
  const graph = new GPUCommandGraph<NoParameters>(device, {id: 'shadow-sun-hours-graph'});
  const importBuffer = makeImporter(graph);
  const uniforms = importBuffer(props.uniforms);
  const horizonMap = importBuffer(props.horizonMap);
  const steps = importBuffer(props.steps);
  const hours = importBuffer(props.hours);
  graph.addComputePass({
    id: 'sun-hours',
    resources: [
      {buffer: uniforms, usage: 'uniform'},
      {buffer: horizonMap, usage: 'storage-read'},
      {buffer: steps, usage: 'storage-read'},
      {buffer: hours, usage: 'storage-read-write'}
    ],
    workload: {
      operation: 'sun-hours',
      maximumInvocationCount: size * size,
      readByteLength: size * size * SUN_HOURS_STEPS_PER_DISPATCH * 4,
      writeByteLength: size * size * 4
    },
    ...makeKernelCompiler<NoParameters>({
      kernel: {
        id: 'sun-hours',
        source: SUN_HOURS_WGSL,
        shaderLayout: {
          bindings: [
            {name: 'uniforms', type: 'uniform', group: 0, location: 0},
            {name: 'horizonMap', type: 'read-only-storage', group: 0, location: 1},
            {name: 'steps', type: 'read-only-storage', group: 0, location: 2},
            {name: 'hours', type: 'storage', group: 0, location: 3}
          ]
        }
      },
      bindings: {uniforms, horizonMap, steps, hours},
      workgroupCount: [Math.ceil(size / 8), Math.ceil(size / 8)]
    })
  });
  return graph;
}

function makeImporter<Parameters>(graph: GPUCommandGraph<Parameters>) {
  return (buffer: Buffer): GraphBufferHandle =>
    graph.importBuffer({id: buffer.id, byteLength: buffer.byteLength, usage: buffer.usage}, buffer);
}

/**
 * Returns `compile` / `compileAsync` callbacks for a single-kernel compute node. Each kernel has its
 * own WGSL source and no override constants, so the pipelines are distinct on every backend.
 * Bindings are graph handles resolved to concrete buffers at encode time.
 */
function makeKernelCompiler<Parameters>(props: {
  kernel: KernelProps;
  bindings: Record<string, GraphBufferHandle>;
  workgroupCount: [number, number];
}): Pick<GPUCommandGraphComputeNode<Parameters>, 'compile' | 'compileAsync'> {
  const makeExecutable = (kernel: Kernel): GPUCommandGraphComputeExecutable<Parameters> => ({
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
