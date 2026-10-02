// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// ViTPose-B on src/lib/nn (./vitpose.ts) against PyTorch (transformers VitPoseForPoseEstimation), per layer and end
// to end. The reference is scripts/models/vitpose.py --dump-ref (fp32 forward of the fp16-rounded weights on the
// Step Inside demo photo, person box), written once to out/body/vitpose-ref/.
//
//   [DAWN_DIR=/tmp/dawn] npx tsx src/lib/body/vitpose.check.ts [--backend cpu|gpu]
//
// Tolerances: crop max |Δ| ≤ 1 u8 step (the processor rounds its warp to u8) on ≥ 99.9 % of values; relative L2
// ≤ 1e-3 per layer (fp32 kernels vs fp32 PyTorch); keypoints within 0.05 photo px of the reference and scores
// within 1e-3. SKIP (exit 0) without the weights (node scripts/models/fetch.mjs --only vitpose), without the
// reference and a Python with transformers to make it ($MODELS_PYTHON), or (gpu) without a Dawn adapter.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createNn, type Nn, type Tensor } from "#/lib/nn";
import {
	COCO17,
	cropPerson,
	cropWindow,
	decodeHeatmaps,
	heatmapToPhoto,
	VITPOSE_B,
	VitPose,
} from "./vitpose";

const skip = (why: string) => {
	console.log(`SKIP vitpose: ${why}`);
	process.exit(0);
};
const backend = process.argv.includes("--backend")
	? process.argv[process.argv.indexOf("--backend") + 1]
	: process.env.DAWN_DIR
		? "gpu"
		: "cpu";
const weights = path.join("public/models", VITPOSE_B.file);
if (!existsSync(weights)) skip(`${weights} missing`);
const REF_DIR = "out/body/vitpose-ref";
const refFile = path.join(REF_DIR, "ref.safetensors");
if (!existsSync(refFile)) {
	const py = process.env.MODELS_PYTHON;
	if (!py || !existsSync(py))
		skip("no reference and no $MODELS_PYTHON (with transformers) to make it");
	console.log("writing the PyTorch reference (once) …");
	execFileSync(
		py as string,
		[
			"scripts/models/vitpose.py",
			"--dump-ref",
			REF_DIR,
			"--safetensors",
			weights,
		],
		{ stdio: "inherit" },
	);
}

let device: import("@luma.gl/core").Device | undefined;
if (backend === "gpu") {
	const dir = process.env.DAWN_DIR;
	if (!dir) skip("--backend gpu needs DAWN_DIR");
	const { create, globals } = await import(
		pathToFileURL(path.join(dir as string, "node_modules/webgpu/index.js")).href
	);
	Object.assign(globalThis, globals);
	const gpu = create([]);
	Object.defineProperty(globalThis, "navigator", {
		value: { gpu, userAgent: "node" },
		configurable: true,
	});
	const adapter = await gpu.requestAdapter();
	if (!adapter) skip("no Dawn adapter");
	const { attachWebGPUDevice } = await import("#/lib/gpu/core/luma");
	const { COMPUTE_FEATURES } = await import("#/lib/gpu/device");
	device = (await attachWebGPUDevice(
		await adapter.requestDevice({
			requiredFeatures: COMPUTE_FEATURES.filter((f) => adapter.features.has(f)),
			requiredLimits: {
				maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
				maxBufferSize: adapter.limits.maxBufferSize,
			},
		}),
		{ id: "vitpose-check" },
		true,
	)) as import("@luma.gl/core").Device;
}
const nn: Nn = await createNn({
	backend: backend === "gpu" ? "gpu" : "cpu",
	...(device ? { device } : {}),
});
const ref = nn.weightsFromBytes(new Uint8Array(readFileSync(refFile)));
const refArr = (name: string) => nn.read(ref.get(name));

let failed = 0;
function relL2(have: Float32Array, want: Float32Array) {
	let num = 0;
	let den = 0;
	let maxAbs = 0;
	for (let i = 0; i < want.length; i++) {
		const d = have[i] - want[i];
		num += d * d;
		den += want[i] * want[i];
		maxAbs = Math.max(maxAbs, Math.abs(d));
	}
	return { rel: Math.sqrt(num / Math.max(den, 1e-30)), maxAbs };
}
async function compare(name: string, got: Tensor, tol = 1e-3) {
	const want = await refArr(name);
	const have = await nn.read(got);
	if (have.length !== want.length) {
		failed++;
		console.log(
			`FAIL ${name}: ${have.length} values, reference ${want.length}`,
		);
		return;
	}
	const { rel, maxAbs } = relL2(have, want);
	const bad = !(rel <= tol);
	if (bad) failed++;
	console.log(
		`${bad ? "FAIL" : "ok  "} ${name.padEnd(14)} rel L2 ${rel.toExponential(2)}  max |Δ| ${maxAbs.toExponential(2)}`,
	);
}

// 1. the crop (CPU) against the processor's pixel_values
const rgbT = ref.get("rgb");
const [H, W] = rgbT.shape;
const rgb = await refArr("rgb");
const box = await refArr("box");
const win = cropWindow(box[0], box[1], box[2], box[3]);
const crop = cropPerson({ width: W, height: H, data: rgb, channels: 3 }, win);
const pv = await refArr("pixel_values");
{
	const step = 1 / 255 / Math.min(...VITPOSE_B.std);
	let over = 0;
	let maxAbs = 0;
	for (let i = 0; i < pv.length; i++) {
		const d = Math.abs(crop[i] - pv[i]);
		maxAbs = Math.max(maxAbs, d);
		if (d > step * 1.01) over++;
	}
	const bad = over > 0.001 * pv.length;
	if (bad) failed++;
	console.log(
		`${bad ? "FAIL" : "ok  "} crop           max |Δ| ${(maxAbs / step).toFixed(2)} u8 steps, ${over} values over one step`,
	);
}

// 2. per layer from the reference pixel_values (eager on the CPU; one graph per stage on the GPU)
const t0 = performance.now();
const net = await VitPose.load(nn, { weights: "fp16" });
const [IH, IW] = VITPOSE_B.input;
const x = nn.fromArray(pv, [1, 3, IH, IW]);
const emb = await nn.forward(() => net.embed(x));
await compare("embeddings", emb);
let t = emb;
for (let i = 0; i < VITPOSE_B.depth; i++) {
	const prev = t;
	t = await nn.forward(() => net.block(prev, i));
	if (i === 0 || i === 5 || i === 11) await compare(`layer${i}`, t);
}
const feats = await nn.forward(() =>
	nn.layerNorm(
		t,
		net.weights.get("norm.weight"),
		net.weights.get("norm.bias"),
		1e-12,
	),
);
await compare("features", feats);
const hmT = await nn.forward(() => net.head(feats));
await compare("heatmaps", hmT, 2e-3);
const tLayers = performance.now() - t0;

// 3. end to end: one forward, decode, against the processor's post-processing
const t1 = performance.now();
const hmE = await nn.forward(() => net.network(x));
const heat = await nn.read(hmE);
const tNet = performance.now() - t1;
const [HH, HW] = VITPOSE_B.heatmap;
const d = decodeHeatmaps(heat, COCO17.length, HH, HW);
const kps = await refArr("keypoints");
const scores = await refArr("scores");
let maxPx = 0;
let maxScore = 0;
for (let k = 0; k < COCO17.length; k++) {
	const [px, py] = heatmapToPhoto(d.x[k], d.y[k], win);
	maxPx = Math.max(maxPx, Math.hypot(px - kps[2 * k], py - kps[2 * k + 1]));
	maxScore = Math.max(maxScore, Math.abs(d.score[k] - scores[k]));
}
const kpBad = !(maxPx <= 0.05 && maxScore <= 1e-3);
if (kpBad) failed++;
console.log(
	`${kpBad ? "FAIL" : "ok  "} keypoints      max |Δ| ${maxPx.toExponential(2)} px, score ${maxScore.toExponential(2)}`,
);
// warm run (graph cached on the GPU)
const t2 = performance.now();
const hmW = await nn.forward(() => net.network(x));
await nn.read(hmW);
const tWarm = performance.now() - t2;
console.log(
	`${nn.backend.kind} backend: per-layer pass ${(tLayers / 1000).toFixed(1)} s, forward ${tNet.toFixed(0)} ms (first), ${tWarm.toFixed(0)} ms (warm)`,
);
console.log(failed ? `${failed} failed` : "ok");
process.exit(failed ? 1 : 0);
