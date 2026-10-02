// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// MoGe-2 ViT-S (normal) forward pass on the src/lib/nn tensor runtime: the browser's Step Inside depth
// model (the service ran MoGe-2 ViT-L: tools/nearfield/service/models.py). Weights:
// public/models/moge2-vits-normal.<hash>.safetensors (scripts/models/moge2-vits.py; MIT, DINOv2-S
// backbone Apache-2.0), PyTorch state_dict names. Reference: moge/model/v2.py MoGeModel.forward and
// its modules (dinov2_encoder.py, dinov2 vision_transformer.py, conv_stack.py).
//
//   image [1, 3, 14·bh, 14·bw] RGB 0..1
//   → ImageNet normalise → DINOv2-S/14 (12 blocks, 6 heads, LayerScale, no registers); blocks 5 and 11
//     through the final norm, patch tokens → 1×1 projections, summed → [1, 384, bh, bw]; the normed
//     block-11 cls token → scale head (Linear-ReLU-Linear-ReLU-Linear, exp)
//   → neck ConvStack over 5 levels (base·2^l; uv planes concatenated at every level)
//   → points / normal / mask ConvStack heads (level-4 output, 16·base) → bilinear to the output size
//   → points: [xy·e^z, e^z]; normal: L2-normalised; mask: sigmoid.
// The final resize goes straight from the head resolution to the caller's output grid (MoGe resizes to
// the input image, which the service had decoded at the output grid: same thing).
import type { Nn, Tensor, Weights } from "#/lib/nn";

/** The checkpoint's model config (scripts/models/moge2-vits.py prints it). */
export const MOGE2_VITS = {
	file: "moge2-vits-normal.6d404d23.safetensors",
	dim: 384,
	heads: 6,
	depth: 12,
	patch: 14,
	/** encoder intermediate_layers */
	layers: [5, 11],
	posGrid: 37,
	/** ConvStack widths per level and res blocks per level */
	widths: [384, 256, 128, 64, 32],
	resBlocks: [0, 1, 1, 1, 0],
	/** MoGe-2 num_tokens_range */
	tokens: [1200, 3600],
} as const;

/** Size of MoGe's focal / shift recovery downsample (recover_focal_shift downsample_size). */
export const FOCAL_GRID: readonly [number, number] = [64, 64];

export type DepthNetOutput = {
	/** [1, H, W] z of the camera-frame affine point map (shift unknown) */
	z: Tensor;
	/** [1, H, W, 3] unit normals */
	normal: Tensor;
	/** [1, H, W] P(geometry) */
	mask: Tensor;
	/** [1, 64, 64, 3] nearest downsample of the point map (focal / shift recovery) */
	points64: Tensor;
	/** [1, 64, 64] nearest downsample of the mask */
	mask64: Tensor;
	/** [1] metric scale */
	metricScale: Tensor;
};

/** Token grid (rows, cols) for `tokens` base tokens at `aspect` = W / H (MoGe forward's base_h, base_w). */
export function tokenGrid(tokens: number, aspect: number): [number, number] {
	return [
		Math.max(1, Math.round(Math.sqrt(tokens / aspect))),
		Math.max(1, Math.round(Math.sqrt(tokens * aspect))),
	];
}

/** PyTorch bicubic (A = −0.75) cubic convolution weights for fraction t. */
function cubicWeights(t: number): [number, number, number, number] {
	const A = -0.75;
	const c1 = (x: number) => ((A + 2) * x - (A + 3)) * x * x + 1;
	const c2 = (x: number) => ((A * x - 5 * A) * x + 8 * A) * x - 4 * A;
	return [c2(t + 1), c1(t), c1(1 - t), c2(2 - t)];
}

/**
 * DINOv2 interpolate_pos_encoding (not ONNX mode): the M × M patch grid → (h0, w0) by bicubic
 * F.interpolate with scale_factor ((h0 + 0.1) / M, (w0 + 0.1) / M), antialias off. With a scale
 * factor PyTorch maps dst → src = (dst + 0.5) · M / (n + 0.1) − 0.5 (not the size ratio), taps
 * clamped to the grid. `pos` is [(1 + M²) · C] (cls row first); returns the same layout for h0 · w0.
 */
export function interpolatePosEmbed(
	pos: Float32Array,
	M: number,
	C: number,
	h0: number,
	w0: number,
): Float32Array {
	const out = new Float32Array((1 + h0 * w0) * C);
	out.set(pos.subarray(0, C), 0);
	if (h0 === M && w0 === M) {
		out.set(pos.subarray(C, (1 + M * M) * C), C);
		return out;
	}
	const taps = (n: number) => {
		const s = M / (n + 0.1);
		const idx = new Int32Array(4 * n);
		const wts = new Float64Array(4 * n);
		for (let d = 0; d < n; d++) {
			const src = s * (d + 0.5) - 0.5;
			const i0 = Math.floor(src);
			const w = cubicWeights(src - i0);
			for (let k = 0; k < 4; k++) {
				idx[4 * d + k] = Math.min(M - 1, Math.max(0, i0 - 1 + k));
				wts[4 * d + k] = w[k];
			}
		}
		return { idx, wts };
	};
	const ty = taps(h0);
	const tx = taps(w0);
	// separable: rows first (M × w0 × C), then columns, in f64
	const tmp = new Float64Array(M * w0 * C);
	for (let r = 0; r < M; r++)
		for (let x = 0; x < w0; x++)
			for (let k = 0; k < 4; k++) {
				const w = tx.wts[4 * x + k];
				const src = C + (r * M + tx.idx[4 * x + k]) * C;
				const dst = (r * w0 + x) * C;
				for (let c = 0; c < C; c++) tmp[dst + c] += w * pos[src + c];
			}
	for (let y = 0; y < h0; y++)
		for (let x = 0; x < w0; x++) {
			const dst = C + (y * w0 + x) * C;
			for (let k = 0; k < 4; k++) {
				const w = ty.wts[4 * y + k];
				const src = (ty.idx[4 * y + k] * w0 + x) * C;
				for (let c = 0; c < C; c++) out[dst + c] += w * tmp[src + c];
			}
		}
	return out;
}

/** MoGe normalized_view_plane_uv as a [1, 2, h, w] array (u along width, v along height). */
export function uvPlanes(w: number, h: number, aspect: number): Float32Array {
	const d = Math.sqrt(1 + aspect * aspect);
	const sx = aspect / d;
	const sy = 1 / d;
	const out = new Float32Array(2 * w * h);
	for (let j = 0; j < h; j++)
		for (let i = 0; i < w; i++) {
			out[j * w + i] = (sx * (2 * i + 1 - w)) / w;
			out[w * h + j * w + i] = (sy * (2 * j + 1 - h)) / h;
		}
	return out;
}

/** Host-side constants of one token grid: interpolated pos embed + the five uv planes. */
type GridConsts = { pos: Tensor; uv: Tensor[] };

export class MogeDepthNet {
	private posEmbed: Float32Array | null = null;
	private consts = new Map<string, GridConsts>();

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
	): Promise<MogeDepthNet> {
		return new MogeDepthNet(nn, await nn.loadWeights(MOGE2_VITS.file, opts));
	}

	private w(name: string): Tensor {
		return this.weights.get(name);
	}

	/** Pos embed and uv planes for a (bh, bw) grid at `aspect`, cached per grid. */
	async gridConsts(
		bh: number,
		bw: number,
		aspect: number,
	): Promise<GridConsts> {
		const key = `${bh}x${bw}@${aspect}`;
		const hit = this.consts.get(key);
		if (hit) return hit;
		const { nn } = this;
		const M = MOGE2_VITS.posGrid;
		const C = MOGE2_VITS.dim;
		this.posEmbed ??= await nn.read(this.w("encoder.backbone.pos_embed"));
		const pos = nn.fromArray(interpolatePosEmbed(this.posEmbed, M, C, bh, bw), [
			1,
			1 + bh * bw,
			C,
		]);
		const uv: Tensor[] = [];
		for (let l = 0; l < 5; l++) {
			const w = bw << l;
			const h = bh << l;
			uv.push(nn.fromArray(uvPlanes(w, h, aspect), [1, 2, h, w]));
		}
		const c = { pos, uv };
		// keep a few grids (photos of a roll share orientations)
		if (this.consts.size >= 4) {
			const [k0, v0] = this.consts.entries().next().value as [
				string,
				GridConsts,
			];
			this.consts.delete(k0);
			nn.dispose([v0.pos, ...v0.uv]);
		}
		this.consts.set(key, c);
		return c;
	}

	private block(x: Tensor, i: number, bh: number, bw: number): Tensor {
		const { nn } = this;
		const p = `encoder.backbone.blocks.${i}.`;
		const { dim, heads } = MOGE2_VITS;
		const n = 1 + bh * bw;
		const hd = dim / heads;
		// attention: qkv [1, N, 3·C] → (3, B, H, N, D)
		const h1 = nn.layerNorm(
			x,
			this.w(`${p}norm1.weight`),
			this.w(`${p}norm1.bias`),
			1e-6,
		);
		const qkv = nn.permute(
			nn.reshape(
				nn.linear(
					h1,
					this.w(`${p}attn.qkv.weight`),
					this.w(`${p}attn.qkv.bias`),
				),
				[1, n, 3, heads, hd],
			),
			[2, 0, 3, 1, 4],
		);
		const [q, k, v] = nn
			.split(qkv, 3, 0)
			.map((t) => nn.reshape(t, [1, heads, n, hd]));
		const a = nn.reshape(
			nn.permute(
				nn.attention(q, k, v, { scale: 1 / Math.sqrt(hd) }),
				[0, 2, 1, 3],
			),
			[1, n, dim],
		);
		const attn = nn.linear(
			a,
			this.w(`${p}attn.proj.weight`),
			this.w(`${p}attn.proj.bias`),
		);
		const x1 = nn.add(x, nn.mul(attn, this.w(`${p}ls1.gamma`)));
		const h2 = nn.layerNorm(
			x1,
			this.w(`${p}norm2.weight`),
			this.w(`${p}norm2.bias`),
			1e-6,
		);
		const mlp = nn.linear(
			nn.gelu(
				nn.linear(h2, this.w(`${p}mlp.fc1.weight`), this.w(`${p}mlp.fc1.bias`)),
			),
			this.w(`${p}mlp.fc2.weight`),
			this.w(`${p}mlp.fc2.bias`),
		);
		return nn.add(x1, nn.mul(mlp, this.w(`${p}ls2.gamma`)));
	}

	/** DINOv2 encoder → projected features [1, 384, bh, bw] and the normed cls token [1, 384]. */
	encode(
		image: Tensor,
		bh: number,
		bw: number,
		pos: Tensor,
	): { features: Tensor; cls: Tensor } {
		const { nn } = this;
		const { dim, patch } = MOGE2_VITS;
		const x0 = nn.div(
			nn.sub(image, this.w("encoder.image_mean")),
			this.w("encoder.image_std"),
		);
		const pe = nn.conv2d(
			x0,
			this.w("encoder.backbone.patch_embed.proj.weight"),
			this.w("encoder.backbone.patch_embed.proj.bias"),
			{ stride: patch },
		);
		const tokens = nn.permute(nn.reshape(pe, [1, dim, bh * bw]), [0, 2, 1]);
		let x = nn.add(
			nn.concat(
				[nn.reshape(this.w("encoder.backbone.cls_token"), [1, 1, dim]), tokens],
				1,
			),
			pos,
		);
		const norm = (t: Tensor) =>
			nn.layerNorm(
				t,
				this.w("encoder.backbone.norm.weight"),
				this.w("encoder.backbone.norm.bias"),
				1e-6,
			);
		let features: Tensor | null = null;
		let cls: Tensor | null = null;
		const layers = MOGE2_VITS.layers as readonly number[];
		for (let i = 0; i < MOGE2_VITS.depth; i++) {
			x = this.block(x, i, bh, bw);
			const li = layers.indexOf(i);
			if (li < 0) continue;
			const normed = norm(x);
			const patches = nn.reshape(
				nn.permute(nn.slice(normed, 1, 1), [0, 2, 1]),
				[1, dim, bh, bw],
			);
			const proj = nn.conv2d(
				patches,
				this.w(`encoder.output_projections.${li}.weight`),
				this.w(`encoder.output_projections.${li}.bias`),
			);
			features = features ? nn.add(features, proj) : proj;
			if (i === layers[layers.length - 1])
				cls = nn.reshape(nn.slice(normed, 1, 0, 1), [1, dim]);
		}
		if (!features || !cls) throw new Error("moge: no encoder features");
		return { features, cls };
	}

	/** 3×3 conv with replicate padding (padding_mode="replicate"). */
	private conv3(x: Tensor, name: string): Tensor {
		const { nn } = this;
		return nn.conv2d(
			nn.pad(x, [1, 1, 1, 1], { mode: "replicate" }),
			this.w(`${name}.weight`),
			this.w(`${name}.bias`),
		);
	}

	private conv1(x: Tensor, name: string): Tensor {
		return this.nn.conv2d(x, this.w(`${name}.weight`), this.w(`${name}.bias`));
	}

	/**
	 * ConvStack.forward (conv_stack.py): per level x = (l ? x : 0) + input_blocks[l](in[l]), the res
	 * blocks, the output block (identity except where `outLevels` names a 1×1 conv), then the level's
	 * resampler. Returns every level's output.
	 */
	convStack(
		prefix: string,
		inputs: Tensor[],
		outConv: number | null,
	): Tensor[] {
		const { nn } = this;
		const outs: Tensor[] = [];
		let x: Tensor | null = null;
		for (let l = 0; l < 5; l++) {
			const f = this.conv1(inputs[l], `${prefix}.input_blocks.${l}`);
			let h: Tensor = x ? nn.add(x, f) : f;
			for (let r = 0; r < MOGE2_VITS.resBlocks[l]; r++) {
				const p = `${prefix}.res_blocks.${l}.${r}.layers`;
				const y = this.conv3(
					nn.relu(this.conv3(nn.relu(h), `${p}.2`)),
					`${p}.5`,
				);
				h = nn.add(h, y);
			}
			outs.push(
				l === outConv ? this.conv1(h, `${prefix}.output_blocks.${l}`) : h,
			);
			if (l < 4) {
				const p = `${prefix}.resamplers.${l}`;
				const up =
					l < 3
						? nn.convTranspose2d(
								h,
								this.w(`${p}.0.weight`),
								this.w(`${p}.0.bias`),
								{
									stride: 2,
								},
							)
						: nn.interpolate(h, {
								scale: 2,
								mode: "bilinear",
								alignCorners: false,
							});
				x = this.conv3(up, `${p}.1`);
			}
		}
		return outs;
	}

	/**
	 * The network on `image` ([1, 3, 14·bh, 14·bw], RGB 0..1, `aspect` = the photo's W / H, which the
	 * uv planes use), outputs resized (bilinear) to `outSize` = [H, W]. Enqueued under nn.forward.
	 */
	async run(
		image: Tensor,
		aspect: number,
		outSize: readonly [number, number],
	): Promise<DepthNetOutput> {
		const { nn } = this;
		const { patch } = MOGE2_VITS;
		const bh = image.shape[2] / patch;
		const bw = image.shape[3] / patch;
		if (!Number.isInteger(bh) || !Number.isInteger(bw))
			throw new Error("moge: image size must be a multiple of 14");
		const { pos, uv } = await this.gridConsts(bh, bw, aspect);
		return nn.forward(() => {
			const { features, cls } = this.encode(image, bh, bw, pos);
			const neckIn = [
				nn.concat([features, uv[0]], 1),
				uv[1],
				uv[2],
				uv[3],
				uv[4],
			];
			const neck = this.convStack("neck", neckIn, null);
			const head = (name: string) =>
				nn.interpolate(this.convStack(name, neck, 4)[4], {
					size: outSize,
					mode: "bilinear",
					alignCorners: false,
				});
			// points: remap "exp" → [xy·e^z, e^z] (channels first here, NHWC below)
			const p = head("points_head");
			const ez = nn.unary("exp", nn.slice(p, 1, 2, 3));
			const pointsNchw = nn.concat([nn.mul(nn.slice(p, 1, 0, 2), ez), ez], 1);
			const z = nn.reshape(ez, [1, outSize[0], outSize[1]]);
			const points64 = nn.permute(
				nn.interpolate(pointsNchw, { size: FOCAL_GRID, mode: "nearest" }),
				[0, 2, 3, 1],
			);
			const normal = nn.l2Normalize(
				nn.permute(head("normal_head"), [0, 2, 3, 1]),
				3,
				1e-12,
			);
			const maskNchw = nn.sigmoid(head("mask_head"));
			const mask = nn.reshape(maskNchw, [1, outSize[0], outSize[1]]);
			const mask64 = nn.reshape(
				nn.interpolate(maskNchw, { size: FOCAL_GRID, mode: "nearest" }),
				[1, FOCAL_GRID[0], FOCAL_GRID[1]],
			);
			const s = nn.relu(
				nn.linear(
					cls,
					this.w("scale_head.0.weight"),
					this.w("scale_head.0.bias"),
				),
			);
			const s2 = nn.relu(
				nn.linear(
					s,
					this.w("scale_head.2.weight"),
					this.w("scale_head.2.bias"),
				),
			);
			const metricScale = nn.reshape(
				nn.unary(
					"exp",
					nn.linear(
						s2,
						this.w("scale_head.4.weight"),
						this.w("scale_head.4.bias"),
					),
				),
				[1],
			);
			return { z, normal, mask, points64, mask64, metricScale };
		});
	}

	dispose() {
		for (const c of this.consts.values()) this.nn.dispose([c.pos, ...c.uv]);
		this.consts.clear();
		this.nn.dispose(this.weights);
	}
}
