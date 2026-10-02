// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The engine surface PhotoWorkspace (src/components/PhotoWorkspace.tsx) and the export layer
// (src/lib/export/**) use, so the deck.gl WebGpuEngine (src/lib/deck-webgpu/engine.ts, the default
// where WebGPU is available) and the WebGL DeckEngine (src/lib/deck/engine.ts, the fallback and
// ?renderer=deck) are interchangeable behind `?renderer=` (src/lib/renderer-select.ts). WebGpuEngine
// reports backend 'webgpu'.
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
import type { NearFieldScene, NearFieldViewOpts } from "./nearfield/types";
import type { ByteMask } from "./ontology/core/geometry";
import type { PhotoMeta, RegionData, RegionTrail } from "./photos";
import type { RevealUniforms } from "./reveal/config";
import type { PeakLabel, Sample, Settings } from "./settings";
import type { ViewStyle } from "./style/types";

export type { PeakLabel, Sample, Settings };

/** Person / foreground mask, row 0 = top (segment.ts ForegroundMask is structurally one). */
/** Foreground (person) mask over the photo. */
export type FgMask = ByteMask;

export interface Renderer {
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
	/** demAtCamera is a DEM height (false: the no-DEM fallback, photo.alt ?? 0). */
	readonly demKnown: boolean;
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
	setStyle(s: ViewStyle): void;
	/** The photo's P(sky) (#/lib/sky segmentSky, row 0 = top), for the fitted haze. Both engines. */
	setSkyMask(m: FgMask | null): void;
	/** Step Inside 3D Tiles (src/lib/tiles3d, ?tiles3d=): the on-screen credit line while stepping, or null. */
	tiles3dAttribution(): string | null;
	/**
	 * Terroir land cover (src/lib/terroir, reports/terroir-cartography.md): the pack's class grid for
	 * style.terroir.cover / contours.inkByCover; null = off (bit-identical to before). Display-only.
	 */
	setTerroirCover(grid: import("./terroir/pack").CoverGrid | null): void;
	/** Replace the region's hiking paths (loaded on demand when the trails layer is switched on). */
	setTrails(trails: RegionTrail[]): void;
	/** One frame of the overlay reveal (src/lib/reveal); null = off (the classic composite, untouched). */
	setReveal(r: RevealUniforms | null): void;
	/**
	 * style.labels.glow (look/labels/glow.ts, luma pointGlow): additive glowing sprites at the labelled
	 * summits, drawn after the composite in the photo view; null = off (the render is untouched).
	 * Display-only: never in exports.
	 */
	setGlowMarkers(m: import("./look/labels/glow").GlowMarkers | null): void;
	/**
	 * concord DSM occluder (?concord=occl, src/lib/concord/occl): photo-space dim mask, row 0 = top,
	 * 255 = dim the overlay there; null = off (bit-identical composite). Display-only.
	 */
	setOccluder(m: FgMask | null): void;
	/**
	 * concord label hook (?concord=occl,labels; src/lib/concord/occl/hooks.ts occludedLabels): ids of peak
	 * labels whose anchor sits behind a DSM object; the label renderer should hide or dim them. null = none
	 * (bit-identical). Optional: no engine implements it yet (consumer wiring owed). Display-only.
	 */
	setOccludedLabels?(ids: string[] | null): void;
	/**
	 * concord drape hook (?concord=occl,drape; hooks.ts drapeMaskFromOccluder): photo-space mask, row 0 =
	 * top, 255 = the photo pixel shows a DSM object in front of the terrain, so the drape must not project
	 * it onto the terrain; null = off (bit-identical). Optional: no engine implements it yet. Display-only.
	 */
	setDrapeMask?(m: FgMask | null): void;
	/**
	 * Step Inside (src/lib/nearfield): show a near-field scene (null = remove). Splats draw in the world
	 * view / step-inside camera (deck: also the photo view); the world drape skips the scene's Object pixels.
	 */
	setNearField(scene: NearFieldScene | null, opts?: NearFieldViewOpts): void;

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
	skyline(): Float32Array | null;
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

	// ---- offscreen pose renders (src/lib/matcher context, the precision gate; not the workspace) ----
	// Both engines implement them (renderer.check.ts).
	/**
	 * The terrain all around the eye: 360° high-detail streaming (kept), the CPU queries on the complete
	 * set, the horizon re-traced over 360°. Resolves with the ms it took (0 when already done).
	 */
	loadFullTerrain(timeoutMs?: number): Promise<number>;
	/** Satellite imagery for the render set's tiles within `maxDistM` of the eye (0 = all), fetched now. */
	loadSatellite(
		maxDistM?: number,
		retries?: number,
	): Promise<{ tiles: number; missing: number; retries: number }>;
	/**
	 * The matcher's view through `pose`, offscreen at width × height (default 1024 px on the long side):
	 * xyz = ENU metres in `frame` (3 per pixel, row 0 = top, 0,0,0 = sky); rgba = sRGB 8-bit, opaque,
	 * the terrain colour pass alone in the Blend-satellite look over sky #b9cde0. The engine's pose and
	 * the on-screen view are unchanged.
	 */
	renderPoseView(
		pose: Pose,
		opts?: { width?: number; height?: number },
	): Promise<PoseView | null>;
	/**
	 * The in-browser matcher's skyline evidence (src/lib/matcher, formerly the render worker's skyline
	 * export): copies of the photo's edge planes and the DEM horizon directions. With `alignFrom`,
	 * autoAlign(true) runs from that pose first and its result is returned as `align`; the engine's
	 * prior and pose are untouched (the edge map's sky model is refit, as any autoAlign does).
	 * null before the horizon and edge map exist.
	 */
	matchEvidence(alignFrom?: Pose): Promise<MatchEvidence | null>;
}

/** Renderer.matchEvidence's output: edge planes at w × h (row 0 = top) and horizonDirs (N × 3). */
export type MatchEvidence = {
	w: number;
	h: number;
	horizon: Float32Array;
	fine: Float32Array;
	coarse: Float32Array;
	fg: Float32Array;
	/** P(sky) after the (optional) autoAlign's refit */
	sky: Float32Array;
	/** edge-map RGBA */
	rgb: Uint8ClampedArray;
	align: AlignResult | null;
};

/** renderPoseView's output (see Renderer.renderPoseView). */
export type PoseView = {
	width: number;
	height: number;
	xyz: Float32Array;
	rgba: Uint8ClampedArray;
};

/** Constructor shape the backends share: `new Engine(canvas, photo)`. */
export type RendererConstructor = new (
	canvas: HTMLCanvasElement,
	photo: PhotoMeta,
) => Renderer;
