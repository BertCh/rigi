// GA5 (reports/geometry-first-pose.md G6): solution-separation integrity (GNSS ARAIM / TRN style).
//
// The full MAP solution x0 (covariance Σ0) is compared with re-solves x_k that each leave one subset of
// the evidence out: a cue family, an image sector (left / right half), a distance band (near / far),
// skyline vs matches. If the evidence is consistent, every x_k scatters around x0 within
// σ_sep,k = √(Σ_k − Σ_0) (the separation covariance of nested least squares); a fault confined to one
// subset (a wrong eye that only the near band contradicts, a wrong basin whose matches disagree between
// halves) shows up as a separation well beyond it. Per axis group and subset
//
//     PL_k = |x0 − x_k| + K_md · σ_sep,k            (projected on H = E/N, V = U, yaw)
//
// with σ_sep,H = √λmax of the 2×2 E/N block of Σ_k − Σ_0 (clamped ≥ 0), and PL = max_k PL_k. The
// photo passes iff PL_H < alertH, PL_V < alertV, PL_yaw < alertYaw (and PL_pitch < alertPitch, off by
// default), AND every subset solved
// ("availability": a subset with too few rows or a failed solve fails the photo — it cannot be
// verified). The fault-free term K_md·σ0 is reported (plFF*) but is not part of the pass rule: when
// the eye information is the GPS prior alone it is K·σ_GPS, which says "no better than GPS", not
// "wrong". A subset that removes every data (non-prior) row is never formed (prior-only re-solves
// would compare the evidence against the prior, which is the prior veto, not integrity).
//
// Subsets are Factor-list transforms. Row-level subsets (sectors, bands) need per-row metadata that
// the frozen Factor does not carry, so callers pass `rowInfo(f)` → [{u, depthM}] (one entry per
// residual row, or undefined for factors that are kept whole) and `maskFactor` wraps a factor so the
// masked rows read NaN (the solver drops them) and its nEff cap shrinks with the kept fraction.
//
// Caveats (documented, not hidden): the MAP covariance is MAD-rescaled per solve (map/covariance.ts),
// so Σ_k − Σ_0 is not exactly PSD; negative parts are clamped. Each re-solve starts at x0 (the
// standard choice; it finds the subset minimum nearest the full solution, so a multi-modal subset
// under-reports separation). With the eye FIXED (MapProblem.free.eye = false) the eye PLs are 0 and
// a wrong eye can only show as a rotation separation between subsets (near vs far parallax: the
// rotation that fits the near band from a wrong eye differs from the one that fits the far band);
// that is the configuration for testing a proposed camera as-is. K_md = 5.33 is the ARAIM P_md ≈ 1e-7 value; here it is a convention,
// not a calibrated probability.
import {
	type CueFamily,
	dAngle,
	type Factor,
	type GeoState,
	IDX,
	type MapOpts,
	type MapProblem,
	type MapResult,
	NP,
	PRIOR_FAMILIES,
} from "../core";
import { solveMap } from "../map/solve";

export type RowInfo = { u: number; depthM: number };

export type SubsetSpec = {
	name: string;
	/** The factor list of the re-solve (a subset / masked copy of the full problem's factors). */
	factors: Factor[];
};

export type SubsetResult = {
	name: string;
	ok: boolean;
	why?: string;
	x?: GeoState;
	dH: number;
	dV: number;
	dYawDeg: number;
	dPitchDeg: number;
	sepH: number;
	sepV: number;
	sepYawDeg: number;
	sepPitchDeg: number;
	plH: number;
	plV: number;
	plYawDeg: number;
	plPitchDeg: number;
	/** Separation test statistic max(dH/sepH, dV/sepV, dYaw/sepYaw) (∞ when sep = 0 and d > 0). */
	sepZ: number;
	dataRows: number;
};

export type ProtectionLevel = {
	plH: number;
	plV: number;
	plYawDeg: number;
	plPitchDeg: number;
	/** Fault-free terms K·σ0 (reported, not in the pass rule). */
	plFFH: number;
	plFFV: number;
	plFFYawDeg: number;
	subsets: SubsetResult[];
	/** Every subset available and every PL below its alert limit. */
	pass: boolean;
	reasons: string[];
	/** Name of the subset that sets each PL. */
	worst: { H: string; V: string; yaw: string; pitch: string };
};

export type ProtectionOpts = {
	/** Explicit subsets; default defaultSubsets(p, rowInfo). */
	subsets?: SubsetSpec[];
	/** Per-row metadata for sector / band subsets. */
	rowInfo?: (f: Factor) => RowInfo[] | undefined;
	kMd?: number;
	/** Alert limits: horizontal / vertical eye (m) and yaw (deg). Defaults 50 / 25 / 1. */
	alertH?: number;
	alertV?: number;
	alertYawDeg?: number;
	/** Pitch alert limit (deg). Default off (Infinity). */
	alertPitchDeg?: number;
	/** A subset needs at least this many valid data rows (else unavailable ⇒ fail). Default 12. */
	minRows?: number;
	/** Near / far split for band subsets (m). Default 2000. */
	bandSplitM?: number;
	map?: MapOpts;
	/** Solver (default map/solve solveMap); injectable for tests. */
	solve?: (p: MapProblem, x0: GeoState, o?: MapOpts) => Promise<MapResult>;
};

export const PL_DEFAULTS = {
	kMd: 5.33,
	alertH: 50,
	alertV: 25,
	alertYawDeg: 1,
	alertPitchDeg: Number.POSITIVE_INFINITY,
	minRows: 12,
	bandSplitM: 2000,
};

const isPrior = (f: Factor) =>
	f.prior === true || PRIOR_FAMILIES.includes(f.family);

/** Valid (finite) data rows of the non-prior factors at x. */
export function dataRows(factors: Factor[], x: GeoState): number {
	let n = 0;
	for (const f of factors) {
		if (isPrior(f)) continue;
		const r = f.residual(x);
		for (let i = 0; i < r.length; i++) if (Number.isFinite(r[i])) n++;
	}
	return n;
}

/**
 * Wrap a factor so rows with keep(i) = false read NaN. nEff shrinks with the kept fraction (the cap
 * models correlation within the factor: half the rows carry at most half the capped information).
 * The Jacobian, when analytic, is passed through (NaN rows are dropped by the solver anyway).
 */
export function maskFactor(
	f: Factor,
	keep: (row: number) => boolean,
	tag: string,
): Factor {
	const frac = () => {
		const d = f.dim;
		let k = 0;
		for (let i = 0; i < d; i++) if (keep(i)) k++;
		return d ? k / d : 0;
	};
	const out: Factor = {
		family: f.family,
		name: `${f.name}|${tag}`,
		get dim() {
			return f.dim;
		},
		loss: f.loss,
		prior: f.prior,
		residual(x) {
			const r = f.residual(x);
			const o = new Float64Array(r.length);
			for (let i = 0; i < r.length; i++) o[i] = keep(i) ? r[i] : Number.NaN;
			return o;
		},
	};
	if (f.nEff !== undefined)
		Object.defineProperty(out, "nEff", {
			get: () => Math.max(1, (f.nEff as number) * frac()),
			enumerable: true,
		});
	if (f.jacobian)
		out.jacobian = (x) => (f.jacobian as (x: GeoState) => Float64Array)(x);
	if (f.relinearize)
		out.relinearize = (x) =>
			(f.relinearize as (x: GeoState) => Promise<void>)(x);
	return out;
}

/**
 * Default leave-one-out subsets:
 *   - each data family present (leave it out), when at least one other data family remains;
 *   - with rowInfo: leave out the left / right image half (u < 0.5 / u ≥ 0.5) and the near / far
 *     band (depth < / ≥ bandSplitM), row-masked over every factor that has row metadata.
 * "skyline vs matches" is the family pair skyline / point: leaving out one keeps the other.
 */
export function defaultSubsets(
	p: MapProblem,
	o: Pick<ProtectionOpts, "rowInfo" | "bandSplitM"> = {},
): SubsetSpec[] {
	const out: SubsetSpec[] = [];
	const dataFams = [
		...new Set(p.factors.filter((f) => !isPrior(f)).map((f) => f.family)),
	] as CueFamily[];
	if (dataFams.length >= 2)
		for (const fam of dataFams)
			out.push({
				name: `-${fam}`,
				factors: p.factors.filter((f) => f.family !== fam),
			});
	if (o.rowInfo) {
		const split = o.bandSplitM ?? PL_DEFAULTS.bandSplitM;
		const rowMasks: [string, (ri: RowInfo) => boolean][] = [
			["-left", (ri) => ri.u >= 0.5],
			["-right", (ri) => ri.u < 0.5],
			["-near", (ri) => !(ri.depthM < split)],
			["-far", (ri) => ri.depthM < split],
		];
		for (const [name, keep] of rowMasks) {
			let touched = false;
			const factors = p.factors.map((f) => {
				if (isPrior(f)) return f;
				const info = o.rowInfo?.(f);
				if (!info) return f;
				touched = true;
				return maskFactor(
					f,
					(i) => (i < info.length ? keep(info[i]) : true),
					name,
				);
			});
			if (touched) out.push({ name, factors });
		}
	}
	return out;
}

/** Symmetric 2×2 block of a 7×7 row-major matrix, √λmax (clamped). */
function sqrtLmax2(M: Float64Array, a: number, b: number): number {
	const A = M[a * NP + a];
	const B = M[a * NP + b];
	const D = M[b * NP + b];
	const t = (A + D) / 2;
	const q = Math.sqrt(Math.max(0, ((A - D) / 2) ** 2 + B * B));
	return Math.sqrt(Math.max(0, t + q));
}

/**
 * Solution-separation protection level of the full solution `full` of problem `p`. Re-solves every
 * subset starting at full.x.
 */
export async function protectionLevel(
	p: MapProblem,
	full: MapResult,
	o: ProtectionOpts = {},
): Promise<ProtectionLevel> {
	const K = o.kMd ?? PL_DEFAULTS.kMd;
	const aH = o.alertH ?? PL_DEFAULTS.alertH;
	const aV = o.alertV ?? PL_DEFAULTS.alertV;
	const aY = o.alertYawDeg ?? PL_DEFAULTS.alertYawDeg;
	const aP = o.alertPitchDeg ?? PL_DEFAULTS.alertPitchDeg;
	const minRows = o.minRows ?? PL_DEFAULTS.minRows;
	const solve = o.solve ?? solveMap;
	const subsets = o.subsets ?? defaultSubsets(p, o);
	const x0 = full.x;
	const S0 = full.cov;
	const res: SubsetResult[] = [];
	const reasons: string[] = [];
	for (const s of subsets) {
		const base: SubsetResult = {
			name: s.name,
			ok: false,
			dH: Number.NaN,
			dV: Number.NaN,
			dYawDeg: Number.NaN,
			dPitchDeg: Number.NaN,
			sepH: Number.NaN,
			sepV: Number.NaN,
			sepYawDeg: Number.NaN,
			sepPitchDeg: Number.NaN,
			plH: Number.POSITIVE_INFINITY,
			plV: Number.POSITIVE_INFINITY,
			plYawDeg: Number.POSITIVE_INFINITY,
			plPitchDeg: Number.POSITIVE_INFINITY,
			sepZ: Number.POSITIVE_INFINITY,
			dataRows: 0,
		};
		// relinearise at x0 before counting rows (eye-dependent factors may re-extract)
		for (const f of s.factors) if (f.relinearize) await f.relinearize(x0);
		const n = dataRows(s.factors, x0);
		base.dataRows = n;
		if (n < minRows) {
			res.push({ ...base, why: `unavailable: ${n} data rows < ${minRows}` });
			reasons.push(`${s.name} unavailable (${n} rows)`);
			continue;
		}
		let r: MapResult;
		try {
			r = await solve({ ...p, factors: s.factors }, x0, o.map);
		} catch (e) {
			res.push({ ...base, why: `solve failed: ${(e as Error).message}` });
			reasons.push(`${s.name} solve failed`);
			continue;
		}
		const D = new Float64Array(NP * NP);
		for (let q = 0; q < NP * NP; q++) D[q] = r.cov[q] - S0[q];
		const dE = r.x[IDX.E] - x0[IDX.E];
		const dN = r.x[IDX.N] - x0[IDX.N];
		const dH = Math.hypot(dE, dN);
		const dV = Math.abs(r.x[IDX.U] - x0[IDX.U]);
		const dY = Math.abs(dAngle(r.x[IDX.yaw], x0[IDX.yaw]));
		const sepH = sqrtLmax2(D, IDX.E, IDX.N);
		const sepV = Math.sqrt(Math.max(0, D[IDX.U * NP + IDX.U]));
		const sepY = Math.sqrt(Math.max(0, D[IDX.yaw * NP + IDX.yaw]));
		const dP = Math.abs(r.x[IDX.pitch] - x0[IDX.pitch]);
		const sepP = Math.sqrt(Math.max(0, D[IDX.pitch * NP + IDX.pitch]));
		const z = (d: number, s: number) =>
			s > 0 ? d / s : d > 1e-9 ? Number.POSITIVE_INFINITY : 0;
		const sub: SubsetResult = {
			...base,
			ok: true,
			x: r.x,
			dH,
			dV,
			dYawDeg: dY,
			dPitchDeg: dP,
			sepH,
			sepV,
			sepYawDeg: sepY,
			sepPitchDeg: sepP,
			plH: dH + K * sepH,
			plV: dV + K * sepV,
			plYawDeg: dY + K * sepY,
			plPitchDeg: dP + K * sepP,
			sepZ: Math.max(z(dH, sepH), z(dV, sepV), z(dY, sepY), z(dP, sepP)),
		};
		if (!r.converged) sub.why = "not converged";
		res.push(sub);
	}
	const argmax = (k: "plH" | "plV" | "plYawDeg" | "plPitchDeg") => {
		let best = res.length ? res[0] : null;
		for (const s of res) if (best && s[k] > best[k]) best = s;
		return best;
	};
	const wH = argmax("plH");
	const wV = argmax("plV");
	const wY = argmax("plYawDeg");
	const wP = argmax("plPitchDeg");
	const plH = wH ? wH.plH : 0;
	const plV = wV ? wV.plV : 0;
	const plY = wY ? wY.plYawDeg : 0;
	const plP = wP ? wP.plPitchDeg : 0;
	if (!res.length) reasons.push("no subsets (no redundancy)");
	if (plH >= aH) reasons.push(`PL_H ${plH.toFixed(1)} m ≥ ${aH} (${wH?.name})`);
	if (plV >= aV) reasons.push(`PL_V ${plV.toFixed(1)} m ≥ ${aV} (${wV?.name})`);
	if (plY >= aY)
		reasons.push(`PL_yaw ${plY.toFixed(3)}° ≥ ${aY} (${wY?.name})`);
	if (plP >= aP)
		reasons.push(`PL_pitch ${plP.toFixed(3)}° ≥ ${aP} (${wP?.name})`);
	const sEN = full.sigmaEN;
	return {
		plH,
		plV,
		plYawDeg: plY,
		plPitchDeg: plP,
		plFFH: K * sEN,
		plFFV: K * Math.sqrt(Math.max(0, S0[IDX.U * NP + IDX.U])),
		plFFYawDeg: K * Math.sqrt(Math.max(0, S0[IDX.yaw * NP + IDX.yaw])),
		subsets: res,
		pass: res.length > 0 && reasons.length === 0,
		reasons,
		worst: {
			H: wH?.name ?? "",
			V: wV?.name ?? "",
			yaw: wY?.name ?? "",
			pitch: wP?.name ?? "",
		},
	};
}

export type BubbleTest = {
	dH: number;
	dV: number;
	dYawDeg: number;
	/** max(PL, K·σ0) per group: the protected region around the full solution. */
	bubbleH: number;
	bubbleV: number;
	bubbleYawDeg: number;
	/** The hypothesis lies outside the protected region in at least one group. */
	outside: boolean;
};

/**
 * Is a proposed state (e.g. the hypothesis a solver or a candidate generator handed in) inside the
 * protection bubble of the MAP solution? With the eye free, a wrong-eye hypothesis is usually not
 * "accepted with a big PL" but CORRECTED: the MAP moves away from it. The hypothesis is then rejected
 * as proposed when it lies outside max(PL, K·σ0) of the solution.
 */
export function bubbleTest(
	xHyp: GeoState,
	full: MapResult,
	pl: ProtectionLevel,
): BubbleTest {
	const x0 = full.x;
	const dH = Math.hypot(xHyp[IDX.E] - x0[IDX.E], xHyp[IDX.N] - x0[IDX.N]);
	const dV = Math.abs(xHyp[IDX.U] - x0[IDX.U]);
	const dY = Math.abs(dAngle(xHyp[IDX.yaw], x0[IDX.yaw]));
	const bH = Math.max(pl.plH, pl.plFFH);
	const bV = Math.max(pl.plV, pl.plFFV);
	const bY = Math.max(pl.plYawDeg, pl.plFFYawDeg);
	return {
		dH,
		dV,
		dYawDeg: dY,
		bubbleH: bH,
		bubbleV: bV,
		bubbleYawDeg: bY,
		outside: dH > bH || dV > bV || dY > bY,
	};
}
