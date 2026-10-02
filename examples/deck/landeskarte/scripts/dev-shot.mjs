// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors
// Scratch: one page, console + screenshot. node dev-shot.mjs <backend> <query> <name> [evalJs]
import {mkdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {createServer} from 'vite';
import {GPU_ARGS} from '../../../gpu-args.mjs';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const [backend, query = '', name = 'shot', evalJs = ''] = process.argv.slice(2);
mkdirSync('/tmp/lk', {recursive: true});
const server = await createServer({root, logLevel: 'error', server: {host: '127.0.0.1', port: 0}});
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch({headless: true, args: GPU_ARGS});
try {
  const page = await browser.newPage({viewport: {width: 1280, height: 900}});
  page.on('pageerror', e => console.log('PAGEERROR', e.message));
  page.on('console', m => {
    if (!m.location().url.includes('mapterhorn') && !m.text().includes('willReadFrequently'))
      console.log(m.type().toUpperCase(), m.text().slice(0, 1500));
  });
  await page.goto(`${url}?backend=${backend}&reveal=off${query}`);
  await page.waitForFunction(() => document.body.dataset.ready, undefined, {timeout: 120000});
  console.log('ready', await page.evaluate(() => document.body.dataset.ready));
  await page
    .waitForFunction(
      () => {
        const d = window.landeskarteScene.diagnostics;
        return d.computeBackend !== 'none' && d.tilesLoaded + d.tilesFailed >= d.tilesRequested;
      },
      undefined,
      {timeout: 90000}
    )
    .catch(() => console.log('settle timeout'));
  if (evalJs) console.log('eval', JSON.stringify(await page.evaluate(evalJs)));
  await page.evaluate(async () => {
    await window.landeskarteScene.waitForFrame();
    await window.landeskarteScene.waitForFrame();
  });
  console.log(
    JSON.stringify(
      await page.evaluate(() => ({...window.landeskarteScene.diagnostics, pose: undefined}))
    )
  );
  await page.screenshot({path: join('/tmp/lk', `${name}.png`)});
} finally {
  await browser.close();
  await server.close();
}
