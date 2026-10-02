// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { CLASSIC } from "../../style/defaults.ts";
import { mergeStyle, pruneOverrides } from "../../style/schema.ts";
import {
	GLOW_DEFAULT,
	glowMarkersFor,
	glowUniformsOf,
	sameGlowMarkers,
} from "../labels/glow.ts";
// Node check for the peak labels: `npx tsx src/lib/look/__tests__/labels.check.ts`
//  - classic: rankPeaks + declutterClassic reproduce the engines' original code byte for byte
//  - panorama / inline layout: no overlaps, only visible peaks, stable under small moves, < 2 ms
import {
	type LabelCandidate,
	type LayoutKind,
	type LayoutOptions,
	labelsOverlap,
	layoutLabels,
	skylineAt,
} from "../labels/layout.ts";
import { declutterClassic, peakRank, rankPeaks } from "../labels/rank.ts";

const W = 1600;
const H = 1200;

function rng(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 4294967296;
	};
}

function scene(seed: number) {
	const r = rng(seed);
	const ph = [r() * 6, r() * 6, r() * 6];
	const skyPx = (x: number) =>
		520 +
		70 * Math.sin(x / 190 + ph[0]) +
		35 * Math.sin(x / 67 + ph[1]) +
		14 * Math.sin(x / 23 + ph[2]);
	const skyline = new Float32Array(512);
	for (let i = 0; i < skyline.length; i++)
		skyline[i] = skyPx(((i + 0.5) / skyline.length) * W) / H;
	const cands: LabelCandidate[] = [];
	for (let i = 0; i < 40; i++) {
		const x = 20 + r() * (W - 40);
		const onSky = r() < 0.6;
		const y = onSky ? skyPx(x) + 2 : skyPx(x) + 20 + r() * 300;
		const ele = 1500 + r() * 2800;
		cands.push({
			id: `p${i}`,
			name: `Peak ${String.fromCharCode(65 + (i % 26))}${"orn".slice(0, i % 4)}${i > 25 ? "stock" : ""}`,
			ele: Math.round(ele),
			prominence: r() < 0.5 ? Math.round(r() * 900) : null,
			distKm: 2 + r() * 90,
			x,
			y,
			visible: r() < 0.85,
			skylineY: skyPx(x),
		});
	}
	return { cands, skyline };
}

let failures = 0;
function check(ok: boolean, msg: string) {
	console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
	if (!ok) failures++;
}

for (const style of ["panorama", "inline"] as LayoutKind[]) {
	for (const angle of style === "panorama" ? [50, 0] : [0]) {
		const tag = `${style}${style === "panorama" ? ` ${angle}°` : ""}`;
		let overlaps = 0;
		let invisible = 0;
		let placedTotal = 0;
		let kept = 0;
		let keptOf = 0;
		let times: number[] = [];
		for (let seed = 1; seed <= 20; seed++) {
			const { cands, skyline } = scene(seed);
			const opts: LayoutOptions = {
				width: W,
				height: H,
				fontPx: 15,
				style,
				angle,
				skyline,
				maxLabels: 28,
			};
			const a = layoutLabels(cands, opts);
			placedTotal += a.length;
			for (let i = 0; i < a.length; i++) {
				if (!a[i].visible) invisible++;
				for (let j = i + 1; j < a.length; j++)
					if (labelsOverlap(a[i], a[j])) overlaps++;
			}
			// stability: nudge every summit by 3 px (random direction) and re-layout with prev
			const r = rng(seed * 7919);
			const moved = cands.map((c) => ({ ...c, x: c.x + (r() < 0.5 ? -3 : 3) }));
			const b = layoutLabels(moved, opts, a);
			const byId = new Map(b.map((l) => [l.id, l]));
			for (const l of a) {
				keptOf++;
				const m = byId.get(l.id);
				if (m && m.row === l.row) kept++;
			}
			for (let i = 0; i < b.length; i++)
				for (let j = i + 1; j < b.length; j++)
					if (labelsOverlap(b[i], b[j])) overlaps++;
			// timing: best of 5 batches (the machine may be shared with other jobs)
			const N = 40;
			let best = Number.POSITIVE_INFINITY;
			let prev = a;
			for (let batch = 0; batch < 5; batch++) {
				const t0 = performance.now();
				for (let k = 0; k < N; k++)
					prev = layoutLabels(k % 2 ? moved : cands, opts, prev);
				best = Math.min(best, (performance.now() - t0) / N);
			}
			times.push(best);
		}
		times = times.sort((x, y) => x - y);
		const mean = times.reduce((s, t) => s + t, 0) / times.length;
		const worst = times[times.length - 1];
		console.log(
			`\n[${tag}] 20 scenes × 40 peaks, ${W}×${H}: avg ${(placedTotal / 20).toFixed(1)} labels placed`,
		);
		check(overlaps === 0, `no overlapping label boxes (${overlaps} overlaps)`);
		check(
			invisible === 0,
			`all placed labels visible (${invisible} occluded placed)`,
		);
		const keepRate = kept / Math.max(1, keptOf);
		check(
			keepRate >= 0.9,
			`stability: ${(keepRate * 100).toFixed(1)}% keep the same row after a 3 px nudge`,
		);
		check(
			worst < 2,
			`runtime: mean ${mean.toFixed(3)} ms, worst scene ${worst.toFixed(3)} ms per layout (< 2 ms)`,
		);
	}
}

// ---- classic: byte-equal to the pre-P4 engine code --------------------------------------------

type Fx = {
	name: string;
	ele: number | null;
	prominence: number | null;
	u: number;
	v: number;
	range: number;
	visible: boolean;
	world: [number, number, number];
};

function fixture(seed: number): Fx[] {
	const r = rng(seed);
	const names = [
		"Eiger",
		"Mönch",
		"Jungfrau",
		"Piz Bernina",
		"Dom",
		"Täschhorn",
		"Weisshorn",
		"Pt. 2412",
		"Gross Fiescherhorn",
		"Oberaarhorn",
	];
	const out: Fx[] = [];
	for (let i = 0; i < 160; i++) {
		const dup = i > 10 && r() < 0.12 ? out[Math.floor(r() * out.length)] : null;
		out.push({
			// duplicates exercise every tie-break: same rank / prominence / elevation / name, different u
			name: dup
				? dup.name
				: `${names[i % names.length]}${r() < 0.3 ? "" : ` ${i}`}`,
			ele: dup ? dup.ele : r() < 0.1 ? null : Math.round(1200 + r() * 3300),
			prominence: dup
				? dup.prominence
				: r() < 0.4
					? null
					: Math.round(r() * 1500),
			u: r(),
			v: 0.2 + r() * 0.5,
			range: dup ? dup.range : 500 + r() * 90000,
			visible: r() < 0.8,
			world: [r() * 1e4, r() * 1e4, r() * 3000],
		});
	}
	return out;
}

/** engine.ts peakLabels before P4 step 10 (sort + declutter), verbatim. */
function oldThree(peaks: Fx[], max: number) {
	const out = peaks.map((p) => ({
		name: p.name,
		ele: p.ele,
		u: p.u,
		v: p.v,
		distKm: p.range / 1000,
		rank: (p.prominence ?? 0) * 3 + (p.ele ?? 0) - p.range * 0.012,
		visible: p.visible,
		world: p.world,
		prom: p.prominence ?? 0,
	}));
	out.sort(
		(a, b) =>
			Number(b.visible) - Number(a.visible) ||
			b.rank - a.rank ||
			b.prom - a.prom ||
			(b.ele ?? 0) - (a.ele ?? 0) ||
			(a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
			a.u - b.u,
	);
	const placed: typeof out = [];
	for (const l of out) {
		if (!l.visible) continue;
		const half = (l: { name: string }) => Math.max(l.name.length, 12) * 0.0034;
		if (
			placed.some(
				(q) =>
					Math.abs(q.u - l.u) < half(q) + half(l) &&
					Math.abs(q.v - l.v) < 0.075,
			)
		)
			continue;
		placed.push(l);
		if (placed.length >= max) break;
	}
	return placed;
}

const key = (
	ls: { name: string; u: number; v: number; rank: number; distKm: number }[],
) => JSON.stringify(ls.map((l) => [l.name, l.u, l.v, l.rank, l.distKm]));

console.log(
	"\n[classic] rankPeaks + declutterClassic vs the original engine code",
);
let same = 0;
const trials = 40;
for (let seed = 1; seed <= trials; seed++) {
	const peaks = fixture(seed);
	const max = [28, 5, 1, 100][seed % 4];
	const now = rankPeaks(
		peaks
			.filter((p) => p.visible)
			.map((p) => ({
				name: p.name,
				ele: p.ele,
				prominence: p.prominence,
				u: p.u,
				v: p.v,
				distKm: p.range / 1000,
				rank: peakRank(p.prominence, p.ele, p.range),
			})),
	);
	if (key(declutterClassic(now, max)) === key(oldThree(peaks, max))) same++;
}
check(
	same === trials,
	`classic output byte-equal on ${same}/${trials} seeded fixtures`,
);

// skylineAt: three's RGBA bottom-up buffer and deck's r32 top-down one give the same skyline
{
	const w = 64;
	const h = 48;
	const rgba = new Float32Array(w * h * 4);
	const r32 = new Float32Array(w * h).fill(Number.POSITIVE_INFINITY);
	for (let x = 0; x < w; x++) {
		const top = 5 + (x % 17); // first terrain row from the top
		for (let t = top; t < h; t++) {
			rgba[((h - 1 - t) * w + x) * 4 + 3] = 1000;
			r32[t * w + x] = 1000;
		}
	}
	const a = skylineAt(rgba, w, h);
	const b = skylineAt(r32, w, h, { rowsTopDown: true, stride: 1, channel: 0 });
	check(
		JSON.stringify(Array.from(a)) === JSON.stringify(Array.from(b)) &&
			a[0] === Math.fround(5 / h),
		"skylineAt: three RGBA (bottom-up) = deck r32 (top-down)",
	);
}

// glow markers (style.labels.glow): off by default, markers only when on, schema round trip
{
	const labels = [
		{ u: 0.25, v: 0.5 },
		{ u: 0.75, v: 0.125 },
	];
	check(CLASSIC.labels.glow == null, "glow: off in the classic style");
	check(glowMarkersFor(labels, undefined) === null, "glow: off → no markers");
	check(glowMarkersFor(labels, null) === null, "glow: null → no markers");
	check(glowMarkersFor([], GLOW_DEFAULT) === null, "glow: no labels → none");
	check(
		glowMarkersFor(labels, { ...GLOW_DEFAULT, intensity: 0 }) === null,
		"glow: zero intensity → none",
	);
	const m = glowMarkersFor(labels, GLOW_DEFAULT);
	check(
		!!m &&
			m.points.length === 4 &&
			m.points[0] === 0.25 &&
			m.points[3] === 0.125,
		"glow: one (u, v) per label",
	);
	check(
		sameGlowMarkers(m, glowMarkersFor(labels, GLOW_DEFAULT)) &&
			!sameGlowMarkers(m, glowMarkersFor(labels.slice(1), GLOW_DEFAULT)) &&
			!sameGlowMarkers(m, null),
		"glow: sameGlowMarkers compares points and look",
	);
	const u = glowUniformsOf(GLOW_DEFAULT);
	check(
		u.tint[0] > u.tint[2] && u.tint[0] <= 1 && u.radiusPx === 22,
		"glow: tint is linear and warm",
	);
	const on = mergeStyle(CLASSIC, { labels: { glow: { radiusPx: 30 } } });
	check(
		on.labels.glow?.radiusPx === 30 &&
			on.labels.glow?.tint === GLOW_DEFAULT.tint,
		"glow: a partial turns it on over the defaults",
	);
	check(
		mergeStyle(on, { labels: { glow: null } }).labels.glow === null,
		"glow: null turns it off again",
	);
	check(
		pruneOverrides({ labels: { glow: { radiusPx: 9999, bogus: 1 } } }).labels
			?.glow?.radiusPx === 200,
		"glow: untrusted values clamp",
	);
	check(
		JSON.stringify(mergeStyle(CLASSIC, {})) === JSON.stringify(CLASSIC),
		"glow: an empty override leaves the classic style byte-identical",
	);
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
