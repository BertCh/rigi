// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The roll map's GPU backend on WebGPU, WITHOUT deck: a luma-direct host (deck-webgpu/hosts/direct.ts)
// drawing the WGSL cores of src/lib/deck-webgpu into a canvas whose colour pass camera is the world
// orbit camera (frame.view "world"; the host's `photo` camera is the same camera and no core draws
// in the geometry pass, so that pass only clears). Plan: reports/roll-map-webgpu-plan-2026-10-02.md.
//
//   terrain      BatchedTerrainCore + ImageryArray + TerrainStyles (basemap style / look, elevRange,
//                no near fade, no photo projection), colour pass only here; the same core is the
//                geometry source's terrain for the range maps (its geometry pass runs off-frame)
//   drape        MultiDrapeCore over a WebGpuDrapeAtlas (clear air texture + exposure)
//   gizmos       one GizmoCore per RollGizmo, keyed by id
//   pins         PinCore, drawn last
//   present      AlphaPresentCore: colour target -> canvas, alpha kept (the CSS sky shows behind)
//
// extras: RollFrame.extras (deck layers: terroir names, halos, prior fans) are drawn by a deck on the
// SAME device (./webgpu-deck-overlay.ts), created when the first extras arrive, painted right after
// the host's frame has been presented (OverlayCore, a screen-pass core that defers the deck pass to
// a microtask after the host's submit). Frame order: terrain, drape, gizmos, extra cores (setExtraCores:
// the Spot 3D splats; the caller owns and destroys them), pins, present, THEN the deck extras, so on
// WebGPU deck extras sit over the pins (WebGL: pins last). Extras layers must use depthCompare
// "always" (no LogDepthExtension: GLSL only).
// Host creation (createHost), the per-frame camera (applyView) and the core list (syncCores) are
// small isolated functions.
//
// Not done here: a full rebuild after a device loss (onFatal is called; the engine / component
// falls back or recreates the backend), atlas version polling (the engine calls render() when its
// atlasVersion moves, as it does for the WebGL layer).
import type { Device } from "@luma.gl/core";
import type { Pose } from "#/lib/camera";
import type { WorldViewState } from "#/lib/deck/world-view";
import type { DeckTerrainStyle } from "#/lib/style/deck-apply";
import { releaseForCompute } from "../../deck-webgpu/device";
import { DirectHost } from "../../deck-webgpu/hosts/direct";
import type { CameraPose } from "../../deck-webgpu/hosts/passes";
import { ImageryArray } from "../../deck-webgpu/imagery";
import {
	type BatchedTerrainCore,
	createBatchedTerrain,
} from "../../deck-webgpu/layers/batched-terrain";
import { WebGpuGeometrySource } from "../../deck-webgpu/layers/geometry-source";
import {
	createGizmoCore,
	type GizmoCore,
} from "../../deck-webgpu/layers/gizmo";
import {
	createMultiDrape,
	type MultiDrapeCore,
	WebGpuDrapeAtlas,
} from "../../deck-webgpu/layers/multi-drape";
import { createPins, type PinCore } from "../../deck-webgpu/layers/pins";
import {
	createTerrainStyles,
	type TerrainStyles,
	terrainStyleName,
} from "../../deck-webgpu/layers/terrain-styles";
import type {
	GpuLayerCore,
	PassContext,
	PassKind,
	PrepassContext,
} from "../../deck-webgpu/pass";
import { adoptedRenderDevice } from "../../gpu/device";
import { readClearRangeGrid } from "../../gpu/roll/clear-range";
import type {
	RangeHandOff,
	RollBackendKind,
	RollFrame,
	RollGeometrySource,
	RollGpuBackend,
} from "./backend";
import {
	diffIds,
	gizmoProps,
	projectRollPoint,
	rollViewPose,
} from "./backend-webgpu-math";
import type { DrapeAtlas, DrapeItem } from "./drape-atlas";
import { RangeGpuWebGpu } from "./range-webgpu";
import { DeckExtrasOverlay } from "./webgpu-deck-overlay";
import { AlphaPresentCore } from "./webgpu-present";

const INITIAL_VIEW: CameraPose = {
	eye: [0, 0, 0],
	forward: [0, 1, 0],
	up: [0, 0, 1],
	vfov: 55,
	near: 0.5,
};

/** The host: luma-direct, no deck. A deck overlay host (extras) would replace this function. */
function createHost(canvas: HTMLCanvasElement, pixelRatio: number) {
	return DirectHost.create(canvas, INITIAL_VIEW, pixelRatio);
}

/** Draws `inner` in the colour pass only (the terrain core's geometry pass belongs to range maps). */
class ColorOnly implements GpuLayerCore {
	readonly passes: readonly PassKind[] = ["color"];
	constructor(private inner: GpuLayerCore) {}
	get id() {
		return this.inner.id;
	}
	get order() {
		return this.inner.order;
	}
	draw(ctx: PassContext) {
		this.inner.draw(ctx);
	}
	prepass(ctx: PrepassContext) {
		this.inner.prepass?.(ctx);
	}
	visible() {
		return this.inner.visible?.() ?? true;
	}
	destroy() {
		// the terrain core is destroyed by the backend, once
	}
}

/**
 * Screen-pass core after the present pass: schedules the deck overlay's pass for right after this
 * frame's submit (a render pass cannot nest inside the host's open screen pass).
 */
class OverlayCore implements GpuLayerCore {
	readonly passes: readonly PassKind[] = ["screen"];
	readonly order = 1000;
	readonly id = "roll-extras-overlay";
	constructor(private overlay: DeckExtrasOverlay) {}
	visible() {
		return this.overlay.active;
	}
	draw(ctx: PassContext) {
		if (ctx.kind !== "screen") return;
		queueMicrotask(() => this.overlay.draw());
	}
	destroy() {
		// owned by the backend
	}
}

/** WebGpuGeometrySource as the engine's range queue wants it (RollGeometrySource). */
class RollGeometryAdapter implements RollGeometrySource {
	constructor(
		private src: WebGpuGeometrySource,
		private onDispose: () => void,
	) {}
	get width() {
		return this.src.width;
	}
	get height() {
		return this.src.height;
	}
	get range() {
		return this.src.range;
	}
	get pose(): Pose | null {
		return this.src.pose;
	}
	/** rgba32float, xyz = ENU metres, w = range from the eye (0 = sky), rows top-first. */
	get texture() {
		return this.src.targets.geometry;
	}
	get drawSeq() {
		return this.src.renderSeq;
	}
	get timing() {
		const t = this.src.timing;
		return t ? { copyMs: t.readbackMs, unpackMs: t.unpackMs } : null;
	}
	render(pose: Pose) {
		return this.src.render(pose);
	}
	drawOnly(pose: Pose) {
		return this.src.drawOnly(pose);
	}
	readDrawn(seq: number, pose: Pose) {
		return this.src.readDrawn(seq, pose);
	}
	async readDecimated(seq: number, _pose: Pose, step: number) {
		// drawOnly() bumps renderSeq per draw, so the target holds draw `seq` exactly while they match;
		// the read is queued now, ahead of any later draw
		if (this.src.renderSeq !== seq) return null;
		return readClearRangeGrid(this.src.gpuDevice, this.texture, step);
	}
	dispose() {
		this.onDispose();
		this.src.dispose();
	}
}

type Gpu = {
	host: DirectHost;
	device: Device;
	imagery: ImageryArray;
	terrain: BatchedTerrainCore;
	terrainColor: ColorOnly;
	styles: TerrainStyles;
	drape: MultiDrapeCore;
	pins: PinCore;
	present: AlphaPresentCore;
};

class WebgpuBackend implements RollGpuBackend {
	readonly kind: RollBackendKind = "webgpu";
	readonly supportsExtras = true;
	readonly ready: Promise<Device>;
	onFatal?: (e: Error) => void;

	private gpu: Gpu | null = null;
	private disposed = false;
	private pixelRatio: number;
	private frame: RollFrame | null = null;
	private view: CameraPose | null = null;
	private gizmos = new Map<
		string,
		{ core: GizmoCore; image: ImageBitmap | null }
	>();
	private extras = new Map<string, readonly GpuLayerCore[]>();
	/** The deck extras overlay; created with the first non-empty RollFrame.extras. */
	private overlay: DeckExtrasOverlay | null = null;
	private overlayCore: OverlayCore | null = null;
	private sources = new Set<RollGeometryAdapter>();
	private handOff: RangeHandOff | null = null;
	// what the cores were last given (identity keys: arrays keep identity while unchanged)
	private tilesKey: unknown = null;
	private imageryKey: {
		tiles: unknown;
		map: unknown;
		size: number;
		on: boolean;
	} | null = null;
	private lookKey: { look: unknown; style: string; elev: unknown } | null =
		null;
	private partsApplied = false;

	constructor(
		private canvas: HTMLCanvasElement,
		opts: { pixelRatio: number },
	) {
		this.pixelRatio = opts.pixelRatio;
		this.ready = this.boot();
		this.ready.catch(() => {}); // callers handle it; this only avoids an unhandled rejection
	}

	private async boot(): Promise<Device> {
		const host = await createHost(this.canvas, this.pixelRatio);
		if (this.disposed) {
			host.destroy();
			throw new Error("roll map backend disposed before its device was ready");
		}
		const made: { destroy(): void }[] = [];
		const make = <T extends { destroy(): void }>(c: T): T => {
			made.push(c);
			return c;
		};
		try {
			const device = host.device;
			this.setContextRatio(host, this.pixelRatio);
			host.frameView = "world";
			const imagery = make(new ImageryArray(device));
			const terrain = make(createBatchedTerrain(device, imagery));
			const styles = make(createTerrainStyles(device));
			const drape = make(createMultiDrape(device));
			const pins = make(createPins(device));
			pins.setPixelRatio(this.pixelRatio);
			const present = make(new AlphaPresentCore());
			imagery.onChange = () => {
				terrain.syncImageryLayers();
				host.requestRender("color");
			};
			device.lost.then((info) => {
				if (this.disposed || info?.reason === "destroyed") return;
				this.onFatal?.(new Error(`WebGPU device lost: ${info?.message ?? ""}`));
			});
			this.gpu = {
				host,
				device,
				imagery,
				terrain,
				terrainColor: new ColorOnly(terrain),
				styles,
				drape,
				pins,
				present,
			};
			this.syncCores();
			if (this.frame) this.apply(this.frame);
			return device;
		} catch (e) {
			this.gpu = null;
			host.cores = [];
			for (const c of made.reverse())
				try {
					c.destroy();
				} catch {}
			try {
				host.destroy();
			} catch {}
			// only if compute still points at this device: another live embed may own it now
			if (adoptedRenderDevice() === host.device) releaseForCompute();
			throw e;
		}
	}

	private setContextRatio(host: DirectHost, ratio: number) {
		try {
			host.device
				.getDefaultCanvasContext()
				.setProps({ useDevicePixels: ratio } as never);
		} catch {}
	}

	/** host.cores = the terrain, drape, gizmos, extras, pins and the present pass. */
	private syncCores() {
		const g = this.gpu;
		if (!g) return;
		g.host.cores = [
			g.terrainColor,
			g.drape,
			...[...this.gizmos.values()].map((x) => x.core),
			...[...this.extras.values()].flat(),
			g.pins,
			g.present,
			...(this.overlayCore ? [this.overlayCore] : []),
		];
	}

	/** The colour pass camera (the host's view and, as it has no photo, its photo camera). */
	private applyView(g: Gpu, viewState: unknown) {
		const pose = rollViewPose(viewState as WorldViewState);
		g.host.view = pose;
		g.host.photo = pose;
		g.host.frameView = "world";
		this.view = pose;
	}

	createAtlas(device: Device, items: DrapeItem[]): DrapeAtlas {
		return new WebGpuDrapeAtlas(device, items);
	}

	createGeometrySource(
		eye: [number, number, number],
		width: number,
		height: number,
	): RollGeometrySource {
		const g = this.gpu;
		if (!g) throw new Error("roll map backend is not ready");
		const src = new WebGpuGeometrySource(
			{ device: g.device, cores: () => [g.terrain], eye },
			width,
			height,
			{ xyz: false },
		);
		const a: RollGeometryAdapter = new RollGeometryAdapter(src, () =>
			this.sources.delete(a),
		);
		this.sources.add(a);
		return a;
	}

	rangeHandOff(): RangeHandOff | null {
		const g = this.gpu;
		if (!g) return null;
		this.handOff ??= new RangeGpuWebGpu(g.device);
		return this.handOff;
	}

	/** Extra GpuLayerCores (e.g. the Spot 3D splats) drawn between the gizmos and the pins. The
	 * caller owns them (the backend never destroys them). null / empty removes the key. */
	setExtraCores(key: string, cores: readonly GpuLayerCore[] | null) {
		if (cores?.length) this.extras.set(key, cores);
		else this.extras.delete(key);
		this.syncCores();
		this.gpu?.host.requestRender("color");
	}

	render(frame: RollFrame) {
		this.frame = frame;
		if (this.disposed || !this.gpu) return;
		this.apply(frame);
	}

	private apply(frame: RollFrame) {
		const g = this.gpu;
		if (!g) return;
		this.applyView(g, frame.viewState);

		// terrain: style + look, tiles, imagery
		const basemap = frame.basemap as { style: string; look: DeckTerrainStyle };
		const style = terrainStyleName(basemap.style);
		const changed = g.styles.set({
			style,
			look: basemap.look,
			contourInterval: 50,
			contourOpacity: 1,
			nearFade: 0,
			nearDiscard: 0,
		});
		if (changed || !this.partsApplied) {
			g.styles.applyTo(g.terrain);
			this.partsApplied = true;
		}
		const lk = this.lookKey;
		if (
			!lk ||
			lk.look !== basemap.look ||
			lk.style !== style ||
			lk.elev !== frame.elevRange
		) {
			g.terrain.look = g.styles.terrainLook(frame.elevRange ?? [400, 4200]);
			this.lookKey = { look: basemap.look, style, elev: frame.elevRange };
		}
		if (frame.tiles !== this.tilesKey) {
			this.tilesKey = frame.tiles;
			g.terrain.setTiles(frame.tiles);
			g.drape.setTiles(frame.tiles);
		}
		const wantImagery = style === "imagery";
		const ik = this.imageryKey;
		if (
			!ik ||
			ik.tiles !== frame.tiles ||
			ik.map !== frame.imagery ||
			ik.size !== frame.imagery.size ||
			ik.on !== wantImagery
		) {
			this.imageryKey = {
				tiles: frame.tiles,
				map: frame.imagery,
				size: frame.imagery.size,
				on: wantImagery,
			};
			if (wantImagery) {
				g.imagery.sync(
					frame.imagery,
					frame.tiles.map((t) => ({ id: t.id, distance: t.distance })),
				);
				g.terrain.syncImageryLayers();
			} else g.imagery.releaseWhenIdle();
		}

		// drape
		const d = frame.drape;
		if (d) {
			g.drape.setAtlas(d.atlas);
			g.drape.setPhotos(d.photos);
			g.drape.setSettings({
				opacity: d.opacity,
				sharpness: d.sharpness,
				reachM: d.reachM,
				people: d.people,
			});
			g.drape.setClearAir(d.clearTexture, d.clearAir);
		} else g.drape.setSettings({ opacity: 0 });

		// gizmos (one core per id; the thumbnail uploads only when it changed)
		const { add, remove } = diffIds(this.gizmos.keys(), frame.gizmos);
		for (const id of remove) {
			this.gizmos.get(id)?.core.destroy();
			this.gizmos.delete(id);
		}
		for (const id of add)
			this.gizmos.set(id, {
				core: createGizmoCore(g.device, {}, `roll-gizmo-${id}`),
				image: null,
			});
		for (const gz of frame.gizmos) {
			const e = this.gizmos.get(gz.id);
			if (!e) continue;
			const withImage = e.image !== gz.image || add.includes(gz.id);
			e.core.setProps(gizmoProps(gz, this.pixelRatio, withImage));
			e.image = gz.image;
		}
		if (add.length || remove.length) this.syncCores();

		g.pins.setPins(frame.pins);
		this.applyExtras(g, frame);
		g.host.requestRender("color");
	}

	/** frame.extras -> the deck overlay (created on first use; none for the landing). */
	private applyExtras(g: Gpu, frame: RollFrame) {
		const layers = frame.extras as readonly unknown[];
		if (!this.overlay) {
			if (!layers.length) return;
			this.overlay = new DeckExtrasOverlay(g.device, {
				pixelRatio: this.pixelRatio,
				onNeedFrame: () => this.gpu?.host.requestRender("color"),
			});
			this.overlayCore = new OverlayCore(this.overlay);
			this.syncCores();
		}
		this.overlay.setViewState(frame.viewState);
		this.overlay.setLayers(layers);
	}

	/** render() already applies every input to the cores synchronously; the draw is on the next frame. */
	flush() {}

	project(
		p: readonly [number, number, number],
	): [number, number, number] | null {
		if (!this.view) return null;
		return projectRollPoint(
			this.view,
			this.canvas.clientWidth,
			this.canvas.clientHeight,
			p,
		);
	}

	setPixelRatio(ratio: number) {
		this.pixelRatio = ratio;
		const g = this.gpu;
		if (!g) return;
		this.setContextRatio(g.host, ratio);
		g.pins.setPixelRatio(ratio);
		this.overlay?.setPixelRatio(ratio);
		for (const e of this.gizmos.values())
			e.core.setProps({ pixelRatio: ratio });
		g.host.requestRender("color");
	}

	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		for (const s of [...this.sources]) s.dispose();
		this.handOff?.destroy();
		this.handOff = null;
		for (const e of this.gizmos.values()) e.core.destroy();
		this.gizmos.clear();
		this.extras.clear();
		this.overlay?.destroy();
		this.overlay = null;
		this.overlayCore = null;
		const g = this.gpu;
		this.gpu = null;
		if (!g) return; // boot() sees `disposed` and destroys the host
		g.host.cores = [];
		for (const c of [
			g.drape,
			g.pins,
			g.present,
			g.terrain,
			g.styles,
			g.imagery,
		])
			try {
				c.destroy();
			} catch {}
		// the device's destruction clears the compute adoption (gpu/device adoptRenderDevice's lost handler)
		g.host.destroy();
	}
}

export function createWebgpuBackend(
	canvas: HTMLCanvasElement,
	opts: { pixelRatio: number },
): RollGpuBackend {
	return new WebgpuBackend(canvas, opts);
}
