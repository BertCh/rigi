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
const screenshotDirectory = process.env.PHOTO_DRAPE_SCREENSHOTS || join(tmpdir(), 'photo-drape');
mkdirSync(screenshotDirectory, {recursive: true});

// Flown into the photo, the canvas shows the photo itself wherever the terrain was seen. Below
// the skyline (rows 45–100 %) the mean absolute difference from the photo, downscaled in the page,
// measured 1.6 (WebGPU) and 1.7 (WebGL2) of 255 per channel. The residue is near-field DEM facets
// the photo camera did not see, one-texel shadow edges along ridges, and resampling. The hillshade
// alone scores 42.5. Above the skyline the canvas shows its CSS sky, not the photo's clouds, so
// that band is not compared. 8 leaves 5× headroom over the measurement and stays far below the
// hillshade. (A 1° pose error would shift the shoreline by about 17 px; not measured here.)
const PHOTO_MATCH_THRESHOLD = 8;

const server = await createServer({root, logLevel: 'error', server: {host: '127.0.0.1', port: 0}});
await server.listen();
const url = process.env.PHOTO_DRAPE_EXAMPLE_URL || server.resolvedUrls.local[0];

/** Luminance spread of a screenshot, decoded in the page (no image dependencies). */
async function measureDeviation(page, screenshot) {
  return page.evaluate(async base64 => {
    const bitmap = await createImageBitmap(
      await (await fetch(`data:image/png;base64,${base64}`)).blob()
    );
    const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
    context.drawImage(bitmap, 0, 0);
    const {data} = context.getImageData(0, 0, bitmap.width, bitmap.height);
    let sum = 0;
    let sumOfSquares = 0;
    for (let offset = 0; offset < data.length; offset += 4) {
      const luminance =
        0.2126 * data[offset] + 0.7152 * data[offset + 1] + 0.0722 * data[offset + 2];
      sum += luminance;
      sumOfSquares += luminance * luminance;
    }
    const count = data.length / 4;
    return Math.sqrt(Math.max(sumOfSquares / count - (sum / count) ** 2, 0));
  }, screenshot.toString('base64'));
}

/**
 * Compares two images in the page. `second` is a screenshot or, when null, the photo
 * `niederhorn.jpg` scaled to the screenshot's size. Returns the mean absolute difference per
 * channel over rows `top`..100 % and the fraction of those pixels that differ by more than 12.
 */
async function compareImages(page, first, second, top = 0) {
  return page.evaluate(
    async ({firstBase64, secondBase64, top}) => {
      const decode = async source => createImageBitmap(await (await fetch(source)).blob());
      const firstBitmap = await decode(`data:image/png;base64,${firstBase64}`);
      const secondBitmap = await decode(
        secondBase64 ? `data:image/png;base64,${secondBase64}` : './niederhorn.jpg'
      );
      const {width, height} = firstBitmap;
      const read = bitmap => {
        const context = new OffscreenCanvas(width, height).getContext('2d');
        context.drawImage(bitmap, 0, 0, width, height);
        return context.getImageData(0, 0, width, height).data;
      };
      const firstData = read(firstBitmap);
      const secondData = read(secondBitmap);
      let sum = 0;
      let changed = 0;
      let count = 0;
      for (let row = Math.floor(top * height); row < height; row++) {
        for (let column = 0; column < width; column++) {
          const offset = (row * width + column) * 4;
          let difference = 0;
          for (let channel = 0; channel < 3; channel++) {
            difference += Math.abs(firstData[offset + channel] - secondData[offset + channel]);
          }
          sum += difference / 3;
          if (difference / 3 > 12) changed++;
          count++;
        }
      }
      return {meanDifference: sum / count, changedFraction: changed / count};
    },
    {firstBase64: first.toString('base64'), secondBase64: second?.toString('base64'), top}
  );
}

async function openScene(browser, query, errors) {
  // 1200 × 900 CSS pixels: the 4:3 canvas fills the page exactly.
  const page = await browser.newPage({viewport: {width: 1200, height: 900}});
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

function getDiagnostics(page) {
  return page.evaluate(() => ({...window.photoDrapeScene.diagnostics}));
}

function waitForFrame(page) {
  return page.evaluate(() => window.photoDrapeScene.waitForFrame());
}

try {
  for (const backend of process.env.PHOTO_DRAPE_BACKEND
    ? [process.env.PHOTO_DRAPE_BACKEND]
    : ['webgpu', 'webgl']) {
    const browser = await chromium.launch({headless: true, args: GPU_ARGS});
    try {
      const errors = [];
      const page = await openScene(browser, `?backend=${backend}`, errors);
      const scene = page.locator('#scene');
      const diagnostics = await getDiagnostics(page);
      console.log(
        `${backend}: ${diagnostics.tilesLoaded}/${diagnostics.tilesRequested} tiles, ` +
          `${diagnostics.tilesFailed} failed, ${diagnostics.frames} frames, ` +
          `${diagnostics.shadowMapPasses} shadow-map pass, photo ${diagnostics.photoLoaded}`
      );
      assert.equal(diagnostics.backend, backend, `${backend}: requested backend`);
      assert.equal(diagnostics.error, '', `${backend}: scene errors`);
      assert(diagnostics.frames > 0, `${backend}: frames rendered`);
      assert.equal(diagnostics.tilesFailed, 0, `${backend}: no DEM tile failed`);
      assert.equal(diagnostics.tilesLoaded, diagnostics.tilesRequested, `${backend}: all tiles`);
      assert.equal(diagnostics.shadowMapPasses, 1, `${backend}: one shadow-map pass`);

      const orbit = await scene.screenshot({
        path: join(screenshotDirectory, `orbit-${backend}.png`)
      });
      const deviation = await measureDeviation(page, orbit);
      console.log(`${backend}: orbit luminance deviation ${deviation.toFixed(1)}`);
      assert(deviation > 15, `${backend}: canvas is not uniform`);

      // The comparisons below look at the canvas only.
      await page.addStyleTag({content: 'aside, .attribution { display: none !important; }'});
      await page.evaluate(() => window.photoDrapeScene.setFrustumVisible(false));
      await waitForFrame(page);
      const photoLoaded = diagnostics.photoLoaded;
      if (photoLoaded) {
        const draped = await scene.screenshot();
        await page.evaluate(() => window.photoDrapeScene.setDrapeOpacity(0));
        await waitForFrame(page);
        const hillshade = await scene.screenshot({
          path: join(screenshotDirectory, `hillshade-${backend}.png`)
        });
        const {changedFraction} = await compareImages(page, draped, hillshade);
        console.log(`${backend}: draped pixels ${(100 * changedFraction).toFixed(1)} % of canvas`);
        assert(changedFraction > 0.05, `${backend}: the drape differs from the hillshade`);
        await page.evaluate(() => window.photoDrapeScene.setDrapeOpacity(1));
      } else {
        console.log(`${backend}: niederhorn.jpg missing, drape checks skipped`);
        assert(
          await page.locator('#drape-opacity').isDisabled(),
          `${backend}: drape opacity disabled without the photo`
        );
      }

      // Orbiting redraws the terrain but never the shadow map.
      const framesBeforeOrbit = (await getDiagnostics(page)).frames;
      for (const rotationOrbit of [150, 190, 260, 330]) {
        await page.evaluate(
          value => window.photoDrapeScene.setOrbitViewState({rotationOrbit: value, rotationX: 50}),
          rotationOrbit
        );
        await waitForFrame(page);
      }
      // A side view from the south-west: slopes facing away from the photo stay untextured.
      await page.evaluate(() =>
        window.photoDrapeScene.setOrbitViewState({rotationOrbit: 40, rotationX: 45, zoom: -5.4})
      );
      await page.evaluate(() => window.photoDrapeScene.setShadowedAreasVisible(true));
      await waitForFrame(page);
      const tinted = await scene.screenshot({
        path: join(screenshotDirectory, `shadow-tint-${backend}.png`)
      });
      await page.evaluate(() => window.photoDrapeScene.setShadowedAreasVisible(false));
      await waitForFrame(page);
      const untinted = await scene.screenshot({
        path: join(screenshotDirectory, `side-${backend}.png`)
      });
      const tint = await compareImages(page, tinted, untinted);
      console.log(`${backend}: shadowed (tinted) ${(100 * tint.changedFraction).toFixed(1)} %`);
      assert(tint.changedFraction > 0.02, `${backend}: shadowed areas are tinted`);
      const afterOrbit = await getDiagnostics(page);
      assert(afterOrbit.frames > framesBeforeOrbit + 5, `${backend}: orbit frames`);
      assert.equal(afterOrbit.shadowMapPasses, 1, `${backend}: no shadow pass while orbiting`);

      // Fly into the photo: the deck.gl transition ends exactly in the photo camera.
      await page.evaluate(() => window.photoDrapeScene.flyIntoPhoto(1500));
      const viewport = await page.evaluate(() => {
        const [orbitViewport] = window.photoDrapeScene.deck.getViewports();
        return {roll: orbitViewport.roll, cameraPosition: [...orbitViewport.cameraPosition]};
      });
      const lensOffset = Math.hypot(
        viewport.cameraPosition[0],
        viewport.cameraPosition[1],
        viewport.cameraPosition[2] - 1918.89
      );
      console.log(
        `${backend}: flown in, eye ${lensOffset.toFixed(2)} m from the lens, ` +
          `roll ${viewport.roll.toFixed(3)}°`
      );
      assert(lensOffset < 2, `${backend}: the orbit eye reaches the photo lens`);
      assert(Math.abs(viewport.roll + 2.4126) < 0.01, `${backend}: the photo roll is applied`);
      const flownIn = await scene.screenshot({
        path: join(screenshotDirectory, `flown-in-${backend}.png`)
      });
      if (photoLoaded) {
        const match = await compareImages(page, flownIn, null, 0.45);
        await page.evaluate(() => window.photoDrapeScene.setDrapeOpacity(0));
        await waitForFrame(page);
        const hillshadeMatch = await compareImages(page, await scene.screenshot(), null, 0.45);
        await page.evaluate(() => window.photoDrapeScene.setDrapeOpacity(1));
        console.log(
          `${backend}: flown in vs photo, mean |Δ| ${match.meanDifference.toFixed(1)} ` +
            `(hillshade ${hillshadeMatch.meanDifference.toFixed(1)}) below the skyline`
        );
        assert(
          match.meanDifference < PHOTO_MATCH_THRESHOLD,
          `${backend}: flown in, the canvas matches the photo`
        );
      }
      assert.equal(
        (await getDiagnostics(page)).shadowMapPasses,
        1,
        `${backend}: no shadow pass during the flight`
      );

      await page.evaluate(() => window.photoDrapeScene.resetOrbit(500));
      await page.evaluate(() => {
        window.photoDrapeScene.finalize();
        window.photoDrapeScene.finalize();
      });
      assert.deepEqual(errors, [], `${backend}: GPU/browser errors`);
      console.log(`${backend}: terrain, shadow map, drape, flight and cleanup passed`);

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
          {timeout: 120_000}
        );
        assert.equal(
          await fallbackPage.evaluate(() => window.photoDrapeScene.diagnostics.backend),
          'webgl',
          'default falls back when WebGPU is absent'
        );
        assert.equal(await fallbackPage.locator('#backend').inputValue(), 'webgl');
        await fallbackPage.evaluate(() => window.photoDrapeScene.finalize());
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
