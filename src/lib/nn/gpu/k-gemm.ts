// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Tiled GEMM (64×64 output tile per 256-thread workgroup, 4×4 per thread, K in steps of 16 through
// workgroup memory) with pluggable operand loaders, so matmul / linear, implicit-GEMM conv2d,
// convTranspose2d and deformable conv v2 share one kernel shape. A loader returns 0 outside its
// operand, so ragged edges need no padding. Small-M convs (depthwise) use a direct kernel instead.

import type { MatmulParams, UnaryPrim } from "../base";
import type { ConvParams } from "../shape";
import type { DType } from "../types";
import { ENTRY, type KernelCall, unaryExpr } from "./k-elementwise";
import { grid1d, nnKernel } from "./wgsl";

export const TILE = 64;
const TK = 16;

/** Fused epilogue activation (applied after the bias). */
export type Epilogue = { op: UnaryPrim; alpha: number; beta: number } | null;

const actFn = (e: Epilogue) =>
	e
		? `fn act(v: f32, al: f32, be: f32) -> f32 { return ${unaryExpr(e.op)}; }\n`
		: "fn act(v: f32, al: f32, be: f32) -> f32 { return v; }\n";

/**
 * GEMM body. The op supplies (as WGSL): `fn setup(z: u32)` (sets private bases), `fn loadA(m, k)`,
 * `fn loadB(k, n)` and `fn store(m, n, v)`; M, N, K are read from M[0..3), the activation's alpha
 * and beta from M[3..5). `aMajor` / `bMajor` pick which tile index consecutive threads walk on
 * loads ("k" or "m" for A, "k" or "n" for B) so global reads coalesce.
 */
function gemmSource(
	ops: string,
	aMajor: "k" | "m",
	bMajor: "k" | "n",
	ep: Epilogue,
): string {
	const aIdx =
		aMajor === "k"
			? "let ak = e % 16u; let am = e / 16u;"
			: "let am = e % 64u; let ak = e / 64u;";
	const bIdx =
		bMajor === "n"
			? "let bn = e % 64u; let bk = e / 64u;"
			: "let bk = e % 16u; let bn = e / 16u;";
	return `
var<workgroup> As: array<f32, ${TILE * TK}>;
var<workgroup> Bs: array<f32, ${TILE * TK}>;
var<private> gM: u32;
var<private> gN: u32;
var<private> gK: u32;
${actFn(ep)}
${ops}
@compute @workgroup_size(16, 16)
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  gM = mu(0u); gN = mu(1u); gK = mu(2u);
  let al = mf(3u);
  let be = mf(4u);
  setup(wid.z);
  let m0 = wid.y * ${TILE}u;
  let n0 = wid.x * ${TILE}u;
  let tid = lid.y * 16u + lid.x;
  var acc: array<vec4<f32>, 4>;
  let kTotal = mu(2u);
  for (var k0 = 0u; k0 < kTotal; k0 += ${TK}u) {
    for (var i = 0u; i < 4u; i++) {
      let e = tid + i * 256u;
      ${aIdx}
      let gm = m0 + am;
      let gk = k0 + ak;
      var va = 0.0;
      if (gm < gM && gk < gK) { va = loadA(gm, gk); }
      As[ak * 64u + am] = va;
      ${bIdx}
      let gk2 = k0 + bk;
      let gn = n0 + bn;
      var vb = 0.0;
      if (gk2 < gK && gn < gN) { vb = loadB(gk2, gn); }
      Bs[bk * 64u + bn] = vb;
    }
    workgroupBarrier();
    for (var k = 0u; k < ${TK}u; k++) {
      let a = vec4<f32>(As[k * 64u + lid.y * 4u], As[k * 64u + lid.y * 4u + 1u],
        As[k * 64u + lid.y * 4u + 2u], As[k * 64u + lid.y * 4u + 3u]);
      let b = vec4<f32>(Bs[k * 64u + lid.x * 4u], Bs[k * 64u + lid.x * 4u + 1u],
        Bs[k * 64u + lid.x * 4u + 2u], Bs[k * 64u + lid.x * 4u + 3u]);
      acc[0] += a.x * b;
      acc[1] += a.y * b;
      acc[2] += a.z * b;
      acc[3] += a.w * b;
    }
    workgroupBarrier();
  }
  for (var i = 0u; i < 4u; i++) {
    let m = m0 + lid.y * 4u + i;
    if (m >= gM) { continue; }
    for (var j = 0u; j < 4u; j++) {
      let n = n0 + lid.x * 4u + j;
      if (n < gN) { store(m, n, acc[i][j], al, be); }
    }
  }
}
`;
}

const epKey = (e: Epilogue) => (e ? `+${e.op}` : "");
const epMeta = (e: Epilogue) => {
	const f = new Float32Array([e?.alpha ?? 0, e?.beta ?? 0]);
	return [...new Uint32Array(f.buffer)];
};

/** Batched matmul / linear: a [batch, M, K] · b [batch, K, N] (or [N, K]) + bias[n]. */
export function matmulKernel(
	p: MatmulParams,
	da: DType,
	db: DType,
	dbias: DType | null,
	ep: Epilogue,
): KernelCall {
	const { batch, aBatchStrides, bBatchStrides, M, N, K, transB } = p;
	if (batch.length > 4) throw new Error("nn: matmul batch rank > 4");
	const Z = batch.reduce((x, y) => x * y, 1);
	const pad = (a: number[], v: number) => [
		...a,
		...new Array(4 - a.length).fill(v),
	];
	// M[5]=batch rank, M[6..10) batch shape, M[10..14) a strides, M[14..18) b strides
	const meta = [
		M,
		N,
		K,
		...epMeta(ep),
		batch.length,
		...pad(batch, 1),
		...pad(aBatchStrides, 0),
		...pad(bBatchStrides, 0),
	];
	const ops = `
var<private> aBase: u32;
var<private> bBase: u32;
var<private> oBase: u32;
fn setup(z: u32) {
  var r = z;
  aBase = 0u; bBase = 0u;
  let rank = mu(5u);
  for (var d = 0u; d < rank; d++) {
    let dd = rank - 1u - d;
    let c = r % mu(6u + dd);
    r = r / mu(6u + dd);
    aBase += c * mu(10u + dd);
    bBase += c * mu(14u + dd);
  }
  oBase = z * gM * gN;
}
fn loadA(m: u32, k: u32) -> f32 { return ld_a(aBase + m * gK + k); }
fn loadB(k: u32, n: u32) -> f32 { return ld_b(bBase + ${transB ? "n * gK + k" : "k * gN + n"}); }
fn store(m: u32, n: u32, v: f32, al: f32, be: f32) {
  out[oBase + m * gN + n] = act(v${dbias ? " + ld_bias(n)" : ""}, al, be);
}`;
	const inputs = [
		{ name: "a", dtype: da },
		{ name: "b", dtype: db },
		...(dbias ? [{ name: "bias", dtype: dbias }] : []),
	];
	const spec = nnKernel(
		`matmul${transB ? "-tb" : ""}${dbias ? "-bias" : ""}${epKey(ep)}`,
		inputs,
		["out"],
		gemmSource(ops, "k", transB ? "k" : "n", ep),
	);
	return {
		spec,
		meta,
		wg: [Math.ceil(N / TILE), Math.ceil(M / TILE), Z],
	};
}

const convMeta = (
	p: ConvParams,
	ep: Epilogue,
	M: number,
	N: number,
	K: number,
) => [
	M,
	N,
	K,
	...epMeta(ep),
	p.N,
	p.Cin,
	p.H,
	p.W,
	p.Cout,
	p.kh,
	p.kw,
	p.sh,
	p.sw,
	p.ph,
	p.pw,
	p.dh,
	p.dw,
	p.groups,
	p.Ho,
	p.Wo,
	p.dg,
];
// M[5..] = N Cin H W Cout kh kw sh sw ph pw dh dw groups Ho Wo dg
const CONV_FIELDS = `
fn cN() -> u32 { return mu(5u); }
fn cCin() -> u32 { return mu(6u); }
fn cH() -> u32 { return mu(7u); }
fn cW() -> u32 { return mu(8u); }
fn cCout() -> u32 { return mu(9u); }
fn ckh() -> u32 { return mu(10u); }
fn ckw() -> u32 { return mu(11u); }
fn csh() -> u32 { return mu(12u); }
fn csw() -> u32 { return mu(13u); }
fn cph() -> i32 { return mi(14u); }
fn cpw() -> i32 { return mi(15u); }
fn cdh() -> u32 { return mu(16u); }
fn cdw() -> u32 { return mu(17u); }
fn cG() -> u32 { return mu(18u); }
fn cHo() -> u32 { return mu(19u); }
fn cWo() -> u32 { return mu(20u); }
fn cDg() -> u32 { return mu(21u); }
`;

export type ConvKind = "conv" | "convT" | "deform";

/**
 * Implicit-GEMM convolution: per (image, group) z, C[co, pixel] = Σ_k W[co, k] · col[k, pixel],
 * with k = (ci, ky, kx). col is computed on the fly from x (and the offsets / mask for deform).
 */
export function convGemmKernel(
	kind: ConvKind,
	p: ConvParams,
	dt: { x: DType; w: DType; b: DType | null; off?: DType; mask?: DType | null },
	ep: Epilogue,
): KernelCall {
	const cig = p.Cin / p.groups;
	const cog = p.Cout / p.groups;
	const K = cig * p.kh * p.kw;
	const N = p.Ho * p.Wo;
	const M = cog;
	const loadA =
		kind === "convT"
			? // weight [Cin, Cout/g, kh, kw]
				`fn loadA(m: u32, k: u32) -> f32 {
  let kk = ckh() * ckw();
  let ci = k / kk;
  return ld_w(((gg * ${cig}u + ci) * ${cog}u + m) * kk + k % kk);
}`
			: `fn loadA(m: u32, k: u32) -> f32 { return ld_w((gg * ${cog}u + m) * gK + k); }`;
	let loadB: string;
	if (kind === "conv")
		loadB = `fn loadB(k: u32, n: u32) -> f32 {
  let kk = ckh() * ckw();
  let ci = k / kk;
  let r = k % kk;
  let ky = r / ckw();
  let kx = r % ckw();
  let oy = n / cWo();
  let ox = n % cWo();
  let iy = i32(oy * csh() + ky * cdh()) - cph();
  let ix = i32(ox * csw() + kx * cdw()) - cpw();
  if (iy < 0 || ix < 0 || iy >= i32(cH()) || ix >= i32(cW())) { return 0.0; }
  return ld_x(((nb * cCin() + gg * ${cig}u + ci) * cH() + u32(iy)) * cW() + u32(ix));
}`;
	else if (kind === "convT")
		loadB = `fn loadB(k: u32, n: u32) -> f32 {
  let kk = ckh() * ckw();
  let ci = k / kk;
  let r = k % kk;
  let ky = r / ckw();
  let kx = r % ckw();
  let oy = n / cWo();
  let ox = n % cWo();
  let ty = i32(oy) + cph() - i32(ky * cdh());
  let tx = i32(ox) + cpw() - i32(kx * cdw());
  if (ty < 0 || tx < 0) { return 0.0; }
  if (u32(ty) % csh() != 0u || u32(tx) % csw() != 0u) { return 0.0; }
  let iy = u32(ty) / csh();
  let ix = u32(tx) / csw();
  if (iy >= cH() || ix >= cW()) { return 0.0; }
  return ld_x(((nb * cCin() + gg * ${cig}u + ci) * cH() + iy) * cW() + ix);
}`;
	else
		loadB = `fn tap(base: u32, y: i32, x: i32) -> f32 {
  if (y < 0 || x < 0 || y >= i32(cH()) || x >= i32(cW())) { return 0.0; }
  return ld_x(base + u32(y) * cW() + u32(x));
}
fn loadB(k: u32, n: u32) -> f32 {
  let kk = ckh() * ckw();
  let ci = k / kk;
  let r = k % kk;
  let ky = r / ckw();
  let kx = r % ckw();
  let hw = cHo() * cWo();
  let oy = n / cWo();
  let ox = n % cWo();
  let c = gg * ${cig}u + ci;
  let og = c / (cCin() / cDg());
  let oi = ((nb * cDg() + og) * 2u * kk + 2u * r) * hw + n;
  let y = f32(i32(oy * csh() + ky * cdh()) - cph()) + ld_off(oi);
  let x = f32(i32(ox * csw() + kx * cdw()) - cpw()) + ld_off(oi + hw);
  ${dt.mask ? "let mk = ld_mask(((nb * cDg() + og) * kk + r) * hw + n);" : "let mk = 1.0;"}
  if (y <= -1.0 || x <= -1.0 || y >= f32(cH()) || x >= f32(cW())) { return 0.0; }
  let y0 = floor(y);
  let x0 = floor(x);
  let ly = y - y0;
  let lx = x - x0;
  let iy = i32(y0);
  let ix = i32(x0);
  let base = (nb * cCin() + c) * cH() * cW();
  let v = (1.0 - ly) * ((1.0 - lx) * tap(base, iy, ix) + lx * tap(base, iy, ix + 1)) +
    ly * ((1.0 - lx) * tap(base, iy + 1, ix) + lx * tap(base, iy + 1, ix + 1));
  return mk * v;
}`;
	const ops = `${CONV_FIELDS}
var<private> nb: u32;
var<private> gg: u32;
fn setup(z: u32) { nb = z / cG(); gg = z % cG(); }
${loadA}
${loadB}
fn store(m: u32, n: u32, v: f32, al: f32, be: f32) {
  let co = gg * ${cog}u + m;
  out[(nb * cCout() + co) * gN + n] = act(v${dt.b ? " + ld_bias(co)" : ""}, al, be);
}`;
	const inputs = [
		{ name: "x", dtype: dt.x },
		...(kind === "deform" ? [{ name: "off", dtype: dt.off as DType }] : []),
		...(kind === "deform" && dt.mask ? [{ name: "mask", dtype: dt.mask }] : []),
		{ name: "w", dtype: dt.w },
		...(dt.b ? [{ name: "bias", dtype: dt.b }] : []),
	];
	// cig / cog are baked into the source (constant folding of the hot divisions)
	const spec = nnKernel(
		`${kind}-gemm-${cig}-${cog}${dt.b ? "-bias" : ""}${dt.mask ? "-mask" : ""}${epKey(ep)}`,
		inputs,
		["out"],
		gemmSource(ops, "k", "n", ep),
	);
	return {
		spec,
		meta: convMeta(p, ep, M, N, K),
		wg: [Math.ceil(N / TILE), Math.ceil(M / TILE), p.N * p.groups],
	};
}

/** Direct convolution, one invocation per output element (depthwise and other small-M convs). */
export function convDirectKernel(
	p: ConvParams,
	dt: { x: DType; w: DType; b: DType | null },
	ep: Epilogue,
): KernelCall {
	const cig = p.Cin / p.groups;
	const cog = p.Cout / p.groups;
	const n = p.N * p.Cout * p.Ho * p.Wo;
	const body = `${CONV_FIELDS}${actFn(ep)}
${ENTRY} {
  let i = lin(wid, nwg, lid);
  if (i >= mu(0u)) { return; }
  let al = mf(3u);
  let be = mf(4u);
  let ox = i % cWo();
  let oy = (i / cWo()) % cHo();
  let co = (i / (cWo() * cHo())) % cCout();
  let nb = i / (cWo() * cHo() * cCout());
  let g = co / ${cog}u;
  var s = ${dt.b ? "ld_bias(co)" : "0.0"};
  for (var ci = 0u; ci < ${cig}u; ci++) {
    let xb = (nb * cCin() + g * ${cig}u + ci) * cH();
    let wb = (co * ${cig}u + ci) * ckh();
    for (var ky = 0u; ky < ckh(); ky++) {
      let iy = i32(oy * csh() + ky * cdh()) - cph();
      if (iy < 0 || iy >= i32(cH())) { continue; }
      for (var kx = 0u; kx < ckw(); kx++) {
        let ix = i32(ox * csw() + kx * cdw()) - cpw();
        if (ix < 0 || ix >= i32(cW())) { continue; }
        s += ld_w((wb + ky) * ckw() + kx) * ld_x((xb + u32(iy)) * cW() + u32(ix));
      }
    }
  }
  out[i] = act(s, al, be);
}`;
	const spec = nnKernel(
		`conv-direct-${cig}-${cog}${dt.b ? "-bias" : ""}${epKey(ep)}`,
		[
			{ name: "x", dtype: dt.x },
			{ name: "w", dtype: dt.w },
			...(dt.b ? [{ name: "bias", dtype: dt.b }] : []),
		],
		["out"],
		body,
	);
	const meta = convMeta(p, ep, 0, 0, 0);
	meta[0] = n;
	return { spec, meta, wg: grid1d(n) };
}
