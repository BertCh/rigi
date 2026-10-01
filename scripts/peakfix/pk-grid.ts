// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * PEAKFIX PK1 / PK2 eye grid search (tools/research/peakfix/PROTOCOL.txt). DEV GT photos only, CPU, no renders.
 *
 *   npx tsx scripts/peakfix/pk-grid.ts [--synth] [--half 400] [--step 20] [--tag x] IMG_xxxx
 *
 * Writes out/peakfix/<pk1|pk2><tag>/<photo>.json.
 */
import fs from "node:fs";
import path from "node:path";
import {
	type Arm,
	camOf,
	type FitParams,
	type FitResult,
	fitArm,
	type Obs,
	PK_OPTS,
	projectAzEl,
	pxPerDeg,
	scanStart,
} from "../../src/lib/peakfix/fit";
import {
	horizonPeaks,
	skylinePeaks,
	type WorldPeak,
} from "../../src/lib/peakfix/peaks";
import type { EyeHorizon } from "../../src/lib/pose6dof/eye";
import {
	FastSampler,
	halfDiagFovDeg,
	photoSetup,
	writeJson,
} from "../geocam/lib";
import { sectorHorizonFrom } from "./lib-pk";

const argv = process.argv.slice(2);
const flag = (k: string) => argv.includes(k);
const opt = (k: string, d: string) => {
	const i = argv.indexOf(k);
	return i >= 0 ? argv[i + 1] : d;
};
const VALUED = ["--half", "--step", "--tag"];
const photo = argv.filter(
	(a, i) => !a.startsWith("--") && !VALUED.includes(argv[i - 1]),
)[0];
const synth = flag("--synth");
const HALF = Number(opt("--half", "400"));
const STEP = Number(opt("--step", "20"));
const tag = opt("--tag", "");
/** PROTOCOL amendment A2 (post hoc): PEAK/BOTH start from the DENSE fit. */
const A2 = flag("--a2");
const ARMS: Arm[] = ["dense", "peak", "both"];
const OUT = path.join("out", "peakfix", `${synth ? "pk1" : "pk2"}${tag}`);

const P = await photoSetup(photo, { start: "app" });
const fs_ = new FastSampler(P.t);
const aspect = P.gt.aspect;
const W = aspect >= 1 ? 1600 : 1600 * aspect;
const H = aspect >= 1 ? 1600 / aspect : 1600;
const h0 = 0 - P.ground(0, 0);
const eyeAt = (e: number, n: number): [number, number, number] => {
	const g = P.ground(e, n);
	return [e, n, (Number.isFinite(g) ? g : P.ground(0, 0)) + h0];
};

const ref = synth ? P.gt : P.start;
const vfov = ref.pose.vfov;
const halfAz = halfDiagFovDeg(ref) + 3;
const a0 = ref.pose.yaw - halfAz;

const hzAt = (eye: [number, number, number]): EyeHorizon =>
	sectorHorizonFrom(
		P.s,
		fs_,
		eye,
		a0 < 0 ? a0 + 360 : a0,
		(a0 < 0 ? a0 + 360 : a0) + 2 * halfAz,
	);
const AZ0 = a0 < 0 ? a0 + 360 : a0;

// --- observations
let rng = 0x9e3779b9;
const rand = () => {
	rng ^= rng << 13;
	rng ^= rng >>> 17;
	rng ^= rng << 5;
	return ((rng >>> 0) + 0.5) / 4294967296;
};
const gauss = () =>
	Math.sqrt(-2 * Math.log(rand())) * Math.cos(2 * Math.PI * rand());

let samples: Obs["samples"];
let p0: FitParams;
const gtP: FitParams = [
	P.gt.pose.yaw,
	P.gt.pose.pitch,
	P.gt.pose.roll,
	Math.log(P.gt.intr.fScale),
];
if (synth) {
	// PK1: the GT-eye DEM horizon projected with the GT camera, every 2 px, σ 1 px vertical noise
	const hz = hzAt(eyeAt(0, 0));
	const tmpObs: Obs = { W, H, vfov: P.gt.pose.vfov, samples: [], peaks: [] };
	const c = camOf(gtP, tmpObs);
	const pts: [number, number][] = [];
	const n = hz.elevation.length;
	const k0 = Math.ceil(AZ0 / hz.step);
	const k1 = Math.floor((AZ0 + 2 * halfAz) / hz.step);
	for (let k = k0; k <= k1; k++) {
		const el = hz.elevation[((k % n) + n) % n];
		if (el <= -89) continue;
		const q = projectAzEl(c, k * hz.step, el);
		if (q) pts.push(q);
	}
	pts.sort((a, b) => a[0] - b[0]);
	samples = [];
	let j = 0;
	for (let x = 1; x < W; x += 2) {
		while (j < pts.length - 2 && pts[j + 1][0] < x) j++;
		const [xa, ya] = pts[j];
		const [xb, yb] = pts[j + 1];
		if (!(xa <= x && x <= xb)) continue;
		const y = ya + ((yb - ya) * (x - xa)) / Math.max(1e-9, xb - xa);
		if (y < 0 || y > H) continue;
		samples.push({ x, y: y + gauss(), w: 1 });
	}
	p0 = [gtP[0] + 0.6, gtP[1] - 0.3, gtP[2] + 0.3, gtP[3] + Math.log(1.02)];
} else {
	samples = P.skyline.map((s) => ({ x: s.u * W, y: s.v * H, w: s.w ?? 1 }));
	p0 = [
		P.start.pose.yaw,
		P.start.pose.pitch,
		P.start.pose.roll,
		Math.log(P.start.intr.fScale),
	];
}
const obsBase: Obs = { W, H, vfov, samples, peaks: [] };
const dx = 2;
const peaks = skylinePeaks(samples, dx, {
	minPromPx: PK_OPTS.promPx * PK_OPTS.hysteresis,
	windowPx: 60,
});
const obs: Obs = { ...obsBase, peaks };
const ppd0 = pxPerDeg(p0, obs);
const modelPeaks = (hz: EyeHorizon): WorldPeak[] =>
	horizonPeaks(hz, AZ0, AZ0 + 2 * halfAz, {
		minPromDeg: (PK_OPTS.promPx * PK_OPTS.hysteresis) / ppd0,
		windowDeg: 60 / ppd0,
	});

type Cell = {
	e: number;
	n: number;
	z: number;
	arms: Record<Arm, { cost: number; nMatched: number; p: FitParams }>;
};
const memo = new Map<string, Cell>();
const evalEye = (e: number, n: number): Cell => {
	const key = `${e},${n}`;
	const hit = memo.get(key);
	if (hit) return hit;
	const eye = eyeAt(e, n);
	const hz = hzAt(eye);
	const mp = modelPeaks(hz);
	const ps = scanStart(p0, hz, obs, PK_OPTS);
	const arms = {} as Cell["arms"];
	const pd = A2 ? fitArm("dense", ps, hz, mp, obs).p : ps;
	for (const a of ARMS) {
		const r = fitArm(a, a === "dense" ? ps : pd, hz, mp, obs);
		arms[a] = { cost: r.cost, nMatched: r.nMatched, p: r.p };
	}
	const cell = { e, n, z: eye[2], arms };
	memo.set(key, cell);
	return cell;
};

const t0 = Date.now();
const grid: Cell[] = [];
for (let n = -HALF; n <= HALF; n += STEP)
	for (let e = -HALF; e <= HALF; e += STEP) grid.push(evalEye(e, n));
const tGrid = Date.now() - t0;

const best = (cells: Cell[], a: Arm) =>
	cells.reduce((b, c) => (c.arms[a].cost < b.arms[a].cost ? c : b));

const detail = (e: number, n: number, a: Arm) => {
	const eye = eyeAt(e, n);
	const hz = hzAt(eye);
	const mp = modelPeaks(hz);
	const ps = scanStart(p0, hz, obs, PK_OPTS);
	const pd = A2 && a !== "dense" ? fitArm("dense", ps, hz, mp, obs).p : ps;
	const r: FitResult = fitArm(a, pd, hz, mp, obs);
	const matched = r.pairs
		.filter((q) => q.side === "photo")
		.map((q) => ({
			d: Math.round(mp[q.model].d),
			az: +mp[q.model].az.toFixed(3),
			photo: obs.peaks[q.photo],
		}));
	return {
		cost: r.cost,
		dense: r.dense,
		peak: r.peak,
		nMatched: r.nMatched,
		nItems: r.nItems,
		p: r.p,
		matched,
	};
};

const result: Record<string, unknown> = {
	photo,
	mode: synth ? "PK1" : "PK2",
	half: HALF,
	step: STEP,
	hAcc: P.meta.hAcc,
	nSamples: samples.length,
	photoPeaks: peaks,
	p0,
	gtP,
	msGrid: tGrid,
	nGrid: grid.length,
	grid: grid.map((c) => [
		c.e,
		c.n,
		...ARMS.map((a) => +c.arms[a].cost.toFixed(4)),
		c.arms.peak.nMatched,
		c.arms.both.nMatched,
	]),
	gridCols: ["e", "n", ...ARMS, "peakMatched", "bothMatched"],
};
const arms: Record<string, unknown> = {};
for (const a of ARMS) {
	const b = best(grid, a);
	const fine: Cell[] = [];
	for (let n = b.n - 25; n <= b.n + 25; n += 5)
		for (let e = b.e - 25; e <= b.e + 25; e += 5) fine.push(evalEye(e, n));
	const f = best(fine, a);
	// second basin: best grid cell ≥ 60 m from the refined minimum
	const far = grid.filter((c) => Math.hypot(c.e - f.e, c.n - f.n) >= 60);
	const s2 = far.length ? best(far, a) : null;
	arms[a] = {
		grid: { e: b.e, n: b.n, cost: b.arms[a].cost },
		e: f.e,
		n: f.n,
		err: Math.hypot(f.e, f.n),
		cost: f.arms[a].cost,
		nMatched: f.arms[a].nMatched,
		second: s2
			? {
					e: s2.e,
					n: s2.n,
					cost: s2.arms[a].cost,
					ratio: s2.arms[a].cost / Math.max(1e-9, f.arms[a].cost),
				}
			: null,
		detail: detail(f.e, f.n, a),
	};
}
result.arms = arms;
result.atTruth = Object.fromEntries(ARMS.map((a) => [a, detail(0, 0, a)]));
result.msTotal = Date.now() - t0;
fs.mkdirSync(OUT, { recursive: true });
writeJson(path.join(OUT, `${photo}.json`), result);
console.log(
	photo,
	result.mode,
	`grid ${grid.length} in ${(tGrid / 1000).toFixed(0)} s`,
	ARMS.map((a) => {
		const r = arms[a] as { err: number; nMatched: number };
		return `${a} ${r.err.toFixed(0)} m (${r.nMatched})`;
	}).join(" | "),
);
