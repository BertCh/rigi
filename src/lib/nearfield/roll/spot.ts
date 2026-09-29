// Camera-roll "spot" fusion (Step Inside P2, reports/step-inside-design.md "Roll spots"): several photos
// taken within VIEWPOINT_RADIUS_M of each other, each with an accepted pose (saved / ground truth / solved),
// become one ENU splat cloud of the spot's near field. Pure TS (no DOM, no deck).
//
//   per photo: depth (from /multiview DA3 with the Rigi poses as known poses, or any per-photo depth)
//     → DEM anchoring with anchor.ts's range-dependent curve (tools/nearfield/spike/SUMMARY.txt reviewer
//       note: monocular depth compresses range, so ONE scale either places near objects many times too far
//       or pulls the far terrain into the near field) on DEM 15–3000 m
//     → depth split with the spike's params (objectMargin 0.5, nearRadius 150; no-DEM pixels within
//       nearRadius = Object, which classifyRange already does)
//     → people dropped (they move between the photos of a spot), everything else kept per `keep`
//     → depth-lift to Gaussians (lift.ts) → ENU with the photo's pose (toEnu)
//   all photos: voxel-hash merge (./voxel.ts), provenance 'reconstructed', source = photo index.
//
// Frames: `eye` and `pose` must be in ONE ENU frame (the roll map's frame: RollMapEngine.debugPlaced()).
import type { Pose } from "../../camera";
import {
	ANCHOR_QUALITY_CONSTS,
	type AnchorOpts,
	fitAnchor,
	logMode,
} from "../anchor";
import {
	gridDemRange,
	type IntrinsicsNorm,
	intrinsicsFromPose,
	type MaskLike,
	maskSampler,
} from "../geom";
import {
	camToEnuMatrix,
	liftToGaussians,
	quatFromMatrix,
	type RGBAImage,
	toEnu,
} from "../lift";
import { splitPixels } from "../split";
import {
	type AnchorFit,
	type GaussianCloud,
	type NearFieldDepth,
	PixelClass,
	PROVENANCE_CODE,
	type SplitParams,
	type SplitResult,
} from "../types";
import {
	type EyePair,
	type EyeSolve,
	type EyeSolveOpts,
	REFINE_EYES_DEFAULT,
	refineEyes,
	type Vec3,
} from "./eyes";
import { type VoxelMergeOpts, type VoxelMergeStats, voxelMerge } from "./voxel";

export { REFINE_EYES_DEFAULT } from "./eyes";

/** Spike-recommended split for placement (tools/nearfield/spike/SUMMARY.txt). */
export const SPOT_SPLIT: SplitParams = {
	objectMargin: 0.5,
	nearRadius: 150,
	minGapM: 3,
};

/** Anchor quality below which a photo is left out of the spot (tools/nearfield/spike: "low trust"). */
export const SPOT_MIN_QUALITY = 0.15;

/**
 * DEM range windows tried in order for the anchor fit (m). anchor.ts fits a range-dependent curve by default
 * (monotone log-log), so one wide window places near objects AND keeps the far field far; the 15 m floor
 * skips the eye-height / grazing-ray errors of the DEM right at the eye (spike). The second window only
 * rescues photos with almost no terrain in the first.
 */
export const SPOT_ANCHOR_WINDOWS: [number, number][] = [
	[15, 3000],
	[2, 5000],
];

/** One photo of the spot. */
export type SpotView = {
	id: string;
	/** Pose in the shared ENU frame. */
	pose: Pose;
	/** Eye in the shared ENU frame (m). */
	eye: [number, number, number];
	/** Photo width / height. */
	aspect: number;
	/** Photo pixels (any resolution; same framing as the depth). */
	photo: RGBAImage;
	/**
	 * DEM ray length per pixel through this pose (GpuGeometrySource.range layout: row 0 = top;
	 * Infinity / 0 / NaN = no terrain). Any resolution.
	 */
	range: { width: number; height: number; data: Float32Array };
	peopleMask?: MaskLike | null;
	skyMask?: MaskLike | null;
	/**
	 * Joint multi-view placement (jointPlacement): the depth's own camera in ENU and one metric scale for
	 * the whole reconstruction, instead of the per-photo DEM anchor + the Rigi pose.
	 */
	placement?: SpotPlacement | null;
};

/** Where one view of a jointly reconstructed spot sits in ENU (see jointPlacement). */
export type SpotPlacement = {
	/** Camera (OpenCV) → ENU rotation, row-major 3×3. */
	camToEnu: number[];
	eye: [number, number, number];
	/** Model depth → metres (one scale for every view of the reconstruction). */
	scale: number;
	/** The depth model's intrinsics for this view (normalised, photo framing). */
	K: IntrinsicsNorm;
	/** Joint scale fit quality (as AnchorFit.quality). */
	quality: number;
	/**
	 * Joint scale-fit samples (all views). Carried into the view's AnchorFit.n: splitPixels treats
	 * n < ANCHOR_QUALITY_CONSTS.nMin as "no fit" and would then classify from the DEM alone.
	 */
	n?: number;
};

export type SpotOpts = {
	split?: SplitParams;
	/** Classes lifted to splats. Default Object + Terrain (the near-field surface the drape smears). */
	keep?: PixelClass[];
	/** Drop people-mask pixels (transient between the photos). Default true. */
	dropPeople?: boolean;
	/** Anchor windows (m) tried in order; the first with ≥ minAnchorN samples wins. */
	anchorWindows?: [number, number][];
	minAnchorN?: number;
	anchor?: Omit<AnchorOpts, "minRange" | "maxRange" | "skyMask" | "peopleMask">;
	/** Depth-grid cells per splat. Default 2. */
	stride?: number;
	/** Flying-pixel threshold (lift.ts edgeLog). Default 0.1. */
	edgeLog?: number;
	voxel?: VoxelMergeOpts;
	/**
	 * Skip photos whose anchor quality is below this. Default SPOT_MIN_QUALITY (the spike's "low trust"
	 * level, 0.15): in a spot, a photo whose depth disagrees with the DEM would only add misplaced splats.
	 */
	minQuality?: number;
	/**
	 * Relative eye refinement (./eyes.ts, refineSpotEyes) BEFORE the DEM range buffers are rendered: photo
	 * pairs with near-field matches pull their GPS eyes into agreement (mean kept, z on the DEM). Needs
	 * measured pairs (RollSpotOpts.eyePairs); an object passes solver options. Default REFINE_EYES_DEFAULT
	 * (off: one usable pair of evidence so far, tools/nearfield/eyes/REPORT.txt).
	 */
	refineEyes?: boolean | EyeSolveOpts;
};

export type SpotViewResult = {
	id: string;
	index: number;
	anchor: AnchorFit;
	/** DEM window [min, max] the anchor was fitted on (null = no fit). */
	anchorWindow: [number, number] | null;
	split: SplitResult;
	splats: number;
	/** Why the photo contributed nothing, if so. */
	skipped?: string;
};

export type SpotResult = {
	cloud: GaussianCloud;
	views: SpotViewResult[];
	merge: VoxelMergeStats;
};

/** A range buffer as a DemRangeAt-ready grid (NaN = no terrain). */
export function rangeGrid(r: SpotView["range"]): Float32Array {
	const g = new Float32Array(r.data.length);
	for (let i = 0; i < g.length; i++) {
		const v = r.data[i];
		g[i] = v > 0 && Number.isFinite(v) ? v : Number.NaN;
	}
	return g;
}

/** Anchor fit on the first DEM window with enough samples (near first). */
export function fitSpotAnchor(
	depth: NearFieldDepth,
	dem: (u: number, v: number) => number | null,
	K: IntrinsicsNorm,
	masks: { sky?: MaskLike | null; people?: MaskLike | null },
	opts: SpotOpts = {},
): { fit: AnchorFit; window: [number, number] | null } {
	const windows = opts.anchorWindows ?? SPOT_ANCHOR_WINDOWS;
	const minN = opts.minAnchorN ?? 200;
	let last: AnchorFit | null = null;
	for (const w of windows) {
		const fit = fitAnchor(depth, dem, K, {
			...opts.anchor,
			minRange: w[0],
			maxRange: w[1],
			skyMask: masks.sky ?? null,
			peopleMask: masks.people ?? null,
		});
		last = fit;
		if (fit.n >= minN && Number.isFinite(fit.residualLog))
			return { fit, window: w };
	}
	return {
		fit: last ?? {
			scale: 1,
			shift: 0,
			residualLog: Number.NaN,
			inlierFrac: 0,
			n: 0,
			quality: 0,
			maxRange: 0,
		},
		window: null,
	};
}

/**
 * One photo → its anchored near-field splats in the shared ENU frame (provenance 'reconstructed',
 * source = index). The split is returned for masks (e.g. the Brush training alpha).
 */
export function liftSpotView(
	view: SpotView,
	depth: NearFieldDepth,
	index: number,
	opts: SpotOpts = {},
): { cloud: GaussianCloud; result: SpotViewResult } {
	const params = opts.split ?? SPOT_SPLIT;
	const pl = view.placement ?? null;
	const K = pl?.K ?? intrinsicsFromPose(view.pose, view.aspect);
	depth = regridDepth(depth, view.aspect);
	const dem = gridDemRange(
		rangeGrid(view.range),
		view.range.width,
		view.range.height,
	);
	const { fit, window } = pl
		? {
				fit: {
					scale: pl.scale,
					shift: 0,
					residualLog: Number.NaN,
					inlierFrac: 1,
					n: pl.n ?? ANCHOR_QUALITY_CONSTS.nMin,
					quality: pl.quality,
					maxRange: 0,
				} as AnchorFit,
				window: [0, 0] as [number, number],
			}
		: fitSpotAnchor(
				depth,
				dem,
				K,
				{ sky: view.skyMask, people: view.peopleMask },
				opts,
			);
	const split = splitPixels(
		depth,
		fit,
		dem,
		view.skyMask ?? null,
		view.peopleMask ?? null,
		params,
		K,
	);
	const result: SpotViewResult = {
		id: view.id,
		index,
		anchor: fit,
		anchorWindow: window,
		split,
		splats: 0,
	};
	const empty = toEnu(
		{
			count: 0,
			frame: "camera",
			positions: new Float32Array(0),
			scales: new Float32Array(0),
			rotations: new Float32Array(0),
			colors: new Uint8Array(0),
			provenance: new Uint8Array(0),
		},
		view.pose,
		view.eye,
	);
	if (!window) {
		result.skipped = `no anchor fit (n=${fit.n})`;
		return { cloud: empty, result };
	}
	if (fit.quality < (opts.minQuality ?? SPOT_MIN_QUALITY)) {
		result.skipped = `anchor quality ${fit.quality.toFixed(2)}`;
		return { cloud: empty, result };
	}
	// people: out of the lift (their split class is forced Object)
	let liftSplit = split;
	const people = maskSampler(view.peopleMask);
	if (people && opts.dropPeople !== false) {
		const cls = split.cls.slice();
		const { width: W, height: H } = split;
		for (let j = 0; j < H; j++)
			for (let i = 0; i < W; i++)
				if (people((i + 0.5) / W, (j + 0.5) / H))
					cls[j * W + i] = PixelClass.Unknown;
		liftSplit = { ...split, cls };
	}
	const cam = liftToGaussians(depth, view.photo, K, liftSplit, {
		stride: opts.stride ?? 2,
		keep: opts.keep ?? [PixelClass.Object, PixelClass.Terrain],
		anchor: fit,
		edgeLog: opts.edgeLog,
		provenance: PROVENANCE_CODE.reconstructed,
	});
	cam.source = new Uint16Array(cam.count).fill(index);
	const cloud = pl
		? toEnuMatrix(cam, pl.camToEnu, pl.eye)
		: toEnu(cam, view.pose, view.eye);
	result.splats = cloud.count;
	return { cloud, result };
}

/** Fuse a spot: per-photo lifts (depths[i] belongs to views[i]) merged in ENU. */
export function fuseSpot(
	views: SpotView[],
	depths: (NearFieldDepth | null)[],
	opts: SpotOpts = {},
): SpotResult {
	if (views.length !== depths.length)
		throw new Error("fuseSpot: one depth per view");
	const clouds: GaussianCloud[] = [];
	const results: SpotViewResult[] = [];
	views.forEach((v, i) => {
		const d = depths[i];
		if (!d) {
			results.push({
				id: v.id,
				index: i,
				anchor: {
					scale: 1,
					shift: 0,
					residualLog: Number.NaN,
					inlierFrac: 0,
					n: 0,
					quality: 0,
					maxRange: 0,
				},
				anchorWindow: null,
				split: { width: 0, height: 0, cls: new Uint8Array(0), counts: [] },
				splats: 0,
				skipped: "no depth",
			});
			return;
		}
		const r = liftSpotView(v, d, i, opts);
		clouds.push(r.cloud);
		results.push(r.result);
	});
	const { cloud, stats } = voxelMerge(clouds, opts.voxel);
	return { cloud, views: results, merge: stats };
}

/**
 * poses.json for POST /multiview: camera-to-world 4×4 (row-major, OpenCV camera: x right, y down,
 * z forward) in the shared ENU frame shifted by `origin` (keeps the numbers small), plus the photos'
 * normalised intrinsics. DA3 gets these as known poses; its depths then share their metric scale.
 */
export function multiviewPoses(
	views: Pick<SpotView, "pose" | "eye" | "aspect">[],
	origin: [number, number, number] = [0, 0, 0],
) {
	return {
		c2w: views.map((v) => {
			const m = camToEnuMatrix(v.pose);
			const t = [0, 1, 2].map((k) => v.eye[k] - origin[k]);
			return [
				m[0],
				m[1],
				m[2],
				t[0],
				m[3],
				m[4],
				m[5],
				t[1],
				m[6],
				m[7],
				m[8],
				t[2],
				0,
				0,
				0,
				1,
			];
		}),
		intrinsicsNorm: views.map((v) => intrinsicsFromPose(v.pose, v.aspect)),
	};
}

/**
 * Re-grid a depth map onto the photo's framing when the model returned a centre crop of a different
 * aspect (DA3 centre-crops a /multiview batch of mixed portrait + landscape photos to squares; its
 * intrinsics then describe the crop). Photo cells outside the crop become invalid. Returns the input
 * when the aspects agree within 2%. z-depth is unchanged (same camera centre and axis).
 */
export function regridDepth(
	depth: NearFieldDepth,
	aspect: number,
	longSide = Math.max(depth.width, depth.height),
): NearFieldDepth {
	const { width: w, height: h } = depth;
	const ad = w / h;
	if (Math.abs(ad / aspect - 1) < 0.02) return depth;
	const W = aspect >= 1 ? longSide : Math.max(1, Math.round(longSide * aspect));
	const H = aspect >= 1 ? Math.max(1, Math.round(longSide / aspect)) : longSide;
	// the crop's extent in photo-normalised coords
	const fw = Math.min(1, ad / aspect);
	const fh = Math.min(1, aspect / ad);
	const d = new Float32Array(W * H);
	const valid = new Uint8Array(W * H);
	const nrm = depth.normal ? new Float32Array(3 * W * H) : undefined;
	for (let j = 0; j < H; j++)
		for (let i = 0; i < W; i++) {
			const u = ((i + 0.5) / W - 0.5) / fw + 0.5;
			const v = ((j + 0.5) / H - 0.5) / fh + 0.5;
			if (!(u >= 0 && u < 1 && v >= 0 && v < 1)) continue;
			const s = Math.floor(v * h) * w + Math.floor(u * w);
			const k = j * W + i;
			d[k] = depth.depth[s];
			valid[k] = depth.valid[s];
			if (nrm && depth.normal)
				for (let a = 0; a < 3; a++) nrm[3 * k + a] = depth.normal[3 * s + a];
		}
	const Kd = depth.intrinsicsNorm;
	return {
		...depth,
		width: W,
		height: H,
		depth: d,
		valid,
		normal: nrm,
		intrinsicsNorm: Kd
			? { fx: Kd.fx * fw, fy: Kd.fy * fh, cx: 0.5, cy: 0.5 }
			: undefined,
	};
}

/**
 * The optional refineEyes step: refined eyes for the views from measured pairs (./eyes.ts: gate, triplet
 * closure, least squares with the GPS mean kept and eye z = DEM + 1.6 m). `heightAt` = DEM surface z in the
 * spot's ENU frame. Null when the step is off, there are no pairs, or no pair passes the gate (keep the GPS
 * eyes). The caller must re-render each moved view's DEM range at its new eye before lifting.
 */
export function refineSpotEyes(
	views: Pick<SpotView, "id" | "eye">[],
	pairs: EyePair[],
	heightAt: (e: number, n: number) => number | null,
	opts: Pick<SpotOpts, "refineEyes"> = {},
): (EyeSolve & { pairs: EyePair[] }) | null {
	const on = opts.refineEyes ?? REFINE_EYES_DEFAULT;
	if (!on || !pairs.length) return null;
	const eyes: Record<string, Vec3> = {};
	for (const v of views) eyes[v.id] = [v.eye[0], v.eye[1], v.eye[2]];
	return refineEyes(eyes, pairs, heightAt, typeof on === "object" ? on : {});
}

/** Mean eye of the views (the default origin for exports and /multiview). */
export function spotOrigin(
	views: Pick<SpotView, "eye">[],
): [number, number, number] {
	const o: [number, number, number] = [0, 0, 0];
	for (const v of views) for (let k = 0; k < 3; k++) o[k] += v.eye[k];
	return o.map((x) => x / Math.max(1, views.length)) as [
		number,
		number,
		number,
	];
}

/**
 * Near-field alpha mask of a photo for training (255 = keep): its split classes in `keep`, minus people.
 * Same grid as the split.
 */
export function nearFieldMask(
	split: SplitResult,
	keep: PixelClass[] = [PixelClass.Object, PixelClass.Terrain],
	people?: MaskLike | null,
): { width: number; height: number; data: Uint8Array } {
	const { width: W, height: H } = split;
	const ks = new Set<number>(keep);
	const ppl = maskSampler(people);
	const data = new Uint8Array(W * H);
	for (let j = 0; j < H; j++)
		for (let i = 0; i < W; i++) {
			const k = j * W + i;
			data[k] =
				ks.has(split.cls[k]) && !ppl?.((i + 0.5) / W, (j + 0.5) / H) ? 255 : 0;
		}
	return { width: W, height: H, data };
}

/** Photos of a roll viewpoint that may join a spot: accepted poses only (never the EXIF prior). */
export function spotEligible(p: { poseSource: string }): boolean {
	return p.poseSource !== "prior";
}

/** toEnu (lift.ts) for an explicit camera → ENU rotation (row-major 3×3) and eye. */
export function toEnuMatrix(
	cloud: GaussianCloud,
	m: number[],
	eye: [number, number, number],
): GaussianCloud {
	const [qw, qx, qy, qz] = quatFromMatrix(m);
	const n = cloud.count;
	const P = new Float32Array(3 * n);
	const Q = new Float32Array(4 * n);
	const p = cloud.positions;
	const r = cloud.rotations;
	for (let i = 0; i < n; i++) {
		const x = p[3 * i];
		const y = p[3 * i + 1];
		const z = p[3 * i + 2];
		for (let a = 0; a < 3; a++)
			P[3 * i + a] =
				eye[a] + m[3 * a] * x + m[3 * a + 1] * y + m[3 * a + 2] * z;
		const bw = r[4 * i];
		const bx = r[4 * i + 1];
		const by = r[4 * i + 2];
		const bz = r[4 * i + 3];
		Q[4 * i] = qw * bw - qx * bx - qy * by - qz * bz;
		Q[4 * i + 1] = qw * bx + qx * bw + qy * bz - qz * by;
		Q[4 * i + 2] = qw * by - qx * bz + qy * bw + qz * bx;
		Q[4 * i + 3] = qw * bz + qx * by - qy * bx + qz * bw;
	}
	return {
		...cloud,
		frame: "enu",
		positions: P,
		rotations: Q,
		scales: cloud.scales.slice(),
		colors: cloud.colors.slice(),
		provenance: cloud.provenance.slice(),
		...(cloud.source ? { source: cloud.source.slice() } : {}),
	};
}

const mul3 = (a: number[], b: number[]) =>
	[0, 1, 2].flatMap((i) =>
		[0, 1, 2].map(
			(j) =>
				a[3 * i] * b[j] + a[3 * i + 1] * b[3 + j] + a[3 * i + 2] * b[6 + j],
		),
	);
const tr3 = (a: number[]) => [
	a[0],
	a[3],
	a[6],
	a[1],
	a[4],
	a[7],
	a[2],
	a[5],
	a[8],
];
const mv3 = (a: number[], v: number[]) =>
	[0, 1, 2].map(
		(i) => a[3 * i] * v[0] + a[3 * i + 1] * v[1] + a[3 * i + 2] * v[2],
	);

/** Nearest rotation to a 3×3 matrix (polar decomposition by Newton iteration R ← (R + R⁻ᵀ)/2). */
export function nearestRotation(m: number[]): number[] {
	let r = m.slice();
	for (let it = 0; it < 30; it++) {
		const [a, b, c, d, e, f, g, h, k] = r;
		const det = a * (e * k - f * h) - b * (d * k - f * g) + c * (d * h - e * g);
		if (!(Math.abs(det) > 1e-12)) break;
		// inverse transpose = cofactor matrix / det
		const it_ = [
			(e * k - f * h) / det,
			-(d * k - f * g) / det,
			(d * h - e * g) / det,
			-(b * k - c * h) / det,
			(a * k - c * g) / det,
			-(a * h - b * g) / det,
			(b * f - c * e) / det,
			-(a * f - c * d) / det,
			(a * e - b * d) / det,
		];
		const n = r.map((v, i) => 0.5 * (v + it_[i]));
		const dlt = n.reduce((s2, v, i) => s2 + Math.abs(v - r[i]), 0);
		r = n;
		if (dlt < 1e-12) break;
	}
	return r;
}

export type JointPlacementResult = {
	placements: SpotPlacement[];
	scale: number;
	/** Scale-fit samples and inlier fraction (DEM 15–300 m, all views). */
	n: number;
	inlierFrac: number;
	/** Per view: angle (deg) between the aligned model rotation and the Rigi rotation. */
	rotErrDeg: number[];
	/** Per view: |aligned model eye − Rigi eye| (m): how far the reconstruction moves each photographer. */
	eyeShiftM: number[];
};

/**
 * Place an UNPOSED multi-view reconstruction (/multiview without poses: consistent relative cameras and
 * depths, arbitrary similarity) in ENU. Rotation: the chordal mean of R_rigi · R_modelᵀ over the views
 * (Rigi orientations come from the far skyline and are good to ~1°). Scale: ONE robust scale of model ray
 * vs DEM range on DEM 15–300 m over all views (a curve would break the multi-view rigidity). Translation:
 * the mean over views of eye_rigi − s·Q·c_model (GPS eyes are only good to ~5–40 m; the model's relative
 * baselines are kept). `cameras[i].c2w` = the model's camera-to-first-camera 4×4 (row-major, OpenCV).
 */
export function jointPlacement(
	views: SpotView[],
	depths: NearFieldDepth[],
	cameras: { c2w: number[]; intrinsicsNorm: IntrinsicsNorm }[],
	band = 0.15,
): JointPlacementResult | null {
	const n = views.length;
	if (n < 2 || depths.length !== n || cameras.length !== n) return null;
	const Rm = cameras.map((c) =>
		[0, 1, 2].flatMap((i) => [
			c.c2w[4 * i],
			c.c2w[4 * i + 1],
			c.c2w[4 * i + 2],
		]),
	);
	const cm = cameras.map((c) => [c.c2w[3], c.c2w[7], c.c2w[11]]);
	const Rr = views.map((v) => camToEnuMatrix(v.pose));
	const acc = new Array(9).fill(0);
	for (let i = 0; i < n; i++) {
		const x = mul3(Rr[i], tr3(Rm[i]));
		for (let k = 0; k < 9; k++) acc[k] += x[k];
	}
	const Q = nearestRotation(acc);
	const Ks: IntrinsicsNorm[] = [];
	const logr: number[] = [];
	const regr: NearFieldDepth[] = [];
	for (let i = 0; i < n; i++) {
		const d = regridDepth(depths[i], views[i].aspect);
		regr.push(d);
		const K =
			d.intrinsicsNorm ?? intrinsicsFromPose(views[i].pose, views[i].aspect);
		Ks.push(K);
		const dem = gridDemRange(
			rangeGrid(views[i].range),
			views[i].range.width,
			views[i].range.height,
		);
		const sky = maskSampler(views[i].skyMask);
		const ppl = maskSampler(views[i].peopleMask);
		const { width: W, height: H } = d;
		const st = Math.max(1, Math.ceil(Math.sqrt((W * H) / 20_000)));
		for (let j = st >> 1; j < H; j += st)
			for (let k = st >> 1; k < W; k += st) {
				const z = d.depth[j * W + k];
				if (!d.valid[j * W + k] || !(z > 0)) continue;
				const u = (k + 0.5) / W;
				const v = (j + 0.5) / H;
				if (sky?.(u, v) || ppl?.(u, v)) continue;
				const r = dem(u, v);
				if (r == null || r < 15 || r > 300) continue;
				const x = (u - K.cx) / K.fx;
				const y = (v - K.cy) / K.fy;
				logr.push(Math.log(r / (z * Math.sqrt(1 + x * x + y * y))));
			}
	}
	if (logr.length < 50) return null;
	const ls = logMode(logr, band);
	const s = Math.exp(ls);
	const inl = logr.filter((x) => Math.abs(x - ls) <= band).length / logr.length;
	const T = [0, 0, 0];
	for (let i = 0; i < n; i++) {
		const qc = mv3(Q, cm[i]);
		for (let a = 0; a < 3; a++) T[a] += (views[i].eye[a] - s * qc[a]) / n;
	}
	const placements: SpotPlacement[] = [];
	const rotErrDeg: number[] = [];
	const eyeShiftM: number[] = [];
	for (let i = 0; i < n; i++) {
		const R = nearestRotation(mul3(Q, Rm[i]));
		const qc = mv3(Q, cm[i]);
		const eye = [0, 1, 2].map((a) => s * qc[a] + T[a]) as [
			number,
			number,
			number,
		];
		const d = mul3(tr3(R), Rr[i]);
		rotErrDeg.push(
			(Math.acos(Math.max(-1, Math.min(1, (d[0] + d[4] + d[8] - 1) / 2))) *
				180) /
				Math.PI,
		);
		eyeShiftM.push(
			Math.hypot(
				eye[0] - views[i].eye[0],
				eye[1] - views[i].eye[1],
				eye[2] - views[i].eye[2],
			),
		);
		placements.push({
			camToEnu: R,
			eye,
			scale: s,
			K: Ks[i],
			quality: inl,
			n: logr.length,
		});
	}
	return {
		placements,
		scale: s,
		n: logr.length,
		inlierFrac: inl,
		rotErrDeg,
		eyeShiftM,
	};
}
