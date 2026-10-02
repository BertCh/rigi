// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Offline bake: turns each photo's skyline (image column -> sky boundary row) into world
// directions (azimuth, elevation in degrees) through the solved pinhole pose, and writes
// data/photo-skylines.json. Two skylines per photo: `ml`, from the U2-Net-P neural sky segmenter run
// here under onnxruntime-web (wasm) on the photo, and `classical`, Rigi's dependency-free detector
// output stored in the gipfelbuch JSON. Geometry only: no pixel of any photo ships.
// Run from the repository root (needs its node_modules: onnxruntime-web, @napi-rs/canvas):
//   node examples/deck/landeskarte/scripts/bake-skylines.mjs
//
// Inputs (read only, relative to the repository root):
//   public/demo/gipfelbuch/demo-NN.json  skyline.rows/weight (800 px working width), app pose, photo size
//   public/demo/masks/people-masks.bin   gzip'd "RPM1" masks of MediaPipe selfie_multiclass_256, used
//                                        only to drop columns where a person cuts the skyline
//   public/demo/photos/demo-NN.jpg      the photos, decoded and resized to the 800 px working width
//   public/models/skyseg-u2netp.873ea284.onnx  U2-Net-P sky model (MIT, xiongzhu666)
//   examples/deck/landeskarte/data/stations.json  station ids and UTC minutes
//
// The ML preprocessing mirrors src/lib/sky/core.ts and model.ts for the wasm backend: planar RGB
// 0..1 at the working size, area-average resample to modelSize(W, H, 384) (long side 384, both
// sides a multiple of 32), ImageNet mean/std normalisation, NCHW float32; the output is P(sky) at
// that size, bilinearly upsampled back to the working size (no guided filter).

import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {gunzipSync} from 'node:zlib';
import {createRequire} from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const exampleRoot = resolve(here, '..');
const demoRoot = resolve(exampleRoot, '../../../public/demo');
const outFile = join(exampleRoot, 'data', 'photo-skylines.json');
const repoRoot = resolve(exampleRoot, '../../..');
const requireFromRepo = createRequire(join(repoRoot, 'package.json'));
const ort = await import(pathToFileURL(requireFromRepo.resolve('onnxruntime-web')).href);
const {createCanvas, loadImage} = requireFromRepo('@napi-rs/canvas');
const ortVersion = JSON.parse(
  readFileSync(join(repoRoot, 'node_modules/onnxruntime-web/package.json'), 'utf8')
).version;
const MODEL_FILE = join(repoRoot, 'public/models/skyseg-u2netp.873ea284.onnx');
const MODEL_LONG_SIDE = 384;
const ML_THRESHOLD = 0.5;
const SPIKE_REACH = 4;
const SPIKE_DEG = 0.75;
/** An ML sky run shorter than this (working px) at the top does not count as sky (specks). */
const MIN_SKY_PX = 6;

const DEG = Math.PI / 180;
/** Columns weighted below this by the detector are not a usable boundary (keeps the confident part). */
const MIN_WEIGHT = 0.7;
/** One output sample per this many degrees of azimuth. */
const AZIMUTH_STEP = 0.1;
/** The classical series is the fainter secondary line and gets half the resolution (size budget). */
const CLASSICAL_STEP = 0.2;
/** A person mask pixel this close (working px) to the boundary row drops the column. */
const PERSON_REACH_PX = 12;
const PERSON_THRESHOLD = 128;
const BYTE_BUDGET = 120 * 1024;

/** Optical axis, image-right and image-up of a pose; the same maths as views/getCameraAxes. */
function cameraAxes(yawDeg, pitchDeg, rollDeg) {
  const yaw = yawDeg * DEG;
  const pitch = pitchDeg * DEG;
  const roll = rollDeg * DEG;
  const forward = [
    Math.sin(yaw) * Math.cos(pitch),
    Math.cos(yaw) * Math.cos(pitch),
    Math.sin(pitch)
  ];
  const levelRight = [Math.cos(yaw), -Math.sin(yaw), 0];
  const levelUp = [
    levelRight[1] * forward[2] - levelRight[2] * forward[1],
    levelRight[2] * forward[0] - levelRight[0] * forward[2],
    levelRight[0] * forward[1] - levelRight[1] * forward[0]
  ];
  const cosine = Math.cos(roll);
  const sine = Math.sin(roll);
  const right = levelRight.map((v, i) => v * cosine - levelUp[i] * sine);
  const up = levelUp.map((v, i) => v * cosine + levelRight[i] * sine);
  return {forward, right, up};
}

/** Parse the people-masks layout: "RPM1", u32 count, then id length, id, u16 w, u16 h, w*h bytes. */
function readPeopleMasks(file) {
  const masks = new Map();
  if (!existsSync(file)) return masks;
  const bytes = gunzipSync(readFileSync(file));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.toString('latin1', 0, 4) !== 'RPM1') return masks;
  const count = view.getUint32(4, true);
  let at = 8;
  for (let index = 0; index < count; index++) {
    const idLength = bytes[at++];
    const id = bytes.toString('latin1', at, at + idLength);
    at += idLength;
    const width = view.getUint16(at, true);
    const height = view.getUint16(at + 2, true);
    at += 4;
    if (width && height)
      masks.set(id, {width, height, data: bytes.subarray(at, at + width * height)});
    at += width * height;
  }
  return masks;
}

function personNearBoundary(mask, column, row, width, height) {
  if (!mask) return false;
  const mx = Math.min(mask.width - 1, Math.floor(((column + 0.5) / width) * mask.width));
  const lo = Math.max(0, Math.floor(((row - PERSON_REACH_PX) / height) * mask.height));
  const hi = Math.min(mask.height - 1, Math.ceil(((row + PERSON_REACH_PX) / height) * mask.height));
  for (let my = lo; my <= hi; my++) {
    if (mask.data[my * mask.width + mx] >= PERSON_THRESHOLD) return true;
  }
  return false;
}

// ---- ML: mirrors src/lib/sky/core.ts (modelSize, resamplePlanes, rgbPlanes, normalise) ----

function modelSize(w, h, longSide) {
  const s = longSide / Math.max(w, h);
  const r = v => Math.max(64, Math.round((v * s) / 32) * 32);
  return {width: r(w), height: r(h)};
}

/** Area-average (down) or bilinear (up) resample of one axis; same arithmetic as core.ts. */
function resampleAxis(src, n, stride, count, cstride, m, out, ostride, ocstride) {
  const scale = n / m;
  for (let j = 0; j < m; j++) {
    if (scale > 1) {
      const a = j * scale;
      const b = a + scale;
      const i0 = Math.floor(a);
      const i1 = Math.min(n, Math.ceil(b));
      for (let k = 0; k < count; k++) {
        let acc = 0;
        for (let i = i0; i < i1; i++) {
          acc += (Math.min(b, i + 1) - Math.max(a, i)) * src[k * cstride + i * stride];
        }
        out[k * ocstride + j * ostride] = acc / scale;
      }
    } else {
      const t = (j + 0.5) * scale - 0.5;
      const i0 = Math.max(0, Math.min(n - 1, Math.floor(t)));
      const i1 = Math.min(n - 1, i0 + 1);
      const f = Math.max(0, Math.min(1, t - i0));
      for (let k = 0; k < count; k++) {
        out[k * ocstride + j * ostride] =
          src[k * cstride + i0 * stride] * (1 - f) + src[k * cstride + i1 * stride] * f;
      }
    }
  }
}

function resamplePlanes(src, w, h, channels, W, H) {
  if (w === W && h === H) return src;
  const tmp = new Float32Array(channels * h * W);
  for (let c = 0; c < channels; c++) {
    resampleAxis(src.subarray(c * w * h), w, 1, h, w, W, tmp.subarray(c * W * h), 1, W);
  }
  const out = new Float32Array(channels * H * W);
  for (let c = 0; c < channels; c++) {
    resampleAxis(tmp.subarray(c * W * h), h, W, W, 1, H, out.subarray(c * W * H), W, 1);
  }
  return out;
}

function rgbPlanes(rgba, n) {
  const out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    out[i] = rgba[4 * i] / 255;
    out[n + i] = rgba[4 * i + 1] / 255;
    out[2 * n + i] = rgba[4 * i + 2] / 255;
  }
  return out;
}

const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
function normalise(rgb, n) {
  const out = new Float32Array(3 * n);
  for (let c = 0; c < 3; c++) {
    const scale = 1 / STD[c];
    for (let i = 0; i < n; i++) out[c * n + i] = (rgb[c * n + i] - MEAN[c]) * scale;
  }
  return out;
}

async function decodeWorking(file, width) {
  const image = await loadImage(file);
  const height = Math.round((image.height * width) / image.width);
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0, width, height);
  return {width, height, data: context.getImageData(0, 0, width, height).data};
}

/** P(sky) per working pixel (row-major, height x width), from the model at long side 384. */
async function runSkyModel(session, photo) {
  const {width: W, height: H} = photo;
  const {width, height} = modelSize(W, H, MODEL_LONG_SIDE);
  const rgb = resamplePlanes(rgbPlanes(photo.data, W * H), W, H, 3, width, height);
  const input = new ort.Tensor('float32', normalise(rgb, width * height), [1, 3, height, width]);
  const output = await session.run({[session.inputNames[0]]: input});
  const prob = new Float32Array(output[session.outputNames[0]].data);
  return resamplePlanes(prob, width, height, 1, W, H);
}

/** Per column: first row below the topmost sky run where P(sky) < 0.5 (sub-pixel), else null. */
function skyBoundaryRows(prob, W, H) {
  const rows = new Array(W).fill(null);
  for (let x = 0; x < W; x++) {
    let y = 0;
    while (y < H && prob[y * W + x] < ML_THRESHOLD) y++;
    const start = y;
    while (y < H && prob[y * W + x] >= ML_THRESHOLD) y++;
    // No sky, a speck, or sky to the bottom: no boundary.
    if (start >= H || y >= H || y - start < MIN_SKY_PX) continue;
    const above = prob[(y - 1) * W + x];
    const below = prob[y * W + x];
    // Row-centre coordinates: pixel y-1 centre is y - 0.5; interpolate the 0.5 crossing.
    rows[x] = y - 0.5 + (above - ML_THRESHOLD) / Math.max(1e-6, above - below);
  }
  return rows;
}

const round2 = value => Math.round(value * 100) / 100;
const round1 = value => Math.round(value * 10) / 10;

const stations = JSON.parse(
  readFileSync(join(exampleRoot, 'data', 'stations.json'), 'utf8')
).stations;
const masks = readPeopleMasks(join(demoRoot, 'masks', 'people-masks.bin'));

/**
 * Drops samples more than SPIKE_DEG from the median of their +-SPIKE_REACH neighbours: a branch,
 * a post or a cable that the segmentation cut into the sky, not the skyline.
 */
function dropSpikes(samples) {
  return samples.filter(([, elevation], index) => {
    const window = [];
    for (
      let k = Math.max(0, index - SPIKE_REACH);
      k <= Math.min(samples.length - 1, index + SPIKE_REACH);
      k++
    ) {
      if (k !== index) window.push(samples[k][1]);
    }
    window.sort((a, b) => a - b);
    return Math.abs(elevation - window[window.length >> 1]) <= SPIKE_DEG;
  });
}

/** Columns -> (az, el) samples through the pose, one mean per `step` degrees of azimuth. */
function bakeSamples(rows, weights, mask, photo, pose, stats, step) {
  const {width, height} = photo;
  const focal = height / 2 / Math.tan((pose.vfov * DEG) / 2);
  const {forward, right, up} = cameraAxes(pose.yaw, pose.pitch, pose.roll);
  const bins = new Map();
  for (let column = 0; column < rows.length; column++) {
    const row = rows[column];
    if (row === null || !Number.isFinite(row) || !(weights[column] > MIN_WEIGHT)) continue;
    if (personNearBoundary(mask, column, row, width, height)) {
      stats.dropped++;
      continue;
    }
    const x = (column + 0.5 - width / 2) / focal;
    const y = (height / 2 - row) / focal;
    const d = [0, 1, 2].map(i => forward[i] + x * right[i] + y * up[i]);
    const azimuth = (Math.atan2(d[0], d[1]) / DEG + 360) % 360;
    const elevation = Math.asin(d[2] / Math.hypot(d[0], d[1], d[2])) / DEG;
    const key = Math.round(azimuth / step) % Math.round(360 / step);
    const bin = bins.get(key) ?? {el: 0, n: 0};
    bin.el += elevation;
    bin.n++;
    bins.set(key, bin);
  }
  // Azimuth is the bin's centre (grid of multiples of 0.1 degree), elevation the mean.
  return [...bins.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([key, bin]) => [round1(key * step), round2(bin.el / bin.n)]);
}

const tModel = performance.now();
const session = await ort.InferenceSession.create(new Uint8Array(readFileSync(MODEL_FILE)), {
  executionProviders: ['wasm'],
  graphOptimizationLevel: 'all'
});
console.log(
  `model loaded in ${(performance.now() - tModel).toFixed(0)} ms (onnxruntime-web ${ortVersion} wasm)`
);

const photos = [];
for (const station of stations) {
  const data = JSON.parse(readFileSync(join(demoRoot, 'gipfelbuch', `${station.id}.json`), 'utf8'));
  const {rows, weight} = data.skyline;
  const pose = data.app;
  // Both detectors report in WORK-wide pixels; photo.width/height are that working size.
  const photo = {width: data.photo.width, height: data.photo.height};
  const mask = masks.get(station.id) ?? null;
  const classicalStats = {dropped: 0};
  const classical = bakeSamples(rows, weight, mask, photo, pose, classicalStats, CLASSICAL_STEP);

  const t0 = performance.now();
  const decoded = await decodeWorking(join(demoRoot, 'photos', `${station.id}.jpg`), photo.width);
  if (decoded.height !== photo.height) throw new Error(`${station.id}: aspect changed`);
  const prob = await runSkyModel(session, decoded);
  const mlRows = skyBoundaryRows(prob, photo.width, photo.height);
  const ml = dropSpikes(
    bakeSamples(
      mlRows,
      new Array(mlRows.length).fill(1),
      mask,
      photo,
      pose,
      {dropped: 0},
      AZIMUTH_STEP
    )
  );
  const ms = performance.now() - t0;
  photos.push({id: station.id, minutes: station.minutes, classical, ml});
  console.log(
    `${station.id}: classical ${classical.length}, ml ${ml.length} samples ` +
      `(${mlRows.filter(r => r !== null).length}/${mlRows.length} columns with a boundary), ` +
      `${classicalStats.dropped} classical columns dropped by people, decode+infer ${ms.toFixed(0)} ms`
  );
}

const output = {
  _licence:
    'Skylines of photos taken by the project author, 2026-09-07, as world directions (azimuth, elevation in degrees). Geometry only, no pixels. Directions come from solved poses, which are not ground truth. ML boundary from U2-Net-P (MIT, xiongzhu666); people masks (Google MediaPipe selfie_multiclass_256, Apache-2.0) were used only to drop columns.',
  _provenance: {
    classical:
      "Not a neural network. Rigi's dependency-free classical detector detectSkyline (src/lib/geo/skyline.ts): robust polynomial sky-colour field fitted per photo, Viterbi boundary per column over rows, per-column weight; run by scripts/gipfelbuch/build-data.ts at 800 px working width. Columns with weight <= 0.7 are dropped; mean per 0.2 degree of azimuth.",
    ml: `U\u00b2-Net-P (MIT, xiongzhu666/Sky-Segmentation-and-Post-processing), onnxruntime-web ${ortVersion} wasm, input long side ${MODEL_LONG_SIDE} (multiples of 32, 384x288 landscape, 288x384 portrait), threshold ${ML_THRESHOLD}. Photo resized to 800 px wide, ImageNet-normalised, P(sky) bilinearly upsampled to 800 px, boundary = first row below the topmost sky run (>= ${MIN_SKY_PX} px) where P(sky) < ${ML_THRESHOLD}, sub-pixel; columns with no sky or sky to the bottom skipped; samples > ${SPIKE_DEG} deg from the median of their ${2 * SPIKE_REACH} neighbours dropped as spikes. Same preprocessing as src/lib/sky/core.ts, no guided-filter refine.`,
    people:
      'MediaPipe selfie_multiclass_256 (Apache-2.0) masks, used only to drop columns with a person mask pixel within 12 px of the boundary.',
    pose: 'Image (column, row) to azimuth/elevation through the solved pose (data.app) of the Rigi matcher against the Mapterhorn DEM; mean per 0.1 degree (ml) or 0.2 degree (classical) of azimuth.'
  },
  photos
};
const text = `${JSON.stringify(output).replace(/\[\{/, '[\n{').replace(/\},\{/g, '},\n{')}\n`;
writeFileSync(outFile, text);
console.log(`wrote ${outFile} (${text.length} bytes)`);
if (text.length > BYTE_BUDGET) {
  console.error(`over the ${BYTE_BUDGET} byte budget`);
  process.exitCode = 1;
}
