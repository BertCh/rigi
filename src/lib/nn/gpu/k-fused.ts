// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Fused kernels the planner (fusion.ts) substitutes for node pairs: layerNorm over the result of an
// elementwise expression (the residual add of a transformer block), optionally also writing that
// result (the residual stream the next block adds to).

import type { DType } from "../types";
import {
	coalesce,
	decompose,
	type EwDesc,
	type KernelCall,
	padTo,
} from "./k-elementwise";
import { fbits, nnKernel } from "./wgsl";

/** What a layerNorm node needs to be rebuilt around a fused producer. */
export type LayerNormDesc = {
	dw: DType | null;
	db: DType | null;
	rows: number;
	C: number;
	eps: number;
};

const ROW_ENTRY = `var<workgroup> red: array<f32, 256>;
fn wg_sum(v: f32, t: u32) -> f32 {
  red[t] = v;
  workgroupBarrier();
  for (var s = 128u; s > 0u; s >>= 1u) {
    if (t < s) { red[t] += red[t + s]; }
    workgroupBarrier();
  }
  let r = red[0];
  workgroupBarrier();
  return r;
}
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>,
  @builtin(local_invocation_id) lid: vec3<u32>)`;

function rowGrid(rows: number): [number, number, number] {
	if (rows <= 65535) return [Math.max(1, rows), 1, 1];
	const y = Math.ceil(rows / 65535);
	return [Math.ceil(rows / y), y, 1];
}

/**
 * layerNorm(ew) over rows of C, where `ew` is a flat elementwise expression of the same element
 * count (every tensor operand contiguous). Inputs: ew's tensor operands, then w, b; outputs: `out`
 * (the normalised rows) and, when `emitSum`, `sum` (the expression's value). M: [rows, C, eps,
 * ew scalars...]. The expression is evaluated three times per element (mean, variance, output) from
 * cached operand reads instead of a round trip through memory.
 */
export function layerNormResidualKernel(
	ew: EwDesc,
	ln: LayerNormDesc,
	emitSum: boolean,
): KernelCall {
	const inputs: { name: string; dtype: DType }[] = [];
	const names: string[] = [];
	// M: [rows, C, eps, then the elementwise header at 3: n, rank, shape(6), stride sets(6 each), scalars]
	const { shape, sets } = coalesce(
		ew.shape,
		ew.ops.flatMap((o) => (o.kind === "tensor" ? [o.strides] : [])),
	);
	const base = 3;
	const meta = [
		ln.rows,
		ln.C,
		fbits(ln.eps),
		ln.rows * ln.C,
		shape.length,
		...padTo(shape, 1),
	];
	for (const s of sets) meta.push(...padTo(s));
	let loads = "";
	let ti = 0;
	for (const o of ew.ops) {
		const nm = `x${names.length}`;
		names.push(nm);
		if (o.kind === "scalar") {
			loads += `  let ${nm} = mf(${meta.length}u);\n`;
			meta.push(fbits(o.value));
		} else {
			inputs.push({ name: `in${ti}`, dtype: o.dtype });
			loads += `  let ${nm} = ld_in${ti}(o${ti});\n`;
			ti++;
		}
	}
	if (ln.dw) inputs.push({ name: "w", dtype: ln.dw });
	if (ln.db) inputs.push({ name: "b", dtype: ln.db });
	let uidCount = 0;
	const stmt = ew.stmt(names, "acc", () => `w${uidCount++}`);
	const spec = nnKernel(
		`lnres-${ew.key}-${ew.ops.map((o) => o.kind[0]).join("")}${ln.dw ? "-w" : ""}${ln.db ? "-b" : ""}${emitSum ? "-s" : ""}`,
		inputs,
		emitSum ? ["out", "sum"] : ["out"],
		`fn xval(i: u32) -> f32 {
${decompose(sets.length, base)}${loads}  var acc = 0.0;
  ${stmt}
  return acc;
}
${ROW_ENTRY} {
  let row = wid.y * nwg.x + wid.x;
  let t = lid.x;
  let C = mu(1u);
  let base = row * C;
  var a = 0.0;
  for (var i = t; i < C; i += 256u) { a += xval(base + i); }
  let mean = wg_sum(a, t) / f32(C);
  var q = 0.0;
  for (var i = t; i < C; i += 256u) { let d = xval(base + i) - mean; q += d * d; }
  let inv = inverseSqrt(wg_sum(q, t) / f32(C) + mf(2u));
  if (row >= mu(0u)) { return; }
  for (var i = t; i < C; i += 256u) {
    let v = xval(base + i);
${emitSum ? "    sum[base + i] = v;\n" : ""}    out[base + i] = (v - mean) * inv${ln.dw ? " * ld_w(i)" : ""}${ln.db ? " + ld_b(i)" : ""};
  }
}`,
	);
	return { spec, meta, wg: rowGrid(ln.rows) };
}
