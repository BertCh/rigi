// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import '../../../example-infobox.css';
import {
  getExampleRuntimeEnvironment,
  preflightExampleSupport,
  type ExampleBackend
} from '../../../example-support';
import exampleSupport from '../mobile-support';
import {createPhotoGraphScene, type PhotoGraphDiagnostics} from './app';

declare global {
  interface Window {
    photoGraphScene?: ReturnType<typeof createPhotoGraphScene>;
  }
}

const status = document.querySelector<HTMLElement>('#status')!;

async function main(): Promise<void> {
  const requestedBackend = new URLSearchParams(location.search).get('backend');
  const preflight = preflightExampleSupport(
    exampleSupport,
    getExampleRuntimeEnvironment(window, navigator),
    {backends: await getAvailableBackends(requestedBackend)}
  );
  if (!preflight.supported) {
    showUnsupported(preflight.reason);
    return;
  }

  document.documentElement.dataset['lumaExampleState'] = 'loading';
  const scene = createPhotoGraphScene(document.querySelector<HTMLElement>('#scene')!, {
    onUpdate: updateInfobox
  });
  window.photoGraphScene = scene;
  const threshold = document.querySelector<HTMLInputElement>('#threshold')!;
  threshold.addEventListener('input', () => {
    document.querySelector('#threshold-value')!.textContent = threshold.value;
    void scene.setThreshold(Number(threshold.value));
  });
  const photo = document.querySelector<HTMLInputElement>('#photo')!;
  photo.addEventListener('change', async () => {
    const file = photo.files?.[0];
    if (!file) return;
    const bitmap = await createImageBitmap(file);
    await scene.setPhoto(bitmap);
    bitmap.close();
  });
  window.addEventListener('pagehide', () => scene.finalize());
  try {
    await scene.ready;
    document.body.dataset['ready'] = 'true';
    document.documentElement.dataset['lumaExampleState'] = 'running';
  } catch (error) {
    document.documentElement.dataset['lumaExampleState'] = 'failed';
    status.textContent = error instanceof Error ? error.message : String(error);
  }
}

/** The page's `?backend=webgl` asks for WebGL2 only, which this compute example cannot use. */
async function getAvailableBackends(requestedBackend: string | null): Promise<ExampleBackend[]> {
  const backends: ExampleBackend[] = [];
  if ('WebGL2RenderingContext' in window) backends.push('webgl2');
  if (requestedBackend === 'webgl') return backends;
  try {
    const gpu = (navigator as Navigator & {gpu?: {requestAdapter: () => Promise<unknown>}}).gpu;
    if (gpu && (await gpu.requestAdapter())) backends.push('webgpu');
  } catch {
    // A present but unusable WebGPU API counts as unavailable.
  }
  return backends;
}

function showUnsupported(reason: string): void {
  document.documentElement.dataset['lumaExampleState'] = 'unsupported';
  document.body.dataset['ready'] = 'unsupported';
  const alert = document.createElement('div');
  alert.dataset['lumaExampleStatus'] = 'unsupported';
  alert.setAttribute('role', 'alert');
  alert.className = 'unsupported';
  const heading = document.createElement('strong');
  heading.textContent = 'This example is not supported on this device.';
  const explanation = document.createElement('span');
  explanation.textContent = reason;
  alert.append(heading, explanation);
  document.body.append(alert);
  status.textContent = reason;
}

/** The plain-text "Graph readout": nodes, per-node GPU ms where timestamp queries exist, dispatches. */
function updateInfobox(diagnostics: PhotoGraphDiagnostics): void {
  const lines = diagnostics.nodes.map(node => {
    const outcome = node.outcome === 'executed' ? '' : ` ${node.outcome}`;
    const time = node.gpuMs !== undefined ? `${node.gpuMs.toFixed(3)} ms` : '-';
    return `${node.id.padEnd(12)} ${node.type.padEnd(8)} ${time.padStart(10)}${outcome}`;
  });
  lines.push(
    '',
    `nodes ${diagnostics.nodes.length}, dispatches ${diagnostics.dispatchCount}, passes ${diagnostics.passCount}`,
    `graph ${diagnostics.gpuMs.toFixed(3)} ms (${diagnostics.gpuTiming})`,
    `image ${diagnostics.width} x ${diagnostics.height}, skyline in ${diagnostics.skylineColumns} columns`
  );
  document.querySelector('#readout')!.textContent = lines.join('\n');
  status.textContent = 'Bands, left to right: image, luminance, blur, gradient, skyline.';
}

void main();
