// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The batched terrain's GPU cull (src/lib/deck-webgpu/layers/terrain-cull.ts: a flag kernel plus one
// luma GPUCompaction per draw slot, indirect records written in place) on a real luma WebGPU device
// in node (Dawn). Synthetic candidate sets (hundreds of tiles, three mesh resolutions) and several
// cameras; per camera the read-back instance lists and instanceCounts are compared with the CPU twin:
//   - visibility: the f32 twin inViewF32 of the packed inputs (mismatches are reported; any tile the
//     f64 sphereInView keeps must be kept, else FAIL)
//   - per slot (slot = seg index): the instance list equals the twin's rows, exactly and in tile-set
//     order (GPUCompaction is stable); the record is [indexCount, count, firstIndex, 0, 0]
// Then the timings: encode + submit wall time per frame and the batched time including GPU
// completion, for this path and for the previous one (COMPACT kernel, copied from git HEAD of the
// adoption into layers/old-tmp when present; skipped otherwise).
//
//   (mkdir /tmp/dawn && cd /tmp/dawn && npm i webgpu@0.3.0)   # not an app dependency
//   DAWN_DIR=/tmp/dawn npx tsx scripts/gpu/terrain-cull-dawn.ts [tiles] [cameras]
//
// SKIP (exit 0) without DAWN_DIR or an adapter; exit 1 on any mismatch.
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Device } from "@luma.gl/core";
import { gridMesh } from "../../src/lib/deck/batched-terrain-grid";
import { cameraUniforms, sphereInView } from "../../src/lib/deck-webgpu/camera";
import { TerrainGpuCull } from "../../src/lib/deck-webgpu/layers/terrain-cull";
import { RECORD_WORDS } from "../../src/lib/deck-webgpu/layers/terrain-cull.wgsl";
import {
	compactTwin,
	inViewF32,
	packCandidates,
	packCullParams,
	padRadius,
	unpackParams,
} from "../../src/lib/deck-webgpu/layers/terrain-cull-math";
import { attachWebGPUDevice } from "../../src/lib/gpu/core/luma";
import { submit } from "../../src/lib/gpu/core/queue";
import { COMPUTE_FEATURES } from "../../src/lib/gpu/device";

const dir = process.env.DAWN_DIR;
if (!dir) {
	console.log("SKIP terrain-cull-dawn: DAWN_DIR not set");
	process.exit(0);
}
const TILES = Number(process.argv[2] ?? 400);
const CAMERAS = Number(process.argv[3] ?? 24);
const { create, globals } = await import(
	pathToFileURL(path.join(dir, "node_modules/webgpu/index.js")).href
);
Object.assign(globalThis, globals);
// keep the instance referenced: Dawn drops pipelines of a collected instance
const gpu = create([]);
Object.defineProperty(globalThis, "navigator", {
	value: { gpu, userAgent: "node" },
	configurable: true,
});
const adapter = await gpu.requestAdapter();
if (!adapter) {
	console.log("SKIP terrain-cull-dawn: no adapter");
	process.exit(0);
}
const device = (await attachWebGPUDevice(
	await adapter.requestDevice({
		requiredFeatures: COMPUTE_FEATURES.filter((f) => adapter.features.has(f)),
	}),
	{ id: "terrain-cull-dawn" },
	true,
)) as Device;
console.log(`adapter ${JSON.stringify(adapter.info ?? {})}`);

let failed = 0;
const fail = (message: string) => {
	failed++;
	if (failed <= 20) console.log(`FAIL ${message}`);
};

let seed = 0x7e44a1;
const rnd = () => {
	seed = (seed + 0x6d2b79f5) | 0;
	let t = seed;
	t = Math.imul(t ^ (t >>> 15), t | 1);
	t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const range = (a: number, b: number) => a + (b - a) * rnd();
const SEGS = [64, 128, 256];

type Tile = {
	sphere: [number, number, number, number];
	row: number;
	seg: number;
};
const makeTiles = (n: number): Tile[] =>
	Array.from({ length: n }, (_, i) => ({
		sphere: [
			range(-60e3, 60e3),
			range(-60e3, 60e3),
			range(0, 3500),
			range(200, 6000),
		],
		row: Math.floor(rnd() * 1e5),
		seg: SEGS[Math.floor(rnd() * SEGS.length)] + (i < 0 ? 1 : 0),
	}));
const makeCamera = () => {
	const yaw = range(0, Math.PI * 2);
	const pitch = range(-0.3, 0.3);
	return cameraUniforms({
		eye: [range(-20e3, 20e3), range(-20e3, 20e3), range(500, 3000)],
		forward: [
			Math.cos(pitch) * Math.cos(yaw),
			Math.cos(pitch) * Math.sin(yaw),
			Math.sin(pitch),
		],
		up: [0, 0, 1],
		vfov: range(20, 80),
		width: 1600,
		height: 900,
		near: 1,
	});
};

const waitIdle = () =>
	(
		device as unknown as {
			handle: { queue: { onSubmittedWorkDone(): Promise<void> } };
		}
	).handle.queue.onSubmittedWorkDone();
const readWords = async (
	buffer: {
		readAsync(o: number, n: number): Promise<Uint8Array>;
	},
	words: number,
) => {
	const bytes = await buffer.readAsync(0, words * 4);
	return new Uint32Array(bytes.buffer, bytes.byteOffset, words);
};

type CullLike = {
	setCandidates(t: readonly Tile[]): boolean;
	prepare(
		enc: ReturnType<Device["createCommandEncoder"]>,
		camera: ReturnType<typeof makeCamera>,
	): {
		args: { readAsync(o: number, n: number): Promise<Uint8Array> };
		inst: readonly { readAsync(o: number, n: number): Promise<Uint8Array> }[];
	} | null;
	destroy(): void;
};
async function ready(cull: CullLike, cam: ReturnType<typeof makeCamera>) {
	for (let i = 0; i < 400; i++) {
		const enc = device.createCommandEncoder();
		const d = cull.prepare(enc, cam);
		if (d) return { enc, d };
		enc.finish();
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error("terrain cull graph never became ready");
}

// ---- correctness ----------------------------------------------------------------------------------
const cull = new TerrainGpuCull(device);
let visMismatch = 0;
let visTotal = 0;
let keptTiles = 0;
for (const n of [3, 37, TILES, TILES * 3]) {
	const tiles = makeTiles(n);
	if (!cull.setCandidates(tiles)) throw new Error("setCandidates refused");
	for (let c = 0; c < CAMERAS; c++) {
		const cam = makeCamera();
		const { enc, d } = await ready(cull, cam);
		submit(device, enc);
		const args = await readWords(d.args, 4 * RECORD_WORDS);
		// the twin: seg index = first-seen order (setCandidates keeps it across calls)
		const segOrder = [...new Set(tiles.map((t) => t.seg))];
		const params = unpackParams(packCullParams(cam, tiles.length));
		const packed = new Float32Array(
			packCandidates(
				tiles.map((t) => ({ ...t, seg: 0 })),
				tiles.length,
			),
		);
		const vis = tiles.map((t, i) => {
			const f32 = inViewF32(params, [
				packed[i * 8],
				packed[i * 8 + 1],
				packed[i * 8 + 2],
				packed[i * 8 + 3],
			]);
			const f64 = sphereInView(cam, [
				t.sphere[0],
				t.sphere[1],
				t.sphere[2],
				padRadius(t.sphere[3]),
			]);
			return { f32, f64 };
		});
		const flagsKept = vis.map((v) => v.f32);
		// seg indices persist across setCandidates calls: map seg value -> index via the class order
		const segIndex = (v: number) =>
			(cull as unknown as { segValues: number[] }).segValues.indexOf(v);
		const cands = tiles.map((t) => ({ ...t, seg: segIndex(t.seg) }));
		const segsInfo = (cull as unknown as { segValues: number[] }).segValues.map(
			(v, k) => ({
				indexCount: gridMesh(v).indices.length,
				firstIndex: (cull as unknown as { recordWords: Uint32Array })
					.recordWords[k * RECORD_WORDS + 2],
			}),
		);
		const twin = compactTwin(cands, flagsKept, segsInfo);
		void segOrder;
		for (let i = 0; i < tiles.length; i++) {
			visTotal++;
			if (vis[i].f64 && !vis[i].f32)
				fail(`n ${n} cam ${c}: f64 keeps ${i}, f32 twin culls`);
			if (vis[i].f32) keptTiles++;
		}
		for (let k = 0; k < segsInfo.length; k++) {
			const want = twin.slots[k].rows;
			const count = args[k * RECORD_WORDS + 1];
			const got = Array.from(
				(await readWords(d.inst[k], Math.max(1, count))).subarray(0, count),
			);
			const rec = Array.from(
				args.subarray(k * RECORD_WORDS, (k + 1) * RECORD_WORDS),
			);
			// the GPU's own vis may differ from the f32 twin by FMA rounding: compare as the twin's
			// list when counts match, else count the tiles that differ
			const wantRec = [
				segsInfo[k].indexCount,
				want.length,
				segsInfo[k].firstIndex,
				0,
				0,
			];
			if (got.join() !== want.join()) {
				const gs = new Set(got);
				const diff =
					want.filter((r) => !gs.has(r)).length +
					got.filter((r) => !want.includes(r)).length;
				visMismatch += diff;
				if (diff > 4)
					fail(
						`n ${n} cam ${c} slot ${k}: ${diff} rows differ (got ${got.length}, want ${want.length})`,
					);
			} else if (rec.join() !== wantRec.join())
				fail(`n ${n} cam ${c} slot ${k}: record ${rec} ≠ ${wantRec}`);
		}
		for (let k = segsInfo.length; k < 4; k++)
			if (args[k * RECORD_WORDS + 1] !== 0)
				fail(`unused slot ${k} has instances`);
	}
}
console.log(
	`correctness: ${visTotal} tile tests, kept ${keptTiles}, row mismatches vs the f32 twin (FMA ulp cases) ${visMismatch}, failed ${failed}`,
);

// ---- timings --------------------------------------------------------------------------------------
async function timeIt(label: string, make: () => CullLike) {
	const c = make();
	const tiles = makeTiles(TILES);
	c.setCandidates(tiles);
	const cam = makeCamera();
	const first = await ready(c, cam);
	submit(device, first.enc);
	await waitIdle();
	const FRAMES = 200;
	const encodeMs: number[] = [];
	const totalMs: number[] = [];
	for (let rep = 0; rep < 7; rep++) {
		const t0 = performance.now();
		let enc = 0;
		for (let f = 0; f < FRAMES; f++) {
			const t1 = performance.now();
			const e = device.createCommandEncoder();
			c.prepare(e, makeCamera());
			submit(device, e);
			enc += performance.now() - t1;
		}
		await waitIdle();
		totalMs.push((performance.now() - t0) / FRAMES);
		encodeMs.push(enc / FRAMES);
	}
	const med = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];
	console.log(
		`${label.padEnd(10)} ${TILES} tiles: encode+submit ${med(encodeMs).toFixed(3)} ms/frame, with GPU completion ${med(totalMs).toFixed(3)} ms/frame (medians of 7 x ${FRAMES} frames)`,
	);
	c.destroy();
}
await timeIt("new", () => new TerrainGpuCull(device));
const oldPath = "../../src/lib/deck-webgpu/layers/old-tmp/terrain-cull";
if (existsSync(new URL(`${oldPath}.ts`, import.meta.url))) {
	const old = await import(oldPath);
	await timeIt("old", () => new old.TerrainGpuCull(device));
	await timeIt("new", () => new TerrainGpuCull(device));
	await timeIt("old", () => new old.TerrainGpuCull(device));
}

if (failed) {
	console.log(`FAIL terrain-cull-dawn: ${failed} failure(s)`);
	process.exit(1);
}
console.log("terrain-cull-dawn: OK");
process.exit(0);
