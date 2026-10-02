// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Pure CPU checks for views/*. Run: npx tsx checks/views.check.ts

import assert from 'node:assert/strict';
import type {ENU, ViewPose} from '../types';
import {createFlight, interpolatePose} from '../views/flight';
import {
  LandeskarteViewport,
  getCameraAxes,
  getPanoramaPose,
  getPlanPose,
  poseToViewState,
  projectToScreen
} from '../views/landeskarte-view';

const WIDTH = 1280;
const HEIGHT = 720;

function pass(name: string, detail: string): void {
  console.log(`PASS ${name}: ${detail}`);
}

const along = (pose: ViewPose, axis: 'forward' | 'right' | 'up', distance: number): ENU => {
  const v = getCameraAxes(pose)[axis];
  return [
    pose.eye[0] + v[0] * distance,
    pose.eye[1] + v[1] * distance,
    pose.eye[2] + v[2] * distance
  ];
};

// 1. A point on the optical axis lands in the middle of the canvas, whatever the pose.
{
  const poses: ViewPose[] = [
    getPlanPose(),
    getPanoramaPose(),
    {eye: [120, -340, 15], yaw: 123, pitch: 17, roll: -31, vfov: 40},
    {eye: [0, 0, 500], yaw: -200, pitch: -60, roll: 90, vfov: 20}
  ];
  let worst = 0;
  for (const pose of poses) {
    const p = projectToScreen(pose, along(pose, 'forward', 12_345), WIDTH, HEIGHT);
    assert.ok(p, 'point on the axis must project');
    worst = Math.max(worst, Math.abs(p[0] - WIDTH / 2), Math.abs(p[1] - HEIGHT / 2));
    assert.ok(Math.abs(p[2] - 12_345) < 1e-6, 'depth is the distance along the axis');
  }
  assert.ok(worst < 1e-6, `centre error ${worst}`);
  pass('centre', `max offset ${worst.toExponential(2)} px over ${poses.length} poses`);
}

// 2. Plan: eye straight above the origin, north at the top, east on the right.
{
  const plan = getPlanPose();
  const origin = projectToScreen(plan, [0, 0, 0], WIDTH, HEIGHT);
  const north = projectToScreen(plan, [0, 1000, 0], WIDTH, HEIGHT);
  const east = projectToScreen(plan, [1000, 0, 0], WIDTH, HEIGHT);
  assert.ok(origin && north && east);
  assert.ok(Math.abs(origin[0] - WIDTH / 2) < 1e-6 && Math.abs(origin[1] - HEIGHT / 2) < 1e-6);
  assert.ok(north[1] < origin[1] && Math.abs(north[0] - origin[0]) < 1e-6, 'north is up');
  assert.ok(east[0] > origin[0] && Math.abs(east[1] - origin[1]) < 1e-6, 'east is right');
  // Scale: 2 d tan(vfov/2) / height metres per pixel at the ground.
  const metersPerPixel = (2 * 40_000 * Math.tan((8 * Math.PI) / 360)) / HEIGHT;
  const measured = 1000 / (origin[1] - north[1]);
  assert.ok(Math.abs(measured / metersPerPixel - 1) < 1e-3);
  pass(
    'plan',
    `north up, east right, ${measured.toFixed(2)} m/px (formula ${metersPerPixel.toFixed(2)})`
  );
}

// 3. Roll rotates the camera clockwise: its up axis tilts right, so the world turns
// anticlockwise on screen (a point above the centre moves left, one to the right moves up).
{
  const level: ViewPose = {eye: [0, 0, 0], yaw: 0, pitch: 0, roll: 0, vfov: 50};
  const rolled: ViewPose = {...level, roll: 10};
  const above: ENU = [0, 1000, 150];
  const rightOf: ENU = [150, 1000, 0];
  const a0 = projectToScreen(level, above, WIDTH, HEIGHT);
  const a1 = projectToScreen(rolled, above, WIDTH, HEIGHT);
  const r0 = projectToScreen(level, rightOf, WIDTH, HEIGHT);
  const r1 = projectToScreen(rolled, rightOf, WIDTH, HEIGHT);
  assert.ok(a0 && a1 && r0 && r1);
  assert.ok(a1[0] < a0[0], 'point above centre moves left at positive roll');
  assert.ok(r1[1] < r0[1], 'point right of centre moves up at positive roll');
  const axes = getCameraAxes(rolled);
  assert.ok(axes.up[0] > 0 && axes.right[2] < 0, 'camera up tilts right, right tilts down');
  // The rotation angle of the image about the centre equals the roll.
  const angle = (p: number[]) => Math.atan2(HEIGHT / 2 - p[1], p[0] - WIDTH / 2);
  const turned = ((angle(a1) - angle(a0)) * 180) / Math.PI;
  assert.ok(turned > 9 && turned < 11, `image turn ${turned}`);
  pass(
    'roll',
    `10 deg camera roll turns the world ${turned.toFixed(2)} deg anticlockwise on screen`
  );
}

// 4. projectToScreen is the CPU mirror of the deck viewport.
{
  const pose: ViewPose = {eye: [300, -200, 80], yaw: 217, pitch: -8, roll: 3.5, vfov: 47};
  const viewport = new LandeskarteViewport({
    ...poseToViewState(pose),
    width: WIDTH,
    height: HEIGHT
  });
  let worst = 0;
  for (const point of [
    [-4000, 9000, 1500],
    [2500, 3000, 600],
    [100, 700, 40],
    [-900, -500, 300]
  ] as ENU[]) {
    const mine = projectToScreen(pose, point, WIDTH, HEIGHT);
    if (!mine) continue;
    const [x, y] = viewport.project(point);
    worst = Math.max(worst, Math.hypot(mine[0] - x, mine[1] - y));
  }
  assert.ok(worst < 1e-2, `mirror error ${worst} px`);
  pass('viewport mirror', `max distance to deck viewport.project ${worst.toExponential(2)} px`);
}

// 5. Points behind the camera do not project.
{
  const pose = getPanoramaPose();
  assert.equal(projectToScreen(pose, along(pose, 'forward', -500), WIDTH, HEIGHT), null);
  pass('behind', 'null behind the camera');
}

// 6. interpolatePose: exact ends, shortest yaw, monotone altitude.
{
  const from = getPlanPose();
  const to = getPanoramaPose();
  const end = interpolatePose(from, to, 1);
  assert.deepEqual(end.eye, to.eye);
  assert.ok(
    end.yaw === to.yaw && end.pitch === to.pitch && end.roll === to.roll && end.vfov === to.vfov
  );
  assert.deepEqual(interpolatePose(from, to, 0).eye, from.eye);
  assert.deepEqual(interpolatePose(from, to, 7).eye, to.eye, 't beyond 1 clamps to the target');
  let previous = Infinity;
  for (let i = 0; i <= 100; i++) {
    const height = interpolatePose(from, to, i / 100).eye[2];
    assert.ok(height <= previous + 1e-9, 'altitude never rises on a descent');
    previous = height;
  }
  // 350 -> 10 degrees goes through north, 20 degrees, not 340.
  const wrap = interpolatePose({...from, yaw: 350}, {...from, yaw: 10}, 0.5);
  assert.ok(Math.abs(wrap.yaw - 360) < 1e-9, `wrap yaw ${wrap.yaw}`);
  // Log-altitude: the midpoint of a 40 km descent is far below the arithmetic midpoint.
  const mid = interpolatePose(from, to, 0.5).eye[2];
  assert.ok(mid < 10_000);
  pass(
    'interpolate',
    `ends exact; yaw 350->10 takes the 20 degree arc; mid altitude ${mid.toFixed(0)} m`
  );
}

// 7. createFlight ends exactly on the target pose (rAF shimmed to a 16 ms clock).
{
  const from = getPlanPose();
  const to = getPanoramaPose();
  const g = globalThis as unknown as Record<string, unknown>;
  let clock = 0;
  const queue: ((now: number) => void)[] = [];
  g.performance = {now: () => clock};
  g.requestAnimationFrame = (callback: (now: number) => void) => queue.push(callback);
  g.cancelAnimationFrame = () => {};
  const poses: ViewPose[] = [];
  let done = 0;
  createFlight(
    from,
    to,
    1000,
    pose => poses.push(pose),
    () => done++
  );
  while (queue.length) {
    clock += 16;
    queue.shift()?.(clock);
  }
  const last = poses[poses.length - 1];
  assert.equal(done, 1);
  assert.deepEqual(last.eye, to.eye);
  assert.ok(last.yaw === to.yaw && last.pitch === to.pitch && last.roll === to.roll);
  assert.ok(last.vfov === to.vfov);
  pass('flight', `${poses.length} frames, final pose identical to target, onDone once`);
  // cancel() stops the flight and never calls onDone.
  queue.length = 0;
  let cancelledDone = 0;
  const flight = createFlight(
    from,
    to,
    1000,
    () => {},
    () => cancelledDone++
  );
  flight.cancel();
  while (queue.length) {
    clock += 16;
    queue.shift()?.(clock);
  }
  assert.equal(cancelledDone, 0);
  pass('cancel', 'cancelled flight never calls onDone');
}
