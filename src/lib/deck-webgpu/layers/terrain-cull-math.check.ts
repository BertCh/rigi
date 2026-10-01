// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Node check for the batched terrain's GPU cull math (terrain-cull-math.ts, terrain-cull.wgsl.ts),
// no GPU. Run: npx tsx src/lib/deck-webgpu/layers/terrain-cull-math.check.ts
//   1. conservative: on random and adversarial (on-plane ± ε) spheres, every sphere the CPU cull
//      keeps (camera.ts sphereInView on the padded sphere, f64, BatchedTerrainCore.visibleRows'
//      test) is kept by the f32 twin of the WGSL in_view on the packed f32 inputs
//   2. tight: the twin keeps few extras on random spheres (reported; bounded)
//   3. order: the compaction twin gives visibleRows' groups (seg order = first visible tile) and rows
//   4. layout: both WGSL entry points parse (luma's WGSL reflection) with the kernels' binding
//      layouts, and the packed uniform block is 80 B with n in word 19
import { getShaderLayoutFromWGSL } from "@luma.gl/webgpu";
import type { Vec3 } from "#/lib/ontology/core/geometry";
import { type CameraUniforms, cameraUniforms, sphereInView } from "../camera";
import { COMPACT_KERNEL, CULL_KERNEL } from "./terrain-cull";
import { CULL_SLOTS, RECORD_WORDS } from "./terrain-cull.wgsl";
import {
	type CullCandidate,
	compactTwin,
	inViewF32,
	packCandidates,
	packCullParams,
	padRadius,
	unpackParams,
} from "./terrain-cull-math";

let failures = 0;
const fail = (msg: string) => {
	failures++;
	if (failures <= 20) console.error(`FAIL ${msg}`);
};

// deterministic PRNG (mulberry32)
let seed = 0x5eed1e5;
const rnd = () => {
	seed = (seed + 0x6d2b79f5) | 0;
	let t = seed;
	t = Math.imul(t ^ (t >>> 15), t | 1);
	t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const range = (a: number, b: number) => a + (b - a) * rnd();
const unit = (): Vec3 => {
	for (;;) {
		const v: Vec3 = [range(-1, 1), range(-1, 1), range(-1, 1)];
		const l = Math.hypot(...v);
		if (l > 0.1 && l <= 1) return [v[0] / l, v[1] / l, v[2] / l];
	}
};

function randomCamera(): CameraUniforms {
	const forward = unit();
	return cameraUniforms({
		eye: [range(-150e3, 150e3), range(-150e3, 150e3), range(0, 5000)],
		forward,
		up: unit(),
		vfov: range(5, 100),
		width: Math.round(range(200, 4000)),
		height: Math.round(range(200, 3000)),
		near: rnd() < 0.5 ? 1 : range(0.3, 5),
		offset: rnd() < 0.3 ? [range(-1, 1), range(-1, 1)] : undefined,
	});
}

/** The kernel's view of one tile: packed (f32) params and candidate. */
function gpuKeeps(u: CameraUniforms, sphere: [number, number, number, number]) {
	const p = unpackParams(packCullParams(u, 1));
	const c = new Float32Array(
		packCandidates([{ sphere, row: 0, seg: 0 }] satisfies CullCandidate[]),
	);
	return inViewF32(p, [c[0], c[1], c[2], c[3]]);
}
const cpuKeeps = (u: CameraUniforms, s: [number, number, number, number]) =>
	sphereInView(u, [s[0], s[1], s[2], padRadius(s[3])]);

/** ENU centre at camera-frame (x, y, z). */
const at = (u: CameraUniforms, x: number, y: number, z: number): Vec3 => [
	u.eye[0] + x * u.right[0] + y * u.up[0] + z * u.forward[0],
	u.eye[1] + x * u.right[1] + y * u.up[1] + z * u.forward[1],
	u.eye[2] + x * u.right[2] + y * u.up[2] + z * u.forward[2],
];

// ---- 1 + 2: random spheres ------------------------------------------------------------------------
let kept = 0;
let extra = 0;
let total = 0;
for (let c = 0; c < 400; c++) {
	const u = randomCamera();
	for (let i = 0; i < 500; i++) {
		const r = rnd() < 0.2 ? range(0, 50) : range(50, 20e3);
		const s: [number, number, number, number] = [
			u.eye[0] + range(-200e3, 200e3),
			u.eye[1] + range(-200e3, 200e3),
			range(-500, 4500),
			r,
		];
		const cpu = cpuKeeps(u, s);
		const gpu = gpuKeeps(u, s);
		total++;
		if (cpu) kept++;
		if (cpu && !gpu) fail(`random: CPU keeps, GPU culls ${JSON.stringify(s)}`);
		if (gpu && !cpu) extra++;
	}
}
console.log(
	`random: ${total} spheres, CPU keeps ${kept}, GPU extra ${extra} (${((100 * extra) / total).toFixed(4)} %)`,
);
if (extra > total * 1e-3) fail(`random: too many extras (${extra})`);

// ---- 1: adversarial, centred on a cull plane ± ε --------------------------------------------------
let adv = 0;
let advExtra = 0;
const EPS = [0, 1e-12, 1e-9, 1e-7, 1e-6, 1e-5, 1e-4, 1e-3, 1e-2, 0.1, 1];
for (let c = 0; c < 300; c++) {
	const u = randomCamera();
	const kx = Math.sqrt(1 + u.tanHalfX ** 2);
	const ky = Math.sqrt(1 + u.tanHalfY ** 2);
	const ox = u.offset[0] * u.tanHalfX;
	const oy = u.offset[1] * u.tanHalfY;
	for (let i = 0; i < 60; i++) {
		const r = rnd() < 0.3 ? range(0, 20) : range(20, 15e3);
		const rp = padRadius(r);
		const z = rnd() < 0.2 ? range(-rp, u.near) : range(u.near, 200e3);
		const plane = Math.floor(rnd() * 5);
		for (const e of EPS)
			for (const sign of [-1, 1]) {
				let x = range(-0.5, 0.5) * u.tanHalfX * Math.max(z, 1);
				let y = range(-0.5, 0.5) * u.tanHalfY * Math.max(z, 1);
				let zz = z;
				const d = sign * e * (1 + Math.abs(z));
				if (plane === 0) zz = u.near - rp + d;
				else if (plane === 1) x = u.tanHalfX * z + rp * kx - ox * z + d;
				else if (plane === 2) x = -(u.tanHalfX * z + rp * kx) - ox * z - d;
				else if (plane === 3) y = u.tanHalfY * z + rp * ky - oy * z + d;
				else y = -(u.tanHalfY * z + rp * ky) - oy * z - d;
				const p = at(u, x, y, zz);
				const s: [number, number, number, number] = [p[0], p[1], p[2], r];
				const cpu = cpuKeeps(u, s);
				const gpu = gpuKeeps(u, s);
				adv++;
				if (cpu && !gpu)
					fail(
						`adversarial plane ${plane} ε ${sign * e}: CPU keeps, GPU culls`,
					);
				if (gpu && !cpu) advExtra++;
			}
	}
}
console.log(`adversarial: ${adv} on-plane spheres, GPU extra ${advExtra}`);

// ---- 3: compaction order = visibleRows' groups ----------------------------------------------------
const SEGS = [64, 128, 256];
for (let trial = 0; trial < 2000; trial++) {
	const n = 1 + Math.floor(rnd() * 600);
	const segValues: number[] = [];
	const cands: CullCandidate[] = [];
	const segVal: number[] = [];
	for (let i = 0; i < n; i++) {
		const v = SEGS[Math.floor(rnd() * SEGS.length)];
		if (!segValues.includes(v)) segValues.push(v);
		cands.push({
			sphere: [0, 0, 0, 1],
			row: Math.floor(rnd() * 1e4),
			seg: segValues.indexOf(v),
		});
		segVal.push(v);
	}
	const vis = cands.map(() => rnd() < (trial % 3 === 0 ? 0.05 : 0.6));
	// visibleRows: Map<seg value, rows> in insertion order
	const groups = new Map<number, number[]>();
	cands.forEach((c, i) => {
		if (!vis[i]) return;
		const g = groups.get(segVal[i]);
		if (g) g.push(c.row);
		else groups.set(segVal[i], [c.row]);
	});
	const segs = segValues.map((_, k) => ({
		indexCount: 100 + k,
		firstIndex: 1000 * k,
	}));
	const out = compactTwin(cands, vis, segs);
	const want = [...groups.entries()];
	for (let s = 0; s < CULL_SLOTS; s++) {
		const got = out.slots[s];
		const w = want[s];
		const rec = [
			...out.args.subarray(s * RECORD_WORDS, (s + 1) * RECORD_WORDS),
		];
		if (!w) {
			if (got.seg !== -1 || got.rows.length || rec.some((x) => x !== 0))
				fail(`order trial ${trial}: slot ${s} should be empty`);
			continue;
		}
		const k = segValues.indexOf(w[0]);
		if (got.seg !== k)
			fail(`order trial ${trial}: slot ${s} seg ${got.seg} ≠ ${k}`);
		if (got.rows.join() !== w[1].join())
			fail(`order trial ${trial}: slot ${s} rows differ`);
		if (
			rec.join() !==
			[segs[k].indexCount, w[1].length, segs[k].firstIndex, 0, 0].join()
		)
			fail(`order trial ${trial}: slot ${s} record ${rec}`);
	}
}

// ---- 4: WGSL layouts ------------------------------------------------------------------------------
for (const k of [CULL_KERNEL, COMPACT_KERNEL]) {
	const b = (getShaderLayoutFromWGSL(k.source)?.bindings ?? []).map((x) => [
		x.name,
		x.type,
		x.location,
	]);
	const want = k.layout.map(([name, kind], i) => [name, kind, i]);
	if (JSON.stringify(b) !== JSON.stringify(want))
		fail(
			`${k.id}: WGSL bindings ${JSON.stringify(b)} ≠ layout ${JSON.stringify(want)}`,
		);
}
{
	const u = randomCamera();
	const buf = packCullParams(u, 1234);
	if (buf.byteLength !== 80) fail(`params ${buf.byteLength} B ≠ 80`);
	if (new Uint32Array(buf)[19] !== 1234) fail("params: n not in word 19");
	if (unpackParams(buf).near !== Math.fround(u.near)) fail("params: near");
}

if (failures) {
	console.error(`terrain-cull-math: ${failures} failure(s)`);
	process.exit(1);
}
console.log("terrain-cull-math: OK");
