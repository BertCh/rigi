// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Policy "t6" for ad-hoc two-stage requests (port of tools/matcher/server/t6.py): the T6 stage-1
// hypothesis search and the frozen T6 rule (./rule.ts, sha1 292fb74f…), on the app's engine.
//   stage 1   sky        skyline global search (src/lib/gpu/skyglobal: grid + candidate re-score on the
//                        luma compute graph, polish on the CPU), top 4
//             sweep40    the 40° render-match sweep (9 views or a ±20° fan), baseline if ≥ 30 inliers
//             appseeds   the app's autoAlign from 9 yaws × 3 pitches (always run)
//             narrow     hfov < 25°: seeded 3×3 fans at the photo FOV (+ other seeds ≥ 30 inliers)
//             sweepfine  FOV-aware sweep, one rotation per window of 3 adjacent views, top 4 ≥ 15 inliers
//   stage 2   the baseline first, then fine-sweep / sky interleaved, then the other baseline source;
//             2° dedupe, at most 6, each through the fused stage 2
//   selection + confidence: rule.select / rule.confidence, unchanged.
// The basin gap (untrusted positions) is not computed in the browser: gapOK is then false, as the
// service had it when the check failed.

import type { Pose } from "#/lib/camera";
import { searchGpu } from "#/lib/gpu/skyglobal";
import { type EdgeInputs, SkyGlobal } from "#/lib/gpu/skyglobal/cpu";
import type { StageResult } from "./assemble";
import { Deadline } from "./assemble";
import {
	alignRuns,
	Cancelled,
	correspond,
	ensureSatellite,
	eyeOf,
	fanPoses,
	type MatchContext,
	renderViews,
	tick,
	type ViewPose,
} from "./context";
import { type Correspondences, legacySolve, subsetCorr } from "./core";
import { HIGH_CONF, LOW_CONF } from "./fusion";
import { dang, hfovFromVfov, vfovFromHfov } from "./geometry";
import {
	ADHOC_360_OFFSETS,
	ADHOC_NARROW_MAX_SEEDS,
	ADHOC_SEED_PITCHES,
	ADHOC_STAGE1_MIN_INLIERS,
	type AdhocRequest,
	type AdhocSetup,
	adhocDrape,
	adhocSetup,
	SWEEP_KP,
	stage2,
} from "./pipeline";
import {
	AMBIG_DEG,
	baseline,
	confidence,
	FROZEN_RULE_SHA1,
	inliersOf,
	poseDistance,
	RULE_ID,
	select,
	strong,
	supportOf,
	type T6Candidate,
	type T6Record,
	verified,
	veto,
} from "./rule";

export const MAX_VERIFY = 6;
export const SKY_K = 4;
export const SWEEP_WIN_MIN_INL = 15;
export const FINE_MIN_STEP = 8.0;
export const UNKNOWN_HFOVS = [40.0, 62.0];
export const DEDUPE_DEG = 2.0;
export const GAP_SUPPORT = 0.5;
export const MIN_HORIZON_DIRS = 500;

type Cand = T6Candidate & {
	skyScore0?: number;
	appScore?: number | null;
	window?: string;
	inlierFrac?: number;
	vfovRender?: number;
	res?: StageResult;
	ms?: number;
};

type Rec = T6Record & {
	candidates: Cand[];
	[k: string]: unknown;
};

const p = (pose: Pose): Pose => ({
	yaw: +pose.yaw,
	pitch: +pose.pitch,
	roll: +pose.roll,
	vfov: +pose.vfov,
});

/** Raw photo evidence + the horizon (render_worker `edges`): the SkyGlobal inputs. */
async function edges(ctx: MatchContext): Promise<EdgeInputs | null> {
	const ev = await ctx.engine.matchEvidence();
	if (!ev) return null;
	const n = ev.w * ev.h;
	const rgb = new Uint8Array(n * 3);
	for (let i = 0; i < n; i++) {
		rgb[i * 3] = ev.rgb[i * 4];
		rgb[i * 3 + 1] = ev.rgb[i * 4 + 1];
		rgb[i * 3 + 2] = ev.rgb[i * 4 + 2];
	}
	return {
		w: ev.w,
		h: ev.h,
		dirs: ev.horizon,
		fine: ev.fine,
		coarse: ev.coarse,
		fg: ev.fg,
		rgb,
	};
}

/** pipeline.fine_sweep: views every max(8°, hfov/2) at the photo vfov (unknown focal: hfov 40° and 62°). */
async function fineSweep(ctx: MatchContext, s: AdhocSetup) {
	const eye = eyeOf(ctx.engine);
	const hyps: Cand[] = [];
	const vfovs = s.focalKnown
		? [s.p0.vfov]
		: UNKNOWN_HFOVS.map((h) => vfovFromHfov(h, s.aspect));
	const t0 = performance.now();
	let nviews = 0;
	for (const vf of vfovs) {
		const hf = hfovFromVfov(vf, s.aspect);
		let step = Math.max(FINE_MIN_STEP, 0.5 * hf);
		const n = Math.max(9, Math.ceil(360 / step));
		step = 360 / n;
		const poses: ViewPose[] = Array.from({ length: n }, (_, i) => ({
			tag: `f${i}`,
			yaw: i * step,
			pitch: 0,
			roll: 0,
			vfov: vf,
		}));
		const views = await renderViews(ctx, poses, { allowEmpty: true });
		nviews += views.length;
		if (!views.length) continue;
		const c = await correspond(ctx, views, eye);
		const counts = c.perView.map((q) => q.lifted);
		const starts = [0];
		for (const k of counts) starts.push(starts[starts.length - 1] + k);
		const nv = views.length;
		for (let i = 0; i < nv; i++) {
			const mask = new Uint8Array(c.x2d.length / 2);
			let cnt = 0;
			for (const d of [-1, 0, 1]) {
				const j = (((i + d) % nv) + nv) % nv;
				for (let k = starts[j]; k < starts[j + 1]; k++) {
					if (!mask[k]) cnt++;
					mask[k] = 1;
				}
			}
			if (cnt < 12) continue;
			const sub: Correspondences = {
				...subsetCorr(c, mask),
				perView: c.perView,
				matchMs: c.matchMs,
			};
			const prior = { yaw: views[i].pose.yaw, pitch: 0, roll: 0, vfov: vf };
			const r = await legacySolve(sub, views, eye, prior, {
				freeFocal: !s.focalKnown,
				scorer: ctx.scorer,
			});
			if (r.pose && r.inliers >= SWEEP_WIN_MIN_INL)
				hyps.push({
					source: "sweepfine",
					pose: p(r.pose),
					inliers: r.inliers,
					inlierFrac: r.inlierFrac,
					window: views[i].tag,
					vfovRender: vf,
				});
		}
	}
	hyps.sort((a, b) => (b.inliers ?? 0) - (a.inliers ?? 0));
	const out: Cand[] = [];
	for (const h of hyps)
		if (
			out.every(
				(q) =>
					Math.abs(dang(h.pose.yaw, q.pose.yaw)) > 2 ||
					Math.abs(h.pose.pitch - q.pose.pitch) > 2,
			)
		)
			out.push(h);
	return {
		hyps: out.slice(0, 4),
		info: { views: nviews, ms: Math.round(performance.now() - t0), vfovs },
	};
}

/** The T6 run's narrow_stage1 on the app-seed align runs. */
async function narrowStage1(
	ctx: MatchContext,
	s: AdhocSetup,
	r: AdhocRequest,
	runs: Awaited<ReturnType<typeof alignRuns>>,
) {
	const p0 = s.p0;
	const seeds: { yaw: number; pitch: number; roll: number; source: string }[] =
		[];
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
	const alts = runs
		.flatMap((x) => x.alternatives)
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
	const dy = 0.8 * s.hfov;
	const dp = 0.8 * p0.vfov;
	const tried: {
		seed: (typeof use)[number];
		pose: Pose | null;
		inliers: number;
	}[] = [];
	let best: { seed: (typeof use)[number]; pose: Pose; inliers: number } | null =
		null;
	const eye = eyeOf(ctx.engine);
	for (const sd of use) {
		const poses: ViewPose[] = [];
		(s.gravKnown ? [0] : [-dp, 0, dp]).forEach((pp, j) => {
			for (const d of [-dy, 0, dy].map((v) => Math.round(v * 1e4) / 1e4))
				poses.push({
					tag: `y${d}_p${j}`,
					yaw: sd.yaw + d,
					pitch: sd.pitch + pp,
					roll: sd.roll,
					vfov: p0.vfov,
				});
		});
		const views = await renderViews(ctx, poses, { allowEmpty: true });
		if (!views.length) {
			tried.push({ seed: sd, pose: null, inliers: 0 });
			continue;
		}
		const c = await correspond(ctx, views, eye, { maxKp: SWEEP_KP });
		const s1 = await legacySolve(
			c,
			views,
			eye,
			{ ...p0, yaw: sd.yaw },
			{
				freeFocal: !s.focalKnown,
				scorer: ctx.scorer,
			},
		);
		tried.push({ seed: sd, pose: s1.pose, inliers: s1.inliers });
		if (s1.pose && (!best || s1.inliers > best.inliers))
			best = { seed: sd, pose: s1.pose, inliers: s1.inliers };
	}
	const cand = (pose: Pose, inl: number): Cand => {
		const q = p(pose);
		if (s.focalKnown) q.vfov = p0.vfov;
		return { source: "narrow", pose: q, inliers: inl };
	};
	let base: Cand | null = null;
	let used: string | null = null;
	if (best && best.inliers >= ADHOC_STAGE1_MIN_INLIERS) {
		base = cand(best.pose, best.inliers);
		used = best.seed.source;
	} else if (use.length) {
		const sd = use.find((q) => q.source === "app-skyline") ?? use[0];
		base = {
			source: "narrow",
			pose: { yaw: sd.yaw, pitch: sd.pitch, roll: sd.roll, vfov: p0.vfov },
			inliers: 0,
		};
		used = `fallback:${sd.source}`;
	}
	const others = tried
		.filter(
			(t) =>
				t.pose &&
				t.inliers >= ADHOC_STAGE1_MIN_INLIERS &&
				(!best || t.pose !== best.pose),
		)
		.map((t) => ({ ...cand(t.pose as Pose, t.inliers), source: "narrowalt" }));
	return { base, others, info: { seeds: use, tried, used } };
}

/** One T6 attempt (t6.Run.run). */
async function runOnce(
	ctx: MatchContext,
	s: AdhocSetup,
	r: AdhocRequest,
): Promise<{ rec: Rec; sg: SkyGlobal }> {
	const p0 = s.p0;
	const T: Record<string, number> = {};
	const rec: Rec = {
		positionSource: !s.untrusted
			? "exif-gps"
			: (r.positionSource ?? "untrusted"),
		candidates: [],
		focalKnown: s.focalKnown,
		vfov0: p0.vfov,
		hfov0: s.hfov,
		narrow: s.narrow,
		timingMs: T,
	};
	let ts = performance.now();
	tick(ctx, "t6:edges");
	const ed = await edges(ctx);
	const eye = eyeOf(ctx.engine);
	const nDirs = ed ? ed.dirs.length / 3 : 0;
	rec.horizonDirs = nDirs;
	if (!ed || nDirs < MIN_HORIZON_DIRS)
		throw new Error(`empty horizon (${nDirs} dirs)`);
	tick(ctx, "t6:sky");
	const sg = new SkyGlobal(ed, s.aspect);
	const sres = await searchGpu(sg, p0.vfov, s.focalKnown, SKY_K, {
		rescore: "gpu",
	});
	const cands: Cand[] = sres.hyps.map((h, i) => ({
		source: "sky",
		rank: i,
		pose: p(h.pose),
		skyScore0: h.score,
	}));
	rec.sky = { gridMs: sres.gridMs, refineMs: sres.refineMs, gpu: sres.gpu };
	T.sky = Math.round(performance.now() - ts);
	// baseline: the 40° sweep
	ts = performance.now();
	let baseSeed: string | null = null;
	if (!s.narrow) {
		const views = await renderViews(
			ctx,
			fanPoses(p0, s.full ? ADHOC_360_OFFSETS : [-20, -10, 0, 10, 20]),
			{ allowEmpty: true },
		);
		let s40: Awaited<ReturnType<typeof legacySolve>> | null = null;
		if (views.length) {
			const c40 = await correspond(ctx, views, eye, { maxKp: SWEEP_KP });
			s40 = await legacySolve(c40, views, eye, p0, {
				freeFocal: !s.focalKnown,
				scorer: ctx.scorer,
			});
		}
		rec.sweep40 = { inliers: s40?.inliers ?? 0, pose: s40?.pose ?? null };
		if (s40?.pose && s40.inliers >= ADHOC_STAGE1_MIN_INLIERS) {
			const q = p(s40.pose);
			if (s.focalKnown) q.vfov = p0.vfov;
			cands.push({ source: "sweep40", pose: q, inliers: s40.inliers });
			baseSeed = "sweep40";
		}
	}
	T.sweep40 = Math.round(performance.now() - ts);
	// baseline: the app's skyline seeds (always run)
	ts = performance.now();
	const seeds: Pose[] = ADHOC_360_OFFSETS.flatMap((y) =>
		(s.gravKnown ? [0] : ADHOC_SEED_PITCHES).map((dp) => ({
			yaw: y,
			pitch: p0.pitch + dp,
			roll: p0.roll,
			vfov: p0.vfov,
		})),
	);
	const runs = await alignRuns(ctx, seeds);
	let bestRun: (typeof runs)[number] | null = null;
	for (const x of runs)
		if (
			x.pose &&
			(!bestRun || (x.score ?? -Infinity) > (bestRun.score ?? -Infinity))
		)
			bestRun = x;
	if (bestRun?.pose) {
		cands.push({
			source: "appseeds",
			pose: p(bestRun.pose),
			appScore: bestRun.score,
		});
		if (baseSeed == null && !s.narrow && s.full) baseSeed = "appseeds";
	}
	if (s.narrow) {
		const nb = await narrowStage1(ctx, s, r, runs);
		rec.narrowStage1 = nb.info;
		if (nb.base) {
			cands.push(nb.base);
			baseSeed = "narrow";
		}
		cands.push(...nb.others);
	}
	if (baseSeed == null) {
		cands.push({ source: "prior", pose: { ...p0 } });
		baseSeed = "prior";
	}
	rec.baselineSeed = baseSeed;
	T.appseeds = Math.round(performance.now() - ts);
	// FOV-aware fine sweep
	ts = performance.now();
	if (!s.narrow) {
		tick(ctx, "t6:sweepfine");
		const fs = await fineSweep(ctx, s);
		rec.sweepfine = fs.info;
		for (const h of fs.hyps) {
			const q = { ...h.pose };
			if (s.focalKnown) q.vfov = p0.vfov;
			cands.push({ ...h, pose: q });
		}
	}
	T.sweepfine = Math.round(performance.now() - ts);
	// verification order
	const base = cands.filter((c) => c.source === baseSeed);
	let fine = cands
		.filter((c) => c.source === "sweepfine")
		.sort((a, b) => (b.inliers ?? 0) - (a.inliers ?? 0));
	const sky = cands
		.filter((c) => c.source === "sky")
		.sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
	fine = fine.concat(
		cands
			.filter((c) => c.source === "narrowalt")
			.sort((a, b) => (b.inliers ?? 0) - (a.inliers ?? 0)),
	);
	const rest = cands.filter(
		(c) =>
			(c.source === "sweep40" || c.source === "appseeds") &&
			c.source !== baseSeed,
	);
	const inter: Cand[] = [];
	for (let i = 0; i < Math.max(fine.length, sky.length); i++) {
		if (fine[i]) inter.push(fine[i]);
		if (sky[i]) inter.push(sky[i]);
	}
	const uniq: Cand[] = [];
	for (const c of [...base, ...inter, ...rest]) {
		const dup = uniq.find(
			(u) =>
				Math.abs(dang(c.pose.yaw, u.pose.yaw)) < DEDUPE_DEG &&
				Math.abs(c.pose.pitch - u.pose.pitch) < DEDUPE_DEG,
		);
		if (dup) {
			dup.alsoFrom = [...(dup.alsoFrom ?? []), c.source];
			continue;
		}
		uniq.push(c);
	}
	rec.nCandidates = uniq.length;
	rec.candidates = uniq;
	// verification
	ts = performance.now();
	for (const c of uniq.slice(0, MAX_VERIFY)) {
		const t1 = performance.now();
		tick(ctx, "t6:verify");
		let st: Awaited<ReturnType<typeof stage2>>;
		try {
			st = await stage2(ctx, s, c.pose);
		} catch (e) {
			if (
				e instanceof Cancelled ||
				e instanceof Deadline ||
				(e as Error)?.name === "AbortError"
			)
				throw e;
			c.error = String((e as Error)?.message ?? e).slice(0, 300);
			continue;
		}
		const res = st.res;
		const fp = res.pose ?? null;
		c.res = res;
		c.fused = {
			pose: fp,
			level: res.confidenceLevel ?? null,
			method: res.method,
			checks: res.confidenceChecks ?? null,
			fusionScore: res.fusionScore,
			inliers: res.inliers,
			inlierFrac: res.inlierFrac,
			nLifted: res.nLifted,
			fusedFrom: res.fusedFrom,
			cues: res.cues ?? null,
			eye: st.eye,
		};
		if (fp) {
			c.fused.skyScore = sg.scorePose(fp, true);
			const sup = res.confidenceChecks?.matchSupport ?? 0;
			if ((res.confidenceLevel === "high" || sup >= GAP_SUPPORT) && s.untrusted)
				c.fused.basinGap = {
					error: "position-grid basin gap not available in the browser",
				};
		}
		c.ms = Math.round(performance.now() - t1);
	}
	T.verify = Math.round(performance.now() - ts);
	return { rec, sg };
}

/** t6.response: the selected candidate's stage-2 result with the T6 level and checks. */
function response(
	s: AdhocSetup,
	rec: Rec,
): StageResult & Record<string, unknown> {
	const sel = select(rec) as
		| (Cand & { fused: NonNullable<Cand["fused"]> & { pose: Pose } })
		| null;
	const base = baseline(rec);
	const stage1 = {
		baselineSeed: rec.baselineSeed,
		nCandidates: rec.nCandidates,
		verified: verified(rec).length,
		maxVerify: MAX_VERIFY,
		positionSource: rec.positionSource,
		candidates: rec.candidates.map((c) => ({
			source: c.source,
			alsoFrom: c.alsoFrom ?? [],
			hypothesis: c.pose,
			selected: c === sel,
			baseline: c === base,
			pose: c.fused?.pose ?? null,
			levelApriori: c.fused?.level ?? null,
			...(c.error ? { error: c.error } : {}),
		})),
	};
	if (!sel?.res)
		return {
			pose: null as unknown as Pose,
			method: "fused",
			confidence: LOW_CONF,
			confidenceLevel: "low",
			reason: "no verified hypothesis",
			inliers: 0,
			inlierFrac: 0,
			nLifted: 0,
			residualPx: null,
			coverage: 0,
			deltaYawFromPrior: 0,
			timingMs: {},
			version: "",
			stage1,
		};
	const [lvl, checks0] = confidence(rec, sel);
	const high = lvl === "HIGH";
	const checks: Record<string, unknown> = {
		...checks0,
		gapOK: !!checks0.gapOK,
	};
	const v = veto(rec, sel, checks0);
	checks.veto = v;
	if (checks0.ambiguity)
		checks.ambiguousWith = verified(rec)
			.filter(
				(q) =>
					q !== sel &&
					strong(q) &&
					poseDistance(q.fused.pose, sel.fused.pose) > AMBIG_DEG,
			)
			.map((q) => ({
				source: q.source,
				pose: q.fused.pose,
				matchSupport: supportOf(q),
				inliers: inliersOf(q),
				distDeg:
					Math.round(poseDistance(q.fused.pose, sel.fused.pose) * 1000) / 1000,
			}));
	if (s.untrusted) checks.positionTrusted = false;
	const res: StageResult & Record<string, unknown> = {
		...sel.res,
		confidence: high ? HIGH_CONF : LOW_CONF,
		confidenceLevel: high ? "high" : "low",
		confidenceChecks: checks as StageResult["confidenceChecks"],
		stage1,
		selectedSource: sel.source,
		baseline: base
			? {
					source: base.source,
					pose: base.fused.pose,
					confidenceLevelApriori: base.fused.level,
				}
			: null,
		stage2Prior: p(sel.pose),
		rule: { id: RULE_ID, sha1: FROZEN_RULE_SHA1 },
		method: "fused",
	};
	delete res.lowReason;
	if (!high && v) res.lowReason = v;
	return res;
}

/** Policy t6 for one request, with one whole-run retry on a failure that is not an abort / deadline. */
export async function matchAdhocT6(
	ctx: MatchContext,
	r: AdhocRequest,
): Promise<StageResult> {
	const t0 = performance.now();
	const s = adhocSetup(r, ctx.engine.aspect);
	if (s.full) ctx.timing.fullTerrainMs = await ctx.engine.loadFullTerrain();
	await ensureSatellite(ctx, adhocDrape(s));
	const attempts: Record<string, unknown>[] = [];
	for (let attempt = 1; ; attempt++) {
		const ta = performance.now();
		try {
			const { rec } = await runOnce(ctx, s, r);
			attempts.push({
				ms: Math.round(performance.now() - ta),
				timingMs: rec.timingMs,
			});
			const out = response(s, rec);
			out.timingMs = {
				...(rec.timingMs as Record<string, number>),
				...ctx.timing,
				t6: Math.round(performance.now() - t0),
			};
			out.policy = "t6";
			(out.stage1 as Record<string, unknown>).attempts = attempts;
			return out;
		} catch (e) {
			if (
				e instanceof Cancelled ||
				e instanceof Deadline ||
				(e as Error)?.name === "AbortError" ||
				attempt === 2
			)
				throw e;
			attempts.push({
				error: String((e as Error)?.message ?? e).slice(0, 300),
				ms: Math.round(performance.now() - ta),
			});
		}
	}
}
