// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Loads the example in headless Chromium on the real GPU and checks the GPU skyline against the
// CPU twin, the rendered panorama, the graph's conditional decode, and the WebGL2 fallback message.
// Screenshots go to HORIZON_GRAPH_SHOTS_DIR (default: the OS temp directory).

import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {createServer} from 'vite';

/** Chromium flags for real-GPU WebGPU in headless mode on macOS (Metal). */
const GPU_ARGS = [
  '--use-angle=metal',
  '--enable-gpu',
  '--ignore-gpu-blocklist',
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan,WebGPU'
];
/** Documented bound: no bin may differ from the CPU twin by more than 1e-3 degrees. */
const MAXIMUM_MISMATCHED_BINS = 0;

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const shotsDirectory = process.env.HORIZON_GRAPH_SHOTS_DIR || tmpdir();
mkdirSync(shotsDirectory, {recursive: true});
const server = await createServer({root, logLevel: 'error', server: {host: '127.0.0.1', port: 0}});
await server.listen();
const url = server.resolvedUrls.local[0];

/** Fraction of pixels right of the infobox that differ clearly from the sky clear colour. */
async function getNonSkyFraction(page) {
  const screenshot = (await page.screenshot()).toString('base64');
  return page.evaluate(async base64 => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = new OffscreenCanvas(image.width, image.height);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const {data, width, height} = context.getImageData(0, 0, image.width, image.height);
    const sky = [5, 10, 20];
    let count = 0;
    let total = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 300; x < width; x++) {
        const offset = (y * width + x) * 4;
        total++;
        if (sky.some((value, channel) => Math.abs(data[offset + channel] - value) > 12)) count++;
      }
    }
    return count / total;
  }, screenshot);
}

function trackErrors(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return errors;
}

const browser = await chromium.launch({headless: true, args: GPU_ARGS});
try {
  const page = await browser.newPage({viewport: {width: 1280, height: 760}});
  const errors = trackErrors(page);
  await page.goto(url);
  await page.waitForFunction(() => document.body.dataset.ready, undefined, {timeout: 120_000});
  assert.equal(await page.evaluate(() => document.body.dataset.ready), 'true', 'scene ready');
  await page.waitForFunction(() => window.horizonGraphScene.diagnostics.frames > 0);
  const first = await page.evaluate(() => structuredClone(window.horizonGraphScene.diagnostics));
  console.log(
    `webgpu: ${first.bins} bins, GPU ${first.gpuMs.toFixed(3)} ms (${first.gpuTiming}), CPU twin ${first.cpuMs.toFixed(1)} ms, ` +
      `max |Δ| ${first.maxAbsDeltaDegrees.toExponential(2)}°, mismatched ${first.mismatchedBins}, identical ${first.identicalBins}, max ${first.maxTangentUlps} ULP`
  );
  console.log(
    `  eye ${first.eyeAltitude.toFixed(1)} m (DEM ${first.groundAltitude.toFixed(1)} m), highest skyline ${first.highestElevation.toFixed(2)}° at ${first.highestAzimuth.toFixed(1)}°`
  );
  console.log(
    `  nodes: ${first.nodes.map(node => `${node.id}=${node.outcome}${node.gpuMs !== undefined ? `/${node.gpuMs.toFixed(3)}ms` : ''}`).join(', ')}`
  );
  for (const peak of first.peaks) {
    console.log(
      `  ${peak.name}: az ${peak.azimuth.toFixed(2)}°, el ${peak.elevation.toFixed(2)}°, ${(peak.distance / 1000).toFixed(1)} km, visible ${peak.visible}`
    );
  }
  await page.screenshot({path: join(shotsDirectory, 'horizon-graph-webgpu.png')});
  assert.equal(first.backend, 'webgpu');
  assert.equal(first.error, '');
  assert(first.frames > 0, 'frames rendered');
  assert(
    first.mismatchedBins <= MAXIMUM_MISMATCHED_BINS,
    `mismatched bins ${first.mismatchedBins}`
  );
  assert.equal(first.nodes[0].id, 'decode-terrarium');
  assert.equal(first.nodes[0].outcome, 'executed', 'first run decodes the mosaic');
  for (const name of ['Eiger', 'Mönch', 'Jungfrau']) {
    const peak = first.peaks.find(candidate => candidate.name === name);
    assert(peak.visible, `${name} is on the skyline`);
    assert(peak.azimuth > 125 && peak.azimuth < 150, `${name} lies to the south-east`);
  }
  // The GPS fix lies on the south slope, so the nearby summit ridge tops the northern skyline;
  // across the southern half the Bernese Alps must be highest.
  const southernPeak = await page.evaluate(() => {
    const {tangents} = window.horizonGraphScene.getHorizonProfile();
    let highestBin = tangents.length / 4;
    for (let bin = tangents.length / 4; bin < (3 * tangents.length) / 4; bin++) {
      if (tangents[bin] > tangents[highestBin]) highestBin = bin;
    }
    return (highestBin / tangents.length) * 360;
  });
  console.log(`  highest southern skyline at ${southernPeak.toFixed(1)}°`);
  assert(southernPeak > 125 && southernPeak < 150, 'the Bernese Alps top the southern skyline');
  const nonSky = await getNonSkyFraction(page);
  console.log(`  non-sky pixels ${(nonSky * 100).toFixed(1)}%`);
  assert(nonSky > 0.1, 'canvas shows the silhouette');

  // Hover readout and a zoomed view of the Eiger–Mönch–Jungfrau group (render-only setters).
  await page.evaluate(() => {
    window.horizonGraphScene.setHeading(138);
    window.horizonGraphScene.setFieldOfView(60);
  });
  await page.mouse.move(640, 300);
  await page.waitForTimeout(300);
  await page.screenshot({path: join(shotsDirectory, 'horizon-graph-webgpu-alps.png')});

  // A rebuilt graph at 4096 bins and a shorter ray re-encode without decoding again.
  const runs = first.runs;
  await page.evaluate(() => window.horizonGraphScene.setAzimuthBins(4096));
  await page.waitForFunction(count => window.horizonGraphScene.diagnostics.runs > count, runs);
  const rebuilt = await page.evaluate(() => structuredClone(window.horizonGraphScene.diagnostics));
  console.log(
    `webgpu: ${rebuilt.bins} bins, GPU ${rebuilt.gpuMs.toFixed(3)} ms, CPU twin ${rebuilt.cpuMs.toFixed(1)} ms, ` +
      `max |Δ| ${rebuilt.maxAbsDeltaDegrees.toExponential(2)}°, mismatched ${rebuilt.mismatchedBins}`
  );
  assert.equal(rebuilt.bins, 4096);
  assert.equal(rebuilt.nodes[0].outcome, 'skipped', 'heights persist across graph rebuilds');
  assert(
    rebuilt.mismatchedBins <= MAXIMUM_MISMATCHED_BINS,
    `mismatched bins ${rebuilt.mismatchedBins}`
  );
  await page.evaluate(() => window.horizonGraphScene.setMaxDistance(15_000));
  await page.waitForFunction(
    count => window.horizonGraphScene.diagnostics.runs > count,
    rebuilt.runs
  );
  const shortened = await page.evaluate(() =>
    structuredClone(window.horizonGraphScene.diagnostics)
  );
  assert.equal(shortened.maximumDistance, 15_000);
  assert(!shortened.peaks.find(peak => peak.name === 'Eiger').visible, 'Eiger is beyond 15 km');
  assert(shortened.mismatchedBins <= MAXIMUM_MISMATCHED_BINS);
  await page.evaluate(() => {
    window.horizonGraphScene.finalize();
    window.horizonGraphScene.finalize();
  });
  assert.equal(await page.evaluate(() => window.horizonGraphScene.diagnostics.error), '');
  assert.deepEqual(errors, [], 'webgpu: page errors');
  console.log('webgpu: skyline, CPU twin, render, rebuild, conditional decode and cleanup passed');

  // WebGL2 cannot run the compute graph: the page must explain that instead of failing.
  const fallbackPage = await browser.newPage({viewport: {width: 1280, height: 760}});
  const fallbackErrors = trackErrors(fallbackPage);
  await fallbackPage.goto(`${url}?backend=webgl`);
  await fallbackPage.waitForFunction(() => document.body.dataset.ready === 'unsupported');
  const message = await fallbackPage.textContent('[data-luma-example-status="unsupported"]');
  assert.match(message, /requires WebGPU/);
  assert.equal(await fallbackPage.evaluate(() => window.horizonGraphScene), undefined);
  assert.deepEqual(fallbackErrors, [], 'webgl: page errors');
  await fallbackPage.screenshot({
    path: join(shotsDirectory, 'horizon-graph-webgl-unsupported.png')
  });
  console.log(`webgl: unsupported message rendered: "${message}"`);
} finally {
  await browser.close();
  await server.close();
}
