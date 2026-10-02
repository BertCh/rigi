// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * The one-forward GPU people-mask pipeline (segment/people-gpu.ts) against the OLD pipeline (CPU bilinear
 * resample + normalise in, per-net forward, CPU bilinear up, smoothstep, dilate, two box blurs, round),
 * both starting from the same w x h RGBA bytes, so the difference is the GPU pipeline alone (texture
 * resample, interpolate, pool ops, rounding). Photos: public/demo/photos-1024 (decoded with
 * @napi-rs/canvas) plus a synthetic image. Reports max abs diff of the byte mask and the fraction of
 * pixels differing by > 8; `--cpu-nn` also runs the old path on the CPU nn backend (slow).
 *
 *   DAWN_DIR=/tmp/dawn npx tsx src/lib/segment/__tests__/people-gpu.check.ts [--images demo-05] [--models multiclass,deeplab,combined] [--cpu-nn]
 * SKIPs (exit 0) without DAWN_DIR / an adapter or without the weights and demo photos.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { smoothstep } from "#/lib/math";
import { setModelFetcher } from "#/lib/nn";
import { CpuNn } from "#/lib/nn/cpu";
import { GpuNn } from "#/lib/nn/gpu/gpu-nn";
import type { Nn } from "#/lib/nn/types";
import { dawnDevice } from "../../../../scripts/nn/dawn";
import {
	loadPeopleNet,
	PEOPLE_WEIGHTS,
	type PeopleModel,
	type PeopleNet,
	peopleInput,
	personProbability,
	resampleBilinear,
} from "../people";
import { createRgbaTexture, maskSize, segmentTextureGpu } from "../people-gpu";

const MODELS_DIR = process.env.RIGI_MODELS_DIR ?? "public/models";
const argv = process.argv.slice(2);
const opt = (n: string, d: string) =>
	argv.includes(n) ? argv[argv.indexOf(n) + 1] : d;
const IMAGES = opt("--images", "demo-05").split(",");
const WHICH = opt("--models", "multiclass,deeplab,combined").split(",");
const CPU_NN = argv.includes("--cpu-nn");
const MAX_TOL = 8;
const FRAC_TOL = 0.001;

const skip = (why: string) => {
	console.log(`SKIP people-gpu: ${why}`);
	process.exit(0);
};
const dawn = await dawnDevice("people-gpu");
if (!dawn) skip("no DAWN_DIR / adapter");
const device = dawn as NonNullable<typeof dawn>;
for (const m of Object.values(PEOPLE_WEIGHTS))
	if (!existsSync(join(MODELS_DIR, m))) skip(`missing ${m}`);
for (const n of IMAGES)
	if (!existsSync(join("public/demo/photos-1024", `${n}.jpg`)))
		skip(`missing demo photo ${n}`);
setModelFetcher(async (file) => {
	const b = readFileSync(join(MODELS_DIR, file));
	return b.buffer.slice(
		b.byteOffset,
		b.byteOffset + b.byteLength,
	) as ArrayBuffer;
});

// ---- the old CPU post-process (segment.ts before the one-forward pipeline) ----
function dilate(src: Float32Array, w: number, h: number, r: number) {
	const tmp = new Float32Array(src.length);
	const out = new Float32Array(src.length);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			let m = 0;
			for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++)
				m = Math.max(m, src[y * w + k]);
			tmp[y * w + x] = m;
		}
	for (let x = 0; x < w; x++)
		for (let y = 0; y < h; y++) {
			let m = 0;
			for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++)
				m = Math.max(m, tmp[k * w + x]);
			out[y * w + x] = m;
		}
	return out;
}
function boxBlur(src: Float32Array, w: number, h: number, r: number) {
	const tmp = new Float32Array(src.length);
	const out = new Float32Array(src.length);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			let s = 0;
			let n = 0;
			for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) {
				s += src[y * w + k];
				n++;
			}
			tmp[y * w + x] = s / n;
		}
	for (let x = 0; x < w; x++)
		for (let y = 0; y < h; y++) {
			let s = 0;
			let n = 0;
			for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) {
				s += tmp[k * w + x];
				n++;
			}
			out[y * w + x] = s / n;
		}
	return out;
}
async function oldPipeline(
	nn: Nn,
	nets: PeopleNet[],
	rgba: Uint8ClampedArray,
	w: number,
	h: number,
) {
	const probs: Float32Array[] = [];
	for (const net of nets) {
		const x = peopleInput(net, rgba, w, h);
		const run = () => personProbability(net, x);
		const prob = await (nn.backend.kind === "cpu" ? run() : nn.forward(run));
		const low = await nn.read(prob);
		const [, mh, mw] = net.net.inputShape;
		probs.push(resampleBilinear(low, mw, mh, 1, w, h));
		nn.dispose([prob, x]);
	}
	let fg = new Float32Array(w * h);
	for (let i = 0; i < fg.length; i++) {
		let p = 0;
		for (const pr of probs) p = Math.max(p, pr[i]);
		fg[i] = smoothstep(0.3, 0.6, p);
	}
	fg = dilate(fg, w, h, Math.max(1, Math.round(w * 0.01)));
	fg = boxBlur(fg, w, h, 1);
	fg = boxBlur(fg, w, h, 1);
	const data = new Uint8Array(w * h);
	for (let i = 0; i < data.length; i++) data[i] = Math.round(fg[i] * 255);
	return data;
}

async function photo(name: string) {
	const img = await loadImage(join("public/demo/photos-1024", `${name}.jpg`));
	const { w, h } = maskSize(img.width, img.height);
	const c = createCanvas(w, h);
	const ctx = c.getContext("2d");
	ctx.drawImage(img, 0, 0, w, h);
	return { w, h, rgba: ctx.getImageData(0, 0, w, h).data };
}
function synthetic() {
	const { w, h } = maskSize(640, 480);
	const rgba = new Uint8ClampedArray(w * h * 4);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const i = (y * w + x) * 4;
			const dx = (x - w / 2) / (w * 0.15);
			const dy = (y - h * 0.6) / (h * 0.3);
			const body = dx * dx + dy * dy < 1;
			rgba[i] = body ? 200 : (x * 255) / w;
			rgba[i + 1] = body ? 150 : (y * 255) / h;
			rgba[i + 2] = body ? 120 : 200;
			rgba[i + 3] = 255;
		}
	return { w, h, rgba };
}

const gpu = new GpuNn(device, { graphGroup: "nn/people-check" });
const cpu = new CpuNn();
const netCache = new Map<string, Promise<PeopleNet>>();
const netOf = (nn: Nn, m: PeopleModel) => {
	const key = `${nn.backend.kind}/${m}`;
	if (!netCache.has(key)) netCache.set(key, loadPeopleNet(nn, m));
	return netCache.get(key) as Promise<PeopleNet>;
};
const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];

let failed = false;
const inputs = [
	...(await Promise.all(IMAGES.map(async (n) => ({ n, ...(await photo(n)) })))),
	{ n: "synthetic", ...synthetic() },
];
for (const { n, w, h, rgba } of inputs)
	for (const which of WHICH) {
		const models: PeopleModel[] =
			which === "combined" ? ["multiclass", "deeplab"] : [which as PeopleModel];
		const gnets = await Promise.all(models.map((m) => netOf(gpu, m)));
		const tex = createRgbaTexture(device, new Uint8Array(rgba.buffer), w, h);
		const times: number[] = [];
		let got = await segmentTextureGpu(gpu, gnets, tex, w, h);
		for (let i = 0; i < 5; i++) {
			const t = performance.now();
			got = await segmentTextureGpu(gpu, gnets, tex, w, h);
			times.push(performance.now() - t);
		}
		tex.destroy();
		const refs: [string, Uint8Array][] = [
			[
				"old CPU post-process (GPU nn)",
				await oldPipeline(gpu, gnets, rgba, w, h),
			],
		];
		if (CPU_NN)
			refs.push([
				"old pipeline, CPU nn",
				await oldPipeline(
					cpu,
					await Promise.all(models.map((m) => netOf(cpu, m))),
					rgba,
					w,
					h,
				),
			]);
		for (const [label, ref] of refs) {
			let max = 0;
			let over = 0;
			let fg = 0;
			for (let i = 0; i < ref.length; i++) {
				const d = Math.abs(ref[i] - got.data[i]);
				max = Math.max(max, d);
				if (d > 8) over++;
				if (ref[i] > 127) fg++;
			}
			const frac = over / ref.length;
			const ok = max <= MAX_TOL && frac <= FRAC_TOL;
			if (!ok) failed = true;
			console.log(
				`${ok ? "PASS" : "FAIL"} ${n} ${which} ${w}x${h} vs ${label}: max abs ${max}, ${(frac * 100).toFixed(3)}% px differ > 8 (tol ${MAX_TOL}, ${FRAC_TOL * 100}%), ref fg px ${fg}; one forward warm median ${median(times).toFixed(1)} ms`,
			);
		}
	}
process.exit(failed ? 1 : 0);
