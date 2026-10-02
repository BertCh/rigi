// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The "proof" drawer: which backend runs, whether the shadow compute is the luma graph or the CPU
// twin, per-node GPU milliseconds and the GPU-versus-CPU parity table. Closed by default.

import type {Diagnostics, ParityReport} from '../types';
import {h} from './controls';

export type Hud = {
  element: HTMLElement;
  update(diagnostics: Diagnostics): void;
  setOpen(open: boolean): void;
};

export type HudOptions = {
  /** Wired to `scene.runParity`; the button is disabled while it runs. */
  onRunParity?: () => void | Promise<void>;
};

const COMPUTE_LABELS: Record<Diagnostics['computeBackend'], string> = {
  graph: 'graph',
  'cpu-twin': 'CPU twin',
  none: 'kein Compute'
};

function badge(label: string, value: string): HTMLElement {
  return h('span', {class: 'lk-badge'}, [
    h('span', {class: 'lk-badge-label'}, [label]),
    h('span', {class: 'lk-badge-value'}, [value])
  ]);
}

function tableRow(cells: string[], header = false): HTMLTableRowElement {
  const tr = h('tr');
  for (const text of cells) tr.append(h(header ? 'th' : 'td', {}, [text]));
  return tr;
}

function parityRows(parity: ParityReport): string[][] {
  return [
    ['Gegenstand', parity.subject],
    ['max. Abweichung', `${parity.maxAbsDeg.toExponential(2)}° (Grenze ${parity.toleranceDeg}°)`],
    ['über Grenze', `${parity.overTolerance} von ${parity.total}`],
    ['bit-identisch', `${parity.bitIdentical} von ${parity.total}`],
    [
      'Schatten-Flips',
      `${parity.shadowFlips}${parity.shadowFlips > 0 ? (parity.flipsWithinUlpBand ? ', im ULP-Band' : ', ausserhalb ULP-Band') : ''}`
    ],
    ['Zeit CPU / GPU', `${parity.cpuMs.toFixed(1)} / ${parity.gpuMs.toFixed(1)} ms`]
  ];
}

export function createHud(host: HTMLElement, options: HudOptions = {}): Hud {
  const badges = h('div', {class: 'lk-badges'});
  const stats = h('p', {class: 'lk-hud-stats'});
  const errorLine = h('p', {class: 'lk-hud-error', role: 'status'});
  const nodeTable = h('table', {class: 'lk-table'});
  const parityTable = h('table', {class: 'lk-table'});
  const runButton = h('button', {type: 'button', class: 'lk-action'}, ['CPU twin ausführen']);
  const parityNote = h('p', {class: 'lk-muted lk-hud-note'});

  runButton.addEventListener('click', async () => {
    if (!options.onRunParity) return;
    runButton.disabled = true;
    try {
      await options.onRunParity();
    } finally {
      runButton.disabled = false;
    }
  });
  if (!options.onRunParity) runButton.hidden = true;

  const details = h('details', {class: 'lk-drawer lk-hud'}, [
    h('summary', {}, ['Beweis']),
    h('div', {class: 'lk-drawer-body'}, [
      h('div', {class: 'lk-column'}, [badges, stats, errorLine, nodeTable]),
      h('div', {class: 'lk-column'}, [parityTable, parityNote, runButton])
    ])
  ]);
  host.append(details);

  // Rebuilding tables every frame would thrash layout; compare a cheap signature first.
  let badgeSignature = '';
  let nodeSignature = '';
  let paritySignature = '';

  let latest: Diagnostics | null = null;
  const render = (d: Diagnostics): void => {
    // Skip all work while the drawer is closed; opening it renders the latest state at once.
    if (!details.open) return;

    const nextBadges = `${d.backend}|${d.computeBackend}|${d.mode}`;
    if (nextBadges !== badgeSignature) {
      badgeSignature = nextBadges;
      badges.replaceChildren(
        badge(
          'Backend',
          d.backend === 'webgpu' ? 'WebGPU' : d.backend === 'webgl' ? 'WebGL2' : '–'
        ),
        badge('Compute', COMPUTE_LABELS[d.computeBackend])
      );
    }
    stats.textContent = `Bilder ${d.frames}, Kacheln ${d.tilesLoaded}/${d.tilesRequested}${d.tilesFailed > 0 ? ` (${d.tilesFailed} fehlgeschlagen)` : ''}, Schattenläufe ${d.shadowPasses}, Namen ${d.labelsPlaced}, Standorte ${d.stationsLoaded}`;
    errorLine.textContent = d.error;

    const nodes = Object.entries(d.graphNodeMs);
    const nextNodes = nodes.map(([id, ms]) => `${id}:${ms.toFixed(3)}`).join(',');
    if (nextNodes !== nodeSignature) {
      nodeSignature = nextNodes;
      nodeTable.replaceChildren(
        tableRow(['Knoten', 'GPU ms'], true),
        ...nodes.map(([id, ms]) => tableRow([id, ms.toFixed(3)]))
      );
      if (nodes.length === 0) {
        nodeTable.replaceChildren(tableRow(['Keine GPU-Zeiten (Timestamps nicht verfügbar)']));
      }
    }

    const nextParity = d.parity ? JSON.stringify(d.parity) : '';
    if (nextParity !== paritySignature) {
      paritySignature = nextParity;
      if (d.parity) {
        parityTable.replaceChildren(...parityRows(d.parity).map(cells => tableRow(cells)));
        parityNote.textContent = '';
      } else {
        parityTable.replaceChildren();
        parityNote.textContent = 'Noch kein Vergleich GPU gegen CPU gelaufen.';
      }
    }
  };
  details.addEventListener('toggle', () => {
    if (latest) render(latest);
  });

  return {
    element: details,
    setOpen(open) {
      details.open = open;
    },
    update(d) {
      latest = d;
      render(d);
    }
  };
}
