// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * The people segmenters on nn (src/lib/segment/people.ts, tflite-net.ts) against the TFLite interpreter
 * (ai_edge_litert, the venv python) on fixed demo photos: per-stage, logit and P(person) max / mean abs
 * error on both nn backends (CPU reference, WebGPU over Dawn when DAWN_DIR is set). The weights are fp16
 * (scripts/models/mediapipe-seg.py) and the reference is the fp32 .tflite, so the error includes the
 * rounding of the weights.
 *
 *   DAWN_DIR=/tmp/dawn npx tsx src/lib/segment/__tests__/people-parity.check.ts [--images demo-01,demo-03] [--models deeplab,multiclass] [--no-cpu] [--no-stages]
 * SKIPs (exit 0) when a weights file, a source .tflite or the python reference (tools/matcher/.venv with
 * `pip install tflite ai-edge-litert`) is missing; the GPU rows need DAWN_DIR.
 */
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { setModelFetcher } from "#/lib/nn";
import { CpuNn } from "#/lib/nn/cpu";
import type { Nn } from "#/lib/nn/types";
import { dawnDevice } from "../../../../scripts/nn/dawn";
import {
	loadPeopleNet,
	PEOPLE_WEIGHTS,
	type PeopleModel,
	peopleInput,
	personProbability,
	resampleBilinear,
	runPeopleNet,
} from "../people";
import { runTfliteNet } from "../tflite-net";

const MODELS = process.env.RIGI_MODELS_DIR ?? "public/models";
const TFLITE: Record<PeopleModel, string> = {
	deeplab: "deeplab_v3.ff36e24d.tflite",
	multiclass: "selfie_multiclass_256x256.c6748b12.tflite",
};
const KEY: Record<PeopleModel, string> = {
	deeplab: "deeplab",
	multiclass: "selfie",
};
const argv = process.argv.slice(2);
const opt = (n: string, d: string) =>
	argv.includes(n) ? argv[argv.indexOf(n) + 1] : d;
const IMAGES = opt("--images", "demo-01,demo-03").split(",");
const WHICH = opt("--models", "deeplab,multiclass").split(",") as PeopleModel[];
const LONG = 512;
const PYTHON =
	[
		process.env.MODELS_PYTHON,
		"tools/matcher/.venv/bin/python",
		join(process.env.RIGI_MAIN ?? "", "tools/matcher/.venv/bin/python"),
	].find((p) => p && existsSync(p)) ?? "";
const TMP = join(process.env.TMPDIR ?? "/tmp", "people-parity");

const skip = (why: string) => {
	console.log(`SKIP people-parity: ${why}`);
	process.exit(0);
};
if (!PYTHON) skip("no python venv (tools/matcher/.venv)");
try {
	execFileSync(PYTHON, ["-c", "import tflite, ai_edge_litert"], {
		stdio: "ignore",
	});
} catch {
	skip("the venv lacks tflite / ai-edge-litert");
}
for (const m of WHICH)
	for (const f of [PEOPLE_WEIGHTS[m], TFLITE[m]])
		if (!existsSync(join(MODELS, f))) skip(`missing ${join(MODELS, f)}`);
for (const n of IMAGES)
	if (!existsSync(join("public/demo/photos-1024", `${n}.jpg`)))
		skip(`missing demo photo ${n}`);

setModelFetcher(async (file) => {
	const b = readFileSync(join(MODELS, file));
	return b.buffer.slice(
		b.byteOffset,
		b.byteOffset + b.byteLength,
	) as ArrayBuffer;
});

const stats = (a: ArrayLike<number>, b: ArrayLike<number>) => {
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
const f32 = (file: string) => {
	const b = readFileSync(file);
	return new Float32Array(
		b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
	);
};
const nchwToNhwc = (a: Float32Array, c: number, h: number, w: number) => {
	const o = new Float32Array(a.length);
	for (let ch = 0; ch < c; ch++)
		for (let i = 0; i < h * w; i++) o[i * c + ch] = a[ch * h * w + i];
	return o;
};

const cpu = new CpuNn();
const device = await dawnDevice("people-parity");
let gpu: Nn | null = null;
if (device) {
	const { GpuNn } = await import("#/lib/nn/gpu/gpu-nn");
	gpu = new GpuNn(device);
} else console.log("no DAWN_DIR / adapter: the GPU rows are skipped");

async function photo(name: string) {
	const img = await loadImage(join("public/demo/photos-1024", `${name}.jpg`));
	const s = LONG / Math.max(img.width, img.height);
	const w = Math.round(img.width * s);
	const h = Math.round(img.height * s);
	const c = createCanvas(w, h);
	const ctx = c.getContext("2d");
	ctx.drawImage(img, 0, 0, w, h);
	return { w, h, rgba: ctx.getImageData(0, 0, w, h).data };
}

const worst: Record<
	string,
	{ logit: number; prob: number; mean: number; full: number }
> = {};
let failed = false;
mkdirSync(TMP, { recursive: true });

for (const model of WHICH) {
	const cpuNet = await loadPeopleNet(cpu, model);
	// tap the residual adds, resizes, softmaxes and the final conv
	const taps = cpuNet.net.program
		.filter((o) => ["add", "resize", "softmax", "tconv"].includes(o[0]))
		.map((o) => o[1]);
	const trace = new Set(argv.includes("--no-stages") ? [] : taps);
	for (const name of IMAGES) {
		const { w, h, rgba } = await photo(name);
		const xc = peopleInput(cpuNet, rgba, w, h);
		const input = await cpu.read(xc);
		writeFileSync(join(TMP, "in.f32"), input);
		rmSync(join(TMP, "ref"), { recursive: true, force: true });
		const t0 = performance.now();
		execFileSync(
			PYTHON,
			[
				"scripts/models/mediapipe-seg.py",
				"reference",
				KEY[model],
				join(TMP, "in.f32"),
				join(TMP, "ref"),
				[...trace].join(","),
			],
			{ env: { ...process.env, RIGI_MAIN: process.env.RIGI_MAIN ?? "" } },
		);
		const tTflite = performance.now() - t0;
		const [, mh, mw, C] = cpuNet.net.outputShape;
		const refLogits = f32(join(TMP, "ref/output.f32"));
		// reference P(person) from the reference logits (softmax over classes)
		const refProb = new Float32Array(mh * mw);
		for (let i = 0; i < mh * mw; i++) {
			let m = -Infinity;
			for (let c = 0; c < C; c++) m = Math.max(m, refLogits[i * C + c]);
			let sum = 0;
			const e = new Float64Array(C);
			for (let c = 0; c < C; c++) {
				e[c] = Math.exp(refLogits[i * C + c] - m);
				sum += e[c];
			}
			refProb[i] = model === "multiclass" ? 1 - e[0] / sum : e[15] / sum;
		}
		console.log(
			`\n${model} ${name} ${w}x${h} -> ${mw}x${mh}x${C}  tflite ${tTflite.toFixed(0)} ms (incl. python start-up)`,
		);
		for (const [label, nn] of [
			["cpu", argv.includes("--no-cpu") ? null : cpu],
			["gpu", gpu],
		] as const) {
			if (!nn) continue;
			const net = await loadPeopleNet(nn, model);
			const x = peopleInput(net, rgba, w, h);
			const run = async () => {
				const go = () => {
					const r = runTfliteNet(nn, net.net, x, trace);
					const p = personProbability(net, x);
					return { logits: r.output, taps: r.taps, prob: p };
				};
				return nn.backend.kind === "cpu" ? go() : nn.forward(go);
			};
			let out = await run();
			await nn.read(out.prob);
			const t1 = performance.now();
			out = await run();
			const prob = await nn.read(out.prob);
			const ms = performance.now() - t1;
			const logits = nchwToNhwc(await nn.read(out.logits), C, mh, mw);
			const rows: string[] = [];
			for (const n of trace) {
				const s = stats(
					await nn.read(out.taps[n]),
					f32(join(TMP, `ref/${n}.f32`)),
				);
				rows.push(
					`${n}:${s.max.toExponential(1)}/${(s.max / s.peak).toExponential(1)}`,
				);
			}
			if (rows.length)
				console.log(
					`  ${label} stages max abs / rel-to-peak: ${rows.join(" ")}`,
				);
			const l = stats(logits, refLogits);
			const f = stats(prob, refProb);
			const key = `${model} ${label}`;
			worst[key] ??= { logit: 0, prob: 0, mean: 0, full: 0 };
			const wst = worst[key];
			wst.logit = Math.max(wst.logit, l.max / l.peak);
			wst.prob = Math.max(wst.prob, f.max);
			wst.mean = Math.max(wst.mean, f.mean);
			console.log(
				`  ${label} logits max abs ${l.max.toExponential(2)} (rel to peak ${(l.max / l.peak).toExponential(1)}) mean ${l.mean.toExponential(2)}; P(person) max abs ${f.max.toExponential(2)} mean ${f.mean.toExponential(2)}  ${ms.toFixed(0)} ms${label === "gpu" ? " (warm)" : ""}`,
			);
			nn.dispose(x);
			// the full entry point (input stretch, forward, resample to the image size) vs the reference chain
			const full = await runPeopleNet(net, rgba, w, h, w, h);
			const fullRef = resampleBilinear(refProb, mw, mh, 1, w, h);
			const g = stats(full, fullRef);
			worst[key].full = Math.max(worst[key].full, g.max);
			console.log(
				`  ${label} runPeopleNet at ${w}x${h}: max abs ${g.max.toExponential(2)} mean ${g.mean.toExponential(2)}`,
			);
		}
	}
}
rmSync(TMP, { recursive: true, force: true });

// fp16 weights against the fp32 graph: P(person) is a probability, so absolute error is what matters
const MAX_TOL = 0.05;
const MEAN_TOL = 0.003;
for (const [label, w] of Object.entries(worst)) {
	const ok = w.prob <= MAX_TOL && w.full <= MAX_TOL && w.mean <= MEAN_TOL;
	console.log(
		`${ok ? "PASS" : "FAIL"} people ${label}: worst P(person) max ${w.prob.toExponential(2)} (tol ${MAX_TOL}), mean ${w.mean.toExponential(2)} (tol ${MEAN_TOL}), logits rel ${w.logit.toExponential(1)}`,
	);
	if (!ok) failed = true;
}
process.exit(failed ? 1 : 0);
