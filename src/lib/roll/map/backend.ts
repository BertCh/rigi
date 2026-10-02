// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The roll map's GPU backend: everything RollMapEngine (./roll-map.ts) draws or renders on the GPU,
// behind one interface, so the engine's loading, seeding, camera, picking and range-queue logic is
// shared between deck.gl on WebGL2 (./backend-webgl.ts, the reference look) and deck.gl on WebGPU
// (./backend-webgpu.ts, WGSL cores from src/lib/deck-webgpu). The engine builds a RollFrame from its
// state on every change and hands it to render(); the backend owns the device, the canvas context,
// the atlas class, the geometry sources (range maps) and the range hand-off (range map → atlas cell
// + coarse grid on the GPU).
//
// Design and open items: reports/gpu-renderer.md (roll map on WebGPU).

import type { Device, Texture } from "@luma.gl/core";
import type { Pose } from "#/lib/camera";
import type { GeometrySource } from "#/lib/deck/geometry-source";
import type { TileMesh } from "#/lib/deck/terrain-data";
import type { GpuLayerCore } from "#/lib/deck-webgpu/pass";
import type { CoarseRange, DrapeAtlas, DrapeItem } from "./drape-atlas";

export type RollBackendKind = "webgl" | "webgpu";

/** A photo's drape projection state (same fields as multi-drape-layer.ts / multi-drape.ts DrapePhoto). */
export type RollDrapePhoto = {
	id: string;
	viewProj: number[];
	eye: [number, number, number];
	minRange: number;
	gain: number;
	aspect: number;
	vfov: number;
};

export type RollGizmo = {
	id: string;
	pose: Pose;
	eye: [number, number, number];
	aspect: number;
	/** Small thumbnail on the frustum's image plane, or null for none. */
	image: ImageBitmap | null;
	planeOpacity: number;
	lineColor: [number, number, number, number];
	pinColor: [number, number, number, number];
	pinRadiusM: number;
};

/** A selection target: a disc in screen pixels at the photo's eye, always on top (no depth test). */
export type RollPin = {
	id: string;
	position: [number, number, number];
	radiusPx: number;
	fill: [number, number, number, number];
	line: [number, number, number, number];
	lineWidthPx: number;
};

/** Everything one frame draws. Arrays keep their identity while nothing in them changed. */
export type RollFrame = {
	tiles: readonly TileMesh[];
	/** Basemap imagery per tile id (empty for the shaded / plain looks). */
	imagery: ReadonlyMap<string, ImageBitmap>;
	/** basemapLook(settings.basemap) (./basemap.ts). */
	basemap: { style: string; look: unknown };
	elevRange: [number, number] | null;
	/** Null = drape off (opacity 0). */
	drape: {
		atlas: DrapeAtlas;
		atlasVersion: number;
		photos: readonly RollDrapePhoto[];
		opacity: number;
		sharpness: number;
		reachM: number;
		people: 0 | 1;
		/** DrapeClear.texture / .version (./drape-clear.ts). */
		clearTexture: Texture | null;
		clearVersion: number;
		clearAir: boolean;
	} | null;
	gizmos: readonly RollGizmo[];
	/** Deck layers added by opt-in features (RollMapEngine.setExtraLayers). A backend that cannot
	 * draw deck layers ignores them and reports it once through `supportsExtras`. */
	extras: readonly unknown[];
	pins: readonly RollPin[];
	/** WorldCamera.viewState(target) for deck's "world" view (WebGL) / the colour pass camera. */
	viewState: unknown;
};

/**
 * The GPU half of a range map's trip into the drape atlas (./range-gpu.ts on WebGL2): copy a
 * geometry source's target into an atlas range cell with rangeMapFrom's fix-up (keep 0 < r < +Inf,
 * else +0; row 0 = top) and max-pool it to the COARSE grid, with only the grid read back.
 */
export interface RangeHandOff {
	readonly device: Device;
	/** Usable now; false = callers take the CPU path (render + rangeMapFrom + setRange). */
	readonly ok: boolean;
	whenReady(): Promise<void>;
	coarse(
		src: Texture,
		w: number,
		h: number,
		cancelled: () => boolean,
	): Promise<{ grid: CoarseRange; mainMs: number; bytes: number } | null>;
	copyInto(
		dst: Texture,
		at: [number, number],
		src: Texture,
		w: number,
		h: number,
	): boolean;
	destroy(): void;
}

/** What the engine's range queue needs from a geometry source (GpuGeometrySource on WebGL2). */
export interface RollGeometrySource extends GeometrySource {
	readonly pose: Pose | null;
	/** The render target (WebGL2: GL row order, red = range; WebGPU: rgba32float, w = range). */
	readonly texture: Texture;
	readonly drawSeq: number;
	/** Draw into the target without a readback; false = not possible now (take render()). */
	drawOnly(pose: Pose): boolean;
	/** Read back the draw `seq` (still in the target) into range; false = overwritten / failed. */
	readDrawn(seq: number, pose: Pose): Promise<boolean>;
	/**
	 * The still-intact draw `seq` sampled at every `step`-th texel on the GPU (decimateRange's rule:
	 * nearest, sky / non-finite 0, row 0 = top), only that grid read back. null = overwritten or not
	 * possible: the caller takes readDrawn + decimateRange.
	 */
	readDecimated?(
		seq: number,
		pose: Pose,
		step: number,
	): Promise<{ w: number; h: number; data: Float32Array } | null>;
	readonly timing?: { copyMs?: number; unpackMs?: number } | null;
	dispose(): void;
}

export interface RollGpuBackend {
	readonly kind: RollBackendKind;
	/** Resolves with the device once it can render; rejects when the backend could not start. */
	readonly ready: Promise<Device>;
	/** False on a backend that cannot draw RollFrame.extras (deck layers). */
	readonly supportsExtras: boolean;
	/** Basemap imagery as CPU-backed bitmaps (WebGL2: a GPU-backed bitmap's texture-array upload is a
	 * main-thread readback). Absent / false = loadImagery's default. */
	readonly cpuImageryBitmaps?: boolean;
	/** The drape atlas for this device (DrapeAtlas on WebGL2, WebGpuDrapeAtlas on WebGPU). */
	createAtlas(device: Device, items: DrapeItem[]): DrapeAtlas;
	/** A geometry source over the current terrain (the last rendered frame's tiles) at `eye`. */
	createGeometrySource(
		eye: [number, number, number],
		width: number,
		height: number,
	): RollGeometrySource;
	/** The range hand-off for this device, or null where there is none (CPU path only). */
	rangeHandOff(): RangeHandOff | null;
	render(frame: RollFrame): void;
	/** Apply the last render() synchronously (deck's layerManager.updateLayers) before an offscreen pass. */
	flush(): void;
	/** A roll-frame point to canvas CSS px [x, y, depth] (depth < 1 = in front); null before the first frame. */
	project(
		p: readonly [number, number, number],
	): [number, number, number] | null;
	setPixelRatio(ratio: number): void;
	/**
	 * Optional (WebGPU): extra GpuLayerCores (e.g. the Spot 3D splats) drawn with the frame, keyed
	 * by name; null / empty removes the key. The caller owns the cores and destroys them.
	 */
	setExtraCores?(key: string, cores: readonly GpuLayerCore[] | null): void;
	/** Called when the device is lost and could not be (or is not) recovered by the backend. */
	onFatal?: (e: Error) => void;
	dispose(): void;
}
