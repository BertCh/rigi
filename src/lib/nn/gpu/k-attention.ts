// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Fused attention, flash-style: softmax(q kᵀ · scale + mask) v without materialising the Nq × Nk
// scores. A 64-thread workgroup owns 64 queries of one (batch, head); each thread keeps its query
// row and output accumulator in registers and streams K / V through workgroup memory in tiles of BC
// keys, with an online (running max) softmax per tile. D and Dv are baked into the source.

import type { AttentionParams } from "../base";
import type { DType } from "../types";
import type { KernelCall } from "./k-elementwise";
import { fbits, nnKernel } from "./wgsl";

const BQ = 128;

export function attentionKernel(
	p: AttentionParams,
	dq: DType,
	dk: DType,
	dv: DType,
	dm: DType | null,
): KernelCall {
	const { B, H, Nq, Nk, D, Dv, scale, maskStrides } = p;
	// workgroup memory: BC · (D + Dv) f32 within 16 KiB
	const BC = Math.max(
		4,
		Math.min(32, 2 ** Math.floor(Math.log2(4096 / (D + Dv)))),
	);
	const ms = maskStrides ?? [0, 0, 0, 0];
	const meta = [Nq, Nk, H, fbits(scale), ...ms];
	// vec4 path (D, Dv multiples of 4): rows as vec4 in registers and workgroup memory
	const V = D % 4 === 0 && Dv % 4 === 0 ? 4 : 1;
	const T = V === 4 ? "vec4<f32>" : "f32";
	const D4 = D / V;
	const DV4 = Dv / V;
	const ldk = (base: string) =>
		V === 4
			? `vec4<f32>(ld_k(${base}), ld_k(${base} + 1u), ld_k(${base} + 2u), ld_k(${base} + 3u))`
			: `ld_k(${base})`;
	const ldv = (base: string) =>
		V === 4
			? `vec4<f32>(ld_v(${base}), ld_v(${base} + 1u), ld_v(${base} + 2u), ld_v(${base} + 3u))`
			: `ld_v(${base})`;
	const ldq = (base: string) =>
		V === 4
			? `vec4<f32>(ld_q(${base}), ld_q(${base} + 1u), ld_q(${base} + 2u), ld_q(${base} + 3u))`
			: `ld_q(${base})`;
	const dot = V === 4 ? "dot(qr[c], Ks[j * D4 + c])" : "qr[c] * Ks[j * D4 + c]";
	const spec = nnKernel(
		`attention-${D}-${Dv}-${BC}-v${V}${dm ? "-mask" : ""}`,
		[
			{ name: "q", dtype: dq },
			{ name: "k", dtype: dk },
			{ name: "v", dtype: dv },
			...(dm ? [{ name: "mask", dtype: dm }] : []),
		],
		["out"],
		`
const D = ${D}u;
const DV = ${Dv}u;
const D4 = ${D4}u;
const DV4 = ${DV4}u;
const BC = ${BC}u;
var<workgroup> Ks: array<${T}, ${BC * D4}>;
var<workgroup> Vs: array<${T}, ${BC * DV4}>;
@compute @workgroup_size(${BQ})
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let Nq = mu(0u);
  let Nk = mu(1u);
  let bh = wid.y;
  let b = bh / mu(2u);
  let h = bh % mu(2u);
  let qi = wid.x * ${BQ}u + lid.x;
  let live = qi < Nq;
  let scale = mf(3u);
  var qr: array<${T}, ${D4}>;
  var acc: array<${T}, ${DV4}>;
  let qb = (bh * Nq + min(qi, Nq - 1u)) * D;
  for (var c = 0u; c < D4; c++) { qr[c] = ${ldq(`qb + c * ${V}u`)} * scale; }
  for (var c = 0u; c < DV4; c++) { acc[c] = ${T}(0.0); }
  var m = -3.402823e38;
  var l = 0.0;
  let mrow = b * mu(4u) + h * mu(5u) + min(qi, Nq - 1u) * mu(6u);
  for (var j0 = 0u; j0 < Nk; j0 += BC) {
    // cooperative tile load
    for (var e = lid.x; e < BC * D4; e += ${BQ}u) {
      let j = j0 + e / D4;
      Ks[e] = select(${T}(0.0), ${ldk(`(bh * Nk + min(j, Nk - 1u)) * D + (e % D4) * ${V}u`)}, j < Nk);
    }
    for (var e = lid.x; e < BC * DV4; e += ${BQ}u) {
      let j = j0 + e / DV4;
      Vs[e] = select(${T}(0.0), ${ldv(`(bh * Nk + min(j, Nk - 1u)) * DV + (e % DV4) * ${V}u`)}, j < Nk);
    }
    workgroupBarrier();
    let nj = min(BC, Nk - j0);
    var s: array<f32, ${BC}>;
    var tm = m;
    for (var j = 0u; j < nj; j++) {
      var d = 0.0;
      for (var c = 0u; c < D4; c++) { d += ${dot}; }
      ${dm ? "d += ld_mask(mrow + (j0 + j) * mu(7u));" : ""}
      s[j] = d;
      tm = max(tm, d);
    }
    let corr = exp(m - tm);
    l *= corr;
    for (var c = 0u; c < DV4; c++) { acc[c] *= corr; }
    for (var j = 0u; j < nj; j++) {
      let pj = exp(s[j] - tm);
      l += pj;
      for (var c = 0u; c < DV4; c++) { acc[c] += pj * Vs[j * DV4 + c]; }
    }
    m = tm;
    workgroupBarrier();
  }
  if (live) {
    let ob = (bh * Nq + qi) * DV;
    let inv = 1.0 / l;
    for (var c = 0u; c < DV4; c++) {
      let r = acc[c] * inv;
      ${V === 4 ? "out[ob + c * 4u] = r.x; out[ob + c * 4u + 1u] = r.y; out[ob + c * 4u + 2u] = r.z; out[ob + c * 4u + 3u] = r.w;" : "out[ob + c] = r;"}
    }
  }
}`,
	);
	return { spec, meta, wg: [Math.ceil(Nq / BQ), B * H, 1] };
}
