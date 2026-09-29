// Browser glue for roll spots: RollMapEngine (DEM range buffers, people masks, poses in the roll frame)
// + the near-field service (/multiview DA3 with the Rigi poses, or per-photo /depth) → fuseSpot → a
// DeckSplatLayer on the roll map (the "Spot 3D" toggle in RollMap.tsx). Lazy-loaded; nothing here runs
// unless the toggle is switched on.
import type { Pose } from "../../camera";
import { GpuGeometrySource } from "../../deck/geometry-pass";
import { type DemRaster, latToTileY, loadDemTile, lonToTileX } from "../../dem";
import type { RollMapEngine } from "../../roll/map/roll-map";
import type { Roll, RollPhoto } from "../../roll/types";
import {
	type DepthModel,
	type NearFieldClient,
	type NearFieldMultiView,
	nearField,
} from "../client";
import { DeckSplatLayer } from "../deck-splat-layer";
import type { RGBAImage } from "../lift";
import { imageToRGBA } from "../scene";
import type { GaussianCloud, NearFieldDepth } from "../types";
import type { EyePair, EyeSolve } from "./eyes";
import {
	fuseSpot,
	type JointPlacementResult,
	jointPlacement,
	multiviewPoses,
	REFINE_EYES_DEFAULT,
	refineSpotEyes,
	type SpotOpts,
	type SpotResult,
	type SpotView,
	spotEligible,
	spotOrigin,
} from "./spot";

/**
 * "multiview": /multiview DA3 with the Rigi poses as known poses, then a DEM anchor per photo.
 * "multiview-joint": /multiview WITHOUT poses (DA3's own consistent relative cameras), placed in ENU as one
 *   rigid reconstruction (spot.jointPlacement: Rigi rotations, one DEM scale, mean GPS translation).
 * "moge2" / "da3": per-photo /depth, DEM anchor per photo.
 */
export type SpotDepthSource = "multiview" | "multiview-joint" | "moge2" | "da3";

export type RollSpotOpts = SpotOpts & {
	client?: NearFieldClient;
	/** "multiview" (default): one /multiview DA3 call with the poses; else per-photo /depth. */
	depth?: SpotDepthSource;
	/** Send the Rigi poses as known poses to /multiview. Default true. */
	posed?: boolean;
	/** One /multiview per photo orientation (default true; see buildRollSpot). */
	splitOrientations?: boolean;
	/** Sky masks from src/lib/sky (default true). */
	sky?: boolean;
	/** Long side (px) of the photo pixels used for colours (and uploaded). Default 1024. */
	pixelsLong?: number;
	signal?: AbortSignal;
	onStatus?: (s: string) => void;
	/**
	 * Measured photo pairs for the refineEyes step (SpotOpts.refineEyes), or a provider called with the placed
	 * cameras. There is no in-app matcher yet: pairs come from tools/nearfield/eyes (ALIKED+LightGlue offline).
	 */
	eyePairs?:
		| EyePair[]
		| ((
				cams: {
					id: string;
					pose: Pose;
					eye: [number, number, number];
					aspect: number;
				}[],
		  ) => Promise<EyePair[]>);
};

export type RollSpot = SpotResult & {
	ids: string[];
	depthModel: string;
	seconds: number;
	origin: [number, number, number];
	/** Per view, for exports / evaluation. */
	inputs: SpotView[];
	depths: (NearFieldDepth | null)[];
	/** "multiview-joint": the placement of each jointly reconstructed group. */
	joint: (JointPlacementResult | null)[];
	/** The refineEyes step's solution when it ran and moved the eyes (inputs[k].eye are the refined eyes). */
	eyes?: (EyeSolve & { pairs: EyePair[] }) | null;
};

/** The photos of a viewpoint that can join its spot (accepted poses only). */
export function spotPhotos(roll: Roll, viewpoint: number): RollPhoto[] {
	return roll.photos.filter(
		(p) => p.viewpoint === viewpoint && spotEligible(p),
	);
}

async function loadImage(src: string): Promise<{
	img: HTMLImageElement;
	blob: Blob;
}> {
	const blob = await (await fetch(src)).blob();
	const url = URL.createObjectURL(blob);
	try {
		const img = new Image();
		img.src = url;
		await img.decode();
		return { img, blob };
	} finally {
		URL.revokeObjectURL(url);
	}
}

/** Downscaled JPEG of an image (long side ≤ long) for the service upload. */
async function jpegOf(img: HTMLImageElement, long: number): Promise<Blob> {
	const s = Math.min(1, long / Math.max(img.naturalWidth, img.naturalHeight));
	const w = Math.max(1, Math.round(img.naturalWidth * s));
	const h = Math.max(1, Math.round(img.naturalHeight * s));
	const c = new OffscreenCanvas(w, h);
	c.getContext("2d")?.drawImage(img, 0, 0, w, h);
	return c.convertToBlob({ type: "image/jpeg", quality: 0.92 });
}

/**
 * Build the spot of the given photos (all within one viewpoint) from the map's terrain + the service.
 * Null when the service is unavailable or fewer than one view has depth.
 */
export async function buildRollSpot(
	engine: RollMapEngine,
	ids: string[],
	opts: RollSpotOpts = {},
): Promise<RollSpot | null> {
	const t0 = performance.now();
	const client = opts.client ?? nearField;
	const status = opts.onStatus ?? (() => {});
	const long = opts.pixelsLong ?? 1024;
	const mode = opts.depth ?? "multiview";
	if (!ids.length) return null;
	if (!(await client.available())) {
		status("near-field service unavailable");
		return null;
	}
	status("loading photos");
	const photos = new Map(engine.roll.photos.map((p) => [p.meta.id, p]));
	const loaded = await Promise.all(
		ids.map(async (id) => {
			const p = photos.get(id);
			if (!p) throw new Error(`buildRollSpot: ${id} not in the roll`);
			const { img } = await loadImage(p.meta.src);
			const rgba = imageToRGBA(img, long) as RGBAImage;
			return { id, img, rgba, upload: await jpegOf(img, long) };
		}),
	);
	if (opts.signal?.aborted) return null;

	status("depth");
	let model: string = mode;
	// DEM range buffers need the pose first: take the placed pose with a 1×1 render
	const cams = await Promise.all(ids.map((id) => engine.rangeMapFor(id, 1, 1)));
	if (cams.some((c) => !c)) {
		status("terrain not ready");
		return null;
	}
	const placed = cams as NonNullable<(typeof cams)[number]>[];
	// optional: relative eye refinement before anything uses the eyes (multiview poses, range buffers)
	let eyeSol: RollSpot["eyes"] = null;
	if (opts.eyePairs && (opts.refineEyes ?? REFINE_EYES_DEFAULT)) {
		status("refining eyes");
		const cams1 = ids.map((id, k) => ({
			id,
			pose: placed[k].pose,
			eye: placed[k].eye,
			aspect: placed[k].aspect,
		}));
		const pairs =
			typeof opts.eyePairs === "function"
				? await opts.eyePairs(cams1)
				: opts.eyePairs;
		const heightAt = await demHeightSampler(
			engine,
			placed.map((p) => p.eye),
		);
		eyeSol = refineSpotEyes(cams1, pairs, heightAt, opts);
		if (eyeSol)
			ids.forEach((id, k) => {
				const e = eyeSol?.eyes[id];
				if (e) placed[k] = { ...placed[k], eye: [e[0], e[1], e[2]] };
			});
	}
	const origin = spotOrigin(placed);
	const depths: (NearFieldDepth | null)[] = [];
	for (const _ of ids) depths.push(null);
	const perPhoto = async (k: number, dm: DepthModel) => {
		const d = await client.depth(loaded[k].upload, {
			model: dm,
			signal: opts.signal,
			timeoutMs: 300_000,
		});
		depths[k] = d;
		if (d) model = d.model;
	};
	const joint: { idx: number[]; cameras: NearFieldMultiView["cameras"] }[] = [];
	if (mode === "multiview" || mode === "multiview-joint") {
		// DA3 centre-crops a batch of mixed portrait + landscape photos to squares (the near field at the
		// bottom of a portrait photo is lost): one /multiview per orientation unless told otherwise
		const idx = ids.map((_, k) => k);
		const groups =
			opts.splitOrientations === false
				? [idx]
				: [
						idx.filter((k) => placed[k].aspect >= 1),
						idx.filter((k) => placed[k].aspect < 1),
					].filter((g) => g.length);
		for (const g of groups) {
			if (g.length < 2) {
				await perPhoto(g[0], "da3");
				continue;
			}
			const mv = await client.multiview(
				g.map((k) => loaded[k].upload),
				{
					poses:
						opts.posed === false || mode === "multiview-joint"
							? undefined
							: multiviewPoses(
									g.map((k) => placed[k]),
									origin,
								),
					signal: opts.signal,
				},
			);
			if (!mv) continue;
			g.forEach((k, n) => {
				depths[k] = mv.depths[n];
			});
			if (mode === "multiview-joint")
				joint.push({ idx: g, cameras: mv.cameras });
			model = mv.model;
		}
		if (depths.every((d) => !d)) {
			status("multiview failed");
			return null;
		}
	} else for (const k of ids.keys()) await perPhoto(k, mode);
	// sky: DA3-BASE has no sky output, and a sky pixel with depth and no DEM would be an "Object"
	const skies =
		opts.sky === false
			? ids.map(() => null)
			: await import("../../sky")
					.then(({ segmentSky }) =>
						Promise.all(
							loaded.map((l) =>
								segmentSky(l.img, { longSide: 512 }).catch(() => null),
							),
						),
					)
					.catch(() => ids.map(() => null));
	if (opts.signal?.aborted) return null;

	status("terrain range");
	const views: SpotView[] = [];
	for (const [k, l] of loaded.entries()) {
		const d = depths[k];
		const w = d?.width ?? 512;
		const h = d?.height ?? Math.round(512 / placed[k].aspect);
		const r = eyeSol
			? await rangeAtEye(engine, l.id, placed[k].eye, w, h)
			: await engine.rangeMapFor(l.id, w, h);
		if (!r) return null;
		views.push({
			id: l.id,
			pose: r.pose,
			eye: r.eye,
			aspect: r.aspect,
			photo: l.rgba,
			range: { width: w, height: h, data: r.range },
			peopleMask: engine.peopleMaskOf(l.id),
			skyMask: skies[k],
		});
	}
	const jointStats: (JointPlacementResult | null)[] = [];
	for (const g of joint) {
		const jp = jointPlacement(
			g.idx.map((k) => views[k]),
			g.idx.map((k) => depths[k] as NearFieldDepth),
			g.cameras,
		);
		jointStats.push(jp);
		if (jp)
			g.idx.forEach((k, n) => {
				views[k].placement = jp.placements[n];
			});
	}
	status("fusing");
	const res = fuseSpot(views, depths, opts);
	status(`${res.cloud.count} splats`);
	return {
		...res,
		ids,
		depthModel: model,
		seconds: (performance.now() - t0) / 1000,
		origin,
		inputs: views,
		depths,
		joint: jointStats,
		eyes: eyeSol,
	};
}

/** A photo's DEM range buffer rendered at an explicit eye (the refined one) with its placed pose. */
async function rangeAtEye(
	engine: RollMapEngine,
	id: string,
	eye: [number, number, number],
	w: number,
	h: number,
) {
	// rangeMapFor(1×1) gives the placed pose and flushes the deck layers the geometry pass reads
	const p = await engine.rangeMapFor(id, 1, 1);
	if (!p) return null;
	const src = new GpuGeometrySource(engine.deck, eye, w, h, { xyz: false });
	try {
		await src.render(p.pose);
		if (!src.pose) return null;
		return { ...p, eye, range: src.range.slice() };
	} finally {
		src.dispose();
	}
}

/**
 * DEM surface z in the roll frame near the given eyes (±40 m, 1 m posts, Mapterhorn z17, the tile sampling
 * of terrain.ts), as a sync lookup for the eye solver; null outside the sampled windows.
 */
async function demHeightSampler(
	engine: RollMapEngine,
	eyes: [number, number, number][],
	half = 40,
	z = 17,
): Promise<(e: number, n: number) => number | null> {
	const fr = engine.frame;
	const tiles = new Map<string, Promise<DemRaster | null>>();
	const tileOf = (lat: number, lon: number) => {
		const fx = lonToTileX(lon, z);
		const fy = latToTileY(lat, z);
		const key = { z, x: Math.floor(fx), y: Math.floor(fy) };
		const k = `${key.x}/${key.y}`;
		if (!tiles.has(k))
			tiles.set(
				k,
				loadDemTile(key).catch(() => null),
			);
		return { t: tiles.get(k) as Promise<DemRaster | null>, fx, fy, key };
	};
	const grids = await Promise.all(
		eyes.map(async (eye) => {
			const n = 2 * half + 1;
			const g = new Float32Array(n * n).fill(Number.NaN);
			const e0 = Math.round(eye[0]) - half;
			const n0 = Math.round(eye[1]) - half;
			await Promise.all(
				Array.from({ length: n * n }, async (_, k) => {
					const e = e0 + (k % n);
					const nn = n0 + Math.floor(k / n);
					const geo = fr.toGeo(e, nn, eye[2]);
					const s = tileOf(geo.lat, geo.lon);
					const t = await s.t;
					if (!t) return;
					const S = t.size;
					const x = Math.min(Math.max((s.fx - s.key.x) * S - 0.5, 0), S - 1);
					const y = Math.min(Math.max((s.fy - s.key.y) * S - 0.5, 0), S - 1);
					const x0 = Math.floor(x);
					const y0 = Math.floor(y);
					const x1 = Math.min(x0 + 1, S - 1);
					const y1 = Math.min(y0 + 1, S - 1);
					const H = t.heights;
					const a = H[y0 * S + x0] * (1 - (x - x0)) + H[y0 * S + x1] * (x - x0);
					const b = H[y1 * S + x0] * (1 - (x - x0)) + H[y1 * S + x1] * (x - x0);
					const hgt = a * (1 - (y - y0)) + b * (y - y0);
					g[k] = fr.fromGeo(geo.lat, geo.lon, hgt)[2];
				}),
			);
			return { e0, n0, n, g };
		}),
	);
	return (e, nn) => {
		for (const { e0, n0, n, g } of grids) {
			const x = e - e0;
			const y = nn - n0;
			if (!(x >= 0 && y >= 0 && x <= n - 1 && y <= n - 1)) continue;
			const xi = Math.min(Math.floor(x), n - 2);
			const yi = Math.min(Math.floor(y), n - 2);
			const fx = x - xi;
			const fy = y - yi;
			const v =
				g[yi * n + xi] * (1 - fx) * (1 - fy) +
				g[yi * n + xi + 1] * fx * (1 - fy) +
				g[(yi + 1) * n + xi] * (1 - fx) * fy +
				g[(yi + 1) * n + xi + 1] * fx * fy;
			if (Number.isFinite(v)) return v;
		}
		return null;
	};
}

/** The roll-map layer for a spot cloud (DeckSplatLayer, canvas pass, log depth like the terrain). */
export function spotLayer(
	cloud: GaussianCloud,
	o: { truth?: boolean; opacity?: number } = {},
) {
	return new DeckSplatLayer({
		id: "spot3d",
		cloud,
		truth: o.truth ?? false,
		opacity: o.opacity ?? 1,
		maxRadiusPx: 256,
	});
}
