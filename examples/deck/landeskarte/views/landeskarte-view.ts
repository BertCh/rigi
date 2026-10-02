// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// One camera for both modes. The Landeskarte plan (looking straight down from 40 km) and the
// summit panorama (a photographer's lens, with roll) are the same perspective view with different
// view state, so the flight between them is just an interpolation of a ViewPose.

import {OrthographicView, View, Viewport} from '@deck.gl/core';
import {Matrix4} from '@math.gl/core';
import {SUMMIT_EYE, SUMMIT_FRAME_VIEW} from '../data/scene-data';
import {makeFrame} from '../geo/geodesy';
import type {ENU, Frame, Station, Vec3, ViewPose} from '../types';

const DEG = Math.PI / 180;

/** A large near plane keeps depth precision over a 200 km range. */
export const DEFAULT_NEAR = 80;
export const DEFAULT_FAR = 200_000;

/** Transition fields that every deck.gl view state accepts (not exported by name). */
type CommonViewState = View extends View<infer ViewState> ? ViewState : never;

/** View state of a {@link LandeskarteView}: a camera in local east/north/up metres. */
export type LandeskarteViewState = CommonViewState & {
  /** Lens position in the local frame (x east, y north, z up), metres. */
  position: ENU;
  /** Degrees clockwise from north. */
  yaw: number;
  /** Degrees, up positive. */
  pitch: number;
  /** Degrees; positive rolls the camera clockwise, so the world turns anticlockwise on screen. */
  roll: number;
  /** Vertical field of view, degrees. */
  verticalFieldOfView: number;
  near?: number;
  far?: number;
};

type LandeskarteViewportProps = LandeskarteViewState & {
  id?: string;
  x?: number;
  y?: number;
  width: number;
  height: number;
};

/** Optical axis, image-right and image-up directions of a pose in the local frame. */
export function getCameraAxes(pose: Pick<ViewPose, 'yaw' | 'pitch' | 'roll'>): {
  forward: Vec3;
  right: Vec3;
  up: Vec3;
} {
  const yaw = pose.yaw * DEG;
  const pitch = pose.pitch * DEG;
  const roll = pose.roll * DEG;
  const forward: Vec3 = [
    Math.sin(yaw) * Math.cos(pitch),
    Math.cos(yaw) * Math.cos(pitch),
    Math.sin(pitch)
  ];
  // Level right, then up = right x forward. This stays well defined looking straight down
  // (pitch -90): up is then the yaw direction, so the plan keeps north at the top at yaw 0.
  const levelRight: Vec3 = [Math.cos(yaw), -Math.sin(yaw), 0];
  const levelUp: Vec3 = [
    levelRight[1] * forward[2] - levelRight[2] * forward[1],
    levelRight[2] * forward[0] - levelRight[0] * forward[2],
    levelRight[0] * forward[1] - levelRight[1] * forward[0]
  ];
  const cosine = Math.cos(roll);
  const sine = Math.sin(roll);
  const right: Vec3 = [0, 0, 0];
  const up: Vec3 = [0, 0, 0];
  for (let index = 0; index < 3; index++) {
    right[index] = levelRight[index] * cosine - levelUp[index] * sine;
    up[index] = levelUp[index] * cosine + levelRight[index] * sine;
  }
  return {forward, right, up};
}

/**
 * A perspective viewport with yaw, pitch, roll and a vertical field of view. deck.gl's
 * FirstPersonViewport has no roll, and a hand-held photo almost always has some. The world is
 * non-geospatial: layers use COORDINATE_SYSTEM.CARTESIAN in local metres.
 */
export class LandeskarteViewport extends Viewport {
  static override displayName = 'LandeskarteViewport';

  constructor(props: LandeskarteViewportProps) {
    const {forward, up} = getCameraAxes(props);
    super({
      id: props.id,
      x: props.x,
      y: props.y,
      width: props.width,
      height: props.height,
      // The viewport translates by -position itself, so the view matrix is a pure rotation.
      position: props.position,
      viewMatrix: new Matrix4().lookAt({eye: [0, 0, 0], center: forward, up}),
      fovy: props.verticalFieldOfView,
      near: props.near ?? DEFAULT_NEAR,
      far: props.far ?? DEFAULT_FAR
    });
  }
}

/** The perspective view for plan and panorama. The pose is app-driven: no deck controller. */
export class LandeskarteView extends View<LandeskarteViewState> {
  static displayName = 'LandeskarteView';

  override getViewportType() {
    return LandeskarteViewport;
  }

  protected override get ControllerType(): never {
    // Input goes through attachOrbitControls, which leaves the mouse wheel to the page.
    throw new Error('LandeskarteView');
  }
}

/** View state for a pose. */
export function poseToViewState(pose: ViewPose): LandeskarteViewState {
  return {
    position: [pose.eye[0], pose.eye[1], pose.eye[2]],
    yaw: pose.yaw,
    pitch: pose.pitch,
    roll: pose.roll,
    verticalFieldOfView: pose.vfov,
    near: pose.near ?? DEFAULT_NEAR,
    far: pose.far ?? DEFAULT_FAR
  } as LandeskarteViewState;
}

/** The Landeskarte sheet: straight down from 40 km, north up, a narrow lens so it reads flat. */
export function getPlanPose(): ViewPose {
  return {eye: [0, 0, 40_000], yaw: 0, pitch: -90, roll: 0, vfov: 8};
}

/**
 * The summit panorama. Without a station this is the solved pose of the first photo (the frame
 * origin is its viewpoint, so the eye is the origin). With a station its lens position is
 * placed in `frame` (default: the summit frame).
 */
export function getPanoramaPose(station?: Station, frame?: Frame): ViewPose {
  if (!station) {
    const {yaw, pitch, roll, vfov} = SUMMIT_FRAME_VIEW;
    return {eye: [0, 0, 0], yaw, pitch, roll, vfov};
  }
  const summitFrame = frame ?? makeFrame(SUMMIT_EYE.lat, SUMMIT_EYE.lon, SUMMIT_EYE.h);
  return {
    eye: summitFrame.toEnu(station.lat, station.lon, station.h),
    yaw: station.yaw,
    pitch: station.pitch,
    roll: station.roll,
    vfov: station.vfov
  };
}

/**
 * CPU mirror of {@link LandeskarteViewport}: pixel x right, y down, and the depth along the
 * optical axis in metres. Null when the point is behind the near plane. Pass positions that
 * already carry the curvature drop, as the layers do.
 */
export function projectToScreen(
  pose: ViewPose,
  enu: ENU,
  width: number,
  height: number
): [number, number, number] | null {
  const {forward, right, up} = getCameraAxes(pose);
  const dx = enu[0] - pose.eye[0];
  const dy = enu[1] - pose.eye[1];
  const dz = enu[2] - pose.eye[2];
  const depth = dx * forward[0] + dy * forward[1] + dz * forward[2];
  if (depth <= (pose.near ?? DEFAULT_NEAR)) return null;
  const cameraX = dx * right[0] + dy * right[1] + dz * right[2];
  const cameraY = dx * up[0] + dy * up[1] + dz * up[2];
  const tanHalf = Math.tan((pose.vfov * DEG) / 2);
  // Normalised device coordinates, then pixels (y flipped: canvas y points down).
  const ndcX = cameraX / (depth * tanHalf * (width / height));
  const ndcY = cameraY / (depth * tanHalf);
  return [(ndcX * 0.5 + 0.5) * width, (0.5 - ndcY * 0.5) * height, depth];
}

/** Orthographic view for labels, markers and wedges, in canvas pixels (see makeScreenViewState). */
export function makeScreenView(): OrthographicView {
  return new OrthographicView({id: 'screen', flipY: true});
}

/**
 * View state that makes the screen view's world units equal canvas pixels with y down.
 * deck.gl wants the target at the canvas centre.
 */
export function makeScreenViewState(width: number, height: number) {
  return {target: [width / 2, height / 2, 0] as [number, number, number], zoom: 0};
}

/** Layers whose id starts with `screen-` draw in the screen view, all others in the world view. */
export function layerFilter({layer, viewport}: {layer: {id: string}; viewport: {id: string}}) {
  return layer.id.startsWith('screen-') === (viewport.id === 'screen');
}
