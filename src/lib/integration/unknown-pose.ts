// Pose for photos whose heading / gravity / focal is unknown (uploads without a compass, gravity vector
// or 35 mm focal). reports/bench-ablation.md: the app's autoAlign accepts wrong poses on these (7/11
// without a heading), so it is never auto-accepted here. Order:
//   1. 0f's CPU cascade in a Worker with the unknowns declared (360° yaw, free tilt, focal seeds);
//      its pose is taken only if it accepts (0 false accepts in every ablation condition).
//   2. if the cascade rejects and the matcher service is up: fused /match in ad-hoc mode (two-stage
//      360° sweep); taken only at confidenceLevel HIGH.
//   3. otherwise the best guess is shown as "unverified".

import type { Pose } from "#/lib/camera";
import { priorHeading } from "#/lib/geocam/priors/heading";
import { gpuEnabled } from "#/lib/gpu/device";
import { unknownGpuOptIn } from "#/lib/gpu/horizon/unknown-opt-in";
import {
	type MatchRequest,
	type MatchResult,
	matchAccepted,
	requestMatch,
	requestMatchOrDefer,
} from "#/lib/matcher-client";
import type { PhotoMeta } from "#/lib/photos";

export type Unknowns = {
	yaw: boolean;
	gravity: boolean;
	focal: boolean;
	any: boolean;
};

type LocalFlags = {
	yawUnknown?: boolean;
	pitchRollUnknown?: boolean;
	focalUnknown?: boolean;
};

export function photoUnknowns(photo: PhotoMeta): Unknowns {
	const l = (photo as PhotoMeta & { local?: LocalFlags }).local;
	const yaw = priorHeading(photo) == null || !!l?.yawUnknown;
	const gravity = photo.gravity == null || !!l?.pitchRollUnknown;
	const focal = !!l?.focalUnknown;
	return { yaw, gravity, focal, any: yaw || gravity || focal };
}

export type UnknownPosePrepare = {
	type: "prepare";
	lat: number;
	lon: number;
	alt: number | null;
	/** 360° horizon on the GPU (opt-in: unknownGpuOptIn); the CPU sceneHorizon otherwise and on failure */
	gpu?: boolean;
	/** solvePose's coarse grid on the GPU (src/lib/gpu/solve; identical by construction): gpuEnabled() */
	solveGpu?: boolean;
};

export type UnknownPoseRequest = {
	type: "solve";
	id: number;
	lat: number;
	lon: number;
	alt: number | null;
	gpsAccuracy: number | null;
	width: number;
	height: number;
	prior: Pose;
	unknown: Omit<Unknowns, "any">;
	image: { width: number; height: number; data: Uint8ClampedArray };
	/** as UnknownPosePrepare.gpu */
	gpu?: boolean;
	/** as UnknownPosePrepare.solveGpu */
	solveGpu?: boolean;
};

export type UnknownPoseResult = {
	pose: Pose;
	confidence: number;
	accepted: boolean;
	stage: "solve" | "refine";
	/**
	 * every cascade stage that ran, in order (solve, then refine on reject), for the chosen focal seed and
	 * then the other focal seeds; near-duplicates dropped, at most MAX_CANDIDATES. `pose` is the first
	 * accepting stage's, else solve's. When nothing accepts any may be right, so seed /match with them.
	 */
	candidates: {
		pose: Pose;
		confidence: number;
		stage: "solve" | "refine";
		accepted: boolean;
	}[];
	/** one entry per focal seed (a single one when the focal is known) */
	seeds: {
		vfov: number;
		yaw: number;
		solvedVfov: number;
		confidence: number;
		accepted: boolean;
		stage: "solve" | "refine";
	}[];
	ms: { horizon: number; total: number };
	/** where the 360° horizon was marched (src/lib/gpu/horizon/scene-profile.ts when "gpu") */
	horizonOn?: "gpu" | "cpu";
	/** where solvePose's coarse grids ran ("mixed": some fell back to the CPU) */
	solveOn?: "gpu" | "cpu" | "mixed";
};

export type UnknownPoseResponse =
	| { id: number; ok: true; result: UnknownPoseResult }
	| { id: number; ok: false; error: string };

const WORK_WIDTH = 800; // as scripts/eval.ts
let seq = 0;

/**
 * The cascade in a Web Worker. Create it as soon as the photo is known: it starts loading the 360°
 * terrain and horizon at once (in parallel with the engine), and keeps the horizon for re-runs.
 */
export class UnknownPoseSolver {
	private worker: Worker;
	private pending = new Map<
		number,
		{ resolve: (r: UnknownPoseResult) => void; reject: (e: Error) => void }
	>();
	/** GPU 360° horizon, opt-in (?unknownGpu=on; off under ?gpu=off) */
	private gpu = unknownGpuOptIn();
	/** GPU coarse grid: on wherever WebGPU is (off under ?gpu=off); the result is the CPU's by construction */
	private solveGpu = gpuEnabled();

	constructor(private photo: PhotoMeta) {
		this.worker = new Worker(
			new URL("./unknown-pose.worker.ts", import.meta.url),
			{ type: "module" },
		);
		this.worker.onmessage = (ev: MessageEvent<UnknownPoseResponse>) => {
			const p = this.pending.get(ev.data.id);
			if (!p) return;
			this.pending.delete(ev.data.id);
			if (ev.data.ok) p.resolve(ev.data.result);
			else p.reject(new Error(ev.data.error));
		};
		this.worker.onerror = (e) =>
			this.failAll(new Error(e.message || "cascade worker failed"));
		const prep: UnknownPosePrepare = {
			type: "prepare",
			lat: photo.lat,
			lon: photo.lon,
			alt: photo.alt,
			gpu: this.gpu,
			solveGpu: this.solveGpu,
		};
		this.worker.postMessage(prep);
	}

	private failAll(e: Error) {
		for (const p of this.pending.values()) p.reject(e);
		this.pending.clear();
	}

	solve(
		img: HTMLImageElement,
		prior: Pose,
		unknown: Unknowns,
		signal?: AbortSignal,
	) {
		return new Promise<UnknownPoseResult>((resolve, reject) => {
			const w = WORK_WIDTH;
			const h = Math.round((img.naturalHeight * w) / img.naturalWidth);
			const canvas = document.createElement("canvas");
			canvas.width = w;
			canvas.height = h;
			const c2d = canvas.getContext("2d", { willReadFrequently: true });
			if (!c2d) return reject(new Error("2D canvas unavailable"));
			c2d.drawImage(img, 0, 0, w, h);
			const data = c2d.getImageData(0, 0, w, h).data;
			const id = ++seq;
			const onAbort = () => {
				this.pending.delete(id);
				reject(new DOMException("aborted", "AbortError"));
			};
			if (signal?.aborted) return onAbort();
			signal?.addEventListener("abort", onAbort, { once: true });
			const off = () => signal?.removeEventListener("abort", onAbort);
			this.pending.set(id, {
				resolve: (r) => {
					off();
					resolve(r);
				},
				reject: (e) => {
					off();
					reject(e);
				},
			});
			const p = this.photo;
			const req: UnknownPoseRequest = {
				type: "solve",
				id,
				lat: p.lat,
				lon: p.lon,
				alt: p.alt,
				gpsAccuracy: p.hAccuracy,
				width: p.width,
				height: p.height,
				prior,
				unknown: {
					yaw: unknown.yaw,
					gravity: unknown.gravity,
					focal: unknown.focal,
				},
				image: { width: w, height: h, data },
				gpu: this.gpu,
				solveGpu: this.solveGpu,
			};
			this.worker.postMessage(req, [data.buffer]);
		});
	}

	dispose() {
		this.failAll(
			new DOMException("disposed", "AbortError") as unknown as Error,
		);
		this.worker.terminate();
	}
}

/**
 * Where the position came from, for the matcher's basin-gap LOW check (on for anything but "exif-gps"):
 * bundled photos and uploads with EXIF GPS are "exif-gps", a pin the user placed is "manual".
 */
export function positionSource(photo: PhotoMeta) {
	const l = (
		photo as PhotoMeta & { local?: { positionSource?: "exif" | "pin" } }
	).local;
	return l?.positionSource === "pin" ? "manual" : "exif-gps";
}

/**
 * Fused /match, ad-hoc photo mode (tools/matcher/server/app.py match_adhoc): unknowns are simply omitted.
 * `seeds` are the cascade's candidates (reports/matcher-service.md v0.3): only real candidates, since a
 * wrong seed costs time (+90° seed: 60–104 s instead of 34–62 s).
 * v0.3 on CPU LightGlue with basin-gap takes 45–77 s when idle, hence the 150 s default.
 */
export async function matchUnknownPose(
	photo: PhotoMeta,
	prior: Pose,
	unknown: Unknowns,
	signal?: AbortSignal,
	timeoutMs = 150_000,
	seeds: Pose[] = [],
) {
	const req = await adhocRequest(photo, prior, unknown, signal, seeds);
	return req && requestMatch(req, { signal, timeoutMs });
}

/** matchUnknownPose with requestMatchOrDefer's early out when the service is contended. */
export async function matchUnknownPoseOrDefer(
	photo: PhotoMeta,
	prior: Pose,
	unknown: Unknowns,
	signal?: AbortSignal,
	timeoutMs = 150_000,
	seeds: Pose[] = [],
) {
	const req = await adhocRequest(photo, prior, unknown, signal, seeds);
	return req
		? requestMatchOrDefer(req, { signal, timeoutMs })
		: { result: null };
}

async function adhocRequest(
	photo: PhotoMeta,
	prior: Pose,
	unknown: Unknowns,
	signal: AbortSignal | undefined,
	seeds: Pose[],
): Promise<MatchRequest | null> {
	let blob: Blob;
	try {
		blob = await (await fetch(photo.src, { signal })).blob();
	} catch {
		return null;
	}
	return {
		photo: blob,
		meta: {
			lat: photo.lat,
			lon: photo.lon,
			altitudeM: photo.alt,
			positionSource: positionSource(photo),
		},
		...(photo.hAccuracy != null ? { positionUncertainM: photo.hAccuracy } : {}),
		...(seeds.length
			? {
					poseSeeds: seeds.map((p) => ({
						yaw: p.yaw,
						pitch: p.pitch,
						roll: p.roll,
						vfov: p.vfov,
					})),
				}
			: {}),
		prior: {
			...(unknown.yaw ? {} : { yaw: prior.yaw }),
			...(unknown.gravity ? {} : { pitch: prior.pitch, roll: prior.roll }),
			...(unknown.focal ? {} : { vfov: prior.vfov }),
		},
		fused: true,
	};
}

export type UnknownPoseOutcome = {
	pose: Pose;
	/** accepted: a verifier accepted it; unverified: best guess only, the user should check it */
	state: "accepted" | "unverified";
	source: "cascade" | "matcher" | "none";
	confidence: number | null;
	note: string;
	/**
	 * The match service was contended, so this unverified outcome came early: the match is still running
	 * (under the caller's signal) and resolves to an accepted outcome if it is confident, else null.
	 */
	upgrade?: Promise<UnknownPoseOutcome | null>;
};

/** Cascade → matcher → unverified. Never throws; `fallback` is used when nothing produced a pose. */
export async function resolveUnknownPose(
	photo: PhotoMeta,
	solver: UnknownPoseSolver,
	img: HTMLImageElement,
	prior: Pose,
	unknown: Unknowns,
	fallback: Pose,
	opts: { signal?: AbortSignal; onStage?: (msg: string) => void } = {},
): Promise<UnknownPoseOutcome> {
	const what = [
		unknown.yaw && "compass",
		unknown.gravity && "gravity",
		unknown.focal && "lens",
	]
		.filter(Boolean)
		.join(" + ");
	let guess: UnknownPoseResult | null = null;
	try {
		opts.onStage?.(
			`No ${what}: searching ${unknown.yaw ? "360°" : "free tilt"} (skyline cascade)`,
		);
		guess = await solver.solve(img, prior, unknown, opts.signal);
		console.debug("[unknown-pose] cascade", {
			accepted: guess.accepted,
			confidence: +guess.confidence.toFixed(3),
			stage: guess.stage,
			ms: JSON.stringify(guess.ms),
			seeds: JSON.stringify(guess.seeds),
		});
		if (guess.accepted)
			return {
				pose: guess.pose,
				state: "accepted",
				source: "cascade",
				confidence: guess.confidence,
				note: `No ${what}: skyline cascade accepted · confidence ${(guess.confidence * 100).toFixed(0)}%`,
			};
	} catch (e) {
		if ((e as Error)?.name === "AbortError") throw e;
		console.warn("[unknown-pose] cascade failed", e);
	}
	opts.onStage?.(`No ${what}: asking the match service`);
	const accepted = (m: MatchResult): UnknownPoseOutcome => ({
		pose: m.pose,
		state: "accepted",
		source: "matcher",
		confidence: m.confidence,
		note: `No ${what}: render-and-match accepted (high confidence)`,
	});
	const isAccepted = (m: MatchResult) =>
		matchAccepted(m, {
			positionTrusted: positionSource(photo) === "exif-gps",
			cascadePose: guess?.pose,
		});
	const r = await matchUnknownPoseOrDefer(
		photo,
		prior,
		unknown,
		opts.signal,
		undefined,
		guess?.candidates.map((c) => c.pose) ?? [],
	);
	if ("deferred" in r) {
		// contended service: don't hold the overlay for minutes; the user checks the guess, and a confident
		// match still upgrades it later
		return {
			pose: guess?.pose ?? fallback,
			state: "unverified",
			source: guess ? "cascade" : "none",
			confidence: guess?.confidence ?? null,
			note: `Unverified: no ${what}, and the match service is busy. Check this pose, drag it or pin a peak; it updates if the match service confirms one.`,
			upgrade: r.deferred.then((m) =>
				m && isAccepted(m) ? accepted(m) : null,
			),
		};
	}
	const m = r.result;
	if (m && isAccepted(m)) return accepted(m);
	// the cascade's guess here is a rejected one (confidence ~0), so the matcher's LOW pose is the better
	// unverified guess: on IMG_7155 stripped it was 0.03° off where the rejected cascade guess was 159° off
	const src = m ? "matcher" : guess ? "cascade" : "none";
	return {
		pose: m?.pose ?? guess?.pose ?? fallback,
		state: "unverified",
		source: src,
		confidence: m?.confidence ?? guess?.confidence ?? null,
		note: `Unverified: no ${what}, and no solver could confirm this pose. Check it, drag it or pin a peak.`,
	};
}
