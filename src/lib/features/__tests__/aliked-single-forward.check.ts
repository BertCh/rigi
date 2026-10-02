// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * runAliked is ONE nn forward with one readback (soft-argmax, SDDH patches and corners as nn ops,
 * dkd-nn.ts). This check compares it with the staged pipeline it replaced, which round-trips through the
 * CPU reference helpers of dkd.ts (the PyTorch-faithful formulas), on the GPU backend over Dawn:
 * same count, keypoints within 1e-3 px, scores within 1e-5, descriptors cosine > 0.99999. Inputs: a
 * textured synthetic image (K above and below the real keypoint count, so padded slots are exercised) and
 * a smooth gradient.
 *
 *   DAWN_DIR=/tmp/dawn npx tsx src/lib/features/__tests__/aliked-single-forward.check.ts
 * SKIPs (exit 0) without DAWN_DIR or the ALIKED weights.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	createNn,
	type Nn,
	setModelFetcher,
	type Tensor,
	type Weights,
} from "#/lib/nn";
import { dawnDevice } from "../../../../scripts/nn/dawn";
import {
	ALIKED_DIM,
	ALIKED_WEIGHTS,
	type AlikedOptions,
	type AlikedResult,
	alikedBranches,
	alikedScore,
	runAliked,
	sampleFeatures,
	simpleNms,
} from "../aliked";
import {
	borderMask,
	countAbove,
	DKD_RADIUS,
	patchNodes,
	sddhCorners,
	softArgmax,
	toPaddedGrid,
	windowIndices,
} from "../dkd";
import { preprocessImage } from "../preprocess";

const SDDH_POSITIONS = 16;
const DETECTION_THRESHOLD = 0.01;

/** The pre-P2.13 pipeline: four submissions with CPU soft-argmax / SDDH corner math (dkd.ts) in between. */
async function runStaged(
	nn: Nn,
	w: Weights,
	rgb: Tensor,
	opts: AlikedOptions,
): Promise<AlikedResult> {
	const live: Tensor[] = [];
	const keep = <T extends Tensor>(t: T): T => {
		live.push(t);
		return t;
	};
	try {
		// 1. dense maps, NMS, top-k
		const s1 = await nn.forward(() => {
			const prep = preprocessImage(nn, rgb, opts.longSide);
			const branches = alikedBranches(nn, w, prep.padded).map(keep);
			const [left, , top] = prep.pads;
			const { height: h, width: wd } = prep;
			const full = alikedScore(nn, w, branches);
			const score = keep(
				nn.slice(nn.slice(full, 2, top, top + h), 3, left, left + wd),
			);
			const nms = nn.mul(
				simpleNms(nn, score, DKD_RADIUS),
				nn.fromArray(borderMask(h, wd), [1, 1, h, wd]),
			);
			const k = Math.min(opts.maxKeypoints, h * wd);
			const top_ = nn.topk(nn.reshape(nms, [h * wd]), k, 0);
			return { prep, branches, score, top: top_ };
		});
		const { prep, branches, score } = s1;
		const { height: h, width: wd } = prep;
		const [values, flat] = await Promise.all([
			nn.read(s1.top.values),
			nn.read(s1.top.indices),
		]);
		let meanValue: number | undefined;
		if (!(values.length > 0 && values[0] > DETECTION_THRESHOLD)) {
			const m = await nn.forward(() => nn.mean(nn.reshape(score, [h * wd]), 0));
			meanValue = (await nn.read(m))[0];
			nn.dispose(m);
		}
		const { count } = countAbove(
			values,
			DETECTION_THRESHOLD,
			meanValue === undefined ? undefined : () => meanValue as number,
		);
		for (const t of [s1.top.values, s1.top.indices, prep.image, prep.padded])
			nn.dispose(t);
		if (count === 0)
			return {
				keypoints: new Float32Array(0),
				scores: new Float32Array(0),
				descriptors: new Float32Array(0),
				count: 0,
			};

		// 2. 5×5 windows → soft-argmax (CPU, K points)
		const win = await nn.forward(() =>
			nn.gather(
				nn.reshape(score, [h * wd]),
				nn.fromArray(windowIndices(flat, count, wd), [count * 25]),
				0,
			),
		);
		const windows = await nn.read(win);
		nn.dispose(win);
		const { keypoints: kp, scores } = softArgmax(windows, flat, count, wd);

		// 3. SDDH descriptors. 3a: patch features → offsets (read back, K×32)
		const [left, , top] = prep.pads;
		const Hp = branches[0].shape[2];
		const Wp = branches[0].shape[3];
		const lim = Math.max(h, wd) / 4;
		const P = SDDH_POSITIONS;
		const offT = await nn.forward(() => {
			const nodes = toPaddedGrid(
				patchNodes(kp, count, h, wd),
				left,
				top,
				Wp,
				Hp,
			);
			// [1, 128, 1, K*9] → [K, 128, 3, 3]
			const pf = sampleFeatures(
				nn,
				branches,
				nn.fromArray(nodes, [1, 1, count * 9, 2]),
			);
			const patch = nn.permute(
				nn.reshape(pf, [ALIKED_DIM, count, 3, 3]),
				[1, 0, 2, 3],
			);
			const off = nn.selu(
				nn.conv2d(patch, w.get("desc.offset1.w"), w.get("desc.offset1.b")),
			);
			return nn.clamp(
				nn.conv2d(off, w.get("desc.offset2.w"), w.get("desc.offset2.b")),
				-lim,
				lim,
			);
		});
		const offsets = await nn.read(offT); // [K, 2P]: x offsets, then y offsets
		nn.dispose(offT);
		// 3b: the reference bilinearly samples the L2-normalised feature map (zeros outside); sample the
		// normalised features at the four integer corners (exact) and blend them with the bilinear weights.
		const corners = sddhCorners(kp, offsets, count, P, h, wd);
		const descT = await nn.forward(() => {
			const grid = toPaddedGrid(corners.nodes, left, top, Wp, Hp);
			const f4 = sampleFeatures(
				nn,
				branches,
				nn.fromArray(grid, [1, count, P * 4, 2]),
			); // [1,128,K,4P]
			const f = nn.sum(
				nn.mul(
					nn.reshape(f4, [1, ALIKED_DIM, count, P, 4]),
					nn.fromArray(corners.weights, [1, 1, count, P, 4]),
				),
				4,
			); // [1, 128, K, P]
			const fs = nn.selu(
				nn.linear(nn.permute(f, [0, 2, 3, 1]), w.get("desc.sf.w")),
			); // [1, K, P, 128]
			const d = nn.matmul(
				nn.reshape(fs, [count, P * ALIKED_DIM]),
				w.get("desc.agg.w"),
			);
			return nn.l2Normalize(d, 1);
		});
		const descriptors = await nn.read(descT);
		nn.dispose(descT);

		// back to input pixels: (kp + 0.5) / scale − 0.5
		const keypoints = new Float32Array(2 * count);
		for (let i = 0; i < count; i++) {
			keypoints[2 * i] = (kp[2 * i] + 0.5) / prep.scaleX - 0.5;
			keypoints[2 * i + 1] = (kp[2 * i + 1] + 0.5) / prep.scaleY - 0.5;
		}
		return { keypoints, scores, descriptors, count };
	} finally {
		for (const t of live) nn.dispose(t);
	}
}

const MODELS = process.env.RIGI_MODELS_DIR ?? "public/models";
if (!existsSync(join(MODELS, ALIKED_WEIGHTS))) {
	console.log(`SKIP: missing ${join(MODELS, ALIKED_WEIGHTS)}`);
	process.exit(0);
}
const device = await dawnDevice("aliked-single-forward");
if (!device) {
	console.log("SKIP: needs DAWN_DIR (Dawn WebGPU in node)");
	process.exit(0);
}
setModelFetcher(async (file) => {
	const b = readFileSync(join(MODELS, file));
	return b.buffer.slice(
		b.byteOffset,
		b.byteOffset + b.byteLength,
	) as ArrayBuffer;
});
const nn = await createNn({ backend: "gpu", device });
const weights = await nn.loadWeights(ALIKED_WEIGHTS);

const H = 192;
const W = 256;
function textured(): Float32Array {
	let s = 12345;
	const rand = () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
	const px = new Float32Array(3 * H * W);
	const blobs = Array.from({ length: 60 }, () => ({
		x: rand() * W,
		y: rand() * H,
		r: 3 + rand() * 12,
		v: [rand(), rand(), rand()],
	}));
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++)
			for (let c = 0; c < 3; c++) {
				let v = 0.3 + 0.2 * Math.sin(x * 0.05 + c) * Math.cos(y * 0.04);
				for (const b of blobs)
					if (Math.hypot(x - b.x, y - b.y) < b.r) v = b.v[c];
				px[c * H * W + y * W + x] = v;
			}
	return px;
}
function gradient(): Float32Array {
	const px = new Float32Array(3 * H * W);
	for (let c = 0; c < 3; c++)
		for (let i = 0; i < H * W; i++) px[c * H * W + i] = 0.2 + 0.0005 * (i % W);
	return px;
}

let failed = false;
for (const [name, make, opts] of [
	["textured/512", textured, { maxKeypoints: 512, longSide: 256 }],
	["textured/4096", textured, { maxKeypoints: 4096, longSide: 256 }],
	["gradient/256", gradient, { maxKeypoints: 256, longSide: 256 }],
] as [string, () => Float32Array, AlikedOptions][]) {
	// a fresh tensor per run: the staged reference disposes its input when no resize / pad was needed
	const a = await runStaged(
		nn,
		weights,
		nn.fromArray(make(), [1, 3, H, W]),
		opts,
	);
	const b = await runAliked(
		nn,
		weights,
		nn.fromArray(make(), [1, 3, H, W]),
		opts,
	);
	const n = Math.min(a.count, b.count);
	let dk = 0;
	let ds = 0;
	let minCos = 1;
	for (let i = 0; i < n; i++) {
		dk = Math.max(
			dk,
			Math.hypot(
				a.keypoints[2 * i] - b.keypoints[2 * i],
				a.keypoints[2 * i + 1] - b.keypoints[2 * i + 1],
			),
		);
		ds = Math.max(ds, Math.abs(a.scores[i] - b.scores[i]));
		let dot = 0;
		for (let j = 0; j < ALIKED_DIM; j++)
			dot +=
				a.descriptors[i * ALIKED_DIM + j] * b.descriptors[i * ALIKED_DIM + j];
		minCos = Math.min(minCos, dot);
	}
	const ok = a.count === b.count && dk < 1e-3 && ds < 1e-5 && minCos > 0.99999;
	failed ||= !ok;
	console.log(
		`${ok ? "PASS" : "FAIL"} ${name}: count ${a.count} vs ${b.count}, max |dkp| ${dk.toExponential(2)} px, max |dscore| ${ds.toExponential(2)}, min descriptor cosine ${minCos.toFixed(6)}`,
	);
}
process.exit(failed ? 1 : 0);
