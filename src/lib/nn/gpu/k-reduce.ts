// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Row-wise kernels with workgroup reductions (softmax, logSoftmax, layerNorm, groupNorm, l2Normalize,
// sum / mean / max / min / argmax). A row is `len` elements `inner` apart. Rows with inner == 1 run
// one 256-thread workgroup per row (tree reductions in workgroup memory); strided rows (inner > 1)
// run one invocation per (outer, inner) column with sequential loops.

import {
	argStep,
	maxStep,
	minStep,
	type ReduceStep,
	sumStep,
	wgslTreeReduce,
} from "#/lib/gpu/core/wgsl/reduce";
import type { ReducePrim } from "../base";
import type { DType } from "../types";
import { ENTRY, type KernelCall } from "./k-elementwise";
import { fbits, grid1d, nnKernel } from "./wgsl";

/** Workgroups for `rows` row-groups, folded past 65535. */
function rowGrid(rows: number): [number, number, number] {
	if (rows <= 65535) return [Math.max(1, rows), 1, 1];
	const y = Math.ceil(rows / 65535);
	return [Math.ceil(rows / y), y, 1];
}

const tree = (step: ReduceStep) =>
	wgslTreeReduce({ size: 256, lane: "t", steps: [step] });
const TREE_SUM = tree(sumStep("red"));
const TREE_MAX = tree(maxStep("red"));
const TREE_MIN = tree(minStep("red"));
const TREE_ARGMAX = tree(argStep({ value: "red", index: "redi", mode: "max" }));

const ROW_ENTRY = `var<workgroup> red: array<f32, 256>;
var<workgroup> redi: array<u32, 256>;
fn wg_sum(v: f32, t: u32) -> f32 {
  red[t] = v;
${TREE_SUM}
  let r = red[0];
  workgroupBarrier();
  return r;
}
fn wg_max(v: f32, t: u32) -> f32 {
  red[t] = v;
${TREE_MAX}
  let r = red[0];
  workgroupBarrier();
  return r;
}
fn wg_min(v: f32, t: u32) -> f32 {
  red[t] = v;
${TREE_MIN}
  let r = red[0];
  workgroupBarrier();
  return r;
}
// arg-max: larger value wins, ties to the lower index
fn wg_argmax(v: f32, i: u32, t: u32) -> u32 {
  red[t] = v;
  redi[t] = i;
${TREE_ARGMAX}
  let r = redi[0];
  workgroupBarrier();
  return r;
}
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>,
  @builtin(local_invocation_id) lid: vec3<u32>)`;

/** Softmax / logSoftmax along rows. M: [rows, len, inner] */
export function softmaxKernel(
	dtype: DType,
	outer: number,
	len: number,
	inner: number,
	log: boolean,
): KernelCall {
	const fin = log ? "v - mx - log(s)" : "exp(v - mx) / s";
	if (inner === 1) {
		const spec = nnKernel(
			`softmax-row${log ? "-log" : ""}`,
			[{ name: "x", dtype }],
			["out"],
			`${ROW_ENTRY} {
  let row = wid.y * nwg.x + wid.x;
  let t = lid.x;
  let len = mu(1u);
  let base = row * len;
  var m = -3.402823e38;
  for (var i = t; i < len; i += 256u) { m = max(m, ld_x(base + i)); }
  let mx = wg_max(m, t);
  var a = 0.0;
  for (var i = t; i < len; i += 256u) { a += exp(ld_x(base + i) - mx); }
  let s = wg_sum(a, t);
  if (row >= mu(0u)) { return; }
  for (var i = t; i < len; i += 256u) {
    let v = ld_x(base + i);
    out[base + i] = ${fin};
  }
}`,
		);
		return { spec, meta: [outer, len, 1], wg: rowGrid(outer) };
	}
	const spec = nnKernel(
		`softmax-col${log ? "-log" : ""}`,
		[{ name: "x", dtype }],
		["out"],
		`${ENTRY} {
  let c = lin(wid, nwg, lid);
  let len = mu(1u);
  let inner = mu(2u);
  if (c >= mu(0u) * inner) { return; }
  let base = (c / inner) * len * inner + c % inner;
  var mx = -3.402823e38;
  for (var i = 0u; i < len; i++) { mx = max(mx, ld_x(base + i * inner)); }
  var s = 0.0;
  for (var i = 0u; i < len; i++) { s += exp(ld_x(base + i * inner) - mx); }
  for (var i = 0u; i < len; i++) {
    let v = ld_x(base + i * inner);
    out[base + i * inner] = ${fin};
  }
}`,
	);
	return { spec, meta: [outer, len, inner], wg: grid1d(outer * inner) };
}

/** layerNorm over rows of C. M: [rows, C, eps] */
export function layerNormKernel(
	dx: DType,
	dw: DType | null,
	db: DType | null,
	rows: number,
	C: number,
	eps: number,
): KernelCall {
	const spec = nnKernel(
		`layernorm${dw ? "-w" : ""}${db ? "-b" : ""}`,
		[
			{ name: "x", dtype: dx },
			...(dw ? [{ name: "w", dtype: dw }] : []),
			...(db ? [{ name: "b", dtype: db }] : []),
		],
		["out"],
		`${ROW_ENTRY} {
  let row = wid.y * nwg.x + wid.x;
  let t = lid.x;
  let C = mu(1u);
  let base = row * C;
  var a = 0.0;
  for (var i = t; i < C; i += 256u) { a += ld_x(base + i); }
  let mean = wg_sum(a, t) / f32(C);
  var q = 0.0;
  for (var i = t; i < C; i += 256u) { let d = ld_x(base + i) - mean; q += d * d; }
  let inv = inverseSqrt(wg_sum(q, t) / f32(C) + mf(2u));
  if (row >= mu(0u)) { return; }
  for (var i = t; i < C; i += 256u) {
    out[base + i] = (ld_x(base + i) - mean) * inv${dw ? " * ld_w(i)" : ""}${db ? " + ld_b(i)" : ""};
  }
}`,
	);
	return { spec, meta: [rows, C, fbits(eps)], wg: rowGrid(rows) };
}

/** groupNorm: one workgroup per (n, group). M: [N·G, cpg·inner, inner, cpg, G, eps] */
export function groupNormKernel(
	dx: DType,
	dw: DType | null,
	db: DType | null,
	N: number,
	C: number,
	G: number,
	inner: number,
	eps: number,
): KernelCall {
	const cpg = C / G;
	const spec = nnKernel(
		`groupnorm${dw ? "-w" : ""}${db ? "-b" : ""}`,
		[
			{ name: "x", dtype: dx },
			...(dw ? [{ name: "w", dtype: dw }] : []),
			...(db ? [{ name: "b", dtype: db }] : []),
		],
		["out"],
		`${ROW_ENTRY} {
  let row = wid.y * nwg.x + wid.x;
  let t = lid.x;
  let len = mu(1u);
  let inner = mu(2u);
  let base = row * len;
  var a = 0.0;
  for (var i = t; i < len; i += 256u) { a += ld_x(base + i); }
  let mean = wg_sum(a, t) / f32(len);
  var q = 0.0;
  for (var i = t; i < len; i += 256u) { let d = ld_x(base + i) - mean; q += d * d; }
  let inv = inverseSqrt(wg_sum(q, t) / f32(len) + mf(5u));
  if (row >= mu(0u)) { return; }
  let c0 = (row % mu(4u)) * mu(3u);
  for (var i = t; i < len; i += 256u) {
    let c = c0 + i / inner;
    out[base + i] = (ld_x(base + i) - mean) * inv${dw ? " * ld_w(c)" : ""}${db ? " + ld_b(c)" : ""};
  }
}`,
	);
	return {
		spec,
		meta: [N * G, cpg * inner, inner, cpg, G, fbits(eps)],
		wg: rowGrid(N * G),
	};
}

/** x / max(‖x‖, eps) along rows. M: [outer, len, inner, eps] */
export function l2NormKernel(
	dtype: DType,
	outer: number,
	len: number,
	inner: number,
	eps: number,
): KernelCall {
	if (inner === 1) {
		const spec = nnKernel(
			"l2norm-row",
			[{ name: "x", dtype }],
			["out"],
			`${ROW_ENTRY} {
  let row = wid.y * nwg.x + wid.x;
  let t = lid.x;
  let len = mu(1u);
  let base = row * len;
  var a = 0.0;
  for (var i = t; i < len; i += 256u) { let v = ld_x(base + i); a += v * v; }
  let d = max(sqrt(wg_sum(a, t)), mf(3u));
  if (row >= mu(0u)) { return; }
  for (var i = t; i < len; i += 256u) { out[base + i] = ld_x(base + i) / d; }
}`,
		);
		return { spec, meta: [outer, len, 1, fbits(eps)], wg: rowGrid(outer) };
	}
	const spec = nnKernel(
		"l2norm-col",
		[{ name: "x", dtype }],
		["out"],
		`${ENTRY} {
  let c = lin(wid, nwg, lid);
  let len = mu(1u);
  let inner = mu(2u);
  if (c >= mu(0u) * inner) { return; }
  let base = (c / inner) * len * inner + c % inner;
  var a = 0.0;
  for (var i = 0u; i < len; i++) { let v = ld_x(base + i * inner); a += v * v; }
  let d = max(sqrt(a), mf(3u));
  for (var i = 0u; i < len; i++) { out[base + i * inner] = ld_x(base + i * inner) / d; }
}`,
	);
	return {
		spec,
		meta: [outer, len, inner, fbits(eps)],
		wg: grid1d(outer * inner),
	};
}

/** sum / mean / max / min / argmax along rows. M: [outer, len, inner] */
export function reduceKernel(
	op: ReducePrim,
	dtype: DType,
	outer: number,
	len: number,
	inner: number,
): KernelCall {
	if (inner === 1 && len >= 256) {
		const red =
			op === "argmax"
				? `var bv = -3.402823e38;
  var bi = 0u;
  for (var i = t; i < len; i += 256u) { let v = ld_x(base + i); if (v > bv) { bv = v; bi = i; } }
  let r = f32(wg_argmax(bv, bi, t));`
				: op === "max"
					? `var a = -3.402823e38;
  for (var i = t; i < len; i += 256u) { a = max(a, ld_x(base + i)); }
  let r = wg_max(a, t);`
					: op === "min"
						? `var a = 3.402823e38;
  for (var i = t; i < len; i += 256u) { a = min(a, ld_x(base + i)); }
  let r = wg_min(a, t);`
						: `var a = 0.0;
  for (var i = t; i < len; i += 256u) { a += ld_x(base + i); }
  let r = wg_sum(a, t)${op === "mean" ? " / f32(len)" : ""};`;
		const spec = nnKernel(
			`reduce-row-${op}`,
			[{ name: "x", dtype }],
			["out"],
			`${ROW_ENTRY} {
  let row = wid.y * nwg.x + wid.x;
  let t = lid.x;
  let len = mu(1u);
  let base = row * len;
  ${red}
  if (row < mu(0u) && t == 0u) { out[row] = r; }
}`,
		);
		return { spec, meta: [outer, len, 1], wg: rowGrid(outer) };
	}
	const init =
		op === "max" || op === "argmax"
			? "-3.402823e38"
			: op === "min"
				? "3.402823e38"
				: "0.0";
	const step =
		op === "argmax"
			? "if (v > a) { a = v; ai = i; }"
			: op === "max"
				? "a = max(a, v);"
				: op === "min"
					? "a = min(a, v);"
					: "a += v;";
	const fin =
		op === "argmax" ? "f32(ai)" : op === "mean" ? "a / f32(len)" : "a";
	const spec = nnKernel(
		`reduce-col-${op}`,
		[{ name: "x", dtype }],
		["out"],
		`${ENTRY} {
  let c = lin(wid, nwg, lid);
  let len = mu(1u);
  let inner = mu(2u);
  if (c >= mu(0u) * inner) { return; }
  let base = (c / inner) * len * inner + c % inner;
  var a = ${init};
  var ai = 0u;
  for (var i = 0u; i < len; i++) {
    let v = ld_x(base + i * inner);
    ${step}
  }
  out[c] = ${fin};
}`,
	);
	return { spec, meta: [outer, len, inner], wg: grid1d(outer * inner) };
}
