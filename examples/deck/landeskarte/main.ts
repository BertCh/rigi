// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import {resolveDeckExampleDeviceType} from '../deck-example-device';
import {createLandeskarteScene} from './app';
import './ui/controls.css';
import './ui/furniture.css';
import './style.css';

declare global {
  interface Window {
    landeskarteScene: ReturnType<typeof createLandeskarteScene>;
  }
}

const params = new URLSearchParams(location.search);
const backend = document.querySelector<HTMLSelectElement>('#backend')!;
const status = document.querySelector<HTMLElement>('#status')!;
const deviceType = await resolveDeckExampleDeviceType(params.get('backend'));
backend.value = deviceType;
backend.addEventListener('change', () => {
  const next = new URLSearchParams(location.search);
  next.set('backend', backend.value);
  location.search = `?${next.toString()}`;
});

/** `?t=HH:MM` is the CEST wall clock (UTC + 2 h on 7 September 2026) and freezes the capture. */
function parseClock(text: string | null): number | undefined {
  const match = text ? /^(\d{1,2}):(\d{2})$/.exec(text) : null;
  return match ? Number(match[1]) * 60 + Number(match[2]) - 120 : undefined;
}

const minutes = parseClock(params.get('t'));
const modeParam = params.get('mode');
const scene = createLandeskarteScene(document.querySelector<HTMLDivElement>('#scene')!, {
  deviceType,
  mode: modeParam === 'panorama' ? 'panorama' : 'plan',
  minutes,
  reveal: params.get('reveal') !== 'off' && minutes === undefined,
  controlsHost: document.querySelector<HTMLElement>('#controls')!,
  drawersHost: document.querySelector<HTMLElement>('#drawers')!,
  onStatus: text => {
    status.textContent = text;
  }
});
window.landeskarteScene = scene;

scene.ready
  .then(() => {
    const {tilesLoaded, tilesRequested} = scene.diagnostics;
    status.textContent = `${tilesLoaded} von ${tilesRequested} Geländekacheln geladen.`;
    document.body.dataset['ready'] = 'true';
  })
  .catch(error => {
    status.textContent = error.message;
    document.body.dataset['ready'] = 'error';
  });
window.addEventListener('pagehide', () => scene.finalize());
