// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import {createSummitViewScene} from './app';
import {resolveDeckExampleDeviceType} from '../deck-example-device';
declare global {
  interface Window {
    summitViewScene: ReturnType<typeof createSummitViewScene>;
  }
}
const backend = document.querySelector<HTMLSelectElement>('#backend')!;
const deviceType = await resolveDeckExampleDeviceType(
  new URLSearchParams(location.search).get('backend')
);
backend.value = deviceType;
const scene = createSummitViewScene(document.querySelector<HTMLDivElement>('#scene')!, {
  deviceType
});
window.summitViewScene = scene;
backend.addEventListener('change', () => {
  location.search = `?backend=${backend.value}`;
});
const photoBlend = document.querySelector<HTMLInputElement>('#photo-blend')!;
photoBlend.addEventListener('input', () => scene.setPhotoBlend(Number(photoBlend.value)));
const labels = document.querySelector<HTMLInputElement>('#labels')!;
labels.addEventListener('change', () => scene.setLabelsVisible(labels.checked));
const earthCurvature = document.querySelector<HTMLInputElement>('#earth-curvature')!;
earthCurvature.addEventListener('change', () => scene.setEarthCurvature(earthCurvature.checked));
const status = document.querySelector('#status')!;
scene.ready
  .then(() => {
    const {tilesLoaded, tilesRequested} = scene.diagnostics;
    status.textContent = `${tilesLoaded} of ${tilesRequested} DEM tiles loaded.`;
    document.body.dataset['ready'] = 'true';
  })
  .catch(error => {
    status.textContent = error.message;
  });
window.addEventListener('pagehide', () => scene.finalize());
