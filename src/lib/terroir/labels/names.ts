// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Pure helpers for the terroir name labels (NamesSvg): reach filter, dedupe against the engine's
// peak labels, typography, ranking, uncertainty softening and the greedy rectangle declutter.
// No DOM, no React: run by labels.check.ts in node.
import { NAME_TYPO, type NameTypography } from "../classes";
import type { NameClass, TerroirName } from "../types";

export type Rect = { x0: number; y0: number; x1: number; y1: number };

export const rectsHit = (a: Rect, b: Rect, pad = 0) =>
	a.x0 < b.x1 + pad &&
	b.x0 < a.x1 + pad &&
	a.y0 < b.y1 + pad &&
	b.y0 < a.y1 + pad;

export const PEAK_CLASSES: ReadonlySet<NameClass> = new Set([
	"peak-major",
	"peak",
	"peak-minor",
]);

/** Under reach 'near' a class shows only inside its nearReachM; 'all' ignores it. */
export function reachOk(cls: NameClass, distM: number, reach: "near" | "all") {
	if (reach === "all") return true;
	return (
		distM <= Math.min(NAME_TYPO[cls].nearReachM, NEAR_CAP_M[cls] ?? Infinity)
	);
}

/** Tighter limits under reach 'near' (calm middle distance): the class table's reach is the ceiling. */
const NEAR_CAP_M: Partial<Record<NameClass, number>> = {
	ridge: 8000,
	region: 8000,
	alp: 4000,
	field: 4000,
	hamlet: 4000,
	village: 15000,
};

/** At most this many spaced-caps labels per view, and of them this many massifs (any distance). */
export const CAPS_MAX = 3;
export const MASSIF_MAX = 2;

const norm = (s: string) =>
	s
		.toLowerCase()
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/[^a-z0-9]+/g, " ")
		.trim();

/** ENU (east, north) distance in metres, ignoring height. */
const enuDist = (a: [number, number, number], b: ArrayLike<number>) =>
	Math.hypot(a[0] - b[0], a[1] - b[1]);

/**
 * True when a pack peak is already owned by an engine peak label: the same name within `sameNameM`
 * (default 2 km, spelling differs less than position), or any engine peak within `nearM` (~300 m).
 * `enu` is the pack name's position in the engine frame, `peaks[i].world` the engine peaks'.
 */
export function dupOfPeak(
	name: string,
	enu: ArrayLike<number>,
	peaks: { name: string; world: [number, number, number] }[],
	nearM = 300,
	sameNameM = 2000,
) {
	const n = norm(name);
	for (const p of peaks) {
		const d = enuDist(p.world, enu);
		if (d <= nearM) return true;
		if (d <= sameNameM && norm(p.name) === n) return true;
	}
	return false;
}

export type NameType = {
	px: number;
	weight: number;
	italic: boolean;
	/** letter-spacing, px */
	trackPx: number;
	upper: boolean;
	color: string;
	priority: number;
};

/** The class's typography at a base label size (style.labels.name.px). */
export function nameType(cls: NameClass, basePx: number): NameType {
	const t: NameTypography = NAME_TYPO[cls] ?? NAME_TYPO.other;
	return {
		px: basePx * t.size,
		weight: t.weight,
		italic: t.italic,
		trackPx: t.tracking * basePx * t.size,
		upper: t.upper,
		color: t.color,
		priority: t.priority,
	};
}

export const displayText = (text: string, t: Pick<NameType, "upper">) =>
	t.upper ? text.toLocaleUpperCase() : text;

export const fontString = (t: NameType, family: string, scale = 1) =>
	`${t.italic ? "italic " : ""}${t.weight} ${(t.px * scale).toFixed(2)}px ${family}`;

/** Text width including letter-spacing (CSS adds it after every glyph). */
export function textWidth(
	text: string,
	t: NameType,
	family: string,
	measure: (text: string, font: string) => number,
	scale = 1,
) {
	const s = displayText(text, t);
	return (
		measure(s, fontString(t, family, scale)) + t.trackPx * scale * [...s].length
	);
}

/** Placement score: class priority, size of the feature and nearness; hysteresis bonus for last frame's winners. */
export function nameScore(
	n: Pick<TerroirName, "cls" | "areaKm2">,
	distKm: number,
	centre: number,
	kept: boolean,
) {
	const t = NAME_TYPO[n.cls] ?? NAME_TYPO.other;
	return (
		t.priority +
		Math.log1p(n.areaKm2 ?? 0) * 3 -
		Math.min(distKm, 80) * 0.35 +
		centre * 4 +
		(kept ? 40 : 0)
	);
}

/** Range fade like the peak labels (peaks fade beyond 25 km). */
export function rangeOpacity(distKm: number) {
	const far = Math.min(1, Math.max(0, (distKm - 25) / 95));
	return Math.round((1 - 0.4 * far * far * (3 - 2 * far)) * 100) / 100;
}

/** Opacity of a label while the pose is a guess: 0.75 near, falling to 0.40 from 5 km out to 45 km. */
export function uncertainOpacity(distKm: number) {
	const k = Math.min(1, Math.max(0, (distKm - 5) / 40));
	return Math.round((0.75 - 0.35 * k) * 100) / 100;
}

/** A far peak name carries a "≈" while the pose is a guess. */
export const UNCERTAIN_FAR_KM = 20;
export const uncertainPrefix = (distKm: number) =>
	distKm > UNCERTAIN_FAR_KM ? "≈ " : "";

export type Placement = { rect: Rect; id: string };

export type DeclutterItem<T = unknown> = {
	id: string;
	score: number;
	/** alternative boxes in preference order (the first that fits wins) */
	rects: Rect[];
	data: T;
	/** limit groups this item counts against (see declutterNames `limits`) */
	tags?: string[];
	/** extra vertical clearance (px) kept from the obstacles, on top of `pad` */
	obsPadY?: number;
};

/** Greedy by score: each item takes its first alternative that is inside the stage and clear of everything placed. */
export function declutterNames<T>(
	items: DeclutterItem<T>[],
	obstacles: Rect[],
	o: {
		width: number;
		height: number;
		max: number;
		pad?: number;
		edge?: number;
		/** max placed items per tag */
		limits?: Record<string, number>;
	},
): { item: DeclutterItem<T>; rect: Rect; alt: number }[] {
	const pad = o.pad ?? 3;
	const edge = o.edge ?? 2;
	const sorted = [...items].sort((a, b) => b.score - a.score);
	const taken: Rect[] = [];
	const out: { item: DeclutterItem<T>; rect: Rect; alt: number }[] = [];
	const used: Record<string, number> = {};
	for (const it of sorted) {
		if (out.length >= o.max) break;
		if (
			it.tags?.some(
				(t) =>
					o.limits?.[t] != null && (used[t] ?? 0) >= (o.limits[t] as number),
			)
		)
			continue;
		for (let k = 0; k < it.rects.length; k++) {
			const r = it.rects[k];
			if (
				r.x0 < edge ||
				r.y0 < edge ||
				r.x1 > o.width - edge ||
				r.y1 > o.height - edge
			)
				continue;
			if (obstacles.some((b) => rectsHit(r, b, pad))) continue;
			if (taken.some((b) => rectsHit(r, b, pad))) continue;
			taken.push(r);
			out.push({ item: it, rect: r, alt: k });
			break;
		}
	}
	return out;
}

/** Bounding box of points. */
export function bounds(pts: { x: number; y: number }[]): Rect {
	let x0 = Number.POSITIVE_INFINITY;
	let y0 = x0;
	let x1 = Number.NEGATIVE_INFINITY;
	let y1 = x1;
	for (const p of pts) {
		x0 = Math.min(x0, p.x);
		y0 = Math.min(y0, p.y);
		x1 = Math.max(x1, p.x);
		y1 = Math.max(y1, p.y);
	}
	return { x0, y0, x1, y1 };
}

export const padRect = (r: Rect, p: number): Rect => ({
	x0: r.x0 - p,
	y0: r.y0 - p,
	x1: r.x1 + p,
	y1: r.y1 + p,
});

type Pt = { x: number; y: number };

/**
 * A sub-polyline of arc length `len` centred on the middle of `pts`, or null when the path is shorter
 * than `minLen`, turns more than `maxTurnDeg` in total over the span, or runs right-to-left (text
 * would be upside down: it is reversed instead). Result always runs left to right.
 */
export function textPath(
	pts: Pt[],
	len: number,
	minLen = 60,
	maxTurnDeg = 75,
): Pt[] | null {
	if (pts.length < 2) return null;
	let p = pts;
	if (p[p.length - 1].x < p[0].x) p = [...p].reverse();
	const seg: number[] = [];
	let total = 0;
	for (let i = 1; i < p.length; i++) {
		const d = Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
		seg.push(d);
		total += d;
	}
	if (total < minLen) return null;
	const want = Math.min(total, len);
	const s0 = (total - want) / 2;
	const s1 = s0 + want;
	const at = (s: number): Pt => {
		let acc = 0;
		for (let i = 0; i < seg.length; i++) {
			if (acc + seg[i] >= s || i === seg.length - 1) {
				const t = seg[i] > 0 ? Math.min(1, Math.max(0, (s - acc) / seg[i])) : 0;
				return {
					x: p[i].x + (p[i + 1].x - p[i].x) * t,
					y: p[i].y + (p[i + 1].y - p[i].y) * t,
				};
			}
			acc += seg[i];
		}
		return p[p.length - 1];
	};
	const out: Pt[] = [at(s0)];
	let acc = 0;
	for (let i = 0; i < seg.length; i++) {
		acc += seg[i];
		if (acc > s0 && acc < s1) out.push(p[i + 1]);
	}
	out.push(at(s1));
	// total turning
	let turn = 0;
	for (let i = 2; i < out.length; i++) {
		const a = Math.atan2(
			out[i - 1].y - out[i - 2].y,
			out[i - 1].x - out[i - 2].x,
		);
		const b = Math.atan2(out[i].y - out[i - 1].y, out[i].x - out[i - 1].x);
		let d = Math.abs(b - a);
		if (d > Math.PI) d = 2 * Math.PI - d;
		turn += d;
	}
	if ((turn * 180) / Math.PI > maxTurnDeg) return null;
	return out;
}
