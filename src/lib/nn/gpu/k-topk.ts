// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// topk by a bitonic sort of (value, index) per row, padded to a power of two P. Steps with a
// compare distance below 512 run inside one workgroup (512-element blocks in workgroup memory), so a
// row of 2^19 scores (ALIKED at 640×800) takes ~66 dispatches instead of 190. Order: larger value
// first, ties to the lower index (torch.topk sorted=True on distinct values; stable on ties).

import type { DType } from "../types";
import { ENTRY, type KernelCall } from "./k-elementwise";
import { grid1d, nnKernel } from "./wgsl";

export const BLOCK = 512;

const BEFORE = `fn before(ka: f32, ia: f32, kb: f32, ib: f32) -> bool {
  return ka > kb || (ka == kb && ia < ib);
}`;

/** M (all passes): [rows, len, P, k, j, block, kOut] */
export function topkPlan(
	dtype: DType,
	rows: number,
	len: number,
	kOut: number,
): { P: number; init: KernelCall; steps: KernelCall[]; final: KernelCall } {
	const P = 2 ** Math.ceil(Math.log2(Math.max(2, len)));
	const block = Math.min(P, BLOCK);
	const meta = (k: number, j: number) => [rows, len, P, k, j, block, kOut];
	const init: KernelCall = {
		spec: nnKernel(
			"topk-init",
			[{ name: "x", dtype }],
			["keys", "idx"],
			`${ENTRY} {
  let i = lin(wid, nwg, lid);
  let P = mu(2u);
  if (i >= mu(0u) * P) { return; }
  let r = i / P;
  let c = i % P;
  let len = mu(1u);
  var ninf = 0xff800000u;
  keys[i] = select(bitcast<f32>(ninf), ld_x(r * len + min(c, len - 1u)), c < len);
  idx[i] = f32(c);
}`,
		),
		meta: meta(0, 0),
		wg: grid1d(rows * P),
	};
	const localSrc = (full: boolean) => `${BEFORE}
var<workgroup> sk: array<f32, ${BLOCK}>;
var<workgroup> si: array<f32, ${BLOCK}>;
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let B = mu(5u);
  let base = wid.x * B;
  // the block's offset within its row (rows are P long, P a multiple of B)
  let rowOff = base % mu(2u);
  let t = lid.x;
  for (var e = t; e < B; e += 256u) { sk[e] = keys[base + e]; si[e] = idx[base + e]; }
  workgroupBarrier();
  ${full ? "for (var k = 2u; k <= B; k <<= 1u) {" : "let k = mu(3u); {"}
    for (var j = ${full ? "k >> 1u" : "B >> 1u"}; j > 0u; j >>= 1u) {
      if (t < B / 2u) {
        let i = ((t & ~(j - 1u)) << 1u) | (t & (j - 1u));
        let l = i | j;
        let up = ((rowOff + i) & k) == 0u;
        let ka = sk[i]; let ia = si[i]; let kb = sk[l]; let ib = si[l];
        if (before(kb, ib, ka, ia) == up) { sk[i] = kb; si[i] = ib; sk[l] = ka; si[l] = ia; }
      }
      workgroupBarrier();
    }
  }
  for (var e = t; e < B; e += 256u) { keys[base + e] = sk[e]; idx[base + e] = si[e]; }
}`;
	const steps: KernelCall[] = [];
	const nBlocks = (rows * P) / block;
	steps.push({
		spec: nnKernel("topk-local-sort", [], ["keys", "idx"], localSrc(true)),
		meta: meta(0, 0),
		wg: [nBlocks, 1, 1],
	});
	const globalSpec = nnKernel(
		"topk-global",
		[],
		["keys", "idx"],
		`${BEFORE}
${ENTRY} {
  let t = lin(wid, nwg, lid);
  let P = mu(2u);
  if (t >= mu(0u) * P / 2u) { return; }
  let k = mu(3u);
  let j = mu(4u);
  let r = t / (P / 2u);
  let tt = t % (P / 2u);
  let i = ((tt & ~(j - 1u)) << 1u) | (tt & (j - 1u));
  let l = i | j;
  let up = (i & k) == 0u;
  let a = r * P + i;
  let b = r * P + l;
  let ka = keys[a]; let ia = idx[a]; let kb = keys[b]; let ib = idx[b];
  if (before(kb, ib, ka, ia) == up) { keys[a] = kb; idx[a] = ib; keys[b] = ka; idx[b] = ia; }
}`,
	);
	const mergeSpec = nnKernel(
		"topk-local-merge",
		[],
		["keys", "idx"],
		localSrc(false),
	);
	for (let k = block * 2; k <= P; k *= 2) {
		for (let j = k / 2; j >= block; j /= 2)
			steps.push({
				spec: globalSpec,
				meta: meta(k, j),
				wg: grid1d((rows * P) / 2),
			});
		steps.push({ spec: mergeSpec, meta: meta(k, 0), wg: [nBlocks, 1, 1] });
	}
	const final: KernelCall = {
		spec: nnKernel(
			"topk-final",
			[
				{ name: "keys", dtype: "f32" },
				{ name: "idx", dtype: "f32" },
			],
			["values", "indices"],
			`${ENTRY} {
  let i = lin(wid, nwg, lid);
  let kOut = mu(6u);
  if (i >= mu(0u) * kOut) { return; }
  let src = (i / kOut) * mu(2u) + i % kOut;
  values[i] = ld_keys(src);
  indices[i] = ld_idx(src);
}`,
		),
		meta: meta(0, 0),
		wg: grid1d(rows * kOut),
	};
	return { P, init, steps, final };
}
