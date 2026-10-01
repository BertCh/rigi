// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// CPU emulation of the certified-f32 refine's round loop: DECIDE, EVAL (f32, Math.fround per
// operation) and EVAL2 (double-f32 on ../precision/df32.ts, the TypeScript twin of DF32_WGSL) of
// ./cert.wgsl.ts, operation for operation, including the 256-invocation striping and the tree
// reductions, on the same CertBuffers as the GPU runner (./cert-gpu.ts). It is a CertRunner, so the
// node check (./cert.check.ts) drives it with the production host loop (./cert-refine.ts
// certifiedRefine) and compares the result with autoAlign's float64 refine.
//
// The emulation is one IEEE f32 machine (correctly rounded ÷ unless df32's setDivSqrtPerturbation is
// on, no implicit FMA contraction); it exercises the bound and the decision logic on real inputs, not
// a particular GPU's bits.
import type { EdgeMap } from "#/lib/align";
import {
	type DD,
	ddAdd,
	ddAddF,
	ddDiv,
	ddMul,
	ddMulF,
	div32,
	flushSubnormals,
	fr,
	ftz32,
	nextUp32,
	split,
	twoSum,
} from "#/lib/gpu/precision/df32";
import {
	ADD2,
	BASIS2,
	DOT2,
	ED_K,
	END2,
	e2Coef,
	eCoef,
	G_REL,
	G2,
	PEN_REL,
	PEN2,
	PIX2,
	Q_REL,
	REL2,
} from "./cert.wgsl";
import {
	AUDIT_CAP,
	AUDIT_WORDS,
	type CertBuffers,
	type CertRunner,
	JOB_WORDS,
	L,
	LANE_WORDS,
	type LatticeSlack,
	LOG_CAP,
	MAX_JOBS,
	REASON,
	RES_UNBOUNDED,
	STATUS,
	T_MAX,
	T_MIN,
	TABLE_ENTRY,
	TABLE2_ENTRY,
	UNIT_DIV,
	WINDOW,
} from "./cert-refine";

// one f32 rounding of the emulated machine (df32's live `fr`: flushes subnormal results in the
// flush-to-zero stress mode, setFlushSubnormals)
const F = (x: number) => fr(x);
const MIN_NORMAL = 2 ** -126;
const clampDown = (x: number) => (Math.abs(x) < MIN_NORMAL ? -MIN_NORMAL : x);
const clampUp = (x: number) => (Math.abs(x) < MIN_NORMAL ? MIN_NORMAL : x);
/** a load of the emulated machine: subnormals flushed in flush-to-zero mode */
const ld = (a: Float32Array) => (flushSubnormals() ? a.map(ftz32) : a);
const U32 = F(1.1920929e-7);
const WG = 256;
const J2 = MAX_JOBS;

type Params = {
	w: number;
	h: number;
	nDirs: number;
	band: number;
	gapCoarse: number;
	gapFine: number;
	aspect: number;
	asp: DD;
	eCoef: number;
	e2Coef: number;
	total: number;
	slack: LatticeSlack;
};

type Dirs = {
	dx: Float32Array;
	dy: Float32Array;
	dz: Float32Array;
	d1: Float32Array;
};

/** Test knobs of the emulated runner. */
export type EmulateOptions = {
	/** shift every neighbour interval of both tiers down by this much: a device breaking the bound */
	fault?: number;
	/**
	 * Force a path: "tier2" = every EVAL result comes back without an interval (EVAL2 decides all),
	 * "cpu" = EVAL and EVAL2 both (the CPU decides every comparison and every pass start).
	 */
	force?: "tier2" | "cpu";
};

/** A CertRunner that runs the rounds in emulation on the CPU. */
export function emulatedRunner(
	aspect: number,
	dirs: Float32Array,
	edge0: EdgeMap,
	opts: EmulateOptions = {},
): CertRunner {
	const fault = opts.fault ?? 0;
	let edge = edge0;
	const { w, h } = edge0;
	const nDirs = Math.floor(dirs.length / 3);
	let d: Dirs = {
		dx: new Float32Array(nDirs),
		dy: new Float32Array(nDirs),
		dz: new Float32Array(nDirs),
		d1: new Float32Array(nDirs),
	};
	for (let i = 0; i < nDirs; i++) {
		d.dx[i] = dirs[i * 3];
		d.dy[i] = dirs[i * 3 + 1];
		d.dz[i] = dirs[i * 3 + 2];
		d.d1[i] = F(F(Math.abs(d.dx[i]) + Math.abs(d.dy[i])) + Math.abs(d.dz[i]));
	}
	const jobs = new Uint32Array(2 * MAX_JOBS * JOB_WORDS);
	const jobsI = new Int32Array(jobs.buffer);
	const res = new Uint32Array(2 * MAX_JOBS * 4);
	const resF = new Float32Array(res.buffer);
	let nonce = 0;
	const d0 = d;
	let tables: Float32Array = new Float32Array(0);
	let tables2: Float32Array = new Float32Array(0);
	const evalJob = (p: Params, q: number, tier2: boolean) => {
		const o = q * JOB_WORDS;
		const lane = jobs[o];
		const isFine = jobs[o + 2] === 1;
		const W2 = 2 * WINDOW;
		const base = lane * (W2 + 1);
		const at = (k: number) =>
			base + Math.min(Math.max(jobsI[o + 4 + k], 0), W2);
		const r = tier2
			? scoreInterval2(p, edge, d, isFine, tables2, at(0), at(1), at(2), at(3))
			: scoreInterval(p, edge, d, isFine, tables, at(0), at(1), at(2), at(3));
		const shift = fault && jobs[o + 1] < 8 ? fault : 0;
		resF[q * 4] = clampDown(r.lo - shift);
		resF[q * 4 + 1] = clampUp(r.hi - shift);
		const forced =
			opts.force === "cpu" || (opts.force === "tier2" && !tier2)
				? RES_UNBOUNDED
				: 0;
		res[q * 4 + 2] = r.flags | forced;
		res[q * 4 + 3] = jobs[o + 3];
	};
	return {
		run: async (b, rounds, slack) => {
			nonce = (nonce + 1) >>> 0;
			// the machine's loads (flushed in flush-to-zero mode)
			tables = ld(b.tables);
			tables2 = ld(b.tables2);
			edge = flushSubnormals()
				? {
						...edge0,
						coarse: ld(edge0.coarse),
						fine: ld(edge0.fine),
						fg: ld(edge0.fg),
						skyCum: ld(edge0.skyCum),
					}
				: edge0;
			d = flushSubnormals()
				? { dx: ld(d0.dx), dy: ld(d0.dy), dz: ld(d0.dz), d1: d0.d1 }
				: d0;
			const p: Params = {
				w,
				h,
				nDirs,
				band: Math.max(2, Math.round(h * 0.035)),
				gapCoarse: Math.max(1, Math.round(h * 0.012)),
				gapFine: Math.max(1, Math.round(h * 0.006)),
				aspect: F(aspect),
				asp: split(aspect),
				eCoef: eCoef(nDirs),
				e2Coef: e2Coef(nDirs),
				total: F(nDirs),
				slack,
			};
			// DECIDE_0, then (EVAL_r, EVAL2_r, DECIDE_{r+1}) for r < rounds, as the graph encodes them
			let [n, n2] = decide(b, jobs, jobsI, res, resF, nonce);
			for (let r = 0; r < rounds; r++) {
				for (let q = 0; q < n; q++) evalJob(p, q, false);
				for (let q = 0; q < n2; q++) evalJob(p, J2 + q, true);
				[n, n2] = decide(b, jobs, jobsI, res, resF, nonce);
			}
		},
	};
}

/** DECIDE (cert.wgsl.ts CERT_DECIDE_WGSL); returns the job counts it planned (the indirect x's). */
function decide(
	b: CertBuffers,
	jobs: Uint32Array,
	jobsI: Int32Array,
	res: Uint32Array,
	resF: Float32Array,
	nonce: number,
): [number, number] {
	const { u32, i32, f32 } = b;
	const auditF = new Float32Array(b.audit.buffer);
	const auditI = new Int32Array(b.audit.buffer);
	const halt = (o: number, reason: number) => {
		u32[o + L.status] = STATUS.halted;
		u32[o + L.reason] = reason;
		u32[o + L.planCount] = 0;
		u32[o + L.plan2Count] = 0;
		u32[o + L.tier2] = 0;
	};
	const cOf = (o: number, jo: number) =>
		[0, 1, 2, 3].map(
			(k) => (jobsI[jo + 4 + k] - WINDOW + i32[o + L.c0 + k]) | 0,
		);
	const logAudit = (
		l: number,
		o: number,
		jo: number,
		lo: number,
		hi: number,
		tier: number,
		decision: number,
	) => {
		const n = u32[o + L.auditN];
		const a = (l * AUDIT_CAP + (n % AUDIT_CAP)) * AUDIT_WORDS;
		auditF[a] = lo;
		auditF[a + 1] = hi;
		const c = cOf(o, jo);
		for (let k = 0; k < 4; k++) auditI[a + 2 + k] = c[k];
		b.audit[a + 6] =
			(jobs[jo + 2] |
				(tier << 4) |
				(jobs[jo + 1] << 8) |
				(decision << 12) |
				(u32[o + L.iter] << 16)) >>>
			0;
		b.audit[a + 7] = n;
		auditF[a + 8] = f32[o + L.curLo];
		auditF[a + 9] = f32[o + L.curHi];
		u32[o + L.auditN] = n + 1;
	};
	const accept = (
		l: number,
		o: number,
		jo: number,
		lo: number,
		hi: number,
		tight: number,
	) => {
		const nLog = u32[o + L.nLog];
		if (nLog >= LOG_CAP) {
			halt(o, REASON.logFull);
			return;
		}
		b.log[l * LOG_CAP + nLog] =
			(u32[o + L.j] |
				(u32[o + L.level] << 3) |
				(u32[o + L.fine] << 6) |
				(u32[o + L.iter] << 7) |
				(tight << 13)) >>>
			0;
		u32[o + L.nLog] = nLog + 1;
		const c = cOf(o, jo);
		for (let k = 0; k < 4; k++) i32[o + L.c + k] = c[k];
		f32[o + L.curLo] = lo;
		f32[o + L.curHi] = hi;
		u32[o + L.curTight] = tight;
		u32[o + L.improved] = 1;
		u32[o + L.certAcc]++;
		u32[o + L.j]++;
	};
	const consumeTier2 = (l: number, o: number) => {
		const first = J2 + u32[o + L.plan2First];
		const count = u32[o + L.plan2Count];
		u32[o + L.plan2Count] = 0;
		u32[o + L.tier2] = 0;
		for (let q = 0; q < count; q++) {
			const jo = (first + q) * JOB_WORDS;
			const ro = (first + q) * 4;
			if (res[ro + 3] !== jobs[jo + 3]) return halt(o, REASON.stale);
			const lo = resF[ro];
			const hi = resF[ro + 1];
			const unb = (res[ro + 2] & RES_UNBOUNDED) !== 0;
			const slot = jobs[jo + 1];
			if (!unb && (slot === 8 || slot === 9)) logAudit(l, o, jo, lo, hi, 2, 0);
			if (slot === 8) {
				if (unb) return halt(o, REASON.start);
				f32[o + L.curLo] = lo;
				f32[o + L.curHi] = hi;
				u32[o + L.curTight] = 1;
				u32[o + L.needStart] = 0;
				return;
			}
			if (slot === 9) {
				if (!unb) {
					const nl = Math.max(f32[o + L.curLo], lo);
					const nh = Math.min(f32[o + L.curHi], hi);
					if (nl > nh) {
						f32[o + L.haltLo] = lo;
						f32[o + L.haltHi] = hi;
						return halt(o, REASON.inconsistent);
					}
					f32[o + L.curLo] = nl;
					f32[o + L.curHi] = nh;
					u32[o + L.curTight] = 1;
				}
				continue;
			}
			if (slot !== u32[o + L.j]) return halt(o, REASON.stale);
			f32[o + L.haltLo] = lo;
			f32[o + L.haltHi] = hi;
			if (unb) return halt(o, REASON.unbounded);
			if (lo > f32[o + L.curHi]) {
				logAudit(l, o, jo, lo, hi, 2, 1);
				u32[o + L.cert2]++;
				return accept(l, o, jo, lo, hi, 1);
			}
			if (hi <= f32[o + L.curLo]) {
				logAudit(l, o, jo, lo, hi, 2, 2);
				u32[o + L.cert2]++;
				u32[o + L.certRej]++;
				u32[o + L.j]++;
				return;
			}
			logAudit(l, o, jo, lo, hi, 2, 3);
			return halt(o, REASON.tie);
		}
	};
	const consumeLane = (l: number, o: number) => {
		const first = u32[o + L.planFirst];
		const count = u32[o + L.planCount];
		u32[o + L.planCount] = 0;
		if (u32[o + L.tier2] === 1) {
			if (u32[o + L.plan2Count] > 0) {
				u32[o + L.rounds]++;
				consumeTier2(l, o);
			}
			return;
		}
		if (count === 0) return;
		u32[o + L.rounds]++;
		if (u32[o + L.needStart] === 1) {
			const jo = first * JOB_WORDS;
			if (res[first * 4 + 3] !== jobs[jo + 3] || jobs[jo + 1] !== 8)
				return halt(o, REASON.stale);
			if (res[first * 4 + 2] & RES_UNBOUNDED) {
				u32[o + L.tier2] = 1;
				return;
			}
			logAudit(l, o, jo, resF[first * 4], resF[first * 4 + 1], 1, 0);
			f32[o + L.curLo] = resF[first * 4];
			f32[o + L.curHi] = resF[first * 4 + 1];
			u32[o + L.curTight] = 0;
			u32[o + L.needStart] = 0;
			return;
		}
		for (let q = 0; q < count; q++) {
			const jo = (first + q) * JOB_WORDS;
			const ro = (first + q) * 4;
			if (res[ro + 3] !== jobs[jo + 3] || jobs[jo + 1] !== u32[o + L.j])
				return halt(o, REASON.stale);
			const lo = resF[ro];
			const hi = resF[ro + 1];
			if ((res[ro + 2] & RES_UNBOUNDED) === 0) {
				if (lo > f32[o + L.curHi]) {
					logAudit(l, o, jo, lo, hi, 1, 1);
					return accept(l, o, jo, lo, hi, 0);
				}
				if (hi <= f32[o + L.curLo]) {
					logAudit(l, o, jo, lo, hi, 1, 2);
					u32[o + L.certRej]++;
					u32[o + L.j]++;
					continue;
				}
				logAudit(l, o, jo, lo, hi, 1, 3);
			}
			u32[o + L.tier2] = 1;
			return;
		}
	};
	for (let l = 0; l < b.nLanes; l++) {
		const o = l * LANE_WORDS;
		if (u32[o + L.status] === STATUS.running) consumeLane(l, o);
		if (
			u32[o + L.status] === STATUS.running &&
			u32[o + L.tier2] === 0 &&
			u32[o + L.j] >= 8
		) {
			let done = false;
			if (u32[o + L.improved] === 0) {
				u32[o + L.level]++;
				if (u32[o + L.level] >= 6) done = true;
			}
			u32[o + L.iter]++;
			if (u32[o + L.iter] >= 60) done = true;
			u32[o + L.j] = 0;
			u32[o + L.improved] = 0;
			if (done) {
				if (u32[o + L.fine] === 1) u32[o + L.status] = STATUS.done;
				else {
					u32[o + L.fine] = 1;
					u32[o + L.level] = 0;
					u32[o + L.iter] = 0;
					u32[o + L.needStart] = 1;
				}
			}
		}
	}
	let n = 0;
	let n2 = 0;
	for (let l = 0; l < b.nLanes; l++) {
		const o = l * LANE_WORDS;
		u32[o + L.planFirst] = n;
		u32[o + L.planCount] = 0;
		u32[o + L.plan2First] = n2;
		u32[o + L.plan2Count] = 0;
		if (u32[o + L.status] !== STATUS.running) continue;
		const push = (slot: number, c: number[], tier2: boolean) => {
			const jo = (tier2 ? J2 + n2 : n) * JOB_WORDS;
			jobs[jo] = l;
			jobs[jo + 1] = slot;
			jobs[jo + 2] = u32[o + L.fine];
			jobs[jo + 3] =
				(Math.imul(nonce, 2654435761) ^
					(l << 24) ^
					(u32[o + L.seq] & 0xffffff)) >>>
				0;
			for (let k = 0; k < 4; k++)
				jobsI[jo + 4 + k] = c[k] - i32[o + L.c0 + k] + WINDOW;
			u32[o + L.seq]++;
			if (tier2) {
				u32[o + L.evals2]++;
				u32[o + L.plan2Count]++;
				n2++;
			} else {
				u32[o + L.evals]++;
				u32[o + L.planCount]++;
				n++;
			}
		};
		const c = [0, 1, 2, 3].map((k) => i32[o + L.c + k]);
		const step = UNIT_DIV >> u32[o + L.level];
		const nbOf = (j: number) => {
			const v = c.slice();
			v[j >> 1] += j & 1 ? -step : step;
			return v;
		};
		if (u32[o + L.tier2] === 1) {
			if (u32[o + L.needStart] === 1) push(8, c, true);
			else {
				if (u32[o + L.curTight] === 0) push(9, c, true);
				push(u32[o + L.j], nbOf(u32[o + L.j]), true);
			}
			continue;
		}
		if (u32[o + L.needStart] === 1) {
			push(8, c, false);
			continue;
		}
		let out = false;
		for (let j = u32[o + L.j]; j < 8; j++) {
			const v = nbOf(j);
			for (let k = 0; k < 4; k++)
				if (Math.abs(v[k] - i32[o + L.c0 + k]) > WINDOW) out = true;
		}
		if (out) {
			halt(o, REASON.window);
			continue;
		}
		for (let j = u32[o + L.j]; j < 8; j++) push(j, nbOf(j), false);
	}
	return [n, n2];
}

const near = (x: number, thr: number, e: number) => Math.abs(F(x - thr)) <= e;
const g32 = (p: Params, S: number, m: number, vfov: number) => {
	const cov = Math.min(
		F(div32(div32(m, p.total), F(F(div32(F(vfov * p.aspect), 360)) * F(0.6)))),
		1,
	);
	return F(div32(S, m) * cov);
};

/** EVAL (cert.wgsl.ts CERT_EVAL_WGSL) for one pose, in f32. */
function scoreInterval(
	p: Params,
	edge: EdgeMap,
	d: Dirs,
	isFine: boolean,
	tab: Float32Array,
	iy: number,
	ip: number,
	ir: number,
	iv: number,
) {
	const TE = TABLE_ENTRY;
	const sy = tab[iy * TE];
	const cy = tab[iy * TE + 1];
	const sp = tab[ip * TE + 2];
	const cp = tab[ip * TE + 3];
	const sr = tab[ir * TE + 4];
	const cr = tab[ir * TE + 5];
	const t = tab[iv * TE + 6];
	const vfov = tab[iv * TE + 7];
	const pen = F(
		F(F(tab[iy * TE + 8] + tab[ip * TE + 9]) + tab[ir * TE + 10]) +
			tab[iv * TE + 11],
	);
	const { w, h, skyCum, coarse, fine, fg } = edge;
	// camera poseBasis in f32 (item 1)
	const f0 = F(sy * cp);
	const f1 = F(cy * cp);
	const f2 = sp;
	const r0x = cy;
	const r0y = -sy;
	const r0z = 0;
	const u0x = F(F(r0y * f2) - F(r0z * f1));
	const u0y = F(F(r0z * f0) - F(r0x * f2));
	const u0z = F(F(r0x * f1) - F(r0y * f0));
	const rx = F(F(r0x * cr) - F(u0x * sr));
	const ry = F(F(r0y * cr) - F(u0y * sr));
	const rz = F(F(r0z * cr) - F(u0z * sr));
	const ux = F(F(u0x * cr) + F(r0x * sr));
	const uy = F(F(u0y * cr) + F(r0y * sr));
	const uz = F(F(u0z * cr) + F(r0z * sr));
	const gap = isFine ? p.gapFine : p.gapCoarse;
	const T = F(t * p.aspect);
	const map = isFine ? fine : coarse;
	const qRel = F(F(Q_REL * U32) + p.slack.relT);
	const edK = F(F(ED_K * U32) + p.slack.dB);
	const term = (x: number, y: number): [number, number] => {
		const a0 = Math.max(0, y - gap - p.band);
		const a1 = Math.max(0, y - gap);
		const b0 = Math.min(h, y + gap);
		const b1 = Math.min(h, y + gap + p.band);
		const above =
			a1 > a0
				? div32(F(skyCum[a1 * w + x] - skyCum[a0 * w + x]), a1 - a0)
				: 0.5;
		const below =
			b1 > b0
				? div32(F(skyCum[b1 * w + x] - skyCum[b0 * w + x]), b1 - b0)
				: 0.5;
		const k = y * w + x;
		const m = map[k];
		return [
			F(F(F(0.5 * m) + F(above - below)) * F(1 - fg[k])),
			F(F(F(0.5 * Math.abs(m)) + Math.abs(above)) + Math.abs(below)),
		];
	};
	const sLo = new Float32Array(WG);
	const sHi = new Float32Array(WG);
	const sA = new Float32Array(WG);
	const sN = new Uint32Array(WG);
	const sAmb = new Uint32Array(WG);
	const sAmbZ = new Uint32Array(WG);
	const sAmbHi = new Float32Array(WG);
	const sAmbLo = new Float32Array(WG);
	const c64 = F(64 * U32);
	const c2 = F(2 * U32);
	const tiny8 = F(1e-8);
	const tiny9 = F(1e-9);
	const tiny6 = F(1e-6);
	const thr49 = F(F(0.49) + tiny6);
	const z01 = F(0.1);
	const e01 = F(0.01);
	const e99 = F(0.99);
	for (let lid = 0; lid < WG; lid++) {
		let lo = 0;
		let hi = 0;
		let aSum = 0;
		let n = 0;
		let amb = 0;
		let ambZ = 0;
		let ambHi = 0;
		let ambLo = 0;
		for (let i = lid; i < p.nDirs; i += WG) {
			const ex = d.dx[i];
			const ey = d.dy[i];
			const ez = d.dz[i];
			const e = F(F(edK * d.d1[i]) * F(1.01));
			const z = F(F(F(ex * f0) + F(ey * f1)) + F(ez * f2));
			const xr = F(F(F(ex * rx) + F(ey * ry)) + F(ez * rz));
			if (near(z, z01, F(e + tiny8))) {
				const qmin = div32(div32(div32(F(Math.abs(xr) - e), F(z + e)), T), 2);
				if (F(qmin * F(1 - c64)) <= thr49) ambZ++;
				continue;
			}
			if (z <= z01) continue;
			const xu = F(F(F(ex * ux) + F(ey * uy)) + F(ez * uz));
			const qu = div32(div32(div32(xr, z), T), 2);
			const qv = div32(div32(div32(xu, z), t), 2);
			const uu = F(0.5 + qu);
			const vv = F(0.5 - qv);
			const zl = F(z - e);
			const ezl = div32(e, zl);
			const eu = F(
				F(
					F(F(Math.abs(qu) * F(ezl + qRel)) + div32(e, F(F(zl * T) * 2))) *
						1.25,
				) + c2,
			);
			const ev = F(
				F(
					F(F(Math.abs(qv) * F(ezl + qRel)) + div32(e, F(F(zl * t) * 2))) *
						1.25,
				) + c2,
			);
			const eu1 = F(eu + tiny9);
			const ev1 = F(ev + tiny9);
			const nearU = near(uu, e01, eu1) || near(uu, e99, eu1);
			const nearV = near(vv, e01, ev1) || near(vv, e99, ev1);
			if (
				(!nearU && (uu < e01 || uu > e99)) ||
				(!nearV && (vv < e01 || vv > e99))
			)
				continue;
			const X = F(uu * w);
			const Y = F(vv * h);
			const mx = F(F(F(eu * w) + F(U32 * Math.abs(X))) + tiny6);
			const my = F(F(F(ev * h) + F(U32 * Math.abs(Y))) + tiny6);
			const fxa = Math.floor(F(X - mx));
			const fxb = Math.floor(F(X + mx));
			const fya = Math.floor(F(Y - my));
			const fyb = Math.floor(F(Y + my));
			if (fxb - fxa > 1 || fyb - fya > 1) {
				ambZ++;
				continue;
			}
			const xa = Math.min(Math.max(fxa, 0), w - 1);
			const xb = Math.min(Math.max(fxb, 0), w - 1);
			const ya = Math.min(Math.max(fya, 0), h - 1);
			const yb = Math.min(Math.max(fyb, 0), h - 1);
			let c = term(xa, ya);
			let cLo = c[0];
			let cHi = c[0];
			let cA = c[1];
			if (xb !== xa) {
				c = term(xb, ya);
				cLo = Math.min(cLo, c[0]);
				cHi = Math.max(cHi, c[0]);
				cA = Math.max(cA, c[1]);
			}
			if (yb !== ya) {
				c = term(xa, yb);
				cLo = Math.min(cLo, c[0]);
				cHi = Math.max(cHi, c[0]);
				cA = Math.max(cA, c[1]);
				if (xb !== xa) {
					c = term(xb, yb);
					cLo = Math.min(cLo, c[0]);
					cHi = Math.max(cHi, c[0]);
					cA = Math.max(cA, c[1]);
				}
			}
			aSum = F(aSum + cA);
			if (nearU || nearV) {
				amb++;
				ambHi = F(ambHi + Math.max(0, cHi));
				ambLo = F(ambLo + Math.min(0, cLo));
			} else {
				lo = F(lo + cLo);
				hi = F(hi + cHi);
				n++;
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
	}
	for (let s = WG / 2; s > 0; s >>= 1)
		for (let lid = 0; lid < s; lid++) {
			sLo[lid] += sLo[lid + s];
			sHi[lid] += sHi[lid + s];
			sA[lid] += sA[lid + s];
			sN[lid] += sN[lid + s];
			sAmb[lid] += sAmb[lid + s];
			sAmbZ[lid] += sAmbZ[lid + s];
			sAmbHi[lid] += sAmbHi[lid + s];
			sAmbLo[lid] += sAmbLo[lid + s];
		}
	const N = sN[0];
	const NA = sAmb[0];
	const sumLo = sLo[0];
	const sumHi = sHi[0];
	const absA = sA[0];
	const aHi = sAmbHi[0];
	const aLo = sAmbLo[0];
	const fin = Number.isFinite;
	let flags = 0;
	if (
		sAmbZ[0] > 0 ||
		!fin(sumLo) ||
		!fin(sumHi) ||
		!fin(absA) ||
		!fin(aHi) ||
		!fin(aLo) ||
		absA < 0 ||
		aHi < 0 ||
		aLo > 0 ||
		!(t >= T_MIN && t <= T_MAX)
	)
		flags = RES_UNBOUNDED;
	const tiny30 = F(1e-30);
	const E = F(F(p.eCoef * absA) + F(tiny30 * (N + NA)));
	let sHiT = F(F(sumHi + aHi) + E);
	sHiT = F(F(sHiT + F(c2 * F(F(Math.abs(sumHi) + aHi) + E))) + tiny30);
	let sLoT = F(F(sumLo + aLo) - E);
	sLoT = F(
		F(sLoT - F(c2 * F(F(Math.abs(sumLo) + Math.abs(aLo)) + E))) - tiny30,
	);
	let scHi = F(-3e38);
	let scLo = F(3e38);
	if (N <= 20) {
		scHi = 0;
		scLo = 0;
	}
	const m1 = Math.max(N, 21);
	const m2 = N + NA;
	if (m1 <= m2) {
		scHi = Math.max(
			scHi,
			Math.max(g32(p, sHiT, m1, vfov), g32(p, sHiT, m2, vfov)),
		);
		scLo = Math.min(
			scLo,
			Math.min(g32(p, sLoT, m1, vfov), g32(p, sLoT, m2, vfov)),
		);
	}
	const gRel = F(F(G_REL * U32) + p.slack.relV);
	scHi = F(F(scHi + F(Math.abs(scHi) * gRel)) + tiny30);
	scLo = F(F(scLo - F(Math.abs(scLo) * gRel)) - tiny30);
	const pRel = F(PEN_REL * U32);
	const penHi = F(F(F(pen * F(1 + pRel)) + p.slack.pen) + tiny30);
	const penLo = F(F(F(pen * F(1 - pRel)) - p.slack.pen) - tiny30);
	let fHi = F(scHi - penLo);
	fHi = F(F(fHi + F(F(Math.abs(fHi) * 2) * U32)) + tiny30);
	let fLo = F(scLo - penHi);
	fLo = F(F(fLo - F(F(Math.abs(fLo) * 2) * U32)) - tiny30);
	if (!fin(fLo) || !fin(fHi)) flags = RES_UNBOUNDED;
	return { lo: fLo, hi: fHi, flags };
}

// ---- EVAL2 (double-f32) ----

const C01 = split(0.1);
const C001 = split(0.01);
const C099 = split(0.99);
const C06 = split(0.6);
const up = (x: number) => {
	const f = Math.fround(x);
	return f >= x ? f : Math.fround(f * (1 + 2 ** -23));
};
// the WGSL's constants (the same f32 values, cert.wgsl.ts)
const ED2c = up(BASIS2 + DOT2);
const REL2c = up(REL2);
const ADD2c = up(ADD2);
const PIX2c = up(PIX2);
const G2c = up(G2);
const PEN2c = up(PEN2);
const END2c = up(END2);
const ZERO: DD = [0, 0];
const neg = (a: DD): DD => [-a[0], -a[1]];
const add = (a: DD, b: DD) => ddAdd(a[0], a[1], b[0], b[1]);
const mul = (a: DD, b: DD) => ddMul(a[0], a[1], b[0], b[1]);
const div = (a: DD, b: DD) => ddDiv(a[0], a[1], b[0], b[1]);
const dfLt = (a: DD, b: DD) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
const dfMin = (a: DD, b: DD) => (dfLt(b, a) ? b : a);
const dfMax = (a: DD, b: DD) => (dfLt(a, b) ? b : a);
const dfFloor = (a: DD) => {
	const f = Math.floor(a[0]);
	return f === a[0] && a[1] < 0 ? f - 1 : f;
};
const nextUp = (x: number) => (x === 0 ? MIN_NORMAL : nextUp32(x));
const nextDown = (x: number) => -nextUp(-x);
const dfDown = (a: DD) => (a[1] < 0 ? nextDown(a[0]) : a[0]);
const dfUp = (a: DD) => (a[1] > 0 ? nextUp(a[0]) : a[0]);
const side = (a: DD, c: DD, e: number) => {
	const dd = add(a, neg(c))[0];
	if (Math.abs(dd) <= F(F(e * F(1.01)) + F(1e-30))) return 0;
	return dd < 0 ? -1 : 1;
};
const dot2 = (f: DD[], x: number, y: number, z: number) =>
	add(
		add(ddMulF(f[0][0], f[0][1], x), ddMulF(f[1][0], f[1][1], y)),
		ddMulF(f[2][0], f[2][1], z),
	);

/** EVAL2 (cert.wgsl.ts CERT_EVAL2_WGSL) for one pose, in double-f32. */
function scoreInterval2(
	p: Params,
	edge: EdgeMap,
	d: Dirs,
	isFine: boolean,
	tab: Float32Array,
	iy: number,
	ip: number,
	ir: number,
	iv: number,
) {
	const TE = TABLE2_ENTRY;
	const at = (i: number, k: number): DD => [
		tab[i * TE + 2 * k],
		tab[i * TE + 2 * k + 1],
	];
	const sy = at(iy, 0);
	const cy = at(iy, 1);
	const sp = at(ip, 2);
	const cp = at(ip, 3);
	const sr = at(ir, 4);
	const cr = at(ir, 5);
	const t2 = at(iv, 6);
	const vfov2 = at(iv, 7);
	const asp = p.asp;
	const { w, h, skyCum, coarse, fine, fg } = edge;
	const F0 = mul(sy, cp);
	const F1 = mul(cy, cp);
	const F2 = sp;
	const U0x = mul(neg(sy), sp);
	const U0y = neg(mul(cy, sp));
	const U0z = add(mul(cy, F1), mul(sy, F0));
	const R = [
		add(mul(cy, cr), neg(mul(U0x, sr))),
		add(neg(mul(sy, cr)), neg(mul(U0y, sr))),
		neg(mul(U0z, sr)),
	];
	const UP = [
		add(mul(U0x, cr), mul(cy, sr)),
		add(mul(U0y, cr), neg(mul(sy, sr))),
		mul(U0z, cr),
	];
	const FW = [F0, F1, F2];
	const f4 = [F0[0], F1[0], F2[0]];
	const r4 = [R[0][0], R[1][0], R[2][0]];
	const u4 = [UP[0][0], UP[1][0], UP[2][0]];
	const t = t2[0];
	const T = F(t * p.aspect);
	const TA = mul(t2, asp);
	const gap = isFine ? p.gapFine : p.gapCoarse;
	const map = isFine ? fine : coarse;
	const qRel = F(F(Q_REL * U32) + p.slack.relT);
	const edK = F(F(ED_K * U32) + p.slack.dB);
	const rel2 = F(REL2c + p.slack.relT);
	const c2 = F(2 * U32);
	const tiny8 = F(1e-8);
	const tiny9 = F(1e-9);
	const z01 = F(0.1);
	const thr49 = F(0.49);
	const e46 = ADD2c;
	const e44 = PIX2c;
	const term2 = (x: number, y: number): [DD, number] => {
		const a0 = Math.max(0, y - gap - p.band);
		const a1 = Math.max(0, y - gap);
		const b0 = Math.min(h, y + gap);
		const b1 = Math.min(h, y + gap + p.band);
		const above: DD =
			a1 > a0
				? div(twoSum(skyCum[a1 * w + x], -skyCum[a0 * w + x]), [a1 - a0, 0])
				: [0.5, 0];
		const below: DD =
			b1 > b0
				? div(twoSum(skyCum[b1 * w + x], -skyCum[b0 * w + x]), [b1 - b0, 0])
				: [0.5, 0];
		const k = y * w + x;
		const m = map[k];
		const s1 = add(above, neg(below));
		const t1 = ddAddF(s1[0], s1[1], 0.5 * m);
		const c = mul(t1, twoSum(1, -fg[k]));
		return [
			c,
			F(F(F(0.5 * Math.abs(m)) + Math.abs(above[0])) + Math.abs(below[0])),
		];
	};
	const wLo: DD[] = [];
	const wHi: DD[] = [];
	const wAmbLo: DD[] = [];
	const wAmbHi: DD[] = [];
	const wA = new Float32Array(WG);
	const wN = new Uint32Array(WG);
	const wAmb = new Uint32Array(WG);
	const wAmbZ = new Uint32Array(WG);
	for (let lid = 0; lid < WG; lid++) {
		let lo: DD = ZERO;
		let hi: DD = ZERO;
		let ambLo: DD = ZERO;
		let ambHi: DD = ZERO;
		let aSum = 0;
		let n = 0;
		let amb = 0;
		let ambZ = 0;
		for (let i = lid; i < p.nDirs; i += WG) {
			const ex = d.dx[i];
			const ey = d.dy[i];
			const ez = d.dz[i];
			const d1 = d.d1[i];
			const ed = F(F(edK * d1) * 1.25);
			const z = F(F(F(ex * f4[0]) + F(ey * f4[1])) + F(ez * f4[2]));
			if (!near(z, z01, F(ed + tiny8)) && z <= z01) continue;
			if (z > F(F(z01 + ed) + tiny8)) {
				const xr = F(F(F(ex * r4[0]) + F(ey * r4[1])) + F(ez * r4[2]));
				const xu = F(F(F(ex * u4[0]) + F(ey * u4[1])) + F(ez * u4[2]));
				const qu = div32(div32(div32(xr, z), T), 2);
				const qv = div32(div32(div32(xu, z), t), 2);
				const zl = F(z - ed);
				const ezl = div32(ed, zl);
				const eu = F(
					F(
						F(
							F(F(Math.abs(qu) * F(ezl + qRel)) + div32(ed, F(F(zl * T) * 2))) *
								1.25,
						) + c2,
					) + tiny9,
				);
				const ev = F(
					F(
						F(
							F(F(Math.abs(qv) * F(ezl + qRel)) + div32(ed, F(F(zl * t) * 2))) *
								1.25,
						) + c2,
					) + tiny9,
				);
				if (
					Math.abs(qu) > F(thr49 + F(eu * 2)) ||
					Math.abs(qv) > F(thr49 + F(ev * 2))
				)
					continue;
			}
			const ed2 = F(F(F(ED2c + p.slack.dB) * d1) * F(1.01));
			const Z = dot2(FW, ex, ey, ez);
			const zs = side(Z, C01, ed2);
			if (zs === 0) {
				ambZ++;
				continue;
			}
			if (zs < 0) continue;
			const XR = dot2(R, ex, ey, ez);
			const XU = dot2(UP, ex, ey, ez);
			const qa = div(div(XR, Z), TA);
			const QU = ddMulF(qa[0], qa[1], 0.5);
			const qb = div(div(XU, Z), t2);
			const QV = ddMulF(qb[0], qb[1], 0.5);
			const UU = ddAddF(QU[0], QU[1], 0.5);
			const VV = ddAddF(-QV[0], -QV[1], 0.5);
			const zl2 = F(F(Z[0] - ed2) * F(1 - F(4 * U32)));
			const ez2 = div32(ed2, zl2);
			const eu2 = F(
				F(
					F(
						F(Math.abs(QU[0]) * F(ez2 + rel2)) +
							div32(ed2, F(F(zl2 * TA[0]) * 2)),
					) * 1.25,
				) + e46,
			);
			const ev2 = F(
				F(
					F(
						F(Math.abs(QV[0]) * F(ez2 + rel2)) + div32(ed2, F(F(zl2 * t) * 2)),
					) * 1.25,
				) + e46,
			);
			const su1 = side(UU, C001, eu2);
			const su9 = side(UU, C099, eu2);
			const sv1 = side(VV, C001, ev2);
			const sv9 = side(VV, C099, ev2);
			const nearU = su1 === 0 || su9 === 0;
			const nearV = sv1 === 0 || sv9 === 0;
			if ((!nearU && (su1 < 0 || su9 > 0)) || (!nearV && (sv1 < 0 || sv9 > 0)))
				continue;
			const X = ddMulF(UU[0], UU[1], w);
			const Y = ddMulF(VV[0], VV[1], h);
			const mx = F(
				F(F(F(eu2 * w) * F(1.01)) + F(e44 * Math.abs(X[0]))) + F(1e-30),
			);
			const my = F(
				F(F(F(ev2 * h) * F(1.01)) + F(e44 * Math.abs(Y[0]))) + F(1e-30),
			);
			const fxa = dfFloor(ddAddF(X[0], X[1], -mx));
			const fxb = dfFloor(ddAddF(X[0], X[1], mx));
			const fya = dfFloor(ddAddF(Y[0], Y[1], -my));
			const fyb = dfFloor(ddAddF(Y[0], Y[1], my));
			if (fxb - fxa > 1 || fyb - fya > 1) {
				ambZ++;
				continue;
			}
			const xa = Math.min(Math.max(fxa, 0), w - 1);
			const xb = Math.min(Math.max(fxb, 0), w - 1);
			const ya = Math.min(Math.max(fya, 0), h - 1);
			const yb = Math.min(Math.max(fyb, 0), h - 1);
			let c = term2(xa, ya);
			let cLo = c[0];
			let cHi = c[0];
			let cA = c[1];
			if (xb !== xa) {
				c = term2(xb, ya);
				cLo = dfMin(cLo, c[0]);
				cHi = dfMax(cHi, c[0]);
				cA = Math.max(cA, c[1]);
			}
			if (yb !== ya) {
				c = term2(xa, yb);
				cLo = dfMin(cLo, c[0]);
				cHi = dfMax(cHi, c[0]);
				cA = Math.max(cA, c[1]);
				if (xb !== xa) {
					c = term2(xb, yb);
					cLo = dfMin(cLo, c[0]);
					cHi = dfMax(cHi, c[0]);
					cA = Math.max(cA, c[1]);
				}
			}
			aSum = F(aSum + cA);
			if (nearU || nearV) {
				amb++;
				ambHi = add(ambHi, dfMax(cHi, ZERO));
				ambLo = add(ambLo, dfMin(cLo, ZERO));
			} else {
				lo = add(lo, cLo);
				hi = add(hi, cHi);
				n++;
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
	}
	for (let s = WG / 2; s > 0; s >>= 1)
		for (let lid = 0; lid < s; lid++) {
			wLo[lid] = add(wLo[lid], wLo[lid + s]);
			wHi[lid] = add(wHi[lid], wHi[lid + s]);
			wAmbLo[lid] = add(wAmbLo[lid], wAmbLo[lid + s]);
			wAmbHi[lid] = add(wAmbHi[lid], wAmbHi[lid + s]);
			wA[lid] += wA[lid + s];
			wN[lid] += wN[lid + s];
			wAmb[lid] += wAmb[lid + s];
			wAmbZ[lid] += wAmbZ[lid + s];
		}
	const N = wN[0];
	const NA = wAmb[0];
	const sumLo = wLo[0];
	const sumHi = wHi[0];
	const aLo = wAmbLo[0];
	const aHi = wAmbHi[0];
	const absA = wA[0];
	const fin = Number.isFinite;
	let flags = 0;
	if (
		wAmbZ[0] > 0 ||
		!fin(sumLo[0]) ||
		!fin(sumHi[0]) ||
		!fin(absA) ||
		!fin(aHi[0]) ||
		!fin(aLo[0]) ||
		absA < 0 ||
		aHi[0] < 0 ||
		aLo[0] > 0 ||
		!(t >= T_MIN && t <= T_MAX)
	)
		flags = RES_UNBOUNDED;
	const e45 = END2c;
	const E2 = F(F(p.e2Coef * absA) + F(F(1e-30) * (N + NA)));
	const h1 = add(sumHi, aHi);
	const sHiT = ddAddF(
		h1[0],
		h1[1],
		F(E2 + F(e45 * F(Math.abs(sumHi[0]) + Math.abs(aHi[0])))),
	);
	const l1 = add(sumLo, aLo);
	const sLoT = ddAddF(
		l1[0],
		l1[1],
		-F(E2 + F(e45 * F(Math.abs(sumLo[0]) + Math.abs(aLo[0])))),
	);
	const g2 = (S: DD, m: number): DD => {
		const mm: DD = [m, 0];
		const den = mul(div(mul(vfov2, asp), [360, 0]), C06);
		let cov = div(div(mm, [p.total, 0]), den);
		if (!dfLt(cov, [1, 0])) cov = [1, 0];
		return mul(div(S, mm), cov);
	};
	let scHi: DD = [F(-3e38), 0];
	let scLo: DD = [F(3e38), 0];
	if (N <= 20) {
		scHi = ZERO;
		scLo = ZERO;
	}
	const m1 = Math.max(N, 21);
	const m2 = N + NA;
	if (m1 <= m2) {
		scHi = dfMax(scHi, dfMax(g2(sHiT, m1), g2(sHiT, m2)));
		scLo = dfMin(scLo, dfMin(g2(sLoT, m1), g2(sLoT, m2)));
	}
	const gw = F(G2c + p.slack.relV);
	scHi = ddAddF(
		scHi[0],
		scHi[1],
		F(F(F(Math.abs(scHi[0]) * gw) * F(1.01)) + F(1e-30)),
	);
	scLo = ddAddF(
		scLo[0],
		scLo[1],
		-F(F(F(Math.abs(scLo[0]) * gw) * F(1.01)) + F(1e-30)),
	);
	const pen = add(add(add(at(iy, 8), at(ip, 9)), at(ir, 10)), at(iv, 11));
	const pw = F(F(F(Math.abs(pen[0]) * PEN2c) + p.slack.pen) + F(1e-30));
	const dh = add(scHi, neg(pen));
	const fHi = ddAddF(
		dh[0],
		dh[1],
		F(pw + F(e45 * F(Math.abs(scHi[0]) + Math.abs(pen[0])))),
	);
	const dl = add(scLo, neg(pen));
	const fLo = ddAddF(
		dl[0],
		dl[1],
		-F(pw + F(e45 * F(Math.abs(scLo[0]) + Math.abs(pen[0])))),
	);
	const lo32 = dfDown(fLo);
	const hi32 = dfUp(fHi);
	if (!fin(lo32) || !fin(hi32)) flags = RES_UNBOUNDED;
	return { lo: lo32, hi: hi32, flags };
}
