// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Offline checks for terrain/dem-tiles.ts: tiles are synthesised from analytic terrain, so nothing
// touches the network. Run: npx tsx examples/deck/landeskarte/checks/dem.check.ts

import assert from 'node:assert/strict';
import {REFRACTION_K, makeFrame} from '../geo/geodesy';
import {
  DEM_TILE_SIZE,
  MAX_TILES,
  TileStreamer,
  decodeTerrarium,
  encodeTerrarium,
  isVisible,
  makeLoadedTile,
  sampleHeight,
  selectTiles,
  tileCoordinates
} from '../terrain/dem-tiles';
import type {LoadedTile, TileKey, ViewPose} from '../types';

const DEG = Math.PI / 180;
const frame = makeFrame(46.7102, 7.7733, 1919);

function pass(name: string, detail: string): void {
  console.log(`PASS ${name}: ${detail}`);
}

// ---- Synthetic terrain --------------------------------------------------------------------------

/** Mountain at the summit plus a ridge 5 km north, on a 1000 m plateau. */
function terrainHeight(lat: number, lon: number): number {
  const [east, north] = frame.toEnu(lat, lon, 0);
  const summit = 900 * Math.exp(-(east * east + north * north) / (2 * 800 * 800));
  const ridge = 1200 * Math.exp(-((north - 5000) ** 2) / (2 * 400 * 400));
  return 1000 + summit + ridge;
}

function mercatorLatitude(z: number, y: number): number {
  return Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) / DEG;
}

/** Terrarium bytes of `height(lat, lon)` sampled at the 512 x 512 pixel centres of a tile. */
function synthesizeTile(
  key: Pick<TileKey, 'z' | 'x' | 'y'>,
  height: (lat: number, lon: number) => number
): Uint8Array {
  const rgba = new Uint8Array(DEM_TILE_SIZE * DEM_TILE_SIZE * 4);
  const longitudes = new Float64Array(DEM_TILE_SIZE);
  for (let i = 0; i < DEM_TILE_SIZE; i++) {
    longitudes[i] = ((key.x + (i + 0.5) / DEM_TILE_SIZE) / 2 ** key.z) * 360 - 180;
  }
  for (let row = 0; row < DEM_TILE_SIZE; row++) {
    const lat = mercatorLatitude(key.z, key.y + (row + 0.5) / DEM_TILE_SIZE);
    for (let column = 0; column < DEM_TILE_SIZE; column++) {
      const [r, g, b] = encodeTerrarium(height(lat, longitudes[column]));
      const offset = (row * DEM_TILE_SIZE + column) * 4;
      rgba[offset] = r;
      rgba[offset + 1] = g;
      rgba[offset + 2] = b;
      rgba[offset + 3] = 255;
    }
  }
  return rgba;
}

function tileAt(z: number, lat: number, lon: number): TileKey {
  const [x, y] = tileCoordinates(z, lon, lat);
  const pose: ViewPose = {eye: [0, 0, 2], yaw: 0, pitch: 0, roll: 0, vfov: 30};
  const key = selectTiles(frame, pose, {minZoom: z, maxZoom: z, maxDistance: 1}).find(
    tile => tile.x === Math.floor(x) && tile.y === Math.floor(y)
  );
  assert.ok(key, `tile ${z}/${Math.floor(x)}/${Math.floor(y)} selected`);
  return key;
}

function loadSynthetic(
  keys: TileKey[],
  height: (lat: number, lon: number) => number
): LoadedTile[] {
  return keys.map((key, layer) => makeLoadedTile(key, layer, synthesizeTile(key, height)));
}

// ---- Terrarium ------------------------------------------------------------------------------------

{
  assert.equal(decodeTerrarium(128, 0, 0), 0);
  assert.equal(decodeTerrarium(0, 0, 0), -32768);
  assert.equal(decodeTerrarium(135, 123, 64), 7 * 256 + 123 + 0.25);
  let worst = 0;
  for (const h of [-100, 0, 0.004, 1931.6, 4274.17, 8848]) {
    const [r, g, b] = encodeTerrarium(h);
    worst = Math.max(worst, Math.abs(decodeTerrarium(r, g, b) - h));
  }
  assert.ok(worst <= 1 / 512 + 1e-9);
  pass(
    'terrarium',
    `(128,0,0) = 0 m exactly, (0,0,0) = -32768, round trip within ${worst.toFixed(5)} m`
  );
}

// ---- Height queries -------------------------------------------------------------------------------

const z14 = tileAt(14, frame.origin.lat, frame.origin.lon);
const z14Tile = loadSynthetic([z14], terrainHeight);

{
  // Interior points of the z14 tile within 600 m of the summit, where the peak has its curvature.
  let worst = 0;
  let count = 0;
  for (let east = -600; east <= 600; east += 37) {
    for (let north = -600; north <= 600; north += 41) {
      const geo = frame.toGeo([east, north, 0]);
      const [tx, ty] = tileCoordinates(14, geo.lon, geo.lat);
      const u = tx - z14.x;
      const v = ty - z14.y;
      if (u < 0.03 || u > 0.97 || v < 0.03 || v > 0.97) continue;
      const height = sampleHeight(z14Tile, frame, geo.lat, geo.lon);
      assert.ok(height !== null);
      worst = Math.max(worst, Math.abs(height - terrainHeight(geo.lat, geo.lon)));
      count++;
    }
  }
  assert.ok(count > 100, `only ${count} interior samples`);
  assert.ok(worst < 0.1, `height error ${worst}`);
  pass('sampleHeight', `${count} points vs analytic terrain, max error ${worst.toFixed(4)} m`);
}

{
  const coarse = loadSynthetic([tileAt(13, frame.origin.lat, frame.origin.lon)], () => 100);
  const fine = loadSynthetic([z14], () => 200);
  const lat = frame.origin.lat;
  const lon = frame.origin.lon;
  assert.equal(sampleHeight([...coarse, ...fine], frame, lat, lon), 200);
  assert.equal(sampleHeight([...fine, ...coarse], frame, lat, lon), 200);
  assert.equal(sampleHeight(coarse, frame, lat, lon), 100);
  assert.equal(sampleHeight(fine, frame, lat + 1, lon), null);
  pass('finest tile wins', 'z14 over z13 in either order; null outside the loaded tiles');
}

// ---- Tile selection -------------------------------------------------------------------------------

const planPose: ViewPose = {eye: [0, 0, 40000], yaw: 0, pitch: -90, roll: 0, vfov: 8};
const panoramaPose: ViewPose = {eye: [0, 0, 1.6], yaw: 0, pitch: 0, roll: 0, vfov: 30};

function coverCount(keys: TileKey[], east: number, north: number): number {
  const geo = frame.toGeo([east, north, 0]);
  let count = 0;
  for (const key of keys) {
    const [x, y] = tileCoordinates(key.z, geo.lon, geo.lat);
    if (Math.floor(x) === key.x && Math.floor(y) === key.y) count++;
  }
  return count;
}

{
  const keys = selectTiles(frame, planPose);
  assert.ok(keys.length > 4 && keys.length <= MAX_TILES, `plan count ${keys.length}`);
  assert.equal(keys[0].distance, 0);
  assert.equal(keys[0].z, 14);
  assert.equal(coverCount([keys[0]], 0, 0), 1);
  for (let i = 1; i < keys.length; i++) assert.ok(keys[i].distance >= keys[i - 1].distance);
  // The visible footprint (half-height 40 km * tan 4 deg = 2.8 km) is covered exactly once.
  let covered = 0;
  for (let east = -4000; east <= 4000; east += 250) {
    for (let north = -2800; north <= 2800; north += 250) {
      assert.equal(coverCount(keys, east, north), 1, `plan point ${east},${north}`);
      covered++;
    }
  }
  const zooms = keys.map(key => key.z);
  assert.ok(Math.min(...zooms) >= 9 && Math.max(...zooms) <= 14);
  pass(
    'selectTiles plan',
    `${keys.length} tiles (cap ${MAX_TILES}), z${Math.min(...zooms)}..z${Math.max(...zooms)}, summit tile z14 first, ${covered} footprint points each covered exactly once`
  );
}

{
  const keys = selectTiles(frame, panoramaPose);
  assert.ok(keys.length > 10 && keys.length <= MAX_TILES, `panorama count ${keys.length}`);
  assert.equal(keys[0].distance, 0);
  assert.equal(keys[0].z, 14);
  for (let i = 1; i < keys.length; i++) assert.ok(keys[i].distance >= keys[i - 1].distance);
  const farthest = Math.max(...keys.map(key => key.distance));
  assert.ok(farthest <= 150_000 && farthest > 100_000, `farthest ${farthest}`);
  // Beyond the near field, nothing behind the camera: bearing within the wedge plus its margin.
  const halfWidth = Math.atan(Math.tan(15 * DEG) * (16 / 9)) / DEG + 10;
  for (const key of keys) {
    if (key.distance < 5000) continue;
    const lat = frame.origin.lat + key.latitudeOffsets[1] / DEG;
    const lon = frame.origin.lon + (key.longitudeOffsets[0] + key.longitudeOffsets[1]) / 2 / DEG;
    const [east, north] = frame.toEnu(lat, lon, frame.origin.h);
    const bearing = Math.abs(Math.atan2(east, north) / DEG);
    assert.ok(bearing < halfWidth + 25, `tile ${key.z}/${key.x}/${key.y} at bearing ${bearing}`);
  }
  // Fine near, coarse far: zoom never increases with distance by more than a level of noise.
  const near = keys.filter(key => key.distance < 2000).map(key => key.z);
  const far = keys.filter(key => key.distance > 60_000).map(key => key.z);
  assert.ok(Math.min(...near) >= 13, 'near field is fine');
  assert.ok(Math.max(...far) <= 11, 'far field is coarse');
  // No overlaps and no holes inside the wedge core out to 100 km.
  let covered = 0;
  for (let range = 300; range <= 100_000; range *= 1.4) {
    for (const bearing of [-18, -9, 0, 9, 18]) {
      const east = range * Math.sin(bearing * DEG);
      const north = range * Math.cos(bearing * DEG);
      assert.equal(coverCount(keys, east, north), 1, `panorama point ${range} m at ${bearing}`);
      covered++;
    }
  }
  const behind = keys.filter(key => key.distance > 5000 && key.latitudeOffsets[1] < -0.02);
  assert.equal(behind.length, 0, 'no far tiles behind the summit');
  const south = selectTiles(frame, {...panoramaPose, yaw: 180});
  assert.ok(south.length <= MAX_TILES);
  pass(
    'selectTiles panorama',
    `${keys.length} tiles, farthest ${(farthest / 1000).toFixed(0)} km, near z${Math.min(...near)}, far z${Math.max(...far)}, ${covered} wedge points each covered once; yaw 180 -> ${south.length} tiles`
  );
}

{
  // Yaw is unwrapped during flights: -720 must select what 0 selects.
  const same = selectTiles(frame, {...panoramaPose, yaw: -720}).map(
    key => `${key.z}/${key.x}/${key.y}`
  );
  const base = selectTiles(frame, panoramaPose).map(key => `${key.z}/${key.x}/${key.y}`);
  assert.deepEqual(same, base);
  // Looking 55 deg down, ground beside the camera is in view: the wedge must be wider than at
  // the horizon, so tiles east of the eye (90 deg off the heading) are kept.
  const down: ViewPose = {...panoramaPose, eye: [0, 0, 6000], pitch: -55};
  const level = {...down, pitch: 0};
  const sideTiles = (pose: ViewPose): number =>
    selectTiles(frame, pose, {maxDistance: 20_000}).filter(key => {
      const lon = frame.origin.lon + (key.longitudeOffsets[0] + key.longitudeOffsets[1]) / 2 / DEG;
      return lon > frame.origin.lon + 0.06;
    }).length;
  assert.ok(sideTiles(down) > sideTiles(level), 'steep pitch widens the wedge');
  pass(
    'wedge',
    `yaw -720 equals yaw 0; side tiles ${sideTiles(level)} level -> ${sideTiles(down)} at pitch -55`
  );
}

// ---- Sight line -----------------------------------------------------------------------------------

{
  const keys = selectTiles(
    frame,
    {...panoramaPose, vfov: 120},
    {
      wedge: false,
      maxDistance: 30_000,
      minZoom: 10,
      maxZoom: 10
    }
  );
  const tiles = loadSynthetic(keys, terrainHeight);
  const eye: [number, number, number] = [0, 0, 2];

  // The 2200 m ridge 5 km north blocks a 1500 m target 15 km behind it.
  assert.equal(isVisible(frame, tiles, eye, [0, 15000, 1500 - 1919]), false);
  // Eastwards the plateau lies 900 m below the eye: a 1100 m target is visible.
  assert.equal(isVisible(frame, tiles, eye, [15000, 0, 1100 - 1919]), true);

  // Curvature: stand 3 m above the plateau and look at the ground 24 km away. With the earth's
  // bulge (k = 0.13) the ground blocks itself by 8 m at mid-path; with no bulge it does not.
  const low: [number, number, number] = [0, -6000, 1003 - 1919];
  const far: [number, number, number] = [24000, -6000, 1000 - 1919];
  // k = 0.13 gives drop 39 m at 24 km; k = 1 cancels it entirely.
  assert.equal(isVisible(frame, tiles, low, far, REFRACTION_K), false);
  assert.equal(isVisible(frame, tiles, low, far, 1), true);
  pass(
    'isVisible',
    `${keys.length} z10 tiles; ridge blocks, plateau open, curvature blocks at k=${REFRACTION_K} and opens at k=1`
  );
}

// ---- Streamer -------------------------------------------------------------------------------------

async function runStreamerChecks(): Promise<void> {
  const keys = selectTiles(frame, panoramaPose).slice(0, 30);
  const rgba = new Uint8Array(DEM_TILE_SIZE * DEM_TILE_SIZE * 4).fill(0);
  let inFlight = 0;
  let peak = 0;
  const fetched: string[] = [];
  const failing = `${keys[17].z}/${keys[17].x}/${keys[17].y}`;
  const fetchRgba = async (key: TileKey, signal: AbortSignal): Promise<Uint8Array> => {
    const id = `${key.z}/${key.x}/${key.y}`;
    fetched.push(id);
    inFlight++;
    peak = Math.max(peak, inFlight);
    // Odd delays so that tiles arrive out of request order.
    await new Promise(resolve => setTimeout(resolve, 1 + ((key.x * 7 + key.y * 3) % 9)));
    inFlight--;
    if (signal.aborted) throw new Error('aborted');
    if (id === failing) throw new Error('404');
    return rgba;
  };

  const delivered: LoadedTile[] = [];
  const controller = new AbortController();
  const streamer = new TileStreamer(tile => delivered.push(tile), controller.signal, {fetchRgba});
  streamer.request(keys.slice(0, 24));
  // A second request replaces the queue that has not started: 6..11 are dropped, 12..29 added.
  streamer.request(keys.slice(12, 30));
  assert.equal(streamer.stats.requested, 6 + 18);
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(fetched.length, 24);
  assert.equal(new Set(fetched).size, 24, 'no tile fetched twice');
  assert.ok(peak <= 6, `peak concurrency ${peak}`);
  assert.equal(streamer.stats.loaded, 23);
  assert.equal(streamer.stats.failed, 1);
  assert.equal(delivered.length, 23);
  delivered.forEach((tile, index) => assert.equal(tile.layer, index, 'layers are arrival order'));
  assert.equal(streamer.tiles.length, 23);
  assert.equal(delivered[0].elevations.length, 129 * 129);

  streamer.request(keys);
  streamer.request(keys.slice(6, 12));
  assert.equal(streamer.stats.requested, 24 + 6, 'only the unseen dropped tiles are new');
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(fetched.length, 30, 'repeat requests refetch nothing');

  controller.abort();
  streamer.request(selectTiles(frame, planPose).slice(0, 5));
  const before = fetched.length;
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(fetched.length, before, 'nothing starts after abort');
  pass(
    'TileStreamer',
    `peak concurrency ${peak} (<= 6), 24 fetches for 24 wanted, 1 failure counted, layers 0..22 in arrival order, abort stops`
  );
}

await runStreamerChecks();
console.log('dem.check: all checks passed');
