// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Elementwise kernels: unary (with alpha / beta), binary and where with NumPy broadcasting, strided
// copies (permute / slice / expand), copy-into (concat), fill. Broadcast index math works on the
// shape coalesced to at most MAX_RANK dims.

import type { UnaryPrim } from "../base";
import { stridesOf } from "../shape";
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

export const padTo = (a: number[], v = 0) => [
	...a,
	...new Array(MAX_RANK - a.length).fill(v),
];

/**
 * WGSL that decomposes `i` over the shape at M[base+2..base+8) into offsets over k stride sets at
 * M[base+8+6j..]; `base` is where the elementwise header (n, rank, shape, strides) starts in M.
 */
export function decompose(k: number, base = 0): string {
	let s = "  var r = i;\n";
	for (let j = 0; j < k; j++) s += `  var o${j} = 0u;\n`;
	s += `  let rank = mu(${base + 1}u);\n  for (var d = 0u; d < rank; d++) {\n    let dd = rank - 1u - d;\n    let c = r % mu(${base + 2}u + dd);\n    r = r / mu(${base + 2}u + dd);\n`;
	for (let j = 0; j < k; j++)
		s += `    o${j} += c * mu(${base + 8 + 6 * j}u + dd);\n`;
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
 * An elementwise computation over `shape`, described so that chains of them can fuse into one kernel
 * (gpu/fusion.ts). `ops` are the operands in kernel order (tensor operands match the node's inputs
 * one to one, in order). `stmt(names, out, uid)` returns WGSL statements that assign the result to
 * the f32 variable `out`, reading operand j from the f32 expression `names[j]`; it opens its own
 * block for locals, and takes unique variable names from `uid`. `key` identifies `stmt` (and the
 * operand layout) for kernel memoisation: equal keys must generate equal code.
 */
export type EwDesc = {
	shape: number[];
	ops: Operand[];
	key: string;
	stmt: (names: string[], out: string, uid: () => string) => string;
};

/** The kernel of an elementwise description: out[i] = stmt over the (coalesced) broadcast index. */
export function ewKernel(d: EwDesc): KernelCall {
	const tensorSets = d.ops.flatMap((o) =>
		o.kind === "tensor" ? [o.strides] : [],
	);
	const { shape, sets } = coalesce(d.shape, tensorSets);
	const n = d.shape.reduce((a, b) => a * b, 1);
	const contiguous = (s: number[]) => {
		let acc = 1;
		for (let k = shape.length - 1; k >= 0; k--) {
			if (s[k] !== acc) return false;
			acc *= shape[k];
		}
		return true;
	};
	const flat = sets.map(contiguous);
	const general = flat.some((f) => !f);
	const meta = [n, shape.length, ...padTo(shape, 1)];
	for (const s of sets) meta.push(...padTo(s));
	let body = "";
	let ti = 0;
	let si = 0;
	const inputs: { name: string; dtype: DType }[] = [];
	const variant: string[] = [];
	const names: string[] = [];
	d.ops.forEach((o, j) => {
		const nm = `x${j}`;
		names.push(nm);
		if (o.kind === "scalar") {
			body += `  let ${nm} = mf(${meta.length + si++}u);\n`;
			variant.push("s");
		} else {
			inputs.push({ name: `in${ti}`, dtype: o.dtype });
			const f = flat[ti];
			body += `  let ${nm} = ld_in${ti}(${f ? "i" : `o${ti}`});\n`;
			variant.push(f ? "f" : "g");
			ti++;
		}
	});
	// scalar words follow the stride sets (the indices above were taken before these pushes)
	for (const o of d.ops) if (o.kind === "scalar") meta.push(fbits(o.value));
	let uidCount = 0;
	const stmt = d.stmt(names, "acc", () => `w${uidCount++}`);
	const spec = nnKernel(
		`ew-${d.key}-${variant.join("")}`,
		inputs,
		["out"],
		`${ENTRY} {
  let i = lin(wid, nwg, lid);
  if (i >= mu(0u)) { return; }
${general ? decompose(sets.length) : ""}${body}  var acc = 0.0;
  ${stmt}
  out[i] = acc;
}`,
	);
	return { spec, meta, wg: grid1d(n) };
}

/** Description of a unary op over `shape` (alpha / beta are scalar operands, not baked in). */
export function unaryDesc(
	op: UnaryPrim,
	dtype: DType,
	shape: number[],
	alpha: number,
	beta: number,
): EwDesc {
	return {
		shape,
		ops: [
			{ kind: "tensor", dtype, strides: stridesOf(shape) },
			{ kind: "scalar", value: alpha },
			{ kind: "scalar", value: beta },
		],
		key: `u-${op}`,
		stmt: (n, out) =>
			`{ let v = ${n[0]}; let al = ${n[1]}; let be = ${n[2]}; ${out} = ${unaryExpr(op)}; }`,
	};
}

/** Description of an n-ary op (binary: names [a, b]; where: [c, a, b]) with broadcasting operands. */
export function naryDesc(
	key: string,
	names: string[],
	ops: Operand[],
	out: number[],
	expr: string,
): EwDesc {
	return {
		shape: out,
		ops,
		key,
		stmt: (n, o) =>
			`{ ${names.map((nm, j) => `let ${nm} = ${n[j]};`).join(" ")} ${o} = ${expr}; }`,
	};
}

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
	return ewKernel(naryDesc(key, names, ops, out, expr));
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
