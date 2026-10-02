// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Real data for /gipfelbuch/tap-a-peak: runs the real solveFromControlPoints (src/lib/geo/control-points.ts) on a demo
 * photo, starting from the PHONE-SENSOR prior camera, with 1..4 "taps". A tap is a labelled peak at the pixel where
 * it projects at the pipeline-solved pose (an exact finger), paired with its OSM name's DEM azimuth/elevation.
 *
 *   npx tsx scripts/gipfelbuch/data-tap.ts            (needs public/demo/gipfelbuch/<id>.json from build-data.ts)
 *
 * Writes public/demo/gipfelbuch/tap/<id>.json. For every tap count it records the resulting pose, the solver's rms and
 * whether f was unlocked, the error against the solved pose, how far the labelled peaks sit from their solved
 * positions, and the median |detected skyline - DEM skyline| in px (the DEM skyline is the horizon profile
 * projected through the camera, so it is independent of the taps).
 */
import fs from "node:fs";
import path from "node:path";
import type { GipfelbuchPhotoData } from "../../src/components/gipfelbuch/viz/real";
import {
	type Camera,
	cameraFromAngles,
	directionENU,
	project,
} from "../../src/lib/geo/camera";
import { solveFromControlPoints } from "../../src/lib/geo/control-points";
import { ROOT } from "../lib/node-io";

const IDS = ["demo-10", "demo-09", "demo-01"];
const OUT = path.join(ROOT, "public", "demo", "gipfelbuch", "tap");
fs.mkdirSync(OUT, { recursive: true });
const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const wrap = (a: number) => ((a + 540) % 360) - 180;

for (const id of IDS) {
	const d: GipfelbuchPhotoData = JSON.parse(
		fs.readFileSync(
			path.join(ROOT, "public/demo/gipfelbuch", `${id}.json`),
			"utf8",
		),
	);
	const W = d.photo.width;
	const H = d.photo.height;
	const mk = (c: { yaw: number; pitch: number; roll: number; f: number }) =>
		cameraFromAngles({ width: W, height: H, ...c });
	const prior = mk(d.prior);
	const truth = mk(d.solved);
	const vfov = (c: Camera) => (2 * Math.atan(H / 2 / c.f) * 180) / Math.PI;

	// candidate taps: unique-name, visible, labelled, inside the frame, solved px
	const pool = d.peaks.filter(
		(p) => p.labelled && p.visible && p.solved && p.name !== "",
	);
	const uniq = new Map(pool.map((p) => [p.name, p]));
	const cand = [...uniq.values()].filter(
		(p) => (p.solved as number[])[0] > 40 && (p.solved as number[])[0] < W - 40,
	);
	const X = (p: (typeof cand)[number]) => (p.solved as number[])[0];
	// tap 1 nearest the centre, tap 2 the farthest in x from it, tap 3 the middle of those two, tap 4 the next far end
	const t1 = [...cand].sort(
		(a, b) => Math.abs(X(a) - W / 2) - Math.abs(X(b) - W / 2),
	)[0];
	const t2 = [...cand].sort(
		(a, b) => Math.abs(X(b) - X(t1)) - Math.abs(X(a) - X(t1)),
	)[0];
	const mid = (X(t1) + X(t2)) / 2;
	const rest = (xs: typeof cand) => xs.filter((p) => ![t1, t2].includes(p));
	const t3 = [...rest(cand)].sort(
		(a, b) => Math.abs(X(a) - mid) - Math.abs(X(b) - mid),
	)[0];
	const t4 = [...rest(cand)]
		.filter((p) => p !== t3)
		.sort((a, b) => Math.abs(X(b) - X(t1)) - Math.abs(X(a) - X(t1)))[0];
	const taps = [t1, t2, t3, t4].filter(Boolean);

	const labelled = d.peaks.filter((p) => p.labelled && p.solved);
	const proj = (c: Camera, p: { az: number; el: number }) =>
		project(c, directionENU(p.az, p.el));
	const rowsAt = (c: Camera) => {
		const rows: (number | null)[] = new Array(W).fill(null);
		let prev: [number, number] | null = null;
		for (const q of d.horizon.profile) {
			const pt = proj(c, q);
			if (pt && prev && pt[0] !== prev[0]) {
				const [a, b] = prev[0] < pt[0] ? [prev, pt] : [pt, prev];
				for (
					let x = Math.max(0, Math.ceil(a[0]));
					x <= Math.min(W - 1, Math.floor(b[0]));
					x++
				)
					rows[x] = a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0]);
			}
			prev = pt;
		}
		return rows;
	};
	const median = (rows: (number | null)[]) => {
		const e: number[] = [];
		rows.forEach((y, x) => {
			const o = d.skyline.rows[x];
			if (y != null && o != null && d.skyline.weight[x] > 0.05)
				e.push(Math.abs(o - y));
		});
		e.sort((a, b) => a - b);
		return {
			median: r2(e[e.length >> 1]),
			within5: r3(e.filter((v) => v <= 5).length / e.length),
			n: e.length,
		};
	};
	const record = (
		n: number,
		c: Camera,
		rms: number | null,
		solvedFocal: boolean,
	) => {
		const shifts = labelled.map((p) => {
			const q = proj(c, p);
			const t = p.solved as [number, number];
			return q ? Math.hypot(q[0] - t[0], q[1] - t[1]) : Number.NaN;
		});
		const ok = shifts.filter(Number.isFinite).sort((a, b) => a - b);
		const rows = rowsAt(c);
		return {
			n,
			cam: {
				yaw: r2(c.yaw),
				pitch: r2(c.pitch),
				roll: r2(c.roll),
				f: r1(c.f),
				vfov: r2(vfov(c)),
			},
			rmsPx: rms == null ? null : r2(rms),
			solvedFocal,
			err: {
				yaw: r2(wrap(c.yaw - truth.yaw)),
				pitch: r2(c.pitch - truth.pitch),
				roll: r2(c.roll - truth.roll),
				fRatio: r3(c.f / truth.f),
			},
			peakShift: { median: r1(ok[ok.length >> 1]), max: r1(ok[ok.length - 1]) },
			skyline: median(rows),
			rows: rows
				.filter((_, x) => x % 4 === 0)
				.map((y) => (y == null ? null : r1(y))),
			peaks: labelled.map((p) => {
				const q = proj(c, p);
				return q ? [r1(q[0]), r1(q[1])] : null;
			}),
		};
	};

	const steps = [record(0, prior, null, false)];
	for (let n = 1; n <= taps.length; n++) {
		const pts = taps.slice(0, n).map((p) => ({
			x: (p.solved as number[])[0],
			y: (p.solved as number[])[1],
			azimuth: p.az,
			elevation: p.el,
			label: p.name,
		}));
		const s = solveFromControlPoints(prior, pts);
		steps.push(record(n, s.camera, s.rmsPx, s.solvedFocal));
	}
	const out = {
		id,
		script: "scripts/gipfelbuch/data-tap.ts",
		generated: new Date().toISOString().slice(0, 10),
		solver: "solveFromControlPoints (src/lib/geo/control-points.ts)",
		photo: { width: W, height: H },
		truth: {
			yaw: r2(truth.yaw),
			pitch: r2(truth.pitch),
			roll: r2(truth.roll),
			f: r1(truth.f),
			vfov: r2(vfov(truth)),
		},
		taps: taps.map((p) => ({
			name: p.name,
			dem: p.dem,
			distance: p.distance,
			az: p.az,
			el: p.el,
			x: (p.solved as number[])[0],
			y: (p.solved as number[])[1],
		})),
		labelledNames: labelled.map((p) => p.name),
		// the DEM skyline at the SOLVED pose through this same projection (sanity check vs build-data's solvedRows)
		solvedSkyline: median(rowsAt(truth)),
		steps,
	};
	fs.writeFileSync(path.join(OUT, `${id}.json`), JSON.stringify(out));
	console.log(id, taps.map((t) => t.name).join(", "));
	for (const s of steps)
		console.log(
			` n=${s.n} yaw ${s.err.yaw} pitch ${s.err.pitch} roll ${s.err.roll} f×${s.err.fRatio} rms ${s.rmsPx} peakShift ${s.peakShift.median}/${s.peakShift.max} skyline ${s.skyline.median}px`,
		);
	console.log(
		" at solved pose:",
		out.solvedSkyline,
		"build-data residual",
		d.residual.solved,
	);
}
