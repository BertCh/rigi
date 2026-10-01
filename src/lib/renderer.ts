// The engine surface PhotoWorkspace (src/components/PhotoWorkspace.tsx) and the export layer
// (src/lib/export/**) use, so the deck.gl WebGpuEngine (src/lib/deck-webgpu/engine.ts, the default
// where WebGPU is available) and the WebGL DeckEngine (src/lib/deck/engine.ts, the fallback and
// ?renderer=deck) are interchangeable behind `?renderer=` (src/lib/renderer-select.ts). WebGpuEngine
// reports kind 'deck' with backend 'webgpu'. (The three.js PhotoEngine, src/lib/engine.ts, was removed
// on 2026-10-01; ?renderer=three now falls back to the default with a console warning.)
//
// Exactly the members those callers use (grepped 2026-09-25), typed with the existing types; the
// engines satisfy it structurally (checked in renderer.check.ts). Tools that poke engine internals
// through window.__engine (style-baseline's geoSrc, gpu/look/capture.ts, …) are NOT covered: WebGL-deck
// internals (deckInstance.layerManager, compositor) must also check `__engine.backend !== 'webgpu'`.
//
// autoAlign() may return a Promise (the deck engines render their silhouette hypotheses through an
// async GeometrySource): callers `await` it.

import type { AlignResult, Pin } from "./align";
import type { Pose } from "./camera";
import type { EnuFrame } from "./geodesy";
import type { Unknowns } from "./integration/unknown-pose";
import type { NearFieldSample } from "./nearfield/measure";
import type { NearFieldScene, NearFieldViewOpts } from "./nearfield/types";
import type { PhotoMeta, RegionData, RegionTrail } from "./photos";
import type { RevealUniforms } from "./reveal/config";
import type { PeakLabel, Sample, Settings } from "./settings";
import type { ViewStyle } from "./style/types";

export type { PeakLabel, Sample, Settings };

/** Person / foreground mask, row 0 = top (segment.ts ForegroundMask is structurally one). */
export type FgMask = { width: number; height: number; data: Uint8Array };

export interface Renderer {
	/** 'deck' for both engines (WebGpuEngine adds backend 'webgpu'). */
	readonly kind?: "deck";

	// ---- identity & camera (PW, export) ----
	readonly photo: PhotoMeta;
	readonly aspect: number;
	readonly prior: Pose;
	readonly unknowns: Unknowns;
	readonly pose: Pose;
	readonly settings: Settings;
	/** Camera-anchored ENU frame at the photo's lat/lon (export: frame.lat/lon/h, toGeo). */
	readonly frame: EnuFrame;
	/** Camera position in `frame`, metres. */
	readonly eye: { readonly x: number; readonly y: number; readonly z: number };
	readonly eyeAlt: number;
	readonly demAtCamera: number;
	/** Set once terrain exists; exports only test it for truthiness (engine-export.ts engineReady). */
	readonly terrain?: unknown;
	readonly photoElement: HTMLImageElement | undefined;
	readonly hasPeople: boolean;
	readonly isFlying: boolean;

	// ---- lifecycle ----
	init(
		region: RegionData | null | Promise<RegionData | null>,
		onProgress?: (msg: string, frac: number) => void,
		segment?: (img: HTMLImageElement) => Promise<FgMask | null>,
	): Promise<void>;
	dispose(): void;
	resize(w: number, h: number): void;
	/** Called after every rendered frame (and whenever labels / queries change). Returns an unsubscribe. */
	onRender(cb: () => void): () => void;

	// ---- state ----
	setPose(p: Pose): void;
	setSettings(s: Partial<Settings>): void;
	/** How the views look (src/lib/style). Both engines implement it; optional for other Renderer shapes. */
	setStyle?(s: ViewStyle): void;
	/** The photo's P(sky) (#/lib/sky segmentSky, row 0 = top), for the fitted haze. Both engines. */
	setSkyMask?(m: FgMask | null): void;
	/** Step Inside 3D Tiles (src/lib/tiles3d, ?tiles3d=): the on-screen credit line while stepping, or null. */
	tiles3dAttribution?(): string | null;
	/**
	 * Terroir land cover (src/lib/terroir, reports/terroir-cartography.md): the pack's class grid for
	 * style.terroir.cover / contours.inkByCover; null = off (bit-identical to before). Display-only.
	 */
	setTerroirCover?(grid: import("./terroir/pack").CoverGrid | null): void;
	/** Replace the region's hiking paths (loaded on demand when the trails layer is switched on). */
	setTrails?(trails: RegionTrail[]): void;
	/** One frame of the overlay reveal (src/lib/reveal); null = off (the classic composite, untouched). */
	setReveal?(r: RevealUniforms | null): void;
	/**
	 * concord DSM occluder (?concord=occl, src/lib/concord/occl): photo-space dim mask, row 0 = top,
	 * 255 = dim the overlay there; null = off (bit-identical composite). Display-only.
	 */
	setOccluder?(m: FgMask | null): void;
	/**
	 * Step Inside (src/lib/nearfield): show a near-field scene (null = remove). Splats draw in the world
	 * view / step-inside camera (deck: also the photo view); the world drape skips the scene's Object pixels.
	 */
	setNearField?(scene: NearFieldScene | null, opts?: NearFieldViewOpts): void;
	/** Near-field object under normalised photo coords (Object pixels of the shown scene), else null. */
	nearFieldSampleAt?(u: number, v: number): NearFieldSample | null;

	// ---- queries ----
	/** Resolves true once sampleAt / peakLabels describe the current pose (false if disposed first). */
	readback(): Promise<boolean>;
	geometryReady(): boolean;
	/** Terrain under normalised photo coords (u right, v down), null for sky / no data. */
	sampleAt(u: number, v: number): Sample | null;
	/**
	 * sampleAt that does not need the full CPU copy of the geometry (WebGPU: one gathered texel, cached
	 * per render). Same answer as sampleAt; hover and other point queries prefer it when present.
	 */
	sampleAtAsync?(u: number, v: number): Promise<Sample | null>;
	/**
	 * Like readback(), resolving once peakLabels / skyline / sampleAtAsync describe the current pose,
	 * without forcing the full CPU copy sampleAt needs (WebGPU geometry diet).
	 */
	settle?(): Promise<boolean>;
	isForeground(u: number, v: number): boolean;
	/** Ranked visible peaks; `declutter: false` skips the classic declutter (panorama / inline layouts). */
	peakLabels(max?: number, opts?: { declutter?: boolean }): PeakLabel[];
	/** Per-column skyline of the fresh geometry buffer (fraction of the height from the top), else null. */
	skyline?(): Float32Array | null;
	peaksInFrame(): PeakLabel[];

	// ---- alignment ----
	autoAlign(
		fromPrior?: boolean,
	): AlignResult | null | Promise<AlignResult | null>;
	solvePins(pins: Pin[], from?: Pose, solveFov?: boolean): Pose;

	// ---- blend brush, world view, export ----
	paint(u: number, v: number, radius: number, erase: boolean): void;
	clearBrush(fill?: boolean): void;
	flyToPhoto(dur?: number): void;
	flyOut(): void;
	exportImage(withLabels?: boolean): Promise<Blob | null>;
}

/** Constructor shape the backends share: `new Engine(canvas, photo)`. */
export type RendererConstructor = new (
	canvas: HTMLCanvasElement,
	photo: PhotoMeta,
) => Renderer;
