// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Batch pose alignment for a roll ("Align roll"): runs the single-photo skyline cascade
// (integration/unknown-pose.ts, frozen) over every photo that only has its EXIF prior, and stores
// the poses the cascade ACCEPTS as 'solved' (roll.ts saveSolvedPose). Rejected photos keep their
// prior and come back as "needs review": in the wild a plain skyline accept is unsafe (43 %
// precision for the app's autoAlign), whereas the cascade had 0 false accepts on the bundled set,
// so its accept flag is the only thing that promotes a pose.
//
// Browser only (Web Worker + canvas). The matcher service (:8765) is never used: it may be down,
// and a roll of dozens of photos would queue minutes of render-and-match per photo.
//
// One worker at a time, sequentially: the cascade loads a 360° DEM and marches a horizon, which is
// CPU- and memory-heavy; several at once starve the page (and the machine).

import type { Pose } from "../../camera";
import {
	photoUnknowns,
	type UnknownPoseResult,
	UnknownPoseSolver,
} from "../../integration/unknown-pose";
import { loadSolvedPose, priorPose, saveSolvedPose } from "../roll";
import type { Roll, RollPhoto } from "../types";
import {
	type Anchor,
	anchorOf,
	angDiff,
	biasedPrior,
	biasWindowS,
	compassHeading,
	hasCompass,
	MIN_BIAS_DEG,
	OUTLIER_DEG,
	viewpointBias,
} from "./viewpoint";

export type AlignStatus = "accepted" | "needs-review" | "failed";

export type PhotoAlignResult = {
	id: string;
	status: AlignStatus;
	/** Accepted: the stored pose. Needs review: the cascade's (unaccepted) best guess, NOT stored. Failed: the prior. */
	pose: Pose;
	/** The prior the cascade started from (the EXIF prior, shifted by biasDeg when that applied). */
	prior: Pose;
	confidence: number | null;
	stage: UnknownPoseResult["stage"] | null;
	/** Viewpoint compass-bias applied to the prior's yaw (deg), null when none. */
	biasDeg: number | null;
	/** Anchors the bias came from. */
	biasFrom: number;
	/** Cascade runs for this photo (2 when retried with a viewpoint prior). */
	attempts: number;
	/** Wall time over all attempts, ms. */
	ms: number;
	/**
	 * Accepted photos with a compass whose neighbours are anchored too: how far this photo's
	 * (pose − compass) offset is from theirs. `outlier` flags a disagreement worth a look; it does not
	 * change the accept (the cascade decides).
	 */
	viewpointCheck: {
		neighbourBiasDeg: number;
		deltaDeg: number;
		outlier: boolean;
	} | null;
	error?: string;
};

export type AlignProgress = {
	/** Photos finished (all attempts of the first pass, then retries). */
	done: number;
	total: number;
	/** The photo being solved now (null once finished). */
	current: RollPhoto | null;
	phase: "solve" | "retry" | "done";
	accepted: number;
};

export type AlignOptions = {
	signal?: AbortSignal;
	onProgress?: (p: AlignProgress) => void;
	/** Called after each photo's final attempt (also for retries, with the updated result). */
	onPhoto?: (r: PhotoAlignResult, photo: RollPhoto) => void;
	/** Also re-run photos that already have a 'solved' pose (from their EXIF prior). Default false. */
	resolve?: boolean;
	/** Use the viewpoint compass-bias prior (see viewpoint.ts). Default true. */
	viewpointBias?: boolean;
	/** Anchor window of the viewpoint bias, s. Default biasWindowS() (?rollBiasWindow, else 45 min). */
	biasWindowS?: number;
	/** Store accepted poses with saveSolvedPose. Default true (evaluation turns it off). */
	persist?: boolean;
	/** Per attempt deadline, ms (the worker's own DEM load gives up after 90 s). Default 150 s. */
	timeoutMs?: number;
};

export type AlignSummary = {
	results: PhotoAlignResult[];
	accepted: number;
	needsReview: number;
	failed: number;
	/** True when the signal aborted: results hold the photos finished before that (accepted ones are stored). */
	aborted: boolean;
	ms: number;
};

/** Retry a rejected photo when the viewpoint bias it would now get differs by at least this (deg). */
const RETRY_DELTA_DEG = 2;

/** Photos alignRoll would run on. */
export function alignTargets(roll: Roll, resolve = false) {
	return roll.photos.filter(
		(p) => p.poseSource === "prior" || (resolve && p.poseSource === "solved"),
	);
}

function loadImage(src: string, signal?: AbortSignal) {
	return new Promise<HTMLImageElement>((resolve, reject) => {
		const img = new Image();
		// bundled photos are same-origin, uploads are blob: URLs; either way the canvas must stay untainted
		img.crossOrigin = "anonymous";
		const onAbort = () => {
			img.src = "";
			reject(new DOMException("aborted", "AbortError"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		img.onload = () => {
			signal?.removeEventListener("abort", onAbort);
			resolve(img);
		};
		img.onerror = () => {
			signal?.removeEventListener("abort", onAbort);
			reject(new Error(`could not load ${src}`));
		};
		img.src = src;
	});
}

/** One cascade run in a fresh worker, bounded by `timeoutMs` and the caller's signal. */
async function runCascade(
	photo: RollPhoto,
	img: HTMLImageElement,
	prior: Pose,
	timeoutMs: number,
	signal?: AbortSignal,
) {
	// a worker per photo: the solver is bound to one camera position, and terminating it frees the
	// 360° terrain (tens of MB) before the next photo loads its own
	const solver = new UnknownPoseSolver(photo.meta);
	// no AbortSignal.any (Safari < 17.4): forward the caller's abort and the deadline into one controller
	const ctl = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		ctl.abort();
	}, timeoutMs);
	const forward = () => ctl.abort();
	signal?.addEventListener("abort", forward, { once: true });
	if (signal?.aborted) ctl.abort();
	try {
		return await solver.solve(
			img,
			prior,
			photoUnknowns(photo.meta),
			ctl.signal,
		);
	} catch (e) {
		if (timedOut && !signal?.aborted)
			throw new Error(
				`cascade did not finish within ${Math.round(timeoutMs / 1000)} s`,
			);
		throw e;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", forward);
		solver.dispose();
	}
}

const isAbort = (e: unknown) => (e as Error)?.name === "AbortError";

/**
 * Align every prior-only photo of the roll (and 'solved' ones with `resolve`). Resolves with a
 * summary; never throws except for programming errors. On abort it resolves early with
 * `aborted: true` (poses accepted so far are already stored).
 *
 * Order: capture time. With the viewpoint bias, a photo starts from its compass shifted by the
 * median offset of the anchored photos at its spot (saved / ground truth / solved / accepted
 * earlier in this run, within BIAS_WINDOW_S). Photos rejected before their spot had an anchor get
 * one retry in a second pass if the bias they would now get differs by ≥ RETRY_DELTA_DEG.
 */
export async function alignRoll(
	roll: Roll,
	opts: AlignOptions = {},
): Promise<AlignSummary> {
	const t0 = performance.now();
	const { signal, onProgress, onPhoto } = opts;
	const useBias = opts.viewpointBias ?? true;
	const windowS = opts.biasWindowS ?? biasWindowS();
	const persist = opts.persist ?? true;
	const timeoutMs = opts.timeoutMs ?? 150_000;
	const targets = alignTargets(roll, opts.resolve);
	const targetIds = new Set(targets.map((p) => p.meta.id));

	// anchors: trusted poses the run does not touch
	const anchors: Anchor[] = [];
	for (const p of roll.photos) {
		if (targetIds.has(p.meta.id) || p.poseSource === "prior") continue;
		const a = anchorOf(p.meta, p.viewpoint, p.t, p.pose);
		if (a) anchors.push(a);
	}

	const results = new Map<string, PhotoAlignResult>();
	const tried = new Map<string, number | null>(); // bias each photo was last tried with
	let done = 0;
	let aborted = false;
	const acceptedCount = () =>
		[...results.values()].filter((r) => r.status === "accepted").length;

	const biasFor = (p: RollPhoto) =>
		useBias && hasCompass(p.meta)
			? viewpointBias(anchors, p.viewpoint, p.t, p.meta.id, windowS)
			: null;

	const attempt = async (
		p: RollPhoto,
		img: HTMLImageElement,
		prev: PhotoAlignResult | undefined,
	): Promise<PhotoAlignResult> => {
		const bias = biasFor(p);
		const biasDeg =
			bias && Math.abs(bias.biasDeg) >= MIN_BIAS_DEG ? bias.biasDeg : null;
		const prior = biasedPrior(priorPose(p.meta), biasDeg);
		tried.set(p.meta.id, biasDeg);
		const ta = performance.now();
		const base = {
			id: p.meta.id,
			prior,
			biasDeg,
			biasFrom: biasDeg == null ? 0 : (bias?.n ?? 0),
			attempts: (prev?.attempts ?? 0) + 1,
			viewpointCheck: null,
		};
		const prevMs = prev?.ms ?? 0;
		try {
			const r = await runCascade(p, img, prior, timeoutMs, signal);
			const ms = prevMs + Math.round(performance.now() - ta);
			return {
				...base,
				status: r.accepted ? "accepted" : "needs-review",
				pose: r.pose,
				confidence: r.confidence,
				stage: r.stage,
				ms,
			};
		} catch (e) {
			if (isAbort(e) && signal?.aborted) throw e;
			const ms = prevMs + Math.round(performance.now() - ta);
			console.warn("[align-roll]", p.meta.id, e);
			return {
				...base,
				status: "failed",
				pose: p.pose,
				confidence: null,
				stage: null,
				ms,
				error: (e as Error)?.message ?? String(e),
			};
		}
	};

	const finish = (p: RollPhoto, r: PhotoAlignResult) => {
		results.set(p.meta.id, r);
		if (r.status === "accepted") {
			if (persist)
				saveSolvedPose(p.meta.id, {
					pose: r.pose,
					confidence: r.confidence ?? 0,
					method: "cascade",
					at: new Date().toISOString(),
				});
			const a = anchorOf(p.meta, p.viewpoint, p.t, r.pose);
			if (a) {
				const i = anchors.findIndex((x) => x.id === a.id);
				if (i >= 0) anchors[i] = a;
				else anchors.push(a);
			}
		}
		onPhoto?.(r, p);
	};

	const solveOne = async (p: RollPhoto, phase: "solve" | "retry") => {
		onProgress?.({
			done,
			total: targets.length,
			current: p,
			phase,
			accepted: acceptedCount(),
		});
		let img: HTMLImageElement;
		try {
			img = await loadImage(p.meta.src, signal);
		} catch (e) {
			if (isAbort(e) && signal?.aborted) throw e;
			const prior = priorPose(p.meta);
			const r: PhotoAlignResult = {
				id: p.meta.id,
				status: "failed",
				pose: p.pose,
				prior,
				confidence: null,
				stage: null,
				biasDeg: null,
				biasFrom: 0,
				attempts: 0,
				ms: 0,
				viewpointCheck: null,
				error: (e as Error)?.message,
			};
			return finish(p, r);
		}
		finish(p, await attempt(p, img, results.get(p.meta.id)));
	};

	try {
		for (const p of targets) {
			if (signal?.aborted) throw new DOMException("aborted", "AbortError");
			await solveOne(p, "solve");
			done++;
		}
		if (useBias) {
			// second pass: rejected photos whose spot gained an anchor after they were tried
			const retry = targets.filter((p) => {
				const r = results.get(p.meta.id);
				if (r?.status !== "needs-review") return false;
				const now = biasFor(p);
				const nowDeg =
					now && Math.abs(now.biasDeg) >= MIN_BIAS_DEG ? now.biasDeg : 0;
				return (
					Math.abs(nowDeg - (tried.get(p.meta.id) ?? 0)) >= RETRY_DELTA_DEG
				);
			});
			for (const p of retry) {
				if (signal?.aborted) throw new DOMException("aborted", "AbortError");
				await solveOne(p, "retry");
			}
		}
	} catch (e) {
		if (!isAbort(e)) throw e;
		aborted = true;
	}

	// leave-one-out consistency of each accepted photo against its anchored neighbours (informational)
	for (const p of targets) {
		const r = results.get(p.meta.id);
		if (r?.status !== "accepted" || !hasCompass(p.meta)) continue;
		const nb = viewpointBias(anchors, p.viewpoint, p.t, p.meta.id, windowS);
		if (!nb) continue;
		const deltaDeg = angDiff(
			angDiff(r.pose.yaw, compassHeading(p.meta)),
			nb.biasDeg,
		);
		r.viewpointCheck = {
			neighbourBiasDeg: nb.biasDeg,
			deltaDeg,
			outlier: Math.abs(deltaDeg) > OUTLIER_DEG,
		};
	}

	const list = targets
		.map((p) => results.get(p.meta.id))
		.filter((r): r is PhotoAlignResult => !!r);
	onProgress?.({
		done: list.length,
		total: targets.length,
		current: null,
		phase: "done",
		accepted: acceptedCount(),
	});
	return {
		results: list,
		accepted: list.filter((r) => r.status === "accepted").length,
		needsReview: list.filter((r) => r.status === "needs-review").length,
		failed: list.filter((r) => r.status === "failed").length,
		aborted,
		ms: Math.round(performance.now() - t0),
	};
}

/** Forget the aligner's poses for these photos (e.g. to re-align from scratch). */
export function clearSolvedPoses(roll: Roll) {
	for (const p of roll.photos)
		if (loadSolvedPose(p.meta.id)) saveSolvedPose(p.meta.id, null);
}
