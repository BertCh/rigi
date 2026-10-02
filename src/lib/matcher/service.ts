// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The in-browser render-and-match "service": what tools/matcher/server/app.py did over HTTP, run on the
// page's own engine and GPU. "Service up" is now "models available": an engine is bound (the photo
// workspace binds its engine) and the keypoint models load. Jobs are serialised (one engine, one GPU):
// a request arriving while one runs waits (the client defers it, as it did on a 503).

import type { Pose } from "#/lib/camera";
import { getFlag } from "#/lib/flags";
import type {
	MatchRequest,
	MatchResult,
	SkylineCueInput,
} from "#/lib/matcher-client";
import { Deadline, MATCHER_VERSION, type StageResult } from "./assemble";
import { boundMatcherEngine } from "./binding";
import {
	Cancelled,
	correspond,
	type FeatureBackend,
	type MatchContext,
	type PhotoSource,
	type RgbaImage,
	skylineCue,
} from "./context";
import type { View } from "./core";
import { skylineFromArrays } from "./fusion";
import { matchAdhoc, matchKnownPrior } from "./pipeline";
import { assembleOffThread } from "./solve-offthread";
import { matchAdhocT6 } from "./t6";

export { bindMatcherEngine, type MatcherEngine } from "./binding";

type FeatureLoader = () => Promise<FeatureBackend | null>;
let loader: FeatureLoader = async () => null;
let features: Promise<FeatureBackend | null> | null = null;

/** The keypoint backend (src/lib/features); registered by ./features.ts, injectable in tests. */
export function setFeatureLoader(l: FeatureLoader) {
	loader = l;
	features = null;
}

function loadFeatures(): Promise<FeatureBackend | null> {
	features ??= loader().catch((e) => {
		console.warn("[matcher] keypoint models unavailable", e);
		return null;
	});
	features.then((f) => {
		if (!f) features = null; // retry on the next request (a network blip must not stick)
	});
	return features;
}

/** "Service up": an engine is bound and the keypoint models load. */
export async function modelsAvailable(): Promise<boolean> {
	if (!boundMatcherEngine()) return false;
	return !!(await loadFeatures());
}

// ---------- the job queue ----------

let running: { since: number } | null = null;
let waiting = 0;
let chain: Promise<unknown> = Promise.resolve();

export const queueState = () => ({ running: running != null, waiting });

async function exclusive<T>(
	fn: () => Promise<T>,
	onBusy?: () => void,
): Promise<T> {
	if (running || waiting) onBusy?.();
	waiting++;
	const prev = chain;
	let release!: () => void;
	chain = new Promise<void>((r) => {
		release = r;
	});
	try {
		await prev.catch(() => {});
	} finally {
		waiting--;
	}
	running = { since: performance.now() };
	try {
		return await fn();
	} finally {
		running = null;
		release();
	}
}

// ---------- photo rasters ----------

async function rasterize(
	src: CanvasImageSource,
	W: number,
	H: number,
): Promise<RgbaImage> {
	const cv = new OffscreenCanvas(W, H);
	const g = cv.getContext("2d");
	if (!g) throw new Error("matcher: no 2d context");
	g.imageSmoothingEnabled = true;
	g.imageSmoothingQuality = "high";
	g.drawImage(src, 0, 0, W, H);
	return g.getImageData(0, 0, W, H);
}

async function photoFrom(src: Blob | HTMLImageElement): Promise<PhotoSource> {
	const bmp =
		src instanceof Blob
			? await createImageBitmap(src, { imageOrientation: "from-image" })
			: await createImageBitmap(src);
	return {
		width: bmp.width,
		height: bmp.height,
		at: (W, H) => rasterize(bmp, W, H),
	};
}

async function decodeRgba(blob: Blob, W: number, H: number) {
	const bmp = await createImageBitmap(blob);
	try {
		return (await rasterize(bmp, W, H)).data;
	} finally {
		bmp.close();
	}
}

function cueFromInput(sk: SkylineCueInput, prior: Pose) {
	return skylineFromArrays(sk.w, sk.h, sk.fine, sk.fg, sk.sky, sk.horizon, {
		prior,
		pose: sk.pose,
		confidence: sk.confidence ?? null,
		accepted: sk.accepted,
	});
}

/** Caller-rendered views (the multipart mode): correspond + assemble on the given arrays. */
async function matchViews(
	ctx: MatchContext,
	req: Extract<MatchRequest, { views: unknown }>,
): Promise<StageResult> {
	const views: View[] = [];
	for (const v of req.views)
		views.push({
			tag: v.tag,
			pose: v.pose,
			W: v.W,
			H: v.H,
			rgba: await decodeRgba(v.rgb, v.W, v.H),
			xyz: v.xyz,
		});
	const fused = req.fused !== false;
	let sk = fused && req.skyline ? cueFromInput(req.skyline, req.prior) : null;
	let note: string | null = null;
	if (fused && !sk) {
		if (
			req.photoId &&
			ctx.engine === boundMatcherEngine() &&
			boundMatcherEngine()?.photo.id === req.photoId
		) {
			sk = await skylineCue(ctx, req.prior);
		}
		if (!sk) note = "no skyline parts and no photoId to export them for";
	}
	const corr = await correspond(ctx, views, req.eye);
	return assembleOffThread(corr, views, req.eye, req.prior, sk, {
		fused,
		freeFocal: !!req.freeFocal,
		deadline: ctx.deadline,
		skyNote: note,
	});
}

/**
 * Run one match request in the browser. null when the models or the engine are unavailable, the request
 * does not fit the bound engine (another photo), it times out, is aborted or finds no pose.
 */
export async function runMatch(
	req: MatchRequest,
	opts: { signal?: AbortSignal; timeoutMs?: number; onBusy?: () => void } = {},
): Promise<MatchResult | null> {
	const timeoutMs = opts.timeoutMs ?? 60_000;
	const t0 = performance.now();
	if (opts.signal?.aborted) return null;
	const fb = await loadFeatures();
	const e = boundMatcherEngine();
	if (!fb || !e) return null;
	try {
		return await exclusive(async () => {
			if (boundMatcherEngine() !== e) return null; // the workspace moved on while queued
			const ctx: MatchContext = {
				engine: e,
				features: fb,
				photo: null as unknown as PhotoSource,
				deadline: t0 + timeoutMs,
				signal: opts.signal,
				timing: {},
			};
			let res: StageResult;
			if ("meta" in req) {
				ctx.photo = await photoFrom(req.photo);
				const policy = getFlag("matcherPolicy");
				const adhoc = {
					prior: req.prior,
					fused: req.fused,
					positionSource: req.meta.positionSource,
					positionUncertainM: req.positionUncertainM,
					yawSeeds: req.yawSeeds,
					poseSeeds: req.poseSeeds,
				};
				const known =
					req.prior.yaw != null &&
					req.prior.pitch != null &&
					req.prior.roll != null &&
					req.prior.vfov != null;
				res =
					policy === "t6" && !known && req.fused !== false
						? await matchAdhocT6(ctx, adhoc)
						: await matchAdhoc(ctx, adhoc);
			} else if ("views" in req) {
				ctx.photo = await photoFrom(req.photo);
				res = await matchViews(ctx, req);
			} else {
				if (e.photo.id !== req.photoId) return null;
				const img = e.photoElement;
				if (!img) return null;
				ctx.photo = await photoFrom(img);
				res = await matchKnownPrior(ctx, req.prior, {
					offsets: req.offsets,
					fused: req.fused,
					freeFocal: req.freeFocal,
				});
			}
			if (!res.pose) return null;
			res.version = MATCHER_VERSION;
			res.timingMs = {
				...res.timingMs,
				total: Math.round(performance.now() - t0),
			};
			return res;
		}, opts.onBusy);
	} catch (err) {
		if (err instanceof Cancelled || (err as Error)?.name === "AbortError")
			return null;
		if (err instanceof Deadline) {
			console.warn("[matcher] timed out after", timeoutMs, "ms");
			return null;
		}
		console.warn("[matcher] match failed", err);
		return null;
	}
}
