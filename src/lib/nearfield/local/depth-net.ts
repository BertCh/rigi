// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// MoGe-2 ViT-S (normal) forward pass on the src/lib/nn tensor runtime: the browser's Step Inside depth
// model (the former near-field service ran MoGe-2 ViT-L in PyTorch). Weights:
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
//
// Two ways to run the same forward body (`record`, synchronous nn ops):
//   run()    nn.forward: its own cached graph, one submission, for scripts and checks (async, keeps the tensors);
//   graphs   ./pipeline-gpu.ts records it with nn.forwardInto into a ComputeGraph that is followed by the
//            compose / normals / lift graph (the Step Inside flow, GPU-resident hand-offs).
// The per-grid pos embed is resampled on the GPU (nn.interpolate bicubic over the checkpoint's own
// pos_embed; interpolatePosEmbed below is its CPU reference). Graphs recorded over a grid's constants
// (ComputeGraphs bake those tensors and the weights in) are tracked per grid (`GridConsts.group`) and
// released before the tensors they use are disposed.
import type { Device } from "@luma.gl/core";
import { releaseCachedGraphs } from "#/lib/gpu/core/graph";
import type { CompiledForward, Nn, Tensor, Weights } from "#/lib/nn";

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

/**
 * Weight files of the same network, chosen by the `nearfieldWeights` flag. `fp16` is the checkpoint as
 * dumped; `q8` and `q8lite` are scripts/models/quantize.ts outputs (int8, one scale per row; q8lite drops
 * the normal head, so compose.ts derives normals from the depth), expanded to f16 on the GPU at load.
 * Against fp16 on 24 photos (scripts/nearfield/depth-weights-eval.ts): depth 0.6% median / 2% p90
 * after scale alignment, focal 0.3%, normals 0.4° (q8). reports/step-inside-download.md.
 */
export const MOGE2_WEIGHTS = {
	fp16: "moge2-vits-normal.6d404d23.safetensors",
	q8: "moge2-vits-q8.65924691.safetensors",
	q8lite: "moge2-vits-q8lite.7a9fc5f9.safetensors",
} as const;
export type MogeWeights = keyof typeof MOGE2_WEIGHTS;

/** Size of MoGe's focal / shift recovery downsample (recover_focal_shift downsample_size). */
export const FOCAL_GRID: readonly [number, number] = [64, 64];

/** Per-call options of MogeDepthNet.run; the defaults are the still-photo path. */
export type DepthRunOptions = {
	/** run the points / mask / normal heads as one grouped stack (same maths, fewer launches) */
	batchedHeads?: boolean;
	/** 4 (default): heads at 16× the token grid; 3: level 4 computed at 8× (approximate, faster) */
	headStopLevel?: 3 | 4;
	/** false: skip the normal head even when the weights have it (compose derives normals) */
	normals?: boolean;
};

/** A live-tier preset: the weights file, the base-token count the caller resizes to, and run options. */
export type DepthLivePreset = Required<DepthRunOptions> & {
	weights: MogeWeights;
	tokens: number;
};

/**
 * Live presets. Measured on Dawn (M3 Pro, noisy): live ≈ 165 ms, liveFast ≈ 117 ms per forward at a
 * 1024 × 768 output; neither reaches 100 ms. Quality vs the 1200-token model:
 * reports/depth-live-2026-10-02.md. The caller resizes the photo to tokenGrid(tokens, aspect) · 14.
 */
export const DEPTH_LIVE_PRESETS: Record<"live" | "liveFast", DepthLivePreset> =
	{
		live: {
			weights: "q8lite",
			tokens: 384,
			headStopLevel: 3,
			batchedHeads: true,
			normals: false,
		},
		liveFast: {
			weights: "q8lite",
			tokens: 256,
			headStopLevel: 3,
			batchedHeads: true,
			normals: false,
		},
	};

export type DepthNetOutput = {
	/** [1, H, W] z of the camera-frame affine point map (shift unknown) */
	z: Tensor;
	/** [1, H, W, 3] unit normals; null for weights without the normal head (compose derives them) */
	normal: Tensor | null;
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

/** Constants of one token grid on the GPU: interpolated pos embed + the five uv planes. */
export type GridConsts = {
	pos: Tensor;
	uv: Tensor[];
	/** the cachedGraph group of the graphs recorded over these tensors */
	group: string;
};

/** cachedGraph group prefix of the depth graphs over one net (pipeline-gpu.ts: one group per grid). */
export const DEPTH_GRAPH_GROUP = "nearfield-depth";

/**
 * The pos-embed resample as nn ops: pos_embed [1, 1 + M², C] → cls row + the M × M patch rows as
 * [1, C, M, M] → bicubic with scale_factor ((bh + 0.1) / M, (bw + 0.1) / M) (DINOv2
 * interpolate_pos_encoding; nn.interpolate floors M · scale to bh × bw) → [1, 1 + bh·bw, C].
 */
export function resamplePosEmbed(
	nn: Nn,
	pos: Tensor,
	M: number,
	bh: number,
	bw: number,
): Tensor {
	const C = pos.shape[2];
	const cls = nn.slice(pos, 1, 0, 1);
	const grid = nn.permute(
		nn.reshape(nn.slice(pos, 1, 1, 1 + M * M), [1, M, M, C]),
		[0, 3, 1, 2],
	);
	// DINOv2 skips the resample when the grid already is M × M
	const up =
		bh === M && bw === M
			? grid
			: nn.interpolate(grid, {
					scale: [(bh + 0.1) / M, (bw + 0.1) / M],
					mode: "bicubic",
					alignCorners: false,
				});
	if (up.shape[2] !== bh || up.shape[3] !== bw)
		throw new Error(
			`moge: pos embed resample gave ${up.shape[2]}x${up.shape[3]}, wanted ${bh}x${bw}`,
		);
	const patches = nn.reshape(nn.permute(up, [0, 2, 3, 1]), [1, bh * bw, C]);
	return nn.concat([cls, patches], 1);
}

export class MogeDepthNet {
	private consts = new Map<string, GridConsts>();
	/** head weights concatenated along Cout for the batched stack, keyed by heads + layer */
	private fused = new Map<string, Tensor>();
	private fusedReady = new Set<string>();
	/** persistent forwards (runCompiled) by grid key + output size */
	private compiled = new Map<
		string,
		Promise<CompiledForward<DepthNetOutput>>
	>();

	/** `device`: the nn runtime's device, needed only to release graphs recorded over this net. */
	constructor(
		readonly nn: Nn,
		readonly weights: Weights,
		readonly device?: Device,
	) {}

	static async load(
		nn: Nn,
		opts: {
			/** a MOGE2_WEIGHTS file (default MOGE2_VITS.file) */
			file?: string;
			signal?: AbortSignal;
			onProgress?: (loaded: number, total: number) => void;
			device?: Device;
		} = {},
	): Promise<MogeDepthNet> {
		const { file = MOGE2_VITS.file, device, ...rest } = opts;
		return new MogeDepthNet(nn, await nn.loadWeights(file, rest), device);
	}

	/** fp16 and q8 have the normal head; q8lite drops it (MOGE2_WEIGHTS). */
	get hasNormalHead(): boolean {
		return this.weights.has("normal_head.input_blocks.0.weight");
	}

	private w(name: string): Tensor {
		return this.weights.get(name);
	}

	/** Pos embed (GPU bicubic resample) and uv planes for a (bh, bw) grid at `aspect`, cached per grid. */
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
		const pos = await nn.forward(() =>
			resamplePosEmbed(
				nn,
				nn.reshape(this.w("encoder.backbone.pos_embed"), [1, 1 + M * M, C]),
				M,
				bh,
				bw,
			),
		);
		const uv: Tensor[] = [];
		for (let l = 0; l < 5; l++) {
			const w = bw << l;
			const h = bh << l;
			uv.push(nn.fromArray(uvPlanes(w, h, aspect), [1, 2, h, w]));
		}
		const c = { pos, uv, group: `${DEPTH_GRAPH_GROUP}/${key}` };
		// keep a few grids (photos of a roll share orientations)
		if (this.consts.size >= 4) {
			const [k0, v0] = this.consts.entries().next().value as [
				string,
				GridConsts,
			];
			this.consts.delete(k0);
			this.dropCompiled(`${k0}|`);
			void this.releaseConsts(v0);
		}
		this.consts.set(key, c);
		return c;
	}

	/** Release the graphs recorded over a grid's tensors (after their runs), then dispose the tensors. */
	private async releaseConsts(c: GridConsts) {
		try {
			if (this.device) await releaseCachedGraphs(this.device, c.group);
		} finally {
			this.nn.dispose([c.pos, ...c.uv]);
		}
	}

	/**
	 * Builds (eagerly, outside any recording) the fused head weights `record` needs for `opts`; call it
	 * before recording into a graph. No-op for the separate-heads default.
	 */
	prepare(opts: DepthRunOptions = {}) {
		if (opts.batchedHeads === true) this.prepareFused(this.headNamesFor(opts));
	}

	/**
	 * The forward body: synchronous nn ops on `image` ([1, 3, 14·bh, 14·bw]) with the grid's constants,
	 * outputs at `outSize` = [H, W]. For nn.forwardInto (the graph pipeline); `prepare(opts)` first.
	 */
	record(
		image: Tensor,
		outSize: readonly [number, number],
		consts: GridConsts,
		opts: DepthRunOptions = {},
	): DepthNetOutput {
		const bh = image.shape[2] / MOGE2_VITS.patch;
		const bw = image.shape[3] / MOGE2_VITS.patch;
		return this.forwardOps(
			image,
			bh,
			bw,
			consts.pos,
			consts.uv,
			outSize,
			this.headNamesFor(opts),
			opts,
		);
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

	/** Layer parameters of `names` (one head, or several fused along Cout for the batched stack). */
	private param(names: readonly string[], rel: string): Tensor {
		if (names.length === 1) return this.w(`${names[0]}.${rel}`);
		const key = `${names.join("+")}:${rel}`;
		const hit = this.fused.get(key);
		if (hit) return hit;
		const t = this.nn.concat(
			names.map((n) => this.w(`${n}.${rel}`)),
			0,
		);
		this.fused.set(key, t);
		return t;
	}

	/** 3×3 conv with replicate padding (padding_mode="replicate"); `groups` > 1 for the batched heads. */
	private conv3(
		x: Tensor,
		names: readonly string[],
		rel: string,
		groups = 1,
	): Tensor {
		const { nn } = this;
		return nn.conv2d(
			nn.pad(x, [1, 1, 1, 1], { mode: "replicate" }),
			this.param(names, `${rel}.weight`),
			this.param(names, `${rel}.bias`),
			{ groups },
		);
	}

	private conv1(x: Tensor, names: readonly string[], rel: string): Tensor {
		return this.nn.conv2d(
			x,
			this.param(names, `${rel}.weight`),
			this.param(names, `${rel}.bias`),
		);
	}

	/**
	 * ConvStack.forward (conv_stack.py): per level x = (l ? x : 0) + input_blocks[l](in[l]), the res
	 * blocks, the output block (identity except where `outConv` names a 1×1 conv), then the level's
	 * resampler. Returns every level's output.
	 *
	 * `names` more than one: the heads of those prefixes run as ONE stack, group = names.length. The
	 * first layer of each level reads the shared input, so its weights concatenate along Cout; every
	 * later layer is a grouped conv over the concatenated channels (exactly the per-head result).
	 * `last8`: the live shortcut (headStopLevel 3): level 3's resampler skips its 2× upsample and its
	 * 3×3 conv runs at the lower resolution, so level 4 is computed at 8× (an approximation; the caller
	 * passes level-4 inputs at the same resolution).
	 */
	convStack(
		prefixes: string | readonly string[],
		inputs: Tensor[],
		outConv: number | null,
		last8 = false,
	): Tensor[] {
		const { nn } = this;
		const names = typeof prefixes === "string" ? [prefixes] : prefixes;
		const g = names.length;
		const outs: Tensor[] = [];
		let x: Tensor | null = null;
		for (let l = 0; l < 5; l++) {
			const f = this.conv1(inputs[l], names, `input_blocks.${l}`);
			let h: Tensor = x ? nn.add(x, f) : f;
			for (let r = 0; r < MOGE2_VITS.resBlocks[l]; r++) {
				const p = `res_blocks.${l}.${r}.layers`;
				const y = this.conv3(
					nn.relu(this.conv3(nn.relu(h), names, `${p}.2`, g)),
					names,
					`${p}.5`,
					g,
				);
				h = nn.add(h, y);
			}
			outs.push(l === outConv ? this.outputBlock(h, names, l) : h);
			if (l < 4) {
				const p = `resamplers.${l}`;
				let up = h;
				if (l < 3)
					up = nn.convTranspose2d(
						h,
						this.param(names, `${p}.0.weight`),
						this.param(names, `${p}.0.bias`),
						{ stride: 2, groups: g },
					);
				else if (!last8)
					up = nn.interpolate(h, {
						scale: 2,
						mode: "bilinear",
						alignCorners: false,
					});
				x = this.conv3(up, names, `${p}.1`, g);
			}
		}
		return outs;
	}

	/**
	 * output_blocks.4 (1×1 conv, 32 → 3 or 1). Fused heads have unequal Cout (mask = 1), so a fused
	 * mask weight is zero-padded to 3 channels and the conv is grouped (the padding channels are 0).
	 */
	private outputBlock(h: Tensor, names: readonly string[], l: number): Tensor {
		const { nn } = this;
		const rel = `output_blocks.${l}`;
		if (names.length === 1) return this.conv1(h, names, rel);
		const [wb, bb] = this.fusedOutputParams(names, rel);
		return nn.conv2d(h, wb, bb, { groups: names.length });
	}

	private fusedOutputParams(
		names: readonly string[],
		rel: string,
	): [Tensor, Tensor] {
		const { nn } = this;
		const key = `${names.join("+")}:${rel}`;
		let wb = this.fused.get(`${key}.weight`);
		let bb = this.fused.get(`${key}.bias`);
		if (!wb || !bb) {
			const wParts: Tensor[] = [];
			const bParts: Tensor[] = [];
			for (const n of names) {
				const wt = this.w(`${n}.${rel}.weight`);
				const bt = this.w(`${n}.${rel}.bias`);
				const pad = 3 - wt.shape[0];
				wParts.push(
					pad ? nn.concat([wt, nn.zeros([pad, wt.shape[1], 1, 1])], 0) : wt,
				);
				bParts.push(pad ? nn.concat([bt, nn.zeros([pad])], 0) : bt);
			}
			wb = nn.concat(wParts, 0);
			bb = nn.concat(bParts, 0);
			this.fused.set(`${key}.weight`, wb);
			this.fused.set(`${key}.bias`, bb);
		}
		return [wb, bb];
	}

	/**
	 * Builds (outside the forward) and caches the fused head weights `run` needs for `heads`, so the
	 * per-frame graph only enqueues compute. No-op for the separate path.
	 */
	private prepareFused(names: readonly string[]) {
		if (names.length < 2) return;
		const probe = (tag: string, fn: () => void) => {
			if (this.fusedReady.has(tag)) return;
			fn();
			this.fusedReady.add(tag);
		};
		probe(names.join("+"), () => {
			const rels: string[] = [];
			for (let l = 0; l < 5; l++) rels.push(`input_blocks.${l}`);
			for (let l = 0; l < 5; l++)
				for (let r = 0; r < MOGE2_VITS.resBlocks[l]; r++)
					rels.push(
						`res_blocks.${l}.${r}.layers.2`,
						`res_blocks.${l}.${r}.layers.5`,
					);
			for (let l = 0; l < 4; l++) rels.push(`resamplers.${l}.1`);
			for (const rel of rels) {
				this.param(names, `${rel}.weight`);
				this.param(names, `${rel}.bias`);
			}
			for (let l = 0; l < 3; l++) {
				this.param(names, `resamplers.${l}.0.weight`);
				this.param(names, `resamplers.${l}.0.bias`);
			}
			this.fusedOutputParams(names, "output_blocks.4");
		});
	}

	/**
	 * The network on `image` ([1, 3, 14·bh, 14·bw], RGB 0..1, `aspect` = the photo's W / H, which the
	 * uv planes use), outputs resized (bilinear) to `outSize` = [H, W]. Enqueued under nn.forward.
	 * `opts` default to the still-photo behaviour (separate heads, level 4, normals when present).
	 */
	async run(
		image: Tensor,
		aspect: number,
		outSize: readonly [number, number],
		opts: DepthRunOptions = {},
	): Promise<DepthNetOutput> {
		const { nn } = this;
		const { patch } = MOGE2_VITS;
		const bh = image.shape[2] / patch;
		const bw = image.shape[3] / patch;
		if (!Number.isInteger(bh) || !Number.isInteger(bw))
			throw new Error("moge: image size must be a multiple of 14");
		const headNames = this.headNamesFor(opts);
		const batched = opts.batchedHeads === true;
		if (batched) this.prepareFused(headNames);
		const { pos, uv } = await this.gridConsts(bh, bw, aspect);
		return nn.forward(() =>
			this.forwardOps(image, bh, bw, pos, uv, outSize, headNames, opts),
		);
	}

	/**
	 * run() as a persistent forward (nn.compile): recorded once per (grid, outSize, options), then
	 * replayed with only the image upload. `image` is a ready tensor or the [1, 3, 14·bh, 14·bw]
	 * values. The result tensors are persistent: the next call with the same key overwrites them, so
	 * read them first (the CPU backend returns fresh ones). Takes the same options as run().
	 */
	async runCompiled(
		image: Tensor | { data: Float32Array; shape: readonly number[] },
		aspect: number,
		outSize: readonly [number, number],
		opts: DepthRunOptions = {},
	): Promise<DepthNetOutput> {
		const { nn } = this;
		const { shape } = image;
		const bh = shape[2] / MOGE2_VITS.patch;
		const bw = shape[3] / MOGE2_VITS.patch;
		if (!Number.isInteger(bh) || !Number.isInteger(bw))
			throw new Error("moge: image size must be a multiple of 14");
		const headNames = this.headNamesFor(opts);
		if (opts.batchedHeads === true) this.prepareFused(headNames);
		const { pos, uv } = await this.gridConsts(bh, bw, aspect);
		const gridKey = `${bh}x${bw}@${aspect}`;
		const optionKey = `${opts.batchedHeads === true ? "b" : "s"}${opts.headStopLevel ?? 4}${headNames.length}`;
		const key = `${gridKey}|${outSize[0]}x${outSize[1]}|${optionKey}`;
		let c = this.compiled.get(key);
		if (!c) {
			c = nn.compile(`moge2-vits/${key}`, [shape], ([img]) =>
				this.forwardOps(img, bh, bw, pos, uv, outSize, headNames, opts),
			);
			this.compiled.set(key, c);
		}
		const run = await c;
		const input = "data" in image ? image.data : image;
		await run.submit([input]);
		const persistent = (run as { outputs?: DepthNetOutput }).outputs;
		if (persistent) return persistent;
		return nn.forward(() =>
			this.forwardOps(
				input as Tensor,
				bh,
				bw,
				pos,
				uv,
				outSize,
				headNames,
				opts,
			),
		);
	}

	private dropCompiled(prefix: string) {
		for (const [k, c] of this.compiled)
			if (k.startsWith(prefix)) {
				this.compiled.delete(k);
				void c.then((x) => x.dispose());
			}
	}

	private headNamesFor(opts: DepthRunOptions): string[] {
		const wantNormal = (opts.normals ?? true) && this.hasNormalHead;
		return ["points_head", "mask_head", ...(wantNormal ? ["normal_head"] : [])];
	}

	/** The network's ops (recorded under nn.forward / nn.compile). */
	private forwardOps(
		image: Tensor,
		bh: number,
		bw: number,
		pos: Tensor,
		uv: Tensor[],
		outSize: readonly [number, number],
		headNames: readonly string[],
		opts: DepthRunOptions,
	): DepthNetOutput {
		const { nn } = this;
		const wantNormal = headNames.includes("normal_head");
		const last8 = (opts.headStopLevel ?? 4) < 4;
		const batched = opts.batchedHeads === true;
		const { features, cls } = this.encode(image, bh, bw, pos);
		const neckIn = [
			nn.concat([features, uv[0]], 1),
			uv[1],
			uv[2],
			uv[3],
			last8 ? uv[3] : uv[4],
		];
		const neck = this.convStack(["neck"], neckIn, null, last8);
		const resize = (t: Tensor) =>
			nn.interpolate(t, {
				size: outSize,
				mode: "bilinear",
				alignCorners: false,
			});
		let p: Tensor;
		let maskLogit: Tensor;
		let normalRaw: Tensor | null = null;
		if (batched) {
			// channels: points 0..2, mask 3 (padded to 3), normal 6..8
			const all = resize(this.convStack(headNames, neck, 4, last8)[4]);
			p = nn.slice(all, 1, 0, 3);
			maskLogit = nn.slice(all, 1, 3, 4);
			if (wantNormal) normalRaw = nn.slice(all, 1, 6, 9);
		} else {
			const head = (name: string) =>
				resize(this.convStack([name], neck, 4, last8)[4]);
			p = head("points_head");
			maskLogit = head("mask_head");
			if (wantNormal) normalRaw = head("normal_head");
		}
		// points: remap "exp" → [xy·e^z, e^z] (channels first here, NHWC below)
		const ez = nn.unary("exp", nn.slice(p, 1, 2, 3));
		const pointsNchw = nn.concat([nn.mul(nn.slice(p, 1, 0, 2), ez), ez], 1);
		const z = nn.reshape(ez, [1, outSize[0], outSize[1]]);
		const points64 = nn.permute(
			nn.interpolate(pointsNchw, { size: FOCAL_GRID, mode: "nearest" }),
			[0, 2, 3, 1],
		);
		const normal = normalRaw
			? nn.l2Normalize(nn.permute(normalRaw, [0, 2, 3, 1]), 3, 1e-12)
			: null;
		const maskNchw = nn.sigmoid(maskLogit);
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
			nn.linear(s, this.w("scale_head.2.weight"), this.w("scale_head.2.bias")),
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
	}

	/** Release the graphs recorded over this net, then its constants and weights. */
	async dispose(): Promise<void> {
		this.dropCompiled("");
		const cs = [...this.consts.values()];
		this.consts.clear();
		await Promise.all(cs.map((c) => this.releaseConsts(c)));
		this.nn.dispose([...this.fused.values()]);
		this.fused.clear();
		this.fusedReady.clear();
		this.nn.dispose(this.weights);
	}
}
