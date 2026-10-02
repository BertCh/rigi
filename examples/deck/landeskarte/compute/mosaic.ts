// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The z11 Terrarium mosaic that feeds every compute graph: a (2r + 1)^2 square of Mapterhorn
// tiles around the summit, kept as raw RGBA words (for the GPU decode node) and as decoded
// Float32 heights (for the CPU twins). Pure helpers here are shared with the checks.

import type {Frame, Mosaic, MosaicInfo} from '../types';

/** Mapterhorn Terrarium-encoded WebP tiles (512 px, CORS enabled). */
export const MOSAIC_TILE_URL = 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp';
export const MOSAIC_TILE_SIZE = 512;

const DEG = Math.PI / 180;

/** Web Mercator world pixel of a position at one zoom (tile size 512). */
export function getWorldPixel(lat: number, lon: number, zoom: number): [number, number] {
  const worldSize = MOSAIC_TILE_SIZE * 2 ** zoom;
  const column = ((lon + 180) / 360) * worldSize;
  const latRadians = lat * DEG;
  const row =
    ((1 - Math.log(Math.tan(latRadians) + 1 / Math.cos(latRadians)) / Math.PI) / 2) * worldSize;
  return [column, row];
}

/** Inverse of `getWorldPixel`: [lat, lon] in degrees. */
export function getWorldLatLon(column: number, row: number, zoom: number): [number, number] {
  const worldSize = MOSAIC_TILE_SIZE * 2 ** zoom;
  const lon = (column / worldSize) * 360 - 180;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / worldSize))) / DEG;
  return [lat, lon];
}

/** Terrarium bytes to metres: `r * 256 + g + b / 256 - 32768` (every step exact in f32). */
export function decodeTerrariumPixels(pixels: Uint32Array): Float32Array {
  const heights = new Float32Array(pixels.length);
  for (let index = 0; index < pixels.length; index++) {
    const packed = pixels[index];
    heights[index] =
      (packed & 255) * 256 + ((packed >>> 8) & 255) + ((packed >>> 16) & 255) / 256 - 32768;
  }
  return heights;
}

/** Where a mosaic sits in the Web Mercator world, relative to the frame origin (the eye). */
export type MosaicPlacement = {
  /** World pixel of the mosaic's top-left corner. */
  originColumn: number;
  originRow: number;
  /** Eye position in mosaic pixels (fractional). */
  eyeColumn: number;
  eyeRow: number;
};

/**
 * Recovers the placement from the mosaic size alone: `loadMosaic` always centres the square on the
 * tile that contains the frame origin, so the radius follows from the width.
 */
export function getMosaicPlacement(mosaic: MosaicInfo, frame: Frame): MosaicPlacement {
  const [worldColumn, worldRow] = getWorldPixel(frame.origin.lat, frame.origin.lon, mosaic.zoom);
  const radiusTiles = (mosaic.width / MOSAIC_TILE_SIZE - 1) / 2;
  const originColumn =
    (Math.floor(worldColumn / MOSAIC_TILE_SIZE) - radiusTiles) * MOSAIC_TILE_SIZE;
  const originRow = (Math.floor(worldRow / MOSAIC_TILE_SIZE) - radiusTiles) * MOSAIC_TILE_SIZE;
  return {
    originColumn,
    originRow,
    eyeColumn: worldColumn - originColumn,
    eyeRow: worldRow - originRow
  };
}

/** East-west ground metres per mosaic pixel at the frame origin, on the frame's ellipsoid. */
export function getMetersPerPixel(frame: Frame, zoom: number): number {
  const worldSize = MOSAIC_TILE_SIZE * 2 ** zoom;
  return (2 * Math.PI * frame.primeVerticalRadius * frame.cosLat) / worldSize;
}

/** Builds a Mosaic from raw pixels already placed on the tile grid (also used by the checks). */
export function makeMosaic(frame: Frame, zoom: number, width: number, pixels: Uint32Array): Mosaic {
  const height = pixels.length / width;
  const info = {zoom, width, height} as MosaicInfo;
  const placement = getMosaicPlacement(info, frame);
  // The corner's ENU through the frame itself, so originEnu agrees with every other module.
  const [cornerLat, cornerLon] = getWorldLatLon(placement.originColumn, placement.originRow, zoom);
  const [east, north] = frame.toEnu(cornerLat, cornerLon, frame.origin.h);
  return {
    zoom,
    width,
    height,
    pixels,
    heights: decodeTerrariumPixels(pixels),
    metersPerPixel: getMetersPerPixel(frame, zoom),
    originEnu: [east, north]
  };
}

/** Ground height at the eye by bilinear interpolation of the mosaic (f64), metres. */
export function getMosaicGroundHeight(mosaic: Mosaic, frame: Frame): number {
  const {eyeColumn, eyeRow} = getMosaicPlacement(mosaic, frame);
  // Terrarium samples are pixel values; the pixel (i, j) centre is at (i + 0.5, j + 0.5).
  const column = eyeColumn - 0.5;
  const row = eyeRow - 0.5;
  const x = Math.floor(column);
  const y = Math.floor(row);
  const fx = column - x;
  const fy = row - y;
  const {heights, width} = mosaic;
  const index = y * width + x;
  const top = heights[index] + (heights[index + 1] - heights[index]) * fx;
  const bottom =
    heights[index + width] + (heights[index + width + 1] - heights[index + width]) * fx;
  return top + (bottom - top) * fy;
}

export function getMosaicInfo(mosaic: Mosaic): MosaicInfo {
  const {pixels: _pixels, heights: _heights, ...info} = mosaic;
  return info;
}

/**
 * Fetches a `(2 * radiusTiles + 1)^2` square of z11 tiles centred on the tile holding the frame
 * origin (7 x 7 tiles are about 94 km wide: 45 km of ray in every direction). Height decoding
 * happens on the CPU here only so the twins and the checks have `heights`; the ring graph decodes
 * the raw pixels again on the GPU.
 */
export async function loadMosaic(
  frame: Frame,
  zoom = 11,
  radiusTiles = 3,
  signal?: AbortSignal
): Promise<Mosaic> {
  const [worldColumn, worldRow] = getWorldPixel(frame.origin.lat, frame.origin.lon, zoom);
  const firstTileX = Math.floor(worldColumn / MOSAIC_TILE_SIZE) - radiusTiles;
  const firstTileY = Math.floor(worldRow / MOSAIC_TILE_SIZE) - radiusTiles;
  const tilesPerSide = 2 * radiusTiles + 1;
  const width = tilesPerSide * MOSAIC_TILE_SIZE;
  const pixels = new Uint32Array(width * width);
  const loads: Promise<void>[] = [];
  for (let tileRow = 0; tileRow < tilesPerSide; tileRow++) {
    for (let tileColumn = 0; tileColumn < tilesPerSide; tileColumn++) {
      const url = MOSAIC_TILE_URL.replace('{z}', String(zoom))
        .replace('{x}', String(firstTileX + tileColumn))
        .replace('{y}', String(firstTileY + tileRow));
      loads.push(
        loadTilePixels(url, signal).then(tilePixels => {
          for (let row = 0; row < MOSAIC_TILE_SIZE; row++) {
            const source = row * MOSAIC_TILE_SIZE;
            const target =
              (tileRow * MOSAIC_TILE_SIZE + row) * width + tileColumn * MOSAIC_TILE_SIZE;
            pixels.set(tilePixels.subarray(source, source + MOSAIC_TILE_SIZE), target);
          }
        })
      );
    }
  }
  await Promise.all(loads);
  return makeMosaic(frame, zoom, width, pixels);
}

async function loadTilePixels(url: string, signal?: AbortSignal): Promise<Uint32Array> {
  const response = await fetch(url, {signal});
  if (!response.ok) {
    throw new Error(`Terrain tile ${url} failed with HTTP ${response.status}`);
  }
  // Terrarium bytes are data, not colour: disable colour management and premultiplication.
  const bitmap = await createImageBitmap(await response.blob(), {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none'
  });
  const canvas = new OffscreenCanvas(MOSAIC_TILE_SIZE, MOSAIC_TILE_SIZE);
  const context = canvas.getContext('2d', {willReadFrequently: true})!;
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const imageData = context.getImageData(0, 0, MOSAIC_TILE_SIZE, MOSAIC_TILE_SIZE);
  return new Uint32Array(imageData.data.buffer);
}
