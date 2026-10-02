// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * U²-Net-P on nn (src/lib/sky/u2netp.ts) against onnxruntime-web (node, wasm CPU EP) on fixed photos
 * (public/demo/photos-1024): per stage (the eleven RSU outputs and six side maps) and final-mask max / mean
 * abs error, on both nn backends (CPU reference, WebGPU over Dawn when DAWN_DIR is set), plus indicative
 * timings. Weights: scripts/models/u2netp.py (fp16 storage; the ONNX is fp32, so the error includes
 * the fp16 rounding of the weights).
 *
 *   DAWN_DIR=/tmp/dawn npx tsx src/lib/sky/__tests__/u2netp-parity.check.ts [--long 160] [--images demo-01,demo-03] [--no-stages] [--no-cpu]
 * SKIPs (exit 0) when the weights or the source ONNX are missing; the stage table needs the python venv
 * (tools/matcher/.venv, onnx) and is skipped without it; the GPU rows need DAWN_DIR.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import * as ort from "onnxruntime-web";
import { setModelFetcher } from "#/lib/nn";
import { CpuNn } from "#/lib/nn/cpu";
import type { Nn } from "#/lib/nn/types";
import { dawnDevice } from "../../../../scripts/nn/dawn";
import { modelSize, normalise, resamplePlanes, rgbPlanes } from "../core";
import { bindU2netp, runU2netp, U2NETP_WEIGHTS } from "../u2netp";

const MODELS = process.env.RIGI_MODELS_DIR ?? "public/models";
const ONNX = join(MODELS, "skyseg-u2netp.873ea284.onnx");
const argv = process.argv.slice(2);
const opt = (n: string, d: string) =>
	argv.includes(n) ? argv[argv.indexOf(n) + 1] : d;
const LONG = Number(opt("--long", "160"));
const IMAGES = opt("--images", "demo-01,demo-03,demo-08").split(",");
const PYTHON =
	[
		process.env.MODELS_PYTHON,
		"tools/matcher/.venv/bin/python",
		join(process.env.RIGI_MAIN ?? "", "tools/matcher/.venv/bin/python"),
	].find((p) => p && existsSync(p)) ?? "";

for (const f of [join(MODELS, U2NETP_WEIGHTS), ONNX])
	if (!existsSync(f)) {
		console.log(`SKIP u2netp-parity: missing ${f}`);
		process.exit(0);
	}
setModelFetcher(async (file) => {
	const b = readFileSync(join(MODELS, file));
	return b.buffer.slice(
		b.byteOffset,
		b.byteOffset + b.byteLength,
	) as ArrayBuffer;
});

const stats = (a: Float32Array, b: Float32Array) => {
	let max = 0;
	let sum = 0;
	let peak = 0;
	for (let i = 0; i < a.length; i++) {
		const d = Math.abs(a[i] - b[i]);
		if (d > max) max = d;
		sum += d;
		peak = Math.max(peak, Math.abs(b[i]));
	}
	return { max, mean: sum / a.length, peak };
};

// the ONNX with every stage / side output exposed
let tapNames: string[] = [];
let tapsOnnx = ONNX;
if (!argv.includes("--no-stages") && PYTHON) {
	try {
		tapsOnnx = join(process.env.TMPDIR ?? "/tmp", "u2netp-taps.onnx");
		tapNames = JSON.parse(
			execFileSync(
				PYTHON,
				["scripts/models/u2netp.py", "taps-onnx", tapsOnnx],
				{
					encoding: "utf8",
				},
			),
		);
	} catch (e) {
		console.log(`stage table skipped (${String(e).slice(0, 80)})`);
		tapsOnnx = ONNX;
	}
}
ort.env.wasm.numThreads = 1;
ort.env.logLevel = "error";
const session = await ort.InferenceSession.create(readFileSync(tapsOnnx), {
	executionProviders: ["wasm"],
});
const outName = "1959";

const cpu = new CpuNn();
const device = await dawnDevice("u2netp-parity");
let gpu: Nn | null = null;
if (device) {
	const { GpuNn } = await import("#/lib/nn/gpu/gpu-nn");
	gpu = new GpuNn(device);
} else console.log("no DAWN_DIR / adapter: the GPU rows are skipped");

const trace = new Set(tapNames);
let failed = false;
const worst: Record<string, { max: number; mean: number }> = {};

async function photo(name: string) {
	const img = await loadImage(join("public/demo/photos-1024", `${name}.jpg`));
	const c = createCanvas(img.width, img.height);
	const ctx = c.getContext("2d");
	ctx.drawImage(img, 0, 0);
	const d = ctx.getImageData(0, 0, img.width, img.height);
	const { width, height } = modelSize(img.width, img.height, LONG);
	const rgb = resamplePlanes(
		rgbPlanes({ width: img.width, height: img.height, data: d.data }),
		img.width,
		img.height,
		3,
		width,
		height,
	);
	return { width, height, input: normalise(rgb, width * height) };
}

for (const name of IMAGES) {
	const { width, height, input } = await photo(name);
	const t0 = performance.now();
	const ref = await session.run({
		input: new ort.Tensor("float32", input, [1, 3, height, width]),
	});
	const tOrt = performance.now() - t0;
	const refOf = (n: string) => ref[n].data as Float32Array;
	console.log(`\n${name} ${width}x${height}  ort-wasm ${tOrt.toFixed(0)} ms`);
	for (const [label, nn] of [
		["cpu", argv.includes("--no-cpu") ? null : cpu],
		["gpu", gpu],
	] as const) {
		if (!nn) continue;
		const bound = bindU2netp(
			await nn.loadWeights(U2NETP_WEIGHTS).catch((e) => {
				throw e;
			}),
		);
		const x = nn.fromArray(input, [1, 3, height, width]);
		const run = async () => {
			if (nn.backend.kind === "cpu") return runU2netp(nn, bound, x, trace);
			return nn.forward(() => runU2netp(nn, bound, x, trace));
		};
		let out = await run();
		await nn.read(out.prob);
		const t1 = performance.now();
		out = await run();
		const prob = await nn.read(out.prob);
		const ms = performance.now() - t1;
		const rows: string[] = [];
		for (const n of tapNames) {
			const s = stats(await nn.read(out.taps[n]), refOf(n));
			rows.push(
				`${n}:${s.max.toExponential(1)}/${(s.max / s.peak).toExponential(1)}`,
			);
		}
		if (rows.length)
			console.log(`  ${label} stages max abs / rel-to-peak: ${rows.join(" ")}`);
		const f = stats(prob, refOf(outName));
		worst[label] ??= { max: 0, mean: 0 };
		const w = worst[label];
		w.max = Math.max(w.max, f.max);
		w.mean = Math.max(w.mean, f.mean);
		console.log(
			`  ${label} mask max abs ${f.max.toExponential(2)} mean abs ${f.mean.toExponential(2)}  ${ms.toFixed(0)} ms${label === "gpu" ? " (warm)" : ""}`,
		);
		nn.dispose(x);
		nn.dispose(out.prob);
	}
}

// fp16 weights against the fp32 graph: the mask is a probability, so absolute error is what matters
const MAX_TOL = 0.03;
const MEAN_TOL = 0.003;
for (const [label, w] of Object.entries(worst)) {
	const ok = w.max <= MAX_TOL && w.mean <= MEAN_TOL;
	console.log(
		`${ok ? "PASS" : "FAIL"} u2netp ${label}: worst mask max ${w.max.toExponential(2)} (tol ${MAX_TOL}), mean ${w.mean.toExponential(2)} (tol ${MEAN_TOL})`,
	);
	if (!ok) failed = true;
}
process.exit(failed ? 1 : 0);
