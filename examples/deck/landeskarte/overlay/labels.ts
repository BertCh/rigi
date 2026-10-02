// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Peak and lake names after Imhof's rules (Kartographische Geländedarstellung): names rank by
// size and weight, the most important are placed first and keep the best spot, lesser names are
// dropped rather than crowded. In the plan the preferred spot is up and to the right of the
// symbol. In the panorama every name floats above the skyline on a hairline leader, and the
// leaders never cross, so the eye can follow each name down to its summit.
//
// `placeLabels` is pure (no DOM, no GPU) so the rules are checked in Node. `toTextLayers` turns
// the result into deck layers for the screen-space overlay view.

import {type Layer} from '@deck.gl/core';
import {LineLayer, ScatterplotLayer, TextLayer} from '@deck.gl/layers';
import {curvatureDrop, REFRACTION_K} from '../geo/geodesy';
import {NEATLINE_INSET} from '../ui/furniture';
import type {ENU, Frame, LakeLabel, Peak, PeakTier, PlacedLabel, RGB, SceneMode} from '../types';
import {
  ALTITUDE_STYLE,
  COLOR_NAVY,
  COLOR_PAPER,
  estimateTextWidth,
  formatAltitude,
  LABEL_CHARACTER_SET,
  LABEL_FLOOR_PX,
  NAME_TYPO,
  trackText,
  type NameTier,
  type TextStyle
} from './typography';

export type MeasureText = (text: string, sizePx: number, style: TextStyle) => number;

export type PlaceLabelsInput = {
  peaks: Peak[];
  lakes: LakeLabel[];
  /** The frame the camera lives in; features are converted to ENU with it. */
  frame: Frame;
  /** ENU metres to canvas pixels (y down) and depth, or null when behind the camera. */
  project: (enu: ENU) => [number, number, number] | null;
  /** False for features hidden by nearer terrain (ring graph `peakVisible` or `isVisible`). */
  visible: (id: string) => boolean;
  viewport: {width: number; height: number};
  /** Text floor in pixels. Never below the 11 px floor of the style guide. */
  minPx?: number;
  /** 'plan' (default) or 'panorama'. */
  mode?: SceneMode;
  /** Size of a `peak`-tier name before the tier scale, pixels. Default 13. */
  baseSizePx?: number;
  refractionK?: number;
  /**
   * Panorama only: canvas y of the terrain skyline at canvas x (smaller is higher), or null where
   * unknown. A name is only placed where its whole box clears this line.
   */
  skyline?: (x: number) => number | null;
  /** Exact text widths (for example canvas `measureText`). Default is `estimateTextWidth`. */
  measure?: MeasureText;
};

const VIEWPORT_MARGIN = 4;
/**
 * Inset of the label viewport from the canvas edge: the neatline plus a gap, so a name box never
 * touches the neatline or the tick numbers in its margin. The anchor point of a dot may sit
 * closer (VIEWPORT_MARGIN); callers should use this value for their own anchor inset too.
 */
export const LABEL_VIEWPORT_INSET = NEATLINE_INSET + 8;
/** Safety on the estimated text width; a measured width needs less. */
const WIDTH_SAFETY = 1.05;
/** Gap between the symbol and the text in the plan, pixels. */
const SYMBOL_GAP = 5;
const SYMBOL_RADIUS = 3;
const BASE_PAD = 3;
const TIER_RANK: Record<PeakTier, number> = {'peak-major': 0, peak: 1, minor: 2};
const PANORAMA_LIFTS = [14, 26, 38, 52, 68, 86, 106, 128];
const PLAN_LEADER_LIFTS = [18, 32, 48];
const LINE_HEIGHT = 1.12;

type Rect = {x0: number; y0: number; x1: number; y1: number};
type Segment = {ax: number; ay: number; bx: number; by: number};

/** Layout of the two-line block (name over altitude) for a name size. */
export function getLabelBlock(sizePx: number, hasSubtext: boolean) {
  const nameHeight = sizePx * LINE_HEIGHT;
  const subtextSize = Math.max(LABEL_FLOOR_PX, Math.round(sizePx * 0.84 * 2) / 2);
  const subtextHeight = hasSubtext ? subtextSize * LINE_HEIGHT : 0;
  return {nameHeight, subtextSize, subtextHeight, height: nameHeight + subtextHeight};
}

/** Where a leader meets the text block: bottom centre for names above, top centre below. */
export function getLeaderEnd(label: PlacedLabel): [number, number] {
  const {height} = getLabelBlock(label.sizePx, label.subtext !== '');
  const above = label.position[1] < label.anchor[1];
  return [label.position[0], label.position[1] + (above ? height / 2 : -height / 2)];
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

function inflate(rect: Rect, by: number): Rect {
  return {x0: rect.x0 - by, y0: rect.y0 - by, x1: rect.x1 + by, y1: rect.y1 + by};
}

/** Liang-Barsky clip: does the segment touch the rectangle? */
function segmentHitsRect(segment: Segment, rect: Rect): boolean {
  const dx = segment.bx - segment.ax;
  const dy = segment.by - segment.ay;
  const p = [-dx, dx, -dy, dy];
  const q = [
    segment.ax - rect.x0,
    rect.x1 - segment.ax,
    segment.ay - rect.y0,
    rect.y1 - segment.ay
  ];
  let t0 = 0;
  let t1 = 1;
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return false;
    } else {
      const t = q[i] / p[i];
      if (p[i] < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
      if (t0 > t1) return false;
    }
  }
  return true;
}

function orientation(ax: number, ay: number, bx: number, by: number, cx: number, cy: number) {
  const value = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  return value > 1e-9 ? 1 : value < -1e-9 ? -1 : 0;
}

function onSegment(s: Segment, x: number, y: number): boolean {
  return (
    x >= Math.min(s.ax, s.bx) - 1e-9 &&
    x <= Math.max(s.ax, s.bx) + 1e-9 &&
    y >= Math.min(s.ay, s.by) - 1e-9 &&
    y <= Math.max(s.ay, s.by) + 1e-9
  );
}

/** True when the segments share any point, touching included. */
export function segmentsIntersect(s: Segment, t: Segment): boolean {
  const o1 = orientation(s.ax, s.ay, s.bx, s.by, t.ax, t.ay);
  const o2 = orientation(s.ax, s.ay, s.bx, s.by, t.bx, t.by);
  const o3 = orientation(t.ax, t.ay, t.bx, t.by, s.ax, s.ay);
  const o4 = orientation(t.ax, t.ay, t.bx, t.by, s.bx, s.by);
  if (o1 !== o2 && o3 !== o4) return true;
  return (
    (o1 === 0 && onSegment(s, t.ax, t.ay)) ||
    (o2 === 0 && onSegment(s, t.bx, t.by)) ||
    (o3 === 0 && onSegment(t, s.ax, s.ay)) ||
    (o4 === 0 && onSegment(t, s.bx, s.by))
  );
}

type Item = {
  id: string;
  text: string;
  subtext: string;
  tier: NameTier;
  anchor: [number, number];
  sizePx: number;
  width: number;
  height: number;
  pad: number;
  /** Rank for the greedy order: lower goes first. */
  order: [number, number];
};

type Placed = {box: Rect; leader: Segment | null; anchorBox: Rect};

type Candidate = {cx: number; cy: number; leader: Segment | null};

export function placeLabels(input: PlaceLabelsInput): PlacedLabel[] {
  const {viewport, frame} = input;
  const mode = input.mode ?? 'plan';
  const minPx = Math.max(LABEL_FLOOR_PX, input.minPx ?? LABEL_FLOOR_PX);
  const baseSize = input.baseSizePx ?? 13;
  const k = input.refractionK ?? REFRACTION_K;
  const measure = input.measure ?? estimateTextWidth;
  const exact = input.measure !== undefined;

  // The world is curved: up = elevation - (1 - k) d^2 / 2R, the same convention as the terrain.
  const projectGeo = (lat: number, lon: number, ele: number) => {
    const enu = frame.toEnu(lat, lon, ele);
    enu[2] -= curvatureDrop(Math.hypot(enu[0], enu[1]), k);
    return input.project(enu);
  };
  const inside = (x: number, y: number) =>
    x >= VIEWPORT_MARGIN &&
    x <= viewport.width - VIEWPORT_MARGIN &&
    y >= VIEWPORT_MARGIN &&
    y <= viewport.height - VIEWPORT_MARGIN;

  const makeItem = (
    id: string,
    name: string,
    ele: number,
    tier: NameTier,
    anchor: [number, number],
    order: [number, number]
  ): Item => {
    const style = NAME_TYPO[tier];
    const sizePx = Math.max(minPx, Math.round(baseSize * style.scale * 2) / 2);
    const block = getLabelBlock(sizePx, true);
    const nameStyle = {weight: style.weight, italic: style.italic, trackingEm: style.trackingEm};
    const display = tier === 'lake' ? trackText(name) : name;
    const subtext = formatAltitude(ele);
    const safety = exact ? 1 : WIDTH_SAFETY;
    const nameWidth = measure(display, sizePx, {...nameStyle, trackingEm: 0}) * safety;
    // The altitude is set in the mono face (0.6 em digits), a little wider than the sans estimate.
    const subtextWidth =
      measure(subtext, block.subtextSize, {weight: 400, italic: false, trackingEm: 0}) *
      safety *
      (exact ? 1 : 1.08);
    return {
      id,
      text: name,
      subtext,
      tier,
      anchor,
      sizePx,
      width: Math.max(nameWidth, subtextWidth),
      height: block.height,
      pad: BASE_PAD * style.padScale,
      order
    };
  };

  const items: Item[] = [];
  // Areas first (lakes), then points by rank. Greedy placement keeps the earlier ones.
  for (const lake of input.lakes) {
    if (!input.visible(lake.id)) continue;
    const projected = projectGeo(lake.lat, lake.lon, lake.ele);
    if (!projected || !inside(projected[0], projected[1])) continue;
    items.push(
      makeItem(lake.id, lake.name, lake.ele, 'lake', [projected[0], projected[1]], [-1, 0])
    );
  }
  for (const peak of input.peaks) {
    if (!input.visible(peak.id)) continue;
    const projected = projectGeo(peak.lat, peak.lon, peak.ele);
    if (!projected || !inside(projected[0], projected[1])) continue;
    items.push(
      makeItem(
        peak.id,
        peak.name,
        peak.ele,
        peak.tier,
        [projected[0], projected[1]],
        [TIER_RANK[peak.tier], -peak.ele]
      )
    );
  }
  items.sort(
    (a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1] || (a.id < b.id ? -1 : 1)
  );

  const placedList: Placed[] = [];
  const result: PlacedLabel[] = [];

  const accepts = (item: Item, candidate: Candidate, box: Rect): boolean => {
    if (
      box.x0 < LABEL_VIEWPORT_INSET ||
      box.x1 > viewport.width - LABEL_VIEWPORT_INSET ||
      box.y0 < LABEL_VIEWPORT_INSET ||
      box.y1 > viewport.height - LABEL_VIEWPORT_INSET
    ) {
      return false;
    }
    if (mode === 'panorama' && item.tier !== 'lake' && input.skyline) {
      // The name must sit above the ridge line across its whole width, not only at the summit.
      for (let x = box.x0; x <= box.x1 + 4; x += 4) {
        const line = input.skyline(Math.min(x, box.x1));
        if (line !== null && box.y1 > line - 2) return false;
      }
    }
    const padded = inflate(box, item.pad);
    const anchorBox = inflate(
      {x0: item.anchor[0], y0: item.anchor[1], x1: item.anchor[0], y1: item.anchor[1]},
      SYMBOL_RADIUS
    );
    if (item.tier !== 'lake' && candidate.leader === null && overlaps(anchorBox, box)) {
      // The symbol of this name must not sit under its own text.
      return false;
    }
    for (const other of placedList) {
      if (overlaps(padded, other.box) || overlaps(box, other.anchorBox)) return false;
      if (overlaps(anchorBox, other.box)) return false;
      if (candidate.leader) {
        if (segmentHitsRect(candidate.leader, inflate(other.box, 1))) return false;
        if (segmentHitsRect(candidate.leader, other.anchorBox)) return false;
        if (other.leader && segmentsIntersect(candidate.leader, other.leader)) return false;
      }
      if (other.leader && segmentHitsRect(other.leader, inflate(box, 1))) return false;
    }
    return true;
  };

  const makeCandidates = (item: Item): Candidate[] => {
    const [ax, ay] = item.anchor;
    const w = item.width;
    const h = item.height;
    const candidates: Candidate[] = [];
    const beside = (cx: number, cy: number) => candidates.push({cx, cy, leader: null});
    const lifted = (dx: number, lift: number, above: boolean) => {
      const cx = ax + dx;
      const edge = above ? ay - lift : ay + lift;
      const cy = above ? edge - h / 2 : edge + h / 2;
      candidates.push({cx, cy, leader: {ax, ay, bx: cx, by: edge}});
    };

    if (item.tier === 'lake') {
      // A lake name sits on the water, centred, nudged sideways when something is in the way.
      for (const dx of [0, 0.3, -0.3, 0.6, -0.6]) beside(ax + dx * w, ay);
      return candidates;
    }
    if (mode === 'plan') {
      const g = SYMBOL_GAP;
      // Imhof: up and to the right first, then the other sides in decreasing preference.
      beside(ax + g + w / 2, ay - 2 - h / 2); // NE
      beside(ax + g + w / 2, ay); // E
      beside(ax, ay - g - h / 2); // N
      beside(ax + g + w / 2, ay + 2 + h / 2); // SE
      beside(ax - g - w / 2, ay - 2 - h / 2); // NW
      beside(ax - g - w / 2, ay); // W
      beside(ax, ay + g + h / 2); // S
      beside(ax - g - w / 2, ay + 2 + h / 2); // SW
      for (const lift of PLAN_LEADER_LIFTS) {
        for (const dx of [0, 0.55 * w, -0.55 * w]) lifted(dx, lift, true);
      }
      for (const lift of PLAN_LEADER_LIFTS) {
        for (const dx of [0, 0.55 * w, -0.55 * w]) lifted(dx, lift, false);
      }
      return candidates;
    }
    // Panorama: above the summit only. Shortest leader first; sideways shifts cost half a lift.
    const rows: {cost: number; dx: number; lift: number}[] = [];
    for (const lift of PANORAMA_LIFTS) {
      for (const shift of [0, 0.25, -0.25, 0.5, -0.5, 0.75, -0.75, 1, -1]) {
        rows.push({cost: lift + Math.abs(shift) * w * 0.5, dx: shift * w, lift});
      }
    }
    rows.sort((a, b) => a.cost - b.cost);
    for (const row of rows) lifted(row.dx, row.lift, true);
    return candidates;
  };

  for (const item of items) {
    for (const candidate of makeCandidates(item)) {
      const box = {
        x0: candidate.cx - item.width / 2,
        y0: candidate.cy - item.height / 2,
        x1: candidate.cx + item.width / 2,
        y1: candidate.cy + item.height / 2
      };
      if (!accepts(item, candidate, box)) continue;
      placedList.push({
        box,
        leader: candidate.leader,
        anchorBox: inflate(
          {x0: item.anchor[0], y0: item.anchor[1], x1: item.anchor[0], y1: item.anchor[1]},
          SYMBOL_RADIUS
        )
      });
      result.push({
        id: item.id,
        text: item.text,
        subtext: item.subtext,
        tier: item.tier,
        anchor: item.anchor,
        position: [candidate.cx, candidate.cy],
        leader: candidate.leader !== null,
        sizePx: item.sizePx
      });
      break;
    }
  }

  if (mode === 'panorama') {
    // Azimuth order, west to east on screen: the order the leaders fan out in. Because no two
    // leaders cross, names in a row appear in the same order as their summits.
    result.sort((a, b) => a.anchor[0] - b.anchor[0] || (a.id < b.id ? -1 : 1));
  }
  return result;
}

/** Reveal order of the load animation: areas, then lines (leaders), then points by rank. */
export function getRevealOpacity(kind: NameTier | 'leader' | 'altitude', progress: number): number {
  const windows: Record<string, [number, number]> = {
    lake: [0, 0.4],
    'peak-major': [0.25, 0.55],
    leader: [0.4, 0.7],
    peak: [0.45, 0.75],
    altitude: [0.45, 0.75],
    minor: [0.6, 0.9]
  };
  const [from, to] = windows[kind];
  const t = Math.min(1, Math.max(0, (progress - from) / (to - from)));
  return t * t * (3 - 2 * t);
}

export type TextLayerOptions = {
  /** Reveal progress 0..1 (1 = fully drawn). */
  reveal?: number;
};

// Overlay drawing ignores depth: the screen view has no depth buffer worth testing against.
const ON_TOP = {depthCompare: 'always', depthWriteEnabled: false} as const;

// deck divides `outlineWidth` by the SDF radius (12 by default) and places the outline edge at
// buffer * (1 - that), so 6 gives an edge at 0.375 against 0.75 for the glyph: 0.375 * 12 = 4.5 of
// the 64 px atlas em, a halo about 0.07 em (about 1 px at 13 px) wide. Unverified in a browser.
const HALO_TEXELS = 6;
const SDF_SETTINGS = {sdf: true} as const;

function color(rgb: RGB, alpha = 255): [number, number, number, number] {
  return [rgb[0], rgb[1], rgb[2], alpha];
}

/**
 * Deck layers for `placed`, all ids prefixed `screen-` so the overlay view's `layerFilter` keeps
 * them out of the perspective view. One TextLayer per tier because font weight and family are
 * layer props.
 */
export function toTextLayers(
  placed: PlacedLabel[],
  mode: SceneMode,
  options: TextLayerOptions = {}
): Layer[] {
  const reveal = options.reveal ?? 1;
  const layers: Layer[] = [];
  const withLeader = placed.filter(label => label.leader);

  layers.push(
    new LineLayer<PlacedLabel>({
      id: 'screen-labels-leaders',
      data: withLeader,
      opacity: getRevealOpacity('leader', reveal),
      getSourcePosition: label => label.anchor,
      getTargetPosition: label => getLeaderEnd(label),
      getColor: color(COLOR_NAVY, 235),
      getWidth: 0.6,
      widthUnits: 'pixels',
      parameters: ON_TOP
    })
  );

  // Plan: a round dot marks every named summit. Panorama: a small end dot where a leader lands.
  const dotted = mode === 'plan' ? placed.filter(label => label.tier !== 'lake') : withLeader;
  layers.push(
    new ScatterplotLayer<PlacedLabel>({
      id: 'screen-labels-dots',
      data: dotted,
      opacity: getRevealOpacity('peak', reveal),
      getPosition: label => label.anchor,
      getRadius: mode === 'plan' ? 2.4 : 1.5,
      radiusUnits: 'pixels',
      getFillColor: color(COLOR_NAVY),
      stroked: true,
      getLineColor: color(COLOR_PAPER),
      getLineWidth: 0.8,
      lineWidthUnits: 'pixels',
      parameters: ON_TOP
    })
  );

  const tiers: NameTier[] = ['lake', 'minor', 'peak', 'peak-major'];
  for (const tier of tiers) {
    const style = NAME_TYPO[tier];
    layers.push(
      new TextLayer<PlacedLabel>({
        id: `screen-labels-${tier === 'peak-major' ? 'major' : tier}`,
        data: placed.filter(label => label.tier === tier),
        opacity: getRevealOpacity(tier, reveal),
        characterSet: LABEL_CHARACTER_SET,
        fontFamily: style.family,
        // deck builds the canvas font as `${fontWeight} ${size}px ${family}`: it has no style
        // prop, so the italic of the lake serif rides in with the weight.
        fontWeight: style.italic ? `italic ${style.weight}` : style.weight,
        fontSettings: SDF_SETTINGS,
        // Lake names sit on flat water, there is nothing to separate them from.
        outlineWidth: tier === 'lake' ? 0 : HALO_TEXELS,
        outlineColor: color(COLOR_PAPER),
        lineHeight: 1,
        sizeUnits: 'pixels',
        getPosition: label => {
          const block = getLabelBlock(label.sizePx, label.subtext !== '');
          return [label.position[0], label.position[1] - block.height / 2 + block.nameHeight / 2];
        },
        getText: label => (tier === 'lake' ? trackText(label.text) : label.text),
        getSize: label => label.sizePx,
        getColor: color(style.color),
        getTextAnchor: 'middle',
        getAlignmentBaseline: 'center',
        parameters: ON_TOP
      })
    );
  }

  layers.push(
    new TextLayer<PlacedLabel>({
      id: 'screen-labels-altitude',
      data: placed.filter(label => label.subtext !== ''),
      opacity: getRevealOpacity('altitude', reveal),
      characterSet: LABEL_CHARACTER_SET,
      fontFamily: ALTITUDE_STYLE.family,
      fontWeight: ALTITUDE_STYLE.weight,
      fontSettings: SDF_SETTINGS,
      outlineWidth: HALO_TEXELS,
      outlineColor: color(COLOR_PAPER),
      lineHeight: 1,
      sizeUnits: 'pixels',
      getPosition: label => {
        const block = getLabelBlock(label.sizePx, true);
        return [
          label.position[0],
          label.position[1] - block.height / 2 + block.nameHeight + block.subtextHeight / 2
        ];
      },
      getText: label => label.subtext,
      getSize: label => getLabelBlock(label.sizePx, true).subtextSize,
      getColor: color(ALTITUDE_STYLE.color),
      getTextAnchor: 'middle',
      getAlignmentBaseline: 'center',
      parameters: ON_TOP
    })
  );
  return layers;
}
