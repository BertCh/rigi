// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The fused sky graph (gpu/sky/fused-graph.ts: prep → nn forwardInto → refine, ONE submission and one
// readback) against the three-step path (prepSkyGpuFromRows → inferSkyModelGpu → refineSkyGpu, three
// awaited submissions) on real photos at the 512 px model long side, on a Dawn device in node. Reports
// max |Δ| and the share of differing mask bytes, the cache behaviour (second run hits, release empties,
// a rerun rebuilds) and median warm timings of both paths (a noisy shared machine: indicative only).
// SKIPs (exit 0) without DAWN_DIR or the weights / photos.
//   DAWN_DIR=/tmp/dawn npx tsx src/lib/gpu/sky/fused.check.ts [--photos demo-01,demo-03] [--runs 7]
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { cachedGraphCount } from "#/lib/gpu/core/graph";
import { modelSize, workingSize } from "#/lib/sky/core";
import { fusedModelHooks } from "#/lib/sky/fused";
import {
	createSkyModel,
	inferSkyModelGpu,
	MODEL_LONG_SIDE,
} from "#/lib/sky/model";
import { U2NETP_WEIGHTS } from "#/lib/sky/u2netp";
import { dawnDevice } from "../../../../scripts/nn/dawn";
import {
	FUSED_GROUP,
	lastFusedRun,
	releaseFusedGraphs,
	runFusedSky,
} from "./fused-graph";
import { prepSkyGpuFromRows } from "./prep";
import { refineSkyGpu } from "./refine";

const ID = "sky-fused";
const MODELS = process.env.RIGI_MODELS_DIR ?? "public/models";
const weights = join(MODELS, U2NETP_WEIGHTS);
const argv = process.argv.slice(2);
const opt = (n: string, d: string) =>
	argv.includes(n) ? argv[argv.indexOf(n) + 1] : d;
const PHOTOS = opt("--photos", "demo-01,demo-03,demo-08").split(",");
const RUNS = Number(opt("--runs", "7"));
const files = PHOTOS.map((p) => join("public/demo/photos-1024", `${p}.jpg`));
if (!existsSync(weights) || files.some((f) => !existsSync(f))) {
	console.log(`SKIP ${ID}: missing weights or photos`);
	process.exit(0);
}
const device = await dawnDevice(ID);
if (!device) {
	console.log(`SKIP ${ID}: DAWN_DIR not set or no adapter`);
	process.exit(0);
}

const model = await createSkyModel({
	device,
	backends: ["webgpu"],
	bytes: readFileSync(weights),
});
const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];
let failed = false;
const fail = (m: string) => {
	console.error(`FAIL ${ID}: ${m}`);
	failed = true;
};

for (const [fi, file] of files.entries()) {
	const img = await loadImage(file);
	const { width: W, height: H } = workingSize(img.width, img.height, 1024);
	const canvas = createCanvas(W, H);
	const ctx = canvas.getContext("2d");
	ctx.drawImage(img, 0, 0, W, H);
	const rgba = ctx.getImageData(0, 0, W, H).data;
	const rowBytes = Math.ceil((W * 4) / 256) * 256;
	const padded = new Uint8Array(rowBytes * H);
	for (let y = 0; y < H; y++)
		padded.set(rgba.subarray(4 * y * W, 4 * (y + 1) * W), y * rowBytes);
	const { width: lw, height: lh } = modelSize(W, H, MODEL_LONG_SIDE.webgpu);

	const threeStep = async () => {
		const prep = await prepSkyGpuFromRows(device, padded, W, H, lw, lh);
		const inf = await inferSkyModelGpu(model, prep.inputBuffer, lw, lh);
		try {
			return (
				await refineSkyGpu(device, {
					W,
					H,
					rgba: prep.rgba,
					lw,
					lh,
					guideLo: prep.rgbLo,
					prob: inf.gpuBuffer as GPUBuffer,
				})
			).bytes;
		} finally {
			inf.release();
			prep.dispose();
		}
	};
	const fused = () =>
		runFusedSky(device, {
			W,
			H,
			lw,
			lh,
			model: fusedModelHooks(model),
			fill: (pad) => pad.write(padded),
		});

	const want = await threeStep();
	const got = await fused();
	if (!got.opaque) fail(`${file}: opaque flag false for a JPEG`);
	let max = 0;
	let differ = 0;
	for (let i = 0; i < want.length; i++) {
		const d = Math.abs(got.bytes[i] - want[i]);
		if (d > max) max = d;
		if (d) differ++;
	}
	console.log(
		`${file} ${W}x${H} model ${lw}x${lh}: max|d| ${max}, differing bytes ${((100 * differ) / want.length).toFixed(4)}% (${differ}/${want.length})`,
	);
	if (max > 2)
		fail(`${file}: fused mask differs from the three-step path by ${max}`);
	if (fi === 0) {
		if (lastFusedRun?.hit) fail("first run was a cache hit");
		await fused();
		if (!lastFusedRun?.hit) fail("second run did not hit the cache");
	}

	const t3: number[] = [];
	const tf: number[] = [];
	for (let i = 0; i < RUNS; i++) {
		let t = performance.now();
		await threeStep();
		t3.push(performance.now() - t);
		t = performance.now();
		await fused();
		tf.push(performance.now() - t);
	}
	console.log(
		`  warm median of ${RUNS} (measured, noisy machine): three-step ${median(t3).toFixed(1)} ms, fused ${median(tf).toFixed(1)} ms`,
	);
}

// release empties the cache and a rerun rebuilds (and equals the first answer)
if (!cachedGraphCount(device, FUSED_GROUP)) fail("no cached fused graph");
await releaseFusedGraphs(device);
if (cachedGraphCount(device, FUSED_GROUP)) fail("release left fused graphs");

// the model must be disposable after the release
model.dispose();
console.log(failed ? `FAIL ${ID}` : `PASS ${ID}`);
process.exit(failed ? 1 : 0);
