// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// MoGe-2 ViT-S on src/lib/nn (./depth-net.ts + ./compose.ts) against PyTorch, per layer and end to end.
// The reference is scripts/models/moge2-vits.py --dump-ref (fp32 forward of the fp16-rounded weights on
// demo-01 at 336 × 448, every intermediate the port mirrors), written once to out/nearfield/moge-ref/.
//
//   [DAWN_DIR=/tmp/dawn] npx tsx src/lib/nearfield/local/depth-net.check.ts [--backend cpu|gpu] [--full]
//
// On the CPU backend the whole network takes minutes (≈ 8 min here), so without --full the CPU run stops
// after the encoder (the gate's row); the GPU backend always runs everything.
//
// Tolerances (fp32 kernels vs fp32 PyTorch on the same weights): relative L2 error ≤ 1e-3 per layer,
// final depth median |rel| ≤ 1e-3 and focal / shift within 1e-3. SKIP (exit 0) without the weights
// (node scripts/models/fetch.mjs --only moge2), the matcher venv for the reference, or (gpu) a Dawn adapter.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createNn, type Nn, type Tensor } from "#/lib/nn";
import { composeDepth } from "./compose";
import { FOCAL_GRID, MOGE2_VITS, MogeDepthNet } from "./depth-net";

const skip = (why: string) => {
	console.log(`SKIP depth-net: ${why}`);
	process.exit(0);
};
// default: the GPU backend on Dawn when DAWN_DIR is set (≈ 3 s for everything), else the CPU encoder run
const backend = process.argv.includes("--backend")
	? process.argv[process.argv.indexOf("--backend") + 1]
	: process.env.DAWN_DIR
		? "gpu"
		: "cpu";
const full = backend === "gpu" || process.argv.includes("--full");
const weights = path.join("public/models", MOGE2_VITS.file);
if (!existsSync(weights)) skip(`${weights} missing`);
const REF_DIR = "out/nearfield/moge-ref";
const refFile = path.join(REF_DIR, "ref.safetensors");
if (!existsSync(refFile)) {
	const py = "tools/matcher/.venv/bin/python";
	if (!existsSync(py)) skip("no reference and no matcher venv to make one");
	console.log("writing the PyTorch reference (once) …");
	execFileSync(
		py,
		[
			"scripts/models/moge2-vits.py",
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
		{ id: "depth-net-check" },
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
	let num = 0;
	let den = 0;
	let maxAbs = 0;
	for (let i = 0; i < want.length; i++) {
		const d = have[i] - want[i];
		num += d * d;
		den += want[i] * want[i];
		maxAbs = Math.max(maxAbs, Math.abs(d));
	}
	const rel = Math.sqrt(num / Math.max(den, 1e-30));
	const bad = !(rel <= tol);
	if (bad) failed++;
	console.log(
		`${bad ? "FAIL" : "ok  "} ${name.padEnd(22)} rel L2 ${rel.toExponential(2)}  max |Δ| ${maxAbs.toExponential(2)}`,
	);
}

const t0 = performance.now();
const net = await MogeDepthNet.load(nn);
const image = ref.get("input");
const [, , H, W] = image.shape;
const bh = H / MOGE2_VITS.patch;
const bw = W / MOGE2_VITS.patch;
const aspect = W / H;
const { pos, uv } = await net.gridConsts(bh, bw, aspect);
await compare("enc.pos_embed", pos, 1e-5);

// per layer (eager on the CPU; one graph per stage on the GPU)
const enc = await nn.forward(() => net.encode(image, bh, bw, pos));
await compare("enc.out", enc.features);
await compare("enc.cls_token", enc.cls);
if (!full) {
	console.log(
		`encoder only (pass --full for the heads and the post-processing), ${((performance.now() - t0) / 1000).toFixed(1)} s`,
	);
	console.log(failed ? `${failed} failed` : "ok");
	process.exit(failed ? 1 : 0);
}
const neck = await nn.forward(() =>
	net.convStack(
		"neck",
		[nn.concat([enc.features, uv[0]], 1), uv[1], uv[2], uv[3], uv[4]],
		null,
	),
);
for (let l = 0; l < 5; l++) await compare(`neck.out${l}`, neck[l]);
for (const head of ["points_head", "normal_head", "mask_head"]) {
	const out = await nn.forward(() => net.convStack(head, neck, 4)[4]);
	await compare(`${head}.out4`, out, 2e-3);
}

// end to end: the network at the input size, then the post-processing
const out = await net.run(image, aspect, [H, W]);
await compare("final.normal", out.normal, 2e-3);
await compare("final.mask", out.mask, 2e-3);
await compare("final.metric_scale", out.metricScale);
const [z, mask, normal, points64, mask64, scale] = await Promise.all([
	nn.read(out.z),
	nn.read(out.mask),
	nn.read(out.normal),
	nn.read(out.points64),
	nn.read(out.mask64),
	nn.read(out.metricScale),
]);
const d = composeDepth(
	{
		width: W,
		height: H,
		z,
		mask,
		normal,
		points64,
		mask64,
		focalGrid: FOCAL_GRID,
		metricScale: scale[0],
	},
	"moge-2-vits-normal",
);
const K = await refArr("post.intrinsics");
const refDepth = await refArr("post.depth");
const rels: number[] = [];
let validMismatch = 0;
for (let k = 0; k < W * H; k++) {
	const r = refDepth[k];
	const ok = Number.isFinite(r) && r > 0;
	if (ok !== (d.valid[k] === 1)) validMismatch++;
	else if (ok) rels.push(Math.abs(d.depth[k] - r) / r);
}
rels.sort((a, b) => a - b);
const med = rels[rels.length >> 1] ?? Number.NaN;
const p99 = rels[Math.floor(rels.length * 0.99)] ?? Number.NaN;
const focalOk =
	Math.abs(d.focal - K[4]) <= 1e-3 * K[4] &&
	Math.abs(d.shift - K[5]) <= 1e-3 * Math.max(1, Math.abs(K[5]));
const depthOk = med <= 1e-3 && validMismatch <= 0.001 * W * H;
if (!focalOk || !depthOk) failed++;
console.log(
	`${focalOk && depthOk ? "ok  " : "FAIL"} post: focal ${d.focal.toFixed(5)} (ref ${K[4].toFixed(5)}), shift ${d.shift.toFixed(5)} (ref ${K[5].toFixed(5)}), depth |rel| median ${med.toExponential(2)} p99 ${p99.toExponential(2)}, valid mismatch ${validMismatch}`,
);
console.log(
	`${nn.backend.kind} backend, ${((performance.now() - t0) / 1000).toFixed(1)} s`,
);
console.log(failed ? `${failed} failed` : "ok");
process.exit(failed ? 1 : 0);
