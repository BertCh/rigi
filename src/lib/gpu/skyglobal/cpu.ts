// CPU twin (and reference) of tools/matcher/stage1/skyglobal.py: the T6 stage-1 skyline global
// search. A line-by-line port that reproduces numpy's arithmetic, including the parts that decide
// ties:
//  - float32 sums use numpy's pairwise summation (pairwiseSumF32), float32 casts use Math.fround;
//  - comparisons of float32 arrays with Python floats use float32(0.3) (numpy 2 / NEP 50);
//  - np.arange(float) fills start + i·(a[1] − a[0]), Python round() rounds half to even;
//  - the grid winner's (vfov, pitch, roll) are stored as float32 (skyglobal's `arg` array), so the
//    polish starts from float32-rounded values, as in Python;
//  - scipy uniform_filter (mode "nearest") as a running sum per axis, axis 0 first.
// What cannot match bit for bit: V8's sin / cos / atan2 / asin against the Mac libm numpy uses (at
// most an ulp apart). The parity report measures the effect (bench.ts, scripts/gpu/skyglobal-*).
//
// The search is split so a GPU grid can replace the CPU one: plan() → grid (gridCpu, or the GPU's
// certified grid in ./index.ts) → peaks() → polish() (coordinate descent, CPU only).

export const BINS = 12;
const DEG = 180 / Math.PI; // np.degrees / math.degrees
const RAD = Math.PI / 180; // np.radians / math.radians
const F03 = Math.fround(0.3);
/** Python `2 * math.degrees(x)` (the product order matters for the last bit). */
const twoDeg = (x: number) => 2 * (x * DEG);

export type EdgeInputs = {
	w: number;
	h: number;
	/** horizonDirs, ENU unit vectors, xyz interleaved (the worker's float32). */
	dirs: Float32Array;
	fine: Float32Array;
	coarse: Float32Array;
	fg: Float32Array;
	/** RGB bytes, 3 per pixel, row 0 = top. */
	rgb: Uint8Array;
};

export type Pose = { yaw: number; pitch: number; roll: number; vfov: number };
export type Hyp = { pose: Pose; score: number; coarse: number };
export type Peak = Pose & { coarse: number };

/** Python round(): half to even. */
export function pyRound(x: number): number {
	const r = Math.round(x);
	if (Math.abs(x - Math.trunc(x)) === 0.5) return 2 * Math.round(x / 2);
	return r;
}

/** numpy float remainder (sign of the divisor). */
const fmodPos = (a: number, b: number) => {
	const m = a % b;
	return m !== 0 && m < 0 !== b < 0 ? m + b : m;
};
const imod = (a: number, n: number) => ((a % n) + n) % n;

/** np.arange(start, stop, step) for floats. */
export function arangeF(start: number, stop: number, step: number): number[] {
	const len = Math.max(0, Math.ceil((stop - start) / step));
	const out: number[] = [];
	if (!len) return out;
	out.push(start);
	if (len > 1) {
		const a1 = start + step;
		out.push(a1);
		const delta = a1 - start;
		for (let i = 2; i < len; i++) out.push(start + i * delta);
	}
	return out;
}

/** numpy's pairwise float32 sum (loops_utils.h pairwise_sum, PW_BLOCKSIZE 128). */
export function pairwiseSumF32(
	a: Float32Array,
	off: number,
	n: number,
): number {
	const f = Math.fround;
	if (n < 8) {
		let r = 0;
		for (let i = 0; i < n; i++) r = f(r + a[off + i]);
		return r;
	}
	if (n <= 128) {
		let r0 = a[off];
		let r1 = a[off + 1];
		let r2 = a[off + 2];
		let r3 = a[off + 3];
		let r4 = a[off + 4];
		let r5 = a[off + 5];
		let r6 = a[off + 6];
		let r7 = a[off + 7];
		let i = 8;
		const m = n - (n % 8);
		for (; i < m; i += 8) {
			r0 = f(r0 + a[off + i]);
			r1 = f(r1 + a[off + i + 1]);
			r2 = f(r2 + a[off + i + 2]);
			r3 = f(r3 + a[off + i + 3]);
			r4 = f(r4 + a[off + i + 4]);
			r5 = f(r5 + a[off + i + 5]);
			r6 = f(r6 + a[off + i + 6]);
			r7 = f(r7 + a[off + i + 7]);
		}
		let res = f(f(f(r0 + r1) + f(r2 + r3)) + f(f(r4 + r5) + f(r6 + r7)));
		for (; i < n; i++) res = f(res + a[off + i]);
		return res;
	}
	let n2 = Math.floor(n / 2);
	n2 -= n2 % 8;
	return Math.fround(
		pairwiseSumF32(a, off, n2) + pairwiseSumF32(a, off + n2, n - n2),
	);
}

/** align.ts scanLabels without a prior (pose-free): 1 sky, −1 terrain, 0 unknown. */
export function scanLabels(
	rgb: Uint8Array,
	fg: Float32Array,
	w: number,
	h: number,
) {
	const lbl = new Int8Array(w * h);
	const band = pyRound(h * 0.06);
	const top0 = pyRound(h * 0.12);
	const y80 = pyRound(h * 0.8);
	const d = (x: number, y: number) => {
		const a = ((y - 3) * w + x) * 3;
		const b = ((y + 1) * w + x) * 3;
		return (
			Math.abs(rgb[a] - rgb[b]) +
			Math.abs(rgb[a + 1] - rgb[b + 1]) +
			Math.abs(rgb[a + 2] - rgb[b + 2])
		);
	};
	for (let x = 0; x < w; x++) {
		let stop = -1;
		for (let y = 3; y < h - 1; y++) {
			if (fg[y * w + x] > F03) break;
			if (d(x, y) > 40) {
				stop = y;
				break;
			}
		}
		const top = stop < 0 ? top0 : stop;
		for (let y = 0; y < Math.max(0, top - 2); y++) lbl[y * w + x] = 1;
		if (h * 0.04 < stop && stop < h * 0.85)
			for (let y = stop + 3; y < Math.min(h, stop + 3 + band); y++)
				lbl[y * w + x] = -1;
		for (let y = y80; y < h; y++) lbl[y * w + x] = -1;
	}
	return lbl;
}

/** scipy.ndimage.uniform_filter(a, 2r+1, mode="nearest") on float64, axis 0 then axis 1. */
export function boxNearest(a: Float64Array, w: number, h: number, r: number) {
	const size = 2 * r + 1;
	const s1 = Math.floor(size / 2);
	const s2 = size - s1 - 1;
	const pass = (
		src: Float64Array,
		len: number,
		lines: number,
		at: (line: number, i: number) => number,
	) => {
		const out = new Float64Array(src.length);
		const buf = new Float64Array(len + size);
		for (let l = 0; l < lines; l++) {
			for (let i = -s1; i < len + s2; i++)
				buf[i + s1] = src[at(l, Math.min(len - 1, Math.max(0, i)))];
			let tmp = 0;
			for (let i = 0; i < size; i++) tmp += buf[i];
			out[at(l, 0)] = tmp / size;
			for (let i = 1; i < len; i++) {
				tmp += buf[i + s1 + s2] - buf[i - 1];
				out[at(l, i)] = tmp / size;
			}
		}
		return out;
	};
	const a0 = pass(a, h, w, (x, y) => y * w + x);
	return pass(a0, w, h, (y, x) => y * w + x);
}

/** align.ts fitSkyModel → P(sky), box-blurred r = 1, float32. */
export function fitSky(
	rgb: Uint8Array,
	fg: Float32Array,
	lbl: Int8Array,
	w: number,
	h: number,
) {
	const NB = BINS ** 3;
	const n = w * h;
	const bin = new Int32Array(n);
	const hs = new Float64Array(NB);
	const ht = new Float64Array(NB);
	for (let i = 0; i < n; i++) {
		const q = (c: number) => Math.min(BINS - 1, Math.floor((c * BINS) / 256));
		const b =
			(q(rgb[i * 3]) * BINS + q(rgb[i * 3 + 1])) * BINS + q(rgb[i * 3 + 2]);
		bin[i] = b;
		if (fg[i] <= F03) {
			if (lbl[i] > 0) hs[b]++;
			else if (lbl[i] < 0) ht[b]++;
		}
	}
	let ns = 0;
	let nt = 0;
	for (let b = 0; b < NB; b++) {
		ns += hs[b];
		nt += ht[b];
	}
	const aS = (ns / NB) * 2 + 1e-3;
	const aT = (nt / NB) * 2 + 1e-3;
	const S = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		const b = bin[i];
		const ps = (hs[b] + aS) / (ns + aS * NB);
		const pt = (ht[b] + aT) / (nt + aT * NB);
		S[i] = Math.fround(fg[i] > F03 ? 0.5 : ps / (ps + pt));
	}
	return Float32Array.from(boxNearest(S, w, h, 1));
}

/** Per-pixel integrand of scorePose: (0.5·edge + above − below)·(1 − fg), float32. */
export function scoreMap(
	E: Float32Array,
	sky: Float32Array,
	fg: Float32Array,
	w: number,
	h: number,
	fine: boolean,
) {
	const band = Math.max(2, pyRound(h * 0.035));
	const gap = Math.max(1, pyRound(h * (fine ? 0.006 : 0.012)));
	const cum = new Float64Array((h + 1) * w);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++)
			cum[(y + 1) * w + x] = cum[y * w + x] + sky[y * w + x];
	const clip = (v: number) => Math.min(h, Math.max(0, v));
	const out = new Float32Array(w * h);
	for (let y = 0; y < h; y++) {
		const a0 = clip(y - gap - band);
		const a1 = clip(y - gap);
		const b0 = clip(y + gap);
		const b1 = clip(y + gap + band);
		for (let x = 0; x < w; x++) {
			const above =
				a1 > a0
					? (cum[a1 * w + x] - cum[a0 * w + x]) / Math.max(a1 - a0, 1)
					: 0.5;
			const below =
				b1 > b0
					? (cum[b1 * w + x] - cum[b0 * w + x]) / Math.max(b1 - b0, 1)
					: 0.5;
			const i = y * w + x;
			out[i] = (0.5 * E[i] + (above - below)) * Math.fround(1 - fg[i]);
		}
	}
	return out;
}

/** Max elevation (deg) per azimuth bin (deg, 0 = north, clockwise); null when < 10 bins are hit. */
export function horizonProfile(
	azDeg: Float64Array,
	elDeg: Float64Array,
	step: number,
): Float64Array | null {
	const n = pyRound(360 / step);
	const prof = new Float64Array(n).fill(Number.NEGATIVE_INFINITY);
	for (let i = 0; i < azDeg.length; i++) {
		const k = imod(Math.floor(azDeg[i] / step), n);
		if (elDeg[i] > prof[k]) prof[k] = elDeg[i];
	}
	const gi: number[] = [];
	for (let i = 0; i < n; i++) if (Number.isFinite(prof[i])) gi.push(i);
	if (gi.length < 10) return null;
	// np.interp(idx, r_[gi − n, gi, gi + n], tile(prof[good], 3))
	const xp: number[] = [];
	const fp: number[] = [];
	for (const o of [-n, 0, n])
		for (const g of gi) {
			xp.push(g + o);
			fp.push(prof[g]);
		}
	for (let i = 0; i < n; i++) {
		if (Number.isFinite(prof[i])) continue;
		let lo = 0;
		let hi = xp.length - 1;
		while (hi - lo > 1) {
			const m = (lo + hi) >> 1;
			if (xp[m] <= i) lo = m;
			else hi = m;
		}
		const slope = (fp[lo + 1] - fp[lo]) / (xp[lo + 1] - xp[lo]);
		prof[i] = slope * (i - xp[lo]) + fp[lo];
	}
	return prof;
}

/** project_rel's camera constants for (pitch, roll, vfov) (all degrees). */
export function camera(
	pitch: number,
	roll: number,
	vfov: number,
	aspect: number,
) {
	const p = pitch * RAD;
	const r = roll * RAD;
	const fx = 0.0;
	const fy = Math.cos(p);
	const fz = Math.sin(p);
	const u0y = -Math.sin(p);
	const u0z = Math.cos(p);
	const cr = Math.cos(r);
	const sr = Math.sin(r);
	const rx = 1.0 * cr - 0.0 * sr;
	const ry = 0.0 * cr - u0y * sr;
	const rz = 0.0 * cr - u0z * sr;
	const ux = 0.0 * cr + 1.0 * sr;
	const uy = u0y * cr + 0.0 * sr;
	const uz = u0z * cr + 0.0 * sr;
	const t = Math.tan((vfov * RAD) / 2);
	return { fx, fy, fz, rx, ry, rz, ux, uy, uz, t, ta: t * aspect };
}
export type Camera = ReturnType<typeof camera>;

export type GridPlan = {
	vfovs: number[];
	pitches: number[];
	rolls: number[];
	pstep: number;
	astep: number;
	/** profile bins per 360° (= `total` in the coverage factor) */
	n: number;
	/** yaw index stride in profile bins */
	sy: number;
	nYaw: number;
	prof: Float64Array;
	/** per vfov: sample offsets ja (bins) are −half..half */
	halfBins: number[];
	cntMin: number;
	/** combos in the grid's loop order (vfov → pitch → roll) */
	combos: {
		vi: number;
		pitch: number;
		roll: number;
		cam: Camera;
		covDen: number;
	}[];
};

export type GridResult = {
	/** best coarse score per yaw (float64, as skyglobal's `best` after the first update) */
	best: Float64Array;
	/** winning combo index per yaw */
	arg: Int32Array;
	ms: number;
};

export class SkyGlobal {
	readonly w: number;
	readonly h: number;
	readonly aspect: number;
	readonly fg: Float32Array;
	readonly sky: Float32Array;
	readonly Sc: Float32Array;
	readonly Sf: Float32Array;
	readonly nDirs: number;
	/** per horizon dir: degrees(atan2(x, y)) (unwrapped) and degrees(asin(clip(z))) */
	readonly azRaw: Float64Array;
	readonly el: Float64Array;
	private readonly sinE: Float64Array;
	private readonly cosE: Float64Array;
	private buf = new Float32Array(0);
	/** score_pose evaluations since construction (profiling) */
	evals = 0;

	constructor(ed: EdgeInputs, aspect: number) {
		const { w, h } = ed;
		this.w = w;
		this.h = h;
		this.aspect = aspect;
		this.fg = ed.fg;
		const lbl = scanLabels(ed.rgb, ed.fg, w, h);
		this.sky = fitSky(ed.rgb, ed.fg, lbl, w, h);
		this.Sc = scoreMap(ed.coarse, this.sky, ed.fg, w, h, false);
		this.Sf = scoreMap(ed.fine, this.sky, ed.fg, w, h, true);
		const nd = ed.dirs.length / 3;
		this.nDirs = nd;
		this.azRaw = new Float64Array(nd);
		this.el = new Float64Array(nd);
		this.sinE = new Float64Array(nd);
		this.cosE = new Float64Array(nd);
		for (let i = 0; i < nd; i++) {
			this.azRaw[i] = Math.atan2(ed.dirs[i * 3], ed.dirs[i * 3 + 1]) * DEG;
			this.el[i] =
				Math.asin(Math.min(1, Math.max(-1, ed.dirs[i * 3 + 2]))) * DEG;
			const e = this.el[i] * RAD;
			this.sinE[i] = Math.sin(e);
			this.cosE[i] = Math.cos(e);
		}
	}

	/** Exact app score for one pose (fine or coarse map), on the raw horizonDirs. */
	scorePose(pose: Pose, fine = true): number {
		this.evals++;
		const c = camera(pose.pitch, pose.roll, pose.vfov, this.aspect);
		const S = fine ? this.Sf : this.Sc;
		const { w, h } = this;
		if (this.buf.length < this.nDirs) this.buf = new Float32Array(this.nDirs);
		const buf = this.buf;
		let n = 0;
		for (let i = 0; i < this.nDirs; i++) {
			const a = (this.azRaw[i] - pose.yaw) * RAD;
			const ce = this.cosE[i];
			const dx = Math.sin(a) * ce;
			const dy = Math.cos(a) * ce;
			const dz = this.sinE[i];
			const z = dx * c.fx + dy * c.fy + dz * c.fz;
			if (!(z > 0.1)) continue;
			const u = 0.5 + (dx * c.rx + dy * c.ry + dz * c.rz) / z / c.ta / 2;
			const v = 0.5 - (dx * c.ux + dy * c.uy + dz * c.uz) / z / c.t / 2;
			if (!(u >= 0.01 && u <= 0.99 && v >= 0.01 && v <= 0.99)) continue;
			buf[n++] = S[Math.floor(v * h) * w + Math.floor(u * w)];
		}
		if (n <= 20) return 0.0;
		const s = pairwiseSumF32(buf, 0, n);
		const cov = Math.min(
			n / this.nDirs / (((pose.vfov * this.aspect) / 360) * 0.6),
			1,
		);
		return (s / n) * cov;
	}

	/** search()'s grid parameters and grid()'s derived constants (profile, yaws, combos). */
	plan(
		vfov0: number,
		focalKnown: boolean,
		pitchRange = 15.0,
		rollRange = 9.0,
		ystep0 = 0.5,
	): GridPlan | null {
		const aspect = this.aspect;
		const vfovs = focalKnown
			? [0.94, 1.0, 1.06].map((s) => vfov0 * s)
			: [35, 45, 55, 65, 75].map((hf) =>
					twoDeg(Math.atan(Math.tan((hf * RAD) / 2) / aspect)),
				);
		const pstep = Math.max(0.5, Math.min(1.5, Math.min(...vfovs) / 30));
		const pitches = arangeF(-pitchRange, pitchRange + 1e-9, pstep);
		const rolls = arangeF(-rollRange, rollRange + 1e-9, 1.5);
		const vmax = Math.max(...vfovs);
		const hmax = twoDeg(Math.atan(Math.tan((vmax * RAD) / 2) * aspect));
		const astep = Math.max(0.1, Math.min(0.5, hmax / 120));
		const ystep = Math.max(astep, pyRound(ystep0 / astep) * astep);
		const az = new Float64Array(this.nDirs);
		for (let i = 0; i < this.nDirs; i++) az[i] = fmodPos(this.azRaw[i], 360);
		const prof = horizonProfile(az, this.el, astep);
		if (!prof) return null;
		const n = prof.length;
		const sy = pyRound(ystep / astep);
		const nYaw = Math.ceil(n / sy);
		const halfBins: number[] = [];
		const combos: GridPlan["combos"] = [];
		vfovs.forEach((vf, vi) => {
			const hf = twoDeg(Math.atan(Math.tan((vf * RAD) / 2) * aspect));
			const half = (hf / 2) * 1.25 + 3;
			halfBins.push(Math.trunc(half / astep));
			const covDen = ((vf * aspect) / 360) * 0.6;
			for (const p of pitches)
				for (const r of rolls)
					combos.push({
						vi,
						pitch: p,
						roll: r,
						cam: camera(p, r, vf, aspect),
						covDen,
					});
		});
		return {
			vfovs,
			pitches,
			rolls,
			pstep,
			astep,
			n,
			sy,
			nYaw,
			prof,
			halfBins,
			cntMin: Math.max(3, 0.9 / astep),
			combos,
		};
	}

	/** Per-plan sample tables: sin/cos of the relative azimuths per vfov, sin/cos of the profile. */
	tables(g: GridPlan) {
		const sinA: Float64Array[] = [];
		const cosA: Float64Array[] = [];
		for (const hb of g.halfBins) {
			const na = 2 * hb + 1;
			const s = new Float64Array(na);
			const c = new Float64Array(na);
			for (let j = 0; j < na; j++) {
				const a = (j - hb) * g.astep * RAD;
				s[j] = Math.sin(a);
				c[j] = Math.cos(a);
			}
			sinA.push(s);
			cosA.push(c);
		}
		const sinP = new Float64Array(g.n);
		const cosP = new Float64Array(g.n);
		for (let i = 0; i < g.n; i++) {
			const e = g.prof[i] * RAD;
			sinP[i] = Math.sin(e);
			cosP[i] = Math.cos(e);
		}
		return { sinA, cosA, sinP, cosP };
	}

	/** The exact coarse score of one grid cell (yaw index iy, combo index ci), as grid() computes it. */
	cellScore(
		g: GridPlan,
		T: ReturnType<SkyGlobal["tables"]>,
		iy: number,
		ci: number,
	): number {
		const cb = g.combos[ci];
		const c = cb.cam;
		const hb = g.halfBins[cb.vi];
		const na = 2 * hb + 1;
		const sA = T.sinA[cb.vi];
		const cA = T.cosA[cb.vi];
		const { w, h } = this;
		const S = this.Sc;
		if (this.buf.length < na) this.buf = new Float32Array(na);
		const val = this.buf;
		const y0 = iy * g.sy - hb;
		let cnt = 0;
		for (let j = 0; j < na; j++) {
			const k = imod(y0 + j, g.n);
			const ce = T.cosP[k];
			const dx = sA[j] * ce;
			const dy = cA[j] * ce;
			const dz = T.sinP[k];
			const z = dx * c.fx + dy * c.fy + dz * c.fz;
			const zs = z > 0.1 ? z : 1.0;
			const u = 0.5 + (dx * c.rx + dy * c.ry + dz * c.rz) / zs / c.ta / 2;
			const v = 0.5 - (dx * c.ux + dy * c.uy + dz * c.uz) / zs / c.t / 2;
			if (z > 0.1 && u >= 0.01 && u <= 0.99 && v >= 0.01 && v <= 0.99) {
				const x = Math.min(w - 1, Math.max(0, Math.floor(u * w)));
				const y = Math.min(h - 1, Math.max(0, Math.floor(v * h)));
				val[j] = S[y * w + x];
				cnt++;
			} else val[j] = 0;
		}
		if (!(cnt > g.cntMin)) return 0.0;
		const cov = Math.min(cnt / g.n / g.combos[ci].covDen, 1);
		return (pairwiseSumF32(val, 0, na) / Math.max(cnt, 1)) * cov;
	}

	/** grid(): every combo × every yaw on the coarse map; optionally keeps the full [combo][yaw] grid. */
	gridCpu(g: GridPlan, full?: Float64Array): GridResult {
		const t0 = performance.now();
		const T = this.tables(g);
		const best = new Float64Array(g.nYaw).fill(Number.NEGATIVE_INFINITY);
		const arg = new Int32Array(g.nYaw);
		for (let ci = 0; ci < g.combos.length; ci++)
			for (let iy = 0; iy < g.nYaw; iy++) {
				const sc = this.cellScore(g, T, iy, ci);
				if (full) full[ci * g.nYaw + iy] = sc;
				if (sc > best[iy]) {
					best[iy] = sc;
					arg[iy] = ci;
				}
			}
		return { best, arg, ms: performance.now() - t0 };
	}

	/** Local maxima over yaw, NMS, at most 2k peaks; start poses carry skyglobal's float32 `arg`. */
	peaks(
		g: GridPlan,
		r: GridResult,
		vfov0: number,
		k: number,
		nmsDeg?: number,
	): Peak[] {
		const hf0 = twoDeg(Math.atan(Math.tan((vfov0 * RAD) / 2) * this.aspect));
		const nms = nmsDeg || Math.max(3.0, 0.25 * hf0);
		const n = g.nYaw;
		const { best } = r;
		const yaw = (i: number) => i * g.sy * g.astep;
		// np.argsort(−best): ties are not ordered by numpy's quicksort; here by index (stable)
		const order = Array.from({ length: n }, (_, i) => i).sort(
			(a, b) => best[b] - best[a] || a - b,
		);
		const peaks: Peak[] = [];
		const f = Math.fround;
		for (const i of order) {
			if (!Number.isFinite(best[i]) || best[i] <= 0) break;
			if (!(best[i] >= best[imod(i - 1, n)] && best[i] >= best[imod(i + 1, n)]))
				continue;
			if (
				peaks.every(
					(q) => Math.abs(fmodPos(yaw(i) - q.yaw + 540, 360) - 180) >= nms,
				)
			) {
				const cb = g.combos[r.arg[i]];
				peaks.push({
					yaw: yaw(i),
					vfov: f(g.vfovs[cb.vi]),
					pitch: f(cb.pitch),
					roll: f(cb.roll),
					coarse: best[i],
				});
			}
			if (peaks.length >= 2 * k) break;
		}
		return peaks;
	}

	/** align.ts refine (coordinate descent, halving steps); optional focal penalty as autoAlign. */
	refine(
		start: Pose,
		vfovPrior: number | null,
		vfovSigma: number,
		fine = true,
	): [Pose, number] {
		const f = (p: Pose) => {
			let s = this.scorePose(p, fine);
			if (vfovPrior)
				s -= 0.1 * ((p.vfov - vfovPrior) / (vfovPrior * vfovSigma)) ** 2;
			return s;
		};
		let best: Pose = { ...start };
		let steps: Pose = {
			yaw: 0.4,
			pitch: 0.4,
			roll: 0.8,
			vfov: start.vfov * 0.02,
		};
		let cur = f(best);
		const keys = ["yaw", "pitch", "roll", "vfov"] as const;
		for (let it = 0; it < 60; it++) {
			let improved = false;
			for (const key of keys)
				for (const sg of [1, -1]) {
					const p = { ...best, [key]: best[key] + sg * steps[key] };
					const s = f(p);
					if (s > cur) {
						cur = s;
						best = p;
						improved = true;
					}
				}
			if (!improved) {
				steps = {
					yaw: steps.yaw / 2,
					pitch: steps.pitch / 2,
					roll: steps.roll / 2,
					vfov: steps.vfov / 2,
				};
				if (steps.yaw < 0.01) break;
			}
		}
		return [best, cur];
	}

	/** search()'s polish of the peaks: coarse then fine refine, sort, 1° dedupe, top k. */
	polish(peaks: Peak[], vfov0: number, focalKnown: boolean, k: number): Hyp[] {
		const prior = focalKnown ? vfov0 : null;
		const hyps: Hyp[] = [];
		for (const pk of peaks) {
			const st = { yaw: pk.yaw, pitch: pk.pitch, roll: pk.roll, vfov: pk.vfov };
			const [p1] = this.refine(st, prior, 0.08, false);
			const [p2, s2] = this.refine(p1, prior, 0.08, true);
			hyps.push({ pose: p2, score: s2, coarse: pk.coarse });
		}
		hyps.sort((a, b) => b.score - a.score); // Python's sort is stable, so is Array.sort
		const out: Hyp[] = [];
		for (const hy of hyps)
			if (
				out.every(
					(q) =>
						Math.abs(fmodPos(hy.pose.yaw - q.pose.yaw + 540, 360) - 180) >= 1.0,
				)
			)
				out.push(hy);
		return out.slice(0, k);
	}

	/** SkyGlobal.search with the CPU grid. */
	search(vfov0: number, focalKnown: boolean, k = 6) {
		const g = this.plan(vfov0, focalKnown);
		if (!g) throw new Error("skyglobal: horizon profile has < 10 bins");
		const r = this.gridCpu(g);
		const t0 = performance.now();
		const pk = this.peaks(g, r, vfov0, k);
		const hyps = this.polish(pk, vfov0, focalKnown, k);
		return {
			hyps,
			peaks: pk,
			gridMs: r.ms,
			refineMs: performance.now() - t0,
			plan: g,
			grid: r,
		};
	}
}
