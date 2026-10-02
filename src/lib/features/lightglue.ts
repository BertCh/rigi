// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * LightGlue (Lindenberger et al. 2023, Apache-2.0) for ALIKED features on the nn runtime, configured like
 * the Python services (`LightGlue(features="aliked")` on CPU): 9 layers, 4 heads, 256-d, filter
 * threshold 0.1, depth confidence 0.95 (early stop) and width confidence 0.99 (point pruning, always on
 * for CPU in the reference). Both adaptive steps read back one confidence per point per layer and
 * decide on the CPU, exactly as lightglue.py does; `adaptive: false` runs all 9 layers on every point.
 * Weights: scripts/models/aliked-lightglue.py (fp16, Wqkv rows grouped q | k | v).
 */
import type { Nn, Tensor, Weights } from "#/lib/nn";

export const LIGHTGLUE_WEIGHTS = "lightglue-aliked.f35aee62.safetensors";
const LAYERS = 9;
const HEADS = 4;
const DIM = 256;
const HEAD_DIM = DIM / HEADS;
const DEPTH_CONFIDENCE = 0.95;
const WIDTH_CONFIDENCE = 0.99;
export const FILTER_THRESHOLD = 0.1;

export interface LightGlueInput {
	/** N×2 pixels. */
	keypoints: Float32Array;
	/** N×128. */
	descriptors: Float32Array;
	count: number;
	width: number;
	height: number;
}

export interface LightGlueResult {
	matches0: Int32Array;
	matches1: Int32Array;
	/** Match scores (exp of the log-assignment maximum) for every row of image 0; 0 if not mutual. */
	scores0: Float32Array;
	/** Layers run (lightglue's `stop`). */
	stop: number;
}

/** lightglue's scaled confidence threshold per layer. */
export const confidenceThreshold = (layer: number) =>
	Math.min(1, Math.max(0, 0.8 + 0.1 * Math.exp((-4 * layer) / LAYERS)));

/** normalize_keypoints with the image size: (kp − size/2) / (max(size)/2). */
export function normalizeKeypoints(
	kp: Float32Array,
	count: number,
	width: number,
	height: number,
): Float32Array {
	const out = new Float32Array(2 * count);
	const s = Math.max(width, height) / 2;
	for (let i = 0; i < count; i++) {
		out[2 * i] = (kp[2 * i] - width / 2) / s;
		out[2 * i + 1] = (kp[2 * i + 1] - height / 2) / s;
	}
	return out;
}

/** The learnable Fourier encoding: cos / sin of kpn·Wrᵀ, each repeated twice (interleaved) → [N, 64]. */
export function positionalEncoding(
	kpn: Float32Array,
	count: number,
	wr: Float32Array,
): { cos: Float32Array; sin: Float32Array } {
	const f = wr.length / 2; // Wr [32, 2]
	const cos = new Float32Array(count * 2 * f);
	const sin = new Float32Array(count * 2 * f);
	for (let i = 0; i < count; i++)
		for (let j = 0; j < f; j++) {
			const p = Math.fround(
				Math.fround(kpn[2 * i] * wr[2 * j]) +
					Math.fround(kpn[2 * i + 1] * wr[2 * j + 1]),
			);
			const c = Math.cos(p);
			const s = Math.sin(p);
			const o = i * 2 * f + 2 * j;
			cos[o] = c;
			cos[o + 1] = c;
			sin[o] = s;
			sin[o + 1] = s;
		}
	return { cos, sin };
}

/**
 * lightglue's filter_matches on the row / column arg-maxima of the log assignment: mutual nearest
 * neighbours whose exp(score) exceeds `threshold`.
 */
export function filterMatches(
	rowMax: Float32Array,
	rowArg: ArrayLike<number>,
	colArg: ArrayLike<number>,
	threshold: number,
): { matches0: Int32Array; matches1: Int32Array; scores0: Float32Array } {
	const m = rowMax.length;
	const n = colArg.length;
	const matches0 = new Int32Array(m).fill(-1);
	const matches1 = new Int32Array(n).fill(-1);
	const scores0 = new Float32Array(m);
	for (let i = 0; i < m; i++) {
		const j = rowArg[i];
		if (colArg[j] !== i) continue;
		const s = Math.exp(rowMax[i]);
		scores0[i] = s;
		if (s > threshold) {
			matches0[i] = j;
			matches1[j] = i;
		}
	}
	return { matches0, matches1, scores0 };
}

function heads(nn: Nn, x: Tensor, n: number): Tensor {
	return nn.permute(nn.reshape(x, [1, n, HEADS, HEAD_DIM]), [0, 2, 1, 3]);
}
function merge(nn: Nn, x: Tensor, n: number): Tensor {
	return nn.reshape(nn.permute(x, [0, 2, 1, 3]), [1, n, DIM]);
}
function ffn(nn: Nn, w: Weights, p: string, x: Tensor, msg: Tensor): Tensor {
	let y = nn.linear(
		nn.concat([x, msg], 2),
		w.get(`${p}.ffn.0.weight`),
		w.get(`${p}.ffn.0.bias`),
	);
	y = nn.gelu(
		nn.layerNorm(y, w.get(`${p}.ffn.1.weight`), w.get(`${p}.ffn.1.bias`), 1e-5),
	);
	return nn.add(
		x,
		nn.linear(y, w.get(`${p}.ffn.3.weight`), w.get(`${p}.ffn.3.bias`)),
	);
}

function selfBlock(
	nn: Nn,
	w: Weights,
	i: number,
	x: Tensor,
	cos: Tensor,
	sin: Tensor,
): Tensor {
	const p = `transformers.${i}.self_attn`;
	const n = x.shape[1];
	const qkv = nn.linear(x, w.get(`${p}.Wqkv.weight`), w.get(`${p}.Wqkv.bias`));
	const q = nn.rotaryEmbed(heads(nn, nn.slice(qkv, 2, 0, DIM), n), cos, sin);
	const k = nn.rotaryEmbed(
		heads(nn, nn.slice(qkv, 2, DIM, 2 * DIM), n),
		cos,
		sin,
	);
	const v = heads(nn, nn.slice(qkv, 2, 2 * DIM, 3 * DIM), n);
	const ctx = merge(nn, nn.attention(q, k, v), n);
	const msg = nn.linear(
		ctx,
		w.get(`${p}.out_proj.weight`),
		w.get(`${p}.out_proj.bias`),
	);
	return ffn(nn, w, p, x, msg);
}

function crossBlock(
	nn: Nn,
	w: Weights,
	i: number,
	x0: Tensor,
	x1: Tensor,
): [Tensor, Tensor] {
	const p = `transformers.${i}.cross_attn`;
	const n0 = x0.shape[1];
	const n1 = x1.shape[1];
	const qk = (x: Tensor, n: number) =>
		heads(
			nn,
			nn.linear(x, w.get(`${p}.to_qk.weight`), w.get(`${p}.to_qk.bias`)),
			n,
		);
	const vv = (x: Tensor, n: number) =>
		heads(
			nn,
			nn.linear(x, w.get(`${p}.to_v.weight`), w.get(`${p}.to_v.bias`)),
			n,
		);
	const qk0 = qk(x0, n0);
	const qk1 = qk(x1, n1);
	const v0 = vv(x0, n0);
	const v1 = vv(x1, n1);
	const scale = HEAD_DIM ** -0.5;
	const out = (m: Tensor, n: number) =>
		nn.linear(
			merge(nn, m, n),
			w.get(`${p}.to_out.weight`),
			w.get(`${p}.to_out.bias`),
		);
	const m0 = out(nn.attention(qk0, qk1, v1, { scale }), n0);
	const m1 = out(nn.attention(qk1, qk0, v0, { scale }), n1);
	return [ffn(nn, w, p, x0, m0), ffn(nn, w, p, x1, m1)];
}

function logSigmoid(nn: Nn, z: Tensor): Tensor {
	return nn.unary("logSigmoid", z);
}

function tokenConfidence(nn: Nn, w: Weights, i: number, x: Tensor): Tensor {
	const p = `token_confidence.${i}.token.0`;
	return nn.sigmoid(nn.linear(x, w.get(`${p}.weight`), w.get(`${p}.bias`)));
}

function matchability(nn: Nn, w: Weights, i: number, x: Tensor): Tensor {
	const p = `log_assignment.${i}.matchability`;
	return nn.linear(x, w.get(`${p}.weight`), w.get(`${p}.bias`));
}

export async function runLightGlue(
	nn: Nn,
	w: Weights,
	a: LightGlueInput,
	b: LightGlueInput,
	opts: { threshold?: number; adaptive?: boolean; wr?: Float32Array } = {},
): Promise<LightGlueResult> {
	const threshold = opts.threshold ?? FILTER_THRESHOLD;
	const adaptive = opts.adaptive ?? true;
	const m = a.count;
	const n = b.count;
	if (m === 0 || n === 0)
		return {
			matches0: new Int32Array(m).fill(-1),
			matches1: new Int32Array(n).fill(-1),
			scores0: new Float32Array(m),
			stop: 0,
		};
	const wr = opts.wr ?? (await nn.read(w.get("posenc.Wr.weight")));
	const enc = (f: LightGlueInput) =>
		positionalEncoding(
			normalizeKeypoints(f.keypoints, f.count, f.width, f.height),
			f.count,
			wr,
		);
	const e0 = enc(a);
	const e1 = enc(b);
	// row indices still alive (point pruning), into the original sets
	let ind0 = Int32Array.from({ length: m }, (_, i) => i);
	let ind1 = Int32Array.from({ length: n }, (_, i) => i);
	const owned: Tensor[] = [];
	const own = <T extends Tensor>(t: T): T => {
		owned.push(t);
		return t;
	};
	try {
		let cos0 = own(nn.fromArray(e0.cos, [m, HEAD_DIM]));
		let sin0 = own(nn.fromArray(e0.sin, [m, HEAD_DIM]));
		let cos1 = own(nn.fromArray(e1.cos, [n, HEAD_DIM]));
		let sin1 = own(nn.fromArray(e1.sin, [n, HEAD_DIM]));
		let [d0, d1] = await nn.forward(() => [
			own(
				nn.linear(
					nn.fromArray(a.descriptors.subarray(0, m * 128), [1, m, 128]),
					w.get("input_proj.weight"),
					w.get("input_proj.bias"),
				),
			),
			own(
				nn.linear(
					nn.fromArray(b.descriptors.subarray(0, n * 128), [1, n, 128]),
					w.get("input_proj.weight"),
					w.get("input_proj.bias"),
				),
			),
		]);
		let layer = 0;
		for (; layer < LAYERS; layer++) {
			const i = layer;
			const step = await nn.forward(() => {
				const s0 = selfBlock(nn, w, i, d0, cos0, sin0);
				const s1 = selfBlock(nn, w, i, d1, cos1, sin1);
				const [x0, x1] = crossBlock(nn, w, i, s0, s1);
				if (!adaptive || i === LAYERS - 1) return { x0, x1 };
				return {
					x0,
					x1,
					t0: tokenConfidence(nn, w, i, x0),
					t1: tokenConfidence(nn, w, i, x1),
					z0: matchability(nn, w, i, x0),
					z1: matchability(nn, w, i, x1),
				};
			});
			d0 = own(step.x0);
			d1 = own(step.x1);
			if (!step.t0 || !step.t1 || !step.z0 || !step.z1) continue;
			const [t0, t1, z0, z1] = await Promise.all(
				[step.t0, step.t1, step.z0, step.z1].map((t) => nn.read(t)),
			);
			for (const t of [step.t0, step.t1, step.z0, step.z1]) nn.dispose(t);
			const th = Math.fround(confidenceThreshold(i));
			// early stop: share of confident points among the ORIGINAL m + n
			let unconfident = 0;
			for (const c of t0) if (c < th) unconfident++;
			for (const c of t1) if (c < th) unconfident++;
			if (1 - unconfident / (m + n) > DEPTH_CONFIDENCE) break;
			// point pruning: keep matchable (σ(z) > 1 − width) or low-confidence points
			const keepRows = (t: Float32Array, z: Float32Array) => {
				const keep: number[] = [];
				for (let r = 0; r < t.length; r++) {
					const s = 1 / (1 + Math.exp(-z[r]));
					if (s > 1 - WIDTH_CONFIDENCE || t[r] <= th) keep.push(r);
				}
				return Int32Array.from(keep);
			};
			const k0 = keepRows(t0, z0);
			const k1 = keepRows(t1, z1);
			if (k0.length < d0.shape[1] || k1.length < d1.shape[1]) {
				const shrink = async (
					d: Tensor,
					keep: Int32Array,
					cos: Tensor,
					sin: Tensor,
				) => {
					if (keep.length === d.shape[1]) return { d, cos, sin };
					const idx = nn.fromArray(Float32Array.from(keep), [keep.length]);
					return nn.forward(() => ({
						d: own(nn.gather(d, idx, 1)),
						cos: own(nn.gather(cos, idx, 0)),
						sin: own(nn.gather(sin, idx, 0)),
					}));
				};
				const r0 = await shrink(d0, k0, cos0, sin0);
				const r1 = await shrink(d1, k1, cos1, sin1);
				({ d: d0, cos: cos0, sin: sin0 } = r0);
				({ d: d1, cos: cos1, sin: sin1 } = r1);
				ind0 =
					ind0.length === k0.length
						? ind0
						: Int32Array.from(k0, (r) => ind0[r]);
				ind1 =
					ind1.length === k1.length
						? ind1
						: Int32Array.from(k1, (r) => ind1[r]);
			}
			if (d0.shape[1] === 0 || d1.shape[1] === 0) break;
		}
		const stop = Math.min(layer, LAYERS - 1);
		const mm = d0.shape[1];
		const nn1 = d1.shape[1];
		const res = await nn.forward(() => {
			const p = `log_assignment.${stop}`;
			const proj = (x: Tensor) =>
				nn.scale(
					nn.linear(
						x,
						w.get(`${p}.final_proj.weight`),
						w.get(`${p}.final_proj.bias`),
					),
					DIM ** -0.25,
				);
			const sim = nn.matmul(proj(d0), proj(d1), { transposeB: true }); // [1, M, N]
			const z0 = logSigmoid(nn, matchability(nn, w, stop, d0)); // [1, M, 1]
			const z1 = nn.reshape(logSigmoid(nn, matchability(nn, w, stop, d1)), [
				1,
				1,
				nn1,
			]);
			const scores = nn.add(
				nn.add(nn.add(nn.logSoftmax(sim, 2), nn.logSoftmax(sim, 1)), z0),
				z1,
			);
			return { row: nn.topk(scores, 1, 2), col: nn.topk(scores, 1, 1) };
		});
		const [rowMax, rowArg, colArg] = await Promise.all([
			nn.read(res.row.values),
			nn.read(res.row.indices),
			nn.read(res.col.indices),
		]);
		for (const t of [
			res.row.values,
			res.row.indices,
			res.col.values,
			res.col.indices,
		])
			nn.dispose(t);
		const f = filterMatches(rowMax, rowArg, colArg, threshold);
		// back to the original indices (pruned points never match)
		const matches0 = new Int32Array(m).fill(-1);
		const matches1 = new Int32Array(n).fill(-1);
		const scores0 = new Float32Array(m);
		for (let r = 0; r < mm; r++) {
			scores0[ind0[r]] = f.scores0[r];
			const j = f.matches0[r];
			if (j < 0) continue;
			matches0[ind0[r]] = ind1[j];
			matches1[ind1[j]] = ind0[r];
		}
		return { matches0, matches1, scores0, stop: Math.min(layer + 1, LAYERS) };
	} finally {
		for (const t of new Set(owned)) nn.dispose(t);
	}
}
