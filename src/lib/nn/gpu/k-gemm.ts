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
import {
	GEMM_THREADS,
	type GemmConfig,
	gemmBM,
	gemmBN,
	gemmConfigKey,
	selectGemmConfig,
} from "./gemm-select";
import { ENTRY, type KernelCall, unaryExpr } from "./k-elementwise";
import { getKernelCaps } from "./kernel-caps";
import { grid1d, nnKernel } from "./wgsl";

/** Fused epilogue activation (applied after the bias). */
export type Epilogue = { op: UnaryPrim; alpha: number; beta: number } | null;

const actFn = (e: Epilogue) =>
	e
		? `fn act(v: f32, al: f32, be: f32) -> f32 { return ${unaryExpr(e.op)}; }\n`
		: "fn act(v: f32, al: f32, be: f32) -> f32 { return v; }\n";

/** Output tile: BM × BN per 256-thread workgroup (4 × 4 per thread), K steps of BK. */
export type GemmTile = { BM: number; BN: number; BK: number };

/** The tile for M rows: narrow-M tiles keep small-Cout convs from wasting the 64-row tile. */
export function gemmTile(M: number): GemmTile {
	if (M <= 16) return { BM: 16, BN: 256, BK: 8 };
	if (M <= 32) return { BM: 32, BN: 128, BK: 16 };
	return { BM: 64, BN: 64, BK: 16 };
}

const tileKey = (t: GemmTile) => `${t.BM}x${t.BN}x${t.BK}`;

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
	t: GemmTile,
): string {
	const { BM, BN, BK } = t;
	const TY = BM / 4;
	const TX = BN / 4;
	const aIdx =
		aMajor === "k"
			? `let ak = e % ${BK}u; let am = e / ${BK}u;`
			: `let am = e % ${BM}u; let ak = e / ${BM}u;`;
	const bIdx =
		bMajor === "n"
			? `let bn = e % ${BN}u; let bk = e / ${BN}u;`
			: `let bk = e % ${BK}u; let bn = e / ${BK}u;`;
	return `
var<workgroup> As: array<f32, ${BM * BK}>;
var<workgroup> Bs: array<f32, ${BN * BK}>;
var<private> gM: u32;
var<private> gN: u32;
var<private> gK: u32;
${actFn(ep)}
${ops}
@compute @workgroup_size(${TX}, ${TY})
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  gM = mu(0u); gN = mu(1u); gK = mu(2u);
  let al = mf(3u);
  let be = mf(4u);
  setup(wid.z);
  let m0 = wid.y * ${BM}u;
  let n0 = wid.x * ${BN}u;
  let tid = lid.y * ${TX}u + lid.x;
  var acc: array<vec4<f32>, 4>;
  let kTotal = mu(2u);
  for (var k0 = 0u; k0 < kTotal; k0 += ${BK}u) {
    for (var e = tid; e < ${BM * BK}u; e += 256u) {
      ${aIdx}
      let gm = m0 + am;
      let gk = k0 + ak;
      var va = 0.0;
      if (gm < gM && gk < gK) { va = loadA(gm, gk); }
      As[ak * ${BM}u + am] = va;
    }
    for (var e = tid; e < ${BN * BK}u; e += 256u) {
      ${bIdx}
      let gk2 = k0 + bk;
      let gn = n0 + bn;
      var vb = 0.0;
      if (gk2 < gK && gn < gN) { vb = loadB(gk2, gn); }
      Bs[bk * ${BN}u + bn] = vb;
    }
    workgroupBarrier();
    for (var k = 0u; k < ${BK}u; k++) {
      let ab = k * ${BM}u + lid.y * 4u;
      let bb = k * ${BN}u + lid.x * 4u;
      let a = vec4<f32>(As[ab], As[ab + 1u], As[ab + 2u], As[ab + 3u]);
      let b = vec4<f32>(Bs[bb], Bs[bb + 1u], Bs[bb + 2u], Bs[bb + 3u]);
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

/** How the v2 kernel loads its tiles: scalar loaders, or vec4 reads of contiguous operand runs. */
type GemmLoads = {
	/** A is read as vec4 along k (`loadA4(m, k)`, k % 4 == 0) */
	vecA: boolean;
	/** B is read as vec4 along n (`loadB4(k, n)`) or along k (`loadB4(n, k)`, transposed B) */
	vecB: "n" | "k" | null;
	/** shared tiles and the multiply in f16 (needs `enable f16`, i.e. an f16 input) */
	f16Math: boolean;
	f16Accumulate: boolean;
};

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

/**
 * GEMM body v2: same op contract as gemmSource (`setup`, `loadA`, `loadB`, `store`), with a TM × TN
 * register block per thread, operand tiles stored k-major in vec4 workgroup arrays (one vec4 read
 * feeds 4 FMA rows), the inner loops unrolled at generation time, and optional vec4 global loads
 * (`loadA4` / `loadB4` in `ops`) for dense matmul operands.
 */
function gemmSourceV2(
	ops: string,
	bMajor: "k" | "n",
	ep: Epilogue,
	c: GemmConfig,
	ld: GemmLoads,
): string {
	const { TM, TN, TX, TY, BK } = c;
	const BM = gemmBM(c);
	const BN = gemmBN(c);
	const TM4 = TM / 4;
	const TN4 = TN / 4;
	const T = ld.f16Math ? "f16" : "f32";
	const AT = ld.f16Math && ld.f16Accumulate ? "f16" : "f32";
	const NT = GEMM_THREADS;
	// Every tile store writes whole vec4s: one thread owns 4 consecutive tile rows (A) or columns (B),
	// so no two threads write components of one workgroup vec4 (that is a miscompile / race on
	// Dawn/Metal, not a valid WGSL pattern to rely on).
	const toT = (v: string) => (ld.f16Math ? `vec4<f16>(${v})` : v);
	const lanes = (f: (i: number) => string) => range(4).map(f);
	const BM4 = BM / 4;
	const BN4 = BN / 4;
	const BK4 = BK / 4;
	let loadA: string;
	if (ld.vecA) {
		// thread = (4 rows, one vec4 along k); register 4×4 transpose into k-major rows
		loadA = `for (var e = tid; e < ${BM4 * BK4}u; e += ${NT}u) {
      let am4 = e / ${BK4}u;
      let ak = (e % ${BK4}u) * 4u;
      let gk = k0 + ak;
      ${lanes(
				(r) =>
					`var r${r} = vec4<f32>(0.0); { let gm = m0 + am4 * 4u + ${r}u; if (gm < gM && gk < gK) { r${r} = loadA4(gm, gk); } }`,
			).join("\n      ")}
      ${lanes(
				(i) =>
					`As[(ak + ${i}u) * ${BM4}u + am4] = ${toT(`vec4<f32>(r0[${i}], r1[${i}], r2[${i}], r3[${i}])`)};`,
			).join("\n      ")}
    }`;
	} else {
		loadA = `for (var e = tid; e < ${BM4 * BK}u; e += ${NT}u) {
      let ak = e % ${BK}u;
      let am4 = e / ${BK}u;
      let gk = k0 + ak;
      var v = vec4<f32>(0.0);
      ${lanes(
				(r) =>
					`{ let gm = m0 + am4 * 4u + ${r}u; if (gm < gM && gk < gK) { v[${r}] = loadA(gm, gk); } }`,
			).join("\n      ")}
      As[ak * ${BM4}u + am4] = ${toT("v")};
    }`;
	}
	let loadB: string;
	if (ld.vecB === "n") {
		loadB = `for (var e = tid; e < ${BK * BN4}u; e += ${NT}u) {
      let bk = e / ${BN4}u;
      let bn4 = e % ${BN4}u;
      let gk2 = k0 + bk;
      let gn = n0 + bn4 * 4u;
      var v = vec4<f32>(0.0);
      if (gk2 < gK && gn < gN) { v = loadB4(gk2, gn); }
      Bs[bk * ${BN4}u + bn4] = ${toT("v")};
    }`;
	} else if (ld.vecB === "k") {
		loadB = `for (var e = tid; e < ${BN4 * BK4}u; e += ${NT}u) {
      let bn4 = e / ${BK4}u;
      let bk = (e % ${BK4}u) * 4u;
      let gk2 = k0 + bk;
      ${lanes(
				(r) =>
					`var r${r} = vec4<f32>(0.0); { let gn = n0 + bn4 * 4u + ${r}u; if (gn < gN && gk2 < gK) { r${r} = loadB4(gn, gk2); } }`,
			).join("\n      ")}
      ${lanes(
				(i) =>
					`Bs[(bk + ${i}u) * ${BN4}u + bn4] = ${toT(`vec4<f32>(r0[${i}], r1[${i}], r2[${i}], r3[${i}])`)};`,
			).join("\n      ")}
    }`;
	} else {
		// scalar B, 4 consecutive n per thread; bMajor "k" walks k fastest across threads
		const bIdx =
			bMajor === "n"
				? `let bn4 = e % ${BN4}u; let bk = e / ${BN4}u;`
				: `let bk = e % ${BK}u; let bn4 = e / ${BK}u;`;
		loadB = `for (var e = tid; e < ${BN4 * BK}u; e += ${NT}u) {
      ${bIdx}
      let gk2 = k0 + bk;
      var v = vec4<f32>(0.0);
      ${lanes(
				(r) =>
					`{ let gn = n0 + bn4 * 4u + ${r}u; if (gk2 < gK && gn < gN) { v[${r}] = loadB(gk2, gn); } }`,
			).join("\n      ")}
      Bs[bk * ${BN4}u + bn4] = ${toT("v")};
    }`;
	}
	// ---- inner product, unrolled
	const aReads = range(TM4)
		.map((i) => `let a${i} = As[ab + ${i}u];`)
		.join("\n      ");
	const bReads = range(TN4)
		.map((j) => `let b${j} = Bs[bb + ${j}u];`)
		.join("\n      ");
	const fmas = range(TM)
		.flatMap((i) =>
			range(TN4).map(
				(j) =>
					`acc[${i * TN4 + j}] += ${AT === T ? "" : `vec4<${AT}>`}(a${Math.floor(i / 4)}[${i % 4}] * b${j});`,
			),
		)
		.join("\n      ");
	const stores = range(TM)
		.map(
			(i) => `{
      let m = m0 + lid.y * ${TM}u + ${i}u;
      if (m < gM) {
        ${range(TN)
					.map((j) => {
						const n = `n0 + lid.x * ${TN}u + ${j}u`;
						return `if (${n} < gN) { store(m, ${n}, f32(acc[${i * TN4 + Math.floor(j / 4)}][${j % 4}]), al, be); }`;
					})
					.join("\n        ")}
      }
    }`,
		)
		.join("\n    ");
	return `
var<workgroup> As: array<vec4<${T}>, ${(BK * BM) / 4}>;
var<workgroup> Bs: array<vec4<${T}>, ${(BK * BN) / 4}>;
var<private> gM: u32;
var<private> gN: u32;
var<private> gK: u32;
${actFn(ep)}
${ops}
@compute @workgroup_size(${TX}, ${TY})
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  gM = mu(0u); gN = mu(1u); gK = mu(2u);
  let al = mf(3u);
  let be = mf(4u);
  setup(wid.z);
  let m0 = wid.y * ${BM}u;
  let n0 = wid.x * ${BN}u;
  let tid = lid.y * ${TX}u + lid.x;
  var acc: array<vec4<${AT}>, ${TM * TN4}>;
  for (var i = 0u; i < ${TM * TN4}u; i++) { acc[i] = vec4<${AT}>(0.0); }
  let kTotal = mu(2u);
  for (var k0 = 0u; k0 < kTotal; k0 += ${BK}u) {
    ${loadA}
    ${loadB}
    workgroupBarrier();
    for (var k = 0u; k < ${BK}u; k++) {
      let ab = k * ${BM / 4}u + lid.y * ${TM4}u;
      let bb = k * ${BN / 4}u + lid.x * ${TN4}u;
      ${aReads}
      ${bReads}
      ${fmas}
    }
    workgroupBarrier();
  }
  ${stores}
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
	const caps = getKernelCaps();
	const baseOps = `
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
fn store(m: u32, n: u32, v: f32, al: f32, be: f32) {
  out[oBase + m * gN + n] = act(v${dbias ? " + ld_bias(n)" : ""}, al, be);
}`;
	const biasInput = dbias ? [{ name: "bias", dtype: dbias }] : [];
	if (!caps.legacy) {
		// v2: vec4 loads where the contiguous operand runs allow (dims divisible by 4; dense tensors
		// make every batch base a multiple of 4 then)
		const vecA = K % 4 === 0;
		const vecB = transB ? (K % 4 === 0 ? "k" : null) : N % 4 === 0 ? "n" : null;
		const f16Math = caps.f16 && caps.f16Math && (da === "f16" || db === "f16");
		const config = selectGemmConfig(M, N, caps.gemmTileOverride);
		const vec4Of = (d: DType) => `vec4<${d}>`;
		const elem: Record<string, string> = {};
		if (vecA) elem.a = vec4Of(da);
		if (vecB) elem.b = vec4Of(db);
		const ops = `${baseOps}
${
	vecA
		? `fn loadA4(m: u32, k: u32) -> vec4<f32> { return vec4<f32>(a[(aBase + m * gK + k) >> 2u]); }`
		: "fn loadA(m: u32, k: u32) -> f32 { return ld_a(aBase + m * gK + k); }"
}
${
	vecB === "n"
		? "fn loadB4(k: u32, n: u32) -> vec4<f32> { return vec4<f32>(b[(bBase + k * gN + n) >> 2u]); }"
		: vecB === "k"
			? "fn loadB4(n: u32, k: u32) -> vec4<f32> { return vec4<f32>(b[(bBase + n * gK + k) >> 2u]); }"
			: `fn loadB(k: u32, n: u32) -> f32 { return ld_b(bBase + ${transB ? "n * gK + k" : "k * gN + n"}); }`
}`;
		const spec = nnKernel(
			`matmul2${transB ? "-tb" : ""}${dbias ? "-bias" : ""}${epKey(ep)}-${gemmConfigKey(config)}-${vecA ? "a4" : "a1"}${vecB ? `b4${vecB}` : "b1"}${f16Math ? (caps.f16Accumulate ? "-h16" : "-h") : ""}`,
			[{ name: "a", dtype: da }, { name: "b", dtype: db }, ...biasInput],
			["out"],
			gemmSourceV2(ops, transB ? "k" : "n", ep, config, {
				vecA,
				vecB,
				f16Math,
				f16Accumulate: caps.f16Accumulate,
			}),
			[],
			elem,
		);
		return {
			spec,
			meta,
			wg: [Math.ceil(N / gemmBN(config)), Math.ceil(M / gemmBM(config)), Z],
		};
	}
	const ops = `${baseOps}
fn loadA(m: u32, k: u32) -> f32 { return ld_a(aBase + m * gK + k); }
fn loadB(k: u32, n: u32) -> f32 { return ld_b(bBase + ${transB ? "n * gK + k" : "k * gN + n"}); }`;
	const inputs = [
		{ name: "a", dtype: da },
		{ name: "b", dtype: db },
		...biasInput,
	];
	const t = gemmTile(M);
	const spec = nnKernel(
		`matmul${transB ? "-tb" : ""}${dbias ? "-bias" : ""}${epKey(ep)}-${tileKey(t)}`,
		inputs,
		["out"],
		gemmSource(ops, "k", transB ? "k" : "n", ep, t),
	);
	return {
		spec,
		meta,
		wg: [Math.ceil(N / t.BN), Math.ceil(M / t.BM), Z],
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

/** The structural conv parameters baked into a v2 kernel (constant folding of the im2col index math). */
const convBakeKey = (p: ConvParams) =>
	`k${p.kh}x${p.kw}s${p.sh}x${p.sw}p${p.ph}x${p.pw}d${p.dh}x${p.dw}g${p.groups}o${p.dg}`;
const convFieldsBaked = (p: ConvParams) =>
	CONV_FIELDS.replace(
		/fn ckh\(\).*\n/,
		`fn ckh() -> u32 { return ${p.kh}u; }\n`,
	)
		.replace(/fn ckw\(\).*\n/, `fn ckw() -> u32 { return ${p.kw}u; }\n`)
		.replace(/fn csh\(\).*\n/, `fn csh() -> u32 { return ${p.sh}u; }\n`)
		.replace(/fn csw\(\).*\n/, `fn csw() -> u32 { return ${p.sw}u; }\n`)
		.replace(/fn cph\(\).*\n/, `fn cph() -> i32 { return ${p.ph}; }\n`)
		.replace(/fn cpw\(\).*\n/, `fn cpw() -> i32 { return ${p.pw}; }\n`)
		.replace(/fn cdh\(\).*\n/, `fn cdh() -> u32 { return ${p.dh}u; }\n`)
		.replace(/fn cdw\(\).*\n/, `fn cdw() -> u32 { return ${p.dw}u; }\n`)
		.replace(/fn cG\(\).*\n/, `fn cG() -> u32 { return ${p.groups}u; }\n`)
		.replace(/fn cDg\(\).*\n/, `fn cDg() -> u32 { return ${p.dg}u; }\n`);

/** Four consecutive output pixels (n .. n+3) of one im2col row k, for plain convs (fn loadB4). */
const convLoadB4 = (cig: number) => `
fn loadB4(k: u32, n: u32) -> vec4<f32> {
  let kk = ckh() * ckw();
  let ci = k / kk;
  let r = k % kk;
  let ky = r / ckw();
  let kx = r % ckw();
  var oy = n / cWo();
  var ox = n % cWo();
  let xb = (nb * cCin() + gg * ${cig}u + ci) * cH();
  var v = vec4<f32>(0.0);
  for (var j = 0u; j < 4u; j++) {
    let iy = i32(oy * csh() + ky * cdh()) - cph();
    let ix = i32(ox * csw() + kx * cdw()) - cpw();
    if (iy >= 0 && ix >= 0 && iy < i32(cH()) && ix < i32(cW())) {
      v[j] = ld_x((xb + u32(iy)) * cW() + u32(ix));
    }
    ox += 1u;
    if (ox == cWo()) { ox = 0u; oy += 1u; }
  }
  return v;
}
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
	const caps = getKernelCaps();
	const keyBase = `${kind}-gemm-${cig}-${cog}${dt.b ? "-bias" : ""}${dt.mask ? "-mask" : ""}${epKey(ep)}`;
	if (!caps.legacy) {
		const config = selectGemmConfig(M, N, caps.gemmTileOverride);
		// plain convs gather 4 consecutive output pixels per loader call: the k → (ci, ky, kx) split and
		// the pixel's (oy, ox) are computed once for the four
		const gather4 = kind === "conv";
		const spec = nnKernel(
			`${keyBase}${gather4 ? "-g4" : ""}-${gemmConfigKey(config)}-${convBakeKey(p)}`,
			inputs,
			["out"],
			gemmSourceV2(
				ops.replace(CONV_FIELDS, convFieldsBaked(p)) +
					(gather4 ? convLoadB4(cig) : ""),
				"n",
				ep,
				config,
				{
					vecA: false,
					vecB: gather4 ? "n" : null,
					f16Math: false,
					f16Accumulate: false,
				},
			),
		);
		return {
			spec,
			meta: convMeta(p, ep, M, N, K),
			wg: [
				Math.ceil(N / gemmBN(config)),
				Math.ceil(M / gemmBM(config)),
				p.N * p.groups,
			],
		};
	}
	const t = gemmTile(M);
	const spec = nnKernel(
		`${keyBase}-${tileKey(t)}`,
		inputs,
		["out"],
		gemmSource(ops, "k", "n", ep, t),
	);
	return {
		spec,
		meta: convMeta(p, ep, M, N, K),
		wg: [Math.ceil(N / t.BN), Math.ceil(M / t.BM), p.N * p.groups],
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
