// The engine surface PhotoWorkspace (src/components/PhotoWorkspace.tsx) and the export layer
// (src/lib/export/**) use, so the three.js PhotoEngine (src/lib/engine.ts) and the deck.gl
// DeckEngine (src/lib/deck/engine.ts) are interchangeable behind `?renderer=deck`.
//
// Exactly the members those callers use (grepped 2026-09-25), typed with the existing types.
// PhotoEngine satisfies it structurally (checked in renderer.check.ts) without edits to
// engine.ts. Tools that poke three.js internals through window.__engine (eval-app, leaderboard,
// tools/matcher/*) are NOT covered: gate them on `__engine.kind === 'deck'` (PhotoEngine has no
// `kind`; undefined means three).
//
// One widening versus PhotoEngine: autoAlign() may return a Promise (DeckEngine renders its
// silhouette hypotheses through an async GeometrySource). Callers should `await` it; awaiting
// PhotoEngine's synchronous result is harmless.

import type { AlignResult, Pin } from "./align";
import type { Pose } from "./camera";
import type { PeakLabel, Sample, Settings } from "./engine";
import type { EnuFrame } from "./geodesy";
import type { Unknowns } from "./integration/unknown-pose";
import type { NearFieldSample } from "./nearfield/measure";
import type { NearFieldScene, NearFieldViewOpts } from "./nearfield/types";
import type { PhotoMeta, RegionData, RegionTrail } from "./photos";
import type { RevealUniforms } from "./reveal/config";
import type { ViewStyle } from "./style/types";

export type { PeakLabel, Sample, Settings };

/** Person / foreground mask, row 0 = top (segment.ts ForegroundMask is structurally one). */
export type FgMask = { width: number; height: number; data: Uint8Array };

export interface Renderer {
	/** 'deck' for DeckEngine; PhotoEngine leaves it undefined (= three). */
	readonly kind?: "three" | "deck";

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
	/** How the views look (src/lib/style). Optional: PhotoEngine applies it; DeckEngine adopts it later. */
	setStyle?(s: ViewStyle): void;
	/** The photo's P(sky) (#/lib/sky segmentSky, row 0 = top), for the fitted haze. Both engines. */
	setSkyMask?(m: FgMask | null): void;
	/** Replace the region's hiking paths (loaded on demand when the trails layer is switched on). */
	setTrails?(trails: RegionTrail[]): void;
	/** One frame of the overlay reveal (src/lib/reveal); null = off (the classic composite, untouched). */
	setReveal?(r: RevealUniforms | null): void;
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
	/**
	 * autoAlign with the coarse grid on the WebGPU compute device (same result; CPU fallback).
	 * PhotoEngine only: its autoAlign() stays synchronous for tools; DeckEngine's autoAlign() does
	 * this already. Callers: `engine.autoAlignAsync?.(x) ?? engine.autoAlign(x)`.
	 */
	autoAlignAsync?(fromPrior?: boolean): Promise<AlignResult | null>;
	solvePins(pins: Pin[], from?: Pose, solveFov?: boolean): Pose;

	// ---- blend brush, world view, export ----
	paint(u: number, v: number, radius: number, erase: boolean): void;
	clearBrush(fill?: boolean): void;
	flyToPhoto(dur?: number): void;
	flyOut(): void;
	exportImage(withLabels?: boolean): Promise<Blob | null>;
}

/** Plan name (out/lead/deck-parity/features.md). */
export type PhotoRenderer = Renderer;

/** Constructor shape both backends share: `new Engine(canvas, photo)`. */
export type RendererConstructor = new (
	canvas: HTMLCanvasElement,
	photo: PhotoMeta,
) => Renderer;
