// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/** Mapterhorn Terrarium-encoded WebP tiles (512 px). CORS-enabled; see README for licences. */
export const TERRAIN_TILE_URL = 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp';
export const TERRAIN_TILE_SIZE = 512;
/** Mean Earth radius used for every spherical approximation in this example. */
export const EARTH_RADIUS_METERS = 6_371_000;

export type GeographicPosition = {
  latitude: number;
  longitude: number;
};

/** A square of Terrarium tiles kept as raw RGBA bytes, one 32-bit word per pixel. */
export type TerrainMosaic = {
  zoom: number;
  /** Width and height of the mosaic in pixels. */
  width: number;
  height: number;
  /** Raw Terrarium pixels, little-endian `r | g << 8 | b << 16 | a << 24`. */
  pixels: Uint32Array;
  /** World pixel coordinate of the mosaic's top-left corner at `zoom`. */
  originColumn: number;
  originRow: number;
  /** Number of tiles fetched. */
  tileCount: number;
};

/** Returns the Web Mercator world pixel of a position at one zoom level. */
export function getWorldPixel(position: GeographicPosition, zoom: number): [number, number] {
  const worldSize = TERRAIN_TILE_SIZE * 2 ** zoom;
  const latitudeRadians = (position.latitude * Math.PI) / 180;
  const column = ((position.longitude + 180) / 360) * worldSize;
  const row =
    ((1 - Math.log(Math.tan(latitudeRadians) + 1 / Math.cos(latitudeRadians)) / Math.PI) / 2) *
    worldSize;
  return [column, row];
}

/** Returns Web Mercator pixels per ground metre at a latitude, on the example's sphere. */
export function getPixelsPerMeter(latitude: number, zoom: number): number {
  const worldSize = TERRAIN_TILE_SIZE * 2 ** zoom;
  return worldSize / (2 * Math.PI * EARTH_RADIUS_METERS * Math.cos((latitude * Math.PI) / 180));
}

/**
 * Fetches a `(2 * tileRadius + 1)²` square of tiles centred on the tile containing `center`.
 *
 * Tiles are decoded to RGBA bytes on the CPU only to copy them into one mosaic; the Terrarium
 * height decode itself runs on the GPU (and, for verification, in the CPU twin).
 */
export async function loadTerrainMosaic(
  center: GeographicPosition,
  props: {zoom: number; tileRadius: number; signal?: AbortSignal}
): Promise<TerrainMosaic> {
  const {zoom, tileRadius, signal} = props;
  const [centerColumn, centerRow] = getWorldPixel(center, zoom);
  const firstTileX = Math.floor(centerColumn / TERRAIN_TILE_SIZE) - tileRadius;
  const firstTileY = Math.floor(centerRow / TERRAIN_TILE_SIZE) - tileRadius;
  const tilesPerSide = 2 * tileRadius + 1;
  const width = tilesPerSide * TERRAIN_TILE_SIZE;
  const height = width;
  const pixels = new Uint32Array(width * height);
  const loads: Promise<void>[] = [];
  for (let tileRow = 0; tileRow < tilesPerSide; tileRow++) {
    for (let tileColumn = 0; tileColumn < tilesPerSide; tileColumn++) {
      const url = TERRAIN_TILE_URL.replace('{z}', String(zoom))
        .replace('{x}', String(firstTileX + tileColumn))
        .replace('{y}', String(firstTileY + tileRow));
      loads.push(
        loadTilePixels(url, signal).then(tilePixels => {
          for (let row = 0; row < TERRAIN_TILE_SIZE; row++) {
            const sourceOffset = row * TERRAIN_TILE_SIZE;
            const targetOffset =
              (tileRow * TERRAIN_TILE_SIZE + row) * width + tileColumn * TERRAIN_TILE_SIZE;
            pixels.set(
              tilePixels.subarray(sourceOffset, sourceOffset + TERRAIN_TILE_SIZE),
              targetOffset
            );
          }
        })
      );
    }
  }
  await Promise.all(loads);
  return {
    zoom,
    width,
    height,
    pixels,
    originColumn: firstTileX * TERRAIN_TILE_SIZE,
    originRow: firstTileY * TERRAIN_TILE_SIZE,
    tileCount: tilesPerSide * tilesPerSide
  };
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
  const canvas = new OffscreenCanvas(TERRAIN_TILE_SIZE, TERRAIN_TILE_SIZE);
  const context = canvas.getContext('2d', {willReadFrequently: true})!;
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const imageData = context.getImageData(0, 0, TERRAIN_TILE_SIZE, TERRAIN_TILE_SIZE);
  return new Uint32Array(imageData.data.buffer);
}
