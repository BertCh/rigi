// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Scene builder: depth (+ optional service cloud) + the solved renderer pose → NearFieldScene in ENU.
// Pure TS; the renderer is only read through a structural subset of src/lib/renderer.ts Renderer.
// Placement: the range-dependent anchor curve (anchor.ts) for every model sample, overridden per object by the DEM
// range at its ground contact (ground.ts) where the object visibly stands on modelled terrain.
import type { Pose } from "../camera";
import {
	type AnchorLike,
	type AnchorOpts,
	anchoredRange,
	fitAnchor,
	logMode,
} from "./anchor";
import {
	type DemRangeAt,
	gridDemRange,
	type IntrinsicsNorm,
	intrinsicsFromPose,
	type MaskLike,
	maskSampler,
	median,
	modelDepth,
	rayFactor,
	sampleDemGrid,
} from "./geom";
import {
	cellAt,
	type FarObjectOpts,
	type GroundOpts,
	type GroundResult,
	groundObjects,
	isFarComponent,
	placedDepth,
	placedRange,
	promoteFarObjects,
} from "./ground";
import { type LiftOpts, liftToGaussians, type RGBAImage, toEnu } from "./lift";
import { selectSplats } from "./provenance";
import { classifyRange, splitPixels } from "./split";
import {
	DEFAULT_SPLIT,
	type GaussianCloud,
	type NearFieldDepth,
	type NearFieldScene,
	PixelClass,
	type SplitParams,
	type SplitResult,
} from "./types";

/** The Renderer members the builder reads (PhotoEngine and DeckEngine both satisfy it). */
export type NearFieldRendererLike = {
	readonly pose: Pose;
	readonly aspect: number;
	readonly eye: { readonly x: number; readonly y: number; readonly z: number };
	sampleAt(u: number, v: number): { range: number } | null;
};

export type BuildSceneInput = {
	photoId: string;
	depth: NearFieldDepth;
	/** Camera-frame cloud from /gaussians (SHARP etc.); null/undefined → depth-lift from `photo`. */
	cloud?: GaussianCloud | null;
	renderer: NearFieldRendererLike;
	/** RGBA of the photo (any resolution, same framing as the depth); needed only for the depth-lift. */
	photo?: RGBAImage | null;
	skyMask?: MaskLike | null;
	peopleMask?: MaskLike | null;
	split?: SplitParams;
	anchor?: AnchorOpts;
	lift?: LiftOpts;
	/**
	 * Normalised intrinsics the service built `cloud` with (the /gaussians X-NearField-Meta intrinsicsNorm,
	 * NearFieldClient.gaussiansWithMeta). The cloud is re-projected onto the photo's rays so every Gaussian
	 * stays on the pixel it was seen at. Default: depth.intrinsicsNorm (right for model "lift" with the same
	 * depth model), else the photo intrinsics (no re-projection).
	 */
	cloudIntrinsics?: IntrinsicsNorm | null;
	/** Pre-sampled DEM range grid at depth resolution (geom.sampleDemGrid; NaN = none) to skip resampling. */
	demGrid?: Float32Array;
	/** Object grounding (ground.ts) options; false = place every sample by the anchor curve alone. */
	ground?: Partial<GroundOpts> | false;
	/**
	 * Grounded far objects beyond nearRadius (ground.ts promoteFarObjects: skyline / strong DEM discontinuity,
	 * up to farRadius 600 m). false = off (needs grounding).
	 */
	farObjects?: Partial<FarObjectOpts> | false;
};

/**
 * Confidence radius (m) from the anchored ranges of the kept near field:
 *   r = min(60, 0.5 · median) + 10.
 * Rationale: moving the eye by a fraction of the distance to the nearest content keeps the parallax within
 * what one view can support (disocclusions grow with baseline / depth), so half the median object range; the
 * 60 m cap keeps it within the design's "±10–30 m, orbit a little" budget with margin for far objects, and the
 * +10 m floor always allows a small step even for a subject at arm's length. No content → 10 m.
 */
export function confidenceRadiusFrom(ranges: ArrayLike<number>): number {
	const m = median(ranges);
	return Number.isFinite(m) ? Math.min(60, 0.5 * m) + 10 : 10;
}

/**
 * Relative scale that brings a camera-frame cloud into the depth model's units: the mode of
 * log(depth z / Gaussian z) over the Gaussians that land on a valid depth cell (front surfaces dominate;
 * Gaussians hidden behind them give smaller ratios and fall outside the mode). `K` projects the cloud.
 * 1 when fewer than 30 Gaussians can be compared. A cloud lifted from the same depth gives exactly 1; a
 * SHARP cloud (own metric scale) gives its scale relative to the depth the anchor was fitted on.
 */
function cloudDepthScale(
	positions: Float32Array,
	count: number,
	K: IntrinsicsNorm,
	depth: NearFieldDepth,
): number {
	const { width: W, height: H } = depth;
	const step = Math.max(1, Math.ceil(count / 40_000));
	const r: number[] = [];
	for (let i = 0; i < count; i += step) {
		const x = positions[3 * i];
		const y = positions[3 * i + 1];
		const z = positions[3 * i + 2];
		if (!(z > 0)) continue;
		const u = K.cx + (K.fx * x) / z;
		const v = K.cy + (K.fy * y) / z;
		if (!(u >= 0 && u < 1 && v >= 0 && v < 1)) continue;
		const zd = modelDepth(
			depth,
			Math.min(H - 1, Math.floor(v * H)) * W +
				Math.min(W - 1, Math.floor(u * W)),
		);
		if (zd > 0) r.push(Math.log(zd / z));
	}
	if (r.length < 30) return 1;
	const m = logMode(r, 0.1);
	return Number.isFinite(m) ? Math.exp(m) : 1;
}

/**
 * Keep the Gaussians of a camera-frame service cloud that are near-field objects. Each Gaussian is
 * (1) re-projected from the service's intrinsics `align.cloudK` onto the photo ray through the same pixel
 * (z kept), (2) brought into the depth model's units with cloudDepthScale when `align.depth` is given
 * (the anchor was fitted on that depth), (3) rescaled about the camera by the anchor (position and
 * scales), and classified against the DEM with classifyRange at its photo pixel (intrinsics `K`).
 * Off-image and sky-mask Gaussians are dropped. Returns a camera-frame cloud.
 */
function anchorAndFilterCloud(
	cloud: GaussianCloud,
	anchor: AnchorLike,
	K: IntrinsicsNorm,
	demRangeAt: DemRangeAt,
	skyMask: MaskLike | null,
	peopleMask: MaskLike | null,
	params: SplitParams = DEFAULT_SPLIT,
	keep: PixelClass[] = [PixelClass.Object],
	align: {
		cloudK?: IntrinsicsNorm | null;
		depth?: NearFieldDepth | null;
		/** Grounding on the depth grid: grounded components' Gaussians take their factor; dropped cells are removed. */
		ground?: GroundResult | null;
	} = {},
): GaussianCloud {
	const g = align.ground ?? null;
	if (cloud.frame !== "camera")
		throw new Error("anchorAndFilterCloud: expects a camera-frame cloud");
	const sky = maskSampler(skyMask);
	const people = maskSampler(peopleMask);
	const keepSet = new Set<number>(keep);
	const cK = align.cloudK ?? K;
	const n0 = cloud.count;
	const src = cloud.positions;
	// (1) onto the photo rays
	let p = src;
	if (cK.fx !== K.fx || cK.fy !== K.fy || cK.cx !== K.cx || cK.cy !== K.cy) {
		p = new Float32Array(3 * n0);
		for (let i = 0; i < n0; i++) {
			const z = src[3 * i + 2];
			const u = cK.cx + (cK.fx * src[3 * i]) / z;
			const v = cK.cy + (cK.fy * src[3 * i + 1]) / z;
			p[3 * i] = ((u - K.cx) / K.fx) * z;
			p[3 * i + 1] = ((v - K.cy) / K.fy) * z;
			p[3 * i + 2] = z;
		}
	}
	// (2) into depth-model units
	const rel = align.depth ? cloudDepthScale(p, n0, K, align.depth) : 1;
	const idx: number[] = [];
	const fac: number[] = [];
	for (let i = 0; i < n0; i++) {
		const x = p[3 * i];
		const y = p[3 * i + 1];
		const z = p[3 * i + 2];
		if (!(z > 0)) continue;
		const u = K.cx + (K.fx * x) / z;
		const v = K.cy + (K.fy * y) / z;
		if (!(u >= 0 && u < 1 && v >= 0 && v < 1) || sky?.(u, v)) continue;
		const len = rel * Math.hypot(x, y, z);
		const range = anchoredRange(anchor, len);
		if (!(range > 0)) continue;
		let c = classifyRange(range, demRangeAt(u, v), !!people?.(u, v), params);
		const cell = g ? cellAt(g, u, v) : -1;
		// a grounded far object (promoteFarObjects) is Object although beyond nearRadius
		if (
			c === PixelClass.Far &&
			g &&
			g.split.cls[cell] === PixelClass.Object &&
			isFarComponent(g.components[g.labels[cell]])
		)
			c = PixelClass.Object;
		if (!keepSet.has(c)) continue;
		if (g?.dropped?.[cell]) continue;
		const placed = g ? placedRange(g, anchor, cell, len) : range;
		if (!(placed > 0)) continue;
		idx.push(i);
		fac.push(placed / len);
	}
	const out = selectSplats(cloud, idx);
	for (let k = 0; k < idx.length; k++) {
		const i = idx[k];
		const f = rel * fac[k];
		for (let a = 0; a < 3; a++) {
			out.positions[3 * k + a] = p[3 * i + a] * f;
			out.scales[3 * k + a] *= f;
		}
	}
	return out;
}

/** Placed ray lengths (grounded factor, else the anchor) of the depth cells of one class. */
function classRanges(
	depth: NearFieldDepth,
	split: SplitResult,
	anchor: AnchorLike,
	K: IntrinsicsNorm,
	cls: PixelClass,
	stride = 2,
	ground: GroundResult | null = null,
): number[] {
	const out: number[] = [];
	const { width: W, height: H } = depth;
	for (let j = 0; j < H; j += stride)
		for (let i = 0; i < W; i += stride) {
			const k = j * W + i;
			if (split.cls[k] !== cls) continue;
			// far objects (promoteFarObjects) do not widen the step radius
			if (ground && isFarComponent(ground.components[ground.labels[k]]))
				continue;
			const z = modelDepth(depth, k);
			if (Number.isNaN(z)) continue;
			out.push(
				placedRange(
					ground,
					anchor,
					k,
					z * rayFactor(K, (i + 0.5) / W, (j + 0.5) / H),
				),
			);
		}
	return out;
}

/**
 * Build the near-field scene for one photo. Deterministic and synchronous (the DEM sampling is
 * O(depth pixels) calls to renderer.sampleAt, so pass `demGrid` when rebuilding at the same pose).
 * The caller decides whether to show it: hide when `scene.anchor.quality < ANCHOR_MIN_QUALITY`.
 * The renderer's geometry buffer must describe the current pose (await renderer.readback()).
 */
export function buildNearFieldScene(input: BuildSceneInput): NearFieldScene {
	const { depth, renderer } = input;
	const params = input.split ?? DEFAULT_SPLIT;
	const sky = input.skyMask ?? null;
	const people = input.peopleMask ?? null;
	const K = intrinsicsFromPose(renderer.pose, renderer.aspect);
	const grid =
		input.demGrid && input.demGrid.length === depth.width * depth.height
			? input.demGrid
			: sampleDemGrid(
					depth.width,
					depth.height,
					(u, v) => renderer.sampleAt(u, v)?.range ?? null,
				);
	const dem = gridDemRange(grid, depth.width, depth.height);
	const anchor = fitAnchor(depth, dem, K, {
		skyMask: sky,
		peopleMask: people,
		...input.anchor,
	});
	const split0 = splitPixels(depth, anchor, dem, sky, people, params, K);
	const ground0 =
		input.ground === false
			? null
			: groundObjects(depth, split0, anchor, dem, K, input.ground);
	const ground =
		ground0 && input.farObjects !== false
			? promoteFarObjects(
					depth,
					ground0,
					anchor,
					dem,
					K,
					params,
					input.farObjects || {},
					input.ground || {},
				)
			: ground0;
	const split = ground?.split ?? split0;
	let cam: GaussianCloud;
	if (input.cloud && input.cloud.count > 0)
		cam = anchorAndFilterCloud(
			input.cloud,
			anchor,
			K,
			dem,
			sky,
			people,
			params,
			undefined,
			{
				cloudK: input.cloudIntrinsics ?? depth.intrinsicsNorm ?? K,
				depth,
				ground,
			},
		);
	else if (input.photo)
		cam = liftToGaussians(
			placedDepth(depth, ground, anchor, K),
			input.photo,
			K,
			split,
			{ ...input.lift, anchor: { scale: 1, shift: 0 } },
		);
	else cam = emptyCloud();
	const splats = toEnu(cam, renderer.pose, renderer.eye);
	let ranges = classRanges(
		depth,
		split,
		anchor,
		K,
		PixelClass.Object,
		2,
		ground,
	);
	if (ranges.length < 20)
		ranges = classRanges(depth, split, anchor, K, PixelClass.Terrain);
	return {
		photoId: input.photoId,
		anchor,
		split,
		splats,
		confidenceRadius: confidenceRadiusFrom(ranges),
	};
}

function emptyCloud(frame: GaussianCloud["frame"] = "camera"): GaussianCloud {
	return {
		count: 0,
		frame,
		positions: new Float32Array(0),
		scales: new Float32Array(0),
		rotations: new Float32Array(0),
		colors: new Uint8Array(0),
		provenance: new Uint8Array(0),
	};
}

/**
 * Browser helper: RGBA pixels of an image element / bitmap, downscaled so the long side ≤ maxSide.
 * null outside the browser or when the canvas is unavailable (tainted, no 2D context).
 */
export function imageToRGBA(
	img: CanvasImageSource & { width: number; height: number },
	maxSide = 1024,
): RGBAImage | null {
	const w0 = (img as HTMLImageElement).naturalWidth || img.width;
	const h0 = (img as HTMLImageElement).naturalHeight || img.height;
	if (!w0 || !h0) return null;
	const s = Math.min(1, maxSide / Math.max(w0, h0));
	const w = Math.max(1, Math.round(w0 * s));
	const h = Math.max(1, Math.round(h0 * s));
	try {
		const canvas: OffscreenCanvas | HTMLCanvasElement =
			typeof OffscreenCanvas !== "undefined"
				? new OffscreenCanvas(w, h)
				: Object.assign(document.createElement("canvas"), {
						width: w,
						height: h,
					});
		const ctx = canvas.getContext("2d") as
			| CanvasRenderingContext2D
			| OffscreenCanvasRenderingContext2D
			| null;
		if (!ctx) return null;
		ctx.drawImage(img, 0, 0, w, h);
		const d = ctx.getImageData(0, 0, w, h);
		return { width: w, height: h, data: d.data };
	} catch {
		return null;
	}
}
