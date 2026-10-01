// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Self-contained checks for the roll-spot core. Run: npx tsx src/lib/nearfield/roll/spot.check.ts
// Exits 1 when any check fails (prints every failure).
import type { Pose } from "../../camera";
import { intrinsicsFromPose } from "../geom";
import { camToEnuMatrix } from "../lift";
import { type GaussianCloud, type NearFieldDepth, PixelClass } from "../types";
import { spotColmap } from "./colmap-spot";
import {
	fuseSpot,
	jointPlacement,
	multiviewPoses,
	nearestRotation,
	regridDepth,
	type SpotView,
	toEnuMatrix,
} from "./spot";
import { voxelMerge } from "./voxel";

let failed = 0;
function ok(cond: boolean, msg: string) {
	if (!cond) {
		failed++;
		console.error(`FAIL ${msg}`);
	} else console.log(`ok   ${msg}`);
}
const near = (a: number, b: number, eps: number) => Math.abs(a - b) <= eps;

function cloud(pts: number[][], std: number, src?: number): GaussianCloud {
	const n = pts.length;
	return {
		count: n,
		frame: "enu",
		positions: Float32Array.from(pts.flat()),
		scales: new Float32Array(3 * n).fill(std),
		rotations: Float32Array.from(pts.flatMap(() => [1, 0, 0, 0])),
		colors: new Uint8Array(4 * n).fill(200),
		provenance: new Uint8Array(n).fill(1),
		...(src !== undefined ? { source: new Uint16Array(n).fill(src) } : {}),
	};
}

// ---- voxel merge ----
{
	const grid: number[][] = [];
	for (let i = 0; i < 20; i++)
		for (let j = 0; j < 20; j++) grid.push([i * 0.1, j * 0.1, 5]);
	const a = cloud(grid, 0.03);
	const same = voxelMerge([a, a]);
	ok(
		same.stats.kept === grid.length,
		`identical second view fully deduped (${same.stats.kept}/${2 * grid.length})`,
	);
	ok(
		same.stats.perSource[0].kept + same.stats.perSource[1].kept === grid.length,
		"per-source counts add up",
	);
	const far = cloud(
		grid.map(([x, y, z]) => [x + 10, y, z]),
		0.03,
	);
	const disjoint = voxelMerge([a, far]);
	ok(disjoint.stats.kept === 2 * grid.length, "disjoint views keep everything");
	const self = voxelMerge([a]);
	ok(
		self.stats.kept === grid.length,
		"one source never suppresses itself (adjacent blocks)",
	);
	// a coarse view over a fine one: the coarse splats covering the fine patch go
	const coarse: number[][] = [];
	for (let i = 0; i < 10; i++)
		for (let j = 0; j < 10; j++) coarse.push([i * 0.4, j * 0.4, 5]);
	const mix = voxelMerge([a, cloud(coarse, 0.12)]);
	const keptCoarse = mix.stats.perSource[1].kept;
	ok(
		keptCoarse < 100 && keptCoarse > 40,
		`coarse splats over the fine patch dropped, others kept (${keptCoarse}/100)`,
	);
	ok(
		mix.cloud.source !== undefined &&
			mix.cloud.source.length === mix.cloud.count,
		"merged cloud carries source",
	);
}

// ---- regrid (DA3 square centre crop of a 4:3 photo) ----
{
	const w = 30;
	const h = 30;
	const d: NearFieldDepth = {
		width: w,
		height: h,
		depth: new Float32Array(w * h).map((_, k) => 1 + (k % w)),
		valid: new Uint8Array(w * h).fill(1),
		intrinsicsNorm: { fx: 1, fy: 1, cx: 0.5, cy: 0.5 },
		model: "t",
		seconds: 0,
	};
	const r = regridDepth(d, 4 / 3, 40);
	ok(r.width === 40 && r.height === 30, `regrid size ${r.width}x${r.height}`);
	ok(
		r.valid[15 * 40 + 1] === 0 && r.valid[15 * 40 + 38] === 0,
		"cells outside the crop are invalid",
	);
	ok(
		r.valid[15 * 40 + 20] === 1 && near(r.depth[15 * 40 + 20], 16, 1),
		"centre cell maps to the crop centre",
	);
	ok(
		near(r.intrinsicsNorm?.fx ?? 0, 0.75, 1e-9) &&
			near(r.intrinsicsNorm?.fy ?? 0, 1, 1e-9),
		"crop intrinsics in photo units",
	);
	ok(regridDepth(r, 4 / 3) === r, "same aspect: unchanged");
}

// ---- poses: multiview c2w matches camToEnuMatrix, colmap round trip of the eye ----
{
	const pose: Pose = { yaw: 30, pitch: -5, roll: 2, vfov: 50 };
	const mv = multiviewPoses(
		[{ pose, eye: [10, 20, 30], aspect: 1.5 }],
		[10, 20, 0],
	);
	const m = camToEnuMatrix(pose);
	const c = mv.c2w[0];
	ok(
		near(c[0], m[0], 1e-12) &&
			near(c[6], m[5], 1e-12) &&
			c[3] === 0 &&
			c[11] === 30,
		"multiview c2w = [camToEnu | eye − origin]",
	);
	const cm = spotColmap(
		[{ id: "A", pose, eye: [110, 220, 1930], width: 300, height: 200 }],
		null,
		[100, 200, 1900],
		{ lat: 46.7, lon: 7.7, h: 0 },
	);
	const line = cm["images.txt"].split("\n").find((l) => l.startsWith("1 "));
	const t = (line ?? "").split(" ").slice(1, 8).map(Number);
	// camera centre C = −Rᵀ t with R from the quaternion
	const [qw, qx, qy, qz] = t;
	const R = [
		1 - 2 * (qy * qy + qz * qz),
		2 * (qx * qy - qw * qz),
		2 * (qx * qz + qw * qy),
		2 * (qx * qy + qw * qz),
		1 - 2 * (qx * qx + qz * qz),
		2 * (qy * qz - qw * qx),
		2 * (qx * qz - qw * qy),
		2 * (qy * qz + qw * qx),
		1 - 2 * (qx * qx + qy * qy),
	];
	const C = [0, 1, 2].map(
		(k) => -(R[k] * t[4] + R[3 + k] * t[5] + R[6 + k] * t[6]),
	);
	ok(
		near(C[0], 10, 1e-6) && near(C[1], 20, 1e-6) && near(C[2], 30, 1e-6),
		`COLMAP camera centre = eye − origin (${C.map((x) => x.toFixed(3))})`,
	);
}

// ---- joint placement recovers a similarity ----
{
	const poses: Pose[] = [
		{ yaw: 10, pitch: -3, roll: 1, vfov: 50 },
		{ yaw: 40, pitch: -6, roll: -2, vfov: 50 },
	];
	const eyes: [number, number, number][] = [
		[0, 0, 0],
		[3, 1, 0.2],
	];
	// model frame = ENU rotated by a known Q0ᵀ about the first camera, scaled by 1/s0
	const s0 = 7;
	const a = (25 * Math.PI) / 180;
	const Q0 = [
		Math.cos(a),
		-Math.sin(a),
		0,
		Math.sin(a),
		Math.cos(a),
		0,
		0,
		0,
		1,
	];
	const Q0t = [Q0[0], Q0[3], Q0[6], Q0[1], Q0[4], Q0[7], Q0[2], Q0[5], Q0[8]];
	const mul = (x: number[], y: number[]) =>
		[0, 1, 2].flatMap((i) =>
			[0, 1, 2].map(
				(j) =>
					x[3 * i] * y[j] + x[3 * i + 1] * y[3 + j] + x[3 * i + 2] * y[6 + j],
			),
		);
	const cams = poses.map((p, i) => {
		const Rm = mul(Q0t, camToEnuMatrix(p));
		const c = [0, 1, 2].map(
			(k) =>
				(Q0t[3 * k] * eyes[i][0] +
					Q0t[3 * k + 1] * eyes[i][1] +
					Q0t[3 * k + 2] * eyes[i][2]) /
				s0,
		);
		return {
			c2w: [
				Rm[0],
				Rm[1],
				Rm[2],
				c[0],
				Rm[3],
				Rm[4],
				Rm[5],
				c[1],
				Rm[6],
				Rm[7],
				Rm[8],
				c[2],
				0,
				0,
				0,
				1,
			],
			intrinsicsNorm: intrinsicsFromPose(p, 1),
		};
	});
	// flat ground 2 m below: DEM range per pixel, model depth = range / s0 (z-depth)
	const W = 40;
	const views: SpotView[] = [];
	const depths: NearFieldDepth[] = [];
	for (const [i, p] of poses.entries()) {
		const K = intrinsicsFromPose(p, 1);
		const M = camToEnuMatrix(p);
		const range = new Float32Array(W * W);
		const dz = new Float32Array(W * W);
		for (let j = 0; j < W; j++)
			for (let k = 0; k < W; k++) {
				const x = ((k + 0.5) / W - 0.5) / K.fx;
				const y = ((j + 0.5) / W - 0.5) / K.fy;
				const dirz = M[6] * x + M[7] * y + M[8];
				const t = dirz < -1e-3 ? -20 / dirz : Number.NaN; // ground 20 m below
				const len = Math.sqrt(1 + x * x + y * y);
				range[j * W + k] = Number.isFinite(t) ? t * len : 0;
				dz[j * W + k] = Number.isFinite(t) ? t / s0 : 0;
			}
		views.push({
			id: `v${i}`,
			pose: p,
			eye: eyes[i],
			aspect: 1,
			photo: { width: W, height: W, data: new Uint8Array(4 * W * W).fill(128) },
			range: { width: W, height: W, data: range },
		});
		depths.push({
			width: W,
			height: W,
			depth: dz,
			valid: dz.map((v) => (v > 0 ? 1 : 0)) as unknown as Uint8Array,
			intrinsicsNorm: K,
			model: "t",
			seconds: 0,
		});
	}
	const jp = jointPlacement(views, depths, cams);
	ok(!!jp, "joint placement fits");
	if (jp) {
		ok(near(jp.scale, s0, 0.05 * s0), `scale ${jp.scale.toFixed(3)} ≈ ${s0}`);
		ok(Math.max(...jp.rotErrDeg) < 0.01, "rotations recovered");
		ok(
			Math.max(...jp.eyeShiftM) < 0.05 * s0,
			`eyes recovered (${jp.eyeShiftM.map((x) => x.toFixed(3))})`,
		);
		for (const [i, v] of views.entries()) v.placement = jp.placements[i];
		const res = fuseSpot(views, depths, {
			keep: [PixelClass.Terrain, PixelClass.Object],
		});
		const zs = Array.from(
			{ length: res.cloud.count },
			(_, i) => res.cloud.positions[3 * i + 2],
		);
		const med = zs.sort((x, y) => x - y)[zs.length >> 1];
		ok(
			res.cloud.count > 0 && near(med, -20, 1),
			`jointly placed ground at z ${med?.toFixed(2)} ≈ −20`,
		);
		// regression: the joint fit must count as a fit in splitPixels (n ≥ nMin), else the split
		// ignores the model depth and nothing in front of the DEM ever becomes an Object
		ok(
			res.views.every((v) => v.anchor.n >= 200),
			"joint placement carries its sample count into the split",
		);
		const near3 = depths.map((d) => {
			const z = d.depth.slice();
			for (let j = 30; j < 36; j++)
				for (let k = 17; k < 23; k++) z[j * W + k] *= 0.3;
			return { ...d, depth: z };
		});
		const withObj = fuseSpot(views, near3, {
			keep: [PixelClass.Terrain, PixelClass.Object],
		});
		ok(
			withObj.views.every((v) => v.split.counts[PixelClass.Object] > 0),
			`joint split finds the near object (${withObj.views.map((v) => v.split.counts[PixelClass.Object])})`,
		);
	}
	const Rn = nearestRotation([2, 0.1, 0, -0.1, 2, 0, 0, 0, 2]);
	ok(
		near(Rn[0] * Rn[0] + Rn[1] * Rn[1] + Rn[2] * Rn[2], 1, 1e-9),
		"nearestRotation is orthonormal",
	);
	const e = toEnuMatrix(
		cloud([[0, 0, 1]], 0.1),
		camToEnuMatrix(poses[0]),
		[1, 2, 3],
	);
	ok(e.frame === "enu" && e.count === 1, "toEnuMatrix");
}

if (failed) {
	console.error(`${failed} check(s) failed`);
	process.exit(1);
}
console.log("all roll-spot checks passed");
