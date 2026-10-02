// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Load-time dequantization (../quant.ts format): packed int8 / int4 words + per-group scales → the
// weight as f16 (two halves per u32 word, pack2x16float, so no shader-f16 is needed to write it) or f32.
// One node per weight, recorded at weightsFromBytes and submitted with the next flush. This is the
// expanded path (int4, ineligible tensors, quantResident off); eligible int8 tensors stay resident
// instead and are dequantized inside the GEMM / conv weight loads (wgsl.ts q8Loaders, ../quant.ts
// packResident), so they never reach this kernel.

import type { QuantBits } from "../quant";
import type { DType } from "../types";
import { ENTRY, type KernelCall } from "./k-elementwise";
import { grid1d, nnKernel } from "./wgsl";

/** WGSL of the quantized value of element i. */
const QVAL: Record<QuantBits, string> = {
	// byte i of the buffer = bits (i & 3) · 8 of word i >> 2; extractBits on i32 sign-extends
	8: "return f32(extractBits(bitcast<i32>(q[i >> 2u]), (i & 3u) * 8u, 8u));",
	// element i = nibble (i & 7) of word i >> 3 (element 2k in the low nibble of byte k), stored + 8
	4: "return f32(i32(extractBits(q[i >> 3u], (i & 7u) * 4u, 4u)) - 8);",
};

/**
 * M = [numel, cols, group, groups]. `out` is f16 pairs packed in u32 (`half`) or f32; `scaleType` is
 * the scale tensor's storage type.
 */
export function dequantKernel(
	bits: QuantBits,
	out: DType,
	scaleType: DType,
	numel: number,
	cols: number,
	group: number,
): KernelCall {
	const half = out === "f16";
	const spec = nnKernel(
		`dequant${bits}${half ? "h" : "f"}`,
		[
			{ name: "q", dtype: "f32" },
			{ name: "scale", dtype: scaleType },
		],
		["out"],
		`fn qv(i: u32) -> f32 { ${QVAL[bits]} }
fn dq(i: u32) -> f32 {
  if (i >= mu(0u)) { return 0.0; }
  let row = i / mu(1u);
  let g = (i - row * mu(1u)) / mu(2u);
  return qv(i) * ld_scale(row * mu(3u) + g);
}
${ENTRY} {
  let i = lin(wid, nwg, lid);
  ${
		half
			? `if (2u * i >= mu(0u)) { return; }
  out[i] = pack2x16float(vec2<f32>(dq(2u * i), dq(2u * i + 1u)));`
			: `if (i >= mu(0u)) { return; }
  out[i] = bitcast<u32>(dq(i));`
	}
}`,
		[],
		{ q: "u32", out: "u32" },
	);
	const n = half ? Math.ceil(numel / 2) : numel;
	return { spec, meta: [numel, cols, group, cols / group], wg: grid1d(n) };
}
