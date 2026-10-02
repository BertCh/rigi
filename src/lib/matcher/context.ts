// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The in-browser matcher's request context: the engine that renders the views (the app's own deck
// engine, WebGL2 or WebGPU, through the Renderer interface: renderPoseView / loadSatellite /
// loadFullTerrain / matchEvidence), the keypoint backend (src/lib/features: ALIKED + LightGlue), the
// photo, the deadline and the abort signal. Replaces the service's render worker (playwright driving a
// headless /photo page), its job queue and its client-cancel hooks.

import type { Pose } from "#/lib/camera";
import type { MatchEvidence, Renderer } from "#/lib/renderer";
import { Deadline } from "./assemble";
import type { BasinGap } from "./basin";
import type { BasinJob } from "./basin-run";
import {
	type Correspondences,
	checkView,
	lift,
	type PerView,
	type View,
} from "./core";
import { type SkylineApp, type SkylineCue, skylineFromArrays } from "./fusion";
import { dang } from "./geometry";

/** The engine surface the matcher uses. */
export type MatchEngine = Pick<
	Renderer,
	| "aspect"
	| "prior"
	| "eye"
	| "frame"
	| "renderPoseView"
	| "loadSatellite"
	| "loadFullTerrain"
	| "matchEvidence"
>;

export type RgbaImage = {
	data: Uint8Array | Uint8ClampedArray;
	width: number;
	height: number;
};

/** The frozen src/lib/features interface (L1), injected so the numerics stay testable without models. */
export type FeatureSet = {
	width: number;
	height: number;
	keypoints: Float32Array;
	scores: Float32Array;
	descriptors: Float32Array;
	dim: number;
	count: number;
};
export type FeatureMatches = {
	indices0: Uint32Array;
	indices1: Uint32Array;
	scores: Float32Array;
	count: number;
};
export type FeatureBackend = {
	extractFeatures(
		image: RgbaImage,
		opts?: { maxKeypoints?: number; longSide?: number; signal?: AbortSignal },
	): Promise<FeatureSet>;
	matchFeatures(
		a: FeatureSet,
		b: FeatureSet,
		opts?: { minScore?: number; signal?: AbortSignal },
	): Promise<FeatureMatches>;
};

/** The photo, rasterised on demand at the views' size (core.correspond resizes it to W×H). */
export type PhotoSource = {
	width: number;
	height: number;
	at(W: number, H: number): Promise<RgbaImage>;
};

export class Cancelled extends Error {
	constructor(reason = "aborted") {
		super(reason);
		this.name = "AbortError";
	}
}

export type MatchContext = {
	engine: MatchEngine;
	features: FeatureBackend;
	photo: PhotoSource;
	/** performance.now() deadline (ms) */
	deadline: number;
	signal?: AbortSignal;
	onStage?: (stage: string) => void;
	/** extracted photo features per size / keypoint cap (one request reuses them across views and stages) */
	photoFeatures?: Map<string, Promise<FeatureSet>>;
	/** satellite drape radius already loaded on this engine for this request (0 = everything) */
	drape?: number | null;
	timing: Record<string, number>;
	/** the position-grid basin gap (default: ./basin-run.ts in the solve worker); injectable in tests */
	basinGap?: (job: BasinJob) => Promise<BasinGap>;
};

/** Stage boundary: record it, stop on abort or past the deadline. */
export function tick(ctx: MatchContext, stage?: string) {
	if (stage) ctx.onStage?.(stage);
	if (ctx.signal?.aborted)
		throw new Cancelled(`aborted${stage ? ` at ${stage}` : ""}`);
	if (performance.now() > ctx.deadline) throw new Deadline();
}

export const eyeOf = (e: MatchEngine): [number, number, number] => [
	e.eye.x,
	e.eye.y,
	e.eye.z,
];

/** Satellite drape for the views (the former render worker: once per page; `limitM` 0 = every tile). */
export async function ensureSatellite(ctx: MatchContext, limitM: number) {
	const have = ctx.drape;
	if (have != null && (have === 0 || (limitM !== 0 && limitM <= have))) return;
	await ctx.engine.loadSatellite(limitM, 2);
	ctx.drape = limitM;
}

export type ViewPose = Pose & { tag: string };

export const fanPoses = (prior: Pose, offsets: number[]): ViewPose[] =>
	offsets.map((d) => ({
		tag: `y${d >= 0 ? "+" : ""}${d}`,
		yaw: prior.yaw + d,
		pitch: prior.pitch,
		roll: prior.roll,
		vfov: prior.vfov,
	}));

/** Sparse non-sky count (the worker's 1-in-97 sample). */
function terrainSamples(xyz: Float32Array) {
	let n = 0;
	for (let i = 0; i < xyz.length; i += 97) if (xyz[i] !== 0) n++;
	return n;
}

/**
 * The former render worker's renderOnce: one offscreen view per pose (satellite RGBA + ENU xyz). A view without any
 * terrain is retried once; with `allowEmpty` it is skipped (narrow fans can be all sky), else it fails.
 */
export async function renderViews(
	ctx: MatchContext,
	poses: ViewPose[],
	o: { allowEmpty?: boolean } = {},
): Promise<View[]> {
	const out: View[] = [];
	for (const p of poses) {
		tick(ctx);
		const pose = { yaw: p.yaw, pitch: p.pitch, roll: p.roll, vfov: p.vfov };
		let r = await ctx.engine.renderPoseView(pose);
		if (!r)
			throw new Error(
				"renderPoseView returned nothing (engine not ready or disposed)",
			);
		if (!terrainSamples(r.xyz) && !o.allowEmpty) {
			r = await ctx.engine.renderPoseView(pose);
			if (!r) throw new Error("renderPoseView returned nothing");
		}
		if (!terrainSamples(r.xyz)) {
			if (o.allowEmpty) continue;
			throw new Error(
				`empty render for ${p.tag} (no terrain in view after a retry)`,
			);
		}
		out.push({
			tag: p.tag,
			pose,
			W: r.width,
			H: r.height,
			rgba: r.rgba,
			xyz: r.xyz,
		});
	}
	return out;
}

/**
 * The former render worker's exportSkyline: autoAlign(true) from `prior`, the app's acceptance rule (confidence > 0.2,
 * else a near-compass alternative within 4° of the prior's yaw, else the prior), and the fused solve's
 * skyline cue from the edge planes + horizonDirs. null when the engine has no horizon / edge map.
 */
export async function skylineCue(
	ctx: MatchContext,
	prior: Pose,
): Promise<SkylineCue | null> {
	tick(ctx);
	const ev: MatchEvidence | null = await ctx.engine.matchEvidence(prior);
	if (!ev) return null;
	const res = ev.align;
	const near = res?.alternatives?.find(
		(a) => Math.abs(dang(a.pose.yaw, prior.yaw)) < 4,
	);
	const accepted =
		res && res.confidence > 0.2 ? "confident" : near ? "near-compass" : "prior";
	const pose =
		accepted === "confident" && res
			? res.pose
			: accepted === "near-compass" && near
				? near.pose
				: prior;
	const app: SkylineApp = {
		prior: { ...prior },
		pose: {
			yaw: pose.yaw,
			pitch: pose.pitch,
			roll: pose.roll,
			vfov: pose.vfov,
		},
		confidence: res?.confidence ?? null,
		accepted,
	};
	return skylineFromArrays(ev.w, ev.h, ev.fine, ev.fg, ev.sky, ev.horizon, app);
}

/** Align runs from several priors (the former render worker's `align`): the app's autoAlign answer per prior. */
export async function alignRuns(ctx: MatchContext, priors: Pose[]) {
	const runs: {
		prior: Pose;
		pose: Pose | null;
		score: number | null;
		confidence: number | null;
		alternatives: { pose: Pose; score: number; total: number }[];
	}[] = [];
	for (const pr of priors) {
		tick(ctx);
		const ev = await ctx.engine.matchEvidence(pr);
		const res = ev?.align ?? null;
		runs.push({
			prior: pr,
			pose: res ? { ...res.pose } : null,
			score: res?.score ?? null,
			confidence: res?.confidence ?? null,
			alternatives: (res?.alternatives ?? []).map((a) => {
				const t = a as { pose: Pose; score: number; total?: number };
				return {
					pose: { ...t.pose },
					score: t.score,
					total: t.total ?? t.score,
				};
			}),
		});
	}
	return runs;
}

async function photoFeaturesAt(
	ctx: MatchContext,
	W: number,
	H: number,
	maxKp: number,
) {
	ctx.photoFeatures ??= new Map();
	const key = `${W}x${H}:${maxKp}`;
	let f = ctx.photoFeatures.get(key);
	if (!f) {
		f = ctx.photo.at(W, H).then((img) =>
			ctx.features.extractFeatures(img, {
				maxKeypoints: maxKp,
				signal: ctx.signal,
			}),
		);
		ctx.photoFeatures.set(key, f);
		f.catch(() => ctx.photoFeatures?.delete(key));
	}
	return f;
}

/** Standard deviation of RGB over terrain pixels (per-view stats, as the service reports). */
function rgbStd(v: View) {
	let n = 0;
	let s = 0;
	let s2 = 0;
	for (let i = 0; i < v.W * v.H; i++) {
		if (v.xyz[i * 3] === 0 && v.xyz[i * 3 + 1] === 0 && v.xyz[i * 3 + 2] === 0)
			continue;
		for (let c = 0; c < 3; c++) {
			const x = v.rgba[i * 4 + c];
			s += x;
			s2 += x * x;
			n++;
		}
	}
	return n ? Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2)) : 0;
}

/**
 * core.correspond: ALIKED + LightGlue photo ↔ view matches lifted through each view's xyz. The photo is
 * rasterised at the views' W×H; views whose xyz does not reproject under their pose are an error.
 */
export async function correspond(
	ctx: MatchContext,
	views: View[],
	eye: ArrayLike<number>,
	o: { maxKp?: number } = {},
): Promise<Correspondences> {
	const t0 = performance.now();
	tick(ctx, "match");
	const { W, H } = views[0];
	const bad = views.filter((v) => checkView(v, eye) > 2.0).map((v) => v.tag);
	if (bad.length)
		throw new Error(
			`xyz buffer does not reproject under its pose for views ${bad.join(", ")} (stale/mismatched render)`,
		);
	const maxKp = o.maxKp ?? 4096;
	const fp = await photoFeaturesAt(ctx, W, H, maxKp);
	const x2d: number[] = [];
	const X: number[] = [];
	const perView: PerView[] = [];
	for (const v of views) {
		tick(ctx);
		if (v.W !== W || v.H !== H)
			throw new Error(`view ${v.tag}: ${v.W}×${v.H} != ${W}×${H}`);
		const fr = await ctx.features.extractFeatures(
			{ data: v.rgba, width: v.W, height: v.H },
			{ maxKeypoints: maxKp, signal: ctx.signal },
		);
		const m = await ctx.features.matchFeatures(fp, fr, { signal: ctx.signal });
		const k1 = new Float64Array(m.count * 2);
		for (let i = 0; i < m.count; i++) {
			k1[i * 2] = fr.keypoints[m.indices1[i] * 2];
			k1[i * 2 + 1] = fr.keypoints[m.indices1[i] * 2 + 1];
		}
		const { X: Xv, ok } = lift(k1, v.xyz, v.W, v.H, eye);
		let lifted = 0;
		for (let i = 0; i < m.count; i++) {
			if (!ok[i]) continue;
			lifted++;
			const j = m.indices0[i];
			x2d.push(fp.keypoints[j * 2] + 0.5, fp.keypoints[j * 2 + 1] + 0.5);
			X.push(Xv[i * 3], Xv[i * 3 + 1], Xv[i * 3 + 2]);
		}
		let terrain = 0;
		for (let i = 0; i < v.W * v.H; i++)
			if (
				v.xyz[i * 3] !== 0 ||
				v.xyz[i * 3 + 1] !== 0 ||
				v.xyz[i * 3 + 2] !== 0
			)
				terrain++;
		perView.push({
			tag: v.tag,
			matches: m.count,
			lifted,
			keypoints: fr.count,
			terrainFrac: Math.round((terrain / (v.W * v.H)) * 1000) / 1000,
			rgbStd: Math.round(rgbStd(v) * 10) / 10,
		});
	}
	return {
		x2d: Float64Array.from(x2d),
		X: Float64Array.from(X),
		W,
		H,
		perView,
		matchMs: Math.round(performance.now() - t0),
	};
}
