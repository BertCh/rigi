// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Browser smoke test for the Landeskarte example, one fresh Chromium per backend. Needs network
// (Mapterhorn tiles) and a GPU; run through the render lock:
//   node scripts/examples.mjs smoke deck/landeskarte
// Drives the example only through `window.landeskarteScene` and reads pixels back in the page.
import assert from 'node:assert/strict';
import {mkdirSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {createServer} from 'vite';
import {GPU_ARGS} from '../../../gpu-args.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const screenshotDirectory = process.env.LANDESKARTE_SCREENSHOTS || join(tmpdir(), 'landeskarte');
mkdirSync(screenshotDirectory, {recursive: true});

// UTC minutes since 2026-09-07T00:00Z (the scene's clock).
const MINUTES = {
  noon: 11 * 60,
  firstPhoto: 13 * 60 + 28,
  goldenHour: 16 * 60 + 30,
  sunset: 17 * 60 + 45
};
/** `?t=` takes the CEST wall clock as HH:MM (UTC + 2 h), the scene's own time axis. */
function toCestClock(utcMinutes) {
  const cest = (utcMinutes + 120) % 1440;
  return `${String(Math.floor(cest / 60)).padStart(2, '0')}:${String(cest % 60).padStart(2, '0')}`;
}
const EXPECTED_COMPUTE = {webgpu: 'graph', webgl: 'cpu-twin'};
// The horizon map is built one azimuth per dispatch (16 azimuths) on the graph backend.
const HORIZON_MAP_AZIMUTHS = 16;
// Solved demo-01 frame the panorama flight must end on exactly.
const PANORAMA_ROLL_DEG = -2.413;
const LABEL_PEAK = 'Stockhorn';
// Cross-backend pixel difference is reported always, asserted only when a threshold is given:
// the number has to be measured first, not assumed.
const MAX_BACKEND_DIFFERENCE = process.env.LANDESKARTE_MAX_BACKEND_DIFF
  ? Number(process.env.LANDESKARTE_MAX_BACKEND_DIFF)
  : null;

const server = await createServer({root, logLevel: 'error', server: {host: '127.0.0.1', port: 0}});
await server.listen();
const url = process.env.LANDESKARTE_EXAMPLE_URL || server.resolvedUrls.local[0];

/** Pixel statistics of a screenshot, decoded in the page (no image dependencies in node). */
async function measureScene(page, screenshot) {
  return page.evaluate(async base64 => {
    const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0);
    const {data, width, height} = context.getImageData(0, 0, bitmap.width, bitmap.height);
    const luminanceAt = offset =>
      0.2126 * data[offset] + 0.7152 * data[offset + 1] + 0.0722 * data[offset + 2];
    const band = (top, bottom) => {
      let sum = 0;
      let sumOfSquares = 0;
      let count = 0;
      for (let row = Math.floor(top * height); row < Math.floor(bottom * height); row++) {
        for (let column = 0; column < width; column++) {
          const luminance = luminanceAt((row * width + column) * 4);
          sum += luminance;
          sumOfSquares += luminance * luminance;
          count++;
        }
      }
      const mean = sum / count;
      return {mean, deviation: Math.sqrt(Math.max(sumOfSquares / count - mean * mean, 0))};
    };
    // Pixels within a Euclidean RGB distance of a Brezine ink colour.
    const near = (offset, [red, green, blue], distance) =>
      Math.hypot(data[offset] - red, data[offset + 1] - green, data[offset + 2] - blue) < distance;
    let contourInk = 0;
    let routeRed = 0;
    let dark = 0;
    let darkCount = 0;
    const terrainPixels = [];
    for (let row = 0; row < height; row++) {
      for (let column = 0; column < width; column++) {
        const offset = (row * width + column) * 4;
        if (near(offset, [0x95, 0x50, 0x0c], 36)) contourInk++;
        if (near(offset, [0xbf, 0x22, 0x33], 40)) routeRed++;
        // Terrain rows only: above is sky, below the panorama's bottom darkening.
        if (row >= 0.4 * height && row < 0.75 * height) {
          terrainPixels.push(offset);
          darkCount++;
          if (luminanceAt(offset) < 70) dark++;
        }
      }
    }
    // Colour of the lit part: the brightest quarter of the terrain rows. The shaded rest is lit by
    // the sky, which is blue at noon and darker blue at dusk, so it says nothing about the sun.
    terrainPixels.sort((a, b) => luminanceAt(b) - luminanceAt(a));
    let sumRed = 0;
    let sumBlue = 0;
    for (const offset of terrainPixels.slice(0, Math.ceil(terrainPixels.length / 4))) {
      sumRed += data[offset];
      sumBlue += data[offset + 2];
    }
    const pixels = width * height;
    return {
      width,
      height,
      all: band(0, 1),
      sky: band(0.03, 0.15),
      terrain: band(0.4, 0.75),
      contourInk,
      routeRed,
      pixels,
      darkFraction: dark / darkCount,
      redOverBlue: sumRed / sumBlue
    };
  }, screenshot.toString('base64'));
}

/** Mean absolute channel difference (0..255) between two PNGs of equal size, decoded in the page. */
async function meanAbsoluteDifference(page, pngA, pngB) {
  return page.evaluate(
    async ([a, b]) => {
      const read = async base64 => {
        const bitmap = await createImageBitmap(
          await (await fetch(`data:image/png;base64,${base64}`)).blob()
        );
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext('2d');
        context.drawImage(bitmap, 0, 0);
        return context.getImageData(0, 0, bitmap.width, bitmap.height);
      };
      const first = await read(a);
      const second = await read(b);
      if (first.width !== second.width || first.height !== second.height) return null;
      let sum = 0;
      for (let index = 0; index < first.data.length; index += 4) {
        sum +=
          Math.abs(first.data[index] - second.data[index]) +
          Math.abs(first.data[index + 1] - second.data[index + 1]) +
          Math.abs(first.data[index + 2] - second.data[index + 2]);
      }
      return sum / (first.width * first.height * 3);
    },
    [pngA.toString('base64'), pngB.toString('base64')]
  );
}

async function openScene(browser, query, errors) {
  const page = await browser.newPage({viewport: {width: 1200, height: 800}});
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

/** Waits for the compute backend to publish a field and for the DEM stream to drain. */
async function waitForSettled(page, backend) {
  await page.waitForFunction(
    () => {
      const {diagnostics} = window.landeskarteScene;
      return (
        diagnostics.computeBackend !== 'none' &&
        diagnostics.tilesLoaded + diagnostics.tilesFailed >= diagnostics.tilesRequested
      );
    },
    undefined,
    {timeout: 120_000}
  );
  await page.evaluate(async () => {
    await window.landeskarteScene.waitForFrame();
    await window.landeskarteScene.waitForFrame();
  });
  assert.equal(
    await page.evaluate(() => window.landeskarteScene.diagnostics.computeBackend),
    EXPECTED_COMPUTE[backend],
    `${backend}: compute backend`
  );
}

async function setMinutes(page, minutes) {
  await page.evaluate(async value => {
    await window.landeskarteScene.setMinutes(value);
    await window.landeskarteScene.waitForFrame();
    await window.landeskarteScene.waitForFrame();
  }, minutes);
}

/** Screenshot of the scene element (or the first canvas) saved under the screenshot directory. */
async function capture(page, name) {
  const scene = page.locator('#scene');
  const target = (await scene.count()) > 0 ? scene : page.locator('canvas').first();
  const buffer = await target.screenshot({path: join(screenshotDirectory, `${name}.png`)});
  return {buffer, box: await target.boundingBox()};
}

/**
 * Where the scene drew the label of `name` (anchor in canvas pixels) and where the CPU mirror of
 * the viewport projects the OSM peak, both from the page's own modules.
 */
async function measureLabelError(page, name) {
  return page.evaluate(async peakName => {
    const [{loadPeaks}, {SUMMIT_EYE}, {makeFrame, curvatureDrop}, {projectToScreen}] =
      await Promise.all([
        import('/data/load.ts'),
        import('/data/scene-data.ts'),
        import('/geo/geodesy.ts'),
        import('/views/landeskarte-view.ts')
      ]);
    const scene = window.landeskarteScene;
    const frame = makeFrame(SUMMIT_EYE.lat, SUMMIT_EYE.lon, SUMMIT_EYE.h);
    // Three different OSM summits are called Stockhorn: the one in view is the nearest.
    const peak = (await loadPeaks())
      .filter(candidate => candidate.name === peakName)
      .sort((a, b) => {
        const distance = p => Math.hypot(...frame.toEnu(p.lat, p.lon, p.ele).slice(0, 2));
        return distance(a) - distance(b);
      })[0];
    const [east, north, up] = frame.toEnu(peak.lat, peak.lon, peak.ele);
    const enu = [east, north, up - curvatureDrop(Math.hypot(east, north))];
    const {width, height} = scene.deck;
    const projected = projectToScreen(scene.diagnostics.pose, enu, width, height);
    const labels = scene.deck.layerManager
      .getLayers()
      .filter(layer => layer.id.startsWith('screen-labels'))
      .flatMap(layer => (Array.isArray(layer.props.data) ? layer.props.data : []));
    const label = labels.find(candidate => candidate.text === peakName);
    if (!projected || !label) return {width, found: Boolean(label), projected: Boolean(projected)};
    const [x, y] = label.anchor ?? label.position;
    return {
      width,
      found: true,
      projected: true,
      error: Math.hypot(x - projected[0], y - projected[1])
    };
  }, name);
}

/** Label text and positions as drawn, for the cross-backend comparison. */
async function readLabelPositions(page) {
  return page.evaluate(() =>
    Object.fromEntries(
      window.landeskarteScene.deck.layerManager
        .getLayers()
        .filter(layer => layer.id.startsWith('screen-labels'))
        .flatMap(layer => (Array.isArray(layer.props.data) ? layer.props.data : []))
        .filter(label => typeof label.text === 'string' && Array.isArray(label.position))
        .map(label => [label.text, label.position])
    )
  );
}

const crossBackend = {};

try {
  for (const backend of process.env.LANDESKARTE_BACKEND
    ? [process.env.LANDESKARTE_BACKEND]
    : ['webgpu', 'webgl']) {
    const browser = await chromium.launch({headless: true, args: GPU_ARGS});
    try {
      const errors = [];
      const page = await openScene(browser, `?backend=${backend}&reveal=off&mode=plan`, errors);
      await waitForSettled(page, backend);
      const diagnostics = await page.evaluate(() => ({...window.landeskarteScene.diagnostics}));
      console.log(
        `${backend}: ${diagnostics.tilesLoaded}/${diagnostics.tilesRequested} tiles, ` +
          `${diagnostics.tilesFailed} failed, ${diagnostics.frames} frames, ` +
          `compute ${diagnostics.computeBackend}`
      );
      assert.equal(diagnostics.backend, backend, `${backend}: requested backend`);
      assert.equal(diagnostics.error, '', `${backend}: scene errors`);
      assert(diagnostics.frames > 0, `${backend}: frames rendered`);
      assert(diagnostics.tilesLoaded > 0, `${backend}: DEM tiles loaded`);
      assert(
        diagnostics.tilesLoaded >= 0.9 * diagnostics.tilesRequested,
        `${backend}: most DEM tiles loaded`
      );
      assert(diagnostics.stationsLoaded > 0, `${backend}: stations loaded`);
      assert.equal(diagnostics.mode, 'plan', `${backend}: starts as a plan sheet`);

      // Plan sheet: paper ground with relief, brown contour ink, and no route red until selected.
      const plan = await capture(page, `plan-${backend}`);
      const planStatistics = await measureScene(page, plan.buffer);
      console.log(
        `${backend}: plan luma ${planStatistics.all.mean.toFixed(0)} ` +
          `(deviation ${planStatistics.all.deviation.toFixed(1)}), ` +
          `contour ink ${planStatistics.contourInk} px, route red ${planStatistics.routeRed} px`
      );
      assert(planStatistics.all.deviation > 6, `${backend}: plan sheet is not blank`);
      assert(
        planStatistics.all.mean > 150 && planStatistics.all.mean < 250,
        `${backend}: paper luma in band`
      );
      assert(planStatistics.contourInk > 0, `${backend}: contour ink is drawn`);
      const unselectedRed = planStatistics.routeRed / planStatistics.pixels;
      assert(unselectedRed < 0.0002, `${backend}: no route red without a selection`);

      const stationId = await page.evaluate(async () => {
        const {loadStations} = await import('/data/load.ts');
        return (await loadStations())[0].id;
      });
      await page.evaluate(async id => {
        await window.landeskarteScene.setLayer('trails', true);
        await window.landeskarteScene.selectStation(id);
        await window.landeskarteScene.waitForFrame();
      }, stationId);
      const selected = await capture(page, `plan-selected-${backend}`);
      const selectedStatistics = await measureScene(page, selected.buffer);
      console.log(
        `${backend}: route red with ${stationId} selected ${selectedStatistics.routeRed} px`
      );
      assert(
        selectedStatistics.routeRed > planStatistics.routeRed,
        `${backend}: selection draws route red`
      );
      // Honesty strings: the pose is "solved", and the refraction parameter is labelled.
      // Visible text nodes only: body.textContent would also match inline script and style source.
      const text = await page.evaluate(() => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const parts = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!['SCRIPT', 'STYLE'].includes(node.parentElement?.tagName ?? '')) {
            parts.push(node.textContent);
          }
        }
        return parts.join(' ');
      });
      assert(/solved/i.test(text), `${backend}: "solved" is stated`);
      assert(/k\s*=\s*/.test(text), `${backend}: "k = " parameter label is in the DOM`);
      await page.evaluate(() => window.landeskarteScene.selectStation(null));

      // Lift: the flight must end exactly on the solved summit frame.
      await page.evaluate(async () => {
        await window.landeskarteScene.setMode('panorama');
        await window.landeskarteScene.waitForFrame();
      });
      await page.waitForFunction(
        () => window.landeskarteScene.diagnostics.mode === 'panorama',
        undefined,
        {timeout: 30_000}
      );
      const flight = await page.evaluate(async () => {
        const [{SUMMIT_EYE, SUMMIT_FRAME_VIEW}, {makeFrame}, {getPanoramaPose}] = await Promise.all(
          [
            import('/data/scene-data.ts'),
            import('/geo/geodesy.ts'),
            import('/views/landeskarte-view.ts')
          ]
        );
        const {pose} = window.landeskarteScene.diagnostics;
        const target = getPanoramaPose(
          undefined,
          makeFrame(SUMMIT_EYE.lat, SUMMIT_EYE.lon, SUMMIT_EYE.h)
        );
        return {
          pose,
          eyeError: Math.hypot(...pose.eye.map((value, axis) => value - target.eye[axis])),
          rollError: pose.roll - SUMMIT_FRAME_VIEW.roll
        };
      });
      console.log(
        `${backend}: flight ends ${flight.eyeError.toFixed(3)} m from the target, ` +
          `roll ${flight.pose.roll.toFixed(3)} deg`
      );
      assert(flight.eyeError < 0.005, `${backend}: eye lands exactly on the summit frame`);
      assert(
        Math.abs(flight.pose.roll - PANORAMA_ROLL_DEG) < 0.001,
        `${backend}: roll ${PANORAMA_ROLL_DEG}`
      );

      // Panorama at the first photo (15:28 CEST): sky above terrain, labels where the CPU projects.
      await setMinutes(page, MINUTES.firstPhoto);
      const panorama = await capture(page, `panorama-1528-${backend}`);
      const panoramaStatistics = await measureScene(page, panorama.buffer);
      console.log(
        `${backend}: sky ${panoramaStatistics.sky.mean.toFixed(0)}, ` +
          `terrain ${panoramaStatistics.terrain.mean.toFixed(0)}`
      );
      // The terrain is a pale map tone and the sky a real blue, so "brighter" is the wrong test:
      // the sky band must be a smooth, distinct tone above the textured terrain band.
      assert(
        Math.abs(panoramaStatistics.sky.mean - panoramaStatistics.terrain.mean) > 20 &&
          panoramaStatistics.sky.deviation < panoramaStatistics.terrain.deviation,
        `${backend}: panorama sky is a smooth tone distinct from the terrain`
      );
      const labelError = await measureLabelError(page, LABEL_PEAK);
      assert(labelError.found, `${backend}: ${LABEL_PEAK} label is placed`);
      assert(labelError.projected, `${backend}: ${LABEL_PEAK} projects in front of the camera`);
      console.log(
        `${backend}: ${LABEL_PEAK} label ${labelError.error.toFixed(2)} px from the CPU projection`
      );
      assert(
        labelError.error < 0.01 * labelError.width,
        `${backend}: ${LABEL_PEAK} label error < 1% width`
      );
      crossBackend[backend] = {
        png: panorama.buffer,
        labels: await readLabelPositions(page),
        size: panorama.box
      };

      // Light: shadows grow towards sunset and the grade warms.
      await setMinutes(page, MINUTES.noon);
      const noon = await measureScene(
        page,
        (await capture(page, `panorama-1100z-${backend}`)).buffer
      );
      await setMinutes(page, MINUTES.sunset);
      const sunset = await measureScene(
        page,
        (await capture(page, `panorama-1745z-${backend}`)).buffer
      );
      console.log(
        `${backend}: shadowed fraction ${noon.darkFraction.toFixed(3)} (11:00Z) -> ` +
          `${sunset.darkFraction.toFixed(3)} (17:45Z), R/B ${noon.redOverBlue.toFixed(3)} -> ` +
          `${sunset.redOverBlue.toFixed(3)}`
      );
      assert(
        sunset.darkFraction > noon.darkFraction,
        `${backend}: more shadow at 17:45Z than 11:00Z`
      );
      // Golden hour, not dusk: at 17:45Z the sun is 2 degrees up behind the hills and nearly the
      // whole panorama is in shade, so the lit pixels that carry the sun's colour are too few.
      await setMinutes(page, MINUTES.goldenHour);
      const golden = await measureScene(
        page,
        (await capture(page, `panorama-1630z-${backend}`)).buffer
      );
      console.log(
        `${backend}: lit-pixel R/B ${noon.redOverBlue.toFixed(3)} (11:00Z) -> ` +
          `${golden.redOverBlue.toFixed(3)} (16:30Z)`
      );
      assert(golden.redOverBlue > noon.redOverBlue, `${backend}: golden hour is warmer than noon`);
      await setMinutes(page, MINUTES.sunset);
      const light = await page.evaluate(() => {
        const {shadowPasses, sunElevation, minutes} = window.landeskarteScene.diagnostics;
        return {shadowPasses, sunElevation, minutes};
      });
      assert.equal(
        Math.round(light.minutes),
        MINUTES.sunset,
        `${backend}: clock follows setMinutes`
      );
      assert(light.sunElevation < 5, `${backend}: sun is low at 17:45Z`);
      assert(
        light.shadowPasses >= (backend === 'webgpu' ? HORIZON_MAP_AZIMUTHS : 1),
        `${backend}: shadow passes ran (${light.shadowPasses})`
      );

      // GPU against CPU twin: only the graph backend has two sides to compare.
      if (backend === 'webgpu') {
        const parity = await page.evaluate(async () => window.landeskarteScene.runParity());
        for (const report of [parity].flat().filter(Boolean)) {
          console.log(
            `${backend}: parity ${report.subject} max ${report.maxAbsDeg.toExponential(2)} deg, ` +
              `${report.overTolerance}/${report.total} over ${report.toleranceDeg} deg, ` +
              `${report.shadowFlips} shadow flips (in ULP band: ${report.flipsWithinUlpBand})`
          );
          // A sample position that lands on a texel edge can round to the neighbouring texel in f32
          // on one side only, which moves one angle by a few quantisation steps. Allow one in 10^5.
          assert(
            report.overTolerance <= report.total * 1e-5,
            `${backend}: parity ${report.subject} in tolerance (${report.overTolerance} over)`
          );
          assert(report.flipsWithinUlpBand, `${backend}: shadow flips only at the threshold`);
        }
      }

      // Frozen capture: with ?t= and reveal off, two shots of an idle scene are identical.
      const frozen = await openScene(
        browser,
        `?backend=${backend}&reveal=off&mode=panorama&t=${toCestClock(MINUTES.sunset)}`,
        errors
      );
      await waitForSettled(frozen, backend);
      const first = await capture(frozen, `frozen-a-${backend}`);
      await frozen.evaluate(() => window.landeskarteScene.waitForFrame());
      const second = await capture(frozen, `frozen-b-${backend}`);
      assert(first.buffer.equals(second.buffer), `${backend}: frozen ?t= capture is deterministic`);
      assert.equal(
        Math.round(await frozen.evaluate(() => window.landeskarteScene.diagnostics.minutes)),
        MINUTES.sunset,
        `${backend}: ?t= sets the clock`
      );
      await frozen.evaluate(() => {
        window.landeskarteScene.finalize();
        window.landeskarteScene.finalize();
      });
      await frozen.close();

      await page.evaluate(() => {
        window.landeskarteScene.finalize();
        window.landeskarteScene.finalize();
      });
      assert.equal(await page.evaluate(() => window.landeskarteScene.diagnostics.finalized), true);
      assert.deepEqual(errors, [], `${backend}: GPU/browser errors`);
      console.log(`${backend}: plan, lift, light, parity, frozen capture and cleanup passed`);

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
          await fallbackPage.evaluate(() => window.landeskarteScene.diagnostics.backend),
          'webgl',
          'default falls back when WebGPU is absent'
        );
        assert.equal(await fallbackPage.locator('#backend').inputValue(), 'webgl');
        await fallbackPage.evaluate(() => window.landeskarteScene.finalize());
        assert.deepEqual(fallbackErrors, []);
        await fallbackContext.close();
        console.log('Default backend: absent WebGPU falls back to WebGL2');
      }
    } finally {
      await browser.close();
    }
  }

  if (crossBackend.webgpu && crossBackend.webgl) {
    const browser = await chromium.launch({headless: true});
    try {
      const page = await browser.newPage();
      const difference = await meanAbsoluteDifference(
        page,
        crossBackend.webgpu.png,
        crossBackend.webgl.png
      );
      const labelNames = Object.keys(crossBackend.webgpu.labels).filter(
        name => name in crossBackend.webgl.labels
      );
      let worst = 0;
      for (const name of labelNames) {
        const [ax, ay] = crossBackend.webgpu.labels[name];
        const [bx, by] = crossBackend.webgl.labels[name];
        worst = Math.max(worst, Math.hypot(ax - bx, ay - by));
      }
      console.log(
        `WebGPU vs WebGL, 15:28 CEST panorama: mean abs diff ${difference?.toFixed(2)} / 255, ` +
          `${labelNames.length} common labels, worst label offset ${worst.toFixed(2)} px`
      );
      assert(difference !== null, 'both backends rendered the same canvas size');
      assert(worst <= 1, 'label positions agree across backends within 1 px');
      if (MAX_BACKEND_DIFFERENCE !== null) {
        assert(difference <= MAX_BACKEND_DIFFERENCE, 'backends agree on the same state');
      }
      writeFileSync(
        join(screenshotDirectory, 'cross-backend.json'),
        JSON.stringify(
          {meanAbsoluteDifference: difference, labels: labelNames.length, worst},
          null,
          2
        )
      );
    } finally {
      await browser.close();
    }
  }
  console.log(`Screenshots: ${screenshotDirectory}`);
} finally {
  await server.close();
}
