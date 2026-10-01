// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// npx tsx src/lib/gpu/align/refine-guard.check.ts — node checks of the GPU refine's correctness guards
// (no browser, no GPU): on a synthetic skyline scene,
//  1. autoAlignRefined with true bounds (exact score + slack) equals autoAlign bit for bit, with and
//     without verifying every skip;
//  2. a forced violation (every bound deflated by 1, the alignGpuOptions.faultDeflate fault) is caught
//     by the device's skip verification: guardedRefine returns autoAlign's exact result, reports the
//     violation, and the device's GPU refine stays disabled (until resetGpuRefine);
//  3. a subtle fault (bounds 1e-3 too low) is caught too: the device's first 64 skips are all re-scored,
//     and the first wrong skip trips the check.
import type { Device } from "@luma.gl/core";
import {
	type AlignResult,
	autoAlign,
	autoAlignRefined,
	type EdgeMap,
	newRefineStats,
	RefineBoundViolation,
	type ScoreBounds,
	scorePose,
} from "#/lib/align";
import type { Pose } from "#/lib/camera";
import { gpuRefineDisabled, guardedRefine, resetGpuRefine } from "./index";

let failures = 0;
const check = (name: string, ok: boolean, info = "") => {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${info ? ` ${info}` : ""}`);
};

// ---- synthetic scene: a ridge profile seen from the origin, rendered into an edge map ----
const D = Math.PI / 180;
const ridge = (az: number) =>
	2.5 + 1.8 * Math.sin(az * 7 * D) + 0.9 * Math.sin(az * 19 * D + 1);
const n = 4096;
const dirs = new Float32Array(n * 3);
for (let i = 0; i < n; i++) {
	const az = 60 + (i / n) * 120; // 60°..180°
	const el = ridge(az) * D;
	dirs[i * 3] = Math.sin(az * D) * Math.cos(el);
	dirs[i * 3 + 1] = Math.cos(az * D) * Math.cos(el);
	dirs[i * 3 + 2] = Math.sin(el);
}
const truth: Pose = { yaw: 120, pitch: 1, roll: 0.5, vfov: 40 };
const aspect = 1.5;
const w = 192;
const h = 128;
// skyline row per column for the true pose (small-angle projection is enough for a test image)
const rows = new Float32Array(w).fill(h);
const t = Math.tan((truth.vfov * D) / 2);
for (let i = 0; i < n; i++) {
	const az = 60 + (i / n) * 120;
	const x = 0.5 + Math.tan((az - truth.yaw) * D) / (t * aspect) / 2;
	const v = 0.5 - Math.tan((ridge(az) - truth.pitch) * D) / t / 2;
	const col = Math.floor(x * w);
	if (col >= 0 && col < w) rows[col] = Math.min(rows[col], v * h);
}
const rgb = new Uint8ClampedArray(w * h * 4);
const coarse = new Float32Array(w * h);
const fine = new Float32Array(w * h);
for (let y = 0; y < h; y++)
	for (let x = 0; x < w; x++) {
		const i = y * w + x;
		const sky = y < rows[x];
		rgb.set(sky ? [120, 160, 230, 255] : [90, 80, 60, 255], i * 4);
		const d = Math.abs(y - rows[x]);
		coarse[i] = Math.exp(-(d * d) / 40);
		fine[i] = Math.exp(-(d * d) / 4);
	}
const edge: EdgeMap = {
	w,
	h,
	coarse,
	fine,
	sky: new Float32Array(w * h),
	skyCum: new Float32Array(w * (h + 1)),
	rgb,
	fg: new Float32Array(w * h),
};
const prior: Pose = { yaw: 124, pitch: 0, roll: 0, vfov: 41 };

const same = (a: AlignResult, b: AlignResult) =>
	Object.is(a.score, b.score) &&
	Object.is(a.confidence, b.confidence) &&
	(a.alternatives ?? []).length === (b.alternatives ?? []).length &&
	(a.alternatives ?? []).every((x, i) => {
		const y = (b.alternatives ?? [])[i];
		return (
			Object.is(x.score, y.score) &&
			(["yaw", "pitch", "roll", "vfov"] as const).every((k) =>
				Object.is(x.pose[k], y.pose[k]),
			)
		);
	});

const ref = autoAlign(prior, aspect, dirs, edge, 25);
const exact =
	(slack: number, deflate = 0): ScoreBounds =>
	async (probes) =>
		probes.map((q) => ({
			ub: scorePose(q.pose, aspect, dirs, edge, q.fine, 1) + slack - deflate,
			eps: slack,
		}));

// 1. true bounds
{
	const st = newRefineStats();
	const r = await autoAlignRefined(
		prior,
		aspect,
		dirs,
		edge,
		25,
		undefined,
		exact(1e-5),
		st,
	);
	check(
		"true bounds: identical to autoAlign",
		same(ref, r),
		`skipped ${st.skipped} of ${st.skipped + st.cpuEvals}`,
	);
	check("true bounds: some skips happened", st.skipped > 0);
	const sv = newRefineStats();
	const rv = await autoAlignRefined(
		prior,
		aspect,
		dirs,
		edge,
		25,
		undefined,
		exact(1e-5),
		sv,
		undefined,
		{ check: () => true },
	);
	check(
		"verify-all: identical, every skip re-scored, no violation",
		same(ref, rv) && sv.skipped === 0 && sv.verified > 0,
	);
}

// 2. forced violation through the per-device guard
{
	const device = {} as Device; // only a WeakMap key for the device state
	resetGpuRefine(device);
	let threw = false;
	const g = await guardedRefine(
		device,
		async (verify) => {
			try {
				return await autoAlignRefined(
					prior,
					aspect,
					dirs,
					edge,
					25,
					undefined,
					exact(0, 1),
					undefined,
					undefined,
					verify,
				);
			} catch (e) {
				threw = e instanceof RefineBoundViolation;
				throw e;
			}
		},
		() => autoAlign(prior, aspect, dirs, edge, 25),
	);
	check("fault: verification raised RefineBoundViolation", threw);
	check("fault: violation reported", !!g.violation);
	check("fault: result identical to autoAlign", same(ref, g.res));
	check("fault: device GPU refine disabled", gpuRefineDisabled(device));
	// the flag sticks: a later, correct call does not re-enable it
	const g2 = await guardedRefine(
		device,
		(verify) =>
			autoAlignRefined(
				prior,
				aspect,
				dirs,
				edge,
				25,
				undefined,
				exact(1e-5),
				undefined,
				undefined,
				verify,
			),
		() => autoAlign(prior, aspect, dirs, edge, 25),
	);
	check(
		"fault: flag sticks after a clean call",
		gpuRefineDisabled(device) && same(ref, g2.res) && !g2.violation,
	);
	resetGpuRefine(device);
	check("fault: resetGpuRefine clears the flag", !gpuRefineDisabled(device));
	// another device is unaffected
	check("fault: other devices unaffected", !gpuRefineDisabled({} as Device));
}

// 3. a fault confined to small deflations is still caught (first-64 verification)
{
	const device = {} as Device;
	const g = await guardedRefine(
		device,
		(verify) =>
			autoAlignRefined(
				prior,
				aspect,
				dirs,
				edge,
				25,
				undefined,
				exact(0, 1e-3),
				undefined,
				undefined,
				verify,
			),
		() => autoAlign(prior, aspect, dirs, edge, 25),
	);
	check(
		"small fault: caught, result identical",
		!!g.violation && same(ref, g.res),
	);
}

console.log(failures ? `FAIL: ${failures}` : "PASS");
process.exit(failures ? 1 : 0);
