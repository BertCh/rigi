// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Canvas drawing for the viewpoint terrain behind the panorama strip's photos: depth-faded ridgelines
// (the homepage panorama's look) plus a faint ground fill under the skyline, and peak labels that the
// overlay draws above the photos. Strokes are prebuilt as Path2D in degree space and drawn through the
// view transform, so panning and zooming only re-stroke.
import { wrapOffsets } from "./panorama";
import type { RidgePeak, ViewpointTerrain } from "./ridgelines";

type View = { az0: number; elc: number; ppd: number };

/** Depth buckets per class: few stroke() calls per frame. */
const BUCKETS = 8;
const PAPER = "236,230,218";
/** Viewpoint photos can sit 250 m apart, so near ground moves with the photographer: the match cue
 * is full strength beyond MATCH_FULL_D and fades out towards MATCH_MIN_D (closer ridges are skipped). */
const MATCH_FULL_D = 500;
const MATCH_MIN_D = 250;

export type PreparedTerrain = {
	terrain: ViewpointTerrain;
	/** [ridge][bucket] */
	paths: Path2D[][];
	ground: Path2D;
	/** Ridges beyond MATCH_FULL_D, by bucket: the part of the view a pose must get right (near ground is parallax). */
	far: Path2D[];
	/** Ridges between MATCH_MIN_D and MATCH_FULL_D, one path per slab, with the cue's strength (0..1). */
	mid: { path: Path2D; weight: number }[];
	/** Peaks ranked for labelling, best first. */
	peaks: RidgePeak[];
};

export function prepareTerrain(t: ViewpointTerrain): PreparedTerrain {
	const paths = [0, 1].map(() =>
		Array.from({ length: BUCKETS }, () => new Path2D()),
	);
	const far = Array.from({ length: BUCKETS }, () => new Path2D());
	const midBySlab = new Map<number, { path: Path2D; weight: number }>();
	const n = t.slab.length;
	for (let i = 0; i < n; i++) {
		const b = Math.min(
			BUCKETS - 1,
			Math.floor((t.slab[i] / Math.max(1, t.slabs - 1)) * BUCKETS),
		);
		const p = paths[t.ridge[i]][b];
		for (let k = t.start[i]; k < t.start[i + 1]; k++)
			if (k === t.start[i]) p.moveTo(t.pts[k * 2], t.pts[k * 2 + 1]);
			else p.lineTo(t.pts[k * 2], t.pts[k * 2 + 1]);
	}
	// the match cue: ridges seen past the viewpoint's own ground (a separate trace, ridgelines.ts)
	for (let i = 0; i < t.cueSlab.length; i++) {
		const b = Math.min(
			BUCKETS - 1,
			Math.floor((t.cueSlab[i] / Math.max(1, t.slabs - 1)) * BUCKETS),
		);
		const near = t.dMin * (t.dMax / t.dMin) ** (t.cueSlab[i] / t.slabs);
		let p: Path2D;
		if (near >= MATCH_FULL_D) p = far[b];
		else if (near >= MATCH_MIN_D) {
			let m = midBySlab.get(t.cueSlab[i]);
			if (!m) {
				const f =
					Math.log(near / MATCH_MIN_D) / Math.log(MATCH_FULL_D / MATCH_MIN_D);
				m = { path: new Path2D(), weight: 0.35 + 0.65 * f };
				midBySlab.set(t.cueSlab[i], m);
			}
			p = m.path;
		} else continue;
		for (let k = t.cueStart[i]; k < t.cueStart[i + 1]; k++)
			if (k === t.cueStart[i]) p.moveTo(t.cuePts[k * 2], t.cuePts[k * 2 + 1]);
			else p.lineTo(t.cuePts[k * 2], t.cuePts[k * 2 + 1]);
	}
	const ground = new Path2D();
	const cols = t.skyline.length;
	ground.moveTo(0, -90);
	for (let c = 0; c <= cols; c++) {
		const e = t.skyline[c % cols];
		ground.lineTo(c * t.step, e > -90 ? e : -90);
	}
	ground.lineTo(360, -90);
	ground.closePath();
	const peaks = [...t.peaks].sort(
		(a, b) => (b.prominence ?? 0) - (a.prominence ?? 0) || b.ele - a.ele,
	);
	return {
		terrain: t,
		paths,
		ground,
		far,
		mid: [...midBySlab.values()],
		peaks,
	};
}

/** Ridgelines + ground, behind the photos. `g` is a dpr-scaled CSS-px canvas, already cleared. */
export function drawTerrain(
	g: CanvasRenderingContext2D,
	dpr: number,
	w: number,
	h: number,
	v: View,
	p: PreparedTerrain,
	fade = 1,
) {
	const a1 = v.az0 + w / v.ppd;
	g.save();
	g.lineJoin = "round";
	g.lineCap = "round";
	for (const off of wrapOffsets(0, 360.5, v.az0, a1)) {
		// degree space → device px (y up)
		g.setTransform(
			dpr * v.ppd,
			0,
			0,
			-dpr * v.ppd,
			dpr * (off - v.az0) * v.ppd,
			dpr * (h / 2 + v.elc * v.ppd),
		);
		g.fillStyle = `rgba(${PAPER},${0.035 * fade})`;
		g.fill(p.ground);
		for (let b = BUCKETS - 1; b >= 0; b--) {
			const t = b / (BUCKETS - 1);
			// aerial perspective: far layers faint and fine (matches RigiPanorama's ramp)
			g.strokeStyle = `rgba(${PAPER},${(0.32 - 0.16 * t) * fade})`;
			g.lineWidth = 0.7 / v.ppd;
			g.stroke(p.paths[0][b]);
			g.strokeStyle = `rgba(${PAPER},${(0.85 - 0.5 * t) * fade})`;
			g.lineWidth = (1.3 - 0.6 * t) / v.ppd;
			g.stroke(p.paths[1][b]);
		}
	}
	g.restore();
}

/**
 * Peak names along the top of the strip with leader lines down to the summits, greedily placed by
 * prominence so they never overlap. Drawn in CSS px on the overlay (above the photos, so they name
 * the peaks in them too). Returns the placed labels for hover hit tests.
 */
export function drawPeakLabels(
	g: CanvasRenderingContext2D,
	w: number,
	h: number,
	v: View,
	p: PreparedTerrain,
	top: number,
	hoverName: string | null,
) {
	const a1 = v.az0 + w / v.ppd;
	const placed: { x: number; x1: number; y: number; peak: RidgePeak }[] = [];
	g.font = "600 10.5px ui-sans-serif, system-ui, sans-serif";
	for (const peak of p.peaks) {
		if (placed.length >= 24) break;
		for (const off of wrapOffsets(peak.az, peak.az, v.az0, a1)) {
			const x = (peak.az + off - v.az0) * v.ppd;
			const y = h / 2 - (peak.el - v.elc) * v.ppd;
			if (y < top + 26 || y > h - 4) continue;
			const tw = Math.max(g.measureText(peak.name).width, 42) + 12;
			if (x < 2 || x + tw > w - 2) continue;
			if (placed.some((q) => x < q.x1 + 6 && q.x < x + tw)) continue;
			placed.push({ x, x1: x + tw, y, peak });
		}
	}
	for (const { x, y, peak } of placed) {
		const on = peak.name === hoverName;
		const ink = on ? "220,162,122" : PAPER;
		g.strokeStyle = `rgba(${ink},${on ? 0.9 : 0.3})`;
		g.lineWidth = 0.75;
		g.beginPath();
		g.moveTo(x + 0.5, top + 26);
		g.lineTo(x + 0.5, y - 4);
		g.stroke();
		g.fillStyle = `rgba(${ink},${on ? 1 : 0.8})`;
		g.beginPath();
		g.arc(x, y, on ? 2.4 : 1.6, 0, Math.PI * 2);
		g.fill();
		// a dark halo keeps names legible over bright photo skies
		g.font = "600 10.5px ui-sans-serif, system-ui, sans-serif";
		g.textAlign = "left";
		g.lineWidth = 3;
		g.strokeStyle = "rgba(11,13,16,0.75)";
		g.strokeText(peak.name, x + 4, top + 12);
		g.fillText(peak.name, x + 4, top + 12);
		g.font = "9.5px ui-monospace, monospace";
		const sub = on
			? `${peak.ele} m · ${(peak.d / 1000).toFixed(peak.d < 10_000 ? 1 : 0)} km`
			: `${peak.ele}`;
		g.strokeText(sub, x + 4, top + 23);
		g.fillStyle = `rgba(${ink},${on ? 0.9 : 0.5})`;
		g.fillText(sub, x + 4, top + 23);
	}
	return placed;
}

/**
 * The match cue: the DEM's ridgelines traced faintly over aligned photos, clipped to each frame, so a
 * well-posed photo shows the real skyline sitting on its own. `clips` are photo outlines in CSS px with
 * a strength (hovered / selected photos get a little more). `g` is dpr-scaled CSS px.
 */
export function drawTerrainOnPhotos(
	g: CanvasRenderingContext2D,
	dpr: number,
	w: number,
	h: number,
	v: View,
	p: PreparedTerrain,
	clips: { path: Path2D; strength: number }[],
	fade = 1,
) {
	const a1 = v.az0 + w / v.ppd;
	for (const { path, strength } of clips) {
		g.save();
		g.clip(path);
		g.lineJoin = "round";
		g.lineCap = "round";
		for (const off of wrapOffsets(0, 360.5, v.az0, a1)) {
			g.setTransform(
				dpr * v.ppd,
				0,
				0,
				-dpr * v.ppd,
				dpr * (off - v.az0) * v.ppd,
				dpr * (h / 2 + v.elc * v.ppd),
			);
			// a hairline dark halo under a warm line reads on both snow and sky
			const cue = (path: Path2D, a: number) => {
				g.strokeStyle = `rgba(11,13,16,${a * 0.5})`;
				g.lineWidth = 2.2 / v.ppd;
				g.stroke(path);
				g.strokeStyle = `rgba(220,162,122,${a})`;
				g.lineWidth = 0.9 / v.ppd;
				g.stroke(path);
			};
			for (let b = BUCKETS - 1; b >= 0; b--) {
				const t = b / (BUCKETS - 1);
				cue(p.far[b], Math.min(0.9, (0.6 - 0.15 * t) * strength) * fade);
			}
			for (const m of p.mid)
				cue(m.path, Math.min(0.9, 0.6 * strength) * m.weight * fade);
		}
		g.restore();
	}
}
