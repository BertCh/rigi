// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import {OrbitView, OrbitViewport, View, type OrbitViewProps} from '@deck.gl/core';
import {Matrix4} from '@math.gl/core';
import type {CameraPose} from './scene-data';

type Vector3 = [number, number, number];

/** Transition fields that every deck.gl view state accepts (not exported by name). */
type CommonViewState = View extends View<infer ViewState> ? ViewState : never;

/** View state of a {@link PhotoOrbitView}: deck.gl's orbit view state, orbit axis Z. */
export type PhotoOrbitViewState = CommonViewState & {
  /** Point the camera orbits, local east/north/up metres. */
  target: Vector3;
  /** log2 of screen pixels per metre at the target. */
  zoom: number;
  /** Camera tilt: 0 looks horizontally, 90 straight down. */
  rotationX: number;
  /** Camera heading, degrees clockwise from north. */
  rotationOrbit: number;
};

/** Where the photo was taken: the view rolls like the photo when its eye is there. */
export type RollAnchor = {
  /** Photo camera position, local frame. */
  position: Vector3;
  /** Photo roll, degrees; positive turns the image clockwise. */
  roll: number;
  /** The roll fades out as the eye moves this many metres away. */
  fadeDistance: number;
};

export type PhotoOrbitViewProps = OrbitViewProps & {rollAnchor?: RollAnchor};

type PhotoOrbitViewportProps = Partial<PhotoOrbitViewState> & {
  id?: string;
  x?: number;
  y?: number;
  width: number;
  height: number;
  fovy?: number;
  rollAnchor?: RollAnchor;
};

const DEGREES_TO_RADIANS = Math.PI / 180;
/** Near and far planes as multiples of the camera's distance to the target. */
const NEAR_PLANE_SCALE = 0.08;
const FAR_PLANE_SCALE = 400;

/** Optical axis and image-up direction of a camera pose, in the local frame. */
export function getCameraAxes(pose: CameraPose): {forward: Vector3; right: Vector3; up: Vector3} {
  const yaw = pose.yaw * DEGREES_TO_RADIANS;
  const pitch = pose.pitch * DEGREES_TO_RADIANS;
  const roll = pose.roll * DEGREES_TO_RADIANS;
  const forward: Vector3 = [
    Math.sin(yaw) * Math.cos(pitch),
    Math.cos(yaw) * Math.cos(pitch),
    Math.sin(pitch)
  ];
  // Level right and up vectors, then rotated about the optical axis by the roll angle.
  const levelRight: Vector3 = [Math.cos(yaw), -Math.sin(yaw), 0];
  const levelUp: Vector3 = [
    levelRight[1] * forward[2] - levelRight[2] * forward[1],
    levelRight[2] * forward[0] - levelRight[0] * forward[2],
    levelRight[0] * forward[1] - levelRight[1] * forward[0]
  ];
  const cosine = Math.cos(roll);
  const sine = Math.sin(roll);
  const right: Vector3 = [0, 0, 0];
  const up: Vector3 = [0, 0, 0];
  for (let index = 0; index < 3; index++) {
    right[index] = levelRight[index] * cosine - levelUp[index] * sine;
    up[index] = levelUp[index] * cosine + levelRight[index] * sine;
  }
  return {forward, right, up};
}

/**
 * The perspective projection of an orbit viewport, rolled about the line of sight. deck.gl's
 * OrbitViewport places the camera `projectionMatrix[5] / 2` scaled units from the target, so
 * {@link getFocalDistance} is the matching distance.
 */
function makeRolledProjectionMatrix(fovy: number, aspect: number, roll: number): Matrix4 {
  const focalDistance = getFocalDistance(fovy, roll);
  // A camera rolled clockwise sees the world rotated counter-clockwise: rotate view space by +roll.
  return new Matrix4()
    .perspective({
      fovy: fovy * DEGREES_TO_RADIANS,
      aspect,
      near: NEAR_PLANE_SCALE * focalDistance,
      far: FAR_PLANE_SCALE * focalDistance
    })
    .rotateZ(roll * DEGREES_TO_RADIANS);
}

/** Camera-to-target distance in OrbitViewport's scaled units, for a rolled projection. */
export function getFocalDistance(fovy: number, roll: number): number {
  return Math.cos(roll * DEGREES_TO_RADIANS) / (2 * Math.tan((fovy * DEGREES_TO_RADIANS) / 2));
}

/**
 * The orbit view state that puts the camera exactly at `position` with `pose`, `distance` metres
 * behind its target. A canvas `height` CSS pixels high then shows what the photo camera saw.
 */
export function getPhotoOrbitViewState(
  position: Vector3,
  pose: CameraPose,
  distance: number,
  height: number
): PhotoOrbitViewState {
  const {forward} = getCameraAxes(pose);
  const focalDistance = getFocalDistance(pose.verticalFieldOfView, pose.roll);
  return {
    target: [
      position[0] + forward[0] * distance,
      position[1] + forward[1] * distance,
      position[2] + forward[2] * distance
    ],
    // OrbitViewport: distance = focalDistance · height / 2^zoom.
    zoom: Math.log2((focalDistance * height) / distance),
    rotationX: -pose.pitch,
    rotationOrbit: pose.yaw
  };
}

/**
 * The roll of an orbit camera: the anchor's roll at the anchor, fading smoothly to 0 with
 * distance. deck.gl's orbit controller and its transitions keep only the orbit view-state fields,
 * so roll cannot live in the view state; tying it to the eye position lets a view-state
 * transition to {@link getPhotoOrbitViewState} end exactly in the photo's framing.
 */
function getAnchoredRoll(props: PhotoOrbitViewportProps, fovy: number): number {
  const {rollAnchor, target = [0, 0, 0], zoom = 0, rotationX = 0, rotationOrbit = 0} = props;
  if (!rollAnchor) return 0;
  const {forward} = getCameraAxes({
    yaw: rotationOrbit,
    pitch: -rotationX,
    roll: 0,
    verticalFieldOfView: fovy
  });
  // Unrolled eye distance; with the roll it is cos(roll) shorter, about 1 m at the photo.
  const distance = (getFocalDistance(fovy, 0) * props.height) / 2 ** zoom;
  const offset = Math.hypot(
    target[0] - forward[0] * distance - rollAnchor.position[0],
    target[1] - forward[1] * distance - rollAnchor.position[1],
    target[2] - forward[2] * distance - rollAnchor.position[2]
  );
  const fraction = Math.min(offset / rollAnchor.fadeDistance, 1);
  return rollAnchor.roll * (1 - fraction * fraction * (3 - 2 * fraction));
}

/**
 * deck.gl's OrbitViewport (orbit axis Z) with roll. A hand-held photo almost always has some
 * roll, which OrbitViewport cannot express; it is folded into the projection matrix.
 */
export class PhotoOrbitViewport extends OrbitViewport {
  static override displayName = 'PhotoOrbitViewport';
  /** Applied roll, degrees. */
  readonly roll: number;

  constructor(props: PhotoOrbitViewportProps) {
    const fovy = props.fovy ?? 50;
    const roll = getAnchoredRoll(props, fovy);
    super({
      ...props,
      orbitAxis: 'Z',
      projectionMatrix: makeRolledProjectionMatrix(fovy, props.width / props.height, roll)
    });
    this.roll = roll;
  }
}

/**
 * An OrbitView (orbit axis Z, OrbitController) whose viewport takes the photo's roll near the
 * photo camera (`rollAnchor`).
 */
export class PhotoOrbitView extends OrbitView {
  static override displayName = 'PhotoOrbitView';

  constructor(props: PhotoOrbitViewProps = {}) {
    super(props);
  }

  override getViewportType() {
    return PhotoOrbitViewport;
  }
}
