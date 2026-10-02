// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The photo skylines as a screen-space overlay on the panorama. Each photo carries two skylines
// baked as world directions through the solved pose (see data/photo-skylines.json `_provenance`):
// `ml`, the boundary of the U2-Net-P neural sky segmentation of the photo (primary, drawn strong),
// and `classical`, Rigi's colour-model detector (secondary, fainter). Here each direction is
// placed 20 km out from the eye and projected through the current view, so the dotted line stays
// attached to the terrain as the camera turns. Residual ticks join the DEM horizon of the GPU ring
// to the ML skyline at the same azimuth: a hairline per sample, coloured by sign. Ids start
// with `screen-skyline` (the screen view's layer filter).

import type {Layer} from '@deck.gl/core';
import {PathLayer} from '@deck.gl/layers';
import {getCameraAxes} from '../views/landeskarte-view';
import type {ENU, RingResult, SceneMode} from '../types';

export type PhotoSkyline = {
  id: string;
  /** UTC minutes since DAY_UTC_MS. */
  minutes?: number;
  /** Neural (U2-Net-P) skyline: [azimuth, elevation] in degrees, ascending azimuth, one per 0.1 degree. */
  ml: [number, number][];
  /** Classical detector skyline, same layout at one sample per 0.2 degree. */
  classical: [number, number][];
};

export type SkylineSeries = 'ml' | 'classical';

type Project = (enu: ENU) => [number, number, number] | null;
type Pixel = [number, number];
type Color = [number, number, number, number];

const DEG = Math.PI / 180;
/** Distance at which a direction is projected. Far enough that the eye offset does not matter. */
const PROJECT_DISTANCE = 20_000;
const NAVY: [number, number, number] = [0, 47, 85];
/** Muted diverging pair, never red: photo above the DEM horizon (sand), below it (teal). */
const SAND: [number, number, number] = [176, 132, 60];
const TEAL: [number, number, number] = [61, 125, 138];
const DOT_PX = 1.6;
const GAP_PX = 3.4;
/** A gap wider than this in azimuth breaks the line (a person or a missing run was dropped). */
const BREAK_DEG = 0.4;
/** Residuals beyond this are foreground trees or a failed column, not horizon error: no tick. */
const MAX_TICK_DEG = 4;
/** Ticks shorter than this many pixels would be invisible hairlines of nothing. */
const MIN_TICK_PX = 1.5;
const TICK_STRIDE = 2;
/** Opacity of the secondary (classical) dotted line. */
const SECONDARY_ALPHA = 110;

export async function loadPhotoSkylines(): Promise<PhotoSkyline[]> {
  try {
    const response = await fetch(new URL('../data/photo-skylines.json', import.meta.url));
    if (!response.ok) return [];
    const photos = ((await response.json()) as {photos?: PhotoSkyline[]}).photos;
    return Array.isArray(photos) ? photos : [];
  } catch {
    return [];
  }
}

/** The ring's horizon elevation (degrees) at an azimuth, linear between bins (bin i = i/bins turn). */
function ringElevationAt(ring: RingResult, azimuth: number): number {
  const position = ((((azimuth / 360) % 1) + 1) % 1) * ring.bins;
  const low = Math.floor(position);
  const t = position - low;
  const a = ring.elevationDeg[low % ring.bins];
  const b = ring.elevationDeg[(low + 1) % ring.bins];
  return a + (b - a) * t;
}

/**
 * Image pixel (x right, y down, pixel centres at +0.5) to azimuth and elevation in degrees through
 * a pinhole pose: yaw clockwise from north, pitch up, roll clockwise image rotation, `f` from the
 * vertical field of view. The bake script repeats this maths in plain JavaScript.
 */
export function pixelToDirection(
  pose: {yaw: number; pitch: number; roll: number; vfov: number},
  width: number,
  height: number,
  x: number,
  y: number
): [azimuth: number, elevation: number] {
  const {forward, right, up} = getCameraAxes(pose);
  const focal = height / 2 / Math.tan((pose.vfov * DEG) / 2);
  const u = (x - width / 2) / focal;
  const v = (height / 2 - y) / focal;
  const dx = forward[0] + u * right[0] + v * up[0];
  const dy = forward[1] + u * right[1] + v * up[1];
  const dz = forward[2] + u * right[2] + v * up[2];
  return [
    (((Math.atan2(dx, dy) / DEG) % 360) + 360) % 360,
    Math.asin(dz / Math.hypot(dx, dy, dz)) / DEG
  ];
}

function directionToEnu(eye: ENU, azimuth: number, elevation: number): ENU {
  const az = azimuth * DEG;
  const el = elevation * DEG;
  const horizontal = PROJECT_DISTANCE * Math.cos(el);
  return [
    eye[0] + horizontal * Math.sin(az),
    eye[1] + horizontal * Math.cos(az),
    eye[2] + PROJECT_DISTANCE * Math.sin(el)
  ];
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

/**
 * |photo skyline - DEM horizon| in degrees (the chosen `series`) over every sample of every photo
 * that has a finite ring value. The ring is the summit eye's horizon: it is the right comparison for photos taken within
 * about 100 m of it (all twelve are).
 */
export function skylineResidualStats(
  skylines: PhotoSkyline[],
  ring: RingResult,
  series: SkylineSeries = 'ml'
): {n: number; medianDeg: number; p90Deg: number} {
  const residuals: number[] = [];
  for (const skyline of skylines) {
    for (const [azimuth, elevation] of skyline[series]) {
      const horizon = ringElevationAt(ring, azimuth);
      if (Number.isFinite(horizon)) residuals.push(Math.abs(elevation - horizon));
    }
  }
  residuals.sort((a, b) => a - b);
  return {
    n: residuals.length,
    medianDeg: percentile(residuals, 0.5),
    p90Deg: percentile(residuals, 0.9)
  };
}

/** Cuts a projected polyline into dots: short dashes along its screen length. */
function dashPath(points: Pixel[]): Pixel[][] {
  const dashes: Pixel[][] = [];
  let carried = 0;
  let drawing = true;
  let current: Pixel[] = [];
  for (let index = 1; index < points.length; index++) {
    const [x0, y0] = points[index - 1];
    const [x1, y1] = points[index];
    const length = Math.hypot(x1 - x0, y1 - y0);
    let at = 0;
    while (at < length) {
      const period = drawing ? DOT_PX : GAP_PX;
      const step = Math.min(length - at, period - carried);
      if (drawing) {
        if (current.length === 0) {
          current.push([x0 + ((x1 - x0) * at) / length, y0 + ((y1 - y0) * at) / length]);
        }
        const end = at + step;
        current.push([x0 + ((x1 - x0) * end) / length, y0 + ((y1 - y0) * end) / length]);
      }
      at += step;
      carried += step;
      if (carried >= period - 1e-9) {
        if (drawing && current.length > 1) dashes.push(current);
        current = [];
        carried = 0;
        drawing = !drawing;
      }
    }
  }
  if (drawing && current.length > 1) dashes.push(current);
  return dashes;
}

/** Projected runs of one skyline, broken at azimuth gaps and where a point has no projection. */
function projectRuns(samples: [number, number][], eye: ENU, project: Project): Pixel[][] {
  const runs: Pixel[][] = [];
  let run: Pixel[] = [];
  let previousAzimuth = Number.NaN;
  for (const [azimuth, elevation] of samples) {
    const projected = project(directionToEnu(eye, azimuth, elevation));
    const broken = !projected || !(azimuth - previousAzimuth <= BREAK_DEG);
    if (broken && run.length > 1) runs.push(run);
    if (broken) run = [];
    previousAzimuth = azimuth;
    if (projected) run.push([projected[0], projected[1]]);
  }
  if (run.length > 1) runs.push(run);
  return runs;
}

type Dash = {path: Pixel[]; color: Color};
type Tick = {path: [Pixel, Pixel]; color: Color};

/**
 * Screen layers for the panorama: the primary skyline (default the ML one) dotted, the selected
 * photo strong and the others faint; the other series as a fainter secondary dotted line; and,
 * with a ring result, residual ticks of the primary series for the selected photo. Empty in plan.
 */
export function makeSkylineLayers(
  skylines: PhotoSkyline[],
  ring: RingResult | null,
  project: Project,
  eyeEnu: ENU,
  mode: SceneMode,
  selectedId: string | null,
  series: SkylineSeries = 'ml'
): Layer[] {
  if (mode !== 'panorama' || skylines.length === 0) return [];
  const secondary: SkylineSeries = series === 'ml' ? 'classical' : 'ml';
  const faint: Dash[] = [];
  const strong: Dash[] = [];
  const second: Dash[] = [];
  for (const skyline of skylines) {
    const selected = skyline.id === selectedId;
    const color: Color = [...NAVY, selected ? 255 : 70];
    for (const run of projectRuns(skyline[series], eyeEnu, project)) {
      for (const path of dashPath(run)) (selected ? strong : faint).push({path, color});
    }
    // The secondary line only for the selected photo: all twelve would double the clutter.
    if (!selected) continue;
    for (const run of projectRuns(skyline[secondary], eyeEnu, project)) {
      for (const path of dashPath(run)) second.push({path, color: [...NAVY, SECONDARY_ALPHA]});
    }
  }
  const layers: Layer[] = [
    new PathLayer<Dash>({
      id: 'screen-skyline-others',
      data: faint,
      getPath: d => d.path,
      getColor: d => d.color,
      getWidth: 1.2,
      widthUnits: 'pixels',
      capRounded: true,
      pickable: false
    }),
    new PathLayer<Dash>({
      id: 'screen-skyline-secondary',
      data: second,
      getPath: d => d.path,
      getColor: d => d.color,
      getWidth: 1.2,
      widthUnits: 'pixels',
      capRounded: true,
      pickable: false
    }),
    new PathLayer<Dash>({
      id: 'screen-skyline-selected',
      data: strong,
      getPath: d => d.path,
      getColor: d => d.color,
      getWidth: 2,
      widthUnits: 'pixels',
      capRounded: true,
      pickable: false
    })
  ];
  const chosen = ring ? skylines.find(s => s.id === selectedId) : undefined;
  if (ring && chosen) {
    const ticks: Tick[] = [];
    const samples = chosen[series];
    for (let index = 0; index < samples.length; index += TICK_STRIDE) {
      const [azimuth, elevation] = samples[index];
      const horizon = ringElevationAt(ring, azimuth);
      const residual = elevation - horizon;
      if (!Number.isFinite(horizon) || Math.abs(residual) > MAX_TICK_DEG) continue;
      const photoPoint = project(directionToEnu(eyeEnu, azimuth, elevation));
      const demPoint = project(directionToEnu(eyeEnu, azimuth, horizon));
      if (!photoPoint || !demPoint) continue;
      if (Math.abs(photoPoint[1] - demPoint[1]) < MIN_TICK_PX) continue;
      ticks.push({
        path: [
          [photoPoint[0], photoPoint[1]],
          [photoPoint[0], demPoint[1]]
        ],
        color: [...(residual > 0 ? SAND : TEAL), 210]
      });
    }
    layers.push(
      new PathLayer<Tick>({
        id: 'screen-skyline-residual',
        data: ticks,
        getPath: d => d.path,
        getColor: d => d.color,
        getWidth: 1,
        widthUnits: 'pixels',
        pickable: false
      })
    );
  }
  return layers;
}
