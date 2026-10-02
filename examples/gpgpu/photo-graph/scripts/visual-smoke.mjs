// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Loads the example in headless Chromium on the real GPU, checks the four-node graph ran and found
// a skyline, then checks the WebGL2 fallback message. Screenshots go to PHOTO_GRAPH_SHOTS_DIR
// (default: the OS temp directory).

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

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const shotsDirectory = process.env.PHOTO_GRAPH_SHOTS_DIR || tmpdir();
mkdirSync(shotsDirectory, {recursive: true});
const server = await createServer({root, logLevel: 'error', server: {host: '127.0.0.1', port: 0}});
await server.listen();
const url = server.resolvedUrls.local[0];

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
  await page.waitForFunction(() => document.body.dataset.ready, undefined, {timeout: 60_000});
  assert.equal(await page.evaluate(() => document.body.dataset.ready), 'true', 'scene ready');
  const first = await page.evaluate(() => structuredClone(window.photoGraphScene.diagnostics));
  console.log(
    `webgpu: ${first.nodes.map(node => node.id).join(' > ')}, ${first.dispatchCount} dispatches in ` +
      `${first.passCount} passes, ${first.gpuMs.toFixed(3)} ms (${first.gpuTiming}), ` +
      `skyline in ${first.skylineColumns} columns, mean row ${first.skylineMeanRow.toFixed(1)}`
  );
  await page.screenshot({path: join(shotsDirectory, 'photo-graph-webgpu.png')});
  assert.equal(first.backend, 'webgpu');
  assert.equal(first.error, '');
  assert.deepEqual(
    first.nodes.map(node => node.id),
    ['luminance', 'blur', 'gradient', 'skyline']
  );
  assert.equal(first.dispatchCount, 4);
  // The ridges fill the lower half of the image, so most columns find an edge below the sky.
  assert(first.skylineColumns > first.width * 0.9, 'skyline found in most columns');
  assert(first.skylineMeanRow > 120 && first.skylineMeanRow < 320, 'skyline lies on the ridges');

  // A very high threshold finds no edge; a re-run reuses the compiled graph.
  await page.evaluate(() => window.photoGraphScene.setThreshold(1000));
  const flat = await page.evaluate(() => structuredClone(window.photoGraphScene.diagnostics));
  assert(flat.runs > first.runs, 're-ran the graph');
  assert.equal(flat.skylineColumns, 0, 'no edge above an unreachable threshold');
  await page.evaluate(() => {
    window.photoGraphScene.finalize();
    window.photoGraphScene.finalize();
  });
  assert.deepEqual(errors, [], 'webgpu: page errors');
  console.log('webgpu: graph, skyline, threshold re-run and cleanup passed');

  // WebGL2 cannot run the compute graph: the page must explain that instead of failing.
  const fallbackPage = await browser.newPage({viewport: {width: 1280, height: 760}});
  const fallbackErrors = trackErrors(fallbackPage);
  await fallbackPage.goto(`${url}?backend=webgl`);
  await fallbackPage.waitForFunction(() => document.body.dataset.ready === 'unsupported');
  const message = await fallbackPage.textContent('[data-luma-example-status="unsupported"]');
  assert.match(message, /requires WebGPU/);
  assert.deepEqual(fallbackErrors, [], 'webgl: page errors');
  console.log(`webgl: unsupported message rendered: "${message}"`);
} finally {
  await browser.close();
  await server.close();
}
