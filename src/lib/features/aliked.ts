// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { Nn, Tensor, Weights } from "#/lib/nn";
/**
 * ALIKED-n16 (Zhao et al. 2023, BSD-3-Clause) on the nn runtime, configured like the Python matcher
 * service: lightglue's `ALIKED(max_num_keypoints=K, detection_threshold=0.01)` with its 1024 px long-side
 * resize. Weights: scripts/models/aliked-lightglue.py (BatchNorm folded, fp16).
 *
 * Three submissions per image:
 *   1. preprocess → encoder → four aggregation branches → score head → NMS → top-k (read back: K values
 *      + indices);
 *   2. gather the 5×5 score windows of the kept points (read back) → soft-argmax on the CPU (K points);
 *   3. SDDH: 3×3 patch features → offsets (read back, K×32) → corner nodes + weights on the CPU →
 *      16 deformable samples → 128-d descriptors.
 *
 * Memory: the reference concatenates the four 32-channel branches upsampled to full resolution
 * (128 × H × W floats, 400 MB at 1024×768) before the score head and the descriptor head. Here the
 * score head's 1×1 conv is split per branch and applied before upsampling (exact, both are linear),
 * and the descriptor head samples the four branch maps directly at integer nodes with one
 * align-corners grid (an upsampled node is exactly a bilinear sample of the low-resolution branch),
 * L2-normalises there, and blends the four corners of each fractional SDDH sample on the graph: the
 * reference's grid_sample over the normalised map, without materialising it.
 */
import {
	borderMask,
	countAbove,
	DKD_RADIUS,
	patchNodes,
	sddhCorners,
	softArgmax,
	toPaddedGrid,
	windowIndices,
} from "./dkd";
import { preprocessImage } from "./preprocess";

export const ALIKED_WEIGHTS = "aliked-n16.dc5fb7d3.safetensors";
export const ALIKED_DIM = 128;
/** SDDH sample positions per keypoint (aliked-n16: M = 16). */
const SDDH_POSITIONS = 16;
const DETECTION_THRESHOLD = 0.01;

export interface AlikedOptions {
	/** lightglue max_num_keypoints (the matcher service uses 4096, the propagation service 2048). */
	maxKeypoints: number;
	/** Long side of the working image (lightglue resizes to 1024, up or down). */
	longSide: number;
}

export interface AlikedResult {
	/** Keypoints in input-image pixels (x, y), lightglue's `(kp + 0.5) / scale − 0.5`. */
	keypoints: Float32Array;
	scores: Float32Array;
	descriptors: Float32Array;
	count: number;
}

/** Intermediates kept for the parity check (ignored by callers). */
export interface AlikedTrace {
	pre?: Float32Array;
	score?: Float32Array;
	branches?: Float32Array[];
	/** Keypoints in working-image pixels (before the scale back). */
	workKeypoints?: Float32Array;
}

function dcn(nn: Nn, w: Weights, name: string, x: Tensor): Tensor {
	const h = x.shape[2];
	const wd = x.shape[3];
	const lim = Math.max(h, wd) / 4;
	const off = nn.clamp(
		nn.conv2d(x, w.get(`${name}.offset.w`), w.get(`${name}.offset.b`), {
			padding: 1,
		}),
		-lim,
		lim,
	);
	return nn.deformConv2d(x, off, null, w.get(`${name}.w`), w.get(`${name}.b`), {
		padding: 1,
	});
}

function conv3(nn: Nn, w: Weights, name: string, x: Tensor): Tensor {
	return nn.conv2d(x, w.get(`${name}.w`), w.get(`${name}.b`), { padding: 1 });
}

function resBlock(
	nn: Nn,
	w: Weights,
	name: string,
	x: Tensor,
	deformable: boolean,
): Tensor {
	const c = deformable ? dcn : conv3;
	const y = c(nn, w, `${name}.conv2`, nn.selu(c(nn, w, `${name}.conv1`, x)));
	const id = nn.conv2d(x, w.get(`${name}.down.w`), w.get(`${name}.down.b`));
	return nn.selu(nn.add(y, id));
}

/** Encoder + aggregation: the four SELU'd 32-channel branch maps at 1, 1/2, 1/8, 1/32 resolution. */
export function alikedBranches(nn: Nn, w: Weights, padded: Tensor): Tensor[] {
	const x1 = nn.selu(
		conv3(nn, w, "block1.conv2", nn.selu(conv3(nn, w, "block1.conv1", padded))),
	);
	const x2 = resBlock(nn, w, "block2", nn.avgPool2d(x1, { kernel: 2 }), false);
	const x3 = resBlock(nn, w, "block3", nn.avgPool2d(x2, { kernel: 4 }), true);
	const x4 = resBlock(nn, w, "block4", nn.avgPool2d(x3, { kernel: 4 }), true);
	return [x1, x2, x3, x4].map((x, i) =>
		nn.selu(nn.conv2d(x, w.get(`agg${i + 1}.w`))),
	);
}

/** Score head over the (virtual) branch concat: per-branch 1×1, upsample, sum; then the 3×3 tail. */
export function alikedScore(nn: Nn, w: Weights, branches: Tensor[]): Tensor {
	const size: [number, number] = [branches[0].shape[2], branches[0].shape[3]];
	let s = nn.conv2d(branches[0], w.get("score.in1.w"));
	for (let i = 1; i < 4; i++)
		s = nn.add(
			s,
			nn.interpolate(nn.conv2d(branches[i], w.get(`score.in${i + 1}.w`)), {
				size,
				mode: "bilinear",
				alignCorners: true,
			}),
		);
	s = nn.selu(s);
	s = nn.selu(nn.conv2d(s, w.get("score.c1.w"), null, { padding: 1 }));
	s = nn.selu(nn.conv2d(s, w.get("score.c2.w"), null, { padding: 1 }));
	return nn.sigmoid(nn.conv2d(s, w.get("score.c3.w"), null, { padding: 1 }));
}

/**
 * ALIKED's simple_nms: keep window maxima, then two rounds that re-admit maxima outside the
 * suppressed neighbourhoods (max-pool padding is −∞, as in PyTorch).
 */
export function simpleNms(nn: Nn, scores: Tensor, radius: number): Tensor {
	const pool = (t: Tensor) =>
		nn.maxPool2d(t, { kernel: 2 * radius + 1, stride: 1, padding: radius });
	let maxMask = nn.compare("eq", scores, pool(scores));
	for (let i = 0; i < 2; i++) {
		const supp = nn.compare("gt", pool(maxMask), 0);
		const suppScores = nn.where(supp, 0, scores);
		const fresh = nn.compare("eq", suppScores, pool(suppScores));
		maxMask = nn.maximum(maxMask, nn.mul(fresh, nn.sub(1, supp)));
	}
	return nn.where(maxMask, scores, 0);
}

/** Samples the four branches at grid points [1, gh, gw, 2] → L2-normalised features [1, 128, gh, gw]. */
function sampleFeatures(nn: Nn, branches: Tensor[], grid: Tensor): Tensor {
	return nn.l2Normalize(
		nn.concat(
			branches.map((b) =>
				nn.gridSample(b, grid, { alignCorners: true, padding: "zeros" }),
			),
			1,
		),
		1,
	);
}

/**
 * Runs ALIKED on an RGB image tensor [1, 3, H, W] (values in [0, 1]).
 */
export async function runAliked(
	nn: Nn,
	w: Weights,
	rgb: Tensor,
	opts: AlikedOptions,
	trace?: AlikedTrace,
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
		if (trace) {
			trace.pre = await nn.read(prep.image);
			trace.score = await nn.read(score);
			trace.branches = await Promise.all(branches.map((b) => nn.read(b)));
		}
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
		if (trace) trace.workKeypoints = kp;

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
