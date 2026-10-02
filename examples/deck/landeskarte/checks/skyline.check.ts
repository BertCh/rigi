// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Pure CPU checks for overlay/skyline-layer.ts and data/photo-skylines.json: pixel -> direction ->
// projectToScreen round trip, the baked data (ML U2-Net-P and classical skylines), ML vs classical
// agreement, and the residual stats of both against each JSON's DEM horizon profile. Run: npx tsx checks/skyline.check.ts

import assert from 'node:assert/strict';
import {readFileSync, statSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {
  type PhotoSkyline,
  makeSkylineLayers,
  pixelToDirection,
  skylineResidualStats
} from '../overlay/skyline-layer';
import type {ENU, RingResult} from '../types';
import {projectToScreen} from '../views/landeskarte-view';

const DEG = Math.PI / 180;
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const demoDir = here('../../../../public/demo/gipfelbuch/');

function pass(name: string, detail: string): void {
  console.log(`PASS ${name}: ${detail}`);
}

function toEnu(azimuth: number, elevation: number, distance = 20_000): ENU {
  const horizontal = distance * Math.cos(elevation * DEG);
  return [
    horizontal * Math.sin(azimuth * DEG),
    horizontal * Math.cos(azimuth * DEG),
    distance * Math.sin(elevation * DEG)
  ];
}

// 1. Round trip at several poses, including roll, portrait and a steep pitch.
{
  const poses = [
    {yaw: 260.72, pitch: -3.53, roll: -2.41, vfov: 52.11, width: 800, height: 600},
    {yaw: 12, pitch: 25, roll: 9, vfov: 70, width: 800, height: 1067},
    {yaw: 359.5, pitch: -40, roll: -15, vfov: 88.1, width: 640, height: 480}
  ];
  let worst = 0;
  for (const pose of poses) {
    for (let x = 5.5; x < pose.width; x += 97) {
      for (let y = 5; y < pose.height; y += 83) {
        const [azimuth, elevation] = pixelToDirection(pose, pose.width, pose.height, x, y);
        const screen = projectToScreen(
          {eye: [0, 0, 0], ...pose, near: 1},
          toEnu(azimuth, elevation),
          pose.width,
          pose.height
        );
        assert.ok(screen, `behind camera at ${x},${y}`);
        worst = Math.max(worst, Math.hypot(screen[0] - x, screen[1] - y));
      }
    }
  }
  assert.ok(worst <= 0.5, `round trip ${worst} px`);
  pass('round-trip', `worst ${worst.toExponential(2)} px over ${poses.length} poses (limit 0.5)`);
}

// 2. Baked data.
const baked = JSON.parse(readFileSync(here('../data/photo-skylines.json'), 'utf8')) as {
  _licence: string;
  _provenance: {classical: string; ml: string; people: string; pose: string};
  photos: PhotoSkyline[];
};
{
  const bytes = statSync(here('../data/photo-skylines.json')).size;
  assert.ok(bytes <= 120 * 1024, `${bytes} bytes`);
  assert.match(baked._provenance.classical, /detectSkyline/);
  assert.match(baked._provenance.ml, /U\u00b2-Net-P.*onnxruntime-web.*threshold 0\.5/);
  assert.match(baked._provenance.people, /MediaPipe/);
  assert.equal(baked.photos.length, 12);
  let total = 0;
  for (const photo of baked.photos) {
    for (const series of ['ml', 'classical'] as const) {
      const samples = photo[series];
      assert.ok(samples.length > 50, `${photo.id} ${series} has ${samples.length} samples`);
      for (let index = 0; index < samples.length; index++) {
        const [azimuth, elevation] = samples[index];
        assert.ok(azimuth >= 0 && azimuth < 360 && elevation > -45 && elevation < 45);
        // Ascending, one sample per 0.1 degree bin.
        if (index > 0) assert.ok(azimuth - samples[index - 1][0] > 0.0949, `${photo.id} order`);
      }
      total += samples.length;
    }
  }
  pass('baked', `${bytes} bytes, ${baked.photos.length} photos, ${total} samples, all in range`);
}

// 3. ML and classical against the DEM horizon, and against each other. The JSON's DEM horizon
// profile (the app's own, every 0.5 degree across the view) stands in for a ring result.
{
  const bins = 720;
  const rows: string[] = [];
  const mlMedians: number[] = [];
  for (const photo of baked.photos) {
    const data = JSON.parse(readFileSync(`${demoDir}${photo.id}.json`, 'utf8'));
    const elevationDeg = new Float32Array(bins).fill(Number.NaN);
    for (const point of data.horizon.profile as {az: number; el: number}[]) {
      elevationDeg[Math.round(point.az / 0.5) % bins] = point.el;
    }
    const ring: RingResult = {
      tangents: new Float32Array(bins),
      elevationDeg,
      peakVisible: new Uint32Array(0),
      peakMarginDeg: new Float32Array(0),
      bins
    };
    const ml = skylineResidualStats([photo], ring, 'ml');
    const classical = skylineResidualStats([photo], ring, 'classical');
    // ML vs classical on shared 0.1 degree bins.
    const classicalByBin = new Map(photo.classical.map(([az, el]) => [Math.round(az * 100), el]));
    const differences: number[] = [];
    for (const [az, el] of photo.ml) {
      const other = classicalByBin.get(Math.round(az * 100));
      if (other !== undefined) differences.push(Math.abs(el - other));
    }
    differences.sort((a, b) => a - b);
    const agreement = differences[Math.floor(differences.length / 2)];
    const confidence = data.app.confidence as number;
    assert.ok(ml.n > 30 && classical.n > 30, `${photo.id}: too few comparable samples`);
    assert.ok(differences.length > 30, `${photo.id}: only ${differences.length} shared bins`);
    if (confidence >= 0.7) {
      assert.ok(
        ml.medianDeg < 1,
        `${photo.id}: ML median ${ml.medianDeg.toFixed(3)} deg vs DEM, confidence ${confidence}`
      );
      mlMedians.push(ml.medianDeg);
    }
    rows.push(
      `  ${photo.id}  conf ${confidence.toFixed(2)}  ` +
        `ML-DEM ${ml.medianDeg.toFixed(3)} (p90 ${ml.p90Deg.toFixed(2)}, n ${ml.n})  ` +
        `classical-DEM ${classical.medianDeg.toFixed(3)} (p90 ${classical.p90Deg.toFixed(2)}, ` +
        `n ${classical.n})  ML-classical ${agreement.toFixed(3)} (n ${differences.length})`
    );
  }
  console.log('  median |delta elevation| in degrees:');
  for (const row of rows) console.log(row);
  pass(
    'ml-vs-dem',
    `${mlMedians.length} photos with confidence >= 0.7, worst ML median ${Math.max(...mlMedians).toFixed(3)} deg (limit 1)`
  );
}

// 4. Layers: plan draws nothing, panorama draws ids with the screen-skyline prefix.
{
  const eye: ENU = [0, 0, 0];
  const pose = {eye, yaw: 260, pitch: -3, roll: 0, vfov: 52, near: 1};
  const project = (enu: ENU) => projectToScreen(pose, enu, 800, 600);
  assert.equal(makeSkylineLayers(baked.photos, null, project, eye, 'plan', 'demo-01').length, 0);
  const layers = makeSkylineLayers(baked.photos, null, project, eye, 'panorama', 'demo-01');
  assert.ok(layers.length >= 3 && layers.every(layer => layer.id.startsWith('screen-skyline')));
  pass('layers', `${layers.map(layer => layer.id).join(', ')}`);
}
