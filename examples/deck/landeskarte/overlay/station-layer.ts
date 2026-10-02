// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The twelve photo stations as map marks in screen space: an open triangle with a centre dot, the
// view wedge (solved yaw +/- hfov/2) and the Feldbuch ray with its bearing. Geometry is built in
// the local ENU frame and projected vertex by vertex, so in plan the wedge is a true map object
// that scales with the sheet. Ids start with `screen-stations` (the screen view's layer filter).

import type {Deck, Layer} from '@deck.gl/core';
import {PathLayer, PolygonLayer, ScatterplotLayer, TextLayer} from '@deck.gl/layers';
import {curvatureDrop} from '../geo/geodesy';
import type {ENU, Frame, SceneMode, Station} from '../types';

type Pixel = [number, number];
type Project = (enu: ENU) => [number, number, number] | null;

const INK: [number, number, number] = [19, 19, 19];
/** The single accent: only the selected station uses it. */
const RED: [number, number, number] = [191, 34, 51];
const OCHRE: [number, number, number] = [229, 158, 31];
const PAPER: [number, number, number, number] = [244, 244, 244, 235];
const DEG = Math.PI / 180;

/** Stations under this solver confidence draw dimmed (spec: below 0.7). */
const CONFIDENT = 0.7;

/** Wedge and ray radius on the ground, metres, selected station. */
const RADIUS_METERS: Record<SceneMode, number> = {plan: 1700, panorama: 4000};
/** Unselected stations keep a short hint of their wedge and ray. */
const HINT_SCALE = 0.4;

type Mark = {
  id: string;
  station: Station;
  anchor: Pixel;
  selected: boolean;
  alpha: number;
};

type Wedge = {
  id: string;
  polygon: Pixel[];
  selected: boolean;
  alpha: number;
};

type Ray = {
  id: string;
  path: [Pixel, Pixel];
  selected: boolean;
  alpha: number;
};

type Bearing = {text: string; position: Pixel; angle: number};

function toPixel(p: [number, number, number]): Pixel {
  return [p[0], p[1]];
}

/** Horizontal field of view in degrees from the vertical one and the frame aspect. */
export function horizontalFov(vfov: number, aspect: number): number {
  return (2 * Math.atan(aspect * Math.tan((vfov * DEG) / 2))) / DEG;
}

/** Ground point at `bearing` degrees clockwise from north and `distance` metres from `origin`. */
function groundPoint(origin: ENU, bearing: number, distance: number): ENU {
  const east = origin[0] + Math.sin(bearing * DEG) * distance;
  const north = origin[1] + Math.cos(bearing * DEG) * distance;
  // `origin` is already dropped; keep its height above the curved surface, so the fan follows
  // the ground's curvature rather than a flat plane.
  const drop =
    curvatureDrop(Math.hypot(east, north)) - curvatureDrop(Math.hypot(origin[0], origin[1]));
  return [east, north, origin[2] - drop];
}

function normaliseBearing(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

/**
 * Station marks in screen space.
 *
 * @param project ENU to canvas pixels (y down) and depth, or null when behind the camera
 * @param selectedId station drawn with its full wedge, Feldbuch ray and bearing, or null
 */
export function makeStationLayers(
  stations: Station[],
  frame: Frame,
  project: Project,
  selectedId: string | null,
  mode: SceneMode
): Layer[] {
  const marks: Mark[] = [];
  const wedges: Wedge[] = [];
  const rays: Ray[] = [];
  let bearing: Bearing | null = null;

  for (const station of stations) {
    // Positions handed to `project` carry the curvature drop, like the terrain and trail layers.
    const [east, north, up] = frame.toEnu(station.lat, station.lon, station.h);
    const enu: ENU = [east, north, up - curvatureDrop(Math.hypot(east, north))];
    const apex = project(enu);
    if (!apex) continue;
    const selected = station.id === selectedId;
    const alpha = station.confidence < CONFIDENT ? 0.45 : 1;
    marks.push({id: station.id, station, anchor: toPixel(apex), selected, alpha});

    const radius = RADIUS_METERS[mode] * (selected ? 1 : HINT_SCALE);
    const half = horizontalFov(station.vfov, station.aspect) / 2;

    // Wedge: apex, then an arc sampled every ~6 degrees from yaw - half to yaw + half.
    const steps = Math.max(2, Math.ceil((half * 2) / 6));
    const fan: Pixel[] = [toPixel(apex)];
    let complete = true;
    for (let i = 0; i <= steps; i++) {
      const azimuth = station.yaw - half + (2 * half * i) / steps;
      const p = project(groundPoint(enu, azimuth, radius));
      if (!p) {
        complete = false;
        break;
      }
      fan.push(toPixel(p));
    }
    if (complete) wedges.push({id: station.id, polygon: fan, selected, alpha});

    const tip = project(groundPoint(enu, station.yaw, radius));
    if (tip) {
      rays.push({id: station.id, path: [toPixel(apex), toPixel(tip)], selected, alpha});
      if (selected) {
        const dx = tip[0] - apex[0];
        const dy = tip[1] - apex[1];
        // deck rotates text counter-clockwise on screen; atan2 here is clockwise (y down).
        let angle = -Math.atan2(dy, dx) / DEG;
        // Never upside down: turn the baseline around so the text reads uphill, left to right.
        if (dx < 0) angle += 180;
        bearing = {
          text: `${Math.round(normaliseBearing(station.yaw))}°`,
          position: [apex[0] + dx * 0.55, apex[1] + dy * 0.55],
          angle
        };
      }
    }
  }

  // Selected last, so its marks sit on top of the cluster at the summit.
  const order = (a: {selected: boolean}, b: {selected: boolean}) =>
    Number(a.selected) - Number(b.selected);
  marks.sort(order);
  wedges.sort(order);
  rays.sort(order);

  const triangle = (m: Mark): Pixel[] => {
    // Open triangle, apex up; the centroid sits on the station so the dot is the true position.
    const r = m.selected ? 9 : 6;
    const [x, y] = m.anchor;
    return [
      [x, y - r],
      [x + r * 0.866, y + r * 0.5],
      [x - r * 0.866, y + r * 0.5],
      [x, y - r]
    ];
  };
  const trigger = {mode, selectedId};
  const selectedMarks = marks.filter(m => m.selected);

  const layers: Layer[] = [
    new PolygonLayer<Wedge>({
      id: 'screen-stations-wedge',
      data: wedges,
      getPolygon: d => d.polygon,
      stroked: false,
      getFillColor: d =>
        [...OCHRE, (d.selected ? 70 : 16) * d.alpha] as [number, number, number, number],
      pickable: false,
      updateTriggers: {getFillColor: trigger}
    }),
    new PathLayer<Wedge>({
      id: 'screen-stations-wedge-edge',
      data: wedges.filter(w => w.selected),
      getPath: d => [...d.polygon, d.polygon[0]],
      getColor: [...RED, 200],
      getWidth: 1.2,
      widthUnits: 'pixels',
      pickable: false
    }),
    new PathLayer<Ray>({
      id: 'screen-stations-ray',
      data: rays,
      getPath: d => d.path,
      getColor: d =>
        [...(d.selected ? RED : INK), (d.selected ? 255 : 90) * d.alpha] as [
          number,
          number,
          number,
          number
        ],
      getWidth: d => (d.selected ? 2 : 0.8),
      widthUnits: 'pixels',
      pickable: false,
      updateTriggers: {getColor: trigger, getWidth: trigger}
    }),
    new PolygonLayer<Mark>({
      id: 'screen-stations-fill',
      data: selectedMarks,
      getPolygon: triangle,
      stroked: false,
      getFillColor: [...OCHRE, 255],
      pickable: false
    }),
    new PathLayer<Mark>({
      id: 'screen-stations-triangle',
      data: marks,
      getPath: triangle,
      getColor: m =>
        [...(m.selected ? RED : INK), 255 * m.alpha] as [number, number, number, number],
      getWidth: m => (m.selected ? 2.2 : 1.4),
      widthUnits: 'pixels',
      jointRounded: true,
      pickable: false,
      updateTriggers: {getColor: trigger, getWidth: trigger}
    }),
    new ScatterplotLayer<Mark>({
      id: 'screen-stations-dot',
      data: marks,
      getPosition: m => [m.anchor[0], m.anchor[1], 0],
      getRadius: m => (m.selected ? 2.2 : 1.5),
      radiusUnits: 'pixels',
      getFillColor: m => [...INK, 255 * m.alpha] as [number, number, number, number],
      pickable: false,
      updateTriggers: {getRadius: trigger, getFillColor: trigger}
    }),
    // Invisible, generously sized targets: a 6 px mark is hard to hit with a finger. Alpha 1/255
    // keeps the fragment non-transparent for the picking pass.
    new ScatterplotLayer<Mark>({
      id: 'screen-stations-pick',
      data: marks,
      getPosition: m => [m.anchor[0], m.anchor[1], 0],
      getRadius: 13,
      radiusUnits: 'pixels',
      getFillColor: [0, 0, 0, 1],
      pickable: true
    })
  ];

  if (bearing) {
    layers.push(
      new TextLayer<Bearing>({
        id: 'screen-stations-bearing',
        data: [bearing],
        getText: d => d.text,
        // The default ASCII atlas has no degree sign.
        characterSet: '0123456789°',
        getPosition: d => [d.position[0], d.position[1], 0],
        getAngle: d => d.angle,
        getSize: 12,
        sizeUnits: 'pixels',
        getColor: [...INK, 255],
        getTextAnchor: 'middle',
        getAlignmentBaseline: 'bottom',
        // Lift the text off the ray so the hairline never strikes through the digits.
        getPixelOffset: [0, -4],
        fontFamily: '"Fira Mono", ui-monospace, Menlo, monospace',
        fontSettings: {sdf: true},
        outlineWidth: 2,
        outlineColor: PAPER,
        pickable: false
      })
    );
  }
  return layers;
}

// One counter per Deck: pickObjectAsync resolves in GPU order, not call order, and a pointer
// that moves quickly would otherwise show the station under an earlier position.
const latestPick = new WeakMap<Deck, {serial: number; result: Promise<string | null>}>();

/**
 * Station id under canvas pixel (x, y), or null. When a newer call has started in the meantime,
 * this resolves with that newer call's answer instead of its own, so a caller applying results
 * in resolution order can never end on a stale one.
 */
export async function pickStation(deck: Deck, x: number, y: number): Promise<string | null> {
  const previous = latestPick.get(deck);
  const serial = (previous?.serial ?? 0) + 1;
  const result = deck
    .pickObjectAsync({x, y, radius: 2, layerIds: ['screen-stations-pick']})
    .then(info => (info?.object ? (info.object as Mark).id : null))
    .catch(() => null);
  latestPick.set(deck, {serial, result});
  const own = await result;
  const latest = latestPick.get(deck);
  return latest && latest.serial !== serial ? latest.result : own;
}
