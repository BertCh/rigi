// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Step Inside P3 (research flag only): DEM-conditioned generation along a short trajectory.
//   for each novel camera (sequential, GEN3C-style: every view sees the splats generated before it):
//     render the true RGB-D cache → hole mask → LaMa fills ONLY the holes → lift the filled pixels
//     (DEM depth where the DEM has a surface, else aligned monocular depth, else skip) → Gaussians with
//     provenance `generated` → merge.
// Generated splats never reach measurement exports (provenance.filterForExport) or the hover readout
// (./readout.ts). Browser only (the cache renders with three.js; the fill runs in the near-field service).
import { hfovFromAspect } from "../../camera";
import type { GaussianCloud } from "../types";
import { PROVENANCE_CODE } from "../types";
import type { CacheRenderer } from "./cache-render";
import {
	alignMono,
	type HoleStats,
	holeMask,
	holeStats,
	type LiftGeneratedStats,
	liftGenerated,
	type MonoAlign,
	mergeClouds,
	type RgbdView,
} from "./holes";
import {
	depthWithFov,
	type InpaintMeta,
	inpaint,
	rgbaToPng,
} from "./inpaint-client";
import type { NovelCamera } from "./trajectory";

/** Opt-in switch: `?nearfield=gen` (the lab route checks it; nothing else calls this module). */
export const GENERATE_FLAG = "gen";

export type GenerateOpts = {
	/** Novel-view width (px); height follows the photo aspect. Default 768. */
	width?: number;
	/** Hole dilation (px). Default 1. */
	dilate?: number;
	/** View pixels per generated Gaussian (each axis). Default 2. */
	stride?: number;
	/** LaMa processing long side. Default 1024. */
	inpaintMaxSide?: number;
	/** Use MoGe-2 on the filled view for holes without a DEM surface. Default true. */
	mono?: boolean;
	signal?: AbortSignal;
	onProgress?: (msg: string) => void;
};

export type GeneratedView = {
	camera: NovelCamera;
	/** The cache render BEFORE filling (observed content only). */
	view: RgbdView;
	hole: Uint8Array;
	stats: HoleStats;
	/** The inpainted view (sRGB RGBA), null when there was nothing to fill. */
	filled: Uint8ClampedArray | null;
	inpaintMeta: InpaintMeta | null;
	mono: MonoAlign | null;
	lift: LiftGeneratedStats;
	/** Generated Gaussians added by this view. */
	added: number;
	/** The merged scene rendered from this camera after the merge: true colour and Truth-tinted. */
	merged: RgbdView;
	mergedTruth: RgbdView;
	/**
	 * Self-consistency: over the hole pixels, the fraction the merged render now covers, and the mean |ΔRGB|
	 * (0..255) between the merged render and the filled image there (the lift reproduces the fill it came from).
	 */
	reproj: { covered: number; meanAbsDiff: number };
	ms: { render: number; inpaint: number; mono: number; lift: number };
};

export type GenerateResult = {
	views: GeneratedView[];
	/** Observed near-field splats + every generated one (ENU). */
	merged: GaussianCloud;
	generatedCount: number;
	observedCount: number;
};

const now = () => performance.now();

/**
 * Run the generator along `cameras`. `base` = the photo's near-field splats (ENU, observed/reconstructed).
 * Throws when the service has no /inpaint (the lab reports it); everything else degrades per view.
 */
export async function generateAlongTrajectory(
	cache: CacheRenderer,
	base: GaussianCloud,
	cameras: NovelCamera[],
	opts: GenerateOpts = {},
): Promise<GenerateResult> {
	const W = opts.width ?? 768;
	const H = Math.max(8, Math.round(W / cache.input.aspect));
	const stride = opts.stride ?? 2;
	let merged = base;
	const views: GeneratedView[] = [];
	for (const cam of cameras) {
		if (opts.signal?.aborted) break;
		opts.onProgress?.(`${cam.name}: rendering the RGB-D cache`);
		let t = now();
		cache.setSplats(merged);
		const view = cache.renderView(cam, W, H);
		const hole = holeMask(view, opts.dilate ?? 1);
		const stats = holeStats(view, hole);
		const ms = { render: now() - t, inpaint: 0, mono: 0, lift: 0 };
		let filled: Uint8ClampedArray | null = null;
		let meta: InpaintMeta | null = null;
		let mono: MonoAlign | null = null;
		let lift: LiftGeneratedStats = { demBacked: 0, mono: 0, skipped: 0 };
		let added = 0;
		if (stats.holeFrac > 0) {
			opts.onProgress?.(
				`${cam.name}: LaMa fills ${(100 * stats.holeFrac).toFixed(1)} % holes`,
			);
			t = now();
			const r = await inpaint(view.rgba, hole, W, H, {
				maxSide: opts.inpaintMaxSide ?? 1024,
				signal: opts.signal,
			});
			ms.inpaint = now() - t;
			if (!r)
				throw new Error(
					"near-field service /inpaint unavailable (tools/nearfield/run.sh; LaMa weights in tools/nearfield/service/weights/big-lama.pt)",
				);
			filled = r.rgba;
			meta = r.meta;
			// holes with no DEM surface that are not sky in the photo: monocular depth aligned to the DEM render
			let monoIn: {
				depth: NonNullable<Awaited<ReturnType<typeof depthWithFov>>>;
				align: MonoAlign;
			} | null = null;
			if ((opts.mono ?? true) && stats.noGeo > 0) {
				t = now();
				const needs = new Uint8Array(W * H);
				for (let k = 0; k < W * H; k++)
					needs[k] = hole[k] && !(view.range[k] > 0) ? 1 : 0;
				const K = cam.pose;
				const hfov = hfovFromAspect(K.vfov, cache.input.aspect);
				opts.onProgress?.(`${cam.name}: MoGe-2 depth for no-DEM holes`);
				const d = await depthWithFov(await rgbaToPng(filled, W, H), hfov, {
					maxSide: W,
				});
				if (d) {
					mono = alignMono(view, d, needs);
					monoIn = { depth: d, align: mono };
				}
				ms.mono = now() - t;
			}
			t = now();
			const L = liftGenerated(view, filled, hole, { stride, mono: monoIn });
			lift = L.stats;
			added = L.cloud.count;
			merged = mergeClouds(merged, L.cloud);
			ms.lift = now() - t;
		}
		cache.setSplats(merged);
		const after = cache.renderView(cam, W, H);
		const afterTruth = cache.renderView(cam, W, H, { truth: 0.65 });
		let cov = 0;
		let nh = 0;
		let diff = 0;
		if (filled)
			for (let k = 0; k < W * H; k++) {
				if (!hole[k]) continue;
				nh++;
				if (!after.observed[k]) continue;
				cov++;
				for (let c = 0; c < 3; c++)
					diff += Math.abs(after.rgba[4 * k + c] - filled[4 * k + c]);
			}
		views.push({
			camera: cam,
			view,
			hole,
			stats,
			filled,
			inpaintMeta: meta,
			mono,
			lift,
			added,
			merged: after,
			mergedTruth: afterTruth,
			reproj: {
				covered: nh ? cov / nh : 0,
				meanAbsDiff: cov ? diff / (3 * cov) : 0,
			},
			ms,
		});
	}
	let gen = 0;
	for (let i = 0; i < merged.count; i++)
		if (merged.provenance[i] === PROVENANCE_CODE.generated) gen++;
	return {
		views,
		merged,
		generatedCount: gen,
		observedCount: merged.count - gen,
	};
}
