// Pose refinement.
//  1. Skyline alignment: the DEM horizon (a set of ENU directions, independent of rotation)
//     is projected into the photo for a candidate pose and scored against a blurred photo
//     edge map. Coarse grid over yaw/pitch, then coordinate descent over yaw/pitch/roll/fov.
//  2. Pin solve: Levenberg–Marquardt on user "this peak is here" pins.
import { type Pose, poseBasis, projectPoint } from "./camera";
import { gaussJordan } from "./linalg";
import { kthSmallest } from "./math";

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

export type FgMask = { width: number; height: number; data: Uint8Array };

/** Edge map tuned for sky/terrain boundaries: luminance + "blueness" gradients, sky-above favoured. */
export function buildEdgeMap(
	img: HTMLImageElement | ImageBitmap,
	width = 512,
	fgMask?: FgMask | null,
): EdgeMap {
	const { d, w, h } = photoPixels(img, width);
	return edgeMapFromPixels(d, w, h, edgeMapFg(w, h, fgMask));
}

/**
 * The photo at `width` px (height by aspect) as RGBA bytes, through a 2D canvas: the browser's
 * drawImage downscale defines every edge-map plane (src/lib/gpu/photoprep keeps it for that reason).
 */
export function photoPixels(img: HTMLImageElement | ImageBitmap, width = 512) {
	const w = width;
	const h = Math.round((width * img.height) / img.width);
	const c = document.createElement("canvas");
	c.width = w;
	c.height = h;
	const ctx = c.getContext("2d", {
		willReadFrequently: true,
	}) as CanvasRenderingContext2D;
	ctx.drawImage(img, 0, 0, w, h);
	return { d: ctx.getImageData(0, 0, w, h).data, w, h };
}

/** The foreground (people) mask resampled to the edge map (nearest), 0..1; zeros without a mask. */
export function edgeMapFg(w: number, h: number, fgMask?: FgMask | null) {
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
	return fg;
}

/**
 * buildEdgeMap after the canvas: RGBA bytes `d` (w × h) and the resampled foreground `fg` → the edge
 * map (the CPU reference of src/lib/gpu/photoprep, which reproduces every plane bit for bit).
 */
export function edgeMapFromPixels(
	d: Uint8ClampedArray,
	w: number,
	h: number,
	fg: Float32Array,
): EdgeMap {
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
	const p = kthSmallest(Float32Array.from(E), Math.floor(E.length * 0.97)) || 1;
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
export function scanLabels(map: EdgeMap, priorRows?: Float32Array) {
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
		if (stopHasBand(stop, x, h, priorRows))
			for (let y = stop + 3; y < Math.min(h, stop + 3 + band); y++)
				lbl[y * w + x] = -1;
		for (let y = Math.round(h * 0.8); y < h; y++) lbl[y * w + x] = -1;
	}
	return lbl;
}

/** scanLabels: does column x's colour stop at row `stop` get a terrain band below it? */
export function stopHasBand(
	stop: number,
	x: number,
	h: number,
	priorRows?: Float32Array,
) {
	// a stop far from where the prior pose puts the skyline is a cloud edge, not a ridge
	const plausible =
		!priorRows ||
		(priorRows[x] >= 0 && Math.abs(stop - priorRows[x]) < h * 0.1);
	return plausible && stop > h * 0.04 && stop < h * 0.85;
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
export function skylineRows(
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
	return scoreFromSum(sum, n, total, p.vfov, aspect);
}

/**
 * scorePose's last step from its direction sum `sum`, in-frame count `n` and direction count
 * `total`. Monotone non-decreasing in `sum` for fixed (n, total, vfov, aspect) (one division by
 * n > 0, one product by coverage ≥ 0, both rounding monotonically), so a true upper bound of the
 * sum gives a true upper bound of the score (src/lib/gpu/align/pose-bound.ts).
 */
export function scoreFromSum(
	sum: number,
	n: number,
	total: number,
	vfov: number,
	aspect: number,
) {
	const coverage = Math.min(n / total / (((vfov * aspect) / 360) * 0.6), 1);
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

/**
 * A certified upper bound of scorePose: `ub` ≥ scorePose(...) guaranteed, of which `eps` is the
 * error allowance (ub without it would be the provider's plain estimate).
 */
export type ScoreBound = { ub: number; eps: number };

/**
 * Certified upper bounds of scorePose(pose, aspect, dirs, edge, fine, 1) for a batch of poses
 * (src/lib/gpu/align/pose-bound.ts is the GPU provider). Entry i is a ScoreBound, or undefined when
 * no bound is known (the pose is scored on the CPU). Rejects on GPU errors (the refine then finishes
 * on the CPU, with the same result).
 */
export type ScoreBounds = (
	probes: { pose: Pose; fine: boolean }[],
) => Promise<(ScoreBound | undefined)[]>;

/**
 * Runtime check of the bounds' premise (the device's f32 accuracy): `check(margin, eps)` is asked for
 * every skip (margin = cur − (ub − penalty) ≥ 0) and returns true to have that skip re-scored on the
 * CPU. A re-scored skip whose exact value exceeds its bound throws RefineBoundViolation.
 */
export type SkipVerifier = { check: (margin: number, eps: number) => boolean };

/** A certified bound was wrong (the device broke the f32 accuracy the bound assumes). */
export class RefineBoundViolation extends Error {
	constructor(
		readonly score: number,
		readonly limit: number,
	) {
		super(
			`[align] refine bound violated: f = ${score} > ub − penalty = ${limit}`,
		);
	}
}

/** Counters of autoAlignRefined (CPU and bounded paths alike). */
export type RefineStats = {
	/** coordinate-descent iterations (identical on both paths: the trajectory is the same) */
	iters: number;
	/** CPU scorePose calls of the refine (incl. each pass's start pose) */
	cpuEvals: number;
	/** neighbour evaluations skipped on a certified bound (CPU calls saved) */
	skipped: number;
	/** batched bound requests (GPU dispatches) and the poses they covered */
	rounds: number;
	probes: number;
	/** bound requests that failed (the refine then went on CPU-only) */
	failures: number;
	/** skips re-scored on the CPU by the SkipVerifier (part of cpuEvals), and their ms */
	verified: number;
	verifyMs: number;
};

export const newRefineStats = (): RefineStats => ({
	iters: 0,
	cpuEvals: 0,
	skipped: 0,
	rounds: 0,
	probes: 0,
	failures: 0,
	verified: 0,
	verifyMs: 0,
});

const DESCENT_KEYS = ["yaw", "pitch", "roll", "vfov"] as const;
type Steps = { yaw: number; pitch: number; roll: number; vfov: number };

/** Neighbour `j` (0..7) of `base`, built with the very expression of the CPU loop (k = j>>1, + then −). */
const neighbour = (base: Pose, j: number, steps: Steps): Pose => {
	const k = DESCENT_KEYS[j >> 1];
	const sgn = j & 1 ? -1 : 1;
	return { ...base, [k]: base[k] + sgn * steps[k] };
};

const halve = (steps: Steps): Steps => ({
	yaw: steps.yaw / 2,
	pitch: steps.pitch / 2,
	roll: steps.roll / 2,
	vfov: steps.vfov / 2,
});

const keyF64 = new Float64Array(4);
const keyU16 = new Uint16Array(keyF64.buffer);
/**
 * Exact identity of what scorePose reads from a pose: the bit patterns of yaw, pitch, roll and vfov
 * (so −0 ≠ 0 and every double is distinct), plus the map.
 */
export const probeKey = (p: Pose, fine: boolean) => {
	keyF64[0] = p.yaw;
	keyF64[1] = p.pitch;
	keyF64[2] = p.roll;
	keyF64[3] = p.vfov;
	return (
		(fine ? "f" : "c") +
		String.fromCharCode.apply(null, keyU16 as unknown as number[])
	);
};

/**
 * autoAlign's coordinate descent (`refine`), one iteration per step(): yaw, pitch, roll, vfov, each
 * + then −, every neighbour built from the CURRENT best (greedy: a move is taken as soon as it
 * improves, and later neighbours start from it); no improvement → halve all steps, stop below
 * 0.01° yaw step or after 60 iterations.
 *
 * step(bound) may skip a neighbour, and only on a certificate that the CPU would reject it:
 *   bound(p) = U with scorePose(p) ≤ U (a true bound on the CPU's float64 value, for exactly the
 *   pose p the loop just built; pose-bound.ts derives it with explicit float32 error terms).
 *   f(p) = fl(scorePose(p) − penalty(p)) ≤ fl(U − penalty(p)) since IEEE subtraction of the same
 *   penalty is monotone. So fl(U − penalty(p)) ≤ cur ⇒ f(p) ≤ cur ⇒ the CPU test `s > cur` fails.
 *   A rejected neighbour changes nothing (not best, cur, improved or the steps), so skipping it
 *   leaves the state exactly as the CPU loop leaves it.
 * Every neighbour that is not certified is scored on the CPU (f, float64) and decided with the
 * loop's own rule `s > cur`, in the loop's order. Accepted moves therefore always come from exact
 * CPU scores, and by induction over the evaluations, the sequence of (best, cur, steps) states is
 * the CPU loop's: identical poses and bit-identical scores, whatever the bounds (a missing, loose
 * or speculative bound only costs a CPU call). Correctness rests solely on U being a true upper
 * bound for the pose identified by probeKey.
 *
 * That premise (the device keeping its f32 error within the bound's slack) is checked at run time:
 * step(bound, verify) re-scores the skips the SkipVerifier picks; f ≤ ub − penalty must hold (it
 * follows from a true bound by monotone rounding), and a re-scored skip is then the rejection the
 * CPU makes, so verifying changes no state either. A violation throws RefineBoundViolation.
 */
export class Descent {
	best: Pose;
	cur: number;
	steps: Steps;
	iter = 0;
	done = false;
	constructor(
		start: Pose,
		readonly fine: boolean,
		private readonly f: (p: Pose, fine: boolean) => number,
		private readonly penalty: (p: Pose) => number,
		vfov0: number,
		private readonly stats?: RefineStats,
	) {
		this.best = start;
		this.steps = { yaw: 0.4, pitch: 0.4, roll: 0.8, vfov: vfov0 * 0.02 };
		this.cur = f(start, fine);
		if (stats) stats.cpuEvals++;
	}

	/** One iteration of the loop. `bound(p)`: a certified upper bound of scorePose(p), or undefined. */
	step(bound?: (p: Pose) => ScoreBound | undefined, verify?: SkipVerifier) {
		const st = this.stats;
		let improved = false;
		for (let j = 0; j < 8; j++) {
			const p = neighbour(this.best, j, this.steps);
			const b = bound?.(p);
			if (b !== undefined) {
				const lim = b.ub - this.penalty(p);
				if (lim <= this.cur) {
					if (verify?.check(this.cur - lim, b.eps)) {
						// re-score the skip: a true bound gives f ≤ lim (monotone rounding), and then
						// f ≤ cur, the rejection the CPU makes; anything else is a broken bound
						const t0 = performance.now();
						const s = this.f(p, this.fine);
						if (st) {
							st.cpuEvals++;
							st.verified++;
							st.verifyMs += performance.now() - t0;
						}
						if (s > lim) throw new RefineBoundViolation(s, lim);
					} else if (st) st.skipped++;
					continue;
				}
			}
			const s = this.f(p, this.fine);
			if (st) st.cpuEvals++;
			if (s > this.cur) {
				this.cur = s;
				this.best = p;
				improved = true;
			}
		}
		if (st) st.iters++;
		if (!improved) {
			this.steps = halve(this.steps);
			if (this.steps.yaw < 0.01) this.done = true;
		}
		if (++this.iter >= 60) this.done = true;
	}

	/**
	 * Poses worth bounding before the next step(s): the neighbours the loop would build over the next
	 * `levels` iterations along every branch with at most `accepts` accepted moves per iteration (a
	 * move changes the later neighbours' base; an iteration without one halves the steps). Any subset
	 * is safe (see the class comment); this only decides how many CPU calls and rounds are saved.
	 */
	speculate(accepts: number, levels: number, out: Pose[]) {
		const iteration = (
			base: Pose,
			steps: Steps,
			iter: number,
			level: number,
		) => {
			const next = (b: Pose, improved: boolean) => {
				if (level <= 1 || iter + 1 >= 60) return;
				const s2 = improved ? steps : halve(steps);
				if (!improved && s2.yaw < 0.01) return;
				iteration(b, s2, iter + 1, level - 1);
			};
			const branch = (
				b: Pose,
				from: number,
				acc: number,
				improved: boolean,
			) => {
				for (let j = from; j < 8; j++) {
					const p = neighbour(b, j, steps);
					out.push(p);
					if (acc < accepts) branch(p, j + 1, acc + 1, true);
				}
				next(b, improved);
			};
			branch(base, 0, 0, false);
		};
		iteration(this.best, this.steps, this.iter, levels);
		return out;
	}

	/** True when every neighbour of the next step() (no move taken yet) is in `known`. */
	covered(known: Map<string, ScoreBound | undefined>) {
		for (let j = 0; j < 8; j++)
			if (!known.has(probeKey(neighbour(this.best, j, this.steps), this.fine)))
				return false;
		return true;
	}

	get result() {
		return { pose: this.best, score: this.cur };
	}
}

type AlignCtx = {
	prior: Pose;
	aspect: number;
	dirs: Float32Array;
	edge: EdgeMap;
	penalty: (p: Pose) => number;
	f: (p: Pose, fine: boolean, stride?: number) => number;
};

function alignCtx(
	prior: Pose,
	aspect: number,
	dirs: Float32Array,
	edge: EdgeMap,
): AlignCtx {
	const penalty = (p: Pose) =>
		0.04 * ((p.yaw - prior.yaw) / 20) ** 2 +
		// the gravity vector is good to ~1–3°, the compass only to ~10°
		0.08 * ((p.pitch - prior.pitch) / 2.5) ** 2 +
		0.08 * ((p.roll - prior.roll) / 4) ** 2 +
		0.1 * ((p.vfov - prior.vfov) / (prior.vfov * 0.08)) ** 2;
	const f = (p: Pose, fine: boolean, stride = 1) =>
		scorePose(p, aspect, dirs, edge, fine, stride) - penalty(p);
	return { prior, aspect, dirs, edge, penalty, f };
}

/** autoAlign's coarse search: the ≤ 5 hypotheses (local yaw maxima ≥ 2° apart), best first. */
function coarseHypotheses(
	ctx: AlignCtx,
	yawRange: number,
	grid?: CoarseGridScores,
) {
	const { prior, penalty, f } = ctx;
	// coarse grid (yaw × pitch); keep the best pitch per yaw column
	const byYaw: { yaw: number; pose: Pose; s: number }[] = [];
	// precomputed grid (GPU): only cells within tol of the column's best are scored here
	const g =
		grid && grid.scores.length === coarseGridPoses(prior, yawRange).poses.length
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
	return hyps;
}

function alignResult(results: { pose: Pose; score: number }[]): AlignResult {
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

const byScore = (a: { score: number }, b: { score: number }) =>
	b.score - a.score;

export function autoAlign(
	prior: Pose,
	aspect: number,
	dirs: Float32Array,
	edge: EdgeMap,
	yawRange = 25,
	grid?: CoarseGridScores,
	stats?: RefineStats,
): AlignResult {
	const ctx = alignCtx(prior, aspect, dirs, edge);
	const refine = (start: Pose, fine: boolean) => {
		const d = new Descent(start, fine, ctx.f, ctx.penalty, prior.vfov, stats);
		while (!d.done) d.step();
		return d.result;
	};
	// sky/terrain colours from the prior pose with a wide margin (compass error mostly shifts
	// the skyline sideways, so far above / far below it is still reliable). Re-learning from the
	// solved pose instead feeds back: a wrong pose paints mountains as sky and wins again.
	if (!grid?.skyFitted) fitPriorSky(prior, aspect, dirs, edge);
	const results = coarseHypotheses(ctx, yawRange, grid)
		.map((h) => {
			const coarse = refine(h.pose, false);
			return refine(coarse.pose, true);
		})
		.sort(byScore);
	return alignResult(results);
}

/**
 * autoAlignRefined's speculation (Descent.speculate). Measured on Apple / Chromium (2026-09-30):
 * 1 accept, 1 level is fastest (≈ 40 rounds of ~130 poses per autoAlign); 2 levels halves the rounds
 * but each batch is ~4× larger, and the per-pose host + GPU cost outweighs the saved round trips.
 */
export type RefineSpeculation = { accepts: number; levels: number };
export const REFINE_SPECULATION: RefineSpeculation = { accepts: 1, levels: 1 };

/**
 * autoAlign with the refine's neighbour evaluations pre-screened by certified score bounds
 * (`bounds`, one batch per round for every live hypothesis). Same result as autoAlign, bit for bit:
 * the descents are autoAlign's own (Descent), a bound only ever skips a neighbour the CPU would
 * reject, and every accepted move is decided on an exact CPU score (proof: Descent). The hypotheses
 * run in lockstep, each its coarse pass then its fine pass; a round requests the speculated
 * neighbours of every live descent at once, then each descent steps while its next iteration's
 * neighbours are covered. A failed batch only turns the rest of the refine into the CPU loop.
 * `verify` re-scores chosen skips on the CPU; a broken bound throws RefineBoundViolation out of
 * this call (no partial result: the caller re-runs the plain CPU refine). Interleaving the
 * hypotheses changes no value: f is a pure function of (pose, edge), and `edge`
 * must not be written while this runs (the GPU caller passes a private copy of the sky planes).
 * Each hypothesis' descents, and the final sort (stable, same comparator, same input order), are
 * autoAlign's.
 */
export async function autoAlignRefined(
	prior: Pose,
	aspect: number,
	dirs: Float32Array,
	edge: EdgeMap,
	yawRange: number,
	grid: CoarseGridScores | undefined,
	bounds: ScoreBounds,
	stats: RefineStats = newRefineStats(),
	spec: RefineSpeculation = REFINE_SPECULATION,
	verify?: SkipVerifier,
): Promise<AlignResult> {
	const ctx = alignCtx(prior, aspect, dirs, edge);
	if (!grid?.skyFitted) fitPriorSky(prior, aspect, dirs, edge);
	const hyps = coarseHypotheses(ctx, yawRange, grid);
	const descent = (start: Pose, fine: boolean) =>
		new Descent(start, fine, ctx.f, ctx.penalty, prior.vfov, stats);
	// per hypothesis: its current pass, and its fine result once done
	const live = hyps.map((h) => descent(h.pose, false));
	const done: ({ pose: Pose; score: number } | undefined)[] = hyps.map(
		() => undefined,
	);
	const advance = (i: number) => {
		const d = live[i];
		if (!d.done) return;
		if (!d.fine) live[i] = descent(d.result.pose, true);
		else done[i] = d.result;
	};
	let gpu = true;
	const { accepts, levels } = spec;
	for (;;) {
		const active = live.map((_, i) => i).filter((i) => !done[i]);
		if (!active.length) break;
		const known = new Map<string, ScoreBound | undefined>();
		if (gpu) {
			const probes: { pose: Pose; fine: boolean }[] = [];
			const keys: string[] = [];
			for (const i of active) {
				const ps: Pose[] = [];
				live[i].speculate(accepts, levels, ps);
				for (const pose of ps) {
					const k = probeKey(pose, live[i].fine);
					if (known.has(k)) continue;
					known.set(k, undefined);
					keys.push(k);
					probes.push({ pose, fine: live[i].fine });
				}
			}
			try {
				const ub = await bounds(probes);
				stats.rounds++;
				stats.probes += probes.length;
				let any = false;
				keys.forEach((k, j) => {
					known.set(k, ub[j]);
					if (ub[j] !== undefined) any = true;
				});
				// a batch with no bound at all (e.g. a kernel that never ran): stop dispatching
				if (!any && keys.length) gpu = false;
			} catch (e) {
				console.warn("[align] refine bounds failed, finishing on the CPU", e);
				stats.failures++;
				gpu = false;
				known.clear();
			}
		}
		for (const i of active) {
			if (!gpu) {
				// no bounds (any more): this hypothesis' remaining passes are the plain CPU loop
				while (!done[i]) {
					const d = live[i];
					while (!d.done) d.step();
					advance(i);
				}
				continue;
			}
			const d = live[i];
			const bound = (p: Pose) => known.get(probeKey(p, d.fine));
			// one iteration per round (CPU scores where nothing is known), more while the
			// speculation covers the next one
			do d.step(bound, verify);
			while (!d.done && d.covered(known));
			advance(i);
		}
	}
	return alignResult(
		done.map((r) => r as { pose: Pose; score: number }).sort(byScore),
	);
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
