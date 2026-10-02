// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { Nn, Tensor, Weights } from "#/lib/nn";
/**
 * ALIKED-n16 (Zhao et al. 2023, BSD-3-Clause) on the nn runtime, configured like the former Python matcher
 * service: lightglue's `ALIKED(max_num_keypoints=K, detection_threshold=0.01)` with its 1024 px long-side
 * resize. Weights: scripts/models/aliked-lightglue.py (BatchNorm folded, fp16).
 *
 * One submission and one readback per image: preprocess → encoder → four aggregation branches → score
 * head → NMS → top-k → soft-argmax (dkd-nn.ts) → SDDH patch features → offsets → corner nodes and
 * weights → 16 deformable samples → 128-d descriptors, all for a fixed K = min(maxKeypoints, H·W)
 * slots (top-k is sorted descending, so the keypoints that pass the threshold are a prefix). Slots past
 * the count are computed and sliced off on the CPU, which reads [K, 133] (keypoint x, y, score, NMS
 * value, descriptor, mean score) and derives the count with countAbove.
 *
 * Memory: the reference concatenates the four 32-channel branches upsampled to full resolution
 * (128 × H × W floats, 400 MB at 1024×768) before the score head and the descriptor head. Here the
 * score head's 1×1 conv is split per branch and applied before upsampling (exact, both are linear),
 * and the descriptor head samples the four branch maps directly at integer nodes with one
 * align-corners grid (an upsampled node is exactly a bilinear sample of the low-resolution branch),
 * L2-normalises there, and blends the four corners of each fractional SDDH sample on the graph: the
 * reference's grid_sample over the normalised map, without materialising it.
 */
import { borderMask, countAbove, DKD_RADIUS } from "./dkd";
import {
	createDkdTables,
	type DkdTables,
	patchGridNn,
	sddhCornersNn,
	softArgmaxNn,
} from "./dkd-nn";
import { preprocessImage, resizedSize } from "./preprocess";

export const ALIKED_WEIGHTS = "aliked-n16.dc5fb7d3.safetensors";
export const ALIKED_DIM = 128;
/** SDDH sample positions per keypoint (aliked-n16: M = 16). */
const SDDH_POSITIONS = 16;
const DETECTION_THRESHOLD = 0.01;
/** Packed readback row: x, y, score, NMS value, descriptor (128), mean score. */
const ROW = 4 + ALIKED_DIM + 1;

export interface AlikedConstants {
	tables: DkdTables;
	borderMasks: Map<string, Tensor>;
}
const constantsByNn = new WeakMap<Nn, AlikedConstants>();
const MAX_BORDER_MASKS = 4;

/** Per-runtime constants: the soft-argmax / patch tables and the border masks by map size (uploaded once). */
function alikedConstants(nn: Nn): AlikedConstants {
	let c = constantsByNn.get(nn);
	if (!c) {
		c = { tables: createDkdTables(nn), borderMasks: new Map() };
		constantsByNn.set(nn, c);
	}
	return c;
}

function cachedBorderMask(nn: Nn, h: number, wd: number): Tensor {
	const { borderMasks } = alikedConstants(nn);
	const key = `${h}x${wd}`;
	let m = borderMasks.get(key);
	if (!m) {
		if (borderMasks.size >= MAX_BORDER_MASKS) {
			const [oldest] = borderMasks.keys();
			nn.dispose(borderMasks.get(oldest) as Tensor);
			borderMasks.delete(oldest);
		}
		m = nn.fromArray(borderMask(h, wd), [1, 1, h, wd]);
		borderMasks.set(key, m);
	}
	return m;
}

export interface AlikedOptions {
	/** lightglue max_num_keypoints (the former matcher service used 4096, the propagation service 2048). */
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
export function sampleFeatures(
	nn: Nn,
	branches: Tensor[],
	grid: Tensor,
): Tensor {
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

/** What runAliked uploads before its forward: tensors created inside a forward are graph scratch. */
export interface AlikedPrepared {
	constants: AlikedConstants;
	mask: Tensor;
}

/** Uploads (once per runtime and size) the constants of a forward over an image of `shape` [1, 3, H, W]. */
export function prepareAliked(
	nn: Nn,
	shape: readonly number[],
	longSide: number,
): AlikedPrepared {
	const [workH, workW] = resizedSize(shape[3], shape[2], longSide);
	return {
		constants: alikedConstants(nn),
		mask: cachedBorderMask(nn, workH, workW),
	};
}

/**
 * The synchronous body of runAliked's single forward: resize, encoder, score, NMS, top-k, DKD and SDDH
 * as one packed [K, ROW] tensor. Call inside `nn.forward` (or `nn.warm`, which compiles the same graph
 * without running it, features/warm.ts).
 */
export function alikedForward(
	nn: Nn,
	w: Weights,
	rgb: Tensor,
	opts: AlikedOptions,
	{ constants, mask }: AlikedPrepared,
	trace?: AlikedTrace,
) {
	const prep = preprocessImage(nn, rgb, opts.longSide);
	const branches = alikedBranches(nn, w, prep.padded);
	const [left, , top] = prep.pads;
	const { height: h, width: wd } = prep;
	const Hp = branches[0].shape[2];
	const Wp = branches[0].shape[3];
	const pads = { left, top, paddedWidth: Wp, paddedHeight: Hp };
	const full = alikedScore(nn, w, branches);
	const score = nn.slice(nn.slice(full, 2, top, top + h), 3, left, left + wd);

	// dense maps → NMS → top-k (K slots, sorted descending)
	const nms = nn.mul(simpleNms(nn, score, DKD_RADIUS), mask);
	const k = Math.min(opts.maxKeypoints, h * wd);
	const flatScore = nn.reshape(score, [h * wd]);
	const top_ = nn.topk(nn.reshape(nms, [h * wd]), k, 0);

	// DKD soft-argmax on the kept points
	const kp = softArgmaxNn(nn, constants.tables, flatScore, top_.indices, wd);

	// SDDH: patch features → offsets
	const lim = Math.max(h, wd) / 4;
	const P = SDDH_POSITIONS;
	const pf = sampleFeatures(
		nn,
		branches,
		patchGridNn(nn, constants.tables, kp.x, kp.y, h, wd, pads),
	); // [1, 128, 1, K*9]
	const patch = nn.permute(nn.reshape(pf, [ALIKED_DIM, k, 3, 3]), [1, 0, 2, 3]);
	const off = nn.selu(
		nn.conv2d(patch, w.get("desc.offset1.w"), w.get("desc.offset1.b")),
	);
	const offsets = nn.reshape(
		nn.clamp(
			nn.conv2d(off, w.get("desc.offset2.w"), w.get("desc.offset2.b")),
			-lim,
			lim,
		),
		[k, 2 * P],
	); // x offsets, then y offsets

	// the reference bilinearly samples the L2-normalised feature map (zeros outside): sample the
	// normalised features at the four integer corners (exact) and blend with the bilinear weights
	const corners = sddhCornersNn(nn, kp.x, kp.y, offsets, P, h, wd, pads);
	const f4 = sampleFeatures(nn, branches, corners.grid); // [1,128,K,4P]
	const f = nn.sum(
		nn.mul(
			nn.reshape(f4, [1, ALIKED_DIM, k, P, 4]),
			nn.reshape(corners.weights, [1, 1, k, P, 4]),
		),
		4,
	); // [1, 128, K, P]
	const fs = nn.selu(
		nn.linear(nn.permute(f, [0, 2, 3, 1]), w.get("desc.sf.w")),
	); // [1, K, P, 128]
	const desc = nn.l2Normalize(
		nn.matmul(nn.reshape(fs, [k, P * ALIKED_DIM]), w.get("desc.agg.w")),
		1,
	);

	// mean score map: only used when no NMS value passes the threshold
	const mean = nn.expand(nn.reshape(nn.mean(flatScore, 0), [1, 1]), [k, 1]);
	const packed = nn.concat(
		[kp.x, kp.y, kp.score, nn.reshape(top_.values, [k, 1]), desc, mean],
		1,
	);
	return {
		packed,
		scaleX: prep.scaleX,
		scaleY: prep.scaleY,
		...(trace && { traceMaps: { image: prep.image, score, branches } }),
	};
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
	// constants are uploaded here, outside the forward (tensors created inside it are graph scratch)
	const prepared = prepareAliked(nn, rgb.shape, opts.longSide);
	let packed: Tensor | undefined;
	let extra: Tensor[] = [];
	try {
		let scaleX = 1;
		let scaleY = 1;
		const s = await nn.forward(() =>
			alikedForward(nn, w, rgb, opts, prepared, trace),
		);
		scaleX = s.scaleX;
		scaleY = s.scaleY;
		packed = s.packed;
		const k = packed.shape[0];
		if (trace && s.traceMaps) {
			const t = s.traceMaps;
			trace.pre = await nn.read(t.image);
			trace.score = await nn.read(t.score);
			trace.branches = await Promise.all(t.branches.map((b) => nn.read(b)));
			// the resized image is the caller's own tensor when no resize or padding was needed
			extra = [t.score, ...t.branches];
			if (t.image !== rgb) extra.push(t.image);
		}
		const rows = await nn.read(packed);

		const values = new Float32Array(k);
		for (let i = 0; i < k; i++) values[i] = rows[i * ROW + 3];
		const { count } = countAbove(
			values,
			DETECTION_THRESHOLD,
			() => rows[ROW - 1],
		);
		if (count === 0)
			return {
				keypoints: new Float32Array(0),
				scores: new Float32Array(0),
				descriptors: new Float32Array(0),
				count: 0,
			};
		const kp = new Float32Array(2 * count);
		const scores = new Float32Array(count);
		const descriptors = new Float32Array(count * ALIKED_DIM);
		for (let i = 0; i < count; i++) {
			const r = i * ROW;
			kp[2 * i] = rows[r];
			kp[2 * i + 1] = rows[r + 1];
			scores[i] = rows[r + 2];
			descriptors.set(rows.subarray(r + 4, r + 4 + ALIKED_DIM), i * ALIKED_DIM);
		}
		if (trace) trace.workKeypoints = kp;

		// back to input pixels: (kp + 0.5) / scale − 0.5
		const keypoints = new Float32Array(2 * count);
		for (let i = 0; i < count; i++) {
			keypoints[2 * i] = (kp[2 * i] + 0.5) / scaleX - 0.5;
			keypoints[2 * i + 1] = (kp[2 * i + 1] + 0.5) / scaleY - 0.5;
		}
		return { keypoints, scores, descriptors, count };
	} finally {
		if (packed) nn.dispose(packed);
		for (const t of extra) nn.dispose(t);
	}
}
