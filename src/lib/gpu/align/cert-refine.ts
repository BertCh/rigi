// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Certified-f32 refine (WAG W3.3, precision policy P1 "certified f32"; the default since 2026-10-01,
// ?alignPrecision=f64 for the CPU loop).
//
// autoAlign's coordinate descent (align.ts Descent) as a GPU-driven loop: every hypothesis is a LANE
// whose descent state lives on the GPU; one submit encodes a fixed number of rounds, each
//   decide (consume the last round's scores, take the moves, plan the next neighbours, write the
//   indirect command) → eval (indirect: one workgroup per planned neighbour, a CERTIFIED f32 interval
//   of the CPU's float64 f = scorePose − penalty)
// and the f64 re-score of every neighbour is replaced by a certified compare:
//   accept  iff  fLo(neighbour) > curHi      reject  iff  fHi(neighbour) ≤ curLo
// where [fLo, fHi] ∋ f64 value for both the neighbour and the current best (cert.wgsl.ts has the
// written error bound). A comparison the f32 intervals cannot decide (|Δ| within the bound, an
// unbounded score) is re-evaluated in the next round by the double-f32 kernel EVAL2 (../precision
// df32, ~2^-40 relative instead of ~1e-4), the neighbour and, unless already tight, the current best;
// only what that still cannot decide (|Δ| ≲ 1e-7, a NaN, a degenerate projection) HALTS the lane at
// that neighbour: the CPU decides that one comparison with the exact f64 scores (the tie path, the
// solve-fold pattern) and the lane resumes on the GPU at the next submit.
//
// Decision identity rests on EVERY certified decision being the f64 loop's `s > cur`. That holds when
// the written bound (cert.wgsl.ts) is right and the device meets its arithmetic premise (the shared
// strict-IEEE probe, plus a probe entry point compiled inside the EVAL2 module itself); the runtime
// checks below only SAMPLE it (intervals re-scored exactly, sampled decisions re-decided, every
// EVAL2 accept and every near-margin decision re-decided on exact f64 scores). Given correct decisions,
// the sequence of accepted moves is the CPU loop's by induction, and the CPU's float64 replay of the
// GPU's move log (Descent's own expressions, align.ts neighbour / halve) reproduces the CPU loop's
// poses bit for bit; the final pose of each hypothesis is re-scored exactly (scorePose is pure). The
// replay itself does NOT detect a wrong decision: a wrong certified move gives a different, equally
// replayable trace (only its well-formedness and the lattice counts are checked). So the AlignResult
// is the f64 path's as long as no certified decision is wrong; the checks make a wrong one unlikely
// to go unnoticed, they do not prove its absence.
//
// Poses on the GPU. A pose angle is never rounded to f32 on the GPU: lanes move on a lattice, angle =
// start + c · unit (c an i32 count, unit = the initial step / 32: Descent's steps are step0 / 2^L for
// L = 0..5, i.e. 32 >> L units). The CPU tabulates per lane, for a window of ±W counts around a
// centre c0, f32(sin), f32(cos) of yaw, pitch, roll, f32(tan(vfov/2)), f32(vfov) and f32 of each
// penalty term, all evaluated in float64 at the lattice angle (cert.wgsl.ts charges the difference to
// the f64 loop's sequentially summed angle). A lane leaving its window halts (WINDOW); the CPU
// re-centres the window and the lane goes on.
//
// The runner is either the GPU graph (./cert-gpu.ts) or the f32 CPU emulation (./cert-emulate.ts, the
// node check's twin of the WGSL); both work on the CertBuffers below, so this driver is shared.
import {
	type AlignCtx,
	DESCENT_KEYS,
	descentSteps,
	halve,
	neighbour,
	penaltyTerms,
	probeKey,
	RefineBoundViolation,
	type Steps,
} from "#/lib/align";
import type { Pose } from "#/lib/camera";
import { split } from "#/lib/gpu/precision/df32";

const D = Math.PI / 180;

// ---- buffer layouts (cert.wgsl.ts structs; keep in sync) ----

/** u32 words per lane state (struct Lane). */
export const LANE_WORDS = 48;
/** Lane word indices. */
export const L = {
	status: 0,
	reason: 1,
	fine: 2,
	level: 3,
	iter: 4,
	j: 5,
	improved: 6,
	needStart: 7,
	/** i32 × 4: lattice counts of the current best (yaw, pitch, roll, vfov) */
	c: 8,
	/** i32 × 4: the table window's centre */
	c0: 12,
	/** f32: the certified interval of the current best's f */
	curLo: 16,
	curHi: 17,
	nLog: 18,
	planFirst: 19,
	planCount: 20,
	/** counters: neighbour / start evaluations planned, certified accepts, certified rejects */
	evals: 21,
	certAcc: 22,
	certRej: 23,
	/** rounds in which the lane consumed scores */
	rounds: 24,
	/** job serial counter (stale-result guard) */
	seq: 25,
	/** f32: the halting neighbour's interval (diagnostics) */
	haltLo: 26,
	haltHi: 27,
	/** 1: the last comparison was undecided in f32; this round re-evaluates it in double-f32 */
	tier2: 28,
	/** 1: [curLo, curHi] is tight (from EVAL2 or the CPU's exact value), no EVAL2 re-run needed */
	curTight: 29,
	plan2First: 30,
	plan2Count: 31,
	/** EVAL2 jobs planned, and decisions EVAL2 certified */
	evals2: 32,
	cert2: 33,
	/** intervals written to the lane's audit ring so far */
	auditN: 34,
} as const;
export const STATUS = { running: 0, halted: 1, done: 2, idle: 3 } as const;
export const REASON = {
	none: 0,
	/** the certified compare could not decide (|Δ| within the bound) */
	tie: 1,
	/** no certified interval for the neighbour (a z- or 3-pixel-ambiguous direction, a NaN) */
	unbounded: 2,
	/** a planned neighbour is outside the lane's table window */
	window: 3,
	/** no certified interval for the pass's start pose */
	start: 4,
	/** a result word did not echo its job (a skipped or stale dispatch): GPU error */
	stale: 5,
	/** the move log is full (cannot happen: ≤ 2 passes × 60 iterations × 8 moves < LOG_CAP) */
	logFull: 6,
	/** EVAL2's interval of the current best is disjoint from EVAL's: a broken bound */
	inconsistent: 7,
} as const;
/** u32 words per job (struct Job: lane, slot, fine, serial, idx: vec4<i32>). */
export const JOB_WORDS = 8;
/** u32 words per result (struct Res: lo, hi, flags, echo). */
export const RES_WORDS = 4;
export const RES_UNBOUNDED = 1;
/**
 * log entries per lane; an entry is j | level << 3 | fine << 6 | iter << 7 (6 bits) | tier << 13, tier
 * = who decided the move: 0 EVAL (f32), 1 EVAL2 (double-f32), 2 the CPU (exact f64)
 */
export const LOG_CAP = 1024;
/** max lanes (autoAlign has ≤ 5 hypotheses) */
export const MAX_LANES = 8;
/** jobs per round and tier: ≤ 8 neighbours (or 1 start) per lane; EVAL2's jobs follow at MAX_JOBS */
export const MAX_JOBS = MAX_LANES * 8;
/** table half-width (counts); 2W + 1 entries per lane */
export const WINDOW = 256;
/** f32 per table entry: EVAL's (f32 values), EVAL2's (double-f32 hi, lo pairs) */
export const TABLE_ENTRY = 12;
export const TABLE2_ENTRY = 24;
/** lattice: a step of level L is 32 >> L counts (Descent's 6 levels, L = 0..5) */
export const UNIT_DIV = 32;
/**
 * DECIDE's audit ring per lane: every interval it consumes, with the decision made on it. Words: lo,
 * hi bits, c: 4 × i32, flags = fine | tier << 4 | slot << 8 | decision << 12 | iter << 16, n (the
 * entry's index), curLo, curHi bits (the best's interval the decision used), 2 × pad. Decision: 0 none
 * (start / best re-check), 1 accept, 2 reject, 3 left open (EVAL2 or the CPU next). A lane consumes
 * ≤ 8 EVAL plus ≤ 2 EVAL2 intervals per round, so AUDIT_CAP ≥ rounds · 10 + 2 keeps a whole submit
 * (MAX_ROUNDS): the host sees every interval and every GPU decision.
 */
export const AUDIT_CAP = 512;
export const AUDIT_WORDS = 12;
export const MAX_ROUNDS = Math.floor((AUDIT_CAP - 2) / 10);
/** uniform words (struct U) */
export const U_WORDS = 32;

export const logEntry = (
	j: number,
	level: number,
	fine: number,
	iter: number,
	tier = 0,
) => (j | (level << 3) | (fine << 6) | (iter << 7) | (tier << 13)) >>> 0;
/** a move log entry's iteration (bits 7..12) */
export const entryIter = (e: number) => (e >>> 7) & 63;

const MIN_NORMAL = 2 ** -126;
/**
 * The f32 just below / above a double (outward rounding of an exact score to an f32 interval), kept
 * away from subnormals (a device may flush them): |result| < 2^-126 becomes ∓2^-126.
 */
export function f32Down(x: number) {
	const f = Math.fround(x);
	const r = f <= x ? f : nextF32(f, -1);
	return Math.abs(r) < MIN_NORMAL ? -MIN_NORMAL : r;
}
export function f32Up(x: number) {
	const f = Math.fround(x);
	const r = f >= x ? f : nextF32(f, 1);
	return Math.abs(r) < MIN_NORMAL ? MIN_NORMAL : r;
}
const nb32 = new Float32Array(1);
const nbU = new Uint32Array(nb32.buffer);
function nextF32(f: number, dir: 1 | -1) {
	if (f === 0) return dir * 2 ** -149;
	nb32[0] = f;
	nbU[0] += f > 0 === dir > 0 ? 1 : -1;
	return nb32[0];
}

/** The CPU-visible buffers of one certified refine (the GPU runner mirrors them). */
export type CertBuffers = {
	nLanes: number;
	state: ArrayBuffer;
	u32: Uint32Array;
	i32: Int32Array;
	f32: Float32Array;
	log: Uint32Array;
	tables: Float32Array;
	tables2: Float32Array;
	/** DECIDE's audit ring (read back with the state) */
	audit: Uint32Array;
	/** set when the CPU changed tables / log since the last run (the GPU runner re-uploads them) */
	tablesDirty: boolean;
	logDirty: boolean;
};

/** Bound constants a runner passes to the kernels (latticeSlack). */
export type LatticeSlack = ReturnType<typeof latticeSlack>;

/** Runs `rounds` rounds on the buffers (GPU graph or f32 emulation), in place. */
export type CertRunner = {
	run: (b: CertBuffers, rounds: number, slack: LatticeSlack) => Promise<void>;
};

/** Per-lane lattice: start pose and unit per axis (float64). */
export type LaneLattice = { start: Pose; unit: Steps };

export function laneLattice(start: Pose, vfov0: number): LaneLattice {
	const s0 = descentSteps(vfov0);
	return {
		start,
		unit: {
			yaw: s0.yaw / UNIT_DIV,
			pitch: s0.pitch / UNIT_DIV,
			roll: s0.roll / UNIT_DIV,
			vfov: s0.vfov / UNIT_DIV,
		},
	};
}

/** Lattice angle of axis k at count c (float64). */
const latticeAngle = (
	lat: LaneLattice,
	k: (typeof DESCENT_KEYS)[number],
	c: number,
) => lat.start[k] + c * lat.unit[k];

/**
 * Fill lane `lane`'s table window (centre c0) from float64 values: per entry i (count c0 + i − W):
 * A = (sin yaw, cos yaw, sin pitch, cos pitch), B = (sin roll, cos roll, tan(vfov/2), vfov),
 * C = the four penalty terms; each rounded to f32 once (cert.wgsl.ts charges u per value).
 */
export function fillLaneTable(
	b: Pick<CertBuffers, "tables" | "tables2">,
	lane: number,
	lat: LaneLattice,
	c0: ArrayLike<number>,
	prior: Pose,
) {
	const pen = penaltyTerms(prior);
	const { tables, tables2 } = b;
	const n = 2 * WINDOW + 1;
	let o = lane * n * TABLE_ENTRY;
	for (let i = 0; i < n; i++, o += TABLE_ENTRY) {
		const y = latticeAngle(lat, "yaw", c0[0] + i - WINDOW);
		const p = latticeAngle(lat, "pitch", c0[1] + i - WINDOW);
		const r = latticeAngle(lat, "roll", c0[2] + i - WINDOW);
		const v = latticeAngle(lat, "vfov", c0[3] + i - WINDOW);
		// the very expressions of camera poseBasis / projectPoint (angle · D, then sin / cos / tan)
		tables[o] = Math.sin(y * D);
		tables[o + 1] = Math.cos(y * D);
		tables[o + 2] = Math.sin(p * D);
		tables[o + 3] = Math.cos(p * D);
		tables[o + 4] = Math.sin(r * D);
		tables[o + 5] = Math.cos(r * D);
		tables[o + 6] = Math.tan((v * D) / 2);
		tables[o + 7] = v;
		tables[o + 8] = pen.yaw(y);
		tables[o + 9] = pen.pitch(p);
		tables[o + 10] = pen.roll(r);
		tables[o + 11] = pen.vfov(v);
		// EVAL2: the same f64 values as double-f32 (../precision split: |hi + lo − v| ≤ 2^-48·|v|)
		const v64 = [
			Math.sin(y * D),
			Math.cos(y * D),
			Math.sin(p * D),
			Math.cos(p * D),
			Math.sin(r * D),
			Math.cos(r * D),
			Math.tan((v * D) / 2),
			v,
			pen.yaw(y),
			pen.pitch(p),
			pen.roll(r),
			pen.vfov(v),
		];
		const o2 = (lane * n + i) * TABLE2_ENTRY;
		for (let k = 0; k < TABLE_ENTRY; k++) {
			const [hi, lo] = split(v64[k]);
			tables2[o2 + 2 * k] = hi;
			tables2[o2 + 2 * k + 1] = lo;
		}
	}
}

/**
 * Bound constants for the difference between a lattice angle (start + c · unit, what the tables
 * hold) and the f64 loop's angle for the same lattice point (start plus up to 960 steps, each sum
 * rounded): per axis k, with M_k the largest magnitude the angle can reach (|start| + 2 passes × 60
 * steps of step0 + 1),
 *   ε_k ≤ 962 · 2⁻⁵³ · M_k ≤ 2⁻⁴³ · M_k                                   (degrees)
 *   |Δ sin|, |Δ cos| ≤ (ε_k + 2⁻⁵² M_k) · D + 2⁻⁵¹                        (incl. angle·D and two
 *                                                                          1-ULP Math.sin / cos)
 * ASSUMPTION (not checked): Math.sin / cos / tan are within 1 ULP of the true function (V8's fdlibm
 * ports are; ECMAScript does not require it). It only matters when the two angles differ: equal
 * angles give equal bits whatever the libm. The per-call audit (certifiedRefine) re-scores sampled
 * intervals exactly, which would catch a libm far outside this.
 *   basis components (≤ 3 such factors, plus both f64 evaluations' roundings): dB ≤ 4 · max Δ + 2⁻⁴⁸
 *   tan(vfov/2), relative (t kept in [T_MIN, T_MAX] by the kernels): relT ≤ (ε_v + 2⁻⁵² M_v)·D/2 ·
 *     (1/T_MIN + T_MAX)·1.01 + 2⁻⁵⁰;  vfov in the coverage, relative: relV ≤ ε_v / 0.5° + 2⁻⁵⁰
 *   penalty: Σ_k |∂term_k| · ε_k + 2⁻⁵⁰ · pen_max  (∂ of coef·((a − p)/s)² ≤ 2·coef·(M_k + |p_k|)/s²)
 * Returned as f32 rounded up (the kernels add them to their bounds).
 */
export function latticeSlack(starts: Pose[], prior: Pose, vfov0: number) {
	const s0 = descentSteps(vfov0);
	const scale = {
		yaw: [0.04, 20],
		pitch: [0.08, 2.5],
		roll: [0.08, 4],
		vfov: [0.1, prior.vfov * 0.08],
	} as const;
	let dB = 0;
	let relT = 0;
	let relV = 0;
	let pen = 0;
	for (const st of starts) {
		let penD = 0;
		let penMax = 0;
		for (const k of DESCENT_KEYS) {
			const M = Math.abs(st[k]) + 120 * s0[k] + 1;
			const eps = 2 ** -43 * M;
			const dTrig = (eps + 2 ** -52 * M) * D + 2 ** -51;
			if (k !== "vfov") dB = Math.max(dB, 4 * dTrig + 2 ** -48);
			else {
				relT = Math.max(
					relT,
					(((eps + 2 ** -52 * M) * D) / 2) * (1 / T_MIN + T_MAX) * 1.01 +
						2 ** -50,
				);
				relV = Math.max(relV, eps / 0.5 + 2 ** -50);
			}
			const [coef, sc] = scale[k];
			const a = M + Math.abs(prior[k]);
			penD += ((2 * coef * a) / sc ** 2) * eps;
			penMax += coef * (a / sc) ** 2;
		}
		pen = Math.max(pen, penD + 2 ** -50 * penMax);
	}
	return {
		dB: f32Up(dB),
		relT: f32Up(relT),
		relV: f32Up(relV),
		pen: f32Up(pen),
	};
}

/** The kernels treat a pose whose f32 tan(vfov/2) leaves [T_MIN, T_MAX] as unbounded (CPU). */
export const T_MIN = Math.fround(Math.tan((0.25 * Math.PI) / 180));
export const T_MAX = Math.fround(Math.tan((85 * Math.PI) / 180));

/**
 * Preconditions of the bound (cert.wgsl.ts): angles small enough that the lattice-vs-sequential-sum
 * difference stays far inside the absolute slack, a sane vfov, finite inputs.
 */
export function certifiable(starts: Pose[], prior: Pose, aspect: number) {
	const ok = (p: Pose) =>
		DESCENT_KEYS.every((k) => Number.isFinite(p[k]) && Math.abs(p[k]) < 1e4) &&
		p.vfov > 1 &&
		p.vfov < 170;
	return (
		starts.length > 0 &&
		starts.length <= MAX_LANES &&
		Number.isFinite(aspect) &&
		aspect > 0 &&
		ok(prior) &&
		starts.every(ok)
	);
}

export function newCertBuffers(nLanes: number): CertBuffers {
	const state = new ArrayBuffer(nLanes * LANE_WORDS * 4);
	return {
		nLanes,
		state,
		u32: new Uint32Array(state),
		i32: new Int32Array(state),
		f32: new Float32Array(state),
		log: new Uint32Array(nLanes * LOG_CAP),
		tables: new Float32Array(nLanes * (2 * WINDOW + 1) * TABLE_ENTRY),
		tables2: new Float32Array(nLanes * (2 * WINDOW + 1) * TABLE2_ENTRY),
		audit: new Uint32Array(nLanes * AUDIT_CAP * AUDIT_WORDS),
		tablesDirty: true,
		logDirty: true,
	};
}

export type CertStats = {
	/** comparisons the f32 tier left open that the double-f32 tier (EVAL2) decided, EVAL2 jobs */
	tier2Decided: number;
	tier2Evals: number;
	/** runner calls (GPU submits) and rounds encoded */
	submits: number;
	rounds: number;
	/** decisions: certified on the GPU (accept / reject), decided by the CPU (tie path) */
	certAccepts: number;
	certRejects: number;
	ties: number;
	/** tie-path halts by reason */
	unbounded: number;
	starts: number;
	windows: number;
	/** neighbour / start intervals the GPU evaluated (incl. speculative ones made stale by a move) */
	evals: number;
	/** exact CPU scorePose calls: tie path, final scores, verification */
	cpuEvals: number;
	/** certified decisions re-checked on the CPU (the runtime guard) */
	verified: number;
	/** intervals re-scored exactly by the per-call audit (containment checked) */
	audited: number;
	/** GPU decisions always re-decided exactly: EVAL2 accepts and near-margin decisions */
	forced: number;
	/** ms awaiting the runner */
	runMs: number;
	/** ms in exact f64 scores (ctx.f), and the part of it spent while a submit was in flight */
	exactMs: number;
	overlapMs: number;
	/** forced decisions whose exact scores were computed while the next submit ran (prewarm) */
	prewarmed: number;
};

export const newCertStats = (): CertStats => ({
	tier2Decided: 0,
	tier2Evals: 0,
	submits: 0,
	rounds: 0,
	certAccepts: 0,
	certRejects: 0,
	ties: 0,
	unbounded: 0,
	starts: 0,
	windows: 0,
	evals: 0,
	cpuEvals: 0,
	verified: 0,
	audited: 0,
	forced: 0,
	runMs: 0,
	exactMs: 0,
	overlapMs: 0,
	prewarmed: 0,
});

/** Decides which certified decisions to re-check on the CPU (true: re-check). */
export type CertVerifier = { check: () => boolean };

export type CertRefineOptions = {
	runner: CertRunner;
	/** rounds per runner call (one submit) */
	rounds?: number;
	stats?: CertStats;
	verify?: CertVerifier;
	/** safety cap on runner calls */
	maxSubmits?: number;
	/**
	 * Per-call audit: this many random EVAL intervals and half as many EVAL2 intervals of the call are
	 * re-scored exactly on the CPU (at their lattice pose, which the bound covers) and must contain
	 * the f64 value, or the call throws RefineBoundViolation (the f64 path then runs). Default 8.
	 */
	audit?: number;
	/** random source of the audit's sample (tests) */
	random?: () => number;
	/**
	 * Comparisons the CPU may decide (ties, unbounded scores, start poses) before the call gives up
	 * and the caller runs the f64 path (CertAbort). Default 32.
	 */
	maxCpuDecisions?: number;
	/**
	 * A GPU decision is "near-margin" (always re-decided on exact scores) when its margin is under
	 * this fraction of the wider of its two intervals. The bounds carry ≥ 3× slack (cert.wgsl.ts), so
	 * a decision with a larger margin does not lean on the slack. Default 0.25.
	 */
	nearFraction?: number;
	/**
	 * Compute the exact scores of the forced re-decisions found so far while the next submit runs
	 * (default true). It only fills the exact-score memo that the final re-decision reads, so the
	 * result and every check are the same with it off; it hides CPU time behind GPU time.
	 */
	overlap?: boolean;
};

/**
 * Resolve after the pending microtasks (a runner's lease and submit) and one macrotask turn: a
 * MessageChannel message, which browsers do not clamp the way they clamp nested setTimeout(0).
 */
function yieldToRunner(): Promise<void> {
	if (typeof MessageChannel === "undefined")
		return new Promise((r) => setTimeout(r, 0));
	return new Promise((r) => {
		const ch = new MessageChannel();
		ch.port1.onmessage = () => {
			ch.port1.close();
			r();
		};
		ch.port2.postMessage(0);
	});
}

/** Thrown when the GPU's trace is not a valid Descent trace (a GPU error, not a precision issue). */
export class CertTraceError extends Error {}
/** Thrown when the CPU would decide more than maxCpuDecisions comparisons (the f64 path is cheaper). */
export class CertAbort extends Error {}

/** Float64 replay of a lane's move log (Descent's own expressions). */
class Replay {
	pose: Pose;
	private applied = 0;
	private readonly s0: Steps;
	constructor(
		readonly start: Pose,
		vfov0: number,
	) {
		this.pose = start;
		this.s0 = descentSteps(vfov0);
	}
	steps(level: number) {
		let s = this.s0;
		for (let i = 0; i < level; i++) s = halve(s);
		return s;
	}
	/** apply log entries [applied, n) */
	advance(log: Uint32Array, base: number, n: number) {
		for (; this.applied < n; this.applied++) {
			const e = log[base + this.applied];
			this.pose = neighbour(this.pose, e & 7, this.steps((e >> 3) & 7));
		}
	}
}

/**
 * Every decision of the lane's trace, in the CPU loop's order: replays both passes from `start` with
 * the logged moves (an entry (fine, iter, j) = neighbour j of that iteration was accepted) and checks
 * the trace is one Descent could produce (each entry consumed in order, at its logged level).
 * visit(fine, iter, j, best, nb, accepted) for every neighbour, start(fine, pose) for each pass start.
 * Returns the final pose.
 */
export function replayTrace(
	start: Pose,
	vfov0: number,
	log: Uint32Array,
	base: number,
	n: number,
	visit?: (
		fine: number,
		iter: number,
		j: number,
		best: Pose,
		nb: Pose,
		accepted: boolean,
	) => void,
	passStart?: (fine: number, pose: Pose) => void,
): Pose {
	let k = 0;
	let best = start;
	for (let fine = 0; fine < 2; fine++) {
		passStart?.(fine, best);
		let steps = descentSteps(vfov0);
		let level = 0;
		for (let iter = 0; ; ) {
			let improved = false;
			for (let j = 0; j < 8; j++) {
				const nb = neighbour(best, j, steps);
				const e = k < n ? log[base + k] : -1;
				const hit =
					e >= 0 &&
					(e & 7) === j &&
					((e >> 6) & 1) === fine &&
					entryIter(e) === iter;
				if (hit && ((e >> 3) & 7) !== level)
					throw new CertTraceError(
						`trace: move at level ${(e >> 3) & 7}, loop at ${level}`,
					);
				visit?.(fine, iter, j, best, nb, hit);
				if (hit) {
					k++;
					best = nb;
					improved = true;
				}
			}
			let done = false;
			if (!improved) {
				steps = halve(steps);
				level++;
				if (steps.yaw < 0.01) done = true;
			}
			if (++iter >= 60) done = true;
			if (done) break;
		}
	}
	if (k !== n) throw new CertTraceError(`trace: ${n - k} moves left over`);
	return best;
}

/**
 * The certified-f32 refine of every hypothesis (coarse pass then fine pass, as autoAlign's refine):
 * per hypothesis exactly autoAlign's { pose, score } (see the header). Throws CertTraceError on a GPU
 * error and RefineBoundViolation when a re-checked certified decision disagrees with the exact f64
 * decision (the device broke the bound's premise); the caller then runs the f64 refine.
 */
export async function certifiedRefine(
	starts: Pose[],
	ctx: AlignCtx,
	opts: CertRefineOptions,
): Promise<{ pose: Pose; score: number }[]> {
	const { prior } = ctx;
	const vfov0 = prior.vfov;
	const st = opts.stats ?? newCertStats();
	// the audit ring must hold a whole submit
	const rounds = Math.min(opts.rounds ?? 48, MAX_ROUNDS);
	const maxCpu = opts.maxCpuDecisions ?? 32;
	const nearFrac = opts.nearFraction ?? 0.25;
	const maxSubmits = opts.maxSubmits ?? 400;
	const nLanes = starts.length;
	const b = newCertBuffers(nLanes);
	const lats = starts.map((s) => laneLattice(s, vfov0));
	const replays = starts.map((s) => new Replay(s, vfov0));
	// exact f64 scores the CPU knows, by probeKey (cur after a CPU decision, the tie path's scores)
	const exact = new Map<string, number>();
	const f = (p: Pose, fine: boolean) => {
		const k = probeKey(p, fine);
		let v = exact.get(k);
		if (v === undefined) {
			const t = performance.now();
			v = ctx.f(p, fine);
			st.exactMs += performance.now() - t;
			st.cpuEvals++;
			exact.set(k, v);
		}
		return v;
	};
	// decisions the CPU made (lane:fine:iter:j), excluded from verification
	const cpuDecided = new Set<string>();
	for (let l = 0; l < nLanes; l++) {
		const o = l * LANE_WORDS;
		b.u32[o + L.status] = STATUS.running;
		b.u32[o + L.needStart] = 1;
		fillLaneTable(b, l, lats[l], [0, 0, 0, 0], prior);
	}
	const slack = latticeSlack(starts, prior, vfov0);
	// the per-call audit: reservoir samples over every interval the call produced, and the GPU
	// decisions to re-decide exactly whatever the sample (EVAL2 accepts, near-margin decisions)
	const nAudit = opts.audit ?? 8;
	const random = opts.random ?? Math.random;
	type Entry = {
		lane: number;
		c: number[];
		fine: boolean;
		lo: number;
		hi: number;
	};
	const samples: Entry[][] = [[], []];
	const seen = [0, 0];
	const caps = [nAudit, Math.ceil(nAudit / 2)];
	const auditSeen = new Array<number>(nLanes).fill(0);
	const auditF = new Float32Array(b.audit.buffer);
	const auditI = new Int32Array(b.audit.buffer);
	const forced = new Set<string>();
	// forced decisions whose exact scores are not computed yet (prewarm's queue), by lane
	const forcedQueue: string[] = [];
	const collectAudit = () => {
		for (let l = 0; l < nLanes; l++) {
			const n = b.u32[l * LANE_WORDS + L.auditN];
			if (n - auditSeen[l] > AUDIT_CAP)
				throw new CertTraceError("certified refine: audit ring overrun");
			for (let k = auditSeen[l]; k < n; k++) {
				const o = (l * AUDIT_CAP + (k % AUDIT_CAP)) * AUDIT_WORDS;
				if (b.audit[o + 7] !== k)
					throw new CertTraceError("certified refine: audit entry missing");
				const flags = b.audit[o + 6];
				const tier = (flags >> 4) & 15;
				const slot = (flags >> 8) & 15;
				const decision = (flags >> 12) & 15;
				const fine = flags & 15;
				const lo = auditF[o];
				const hi = auditF[o + 1];
				if (decision === 1 || decision === 2) {
					// the margin the certificate rests on, against the widths of the two intervals
					const cLo = auditF[o + 8];
					const cHi = auditF[o + 9];
					const margin = decision === 1 ? lo - cHi : cLo - hi;
					const near = margin < nearFrac * Math.max(hi - lo, cHi - cLo);
					const key = `${l}:${fine}:${(flags >>> 16) & 63}:${slot}`;
					if ((near || (tier === 2 && decision === 1)) && !forced.has(key)) {
						forced.add(key);
						forcedQueue.push(key);
					}
				}
				const t = tier === 2 ? 1 : 0;
				const e: Entry = {
					lane: l,
					c: [auditI[o + 2], auditI[o + 3], auditI[o + 4], auditI[o + 5]],
					fine: fine === 1,
					lo,
					hi,
				};
				seen[t]++;
				if (samples[t].length < caps[t]) samples[t].push(e);
				else {
					const r = Math.floor(random() * seen[t]);
					if (r < caps[t]) samples[t][r] = e;
				}
			}
			auditSeen[l] = n;
		}
	};
	/**
	 * While a submit runs: the exact scores (neighbour and current best, at the f64 replay's poses) of
	 * the forced decisions collected so far. Each lane's move log up to now is a prefix of its final
	 * log, and a decision already made sees the same poses in a replay of any longer prefix (replayTrace
	 * is deterministic in the log), so these are the very f() calls the final re-decision makes; it
	 * finds them memoized. Nothing is decided here: an error is left to the final replay.
	 */
	const overlap = opts.overlap ?? true;
	const prewarm = (log: Uint32Array, nLog: number[]) => {
		const evals0 = st.exactMs;
		const byLane = new Map<number, Set<string>>();
		for (const key of forcedQueue) {
			const l = Number(key.slice(0, key.indexOf(":")));
			const set = byLane.get(l) ?? new Set<string>();
			byLane.set(l, set);
			set.add(key);
		}
		forcedQueue.length = 0;
		for (const [l, keys] of byLane)
			try {
				replayTrace(
					starts[l],
					vfov0,
					log,
					l * LOG_CAP,
					nLog[l],
					(fine, iter, j, best, nb) => {
						if (!keys.has(`${l}:${fine}:${iter}:${j}`)) return;
						f(nb, fine === 1);
						f(best, fine === 1);
						st.prewarmed++;
					},
				);
			} catch {
				// the final replay reports a malformed trace
			}
		st.overlapMs += st.exactMs - evals0;
	};
	for (let submit = 0; ; submit++) {
		let running = 0;
		for (let l = 0; l < nLanes; l++)
			if (b.u32[l * LANE_WORDS + L.status] === STATUS.running) running++;
		if (!running) break;
		if (submit >= maxSubmits)
			throw new CertTraceError(
				`certified refine: no end after ${maxSubmits} submits`,
			);
		// every submit starts plan-only (the last round's plan has no results); a lane that was
		// waiting for EVAL2 results plans its EVAL2 jobs again
		for (let l = 0; l < nLanes; l++) {
			b.u32[l * LANE_WORDS + L.planCount] = 0;
			b.u32[l * LANE_WORDS + L.plan2Count] = 0;
		}
		const t0 = performance.now();
		if (overlap && forcedQueue.length) {
			// the log as of this submit's start (the runner replaces b.log when it returns)
			const nLog = Array.from(
				{ length: nLanes },
				(_, l) => b.u32[l * LANE_WORDS + L.nLog],
			);
			const log = b.log.slice();
			const pending = opts.runner.run(b, rounds, slack);
			// a runner that rejects while the CPU works is awaited below; mark it handled so the page
			// does not report an unhandledrejection (harnesses treat page errors as failures)
			pending.catch(() => {});
			// let the runner reach its submit before the CPU work (a GPU runner awaits only its readback)
			await yieldToRunner();
			prewarm(log, nLog);
			await pending;
		} else await opts.runner.run(b, rounds, slack);
		st.runMs += performance.now() - t0;
		st.submits++;
		st.rounds += rounds;
		b.tablesDirty = false;
		b.logDirty = false;
		collectAudit();
		for (let l = 0; l < nLanes; l++) {
			const o = l * LANE_WORDS;
			if (b.u32[o + L.status] !== STATUS.halted) continue;
			const reason = b.u32[o + L.reason];
			const fine = b.u32[o + L.fine] === 1;
			const rp = replays[l];
			rp.advance(b.log, l * LOG_CAP, b.u32[o + L.nLog]);
			if (
				(reason === REASON.start ||
					reason === REASON.tie ||
					reason === REASON.unbounded) &&
				st.starts + st.ties + st.unbounded >= maxCpu
			)
				throw new CertAbort(
					`certified refine: more than ${maxCpu} comparisons left to the CPU`,
				);
			if (reason === REASON.start) {
				const cur = f(rp.pose, fine);
				b.f32[o + L.curLo] = f32Down(cur);
				b.f32[o + L.curHi] = f32Up(cur);
				b.u32[o + L.curTight] = 1;
				b.u32[o + L.needStart] = 0;
				st.starts++;
			} else if (reason === REASON.tie || reason === REASON.unbounded) {
				const j = b.u32[o + L.j];
				const level = b.u32[o + L.level];
				const iter = b.u32[o + L.iter];
				const nb = neighbour(rp.pose, j, rp.steps(level));
				const s = f(nb, fine);
				const cur = f(rp.pose, fine);
				cpuDecided.add(`${l}:${+fine}:${iter}:${j}`);
				(globalThis as { __certTie?: (x: object) => void }).__certTie?.({
					reason,
					fine,
					level,
					d: s - cur,
					nbW: b.f32[o + L.haltHi] - b.f32[o + L.haltLo],
					curW: b.f32[o + L.curHi] - b.f32[o + L.curLo],
					s,
					cur,
				});
				if (reason === REASON.tie) st.ties++;
				else st.unbounded++;
				if (s > cur) {
					const n = b.u32[o + L.nLog];
					if (n >= LOG_CAP)
						throw new CertTraceError("certified refine: log full");
					b.log[l * LOG_CAP + n] = logEntry(j, level, +fine, iter, 2);
					b.u32[o + L.nLog] = n + 1;
					b.logDirty = true;
					const k = j >> 1;
					b.i32[o + L.c + k] += (j & 1 ? -1 : 1) * (UNIT_DIV >> level);
					b.f32[o + L.curLo] = f32Down(s);
					b.f32[o + L.curHi] = f32Up(s);
					b.u32[o + L.improved] = 1;
					rp.advance(b.log, l * LOG_CAP, n + 1);
				} else {
					// keep cur's interval; tighten it to the exact value now that the CPU has it
					b.f32[o + L.curLo] = f32Down(cur);
					b.f32[o + L.curHi] = f32Up(cur);
				}
				b.u32[o + L.curTight] = 1;
				b.u32[o + L.j] = j + 1;
			} else if (reason === REASON.window) {
				for (let k = 0; k < 4; k++) b.i32[o + L.c0 + k] = b.i32[o + L.c + k];
				fillLaneTable(
					b,
					l,
					lats[l],
					[0, 1, 2, 3].map((k) => b.i32[o + L.c0 + k]),
					prior,
				);
				b.tablesDirty = true;
				st.windows++;
			} else if (reason === REASON.inconsistent) {
				// two certified intervals of one pose are disjoint: the device broke the bound
				throw new RefineBoundViolation(
					b.f32[o + L.haltLo],
					b.f32[o + L.haltHi],
				);
			} else
				throw new CertTraceError(
					`certified refine: lane ${l} halted (reason ${reason})`,
				);
			b.u32[o + L.status] = STATUS.running;
			b.u32[o + L.reason] = REASON.none;
			b.u32[o + L.tier2] = 0;
		}
	}
	// the per-call audit: every sampled interval must contain the exact f64 f at its lattice pose
	for (const e of [...samples[0], ...samples[1]]) {
		const lat = lats[e.lane];
		const pose: Pose = {
			yaw: latticeAngle(lat, "yaw", e.c[0]),
			pitch: latticeAngle(lat, "pitch", e.c[1]),
			roll: latticeAngle(lat, "roll", e.c[2]),
			vfov: latticeAngle(lat, "vfov", e.c[3]),
		};
		const t = performance.now();
		const v = ctx.f(pose, e.fine);
		st.exactMs += performance.now() - t;
		st.cpuEvals++;
		st.audited++;
		if (!(e.lo <= v && v <= e.hi)) throw new RefineBoundViolation(v, e.hi);
	}
	// replay, check and score every lane
	const out: { pose: Pose; score: number }[] = [];
	for (let l = 0; l < nLanes; l++) {
		const o = l * LANE_WORDS;
		if (b.u32[o + L.status] !== STATUS.done)
			throw new CertTraceError(`certified refine: lane ${l} not done`);
		st.certAccepts += b.u32[o + L.certAcc];
		st.certRejects += b.u32[o + L.certRej];
		st.evals += b.u32[o + L.evals];
		st.tier2Evals += b.u32[o + L.evals2];
		st.tier2Decided += b.u32[o + L.cert2];
		const counts = [0, 0, 0, 0];
		const end = replayTrace(
			starts[l],
			vfov0,
			b.log,
			l * LOG_CAP,
			b.u32[o + L.nLog],
			(fine, iter, j, best, nb, accepted) => {
				if (accepted)
					for (let k = 0; k < 4; k++)
						counts[k] += Math.round(
							(nb[DESCENT_KEYS[k]] - best[DESCENT_KEYS[k]]) /
								lats[l].unit[DESCENT_KEYS[k]],
						);
				// the runtime guard: re-decide on exact f64 scores every forced GPU decision (EVAL2
				// accepts, near-margin decisions) and a sample of the others
				const key = `${l}:${fine}:${iter}:${j}`;
				if (cpuDecided.has(key)) return;
				const must = forced.has(key);
				if (!must && !opts.verify?.check()) return;
				const s = f(nb, fine === 1);
				const cur = f(best, fine === 1);
				if (must) st.forced++;
				else st.verified++;
				if (s > cur !== accepted) throw new RefineBoundViolation(s, cur);
			},
		);
		// the lattice counts the GPU holds must be the replayed moves'
		for (let k = 0; k < 4; k++)
			if (counts[k] !== b.i32[o + L.c + k])
				throw new CertTraceError(
					`certified refine: lane ${l} lattice mismatch`,
				);
		out.push({ pose: end, score: f(end, true) });
	}
	return out;
}
