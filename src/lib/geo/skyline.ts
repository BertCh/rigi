/**
 * Photo skyline detector (dependency-free baseline).
 *
 * 1. Features: colour, local texture, and a vertical colour step ("edge")
 *    that is discounted when it gets brighter going down.
 * 2. Sky model: a smooth colour field (low-order polynomial in x, y per
 *    channel) fitted by robust least squares to sky-looking pixels near the
 *    top. A pixel is sky if it matches the field, or is brighter/greyer than
 *    it (cloud). Haze makes distant ridges sky-*coloured* but darker than the
 *    sky extrapolated to that spot, which is what separates them.
 * 3. Per-column boundary by Viterbi over rows: cost at row y is "non-sky in a
 *    band above y" + "sky in a band below y" − "edge at y", with a
 *    truncated-L1 penalty on jumps between columns. y = 0 means "no sky at
 *    the top of this column" (tree, roof), which yields NaN.
 * 4. The sky model is refitted to the sky just above the boundary and the
 *    Viterbi pass repeated.
 * 5. Per-column weight: edge contrast × polarity (darker below) × sky above /
 *    terrain below, then zeroed for short isolated runs and spikes that stick
 *    up above the local median.
 */

import { clamp01, smoothstep } from "../math";

export interface RGBALike {
	width: number;
	height: number;
	data: Uint8ClampedArray | Uint8Array;
}

export interface SkylineObservation {
	/** Working image size (display frame). */
	width: number;
	height: number;
	/**
	 * Per column: y (px, float) of the sky→non-sky boundary scanning from the
	 * top; NaN if the column has no usable boundary.
	 */
	rows: Float32Array;
	/** Per column 0..1 confidence. */
	weight: Float32Array;
	/** Per-pixel sky probability 0..255 (width*height). */
	sky?: Uint8Array;
}

export interface SkylineOptions {
	/** Sky-model refits (each followed by another Viterbi pass). */
	refinePasses?: number;
	/** Rows below the boundary that are penalised for looking like sky. */
	belowBand?: number;
	/** Rows above the boundary that are fully penalised for looking unlike sky. */
	aboveBand?: number;
	/** Weight of the colour-step (edge) term, in pixel units. */
	edgeWeight?: number;
	/** Smoothness: cost per pixel of vertical jump between columns. */
	jumpCost?: number;
	/** Smoothness: maximum cost of a jump (truncation). */
	jumpCap?: number;
	/** Columns with weight below this are reported as NaN. */
	minWeight?: number;
	/** Return the per-pixel sky probability map (default true). */
	returnSky?: boolean;
}

/** Separable box blur of a single-channel image, radius r (in place-safe). */
function boxBlur(src: Float32Array, w: number, h: number, r: number) {
	const tmp = new Float32Array(w * h);
	const out = new Float32Array(w * h);
	for (let y = 0; y < h; y++) {
		const o = y * w;
		let acc = 0;
		for (let x = -r; x <= r; x++)
			acc += src[o + Math.min(w - 1, Math.max(0, x))];
		for (let x = 0; x < w; x++) {
			tmp[o + x] = acc / (2 * r + 1);
			acc += src[o + Math.min(w - 1, x + r + 1)] - src[o + Math.max(0, x - r)];
		}
	}
	for (let x = 0; x < w; x++) {
		let acc = 0;
		for (let y = -r; y <= r; y++)
			acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
		for (let y = 0; y < h; y++) {
			out[y * w + x] = acc / (2 * r + 1);
			acc +=
				tmp[Math.min(h - 1, y + r + 1) * w + x] -
				tmp[Math.max(0, y - r) * w + x];
		}
	}
	return out;
}

interface Features {
	r: Float32Array;
	g: Float32Array;
	b: Float32Array;
	/** Local texture: blurred gradient magnitude of luminance. */
	tex: Float32Array;
	/** Vertical colour step at each pixel (rows above vs below), discounted
	 * when it gets brighter going down. */
	edge: Float32Array;
	/** Signed luminance step, above minus below (positive = darker below). */
	step: Float32Array;
}

const BRIGHTENING_EDGE = 0.4;

function computeFeatures(img: RGBALike): Features {
	const { width: w, height: h, data } = img;
	const n = w * h;
	const r0 = new Float32Array(n);
	const g0 = new Float32Array(n);
	const b0 = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		r0[i] = data[4 * i] / 255;
		g0[i] = data[4 * i + 1] / 255;
		b0[i] = data[4 * i + 2] / 255;
	}
	// Light denoise so JPEG blocks and grain don't count as texture.
	const r = boxBlur(r0, w, h, 1);
	const g = boxBlur(g0, w, h, 1);
	const b = boxBlur(b0, w, h, 1);

	const grad = new Float32Array(n);
	for (let y = 1; y < h - 1; y++) {
		for (let x = 1; x < w - 1; x++) {
			const i = y * w + x;
			const lx =
				0.3 * (r[i + 1] - r[i - 1]) +
				0.59 * (g[i + 1] - g[i - 1]) +
				0.11 * (b[i + 1] - b[i - 1]);
			const ly =
				0.3 * (r[i + w] - r[i - w]) +
				0.59 * (g[i + w] - g[i - w]) +
				0.11 * (b[i + w] - b[i - w]);
			grad[i] = Math.hypot(lx, ly);
		}
	}
	const tex = boxBlur(grad, w, h, 3);

	// Vertical colour step: mean of 3 rows above vs 3 rows at/below, over a
	// 5-column window so single-pixel noise and thin wires matter less.
	// Terrain is almost always darker than the sky above it, so edges that
	// get brighter going down (cloud undersides over haze) are discounted.
	const k = 3;
	const edge = new Float32Array(n);
	const step = new Float32Array(n);
	const lw = [0.3, 0.59, 0.11];
	const cs = [
		boxBlurH(r0, w, h, 2),
		boxBlurH(g0, w, h, 2),
		boxBlurH(b0, w, h, 2),
	];
	for (let x = 0; x < w; x++) {
		for (let y = k; y < h - k; y++) {
			let d2 = 0;
			let dl = 0;
			for (let c = 0; c < 3; c++) {
				const ch = cs[c];
				let up = 0;
				let dn = 0;
				for (let j = 1; j <= k; j++) {
					up += ch[(y - j) * w + x];
					dn += ch[(y + j - 1) * w + x];
				}
				const d = (up - dn) / k;
				d2 += d * d;
				dl += lw[c] * d;
			}
			const i = y * w + x;
			step[i] = dl;
			edge[i] = Math.sqrt(d2) * (dl > 0 ? 1 : BRIGHTENING_EDGE);
		}
	}
	return { r, g, b, tex, edge, step };
}

function boxBlurH(src: Float32Array, w: number, h: number, r: number) {
	const out = new Float32Array(w * h);
	for (let y = 0; y < h; y++) {
		const o = y * w;
		let acc = 0;
		for (let x = -r; x <= r; x++)
			acc += src[o + Math.min(w - 1, Math.max(0, x))];
		for (let x = 0; x < w; x++) {
			out[o + x] = acc / (2 * r + 1);
			acc += src[o + Math.min(w - 1, x + r + 1)] - src[o + Math.max(0, x - r)];
		}
	}
	return out;
}

/** Hand-made sky prior: blue & bright, or bright & unsaturated; smooth. */
function heuristicSky(f: Features, n: number) {
	const s = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		const r = f.r[i];
		const g = f.g[i];
		const b = f.b[i];
		const l = 0.3 * r + 0.59 * g + 0.11 * b;
		const mx = Math.max(r, g, b);
		const mn = Math.min(r, g, b);
		const sat = mx > 0 ? (mx - mn) / mx : 0;
		const blue = smoothstep(0.02, 0.12, b - r) * smoothstep(-0.02, 0.04, b - g);
		const blueSky = blue * smoothstep(0.15, 0.4, l);
		// Clouds are bright and grey/white; their soft edges carry some texture.
		const cloud =
			smoothstep(0.5, 0.7, l) *
			(1 - smoothstep(0.15, 0.3, sat)) *
			(1 - smoothstep(0.04, 0.12, f.tex[i]));
		const green = smoothstep(0.0, 0.06, g - b);
		const smooth = 1 - smoothstep(0.015, 0.05, f.tex[i]);
		s[i] = Math.max(blueSky * smooth, cloud) * (1 - green);
	}
	return s;
}

/** Low-order polynomial basis in normalised image coordinates. */
const NB = 8;
function basis(u: number, v: number, out: Float64Array) {
	out[0] = 1;
	out[1] = u;
	out[2] = v;
	out[3] = u * u;
	out[4] = u * v;
	out[5] = v * v;
	// Sky brightens quickly toward the horizon: allow a cubic profile in v.
	out[6] = v * v * v;
	out[7] = u * v * v;
}

/** Solves the symmetric system A x = b (NB×NB) by Gaussian elimination. */
function solve(a: Float64Array, b: Float64Array) {
	const m = new Float64Array(a);
	const x = new Float64Array(b);
	for (let c = 0; c < NB; c++) {
		let p = c;
		for (let r = c + 1; r < NB; r++)
			if (Math.abs(m[r * NB + c]) > Math.abs(m[p * NB + c])) p = r;
		for (let k = 0; k < NB; k++) {
			const t = m[c * NB + k];
			m[c * NB + k] = m[p * NB + k];
			m[p * NB + k] = t;
		}
		[x[c], x[p]] = [x[p], x[c]];
		const d = m[c * NB + c] || 1e-12;
		for (let r = c + 1; r < NB; r++) {
			const f = m[r * NB + c] / d;
			for (let k = c; k < NB; k++) m[r * NB + k] -= f * m[c * NB + k];
			x[r] -= f * x[c];
		}
	}
	for (let c = NB - 1; c >= 0; c--) {
		let s = x[c];
		for (let k = c + 1; k < NB; k++) s -= m[c * NB + k] * x[k];
		x[c] = s / (m[c * NB + c] || 1e-12);
	}
	return x;
}

/**
 * Sky model: a smooth colour gradient (quadratic in x, y per channel) fitted
 * by iteratively reweighted least squares to the pixels currently believed to
 * be sky. Aerial haze makes distant ridges sky-*coloured*, but they are
 * darker than the sky gradient extrapolated to that spot, which is the cue
 * this model exposes.
 */
interface SkyModel {
	coef: Float64Array[]; // per channel, NB coefficients
	sigma: number;
}

function fitSkyModel(
	f: Features,
	w: number,
	h: number,
	seedWeight: (x: number, y: number, i: number) => number,
): SkyModel | undefined {
	const step = 4;
	const phi = new Float64Array(NB);
	const ch = [f.r, f.g, f.b];
	let coef: Float64Array[] | undefined;
	let sigma = 0.1;
	for (let iter = 0; iter < 4; iter++) {
		const ata = new Float64Array(NB * NB);
		const atb = [0, 1, 2].map(() => new Float64Array(NB));
		let wsum = 0;
		let r2sum = 0;
		for (let y = 0; y < h; y += step) {
			for (let x = 0; x < w; x += step) {
				const i = y * w + x;
				let wt = seedWeight(x, y, i);
				if (wt <= 0) continue;
				basis(x / w - 0.5, y / h - 0.5, phi);
				if (coef) {
					// Cauchy reweighting against the current fit.
					let r2 = 0;
					for (let c = 0; c < 3; c++) {
						let p = 0;
						for (let k = 0; k < NB; k++) p += coef[c][k] * phi[k];
						r2 += (ch[c][i] - p) ** 2;
					}
					wt /= 1 + r2 / (sigma * sigma);
					r2sum += wt * r2;
				}
				wsum += wt;
				for (let j = 0; j < NB; j++) {
					for (let k = j; k < NB; k++) ata[j * NB + k] += wt * phi[j] * phi[k];
					for (let c = 0; c < 3; c++) atb[c][j] += wt * phi[j] * ch[c][i];
				}
			}
		}
		if (wsum < 20) return coef ? { coef, sigma } : undefined;
		for (let j = 0; j < NB; j++)
			for (let k = 0; k < j; k++) ata[j * NB + k] = ata[k * NB + j];
		for (let j = 0; j < NB; j++) ata[j * NB + j] += 1e-3 * wsum;
		coef = atb.map((b) => solve(ata, b));
		if (iter > 0)
			sigma = Math.max(0.015, Math.min(0.05, Math.sqrt(r2sum / wsum)));
	}
	return coef ? { coef, sigma } : undefined;
}

/**
 * Sky probability from the sky model: close to the local sky colour, or
 * brighter and greyer than it (cloud); darker or more coloured is terrain.
 */
function modelSky(f: Features, w: number, h: number, m: SkyModel) {
	const s = new Float32Array(w * h);
	const sig2 = (2 * m.sigma) ** 2;
	// Per row the basis collapses to a quadratic in u: p = a + b u + c u².
	const rowPoly = (k: Float64Array, v: number) => [
		k[0] + k[2] * v + k[5] * v * v + k[6] * v * v * v,
		k[1] + k[4] * v + k[7] * v * v,
		k[3],
	];
	for (let y = 0; y < h; y++) {
		const v = y / h - 0.5;
		const [ar, br, qr] = rowPoly(m.coef[0], v);
		const [ag, bg, qg] = rowPoly(m.coef[1], v);
		const [ab, bb, qb] = rowPoly(m.coef[2], v);
		for (let x = 0; x < w; x++) {
			const i = y * w + x;
			const u = x / w - 0.5;
			const pr = ar + u * (br + u * qr);
			const pg = ag + u * (bg + u * qg);
			const pb = ab + u * (bb + u * qb);
			const dr = f.r[i] - pr;
			const dg = f.g[i] - pg;
			const db = f.b[i] - pb;
			const dl = (dr + dg + db) / 3;
			const chroma2 = (dr - dl) ** 2 + (dg - dl) ** 2 + (db - dl) ** 2;
			const mx = Math.max(f.r[i], f.g[i], f.b[i]);
			const sat = mx > 0 ? (mx - Math.min(f.r[i], f.g[i], f.b[i])) / mx : 0;
			const pmx = Math.max(pr, pg, pb, 1e-3);
			const psat = (pmx - Math.min(pr, pg, pb)) / pmx;
			let p = Math.exp(-(dl * dl + chroma2) / sig2);
			// Clouds: greyer than the sky behind them (white tops, grey
			// undersides). Haze over terrain goes the other way: darker and at
			// least as saturated as the sky.
			const grey =
				smoothstep(0.0, 0.08, psat - sat) * smoothstep(0.45, 0.6, mx);
			if (dl > 0) p = Math.max(p, grey, 0.2);
			else p = Math.max(p, grey * (1 - smoothstep(0.08, 0.2, -dl)));
			const green = smoothstep(0.0, 0.06, f.g[i] - f.b[i]);
			const smooth = 1 - smoothstep(0.03, 0.1, f.tex[i]);
			s[i] = p * smooth * (1 - green);
		}
	}
	return s;
}

const FAR_ABOVE = 0.2;

/**
 * Viterbi over rows. Returns the boundary row per column (0 = no sky at the
 * top, h = the whole column is sky).
 */
function viterbi(
	sky: Float32Array,
	edge: Float32Array,
	w: number,
	h: number,
	o: Required<Omit<SkylineOptions, "returnSky" | "minWeight" | "refinePasses">>,
) {
	const ns = h + 1;
	const unary = new Float32Array(ns);
	const cum = new Float32Array(ns); // Σ_{r<y} (1 - s)
	const cumS = new Float32Array(ns); // Σ_{r<y} s
	let prev = new Float32Array(ns);
	let cur = new Float32Array(ns);
	const back = new Int32Array(w * ns);
	const fwd = new Float32Array(ns);
	const fwdArg = new Int32Array(ns);
	const band = o.belowBand;
	const top = 2; // ignore the extreme top rows' edge response

	for (let x = 0; x < w; x++) {
		cum[0] = 0;
		cumS[0] = 0;
		for (let y = 0; y < h; y++) {
			const s = sky[y * w + x];
			cum[y + 1] = cum[y] + (1 - s);
			cumS[y + 1] = cumS[y] + s;
		}
		for (let y = 0; y <= h; y++) {
			const below = cumS[Math.min(h, y + band)] - cumS[y];
			const e = y > top && y < h ? edge[y * w + x] : 0;
			// Non-sky just above the boundary counts fully; far above only
			// partly, so blue gaps between high clouds don't drag it upward.
			const y0 = Math.max(0, y - o.aboveBand);
			const above = cum[y] - cum[y0] + FAR_ABOVE * cum[y0];
			unary[y] = above + below - o.edgeWeight * Math.min(e, 0.35);
		}
		if (x === 0) {
			prev.set(unary);
			continue;
		}
		// Truncated L1 distance transform of prev, with argmins.
		for (let y = 0; y < ns; y++) {
			fwd[y] = prev[y];
			fwdArg[y] = y;
		}
		for (let y = 1; y < ns; y++) {
			const c = fwd[y - 1] + o.jumpCost;
			if (c < fwd[y]) {
				fwd[y] = c;
				fwdArg[y] = fwdArg[y - 1];
			}
		}
		for (let y = ns - 2; y >= 0; y--) {
			const c = fwd[y + 1] + o.jumpCost;
			if (c < fwd[y]) {
				fwd[y] = c;
				fwdArg[y] = fwdArg[y + 1];
			}
		}
		let gmin = Infinity;
		let garg = 0;
		for (let y = 0; y < ns; y++) {
			if (prev[y] < gmin) {
				gmin = prev[y];
				garg = y;
			}
		}
		const off = x * ns;
		for (let y = 0; y < ns; y++) {
			let best = fwd[y];
			let arg = fwdArg[y];
			if (gmin + o.jumpCap < best) {
				best = gmin + o.jumpCap;
				arg = garg;
			}
			cur[y] = best + unary[y];
			back[off + y] = arg;
		}
		[prev, cur] = [cur, prev];
	}
	const bound = new Int32Array(w);
	let best = Infinity;
	for (let y = 0; y < ns; y++) {
		if (prev[y] < best) {
			best = prev[y];
			bound[w - 1] = y;
		}
	}
	for (let x = w - 1; x > 0; x--) bound[x - 1] = back[x * ns + bound[x]];
	return bound;
}

export function detectSkyline(
	img: RGBALike,
	opts: SkylineOptions = {},
): SkylineObservation {
	const { width: w, height: h } = img;
	const o = {
		belowBand: opts.belowBand ?? Math.max(8, Math.round(h * 0.15)),
		aboveBand: opts.aboveBand ?? Math.max(8, Math.round(h * 0.2)),
		edgeWeight: opts.edgeWeight ?? 60,
		jumpCost: opts.jumpCost ?? 2,
		jumpCap: opts.jumpCap ?? 80,
	};
	const refinePasses = opts.refinePasses ?? 1;
	const minWeight = opts.minWeight ?? 0.1;

	const f = computeFeatures(img);
	const prior = heuristicSky(f, w * h);
	// Seed the sky model from sky-coloured, smooth pixels, favouring the top.
	let sky = prior;
	const seed = fitSkyModel(f, w, h, (_x, y, i) => {
		const t = 1 - y / h;
		return prior[i] * t ** 6;
	});
	if (seed) sky = modelSky(f, w, h, seed);
	let bound = viterbi(sky, f.edge, w, h, o);
	for (let p = 0; p < refinePasses; p++) {
		// Refit to the sky just above the boundary, which is what the
		// boundary has to be discriminated against.
		const m = fitSkyModel(f, w, h, (x, y, i) => {
			const d = bound[x] - y;
			return d > 4 ? (0.2 + prior[i]) * (d < o.aboveBand ? 1 : 0.2) : 0;
		});
		if (!m) break;
		sky = modelSky(f, w, h, m);
		bound = viterbi(sky, f.edge, w, h, o);
	}

	const rows = new Float32Array(w).fill(Number.NaN);
	const weight = new Float32Array(w);
	const win = 12;
	for (let x = 0; x < w; x++) {
		const yb = bound[x];
		if (yb < win + 2 || yb > h - win) continue;
		// Sub-pixel: parabola through the edge response around the boundary.
		const e0 = f.edge[(yb - 1) * w + x];
		const e1 = f.edge[yb * w + x];
		const e2 = f.edge[(yb + 1) * w + x];
		const den = e0 - 2 * e1 + e2;
		const dy =
			den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (e0 - e2)) / den)) : 0;
		rows[x] = yb + dy;

		// Sky-likeness just above vs just below (skipping the blurred edge).
		let sAbove = 0;
		let sBelow = 0;
		for (let j = 3; j < win + 3; j++) {
			sAbove += sky[(yb - j) * w + x];
			sBelow += sky[Math.min(h - 1, yb + j - 2) * w + x];
		}
		sAbove /= win;
		sBelow /= win;
		const contrast = smoothstep(0.03, 0.15, e1);
		const polarity = 0.2 + 0.8 * smoothstep(-0.02, 0.03, f.step[yb * w + x]);
		weight[x] =
			contrast * polarity * smoothstep(0.3, 0.8, sAbove) * (1 - sBelow);
	}

	// Continuity: split into runs at jumps; short runs (cloud fragments,
	// wires, posts) and short runs sticking up above both neighbours (heads,
	// spikes) are down-weighted.
	const jumpTol = Math.max(3, 0.012 * h);
	let start = 0;
	for (let x = 1; x <= w; x++) {
		const breaks =
			x === w ||
			Number.isNaN(rows[x]) !== Number.isNaN(rows[x - 1]) ||
			Math.abs(rows[x] - rows[x - 1]) > jumpTol;
		if (!breaks) continue;
		if (!Number.isNaN(rows[start])) {
			const len = x - start;
			let factor = smoothstep(0.01 * w, 0.06 * w, len);
			const left = start > 0 ? rows[start - 1] : Number.NaN;
			const right = x < w ? rows[x] : Number.NaN;
			let top = Infinity;
			for (let j = start; j < x; j++) top = Math.min(top, rows[j]);
			const higherThan = (v: number) => Number.isNaN(v) || v - top > 0.03 * h;
			if (len < 0.12 * w && higherThan(left) && higherThan(right)) factor = 0;
			for (let j = start; j < x; j++) weight[j] *= factor;
		}
		start = x;
	}
	// Trend: columns sticking up well above the median of their confident
	// neighbourhood (cloud edges, posts, heads) lose weight.
	const median = (xs: number[]) => {
		xs.sort((a, b) => a - b);
		return xs.length ? xs[xs.length >> 1] : Number.NaN;
	};
	const confident: number[] = [];
	for (let x = 0; x < w; x++)
		if (weight[x] >= minWeight) confident.push(rows[x]);
	const globalTrend = median(confident);
	const rad = Math.round(0.1 * w);
	const trend = new Float32Array(w);
	const buf: number[] = [];
	for (let x = 0; x < w; x++) {
		buf.length = 0;
		for (let j = Math.max(0, x - rad); j <= Math.min(w - 1, x + rad); j++)
			if (weight[j] >= minWeight) buf.push(rows[j]);
		trend[x] = buf.length > rad / 2 ? median(buf) : globalTrend;
	}
	for (let x = 0; x < w; x++) {
		const up = (trend[x] - rows[x]) / h;
		if (up > 0) weight[x] *= 1 - smoothstep(0.05, 0.12, up);
		if (weight[x] < minWeight) rows[x] = Number.NaN;
		if (Number.isNaN(rows[x])) weight[x] = 0;
	}

	const out: SkylineObservation = { width: w, height: h, rows, weight };
	if (opts.returnSky !== false) {
		const s8 = new Uint8Array(w * h);
		for (let i = 0; i < w * h; i++) s8[i] = Math.round(clamp01(sky[i]) * 255);
		out.sky = s8;
	}
	return out;
}
