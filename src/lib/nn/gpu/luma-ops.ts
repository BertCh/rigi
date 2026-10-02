// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// nn ops that run on luma gpgpu operators (GPUTranspose, GPUElementwise, GPUReduction, GPUSort) where
// `scripts/nn/luma-ops-bench.ts` measured them at least as fast as the nn kernels and the semantics
// match; see README "Luma operators". Each builder returns a LumaCall for runtime.ts (a node whose
// work is a luma contributor added to the forward's graph, views over the same storages).

import {
	GPUElementwise,
	GPUFFT2D,
	GPUReduction,
	GPUSort,
	GPUTranspose,
} from "#/lib/gpu/core/luma";
import type { BinaryOp } from "../types";
import { ENTRY } from "./k-elementwise";
import type { LumaCall } from "./runtime";
import { grid1d, nnKernel } from "./wgsl";

let serial = 0;
const nextId = (what: string) => `nn-${what}-${serial++}`;

/** Elementwise ops luma has, by nn name (all f32, equal shapes, both operands tensors). */
const ELEMENTWISE = {
	add: "add",
	sub: "subtract",
	mul: "multiply",
	max: "max",
	min: "min",
} as const;

export function lumaBinaryOp(op: BinaryOp): keyof typeof ELEMENTWISE | null {
	return op in ELEMENTWISE ? (op as keyof typeof ELEMENTWISE) : null;
}

export function lumaBinary(op: keyof typeof ELEMENTWISE, n: number): LumaCall {
	const slot = { len: n, format: "float32" } as const;
	return {
		key: `luma-ew-${op}-${n}`,
		ins: [slot, slot],
		outs: [slot],
		add: (g, [a, b], [o]) =>
			g.add(
				new GPUElementwise({
					id: nextId("ew"),
					operation: ELEMENTWISE[op],
					input: a as never,
					inputB: b as never,
					output: o as never,
				}),
			),
	};
}

/** [rows, columns] row-major → [columns, rows]. */
export function lumaTranspose(rows: number, columns: number): LumaCall {
	const slot = { len: rows * columns, format: "float32" } as const;
	return {
		key: `luma-t-${rows}x${columns}`,
		ins: [slot],
		outs: [slot],
		add: (g, [x], [o]) =>
			g.add(
				new GPUTranspose({
					id: nextId("t"),
					input: x as never,
					output: o as never,
					rows,
					columns,
				}),
			),
	};
}

/** Full reduction of n elements to one (sum / min / max). */
export function lumaReduce(op: "sum" | "min" | "max", n: number): LumaCall {
	return {
		key: `luma-r-${op}-${n}`,
		ins: [{ len: n, format: "float32" }],
		outs: [{ len: 1, format: "float32" }],
		add: (g, [x], [o]) =>
			g.add(
				new GPUReduction({
					id: nextId("r"),
					operation: op,
					input: x as never,
					output: o as never,
				}),
			),
	};
}

/** Full-reduction sizes from which GPUReduction beats the one-workgroup nn kernel (bench: 2^18 and up). */
export const LUMA_REDUCE_MIN = 1 << 18;
/** Row lengths from which a GPUSort topk beats the bitonic nn kernels (bench). */
export const LUMA_TOPK_MIN = 1 << 16;

const ELEM_U32 = { keys: "u32", idx: "u32", sk: "u32", sv: "u32" };

/**
 * Single-row topk (largest k, ties to the lower index) as: key transform (descending float order as an
 * ascending u32, -0 folded into +0), luma GPUSort (stable, ascending), decode of the first k.
 * Storages are f32-typed words holding u32 bit patterns.
 */
export function lumaTopkPlan(len: number, k: number) {
	const init = {
		spec: nnKernel(
			"lsort-init",
			[{ name: "x", dtype: "f32" }],
			["keys", "idx"],
			`${ENTRY} {
  let i = lin(wid, nwg, lid);
  if (i >= mu(0u)) { return; }
  var v = ld_x(i);
  v = select(v, 0.0, v == 0.0);
  let u = bitcast<u32>(v);
  let ord = select(u | 0x80000000u, ~u, (u & 0x80000000u) != 0u);
  keys[i] = ~ord;
  idx[i] = i;
}`,
			[],
			ELEM_U32,
		),
		meta: [len],
		wg: grid1d(len),
	};
	const sort: LumaCall = {
		key: `luma-sort-${len}`,
		ins: [
			{ len, format: "uint32" },
			{ len, format: "uint32" },
		],
		outs: [
			{ len, format: "uint32" },
			{ len, format: "uint32" },
		],
		add: (g, [keys, vals], [sk, sv]) =>
			g.add(
				new GPUSort({
					id: nextId("sort"),
					keys: keys as never,
					values: vals as never,
					outputKeys: sk as never,
					outputValues: sv as never,
					algorithm: "auto",
					direction: "ascending",
				}),
			),
	};
	const final = {
		spec: nnKernel(
			"lsort-final",
			[
				{ name: "sk", dtype: "f32" },
				{ name: "sv", dtype: "f32" },
			],
			["values", "indices"],
			`${ENTRY} {
  let i = lin(wid, nwg, lid);
  if (i >= mu(0u)) { return; }
  let ord = ~sk[i];
  let u = select(~ord, ord & 0x7fffffffu, (ord & 0x80000000u) != 0u);
  values[i] = bitcast<f32>(u);
  indices[i] = f32(sv[i]);
}`,
			[],
			ELEM_U32,
		),
		meta: [k],
		wg: grid1d(k),
	};
	return { init, sort, final };
}

/** Complex 2-D FFT of `batch` fields (height × width, packed vec2) on GPUFFT2D; the inverse scales by 1/(w·h). */
export function lumaFft2d(
	direction: "forward" | "inverse",
	batch: number,
	height: number,
	width: number,
): LumaCall {
	const slot = {
		len: batch * height * width,
		format: "float32x2",
	} as const;
	return {
		key: `luma-fft2d-${direction}-${batch}x${height}x${width}`,
		ins: [slot],
		outs: [slot],
		add: (g, [x], [o]) =>
			g.add(
				new GPUFFT2D({
					id: nextId("fft2d"),
					input: x as never,
					output: o as never,
					direction,
					width,
					height,
					batchCount: batch,
				}),
			),
	};
}

const ONE = { name: "x", dtype: "f32" } as const;

/** The three kernels around the FFT of rfft2: real → complex, then the W/2+1 columns kept. */
export function rfftKernels(batch: number, height: number, width: number) {
	const wf = (width >> 1) + 1;
	const pack = {
		spec: nnKernel(
			"rfft-pack",
			[{ ...ONE }],
			["z"],
			`${ENTRY} {
  let i = lin(wid, nwg, lid);
  if (i >= mu(0u)) { return; }
  z[2u * i] = ld_x(i);
  z[2u * i + 1u] = 0.0;
}`,
		),
		meta: [batch * height * width],
		wg: grid1d(batch * height * width),
	};
	const crop = {
		spec: nnKernel(
			"rfft-crop",
			[{ ...ONE }],
			["y"],
			`${ENTRY} {
  let j = lin(wid, nwg, lid);
  let wf = mu(1u);
  if (j >= mu(0u) * wf * 2u) { return; }
  let c = j & 1u;
  let t = j >> 1u;
  let w = t % wf;
  let bh = t / wf;
  y[j] = ld_x((bh * mu(2u) + w) * 2u + c);
}`,
		),
		meta: [batch * height, wf, width],
		wg: grid1d(batch * height * wf * 2),
	};
	return { pack, crop };
}

/** The kernels around the FFT of irfft2: Hermitian fill of the half spectrum, then the real part. */
export function irfftKernels(batch: number, height: number, width: number) {
	const wf = (width >> 1) + 1;
	const expand = {
		spec: nnKernel(
			"irfft-expand",
			[{ ...ONE }],
			["z"],
			`${ENTRY} {
  let j = lin(wid, nwg, lid);
  let W = mu(3u);
  let H = mu(2u);
  let wf = mu(1u);
  if (j >= mu(0u) * H * W * 2u) { return; }
  let c = j & 1u;
  let t = j >> 1u;
  let w = t % W;
  let bh = t / W;
  let h = bh % H;
  let b = bh / H;
  if (w < wf) {
    z[j] = ld_x(((b * H + h) * wf + w) * 2u + c);
  } else {
    let v = ld_x(((b * H + (H - h) % H) * wf + (W - w)) * 2u + c);
    z[j] = select(v, -v, c == 1u);
  }
}`,
		),
		meta: [batch, wf, height, width],
		wg: grid1d(batch * height * width * 2),
	};
	const real = {
		spec: nnKernel(
			"irfft-real",
			[{ ...ONE }],
			["y"],
			`${ENTRY} {
  let i = lin(wid, nwg, lid);
  if (i >= mu(0u)) { return; }
  y[i] = ld_x(2u * i);
}`,
		),
		meta: [batch * height * width],
		wg: grid1d(batch * height * width),
	};
	return { expand, real };
}
