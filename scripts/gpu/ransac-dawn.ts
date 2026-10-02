// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The GPU RANSAC scorer (src/lib/gpu/ransac/score.ts) on a real luma WebGPU device in node (Dawn),
// against its CPU twin (scoreBatchCpu, f64), and the async solvers against the sync ones.
//
//   (mkdir /tmp/dawn && cd /tmp/dawn && npm i webgpu@0.3.0)   # not an app dependency
//   DAWN_DIR=/tmp/dawn npx tsx scripts/gpu/ransac-dawn.ts
//
// Per batch (chord / angular / reproj, K up to 70000 so the 2-D grid is used): the GPU winner's f64
// re-score equals the CPU winner's (count for chord / angular; MSAC cost within 1e-4 relative for
// reproj, where f32 rounding may pick a near-tie). End to end: rotationRansacAsync,
// cameraRotationRansacAsync and absolutePoseRansacAsync with gpu "on" land within 0.05° of the sync
// solvers and of the ground truth. SKIP (exit 0) without DAWN_DIR; exit 1 on any mismatch.
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Device } from "@luma.gl/core";
import { attachWebGPUDevice } from "../../src/lib/gpu/core/luma";
import { COMPUTE_FEATURES } from "../../src/lib/gpu/device";
import { scoreBatchGpu } from "../../src/lib/gpu/ransac/score";
import {
	absolutePoseRansac,
	absolutePoseRansacAsync,
	cameraRotationRansac,
	cameraRotationRansacAsync,
	chord2OfAngle,
	expSO3,
	HYP_STRIDE,
	type HypothesisBatch,
	kabsch,
	rotationDistanceDeg,
	rotationRansac,
	rotationRansacAsync,
	scoreBatchCpu,
	scoreHypothesis,
} from "../../src/lib/pose6dof";
import {
	synthAbsolute,
	synthRotation,
} from "../../src/lib/pose6dof/ransac/__tests__/synth";

const dir = process.env.DAWN_DIR;
if (!dir) {
	console.log("SKIP ransac-dawn: DAWN_DIR not set");
	process.exit(0);
}
const { create, globals } = await import(
	pathToFileURL(path.join(dir, "node_modules/webgpu/index.js")).href
);
Object.assign(globalThis, globals);
const gpu = create([]);
Object.defineProperty(globalThis, "navigator", {
	value: { gpu, userAgent: "node" },
	configurable: true,
});
const adapter = await gpu.requestAdapter();
if (!adapter) {
	console.log("SKIP ransac-dawn: no adapter");
	process.exit(0);
}
const device = (await attachWebGPUDevice(
	await adapter.requestDevice({
		requiredFeatures: COMPUTE_FEATURES.filter((f) => adapter.features.has(f)),
	}),
	{ id: "ransac-dawn" },
	true,
)) as Device;
// the async solvers resolve their device through getComputeDevice(): hand them this one
const { adoptRenderDevice } = await import("../../src/lib/gpu/device");
adoptRenderDevice(device);

let failed = 0;
const check = (ok: boolean, msg: string) => {
	if (!ok) failed++;
	console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
};

let seed = 7;
const rnd = () => {
	seed = (seed * 16807) % 2147483647;
	return seed / 2147483647;
};

async function compareBatch(label: string, batch: HypothesisBatch) {
	const t0 = performance.now();
	const g = await scoreBatchGpu(device, batch);
	const t1 = performance.now();
	const c = scoreBatchCpu(batch);
	const t2 = performance.now();
	const gs =
		g.index >= 0
			? scoreHypothesis(batch, g.index)
			: { count: -1, cost: Number.NaN };
	const ok =
		batch.mode === "reproj"
			? Math.abs(gs.cost - c.cost) <= 1e-4 * Math.max(1, c.cost)
			: gs.count === c.count &&
				(g.index === c.index || Math.abs(g.count - c.count) <= 1);
	check(
		ok,
		`${label}: K=${batch.count} N=${batch.n} gpu k=${g.index} (${gs.count}, ${gs.cost.toFixed(2)}) cpu k=${c.index} (${c.count}, ${c.cost.toFixed(2)})  gpu ${(t1 - t0).toFixed(1)} ms, cpu ${(t2 - t1).toFixed(1)} ms`,
	);
}

// --- raw batches ---
for (const [K, N] of [
	[1, 3],
	[333, 50],
	[2000, 1500],
	[70000, 64],
]) {
	const s = synthRotation(N, 0.4, rnd);
	const hyps = new Float64Array(K * HYP_STRIDE);
	const pick = new Int32Array(2);
	const R = new Float64Array(9);
	for (let k = 0; k < K; k++) {
		pick[0] = Math.floor(rnd() * N);
		pick[1] = (pick[0] + 1 + Math.floor(rnd() * (N - 1))) % N;
		kabsch(s.b0, s.b1, pick, R);
		hyps.set(R, k * HYP_STRIDE);
	}
	await compareBatch("chord", {
		mode: "chord",
		hyps,
		count: K,
		a: s.b0,
		b: s.b1,
		n: N,
		thr2: chord2OfAngle(0.004),
	});
}
for (const [K, N] of [
	[500, 800],
	[15000, 400],
]) {
	const s = synthAbsolute(N, 0.4, rnd);
	const hyps = new Float64Array(K * HYP_STRIDE);
	for (let k = 0; k < K; k++) {
		const R = expSO3(
			...(Array.from({ length: 3 }, () => (rnd() - 0.5) * 0.02) as [
				number,
				number,
				number,
			]),
		);
		const Rk = new Float64Array(9);
		for (let r = 0; r < 3; r++)
			for (let c = 0; c < 3; c++)
				Rk[r * 3 + c] =
					R[r * 3] * s.R[c] +
					R[r * 3 + 1] * s.R[3 + c] +
					R[r * 3 + 2] * s.R[6 + c];
		const o = k * HYP_STRIDE;
		hyps.set(Rk, o);
		hyps[o + 9] = s.t[0] + (rnd() - 0.5) * 20;
		hyps[o + 10] = s.t[1] + (rnd() - 0.5) * 20;
		hyps[o + 11] = s.t[2] + (rnd() - 0.5) * 20;
		hyps[o + 12] = hyps[o + 13] = s.f * (0.95 + rnd() * 0.1);
		hyps[o + 14] = chord2OfAngle(6 / hyps[o + 12]);
	}
	// reproj on raw (uncentred) points, f32 must still cope
	const obs = new Float64Array(N * 2);
	for (let i = 0; i < N; i++) {
		obs[i * 2] = s.p2[i * 2] - s.cx;
		obs[i * 2 + 1] = s.p2[i * 2 + 1] - s.cy;
	}
	await compareBatch("reproj", {
		mode: "reproj",
		hyps,
		count: K,
		a: s.p3,
		b: obs,
		n: N,
		thr2: 36,
	});
	const dirs = new Float64Array(N * 3);
	for (let i = 0; i < N; i++) {
		const d = [0, 1, 2].map((k) => s.p3[i * 3 + k] - s.eye[k]);
		const l = Math.hypot(...d);
		for (let k = 0; k < 3; k++) dirs[i * 3 + k] = d[k] / l;
	}
	await compareBatch("angular", {
		mode: "angular",
		hyps,
		count: K,
		a: dirs,
		b: obs,
		n: N,
		thr2: 0,
	});
}

// --- end to end ---
{
	const s = synthRotation(1500, 0.5, rnd);
	const a = rotationRansac(s.b0, s.b1, { maxChord: 0.004 });
	const paths: string[] = [];
	const g = await rotationRansacAsync(s.b0, s.b1, {
		maxChord: 0.004,
		gpu: "on",
		onBatch: (p) => paths.push(p),
	});
	check(
		!!a &&
			!!g &&
			paths[0] === "gpu" &&
			rotationDistanceDeg(a.R, g.R) < 0.05 &&
			rotationDistanceDeg(g.R, s.R) < 0.05,
		`rotationRansacAsync: path ${paths.join(",")}, Δsync ${a && g ? rotationDistanceDeg(a.R, g.R).toFixed(4) : "?"}°, inliers ${g?.inlierCount} vs ${a?.inlierCount}`,
	);
}
{
	const s = synthAbsolute(1000, 0.5, rnd);
	const cam = { fx: s.f, fy: s.f, cx: s.cx, cy: s.cy };
	const a = absolutePoseRansac(s.p2, s.p3, cam, { maxReprojErrorPx: 6 });
	const paths: string[] = [];
	const g = await absolutePoseRansacAsync(s.p2, s.p3, cam, {
		maxReprojErrorPx: 6,
		gpu: "on",
		onBatch: (p) => paths.push(p),
	});
	check(
		!!a &&
			!!g &&
			paths.includes("gpu") &&
			rotationDistanceDeg(a.R, g.R) < 0.05 &&
			rotationDistanceDeg(g.R, s.R) < 0.05,
		`absolutePoseRansacAsync: ${paths.length} batches, Δsync ${a && g ? rotationDistanceDeg(a.R, g.R).toFixed(4) : "?"}°, inliers ${g?.inlierCount} vs ${a?.inlierCount}`,
	);
	const dirs = new Float64Array(s.p3.length);
	for (let i = 0; i < dirs.length; i++) dirs[i] = s.p3[i] - s.eye[i % 3];
	const camOff = { ...cam, fx: s.f * 1.05, fy: s.f * 1.05 };
	const c = cameraRotationRansac(s.p2, dirs, camOff, { focal: "free" });
	const cg = await cameraRotationRansacAsync(s.p2, dirs, camOff, {
		focal: "free",
		gpu: "on",
	});
	check(
		!!c &&
			!!cg &&
			rotationDistanceDeg(c.R, cg.R) < 0.05 &&
			Math.abs(cg.focal / s.f - 1) < 0.01,
		`cameraRotationRansacAsync: Δsync ${c && cg ? rotationDistanceDeg(c.R, cg.R).toFixed(4) : "?"}°, focal ${cg?.focal.toFixed(1)} (true ${s.f}), inliers ${cg?.inlierCount} vs ${c?.inlierCount}`,
	);
}

console.log(failed ? `${failed} FAILED` : "all ok");
device.destroy();
process.exit(failed ? 1 : 0);
