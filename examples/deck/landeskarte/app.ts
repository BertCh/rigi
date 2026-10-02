// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Landeskarte Abendlicht: the Niederhorn as a Swiss map sheet that lifts into the summit panorama,
// lit by the real sun of 7 September 2026. This file wires the modules together; each module
// owns one concern (see README.md for the map).

import {COORDINATE_SYSTEM, Deck, type Layer} from '@deck.gl/core';
import {PathLayer} from '@deck.gl/layers';
import type {Device} from '@luma.gl/core';
import {getDeckExampleProps, type DeckExampleDeviceOptions} from '../deck-example-device';
import {computeRingCpu} from './compute/ring-cpu';
import {createRingGraph} from './compute/ring-graph';
import {compareParity, marchCellF64} from './compute/parity';
import {createCpuShadowSource, shadeAtTimeCpu} from './compute/cpu-twins';
import {createShadowGraph} from './compute/shadow-graph';
import {
  dequantizeAngle,
  HORIZON_MAP_AZIMUTHS,
  HORIZON_MAP_SAMPLES,
  makeShadowWindow
} from './compute/shadow-shaders';
import {getMosaicGroundHeight, loadMosaic} from './compute/mosaic';
import {loadPeaks, loadStations, loadTrails} from './data/load';
import {DAY_UTC_MS, LAKES, LAKE_THUN_ELEVATION, SUMMIT_EYE} from './data/scene-data';
import {
  airMass,
  buildSunTable,
  formatCest,
  sunColor as getSunColor,
  sunDirection as getSunDirection,
  sunPosition
} from './geo/sun';
import {curvatureDrop, elevationAngle, haversine, makeFrame, REFRACTION_K} from './geo/geodesy';
import {NebelmeerLayer} from './layers/nebelmeer-layer';
import {SkyLayer, skyColorFor} from './layers/sky-layer';
import {placeLabels, toTextLayers} from './overlay/labels';
import {
  loadPhotoSkylines,
  makeSkylineLayers,
  skylineResidualStats,
  type PhotoSkyline
} from './overlay/skyline-layer';
import {makeStationLayers, pickStation} from './overlay/station-layer';
import {makeTrailLayers} from './overlay/trail-layer';
import {loadLabelFonts} from './overlay/typography';
import {sampleHeight, selectTiles, tileId, TileStreamer} from './terrain/dem-tiles';
import {TerrainLayer} from './terrain/terrain-layer';
import {createControls, type Controls} from './ui/controls';
import {createFurniture, renderWegweiser, type Furniture} from './ui/furniture';
import {createHud, type Hud} from './ui/hud';
import {createNumbersPanel, type NumbersPanel} from './ui/numbers-panel';
import {GIPFELRAST_START_MINUTES, clampMinutes} from './ui/time-axis';
import {createFlight} from './views/flight';
import {
  LandeskarteView,
  getCameraAxes,
  getPanoramaPose,
  getPlanPose,
  layerFilter,
  makeScreenView,
  makeScreenViewState,
  poseToViewState,
  projectToScreen
} from './views/landeskarte-view';
import {attachOrbitControls} from './views/orbit-controls';
import type {
  Diagnostics,
  LayerName,
  LoadedTile,
  Mosaic,
  NumbersState,
  Peak,
  PlacedLabel,
  ParityReport,
  RingGraph,
  RingResult,
  SceneMode,
  SceneOptions,
  ShadowSource,
  Station,
  SunSample,
  SymbolId,
  TerrainUniforms,
  TrailWay,
  ViewPose
} from './types';

export type LandeskarteSceneOptions = DeckExampleDeviceOptions &
  SceneOptions & {
    /** Where the controls, the numbers drawer and the proof drawer go. Default: none (headless). */
    controlsHost?: HTMLElement;
    drawersHost?: HTMLElement;
    /** Called with a short status line while the scene loads. */
    onStatus?: (text: string) => void;
  };

export type LandeskarteScene = ReturnType<typeof createLandeskarteScene>;

/** The first photo, 15:28 CEST: the default clock. */
const DEFAULT_MINUTES = GIPFELRAST_START_MINUTES;
/** Slices of the DEM texture array: also the WebGPU limit on array layers. */
const MAX_TILE_LAYERS = 256;
const FLIGHT_MS = 3200;
const FLIGHT_MS_AUTOMATED = 700;
const REVEAL_MS = 2600;
const NUMBER_OF_RING_BINS = 2048;
/** The panorama pose never rises: it is a lens at the origin. */
const SKYLINE_COLUMN_STEP = 4;
const SHADOW_FIELD_SIZE_GPU = 1024;

const LAYER_DEFAULTS: Record<LayerName, boolean> = {
  contours: true,
  relief: true,
  rock: true,
  scree: true,
  trails: true,
  stations: true,
  labels: true,
  shadows: true,
  sky: true,
  nebelmeer: false,
  ring: false,
  skyline: false
};

const clampUnit = (value: number) => Math.min(Math.max(value, 0), 1);
const smoothstep = (edge0: number, edge1: number, value: number) => {
  const t = clampUnit((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};
/**
 * The sheet: straight down from 40 km with a 16 degree lens (about 22 by 11 km on a wide canvas),
 * shifted west so Thunersee sits in the frame beside the Niederhorn ridge.
 */
function makePlanPose(): ViewPose {
  return {...getPlanPose(), eye: [-2800, -300, 40_000], vfov: 16};
}
const clonePose = (pose: ViewPose): ViewPose => ({...pose, eye: [...pose.eye]});

/** 0 = plan, 1 = panorama, from how high the lens is: the shading crossfades during the lift. */
function getPanoramaMix(pose: ViewPose): number {
  const plan = getPlanPose();
  const logHeight = (z: number) => Math.log(Math.max(z, 0) + 100);
  const fraction =
    (logHeight(pose.eye[2]) - logHeight(0)) / (logHeight(plan.eye[2]) - logHeight(0));
  return 1 - smoothstep(0.08, 0.92, fraction);
}

/** Same name within 5 km: keep the highest (OSM lists some summits twice, with wrong heights). */
function dedupePeaks(peaks: Peak[]): Peak[] {
  const kept: Peak[] = [];
  for (const peak of [...peaks].sort((a, b) => b.ele - a.ele)) {
    const duplicate = kept.some(
      other => other.name === peak.name && haversine(other, peak).distance < 5000
    );
    if (!duplicate) kept.push(peak);
  }
  return kept;
}

export function createLandeskarteScene(
  parent: HTMLDivElement,
  options: LandeskarteSceneOptions = {}
) {
  const automated = typeof navigator !== 'undefined' && navigator.webdriver === true;
  const reducedMotion =
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const revealEnabled = (options.reveal ?? true) && !automated && !reducedMotion;
  const frame = makeFrame(SUMMIT_EYE.lat, SUMMIT_EYE.lon, SUMMIT_EYE.h);
  const sunTable: SunSample[] = buildSunTable(DAY_UTC_MS, SUMMIT_EYE.lat, SUMMIT_EYE.lon);
  const abortController = new AbortController();

  // State -------------------------------------------------------------------------------------
  let mode: SceneMode = options.mode ?? 'plan';
  let pose: ViewPose = mode === 'plan' ? makePlanPose() : getPanoramaPose();
  let minutes = clampMinutes(options.minutes ?? DEFAULT_MINUTES);
  let refractionK = REFRACTION_K;
  let curved = true;
  let flying = false;
  let flight = null as {cancel(): void} | null;
  let revealProgress = revealEnabled ? 0 : 1;
  let selectedStationId: string | null = null;
  let selectedPeakId: string | null = null;
  const layerState: Record<LayerName, boolean> = {...LAYER_DEFAULTS};
  let width = Math.max(parent.clientWidth, 1);
  let height = Math.max(parent.clientHeight, 1);

  const lakeList = LAKES;
  let stations: Station[] = [];
  let peaks: Peak[] = [];
  let trails: TrailWay[] = [];
  let skylines: PhotoSkyline[] = [];
  let mosaic: Mosaic | null = null;
  let device: Device | null = null;
  let shadowSource: ShadowSource | null = null;
  let ringGraph: RingGraph | null = null;
  let ring: RingResult | null = null;
  let ringSerial = 0;
  let sunHoursField: Float32Array | null = null;
  let cursorEnu: [number, number] | null = null;

  /** Tiles of the current view's quadtree selection: the only ones drawn, so LODs never overlap. */
  let wantedTileIds = new Set<string>();
  let drawnTiles = [] as LoadedTile[];
  let drawnSource: unknown = null;
  let drawnWanted: unknown = null;
  let tilesSnapshot = [] as ReturnType<TileStreamer['tiles']['slice']>;
  let tilesDirtyAt = 0;
  let placedLabels: PlacedLabel[] = [];
  let pendingFrames: (() => void)[] = [];
  let renderQueued = false;
  let ringSettled: Promise<unknown> = Promise.resolve();
  let trailSampler = {tiles: null, sample: () => null} as {
    tiles: unknown;
    sample: (lat: number, lon: number) => number | null;
  };
  let debugLayers = null as (() => Layer[]) | null;
  let tileRequestTimer: ReturnType<typeof setTimeout> | undefined;
  let prefetchedOtherMode = false;
  let shadowShades = 0;
  let horizonPasses = 0;
  let detachControls = null as (() => void) | null;
  let controls = null as Controls | null;
  let numbersPanel = null as NumbersPanel | null;
  let hud = null as Hud | null;
  let plateHost = null as HTMLElement | null;
  let snapshotRequest: ((canvas: HTMLCanvasElement) => void) | null = null;

  const diagnostics: Diagnostics = {
    frames: 0,
    backend: '',
    error: '',
    finalized: false,
    tilesRequested: 0,
    tilesLoaded: 0,
    tilesFailed: 0,
    computeBackend: 'none',
    shadowPasses: 0,
    graphNodeMs: {},
    parity: null,
    labelsPlaced: 0,
    stationsLoaded: 0,
    revealDone: !revealEnabled,
    mode,
    minutes,
    sunAzimuth: 0,
    sunElevation: 0,
    pose: mode === 'panorama' ? clonePose(pose) : null
  };
  // The tile counters are live: the streamer owns them.
  Object.defineProperties(diagnostics, {
    tilesRequested: {get: () => streamer.stats.requested, enumerable: true},
    tilesLoaded: {get: () => streamer.stats.loaded, enumerable: true},
    tilesFailed: {get: () => streamer.stats.failed, enumerable: true},
    shadowPasses: {get: () => horizonPasses + shadowShades, enumerable: true}
  });

  // Deck --------------------------------------------------------------------------------------
  let resolveDevice: (device: Device) => void = () => {};
  const deviceReady = new Promise<Device>(resolve => {
    resolveDevice = resolve;
  });
  let rejectReady: (error: Error) => void = () => {};
  const failed = new Promise<never>((_resolve, reject) => {
    rejectReady = reject;
  });

  const streamer = new TileStreamer(() => {
    tilesDirtyAt = performance.now();
    scheduleRender();
  }, abortController.signal);

  const deviceProps = getDeckExampleProps(options);
  const deck = new Deck({
    parent,
    ...deviceProps,
    deviceProps: {
      ...deviceProps.deviceProps,
      createCanvasContext: {alphaMode: 'premultiplied'},
      webgl: {alpha: true, preserveDrawingBuffer: false}
    },
    views: [new LandeskarteView({id: 'landeskarte'}), makeScreenView()],
    viewState: getViewState(),
    layerFilter,
    layers: [],
    // No wheel capture and no deck controller: input goes through attachOrbitControls.
    controller: false,
    touchAction: 'pan-y',
    onDeviceInitialized: initialisedDevice => {
      diagnostics.backend = initialisedDevice.type as Diagnostics['backend'];
      device = initialisedDevice;
      resolveDevice(initialisedDevice);
    },
    onResize: size => {
      width = Math.max(size.width, 1);
      height = Math.max(size.height, 1);
      scheduleRender();
    },
    onAfterRender: () => {
      diagnostics.frames++;
      if (snapshotRequest) {
        const request = snapshotRequest;
        snapshotRequest = null;
        const canvas = deck.getCanvas();
        if (canvas) request(canvas);
      }
      const callbacks = pendingFrames;
      pendingFrames = [];
      for (const callback of callbacks) callback();
      hud?.update(diagnostics);
      options.onUpdate?.(diagnostics);
    },
    onError: error => {
      diagnostics.error ||= error.message;
      rejectReady(error);
    }
  } as ConstructorParameters<typeof Deck>[0]);

  function getViewState(): never {
    return {
      landeskarte: poseToViewState(pose),
      screen: makeScreenViewState(width, height)
    } as never;
  }

  function waitForFrame(): Promise<void> {
    return new Promise(resolve => {
      pendingFrames.push(resolve);
      // Render now, not on the next rAF: the frame this promise waits for must show the new state.
      render();
      deck.redraw('landeskarte changed');
    });
  }

  function scheduleRender(): void {
    if (renderQueued || diagnostics.finalized) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      if (!diagnostics.finalized) render();
    });
  }

  // Sun and light -----------------------------------------------------------------------------
  function getSun() {
    const position = sunPosition(
      new Date(DAY_UTC_MS + minutes * 60_000),
      SUMMIT_EYE.lat,
      SUMMIT_EYE.lon
    );
    return {
      ...position,
      direction: getSunDirection(position.azimuth, position.elevation),
      color: getSunColor(position.elevation),
      sky: skyColorFor(position.elevation)
    };
  }

  function applySunToShadow(): void {
    const sun = getSun();
    diagnostics.sunAzimuth = sun.azimuth;
    diagnostics.sunElevation = sun.elevation;
    if (shadowSource?.field) {
      shadowSource.setSun(sun.azimuth, sun.elevation);
      shadowShades++;
    }
  }

  // Tiles -------------------------------------------------------------------------------------
  function requestTilesFor(target: ViewPose, drawn = true): void {
    const keys = selectTiles(frame, target, {aspect: width / height});
    if (drawn) wantedTileIds = new Set(keys.map(key => tileId(key.z, key.x, key.y)));
    streamer.request(keys);
  }

  /** After a pan or look-around, ask for the tiles the new view needs (debounced). */
  /**
   * The loaded tiles of the wanted selection. While part of it is still loading, the previously
   * drawn tiles stay too, so a pan never opens a hole (briefly two zoom levels overlap).
   */
  function getDrawnTiles(): LoadedTile[] {
    if (drawnSource === tilesSnapshot && drawnWanted === wantedTileIds) return drawnTiles;
    const loaded = tilesSnapshot.filter(tile => wantedTileIds.has(tileId(tile.z, tile.x, tile.y)));
    const complete = loaded.length >= wantedTileIds.size;
    if (complete || drawnTiles.length === 0) {
      drawnTiles = loaded;
    } else {
      const kept = new Set(loaded);
      drawnTiles = [...loaded, ...drawnTiles.filter(tile => !kept.has(tile))];
    }
    drawnSource = tilesSnapshot;
    drawnWanted = wantedTileIds;
    return drawnTiles;
  }

  function requestTilesSoon(): void {
    clearTimeout(tileRequestTimer);
    tileRequestTimer = setTimeout(() => {
      if (!diagnostics.finalized && !flying) requestTilesFor(pose);
    }, 250);
  }

  // Ring and skyline --------------------------------------------------------------------------
  /**
   * The lens sits 45 m below the DEM at the Niederhorn top, so a ring from it would be blocked by
   * the ground at its feet in every direction. The skyline is taken from the DEM plus 1.6 m.
   */
  function getRingEyeHeight(): number {
    return Math.max(frame.origin.h, getMosaicGroundHeight(mosaic!, frame) + 1.6);
  }

  async function refreshRing(): Promise<void> {
    if (!mosaic || peaks.length === 0) return;
    const serial = ++ringSerial;
    const effectiveK = curved ? refractionK : 1;
    // The ring is the skyline from the summit lens, whatever the camera is doing.
    const eyeHeight = getRingEyeHeight();
    try {
      const result = ringGraph
        ? await ringGraph.run(effectiveK, eyeHeight)
        : computeRingCpu(mosaic, frame, peaks, effectiveK, eyeHeight, NUMBER_OF_RING_BINS);
      if (serial !== ringSerial || diagnostics.finalized) return;
      ring = result;
      collectNodeTimes();
      controls?.setLayerAvailable('ring', true);
      if (selectedStationId && !flying) showPlate(selectedStationId);
      scheduleRender();
    } catch (error) {
      console.warn('Landeskarte: ring failed', error);
    }
  }

  function collectNodeTimes(): void {
    const rows = [...(ringGraph?.inspectorRows() ?? []), ...(shadowSource?.inspectorRows() ?? [])];
    const times: Record<string, number> = {};
    for (const row of rows) {
      if (row.gpuMs !== undefined) times[`${row.graph}:${row.id}`] = row.gpuMs;
    }
    diagnostics.graphNodeMs = times;
  }

  /** Canvas y of the terrain skyline at canvas x, sampled every few columns, from the ring. */
  function makeSkyline(result: RingResult): (x: number) => number | null {
    const {forward, right, up} = getCameraAxes(pose);
    const tanHalf = Math.tan((pose.vfov * Math.PI) / 360);
    const aspect = width / height;
    const bins = result.bins;
    const horizonAt = (azimuth: number) => {
      const position = ((((azimuth / 360) * bins) % bins) + bins) % bins;
      const low = Math.floor(position);
      const blend = position - low;
      return result.elevationDeg[low] * (1 - blend) + result.elevationDeg[(low + 1) % bins] * blend;
    };
    const isBelowHorizon = (x: number, y: number) => {
      const ndcX = (x / width) * 2 - 1;
      const ndcY = 1 - (y / height) * 2;
      const dx = forward[0] + right[0] * ndcX * tanHalf * aspect + up[0] * ndcY * tanHalf;
      const dy = forward[1] + right[1] * ndcX * tanHalf * aspect + up[1] * ndcY * tanHalf;
      const dz = forward[2] + right[2] * ndcX * tanHalf * aspect + up[2] * ndcY * tanHalf;
      const length = Math.hypot(dx, dy, dz);
      const azimuth = (Math.atan2(dx, dy) * 180) / Math.PI;
      const elevation = (Math.asin(dz / length) * 180) / Math.PI;
      return elevation <= horizonAt(azimuth);
    };
    const columns = Math.ceil(width / SKYLINE_COLUMN_STEP) + 1;
    const ys = new Float32Array(columns);
    for (let column = 0; column < columns; column++) {
      const x = Math.min(column * SKYLINE_COLUMN_STEP, width);
      if (!isBelowHorizon(x, height)) {
        ys[column] = Number.NaN;
        continue;
      }
      let top = 0;
      let bottom = height;
      if (isBelowHorizon(x, 0)) bottom = 0;
      for (let step = 0; step < 14 && bottom - top > 0.25; step++) {
        const middle = (top + bottom) / 2;
        if (isBelowHorizon(x, middle)) bottom = middle;
        else top = middle;
      }
      ys[column] = bottom;
    }
    return x => {
      const value = ys[Math.min(Math.max(Math.round(x / SKYLINE_COLUMN_STEP), 0), columns - 1)];
      return Number.isNaN(value) ? null : value;
    };
  }

  // Overlay -----------------------------------------------------------------------------------
  function getDrawnSymbols(): SymbolId[] {
    const symbols: SymbolId[] = ['lake'];
    if (layerState.contours) symbols.push('contour-index', 'contour-minor');
    if (layerState.rock) symbols.push('rock');
    if (layerState.scree) symbols.push('scree');
    if (layerState.trails) symbols.push('trail-hiking', 'trail-mountain', 'trail-alpine');
    if (layerState.stations) symbols.push('station');
    if (layerState.labels) symbols.push('peak');
    if (layerState.shadows && mode === 'panorama' && shadowSource?.field) symbols.push('shadow');
    if (layerState.nebelmeer) symbols.push('nebelmeer');
    return symbols;
  }

  function getTerrainUniforms(): TerrainUniforms {
    const sun = getSun();
    const mix = getPanoramaMix(pose);
    const canvas = deck.getCanvas();
    const layerMask =
      (layerState.contours ? 1 : 0) |
      (layerState.relief ? 2 : 0) |
      (layerState.rock ? 4 : 0) |
      (layerState.scree ? 8 : 0);
    return {
      originSinLatitude: frame.sinLat,
      originCosLatitude: frame.cosLat,
      meridionalRadius: frame.meridionalRadius,
      primeVerticalRadius: frame.primeVerticalRadius,
      earthRadius: frame.earthRadius,
      // The same (1 - k) goes to the terrain, the Nebelmeer, the trails and the labels.
      curvatureScale: curved ? 1 - refractionK : 0,
      refractionK,
      lakeLevel: LAKE_THUN_ELEVATION,
      originHeight: frame.origin.h,
      hazeStrength: 1,
      panoramaMix: mix,
      revealProgress,
      shadowEnabled: layerState.shadows && shadowSource?.field ? 1 : 0,
      layerMask,
      shadowOriginEast: 0,
      shadowOriginNorth: 0,
      shadowSizeMeters: 0,
      // gl_FragCoord and @builtin(position) are in device pixels.
      viewportHeight: canvas?.height ?? height,
      cameraPosition: [...pose.eye],
      sunDirection: sun.direction,
      sunColor: sun.color,
      skyColor: sun.sky
    };
  }

  function buildLayers(): Layer[] {
    const sun = getSun();
    const mix = getPanoramaMix(pose);
    const axes = getCameraAxes(pose);
    const tanHalf = Math.tan((pose.vfov * Math.PI) / 360);
    const effectiveK = curved ? refractionK : 1;
    const trailMode: SceneMode = mix > 0.5 ? 'panorama' : 'plan';
    const layers: Layer[] = [
      new SkyLayer({
        id: 'sky',
        // deck applies layer parameters over the model's: the dome must neither test nor write depth.
        parameters: {depthCompare: 'always', depthWriteEnabled: false},
        visible: layerState.sky,
        sunDirection: sun.direction,
        sunColor: sun.color,
        skyColor: sun.sky,
        panoramaMix: mix,
        cameraForward: axes.forward,
        cameraRight: axes.right,
        cameraUp: axes.up,
        tanHalfVfov: tanHalf,
        aspect: width / height,
        eyeHeight: frame.origin.h + pose.eye[2]
      }),
      new TerrainLayer({
        id: 'terrain',
        coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
        tiles: getDrawnTiles(),
        uniforms: getTerrainUniforms(),
        shadowField: shadowSource?.field ?? null,
        maxLayers: MAX_TILE_LAYERS
      })
    ];
    if (layerState.nebelmeer) {
      layers.push(
        new NebelmeerLayer({
          id: 'nebelmeer',
          coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
          frame,
          baseHeight: LAKE_THUN_ELEVATION,
          density: 0.8,
          falloff: 0.5,
          time: 0,
          enabled: mix > 0.5,
          curvatureScale: curved ? 1 - refractionK : 0,
          cameraPosition: [...pose.eye],
          sunDirection: sun.direction,
          sunColor: sun.color,
          skyColor: sun.sky
        })
      );
    }
    if (layerState.trails && trails.length > 0) {
      // A new closure per tile snapshot: the trail layer re-drapes when it changes.
      if (trailSampler.tiles !== tilesSnapshot) {
        const snapshot = tilesSnapshot;
        trailSampler = {
          tiles: snapshot,
          sample: (lat, lon) => sampleHeight(snapshot, frame, lat, lon)
        };
      }
      layers.push(
        ...makeTrailLayers(trails, frame, trailSampler.sample, trailMode, null, effectiveK, {
          eye: pose.eye,
          metersPerPixelPerMeter: (2 * Math.tan((pose.vfov * Math.PI) / 360)) / height
        })
      );
    }

    // Screen layers. They wait for the lift to finish: a tilted plan has no honest overlay.
    placedLabels = [];
    if (!flying) {
      const project = (enu: [number, number, number]) => projectToScreen(pose, enu, width, height);
      // Names stay clear of the neatline margin, where the graticule numbers sit.
      const inset = 34;
      const projectInside = (enu: [number, number, number]) => {
        const p = project(enu);
        return p && p[0] > inset && p[0] < width - inset && p[1] > inset && p[1] < height - inset
          ? p
          : null;
      };
      const overlayMode = mode;
      if (layerState.labels && peaks.length > 0) {
        const visibleIds = new Map<string, boolean>();
        if (overlayMode === 'panorama' && ring) {
          peaks.forEach((peak, index) => visibleIds.set(peak.id, ring!.peakVisible[index] === 1));
        }
        const lakeIds = new Set(lakeList.map(lake => lake.id));
        const panoramaReady = overlayMode === 'plan' || ring !== null;
        placedLabels = panoramaReady
          ? placeLabels({
              peaks,
              lakes: lakeList,
              frame,
              project: projectInside,
              visible: id =>
                overlayMode === 'plan' || lakeIds.has(id) || visibleIds.get(id) === true,
              viewport: {width, height},
              mode: overlayMode,
              refractionK: effectiveK,
              skyline: overlayMode === 'panorama' && ring ? makeSkyline(ring) : undefined
            })
          : [];
        layers.push(...toTextLayers(placedLabels, overlayMode, {reveal: revealProgress}));
      }
      diagnostics.labelsPlaced = placedLabels.length;
      if (layerState.stations && stations.length > 0) {
        layers.push(...makeStationLayers(stations, frame, project, selectedStationId, overlayMode));
      }
      if (layerState.skyline && overlayMode === 'panorama') {
        layers.push(
          ...makeSkylineLayers(skylines, ring, project, [0, 0, 0], overlayMode, selectedStationId)
        );
      }
      if (layerState.ring && overlayMode === 'panorama' && ring) {
        const skyline = makeSkyline(ring);
        const path: [number, number][] = [];
        for (let x = 0; x <= width; x += SKYLINE_COLUMN_STEP) {
          const y = skyline(x);
          if (y !== null) path.push([x, y]);
        }
        layers.push(
          new PathLayer({
            id: 'screen-ring',
            data: [{path}],
            getPath: (d: {path: [number, number][]}) => d.path,
            getColor: [48, 98, 107, 230],
            getWidth: 1.5,
            widthUnits: 'pixels',
            parameters: {depthCompare: 'always', depthWriteEnabled: false}
          })
        );
      }
    }
    return layers;
  }

  // Render ------------------------------------------------------------------------------------
  let furniture = null as Furniture | null;

  function render(): void {
    if (diagnostics.finalized || !device) return;
    // Re-snapshot the tile list (and with it the trail drape) at most every 150 ms while it grows.
    if (tilesSnapshot.length !== streamer.tiles.length) {
      const now = performance.now();
      if (now - tilesDirtyAt > 150 || tilesSnapshot.length === 0) {
        tilesSnapshot = streamer.tiles.slice();
      } else {
        setTimeout(scheduleRender, 160);
      }
    }
    diagnostics.mode = mode;
    diagnostics.minutes = minutes;
    diagnostics.pose = clonePose(pose);
    deck.setProps({viewState: getViewState(), layers: debugLayers ? debugLayers() : buildLayers()});
    if (furniture && !flying) {
      furniture.update({
        pose,
        viewport: {w: width, h: height},
        mode,
        drawnSymbols: getDrawnSymbols(),
        originFrame: frame
      });
    }
    updateNumbers();
  }

  // Numbers drawer ----------------------------------------------------------------------------
  function updateNumbers(): void {
    if (!numbersPanel) return;
    const sun = getSun();
    const peak = selectedPeakId ? peaks.find(candidate => candidate.id === selectedPeakId) : null;
    const effectiveK = curved ? refractionK : 1;
    let peakState: NumbersState['peak'] = null;
    if (peak) {
      const {distance, bearing} = haversine(
        {lat: SUMMIT_EYE.lat, lon: SUMMIT_EYE.lon},
        {lat: peak.lat, lon: peak.lon}
      );
      const [east, north, up] = frame.toEnu(peak.lat, peak.lon, peak.ele);
      const index = peaks.indexOf(peak);
      peakState = {
        name: peak.name,
        ele: peak.ele,
        distance,
        bearing,
        elevationAngle: elevationAngle([0, 0, 0], [east, north, up], effectiveK),
        curvatureDrop: curvatureDrop(distance, effectiveK),
        visible: ring ? ring.peakVisible[index] === 1 : true
      };
    }
    numbersPanel.update({
      peak: peakState,
      refractionK,
      sun: {azimuth: sun.azimuth, elevation: sun.elevation, airMass: airMass(sun.elevation)},
      cursor: getCursorState()
    });
  }

  /** Sun hours, first and last light of the field cell under the cursor (CEST strings). */
  function getCursorState(): NumbersState['cursor'] {
    const field = shadowSource?.field;
    if (!cursorEnu || !field || !mosaic) return null;
    const texel = field.sizeMeters / field.size;
    const column = Math.floor((cursorEnu[0] - field.originEnu[0]) / texel);
    const row = Math.floor((field.originEnu[1] - cursorEnu[1]) / texel);
    if (column < 0 || row < 0 || column >= field.size || row >= field.size) return null;
    const terrain = {
      heights: mosaic.heights,
      width: mosaic.width,
      height: mosaic.height,
      metersPerPixel: mosaic.metersPerPixel
    };
    const window = shadowSource!.window;
    const horizon: number[] = [];
    for (let index = 0; index < HORIZON_MAP_AZIMUTHS; index++) {
      horizon.push(
        marchCellF64(
          terrain,
          window,
          column,
          row,
          (index / HORIZON_MAP_AZIMUTHS) * 2 * Math.PI,
          HORIZON_MAP_SAMPLES
        )
      );
    }
    let first = Number.NaN;
    let last = Number.NaN;
    let litMinutes = 0;
    const step = sunTable.length > 1 ? sunTable[1].minutes - sunTable[0].minutes : 5;
    for (const sample of sunTable) {
      const position = ((sample.azimuth / 360) * HORIZON_MAP_AZIMUTHS) % HORIZON_MAP_AZIMUTHS;
      const low = Math.floor(position);
      const blend = position - low;
      const horizonRad =
        horizon[low] * (1 - blend) + horizon[(low + 1) % HORIZON_MAP_AZIMUTHS] * blend;
      if (sample.elevation > (horizonRad * 180) / Math.PI && sample.elevation > -0.5) {
        if (Number.isNaN(first)) first = sample.minutes;
        last = sample.minutes + step;
        litMinutes += step;
      }
    }
    if (Number.isNaN(first)) return {sunHours: 0, firstLight: '–', lastLight: '–'};
    const reduced = sunHoursField ? sunHoursField[row * field.size + column] : litMinutes / 60;
    return {sunHours: reduced, firstLight: formatCest(first), lastLight: formatCest(last)};
  }

  // Compute -----------------------------------------------------------------------------------
  async function startCompute(): Promise<void> {
    await deviceReady;
    const loadedMosaic = await loadMosaic(frame, 11, 3, abortController.signal).catch(error => {
      if (!abortController.signal.aborted) console.warn('Landeskarte: mosaic', error);
      return null;
    });
    if (!loadedMosaic || diagnostics.finalized) return;
    mosaic = loadedMosaic;
    const gpu = device!.type === 'webgpu';
    options.onStatus?.(gpu ? 'Horizontkarte (GPU-Graph) …' : 'Horizontkarte (CPU-Zwilling) …');
    if (gpu) {
      shadowSource = createShadowGraph(
        device!,
        mosaic,
        makeShadowWindow(mosaic, SHADOW_FIELD_SIZE_GPU, 1),
        {
          timestamps: true,
          onProgress: done => {
            horizonPasses = done;
          }
        }
      );
      ringSettled = createRingGraph(device!, mosaic, peaks, frame, {timestamps: true})
        .then(graph => {
          if (diagnostics.finalized) {
            graph.destroy();
            return;
          }
          ringGraph = graph;
          return refreshRing();
        })
        .catch(error => {
          console.warn('Landeskarte: ring graph failed, using the CPU twin', error);
          return refreshRing();
        });
    } else {
      shadowSource = createCpuShadowSource(device!, mosaic);
      ringSettled = refreshRing();
    }
    const source = shadowSource;
    // Publish the compute backend only when the skyline ring has settled too: the labels depend on it.
    await Promise.all([source.ready, ringSettled]);
    if (diagnostics.finalized || source !== shadowSource) return;
    if (source.field) {
      diagnostics.computeBackend = source.field.backend;
      applySunToShadow();
      controls?.setLayerAvailable('shadows', true);
      source
        .sunHours(sunTable)
        .then(hours => {
          sunHoursField = hours;
          scheduleRender();
        })
        .catch(() => {});
    } else {
      controls?.setLayerAvailable('shadows', false);
    }
    collectNodeTimes();
    scheduleRender();
  }

  async function runParity(): Promise<ParityReport> {
    if (!mosaic || !device) throw new Error('Landeskarte: terrain not loaded yet');
    const base = mosaic;
    // The twin's own window: 256 texels, 4 mosaic pixels each, centred on the summit.
    const smallWindow = makeShadowWindow(base, 256, 4);
    const sun = getSun();
    let report: ParityReport;
    const cpuSource = createCpuShadowSource(device, base);
    try {
      const cpuStart = performance.now();
      const cpuMap = await cpuSource.readHorizonMap();
      const cpuMs = performance.now() - cpuStart;
      if (device.type === 'webgpu') {
        const gpuSource = createShadowGraph(device, base, smallWindow, {timestamps: true});
        try {
          const gpuStart = performance.now();
          await gpuSource.ready;
          const gpuMap = await gpuSource.readHorizonMap();
          const gpuMs = performance.now() - gpuStart;
          report = compareParity({
            horizonGpu: gpuMap,
            horizonCpu: cpuMap,
            toleranceDeg: 0.005,
            cpuMs,
            gpuMs,
            shadow: {
              gpu: shadeAtTimeCpu(
                gpuMap,
                smallWindow,
                HORIZON_MAP_AZIMUTHS,
                sun.azimuth,
                sun.elevation
              ),
              cpu: shadeAtTimeCpu(
                cpuMap,
                smallWindow,
                HORIZON_MAP_AZIMUTHS,
                sun.azimuth,
                sun.elevation
              ),
              azimuths: HORIZON_MAP_AZIMUTHS,
              sunAzimuth: sun.azimuth,
              sunElevation: sun.elevation
            }
          });
          report.subject = 'horizon-map GPU graph vs CPU twin';
        } finally {
          gpuSource.destroy();
        }
      } else {
        // No GPU graph on WebGL2: compare the twin with a direct double-precision march instead.
        const terrain = {
          heights: base.heights,
          width: base.width,
          height: base.height,
          metersPerPixel: base.metersPerPixel
        };
        let maxAbs = 0;
        let over = 0;
        let identical = 0;
        let total = 0;
        const start = performance.now();
        for (let row = 8; row < 256; row += 32) {
          for (let column = 8; column < 256; column += 32) {
            for (let index = 0; index < HORIZON_MAP_AZIMUTHS; index++) {
              const direct = marchCellF64(
                terrain,
                smallWindow,
                column,
                row,
                (index / HORIZON_MAP_AZIMUTHS) * 2 * Math.PI,
                HORIZON_MAP_SAMPLES
              );
              const twin = dequantizeAngle(
                cpuMap[(row * 256 + column) * HORIZON_MAP_AZIMUTHS + index]
              );
              const differenceDeg = (Math.abs(direct - twin) * 180) / Math.PI;
              maxAbs = Math.max(maxAbs, differenceDeg);
              if (differenceDeg > 0.005) over++;
              if (differenceDeg < 1e-9) identical++;
              total++;
            }
          }
        }
        report = {
          subject: 'horizon-map CPU twin vs f64 march (64 cells)',
          maxAbsDeg: maxAbs,
          overTolerance: over,
          toleranceDeg: 0.005,
          bitIdentical: identical,
          total,
          shadowFlips: 0,
          flipsWithinUlpBand: true,
          cpuMs: cpuMs + (performance.now() - start),
          gpuMs: 0
        };
      }
    } finally {
      cpuSource.destroy();
    }
    if (ring && mosaic && ringGraph) {
      const twin = computeRingCpu(
        mosaic,
        frame,
        peaks,
        curved ? refractionK : 1,
        getRingEyeHeight(),
        NUMBER_OF_RING_BINS
      );
      let worst = 0;
      for (let bin = 0; bin < twin.bins; bin++) {
        worst = Math.max(worst, Math.abs(twin.elevationDeg[bin] - ring.elevationDeg[bin]));
      }
      console.info(`Landeskarte: ring GPU vs CPU twin max ${worst.toExponential(2)} deg`);
    }
    diagnostics.parity = report;
    scheduleRender();
    return report;
  }

  // Mode, flight, selection -------------------------------------------------------------------
  function setPose(next: ViewPose): void {
    if (flying) return;
    pose = next;
    if (mode === 'panorama' && ringGraph === null && ring !== null) {
      // The panorama lens never leaves the origin: the ring stays valid while the view turns.
    }
    requestTilesSoon();
    scheduleRender();
  }

  function setMode(next: SceneMode): Promise<void> {
    if (next === mode && !flying) return waitForFrame();
    flight?.cancel();
    const target = next === 'panorama' ? getPanoramaPose() : makePlanPose();
    mode = next;
    controls?.setMode(next);
    requestTilesFor(target);
    selectedPeakId = null;
    const duration = reducedMotion ? 0 : automated ? FLIGHT_MS_AUTOMATED : FLIGHT_MS;
    flying = true;
    furniture?.setReveal(0);
    clearPlate();
    return new Promise(resolve => {
      flight = createFlight(
        clonePose(pose),
        target,
        duration,
        flightPose => {
          pose = flightPose;
          diagnostics.pose = clonePose(flightPose);
          scheduleRender();
        },
        () => {
          flying = false;
          flight = null;
          pose = clonePose(target);
          diagnostics.pose = clonePose(target);
          if (mode === 'panorama') void refreshRing();
          furniture?.setReveal(1);
          if (selectedStationId) showPlate(selectedStationId);
          waitForFrame().then(resolve);
        }
      );
    });
  }

  function clearPlate(): void {
    plateHost?.replaceChildren();
  }

  function showPlate(id: string | null): void {
    clearPlate();
    const station = id ? stations.find(candidate => candidate.id === id) : undefined;
    if (!station || !plateHost) return;
    const plate = renderWegweiser(station, formatCest(station.minutes));
    const skyline = skylines.find(candidate => candidate.id === station.id);
    if (skyline && ring) {
      // How far the photo's neural skyline sits from the DEM horizon of the GPU ring.
      const stats = skylineResidualStats([skyline], ring, 'ml');
      const line = document.createElement('div');
      line.className = 'lk-wegweiser-line';
      const key = document.createElement('span');
      key.textContent = 'Horizont Δ Median / P90';
      const value = document.createElement('span');
      value.className = 'lk-num';
      value.textContent = `${stats.medianDeg.toFixed(2).replace('.', ',')}° / ${stats.p90Deg.toFixed(2).replace('.', ',')}°`;
      line.append(key, value);
      plate.querySelector('.lk-wegweiser-body')?.append(line);
    }
    plateHost.append(plate);
  }

  function selectStation(id: string | null): Promise<void> {
    selectedStationId = id;
    if (!flying) showPlate(id);
    return waitForFrame();
  }

  function setMinutes(value: number): Promise<void> {
    minutes = clampMinutes(value);
    controls?.setMinutes(minutes);
    applySunToShadow();
    return waitForFrame();
  }

  function setRefraction(value: number): Promise<void> {
    refractionK = value;
    controls?.setK(value);
    void refreshRing();
    return waitForFrame();
  }

  function setLayer(name: LayerName, on: boolean): Promise<void> {
    layerState[name] = on;
    controls?.setLayer(name, on);
    return waitForFrame();
  }

  function snapshot(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      snapshotRequest = canvas => {
        // Copy inside the frame callback: a WebGPU canvas is only readable until it presents.
        const copy = document.createElement('canvas');
        copy.width = canvas.width;
        copy.height = canvas.height;
        const context = copy.getContext('2d')!;
        context.drawImage(canvas, 0, 0);
        copy.toBlob(
          blob => (blob ? resolve(blob) : reject(new Error('snapshot failed'))),
          'image/png'
        );
      };
      scheduleRender();
      deck.redraw('landeskarte snapshot');
    });
  }

  // Pointer: hover, click ---------------------------------------------------------------------
  function pointerToCanvas(event: PointerEvent): [number, number] {
    const rect = deck.getCanvas()!.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  }

  /** Ground point under a canvas pixel, ENU east/north: a plane in plan, a marched ray otherwise. */
  function groundUnder(x: number, y: number): [number, number] | null {
    const {forward, right, up} = getCameraAxes(pose);
    const tanHalf = Math.tan((pose.vfov * Math.PI) / 360);
    const ndcX = (x / width) * 2 - 1;
    const ndcY = 1 - (y / height) * 2;
    const direction = [0, 1, 2].map(
      axis =>
        forward[axis] + right[axis] * ndcX * tanHalf * (width / height) + up[axis] * ndcY * tanHalf
    );
    const length = Math.hypot(direction[0], direction[1], direction[2]);
    const unit = direction.map(value => value / length);
    if (mode === 'plan') {
      const planeUp = 1000 - frame.origin.h;
      const t = (planeUp - pose.eye[2]) / unit[2];
      return t > 0 ? [pose.eye[0] + unit[0] * t, pose.eye[1] + unit[1] * t] : null;
    }
    for (let distance = 60; distance < 30_000; distance += distance * 0.02 + 20) {
      const east = pose.eye[0] + unit[0] * distance;
      const north = pose.eye[1] + unit[1] * distance;
      const {lat, lon} = frame.toGeo([east, north, 0]);
      const ground = sampleHeight(tilesSnapshot, frame, lat, lon);
      if (ground === null) continue;
      const rayUp =
        pose.eye[2] + unit[2] * distance - curvatureDrop(Math.hypot(east, north), refractionK);
      if (rayUp <= ground - frame.origin.h) return [east, north];
    }
    return null;
  }

  let hoverPending = false;
  function onPointerMove(event: PointerEvent): void {
    if (event.buttons !== 0 || flying || hoverPending) return;
    hoverPending = true;
    const [x, y] = pointerToCanvas(event);
    requestAnimationFrame(async () => {
      hoverPending = false;
      if (diagnostics.finalized) return;
      cursorEnu = groundUnder(x, y);
      const id = layerState.stations
        ? await pickStation(deck as never, x, y).catch(() => null)
        : null;
      const canvas = deck.getCanvas();
      if (canvas) canvas.style.cursor = id ? 'pointer' : '';
      updateNumbers();
    });
  }

  let downAt: [number, number, number] | null = null;
  function onPointerDown(event: PointerEvent): void {
    downAt = [event.clientX, event.clientY, performance.now()];
  }
  async function onPointerUp(event: PointerEvent): Promise<void> {
    const start = downAt;
    downAt = null;
    if (!start || flying) return;
    const moved = Math.hypot(event.clientX - start[0], event.clientY - start[1]);
    if (moved > 5 || performance.now() - start[2] > 700) return;
    const [x, y] = pointerToCanvas(event);
    const stationId = layerState.stations
      ? await pickStation(deck as never, x, y).catch(() => null)
      : null;
    if (stationId) {
      await selectStation(stationId === selectedStationId ? null : stationId);
      return;
    }
    // Nearest drawn summit name or marker.
    let best: PlacedLabel | null = null;
    let bestDistance = 22;
    for (const label of placedLabels) {
      if (label.tier === 'lake') continue;
      const distance = Math.min(
        Math.hypot(label.anchor[0] - x, label.anchor[1] - y),
        Math.hypot(label.position[0] - x, label.position[1] - y)
      );
      if (distance < bestDistance) {
        best = label;
        bestDistance = distance;
      }
    }
    if (best) {
      selectedPeakId = best.id === selectedPeakId ? null : best.id;
      updateNumbers();
    }
  }

  // UI ----------------------------------------------------------------------------------------
  function buildUi(): void {
    furniture = createFurniture(parent);
    plateHost = document.createElement('div');
    plateHost.className = 'lk-plate-host';
    parent.append(plateHost);
    const controlsHost = options.controlsHost;
    const drawersHost = options.drawersHost ?? controlsHost;
    if (controlsHost) {
      controls = createControls(controlsHost, {
        onMode: next => void setMode(next),
        onMinutes: value => void setMinutes(value),
        onK: value => void setRefraction(value),
        onLayer: (name, on) => void setLayer(name, on),
        onSnapshot: () => {
          snapshot().then(blob => {
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = 'landeskarte-abendlicht.png';
            link.click();
            setTimeout(() => URL.revokeObjectURL(link.href), 2000);
          });
        },
        onCurvature: value => {
          curved = value;
          void refreshRing();
          scheduleRender();
        }
      });
      controls.setMode(mode);
      controls.setMinutes(minutes);
      controls.setSunTable(sunTable);
      controls.setK(refractionK);
      controls.setCurved(curved);
      for (const [name, on] of Object.entries(layerState)) controls.setLayer(name as LayerName, on);
      controls.setLayerAvailable('shadows', false);
      controls.setLayerAvailable('ring', false);
    }
    if (drawersHost) {
      numbersPanel = createNumbersPanel(drawersHost);
      hud = createHud(drawersHost, {onRunParity: () => void runParity()});
    }
  }

  // Ready -------------------------------------------------------------------------------------
  function startReveal(): void {
    if (!revealEnabled) {
      revealProgress = 1;
      diagnostics.revealDone = true;
      furniture?.setReveal(1);
      return;
    }
    furniture?.setReveal(0);
    const start = performance.now();
    const step = (now: number) => {
      if (diagnostics.finalized) return;
      const t = clampUnit((now - start) / REVEAL_MS);
      revealProgress = t;
      scheduleRender();
      if (t >= 1) {
        diagnostics.revealDone = true;
        furniture?.setReveal(1);
        return;
      }
      if (t > 0.7) furniture?.setReveal(1);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  const ready = Promise.race([
    failed,
    (async () => {
      await deviceReady;
      const [loadedStations, loadedPeaks, loadedTrails, loadedSkylines] = await Promise.all([
        loadStations(),
        loadPeaks(),
        loadTrails(),
        loadPhotoSkylines(),
        loadLabelFonts()
      ]);
      stations = loadedStations;
      peaks = dedupePeaks(loadedPeaks);
      trails = loadedTrails;
      skylines = loadedSkylines;
      diagnostics.stationsLoaded = stations.length;
      controls?.setStations(stations);
      buildUi();
      controls?.setStations(stations);
      attachInput();
      applySunToShadow();
      requestTilesFor(pose);
      void startCompute();
      // Wait for the first batch so the reveal starts on a drawn sheet.
      const deadline = performance.now() + 90_000;
      while (
        streamer.stats.loaded + streamer.stats.failed < streamer.stats.requested &&
        performance.now() < deadline &&
        !diagnostics.finalized
      ) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      tilesSnapshot = streamer.tiles.slice();
      // Then prefetch the other mode's tiles so the lift does not wait on the network.
      if (!prefetchedOtherMode) {
        prefetchedOtherMode = true;
        requestTilesFor(mode === 'plan' ? getPanoramaPose() : makePlanPose(), false);
      }
      scheduleRender();
      await waitForFrame();
      startReveal();
      await waitForFrame();
    })()
  ]);

  function attachInput(): void {
    const canvas = deck.getCanvas();
    if (!canvas) return;
    detachControls = attachOrbitControls(canvas, {
      getPose: () => pose,
      setPose,
      mode: () => mode
    });
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointerup', onPointerUp);
  }

  return {
    deck,
    debugState() {
      return {
        ringBins: ring?.bins,
        trailSample: trailSampler.sample,
        trails,
        peaks: peaks.map((peak, index) => ({
          name: peak.name,
          ele: peak.ele,
          vis: ring?.peakVisible[index],
          margin: ring?.peakMarginDeg[index],
          xy: projectToScreen(
            pose,
            (() => {
              const e = frame.toEnu(peak.lat, peak.lon, peak.ele);
              return [e[0], e[1], e[2] - curvatureDrop(Math.hypot(e[0], e[1]), refractionK)] as [
                number,
                number,
                number
              ];
            })(),
            width,
            height
          )
        })),
        placed: placedLabels.length
      };
    },
    setDebugLayers(fn: (() => Layer[]) | null) {
      debugLayers = fn;
    },
    ready,
    diagnostics,
    waitForFrame,
    setMode,
    setMinutes,
    setRefraction,
    selectStation,
    setLayer,
    runParity,
    snapshot,
    finalize() {
      if (diagnostics.finalized) return;
      diagnostics.finalized = true;
      abortController.abort();
      flight?.cancel();
      clearTimeout(tileRequestTimer);
      const canvas = deck.getCanvas();
      canvas?.removeEventListener('pointermove', onPointerMove);
      canvas?.removeEventListener('pointerdown', onPointerDown);
      canvas?.removeEventListener('pointerup', onPointerUp);
      detachControls?.();
      controls?.destroy();
      furniture?.destroy();
      plateHost?.remove();
      shadowSource?.destroy();
      ringGraph?.destroy();
      deck.finalize();
    }
  };
}
