// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Pointer and keyboard input. Deliberately no wheel handling: the example is embedded in pages
// that scroll, and `touch-action: pan-y` lets a vertical swipe scroll the page. Dragging pans the
// plan and looks around in the panorama.

import type {SceneMode, ViewPose} from '../types';
import {getCameraAxes} from './landeskarte-view';

export type OrbitControlsOptions = {
  getPose: () => ViewPose;
  setPose: (pose: ViewPose) => void;
  mode: SceneMode | (() => SceneMode);
};

const DEG = Math.PI / 180;
const MAX_PANORAMA_PITCH = 60;
/** Keyboard step: a tenth of the view for pan, a few degrees for look-around. */
const KEY_PAN_FRACTION = 0.1;
const KEY_LOOK_DEGREES = 4;

/** Returns a function that removes the listeners. */
export function attachOrbitControls(
  canvas: HTMLCanvasElement,
  options: OrbitControlsOptions
): () => void {
  const getMode =
    typeof options.mode === 'function' ? options.mode : () => options.mode as SceneMode;
  let dragPointer: number | null = null;
  let lastX = 0;
  let lastY = 0;

  // Move by a screen-space delta in pixels: positive x is to the right, positive y is down.
  const moveByPixels = (dx: number, dy: number) => {
    const pose = options.getPose();
    const height = canvas.clientHeight || 1;
    if (getMode() === 'plan') {
      // Drag the sheet under the finger: the eye moves the opposite way. Metres per pixel at the
      // ground follow from the eye height and the field of view.
      const metersPerPixel =
        (2 * Math.max(pose.eye[2], 1) * Math.tan((pose.vfov * DEG) / 2)) / height;
      const {right, up} = getCameraAxes(pose);
      options.setPose({
        ...pose,
        eye: [
          pose.eye[0] - right[0] * dx * metersPerPixel + up[0] * dy * metersPerPixel,
          pose.eye[1] - right[1] * dx * metersPerPixel + up[1] * dy * metersPerPixel,
          pose.eye[2]
        ]
      });
      return;
    }
    // Panorama: the scene follows the finger, so dragging right turns the view left.
    const degreesPerPixel = pose.vfov / height;
    options.setPose({
      ...pose,
      yaw: pose.yaw - dx * degreesPerPixel,
      pitch: Math.max(
        -MAX_PANORAMA_PITCH,
        Math.min(MAX_PANORAMA_PITCH, pose.pitch + dy * degreesPerPixel)
      )
    });
  };

  const onPointerDown = (event: PointerEvent) => {
    if (dragPointer !== null || (event.pointerType === 'mouse' && event.button !== 0)) return;
    dragPointer = event.pointerId;
    lastX = event.clientX;
    lastY = event.clientY;
    canvas.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent) => {
    if (event.pointerId !== dragPointer) return;
    moveByPixels(event.clientX - lastX, event.clientY - lastY);
    lastX = event.clientX;
    lastY = event.clientY;
  };
  const onPointerEnd = (event: PointerEvent) => {
    if (event.pointerId !== dragPointer) return;
    dragPointer = null;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const keys: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1]
    };
    const direction = keys[event.key];
    if (!direction) return;
    event.preventDefault();
    const height = canvas.clientHeight || 1;
    const pose = options.getPose();
    // Arrow keys move the view in the arrow's direction, so the dragged content goes the other way.
    const stepPixels =
      getMode() === 'plan' ? height * KEY_PAN_FRACTION : (KEY_LOOK_DEGREES * height) / pose.vfov;
    moveByPixels(-direction[0] * stepPixels, -direction[1] * stepPixels);
  };

  const previousTouchAction = canvas.style.touchAction;
  canvas.style.touchAction = 'pan-y';
  if (!canvas.hasAttribute('tabindex')) canvas.tabIndex = 0;
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerEnd);
  canvas.addEventListener('pointercancel', onPointerEnd);
  canvas.addEventListener('keydown', onKeyDown);
  return () => {
    canvas.style.touchAction = previousTouchAction;
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerEnd);
    canvas.removeEventListener('pointercancel', onPointerEnd);
    canvas.removeEventListener('keydown', onKeyDown);
  };
}
