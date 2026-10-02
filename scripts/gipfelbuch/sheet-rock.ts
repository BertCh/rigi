// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Rock mask, rock hachures and scree for the sheet (design book D5, R7, R8, L1). Offline CPU bake, seeded, deterministic.
 * Masks come from slope and elevation only (no land-cover dataset). Hachures and dots are written as integer paths in
 * quarter sheet units (the renderer wraps them in scale(0.25)) and merged into a handful of <path> strings.
 */
import type { TerrainFields } from "./sheet-relief";
import {
	blurGrid,
	hashString,
	labelComponents,
	makeRng,
	smoothstep,
} from "./sheet-util";

export const ROCK_SLOPE = 37; // degrees
export const ROCK_ELEV = 1450; // metres
const SCREE_SLOPE_MIN = 24;
const SCREE_ELEV = 1250;
const Q = 4; // quarter-unit quantisation

/** Unit vector (east, south) pointing to the light (NW), in grid axes. */
const LIGHT = [-Math.SQRT1_2, -Math.SQRT1_2];

export interface RockMask {
	rock: Uint8Array;
	scree: Uint8Array;
}

export function buildRockMask(
	t: TerrainFields,
	w: number,
	h: number,
	cellMetres: number,
): RockMask {
	const n = w * h;
	// slope from a slightly rougher DEM than the shading uses, so crags still read
	const raw = new Uint8Array(n);
	for (let i = 0; i < n; i++)
		raw[i] = t.slopeDeg[i] > ROCK_SLOPE && t.z[i] > ROCK_ELEV ? 1 : 0;
	// majority filter: slope noise opens pinholes and speckle
	const soft = blurGrid(Float32Array.from(raw), w, h, 1.6);
	const rock = new Uint8Array(n);
	for (let i = 0; i < n; i++) rock[i] = soft[i] > 0.5 ? 1 : 0;
	const { labels, areas } = labelComponents(rock, w, h);
	const minCells = Math.round(26000 / (cellMetres * cellMetres)); // about 2.6 ha
	for (let i = 0; i < n; i++)
		if (rock[i] && areas[labels[i]] < minCells) rock[i] = 0;

	// scree: moderately steep ground, high, below rock (rock found within about 450 m uphill)
	const reach = Math.round(450 / cellMetres);
	const scree = new Uint8Array(n);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const i = y * w + x;
			if (rock[i] || t.z[i] < SCREE_ELEV) continue;
			const s = t.slopeDeg[i];
			if (s < SCREE_SLOPE_MIN || s > ROCK_SLOPE + 4) continue;
			let below = false;
			for (let k = 3; k <= reach && !below; k += 3) {
				const px = Math.round(x - t.downX[i] * k);
				const py = Math.round(y - t.downY[i] * k);
				if (px >= 0 && py >= 0 && px < w && py < h && rock[py * w + px])
					below = true;
			}
			if (below) scree[i] = 1;
		}
	const { labels: sl, areas: sa } = labelComponents(scree, w, h);
	for (let i = 0; i < n; i++)
		if (scree[i] && sa[sl[i]] < minCells / 2) scree[i] = 0;
	return { rock, scree };
}

/** Occupancy raster (1 sheet unit cells) so strokes and dots never touch or cross. */
class Occupancy {
	private readonly cells: Uint8Array;
	constructor(
		private readonly width: number,
		private readonly height: number,
	) {
		this.cells = new Uint8Array(width * height);
	}
	free(x: number, y: number, clearance: number) {
		const c = Math.ceil(clearance);
		const cx = Math.round(x);
		const cy = Math.round(y);
		for (let j = -c; j <= c; j++)
			for (let i = -c; i <= c; i++) {
				if (i * i + j * j > clearance * clearance) continue;
				const px = cx + i;
				const py = cy + j;
				if (px < 0 || py < 0 || px >= this.width || py >= this.height)
					return false;
				if (this.cells[py * this.width + px]) return false;
			}
		return true;
	}
	mark(x: number, y: number, radius: number) {
		const c = Math.ceil(radius);
		const cx = Math.round(x);
		const cy = Math.round(y);
		for (let j = -c; j <= c; j++)
			for (let i = -c; i <= c; i++) {
				if (i * i + j * j > radius * radius) continue;
				const px = cx + i;
				const py = cy + j;
				if (px >= 0 && py >= 0 && px < this.width && py < this.height)
					this.cells[py * this.width + px] = 1;
			}
	}
}

export interface RockLayers {
	/** Hachure path strings by tone tier 0 (lit, thin, sparse) to 3 (shaded, thick, dense); quarter units. */
	hachures: string[];
	/** Scree dot paths by tier 0 to 2; quarter units. */
	scree: string[];
	counts: { hachures: number; dots: number };
}

const q = (v: number) => Math.round(v * Q);

/** Relative integer path for a polyline already in quarter units. */
function relPath(points: [number, number][], close: boolean) {
	let d = `M${points[0][0]} ${points[0][1]}l`;
	const parts: string[] = [];
	for (let i = 1; i < points.length; i++)
		parts.push(
			`${points[i][0] - points[i - 1][0]} ${points[i][1] - points[i - 1][1]}`,
		);
	d += parts.join(" ").replace(/ -/g, "-");
	return close ? `${d}z` : d;
}

export function buildRockLayers(
	mask: RockMask,
	t: TerrainFields,
	w: number,
	h: number,
	sheetW: number,
	sheetH: number,
	/** Sheet units per grid cell. */
	cellSheet: number,
	/** Keep-out test in sheet units (lake, frame). */
	blocked: (x: number, y: number) => boolean,
): RockLayers {
	const occ = new Occupancy(Math.ceil(sheetW), Math.ceil(sheetH));
	const sample = (a: Float32Array, x: number, y: number) =>
		a[
			Math.min(h - 1, Math.max(0, Math.round(y / cellSheet))) * w +
				Math.min(w - 1, Math.max(0, Math.round(x / cellSheet)))
		];
	const inMask = (m: Uint8Array, x: number, y: number) =>
		m[
			Math.min(h - 1, Math.max(0, Math.floor(y / cellSheet))) * w +
				Math.min(w - 1, Math.max(0, Math.floor(x / cellSheet)))
		] === 1;
	const hachures: string[] = ["", "", "", ""];
	const scree: string[] = ["", "", ""];
	let nHach = 0;
	let nDots = 0;

	// ----- R7 rock hachures: streamlines down the slope, LK ratios (width 1:2.6, density about 9:4.5 shade:lit)
	const rng = makeRng(hashString("gipfelbuch-rock-hachures"));
	const STEP = 2.2;
	const candidates: [number, number][] = [];
	for (let y = 2; y < sheetH; y += 2.4)
		for (let x = 2; x < sheetW; x += 2.4)
			if (inMask(mask.rock, x, y))
				candidates.push([x + (rng() - 0.5) * 2.2, y + (rng() - 0.5) * 2.2]);
	// seeded Fisher-Yates so placement order is blue-noise-ish but repeatable
	for (let i = candidates.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[candidates[i], candidates[j]] = [candidates[j], candidates[i]];
	}
	const clearance = [4.4, 3.6, 2.9, 2.3]; // lit sparse .. shaded dense
	for (const [sx, sy] of candidates) {
		if (blocked(sx, sy)) continue;
		const dxs = sample(t.downX, sx, sy);
		const dys = sample(t.downY, sx, sy);
		const lit = dxs * LIGHT[0] + dys * LIGHT[1]; // +1 faces the light
		const tier = lit > 0.5 ? 0 : lit > 0.0 ? 1 : lit > -0.5 ? 2 : 3;
		const slope = sample(t.slopeDeg, sx, sy);
		const length = 5.5 + 7 * smoothstep(34, 62, slope) + rng() * 2.5;
		const pts: [number, number][] = [[sx, sy]];
		let x = sx;
		let y = sy;
		let ok = occ.free(x, y, clearance[tier]);
		for (let s = 0; ok && s * STEP < length; s++) {
			const ux = sample(t.downX, x, y);
			const uy = sample(t.downY, x, y);
			x += ux * STEP;
			y += uy * STEP;
			if (!inMask(mask.rock, x, y) || blocked(x, y)) break;
			if (!occ.free(x, y, clearance[tier])) {
				ok = pts.length > 2;
				break;
			}
			pts.push([x, y]);
		}
		if (!ok || pts.length < 3) continue;
		for (const [px, py] of pts) occ.mark(px, py, clearance[tier] * 0.55);
		hachures[tier] += relPath(
			pts.map(([px, py]) => [q(px), q(py)] as [number, number]),
			false,
		);
		nHach++;
	}

	// ----- R8 scree: irregular 4 to 8 gons, size and density follow the light, a little larger downslope
	const rng2 = makeRng(hashString("gipfelbuch-scree"));
	const dots: [number, number][] = [];
	for (let y = 2; y < sheetH; y += 2.6)
		for (let x = 2; x < sheetW; x += 2.6)
			if (inMask(mask.scree, x, y))
				dots.push([x + (rng2() - 0.5) * 2.4, y + (rng2() - 0.5) * 2.4]);
	for (let i = dots.length - 1; i > 0; i--) {
		const j = Math.floor(rng2() * (i + 1));
		[dots[i], dots[j]] = [dots[j], dots[i]];
	}
	const dotClear = [4.6, 3.4, 2.6];
	for (const [sx, sy] of dots) {
		if (blocked(sx, sy)) continue;
		const lit =
			sample(t.downX, sx, sy) * LIGHT[0] + sample(t.downY, sx, sy) * LIGHT[1];
		const tier = lit > 0.35 ? 0 : lit > -0.25 ? 1 : 2;
		if (!occ.free(sx, sy, dotClear[tier])) continue;
		// density follows the slope too: fade out at the edges of the scree band
		const s = sample(t.slopeDeg, sx, sy);
		if (rng2() > 0.35 + 0.65 * smoothstep(SCREE_SLOPE_MIN, 32, s)) continue;
		const base = [0.55, 0.85, 1.25][tier] * (1 + 0.35 * rng2());
		const sides = 4 + Math.floor(rng2() * 5);
		const a0 = rng2() * Math.PI * 2;
		const ring: [number, number][] = [];
		for (let k = 0; k < sides; k++) {
			const a = a0 + (k / sides) * Math.PI * 2;
			const r = base * (0.7 + 0.6 * rng2());
			ring.push([q(sx + Math.cos(a) * r), q(sy + Math.sin(a) * r)]);
		}
		occ.mark(sx, sy, dotClear[tier] * 0.5);
		scree[tier] += relPath(ring, true);
		nDots++;
	}
	return { hachures, scree, counts: { hachures: nHach, dots: nDots } };
}
