// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import {View, Viewport} from '@deck.gl/core';
import {Matrix4} from '@math.gl/core';
import type {CameraPose} from './scene-data';

/** Transition fields that every deck.gl view state accepts (not exported by name). */
type CommonViewState = View extends View<infer ViewState> ? ViewState : never;

/** View state of a {@link SummitView}: a photo camera in local east/north/up metres. */
export type SummitViewState = CameraPose &
  CommonViewState & {
    /** Lens position in the local frame (x east, y north, z up), metres. */
    position: [number, number, number];
    /** Near plane, metres (default 10). A large near plane keeps depth precision at 100 km. */
    near?: number;
    /** Far plane, metres (default 250 km). */
    far?: number;
  };

type SummitViewportProps = SummitViewState & {
  id?: string;
  x?: number;
  y?: number;
  width: number;
  height: number;
};

type Vector3 = [number, number, number];

/** Optical axis and image-up direction of a camera pose, in the local frame. */
export function getCameraAxes(pose: CameraPose): {forward: Vector3; right: Vector3; up: Vector3} {
  const yaw = (pose.yaw * Math.PI) / 180;
  const pitch = (pose.pitch * Math.PI) / 180;
  const roll = (pose.roll * Math.PI) / 180;
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
  const right = levelRight.map(
    (value, index) => value * cosine - levelUp[index] * sine
  ) as Vector3;
  const up = levelUp.map((value, index) => value * cosine + levelRight[index] * sine) as Vector3;
  return {forward, right, up};
}

/**
 * A perspective viewport with full yaw / pitch / roll and vertical field of view.
 * deck.gl's FirstPersonViewport has no roll, which a hand-held photo almost always has.
 * The world is non-geospatial: layers use `COORDINATE_SYSTEM.CARTESIAN` in local metres.
 */
export class SummitViewport extends Viewport {
  static override displayName = 'SummitViewport';

  constructor(props: SummitViewportProps) {
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
      near: props.near ?? 10,
      far: props.far ?? 250_000
    });
  }
}

/** A deck.gl view that looks through a photo's camera. The pose is app-driven: no controller. */
export class SummitView extends View<SummitViewState> {
  static displayName = 'SummitView';

  override getViewportType() {
    return SummitViewport;
  }

  protected override get ControllerType(): never {
    // SummitView has no controller; the photo pose is fixed.
    throw new Error('SummitView');
  }
}
