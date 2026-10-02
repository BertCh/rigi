// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Elementwise kernels: unary (with alpha / beta), binary and where with NumPy broadcasting, strided
// copies (permute / slice / expand), copy-into (concat), fill. Broadcast index math works on the
// shape coalesced to at most MAX_RANK dims.

import type { UnaryPrim } from "../base";
import type { BinaryOp, DType } from "../types";
import { fbits, grid1d, nnKernel } from "./wgsl";

export const MAX_RANK = 6;

export const ENTRY = `@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>,
  @builtin(local_invocation_id) lid: vec3<u32>)`;

/**
 * Merge adjacent dims that are contiguous in every stride set and drop size-1 dims; returns the
 * reduced shape and stride sets (rank ≥ 1).
 */
export function coalesce(
	shape: readonly number[],
	sets: readonly (readonly number[])[],
): { shape: number[]; sets: number[][] } {
	const sh: number[] = [];
	const st: number[][] = sets.map(() => []);
	for (let d = 0; d < shape.length; d++) {
		if (shape[d] === 1) continue;
		const last = sh.length - 1;
		if (last >= 0 && sets.every((s, k) => st[k][last] === s[d] * shape[d])) {
			sh[last] *= shape[d];
			sets.forEach((s, k) => {
				st[k][last] = s[d];
			});
		} else {
			sh.push(shape[d]);
			sets.forEach((s, k) => {
				st[k].push(s[d]);
			});
		}
	}
	if (!sh.length) return { shape: [1], sets: sets.map(() => [0]) };
	if (sh.length > MAX_RANK)
		throw new Error(
			`nn: elementwise rank ${sh.length} > ${MAX_RANK} after coalescing`,
		);
	return { shape: sh, sets: st };
}

const padTo = (a: number[], v = 0) => [
	...a,
	...new Array(MAX_RANK - a.length).fill(v),
];

/** WGSL that decomposes `i` over the shape at M[2..8) into offsets over k stride sets at M[8+6j..]. */
function decompose(k: number): string {
	let s = "  var r = i;\n";
	for (let j = 0; j < k; j++) s += `  var o${j} = 0u;\n`;
	s +=
		"  let rank = mu(1u);\n  for (var d = 0u; d < rank; d++) {\n    let dd = rank - 1u - d;\n    let c = r % mu(2u + dd);\n    r = r / mu(2u + dd);\n";
	for (let j = 0; j < k; j++) s += `    o${j} += c * mu(${8 + 6 * j}u + dd);\n`;
	s += "  }\n";
	return s;
}

export function unaryExpr(op: UnaryPrim): string {
	switch (op) {
		case "relu":
			return "max(v, 0.0)";
		case "gelu":
			return "0.5 * v * (1.0 + erf_s(v * 0.7071067811865476))";
		case "geluTanh":
			return "0.5 * v * (1.0 + tanh_s(0.7978845608028654 * (v + 0.044715 * v * v * v)))";
		case "silu":
			return "v / (1.0 + exp(-v))";
		case "sigmoid":
			return "1.0 / (1.0 + exp(-v))";
		case "tanh":
			return "tanh_s(v)";
		case "elu":
			return "select(exp(v) - 1.0, v, v > 0.0)";
		case "eluA":
			return "select(al * (exp(v) - 1.0), v, v > 0.0)";
		case "selu":
			return "1.0507009873554805 * select(1.6732632423543772 * (exp(v) - 1.0), v, v > 0.0)";
		case "softplus":
			return "select(log(1.0 + exp(v)), v, v > 20.0)";
		case "logSigmoid":
			return "min(v, 0.0) - log(1.0 + exp(-abs(v)))";
		case "exp":
			return "exp(v)";
		case "log":
			return "log(v)";
		case "sqrt":
			return "sqrt(v)";
		case "rsqrt":
			return "inverseSqrt(v)";
		case "abs":
			return "abs(v)";
		case "neg":
			return "-v";
		case "square":
			return "v * v";
		case "recip":
			return "1.0 / v";
		case "floor":
			return "floor(v)";
		case "round":
			return "round(v)";
		case "leakyRelu":
			return "select(al * v, v, v > 0.0)";
		case "clamp":
			return "min(be, max(al, v))";
		case "affine":
			return "v * al + be";
	}
}

export function binaryExpr(op: BinaryOp): string {
	switch (op) {
		case "add":
			return "a + b";
		case "sub":
			return "a - b";
		case "mul":
			return "a * b";
		case "div":
			return "a / b";
		case "max":
			return "max(a, b)";
		case "min":
			return "min(a, b)";
		case "pow":
			// WGSL pow is undefined for a < 0: odd / even integer exponents by hand
			return "select(pow(abs(a), b) * select(1.0, -1.0, (abs(b) % 2.0) == 1.0), pow(a, b), a >= 0.0)";
		case "eq":
			return "select(0.0, 1.0, a == b)";
		case "ne":
			return "select(0.0, 1.0, a != b)";
		case "gt":
			return "select(0.0, 1.0, a > b)";
		case "ge":
			return "select(0.0, 1.0, a >= b)";
		case "lt":
			return "select(0.0, 1.0, a < b)";
		case "le":
			return "select(0.0, 1.0, a <= b)";
	}
}

export type KernelCall = {
	spec: ReturnType<typeof nnKernel>;
	meta: number[];
	wg: [number, number, number];
};

export function unaryKernel(
	op: UnaryPrim,
	dtype: DType,
	n: number,
	alpha: number,
	beta: number,
): KernelCall {
	const spec = nnKernel(
		`unary-${op}`,
		[{ name: "x", dtype }],
		["out"],
		`${ENTRY} {
  let i = lin(wid, nwg, lid);
  if (i >= mu(0u)) { return; }
  let al = mf(1u);
  let be = mf(2u);
  let v = ld_x(i);
  out[i] = ${unaryExpr(op)};
}`,
	);
	return { spec, meta: [n, fbits(alpha), fbits(beta)], wg: grid1d(n) };
}

export type Operand =
	| { kind: "scalar"; value: number }
	| { kind: "tensor"; dtype: DType; strides: number[] };

/**
 * Broadcasting n-ary kernel (binary: [a, b], where: [c, a, b]): `expr` combines locals named by
 * `names`. Operands equal in shape to the output (strides = contiguous) are read flat.
 */
export function naryKernel(
	key: string,
	names: string[],
	ops: Operand[],
	out: number[],
	expr: string,
): KernelCall {
	const tensorSets = ops.flatMap((o) =>
		o.kind === "tensor" ? [o.strides] : [],
	);
	const { shape, sets } = coalesce(out, tensorSets);
	const n = out.reduce((a, b) => a * b, 1);
	const contiguous = (s: number[]) => {
		let acc = 1;
		for (let d = shape.length - 1; d >= 0; d--) {
			if (s[d] !== acc) return false;
			acc *= shape[d];
		}
		return true;
	};
	const flat = sets.map(contiguous);
	const general = flat.some((f) => !f);
	const meta = [n, shape.length, ...padTo(shape, 1)];
	for (const s of sets) meta.push(...padTo(s));
	while (meta.length < 8 + 6 * 3) meta.push(0);
	const scalarBase = meta.length;
	let body = "";
	let ti = 0;
	const inputs: { name: string; dtype: DType }[] = [];
	const variant: string[] = [];
	ops.forEach((o, j) => {
		const nm = names[j];
		if (o.kind === "scalar") {
			body += `  let ${nm} = mf(${scalarBase + j}u);\n`;
			variant.push("s");
		} else {
			inputs.push({ name: `in_${nm}`, dtype: o.dtype });
			const f = flat[ti];
			body += `  let ${nm} = ld_in_${nm}(${f ? "i" : `o${ti}`});\n`;
			variant.push(f ? "f" : "g");
			ti++;
		}
	});
	ops.forEach((o) => {
		meta.push(o.kind === "scalar" ? fbits(o.value) : 0);
	});
	const spec = nnKernel(
		`${key}-${variant.join("")}`,
		inputs,
		["out"],
		`${ENTRY} {
  let i = lin(wid, nwg, lid);
  if (i >= mu(0u)) { return; }
${general ? decompose(sets.length) : ""}${body}  out[i] = ${expr};
}`,
	);
	return { spec, meta, wg: grid1d(n) };
}

/** out[i] = x[offset + Σ c_d · strides_d] over `out` (permute, slice, expand). */
export function stridedCopyKernel(
	dtype: DType,
	out: number[],
	strides: number[],
	offset: number,
): KernelCall {
	const { shape, sets } = coalesce(out, [strides]);
	const n = out.reduce((a, b) => a * b, 1);
	const meta = [n, shape.length, ...padTo(shape, 1), ...padTo(sets[0]), offset];
	const spec = nnKernel(
		"copy",
		[{ name: "x", dtype }],
		["out"],
		`${ENTRY} {
  let i = lin(wid, nwg, lid);
  if (i >= mu(0u)) { return; }
${decompose(1)}  out[i] = ld_x(mu(14u) + o0);
}`,
	);
	return { spec, meta, wg: grid1d(n) };
}

/** out[dstOffset + Σ c_d · dstStrides_d] = x[i] over x's shape (concat parts). */
export function copyIntoKernel(
	dtype: DType,
	shapeIn: number[],
	dstStrides: number[],
	dstOffset: number,
): KernelCall {
	const { shape, sets } = coalesce(shapeIn, [dstStrides]);
	const n = shapeIn.reduce((a, b) => a * b, 1);
	const meta = [
		n,
		shape.length,
		...padTo(shape, 1),
		...padTo(sets[0]),
		dstOffset,
	];
	const spec = nnKernel(
		"copy-into",
		[{ name: "x", dtype }],
		["out"],
		`${ENTRY} {
  let i = lin(wid, nwg, lid);
  if (i >= mu(0u)) { return; }
${decompose(1)}  out[mu(14u) + o0] = ld_x(i);
}`,
	);
	return { spec, meta, wg: grid1d(n) };
}

export function fillKernel(n: number, value: number): KernelCall {
	const spec = nnKernel(
		"fill",
		[],
		["out"],
		`${ENTRY} {
  let i = lin(wid, nwg, lid);
  if (i >= mu(0u)) { return; }
  out[i] = mf(1u);
}`,
	);
	return { spec, meta: [n, fbits(value)], wg: grid1d(n) };
}
