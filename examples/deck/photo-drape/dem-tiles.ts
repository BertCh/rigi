// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type {PhotoCamera} from './scene-data';

/** Mapterhorn: 512 px Terrarium-encoded WebP elevation tiles, CORS enabled. */
export const DEM_TILE_URL = 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp';
export const DEM_TILE_SIZE = 512;
/** Mesh quads per tile edge; a vertex every 4 DEM pixels. */
export const GRID_SEGMENTS = 128;
/** Atmospheric refraction lifts distant terrain as if the earth were 1 / (1 - k) times larger. */
export const REFRACTION_COEFFICIENT = 0.13;

const DEGREES_TO_RADIANS = Math.PI / 180;
const WGS84_SEMI_MAJOR_AXIS = 6378137;
const WGS84_ECCENTRICITY_SQUARED = 0.00669437999014;

type Vector3 = [number, number, number];

/**
 * Local east/north/up frame at the camera. Positions use small-angle polynomials of the
 * latitude and longitude offsets on the WGS84 radii of curvature at the origin, which stay within
 * 0.005° of an exact ellipsoid transform out to 150 km and need no large-argument trigonometry in
 * single-precision shaders.
 */
export type LocalFrame = {
  longitude: number;
  latitude: number;
  sinLatitude: number;
  cosLatitude: number;
  /** North-south radius of curvature, metres. */
  meridionalRadius: number;
  /** East-west radius of curvature, metres. */
  primeVerticalRadius: number;
  /** Gaussian mean radius, used for the curvature drop. */
  earthRadius: number;
};

export function makeLocalFrame(longitude: number, latitude: number): LocalFrame {
  const sinLatitude = Math.sin(latitude * DEGREES_TO_RADIANS);
  const denominator = 1 - WGS84_ECCENTRICITY_SQUARED * sinLatitude * sinLatitude;
  const primeVerticalRadius = WGS84_SEMI_MAJOR_AXIS / Math.sqrt(denominator);
  const meridionalRadius =
    (WGS84_SEMI_MAJOR_AXIS * (1 - WGS84_ECCENTRICITY_SQUARED)) / denominator ** 1.5;
  return {
    longitude,
    latitude,
    sinLatitude,
    cosLatitude: Math.cos(latitude * DEGREES_TO_RADIANS),
    meridionalRadius,
    primeVerticalRadius,
    earthRadius: Math.sqrt(meridionalRadius * primeVerticalRadius)
  };
}

function getSmallSine(angle: number): number {
  return angle - (angle * angle * angle) / 6;
}

function getSmallVersine(angle: number): number {
  const squared = angle * angle;
  return squared / 2 - (squared * squared) / 24;
}

/**
 * Local position of a point given its latitude / longitude offsets from the frame origin (radians).
 * `curvatureScale` is 1 - k for curvature with refraction, or 0 for a flat earth.
 * The terrain vertex shaders implement exactly this function.
 */
export function getLocalPositionFromOffsets(
  frame: LocalFrame,
  latitudeOffset: number,
  longitudeOffset: number,
  elevation: number,
  curvatureScale: number
): Vector3 {
  const cosLatitude =
    frame.cosLatitude * (1 - getSmallVersine(latitudeOffset)) -
    frame.sinLatitude * getSmallSine(latitudeOffset);
  const heightScale = 1 + elevation / frame.earthRadius;
  const east =
    frame.primeVerticalRadius * cosLatitude * getSmallSine(longitudeOffset) * heightScale;
  const north =
    (frame.meridionalRadius * getSmallSine(latitudeOffset) +
      frame.primeVerticalRadius *
        cosLatitude *
        frame.sinLatitude *
        getSmallVersine(longitudeOffset)) *
    heightScale;
  const up = elevation - (curvatureScale * (east * east + north * north)) / (2 * frame.earthRadius);
  return [east, north, up];
}

export function getLocalPosition(
  frame: LocalFrame,
  longitude: number,
  latitude: number,
  elevation: number,
  curvatureScale: number
): Vector3 {
  return getLocalPositionFromOffsets(
    frame,
    (latitude - frame.latitude) * DEGREES_TO_RADIANS,
    (longitude - frame.longitude) * DEGREES_TO_RADIANS,
    elevation,
    curvatureScale
  );
}

/** One DEM tile and where it sits relative to the frame origin. */
export type DemTile = {
  z: number;
  x: number;
  y: number;
  /** Layer of the shared texture array that holds this tile's pixels. */
  layer: number;
  /** Latitude of the north edge, the Mercator middle and the south edge minus the origin, radians. */
  latitudeOffsets: Vector3;
  /** Longitude of the west and east edges minus the origin, radians. */
  longitudeOffsets: [number, number];
  /** Planar distance from the camera to the nearest point of the tile, metres. */
  distance: number;
};

function getTileLatitude(z: number, y: number): number {
  return Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z)));
}

function makeDemTile(frame: LocalFrame, z: number, x: number, y: number): DemTile {
  const originLatitude = frame.latitude * DEGREES_TO_RADIANS;
  const originLongitude = frame.longitude * DEGREES_TO_RADIANS;
  const west = (x / 2 ** z) * 2 * Math.PI - Math.PI;
  const east = ((x + 1) / 2 ** z) * 2 * Math.PI - Math.PI;
  const latitudeOffsets: Vector3 = [
    getTileLatitude(z, y) - originLatitude,
    getTileLatitude(z, y + 0.5) - originLatitude,
    getTileLatitude(z, y + 1) - originLatitude
  ];
  const longitudeOffsets: [number, number] = [west - originLongitude, east - originLongitude];
  const [southWestEast, southWestNorth] = getLocalPositionFromOffsets(
    frame,
    latitudeOffsets[2],
    longitudeOffsets[0],
    0,
    0
  );
  const [northEastEast, northEastNorth] = getLocalPositionFromOffsets(
    frame,
    latitudeOffsets[0],
    longitudeOffsets[1],
    0,
    0
  );
  const eastGap = Math.max(southWestEast, 0, -northEastEast);
  const northGap = Math.max(southWestNorth, 0, -northEastNorth);
  return {
    z,
    x,
    y,
    layer: -1,
    latitudeOffsets,
    longitudeOffsets,
    distance: Math.hypot(eastGap, northGap)
  };
}

/** True when any part of the tile lies within the horizontal view wedge. */
function isTileInWedge(
  frame: LocalFrame,
  tile: DemTile,
  heading: number,
  halfWidth: number
): boolean {
  if (tile.distance === 0) return true;
  const relativeHeadings: number[] = [];
  for (const latitudeOffset of [tile.latitudeOffsets[0], tile.latitudeOffsets[2]]) {
    for (const longitudeOffset of tile.longitudeOffsets) {
      const [east, north] = getLocalPositionFromOffsets(
        frame,
        latitudeOffset,
        longitudeOffset,
        0,
        0
      );
      const azimuth = Math.atan2(east, north) / DEGREES_TO_RADIANS;
      relativeHeadings.push(((azimuth - heading + 540) % 360) - 180);
    }
  }
  const minimum = Math.min(...relativeHeadings);
  const maximum = Math.max(...relativeHeadings);
  // A tile that wraps through ±180° lies behind the camera.
  return maximum - minimum < 180 && maximum >= -halfWidth && minimum <= halfWidth;
}

export type DemTileSelectionOptions = {
  /** Farthest terrain to draw inside the view wedge, metres. */
  maxDistance?: number;
  /** Terrain nearer than this is drawn in every direction, so the orbit view has context. */
  contextDistance?: number;
  maxZoom?: number;
  /** A tile splits while its width exceeds `detail` × its distance. Smaller is finer. */
  detail?: number;
};

/**
 * Quadtree selection: fine tiles near the camera, coarse ones far away. Inside the photo's view
 * wedge tiles reach `maxDistance`; elsewhere they stop at `contextDistance`.
 */
export function selectDemTiles(
  frame: LocalFrame,
  camera: PhotoCamera,
  {
    maxDistance = 150_000,
    contextDistance = 25_000,
    maxZoom = 14,
    detail = 0.75
  }: DemTileSelectionOptions = {}
): DemTile[] {
  const verticalHalfAngle = (camera.verticalFieldOfView / 2) * DEGREES_TO_RADIANS;
  const horizontalHalfWidth =
    Math.atan(Math.tan(verticalHalfAngle) * camera.aspectRatio) / DEGREES_TO_RADIANS;
  // Margin for roll and for terrain that rises into the frame from outside the wedge.
  const halfWidth = horizontalHalfWidth + Math.abs(camera.roll) + 10;
  const selected: DemTile[] = [];
  const visitTile = (z: number, x: number, y: number) => {
    const tile = makeDemTile(frame, z, x, y);
    if (tile.distance > maxDistance) return;
    if (tile.distance > contextDistance && !isTileInWedge(frame, tile, camera.yaw, halfWidth)) {
      return;
    }
    const width =
      frame.primeVerticalRadius *
      frame.cosLatitude *
      (tile.longitudeOffsets[1] - tile.longitudeOffsets[0]);
    if (z < maxZoom && width > detail * Math.max(tile.distance, 200)) {
      for (const [column, row] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1]
      ]) {
        visitTile(z + 1, 2 * x + column, 2 * y + row);
      }
    } else {
      selected.push(tile);
    }
  };
  // Start from the zoom-6 tiles around the camera (each about 400 km wide).
  const startZoom = 6;
  const [centerX, centerY] = getTileCoordinates(startZoom, camera.longitude, camera.latitude);
  for (let x = Math.floor(centerX) - 1; x <= Math.floor(centerX) + 1; x++) {
    for (let y = Math.floor(centerY) - 1; y <= Math.floor(centerY) + 1; y++) {
      visitTile(startZoom, x, y);
    }
  }
  selected.sort((first, second) => first.distance - second.distance);
  selected.forEach((tile, index) => {
    tile.layer = index;
  });
  return selected;
}

/** Fractional tile coordinates of a longitude / latitude at zoom z. */
function getTileCoordinates(z: number, longitude: number, latitude: number): [number, number] {
  const sinLatitude = Math.sin(latitude * DEGREES_TO_RADIANS);
  const x = ((longitude + 180) / 360) * 2 ** z;
  const y = (0.5 - Math.log((1 + sinLatitude) / (1 - sinLatitude)) / (4 * Math.PI)) * 2 ** z;
  return [x, y];
}

export function getDemTileUrl(tile: DemTile): string {
  return DEM_TILE_URL.replace('{z}', String(tile.z))
    .replace('{x}', String(tile.x))
    .replace('{y}', String(tile.y));
}

/** Fetches a tile and returns its raw RGBA bytes for the GPU. */
export async function loadDemTile(tile: DemTile, signal: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(getDemTileUrl(tile), {signal});
  if (!response.ok) throw new Error(`${response.status} ${response.url}`);
  // Elevations are encoded in the colour bytes: no colour management, no premultiplication.
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

export function getDemTileKey(tile: DemTile): string {
  return `${tile.z}/${tile.x}/${tile.y}`;
}
