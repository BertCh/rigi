// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Pure CPU checks for ui/furniture.ts. Run: npx tsx checks/furniture.check.ts
// The DOM part runs against a tiny recording fake of `document`, enough to prove that building and
// updating the furniture neither throws nor leaves the text wrong.

import assert from 'node:assert/strict';
import {makeFrame} from '../geo/geodesy';
import {lv95ToWgs84, wgs84ToLv95} from '../geo/lv95';
import {hypsoColor} from '../terrain/lut';
import type {Station, SymbolId, ViewPose} from '../types';
import {
  NEATLINE_INSET,
  PLAN_REFERENCE_ELEVATION_M,
  bearingTicks,
  compassName,
  createFurniture,
  edgeTicks,
  elevationKeyStops,
  formatDecimalDe,
  formatGridLabel,
  formatThousands,
  makePlanBasis,
  metersPerPixelAtCentre,
  niceGridStep,
  niceScaleLength,
  renderWegweiser,
  scaleDenominator,
  seededJitter,
  wrapDeltaDegrees
} from '../ui/furniture';

function pass(name: string, detail: string): void {
  console.log(`PASS ${name}: ${detail}`);
}

// 1. Scale bar: 1/2/5 x 10^n, largest that fits, value equals metersPerPixel * pixelLength.
{
  let worst = 0;
  let cases = 0;
  for (let mpp = 0.05; mpp < 400; mpp *= 1.07) {
    for (const maxPx of [60, 100, 140, 220]) {
      const bar = niceScaleLength(mpp, maxPx);
      const mantissa = bar.meters / 10 ** Math.floor(Math.log10(bar.meters));
      assert.ok(
        [1, 2, 5].some(m => Math.abs(m - mantissa) < 1e-9),
        `${bar.meters} not 1/2/5`
      );
      assert.ok(bar.px <= maxPx + 1e-9, 'bar exceeds maxPx');
      // The next nice length up must not fit.
      const next =
        mantissa === 1 ? bar.meters * 2 : mantissa === 2 ? bar.meters * 2.5 : bar.meters * 2;
      assert.ok(next / mpp > maxPx, `not the largest: ${bar.meters} at ${mpp}`);
      worst = Math.max(worst, Math.abs(bar.px * mpp - bar.meters) / bar.meters);
      cases++;
    }
  }
  assert.ok(worst < 0.01);
  assert.equal(niceScaleLength(10, 100).label, `1 km`);
  assert.equal(niceScaleLength(0.5, 100).label, `50 m`);
  pass('scale bar', `${cases} cases, worst |px*mpp - m|/m = ${worst.toExponential(2)}`);
}

// 2. Metres per pixel from the camera, against the pinhole formula.
{
  const pose: ViewPose = {eye: [0, 0, 40000], yaw: 0, pitch: -90, roll: 0, vfov: 8};
  const frame = makeFrame(46.7102, 7.7733, 1963);
  const planeUp = PLAN_REFERENCE_ELEVATION_M - frame.origin.h;
  const mpp = metersPerPixelAtCentre(pose, 900, planeUp);
  const expected = ((40000 - planeUp) * 2 * Math.tan((4 * Math.PI) / 180)) / 900;
  assert.ok(Math.abs(mpp - expected) < 1e-9);
  const denom = scaleDenominator(mpp);
  assert.ok(denom > 20000 && denom < 40000, `denominator ${denom}`);
  pass('metres per pixel', `${mpp.toFixed(3)} m/px, printed scale about 1:${denom}`);
}

// 3. Plan basis round trip, with and without yaw.
{
  const frame = makeFrame(46.7102, 7.7733, 1963);
  for (const yaw of [0, 37, 260.72]) {
    const pose: ViewPose = {eye: [120, -340, 40000], yaw, pitch: -90, roll: 0, vfov: 8};
    const basis = makePlanBasis(
      pose,
      {w: 1200, h: 800},
      PLAN_REFERENCE_ELEVATION_M - frame.origin.h
    );
    const [cx, cy] = basis.toScreen(120, -340);
    assert.ok(Math.abs(cx - 600) < 1e-9 && Math.abs(cy - 400) < 1e-9);
    const [e, n] = basis.toEnu(333, 222);
    const [x, y] = basis.toScreen(e, n);
    assert.ok(Math.abs(x - 333) < 1e-6 && Math.abs(y - 222) < 1e-6);
    // Yaw 90 looks east: east is screen-up.
    if (yaw === 0) {
      const [, up] = basis.toScreen(120, -340 + 100);
      assert.ok(up < 400, 'north is screen-up at yaw 0');
    }
  }
  pass('plan basis', 'screen <-> ENU round trip exact for yaw 0, 37, 260.72');
}

// 4. LV95 edge ticks: tick values land where LV95 says, step choice is spacing-driven.
{
  const frame = makeFrame(46.7102, 7.7733, 1963);
  const pose: ViewPose = {eye: [0, 0, 40000], yaw: 0, pitch: -90, roll: 0, vfov: 8};
  const viewport = {w: 1200, h: 800};
  const basis = makePlanBasis(pose, viewport, PLAN_REFERENCE_ELEVATION_M - frame.origin.h);
  const step = niceGridStep(basis.metersPerPixel, 96);
  assert.ok(step / basis.metersPerPixel >= 96);
  const geoOf = (p: {e: number; n: number}): [number, number] => {
    const g = lv95ToWgs84(p.e, p.n);
    return [g.lat, g.lon];
  };
  const lv = (x: number, y: number) => {
    const [e, n] = basis.toEnu(x, y);
    const g = frame.toGeo([e, n, 0]);
    return wgs84ToLv95(g.lat, g.lon);
  };
  const x0 = NEATLINE_INSET;
  const x1 = viewport.w - NEATLINE_INSET;
  const a = lv(x0, x0);
  const b = lv(x1, x0);
  const ticks = edgeTicks(a.e, b.e, step);
  assert.ok(ticks.length >= 2);
  let worst = 0;
  for (const {value, t} of ticks) {
    const p = lv(x0 + (x1 - x0) * t, x0);
    worst = Math.max(worst, Math.abs(p.e - value));
    assert.equal(value % step, 0);
  }
  assert.ok(worst < 2, `tick position error ${worst} m`);
  // Independent of the edge interpolation: the inverse projection of the tick's LV95 value (at
  // the northing of the top edge) must land on the same screen column within a pixel.
  let worstPx = 0;
  for (const {value, t} of ticks) {
    const northing = wgs84ToLv95(...geoOf(lv(x0 + (x1 - x0) * t, x0))).n;
    const g = lv95ToWgs84(value, northing);
    const [east, north] = frame.toEnu(g.lat, g.lon, frame.origin.h);
    const [sx] = basis.toScreen(east, north);
    worstPx = Math.max(worstPx, Math.abs(sx - (x0 + (x1 - x0) * t)));
  }
  assert.ok(worstPx < 1.5, `inverse-projected tick error ${worstPx} px`);
  // Reversed edge (north runs against the screen y axis).
  const rev = edgeTicks(2000, 1000, 500);
  assert.deepEqual(
    rev.map(r => r.value),
    [1000, 1500, 2000]
  );
  assert.ok(Math.abs(rev[0].t - 1) < 1e-12 && Math.abs(rev[2].t) < 1e-12);
  pass(
    'LV95 ticks',
    `${ticks.length} ticks at step ${step} m, interpolation error ${worst.toFixed(3)} m, inverse-projection error ${worstPx.toFixed(3)} px`
  );
}

// 5. Labels and number formats.
{
  assert.equal(formatThousands(1963), '1\u2009963');
  assert.equal(formatGridLabel(2626000, 1000), '2 626');
  assert.equal(formatGridLabel(1172500, 500), '1 172,5');
  assert.equal(formatDecimalDe(9.29, 1, true), '+9,3');
  assert.equal(formatDecimalDe(-18.55, 1, true), '\u221218,6');
  assert.equal(wrapDeltaDegrees(260.72, 251.43).toFixed(2), '9.29');
  assert.equal(wrapDeltaDegrees(10, 350), 20);
  assert.equal(compassName(260.72), 'W');
  assert.equal(compassName(359), 'N');
  pass('formats', 'thin-space thousands, German decimals, wrapped yaw delta, compass names');
}

// 6. Bearing ticks for the panorama frame: centred bearing at x = 0.5, monotonic.
{
  const ticks = bearingTicks(260.72, 52.11, 4 / 3, 5);
  assert.ok(ticks.length >= 8);
  for (let i = 1; i < ticks.length; i++) assert.ok(ticks[i].x > ticks[i - 1].x);
  const centre = bearingTicks(260, 52.11, 4 / 3, 5).find(t => t.bearing === 260);
  assert.ok(centre && Math.abs(centre.x - 0.5) < 1e-12);
  pass('bearing ticks', `${ticks.length} ticks across the 52.11 degree frame`);
}

// 7. Elevation key comes from the real LUT.
{
  const stops = elevationKeyStops(500, 3000);
  assert.equal(stops[0].offset, 0);
  assert.equal(stops[stops.length - 1].offset, 1);
  for (let i = 1; i < stops.length; i++) assert.ok(stops[i].offset > stops[i - 1].offset);
  const c = hypsoColor(500);
  assert.equal(stops[0].color, `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`);
  pass('elevation key', `${stops.length} stops from HYPSO_STOPS`);
}

// 8. Seeded jitter: deterministic, at most 0.9 px, and varying between ids.
{
  const ids = [
    'legend',
    'blatt',
    'scale',
    'north',
    'cartouche',
    'imprint',
    'corner-nw',
    'corner-ne'
  ];
  let max = 0;
  const seen = new Set<string>();
  for (const id of ids) {
    const [dx, dy] = seededJitter(id);
    assert.deepEqual(seededJitter(id), [dx, dy]);
    max = Math.max(max, Math.hypot(dx, dy));
    seen.add(`${dx.toFixed(3)},${dy.toFixed(3)}`);
  }
  assert.ok(max <= 0.9 + 1e-12, `max ${max}`);
  assert.equal(seen.size, ids.length);
  pass('jitter', `max offset length = ${max.toFixed(3)} px over ${ids.length} ids, all distinct`);
}

// 9. DOM smoke on a recording fake.
class FakeNode {
  children: FakeNode[] = [];
  attributes: Record<string, string> = {};
  style: Record<string, string | ((k: string, v: string) => void)> = {
    setProperty: (k: string, v: string) => {
      this.style[k] = v;
    }
  };
  dataset: Record<string, string> = {};
  classList = {
    add: (c: string) => {
      this.className = `${this.className} ${c}`.trim();
    }
  };
  className = '';
  hidden = false;
  parent: FakeNode | null = null;
  private text = '';
  constructor(public tag: string) {}
  get textContent(): string {
    return this.text + this.children.map(c => c.textContent).join('');
  }
  set textContent(value: string) {
    this.text = value;
    this.children = [];
  }
  get firstElementChild() {
    return this.children[0] ?? null;
  }
  setAttribute(k: string, v: string) {
    this.attributes[k] = v;
    if (k === 'class') this.className = v;
  }
  append(...nodes: FakeNode[]) {
    for (const n of nodes) {
      n.parent = this;
      this.children.push(n);
    }
  }
  replaceChildren(...nodes: FakeNode[]) {
    this.children = [];
    this.append(...nodes);
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this);
  }
}
{
  const fake = {
    createElement: (tag: string) => new FakeNode(tag),
    createElementNS: (_ns: string, tag: string) => new FakeNode(tag),
    createTextNode: (text: string) => {
      const n = new FakeNode('#text');
      n.textContent = text;
      return n;
    }
  };
  (globalThis as unknown as {document: unknown}).document = fake;

  const frame = makeFrame(46.7102, 7.7733, 1919);
  const host = new FakeNode('div');
  const furniture = createFurniture(host as unknown as HTMLElement);
  const symbols: SymbolId[] = ['contour-index', 'rock', 'lake', 'trail-hiking', 'station', 'peak'];
  furniture.update({
    pose: {eye: [0, 0, 40000], yaw: 0, pitch: -90, roll: 0, vfov: 8},
    viewport: {w: 1200, h: 800},
    mode: 'plan',
    drawnSymbols: symbols,
    originFrame: frame
  });
  const root = host.children[0];
  const find = (node: FakeNode, cls: string): FakeNode | null => {
    if (node.className.split(' ').includes(cls)) return node;
    for (const c of node.children) {
      const hit = find(c, cls);
      if (hit) return hit;
    }
    return null;
  };
  assert.ok(host.className.includes('landeskarte'));
  assert.equal(find(root, 'lk-cartouche')?.textContent, 'Niederhorn 1 963 m · 7. September 2026');
  assert.equal(
    find(root, 'lk-north-needle')!.attributes.transform,
    'rotate(0.00)',
    'north arrow counter-rotates the yaw'
  );
  assert.ok(find(root, 'lk-imprint')!.textContent.includes('© OpenStreetMap contributors'));
  const items = find(root, 'lk-legend-list')!.children;
  assert.equal(items.length, symbols.length, 'legend lists only the drawn symbols');
  const scaleNode = find(root, 'lk-scale')!;
  const meters = Number(scaleNode.dataset.meters);
  const px = Number(scaleNode.dataset.px);
  const mpp = metersPerPixelAtCentre(
    {eye: [0, 0, 40000], yaw: 0, pitch: -90, roll: 0, vfov: 8},
    800,
    PLAN_REFERENCE_ELEVATION_M - frame.origin.h
  );
  assert.ok(Math.abs(px * mpp - meters) / meters < 0.01);
  const ticks = find(root, 'lk-fur-edge')!.children.length;
  assert.ok(ticks > 10, `edge children ${ticks}`);

  furniture.update({
    pose: {eye: [0, 0, 1.6], yaw: 260.72, pitch: -3.525, roll: -2.413, vfov: 52.11},
    viewport: {w: 1200, h: 900},
    mode: 'panorama',
    drawnSymbols: [...symbols, 'shadow'],
    originFrame: frame
  });
  assert.equal(find(root, 'lk-north-needle')!.attributes.transform, 'rotate(-260.72)');
  assert.equal(find(root, 'lk-scale')!.hidden, true);
  assert.equal(find(root, 'lk-north')!.hidden, true);
  assert.equal(find(root, 'lk-legend-list')!.children.length, symbols.length + 1);
  assert.ok(find(root, 'lk-blatt')!.textContent.includes('Überhöhung 1,0'));

  const station = {
    id: 'demo-01',
    minutes: 808,
    yaw: 260.72,
    exifHeading: 251.43,
    confidence: 0.86
  } as Station;
  const plate = renderWegweiser(station, '15:28') as unknown as FakeNode;
  const text = plate.textContent;
  assert.ok(text.includes('Aufnahme 01') && text.includes('15:28') && text.includes('+9,3'));
  assert.ok(!plate.className.includes('lk-dim'));
  const dim = renderWegweiser({...station, confidence: 0.55}, '16:00') as unknown as FakeNode;
  assert.ok(dim.className.includes('lk-dim'));
  furniture.destroy();
  assert.equal(host.children.length, 0);
  pass(
    'DOM smoke',
    `${ticks} edge elements, legend filtered to drawn symbols, panorama hides scale and north`
  );
}
