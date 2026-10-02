// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// One-invocation-per-output kernels: pooling, interpolate (nearest / bilinear / bicubic, PyTorch
// source-index rules), gridSample, the NMS max-pool, pad, gather and rotary embedding. Semantics
// match the CPU reference in ../cpu.ts.

import type { GridSampleParams, InterpParams } from "../base";
import type { PoolParams } from "../shape";
import type { DType } from "../types";
import { ENTRY, type KernelCall } from "./k-elementwise";
import { fbits, grid1d, nnKernel } from "./wgsl";

/** M: [n, N·C, H, W, kh, kw, sh, sw, ph, pw, dh, dw, Ho, Wo, countIncludePad] */
export function poolKernel(
	kind: "max" | "avg",
	dtype: DType,
	p: PoolParams,
): KernelCall {
	const n = p.N * p.C * p.Ho * p.Wo;
	const spec = nnKernel(
		`pool-${kind}`,
		[{ name: "x", dtype }],
		["out"],
		`${ENTRY} {
  let i = lin(wid, nwg, lid);
  if (i >= mu(0u)) { return; }
  let H = mu(2u); let W = mu(3u); let kh = mu(4u); let kw = mu(5u);
  let Wo = mu(13u); let Ho = mu(12u);
  let ox = i % Wo;
  let oy = (i / Wo) % Ho;
  let nc = i / (Wo * Ho);
  let y0 = i32(oy * mu(6u)) - mi(8u);
  let x0 = i32(ox * mu(7u)) - mi(9u);
  var m = -3.402823e38;
  var s = 0.0;
  var cnt = 0.0;
  for (var ky = 0u; ky < kh; ky++) {
    let iy = y0 + i32(ky * mu(10u));
    if (iy < 0 || iy >= i32(H)) { continue; }
    for (var kx = 0u; kx < kw; kx++) {
      let ix = x0 + i32(kx * mu(11u));
      if (ix < 0 || ix >= i32(W)) { continue; }
      let v = ld_x((nc * H + u32(iy)) * W + u32(ix));
      m = max(m, v);
      s += v;
      cnt += 1.0;
    }
  }
  ${
		kind === "max"
			? "out[i] = m;"
			: `if (mu(14u) == 1u) {
    let y1 = min(y0 + i32(kh), i32(H) + mi(8u));
    let x1 = min(x0 + i32(kw), i32(W) + mi(9u));
    cnt = f32((y1 - y0) * (x1 - x0));
  }
  out[i] = s / cnt;`
	}
}`,
	);
	return {
		spec,
		meta: [
			n,
			p.N * p.C,
			p.H,
			p.W,
			p.kh,
			p.kw,
			p.sh,
			p.sw,
			p.ph,
			p.pw,
			p.dh,
			p.dw,
			p.Ho,
			p.Wo,
			p.countIncludePad ? 1 : 0,
		],
		wg: grid1d(n),
	};
}

/** M: [n, H, W, Ho, Wo, scaleH, scaleW, alignCorners] */
export function interpolateKernel(dtype: DType, p: InterpParams): KernelCall {
	const n = p.N * p.C * p.Ho * p.Wo;
	let core: string;
	if (p.mode === "nearest")
		core = `let iy = min(H - 1u, u32(floor(f32(oy) * mf(5u))));
  let ix = min(W - 1u, u32(floor(f32(ox) * mf(6u))));
  out[i] = ld_x(base + iy * W + ix);`;
	else if (p.mode === "bilinear")
		core = `let fy = max(0.0, src(oy, mf(5u)));
  let fx = max(0.0, src(ox, mf(6u)));
  let y0 = min(H - 1u, u32(floor(fy)));
  let x0 = min(W - 1u, u32(floor(fx)));
  let y1 = min(H - 1u, y0 + 1u);
  let x1 = min(W - 1u, x0 + 1u);
  let ly = fy - f32(y0);
  let lx = fx - f32(x0);
  out[i] = (1.0 - ly) * ((1.0 - lx) * ld_x(base + y0 * W + x0) + lx * ld_x(base + y0 * W + x1)) +
    ly * ((1.0 - lx) * ld_x(base + y1 * W + x0) + lx * ld_x(base + y1 * W + x1));`;
	else
		core = `let fy = src(oy, mf(5u));
  let fx = src(ox, mf(6u));
  let y0 = i32(floor(fy));
  let x0 = i32(floor(fx));
  let wy = cubic(fy - f32(y0));
  let wx = cubic(fx - f32(x0));
  var v = 0.0;
  for (var a = 0; a < 4; a++) {
    let yy = u32(clamp(y0 - 1 + a, 0, i32(H) - 1));
    var r = 0.0;
    for (var b = 0; b < 4; b++) {
      let xx = u32(clamp(x0 - 1 + b, 0, i32(W) - 1));
      r += wx[b] * ld_x(base + yy * W + xx);
    }
    v += wy[a] * r;
  }
  out[i] = v;`;
	const spec = nnKernel(
		`interp-${p.mode}`,
		[{ name: "x", dtype }],
		["out"],
		`fn src(d: u32, s: f32) -> f32 {
  if (mu(7u) == 1u) { return f32(d) * s; }
  return (f32(d) + 0.5) * s - 0.5;
}
fn cubic(t: f32) -> vec4<f32> {
  let A = -0.75;
  let x1 = t + 1.0;
  let x2 = t;
  let x3 = 1.0 - t;
  let x4 = 2.0 - t;
  return vec4<f32>(
    ((A * x1 - 5.0 * A) * x1 + 8.0 * A) * x1 - 4.0 * A,
    ((A + 2.0) * x2 - (A + 3.0)) * x2 * x2 + 1.0,
    ((A + 2.0) * x3 - (A + 3.0)) * x3 * x3 + 1.0,
    ((A * x4 - 5.0 * A) * x4 + 8.0 * A) * x4 - 4.0 * A);
}
${ENTRY} {
  let i = lin(wid, nwg, lid);
  if (i >= mu(0u)) { return; }
  let H = mu(1u); let W = mu(2u); let Ho = mu(3u); let Wo = mu(4u);
  let ox = i % Wo;
  let oy = (i / Wo) % Ho;
  let base = (i / (Wo * Ho)) * H * W;
  ${core}
}`,
	);
	return {
		spec,
		meta: [
			n,
			p.H,
			p.W,
			p.Ho,
			p.Wo,
			fbits(p.scaleH),
			fbits(p.scaleW),
			p.alignCorners ? 1 : 0,
		],
		wg: grid1d(n),
	};
}

/** M: [n, C, H, W, Ho, Wo] */
export function gridSampleKernel(
	dx: DType,
	dg: DType,
	p: GridSampleParams,
): KernelCall {
	const n = p.N * p.C * p.Ho * p.Wo;
	const unnorm = p.alignCorners
		? "((g + 1.0) * 0.5) * (f32(size) - 1.0)"
		: "((g + 1.0) * f32(size) - 1.0) * 0.5";
	const border = p.padding === "border";
	const sample =
		p.mode === "nearest"
			? "out[i] = tap(base, i32(round(fy)), i32(round(fx)));"
			: `let x0 = floor(fx);
  let y0 = floor(fy);
  let lx = fx - x0;
  let ly = fy - y0;
  let ix = i32(x0);
  let iy = i32(y0);
  out[i] = (1.0 - ly) * ((1.0 - lx) * tap(base, iy, ix) + lx * tap(base, iy, ix + 1)) +
    ly * ((1.0 - lx) * tap(base, iy + 1, ix) + lx * tap(base, iy + 1, ix + 1));`;
	const spec = nnKernel(
		`gridsample-${p.mode}-${p.padding}-${p.alignCorners ? "ac" : "nac"}`,
		[
			{ name: "x", dtype: dx },
			{ name: "grid", dtype: dg },
		],
		["out"],
		`fn un(g: f32, size: u32) -> f32 { return ${unnorm}; }
fn tap(base: u32, y: i32, x: i32) -> f32 {
  let H = i32(mu(2u)); let W = i32(mu(3u));
  if (y < 0 || x < 0 || y >= H || x >= W) { return 0.0; }
  return ld_x(base + u32(y * W + x));
}
${ENTRY} {
  let i = lin(wid, nwg, lid);
  if (i >= mu(0u)) { return; }
  let C = mu(1u); let H = mu(2u); let W = mu(3u); let Ho = mu(4u); let Wo = mu(5u);
  let ox = i % Wo;
  let oy = (i / Wo) % Ho;
  let c = (i / (Wo * Ho)) % C;
  let nb = i / (Wo * Ho * C);
  let gi = ((nb * Ho + oy) * Wo + ox) * 2u;
  var fx = un(ld_grid(gi), W);
  var fy = un(ld_grid(gi + 1u), H);
  ${border ? "fx = clamp(fx, 0.0, f32(W) - 1.0); fy = clamp(fy, 0.0, f32(H) - 1.0);" : ""}
  let base = (nb * C + c) * H * W;
  ${sample}
}`,
	);
	return { spec, meta: [n, p.C, p.H, p.W, p.Ho, p.Wo], wg: grid1d(n) };
}

/** x where it equals its (2r+1)² window max, else 0. M: [n, H, W, r] */
export function nmsKernel(
	dtype: DType,
	shape: readonly number[],
	r: number,
): KernelCall {
	const [N, C, H, W] = shape;
	const n = N * C * H * W;
	const spec = nnKernel(
		"nms-maxpool",
		[{ name: "x", dtype }],
		["out"],
		`${ENTRY} {
  let i = lin(wid, nwg, lid);
  if (i >= mu(0u)) { return; }
  let H = i32(mu(1u)); let W = i32(mu(2u)); let r = i32(mu(3u));
  let x = i32(i % u32(W));
  let y = i32((i / u32(W)) % u32(H));
  let base = (i / u32(W * H)) * u32(H * W);
  let v = ld_x(i);
  var m = -3.402823e38;
  for (var yy = max(0, y - r); yy <= min(H - 1, y + r); yy++) {
    for (var xx = max(0, x - r); xx <= min(W - 1, x + r); xx++) {
      m = max(m, ld_x(base + u32(yy * W + xx)));
    }
  }
  out[i] = select(0.0, v, v == m);
}`,
	);
	return { spec, meta: [n, H, W, r], wg: grid1d(n) };
}

const MAXR = 6;

/** M: [n, rank, outShape6, inShape6, before6, mode(0 const,1 reflect,2 replicate), value] */
export function padKernel(
	dtype: DType,
	inShape: readonly number[],
	pads: [number, number][],
	mode: "constant" | "reflect" | "replicate",
	value: number,
	out: number[],
): KernelCall {
	// fold leading dims without padding into one
	let lead = 0;
	while (lead < pads.length - 1 && pads[lead][0] === 0 && pads[lead][1] === 0)
		lead++;
	const fold = (a: readonly number[]) => [
		a.slice(0, lead).reduce((x, y) => x * y, 1),
		...a.slice(lead),
	];
	const os = fold(out);
	const is = fold(inShape);
	const ps = [[0, 0] as [number, number], ...pads.slice(lead)];
	if (os.length > MAXR) throw new Error("nn: pad rank > 6");
	const n = out.reduce((x, y) => x * y, 1);
	const padArr = (a: number[], v: number) => [
		...a,
		...new Array(MAXR - a.length).fill(v),
	];
	const meta = [
		n,
		os.length,
		...padArr(os, 1),
		...padArr(is, 1),
		...padArr(
			ps.map((p) => p[0]),
			0,
		),
		mode === "constant" ? 0 : mode === "reflect" ? 1 : 2,
		fbits(value),
	];
	const spec = nnKernel(
		"pad",
		[{ name: "x", dtype }],
		["out"],
		`${ENTRY} {
  let i = lin(wid, nwg, lid);
  if (i >= mu(0u)) { return; }
  let rank = mu(1u);
  let mode = mu(20u);
  var r = i;
  var off = 0u;
  var stride = 1u;
  var inside = true;
  for (var d = 0u; d < rank; d++) {
    let dd = rank - 1u - d;
    let c = i32(r % mu(2u + dd));
    r = r / mu(2u + dd);
    let n = i32(mu(8u + dd));
    var s = c - i32(mu(14u + dd));
    if (s < 0 || s >= n) {
      if (mode == 0u) { inside = false; }
      else if (mode == 2u) { s = clamp(s, 0, n - 1); }
      else { s = select(2 * (n - 1) - s, -s, s < 0); }
    }
    off += u32(max(s, 0)) * stride;
    stride *= u32(n);
  }
  out[i] = select(mf(21u), ld_x(off), inside);
}`,
	);
	return { spec, meta, wg: grid1d(n) };
}

/** index_select. M: [n, len, inner, nIdx] */
export function gatherKernel(
	dx: DType,
	di: DType,
	outer: number,
	len: number,
	inner: number,
	nIdx: number,
): KernelCall {
	const n = outer * nIdx * inner;
	const spec = nnKernel(
		"gather",
		[
			{ name: "x", dtype: dx },
			{ name: "idx", dtype: di },
		],
		["out"],
		`${ENTRY} {
  let i = lin(wid, nwg, lid);
  if (i >= mu(0u)) { return; }
  let len = mu(1u); let inner = mu(2u); let nIdx = mu(3u);
  let c = i % inner;
  let j = (i / inner) % nIdx;
  let a = i / (inner * nIdx);
  var k = i32(ld_idx(j));
  if (k < 0) { k += i32(len); }
  out[i] = ld_x((a * len + u32(clamp(k, 0, i32(len) - 1))) * inner + c);
}`,
	);
	return { spec, meta: [n, len, inner, nIdx], wg: grid1d(n) };
}

/** M: [n, rank, shape6, cosStrides6, sinStrides6, D] */
export function rotaryKernel(
	dx: DType,
	dc: DType,
	ds: DType,
	shape: readonly number[],
	cs: number[],
	ss: number[],
	interleaved: boolean,
): KernelCall {
	if (shape.length > MAXR) throw new Error("nn: rotary rank > 6");
	const n = shape.reduce((a, b) => a * b, 1);
	const D = shape[shape.length - 1];
	const padArr = (a: number[], v: number) => [
		...a,
		...new Array(MAXR - a.length).fill(v),
	];
	const meta = [
		n,
		shape.length,
		...padArr([...shape], 1),
		...padArr(cs, 0),
		...padArr(ss, 0),
		D,
	];
	const partner = interleaved
		? "let odd = (d % 2u) == 1u; let p = select(i + 1u, i - 1u, odd); let sg = select(-1.0, 1.0, odd);"
		: "let lo = d < D / 2u; let p = select(i - D / 2u, i + D / 2u, lo); let sg = select(1.0, -1.0, lo);";
	const spec = nnKernel(
		`rotary${interleaved ? "-il" : "-half"}`,
		[
			{ name: "x", dtype: dx },
			{ name: "cs", dtype: dc },
			{ name: "sn", dtype: ds },
		],
		["out"],
		`${ENTRY} {
  let i = lin(wid, nwg, lid);
  if (i >= mu(0u)) { return; }
  let rank = mu(1u);
  let D = mu(20u);
  var r = i;
  var oc = 0u;
  var os = 0u;
  for (var d = 0u; d < rank; d++) {
    let dd = rank - 1u - d;
    let c = r % mu(2u + dd);
    r = r / mu(2u + dd);
    oc += c * mu(8u + dd);
    os += c * mu(14u + dd);
  }
  let d = i % D;
  ${partner}
  out[i] = ld_x(i) * ld_cs(oc) + sg * ld_x(p) * ld_sn(os);
}`,
	);
	return { spec, meta, wg: grid1d(n) };
}

/** texture → [1, C, H, W] with bilinear resampling and per-channel (v - mean) / std. */
export function textureKernel(
	C: number,
	tw: number,
	th: number,
	H: number,
	W: number,
	mean: readonly number[],
	std: readonly number[],
): KernelCall {
	const n = C * H * W;
	const meta = [
		n,
		tw,
		th,
		H,
		W,
		fbits(tw / W),
		fbits(th / H),
		...[0, 1, 2, 3].map((c) => fbits(mean[c] ?? 0)),
		...[0, 1, 2, 3].map((c) => fbits(1 / (std[c] ?? 1))),
	];
	const spec = nnKernel(
		"from-texture",
		[],
		["out"],
		`fn texel(x: i32, y: i32, c: u32) -> f32 {
  let p = vec2<i32>(clamp(x, 0, i32(mu(1u)) - 1), clamp(y, 0, i32(mu(2u)) - 1));
  return textureLoad(img, p, 0)[c];
}
${ENTRY} {
  let i = lin(wid, nwg, lid);
  if (i >= mu(0u)) { return; }
  let H = mu(3u); let W = mu(4u);
  let ox = i % W;
  let oy = (i / W) % H;
  let c = i / (W * H);
  let fx = max(0.0, (f32(ox) + 0.5) * mf(5u) - 0.5);
  let fy = max(0.0, (f32(oy) + 0.5) * mf(6u) - 0.5);
  let x0 = i32(floor(fx));
  let y0 = i32(floor(fy));
  let lx = fx - f32(x0);
  let ly = fy - f32(y0);
  let v = (1.0 - ly) * ((1.0 - lx) * texel(x0, y0, c) + lx * texel(x0 + 1, y0, c)) +
    ly * ((1.0 - lx) * texel(x0, y0 + 1, c) + lx * texel(x0 + 1, y0 + 1, c));
  out[i] = (v - mf(7u + c)) * mf(11u + c);
}`,
		["img"],
	);
	return { spec, meta, wg: grid1d(n) };
}
