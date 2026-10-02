// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Step Inside depth: the quantized MoGe-2 downloads (MOGE2_WEIGHTS q8, q8lite without the normal head)
// against the fp16 checkpoint on real photos, over Dawn in node (src/lib/nn GPU backend). Per photo and
// variant: metric depth error on the pixels both keep (median and p90 of |d / d_fp16 - 1|), focal
// difference, valid-mask IoU, and the angle between the depth-derived normals and the fp16 normal head
// (also for normals derived from the fp16 depth, which isolates the derivation from the quantization).
//
// Inputs are pre-decoded so node needs no JPEG decoder: `--dir` holds index.json
// ([{ name, W, H, bh, bw }]) and <name>.rgb (RGB8 at 14·bw × 14·bh), e.g. made with PIL.
//   DAWN_DIR=/tmp/dawn npx tsx scripts/nearfield/depth-weights-eval.ts --dir <dir> [--json out.json]

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
	composeDepth,
	normalsFromDepth,
} from "../../src/lib/nearfield/local/compose";
import {
	FOCAL_GRID,
	MOGE2_WEIGHTS,
	MogeDepthNet,
	type MogeWeights,
} from "../../src/lib/nearfield/local/depth-net";
import { GpuNn } from "../../src/lib/nn/gpu/gpu-nn";
import { dawnDevice } from "../nn/dawn";

const argv = process.argv.slice(2);
const arg = (k: string) =>
	argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined;
const dir = arg("--dir");
if (!dir) {
	console.error("usage: depth-weights-eval.ts --dir <dir> [--json out.json]");
	process.exit(2);
}
const device = await dawnDevice("depth-weights-eval");
if (!device) {
	console.log("SKIP depth-weights-eval: DAWN_DIR not set or no adapter");
	process.exit(0);
}
const nn = new GpuNn(device);
const MODELS = path.resolve(import.meta.dirname, "../../public/models");
type Photo = { name: string; W: number; H: number; bh: number; bw: number };
const photos = JSON.parse(
	readFileSync(path.join(dir, "index.json"), "utf8"),
) as Photo[];

type Run = ReturnType<typeof composeDepth> & {
	headNormal: Float32Array | null;
	ms: number;
};

/** label → file: MOGE2_WEIGHTS q8 / q8lite, or `--variants label=file,…` (experimental producer outputs). */
const variants: [string, string][] = arg("--variants")
	? (arg("--variants") as string).split(",").map((v) => {
			const [label, file] = v.split("=");
			return [label, file ?? MOGE2_WEIGHTS[label as MogeWeights]];
		})
	: [
			["q8", MOGE2_WEIGHTS.q8],
			["q8lite", MOGE2_WEIGHTS.q8lite],
		];
/** Pixel steps of the depth-derived normals to compare with the fp16 normal head. */
const steps = (arg("--normal-steps") ?? "2").split(",").map(Number);

async function runAll(
	variant: string,
	file: string,
): Promise<Map<string, Run>> {
	const t0 = performance.now();
	const net = new MogeDepthNet(
		nn,
		nn.weightsFromBytes(new Uint8Array(readFileSync(path.join(MODELS, file)))),
	);
	await nn.sync();
	console.log(
		`${variant}: weights loaded in ${(performance.now() - t0).toFixed(0)} ms (normal head ${net.hasNormalHead ? "yes" : "no"})`,
	);
	const out = new Map<string, Run>();
	for (const p of photos) {
		const px = readFileSync(path.join(dir as string, `${p.name}.rgb`));
		const n = p.bh * 14 * p.bw * 14;
		const planes = new Float32Array(3 * n);
		for (let k = 0; k < n; k++)
			for (let c = 0; c < 3; c++) planes[c * n + k] = px[3 * k + c] / 255;
		const image = nn.fromArray(planes, [1, 3, p.bh * 14, p.bw * 14]);
		const t = performance.now();
		const o = await net.run(image, p.W / p.H, [p.H, p.W]);
		const [z, mask, normal, points64, mask64, scale] = await Promise.all([
			nn.read(o.z),
			nn.read(o.mask),
			o.normal ? nn.read(o.normal) : null,
			nn.read(o.points64),
			nn.read(o.mask64),
			nn.read(o.metricScale),
		]);
		const ms = performance.now() - t;
		// compose without the head's normals so every variant's normals are depth-derived
		const d = composeDepth(
			{
				width: p.W,
				height: p.H,
				z,
				mask,
				normal: null,
				points64,
				mask64,
				focalGrid: FOCAL_GRID,
				metricScale: scale[0],
			},
			variant,
		);
		out.set(p.name, { ...d, headNormal: normal, ms });
		nn.dispose([image, ...Object.values(o).filter((x) => x !== null)]);
	}
	nn.dispose(net.weights);
	return out;
}

const quantile = (xs: number[], q: number) => {
	if (!xs.length) return Number.NaN;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const DEG = 180 / Math.PI;

/** Median angle (deg) between `a` (depth-derived) and the head normals where both are set. */
function normalAngle(a: Float32Array, head: Float32Array, valid: Uint8Array) {
	const ang: number[] = [];
	for (let k = 0; k < valid.length; k += 7) {
		if (!valid[k]) continue;
		const ax = a[3 * k];
		const ay = a[3 * k + 1];
		const az = a[3 * k + 2];
		if (ax * ax + ay * ay + az * az < 0.25) continue;
		const d = ax * head[3 * k] + ay * head[3 * k + 1] + az * head[3 * k + 2];
		ang.push(Math.acos(Math.min(1, Math.max(-1, d))) * DEG);
	}
	return quantile(ang, 0.5);
}

const ref = await runAll("fp16", MOGE2_WEIGHTS.fp16);
const report: Record<string, unknown>[] = [];
for (const [variant, file] of variants) {
	const got = await runAll(variant, file);
	for (const p of photos) {
		const a = ref.get(p.name) as Run;
		const b = got.get(p.name) as Run;
		const ratio: number[] = [];
		let inter = 0;
		let union = 0;
		for (let k = 0; k < a.depth.length; k++) {
			const va = a.valid[k];
			const vb = b.valid[k];
			if (va || vb) union++;
			if (va && vb) {
				inter++;
				if (k % 3 === 0) ratio.push(b.depth[k] / a.depth[k]);
			}
		}
		// the DEM anchor fits the scale, so also report the error after the median ratio is divided out
		const r0 = quantile(ratio, 0.5);
		const rel = ratio.map((r) => Math.abs(r - 1));
		const aligned = ratio.map((r) => Math.abs(r / r0 - 1));
		const head = a.headNormal as Float32Array;
		report.push({
			photo: p.name,
			variant,
			depthMedRel: quantile(rel, 0.5),
			depthP90Rel: quantile(rel, 0.9),
			alignedMedRel: quantile(aligned, 0.5),
			alignedP90Rel: quantile(aligned, 0.9),
			focalRel: Math.abs(b.focal / a.focal - 1),
			maskIoU: union ? inter / union : 1,
			// a variant with the head: its head vs the fp16 head; without: depth-derived (step 2) vs the fp16 head
			normalDegVsHead: normalAngle(
				b.headNormal ?? (b.normal as Float32Array),
				head,
				b.valid,
			),
			...Object.fromEntries(
				steps.map((step) => [
					`fp16DerivedS${step}`,
					normalAngle(
						normalsFromDepth(
							a.depth,
							a.valid,
							p.W,
							p.H,
							a.intrinsicsNorm as never,
							{
								step,
							},
						),
						head,
						a.valid,
					),
				]),
			),
			ms: b.ms,
			msFp16: a.ms,
		});
	}
}

const fmt = (v: unknown) =>
	typeof v === "number"
		? Math.abs(v) < 1
			? v.toFixed(4)
			: v.toFixed(1)
		: String(v);
const cols = Object.keys(report[0]);
console.log(cols.join("\t"));
for (const r of report) console.log(cols.map((c) => fmt(r[c])).join("\t"));
for (const [variant] of variants) {
	const rs = report.filter((r) => r.variant === variant);
	const med = (c: string) =>
		quantile(
			rs.map((r) => r[c] as number),
			0.5,
		);
	const worst = (c: string) => Math.max(...rs.map((r) => r[c] as number));
	console.log(
		`${variant} over ${rs.length} photos: depth med rel ${fmt(med("depthMedRel"))} (worst photo ${fmt(worst("depthMedRel"))}), p90 rel ${fmt(med("depthP90Rel"))} (worst ${fmt(worst("depthP90Rel"))}), focal ${fmt(med("focalRel"))} (worst ${fmt(worst("focalRel"))}), mask IoU min ${fmt(Math.min(...rs.map((r) => r.maskIoU as number)))}, scale-aligned med ${fmt(med("alignedMedRel"))} p90 ${fmt(med("alignedP90Rel"))} (worst ${fmt(worst("alignedP90Rel"))}), normals vs head ${fmt(med("normalDegVsHead"))}° (fp16-derived ${steps.map((st) => `s${st} ${fmt(med(`fp16DerivedS${st}`))}°`).join(", ")}), forward ${fmt(med("ms"))} ms vs fp16 ${fmt(med("msFp16"))} ms`,
	);
}
const json = arg("--json");
if (json) writeFileSync(json, JSON.stringify(report, null, "\t"));
process.exit(0);
