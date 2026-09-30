// Step Inside orchestration for one photo in the workspace (reports/step-inside-design.md).
//
//   available()  → the optional near-field service is up (nearField.available(); never throws)
//   build()      → /depth (moge2) + /gaussians (lift; 'sharp' only behind ?nearfield=sharp, research-only)
//                  for the photo (cached per photo), the renderer's DEM range grid for the current pose
//                  (after readback()), the engine's sky / people masks when it has them
//                  → buildNearFieldScene (public signature only) → the measure grid → cached per photo+pose
//   show()/hide() → renderer.setNearField(scene | null, opts)
// Gate: only for an accepted pose (poseAccepted); the scene is hidden when anchor.quality <
// ANCHOR_MIN_QUALITY and flagged 'low trust' below LOW_TRUST_QUALITY.
import { getFlag } from "#/lib/flags";
import type { Pose } from "../camera";
import type { EnuFrame } from "../geodesy";
import type { PhotoMeta } from "../photos";
import {
	nearField as defaultClient,
	type GaussianModel,
	type NearFieldClient,
} from "./client";
import { type MaskLike, sampleDemGrid } from "./geom";
import {
	buildMeasureGrid,
	type MeasurableScene,
	type NearFieldSample,
	nearFieldSampleAt,
} from "./measure";
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
 * Below this anchor quality the scene is shown with a 'low trust' badge. The design gate
 * (ANCHOR_MIN_QUALITY) hides it outright; the badge band sits above it (0.35, or 0.15 over the gate
 * when the gate is raised to 0.35 or more, so the band never collapses).
 */
export const LOW_TRUST_QUALITY = Math.max(0.35, ANCHOR_MIN_QUALITY + 0.15);

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

/** The renderer members the controller reads (PhotoEngine satisfies it; DeckEngine too once it has setNearField). */
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
	/** True when the research-only SHARP weights produced the splats. */
	researchOnly?: boolean;
	seconds?: number;
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

export function poseKey(p: Pose, eye: { x: number; y: number; z: number }) {
	const f = (x: number) => x.toFixed(4);
	return `${f(p.yaw)}|${f(p.pitch)}|${f(p.roll)}|${f(p.vfov)}|${eye.x.toFixed(2)},${eye.y.toFixed(2)},${eye.z.toFixed(2)}`;
}

/** Dev flag: ?nearfield=sharp uses Apple SHARP (research-only weights) for the splats. */
export function gaussianModelFromUrl(): GaussianModel {
	return getFlag("nearfield") === "sharp" ? "sharp" : "lift";
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
	readonly client: NearFieldClient;
	readonly gaussianModel: GaussianModel;
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

	constructor(
		host: NearFieldHost,
		photo: PhotoMeta,
		opts: { client?: NearFieldClient; gaussianModel?: GaussianModel } = {},
	) {
		this.host = host;
		this.photo = photo;
		this.client = opts.client ?? defaultClient;
		this.gaussianModel = opts.gaussianModel ?? gaussianModelFromUrl();
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

	/** Service health (cached by the client). Never throws. */
	async available(force = false): Promise<boolean> {
		if (!this.supported) return false;
		const ok = await this.client.available(force);
		if (!ok && this.state.phase !== "loading")
			this.set({
				phase: "unavailable",
				message: "near-field service is not running",
			});
		else if (ok && this.state.phase === "unavailable")
			this.set({ phase: "idle" });
		return ok;
	}

	/** True when a scene for the current pose is cached (show() is instant, no service call). */
	hasSceneForPose(): boolean {
		return this.sceneCache.has(poseKey(this.host.pose, this.host.eye));
	}

	/** True when the slow service results for this photo are cached (a pose change rebuilds locally). */
	hasPhotoData(): boolean {
		return PHOTO_CACHE.has(this.photoKey());
	}

	private photoKey() {
		return `${this.photo.id}|${this.photo.src}|${this.gaussianModel}`;
	}

	private fetchPhotoData(signal?: AbortSignal): Promise<PhotoData | null> {
		const key = this.photoKey();
		let p = PHOTO_CACHE.get(key);
		if (!p) {
			p = (async () => {
				const blob = await photoBlob(this.photo, this.host.photoElement);
				if (!blob) return null;
				// sequential: the service serialises inference anyway, and /gaussians lift reuses the cached depth
				const depth = await this.client.depth(blob, { model: "moge2", signal });
				if (!depth) return null;
				const g = await this.client.gaussiansWithMeta(blob, {
					model: this.gaussianModel,
					signal,
				});
				return {
					depth,
					cloud: g?.cloud ?? null,
					cloudK: g?.meta.intrinsicsNorm ?? null,
					gaussians: g
						? `${this.gaussianModel}${this.gaussianModel === "sharp" ? " (research-only)" : ""}`
						: "client depth-lift",
				};
			})();
			PHOTO_CACHE.set(key, p);
			while (PHOTO_CACHE.size > PHOTO_CACHE_MAX) {
				const first = PHOTO_CACHE.keys().next().value;
				if (first === undefined) break;
				PHOTO_CACHE.delete(first);
			}
			// failures are not cached
			p.then((d) => {
				if (!d && PHOTO_CACHE.get(key) === p) PHOTO_CACHE.delete(key);
			}).catch(() => PHOTO_CACHE.delete(key));
		}
		return p;
	}

	/**
	 * Build (or reuse) the scene for the current pose. The caller checks poseAccepted() first. Resolves
	 * null on failure / low quality (see `state`). Never throws.
	 */
	async build(signal?: AbortSignal): Promise<MeasurableScene | null> {
		const key0 = poseKey(this.host.pose, this.host.eye);
		const hit = this.sceneCache.get(key0);
		if (hit) return this.adopt(hit, key0);
		if (this.building && this.buildingKey === key0) return this.building;
		this.buildingKey = key0;
		const run = (async (): Promise<MeasurableScene | null> => {
			if (!(await this.available())) return null;
			const t0 = performance.now();
			this.set({
				phase: "loading",
				message: this.hasPhotoData()
					? "Rebuilding for this pose"
					: "Estimating depth (MoGe-2)",
			});
			try {
				const data = await this.fetchPhotoData(signal);
				if (signal?.aborted || this.disposed) return null;
				if (!data) {
					this.set({ phase: "error", message: "near-field service failed" });
					return null;
				}
				this.set({ phase: "loading", message: "Anchoring to the terrain" });
				await this.host.prepareNearFieldDem?.();
				// the DEM grid must describe the pose we key on: wait for a fresh geometry buffer
				if (!(await this.host.readback()) || this.disposed) return null;
				const key = poseKey(this.host.pose, this.host.eye);
				if (!this.host.geometryReady()) return null;
				const { depth } = data;
				const demAt =
					this.host.nearFieldDemRange?.(depth.width, depth.height) ??
					((u: number, v: number) => this.host.sampleAt(u, v)?.range ?? null);
				const demGrid = sampleDemGrid(depth.width, depth.height, demAt);
				const img = this.host.photoElement;
				const photo = !data.cloud && img ? imageToRGBA(img, 1024) : null;
				const scene = buildNearFieldScene({
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
				}) as MeasurableScene;
				const ctx = {
					pose: { ...this.host.pose },
					aspect: this.host.aspect,
					eye: { x: this.host.eye.x, y: this.host.eye.y, z: this.host.eye.z },
					frame: this.host.frame,
				};
				scene.measure = { ...buildMeasureGrid(scene, ctx), ...ctx };
				// the export's licence line: SHARP splats, or a depth-lift of the depth model
				scene.model = data.gaussians.startsWith("sharp")
					? "sharp"
					: `${depth.model}-lift`;
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
				if (key !== poseKey(this.host.pose, this.host.eye)) return null;
				return this.adopt(scene, key);
			} catch (e) {
				console.warn("[nearfield] build failed", e);
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
		});
		return run;
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
			researchOnly:
				this.gaussianModel === "sharp" && !!meta.gaussians?.startsWith("sharp"),
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
		this.scene = null;
		this.sceneKey = "";
		if (this.shown) this.host.setNearField?.(null);
		if (this.state.phase === "ready" || this.state.phase === "low-quality")
			this.set({ phase: "idle" });
	}

	/** Hover readout on Object pixels (null elsewhere, or when no current scene). */
	sampleAt(u: number, v: number): NearFieldSample | null {
		return nearFieldSampleAt(this.scene, u, v);
	}

	dispose() {
		if (this.shown) this.host.setNearField?.(null);
		this.disposed = true;
		this.listeners.clear();
		this.sceneCache.clear();
		this.scene = null;
	}
}
