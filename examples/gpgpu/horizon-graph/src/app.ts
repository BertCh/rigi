// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import {
  Buffer,
  luma,
  type CanvasContext,
  type Device,
  type QuerySet,
  type ShaderLayout
} from '@luma.gl/core';
import {Model} from '@luma.gl/engine';
import {
  GPUCommandGraphInspector,
  type CompiledGPUCommandGraph,
  type GPUCommandGraphInspectorObservation
} from '@luma.gl/gpgpu/gpu-core';
import {webgpuAdapter} from '@luma.gl/webgpu';
import {
  compareHorizons,
  computeHorizonOnCPU,
  decodeTerrariumHeights,
  getElevationDegrees,
  getHeightAt,
  getSampleCount,
  makeAzimuthDirections,
  makeSamples,
  REFRACTION_COEFFICIENT,
  type HorizonProfile,
  type HorizonSetup
} from './horizon-cpu';
import {
  createHorizonBinBuffers,
  createHorizonGraph,
  createHorizonTerrainBuffers,
  writeHorizonUniforms,
  type HorizonBinBuffers,
  type HorizonGraphParameters,
  type HorizonTerrainBuffers
} from './horizon-graph';
import {PANORAMA_UNIFORMS_BYTE_LENGTH, SILHOUETTE_WGSL, SKYLINE_WGSL} from './horizon-shaders';
import {getBearingAndDistance, NIEDERHORN, PEAKS} from './peaks';
import {
  EARTH_RADIUS_METERS,
  getPixelsPerMeter,
  getWorldPixel,
  loadTerrainMosaic
} from './terrain-mosaic';

/** z11 Terrarium pixels are ~26 m here; 7 × 7 tiles reach at least 40 km in every direction. */
const TERRAIN_ZOOM = 11;
const TERRAIN_TILE_RADIUS = 3;
const MAXIMUM_DISTANCE_LIMIT = 45_000;
/** The GPS altitude is raised to this height above the DEM if the DEM lies above it. */
const MINIMUM_EYE_HEIGHT_ABOVE_GROUND = 1.6;
const SKY_COLOR: [number, number, number, number] = [0.02, 0.04, 0.08, 1];
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

export type HorizonGraphSceneOptions = {
  /** Optional WebGPU device to borrow. A device is created (and later destroyed) otherwise. */
  device?: Device;
  /** Called after each graph run and redraw with the latest diagnostics. */
  onUpdate?: (diagnostics: HorizonGraphDiagnostics) => void;
};

/** Per-node result of the latest graph encoding. */
export type HorizonGraphNodeDiagnostics = {
  id: string;
  type: string;
  outcome: 'executed' | 'skipped' | 'gpu-resolved';
  gpuMs?: number;
};

export type HorizonGraphDiagnostics = {
  frames: number;
  runs: number;
  backend: string;
  error: string;
  finalized: boolean;
  bins: number;
  maximumDistance: number;
  /** GPU time of the latest graph run: timestamp-query sum, or submit-to-readback wall time. */
  gpuMs: number;
  gpuTiming: 'timestamp-query' | 'wall-clock' | '';
  /** CPU twin time for the same work as the latest graph run (decode only when the GPU decoded). */
  cpuMs: number;
  maxAbsDeltaDegrees: number;
  maxTangentUlps: number;
  mismatchedBins: number;
  identicalBins: number;
  tileCount: number;
  eyeAltitude: number;
  groundAltitude: number;
  highestAzimuth: number;
  highestElevation: number;
  nodes: HorizonGraphNodeDiagnostics[];
  peaks: {name: string; azimuth: number; elevation: number; distance: number; visible: boolean}[];
};

type BinResources = {
  binCount: number;
  buffers: HorizonBinBuffers;
  compiled: CompiledGPUCommandGraph<HorizonGraphParameters>;
  observation: GPUCommandGraphInspectorObservation<HorizonGraphParameters>;
};

type PanoramaLayout = {
  leftAzimuth: number;
  lowerElevation: number;
  upperElevation: number;
  getX: (azimuth: number) => number;
  getY: (elevation: number) => number;
};

/**
 * Computes the 360° skyline around the Niederhorn on the GPU with a `GPUCommandGraph`, checks it
 * against an f32 CPU twin and draws it as a panorama silhouette.
 */
export function createHorizonGraphScene(
  parent: HTMLElement,
  options: HorizonGraphSceneOptions = {}
) {
  let binCount = 2048;
  let maximumDistance = 40_000;
  let heading = 180;
  let fieldOfView = 360;

  const diagnostics: HorizonGraphDiagnostics = {
    frames: 0,
    runs: 0,
    backend: '',
    error: '',
    finalized: false,
    bins: 0,
    maximumDistance,
    gpuMs: 0,
    gpuTiming: '',
    cpuMs: 0,
    maxAbsDeltaDegrees: 0,
    maxTangentUlps: 0,
    mismatchedBins: 0,
    identicalBins: 0,
    tileCount: 0,
    eyeAltitude: 0,
    groundAltitude: 0,
    highestAzimuth: 0,
    highestElevation: 0,
    nodes: [],
    peaks: []
  };

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block';
  const overlay = document.createElementNS(SVG_NAMESPACE, 'svg');
  overlay.setAttribute('aria-hidden', 'true');
  overlay.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none';
  parent.append(canvas, overlay);

  const abortController = new AbortController();
  const inspector = new GPUCommandGraphInspector({maxSamples: 32});
  let device: Device | null = null;
  let canvasContext: CanvasContext | null = null;
  let querySet: QuerySet | null = null;
  let terrainBuffers: HorizonTerrainBuffers | null = null;
  let binResources: BinResources | null = null;
  let panoramaUniforms: Buffer | null = null;
  let silhouetteModel: Model | null = null;
  let skylineModel: Model | null = null;
  let heights: Float32Array | null = null;
  let setup: HorizonSetup | null = null;
  let cpuDecodeMs = 0;
  let heightsDecoded = false;
  let profile: HorizonProfile | null = null;
  let tangentExtent: [number, number] = [0, 0];
  let hoverX: number | null = null;
  let running = false;
  let runRequested = false;
  let drawRequested = false;

  const resizeObserver = new ResizeObserver(() => requestDraw());
  resizeObserver.observe(parent);
  const handlePointerMove = (event: PointerEvent) => {
    hoverX = event.clientX - parent.getBoundingClientRect().left;
    requestDraw();
  };
  const handlePointerLeave = () => {
    hoverX = null;
    requestDraw();
  };
  parent.addEventListener('pointermove', handlePointerMove);
  parent.addEventListener('pointerleave', handlePointerLeave);

  const ready = initialize().catch(error => {
    diagnostics.error ||= error instanceof Error ? error.message : String(error);
    throw error;
  });

  async function initialize(): Promise<void> {
    if (options.device) {
      device = options.device;
      canvasContext = device.createCanvasContext({canvas, autoResize: true});
    } else {
      device = await luma.createDevice({
        id: 'horizon-graph',
        type: 'webgpu',
        adapters: [webgpuAdapter],
        // 'max' requests every supported feature, including 'timestamp-query' for node timings.
        featureLevel: 'max',
        createCanvasContext: {canvas, autoResize: true, alphaMode: 'opaque'}
      });
      canvasContext = device.getDefaultCanvasContext();
    }
    diagnostics.backend = device.type;
    if (device.type !== 'webgpu') {
      throw new Error('The horizon graph requires WebGPU compute.');
    }
    if (device.features.has('timestamp-query')) {
      querySet = device.createQuerySet({
        id: 'horizon-graph-timestamps',
        type: 'timestamp',
        count: 64
      });
    }

    const mosaic = await loadTerrainMosaic(NIEDERHORN, {
      zoom: TERRAIN_ZOOM,
      tileRadius: TERRAIN_TILE_RADIUS,
      signal: abortController.signal
    });
    if (diagnostics.finalized) return;
    diagnostics.tileCount = mosaic.tileCount;

    // The CPU twin decodes the same raw bytes the GPU decodes.
    const decodeStart = performance.now();
    heights = decodeTerrariumHeights(mosaic.pixels);
    cpuDecodeMs = performance.now() - decodeStart;

    const [worldColumn, worldRow] = getWorldPixel(NIEDERHORN, TERRAIN_ZOOM);
    const eyeColumn = worldColumn - mosaic.originColumn;
    const eyeRow = worldRow - mosaic.originRow;
    diagnostics.groundAltitude = getHeightAt(heights, mosaic.width, eyeColumn, eyeRow);
    const pixelsPerMeter = getPixelsPerMeter(NIEDERHORN.latitude, TERRAIN_ZOOM);
    const mercatorGrowth = Math.tan((NIEDERHORN.latitude * Math.PI) / 180) / EARTH_RADIUS_METERS;
    const samples = makeSamples(MAXIMUM_DISTANCE_LIMIT, 1 / pixelsPerMeter);
    // Every scalar is rounded to f32 once here, so the GPU and the CPU twin read identical values.
    setup = {
      mosaicWidth: mosaic.width,
      mosaicHeight: mosaic.height,
      eyeColumnIndex: Math.floor(eyeColumn),
      eyeRowIndex: Math.floor(eyeRow),
      eyeColumnFraction: Math.fround(eyeColumn - Math.floor(eyeColumn)),
      eyeRowFraction: Math.fround(eyeRow - Math.floor(eyeRow)),
      eyeAltitude: Math.fround(
        Math.max(NIEDERHORN.altitude, diagnostics.groundAltitude + MINIMUM_EYE_HEIGHT_ABOVE_GROUND)
      ),
      pixelsPerMeter: Math.fround(pixelsPerMeter),
      mercatorGrowth: Math.fround(mercatorGrowth),
      halfMercatorGrowth: Math.fround(mercatorGrowth / 2),
      curvature: Math.fround((1 - REFRACTION_COEFFICIENT) / (2 * EARTH_RADIUS_METERS)),
      binCount: 0,
      azimuthDirections: new Float32Array(0),
      samples,
      sampleCount: 0
    };
    diagnostics.eyeAltitude = setup.eyeAltitude;

    terrainBuffers = createHorizonTerrainBuffers(device, {
      terrariumPixels: mosaic.pixels,
      samples
    });
    panoramaUniforms = device.createBuffer({
      id: 'panorama-uniforms',
      byteLength: PANORAMA_UNIFORMS_BYTE_LENGTH,
      usage: Buffer.UNIFORM | Buffer.COPY_DST
    });
    const panoramaShaderLayout: ShaderLayout = {
      attributes: [],
      bindings: [
        {name: 'panorama', type: 'uniform', group: 0, location: 0},
        {name: 'horizonTangents', type: 'read-only-storage', group: 0, location: 1},
        {name: 'horizonDistances', type: 'read-only-storage', group: 0, location: 2}
      ]
    };
    [silhouetteModel, skylineModel] = await Promise.all([
      Model.createAsync(device, {
        id: 'horizon-silhouette',
        source: SILHOUETTE_WGSL,
        topology: 'triangle-strip',
        shaderLayout: panoramaShaderLayout
      }),
      Model.createAsync(device, {
        id: 'horizon-skyline',
        source: SKYLINE_WGSL,
        topology: 'line-strip',
        shaderLayout: panoramaShaderLayout
      })
    ]);
    await runGraph();
  }

  /** Runs the graph until no setter has requested another run. */
  async function requestRun(): Promise<void> {
    if (running) {
      runRequested = true;
      return;
    }
    running = true;
    try {
      do {
        runRequested = false;
        await runGraph();
      } while (runRequested && !diagnostics.finalized);
    } catch (error) {
      diagnostics.error ||= error instanceof Error ? error.message : String(error);
    } finally {
      running = false;
    }
  }

  async function runGraph(): Promise<void> {
    if (!device || !terrainBuffers || !setup || !heights || diagnostics.finalized) return;
    if (binResources?.binCount !== binCount) {
      await rebuildBinResources(device, terrainBuffers, setup);
    }
    const resources = binResources!;
    setup.sampleCount = getSampleCount(setup.samples, maximumDistance);
    writeHorizonUniforms(terrainBuffers.uniforms, setup);

    const decodeHeights = !heightsDecoded;
    const commandEncoder = device.createCommandEncoder({
      id: 'horizon-graph',
      timeProfilingQuerySet: querySet
    });
    const encoding = resources.observation.encode(commandEncoder, {parameters: {decodeHeights}});
    const submitTime = performance.now();
    device.submit(commandEncoder.finish());
    heightsDecoded = true;
    const [tangentBytes, distanceBytes, extentBytes] = await Promise.all([
      resources.buffers.horizonTangents.readAsync(),
      resources.buffers.horizonDistances.readAsync(),
      resources.buffers.tangentExtent.readAsync()
    ]);
    const wallClockMs = performance.now() - submitTime;
    const timing = encoding.canReadGPUTimings
      ? await resources.observation.recordGPUTimings(encoding)
      : undefined;
    if (diagnostics.finalized) return;

    profile = {
      tangents: new Float32Array(tangentBytes.slice().buffer),
      distances: new Float32Array(distanceBytes.slice().buffer)
    };
    const extent = new Float32Array(extentBytes.slice().buffer);
    tangentExtent = [extent[0], extent[1]];

    const cpuStart = performance.now();
    const cpuProfile = computeHorizonOnCPU(heights, setup);
    diagnostics.cpuMs = performance.now() - cpuStart + (decodeHeights ? cpuDecodeMs : 0);
    Object.assign(diagnostics, compareHorizons(profile, cpuProfile));

    diagnostics.runs++;
    diagnostics.bins = binCount;
    diagnostics.maximumDistance = maximumDistance;
    diagnostics.gpuTiming =
      timing?.gpuTimeMilliseconds !== undefined ? 'timestamp-query' : 'wall-clock';
    diagnostics.gpuMs = timing?.gpuTimeMilliseconds ?? wallClockMs;
    diagnostics.nodes = encoding.stats.nodes.map((node, index) => ({
      id: node.id,
      type: node.type,
      outcome: node.condition?.outcome ?? 'executed',
      gpuMs: timing?.nodes[index]?.gpuTimeMilliseconds
    }));
    updateSkylineDiagnostics(profile, setup);
    requestDraw();
  }

  async function rebuildBinResources(
    currentDevice: Device,
    terrain: HorizonTerrainBuffers,
    currentSetup: HorizonSetup
  ): Promise<void> {
    destroyBinResources();
    currentSetup.binCount = binCount;
    currentSetup.azimuthDirections = makeAzimuthDirections(binCount);
    const buffers = createHorizonBinBuffers(currentDevice, currentSetup.azimuthDirections);
    const graph = createHorizonGraph(currentDevice, {
      terrain,
      bins: buffers,
      mosaicWidth: currentSetup.mosaicWidth,
      mosaicHeight: currentSetup.mosaicHeight,
      binCount,
      sampleCapacity: currentSetup.samples.length / 2
    });
    const compiled = await graph.compileAsync();
    binResources = {binCount, buffers, compiled, observation: inspector.observeGraph(compiled)};
  }

  function updateSkylineDiagnostics(currentProfile: HorizonProfile, currentSetup: HorizonSetup) {
    let highestBin = 0;
    for (let bin = 1; bin < currentProfile.tangents.length; bin++) {
      if (currentProfile.tangents[bin] > currentProfile.tangents[highestBin]) highestBin = bin;
    }
    diagnostics.highestAzimuth = (highestBin / binCount) * 360;
    diagnostics.highestElevation = getElevationDegrees(currentProfile.tangents[highestBin]);
    diagnostics.peaks = PEAKS.map(peak => {
      const {azimuth, distance} = getBearingAndDistance(NIEDERHORN, peak);
      const elevation = getElevationDegrees(
        (peak.elevation - currentSetup.eyeAltitude) / distance - distance * currentSetup.curvature
      );
      const bin = Math.round((azimuth / 360) * binCount) % binCount;
      const skylineElevation = getElevationDegrees(currentProfile.tangents[bin]);
      // A summit is visible when nothing nearer rises above it within the DEM's resolution.
      const visible = distance <= maximumDistance && elevation >= skylineElevation - 0.1;
      return {name: peak.name, azimuth, elevation, distance, visible};
    });
  }

  function requestDraw(): void {
    if (drawRequested || diagnostics.finalized) return;
    drawRequested = true;
    requestAnimationFrame(() => {
      drawRequested = false;
      draw();
    });
  }

  function draw(): void {
    if (!device || !canvasContext || !binResources || !profile || !panoramaUniforms) return;
    if (!silhouetteModel || !skylineModel || diagnostics.finalized) return;
    const width = parent.clientWidth;
    const height = parent.clientHeight;
    if (width === 0 || height === 0) return;
    const layout = getPanoramaLayout(width, height);
    const binWidth = 360 / binCount;
    const firstColumn = Math.floor(layout.leftAzimuth / binWidth);
    const columnCount = Math.ceil(fieldOfView / binWidth) + 2;
    const uniformData = new ArrayBuffer(PANORAMA_UNIFORMS_BYTE_LENGTH);
    new Uint32Array(uniformData, 0, 2).set([
      binCount,
      ((firstColumn % binCount) + binCount) % binCount
    ]);
    const verticalScale = -2 / height;
    new Float32Array(uniformData, 8, 6).set([
      firstColumn * binWidth - layout.leftAzimuth,
      binWidth,
      2 / fieldOfView,
      // Clip-space y of an elevation e is getY(e) mapped from CSS pixels.
      (layout.getY(1) - layout.getY(0)) * verticalScale,
      1 + layout.getY(0) * verticalScale,
      maximumDistance
    ]);
    panoramaUniforms.write(new Uint8Array(uniformData));

    const bindings = {
      panorama: panoramaUniforms,
      horizonTangents: binResources.buffers.horizonTangents,
      horizonDistances: binResources.buffers.horizonDistances
    };
    silhouetteModel.setBindings(bindings);
    silhouetteModel.setVertexCount(2 * columnCount);
    skylineModel.setBindings(bindings);
    skylineModel.setVertexCount(columnCount);
    const framebuffer = canvasContext.getCurrentFramebuffer({depthStencilFormat: false});
    const renderPass = device.beginRenderPass({
      id: 'horizon-panorama',
      framebuffer,
      clearColor: SKY_COLOR
    });
    silhouetteModel.draw(renderPass);
    skylineModel.draw(renderPass);
    renderPass.end();
    device.submit();
    diagnostics.frames++;
    drawOverlay(layout, width, height);
    options.onUpdate?.(diagnostics);
  }

  function getPanoramaLayout(width: number, height: number): PanoramaLayout {
    const maximumElevation = getElevationDegrees(tangentExtent[1]);
    const minimumElevation = getElevationDegrees(tangentExtent[0]);
    // Keep the skyline in the upper-middle of the view; clamp deep foreground dips.
    const upperElevation = maximumElevation + 0.5;
    const lowerElevation = Math.max(minimumElevation, maximumElevation - 24) - 0.5;
    const upperY = height * 0.3;
    const lowerY = height * 0.9;
    const leftAzimuth = heading - fieldOfView / 2;
    return {
      leftAzimuth,
      lowerElevation,
      upperElevation,
      getX: azimuth => ((((azimuth - leftAzimuth) % 360) + 360) % 360) * (width / fieldOfView),
      getY: elevation =>
        upperY +
        ((upperElevation - elevation) / (upperElevation - lowerElevation)) * (lowerY - upperY)
    };
  }

  /** Compass ticks, elevation grid, peak labels and the hover readout, in CSS pixels. */
  function drawOverlay(layout: PanoramaLayout, width: number, height: number): void {
    const parts: string[] = [];
    const elevationStep = pickStep(
      (height * 0.6) / (layout.upperElevation - layout.lowerElevation)
    );
    for (
      let elevation = Math.ceil(layout.lowerElevation / elevationStep) * elevationStep;
      elevation <= layout.upperElevation;
      elevation += elevationStep
    ) {
      const y = layout.getY(elevation);
      const isHorizon = Math.abs(elevation) < 1e-9;
      parts.push(
        `<line x1="0" x2="${width}" y1="${y}" y2="${y}" stroke="rgba(148,163,184,${isHorizon ? 0.55 : 0.18})" stroke-dasharray="${isHorizon ? '' : '3 5'}"/>`,
        `<text x="${width - 8}" y="${y - 4}" text-anchor="end" class="axis">${isHorizon ? '0° horizon' : `${elevation}°`}</text>`
      );
    }
    const compassY = height - 30;
    const pixelsPerDegree = width / fieldOfView;
    const minorStep = pixelsPerDegree >= 4 ? 5 : 10;
    for (let azimuth = 0; azimuth < 360; azimuth += 5) {
      const isMajor = azimuth % 45 === 0;
      if (!isMajor && azimuth % minorStep !== 0) continue;
      const x = layout.getX(azimuth);
      parts.push(
        `<line x1="${x}" x2="${x}" y1="${compassY}" y2="${compassY + (isMajor ? 10 : 5)}" stroke="rgba(226,232,240,${isMajor ? 0.9 : 0.45})"/>`
      );
      if (isMajor || (azimuth % 30 === 0 && pixelsPerDegree * 15 >= 40)) {
        const label = isMajor ? COMPASS_POINTS[azimuth / 45] : `${azimuth}°`;
        const anchor = x < 12 ? 'start' : x > width - 12 ? 'end' : 'middle';
        parts.push(
          `<text x="${x}" y="${compassY + 23}" text-anchor="${anchor}" class="${isMajor ? 'compass' : 'axis'}">${label}</text>`
        );
      }
    }
    const rowEnds: number[] = [];
    const visiblePeaks = diagnostics.peaks
      .map(peak => ({...peak, x: layout.getX(peak.azimuth), y: layout.getY(peak.elevation)}))
      .filter(peak => peak.visible)
      .sort((left, right) => left.x - right.x);
    for (const peak of visiblePeaks) {
      let row = 0;
      while (rowEnds[row] !== undefined && peak.x - rowEnds[row] < 116) row++;
      rowEnds[row] = peak.x;
      const labelY = layout.getY(layout.upperElevation) - 34 - row * 30;
      parts.push(
        `<line x1="${peak.x}" x2="${peak.x}" y1="${labelY + 6}" y2="${peak.y - 4}" stroke="rgba(250,219,153,0.7)"/>`,
        `<circle cx="${peak.x}" cy="${peak.y}" r="2.5" fill="#fadb99"/>`,
        `<text x="${peak.x}" y="${labelY - 8}" text-anchor="middle" class="peak">${peak.name}</text>`,
        `<text x="${peak.x}" y="${labelY + 3}" text-anchor="middle" class="axis">${(peak.distance / 1000).toFixed(1)} km</text>`
      );
    }
    if (hoverX !== null && profile) {
      const azimuth = (((layout.leftAzimuth + (hoverX / width) * fieldOfView) % 360) + 360) % 360;
      const bin = Math.round((azimuth / 360) * binCount) % binCount;
      const elevation = getElevationDegrees(profile.tangents[bin]);
      parts.push(
        `<line x1="${hoverX}" x2="${hoverX}" y1="${layout.getY(elevation)}" y2="${compassY}" stroke="rgba(226,232,240,0.35)"/>`,
        `<text x="${width - 8}" y="${compassY - 10}" text-anchor="end" class="readout">${azimuth.toFixed(1)}° · ${elevation.toFixed(2)}° · ${(profile.distances[bin] / 1000).toFixed(1)} km</text>`
      );
    }
    overlay.innerHTML = `<style>${OVERLAY_CSS}</style>${parts.join('')}`;
  }

  function destroyBinResources(): void {
    if (!binResources) return;
    binResources.observation.detach();
    binResources.compiled.destroy();
    for (const buffer of Object.values(binResources.buffers)) buffer.destroy();
    binResources = null;
  }

  return {
    ready,
    diagnostics,
    get device() {
      return device;
    },
    /** Latest GPU horizon profile (curvature-corrected tangents and distances per bin). */
    getHorizonProfile: () => profile,
    /** Immutable timing snapshot of every observed graph. */
    getInspectorSnapshot: () => inspector.getSnapshot(),
    /** Azimuth bins per 360°; rebuilds the graph. */
    setAzimuthBins(value: number) {
      binCount = value;
      void requestRun();
    },
    /** Ray length in metres (5–45 km); re-encodes the compiled graph with a new sample count. */
    setMaxDistance(value: number) {
      maximumDistance = Math.min(Math.max(value, 1000), MAXIMUM_DISTANCE_LIMIT);
      void requestRun();
    },
    /** Panorama centre azimuth in degrees. Redraw only. */
    setHeading(value: number) {
      heading = value;
      requestDraw();
    },
    /** Panorama width in degrees (30–360). Redraw only. */
    setFieldOfView(value: number) {
      fieldOfView = Math.min(Math.max(value, 30), 360);
      requestDraw();
    },
    finalize() {
      if (diagnostics.finalized) return;
      diagnostics.finalized = true;
      abortController.abort();
      resizeObserver.disconnect();
      parent.removeEventListener('pointermove', handlePointerMove);
      parent.removeEventListener('pointerleave', handlePointerLeave);
      destroyBinResources();
      silhouetteModel?.destroy();
      skylineModel?.destroy();
      panoramaUniforms?.destroy();
      if (terrainBuffers) for (const buffer of Object.values(terrainBuffers)) buffer.destroy();
      querySet?.destroy();
      if (options.device) canvasContext?.destroy();
      else device?.destroy();
      canvas.remove();
      overlay.remove();
    }
  };
}

const COMPASS_POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW', 'N'];

const OVERLAY_CSS = `
text { font: 11px ui-sans-serif, system-ui, sans-serif; fill: rgb(148, 163, 184); }
.compass { font-weight: 700; font-size: 12px; fill: rgb(226, 232, 240); }
.peak { font-weight: 600; font-size: 12px; fill: #fadb99; }
.readout { font-size: 12px; fill: rgb(226, 232, 240); font-variant-numeric: tabular-nums; }
`;

/** Picks a 1/2/5 × 10ⁿ degree step so grid lines are at least 36 px apart. */
function pickStep(pixelsPerDegree: number): number {
  for (const step of [0.5, 1, 2, 5, 10, 20]) {
    if (step * pixelsPerDegree >= 36) return step;
  }
  return 45;
}
