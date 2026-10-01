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
import {createHorizonGraphScene, type HorizonGraphDiagnostics} from './app';

declare global {
  interface Window {
    horizonGraphScene?: ReturnType<typeof createHorizonGraphScene>;
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
  const scene = createHorizonGraphScene(document.querySelector<HTMLElement>('#scene')!, {
    onUpdate: updateInfobox
  });
  window.horizonGraphScene = scene;
  for (const [identifier, setter, toValue] of [
    ['bins', scene.setAzimuthBins, Number],
    ['max-distance', scene.setMaxDistance, (value: string) => Number(value) * 1000],
    ['heading', scene.setHeading, Number],
    ['field-of-view', scene.setFieldOfView, Number]
  ] as const) {
    const input = document.querySelector<HTMLInputElement | HTMLSelectElement>(`#${identifier}`)!;
    input.addEventListener('input', () => setter(toValue(input.value)));
  }
  window.addEventListener('pagehide', () => scene.finalize());
  status.textContent = 'Fetching Mapterhorn tiles…';
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

function updateInfobox(diagnostics: HorizonGraphDiagnostics): void {
  const setText = (identifier: string, text: string) => {
    document.querySelector(`#${identifier}`)!.textContent = text;
  };
  setText(
    'gpu-time',
    `${diagnostics.gpuMs.toFixed(2)} ms${diagnostics.gpuTiming === 'wall-clock' ? ' (wall)' : ''}`
  );
  setText('cpu-time', `${diagnostics.cpuMs.toFixed(1)} ms`);
  setText(
    'max-delta',
    `${diagnostics.maxAbsDeltaDegrees.toExponential(1)}° (${diagnostics.maxTangentUlps} ULP)`
  );
  setText(
    'mismatched',
    `${diagnostics.mismatchedBins} / ${diagnostics.bins} (${diagnostics.identicalBins} bit-identical)`
  );
  setText('max-distance-value', `${(diagnostics.maximumDistance / 1000).toFixed(0)} km`);
  const rows = diagnostics.nodes.map(node => {
    const row = document.createElement('tr');
    for (const text of [
      node.id,
      node.outcome === 'skipped'
        ? 'skipped'
        : node.gpuMs !== undefined
          ? `${node.gpuMs.toFixed(3)}`
          : '–'
    ]) {
      const cell = document.createElement('td');
      cell.textContent = text;
      row.append(cell);
    }
    return row;
  });
  document.querySelector('#graph-nodes')!.replaceChildren(...rows);
  status.textContent = `${diagnostics.tileCount} z11 tiles · eye ${diagnostics.eyeAltitude.toFixed(0)} m (DEM ${diagnostics.groundAltitude.toFixed(0)} m). Hover the skyline for azimuth, elevation and distance.`;
}

void main();
