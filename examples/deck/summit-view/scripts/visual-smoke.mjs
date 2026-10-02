// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {createServer} from 'vite';
import {GPU_ARGS} from '../../../gpu-args.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const screenshotDirectory = process.env.SUMMIT_VIEW_SCREENSHOTS || join(tmpdir(), 'summit-view');
mkdirSync(screenshotDirectory, {recursive: true});

// Where Rigi's own renderer places these summits in the 800 × 600 photo at the solved pose
// (public/demo/gipfelbuch/demo-01.json `peaks[].solved`): an independent check of the camera model.
const REFERENCE_LABELS = {
  Niesen: [72.1, 221.9],
  Kaiseregg: [390.8, 258.5],
  Stockhorn: [441.3, 255.4],
  Gantrisch: [488, 260.4]
};

const server = await createServer({root, logLevel: 'error', server: {host: '127.0.0.1', port: 0}});
await server.listen();
const url = process.env.SUMMIT_VIEW_EXAMPLE_URL || server.resolvedUrls.local[0];

/** Luminance statistics of the scene screenshot, decoded in the page (no image dependencies). */
async function measureScene(page, screenshot) {
  return page.evaluate(async base64 => {
    const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0);
    const {data, width, height} = context.getImageData(0, 0, bitmap.width, bitmap.height);
    // Right of the info box: columns 40–98 %. Sky band: rows 5–20 %. Ground band: rows 70–95 %.
    const measureBand = (top, bottom) => {
      let sum = 0;
      let sumOfSquares = 0;
      let count = 0;
      for (let row = Math.floor(top * height); row < Math.floor(bottom * height); row++) {
        for (let column = Math.floor(0.4 * width); column < Math.floor(0.98 * width); column++) {
          const offset = (row * width + column) * 4;
          const luminance =
            0.2126 * data[offset] + 0.7152 * data[offset + 1] + 0.0722 * data[offset + 2];
          sum += luminance;
          sumOfSquares += luminance * luminance;
          count++;
        }
      }
      const mean = sum / count;
      return {mean, deviation: Math.sqrt(Math.max(sumOfSquares / count - mean * mean, 0))};
    };
    return {sky: measureBand(0.05, 0.2), ground: measureBand(0.7, 0.95), all: measureBand(0, 1)};
  }, screenshot.toString('base64'));
}

async function openScene(browser, query, errors) {
  const page = await browser.newPage({viewport: {width: 1100, height: 800}});
  page.on('pageerror', error => {
    errors.push(error.message);
    console.error(error.message);
  });
  page.on('console', message => {
    // A missing DEM tile is a coverage gap, counted in diagnostics.tilesFailed.
    if (message.type() === 'error' && !message.location().url.includes('tiles.mapterhorn.com')) {
      errors.push(message.text());
      console.error(message.text());
    }
  });
  await page.goto(`${url}${query}`);
  await page.waitForFunction(() => document.body.dataset.ready === 'true', undefined, {
    timeout: 120_000
  });
  return page;
}

try {
  for (const backend of process.env.SUMMIT_VIEW_BACKEND
    ? [process.env.SUMMIT_VIEW_BACKEND]
    : ['webgpu', 'webgl']) {
    const browser = await chromium.launch({headless: true, args: GPU_ARGS});
    try {
      const errors = [];
      const page = await openScene(browser, `?backend=${backend}`, errors);
      const diagnostics = await page.evaluate(() => ({...window.summitViewScene.diagnostics}));
      console.log(
        `${backend}: ${diagnostics.tilesLoaded}/${diagnostics.tilesRequested} tiles, ` +
          `${diagnostics.tilesFailed} failed, ${diagnostics.frames} frames`
      );
      assert.equal(diagnostics.backend, backend, `${backend}: requested backend`);
      assert.equal(diagnostics.error, '', `${backend}: scene errors`);
      assert(diagnostics.frames > 0, `${backend}: frames rendered`);
      assert(diagnostics.tilesLoaded > 0, `${backend}: DEM tiles loaded`);
      assert(
        diagnostics.tilesLoaded >= 0.9 * diagnostics.tilesRequested,
        `${backend}: most DEM tiles loaded`
      );

      const scene = page.locator('#scene');
      const box = await scene.boundingBox();
      for (const [name, [referenceX, referenceY]] of Object.entries(REFERENCE_LABELS)) {
        const label = diagnostics.labels.find(candidate => candidate.name === name);
        const scale = box.width / 800;
        const error = Math.hypot(label.x - referenceX * scale, label.y - referenceY * scale);
        console.log(`${backend}: ${name} ${error.toFixed(1)} px from Rigi's solved position`);
        assert(error < 0.01 * box.width, `${backend}: ${name} projects where Rigi places it`);
        assert(label.visible, `${backend}: ${name} is not occluded`);
      }

      // Render only: terrain must be visible, with a bright sky above darker ground.
      await page.uncheck('#labels');
      await page.evaluate(() => window.summitViewScene.waitForFrame());
      const render = await scene.screenshot({
        path: join(screenshotDirectory, `render-${backend}.png`)
      });
      const statistics = await measureScene(page, render);
      console.log(
        `${backend}: sky ${statistics.sky.mean.toFixed(0)}, ground ${statistics.ground.mean.toFixed(0)}, ` +
          `deviation ${statistics.all.deviation.toFixed(1)}`
      );
      assert(statistics.sky.mean - statistics.ground.mean > 30, `${backend}: sky above terrain`);
      assert(statistics.all.deviation > 20, `${backend}: canvas is not uniform`);
      assert(statistics.ground.deviation > 4, `${backend}: terrain is shaded`);

      await page.check('#labels');
      await page.evaluate(() => window.summitViewScene.waitForFrame());
      await scene.screenshot({path: join(screenshotDirectory, `labels-${backend}.png`)});
      if (await page.evaluate(() => window.summitViewScene.diagnostics.photoLoaded)) {
        await page.locator('#photo-blend').fill('0.5');
        await page.evaluate(() => window.summitViewScene.waitForFrame());
        const blended = await scene.screenshot({
          path: join(screenshotDirectory, `blend-${backend}.png`)
        });
        assert.notDeepEqual(blended, render, `${backend}: photo blend changes the canvas`);
      } else {
        console.log(`${backend}: niederhorn.jpg missing, photo blend check skipped`);
      }
      await page.uncheck('#earth-curvature');
      await page.evaluate(() => window.summitViewScene.waitForFrame());
      await scene.screenshot({path: join(screenshotDirectory, `flat-earth-${backend}.png`)});
      const flatNiesen = await page.evaluate(
        () => window.summitViewScene.diagnostics.labels.find(label => label.name === 'Niesen').y
      );
      const curvedNiesen = diagnostics.labels.find(label => label.name === 'Niesen').y;
      assert(flatNiesen < curvedNiesen, `${backend}: without curvature distant summits rise`);

      await page.evaluate(() => {
        window.summitViewScene.finalize();
        window.summitViewScene.finalize();
      });
      assert.deepEqual(errors, [], `${backend}: GPU/browser errors`);
      console.log(`${backend}: terrain, labels, photo blend, curvature and cleanup passed`);

      if (backend === 'webgl') {
        // Without ?backend and without WebGPU the example must fall back to WebGL2.
        const fallbackErrors = [];
        const fallbackContext = await browser.newContext();
        await fallbackContext.addInitScript(() => {
          Object.defineProperty(navigator, 'gpu', {value: undefined});
        });
        const fallbackPage = await fallbackContext.newPage();
        fallbackPage.on('pageerror', error => fallbackErrors.push(error.message));
        await fallbackPage.goto(url);
        await fallbackPage.waitForFunction(
          () => document.body.dataset.ready === 'true',
          undefined,
          {
            timeout: 120_000
          }
        );
        assert.equal(
          await fallbackPage.evaluate(() => window.summitViewScene.diagnostics.backend),
          'webgl',
          'default falls back when WebGPU is absent'
        );
        assert.equal(await fallbackPage.locator('#backend').inputValue(), 'webgl');
        await fallbackPage.evaluate(() => window.summitViewScene.finalize());
        assert.deepEqual(fallbackErrors, []);
        await fallbackContext.close();
        console.log('Default backend: absent WebGPU falls back to WebGL2');
      }
    } finally {
      await browser.close();
    }
  }
  console.log(`Screenshots: ${screenshotDirectory}`);
} finally {
  await server.close();
}
