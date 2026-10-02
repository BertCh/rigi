// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// WGSL generation for nn kernels. Every kernel has the same binding shape:
//   @binding(0) M: array<u32>        per-node parameters (u32 words; f32 via bitcast), a range of the
//                                    graph's one constant meta buffer
//   @binding(1..n) inputs            array<f32> or array<f16> (read with ld_<name>(i) -> f32)
//   @binding(n+1..) outputs          array<f32>
// so one kernel body serves f32 and f16 storage; the spec is memoised per (name, dtypes, variant).

import { defineKernel, type KernelSpec } from "#/lib/gpu/core/kernel";
import type { DType } from "../types";

export const WG = 256;

/** Shared WGSL helpers available to every kernel body. */
const PRELUDE = /* wgsl */ `
fn mu(i: u32) -> u32 { return M[i]; }
fn mf(i: u32) -> f32 { return bitcast<f32>(M[i]); }
fn mi(i: u32) -> i32 { return bitcast<i32>(M[i]); }
// linear invocation id over a (x, y) grid of 256-wide workgroups
fn lin(wid: vec3<u32>, nwg: vec3<u32>, lid: vec3<u32>) -> u32 {
  return (wid.y * nwg.x + wid.x) * ${WG}u + lid.x;
}
fn tanh_s(x: f32) -> f32 { return tanh(clamp(x, -15.0, 15.0)); }
// Numerical Recipes erfc, fractional error < 1.2e-7 (same formula as base.ts erf)
fn erf_s(x: f32) -> f32 {
  let a = abs(x);
  let t = 1.0 / (1.0 + 0.5 * a);
  let y = t * exp(-a * a - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 +
    t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 +
    t * (-0.82215223 + t * 0.17087277)))))))));
  return sign(x) * (1.0 - y);
}
`;

/**
 * Loaders for a resident int8 weight (quant.ts `packResident` layout; header words cols, group, scale
 * offset, groups per row). cols and group are multiples of 4, so the four values of ld4 share one
 * word, one row and one scale. `ldrc_<n>(row, col)` / `ld4rc_<n>` take the (row, col) the caller
 * already has, so the common one-scale-per-row case needs no integer division; `ld_<n>(i)` splits a
 * flat index. `n` is the binding name.
 */
const q8Loaders = (n: string) => /* wgsl */ `
fn q8s_${n}(row: u32, col: u32) -> f32 {
  let gpr = ${n}[3u];
  var s = row;
  if (gpr != 1u) { s = row * gpr + col / ${n}[1u]; }
  return unpack2x16float(${n}[${n}[2u] + (s >> 1u)])[s & 1u];
}
fn ldrc_${n}(row: u32, col: u32) -> f32 {
  let i = row * ${n}[0u] + col;
  return f32(extractBits(bitcast<i32>(${n}[4u + (i >> 2u)]), (i & 3u) * 8u, 8u)) * q8s_${n}(row, col);
}
fn ld4rc_${n}(row: u32, col: u32) -> vec4<f32> {
  let i = row * ${n}[0u] + col;
  let q = (vec4<i32>(bitcast<i32>(${n}[4u + (i >> 2u)])) << vec4<u32>(24u, 16u, 8u, 0u)) >> vec4<u32>(24u);
  return vec4<f32>(q) * q8s_${n}(row, col);
}
fn ld4_${n}(i: u32) -> vec4<f32> {
  let row = i / ${n}[0u];
  return ld4rc_${n}(row, i - row * ${n}[0u]);
}
fn ld_${n}(i: u32) -> f32 {
  let row = i / ${n}[0u];
  return ldrc_${n}(row, i - row * ${n}[0u]);
}
`;

export type KernelInput = { name: string; dtype: DType };

const specs = new Map<string, KernelSpec>();

/**
 * The memoised kernel spec for `body` with these inputs / outputs. `key` must identify the body
 * (the dtypes are appended here). The body defines `@compute fn main`.
 */
export function nnKernel(
	key: string,
	inputs: KernelInput[],
	outputs: string[],
	body: string,
	textures: string[] = [],
	/** element type override by binding name (e.g. `u32` for sort keys); such inputs have no ld_<name>() */
	elem: Record<string, string> = {},
): KernelSpec {
	const id = `nn/${key}|${inputs.map((i) => i.dtype).join(",")}`;
	let s = specs.get(id);
	if (s) return s;
	const f16 = inputs.some((i) => i.dtype === "f16");
	let src = f16 ? "enable f16;\n" : "";
	let b = 0;
	src += `@group(0) @binding(${b++}) var<storage, read> M: array<u32>;\n`;
	for (const t of textures)
		src += `@group(0) @binding(${b++}) var ${t}: texture_2d<f32>;\n`;
	for (const i of inputs)
		src += `@group(0) @binding(${b++}) var<storage, read> ${i.name}: array<${elem[i.name] ?? (i.dtype === "q8" ? "u32" : i.dtype)}>;\n`;
	for (const o of outputs)
		src += `@group(0) @binding(${b++}) var<storage, read_write> ${o}: array<${elem[o] ?? "f32"}>;\n`;
	for (const i of inputs.filter((i) => !elem[i.name]))
		src +=
			i.dtype === "q8"
				? q8Loaders(i.name)
				: `fn ld_${i.name}(i: u32) -> f32 { return f32(${i.name}[i]); }\n`;
	src += PRELUDE + body;
	s = defineKernel(
		id,
		src,
		[
			["M", "read-only-storage"],
			...textures.map((t): [string, "texture"] => [t, "texture"]),
			...inputs.map((i): [string, "read-only-storage"] => [
				i.name,
				"read-only-storage",
			]),
			...outputs.map((o): [string, "storage"] => [o, "storage"]),
		],
		{ group: "nn" },
	);
	specs.set(id, s);
	return s;
}

/** Workgroups for `n` invocations of 256-wide groups, folded into y past 65535. */
export function grid1d(n: number): [number, number, number] {
	const g = Math.max(1, Math.ceil(n / WG));
	if (g <= 65535) return [g, 1, 1];
	const y = Math.ceil(g / 65535);
	return [Math.ceil(g / y), y, 1];
}

/** f32 → u32 word (bit pattern). */
const f32w = new Float32Array(1);
const u32w = new Uint32Array(f32w.buffer);
export function fbits(v: number): number {
	f32w[0] = v;
	return u32w[0];
}
