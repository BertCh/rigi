// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Renders the gallery thumbnail (480 x 320 JPEG) from the live example: the Landeskarte plan sheet
// by default, or the panorama in late-afternoon light with LANDESKARTE_THUMBNAIL_MODE=panorama.
// Needs network for DEM tiles and a GPU, so run it under the render lock:
//   node scripts/gpu/with-render-lock.mjs -- node examples/deck/landeskarte/scripts/make-thumbnail.mjs
//   LANDESKARTE_THUMBNAIL_MINUTES=990 ... (UTC minutes since midnight 7 Sep 2026)
import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {createServer} from 'vite';
import {GPU_ARGS} from '../../../gpu-args.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = process.env.LANDESKARTE_THUMBNAIL || join(root, 'thumbnail.jpg');
const backend = process.env.LANDESKARTE_BACKEND || 'webgpu';
// 16:30 UTC = 18:30 CEST: sun about 10 degrees up in the west, long shadows in the valleys.
const minutes = Number(process.env.LANDESKARTE_THUMBNAIL_MINUTES || 990);
const clock = `${String(Math.floor((minutes + 120) / 60) % 24).padStart(2, '0')}:${String((minutes + 120) % 60).padStart(2, '0')}`;
// The spec's thumbnail is the plan sheet (open map data, Mapterhorn credit in frame); pass
// LANDESKARTE_THUMBNAIL_MODE=panorama for the lit summit view.
const mode = process.env.LANDESKARTE_THUMBNAIL_MODE || 'plan';
// Shot at 3x the gallery size and downsampled in the page: type stays crisp at 480 x 320.
const OUTPUT_SIZE = {width: 480, height: 320};
const SCALE = 3;

mkdirSync(dirname(output), {recursive: true});
const server = await createServer({root, logLevel: 'error', server: {host: '127.0.0.1', port: 0}});
await server.listen();
const url = process.env.LANDESKARTE_EXAMPLE_URL || server.resolvedUrls.local[0];

try {
  const browser = await chromium.launch({headless: true, args: GPU_ARGS});
  try {
    const page = await browser.newPage({
      viewport: {width: OUTPUT_SIZE.width * SCALE, height: OUTPUT_SIZE.height * SCALE}
    });
    page.on('pageerror', error => console.error(error.message));
    // t = frozen sun time, reveal=off = final frame without the load animation.
    await page.goto(`${url}?backend=${backend}&reveal=off&mode=${mode}&t=${clock}`);
    await page.waitForFunction(() => document.body.dataset.ready === 'true', undefined, {
      timeout: 120_000
    });
    // The shadow field arrives after the first frame; wait for it, then for streamed DEM tiles.
    await page.waitForFunction(
      () => {
        const {diagnostics} = window.landeskarteScene;
        return diagnostics.computeBackend !== 'none' && diagnostics.tilesLoaded > 0;
      },
      undefined,
      {timeout: 120_000}
    );
    await page.waitForFunction(
      () => {
        const {tilesLoaded, tilesFailed, tilesRequested} = window.landeskarteScene.diagnostics;
        return tilesLoaded + tilesFailed >= tilesRequested;
      },
      undefined,
      {timeout: 120_000}
    );
    await page.evaluate(async () => {
      await window.landeskarteScene.waitForFrame();
      await window.landeskarteScene.waitForFrame();
    });

    const diagnostics = await page.evaluate(() => ({...window.landeskarteScene.diagnostics}));
    if (diagnostics.error || diagnostics.backend !== backend) {
      throw new Error(
        `scene not healthy: backend "${diagnostics.backend}", error "${diagnostics.error}"`
      );
    }

    const scene = page.locator('#scene');
    const target = (await scene.count()) > 0 ? scene : page.locator('canvas').first();
    const png = await target.screenshot();
    const jpeg = await page.evaluate(
      async ({base64, width, height}) => {
        const bitmap = await createImageBitmap(
          await (await fetch(`data:image/png;base64,${base64}`)).blob()
        );
        const canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext('2d');
        context.imageSmoothingQuality = 'high';
        context.drawImage(bitmap, 0, 0, width, height);
        const blob = await canvas.convertToBlob({type: 'image/jpeg', quality: 0.84});
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = '';
        for (let index = 0; index < bytes.length; index += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
        }
        return btoa(binary);
      },
      {base64: png.toString('base64'), ...OUTPUT_SIZE}
    );
    const bytes = Buffer.from(jpeg, 'base64');
    writeFileSync(output, bytes);
    console.log(
      `${output}: ${OUTPUT_SIZE.width} x ${OUTPUT_SIZE.height}, ${(bytes.length / 1024).toFixed(1)} KiB, ` +
        `${backend}, ${diagnostics.tilesLoaded}/${diagnostics.tilesRequested} tiles`
    );
    await page.evaluate(() => window.landeskarteScene.finalize());
  } finally {
    await browser.close();
  }
} finally {
  await server.close();
}
