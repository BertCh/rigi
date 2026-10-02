// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Frozen interfaces for the Landeskarte example (wave 0). Every module codes against these names.
// Only the integrator edits this file. Units: metres, degrees (angles exposed in APIs), UTC minutes
// since 2026-09-07T00:00Z for times. ENU = [east, north, up] metres from the summit origin.

import type {Texture} from '@luma.gl/core';

export type ENU = [east: number, north: number, up: number];
export type Vec3 = [number, number, number];
export type RGB = [number, number, number];
export type RGBA = [number, number, number, number];

/** A geographic position, WGS84, height in metres above sea level. */
export type GeoPoint = {lat: number; lon: number; h: number};

/**
 * Local east/north/up frame at an origin (the summit eye). Small-angle polynomials of the
 * latitude/longitude offsets on the WGS84 radii of curvature, as in summit-view's dem-tiles.ts.
 * `toEnu` returns the planar position with `up = h - origin.h` (no curvature drop: shaders and
 * `curvatureDrop` apply it separately).
 */
export type Frame = {
  origin: GeoPoint;
  sinLat: number;
  cosLat: number;
  /** North-south radius of curvature, metres. */
  meridionalRadius: number;
  /** East-west radius of curvature, metres. */
  primeVerticalRadius: number;
  /** Mean radius used for the curvature drop (EARTH_R). */
  earthRadius: number;
  toEnu(lat: number, lon: number, h: number): ENU;
  toGeo(enu: ENU): GeoPoint;
};

/** A camera pose. Yaw clockwise from north, pitch up positive, roll turns the image clockwise. */
export type ViewPose = {
  /** Lens position in the local frame. */
  eye: ENU;
  yaw: number;
  pitch: number;
  roll: number;
  /** Vertical field of view, degrees. */
  vfov: number;
  near?: number;
  far?: number;
};

export type SceneMode = 'plan' | 'panorama';

export type SunSample = {
  /** UTC minutes since DAY_UTC_MS. */
  minutes: number;
  /** Degrees clockwise from north. */
  azimuth: number;
  /** Apparent elevation in degrees (refracted, unclamped). */
  elevation: number;
  /** Unit vector towards the sun in ENU. */
  direction: Vec3;
  /** Linear RGB of direct sunlight after air-mass extinction, 0..1. */
  color: RGB;
};

/** One photo of the 7 Sep 2026 roll, as geometry only (no pixels ship). */
export type Station = {
  id: string;
  /** ISO time, UTC. */
  takenAtUtc: string;
  /** UTC minutes since DAY_UTC_MS. */
  minutes: number;
  lat: number;
  lon: number;
  /** Lens height above sea level (solved / corrected), metres. */
  h: number;
  /** Solved pose angles, degrees. */
  yaw: number;
  pitch: number;
  roll: number;
  vfov: number;
  /** Width / height of the frame. */
  aspect: number;
  f35: number;
  /** EXIF compass heading, degrees, or null. Shown only as a delta against the solved yaw. */
  exifHeading: number | null;
  /** Solver confidence 0..1. Below 0.7 the station draws dimmed. */
  confidence: number;
};

export type PeakTier = 'peak-major' | 'peak' | 'minor';

export type Peak = {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** Elevation above sea level, metres. */
  ele: number;
  tier: PeakTier;
};

export type SacScale =
  | 'hiking'
  | 'mountain_hiking'
  | 'demanding_mountain_hiking'
  | 'alpine_hiking'
  | 'demanding_alpine_hiking'
  | 'difficult_alpine_hiking'
  | null;

export type TrailWay = {
  id: string;
  name: string | null;
  sac: SacScale;
  /** [lon, lat] pairs. */
  coords: [number, number][];
};

export type LakeLabel = {id: string; name: string; lat: number; lon: number; ele: number};

/** A DEM tile key and its placement relative to the frame origin. */
export type TileKey = {
  z: number;
  x: number;
  y: number;
  /** Latitude of the north edge, Mercator middle and south edge minus the origin, radians. */
  latitudeOffsets: Vec3;
  /** Longitude of the west and east edges minus the origin, radians. */
  longitudeOffsets: [number, number];
  /** Planar distance from the eye to the nearest point of the tile, metres. */
  distance: number;
};

/** A tile whose Terrarium bytes are decoded, with its layer in the shared texture array. */
export type LoadedTile = TileKey & {
  layer: number;
  /** Raw RGBA bytes, DEM_TILE_SIZE^2 * 4, for texture upload. */
  rgba: Uint8Array;
  /** Decoded heights at the 129 x 129 mesh vertices, row 0 = north, for CPU queries. */
  elevations: Float32Array;
};

/**
 * Square heightfield around the summit for compute (z11 Terrarium mosaic decoded on the CPU, or the
 * raw pixels for the GPU decode node). Row 0 = north. Pixel (i, j) centre in ENU is
 * `originEnu + [(i + 0.5) * metersPerPixel, -(j + 0.5) * metersPerPixel]` (approximate: Mercator
 * scale folded at the summit latitude).
 */
export type Mosaic = {
  zoom: number;
  width: number;
  height: number;
  /** Raw Terrarium pixels, little-endian `r | g << 8 | b << 16 | a << 24`. */
  pixels: Uint32Array;
  /** Decoded heights, metres, Float32. */
  heights: Float32Array;
  metersPerPixel: number;
  /** ENU east/north of the top-left corner of the mosaic. */
  originEnu: [number, number];
};

export type MosaicInfo = Omit<Mosaic, 'pixels' | 'heights'>;

/** Window of the mosaic covered by the shadow field (square, centred on the summit). */
export type ShadowWindow = {
  /** Top-left pixel of the window in the mosaic. */
  column: number;
  row: number;
  /** Side length in field texels. */
  size: number;
  /** Mosaic pixels per field texel (1 on WebGPU, 4 for the CPU twin at 256^2). */
  stride: number;
};

/**
 * Cast-shadow and sky-view fields sampled by the terrain fragment shader. Both are r8unorm 2d
 * textures of `size^2`, north row first. `shadow` = 1 lit, 0 shadowed. `ambient` = sky-view factor.
 * Texel (i, j) covers ENU east `originEnu[0] + (i + 0.5) * sizeMeters / size`, north
 * `originEnu[1] - (j + 0.5) * sizeMeters / size`.
 */
export type ShadowField = {
  shadow: Texture;
  ambient: Texture;
  size: number;
  sizeMeters: number;
  /** ENU east/north of the top-left (north-west) corner. */
  originEnu: [number, number];
  backend: 'graph' | 'cpu-twin';
};

export type RingResult = {
  /** Horizon tangent (max over the ray of (h - h_eye)/d - d(1-k)/(2R)) per azimuth bin. */
  tangents: Float32Array;
  /** atan(tangent) in degrees per bin. */
  elevationDeg: Float32Array;
  /** 1 if the peak top clears the horizon along its own ray, per peak (same order as input). */
  peakVisible: Uint32Array;
  /** Peak elevation angle minus the terrain horizon in front of it, degrees. */
  peakMarginDeg: Float32Array;
  bins: number;
};

/** One row of a graph inspector table. */
export type NodeRow = {
  graph: 'ring' | 'shadow';
  id: string;
  type: string;
  outcome: 'executed' | 'skipped' | 'gpu-resolved';
  gpuMs?: number;
};

export type ParityReport = {
  /** What was compared, e.g. 'ring' or 'horizon-map' or 'shadow'. */
  subject: string;
  maxAbsDeg: number;
  overTolerance: number;
  toleranceDeg: number;
  bitIdentical: number;
  total: number;
  /** Shadow bits that differ between GPU and CPU. */
  shadowFlips: number;
  /** True when every flipped shadow bit lies within the ULP band at the threshold. */
  flipsWithinUlpBand: boolean;
  cpuMs: number;
  gpuMs: number;
  /** SUN_HOURS kernel against a CPU sum on the same horizon map (WebGPU only). */
  sunHours?: {maxAbsHours: number; toleranceHours: number; overTolerance: number; total: number};
  /** Ring graph against its CPU twin, run with the same k and eye height (WebGPU only). */
  ring?: {
    maxAbsDeg: number;
    toleranceDeg: number;
    bins: number;
    refractionK: number;
    eyeHeight: number;
  };
};

export type LayerName =
  | 'contours'
  | 'relief'
  | 'rock'
  | 'scree'
  | 'trails'
  | 'stations'
  | 'labels'
  | 'shadows'
  | 'sky'
  | 'nebelmeer'
  | 'ring'
  | 'skyline';

/** Symbols that can appear in the legend: the legend lists only what is drawn. */
export type SymbolId =
  | 'contour-index'
  | 'contour-minor'
  | 'rock'
  | 'scree'
  | 'lake'
  | 'trail-hiking'
  | 'trail-mountain'
  | 'trail-alpine'
  | 'station'
  | 'peak'
  | 'shadow'
  | 'nebelmeer';

export type Diagnostics = {
  frames: number;
  backend: 'webgpu' | 'webgl' | '';
  error: string;
  finalized: boolean;
  tilesRequested: number;
  tilesLoaded: number;
  tilesFailed: number;
  /** Tiles that arrived after every texture-array layer was taken (not drawn). */
  tilesDropped: number;
  computeBackend: 'graph' | 'cpu-twin' | 'none';
  shadowPasses: number;
  graphNodeMs: Record<string, number>;
  parity: ParityReport | null;
  labelsPlaced: number;
  stationsLoaded: number;
  revealDone: boolean;
  mode: SceneMode;
  minutes: number;
  /** Current sun, for the HUD and the smoke test. */
  sunAzimuth: number;
  sunElevation: number;
  /** Final pose of the last flight (for the exact-frame assertion). */
  pose: ViewPose | null;
};

export type SceneOptions = {
  mode?: SceneMode;
  /** UTC minutes since DAY_UTC_MS; default 13:28 UTC (15:28 CEST, the first photo). */
  minutes?: number;
  /** Play the load reveal. Off under webdriver or prefers-reduced-motion. */
  reveal?: boolean;
  /** Called after each redraw with the latest diagnostics. */
  onUpdate?: (diagnostics: Diagnostics) => void;
};

/**
 * Terrain uniforms. Field order here = WGSL struct order = GLSL std140 block order = the order of
 * `uniformTypes` in terrain-module.ts (luma packs vec3 alignment itself, as in summit-view).
 */
export type TerrainUniforms = {
  // Frame (positions)
  originSinLatitude: number;
  originCosLatitude: number;
  meridionalRadius: number;
  primeVerticalRadius: number;
  earthRadius: number;
  /** (1 - k) / (2R) multiplier switch: 1 with curvature, 0 flat. */
  curvatureScale: number;
  refractionK: number;
  lakeLevel: number;
  /** Height above sea level of the frame origin (ENU up = h - originHeight). */
  originHeight: number;
  /** Aerial-perspective strength multiplier (1 = physical single scatter). */
  hazeStrength: number;
  // Mode and time
  /** 0 = plan (fixed NW light, no cast shadow), 1 = panorama (sun, cast shadow). */
  panoramaMix: number;
  /** 0..1 reveal progress (relief, then contours, then labels). */
  revealProgress: number;
  /** 1 when a shadow field is bound and valid. */
  shadowEnabled: number;
  /** Bitmask of LayerName toggles that affect the terrain shader: 1 contours, 2 relief, 4 rock, 8 scree. */
  layerMask: number;
  // Shadow field placement
  shadowOriginEast: number;
  shadowOriginNorth: number;
  shadowSizeMeters: number;
  /** Viewport height in pixels, for the bottom-22% panorama darkening. */
  viewportHeight: number;
  // Vectors
  cameraPosition: Vec3;
  sunDirection: Vec3;
  sunColor: Vec3;
  skyColor: Vec3;
};

/**
 * Cast-shadow source: the WebGPU compute graph or the CPU twin (WebGL2). Same shape so the app and
 * the terrain layer never branch on backend. Compute failure leaves `field` null: no cast shadow.
 */
export type ShadowSource = {
  /** Resolves when the horizon map is built and `field` is valid. */
  ready: Promise<void>;
  field: ShadowField | null;
  window: ShadowWindow;
  /** Azimuths in the horizon map (16). */
  azimuths: number;
  /** Re-shade for a sun position (degrees). Cheap: a lookup per texel. */
  setSun(azimuth: number, elevation: number): void;
  /** Hours of direct sun per field texel over the day table (row 0 = north). */
  sunHours(table: SunSample[]): Promise<Float32Array>;
  /** Horizon angles per texel and azimuth, u16 quantised (see README), for parity checks. */
  readHorizonMap(): Promise<Uint16Array>;
  inspectorRows(): NodeRow[];
  destroy(): void;
};

/** GPU skyline ring from the summit eye (WebGPU only). */
export type RingGraph = {
  run(refractionK: number, eyeHeight: number): Promise<RingResult>;
  inspectorRows(): NodeRow[];
  destroy(): void;
};

/** WGSL/GLSL snippet function names. Each snippet file exports a WGSL and a GLSL string. */
export const SNIPPETS = {
  relief: 'lk_relief',
  hypso: 'lk_hypso',
  ink: 'lk_ink',
  scree: 'lk_scree',
  hachure: 'lk_hachure',
  atmosphere: 'lk_atmosphere',
  grade: 'lk_grade'
} as const;

export type PlacedLabel = {
  id: string;
  text: string;
  /** Second line, e.g. tabular altitude "2 970". */
  subtext: string;
  tier: PeakTier | 'lake';
  /** Anchor (the feature) in canvas pixels, y down. */
  anchor: [number, number];
  /** Text position in canvas pixels, y down. */
  position: [number, number];
  /** True when a leader line joins position and anchor. */
  leader: boolean;
  sizePx: number;
};

export type NumbersState = {
  peak: {
    name: string;
    ele: number;
    distance: number;
    bearing: number;
    elevationAngle: number;
    curvatureDrop: number;
    visible: boolean;
  } | null;
  refractionK: number;
  sun: {azimuth: number; elevation: number; airMass: number};
  /** Sun hours at the cursor cell and first/last light, CEST strings. */
  cursor: {sunHours: number; firstLight: string; lastLight: string} | null;
};

/** Seed used everywhere a deterministic jitter or noise is needed. */
export const LANDESKARTE_SEED = 0x4e1d_0907;
