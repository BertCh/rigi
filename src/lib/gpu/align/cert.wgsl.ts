// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// WGSL of the certified-f32 refine (./cert-refine.ts has the loop and the decision-identity argument;
// ./cert-emulate.ts is the CPU twin, operation for operation). Three kernels per round:
//   DECIDE (1 invocation): consume the last round's intervals lane by lane (certified accept / reject,
//     a double-f32 re-check, or a halt for the CPU), finalize iterations and passes, plan the next
//     jobs, write the two indirect commands (x = jobs per tier; 0 skips that tier's kernel).
//   EVAL (indirect, one workgroup of 256 per job): an f32 interval [fLo, fHi] of the CPU's float64
//     f = scorePose(pose, aspect, dirs, edge, fine, 1) − penalty(pose).
//   EVAL2 (indirect, same shape, rare): the same interval in double-f32 (../precision/df32.ts), for the
//     comparisons EVAL's intervals could not decide.
//
// ======================== The error bound (f32 score vs f64 score) and the certificate ========================
// u = 2^-24 (f32 unit roundoff), U32 = 2^-23 = 2u. Premise, checked per device by the shared strict-IEEE
// probe (../precision/ieee-probe.ts, read through cert-gpu.ts alignProbeOk: align takes no square
// roots; a failing device keeps the f64 path): f32 +, −, × correctly rounded, fma fused, ÷ within 4 ULP
// (≤ 8u relative), no re-association of the double-f32 error-free transformations (opq); subnormals
// may flush (charged as absolute slack). The f32 bounds below hold for any order of a sum or dot product
// and with or without FMA contraction.
// "Lattice" terms: the tables hold f64 functions of the lattice angle start + c·unit, the CPU loop's
// angle for the same point is a sequential f64 sum; cert-refine.ts latticeSlack bounds the difference
// (u.dB for a basis component, u.relT relative for tan(vfov/2), u.relV relative for vfov, u.penSlack
// for the penalty; ~1e-13 for ordinary poses).
//
// EVAL (f32):
// 1. Basis. Each table sin / cos is the f64 value rounded to f32 (≤ u; all |·| ≤ 1). poseBasis's
//    operations in f32 (absolute errors): forward = (sy·cp, cy·cp, sp) ≤ 3u; r0 = (cy, −sy, 0) ≤ u;
//    u0 = cross(r0, forward), a·b − c·d: ≤ (u + 3u + u)·2 + u = 11u; right = r0·cr − u0·sr and
//    up = u0·cr + r0·sr: ≤ 3u + 13u + u = 17u. A 3-term f32 dot product d·b is then within
//    (17u + 3u)·|d|₁ + u.dB·|d|₁ of the CPU's (γ3 = 3u in any order).
//    Ed = (40·U32 + u.dB)·|d|₁·1.01 = 80u·|d|₁ + …: 4× slack.
// 2. Per direction (./pose-bound.wgsl.ts's derivation with this Ed): z within Ed of 0.1 → z-ambiguous
//    (no interval) unless certainly outside the frame; u, v with |Δq| ≤ (|q|·(Ed/z + 24·U32 + u.relT) +
//    Ed/(z·T·2))·1.25 + 2·U32 (t, aspect and their product rounded: 3u, three divisions ≤ 24u: 27u ≤
//    48u); a frame test within that of an edge → clip-ambiguous (nAmb; its lowest / highest candidate
//    term → ambLo ≤ 0 / ambHi ≥ 0); a pixel span of 2 → the term at both pixels (min → sumLo,
//    max → sumHi); 3+ → no interval. Per term |c_f32 − c_f64| ≤ 13u·A (above / below: u + 8u each, their
//    difference u, + 0.5m u, (1 − fg) and the product 2u; A = 0.5|m| + |above| + |below|, fg ∈ [0, 1]
//    checked on the host).
// 3. Sum. absA = Σ A over the counted directions; depth = ceil(nDirs/256) + 8 additions per term on
//    the GPU (any order), nDirs on the CPU (f64):
//      E = ((24 + 2·depth)·U32 + nDirs·2⁻⁵²)·absA·1.02 + 1e-30·(n + nAmb)   (u.eCoef; needs (13 + depth)u:
//      ≥ 3.7× slack)
//    S_cpu ∈ [sumLo + ambLo − E, sumHi + ambHi + E], each endpoint's own f32 additions widened by 2·U32
//    of the absolute terms + 1e-30.
// 4. Score. The CPU counts m ∈ [n, n + nAmb] directions, g(S, m) = m > 20 ? (S/m)·cov(m) : 0 with
//    cov(m) = min(m / total / ((vfov·aspect/360)·0.6), 1) (align.ts scoreFromSum). g is increasing in S;
//    for S ≥ 0 non-increasing in m (S/C, then S/m), for S < 0 non-decreasing, so its extremes over the
//    box are at m ∈ {max(n, 21), n + nAmb} (and 0 when m ≤ 20 is possible). The f32 g (vfov, aspect
//    rounded, 3 divisions ≤ 24u, 4 more roundings: ≈ 30u) is widened by 64·U32 = 128u + u.relV relative
//    + 1e-30: ≥ 4× slack.
// 5. Penalty. pen = ((pY + pP) + pR) + pV of table values (each the f64 term rounded once: u) is within
//    4u·pen of the CPU's at the lattice point; charged 16·U32·pen + u.penSlack + 1e-30.
// 6. f = score − pen: fLo = scoreLo − penHi, fHi = scoreHi − penLo, each widened by 2·U32 of itself +
//    1e-30 (one f32 rounding; the CPU's f64 subtraction ≤ 2⁻⁵³).
// So the CPU's float64 f of the pose lies in [fLo, fHi]: the f32 estimate is within half the width of
// the f64 score. Typical width: ~1e-4..1e-3 (the two-pixel cases dominate), so ~13% of comparisons on
// the eval photos fall within it.
//
// EVAL2 (double-f32; per-operation budgets EPS_ADD 3.125u², EPS_MUL 6u², EPS_DIV 9u² from
//    ../precision/df32.ts, which also supplies the operations). Directions EVAL's rules put certainly
//    outside (z, frame) are skipped; the rest are evaluated in df32 from df32 tables (each value split
//    from its f64: ≤ 2⁻⁴⁸ relative). The constants below are computed from EPS_* (each a 2× margin
//    over the operations it covers, plus splits and the CPU's own 2⁻⁵³ roundings): a basis component
//    ≤ BASIS2 + u.dB; a dot product ≤ Ed2 = (BASIS2 + DOT2 + u.dB)·|d|₁; q = ((xr/z)/(t·aspect))/2 as
//    item 2 with rel2 = REL2 + u.relT; u = 0.5 ± q adds ADD2; the pixel margin Eu2·w + PIX2·|X|; per
//    term ≤ TERM2·A; sum E2 = (depth·EPS_ADD + nDirs·2⁻⁵³ + TERM2)·absA·1.02 (u.e2Coef); g ≤ G2 + u.relV
//    relative; penalty PEN2·pen + u.penSlack; endpoint additions END2 of the absolute terms. Flushing
//    subnormals (WGSL allows it; the shared probe accepts it) loses ≤ 2⁻¹²⁶ per operation, inside the
//    1e-30 absolute slack every sum and endpoint carries. The endpoints are rounded outward to f32 and
//    kept away from subnormals (an ulp of f32 is then the width: ~1e-7 at |f| ~ 1).
//    This premise (fused fma, opq surviving, ≤ 4-ULP ÷) is checked inside EVAL2's own module: its
//    entry point `probe` runs the shared probe's records (cert-gpu.ts probeEval2Module).
//
// The certificate (DECIDE). The current best's f lies in [curLo, curHi] (its EVAL or EVAL2 interval, or
// the CPU's exact value rounded outward). The CPU loop accepts a neighbour iff f(nb) > cur. Here:
//   fLo(nb) > curHi  ⇒  f(nb) > cur          certified accept
//   fHi(nb) ≤ curLo  ⇒  f(nb) ≤ cur          certified reject
// i.e. a comparison is certified only when the estimates differ by more than both bounds. Otherwise
// (|Δ| within the bound, an unbounded score, a NaN: both tests false) the lane re-checks the comparison
// with EVAL2 (the neighbour, and the best unless its interval is already tight; EVAL2's interval of the
// best is intersected with EVAL's: disjoint intervals mean a broken bound → REASON.inconsistent); what
// EVAL2 cannot decide HALTS the lane and the CPU decides on exact f64 scores (cert-refine.ts).
// A certified decision is the CPU's decision.
// ===============================================================================================================
//
// Layouts (cert-refine.ts L / JOB_WORDS / RES_WORDS / TABLE_ENTRY / TABLE2_ENTRY, keep in sync):
//   Lane (48 words): status reason fine level iter j improved needStart | c: vec4<i32> | c0: vec4<i32> |
//     curLo curHi nLog planFirst planCount evals certAcc certRej rounds seq haltLo haltHi tier2 curTight
//     plan2First plan2Count | evals2 cert2 auditN pad × 13 (tail of the struct, unnamed)
//   Job (8 words): lane slot (0..7 neighbour, 8 = the pass's start, 9 = the current best) fine serial |
//     idx: vec4<i32>. EVAL's jobs at [0, MAX_JOBS), EVAL2's at [MAX_JOBS, 2·MAX_JOBS) (same for Res).
//   Res (4 words): bits of fLo, bits of fHi, flags (1 = no interval), echo of the job's serial
//   tables: per lane (2W + 1) entries of 3 × vec4<f32>: (sin y, cos y, sin p, cos p),
//     (sin r, cos r, tan(vfov/2), vfov), (penalty yaw, pitch, roll, vfov); tables2: the same 12 values
//     as df32 (hi, lo) pairs, 6 × vec4<f32>.
import {
	DF32_WGSL,
	EPS_ADD,
	EPS_DIV,
	EPS_MUL,
	MIN_NORMAL32,
	split,
} from "#/lib/gpu/precision/df32";
import {
	AUDIT_CAP,
	AUDIT_WORDS,
	MAX_JOBS,
	MAX_LANES,
	T_MAX,
	T_MIN,
	UNIT_DIV,
} from "./cert-refine";

/** Ed coefficient in U32 units (EVAL item 1). */
export const ED_K = 40;
/** relative widening of the score in U32 units (EVAL item 4) */
export const G_REL = 64;
/** relative widening of the penalty in U32 units (EVAL item 5) */
export const PEN_REL = 16;
/** relative error of q in U32 units (EVAL item 2) */
export const Q_REL = 24;

/** u.eCoef (EVAL item 3) for nDirs directions, as the f32 the kernel reads (rounded up). */
export function eCoef(nDirs: number) {
	const depth = Math.ceil(nDirs / 256) + 8;
	return up32(((24 + 2 * depth) * 2 ** -23 + nDirs * 2 ** -52) * 1.02);
}
// EVAL2's error constants, from the df32 per-operation budgets (../precision/df32.ts EPS_*), each with
// a 2× margin over the operation count it covers, plus the double-f32 splits of f64 inputs (2⁻⁴⁸
// each) and the CPU's own f64 roundings (2⁻⁵³ each):
/** a basis component: ≤ 12 ddMul + 5 ddAdd from split table values (absolute, |·| ≤ 1) */
export const BASIS2 =
	2 * (12 * EPS_MUL + 5 * EPS_ADD) + 4 * 2 ** -48 + 10 * 2 ** -53;
/** a 3-term dot product over that basis, per |d|₁ (Ed2 = (BASIS2 + DOT2 + u.dB)·|d|₁) */
export const DOT2 = 2 * (3 * EPS_MUL + 2 * EPS_ADD) + 4 * 2 ** -53;
/** q = ((xr/z)/(t·aspect))/2, relative: 2 ddDiv, 2 ddMul, splits of t and aspect, the CPU's 4 */
export const REL2 =
	2 * (2 * EPS_DIV + 2 * EPS_MUL) + 2 * 2 ** -48 + 6 * 2 ** -53;
/** u = 0.5 ± q, absolute: one ddAddF and the CPU's addition */
export const ADD2 = 2 * EPS_ADD + 2 * 2 ** -53;
/** X = u·w, relative: one ddMulF, the margin ddAddF, the CPU's product */
export const PIX2 = 2 * (EPS_MUL + 2 * EPS_ADD) + 2 * 2 ** -53;
/** one term, relative to A: 2 ddDiv (above, below), 2 ddAdd, 1 ddMul, the CPU's 6 roundings */
export const TERM2 = 2 * (2 * EPS_DIV + 2 * EPS_ADD + EPS_MUL) + 6 * 2 ** -53;
/** the score g, relative: 4 ddDiv, 3 ddMul, splits of vfov, aspect, 0.6, the CPU's 8 roundings */
export const G2 = 2 * (4 * EPS_DIV + 3 * EPS_MUL) + 3 * 2 ** -48 + 8 * 2 ** -53;
/** the penalty, relative: 3 ddAdd, 4 splits, the CPU's 3 additions */
export const PEN2 = 2 * 3 * EPS_ADD + 4 * 2 ** -48 + 3 * 2 ** -53;
/** an interval endpoint's ddAdd + ddAddF, relative to its absolute terms */
export const END2 = 2 * (EPS_ADD + 2 * EPS_ADD) + 2 * 2 ** -53;

/** u.e2Coef (EVAL2's sum): (depth·EPS_ADD + nDirs·2⁻⁵³ + TERM2)·1.02, rounded up. */
export function e2Coef(nDirs: number) {
	const depth = Math.ceil(nDirs / 256) + 8;
	return up32((depth * EPS_ADD + nDirs * 2 ** -53 + TERM2) * 1.02);
}
function up32(x: number) {
	const f = Math.fround(x);
	return f >= x ? f : Math.fround(f * (1 + 2 ** -23));
}

const f32w = new Float32Array(1);
const u32w = new Uint32Array(f32w.buffer);
const bitsLit = (x: number) => {
	f32w[0] = x;
	return `bitcast<f32>(0x${u32w[0].toString(16)}u)`;
};
/** A df32 constant (the f64 v split) as a WGSL vec2<f32> literal. */
const dfLit = (v: number) => {
	const [hi, lo] = split(v);
	return `vec2<f32>(${bitsLit(hi)}, ${bitsLit(lo)})`;
};

const COMMON = /* wgsl */ `
struct U {
	w: u32,
	h: u32,
	nDirs: u32,
	nLanes: u32,
	band: i32,
	gapCoarse: i32,
	gapFine: i32,
	aspect: f32,
	W: u32,
	nonce: u32,
	eCoef: f32,
	total: f32,
	logCap: u32,
	zero: u32,
	dB: f32,
	relT: f32,
	relV: f32,
	penSlack: f32,
	e2Coef: f32,
	aspectHi: f32,
	aspectLo: f32,
	/** TEST ONLY (dev builds): subtracted from every neighbour interval (a broken bound); 0 otherwise */
	fault: f32,
	pad1: u32,
	pad2: u32,
	pad3: u32,
	pad4: u32,
	pad5: u32,
	pad6: u32,
	pad7: u32,
	pad8: u32,
	pad9: u32,
	pad10: u32,
};

struct Lane {
	status: u32,
	reason: u32,
	fine: u32,
	level: u32,
	iter: u32,
	j: u32,
	improved: u32,
	needStart: u32,
	c: vec4<i32>,
	c0: vec4<i32>,
	curLo: f32,
	curHi: f32,
	nLog: u32,
	planFirst: u32,
	planCount: u32,
	evals: u32,
	certAcc: u32,
	certRej: u32,
	rounds: u32,
	seq: u32,
	haltLo: f32,
	haltHi: f32,
	tier2: u32,
	curTight: u32,
	plan2First: u32,
	plan2Count: u32,
	evals2: u32,
	cert2: u32,
	auditN: u32,
	p1: u32,
	p2: u32,
	p3: u32,
	p4: u32,
	p5: u32,
	p6: u32,
	p7: u32,
	p8: u32,
	p9: u32,
	p10: u32,
	p11: u32,
	p12: u32,
	p13: u32,
};

struct Job {
	lane: u32,
	slot: u32,
	fine: u32,
	serial: u32,
	idx: vec4<i32>,
};

const RUNNING: u32 = 0u;
const HALTED: u32 = 1u;
const DONE: u32 = 2u;
const R_TIE: u32 = 1u;
const R_UNBOUNDED: u32 = 2u;
const R_WINDOW: u32 = 3u;
const R_START: u32 = 4u;
const R_STALE: u32 = 5u;
const R_LOGFULL: u32 = 6u;
const R_INCONSISTENT: u32 = 7u;
const RES_UNBOUNDED: u32 = 1u;
const T_MIN: f32 = ${bitsLit(T_MIN)};
const T_MAX: f32 = ${bitsLit(T_MAX)};
`;

// interval endpoints are kept away from subnormals (a device may flush them on store or load)
const NORMAL_CLAMP = /* wgsl */ `
const MIN_NORMAL: f32 = ${bitsLit(MIN_NORMAL32)};
fn clampDown(x: f32) -> f32 {
	if (abs(x) < MIN_NORMAL) { return -MIN_NORMAL; }
	return x;
}
fn clampUp(x: f32) -> f32 {
	if (abs(x) < MIN_NORMAL) { return MIN_NORMAL; }
	return x;
}
`;

export const CERT_DECIDE_WGSL = /* wgsl */ `
${COMMON}
const J2: u32 = ${MAX_JOBS}u;
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read_write> state: array<Lane>;
@group(0) @binding(2) var<storage, read_write> moves: array<u32>;
@group(0) @binding(3) var<storage, read_write> jobs: array<Job>;
@group(0) @binding(4) var<storage, read> res: array<vec4<u32>>;
@group(0) @binding(5) var<storage, read_write> cmd: array<u32>;
@group(0) @binding(6) var<storage, read_write> audit: array<u32>;

// every consumed interval goes to the lane's audit ring (lattice counts, tier, slot, the decision and
// the best's interval it used): the host re-scores a sample exactly (containment) and re-decides every
// EVAL2 accept and every near-margin decision on exact scores (the per-call runtime checks)
fn logAudit(l: u32, s: ptr<function, Lane>, job: Job, lo: f32, hi: f32, tier: u32, decision: u32) {
	let W = i32(u.W);
	let o = (l * ${AUDIT_CAP}u + ((*s).auditN % ${AUDIT_CAP}u)) * ${AUDIT_WORDS}u;
	let c = job.idx - vec4<i32>(W, W, W, W) + (*s).c0;
	audit[o] = bitcast<u32>(lo);
	audit[o + 1u] = bitcast<u32>(hi);
	audit[o + 2u] = bitcast<u32>(c.x);
	audit[o + 3u] = bitcast<u32>(c.y);
	audit[o + 4u] = bitcast<u32>(c.z);
	audit[o + 5u] = bitcast<u32>(c.w);
	audit[o + 6u] =
		job.fine | (tier << 4u) | (job.slot << 8u) | (decision << 12u) | ((*s).iter << 16u);
	audit[o + 7u] = (*s).auditN;
	audit[o + 8u] = bitcast<u32>((*s).curLo);
	audit[o + 9u] = bitcast<u32>((*s).curHi);
	(*s).auditN += 1u;
}

fn halt(s: ptr<function, Lane>, reason: u32) {
	(*s).status = HALTED;
	(*s).reason = reason;
	(*s).planCount = 0u;
	(*s).plan2Count = 0u;
	(*s).tier2 = 0u;
}

// neighbour slot j of c at a step of 'step' counts: axis j >> 1, + for even j, − for odd
fn nbOf(c: vec4<i32>, j: u32, step: i32) -> vec4<i32> {
	var d = vec4<i32>(0, 0, 0, 0);
	var sg = step;
	if ((j & 1u) == 1u) { sg = -step; }
	d[j >> 1u] = sg;
	return c + d;
}

// a certified move: log it, take it (the lane's later jobs, built from the old best, are stale)
// (tight = 1: decided by EVAL2, logged as tier 1; 0: EVAL, tier 0)
fn accept(l: u32, s: ptr<function, Lane>, job: Job, lo: f32, hi: f32, tight: u32) {
	let W = i32(u.W);
	if ((*s).nLog >= u.logCap) { halt(s, R_LOGFULL); return; }
	moves[l * u.logCap + (*s).nLog] =
		(*s).j | ((*s).level << 3u) | ((*s).fine << 6u) | ((*s).iter << 7u) | (tight << 13u);
	(*s).nLog += 1u;
	(*s).c = job.idx - vec4<i32>(W, W, W, W) + (*s).c0;
	(*s).curLo = lo;
	(*s).curHi = hi;
	(*s).curTight = tight;
	(*s).improved = 1u;
	(*s).certAcc += 1u;
	(*s).j += 1u;
}

// EVAL2's results: the start, or the best (intersected) then neighbour j; undecided → the CPU
fn consumeTier2(l: u32, s: ptr<function, Lane>) {
	let first = J2 + (*s).plan2First;
	let count = (*s).plan2Count;
	(*s).plan2Count = 0u;
	(*s).tier2 = 0u;
	for (var q = 0u; q < count; q++) {
		let job = jobs[first + q];
		let r = res[first + q];
		if (r.w != job.serial) { halt(s, R_STALE); return; }
		let lo = bitcast<f32>(r.x);
		let hi = bitcast<f32>(r.y);
		let unb = (r.z & RES_UNBOUNDED) != 0u;
		if (job.slot == 8u || job.slot == 9u) {
			if (!unb) { logAudit(l, s, job, lo, hi, 2u, 0u); }
		}
		if (job.slot == 8u) {
			if (unb) { halt(s, R_START); return; }
			(*s).curLo = lo;
			(*s).curHi = hi;
			(*s).curTight = 1u;
			(*s).needStart = 0u;
			return;
		}
		if (job.slot == 9u) {
			if (!unb) {
				let nl = max((*s).curLo, lo);
				let nh = min((*s).curHi, hi);
				if (nl > nh) {
					(*s).haltLo = lo;
					(*s).haltHi = hi;
					halt(s, R_INCONSISTENT);
					return;
				}
				(*s).curLo = nl;
				(*s).curHi = nh;
				(*s).curTight = 1u;
			}
			continue;
		}
		if (job.slot != (*s).j) { halt(s, R_STALE); return; }
		(*s).haltLo = lo;
		(*s).haltHi = hi;
		if (unb) { halt(s, R_UNBOUNDED); return; }
		if (lo > (*s).curHi) {
			logAudit(l, s, job, lo, hi, 2u, 1u);
			(*s).cert2 += 1u;
			accept(l, s, job, lo, hi, 1u);
			return;
		}
		if (hi <= (*s).curLo) {
			logAudit(l, s, job, lo, hi, 2u, 2u);
			(*s).cert2 += 1u;
			(*s).certRej += 1u;
			(*s).j += 1u;
			return;
		}
		// |Δ| within EVAL2's bound too (or a NaN): the CPU decides
		logAudit(l, s, job, lo, hi, 2u, 3u);
		halt(s, R_TIE);
		return;
	}
}

fn consumeLane(l: u32, s: ptr<function, Lane>) {
	let first = (*s).planFirst;
	let count = (*s).planCount;
	(*s).planCount = 0u;
	if ((*s).tier2 == 1u) {
		if ((*s).plan2Count > 0u) {
			(*s).rounds += 1u;
			consumeTier2(l, s);
		}
		return;
	}
	if (count == 0u) { return; }
	(*s).rounds += 1u;
	if ((*s).needStart == 1u) {
		let job = jobs[first];
		let r = res[first];
		if (r.w != job.serial || job.slot != 8u) { halt(s, R_STALE); return; }
		if ((r.z & RES_UNBOUNDED) != 0u) { (*s).tier2 = 1u; return; }
		logAudit(l, s, job, bitcast<f32>(r.x), bitcast<f32>(r.y), 1u, 0u);
		(*s).curLo = bitcast<f32>(r.x);
		(*s).curHi = bitcast<f32>(r.y);
		(*s).curTight = 0u;
		(*s).needStart = 0u;
		return;
	}
	for (var q = 0u; q < count; q++) {
		let job = jobs[first + q];
		let r = res[first + q];
		if (r.w != job.serial || job.slot != (*s).j) { halt(s, R_STALE); return; }
		let lo = bitcast<f32>(r.x);
		let hi = bitcast<f32>(r.y);
		if ((r.z & RES_UNBOUNDED) == 0u) {
			if (lo > (*s).curHi) {
				logAudit(l, s, job, lo, hi, 1u, 1u);
				accept(l, s, job, lo, hi, 0u);
				return;
			}
			if (hi <= (*s).curLo) {
				logAudit(l, s, job, lo, hi, 1u, 2u);
				(*s).certRej += 1u;
				(*s).j += 1u;
				continue;
			}
			logAudit(l, s, job, lo, hi, 1u, 3u);
		}
		// |Δ| within the f32 bound, no f32 interval, or a NaN: re-check in double-f32
		(*s).tier2 = 1u;
		return;
	}
}

// the end of a Descent iteration (align.ts Descent.step): no move → halve (level + 1; yaw step < 0.01
// at level 6), 60 iterations max; a finished coarse pass starts the fine pass from its best
fn finalize(s: ptr<function, Lane>) {
	var done = false;
	if ((*s).improved == 0u) {
		(*s).level += 1u;
		if ((*s).level >= 6u) { done = true; }
	}
	(*s).iter += 1u;
	if ((*s).iter >= 60u) { done = true; }
	(*s).j = 0u;
	(*s).improved = 0u;
	if (done) {
		if ((*s).fine == 1u) {
			(*s).status = DONE;
		} else {
			(*s).fine = 1u;
			(*s).level = 0u;
			(*s).iter = 0u;
			(*s).needStart = 1u;
		}
	}
}

fn serialOf(l: u32, s: ptr<function, Lane>) -> u32 {
	return (u.nonce * 2654435761u) ^ (l << 24u) ^ ((*s).seq & 0xffffffu);
}

fn pushJob(l: u32, s: ptr<function, Lane>, n: ptr<function, u32>, slot: u32, c: vec4<i32>) {
	let W = i32(u.W);
	jobs[*n] = Job(l, slot, (*s).fine, serialOf(l, s), c - (*s).c0 + vec4<i32>(W, W, W, W));
	(*s).seq += 1u;
	(*s).evals += 1u;
	(*s).planCount += 1u;
	*n += 1u;
}

fn pushJob2(l: u32, s: ptr<function, Lane>, n: ptr<function, u32>, slot: u32, c: vec4<i32>) {
	let W = i32(u.W);
	jobs[J2 + *n] = Job(l, slot, (*s).fine, serialOf(l, s), c - (*s).c0 + vec4<i32>(W, W, W, W));
	(*s).seq += 1u;
	(*s).evals2 += 1u;
	(*s).plan2Count += 1u;
	*n += 1u;
}

fn planLane(l: u32, s: ptr<function, Lane>, n: ptr<function, u32>, n2: ptr<function, u32>) {
	(*s).planFirst = *n;
	(*s).planCount = 0u;
	(*s).plan2First = *n2;
	(*s).plan2Count = 0u;
	if ((*s).status != RUNNING) { return; }
	let step = i32(${UNIT_DIV}u >> (*s).level);
	if ((*s).tier2 == 1u) {
		if ((*s).needStart == 1u) {
			pushJob2(l, s, n2, 8u, (*s).c);
			return;
		}
		if ((*s).curTight == 0u) { pushJob2(l, s, n2, 9u, (*s).c); }
		pushJob2(l, s, n2, (*s).j, nbOf((*s).c, (*s).j, step));
		return;
	}
	if ((*s).needStart == 1u) {
		pushJob(l, s, n, 8u, (*s).c);
		return;
	}
	let W = i32(u.W);
	for (var j = (*s).j; j < 8u; j++) {
		let d = abs(nbOf((*s).c, j, step) - (*s).c0);
		if (max(max(d.x, d.y), max(d.z, d.w)) > W) { halt(s, R_WINDOW); return; }
	}
	for (var j = (*s).j; j < 8u; j++) {
		pushJob(l, s, n, j, nbOf((*s).c, j, step));
	}
}

@compute @workgroup_size(1, 1, 1)
fn main() {
	// consume every lane first (planning rewrites the job list the lanes read)
	for (var l = 0u; l < min(u.nLanes, ${MAX_LANES}u); l++) {
		var s = state[l];
		if (s.status == RUNNING) { consumeLane(l, &s); }
		if (s.status == RUNNING && s.tier2 == 0u && s.j >= 8u) { finalize(&s); }
		state[l] = s;
	}
	var n = 0u;
	var n2 = 0u;
	for (var l = 0u; l < min(u.nLanes, ${MAX_LANES}u); l++) {
		var s = state[l];
		planLane(l, &s, &n, &n2);
		state[l] = s;
	}
	cmd[0] = n;
	cmd[1] = 1u;
	cmd[2] = 1u;
	cmd[64] = n2;
	cmd[65] = 1u;
	cmd[66] = 1u;
}
`;

const EVAL_HEAD = /* wgsl */ `
${NORMAL_CLAMP}
const WG: u32 = 256u;
const U32: f32 = 1.1920929e-7;
const ED_K: f32 = ${ED_K}.0;
const G_REL: f32 = ${G_REL}.0;
const PEN_REL: f32 = ${PEN_REL}.0;
const Q_REL: f32 = ${Q_REL}.0;

fn near(x: f32, thr: f32, e: f32) -> bool {
	return abs(x - thr) <= e;
}

fn finite(x: f32) -> bool {
	return (bitcast<u32>(x) & 0x7f800000u) != 0x7f800000u;
}
`;

export const CERT_EVAL_WGSL = /* wgsl */ `
${COMMON}
${EVAL_HEAD}
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> jobs: array<Job>;
@group(0) @binding(2) var<storage, read> tables: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> dirs: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> coarse: array<f32>;
@group(0) @binding(5) var<storage, read> fine: array<f32>;
@group(0) @binding(6) var<storage, read> fg: array<f32>;
@group(0) @binding(7) var<storage, read> skyCum: array<f32>;
@group(0) @binding(8) var<storage, read_write> res: array<vec4<u32>>;

var<workgroup> sLo: array<f32, 256>;
var<workgroup> sHi: array<f32, 256>;
var<workgroup> sA: array<f32, 256>;
var<workgroup> sN: array<u32, 256>;
var<workgroup> sAmb: array<u32, 256>;
var<workgroup> sAmbZ: array<u32, 256>;
var<workgroup> sAmbHi: array<f32, 256>;
var<workgroup> sAmbLo: array<f32, 256>;

struct C { c: f32, a: f32 };

// the CPU's per-direction term at pixel (x, y), and A = 0.5|m| + |above| + |below| (pose-bound's term)
fn term(x: i32, y: i32, gap: i32, isFine: bool) -> C {
	let w = i32(u.w);
	let h = i32(u.h);
	let a0 = max(0, y - gap - u.band);
	let a1 = max(0, y - gap);
	let b0 = min(h, y + gap);
	let b1 = min(h, y + gap + u.band);
	var above = 0.5;
	if (a1 > a0) { above = (skyCum[a1 * w + x] - skyCum[a0 * w + x]) / f32(a1 - a0); }
	var below = 0.5;
	if (b1 > b0) { below = (skyCum[b1 * w + x] - skyCum[b0 * w + x]) / f32(b1 - b0); }
	let k = y * w + x;
	var m = coarse[k];
	if (isFine) { m = fine[k]; }
	return C((0.5 * m + (above - below)) * (1.0 - fg[k]), 0.5 * abs(m) + abs(above) + abs(below));
}

// align.ts scoreFromSum for m > 20 (the caller handles m ≤ 20)
fn g(S: f32, m: u32, vfov: f32) -> f32 {
	let mf = f32(m);
	let cov = min(mf / u.total / ((vfov * u.aspect / 360.0) * 0.6), 1.0);
	return (S / mf) * cov;
}

@compute @workgroup_size(256, 1, 1)
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
	let job = jobs[wid.x];
	let W2 = i32(2u * u.W);
	let base = job.lane * (2u * u.W + 1u);
	let iy = (base + u32(clamp(job.idx.x, 0, W2))) * 3u;
	let ip = (base + u32(clamp(job.idx.y, 0, W2))) * 3u;
	let ir = (base + u32(clamp(job.idx.z, 0, W2))) * 3u;
	let iv = (base + u32(clamp(job.idx.w, 0, W2))) * 3u;
	let ty = tables[iy];
	let tp = tables[ip];
	let tr = tables[ir + 1u];
	let tv = tables[iv + 1u];
	let sy = ty.x;
	let cy = ty.y;
	let sp = tp.z;
	let cp = tp.w;
	let sr = tr.x;
	let cr = tr.y;
	let t = tv.z;
	let vfov = tv.w;
	// camera poseBasis, its operations in f32 (item 1)
	let f4 = vec3<f32>(sy * cp, cy * cp, sp);
	let r0 = vec3<f32>(cy, -sy, 0.0);
	let u0 = vec3<f32>(
		r0.y * f4.z - r0.z * f4.y,
		r0.z * f4.x - r0.x * f4.z,
		r0.x * f4.y - r0.y * f4.x,
	);
	let r4 = vec3<f32>(r0.x * cr - u0.x * sr, r0.y * cr - u0.y * sr, r0.z * cr - u0.z * sr);
	let u4 = vec3<f32>(u0.x * cr + r0.x * sr, u0.y * cr + r0.y * sr, u0.z * cr + r0.z * sr);
	let isFine = job.fine == 1u;
	var gap = u.gapCoarse;
	if (isFine) { gap = u.gapFine; }
	let fw = f32(u.w);
	let fh = f32(u.h);
	let T = t * u.aspect;
	let qRel = Q_REL * U32 + u.relT;
	let edK = ED_K * U32 + u.dB;
	var lo = 0.0;
	var hi = 0.0;
	var aSum = 0.0;
	var n = 0u;
	var amb = 0u;
	var ambZ = 0u;
	var ambHi = 0.0;
	var ambLo = 0.0;
	for (var i = lid; i < u.nDirs; i += WG) {
		let d = dirs[i].xyz;
		let d1 = abs(d.x) + abs(d.y) + abs(d.z);
		let ed = edK * d1 * 1.01;
		let z = d.x * f4.x + d.y * f4.y + d.z * f4.z;
		let xr = d.x * r4.x + d.y * r4.y + d.z * r4.z;
		if (near(z, 0.1, ed + 1e-8)) {
			let qmin = (abs(xr) - ed) / (z + ed) / T / 2.0;
			if (qmin * (1.0 - 64.0 * U32) <= 0.49 + 1e-6) { ambZ += 1u; }
			continue;
		}
		if (z <= 0.1) { continue; }
		let xu = d.x * u4.x + d.y * u4.y + d.z * u4.z;
		let qu = xr / z / T / 2.0;
		let qv = xu / z / t / 2.0;
		let uu = 0.5 + qu;
		let vv = 0.5 - qv;
		let zl = z - ed;
		let eu = (abs(qu) * (ed / zl + qRel) + ed / (zl * T * 2.0)) * 1.25 + 2.0 * U32;
		let ev = (abs(qv) * (ed / zl + qRel) + ed / (zl * t * 2.0)) * 1.25 + 2.0 * U32;
		let eu1 = eu + 1e-9;
		let ev1 = ev + 1e-9;
		let nearU = near(uu, 0.01, eu1) || near(uu, 0.99, eu1);
		let nearV = near(vv, 0.01, ev1) || near(vv, 0.99, ev1);
		if ((!nearU && (uu < 0.01 || uu > 0.99)) || (!nearV && (vv < 0.01 || vv > 0.99))) { continue; }
		let X = uu * fw;
		let Y = vv * fh;
		let mx = eu * fw + U32 * abs(X) + 1e-6;
		let my = ev * fh + U32 * abs(Y) + 1e-6;
		let fxa = i32(floor(X - mx));
		let fxb = i32(floor(X + mx));
		let fya = i32(floor(Y - my));
		let fyb = i32(floor(Y + my));
		if (fxb - fxa > 1 || fyb - fya > 1) { ambZ += 1u; continue; }
		let xa = clamp(fxa, 0, i32(u.w) - 1);
		let xb = clamp(fxb, 0, i32(u.w) - 1);
		let ya = clamp(fya, 0, i32(u.h) - 1);
		let yb = clamp(fyb, 0, i32(u.h) - 1);
		var c = term(xa, ya, gap, isFine);
		var cLo = c.c;
		var cHi = c.c;
		var cA = c.a;
		if (xb != xa) {
			c = term(xb, ya, gap, isFine);
			cLo = min(cLo, c.c); cHi = max(cHi, c.c); cA = max(cA, c.a);
		}
		if (yb != ya) {
			c = term(xa, yb, gap, isFine);
			cLo = min(cLo, c.c); cHi = max(cHi, c.c); cA = max(cA, c.a);
			if (xb != xa) {
				c = term(xb, yb, gap, isFine);
				cLo = min(cLo, c.c); cHi = max(cHi, c.c); cA = max(cA, c.a);
			}
		}
		aSum += cA;
		if (nearU || nearV) {
			amb += 1u;
			ambHi += max(0.0, cHi);
			ambLo += min(0.0, cLo);
		} else {
			lo += cLo;
			hi += cHi;
			n += 1u;
		}
	}
	sLo[lid] = lo;
	sHi[lid] = hi;
	sA[lid] = aSum;
	sN[lid] = n;
	sAmb[lid] = amb;
	sAmbZ[lid] = ambZ;
	sAmbHi[lid] = ambHi;
	sAmbLo[lid] = ambLo;
	workgroupBarrier();
	for (var s = WG / 2u; s > 0u; s = s / 2u) {
		if (lid < s) {
			sLo[lid] += sLo[lid + s];
			sHi[lid] += sHi[lid + s];
			sA[lid] += sA[lid + s];
			sN[lid] += sN[lid + s];
			sAmb[lid] += sAmb[lid + s];
			sAmbZ[lid] += sAmbZ[lid + s];
			sAmbHi[lid] += sAmbHi[lid + s];
			sAmbLo[lid] += sAmbLo[lid + s];
		}
		workgroupBarrier();
	}
	if (lid != 0u) { return; }
	let N = sN[0];
	let NA = sAmb[0];
	let sumLo = sLo[0];
	let sumHi = sHi[0];
	let absA = sA[0];
	let aHi = sAmbHi[0];
	let aLo = sAmbLo[0];
	var flags = 0u;
	if (sAmbZ[0] > 0u || !finite(sumLo) || !finite(sumHi) || !finite(absA) || !finite(aHi) ||
		!finite(aLo) || absA < 0.0 || aHi < 0.0 || aLo > 0.0 || !(t >= T_MIN && t <= T_MAX)) {
		flags = RES_UNBOUNDED;
	}
	// item 3: the CPU's sum S ∈ [sLoT, sHiT]
	let E = u.eCoef * absA + 1e-30 * f32(N + NA);
	var sHiT = sumHi + aHi + E;
	sHiT = sHiT + 2.0 * U32 * (abs(sumHi) + aHi + E) + 1e-30;
	var sLoT = sumLo + aLo - E;
	sLoT = sLoT - 2.0 * U32 * (abs(sumLo) + abs(aLo) + E) - 1e-30;
	// item 4: the score's extremes over m ∈ [N, N + NA]
	var scHi = -3.0e38;
	var scLo = 3.0e38;
	if (N <= 20u) { scHi = 0.0; scLo = 0.0; }
	let m1 = max(N, 21u);
	let m2 = N + NA;
	if (m1 <= m2) {
		scHi = max(scHi, max(g(sHiT, m1, vfov), g(sHiT, m2, vfov)));
		scLo = min(scLo, min(g(sLoT, m1, vfov), g(sLoT, m2, vfov)));
	}
	let gRel = G_REL * U32 + u.relV;
	scHi = scHi + abs(scHi) * gRel + 1e-30;
	scLo = scLo - abs(scLo) * gRel - 1e-30;
	// item 5: the penalty, the CPU's summation order
	let pen = ((tables[iy + 2u].x + tables[ip + 2u].y) + tables[ir + 2u].z) + tables[iv + 2u].w;
	let penHi = pen * (1.0 + PEN_REL * U32) + u.penSlack + 1e-30;
	let penLo = pen * (1.0 - PEN_REL * U32) - u.penSlack - 1e-30;
	// item 6
	var fHi = scHi - penLo;
	fHi = fHi + abs(fHi) * 2.0 * U32 + 1e-30;
	var fLo = scLo - penHi;
	fLo = fLo - abs(fLo) * 2.0 * U32 - 1e-30;
	if (!finite(fLo) || !finite(fHi)) { flags = RES_UNBOUNDED; }
	if (job.slot < 8u) {
		fLo = fLo - u.fault;
		fHi = fHi - u.fault;
	}
	res[wid.x] = vec4<u32>(bitcast<u32>(clampDown(fLo)), bitcast<u32>(clampUp(fHi)), flags, job.serial);
}
`;

/** EVAL2's double-f32 constants (the CPU's f64 literals, split). */
const DF_CONSTS = /* wgsl */ `
const C01 = ${dfLit(0.1)};
const C001 = ${dfLit(0.01)};
const C099 = ${dfLit(0.99)};
const C06 = ${dfLit(0.6)};
`;

export const CERT_EVAL2_WGSL = /* wgsl */ `
${COMMON}
${EVAL_HEAD}
${DF32_WGSL}
${DF_CONSTS}
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> jobs: array<Job>;
@group(0) @binding(2) var<storage, read> tables2: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> dirs: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> coarse: array<f32>;
@group(0) @binding(5) var<storage, read> fine: array<f32>;
@group(0) @binding(6) var<storage, read> fg: array<f32>;
@group(0) @binding(7) var<storage, read> skyCum: array<f32>;
@group(0) @binding(8) var<storage, read_write> res: array<vec4<u32>>;

var<workgroup> wLo: array<vec2<f32>, 256>;
var<workgroup> wHi: array<vec2<f32>, 256>;
var<workgroup> wAmbLo: array<vec2<f32>, 256>;
var<workgroup> wAmbHi: array<vec2<f32>, 256>;
var<workgroup> wA: array<f32, 256>;
var<workgroup> wN: array<u32, 256>;
var<workgroup> wAmb: array<u32, 256>;
var<workgroup> wAmbZ: array<u32, 256>;

const ED2: f32 = ${bitsLit(up32(BASIS2 + DOT2))};
const REL2: f32 = ${bitsLit(up32(REL2))};
const ADD2: f32 = ${bitsLit(up32(ADD2))};
const PIX2: f32 = ${bitsLit(up32(PIX2))};
const G2: f32 = ${bitsLit(up32(G2))};
const PEN2: f32 = ${bitsLit(up32(PEN2))};
const END2: f32 = ${bitsLit(up32(END2))};

fn dfLt(a: vec2<f32>, b: vec2<f32>) -> bool {
	return a.x < b.x || (a.x == b.x && a.y < b.y);
}
fn dfMin(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
	if (dfLt(b, a)) { return b; }
	return a;
}
fn dfMax(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
	if (dfLt(a, b)) { return b; }
	return a;
}
// floor of a normalised df32 with |hi| < 2^24 (a non-integer hi has the floor of hi + lo)
fn dfFloor(a: vec2<f32>) -> i32 {
	let f = floor(a.x);
	if (f == a.x && a.y < 0.0) { return i32(f) - 1; }
	return i32(f);
}
fn nextUp(x: f32) -> f32 {
	if (x == 0.0) { return MIN_NORMAL; }
	let b = bitcast<u32>(x);
	if (x > 0.0) { return bitcast<f32>(b + 1u); }
	return bitcast<f32>(b - 1u);
}
fn nextDown(x: f32) -> f32 {
	return -nextUp(-x);
}
// a normalised df32 rounded outward to f32
fn dfDown(a: vec2<f32>) -> f32 {
	if (a.y < 0.0) { return nextDown(a.x); }
	return a.x;
}
fn dfUp(a: vec2<f32>) -> f32 {
	if (a.y > 0.0) { return nextUp(a.x); }
	return a.x;
}
// sign of a − c beyond the margin e (|a − c| ≤ e: 0)
fn side(a: vec2<f32>, c: vec2<f32>, e: f32) -> i32 {
	let d = ddAdd(a, -c).x;
	if (abs(d) <= e * 1.01 + 1e-30) { return 0; }
	if (d < 0.0) { return -1; }
	return 1;
}
fn dot2(f: array<vec2<f32>, 3>, d: vec3<f32>) -> vec2<f32> {
	return ddAdd(ddAdd(ddMulF(f[0], d.x), ddMulF(f[1], d.y)), ddMulF(f[2], d.z));
}

struct C2 { c: vec2<f32>, a: f32 };

// the CPU's per-direction term at pixel (x, y) in df32 (EVAL2: ≤ 2^-42·A), and A
fn term2(x: i32, y: i32, gap: i32, isFine: bool) -> C2 {
	let w = i32(u.w);
	let h = i32(u.h);
	let a0 = max(0, y - gap - u.band);
	let a1 = max(0, y - gap);
	let b0 = min(h, y + gap);
	let b1 = min(h, y + gap + u.band);
	var above = vec2<f32>(0.5, 0.0);
	if (a1 > a0) {
		above = ddDiv(twoSum(skyCum[a1 * w + x], -skyCum[a0 * w + x]), vec2<f32>(f32(a1 - a0), 0.0));
	}
	var below = vec2<f32>(0.5, 0.0);
	if (b1 > b0) {
		below = ddDiv(twoSum(skyCum[b1 * w + x], -skyCum[b0 * w + x]), vec2<f32>(f32(b1 - b0), 0.0));
	}
	let k = y * w + x;
	var m = coarse[k];
	if (isFine) { m = fine[k]; }
	let t1 = ddAddF(ddAdd(above, -below), 0.5 * m);
	let c = ddMul(t1, twoSum(1.0, -fg[k]));
	return C2(c, 0.5 * abs(m) + abs(above.x) + abs(below.x));
}

fn g2(S: vec2<f32>, m: u32, vfov: vec2<f32>, asp: vec2<f32>) -> vec2<f32> {
	let mm = vec2<f32>(f32(m), 0.0);
	let den = ddMul(ddDiv(ddMul(vfov, asp), vec2<f32>(360.0, 0.0)), C06);
	var cov = ddDiv(ddDiv(mm, vec2<f32>(u.total, 0.0)), den);
	if (!dfLt(cov, vec2<f32>(1.0, 0.0))) { cov = vec2<f32>(1.0, 0.0); }
	return ddMul(ddDiv(S, mm), cov);
}

fn tab(i: u32, k: u32) -> vec2<f32> {
	let v = tables2[i * 6u + (k >> 1u)];
	if ((k & 1u) == 0u) { return v.xy; }
	return v.zw;
}

@compute @workgroup_size(256, 1, 1)
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
	ZERO = u.zero;
	let job = jobs[wid.x];
	let W2 = i32(2u * u.W);
	let base = job.lane * (2u * u.W + 1u);
	let iy = base + u32(clamp(job.idx.x, 0, W2));
	let ip = base + u32(clamp(job.idx.y, 0, W2));
	let ir = base + u32(clamp(job.idx.z, 0, W2));
	let iv = base + u32(clamp(job.idx.w, 0, W2));
	let sy = tab(iy, 0u);
	let cy = tab(iy, 1u);
	let sp = tab(ip, 2u);
	let cp = tab(ip, 3u);
	let sr = tab(ir, 4u);
	let cr = tab(ir, 5u);
	let t2 = tab(iv, 6u);
	let vfov2 = tab(iv, 7u);
	let asp = vec2<f32>(u.aspectHi, u.aspectLo);
	// df32 basis (poseBasis's operations; EVAL2: ≤ 2^-40 + u.dB per component)
	let F0 = ddMul(sy, cp);
	let F1 = ddMul(cy, cp);
	let F2 = sp;
	let U0x = ddMul(-sy, sp);
	let U0y = -ddMul(cy, sp);
	let U0z = ddAdd(ddMul(cy, F1), ddMul(sy, F0));
	let R = array<vec2<f32>, 3>(
		ddAdd(ddMul(cy, cr), -ddMul(U0x, sr)),
		ddAdd(-ddMul(sy, cr), -ddMul(U0y, sr)),
		-ddMul(U0z, sr),
	);
	let UP = array<vec2<f32>, 3>(
		ddAdd(ddMul(U0x, cr), ddMul(cy, sr)),
		ddAdd(ddMul(U0y, cr), -ddMul(sy, sr)),
		ddMul(U0z, cr),
	);
	let FW = array<vec2<f32>, 3>(F0, F1, F2);
	// EVAL's f32 basis (the hi parts), for the cull only
	let f4 = vec3<f32>(F0.x, F1.x, F2.x);
	let r4 = vec3<f32>(R[0].x, R[1].x, R[2].x);
	let u4 = vec3<f32>(UP[0].x, UP[1].x, UP[2].x);
	let t = t2.x;
	let T = t * u.aspect;
	let TA = ddMul(t2, asp);
	let isFine = job.fine == 1u;
	var gap = u.gapCoarse;
	if (isFine) { gap = u.gapFine; }
	let fw = f32(u.w);
	let fh = f32(u.h);
	let qRel = Q_REL * U32 + u.relT;
	let edK = ED_K * U32 + u.dB;
	let rel2 = REL2 + u.relT;
	var lo = vec2<f32>(0.0, 0.0);
	var hi = vec2<f32>(0.0, 0.0);
	var ambLo = vec2<f32>(0.0, 0.0);
	var ambHi = vec2<f32>(0.0, 0.0);
	var aSum = 0.0;
	var n = 0u;
	var amb = 0u;
	var ambZ = 0u;
	for (var i = lid; i < u.nDirs; i += WG) {
		let d = dirs[i].xyz;
		let d1 = abs(d.x) + abs(d.y) + abs(d.z);
		// EVAL's cull (with EVAL's Ed, the basis 1 ULP looser: still within its 4× slack): skip only
		// what is certainly outside
		let ed = edK * d1 * 1.25;
		let z = d.x * f4.x + d.y * f4.y + d.z * f4.z;
		if (!near(z, 0.1, ed + 1e-8) && z <= 0.1) { continue; }
		if (z > 0.1 + ed + 1e-8) {
			let xr = d.x * r4.x + d.y * r4.y + d.z * r4.z;
			let xu = d.x * u4.x + d.y * u4.y + d.z * u4.z;
			let qu = xr / z / T / 2.0;
			let qv = xu / z / t / 2.0;
			let zl = z - ed;
			let eu = (abs(qu) * (ed / zl + qRel) + ed / (zl * T * 2.0)) * 1.25 + 2.0 * U32 + 1e-9;
			let ev = (abs(qv) * (ed / zl + qRel) + ed / (zl * t * 2.0)) * 1.25 + 2.0 * U32 + 1e-9;
			if (abs(qu) > 0.49 + eu * 2.0 || abs(qv) > 0.49 + ev * 2.0) { continue; }
		}
		// df32 (EVAL2 items)
		let ed2 = (ED2 + u.dB) * d1 * 1.01;
		let Z = dot2(FW, d);
		let zs = side(Z, C01, ed2);
		if (zs == 0) { ambZ += 1u; continue; }
		if (zs < 0) { continue; }
		let XR = dot2(R, d);
		let XU = dot2(UP, d);
		let QU = ddMulF(ddDiv(ddDiv(XR, Z), TA), 0.5);
		let QV = ddMulF(ddDiv(ddDiv(XU, Z), t2), 0.5);
		let UU = ddAddF(QU, 0.5);
		let VV = ddAddF(-QV, 0.5);
		let zl2 = (Z.x - ed2) * (1.0 - 4.0 * U32);
		let eu2 = (abs(QU.x) * (ed2 / zl2 + rel2) + ed2 / (zl2 * TA.x * 2.0)) * 1.25 + ADD2;
		let ev2 = (abs(QV.x) * (ed2 / zl2 + rel2) + ed2 / (zl2 * t * 2.0)) * 1.25 + ADD2;
		let su1 = side(UU, C001, eu2);
		let su9 = side(UU, C099, eu2);
		let sv1 = side(VV, C001, ev2);
		let sv9 = side(VV, C099, ev2);
		let nearU = su1 == 0 || su9 == 0;
		let nearV = sv1 == 0 || sv9 == 0;
		if ((!nearU && (su1 < 0 || su9 > 0)) || (!nearV && (sv1 < 0 || sv9 > 0))) { continue; }
		let X = ddMulF(UU, fw);
		let Y = ddMulF(VV, fh);
		let mx = eu2 * fw * 1.01 + PIX2 * abs(X.x) + 1e-30;
		let my = ev2 * fh * 1.01 + PIX2 * abs(Y.x) + 1e-30;
		let fxa = dfFloor(ddAddF(X, -mx));
		let fxb = dfFloor(ddAddF(X, mx));
		let fya = dfFloor(ddAddF(Y, -my));
		let fyb = dfFloor(ddAddF(Y, my));
		if (fxb - fxa > 1 || fyb - fya > 1) { ambZ += 1u; continue; }
		let xa = clamp(fxa, 0, i32(u.w) - 1);
		let xb = clamp(fxb, 0, i32(u.w) - 1);
		let ya = clamp(fya, 0, i32(u.h) - 1);
		let yb = clamp(fyb, 0, i32(u.h) - 1);
		var c = term2(xa, ya, gap, isFine);
		var cLo = c.c;
		var cHi = c.c;
		var cA = c.a;
		if (xb != xa) {
			c = term2(xb, ya, gap, isFine);
			cLo = dfMin(cLo, c.c); cHi = dfMax(cHi, c.c); cA = max(cA, c.a);
		}
		if (yb != ya) {
			c = term2(xa, yb, gap, isFine);
			cLo = dfMin(cLo, c.c); cHi = dfMax(cHi, c.c); cA = max(cA, c.a);
			if (xb != xa) {
				c = term2(xb, yb, gap, isFine);
				cLo = dfMin(cLo, c.c); cHi = dfMax(cHi, c.c); cA = max(cA, c.a);
			}
		}
		aSum += cA;
		if (nearU || nearV) {
			amb += 1u;
			ambHi = ddAdd(ambHi, dfMax(cHi, vec2<f32>(0.0, 0.0)));
			ambLo = ddAdd(ambLo, dfMin(cLo, vec2<f32>(0.0, 0.0)));
		} else {
			lo = ddAdd(lo, cLo);
			hi = ddAdd(hi, cHi);
			n += 1u;
		}
	}
	wLo[lid] = lo;
	wHi[lid] = hi;
	wAmbLo[lid] = ambLo;
	wAmbHi[lid] = ambHi;
	wA[lid] = aSum;
	wN[lid] = n;
	wAmb[lid] = amb;
	wAmbZ[lid] = ambZ;
	workgroupBarrier();
	for (var s = WG / 2u; s > 0u; s = s / 2u) {
		if (lid < s) {
			wLo[lid] = ddAdd(wLo[lid], wLo[lid + s]);
			wHi[lid] = ddAdd(wHi[lid], wHi[lid + s]);
			wAmbLo[lid] = ddAdd(wAmbLo[lid], wAmbLo[lid + s]);
			wAmbHi[lid] = ddAdd(wAmbHi[lid], wAmbHi[lid + s]);
			wA[lid] += wA[lid + s];
			wN[lid] += wN[lid + s];
			wAmb[lid] += wAmb[lid + s];
			wAmbZ[lid] += wAmbZ[lid + s];
		}
		workgroupBarrier();
	}
	if (lid != 0u) { return; }
	let N = wN[0];
	let NA = wAmb[0];
	let sumLo = wLo[0];
	let sumHi = wHi[0];
	let aLo = wAmbLo[0];
	let aHi = wAmbHi[0];
	let absA = wA[0];
	var flags = 0u;
	if (wAmbZ[0] > 0u || !finite(sumLo.x) || !finite(sumHi.x) || !finite(absA) || !finite(aHi.x) ||
		!finite(aLo.x) || absA < 0.0 || aHi.x < 0.0 || aLo.x > 0.0 || !(t >= T_MIN && t <= T_MAX)) {
		flags = RES_UNBOUNDED;
	}
	let E2 = u.e2Coef * absA + 1e-30 * f32(N + NA);
	let sHiT = ddAddF(ddAdd(sumHi, aHi), E2 + END2 * (abs(sumHi.x) + abs(aHi.x)));
	let sLoT = ddAddF(ddAdd(sumLo, aLo), -(E2 + END2 * (abs(sumLo.x) + abs(aLo.x))));
	var scHi = vec2<f32>(-3.0e38, 0.0);
	var scLo = vec2<f32>(3.0e38, 0.0);
	if (N <= 20u) { scHi = vec2<f32>(0.0, 0.0); scLo = vec2<f32>(0.0, 0.0); }
	let m1 = max(N, 21u);
	let m2 = N + NA;
	if (m1 <= m2) {
		scHi = dfMax(scHi, dfMax(g2(sHiT, m1, vfov2, asp), g2(sHiT, m2, vfov2, asp)));
		scLo = dfMin(scLo, dfMin(g2(sLoT, m1, vfov2, asp), g2(sLoT, m2, vfov2, asp)));
	}
	let gw = G2 + u.relV;
	scHi = ddAddF(scHi, abs(scHi.x) * gw * 1.01 + 1e-30);
	scLo = ddAddF(scLo, -(abs(scLo.x) * gw * 1.01 + 1e-30));
	let pen = ddAdd(ddAdd(ddAdd(tab(iy, 8u), tab(ip, 9u)), tab(ir, 10u)), tab(iv, 11u));
	let pw = abs(pen.x) * PEN2 + u.penSlack + 1e-30;
	let fHi = ddAddF(ddAdd(scHi, -pen), pw + END2 * (abs(scHi.x) + abs(pen.x)));
	let fLo = ddAddF(ddAdd(scLo, -pen), -(pw + END2 * (abs(scLo.x) + abs(pen.x))));
	var lo32 = dfDown(fLo);
	var hi32 = dfUp(fHi);
	if (!finite(lo32) || !finite(hi32)) { flags = RES_UNBOUNDED; }
	if (job.slot < 8u) {
		lo32 = lo32 - u.fault;
		hi32 = hi32 - u.fault;
	}
	res[wid.x] = vec4<u32>(bitcast<u32>(clampDown(lo32)), bitcast<u32>(clampUp(hi32)), flags, job.serial);
}

// The strict-IEEE probe compiled INSIDE this module (fma fusion, flushing and fast-math are decided
// per compiled shader): ../precision/ieee-probe.ts PROBE_WGSL's records and operations, read from the
// \`dirs\` binding (2 × vec4 = PROBE_IN f32 per record) and written as bits to \`res\` (5 × vec4 =
// PROBE_OUT words), verified on the host by verifyProbe. The never-true branch keeps every binding of
// the module statically used, so this entry point shares EVAL2's binding layout.
@compute @workgroup_size(64, 1, 1)
fn probe(@builtin(global_invocation_id) gid: vec3<u32>) {
	ZERO = u.zero;
	if (u.nDirs == 0xffffffffu) {
		let k = tables2[0].x + coarse[0] + fine[0] + fg[0] + skyCum[0];
		res[0] = vec4<u32>(bitcast<u32>(k), jobs[0].lane, 0u, 0u);
	}
	let i = gid.x;
	if (i >= u.nDirs) { return; }
	let p0 = dirs[2u * i];
	let p1 = dirs[2u * i + 1u];
	let a = p0.x;
	let bb = p0.y;
	let c = p0.z;
	let x = vec2<f32>(p0.w, p1.x);
	let y = vec2<f32>(p1.y, p1.z);
	let ts = twoSum(a, bb);
	let tp = twoProd(a, bb);
	let s = ddAdd(x, y);
	let m = ddMul(x, y);
	let q = ddDiv(x, y);
	let r = ddSqrt(abs(x));
	let fs = fastTwoSum(a, opq(bb * 1e-9));
	let o = 5u * i;
	res[o] = vec4<u32>(bitcast<u32>(opq(a + bb)), bitcast<u32>(opq(a * bb)), bitcast<u32>(opq(fma(a, bb, c))), bitcast<u32>(opq(a / bb)));
	res[o + 1u] = vec4<u32>(bitcast<u32>(opq(sqrt(abs(a)))), bitcast<u32>(ts.x), bitcast<u32>(ts.y), bitcast<u32>(tp.x));
	res[o + 2u] = vec4<u32>(bitcast<u32>(tp.y), bitcast<u32>(s.x), bitcast<u32>(s.y), bitcast<u32>(m.x));
	res[o + 3u] = vec4<u32>(bitcast<u32>(m.y), bitcast<u32>(q.x), bitcast<u32>(q.y), bitcast<u32>(r.x));
	res[o + 4u] = vec4<u32>(bitcast<u32>(r.y), bitcast<u32>(fs.x), bitcast<u32>(fs.y), 0u);
}
`;
