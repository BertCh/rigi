// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import {createPhotoDrapeScene} from './app';
import {resolveDeckExampleDeviceType} from '../deck-example-device';
declare global {
  interface Window {
    photoDrapeScene: ReturnType<typeof createPhotoDrapeScene>;
  }
}
const backend = document.querySelector<HTMLSelectElement>('#backend')!;
const deviceType = await resolveDeckExampleDeviceType(
  new URLSearchParams(location.search).get('backend')
);
backend.value = deviceType;
const scene = createPhotoDrapeScene(document.querySelector<HTMLDivElement>('#scene')!, {
  deviceType
});
window.photoDrapeScene = scene;
backend.addEventListener('change', () => {
  location.search = `?backend=${backend.value}`;
});
const drapeOpacity = document.querySelector<HTMLInputElement>('#drape-opacity')!;
drapeOpacity.addEventListener('input', () => scene.setDrapeOpacity(Number(drapeOpacity.value)));
const shadowedAreas = document.querySelector<HTMLInputElement>('#shadowed-areas')!;
shadowedAreas.addEventListener('change', () =>
  scene.setShadowedAreasVisible(shadowedAreas.checked)
);
const frustum = document.querySelector<HTMLInputElement>('#frustum')!;
frustum.addEventListener('change', () => scene.setFrustumVisible(frustum.checked));
document.querySelector('#fly-into-photo')!.addEventListener('click', () => scene.flyIntoPhoto());
document.querySelector('#reset-orbit')!.addEventListener('click', () => scene.resetOrbit());
const status = document.querySelector('#status')!;
scene.ready
  .then(() => {
    const {tilesLoaded, tilesRequested} = scene.diagnostics;
    status.textContent = `${tilesLoaded} of ${tilesRequested} DEM tiles loaded.`;
    if (!scene.diagnostics.photoLoaded) {
      drapeOpacity.disabled = true;
      status.textContent += ' Photo not found (niederhorn.jpg): shadow map only, no drape.';
    }
    document.body.dataset['ready'] = 'true';
  })
  .catch(error => {
    status.textContent = error.message;
  });
window.addEventListener('pagehide', () => scene.finalize());
