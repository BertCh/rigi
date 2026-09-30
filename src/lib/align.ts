// Pose refinement.
//  1. Skyline alignment: the DEM horizon (a set of ENU directions, independent of rotation)
//     is projected into the photo for a candidate pose and scored against a blurred photo
//     edge map. Coarse grid over yaw/pitch, then coordinate descent over yaw/pitch/roll/fov.
//  2. Pin solve: Levenberg–Marquardt on user "this peak is here" pins.
import { type Pose, poseBasis, projectPoint } from "./camera";
import { gaussJordan } from "./linalg";

export type EdgeMap = {
	w: number;
	h: number;
	coarse: Float32Array;
	fine: Float32Array;
	/** P(sky) per pixel from a per-photo colour model (0.5 where unknown, e.g. people) */
	sky: Float32Array;
	/** column-wise prefix sums of `sky`, (h+1) rows, for O(1) band means */
	skyCum: Float32Array;
	rgb: Uint8ClampedArray;
	fg: Float32Array;
};

function boxBlur(src: Float32Array, w: number, h: number, r: number) {
	const tmp = new Float32Array(src.length);
	const out = new Float32Array(src.length);
	const k = 2 * r + 1;
	for (let y = 0; y < h; y++) {
		let acc = 0;
		for (let x = -r; x <= r; x++)
			acc += src[y * w + Math.min(Math.max(x, 0), w - 1)];
		for (let x = 0; x < w; x++) {
			tmp[y * w + x] = acc / k;
			acc +=
				src[y * w + Math.min(x + r + 1, w - 1)] -
				src[y * w + Math.max(x - r, 0)];
		}
	}
	for (let x = 0; x < w; x++) {
		let acc = 0;
		for (let y = -r; y <= r; y++)
			acc += tmp[Math.min(Math.max(y, 0), h - 1) * w + x];
		for (let y = 0; y < h; y++) {
			out[y * w + x] = acc / k;
			acc +=
				tmp[Math.min(y + r + 1, h - 1) * w + x] -
				tmp[Math.max(y - r, 0) * w + x];
		}
	}
	return out;
}

type FgMask = { width: number; height: number; data: Uint8Array };

/** Edge map tuned for sky/terrain boundaries: luminance + "blueness" gradients, sky-above favoured. */
export function buildEdgeMap(
	img: HTMLImageElement | ImageBitmap,
	width = 512,
	fgMask?: FgMask | null,
): EdgeMap {
	const w = width;
	const h = Math.round((width * img.height) / img.width);
	const c = document.createElement("canvas");
	c.width = w;
	c.height = h;
	const ctx = c.getContext("2d", {
		willReadFrequently: true,
	}) as CanvasRenderingContext2D;
	ctx.drawImage(img, 0, 0, w, h);
	const d = ctx.getImageData(0, 0, w, h).data;
	const fg = new Float32Array(w * h);
	if (fgMask)
		for (let y = 0; y < h; y++)
			for (let x = 0; x < w; x++) {
				const mx = Math.min(
					fgMask.width - 1,
					Math.floor((x / w) * fgMask.width),
				);
				const my = Math.min(
					fgMask.height - 1,
					Math.floor((y / h) * fgMask.height),
				);
				fg[y * w + x] = fgMask.data[my * fgMask.width + mx] / 255;
			}
	const L = new Float32Array(w * h);
	const B = new Float32Array(w * h);
	for (let i = 0; i < w * h; i++) {
		const r = d[i * 4];
		const g = d[i * 4 + 1];
		const b = d[i * 4 + 2];
		L[i] = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
		B[i] = b / (r + g + b + 1);
	}
	const E = new Float32Array(w * h);
	for (let y = 2; y < h - 2; y++)
		for (let x = 1; x < w - 1; x++) {
			const i = y * w + x;
			const gy = L[i - 2 * w] - L[i + 2 * w];
			const gx = L[i + 1] - L[i - 1];
			const by = B[i - 2 * w] - B[i + 2 * w];
			// sky is usually brighter and bluer above the ridge; still accept either sign, weaker
			const oriented = Math.max(gy, 0) + 0.35 * Math.max(-gy, 0);
			E[i] = oriented + 0.5 * Math.abs(gx) + 2.0 * Math.max(by, 0);
		}
	// normalise by a high percentile so haze-faint skylines still count
	const sorted = Float32Array.from(E).sort();
	const p = sorted[Math.floor(sorted.length * 0.97)] || 1;
	for (let i = 0; i < E.length; i++)
		E[i] = Math.min(E[i] / p, 1.5) * (1 - fg[i]);
	const map: EdgeMap = {
		w,
		h,
		coarse: boxBlur(boxBlur(E, w, h, 5), w, h, 5),
		fine: boxBlur(E, w, h, 1),
		sky: new Float32Array(w * h),
		skyCum: new Float32Array(w * (h + 1)),
		rgb: new Uint8ClampedArray(d),
		fg,
	};
	fitSkyModel(map, scanLabels(map));
	return map;
}

/**
 * Pose-free sky/terrain labels. Scan each column down from the top until the colour jumps
 * (|RGB(y-3) − RGB(y+1)| summed > 40): everything above is sky (incl. clouds above the first
 * edge), and a band just below the stop is terrain, which teaches the model what snow and
 * distant haze look like. Bottom of the frame is terrain too.
 */
function scanLabels(map: EdgeMap, priorRows?: Float32Array) {
	const { w, h, rgb, fg } = map;
	const lbl = new Int8Array(w * h);
	const diff = (x: number, y0: number, y1: number) => {
		const i = (y0 * w + x) * 4;
		const j = (y1 * w + x) * 4;
		return (
			Math.abs(rgb[i] - rgb[j]) +
			Math.abs(rgb[i + 1] - rgb[j + 1]) +
			Math.abs(rgb[i + 2] - rgb[j + 2])
		);
	};
	const band = Math.round(h * 0.06);
	for (let x = 0; x < w; x++) {
		let stop = -1;
		for (let y = 3; y < h - 1; y++) {
			if (fg[y * w + x] > 0.3) break;
			if (diff(x, y - 3, y + 1) > 40) {
				stop = y;
				break;
			}
		}
		const top = stop < 0 ? Math.round(h * 0.12) : stop;
		for (let y = 0; y < top - 2; y++) lbl[y * w + x] = 1;
		// a stop far from where the prior pose puts the skyline is a cloud edge, not a ridge
		const plausible =
			!priorRows ||
			(priorRows[x] >= 0 && Math.abs(stop - priorRows[x]) < h * 0.1);
		if (plausible && stop > h * 0.04 && stop < h * 0.85)
			for (let y = stop + 3; y < Math.min(h, stop + 3 + band); y++)
				lbl[y * w + x] = -1;
		for (let y = Math.round(h * 0.8); y < h; y++) lbl[y * w + x] = -1;
	}
	return lbl;
}

const BINS = 12;
function colorBin(d: Uint8ClampedArray, i: number) {
	const q = (v: number) => Math.min(BINS - 1, Math.floor((v / 256) * BINS));
	return (q(d[i * 4]) * BINS + q(d[i * 4 + 1])) * BINS + q(d[i * 4 + 2]);
}

/** Fit sky/terrain colour histograms from labels (1 sky, -1 terrain, 0 unknown) → P(sky) map. */
export function fitSkyModel(map: EdgeMap, lbl: Int8Array) {
	const { w, h, rgb, fg } = map;
	const hs = new Float32Array(BINS ** 3);
	const ht = new Float32Array(BINS ** 3);
	let ns = 0;
	let nt = 0;
	for (let i = 0; i < w * h; i++) {
		if (fg[i] > 0.3) continue;
		const b = colorBin(rgb, i);
		if (lbl[i] > 0) {
			hs[b]++;
			ns++;
		} else if (lbl[i] < 0) {
			ht[b]++;
			nt++;
		}
	}
	// pseudo-counts proportional to class size: a colour seen in neither sample stays at 0.5
	const NB = BINS ** 3;
	const as = (ns / NB) * 2 + 1e-3;
	const at = (nt / NB) * 2 + 1e-3;
	const S = new Float32Array(w * h);
	for (let i = 0; i < w * h; i++) {
		const b = colorBin(rgb, i);
		const ps = (hs[b] + as) / (ns + as * NB);
		const pt = (ht[b] + at) / (nt + at * NB);
		S[i] = fg[i] > 0.3 ? 0.5 : ps / (ps + pt);
	}
	map.sky = boxBlur(S, w, h, 1);
	for (let x = 0; x < w; x++) {
		let acc = 0;
		map.skyCum[x] = 0;
		for (let y = 0; y < h; y++) {
			acc += map.sky[y * w + x];
			map.skyCum[(y + 1) * w + x] = acc;
		}
	}
}

/** Rendered skyline row per edge-map column for a pose (-1 where no horizon point projects). */
function skylineRows(
	p: Pose,
	aspect: number,
	dirs: Float32Array,
	map: EdgeMap,
) {
	const rows = new Float32Array(map.w).fill(Number.POSITIVE_INFINITY);
	forEachProjected(p, aspect, dirs, 1, (u, v) => {
		const x = Math.floor(u * map.w);
		if (x >= 0 && x < map.w) rows[x] = Math.min(rows[x], v * map.h);
	});
	for (let x = 0; x < map.w; x++) if (!Number.isFinite(rows[x])) rows[x] = -1;
	return rows;
}

function forEachProjected(
	p: Pose,
	aspect: number,
	dirs: Float32Array,
	stride: number,
	cb: (u: number, v: number) => void,
) {
	const b = poseBasis(p);
	const [fx, fy, fz] = b.forward;
	const [rx, ry, rz] = b.right;
	const [ux, uy, uz] = b.up;
	const t = Math.tan((p.vfov * D) / 2);
	for (let i = 0; i < dirs.length; i += 3 * stride) {
		const dx = dirs[i];
		const dy = dirs[i + 1];
		const dz = dirs[i + 2];
		const z = dx * fx + dy * fy + dz * fz;
		if (z <= 0.1) continue;
		const u = 0.5 + (dx * rx + dy * ry + dz * rz) / z / (t * aspect) / 2;
		const v = 0.5 - (dx * ux + dy * uy + dz * uz) / z / t / 2;
		if (u < 0.01 || u > 0.99 || v < 0.01 || v > 0.99) continue;
		cb(u, v);
	}
}

const D = Math.PI / 180;

/**
 * Score = along the projected DEM skyline, edge strength plus sky/terrain contrast
 * (P(sky) just above the line minus just below). Cloud edges have sky on both sides,
 * so only real skylines earn the contrast term.
 */
export function scorePose(
	p: Pose,
	aspect: number,
	dirs: Float32Array,
	edge: EdgeMap,
	fine: boolean,
	stride = 1,
) {
	const map = fine ? edge.fine : edge.coarse;
	const { w, h, skyCum } = edge;
	const band = Math.max(2, Math.round(h * 0.035));
	const gap = Math.max(1, Math.round(h * (fine ? 0.006 : 0.012)));
	let sum = 0;
	let n = 0;
	let total = 0;
	for (let i = 0; i < dirs.length; i += 3 * stride) total++;
	forEachProjected(p, aspect, dirs, stride, (u, v) => {
		const x = Math.floor(u * w);
		const y = Math.floor(v * h);
		const a0 = Math.max(0, y - gap - band);
		const a1 = Math.max(0, y - gap);
		const b0 = Math.min(h, y + gap);
		const b1 = Math.min(h, y + gap + band);
		const above =
			a1 > a0 ? (skyCum[a1 * w + x] - skyCum[a0 * w + x]) / (a1 - a0) : 0.5;
		const below =
			b1 > b0 ? (skyCum[b1 * w + x] - skyCum[b0 * w + x]) / (b1 - b0) : 0.5;
		const fgHere = edge.fg[y * w + x];
		sum += (0.5 * map[y * w + x] + (above - below)) * (1 - fgHere);
		n++;
	});
	const coverage = Math.min(n / total / (((p.vfov * aspect) / 360) * 0.6), 1);
	return n > 20 ? (sum / n) * coverage : 0;
}

export type AlignResult = {
	pose: Pose;
	score: number;
	confidence: number;
	alternatives?: { pose: Pose; score: number }[];
};

/**
 * Precomputed coarse-grid scores for autoAlign (src/lib/gpu/align: the GPU twin of the grid loop).
 * `scores[iy * nPitch + ip]` ≈ scorePose(coarseGridPoses(prior, yawRange)[same index], …, false, 3),
 * accurate to ±tol/2. autoAlign re-scores on the CPU every cell within `tol` of its yaw column's
 * best, so the chosen cells and scores are exactly the CPU's. `skyFitted`: the caller already ran
 * fitPriorSky (the scores depend on it), so autoAlign skips it. `rescored` is filled in (cells
 * re-scored on the CPU).
 */
export type CoarseGridScores = {
	scores: Float32Array;
	tol: number;
	skyFitted?: boolean;
	rescored?: number;
};

/** The coarse grid autoAlign searches, yaw-major, pitch-minor (the same loops as its search). */
export function coarseGridPoses(prior: Pose, yawRange = 25) {
	const poses: Pose[] = [];
	let nYaw = 0;
	for (let dy = -yawRange; dy <= yawRange; dy += 0.5) {
		nYaw++;
		for (let dp = -6; dp <= 6; dp += 0.5)
			poses.push({ ...prior, yaw: prior.yaw + dy, pitch: prior.pitch + dp });
	}
	return { poses, nYaw, nPitch: nYaw ? poses.length / nYaw : 0 };
}

/** autoAlign's first step: refit the sky colour model from the prior's skyline (mutates `edge`). */
export function fitPriorSky(
	prior: Pose,
	aspect: number,
	dirs: Float32Array,
	edge: EdgeMap,
) {
	fitSkyModel(edge, scanLabels(edge, skylineRows(prior, aspect, dirs, edge)));
}

export function autoAlign(
	prior: Pose,
	aspect: number,
	dirs: Float32Array,
	edge: EdgeMap,
	yawRange = 25,
	grid?: CoarseGridScores,
): AlignResult {
	const penalty = (p: Pose) =>
		0.04 * ((p.yaw - prior.yaw) / 20) ** 2 +
		// the gravity vector is good to ~1–3°, the compass only to ~10°
		0.08 * ((p.pitch - prior.pitch) / 2.5) ** 2 +
		0.08 * ((p.roll - prior.roll) / 4) ** 2 +
		0.1 * ((p.vfov - prior.vfov) / (prior.vfov * 0.08)) ** 2;
	const f = (p: Pose, fine: boolean, stride = 1) =>
		scorePose(p, aspect, dirs, edge, fine, stride) - penalty(p);

	const refine = (start: Pose, fine: boolean) => {
		let best = start;
		let steps = { yaw: 0.4, pitch: 0.4, roll: 0.8, vfov: prior.vfov * 0.02 };
		let cur = f(best, fine);
		for (let iter = 0; iter < 60; iter++) {
			let improved = false;
			for (const k of ["yaw", "pitch", "roll", "vfov"] as const) {
				for (const sgn of [1, -1]) {
					const p = { ...best, [k]: best[k] + sgn * steps[k] };
					const s = f(p, fine);
					if (s > cur) {
						cur = s;
						best = p;
						improved = true;
					}
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
		return { pose: best, score: cur };
	};

	const search = () => {
		// coarse grid (yaw × pitch); keep the best pitch per yaw column
		const byYaw: { yaw: number; pose: Pose; s: number }[] = [];
		// precomputed grid (GPU): only cells within tol of the column's best are scored here
		const g =
			grid &&
			grid.scores.length === coarseGridPoses(prior, yawRange).poses.length
				? grid
				: undefined;
		if (grid) grid.rescored = 0;
		let cell = 0;
		for (let dy = -yawRange; dy <= yawRange; dy += 0.5) {
			let bestP = {
				yaw: prior.yaw + dy,
				pose: prior,
				s: Number.NEGATIVE_INFINITY,
			};
			let cut = Number.NEGATIVE_INFINITY;
			if (g) {
				let c = cell;
				for (let dp = -6; dp <= 6; dp += 0.5, c++) {
					const p = { ...prior, yaw: prior.yaw + dy, pitch: prior.pitch + dp };
					cut = Math.max(cut, g.scores[c] - penalty(p) - g.tol);
				}
			}
			for (let dp = -6; dp <= 6; dp += 0.5, cell++) {
				const p = { ...prior, yaw: prior.yaw + dy, pitch: prior.pitch + dp };
				if (g && g.scores[cell] - penalty(p) < cut) continue;
				if (g) g.rescored = (g.rescored ?? 0) + 1;
				const s = f(p, false, 3);
				if (s > bestP.s) bestP = { yaw: p.yaw, pose: p, s };
			}
			byYaw.push(bestP);
		}
		// local maxima along yaw, ≥2° apart → hypotheses
		const peaks = byYaw
			.filter(
				(c, i) =>
					(i === 0 || c.s >= byYaw[i - 1].s) &&
					(i === byYaw.length - 1 || c.s >= byYaw[i + 1].s),
			)
			.sort((a, b) => b.s - a.s);
		const hyps: typeof peaks = [];
		for (const c of peaks) {
			if (hyps.every((h) => Math.abs(h.yaw - c.yaw) >= 2)) hyps.push(c);
			if (hyps.length >= 5) break;
		}
		return hyps
			.map((h) => {
				const coarse = refine(h.pose, false);
				return refine(coarse.pose, true);
			})
			.sort((a, b) => b.score - a.score);
	};

	// sky/terrain colours from the prior pose with a wide margin (compass error mostly shifts
	// the skyline sideways, so far above / far below it is still reliable). Re-learning from the
	// solved pose instead feeds back: a wrong pose paints mountains as sky and wins again.
	if (!grid?.skyFitted) fitPriorSky(prior, aspect, dirs, edge);
	const results = search();
	const best = results[0];
	const second = results.find((r) => Math.abs(r.pose.yaw - best.pose.yaw) > 3);
	const margin = second
		? (best.score - second.score) / Math.max(Math.abs(best.score), 1e-3)
		: 1;
	const confidence =
		Math.max(0, Math.min(1, margin * 4)) *
		Math.min(1, Math.max(0, best.score * 2.5));
	return {
		pose: best.pose,
		score: best.score,
		confidence,
		alternatives: results,
	};
}

// ---------------- pin solver ----------------

export type Pin = { world: [number, number, number]; u: number; v: number };

function projectUV(p: Pose, aspect: number, eye: number[], w: number[]) {
	const q = projectPoint(p, aspect, eye, w);
	// behind (or beside) the camera: a large, smooth penalty instead of a mirrored projection
	if (
		!q ||
		q.depth <= 1e-3 * Math.hypot(w[0] - eye[0], w[1] - eye[1], w[2] - eye[2])
	)
		return [10, 10];
	return [q.u, q.v];
}

/** Solve rotation (+fov with ≥3 pins) so pinned world points land on their clicked pixels. */
export function solvePins(
	prior: Pose,
	aspect: number,
	eye: number[],
	pins: Pin[],
	imgW: number,
	imgH: number,
	solveFov = true,
): Pose {
	if (!pins.length) return prior;
	const keys = (
		pins.length === 1
			? ["yaw", "pitch"]
			: pins.length === 2 || !solveFov
				? ["yaw", "pitch", "roll"]
				: ["yaw", "pitch", "roll", "vfov"]
	) as (keyof Pose)[];
	let p = { ...prior };
	const resid = (q: Pose) => {
		const out: number[] = [];
		for (const pin of pins) {
			const [u, v] = projectUV(q, aspect, eye, pin.world);
			out.push((u - pin.u) * imgW, (v - pin.v) * imgH);
		}
		// weak priors keep under-determined directions sane
		out.push((q.roll - prior.roll) * 0.5, (q.vfov - prior.vfov) * 0.5);
		return out;
	};
	let lambda = 1e-2;
	let r = resid(p);
	let cost = r.reduce((a, b) => a + b * b, 0);
	for (let iter = 0; iter < 50; iter++) {
		const J = keys.map((k) => {
			const h = 1e-4;
			const r2 = resid({ ...p, [k]: p[k] + h });
			return r2.map((x, i) => (x - r[i]) / h);
		});
		const A = keys.map((_, i) =>
			keys.map((_, j) => J[i].reduce((a, _x, n) => a + J[i][n] * J[j][n], 0)),
		);
		const g = keys.map((_, i) => -J[i].reduce((a, x, n) => a + x * r[n], 0));
		for (let i = 0; i < keys.length; i++) A[i][i] *= 1 + lambda;
		const delta = gaussJordan(A, g);
		const q = { ...p };
		keys.forEach((k, i) => {
			q[k] += delta[i];
		});
		const r2 = resid(q);
		const c2 = r2.reduce((a, b) => a + b * b, 0);
		if (c2 < cost) {
			p = q;
			r = r2;
			if (cost - c2 < 1e-6) break;
			cost = c2;
			lambda *= 0.3;
		} else lambda *= 10;
	}
	return p;
}
