// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Terrarium DEM tiles for the Landeskarte example: which tiles to draw for a camera, how to fetch
// and decode them, and CPU queries (height, sight line) that agree with the rendered surface.
//
// The terrain mesh is a 129 x 129 grid per tile, so CPU heights are bilinear interpolations of the
// same 129 x 129 vertex elevations the GPU displaces (not of the raw 512 px pixels): a label or
// trail placed with `sampleHeight` then sits on the drawn surface, not 1 m beside it.

import {REFRACTION_K, curvatureDrop} from '../geo/geodesy';
import type {ENU, Frame, LoadedTile, TileKey, ViewPose} from '../types';

/** Mapterhorn: 512 px Terrarium-encoded WebP elevation tiles, CORS enabled. */
export const DEM_TILE_URL = 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp';
export const DEM_TILE_SIZE = 512;
/** Mesh quads per tile edge; a vertex every 4 DEM pixels. */
export const GRID_SEGMENTS = 128;
/** The selection never returns more tiles than the shared texture array is sized for. */
export const MAX_TILES = 180;

const DEG = Math.PI / 180;
const VERTICES_PER_EDGE = GRID_SEGMENTS + 1;
const MAX_CONCURRENT_REQUESTS = 6;
/** Matches the example's texture array depth (`MAX_TILE_LAYERS` in app.ts). */
const DEFAULT_MAX_LAYERS = 256;
/** The quadtree starts at zoom 6 (about 400 km wide), which covers the 150 km panorama radius. */
const START_ZOOM = 6;

/** Terrarium: h = 256 R + G + B / 256 - 32768, so (128, 0, 0) is exactly 0 m. */
export function decodeTerrarium(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

/** Inverse of `decodeTerrarium`, clamped to the representable range, for synthetic tiles. */
export function encodeTerrarium(height: number): [number, number, number] {
  const scaled = Math.round((Math.min(Math.max(height, -32768), 32767.99) + 32768) * 256);
  return [(scaled >> 16) & 255, (scaled >> 8) & 255, scaled & 255];
}

export function tileId(z: number, x: number, y: number): string {
  return `${z}/${x}/${y}`;
}

export function tileUrl(key: Pick<TileKey, 'z' | 'x' | 'y'>): string {
  return DEM_TILE_URL.replace('{z}', String(key.z))
    .replace('{x}', String(key.x))
    .replace('{y}', String(key.y));
}

/** Fractional Web Mercator tile coordinates of a point at zoom z. */
export function tileCoordinates(z: number, lon: number, lat: number): [number, number] {
  const sinLat = Math.sin(lat * DEG);
  const x = ((lon + 180) / 360) * 2 ** z;
  const y = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * 2 ** z;
  return [x, y];
}

/** Latitude (radians) of the north edge of row y, or of a fractional row. */
function tileLatitude(z: number, y: number): number {
  return Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z)));
}

/** Horizontal placement of a tile relative to the eye, kept internal for culling. */
type PlacedTile = {key: TileKey; eastGap: number; northGap: number; corners: [number, number][]};

function placeTile(frame: Frame, eye: ENU, z: number, x: number, y: number): PlacedTile {
  const originLat = frame.origin.lat * DEG;
  const originLon = frame.origin.lon * DEG;
  const west = (x / 2 ** z) * 2 * Math.PI - Math.PI;
  const east = ((x + 1) / 2 ** z) * 2 * Math.PI - Math.PI;
  const latitudeOffsets: [number, number, number] = [
    tileLatitude(z, y) - originLat,
    tileLatitude(z, y + 0.5) - originLat,
    tileLatitude(z, y + 1) - originLat
  ];
  const longitudeOffsets: [number, number] = [west - originLon, east - originLon];
  // Corners at sea level (heights scale the ground distance by 1e-4 at most: irrelevant for culling).
  const corner = (latitudeOffset: number, longitudeOffset: number): [number, number] => {
    const enu = frame.toEnu(
      frame.origin.lat + latitudeOffset / DEG,
      frame.origin.lon + longitudeOffset / DEG,
      frame.origin.h
    );
    return [enu[0] - eye[0], enu[1] - eye[1]];
  };
  const corners = [
    corner(latitudeOffsets[0], longitudeOffsets[0]),
    corner(latitudeOffsets[0], longitudeOffsets[1]),
    corner(latitudeOffsets[2], longitudeOffsets[0]),
    corner(latitudeOffsets[2], longitudeOffsets[1])
  ];
  // The tile is a Mercator rectangle that is nearly a plan rectangle: gaps from its corner extremes.
  const minEast = Math.min(corners[0][0], corners[2][0]);
  const maxEast = Math.max(corners[1][0], corners[3][0]);
  const minNorth = Math.min(corners[2][1], corners[3][1]);
  const maxNorth = Math.max(corners[0][1], corners[1][1]);
  const eastGap = Math.max(minEast, 0, -maxEast);
  const northGap = Math.max(minNorth, 0, -maxNorth);
  return {
    key: {
      z,
      x,
      y,
      latitudeOffsets,
      longitudeOffsets,
      distance: Math.hypot(eastGap, northGap)
    },
    eastGap,
    northGap,
    corners
  };
}

/** True when any part of the tile lies within the horizontal view wedge (headings in degrees). */
function isInWedge(tile: PlacedTile, heading: number, halfWidth: number): boolean {
  if (tile.key.distance === 0 || halfWidth >= 180) return true;
  // Double modulo: a yaw below -540 (an unwrapped flight yaw) would give a negative remainder.
  const relative = tile.corners.map(
    ([east, north]) => ((((Math.atan2(east, north) / DEG - heading + 540) % 360) + 360) % 360) - 180
  );
  const minimum = Math.min(...relative);
  const maximum = Math.max(...relative);
  // A tile that wraps through +-180 degrees lies behind the camera.
  return maximum - minimum < 180 && maximum >= -halfWidth && minimum <= halfWidth;
}

export type SelectTilesOptions = {
  /**
   * Panorama: how far to draw, metres (default 150 km). Plan: half the side of the square around
   * the eye (default: the camera footprint, with margin for rotation).
   */
  maxDistance?: number;
  /** Finest zoom (default 14, 3.3 m per pixel at the summit). */
  maxZoom?: number;
  /** Coarsest zoom: tiles are split until they are at least this fine (default 9, 53 km wide). */
  minZoom?: number;
  /** Wedge cull for a looking-out camera. Default: true unless the camera looks steeply down. */
  wedge?: boolean;
  /** Viewport width / height, for the wedge width and the plan footprint (default 16 / 9). */
  aspect?: number;
  /** A tile splits while its width exceeds `detail` x its distance. Smaller is finer. */
  detail?: number;
};

/**
 * Quadtree selection: fine tiles near the eye, coarse ones far away, nearest first. In plan (a
 * camera looking down) the tiles tile a square around the eye; for a panorama only the view wedge
 * is covered. When the result exceeds MAX_TILES the detail is relaxed until it fits, which keeps
 * the quadtree free of holes (cutting the far end of a sorted list would not).
 */
export function selectTiles(
  frame: Frame,
  pose: ViewPose,
  opts: SelectTilesOptions = {}
): TileKey[] {
  const {maxZoom = 14, minZoom = 9, aspect = 16 / 9} = opts;
  const wedge = opts.wedge ?? pose.pitch > -60;
  const eye = pose.eye;
  const tanHalf = Math.tan((pose.vfov / 2) * DEG);
  const maxDistance = wedge
    ? (opts.maxDistance ?? 150_000)
    : (opts.maxDistance ??
      Math.max(2000, Math.abs(eye[2]) * tanHalf * Math.hypot(1, aspect) * 1.1));
  // Azimuth half-width of the frustum. Rays through the top and bottom edges have horizontal
  // component cos(pitch) - tanV sin(pitch): a camera looking steeply down sees ground well to the
  // side of its heading near the eye, so the wedge widens as that component shrinks (all round
  // when the nadir is in view). Margin for roll and for terrain that rises into the frame.
  const pitchRad = pose.pitch * DEG;
  const forwardReach = Math.min(
    Math.cos(pitchRad) - tanHalf * Math.sin(pitchRad),
    Math.cos(pitchRad) + tanHalf * Math.sin(pitchRad)
  );
  const frustumHalfWidth =
    forwardReach <= 0.05 ? 180 : Math.atan((tanHalf * aspect) / forwardReach) / DEG;
  const halfWidth = frustumHalfWidth + Math.abs(pose.roll) + 10;

  const eyeGeo = frame.toGeo([eye[0], eye[1], 0]);
  const [centerX, centerY] = tileCoordinates(START_ZOOM, eyeGeo.lon, eyeGeo.lat);

  const collect = (detail: number): TileKey[] => {
    const selected: TileKey[] = [];
    const visit = (z: number, x: number, y: number) => {
      const tile = placeTile(frame, eye, z, x, y);
      const outside = wedge
        ? tile.key.distance > maxDistance || !isInWedge(tile, pose.yaw, halfWidth)
        : Math.max(tile.eastGap, tile.northGap) > maxDistance;
      if (outside) return;
      const width =
        frame.primeVerticalRadius *
        frame.cosLat *
        (tile.key.longitudeOffsets[1] - tile.key.longitudeOffsets[0]);
      const wantsSplit = width > detail * Math.max(tile.key.distance, 200);
      if (z < maxZoom && (z < minZoom || wantsSplit)) {
        for (let child = 0; child < 4; child++)
          visit(z + 1, 2 * x + (child & 1), 2 * y + (child >> 1));
      } else {
        selected.push(tile.key);
      }
    };
    for (let x = Math.floor(centerX) - 1; x <= Math.floor(centerX) + 1; x++) {
      for (let y = Math.floor(centerY) - 1; y <= Math.floor(centerY) + 1; y++) {
        visit(START_ZOOM, x, y);
      }
    }
    return selected;
  };

  let detail = opts.detail ?? 0.75;
  let selected = collect(detail);
  for (let attempt = 0; selected.length > MAX_TILES && attempt < 12; attempt++) {
    detail *= 1.3;
    selected = collect(detail);
  }
  selected.sort((a, b) => a.distance - b.distance || b.z - a.z);
  return selected.slice(0, MAX_TILES);
}

/** Bilinear elevation at tile fraction (u, v); pixel centres sit at (i + 0.5) / 512. */
function sampleRgba(rgba: Uint8Array, u: number, v: number): number {
  const maximum = DEM_TILE_SIZE - 1;
  const x = Math.min(Math.max(u * DEM_TILE_SIZE - 0.5, 0), maximum);
  const y = Math.min(Math.max(v * DEM_TILE_SIZE - 0.5, 0), maximum);
  const left = Math.floor(x);
  const top = Math.floor(y);
  const right = Math.min(left + 1, maximum);
  const bottom = Math.min(top + 1, maximum);
  const horizontal = x - left;
  const vertical = y - top;
  const at = (column: number, row: number): number => {
    const offset = (row * DEM_TILE_SIZE + column) * 4;
    return decodeTerrarium(rgba[offset], rgba[offset + 1], rgba[offset + 2]);
  };
  const upper = at(left, top) * (1 - horizontal) + at(right, top) * horizontal;
  const lower = at(left, bottom) * (1 - horizontal) + at(right, bottom) * horizontal;
  return upper * (1 - vertical) + lower * vertical;
}

/** Heights at the 129 x 129 mesh vertices, row 0 = north, for CPU queries. */
export function getVertexElevations(rgba: Uint8Array): Float32Array {
  const elevations = new Float32Array(VERTICES_PER_EDGE * VERTICES_PER_EDGE);
  for (let row = 0; row < VERTICES_PER_EDGE; row++) {
    for (let column = 0; column < VERTICES_PER_EDGE; column++) {
      elevations[row * VERTICES_PER_EDGE + column] = sampleRgba(
        rgba,
        column / GRID_SEGMENTS,
        row / GRID_SEGMENTS
      );
    }
  }
  return elevations;
}

/** Fetches a tile and returns its raw RGBA bytes (for the GPU). Rejects on HTTP errors. */
export async function fetchTileRgba(key: TileKey, signal: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(tileUrl(key), {signal});
  if (!response.ok) throw new Error(`${response.status} ${response.url}`);
  // Elevations live in the colour bytes: no colour management, no premultiplication.
  const bitmap = await createImageBitmap(await response.blob(), {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none'
  });
  const canvas = new OffscreenCanvas(DEM_TILE_SIZE, DEM_TILE_SIZE);
  const context = canvas.getContext('2d', {willReadFrequently: true})!;
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return new Uint8Array(context.getImageData(0, 0, DEM_TILE_SIZE, DEM_TILE_SIZE).data.buffer);
}

export function makeLoadedTile(key: TileKey, layer: number, rgba: Uint8Array): LoadedTile {
  return {...key, layer, rgba, elevations: getVertexElevations(rgba)};
}

/** `dropped` counts tiles that arrived after every texture layer was taken, and are not drawn. */
export type TileStreamerStats = {
  requested: number;
  loaded: number;
  failed: number;
  dropped: number;
};

export type TileStreamerOptions = {
  /** Replaces the network fetch, for tests and offline use. */
  fetchRgba?: (key: TileKey, signal: AbortSignal) => Promise<Uint8Array>;
  concurrency?: number;
  /** Texture array depth: layers are never recycled, so tiles beyond this are dropped and counted. */
  maxLayers?: number;
};

/**
 * Fetches tiles with bounded concurrency, nearest first. Each `request` replaces the queue of
 * tiles that have not started (a flight changes what is needed), never cancels one in flight, and
 * never refetches a tile already requested. Layers are assigned in arrival order.
 */
export class TileStreamer {
  readonly stats: TileStreamerStats = {requested: 0, loaded: 0, failed: 0, dropped: 0};
  /** Every tile delivered so far, in layer order. */
  readonly tiles: LoadedTile[] = [];

  private readonly onTile: (tile: LoadedTile) => void;
  private readonly signal: AbortSignal;
  private readonly fetchRgba: (key: TileKey, signal: AbortSignal) => Promise<Uint8Array>;
  private readonly concurrency: number;
  private readonly maxLayers: number;
  private readonly seen = new Set<string>();
  private queue: TileKey[] = [];
  private active = 0;

  constructor(
    onTile: (tile: LoadedTile) => void,
    signal: AbortSignal,
    options: TileStreamerOptions = {}
  ) {
    this.onTile = onTile;
    this.signal = signal;
    this.fetchRgba = options.fetchRgba ?? fetchTileRgba;
    this.concurrency = options.concurrency ?? MAX_CONCURRENT_REQUESTS;
    this.maxLayers = options.maxLayers ?? DEFAULT_MAX_LAYERS;
  }

  request(keys: TileKey[]): void {
    // Tiles still waiting from an earlier request are forgotten, and re-queued below only if the
    // new request wants them again, in the new (nearest first) order.
    for (const dropped of this.queue) this.seen.delete(tileId(dropped.z, dropped.x, dropped.y));
    this.stats.requested -= this.queue.length;
    this.queue = [];
    for (const key of keys) {
      const id = tileId(key.z, key.x, key.y);
      if (this.seen.has(id)) continue;
      this.seen.add(id);
      this.queue.push(key);
      this.stats.requested++;
    }
    this.pump();
  }

  private pump(): void {
    while (!this.signal.aborted && this.active < this.concurrency && this.queue.length > 0) {
      const key = this.queue.shift()!;
      this.active++;
      this.fetchRgba(key, this.signal).then(
        rgba => this.finish(key, rgba),
        () => this.fail()
      );
    }
  }

  private finish(key: TileKey, rgba: Uint8Array): void {
    this.active--;
    try {
      if (!this.signal.aborted && this.tiles.length >= this.maxLayers) {
        // The terrain layer skips tiles past its texture depth: count them instead of a silent hole.
        this.stats.dropped++;
      } else if (!this.signal.aborted) {
        const tile = makeLoadedTile(key, this.tiles.length, rgba);
        this.tiles.push(tile);
        this.stats.loaded++;
        this.onTile(tile);
      }
    } finally {
      // A throwing onTile must not stall the queue.
      this.pump();
    }
  }

  private fail(): void {
    this.active--;
    // An abort is not a failure of the tile.
    if (!this.signal.aborted) this.stats.failed++;
    this.pump();
  }
}

type TileIndex = {byId: Map<string, LoadedTile>; zooms: number[]};

/** Trail layers call `sampleHeight` per vertex: reuse the index while the array is unchanged. */
const indexCache = new WeakMap<readonly LoadedTile[], {length: number; index: TileIndex}>();

/** Tiles by id and the loaded zooms, finest first, for point queries. */
function indexTiles(tiles: readonly LoadedTile[]): TileIndex {
  const cached = indexCache.get(tiles);
  if (cached && cached.length === tiles.length) return cached.index;
  const byId = new Map<string, LoadedTile>();
  const zooms = new Set<number>();
  for (const tile of tiles) {
    byId.set(tileId(tile.z, tile.x, tile.y), tile);
    zooms.add(tile.z);
  }
  const index = {byId, zooms: [...zooms].sort((a, b) => b - a)};
  indexCache.set(tiles, {length: tiles.length, index});
  return index;
}

function sampleIndexed(index: TileIndex, lat: number, lon: number): number | null {
  for (const z of index.zooms) {
    const [x, y] = tileCoordinates(z, lon, lat);
    const tile = index.byId.get(tileId(z, Math.floor(x), Math.floor(y)));
    if (!tile) continue;
    const column = (x - Math.floor(x)) * GRID_SEGMENTS;
    const row = (y - Math.floor(y)) * GRID_SEGMENTS;
    const left = Math.min(Math.floor(column), GRID_SEGMENTS - 1);
    const top = Math.min(Math.floor(row), GRID_SEGMENTS - 1);
    const horizontal = column - left;
    const vertical = row - top;
    const e = tile.elevations;
    const upper =
      e[top * VERTICES_PER_EDGE + left] * (1 - horizontal) +
      e[top * VERTICES_PER_EDGE + left + 1] * horizontal;
    const lower =
      e[(top + 1) * VERTICES_PER_EDGE + left] * (1 - horizontal) +
      e[(top + 1) * VERTICES_PER_EDGE + left + 1] * horizontal;
    return upper * (1 - vertical) + lower * vertical;
  }
  return null;
}

/**
 * Terrain height above sea level from the finest loaded tile under a point, or null outside the
 * loaded terrain. The frame is not needed: tiles are indexed by geographic coordinates.
 */
export function sampleHeight(
  tiles: readonly LoadedTile[],
  _frame: Frame,
  lat: number,
  lon: number
): number | null {
  return sampleIndexed(indexTiles(tiles), lat, lon);
}

/**
 * Marches the sight line from `from` to `to` (ENU, up = h - origin.h) through the loaded terrain
 * in the curved reference of `curvatureDrop`. Returns false when terrain rises more than 5 m above
 * the line before the last 300 m (the target stands on terrain of its own). Unloaded ground is
 * treated as open.
 */
export function isVisible(
  frame: Frame,
  tiles: readonly LoadedTile[],
  from: ENU,
  to: ENU,
  k: number = REFRACTION_K
): boolean {
  const distance = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const steps = Math.ceil(distance / 100);
  if (steps < 2) return true;
  const index = indexTiles(tiles);
  const fromGeo = frame.toGeo([from[0], from[1], 0]);
  const toGeo = frame.toGeo([to[0], to[1], 0]);
  const toApparentUp = to[2] - curvatureDrop(distance, k);
  for (let step = 1; step < steps; step++) {
    const fraction = step / steps;
    const along = distance * fraction;
    if (distance - along < 300) break;
    // Latitude and longitude interpolate linearly: the great-circle bulge is metres at 150 km.
    const lat = fromGeo.lat + (toGeo.lat - fromGeo.lat) * fraction;
    const lon = fromGeo.lon + (toGeo.lon - fromGeo.lon) * fraction;
    const height = sampleIndexed(index, lat, lon);
    if (height === null) continue;
    const terrainUp = height - frame.origin.h - curvatureDrop(along, k);
    const sightUp = from[2] + (toApparentUp - from[2]) * fraction;
    if (terrainUp > sightUp + 5) return false;
  }
  return true;
}
