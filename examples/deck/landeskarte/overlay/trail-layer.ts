// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Swiss Wanderweg symbology as deck.gl PathLayers in world (ENU) coordinates.
//
//   hiking (T1)                  solid yellow
//   mountain hiking (T2, T3)     red dashes on a white casing (the white-red-white blaze)
//   alpine hiking (T4 to T6)     blue dashes on a white casing (white-blue-white)
//   unclassified                 thin grey dashes
//
// Dashes are cut on the CPU, in metres along the path, instead of with a dash shader extension:
// the same geometry then draws identically on WebGPU and WebGL2 and stays attached to the ground
// when the camera moves. The red `selected` way is the one place the route accent is used.

import {COORDINATE_SYSTEM, type Layer} from '@deck.gl/core';
import {PathLayer} from '@deck.gl/layers';
import {curvatureDrop, REFRACTION_K} from '../geo/geodesy';
import type {Frame, SceneMode, TrailWay, Vec3} from '../types';

const INK_YELLOW: [number, number, number, number] = [229, 158, 31, 255];
const INK_RED: [number, number, number, number] = [191, 34, 51, 255];
// Red is reserved for the selected state; a Bergwanderweg draws in the rock black instead.
const INK_ROCK: [number, number, number, number] = [43, 39, 36, 255];
const INK_BLUE: [number, number, number, number] = [44, 111, 176, 255];
const INK_GREY: [number, number, number, number] = [122, 118, 112, 235];
const CASING: [number, number, number, number] = [255, 255, 255, 235];

/** Height above the sampled terrain, so a path is not buried by the coarser far-field mesh. */
const LIFT_METERS = 3;

type TrailClass = 'hiking' | 'mountain' | 'alpine' | 'other';

type Segment = {
  path: Vec3[];
  color: [number, number, number, number];
  /** Metres wide in plan, pixels wide in the panorama. */
  casingWidth: [plan: number, panorama: number];
  inkWidth: [plan: number, panorama: number];
  cased: boolean;
};

type PreparedTrail = {id: string; kind: TrailClass; points: Vec3[]};

type Prepared = {
  frame: Frame;
  sampleHeight: (lat: number, lon: number) => number | null;
  k: number;
  trails: PreparedTrail[];
  segments?: Segment[];
  casingData?: Segment[];
  inkData?: Segment[];
};

// Prepared geometry is cached on the identity of the inputs: pass a new `sampleHeight` closure
// when more DEM tiles have loaded and the paths are re-draped.
const cache = new WeakMap<TrailWay[], Prepared>();

export function classifySac(sac: TrailWay['sac']): TrailClass {
  switch (sac) {
    case 'hiking':
      return 'hiking';
    case 'mountain_hiking':
    case 'demanding_mountain_hiking':
      return 'mountain';
    case 'alpine_hiking':
    case 'demanding_alpine_hiking':
    case 'difficult_alpine_hiking':
      return 'alpine';
    default:
      return 'other';
  }
}

/**
 * Cuts a polyline into dashes of `dash` metres separated by `gap` metres, measured along the
 * path in 3D so slopes do not stretch the pattern. Dash ends are interpolated, not snapped.
 */
export function dashPolyline(points: Vec3[], dash: number, gap: number): Vec3[][] {
  const dashes: Vec3[][] = [];
  let current: Vec3[] | null = points.length ? [points[0]] : null;
  let remaining = dash;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    let travelled = 0;
    while (length - travelled > remaining) {
      travelled += remaining;
      const t = travelled / length;
      const point: Vec3 = [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t
      ];
      if (current) {
        current.push(point);
        dashes.push(current);
        current = null;
        remaining = gap;
      } else {
        current = [point];
        remaining = dash;
      }
    }
    remaining -= length - travelled;
    if (current) current.push(b);
  }
  if (current && current.length > 1) dashes.push(current);
  return dashes;
}

function prepareTrails(
  trails: TrailWay[],
  frame: Frame,
  sampleHeight: (lat: number, lon: number) => number | null,
  k: number
): PreparedTrail[] {
  const prepared: PreparedTrail[] = [];
  for (const trail of trails) {
    if (trail.coords.length < 2) continue;
    const heights = trail.coords.map(([lon, lat]) => sampleHeight(lat, lon));
    // Tiles may not cover every vertex yet: carry the nearest known height along the path.
    const known = heights.findIndex(h => h !== null);
    if (known < 0) continue;
    for (let i = 0; i < heights.length; i++) {
      if (heights[i] === null) heights[i] = heights[i === 0 ? known : i - 1];
    }
    const points: Vec3[] = trail.coords.map(([lon, lat], i) => {
      const [east, north, up] = frame.toEnu(lat, lon, heights[i] as number);
      // Same convention as the terrain shader: up -= (1 - k) d^2 / (2R), d planar from the eye.
      return [east, north, up - curvatureDrop(Math.hypot(east, north), k) + LIFT_METERS];
    });
    prepared.push({id: trail.id, kind: classifySac(trail.sac), points});
  }
  return prepared;
}

function buildSegments(trails: PreparedTrail[]): Segment[] {
  const segments: Segment[] = [];
  for (const trail of trails) {
    switch (trail.kind) {
      case 'hiking':
        segments.push({
          path: trail.points,
          color: INK_YELLOW,
          casingWidth: [4.6, 5],
          inkWidth: [2.4, 2.6],
          cased: true
        });
        break;
      case 'mountain':
      case 'alpine': {
        const color = trail.kind === 'mountain' ? INK_ROCK : INK_BLUE;
        // The full-length white casing is drawn once under the dashes, so the gaps read white.
        segments.push({
          path: trail.points,
          color: CASING,
          casingWidth: [4.8, 5.4],
          inkWidth: [4.8, 5.4],
          cased: false
        });
        for (const path of dashPolyline(trail.points, 110, 55)) {
          segments.push({
            path,
            color,
            casingWidth: [0, 0],
            inkWidth: [2.8, 3],
            cased: false
          });
        }
        break;
      }
      default:
        for (const path of dashPolyline(trail.points, 18, 18)) {
          segments.push({
            path,
            color: INK_GREY,
            casingWidth: [0, 0],
            inkWidth: [3, 1.2],
            cased: false
          });
        }
    }
  }
  return segments;
}

/**
 * Trail layers for the world view. Ids start with `trails`. Draw order is casing, ink, then the
 * selected way on top; depth writes are off so that order, not z-fighting, decides overlaps, and
 * depth testing is kept so ridges still hide the paths behind them.
 *
 * @param sampleHeight terrain height above sea level at (lat, lon), or null where no tile is loaded
 * @param selectedId id of the trail to highlight, or null
 * @param refractionK curvature convention; must match the terrain uniforms
 */
/**
 * deck.gl's 'pixels' width units are one world unit per pixel in a perspective view (its scale
 * is 1), so widths are given in metres and scaled by distance: `metersPerPixelPerMeter` is
 * 2 tan(vfov / 2) / viewport height in pixels, and a width of n px at distance d is n * that * d.
 */
export type TrailView = {eye: Vec3; metersPerPixelPerMeter: number};
const DEFAULT_VIEW: TrailView = {eye: [0, 0, 0], metersPerPixelPerMeter: 0.0015};

export function makeTrailLayers(
  trails: TrailWay[],
  frame: Frame,
  sampleHeight: (lat: number, lon: number) => number | null,
  mode: SceneMode,
  selectedId: string | null,
  refractionK: number = REFRACTION_K,
  view: TrailView = DEFAULT_VIEW
): Layer[] {
  let prepared = cache.get(trails);
  if (
    !prepared ||
    prepared.frame !== frame ||
    prepared.sampleHeight !== sampleHeight ||
    prepared.k !== refractionK
  ) {
    prepared = {
      frame,
      sampleHeight,
      k: refractionK,
      trails: prepareTrails(trails, frame, sampleHeight, refractionK)
    };
    cache.set(trails, prepared);
  }
  prepared.segments ??= buildSegments(prepared.trails);
  prepared.casingData ??= [
    ...prepared.segments.filter(s => s.cased),
    ...prepared.segments.filter(s => s.color === CASING)
  ];
  prepared.inkData ??= prepared.segments.filter(s => s.color !== CASING);
  // Metres per pixel at a path's middle vertex, as seen from the eye.
  const {eye, metersPerPixelPerMeter} = view;
  const metersPerPixel = (path: Vec3[]): number => {
    const point = path[path.length >> 1];
    return (
      metersPerPixelPerMeter * Math.hypot(point[0] - eye[0], point[1] - eye[1], point[2] - eye[2])
    );
  };

  const plan = mode === 'plan';
  const index = plan ? 0 : 1;
  const common = {
    coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
    pickable: false,
    widthUnits: 'meters' as const,
    jointRounded: true,
    capRounded: false,
    getPath: (d: {path: Vec3[]}) => d.path,
    // Plan looks straight down: nothing hides a path, and depth at 40 km is too coarse for +3 m.
    parameters: {
      depthCompare: plan ? ('always' as const) : ('less-equal' as const),
      depthWriteEnabled: false
    },
    updateTriggers: {getWidth: [mode, metersPerPixelPerMeter, eye[0], eye[1], eye[2]]}
  };

  const layers: Layer[] = [
    new PathLayer<Segment>({
      ...common,
      id: 'trails-casing',
      data: prepared.casingData,
      getColor: CASING,
      getWidth: d => (d.cased ? d.casingWidth[index] : d.inkWidth[index]) * metersPerPixel(d.path)
    }),
    new PathLayer<Segment>({
      ...common,
      id: 'trails-ink',
      data: prepared.inkData,
      getColor: d => d.color,
      getWidth: d => d.inkWidth[index] * metersPerPixel(d.path)
    })
  ];

  const selected = selectedId ? prepared.trails.find(t => t.id === selectedId) : undefined;
  if (selected) {
    const data = [{path: selected.points}];
    layers.push(
      new PathLayer<{path: Vec3[]}>({
        ...common,
        id: 'trails-selected-casing',
        data,
        getColor: CASING,
        getWidth: (plan ? 6.5 : 8) * metersPerPixel(selected.points)
      }),
      new PathLayer<{path: Vec3[]}>({
        ...common,
        id: 'trails-selected',
        data,
        getColor: INK_RED,
        getWidth: (plan ? 3.6 : 4) * metersPerPixel(selected.points)
      })
    );
  }
  return layers;
}
