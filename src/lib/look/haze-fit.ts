// Fit the photo's aerial perspective against the rendered range buffer.
// Koschmieder per channel: I = J·t + A(1 − t), t = exp(−β·d). Unlike blind dehazing, the
// range d is known for every pixel, so this is a small regression:
//   A   airlight from the photo's own sky in a band just above the skyline (robust median)
//   I_low(d)  dark-object intensity per log-range bin (5th percentile per channel)
//   β_c free per-channel fit (golden-section on log β, closed-form J0 with a grey prior)
//   physical fit: Rayleigh multiplier × Mie sea-level extinction (× Mie scale height) on the
//     same altitude-aware optical depth the shader uses, so the render reproduces the photo
// Everything runs on the geometry buffer's grid (photo box-resampled onto it), ~50 ms at 1024².

import { srgbToLinear } from "../style/color";
import {
	ATM_CURV,
	type AtmosphereParams,
	atmPath,
	BETA_M0,
	BETA_R0,
	H_M,
	H_R,
	MIE_G,
	type Vec3,
} from "./atmosphere";
import { sunColor } from "./sun";

export type SkyMask = {
	width: number;
	height: number;
	data: Uint8Array | Uint8ClampedArray;
};

export type HazeGeo =
	| { kind: "xyzr"; data: Float32Array }
	| { kind: "range"; data: Float32Array; ray: (x: number, y: number) => Vec3 };

export type HazeFitInput = {
	/** sRGB photo, row 0 = top (ImageData or anything shaped like it). */
	photo: {
		width: number;
		height: number;
		data: Uint8ClampedArray | Uint8Array;
	};
	/**
	 * Geometry buffer, row 0 = bottom, range 0 = sky. 'xyzr': RGBA = ENU xyz, range (three). 'range':
	 * one float per pixel (deck's r32f); xyz = eye + ray(x, y)·range, (x, y) the buffer pixel, eye (0, 0, eyeAlt).
	 */
	geo: HazeGeo;
	geoW: number;
	geoH: number;
	/** P(sky)·255, row 0 = top. Without it, sky = range 0. */
	sky?: SkyMask | null;
	/** Foreground occluders the DEM doesn't know (people): P(fg)·255, row 0 = top. Excluded. */
	foreground?: SkyMask | null;
	/** Eye altitude ASL (m); the eye sits at ENU (0, 0, eyeAlt). */
	eyeAlt: number;
	/** Sun direction for the returned params (only sets sunDir / sunColor). */
	sunDir?: Vec3;
};

export type HazeSample = {
	/** Median range of the bin, m. */
	range: number;
	n: number;
	/** Dark-object (low-percentile) linear intensity. */
	low: Vec3;
	/** Model prediction from the physical fit. */
	fit: Vec3;
	/** Sea-level-equivalent Rayleigh / Mie path lengths (bin mean), m. */
	pathR: number;
	pathM: number;
};

export type HazeFit = AtmosphereParams & {
	/** Free per-channel extinction on plain range, 1/m. */
	beta: Vec3;
	/** Dark-object radiance J0 (linear). */
	j0: Vec3;
	/** Multipliers of the physical fit relative to the defaults (BETA_R0, BETA_M0). */
	rayleighScale: number;
	mieScale: number;
	/** Koschmieder visibility at the eye from the physical fit (green), m. */
	visibility: number;
	/** 0..1 from range span, bin count and residual. */
	quality: number;
	/** RMS residual of the physical fit, linear intensity. */
	rms: number;
	samples: HazeSample[];
};

const NBINS = 24;
const DMIN = 200;
const DMAX = 150000;
const H_M_CANDIDATES = [600, 900, 1200, 1800, 2700, 4000];

const SRGB_LUT = (() => {
	const t = new Float32Array(256);
	for (let i = 0; i < 256; i++) t[i] = srgbToLinear(i / 255);
	return t;
})();

function percentile(a: Float32Array, n: number, q: number) {
	const s = a.subarray(0, n).slice().sort();
	const x = q * (n - 1);
	const i = Math.floor(x);
	return i + 1 < n ? s[i] + (s[i + 1] - s[i]) * (x - i) : s[i];
}

export function fitHaze(input: HazeFitInput): HazeFit {
	const { photo, geo, geoW: W, geoH: H, sky, foreground: fg, eyeAlt } = input;
	const N = W * H;
	// ENU point of top-down pixel i
	const pointAt = (i: number): Vec3 => {
		const gx = i % W;
		const gy = H - 1 - Math.floor(i / W);
		if (geo.kind === "xyzr") {
			const g = (gy * W + gx) * 4;
			return [geo.data[g], geo.data[g + 1], geo.data[g + 2]];
		}
		const r = geo.data[gy * W + gx];
		const d = geo.ray(gx, gy);
		return [d[0] * r, d[1] * r, eyeAlt + d[2] * r];
	};

	// --- photo → geo grid (box filter over each geo pixel's footprint), linear; row 0 = top
	const lin = new Float32Array(N * 3);
	const sx = photo.width / W;
	const sy = photo.height / H;
	for (let y = 0; y < H; y++) {
		const y0 = Math.floor(y * sy);
		const y1 = Math.max(
			y0 + 1,
			Math.min(photo.height, Math.floor((y + 1) * sy)),
		);
		for (let x = 0; x < W; x++) {
			const x0 = Math.floor(x * sx);
			const x1 = Math.max(
				x0 + 1,
				Math.min(photo.width, Math.floor((x + 1) * sx)),
			);
			let r = 0;
			let g = 0;
			let b = 0;
			for (let yy = y0; yy < y1; yy++)
				for (let xx = x0; xx < x1; xx++) {
					const k = (yy * photo.width + xx) * 4;
					r += SRGB_LUT[photo.data[k]];
					g += SRGB_LUT[photo.data[k + 1]];
					b += SRGB_LUT[photo.data[k + 2]];
				}
			const w = 1 / ((y1 - y0) * (x1 - x0));
			const o = (y * W + x) * 3;
			lin[o] = r * w;
			lin[o + 1] = g * w;
			lin[o + 2] = b * w;
		}
	}

	// range and sky probability on the same grid, row 0 = top
	const range = new Float32Array(N);
	const pSky = new Float32Array(N);
	for (let y = 0; y < H; y++) {
		const gy = H - 1 - y;
		for (let x = 0; x < W; x++)
			range[y * W + x] =
				geo.kind === "xyzr"
					? geo.data[(gy * W + x) * 4 + 3]
					: geo.data[gy * W + x];
	}
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const i = y * W + x;
			if (sky) {
				const mx = Math.min(
					sky.width - 1,
					Math.floor(((x + 0.5) * sky.width) / W),
				);
				const my = Math.min(
					sky.height - 1,
					Math.floor(((y + 0.5) * sky.height) / H),
				);
				pSky[i] = sky.data[my * sky.width + mx] / 255;
			} else pSky[i] = range[i] > 0 ? 0 : 1;
		}

	// --- airlight: bright sky 20–60 px (at 1024 wide) above the terrain boundary, per column
	const pxScale = W / 1024;
	const a0 = Math.max(2, Math.round(20 * pxScale));
	const a1 = Math.max(a0 + 2, Math.round(60 * pxScale));
	const skyR: number[] = [];
	const skyG: number[] = [];
	const skyB: number[] = [];
	const skyL: number[] = [];
	for (let x = 0; x < W; x += 2) {
		// topmost terrain row (terrain: range > 0 and not sky in the mask)
		let top = -1;
		for (let y = 0; y < H; y++) {
			const i = y * W + x;
			if (range[i] > 0 && pSky[i] < 0.5) {
				top = y;
				break;
			}
		}
		if (top < 0) continue;
		for (let y = Math.max(0, top - a1); y <= top - a0; y++) {
			const i = y * W + x;
			if (range[i] > 0 || pSky[i] < 0.7) continue;
			skyR.push(lin[i * 3]);
			skyG.push(lin[i * 3 + 1]);
			skyB.push(lin[i * 3 + 2]);
			skyL.push(
				0.2126 * lin[i * 3] + 0.7152 * lin[i * 3 + 1] + 0.0722 * lin[i * 3 + 2],
			);
		}
	}
	const airlight = robustSky(skyR, skyG, skyB, skyL, lin, range);

	// --- terrain pixels away from depth edges (pose error smears them across ranges)
	const edge = new Uint8Array(N);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const i = y * W + x;
			const r = range[i];
			if (r <= 0) {
				edge[i] = 1;
				continue;
			}
			const nb = [
				x > 0 ? range[i - 1] : r,
				x < W - 1 ? range[i + 1] : r,
				y > 0 ? range[i - W] : r,
				y < H - 1 ? range[i + W] : r,
			];
			for (const q of nb)
				if (q <= 0 || Math.abs(Math.log(q / r)) > 0.12) edge[i] = 1;
		}
	const rad = Math.max(1, Math.round(3 * pxScale));
	const near = dilate(edge, W, H, rad);
	if (fg) {
		// people (soft mask edges, hair): threshold low and dilate generously
		const m = new Uint8Array(N);
		for (let y = 0; y < H; y++)
			for (let x = 0; x < W; x++) {
				const mx = Math.min(
					fg.width - 1,
					Math.floor(((x + 0.5) * fg.width) / W),
				);
				const my = Math.min(
					fg.height - 1,
					Math.floor(((y + 0.5) * fg.height) / H),
				);
				m[y * W + x] = fg.data[my * fg.width + mx] > 64 ? 1 : 0;
			}
		const d = dilate(m, W, H, Math.max(2, Math.round(8 * pxScale)));
		for (let i = 0; i < N; i++) near[i] |= d[i];
	}

	// --- log-range bins
	const lo = Math.log(DMIN);
	const span = Math.log(DMAX) - lo;
	const counts = new Int32Array(NBINS);
	const bin = new Int16Array(N).fill(-1);
	for (let i = 0; i < N; i++) {
		const r = range[i];
		if (r < Math.max(150, DMIN) || r >= DMAX || near[i] || pSky[i] > 0.3)
			continue;
		const b = Math.floor(((Math.log(r) - lo) / span) * NBINS);
		bin[i] = b;
		counts[b]++;
	}
	let total = 0;
	for (const c of counts) total += c;
	const minCount = Math.max(40, Math.round(total * 0.002));

	const samples: HazeSample[] = [];
	const pathMs: number[][] = [];
	// per bin and channel, up to REPS representative (pathR, pathM[H_M candidates]) tuples from the
	// dark subset: the model averages transmittance over them (mean of exp, not exp of mean path)
	const REPS = 24;
	const NH = H_M_CANDIDATES.length;
	const reps: Float64Array[][] = [[], [], []];
	// pixel indices grouped by bin (counting sort)
	const start = new Int32Array(NBINS + 1);
	for (let b = 0; b < NBINS; b++) start[b + 1] = start[b] + counts[b];
	const fill = start.slice(0, NBINS);
	const order = new Int32Array(total);
	for (let i = 0; i < N; i++) if (bin[i] >= 0) order[fill[bin[i]]++] = i;
	const val = new Float32Array(N);
	for (let b = 0; b < NBINS; b++) {
		const n = counts[b];
		if (n < minCount) continue;
		// dark objects, per channel: the ~5th-percentile tail (1st–9th pct) of that channel. Colour,
		// range and path are averaged over that same subset, which keeps the fit consistent: dark pixels
		// in a bin are biased toward shorter optical paths, so pairing a percentile with the bin's mean
		// path would bias β low. (A shared dark-channel subset breaks on saturated objects: a blue sign
		// has a dark red channel but a bright blue one.)
		const low: Vec3 = [0, 0, 0];
		const binReps: Float64Array[] = [];
		let logR = 0;
		let pR = 0;
		const pM = H_M_CANDIDATES.map(() => 0);
		let mG = 0;
		let ok = true;
		for (let c = 0; c < 3; c++) {
			for (let k = 0; k < n; k++) val[k] = lin[order[start[b] + k] * 3 + c];
			const v0 = percentile(val, n, 0.01);
			const v1 = percentile(val, n, 0.09);
			let sel = 0;
			for (let k = 0; k < n; k++) if (val[k] >= v0 && val[k] <= v1) sel++;
			const stride = Math.max(1, Math.floor(sel / REPS));
			const rep = new Float64Array(Math.min(REPS, sel) * (1 + NH));
			let nr = 0;
			let m = 0;
			for (let k = 0; k < n; k++) {
				if (val[k] < v0 || val[k] > v1) continue;
				const i = order[start[b] + k];
				low[c] += val[k];
				const keep = m % stride === 0 && nr * (1 + NH) < rep.length;
				m++;
				if (!keep && c !== 1) continue;
				const [px, py, pz] = pointAt(i);
				const h1 = pz + (px * px + py * py) * ATM_CURV;
				const r0 = atmPath(eyeAlt, h1, range[i], H_R);
				if (keep) rep[nr * (1 + NH)] = r0;
				for (let q = 0; q < NH; q++) {
					const v = atmPath(eyeAlt, h1, range[i], H_M_CANDIDATES[q]);
					if (keep) rep[nr * (1 + NH) + 1 + q] = v;
					if (c === 1) pM[q] += v;
				}
				if (keep) nr++;
				if (c === 1) {
					logR += Math.log(range[i]);
					pR += r0;
				}
			}
			if (m < 5) ok = false;
			low[c] /= Math.max(1, m);
			if (c === 1) mG = m;
			binReps.push(rep.subarray(0, nr * (1 + NH)));
		}
		if (!ok) continue;
		for (let c = 0; c < 3; c++) reps[c].push(binReps[c]);
		samples.push({
			range: Math.exp(logR / mG),
			n,
			low,
			fit: [0, 0, 0],
			pathR: pR / mG,
			pathM: 0,
		});
		pathMs.push(pM.map((v) => v / mG));
	}

	const sunDir: Vec3 = input.sunDir ?? [-0.5, -0.4, 0.75];
	if (samples.length < 3) {
		// nothing to fit: physical defaults with the photo's airlight
		return {
			betaR: [...BETA_R0],
			betaM: BETA_M0,
			hR: H_R,
			hM: H_M,
			airlight,
			sunDir,
			sunColor: sunColor(sunDir),
			mieG: MIE_G,
			strength: 1,
			airlightMix: 1,
			beta: [0, 0, 0],
			j0: [0.03, 0.03, 0.03],
			rayleighScale: 1,
			mieScale: 1,
			visibility: 3.912 / (BETA_R0[1] + BETA_M0),
			quality: 0,
			rms: 0,
			samples,
		};
	}

	const w0 = samples.map((s) => Math.sqrt(s.n));
	const ds = samples.map((s) => s.range);
	const Ic = [0, 1, 2].map((c) => samples.map((s) => s.low[c]));

	// --- free per-channel β on plain range (J0 shared up to a grey prior), Cauchy IRLS
	const beta: Vec3 = [0, 0, 0];
	const j0: Vec3 = [0, 0, 0];
	const wc = [0, 1, 2].map(() => w0.slice());
	let jBar = -1;
	for (let pass = 0; pass < 4; pass++) {
		const res: number[][] = [];
		for (let c = 0; c < 3; c++) {
			const I = Ic[c];
			const lam = jBar < 0 ? 0 : 0.5 * sum(wc[c]);
			const cost = (lb: number) => {
				const bt = Math.exp(lb);
				const t = ds.map((d) => Math.exp(-bt * d));
				const J = solveJ0(I, t, wc[c], airlight[c], lam, jBar);
				return { err: sse(I, t, wc[c], airlight[c], J), J, t };
			};
			const lb = minimise1D(
				(x) => cost(x).err,
				Math.log(1e-7),
				Math.log(1e-3),
				64,
			);
			const r = cost(lb);
			beta[c] = Math.exp(lb);
			j0[c] = r.J;
			res.push(
				I.map((v, i) => v - (r.J * r.t[i] + airlight[c] * (1 - r.t[i]))),
			);
		}
		jBar = (j0[0] + j0[1] + j0[2]) / 3;
		reweight(res, w0, wc);
	}

	// --- physical fit: τ_c = kR·β_R0,c·pathR + β_M·pathM(H_M), J0 per channel (grey prior)
	//     grid over (kR, β_M, H_M), then Cauchy IRLS with coordinate refinement in log space
	const wp = [0, 1, 2].map(() => w0.slice());
	const lam = 0.1 * sum(w0);
	const evalPhys = (kR: number, bM: number, hk: number) => {
		let err = 0;
		const J: number[] = [];
		const T: number[][] = [];
		for (let c = 0; c < 3; c++) {
			const bR = kR * BETA_R0[c];
			const t = reps[c].map((rep) => {
				let acc = 0;
				const nr = rep.length / (1 + NH);
				for (let k = 0; k < nr; k++)
					acc += Math.exp(
						-bR * rep[k * (1 + NH)] - bM * rep[k * (1 + NH) + 1 + hk],
					);
				return acc / nr;
			});
			T.push(t);
			J.push(solveJ0(Ic[c], t, wp[c], airlight[c], lam, jBar));
			err += sse(Ic[c], t, wp[c], airlight[c], J[c]);
		}
		// weak priors: Rayleigh near physical, Mie scale height near 1.2 km
		const prior =
			sum(wp[1]) *
			1e-5 *
			(Math.log(kR) ** 2 * 0.5 + 8 * Math.log2(H_M_CANDIDATES[hk] / H_M) ** 2);
		return { err: err + prior, raw: err, J, T };
	};
	let best = { kR: 1, bM: BETA_M0, hk: 2, err: Number.POSITIVE_INFINITY };
	for (let hk = 0; hk < NH; hk++)
		for (let a = 0; a <= 24; a++) {
			const kR = Math.exp(Math.log(0.25) + (a / 24) * Math.log(40 / 0.25));
			for (let b = 0; b <= 36; b++) {
				const bM = Math.exp(Math.log(1e-7) + (b / 36) * Math.log(3e-2 / 1e-7));
				const e = evalPhys(kR, bM, hk).err;
				if (e < best.err) best = { kR, bM, hk, err: e };
			}
		}
	for (let pass = 0; pass < 4; pass++) {
		if (pass > 0) {
			// reweight from the current fit's residuals, then re-optimise from there (all H_M)
			const cur = evalPhys(best.kR, best.bM, best.hk);
			reweight(
				[0, 1, 2].map((c) =>
					Ic[c].map(
						(v, i) =>
							v - (cur.J[c] * cur.T[c][i] + airlight[c] * (1 - cur.T[c][i])),
					),
				),
				w0,
				wp,
			);
			let b2 = { ...best, err: Number.POSITIVE_INFINITY };
			for (let hk = 0; hk < NH; hk++) {
				const e = evalPhys(best.kR, best.bM, hk).err;
				if (e < b2.err) b2 = { ...best, hk, err: e };
			}
			best = b2;
		}
		let stepR = Math.log(40 / 0.25) / 24;
		let stepM = Math.log(3e-2 / 1e-7) / 36;
		for (let it = 0; it < 24; it++) {
			const { kR, bM, hk } = best;
			for (const [dr, dm] of [
				[1, 0],
				[-1, 0],
				[0, 1],
				[0, -1],
				[1, 1],
				[-1, -1],
				[1, -1],
				[-1, 1],
			]) {
				const k2 = Math.min(40, Math.max(0.25, kR * Math.exp(dr * stepR)));
				const b2 = Math.min(3e-2, Math.max(1e-7, bM * Math.exp(dm * stepM)));
				const e = evalPhys(k2, b2, hk).err;
				if (e < best.err) best = { kR: k2, bM: b2, hk, err: e };
			}
			if (best.kR === kR && best.bM === bM) {
				stepR /= 2;
				stepM /= 2;
			}
		}
	}
	const fin = evalPhys(best.kR, best.bM, best.hk);
	const hM = H_M_CANDIDATES[best.hk];
	samples.forEach((s, i) => {
		s.pathM = pathMs[i][best.hk];
		s.fit = [0, 1, 2].map(
			(c) => fin.J[c] * fin.T[c][i] + airlight[c] * (1 - fin.T[c][i]),
		) as Vec3;
	});

	// --- quality: range span × bin coverage × residual relative to the haze contrast
	// residual under the robust weights (outlier bins don't count), and the inlier fraction
	const rms = Math.sqrt(fin.raw / (sum(wp[0]) + sum(wp[1]) + sum(wp[2])));
	const inliers = (sum(wp[0]) + sum(wp[1]) + sum(wp[2])) / (3 * sum(w0));
	const contrast = Math.max(
		1e-3,
		(airlight[0] + airlight[1] + airlight[2]) / 3 -
			(fin.J[0] + fin.J[1] + fin.J[2]) / 3,
	);
	const spanQ = Math.min(
		1,
		Math.log10(ds[ds.length - 1] / ds[0]) / Math.log10(30),
	);
	const binQ = Math.min(1, (samples.length * inliers) / 10);
	const resQ = Math.exp(-4 * (rms / contrast));
	// haze that never visibly builds up over the range span is poorly constrained
	const tFar = fin.T[1][fin.T[1].length - 1];
	const haveQ = Math.min(1, (1 - tFar) / 0.15);
	const quality = Math.max(
		0,
		Math.min(1, spanQ * binQ * resQ * (0.5 + 0.5 * haveQ)),
	);

	const eyeR = BETA_R0[1] * best.kR * Math.exp(-eyeAlt / H_R);
	const eyeM = best.bM * Math.exp(-eyeAlt / hM);
	return {
		betaR: [BETA_R0[0] * best.kR, BETA_R0[1] * best.kR, BETA_R0[2] * best.kR],
		betaM: best.bM,
		hR: H_R,
		hM,
		airlight,
		sunDir,
		sunColor: sunColor(sunDir),
		mieG: MIE_G,
		strength: 1,
		airlightMix: 1,
		beta,
		j0: [fin.J[0], fin.J[1], fin.J[2]],
		rayleighScale: best.kR,
		mieScale: best.bM / BETA_M0,
		visibility: 3.912 / (eyeR + eyeM),
		quality,
		rms,
		samples,
	};
}

/** Median of the brighter half of the sky band; falls back to all sky, then a default. */
export function robustSky(
	r: number[],
	g: number[],
	b: number[],
	l: number[],
	lin: Float32Array,
	range: Float32Array,
): Vec3 {
	if (r.length < 20) {
		// no skyline band: any range-0 pixels
		r = [];
		g = [];
		b = [];
		l = [];
		for (let i = 0; i < range.length; i++)
			if (range[i] <= 0) {
				r.push(lin[i * 3]);
				g.push(lin[i * 3 + 1]);
				b.push(lin[i * 3 + 2]);
				l.push(
					0.2126 * lin[i * 3] +
						0.7152 * lin[i * 3 + 1] +
						0.0722 * lin[i * 3 + 2],
				);
			}
		if (r.length < 20) return [0.62, 0.7, 0.8];
	}
	const thr = [...l].sort((x, y) => x - y)[Math.floor(l.length * 0.4)];
	const pick = (a: number[]) => {
		const s = a.filter((_, i) => l[i] >= thr).sort((x, y) => x - y);
		return s[Math.floor(s.length / 2)];
	};
	return [pick(r), pick(g), pick(b)];
}

export function sum(a: number[]) {
	let s = 0;
	for (const v of a) s += v;
	return s;
}

/** Cauchy IRLS weights: w = w0 / (1 + (r / 2.5σ)²), σ from the MAD of all residuals (≥ 0.01). */
export function reweight(res: number[][], w0: number[], out: number[][]) {
	const abs = res
		.flat()
		.map(Math.abs)
		.sort((a, b) => a - b);
	const sigma = Math.max(0.01, 1.4826 * abs[Math.floor(abs.length / 2)]);
	for (let c = 0; c < res.length; c++)
		for (let i = 0; i < w0.length; i++)
			out[c][i] = w0[i] / (1 + (res[c][i] / (2.5 * sigma)) ** 2);
}

/** Closed-form J0 for I = J·t + A(1 − t) with weights and an optional prior λ(J − J̄)². */
export function solveJ0(
	I: number[],
	t: number[],
	w: number[],
	A: number,
	lam: number,
	jBar: number,
) {
	let num = 0;
	let den = 0;
	for (let i = 0; i < I.length; i++) {
		num += w[i] * t[i] * (I[i] - A * (1 - t[i]));
		den += w[i] * t[i] * t[i];
	}
	if (jBar >= 0) {
		num += lam * jBar;
		den += lam;
	}
	const J = den > 1e-12 ? num / den : 0;
	return Math.max(0, Math.min(A, J));
}

export function sse(
	I: number[],
	t: number[],
	w: number[],
	A: number,
	J: number,
) {
	let e = 0;
	for (let i = 0; i < I.length; i++) {
		const r = I[i] - (J * t[i] + A * (1 - t[i]));
		e += w[i] * r * r;
	}
	return e;
}

/** Grid scan then golden-section refinement around the best cell. */
export function minimise1D(
	f: (x: number) => number,
	a: number,
	b: number,
	n: number,
) {
	let bi = 0;
	let bv = Number.POSITIVE_INFINITY;
	for (let i = 0; i <= n; i++) {
		const v = f(a + ((b - a) * i) / n);
		if (v < bv) {
			bv = v;
			bi = i;
		}
	}
	let lo = a + ((b - a) * Math.max(0, bi - 1)) / n;
	let hi = a + ((b - a) * Math.min(n, bi + 1)) / n;
	const gr = (Math.sqrt(5) - 1) / 2;
	let x1 = hi - gr * (hi - lo);
	let x2 = lo + gr * (hi - lo);
	let f1 = f(x1);
	let f2 = f(x2);
	for (let it = 0; it < 40; it++) {
		if (f1 < f2) {
			hi = x2;
			x2 = x1;
			f2 = f1;
			x1 = hi - gr * (hi - lo);
			f1 = f(x1);
		} else {
			lo = x1;
			x1 = x2;
			f1 = f2;
			x2 = lo + gr * (hi - lo);
			f2 = f(x2);
		}
	}
	return (lo + hi) / 2;
}

/** Binary dilation with a (2r+1)² square, separable. */
function dilate(m: Uint8Array, W: number, H: number, r: number) {
	const tmp = new Uint8Array(m.length);
	const out = new Uint8Array(m.length);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			let v = 0;
			for (let k = Math.max(0, x - r); k <= Math.min(W - 1, x + r) && !v; k++)
				v = m[y * W + k];
			tmp[y * W + x] = v;
		}
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			let v = 0;
			for (let k = Math.max(0, y - r); k <= Math.min(H - 1, y + r) && !v; k++)
				v = tmp[k * W + x];
			out[y * W + x] = v;
		}
	return out;
}
