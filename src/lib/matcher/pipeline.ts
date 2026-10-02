// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The matcher's request modes (port of the removed service app.py (tools/matcher/reference/README.md) match_photo_id and match_adhoc,
// policy v034, the service default), on the app's own engine:
//   known pose prior  one fused stage: 5-view ±20° fan + the skyline cue from autoAlign at the prior.
//   ad-hoc            heading / gravity / focal may be missing: stage 1 finds a stage-2 prior (narrow
//                     seeded fans for hfov < 25°; request pose seeds; the 360° / ±20° render-match sweep;
//                     the app's skyline seeds when the sweep fails), then the fused stage 2.
// Policy t6 (stage-1 search + frozen T6 rule) is ./t6.ts. Not ported: the position-grid basin gap
// (pose6.basin_gap, untrusted positions only): such a HIGH is reported LOW with lowReason
// "basinGap unavailable (...)", exactly as the service did when the check could not run.

import type { Pose } from "#/lib/camera";
import { Deadline, type StageResult } from "./assemble";
import { BASIN_GAP_MIN, type BasinGap } from "./basin";
import type { BasinJob } from "./basin-run";
import {
	alignRuns,
	correspond,
	ensureSatellite,
	eyeOf,
	fanPoses,
	type MatchContext,
	renderViews,
	skylineCue,
	tick,
	type ViewPose,
} from "./context";
import type { Correspondences, LegacySolve } from "./core";
import { LOW_CONF, type SkylineCue } from "./fusion";
import { dang, hfovFromVfov, vfovFromHfov } from "./geometry";
import {
	assembleOffThread,
	basinGapOffThread,
	legacySolveOffThread,
} from "./solve-offthread";

export const DEFAULT_OFFSETS = [-20, -10, 0, 10, 20];
export const ADHOC_DEFAULT_HFOV = 50.0;
export const ADHOC_360_OFFSETS = [0, 40, 80, 120, 160, 200, 240, 280, 320];
export const ADHOC_STAGE1_MIN_INLIERS = 30;
export const ADHOC_MAX_HINT_SEEDS = 4;
export const SWEEP_KP = 4096;
export const ADHOC_SEED_PITCHES = [-8.0, 0.0, 8.0];
export const ADHOC_NARROW_HFOV = 25.0;
export const ADHOC_NARROW_MAX_SEEDS = 6;
export const ADHOC_NARROW_DRAPE_M = 150_000;
export const DRAPE_FULL_M = 40_000;
export const POSITION_UNCERTAIN_M = 50.0;
export const VFOV_MIN = 1.5;

/** Known prior (bundled photos, full metadata): one fused stage. */
export async function matchKnownPrior(
	ctx: MatchContext,
	prior: Pose,
	o: { offsets?: number[]; fused?: boolean; freeFocal?: boolean } = {},
): Promise<StageResult> {
	const fused = o.fused !== false;
	const t0 = performance.now();
	await ensureSatellite(ctx, 0);
	tick(ctx, "render");
	const eye = eyeOf(ctx.engine);
	const sk = fused ? await skylineCue(ctx, prior) : null;
	const views = await renderViews(
		ctx,
		fanPoses(prior, o.offsets ?? DEFAULT_OFFSETS),
	);
	const renderMs = performance.now() - t0;
	const corr = await correspond(ctx, views, eye);
	tick(ctx, "solve");
	const res = await assembleOffThread(corr, views, eye, prior, sk, {
		fused,
		freeFocal: !!o.freeFocal,
		deadline: ctx.deadline,
		skyNote: sk ? null : "app has no horizon/edge map",
	});
	res.timingMs = { render: Math.round(renderMs), ...res.timingMs };
	res.eye = eye;
	return res;
}

export type AdhocRequest = {
	/** request prior; missing fields are unknowns */
	prior: Partial<Pick<Pose, "yaw" | "pitch" | "roll" | "vfov">> & {
		hfov?: number;
	};
	fused?: boolean;
	positionSource?: string;
	positionUncertainM?: number;
	yawSeeds?: number[];
	poseSeeds?: (Pick<Pose, "yaw"> &
		Partial<Pick<Pose, "pitch" | "roll" | "vfov">>)[];
	yawHint?: number;
	offsets?: number[];
};

type HintSeed = { yaw: number; pitch?: number; roll?: number; source: string };

/** app.parse_hint_seeds: yawSeeds then poseSeeds, at most ADHOC_MAX_HINT_SEEDS. */
export function parseHintSeeds(r: AdhocRequest): HintSeed[] {
	const out: HintSeed[] = [];
	for (const y of r.yawSeeds ?? [])
		if (typeof y === "number" && Number.isFinite(y))
			out.push({ yaw: y, source: "yawSeeds" });
	for (const p of r.poseSeeds ?? [])
		if (p && typeof p.yaw === "number" && Number.isFinite(p.yaw)) {
			const d: HintSeed = { yaw: p.yaw, source: "poseSeeds" };
			if (typeof p.pitch === "number") d.pitch = p.pitch;
			if (typeof p.roll === "number") d.roll = p.roll;
			out.push(d);
		}
	return out.slice(0, ADHOC_MAX_HINT_SEEDS);
}

/** app.position_untrusted: a non-EXIF position source or an uncertainty over 50 m. */
export const positionUntrusted = (r: AdhocRequest) =>
	(typeof r.positionSource === "string" && r.positionSource !== "exif-gps") ||
	(typeof r.positionUncertainM === "number" &&
		r.positionUncertainM > POSITION_UNCERTAIN_M);

/** What the ad-hoc request knows (app.match_adhoc's preamble). */
export function adhocSetup(r: AdhocRequest, aspect: number) {
	const pin = r.prior ?? {};
	const num = (v: unknown) =>
		typeof v === "number" && Number.isFinite(v) ? v : null;
	const yaw = num(pin.yaw);
	const pitch = num(pin.pitch);
	const roll = num(pin.roll);
	let vfov = num(pin.vfov);
	const hfov = num(pin.hfov);
	const focalKnown = vfov != null || hfov != null;
	if (vfov == null) vfov = vfovFromHfov(hfov ?? ADHOC_DEFAULT_HFOV, aspect);
	if (!(vfov > VFOV_MIN && vfov < 150)) throw new Error("vfov out of range");
	const yawKnown = yaw != null;
	const gravKnown = pitch != null && roll != null;
	const p0: Pose = {
		yaw: yawKnown ? yaw : 0,
		pitch: gravKnown ? pitch : 0,
		roll: gravKnown ? roll : 0,
		vfov,
	};
	const hfovDeg = hfovFromVfov(vfov, aspect);
	return {
		p0,
		aspect,
		focalKnown,
		yawKnown,
		gravKnown,
		full: !yawKnown,
		narrow: hfovDeg < ADHOC_NARROW_HFOV,
		hfov: hfovDeg,
		twoStage: !(yawKnown && gravKnown && focalKnown),
		untrusted: positionUntrusted(r),
		fused: r.fused !== false,
	};
}
export type AdhocSetup = ReturnType<typeof adhocSetup>;

/** The stage-2 fan (app.match_adhoc offs2): ±0.5·hfov in quarter steps when narrow, else ±20°. */
export const stage2Offsets = (s: AdhocSetup, offsets?: number[]) =>
	offsets ??
	(s.narrow
		? [-0.5, -0.25, 0, 0.25, 0.5].map((k) => Math.round(k * s.hfov * 1e4) / 1e4)
		: DEFAULT_OFFSETS);

/** The drape radius the service used for the ad-hoc page (full 360°: 40 km, narrow 150 km). */
export const adhocDrape = (s: AdhocSetup) =>
	s.full ? (s.narrow ? ADHOC_NARROW_DRAPE_M : DRAPE_FULL_M) : 0;

const seedPriors = (s: AdhocSetup, yaws: number[]): Pose[] =>
	yaws.flatMap((y) =>
		(s.gravKnown ? [0] : ADHOC_SEED_PITCHES).map((dp) => ({
			yaw: y,
			pitch: s.p0.pitch + dp,
			roll: s.p0.roll,
			vfov: s.p0.vfov,
		})),
	);

type Stage = Record<string, unknown> & { stage: string; ms: number };

/** app.match_adhoc narrow_stage1: seeds matched against 3×3 fans at the photo's FOV. */
async function narrowStage1(
	ctx: MatchContext,
	s: AdhocSetup,
	r: AdhocRequest,
	hints: HintSeed[],
	stages: Stage[],
	prior2: Pose,
): Promise<Pose> {
	const t0 = performance.now();
	const p0 = s.p0;
	const seeds: (HintSeed & { pitch: number; roll: number })[] = [];
	for (const sd of hints.slice(0, ADHOC_NARROW_MAX_SEEDS))
		seeds.push({
			yaw: sd.yaw,
			pitch: sd.pitch || p0.pitch,
			roll: sd.roll || p0.roll,
			source: sd.source,
		});
	if (s.yawKnown)
		seeds.push({
			yaw: p0.yaw,
			pitch: p0.pitch,
			roll: p0.roll,
			source: "heading",
		});
	if (typeof r.yawHint === "number")
		seeds.push({
			yaw: r.yawHint,
			pitch: p0.pitch,
			roll: p0.roll,
			source: "yaw-hint",
		});
	const runs = await alignRuns(
		ctx,
		seedPriors(s, s.yawKnown ? [p0.yaw] : ADHOC_360_OFFSETS),
	);
	const alts = runs
		.flatMap((x) => x.alternatives)
		.filter((a) => a.pose)
		.sort((a, b) => b.total - a.total);
	for (const a of alts) {
		if (seeds.filter((q) => q.source === "app-skyline").length >= 3) break;
		if (seeds.every((q) => Math.abs(dang(a.pose.yaw, q.yaw)) > 2 * s.hfov))
			seeds.push({
				yaw: a.pose.yaw,
				pitch: a.pose.pitch,
				roll: a.pose.roll,
				source: "app-skyline",
			});
	}
	const use = seeds.slice(0, ADHOC_NARROW_MAX_SEEDS);
	stages.push({
		stage: "narrow-seeds",
		seeds: use,
		ms: Math.round(performance.now() - t0),
	});
	const dy = 0.8 * s.hfov;
	const dp = 0.8 * p0.vfov;
	let best: [(typeof use)[number], LegacySolve] | null = null;
	const tried: Record<string, unknown>[] = [];
	for (const sd of use) {
		if (performance.now() > ctx.deadline - 30_000) break;
		const t1 = performance.now();
		const poses: ViewPose[] = [];
		(s.gravKnown ? [0] : [-dp, 0, dp]).forEach((pp, j) => {
			for (const d of [-dy, 0, dy].map((v) => Math.round(v * 1e4) / 1e4))
				poses.push({
					tag: `y${d >= 0 ? "+" : ""}${d}_p${j}`,
					yaw: sd.yaw + d,
					pitch: sd.pitch + pp,
					roll: sd.roll,
					vfov: p0.vfov,
				});
		});
		const views = await renderViews(ctx, poses, { allowEmpty: true });
		if (!views.length) {
			tried.push({
				source: sd.source,
				pose: null,
				inliers: 0,
				note: "all views empty (sky)",
			});
			continue;
		}
		const eye = eyeOf(ctx.engine);
		const c = await correspond(ctx, views, eye, { maxKp: SWEEP_KP });
		const s1 = await legacySolveOffThread(
			c,
			views,
			eye,
			{ ...p0, yaw: sd.yaw },
			{
				freeFocal: !s.focalKnown,
			},
		);
		tried.push({
			source: sd.source,
			pose: s1.pose,
			inliers: s1.inliers,
			ms: Math.round(performance.now() - t1),
		});
		if (s1.pose && (!best || s1.inliers > best[1].inliers)) best = [sd, s1];
	}
	const ok = !!best && best[1].inliers >= ADHOC_STAGE1_MIN_INLIERS;
	stages.push({
		stage: "narrow-match",
		tried,
		used: ok,
		seedSource: ok && best ? best[0].source : null,
		ms: Math.round(performance.now() - t0),
	});
	if (ok && best?.[1].pose) {
		const bp = best[1].pose;
		return {
			yaw: bp.yaw,
			pitch: bp.pitch,
			roll: bp.roll,
			vfov: s.focalKnown ? p0.vfov : bp.vfov,
		};
	}
	if (use.length) {
		const sd = use.find((q) => q.source === "app-skyline") ?? use[0];
		stages[stages.length - 1].fallbackSeed = sd.source;
		return { yaw: sd.yaw, pitch: sd.pitch, roll: sd.roll, vfov: p0.vfov };
	}
	return prior2;
}

/** app.match_adhoc seeded_stage1: a ±hfov/2 fan around each hint; the first consistent ≥ 30-inlier one wins. */
async function seededStage1(
	ctx: MatchContext,
	s: AdhocSetup,
	hints: HintSeed[],
	stages: Stage[],
): Promise<Pose | null> {
	const t0 = performance.now();
	const p0 = s.p0;
	const tried: Record<string, unknown>[] = [];
	for (const sd of hints.slice(0, ADHOC_MAX_HINT_SEEDS)) {
		if (performance.now() > ctx.deadline - 30_000) break;
		const pr: Pose = {
			yaw: sd.yaw,
			pitch: sd.pitch ?? p0.pitch,
			roll: sd.roll ?? p0.roll,
			vfov: p0.vfov,
		};
		const half = Math.round(0.5 * s.hfov * 1e4) / 1e4;
		const views = await renderViews(ctx, fanPoses(pr, [-half, 0, half]), {
			allowEmpty: true,
		});
		let s1: LegacySolve | null = null;
		if (views.length) {
			const eye = eyeOf(ctx.engine);
			const c = await correspond(ctx, views, eye, { maxKp: SWEEP_KP });
			s1 = await legacySolveOffThread(c, views, eye, pr, {
				freeFocal: !s.focalKnown,
			});
		}
		const pose = s1?.pose ?? null;
		const consistent = !!pose && Math.abs(dang(pose.yaw, pr.yaw)) <= s.hfov;
		const ok = consistent && (s1?.inliers ?? 0) >= ADHOC_STAGE1_MIN_INLIERS;
		tried.push({
			seed: pr,
			source: sd.source,
			pose,
			inliers: s1?.inliers ?? 0,
			consistent,
			ok,
		});
		if (ok && pose) {
			const p2 = {
				yaw: pose.yaw,
				pitch: pose.pitch,
				roll: pose.roll,
				vfov: s.focalKnown ? p0.vfov : pose.vfov,
			};
			stages.push({
				stage: "hint-seeds",
				tried,
				used: true,
				prior2: p2,
				ms: Math.round(performance.now() - t0),
			});
			return p2;
		}
	}
	stages.push({
		stage: "hint-seeds",
		tried,
		used: false,
		ms: Math.round(performance.now() - t0),
	});
	return null;
}

/** The fused stage 2 at `prior2` (render + skyline cue + correspond + assemble). */
export async function stage2(
	ctx: MatchContext,
	s: AdhocSetup,
	prior2: Pose,
	offsets?: number[],
) {
	tick(ctx, "render");
	const eye = eyeOf(ctx.engine);
	const sk = s.fused ? await skylineCue(ctx, prior2) : null;
	const views = await renderViews(
		ctx,
		fanPoses(prior2, stage2Offsets(s, offsets)),
	);
	const corr = await correspond(ctx, views, eye);
	tick(ctx, "solve");
	const res = await assembleOffThread(corr, views, eye, prior2, sk, {
		fused: s.fused,
		freeFocal: !s.focalKnown,
		deadline: ctx.deadline,
		skyNote: sk ? null : "app has no horizon/edge map",
	});
	res.eye = eye;
	return { res, sk, corr, views, eye };
}

/**
 * app.basin_gap_check: the position-grid basin gap (./basin.ts, pose6.basin_gap fast mode) from the
 * stage-2 skyline cue and matches, no new renders. Only on a HIGH result; a gap under 0.20, or a check that
 * cannot run, downgrades it to LOW.
 */
export async function basinGapCheck(
	ctx: MatchContext,
	s: AdhocSetup,
	res: StageResult,
	st: { sk: SkylineCue | null; corr: Correspondences; eye: number[] },
) {
	const t0 = performance.now();
	res.confidenceChecks ??= {
		cueAgreeDeg: null,
		skylineMedPx: null,
		matchSupport: null,
	};
	const checks = res.confidenceChecks;
	checks.positionTrusted = false;
	tick(ctx, "basinGap");
	if (res.confidenceLevel !== "high" || !res.pose) {
		checks.basinGap = null;
		return;
	}
	const r = await runBasinGapFor(ctx, s, res.pose, st);
	checks.basinGap = r.gap == null ? null : Math.round(r.gap * 1e4) / 1e4;
	if (r.grid)
		(checks as Record<string, unknown>).basinGrid = {
			step: r.grid.step,
			best: r.grid.best,
			second: r.grid.second,
		};
	res.timingMs = {
		...res.timingMs,
		basinGap: Math.round(performance.now() - t0),
	};
	if (r.gap == null || r.gap < BASIN_GAP_MIN) {
		res.confidenceLevel = "low";
		res.confidence = LOW_CONF;
		res.lowReason =
			r.gap != null ? "basinGap" : `basinGap unavailable (${r.error})`;
	}
}

/** One basin-gap run for a fused pose; never throws except on abort / deadline. */
export async function runBasinGapFor(
	ctx: MatchContext,
	s: AdhocSetup,
	pose: Pose,
	st: { sk: SkylineCue | null; corr: Correspondences; eye: number[] },
): Promise<{ gap: number | null; grid: BasinGap["grid"]; error?: string }> {
	try {
		if (!st.sk) throw new Error("no skyline cue");
		if (performance.now() > ctx.deadline - 5000)
			throw new Error("no time left before the request deadline");
		const job: BasinJob = {
			lat: ctx.engine.frame.lat,
			lon: ctx.engine.frame.lon,
			sk: st.sk,
			corr: st.corr.x2d.length
				? { x2d: st.corr.x2d, X: st.corr.X, W: st.corr.W, H: st.corr.H }
				: null,
			eye: Array.from(st.eye),
			pose,
			W: st.corr.W,
			H: st.corr.H,
			focalKnown: s.focalKnown,
		};
		const r = await (ctx.basinGap ?? basinGapOffThread)(job);
		tick(ctx);
		return {
			gap: r.gap,
			grid: r.grid,
			error: r.gap == null ? "no grid node solved" : undefined,
		};
	} catch (e) {
		if (
			e instanceof Deadline ||
			(e as Error)?.name === "AbortError" ||
			ctx.signal?.aborted
		)
			throw e;
		return {
			gap: null,
			grid: null,
			error: String((e as Error)?.message ?? e).slice(0, 200),
		};
	}
}

/** app.match_adhoc, policy v034. */
export async function matchAdhoc(
	ctx: MatchContext,
	r: AdhocRequest,
): Promise<StageResult> {
	const tAll = performance.now();
	const s = adhocSetup(r, ctx.engine.aspect);
	const hints = parseHintSeeds(r);
	if (s.full) {
		tick(ctx, "terrain");
		ctx.timing.fullTerrainMs = await ctx.engine.loadFullTerrain();
	}
	await ensureSatellite(ctx, adhocDrape(s));
	const stages: Stage[] = [];
	let prior2: Pose = { ...s.p0 };
	const timing: Record<string, number> = {};
	if (s.twoStage && s.narrow) {
		prior2 = await narrowStage1(ctx, s, r, hints, stages, prior2);
		timing.stage1 = Math.round(stages.reduce((a, x) => a + x.ms, 0));
	} else if (
		s.twoStage &&
		hints.length &&
		(await seededStage1(ctx, s, hints, stages))
	) {
		prior2 = stages[stages.length - 1].prior2 as Pose;
		timing.stage1 = Math.round(stages.reduce((a, x) => a + x.ms, 0));
	} else if (s.twoStage) {
		const ts = performance.now();
		const offs = s.full ? ADHOC_360_OFFSETS : DEFAULT_OFFSETS;
		const views1 = await renderViews(ctx, fanPoses(s.p0, offs));
		const eye = eyeOf(ctx.engine);
		const c1 = await correspond(ctx, views1, eye, { maxKp: SWEEP_KP });
		const s1 = await legacySolveOffThread(c1, views1, eye, s.p0, {
			freeFocal: !s.focalKnown,
		});
		const ok1 = !!s1.pose && s1.inliers >= ADHOC_STAGE1_MIN_INLIERS;
		stages.push({
			stage: "match-sweep",
			offsets: offs,
			pose: s1.pose,
			inliers: s1.inliers,
			used: ok1,
			ms: Math.round(performance.now() - ts),
		});
		if (ok1 && s1.pose)
			prior2 = {
				yaw: s1.pose.yaw,
				pitch: s1.pose.pitch,
				roll: s1.pose.roll,
				vfov: s.focalKnown ? s.p0.vfov : s1.pose.vfov,
			};
		else if (s.full) {
			const t2 = performance.now();
			const runs = await alignRuns(ctx, seedPriors(s, ADHOC_360_OFFSETS));
			let best: (typeof runs)[number] | null = null;
			for (const x of runs)
				if (
					x.pose &&
					(best == null || (x.score ?? -Infinity) > (best.score ?? -Infinity))
				)
					best = x;
			if (best?.pose) prior2 = { ...best.pose };
			stages.push({
				stage: "skyline-seeds",
				pose: best?.pose ?? null,
				score: best?.score ?? null,
				used: !!best,
				ms: Math.round(performance.now() - t2),
			});
		}
		timing.stage1 = Math.round(stages.reduce((a, x) => a + x.ms, 0));
	}
	const ts = performance.now();
	const st2 = await stage2(ctx, s, prior2, r.offsets);
	const res = st2.res;
	if (s.fused && s.untrusted) await basinGapCheck(ctx, s, res, st2);
	res.timingMs = {
		...timing,
		stage2: Math.round(performance.now() - ts),
		...ctx.timing,
		...res.timingMs,
		total: Math.round(performance.now() - tAll),
	};
	(res as StageResult & { adhoc?: unknown }).adhoc = {
		focalKnown: s.focalKnown,
		yawKnown: s.yawKnown,
		gravityKnown: s.gravKnown,
		twoStage: s.twoStage,
		narrow: s.narrow,
		hfov: Math.round(s.hfov * 1000) / 1000,
		stage2Prior: prior2,
		stages,
	};
	return res;
}
