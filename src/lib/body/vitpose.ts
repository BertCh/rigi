// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// ViTPose-B (simple decoder) on the src/lib/nn tensor runtime: COCO-17 2D keypoints of one person from a box.
// Weights: public/models/vitpose-b.<hash>.safetensors (scripts/models/vitpose.py; HF usyd-community/vitpose-base-simple,
// Apache-2.0). Reference: transformers VitPoseForPoseEstimation + VitPoseImageProcessor (top-down, unbiased warp).
//
//   person box (COCO x, y, w, h) → centre / size padded to the 3:4 input aspect and × 1.25
//   → bilinear crop to 256 × 192 (pixel-index coordinates, zero outside the photo, rounded to u8 like the processor)
//   → ImageNet normalise → patch conv 16 × 16 / 16, padding 2 → 16 × 12 tokens + pos embed (cls row folded in)
//   → 12 pre-norm ViT blocks (768, 12 heads, exact GELU, LayerNorm eps 1e-12) → final LayerNorm
//   → ReLU → bilinear ×4 → 3 × 3 conv → 17 heatmaps 64 × 48
//   → argmax + DARK refinement (Gaussian σ 0.8 radius 5, log, Newton step) → photo pixels.
// Everything up to the heatmaps is one nn forward per person; the decode is CPU (17 × 3072 values).
import type { Nn, Tensor, Weights } from "#/lib/nn";

export const VITPOSE_B = {
	file: "vitpose-b.71b52d25.safetensors",
	dim: 768,
	heads: 12,
	depth: 12,
	patch: 16,
	/** network input (H, W) */
	input: [256, 192] as const,
	/** heatmap (H, W) */
	heatmap: [64, 48] as const,
	mean: [0.485, 0.456, 0.406] as const,
	std: [0.229, 0.224, 0.225] as const,
	/** box padding of the image processor (box_to_center_and_scale) */
	padding: 1.25,
	/** DARK Gaussian kernel size (post_process_pose_estimation default) */
	darkKernel: 11,
} as const;

/** COCO-17 keypoint order (the network's channel order). */
export const COCO17 = [
	"nose",
	"leftEye",
	"rightEye",
	"leftEar",
	"rightEar",
	"leftShoulder",
	"rightShoulder",
	"leftElbow",
	"rightElbow",
	"leftWrist",
	"rightWrist",
	"leftHip",
	"rightHip",
	"leftKnee",
	"rightKnee",
	"leftAnkle",
	"rightAnkle",
] as const;

/** An RGBA (or RGB with `channels: 3`) image, row-major. */
export type RgbaImage = {
	width: number;
	height: number;
	data: ArrayLike<number>;
	/** 4 (default) or 3 */
	channels?: 3 | 4;
};

/** A person box in photo-normalised coordinates (0..1 of width / height). */
export type PersonBox = { x: number; y: number; w: number; h: number };

/** 17 keypoints of one person: photo-normalised (u, v) and the heatmap peak as confidence. */
export type PersonKeypoints = {
	u: Float32Array;
	v: Float32Array;
	score: Float32Array;
	box: PersonBox;
};

/** The crop window in photo pixels: centre and full size (after the aspect fit and padding). */
export type CropWindow = { cx: number; cy: number; w: number; h: number };

/** box_to_center_and_scale: COCO pixel box → padded crop window at the network's 3:4 aspect. */
export function cropWindow(
	x: number,
	y: number,
	w: number,
	h: number,
): CropWindow {
	const [IH, IW] = VITPOSE_B.input;
	const aspect = IW / IH;
	let ww = w;
	let hh = h;
	if (ww > aspect * hh) hh = ww / aspect;
	else if (ww < aspect * hh) ww = hh * aspect;
	return {
		cx: x + w * 0.5,
		cy: y + h * 0.5,
		w: ww * VITPOSE_B.padding,
		h: hh * VITPOSE_B.padding,
	};
}

/**
 * The processor's unbiased warp: output pixel (i, j) samples the photo at
 * (cx − w/2 + i·w/(W−1), cy − h/2 + j·h/(H−1)) bilinearly, zero outside, rounded to u8, then ImageNet-normalised.
 * Returns [3, 256, 192] f32 (CHW).
 */
export function cropPerson(image: RgbaImage, win: CropWindow): Float32Array {
	const [IH, IW] = VITPOSE_B.input;
	const C = image.channels ?? 4;
	const { width: W, height: H, data } = image;
	const out = new Float32Array(3 * IH * IW);
	const sx = win.w / (IW - 1);
	const sy = win.h / (IH - 1);
	const x0 = win.cx - win.w / 2;
	const y0 = win.cy - win.h / 2;
	const px = (xi: number, yi: number, c: number) =>
		xi < 0 || yi < 0 || xi >= W || yi >= H ? 0 : data[(yi * W + xi) * C + c];
	for (let j = 0; j < IH; j++) {
		const y = y0 + j * sy;
		const yf = Math.floor(y);
		const ty = y - yf;
		for (let i = 0; i < IW; i++) {
			const x = x0 + i * sx;
			const xf = Math.floor(x);
			const tx = x - xf;
			// scipy "constant" mode: a sample outside [0, n-1] is the constant, not a blend with it
			const inside = x >= 0 && y >= 0 && x <= W - 1 && y <= H - 1;
			for (let c = 0; c < 3; c++) {
				let v = 0;
				if (inside) {
					v =
						(1 - ty) * ((1 - tx) * px(xf, yf, c) + tx * px(xf + 1, yf, c)) +
						ty * ((1 - tx) * px(xf, yf + 1, c) + tx * px(xf + 1, yf + 1, c));
					v = Math.round(v);
				}
				out[c * IH * IW + j * IW + i] =
					(v / 255 - VITPOSE_B.mean[c]) / VITPOSE_B.std[c];
			}
		}
	}
	return out;
}

/** 1-D Gaussian taps of scipy.ndimage.gaussian_filter (σ, radius), normalised. */
function gaussTaps(sigma: number, radius: number): Float64Array {
	const k = new Float64Array(2 * radius + 1);
	let s = 0;
	for (let i = -radius; i <= radius; i++) {
		k[i + radius] = Math.exp((-0.5 * i * i) / (sigma * sigma));
		s += k[i + radius];
	}
	for (let i = 0; i < k.length; i++) k[i] /= s;
	return k;
}

/** scipy "reflect" (half-sample symmetric) index. */
function reflect(i: number, n: number): number {
	const p = 2 * n;
	let m = ((i % p) + p) % p;
	if (m >= n) m = p - 1 - m;
	return m;
}

/**
 * Heatmaps [K, H, W] → per keypoint the argmax (heatmap pixels) refined by DARK
 * (post_dark_unbiased_data_processing) and the raw peak value as the score.
 */
export function decodeHeatmaps(
	heatmaps: Float32Array,
	K: number,
	H: number,
	W: number,
	kernel: number = VITPOSE_B.darkKernel,
): { x: Float32Array; y: Float32Array; score: Float32Array } {
	const x = new Float32Array(K);
	const y = new Float32Array(K);
	const score = new Float32Array(K);
	const radius = (kernel - 1) >> 1;
	const g = gaussTaps(0.8, radius);
	const tmp = new Float64Array(H * W);
	const blur = new Float64Array(H * W);
	for (let k = 0; k < K; k++) {
		const hm = heatmaps.subarray(k * H * W, (k + 1) * H * W);
		let best = 0;
		for (let i = 1; i < H * W; i++) if (hm[i] > hm[best]) best = i;
		score[k] = hm[best];
		let px = best % W;
		let py = (best - px) / W;
		if (!(hm[best] > 0)) {
			// get_keypoint_predictions marks a non-positive peak with −1 (the DARK step still runs)
			px = -1;
			py = -1;
		}
		// separable blur, axis 0 (rows) then axis 1 (columns), reflect boundary
		for (let r = 0; r < H; r++)
			for (let c = 0; c < W; c++) {
				let s = 0;
				for (let t = -radius; t <= radius; t++)
					s += g[t + radius] * hm[reflect(r + t, H) * W + c];
				tmp[r * W + c] = s;
			}
		for (let r = 0; r < H; r++)
			for (let c = 0; c < W; c++) {
				let s = 0;
				for (let t = -radius; t <= radius; t++)
					s += g[t + radius] * tmp[r * W + reflect(c + t, W)];
				blur[r * W + c] = Math.log(Math.min(50, Math.max(0.001, s)));
			}
		// edge-padded lookups around (px, py)
		const at = (cx: number, cy: number) =>
			blur[
				Math.min(H - 1, Math.max(0, cy)) * W + Math.min(W - 1, Math.max(0, cx))
			];
		const i0 = at(px, py);
		const ix1 = at(px + 1, py);
		const ix1_ = at(px - 1, py);
		const iy1 = at(px, py + 1);
		const iy1_ = at(px, py - 1);
		const ix1y1 = at(px + 1, py + 1);
		const ix1_y1_ = at(px - 1, py - 1);
		const dx = 0.5 * (ix1 - ix1_);
		const dy = 0.5 * (iy1 - iy1_);
		const dxx = ix1 - 2 * i0 + ix1_;
		const dyy = iy1 - 2 * i0 + iy1_;
		const dxy = 0.5 * (ix1y1 - ix1 - iy1 + i0 + i0 - ix1_ - iy1_ + ix1_y1_);
		// inv(hessian + eps·I) · derivative (numpy float32 eps)
		const e = 1.1920929e-7;
		const a = dxx + e;
		const d = dyy + e;
		const det = a * d - dxy * dxy;
		let ox = 0;
		let oy = 0;
		if (det !== 0) {
			ox = (d * dx - dxy * dy) / det;
			oy = (-dxy * dx + a * dy) / det;
		}
		x[k] = px - ox;
		y[k] = py - oy;
	}
	return { x, y, score };
}

/** Heatmap pixel → photo pixel (transform_preds). */
export function heatmapToPhoto(
	hx: number,
	hy: number,
	win: CropWindow,
): [number, number] {
	const [HH, HW] = VITPOSE_B.heatmap;
	return [
		hx * (win.w / (HW - 1)) + win.cx - win.w * 0.5,
		hy * (win.h / (HH - 1)) + win.cy - win.h * 0.5,
	];
}

export class VitPose {
	constructor(
		readonly nn: Nn,
		readonly weights: Weights,
	) {}

	static async load(
		nn: Nn,
		opts: {
			signal?: AbortSignal;
			onProgress?: (loaded: number, total: number) => void;
		} = {},
	): Promise<VitPose> {
		return new VitPose(nn, await nn.loadWeights(VITPOSE_B.file, opts));
	}

	private w(name: string): Tensor {
		return this.weights.get(name);
	}

	/** Patch embedding + pos embed: x [B, 3, 256, 192] (normalised) → tokens [B, 192, 768]. */
	embed(x: Tensor): Tensor {
		const { nn } = this;
		const { dim } = VITPOSE_B;
		const B = x.shape[0];
		const pe = nn.conv2d(x, this.w("patch.weight"), this.w("patch.bias"), {
			stride: VITPOSE_B.patch,
			padding: 2,
		});
		const n = pe.shape[2] * pe.shape[3];
		const tokens = nn.permute(nn.reshape(pe, [B, dim, n]), [0, 2, 1]);
		return nn.add(tokens, this.w("pos_embed"));
	}

	block(x: Tensor, i: number): Tensor {
		const { nn } = this;
		const p = `layer.${i}.`;
		const { dim, heads } = VITPOSE_B;
		const [B, n] = x.shape;
		const hd = dim / heads;
		const h1 = nn.layerNorm(
			x,
			this.w(`${p}ln1.weight`),
			this.w(`${p}ln1.bias`),
			1e-12,
		);
		const qkv = nn.permute(
			nn.reshape(
				nn.linear(h1, this.w(`${p}qkv.weight`), this.w(`${p}qkv.bias`)),
				[B, n, 3, heads, hd],
			),
			[2, 0, 3, 1, 4],
		);
		const [q, k, v] = nn
			.split(qkv, 3, 0)
			.map((t) => nn.reshape(t, [B, heads, n, hd]));
		const a = nn.reshape(
			nn.permute(
				nn.attention(q, k, v, { scale: 1 / Math.sqrt(hd) }),
				[0, 2, 1, 3],
			),
			[B, n, dim],
		);
		const x1 = nn.add(
			x,
			nn.linear(a, this.w(`${p}proj.weight`), this.w(`${p}proj.bias`)),
		);
		const h2 = nn.layerNorm(
			x1,
			this.w(`${p}ln2.weight`),
			this.w(`${p}ln2.bias`),
			1e-12,
		);
		const mlp = nn.linear(
			nn.gelu(nn.linear(h2, this.w(`${p}fc1.weight`), this.w(`${p}fc1.bias`))),
			this.w(`${p}fc2.weight`),
			this.w(`${p}fc2.bias`),
		);
		return nn.add(x1, mlp);
	}

	/** Final LayerNorm'd tokens [B, 192, 768] → heatmaps [B, 17, 64, 48]. */
	head(tokens: Tensor): Tensor {
		const { nn } = this;
		const [B] = tokens.shape;
		const [IH, IW] = VITPOSE_B.input;
		const gh = IH / VITPOSE_B.patch;
		const gw = IW / VITPOSE_B.patch;
		const fmap = nn.reshape(nn.permute(tokens, [0, 2, 1]), [
			B,
			VITPOSE_B.dim,
			gh,
			gw,
		]);
		const up = nn.interpolate(nn.relu(fmap), {
			scale: 4,
			mode: "bilinear",
			alignCorners: false,
		});
		return nn.conv2d(up, this.w("head.weight"), this.w("head.bias"), {
			padding: 1,
		});
	}

	/** The whole network (to be called inside nn.forward): normalised crops → heatmaps. */
	network(x: Tensor): Tensor {
		let t = this.embed(x);
		for (let i = 0; i < VITPOSE_B.depth; i++) t = this.block(t, i);
		const normed = this.nn.layerNorm(
			t,
			this.w("norm.weight"),
			this.w("norm.bias"),
			1e-12,
		);
		return this.head(normed);
	}

	/** Heatmaps [17, 64, 48] of one person box (pixel COCO box). One nn forward. */
	async heatmaps(
		image: RgbaImage,
		boxPx: readonly [number, number, number, number],
	): Promise<{ heatmaps: Float32Array; win: CropWindow }> {
		const { nn } = this;
		const [IH, IW] = VITPOSE_B.input;
		const win = cropWindow(boxPx[0], boxPx[1], boxPx[2], boxPx[3]);
		const x = nn.fromArray(cropPerson(image, win), [1, 3, IH, IW]);
		const hm = await nn.forward(() => this.network(x));
		const heatmaps = await nn.read(hm);
		nn.dispose([hm, x]);
		return { heatmaps, win };
	}

	/** Keypoints of each person box (photo-normalised boxes in, photo-normalised keypoints out). */
	async run(
		image: RgbaImage,
		boxes: readonly PersonBox[],
	): Promise<PersonKeypoints[]> {
		const out: PersonKeypoints[] = [];
		const [HH, HW] = VITPOSE_B.heatmap;
		for (const box of boxes) {
			const px: [number, number, number, number] = [
				box.x * image.width - 0.5,
				box.y * image.height - 0.5,
				box.w * image.width,
				box.h * image.height,
			];
			const { heatmaps, win } = await this.heatmaps(image, px);
			const d = decodeHeatmaps(heatmaps, COCO17.length, HH, HW);
			const u = new Float32Array(COCO17.length);
			const v = new Float32Array(COCO17.length);
			for (let k = 0; k < COCO17.length; k++) {
				const [x, y] = heatmapToPhoto(d.x[k], d.y[k], win);
				// pixel index → normalised (pixel centres at (i + 0.5) / W, as people.ts' grid)
				u[k] = (x + 0.5) / image.width;
				v[k] = (y + 0.5) / image.height;
			}
			out.push({ u, v, score: d.score, box });
		}
		return out;
	}

	dispose() {
		this.nn.dispose(this.weights);
	}
}
