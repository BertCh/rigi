// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The roll map on deck.gl over WebGL2 (the reference look): RollGpuBackend (./backend.ts) with the
// Deck, TerrainLayer, MultiDrapeLayer, WorldGizmoLayer frustums, extras and ScatterplotLayer pins
// that RollMapEngine (./roll-map.ts) drew directly before the backend split, GpuGeometrySource for
// the range maps and RangeGpu for the range → atlas hand-off.

import { COORDINATE_SYSTEM, Deck } from "@deck.gl/core";
import { ScatterplotLayer } from "@deck.gl/layers";
import type { Device } from "@luma.gl/core";
import { GpuGeometrySource } from "#/lib/deck/geometry-pass";
import { TerrainLayer } from "#/lib/deck/terrain-layer";
import {
	LogDepthExtension,
	WorldGizmoLayer,
	WorldView,
} from "#/lib/deck/world-view";
import type {
	RangeHandOff,
	RollFrame,
	RollGeometrySource,
	RollGpuBackend,
	RollPin,
} from "./backend";
import { DrapeAtlas, type DrapeItem } from "./drape-atlas";
import { MultiDrapeLayer } from "./multi-drape-layer";
import { RangeGpu } from "./range-gpu";

export type WebglBackendOptions = {
	pixelRatio: number;
	onLoad?: () => void;
};

export function createWebglBackend(
	canvas: HTMLCanvasElement,
	opts: WebglBackendOptions,
): RollGpuBackend {
	return new WebglRollBackend(canvas, opts);
}

type DeckInternals = {
	device?: Device;
	layerManager?: { updateLayers(): void };
	getViewports(): { project(p: number[]): number[] }[];
};

export class WebglRollBackend implements RollGpuBackend {
	readonly kind = "webgl" as const;
	readonly supportsExtras = true;
	/** CPU-backed mosaics: this map draws through WebGL2, where a GPU-backed bitmap's texture-array
	 * upload is a main-thread readback (loadImagery). */
	readonly cpuImageryBitmaps = true;
	readonly ready: Promise<Device>;
	/** The deck (WebGL2) for callers that read its viewports or hand it to GpuGeometrySource. */
	readonly deck: Deck;
	private rangeGpu: RangeGpu | null = null;

	constructor(canvas: HTMLCanvasElement, opts: WebglBackendOptions) {
		let onLoad: (d: Device) => void = () => {};
		this.ready = new Promise<Device>((r) => {
			onLoad = r;
		});
		this.deck = new Deck({
			canvas,
			width: null,
			height: null,
			useDevicePixels: opts.pixelRatio,
			// near 0.5 m: at a photographer's eye (≈ 2 m up) a 5 m near plane cut a hole in the ground
			// below the view; every layer writes log depth, so the ratio costs no precision
			views: [new WorldView({ id: "world", near: 0.5, far: 600_000 })],
			layers: [],
			controller: false,
			onLoad: () => {
				const device = this.internals.device;
				if (device) onLoad(device);
				opts.onLoad?.();
			},
			onError: (e: Error) => console.error("[roll-map]", e),
		} as never);
	}

	private get internals() {
		return this.deck as unknown as DeckInternals;
	}

	createAtlas(device: Device, items: DrapeItem[]) {
		return new DrapeAtlas(device, items);
	}

	createGeometrySource(
		eye: [number, number, number],
		width: number,
		height: number,
	): RollGeometrySource {
		return new GpuGeometrySource(this.deck, eye, width, height, {
			xyz: false,
		});
	}

	rangeHandOff(): RangeHandOff | null {
		const device = this.internals.device;
		if (!device) return null;
		this.rangeGpu ??= new RangeGpu(device);
		return this.rangeGpu;
	}

	render(frame: RollFrame) {
		const layers: unknown[] = [
			new TerrainLayer({
				id: "terrain",
				tiles: frame.tiles,
				imagery: frame.imagery,
				style: frame.basemap.style,
				look: frame.basemap.look,
				...(frame.elevRange && { elevRange: frame.elevRange }),
				nearFade: 0,
				projectPhoto: 0,
				offscreen: false,
			} as never),
			// null = drape off: skip its per-fragment photo loop altogether
			frame.drape &&
				new MultiDrapeLayer({
					id: "drape",
					tiles: frame.tiles,
					atlas: frame.drape.atlas,
					atlasVersion: frame.drape.atlasVersion,
					photos: frame.drape.photos,
					opacity: frame.drape.opacity,
					sharpness: frame.drape.sharpness,
					reachM: frame.drape.reachM,
					people: frame.drape.people,
					photoParams: frame.drape.clearTexture,
					paramsVersion: frame.drape.clearVersion,
					clearAir: frame.drape.clearAir,
				} as never),
		];
		for (const g of frame.gizmos)
			layers.push(
				new WorldGizmoLayer({
					id: `gizmo-${g.id}`,
					pose: g.pose,
					eye: g.eye,
					aspect: g.aspect,
					// the BitmapLayer underneath takes any image source; the prop is typed for <img>
					image: g.image as unknown as HTMLImageElement | null,
					planeOpacity: g.planeOpacity,
					lineColor: g.lineColor,
					pinColor: g.pinColor,
					pinRadiusM: g.pinRadiusM,
				}),
			);
		layers.push(...frame.extras);
		layers.push(
			new ScatterplotLayer<RollPin>({
				id: "pins",
				data: frame.pins as RollPin[],
				coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
				getPosition: (p) => p.position,
				getRadius: (p) => p.radiusPx,
				radiusUnits: "pixels",
				getFillColor: (p) => p.fill,
				getLineColor: (p) => p.line,
				lineWidthUnits: "pixels",
				getLineWidth: (p) => p.lineWidthPx,
				stroked: true,
				billboard: true,
				extensions: [new LogDepthExtension()],
				parameters: { depthCompare: "always", depthWriteEnabled: false },
			}),
		);
		this.deck.setProps({
			viewState: { world: frame.viewState },
			layers,
		} as never);
	}

	flush() {
		this.internals.layerManager?.updateLayers();
	}

	project(p: readonly [number, number, number]) {
		const vp = this.internals.getViewports()[0];
		if (!vp) return null;
		const [x, y, z] = vp.project([p[0], p[1], p[2]]);
		return [x, y, z] as [number, number, number];
	}

	setPixelRatio(ratio: number) {
		this.deck.setProps({ useDevicePixels: ratio } as never);
	}

	dispose() {
		this.deck.finalize();
		this.rangeGpu?.destroy();
		this.rangeGpu = null;
	}
}
