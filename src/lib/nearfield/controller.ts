// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Step Inside orchestration for one photo in the workspace (reports/step-inside-design.md).
//
//   available()  → the in-browser near-field source can run (nearField.available(): WebGPU + the depth
//                  model's weights reachable; never throws)
//   build()      → depth (MoGe-2 ViT-S on src/lib/nn) + the depth lift (graph kernel), in the browser
//                  (./local/client.ts), for the photo (cached per photo), the renderer's DEM range grid for the current pose
//                  (after readback()), the engine's sky / people masks when it has them
//                  → buildNearFieldScene (public signature only) → the measure grid → cached per photo+pose
//   show()/hide() → renderer.setNearField(scene | null, opts)
// Preview: while the photo's depth is not ready (weights downloading, inference running), build() first
// shows a terrain-only scene from the DEM range alone (preview.ts; phase stays "loading", state.preview,
// scene.preview) and replaces it in place with the depth-model scene. A preview has no measure grid and no
// splats: it never measures or exports, and skips the anchor gate (it is the DEM itself).
// Gate: only for an accepted pose (poseAccepted); the scene is hidden when anchor.quality <
// ANCHOR_MIN_QUALITY and flagged 'low trust' below LOW_TRUST_QUALITY.
import { getFlag } from "#/lib/flags";
import type { Pose } from "../camera";
import type { EnuFrame } from "../geodesy";
import type { PhotoMeta } from "../photos";
import { ANCHOR_LOW_TRUST } from "./anchor";
import { nearField as defaultClient, type NearFieldSource } from "./client";
import {
	completeScene,
	completionEnabled,
	completionLiftOpts,
} from "./complete";
import { intrinsicsFromPose, type MaskLike, sampleDemGrid } from "./geom";
import {
	buildMeasureGrid,
	type MeasurableScene,
	type NearFieldSample,
	nearFieldSampleAt,
} from "./measure";
import { prepareObjectPrior } from "./object-evidence";
import {
	demPreviewDepth,
	PREVIEW_DEPTH_MODEL,
	previewGridSize,
} from "./preview";
import { buildNearFieldScene, imageToRGBA } from "./scene";
import {
	ANCHOR_MIN_QUALITY,
	DEFAULT_SPLIT,
	type GaussianCloud,
	type NearFieldDepth,
	type NearFieldScene,
	type NearFieldViewOpts,
	PixelClass,
	type SplitParams,
} from "./types";

/**
 * Below this anchor quality the scene is shown with a 'low trust' badge; the design gate
 * (ANCHOR_MIN_QUALITY) hides it outright. One constant with the export header's (anchor.ts
 * ANCHOR_LOW_TRUST), so the panel chip and the exported file can never disagree.
 */
export const LOW_TRUST_QUALITY = ANCHOR_LOW_TRUST;

/**
 * Phase-1 split parameters (tools/nearfield/spike/SUMMARY.txt + reviewer note): MoGe-2 compresses range,
 * so the Object margin is wide and the near radius short. Pixels with depth but no DEM within nearRadius
 * are Object (split.ts handles that case).
 */
export const STEP_SPLIT: SplitParams = {
	...DEFAULT_SPLIT,
	objectMargin: 0.5,
	nearRadius: 150,
};

/** Alignment states of PhotoWorkspace that count as an accepted / user-confirmed pose. */
export const ACCEPTED_ALIGN_STATES = [
	"accepted",
	"pinned",
	"saved",
	"manual",
] as const;

/**
 * Accepted = the pose came from an autoAlign that a solver confirmed (state 'accepted', or 'auto' with a
 * verified / refined / matched second opinion), manual pins, a saved pose (incl. injected GT), or the
 * user's own hand alignment. 'auto' without a verdict, 'near-compass', 'prior' and 'unverified' are not.
 */
export function poseAccepted(
	alignState: string | null | undefined,
	verify?: string | null,
): boolean {
	if (!alignState) return false;
	if ((ACCEPTED_ALIGN_STATES as readonly string[]).includes(alignState))
		return true;
	return (
		alignState === "auto" &&
		(verify === "verified" || verify === "refined" || verify === "matched")
	);
}

/** The renderer members the controller reads (the deck engines satisfy it). */
export type NearFieldHost = {
	readonly pose: Pose;
	readonly aspect: number;
	readonly eye: { readonly x: number; readonly y: number; readonly z: number };
	readonly frame: Pick<EnuFrame, "toGeo">;
	readonly photoElement: HTMLImageElement | undefined;
	sampleAt(u: number, v: number): { range: number } | null;
	/**
	 * The terrain range (m) to anchor against, on a width × height grid for the current pose, when it
	 * differs from sampleAt (DeckEngine: its query buffer drops terrain right in front of the eye).
	 */
	nearFieldDemRange?(
		width: number,
		height: number,
	): (u: number, v: number) => number | null;
	/** Load the shared near-camera DEM (near-dem.ts) that nearFieldDemRange uses; awaited before sampling. */
	prepareNearFieldDem?(): Promise<void>;
	readback(): Promise<boolean>;
	geometryReady(): boolean;
	setNearField?(scene: NearFieldScene | null, opts?: NearFieldViewOpts): void;
	/** People / foreground mask (row 0 = top), when the engine segmented one. */
	readonly foregroundMask?: MaskLike | null;
	/** P(sky) 0..255 (row 0 = top), when a look loaded one. */
	readonly skyMaskData?: MaskLike | null;
};

export type NearFieldPhase =
	| "idle"
	| "checking"
	| "unavailable"
	| "loading"
	| "ready"
	| "low-quality"
	| "error";

export type NearFieldState = {
	phase: NearFieldPhase;
	/** Human-readable reason / progress. */
	message?: string;
	quality?: number;
	lowTrust?: boolean;
	splats?: number;
	confidenceRadius?: number;
	objectPixels?: number;
	/** Depth model and gaussian source actually used. */
	depthModel?: string;
	gaussians?: string;
	/** True when research-only weights produced the splats (never: SHARP was dropped with the service). */
	researchOnly?: boolean;
	seconds?: number;
	/**
	 * A terrain-only preview (DEM range, no depth model) is shown while the depth loads; phase is "loading".
	 * Not measurable; the depth-model scene replaces it in place.
	 */
	preview?: boolean;
};

export type BuildOpts = {
	/** Show a terrain-only preview while the photo's depth is not ready (default true). */
	preview?: boolean;
	/** Called once when the preview scene becomes current (the caller may enter the step camera on it). */
	onPreview?: (scene: MeasurableScene) => void;
};

type PhotoData = {
	depth: NearFieldDepth;
	cloud: GaussianCloud | null;
	cloudK: { fx: number; fy: number; cx: number; cy: number } | null;
	gaussians: string;
};

/** Per photo+model: the service results (the slow part), shared across controllers (engine re-creation). */
const PHOTO_CACHE = new Map<string, Promise<PhotoData | null>>();
const PHOTO_CACHE_MAX = 4;
/** Keys of PHOTO_CACHE entries that resolved with data (depth ready: no preview needed). */
const PHOTO_READY = new Set<string>();

export function poseKey(p: Pose, eye: { x: number; y: number; z: number }) {
	const f = (x: number) => x.toFixed(4);
	return `${f(p.yaw)}|${f(p.pitch)}|${f(p.roll)}|${f(p.vfov)}|${eye.x.toFixed(2)},${eye.y.toFixed(2)},${eye.z.toFixed(2)}`;
}

async function photoBlob(
	photo: PhotoMeta,
	img: HTMLImageElement | undefined,
): Promise<Blob | null> {
	try {
		const r = await fetch(photo.src);
		if (r.ok) return await r.blob();
	} catch {}
	if (!img) return null;
	// fallback: re-encode the decoded element (uploads served from blob: URLs that were revoked, etc.)
	const s = Math.min(1, 2048 / Math.max(img.naturalWidth, img.naturalHeight));
	const c = document.createElement("canvas");
	c.width = Math.max(1, Math.round(img.naturalWidth * s));
	c.height = Math.max(1, Math.round(img.naturalHeight * s));
	c.getContext("2d")?.drawImage(img, 0, 0, c.width, c.height);
	return new Promise((res) => c.toBlob(res, "image/jpeg", 0.92));
}

export class NearFieldController {
	readonly photo: PhotoMeta;
	readonly host: NearFieldHost;
	readonly client: NearFieldSource;
	state: NearFieldState = { phase: "idle" };
	/** The scene for the current pose (null until built, or when hidden for low quality). */
	scene: MeasurableScene | null = null;
	private sceneKey = "";
	private sceneCache = new Map<string, MeasurableScene>();
	private listeners = new Set<(s: NearFieldState) => void>();
	private building: Promise<MeasurableScene | null> | null = null;
	private buildingKey = "";
	private shown = false;
	private viewOpts: NearFieldViewOpts = {};
	private disposed = false;
	/** Bumped per started build: a superseded run must not reset a newer run's "loading" phase. */
	private runSeq = 0;
	/** Latest progress text of the running build (the preview message repeats it). */
	private progress = "";
	/** onPreview callbacks of the running build (cleared when it settles). */
	private previewCbs = new Set<(scene: MeasurableScene) => void>();

	constructor(
		host: NearFieldHost,
		photo: PhotoMeta,
		opts: { client?: NearFieldSource } = {},
	) {
		this.host = host;
		this.photo = photo;
		this.client = opts.client ?? defaultClient;
	}

	get supported(): boolean {
		return typeof this.host.setNearField === "function";
	}

	onState(cb: (s: NearFieldState) => void): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}

	private set(s: NearFieldState) {
		if (this.disposed) return;
		this.state = s;
		for (const cb of this.listeners) cb(s);
	}

	/**
	 * Local availability (cached by the client): WebGPU compute plus reachable depth weights. Never
	 * throws. A built scene does not need the model, so a failed probe leaves a 'ready' / 'low-quality' /
	 * 'loading' state alone.
	 */
	async available(force = false): Promise<boolean> {
		if (!this.supported) return false;
		const ok = await this.client.available(force);
		const phase = this.state.phase;
		if (
			!ok &&
			phase !== "loading" &&
			phase !== "ready" &&
			phase !== "low-quality"
		)
			this.set({
				phase: "unavailable",
				message: "Step Inside needs WebGPU and its depth model",
			});
		else if (ok && this.state.phase === "unavailable")
			this.set({ phase: "idle" });
		return ok;
	}

	/**
	 * Fetch the depth model's weights ahead of the first build (src/lib/nearfield/local prefetch: into
	 * Cache Storage, no device memory), so pressing Step Inside does not wait on the download. Never throws.
	 */
	async prefetch(signal?: AbortSignal): Promise<boolean> {
		if (!this.supported || !this.client.prefetch) return false;
		return this.client.prefetch(signal).catch(() => false);
	}

	/** True when a scene for the current pose is cached (show() is instant, no model run). */
	hasSceneForPose(): boolean {
		return this.sceneCache.has(poseKey(this.host.pose, this.host.eye));
	}

	/** True when the slow depth results for this photo are cached (a pose change rebuilds locally). */
	hasPhotoData(): boolean {
		return PHOTO_CACHE.has(this.photoKey());
	}

	/** True when this photo's depth has been computed (cached): build() then shows no preview. */
	depthReady(): boolean {
		return PHOTO_READY.has(this.photoKey());
	}

	private photoKey() {
		return `${this.photo.id}|${this.photo.src}`;
	}

	/** "loading" with `message`, prefixed while a preview is shown. */
	private loading(message: string, runId: number) {
		if (this.runSeq !== runId) return;
		this.progress = message;
		if (this.scene?.preview)
			this.set({
				...this.state,
				phase: "loading",
				preview: true,
				message: previewMessage(message),
			});
		else this.set({ phase: "loading", message });
	}

	/** Drop a shown preview (the run failed or was superseded). */
	private dropPreview() {
		if (!this.scene?.preview) return;
		this.scene = null;
		this.sceneKey = "";
		if (this.shown) this.host.setNearField?.(null);
	}

	private fetchPhotoData(
		signal?: AbortSignal,
		onProgress?: (message: string) => void,
	): Promise<PhotoData | null> {
		const key = this.photoKey();
		let p = PHOTO_CACHE.get(key);
		if (!p) {
			p = (async () => {
				const blob = await photoBlob(this.photo, this.host.photoElement);
				if (!blob) return null;
				// sequential: the lift reuses the photo's cached depth
				const depth = await this.client.depth(blob, {
					model: "moge2",
					signal,
					onProgress,
				});
				if (!depth) return null;
				const g = await this.client.gaussiansWithMeta(blob, {
					model: "lift",
					signal,
					onProgress,
				});
				return {
					depth,
					cloud: g?.cloud ?? null,
					cloudK: g?.meta.intrinsicsNorm ?? null,
					gaussians: g ? "lift" : "client depth-lift",
				};
			})();
			PHOTO_CACHE.set(key, p);
			while (PHOTO_CACHE.size > PHOTO_CACHE_MAX) {
				const first = PHOTO_CACHE.keys().next().value;
				if (first === undefined) break;
				PHOTO_CACHE.delete(first);
				PHOTO_READY.delete(first);
			}
			// failures are not cached
			p.then((d) => {
				if (PHOTO_CACHE.get(key) !== p) return;
				if (d) PHOTO_READY.add(key);
				else PHOTO_CACHE.delete(key);
			}).catch(() => {
				if (PHOTO_CACHE.get(key) === p) PHOTO_CACHE.delete(key);
			});
		}
		return p;
	}

	/**
	 * Build (or reuse) the scene for the current pose. The caller checks poseAccepted() first. Resolves
	 * null on failure / low quality (see `state`). Never throws. While the photo's depth is not ready a
	 * terrain-only preview is made current first (opts.onPreview), unless opts.preview is false.
	 */
	async build(
		signal?: AbortSignal,
		opts: BuildOpts = {},
	): Promise<MeasurableScene | null> {
		const key0 = poseKey(this.host.pose, this.host.eye);
		const hit = this.sceneCache.get(key0);
		if (hit) return this.adopt(hit, key0);
		if (this.building && this.buildingKey === key0) {
			if (opts.onPreview) this.previewCbs.add(opts.onPreview);
			return this.building;
		}
		this.buildingKey = key0;
		const runId = ++this.runSeq;
		this.previewCbs.clear();
		if (opts.onPreview) this.previewCbs.add(opts.onPreview);
		const run = (async (): Promise<MeasurableScene | null> => {
			// early exits must not leave the phase at "loading" (the button would stay disabled)
			const bail = (): null => {
				if (this.runSeq === runId) this.dropPreview();
				if (this.state.phase === "loading" && this.runSeq === runId)
					this.set({ phase: "idle" });
				return null;
			};
			if (!(await this.available())) return bail();
			const t0 = performance.now();
			this.progress = this.hasPhotoData()
				? "Rebuilding for this pose"
				: "Estimating depth (MoGe-2)";
			this.set({ phase: "loading", message: this.progress });
			// the terrain-only preview runs beside the depth fetch (never awaited here)
			if (opts.preview !== false && !this.depthReady())
				void this.buildPreview(runId, signal);
			try {
				const data = await this.fetchPhotoData(signal, (message) => {
					if (this.state.phase === "loading") this.loading(message, runId);
				});
				if (signal?.aborted || this.disposed) return bail();
				if (!data) {
					if (this.runSeq === runId) this.dropPreview();
					this.set({ phase: "error", message: "depth estimation failed" });
					return null;
				}
				this.loading("Anchoring to the terrain", runId);
				await this.host.prepareNearFieldDem?.();
				// the DEM grid must describe the pose we key on: wait for a fresh geometry buffer
				if (!(await this.host.readback()) || this.disposed) return bail();
				// one camera for the whole build: the awaits below (object prior) must not mix two poses
				const pose = { ...this.host.pose };
				const eye = {
					x: this.host.eye.x,
					y: this.host.eye.y,
					z: this.host.eye.z,
				};
				const aspect = this.host.aspect;
				const key = poseKey(pose, eye);
				if (!this.host.geometryReady()) return bail();
				const { depth } = data;
				const demAt =
					this.host.nearFieldDemRange?.(depth.width, depth.height) ??
					((u: number, v: number) => this.host.sampleAt(u, v)?.range ?? null);
				const demGrid = sampleDemGrid(depth.width, depth.height, demAt);
				// T2 (?tiles3dObjects=on only): nDSM evidence for the object prior; null = no prior, silently
				const objectPrior =
					getFlag("tiles3dObjects") === "on"
						? await prepareObjectPrior({
								width: depth.width,
								height: depth.height,
								demGrid,
								K: intrinsicsFromPose(pose, aspect),
								pose,
								eye,
								frame: this.host.frame,
								signal,
							})
						: null;
				if (signal?.aborted || this.disposed) return bail();
				if (key !== poseKey(this.host.pose, this.host.eye)) return bail();
				const img = this.host.photoElement;
				const photo = !data.cloud && img ? imageToRGBA(img, 1024) : null;
				// ?nearfield=complete: the P0 completion heuristics (display-only; complete/index.ts)
				const complete = completionEnabled();
				const built = buildNearFieldScene({
					photoId: this.photo.id,
					depth,
					cloud: data.cloud,
					cloudIntrinsics: data.cloudK,
					renderer: this.host,
					photo,
					skyMask: this.host.skyMaskData ?? null,
					peopleMask: this.host.foregroundMask ?? null,
					split: STEP_SPLIT,
					demGrid,
					// opt-in cliff-lip anchoring (cliff-lip.ts), off by default
					...(getFlag("anchorCliff") === "on"
						? { anchor: { cliffLip: true } }
						: {}),
					...(objectPrior ? { objectPrior } : {}),
					...(complete
						? { lift: completionLiftOpts(this.host.foregroundMask ?? null) }
						: {}),
				});
				const scene = (
					complete
						? completeScene(built, {
								depth,
								demGrid,
								K: intrinsicsFromPose(pose, aspect),
								pose: { ...pose },
								eye: { ...eye },
								peopleMask: this.host.foregroundMask ?? null,
							}).scene
						: built
				) as MeasurableScene;
				const ctx = {
					pose: { ...pose },
					aspect,
					eye: { ...eye },
					frame: this.host.frame,
				};
				scene.measure = { ...buildMeasureGrid(scene, ctx), ...ctx };
				// the export's licence line: a depth-lift of the depth model
				scene.model = `${depth.model}-lift`;
				(scene as MeasurableScene & { meta?: unknown }).meta = {
					depthModel: depth.model,
					gaussians: data.gaussians,
					seconds: (performance.now() - t0) / 1000,
				};
				this.sceneCache.set(key, scene);
				if (this.sceneCache.size > 6) {
					const first = this.sceneCache.keys().next().value;
					if (first !== undefined) this.sceneCache.delete(first);
				}
				if (key !== poseKey(this.host.pose, this.host.eye)) return bail();
				return this.adopt(scene, key);
			} catch (e) {
				console.warn("[nearfield] build failed", e);
				if (this.runSeq === runId) this.dropPreview();
				this.set({
					phase: "error",
					message: String((e as Error)?.message ?? e),
				});
				return null;
			}
		})();
		this.building = run;
		run.finally(() => {
			if (this.building === run) this.building = null;
			if (this.runSeq === runId) this.previewCbs.clear();
		});
		return run;
	}

	/**
	 * The terrain-only preview for run `runId`: the DEM range grid at the current pose → a synthetic depth
	 * (preview.ts) → the same scene builder (no photo, no people, no grounding: no splats). Made current only
	 * while that run is still loading at the same pose and no depth-model scene has landed. Never throws.
	 */
	private async buildPreview(runId: number, signal?: AbortSignal) {
		const live = () =>
			!this.disposed &&
			!signal?.aborted &&
			this.runSeq === runId &&
			this.state.phase === "loading";
		try {
			await this.host.prepareNearFieldDem?.();
			if (!live() || !(await this.host.readback()) || !live()) return;
			if (!this.host.geometryReady()) return;
			const pose = { ...this.host.pose };
			const eye = {
				x: this.host.eye.x,
				y: this.host.eye.y,
				z: this.host.eye.z,
			};
			const aspect = this.host.aspect;
			const key = poseKey(pose, eye);
			const { width, height } = previewGridSize(aspect);
			const demAt =
				this.host.nearFieldDemRange?.(width, height) ??
				((u: number, v: number) => this.host.sampleAt(u, v)?.range ?? null);
			const demGrid = sampleDemGrid(width, height, demAt);
			const skyMask = this.host.skyMaskData ?? null;
			const depth = demPreviewDepth(
				demGrid,
				width,
				height,
				intrinsicsFromPose(pose, aspect),
				skyMask,
			);
			const scene = buildNearFieldScene({
				photoId: this.photo.id,
				depth,
				renderer: this.host,
				photo: null,
				skyMask,
				// a person would split as Object with no splat to fill it: a hole in the drape
				peopleMask: null,
				split: STEP_SPLIT,
				demGrid,
				// depth = DEM: a scale-only fit is the identity (a failed fit is scale 1 too)
				anchor: { mode: "scale" },
				ground: false,
				farObjects: false,
			}) as MeasurableScene;
			scene.preview = true;
			scene.model = PREVIEW_DEPTH_MODEL;
			// a depth-model scene may have landed meanwhile (phase no longer "loading")
			if (!live()) return;
			if (key !== poseKey(this.host.pose, this.host.eye)) return;
			this.adoptPreview(scene, key);
		} catch (e) {
			console.warn("[nearfield] terrain preview failed", e);
		}
	}

	/** Make a preview current: no quality gate, phase stays "loading", state.preview. */
	private adoptPreview(scene: MeasurableScene, key: string) {
		this.scene = scene;
		this.sceneKey = key;
		this.set({
			phase: "loading",
			preview: true,
			message: previewMessage(this.progress),
			splats: scene.splats.count,
			confidenceRadius: scene.confidenceRadius,
			depthModel: PREVIEW_DEPTH_MODEL,
		});
		if (this.shown) this.host.setNearField?.(scene, this.viewOpts);
		const cbs = [...this.previewCbs];
		this.previewCbs.clear();
		for (const cb of cbs) cb(scene);
	}

	/** Make `scene` current: quality gate + state. */
	private adopt(scene: MeasurableScene, key: string): MeasurableScene | null {
		const q = scene.anchor.quality;
		const meta =
			(
				scene as {
					meta?: { depthModel?: string; gaussians?: string; seconds?: number };
				}
			).meta ?? {};
		const base: NearFieldState = {
			phase: "ready",
			quality: q,
			lowTrust: q < LOW_TRUST_QUALITY,
			splats: scene.splats.count,
			confidenceRadius: scene.confidenceRadius,
			objectPixels: scene.split.counts[PixelClass.Object] ?? 0,
			depthModel: meta.depthModel,
			gaussians: meta.gaussians,
			researchOnly: false,
			seconds: meta.seconds,
		};
		if (!(q >= ANCHOR_MIN_QUALITY)) {
			this.scene = null;
			this.sceneKey = key;
			if (this.shown) this.host.setNearField?.(null);
			this.set({
				...base,
				phase: "low-quality",
				message: `terrain anchoring too weak (quality ${q.toFixed(2)} < ${ANCHOR_MIN_QUALITY})`,
			});
			return null;
		}
		this.scene = scene;
		this.sceneKey = key;
		this.set(base);
		if (this.shown) this.host.setNearField?.(scene, this.viewOpts);
		return scene;
	}

	/** Show the current scene in the renderer (world view / step inside). */
	show(opts: NearFieldViewOpts = {}) {
		this.viewOpts = { ...this.viewOpts, ...opts };
		this.shown = true;
		if (this.scene) this.host.setNearField?.(this.scene, this.viewOpts);
	}

	/** View option change without a rebuild (Truth toggle, opacity). */
	setViewOpts(opts: NearFieldViewOpts) {
		this.viewOpts = { ...this.viewOpts, ...opts };
		if (this.shown && this.scene)
			this.host.setNearField?.(this.scene, this.viewOpts);
	}

	hide() {
		this.shown = false;
		this.host.setNearField?.(null);
	}

	/** The pose changed: drop the current scene (it no longer lines up); build() makes the new one. */
	invalidate() {
		if (!this.sceneKey) return;
		if (this.sceneKey === poseKey(this.host.pose, this.host.eye)) return;
		const wasPreview = !!this.scene?.preview;
		this.scene = null;
		this.sceneKey = "";
		if (this.shown) this.host.setNearField?.(null);
		if (this.state.phase === "ready" || this.state.phase === "low-quality")
			this.set({ phase: "idle" });
		else if (wasPreview && this.state.phase === "loading")
			this.set({ phase: "loading", message: this.progress });
	}

	/** Hover readout on Object pixels (null elsewhere, or when no current scene). */
	sampleAt(u: number, v: number): NearFieldSample | null {
		return nearFieldSampleAt(this.scene, u, v);
	}

	dispose() {
		if (this.shown) this.host.setNearField?.(null);
		this.disposed = true;
		this.listeners.clear();
		this.previewCbs.clear();
		this.sceneCache.clear();
		this.scene = null;
	}
}

/** Panel text while the preview is shown: "Terrain preview — <depth progress>". */
export function previewMessage(progress: string): string {
	return progress ? `Terrain preview — ${progress}` : "Terrain preview";
}
