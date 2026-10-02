// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Pure CPU check of the label rules on the real Niederhorn peak list: no browser, no GPU.
// Run: npx tsx examples/deck/landeskarte/checks/labels.check.ts

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {LAKES, SUMMIT_EYE, SUMMIT_FRAME_VIEW} from '../data/scene-data';
import {makeFrame} from '../geo/geodesy';
import {
  getLabelBlock,
  getLeaderEnd,
  placeLabels,
  toTextLayers,
  type PlaceLabelsInput
} from '../overlay/labels';
import {
  estimateTextWidth,
  formatAltitude,
  LABEL_CHARACTER_SET,
  LABEL_FLOOR_PX,
  NAME_TYPO,
  THIN_SPACE,
  trackText
} from '../overlay/typography';
import type {ENU, Peak, PlacedLabel} from '../types';

const pass = (message: string) => console.log(`PASS ${message}`);

const peaksFile = JSON.parse(
  readFileSync(new URL('../data/peaks-niederhorn.json', import.meta.url), 'utf8')
) as {peaks: Peak[]};
const peaks = peaksFile.peaks;
const frame = makeFrame(SUMMIT_EYE.lat, SUMMIT_EYE.lon, SUMMIT_EYE.h);

// 1. Typography ------------------------------------------------------------------------------
assert.equal(formatAltitude(1963), `1${THIN_SPACE}963`);
assert.equal(formatAltitude(558), '558');
assert.equal(formatAltitude(4274), `4${THIN_SPACE}274`);
assert.equal(formatAltitude(1000.4), `1${THIN_SPACE}000`);
assert.equal(formatAltitude(12345), `12${THIN_SPACE}345`);
assert.equal(THIN_SPACE.charCodeAt(0), 0x2009);
pass('formatAltitude uses U+2009 thousands: 1963 -> "1 963", 558 -> "558"');

for (const char of 'äöüÄÖÜéèàçßÂ') {
  assert.ok(LABEL_CHARACTER_SET.includes(char), `characterSet lacks ${char}`);
}
assert.ok(LABEL_CHARACTER_SET.includes(THIN_SPACE) && LABEL_CHARACTER_SET.includes(' '));
const allNames = [...peaks.map(peak => peak.name), ...LAKES.map(lake => lake.name)];
const missing = new Set<string>();
for (const name of allNames) {
  for (const char of trackText(name)) {
    if (!LABEL_CHARACTER_SET.includes(char)) missing.add(char);
  }
}
assert.deepEqual([...missing], []);
pass(`characterSet covers every glyph of ${allNames.length} names and the tracked lakes`);

assert.ok(NAME_TYPO['peak-major'].scale * 13 > NAME_TYPO.peak.scale * 13);
assert.ok(NAME_TYPO.minor.scale * 13 >= LABEL_FLOOR_PX);
assert.ok(
  estimateTextWidth('Jungfrau', 13, {weight: 700, italic: false, trackingEm: 0}) >
    estimateTextWidth('Jungfrau', 13, {weight: 500, italic: false, trackingEm: 0})
);
pass('tier scales ordered and the smallest tier (13 px x 0.86) stays on the 11 px floor');

// 2. A pinhole camera for the panorama and a top-down camera for the plan -----------------------
function makePanoramaProject(
  width: number,
  height: number,
  yawDeg: number = SUMMIT_FRAME_VIEW.yaw
) {
  const yaw = (yawDeg * Math.PI) / 180;
  const pitch = (SUMMIT_FRAME_VIEW.pitch * Math.PI) / 180;
  const focal = height / 2 / Math.tan((SUMMIT_FRAME_VIEW.vfov * Math.PI) / 360);
  const forward = [
    Math.sin(yaw) * Math.cos(pitch),
    Math.cos(yaw) * Math.cos(pitch),
    Math.sin(pitch)
  ];
  const right = [Math.cos(yaw), -Math.sin(yaw), 0];
  const up = [
    right[1] * forward[2] - right[2] * forward[1],
    right[2] * forward[0] - right[0] * forward[2],
    right[0] * forward[1] - right[1] * forward[0]
  ];
  return (enu: ENU): [number, number, number] | null => {
    const depth = enu[0] * forward[0] + enu[1] * forward[1] + enu[2] * forward[2];
    if (depth <= 1) return null;
    const x = enu[0] * right[0] + enu[1] * right[1] + enu[2] * right[2];
    const y = enu[0] * up[0] + enu[1] * up[1] + enu[2] * up[2];
    return [width / 2 + (focal * x) / depth, height / 2 - (focal * y) / depth, depth];
  };
}

function makePlanProject(width: number, height: number, metersPerPixel: number) {
  return (enu: ENU): [number, number, number] | null => [
    width / 2 + enu[0] / metersPerPixel,
    height / 2 - enu[1] / metersPerPixel,
    1000
  ];
}

const visibleAll = () => true;

type Box = {x0: number; y0: number; x1: number; y1: number};

/** Text box of a placed label, rebuilt from the public layout helper and the estimator. */
function boxFor(label: PlacedLabel): Box {
  const style = NAME_TYPO[label.tier];
  const block = getLabelBlock(label.sizePx, label.subtext !== '');
  const text = label.tier === 'lake' ? trackText(label.text) : label.text;
  const nameWidth = estimateTextWidth(text, label.sizePx, {...style, trackingEm: 0});
  const subWidth = estimateTextWidth(label.subtext, block.subtextSize, {
    weight: 400,
    italic: false,
    trackingEm: 0
  });
  const w = Math.max(nameWidth, subWidth);
  return {
    x0: label.position[0] - w / 2,
    x1: label.position[0] + w / 2,
    y0: label.position[1] - block.height / 2,
    y1: label.position[1] + block.height / 2
  };
}

// Independent segment-vs-segment test (parametric solve, not the module's orientation test).
function segmentsCross(
  a: [number, number, number, number],
  b: [number, number, number, number]
): boolean {
  const [x1, y1, x2, y2] = a;
  const [x3, y3, x4, y4] = b;
  const denominator = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3);
  if (Math.abs(denominator) < 1e-12) {
    return false; // parallel: the placer rejects overlapping collinear leaders via boxes
  }
  const t = ((x3 - x1) * (y4 - y3) - (y3 - y1) * (x4 - x3)) / denominator;
  const u = ((x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1)) / denominator;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

function pointInBox(x: number, y: number, box: Box): boolean {
  return x > box.x0 && x < box.x1 && y > box.y0 && y < box.y1;
}

function overlapArea(a: Box, b: Box): number {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return w > 0 && h > 0 ? w * h : 0;
}

// 3. Panorama ---------------------------------------------------------------------------------
const panoramaWidth = 1280;
const panoramaHeight = 960;
const panoramaProject = makePanoramaProject(panoramaWidth, panoramaHeight);

// Skyline stand-in: a 40 degree "roof" over every projected summit. Names must clear it.
const summitPoints: [number, number][] = [];
for (const peak of peaks) {
  const projected = panoramaProject(frame.toEnu(peak.lat, peak.lon, peak.ele));
  if (projected) summitPoints.push([projected[0], projected[1]]);
}
const skyline = (x: number): number => {
  let best = Infinity;
  for (const [px, py] of summitPoints) {
    best = Math.min(best, py + 0.8 * Math.abs(x - px));
  }
  return best;
};

const panoramaInput: PlaceLabelsInput = {
  peaks,
  lakes: LAKES,
  frame,
  project: panoramaProject,
  visible: visibleAll,
  viewport: {width: panoramaWidth, height: panoramaHeight},
  mode: 'panorama'
};
const panorama = placeLabels(panoramaInput);

const projectedInView = summitPoints.filter(
  ([x, y]) => x > 4 && x < panoramaWidth - 4 && y > 4 && y < panoramaHeight - 4
).length;
assert.ok(panorama.filter(l => l.tier !== 'lake').length >= 0.5 * projectedInView);
pass(
  `panorama: ${panorama.filter(l => l.tier !== 'lake').length} of ${projectedInView} in-frame summits named`
);

const panoramaPeaks = panorama.filter(label => label.tier !== 'lake');
assert.ok(panoramaPeaks.every(label => label.leader));
assert.ok(panoramaPeaks.every(label => label.position[1] < label.anchor[1]));
for (let i = 1; i < panorama.length; i++) {
  assert.ok(panorama[i - 1].anchor[0] <= panorama[i].anchor[0]);
}
pass('panorama: every name has a leader, sits above its summit, output sorted by azimuth (x)');

let crossings = 0;
let pairs = 0;
let leaderThroughBox = 0;
for (let i = 0; i < panoramaPeaks.length; i++) {
  const a = panoramaPeaks[i];
  const endA = getLeaderEnd(a);
  for (let j = i + 1; j < panoramaPeaks.length; j++) {
    const b = panoramaPeaks[j];
    const endB = getLeaderEnd(b);
    pairs++;
    if (
      segmentsCross(
        [a.anchor[0], a.anchor[1], endA[0], endA[1]],
        [b.anchor[0], b.anchor[1], endB[0], endB[1]]
      )
    ) {
      crossings++;
    }
  }
  for (const other of panorama) {
    if (other === a) continue;
    const box = boxFor(other);
    // Sample the leader finely: no point of it may lie inside another name's box.
    for (let s = 0; s <= 40; s++) {
      const t = s / 40;
      const x = a.anchor[0] + (endA[0] - a.anchor[0]) * t;
      const y = a.anchor[1] + (endA[1] - a.anchor[1]) * t;
      if (pointInBox(x, y, box)) {
        leaderThroughBox++;
        break;
      }
    }
  }
}
assert.equal(crossings, 0);
assert.equal(leaderThroughBox, 0);
pass(`panorama: 0 leader crossings in ${pairs} pairs, 0 leaders through another name`);

let overlaps = 0;
let maxOverlap = 0;
for (let i = 0; i < panorama.length; i++) {
  for (let j = i + 1; j < panorama.length; j++) {
    const area = overlapArea(boxFor(panorama[i]), boxFor(panorama[j]));
    if (area > 0) overlaps++;
    maxOverlap = Math.max(maxOverlap, area);
  }
}
assert.equal(overlaps, 0);
pass(`panorama: no overlapping name boxes (max overlap ${maxOverlap} px^2)`);

const withSkyline = placeLabels({...panoramaInput, skyline});
let skylineViolations = 0;
for (const label of withSkyline.filter(entry => entry.tier !== 'lake')) {
  const box = boxFor(label);
  for (let x = box.x0; x <= box.x1; x += 2) {
    if (box.y1 > skyline(x)) skylineViolations++;
  }
}
assert.equal(skylineViolations, 0);
assert.ok(withSkyline.length > 0);
pass(
  `panorama: ${withSkyline.length} names all clear the skyline (${skylineViolations} violations)`
);

// 4. Plan -------------------------------------------------------------------------------------
const planWidth = 1280;
const planHeight = 800;
const planProject = makePlanProject(planWidth, planHeight, 30);
const planInput: PlaceLabelsInput = {
  peaks,
  lakes: LAKES,
  frame,
  project: planProject,
  visible: visibleAll,
  viewport: {width: planWidth, height: planHeight},
  mode: 'plan'
};
const plan = placeLabels(planInput);
assert.ok(plan.length >= 15, `plan placed ${plan.length}`);
const planPeaks = plan.filter(label => label.tier !== 'lake');
const besideLabels = planPeaks.filter(label => !label.leader);
const upperRight = besideLabels.filter(
  label => label.position[0] > label.anchor[0] && label.position[1] <= label.anchor[1] + 0.5
).length;
assert.ok(besideLabels.length > 0);
assert.ok(upperRight / besideLabels.length >= 0.6, 'upper-right preference');
pass(
  `plan: ${plan.length} names, ${upperRight} of ${besideLabels.length} un-led names sit upper-right ` +
    `(${Math.round((100 * upperRight) / besideLabels.length)}%)`
);

let planOverlaps = 0;
for (let i = 0; i < plan.length; i++) {
  for (let j = i + 1; j < plan.length; j++) {
    if (overlapArea(boxFor(plan[i]), boxFor(plan[j])) > 0) planOverlaps++;
  }
}
assert.equal(planOverlaps, 0);
pass('plan: no overlapping name boxes');

const projectedPlan = peaks
  .map(peak => ({peak, p: planProject(frame.toEnu(peak.lat, peak.lon, peak.ele))}))
  .filter(({p}) => p && p[0] > 4 && p[0] < planWidth - 4 && p[1] > 4 && p[1] < planHeight - 4);
const majorTotal = projectedPlan.filter(({peak}) => peak.tier === 'peak-major').length;
const majorShown = plan.filter(label => label.tier === 'peak-major').length;
const minorTotal = projectedPlan.filter(({peak}) => peak.tier === 'minor').length;
const minorShown = plan.filter(label => label.tier === 'minor').length;
if (majorTotal > 0 && minorTotal > 0) {
  assert.ok(
    majorShown / majorTotal >= minorShown / minorTotal,
    'majors survive at least as often as minors'
  );
}
pass(
  `plan: declutter keeps rank (major ${majorShown}/${majorTotal}, minor ${minorShown}/${minorTotal})`
);

assert.ok(
  plan.some(label => label.tier === 'lake'),
  'a lake name is placed in the plan'
);
pass(`plan: lake names placed (${plan.filter(label => label.tier === 'lake').length})`);

// 5. Floor, visibility, determinism --------------------------------------------------------------
for (const placed of [plan, panorama]) {
  for (const label of placed) {
    assert.ok(label.sizePx >= LABEL_FLOOR_PX, `${label.id} ${label.sizePx}px`);
  }
}
const floored = placeLabels({...planInput, minPx: 4, baseSizePx: 7});
assert.ok(floored.length > 0 && floored.every(label => label.sizePx >= LABEL_FLOOR_PX));
pass(`all sizes >= ${LABEL_FLOOR_PX} px, even when asked for 4 px at a 7 px base`);

const hidden = new Set(panoramaPeaks.slice(0, 5).map(label => label.id));
const withHidden = placeLabels({...panoramaInput, visible: id => !hidden.has(id)});
assert.ok(withHidden.every(label => !hidden.has(label.id)));
pass(`visible() removes occluded summits (${hidden.size} hidden, none placed)`);

assert.deepEqual(placeLabels(panoramaInput), panorama);
assert.deepEqual(placeLabels(planInput), plan);
pass('placement is deterministic');

const phoneProject = makePlanProject(390, 700, 12);
const tiny = placeLabels({
  ...planInput,
  project: phoneProject,
  viewport: {width: 390, height: 700}
});
assert.ok(tiny.length > 0);
for (const label of tiny) {
  const box = boxFor(label);
  assert.ok(box.x0 >= 0 && box.x1 <= 390 && box.y0 >= 0 && box.y1 <= 700);
}
pass(`phone-size plan keeps ${tiny.length} names inside the canvas`);

// Stress: turn the panorama through 360 degrees and demand the same invariants everywhere.
let sweepLabels = 0;
let sweepPairs = 0;
for (let yawDeg = 0; yawDeg < 360; yawDeg += 15) {
  const project = makePanoramaProject(panoramaWidth, panoramaHeight, yawDeg);
  const placed = placeLabels({...panoramaInput, project}).filter(label => label.tier !== 'lake');
  sweepLabels += placed.length;
  for (let i = 0; i < placed.length; i++) {
    const a = placed[i];
    const endA = getLeaderEnd(a);
    for (let j = i + 1; j < placed.length; j++) {
      const b = placed[j];
      const endB = getLeaderEnd(b);
      sweepPairs++;
      assert.equal(overlapArea(boxFor(a), boxFor(b)), 0, `boxes overlap at yaw ${yawDeg}`);
      assert.ok(
        !segmentsCross(
          [a.anchor[0], a.anchor[1], endA[0], endA[1]],
          [b.anchor[0], b.anchor[1], endB[0], endB[1]]
        ),
        `leaders cross at yaw ${yawDeg}`
      );
    }
  }
}
pass(`sweep: 24 yaws, ${sweepLabels} names, ${sweepPairs} pairs, no overlap, no crossing`);

// 6. Layers -----------------------------------------------------------------------------------
for (const [placed, mode] of [
  [plan, 'plan'],
  [panorama, 'panorama']
] as const) {
  const layers = toTextLayers(placed, mode);
  assert.ok(layers.length >= 6);
  for (const layer of layers) {
    assert.ok(layer.id.startsWith('screen-labels'), layer.id);
  }
  const ids = new Set(layers.map(layer => layer.id));
  assert.equal(ids.size, layers.length);
  const text = layers.find(layer => layer.id === 'screen-labels-peak');
  assert.ok(text);
  const props = text.props as unknown as Record<string, any>;
  assert.equal(props.fontSettings.sdf, true);
  assert.ok(props.outlineWidth > 0);
  assert.deepEqual(props.outlineColor, [244, 244, 244, 255]);
  assert.ok(props.characterSet.includes('ü'));
  const lake = layers.find(layer => layer.id === 'screen-labels-lake');
  assert.ok(String((lake?.props as unknown as {fontWeight: string}).fontWeight).includes('italic'));
}
pass('toTextLayers: ids screen-labels*, sdf + paper halo, umlaut characterSet, italic lake serif');
