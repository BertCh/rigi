// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import {Buffer, luma, type Device, type QuerySet} from '@luma.gl/core';
import {Kernel, type KernelProps} from '@luma.gl/engine';
import {
  GPUCommandGraph,
  GPUCommandGraphInspector,
  type GPUCommandGraphComputeExecutable,
  type GPUCommandGraphComputeNode,
  type GraphBufferHandle
} from '@luma.gl/gpgpu/gpu-core';
import {webgpuAdapter} from '@luma.gl/webgpu';
import {
  BLUR_WGSL,
  GRADIENT_WGSL,
  LUMINANCE_WGSL,
  PARAMS_BYTE_LENGTH,
  SKYLINE_WGSL
} from './shaders';

const IMAGE_WIDTH = 640;
const IMAGE_HEIGHT = 400;
/** Stage bands, left to right. */
const BAND_LABELS = ['image', 'luminance', 'blur', 'gradient', 'skyline'];
const SKYLINE_COLOR = '#e8c27a';

export type PhotoGraphSceneOptions = {
  /** Optional WebGPU device to borrow. A device is created (and later destroyed) otherwise. */
  device?: Device;
  /** Called after each graph run and redraw with the latest diagnostics. */
  onUpdate?: (diagnostics: PhotoGraphDiagnostics) => void;
};

export type PhotoGraphDiagnostics = {
  runs: number;
  backend: string;
  error: string;
  finalized: boolean;
  width: number;
  height: number;
  gpuMs: number;
  gpuTiming: 'timestamp-query' | 'wall-clock';
  /** Executed compute nodes, one dispatch each. */
  dispatchCount: number;
  /** Physical compute passes; the graph may coalesce adjacent nodes into one. */
  passCount: number;
  nodes: {id: string; type: string; outcome: string; gpuMs?: number}[];
  /** Columns where the skyline node found an edge above the threshold. */
  skylineColumns: number;
  /** Mean skyline row over those columns. */
  skylineMeanRow: number;
};

/** Creates the test image: a sky with a low sun and three ridges, painted with Canvas 2D. */
function paintTestImage(): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = IMAGE_WIDTH;
  canvas.height = IMAGE_HEIGHT;
  const context = canvas.getContext('2d')!;
  const sky = context.createLinearGradient(0, 0, 0, IMAGE_HEIGHT);
  sky.addColorStop(0, '#27407a');
  sky.addColorStop(0.7, '#e9a77a');
  context.fillStyle = sky;
  context.fillRect(0, 0, IMAGE_WIDTH, IMAGE_HEIGHT);
  const sun = context.createRadialGradient(440, 250, 4, 440, 250, 150);
  sun.addColorStop(0, '#fff3cf');
  sun.addColorStop(1, 'rgba(255, 243, 207, 0)');
  context.fillStyle = sun;
  context.fillRect(0, 0, IMAGE_WIDTH, IMAGE_HEIGHT);
  const ridges = [
    {base: 190, shade: '#6d5a78', phase: 0.7},
    {base: 250, shade: '#47395a', phase: 2.1},
    {base: 315, shade: '#21182f', phase: 4.2}
  ];
  for (const {base, shade, phase} of ridges) {
    context.fillStyle = shade;
    context.beginPath();
    context.moveTo(0, IMAGE_HEIGHT);
    for (let x = 0; x <= IMAGE_WIDTH; x += 2) {
      const t = x / IMAGE_WIDTH;
      const wave =
        Math.sin(t * 7 + phase) * 28 +
        Math.sin(t * 19 + phase * 3) * 11 +
        Math.sin(t * 53 + phase) * 4;
      context.lineTo(x, base + wave);
    }
    context.lineTo(IMAGE_WIDTH, IMAGE_HEIGHT);
    context.fill();
  }
  return context.getImageData(0, 0, IMAGE_WIDTH, IMAGE_HEIGHT);
}

/** Center-crops a photo to the graph's fixed image size (cover fit), staying on this page. */
function fitPhoto(source: CanvasImageSource & {width: number; height: number}): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = IMAGE_WIDTH;
  canvas.height = IMAGE_HEIGHT;
  const context = canvas.getContext('2d')!;
  const scale = Math.max(IMAGE_WIDTH / source.width, IMAGE_HEIGHT / source.height);
  const width = source.width * scale;
  const height = source.height * scale;
  context.drawImage(source, (IMAGE_WIDTH - width) / 2, (IMAGE_HEIGHT - height) / 2, width, height);
  return context.getImageData(0, 0, IMAGE_WIDTH, IMAGE_HEIGHT);
}

/** `compile` / `compileAsync` callbacks for a single-kernel compute node over graph handles. */
function makeKernelCompiler(props: {
  kernel: KernelProps;
  bindings: Record<string, GraphBufferHandle>;
  workgroupCount: [number, number];
}): Pick<GPUCommandGraphComputeNode<unknown>, 'compile' | 'compileAsync'> {
  const makeExecutable = (kernel: Kernel): GPUCommandGraphComputeExecutable<unknown> => ({
    encode: ({computePass, getBuffer}) => {
      const bindings: Record<string, Buffer> = {};
      for (const [name, handle] of Object.entries(props.bindings))
        bindings[name] = getBuffer(handle);
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

/**
 * Runs a test image through `luminance → blur → gradient → skyline` on one `GPUCommandGraph` and
 * draws the five stages as vertical bands of one canvas.
 */
export function createPhotoGraphScene(parent: HTMLElement, options: PhotoGraphSceneOptions = {}) {
  const diagnostics: PhotoGraphDiagnostics = {
    runs: 0,
    backend: '',
    error: '',
    finalized: false,
    width: IMAGE_WIDTH,
    height: IMAGE_HEIGHT,
    gpuMs: 0,
    gpuTiming: 'wall-clock',
    dispatchCount: 0,
    passCount: 0,
    nodes: [],
    skylineColumns: 0,
    skylineMeanRow: 0
  };
  const canvas = document.createElement('canvas');
  canvas.width = IMAGE_WIDTH;
  canvas.height = IMAGE_HEIGHT;
  parent.append(canvas);

  let device: Device | null = null;
  let ownsDevice = false;
  let threshold = 0.35;
  let running = false;
  let rerunRequested = false;
  const buffers: Buffer[] = [];
  let run: (() => Promise<void>) | null = null;
  let destroyGraph: (() => void) | null = null;
  let timestampQuerySet: QuerySet | null = null;
  let image = paintTestImage();
  let pixels: Buffer | null = null;

  const ready = initialize().catch(error => {
    diagnostics.error ||= error instanceof Error ? error.message : String(error);
    throw error;
  });

  async function initialize(): Promise<void> {
    if (options.device) {
      device = options.device;
    } else {
      device = await luma.createDevice({
        id: 'photo-graph',
        type: 'webgpu',
        adapters: [webgpuAdapter],
        // 'max' requests every supported feature, including 'timestamp-query' for node timings.
        featureLevel: 'max'
      });
      ownsDevice = true;
    }
    diagnostics.backend = device.type;
    if (device.type !== 'webgpu') throw new Error('Through the lens requires WebGPU compute.');
    const querySet: QuerySet | null = device.features.has('timestamp-query')
      ? device.createQuerySet({id: 'photo-graph-timestamps', type: 'timestamp', count: 16})
      : null;
    timestampQuerySet = querySet;

    const pixelCount = IMAGE_WIDTH * IMAGE_HEIGHT;
    const createBuffer = (
      id: string,
      byteLength: number,
      usage: number,
      data?: ArrayBufferView
    ) => {
      const buffer = device!.createBuffer({id, byteLength, usage, ...(data ? {data} : {})});
      buffers.push(buffer);
      return buffer;
    };
    const STORAGE_OUT = Buffer.STORAGE | Buffer.COPY_SRC;
    const params = createBuffer('params', PARAMS_BYTE_LENGTH, Buffer.UNIFORM | Buffer.COPY_DST);
    pixels = createBuffer(
      'pixels',
      pixelCount * 4,
      Buffer.STORAGE | Buffer.COPY_DST,
      new Uint32Array(image.data.buffer)
    );
    const luminance = createBuffer('luminance', pixelCount * 4, STORAGE_OUT);
    const blurred = createBuffer('blurred', pixelCount * 4, STORAGE_OUT);
    const gradient = createBuffer('gradient', pixelCount * 4, STORAGE_OUT);
    const skyline = createBuffer('skyline', IMAGE_WIDTH * 4, STORAGE_OUT);

    const graph = new GPUCommandGraph<unknown>(device, {id: 'photo-graph'});
    const importBuffer = (buffer: Buffer): GraphBufferHandle =>
      graph.importBuffer(
        {id: buffer.id, byteLength: buffer.byteLength, usage: buffer.usage},
        buffer
      );
    const handles = {
      params: importBuffer(params),
      pixels: importBuffer(pixels),
      luminance: importBuffer(luminance),
      blurred: importBuffer(blurred),
      gradient: importBuffer(gradient),
      skyline: importBuffer(skyline)
    };
    const imageGroups: [number, number] = [
      Math.ceil(IMAGE_WIDTH / 16),
      Math.ceil(IMAGE_HEIGHT / 16)
    ];
    /** Declares one stage: reads `input`, writes `output`, named as in its WGSL source. */
    const addStage = (
      id: string,
      source: string,
      [inputName, input]: [string, GraphBufferHandle],
      [outputName, output]: [string, GraphBufferHandle],
      groups: [number, number],
      invocations: number
    ) => {
      graph.addComputePass({
        id,
        resources: [
          {buffer: handles.params, usage: 'uniform'},
          {buffer: input, usage: 'storage-read'},
          {buffer: output, usage: 'storage-write'}
        ],
        workload: {
          operation: id,
          maximumInvocationCount: invocations,
          readByteLength: invocations * 4,
          writeByteLength: invocations * 4
        },
        ...makeKernelCompiler({
          kernel: {
            id,
            source,
            shaderLayout: {
              bindings: [
                {name: 'params', type: 'uniform', group: 0, location: 0},
                {name: inputName, type: 'read-only-storage', group: 0, location: 1},
                {name: outputName, type: 'storage', group: 0, location: 2}
              ]
            }
          },
          bindings: {params: handles.params, [inputName]: input, [outputName]: output},
          workgroupCount: groups
        })
      });
    };
    const columnGroups: [number, number] = [Math.ceil(IMAGE_WIDTH / 64), 1];
    addStage(
      'luminance',
      LUMINANCE_WGSL,
      ['pixels', handles.pixels],
      ['luminance', handles.luminance],
      imageGroups,
      pixelCount
    );
    addStage(
      'blur',
      BLUR_WGSL,
      ['luminance', handles.luminance],
      ['blurred', handles.blurred],
      imageGroups,
      pixelCount
    );
    addStage(
      'gradient',
      GRADIENT_WGSL,
      ['blurred', handles.blurred],
      ['gradient', handles.gradient],
      imageGroups,
      pixelCount
    );
    addStage(
      'skyline',
      SKYLINE_WGSL,
      ['gradient', handles.gradient],
      ['skyline', handles.skyline],
      columnGroups,
      IMAGE_WIDTH
    );
    const compiled = await graph.compileAsync();
    const observation = new GPUCommandGraphInspector({maxSamples: 8}).observeGraph(compiled);
    destroyGraph = () => compiled.destroy();

    run = async () => {
      const paramData = new ArrayBuffer(PARAMS_BYTE_LENGTH);
      new Uint32Array(paramData, 0, 2).set([IMAGE_WIDTH, IMAGE_HEIGHT]);
      new Float32Array(paramData, 8, 1).set([threshold]);
      params.write(new Uint8Array(paramData));
      const encoder = device!.createCommandEncoder({
        id: 'photo-graph',
        timeProfilingQuerySet: querySet
      });
      const encoding = observation.encode(encoder, {parameters: undefined});
      const submitTime = performance.now();
      device!.submit(encoder.finish());
      const [luminanceBytes, blurBytes, gradientBytes, skylineBytes] = await Promise.all(
        [luminance, blurred, gradient, skyline].map(buffer => buffer.readAsync())
      );
      const wallClockMs = performance.now() - submitTime;
      const timing = encoding.canReadGPUTimings
        ? await observation.recordGPUTimings(encoding)
        : undefined;
      if (diagnostics.finalized) return;
      const stages = [luminanceBytes, blurBytes, gradientBytes].map(
        bytes => new Float32Array(bytes.slice().buffer)
      );
      const skylineRows = new Uint32Array(skylineBytes.slice().buffer);
      drawBands(stages, skylineRows);
      let found = 0;
      let rowSum = 0;
      for (const row of skylineRows) {
        if (row < IMAGE_HEIGHT) {
          found++;
          rowSum += row;
        }
      }
      diagnostics.runs++;
      diagnostics.gpuTiming =
        timing?.gpuTimeMilliseconds !== undefined ? 'timestamp-query' : 'wall-clock';
      diagnostics.gpuMs = timing?.gpuTimeMilliseconds ?? wallClockMs;
      diagnostics.passCount = encoding.stats.computePassCount;
      diagnostics.dispatchCount = encoding.stats.nodeCount - encoding.stats.skippedNodeCount;
      diagnostics.nodes = encoding.stats.nodes.map((node, index) => ({
        id: node.id,
        type: node.type,
        outcome: node.condition?.outcome ?? 'executed',
        gpuMs: timing?.nodes[index]?.gpuTimeMilliseconds
      }));
      diagnostics.skylineColumns = found;
      diagnostics.skylineMeanRow = found ? rowSum / found : 0;
      options.onUpdate?.(diagnostics);
    };
    await runGuarded();
  }

  /** One band per stage, all sharing the image's pixel grid, so the bands read as one photograph. */
  function drawBands(stages: Float32Array[], skylineRows: Uint32Array): void {
    const context = canvas.getContext('2d')!;
    const output = context.createImageData(IMAGE_WIDTH, IMAGE_HEIGHT);
    const gradientMax = stages[2].reduce((maximum, value) => Math.max(maximum, value), 1e-6);
    const bandWidth = IMAGE_WIDTH / BAND_LABELS.length;
    for (let y = 0; y < IMAGE_HEIGHT; y++) {
      for (let x = 0; x < IMAGE_WIDTH; x++) {
        const index = y * IMAGE_WIDTH + x;
        const band = Math.min(BAND_LABELS.length - 1, Math.floor(x / bandWidth));
        const offset = index * 4;
        let rgb: [number, number, number];
        if (band === 0) {
          rgb = [image.data[offset], image.data[offset + 1], image.data[offset + 2]];
        } else if (band === 4) {
          const dim = image.data.subarray(offset, offset + 3);
          rgb = skylineRows[x] === y ? [232, 194, 122] : [dim[0] * 0.5, dim[1] * 0.5, dim[2] * 0.5];
        } else {
          const value = band === 3 ? stages[2][index] / gradientMax : stages[band - 1][index];
          const grey = Math.min(255, value * 255);
          rgb = [grey, grey, grey];
        }
        output.data.set([rgb[0], rgb[1], rgb[2], 255], offset);
      }
    }
    context.putImageData(output, 0, 0);
    context.font = '12px ui-monospace, monospace';
    context.fillStyle = SKYLINE_COLOR;
    BAND_LABELS.forEach((label, band) => context.fillText(label, band * bandWidth + 8, 18));
  }

  async function runGuarded(): Promise<void> {
    if (running) {
      rerunRequested = true;
      return;
    }
    running = true;
    try {
      do {
        rerunRequested = false;
        await run?.();
      } while (rerunRequested && !diagnostics.finalized);
    } finally {
      running = false;
    }
  }

  function finalize(): void {
    if (diagnostics.finalized) return;
    diagnostics.finalized = true;
    destroyGraph?.();
    timestampQuerySet?.destroy();
    for (const buffer of buffers) buffer.destroy();
    if (ownsDevice) device?.destroy();
    canvas.remove();
  }

  return {
    ready,
    diagnostics,
    /** Gradient magnitude above which the skyline node reports an edge (Sobel units). */
    setThreshold(value: number): Promise<void> {
      threshold = value;
      return runGuarded();
    },
    /** Reads a photo through the same compiled graph: only the pixel buffer is rewritten. */
    async setPhoto(source: CanvasImageSource & {width: number; height: number}): Promise<void> {
      await ready;
      if (diagnostics.finalized) return;
      image = fitPhoto(source);
      pixels!.write(new Uint32Array(image.data.buffer));
      return runGuarded();
    },
    finalize
  };
}
