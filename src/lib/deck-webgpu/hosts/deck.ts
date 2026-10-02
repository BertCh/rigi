// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// deck.gl-on-WebGPU host (the chosen direction, README.md "Approach"). deck owns the device, the
// canvas, the views / viewports and the frame loop; our offscreen passes run in a deck Effect's
// preRender (before deck's canvas LayersPass, same command encoder, one submit), and screen
// cores are drawn by a thin deck Layer (CoreLayer) in deck's canvas pass.
//
// Why not deck's _LayersPass for the offscreen passes (spike.ts, 2026-09-30, deck 9.4.0):
//   - LayersPass clears depth to 1 (reversed-Z needs 0) and a View `clear` opens a render pass
//     inside the open one (invalid command buffer on WebGPU);
//   - WEBGPU_DEFAULT_DRAW_PARAMETERS force premultiplied blending + 'less-equal' over the model's
//     own parameters; blending can't be turned off (only neutralised), so non-blendable targets
//     (rgba32float) need the optional 'float32-blendable' feature;
//   - it opens no resolve targets and ignores sample counts.
// Our pass runner (passes.ts) avoids all of it; deck still gives lifecycle, views, controllers.
import {
	type Deck,
	Layer,
	type LayerContext,
	OrthographicView,
	type PreRenderOptions,
} from "@deck.gl/core";
import type {
	Device,
	RenderPass,
	RenderPipelineParameters,
} from "@luma.gl/core";
import type { Pose } from "#/lib/camera";
import { PhotoView } from "#/lib/deck/photo-view";
import { createWebgpuDeck } from "../device";
import { attachFrameTimings, getFrameTimings } from "../frame-timings";
import type { FrameState, GpuLayerCore } from "../pass";
import { ColorTargets, GeometryTargets, geometrySize } from "../targets";
import type { Host, HostStats } from "./direct";
import {
	type CameraPose,
	camerasFor,
	runOffscreenPasses,
	runScreenPass,
} from "./passes";

type CoreLayerProps = {
	host: DeckHost;
	parameters?: RenderPipelineParameters;
};

/** Draws the host's screen cores in deck's canvas pass. */
class CoreLayer extends Layer<CoreLayerProps> {
	static layerName = "RigiCoreLayer";
	initializeState() {}
	draw({ renderPass }: { renderPass: RenderPass }) {
		this.props.host.drawScreen(renderPass);
	}
	finalizeState(context: LayerContext) {
		super.finalizeState(context);
	}
}

export class DeckHost implements Host {
	readonly kind = "deck" as const;
	geometry: GeometryTargets;
	color: ColorTargets;
	cores: GpuLayerCore[] = [];
	photo: CameraPose;
	view: CameraPose;
	frameView: FrameState["view"] = "photo";
	stats: HostStats = {
		frames: 0,
		cpuMs: 0,
		frameMs: 0,
		firstFrameMs: null,
		geometryMs: 0,
		colorMs: 0,
		screenMs: 0,
	};
	private frame: FrameState = { frame: 0, time: 0, view: "photo" };
	private requestedAt = 0;
	private t0 = performance.now();
	private waiters: (() => void)[] = [];
	private frameStart = 0;
	private offscreenDirty = true;
	/** Extra deck views after [photo, screen] (setExtraViews: e.g. Step Inside's MapView). */
	private extraViews: unknown[] = [];
	private extraViewState: Record<string, unknown> = {};
	private readonly baseViews: unknown[];

	static async create(
		canvas: HTMLCanvasElement,
		pose: CameraPose,
		pixelRatioCap = 2,
	) {
		let host: DeckHost | null = null;
		const effect = {
			id: "rigi-offscreen-passes",
			props: {},
			setup() {},
			cleanup() {},
			preRender(opts: PreRenderOptions) {
				host?.offscreen(opts);
			},
		};
		const views = [
			new PhotoView({ id: "photo", near: 1, far: 400_000 }),
			new OrthographicView({ id: "screen", flipY: true }),
		];
		const { deck, device } = await createWebgpuDeck({
			canvas,
			useDevicePixels: Math.min(window.devicePixelRatio || 1, pixelRatioCap),
			views,
			viewState: DeckHost.viewState(pose, canvas),
			effects: [effect],
			// screen cores draw once, in the 'screen' view
			layerFilter: ({ viewport }: { viewport: { id: string } }) =>
				viewport.id === "screen",
			onAfterRender: () => host?.afterRender(),
			onError: (e: Error) => console.error("[deck-webgpu host]", e),
		});
		host = new DeckHost(deck, device, pose, views);
		host.updateLayers();
		return host;
	}

	private constructor(
		readonly deck: Deck,
		readonly device: Device,
		pose: CameraPose,
		baseViews: unknown[],
	) {
		this.baseViews = baseViews;
		attachFrameTimings(device);
		this.photo = pose;
		this.view = pose;
		const g = geometrySize(4 / 3);
		this.geometry = new GeometryTargets(device, g.width, g.height);
		const [w, h] = this.canvasSize();
		this.color = new ColorTargets(device, w, h);
	}

	private static viewState(pose: CameraPose, canvas: HTMLCanvasElement) {
		const w = canvas.clientWidth || 1;
		const h = canvas.clientHeight || 1;
		// PhotoView takes the pose; our passes read `photo` / `view` directly, the viewport is for
		// deck-side layers (and future deck catalog layers) only
		return {
			photo: {
				...poseFromBasis(pose.forward, pose.up, pose.vfov),
				eye: pose.eye,
			},
			screen: { target: [w / 2, h / 2, 0], zoom: 0 },
		};
	}

	private canvasSize(): [number, number] {
		const ctx = this.device.getDefaultCanvasContext();
		const [w, h] = ctx.getDrawingBufferSize();
		return [Math.max(1, w), Math.max(1, h)];
	}

	setPhotoAspect(aspect: number) {
		const g = geometrySize(aspect);
		this.geometry.resize(g.width, g.height);
	}

	updateLayers() {
		this.deck.setProps({
			layers: [
				new CoreLayer({
					id: "screen-cores",
					host: this,
					// neutralise deck's WebGPU defaults for the screen pass (no depth test)
					parameters: { depthCompare: "always", depthWriteEnabled: false },
				}),
			],
		} as never);
	}

	requestRender(scope: "all" | "screen" = "all") {
		if (scope === "all") this.offscreenDirty = true;
		this.requestedAt = performance.now();
		const canvas = this.device.getDefaultCanvasContext()
			.canvas as HTMLCanvasElement;
		this.deck.setProps({
			viewState: {
				...DeckHost.viewState(this.photo, canvas),
				...this.extraViewState,
			},
		} as never);
		this.deck.redraw("rigi");
	}

	/**
	 * Extra deck views next to [photo, screen] — controller-only views such as Step Inside's hidden
	 * MapView (nearfield/deck-map-camera.ts): deck runs their controllers; no core draws in them
	 * (layerFilter keeps the screen cores in 'screen'). `viewState` is keyed by view id and merged
	 * into every requestRender; handlers are forwarded for the extra views only. Pass `[]` to drop.
	 */
	setExtraViews(
		views: readonly unknown[],
		viewState: Record<string, unknown>,
		handlers: {
			onViewStateChange?: (p: { viewId: string; viewState: unknown }) => void;
			onInteractionStateChange?: (s: Record<string, boolean>) => void;
		} = {},
	) {
		const ids = new Set(
			views.map((v) => (v as { id?: string }).id).filter(Boolean),
		);
		this.extraViews = [...views];
		this.extraViewState = { ...viewState };
		const canvas = this.device.getDefaultCanvasContext()
			.canvas as HTMLCanvasElement;
		this.deck.setProps({
			views: [...this.baseViews, ...this.extraViews],
			viewState: {
				...DeckHost.viewState(this.photo, canvas),
				...this.extraViewState,
			},
			onViewStateChange: (p: {
				viewId: string;
				viewState: Record<string, unknown>;
			}) => {
				if (ids.has(p.viewId)) {
					// controlled view state: keep the controller's move until the owner answers
					this.extraViewState = {
						...this.extraViewState,
						[p.viewId]: p.viewState,
					};
					handlers.onViewStateChange?.(p);
				}
				return p.viewState;
			},
			onInteractionStateChange: (s: Record<string, boolean>) =>
				handlers.onInteractionStateChange?.(s),
		} as never);
	}

	setInteractive(active: boolean) {
		if (this.color.setReduced(active)) this.offscreenDirty = true;
	}

	nextFrame(scope: "all" | "screen" = "all") {
		return new Promise<void>((r) => {
			this.waiters.push(r);
			this.requestRender(scope);
		});
	}

	/** Effect.preRender: geometry + colour passes. */
	private offscreen(opts: PreRenderOptions) {
		this.frameStart = performance.now();
		const [w, h] = this.canvasSize();
		if (this.color.resize(w, h)) this.offscreenDirty = true;
		// deck may redraw on its own (resize, internal needsRedraw); unchanged scenes skip the 3D
		if (!this.offscreenDirty) return;
		this.offscreenDirty = false;
		// deck's photo viewport (opts.viewports) carries the same pose for deck-side layers; our
		// cameras come from `photo` / `view`
		void opts;
		this.frame = {
			frame: this.stats.frames,
			time: this.frameStart,
			view: this.frameView,
		};
		// timed frames: the geometry + colour passes of this preRender (deck's canvas pass is not ours)
		getFrameTimings(this.device)?.beginFrame(this.frame.frame);
		runOffscreenPasses({
			device: this.device,
			cores: this.cores,
			geometry: this.geometry,
			color: this.color,
			photo: this.photo,
			view: this.view,
			frame: this.frame,
			timing: this.stats,
		});
	}

	/** CoreLayer.draw: the screen pass inside deck's canvas LayersPass. */
	drawScreen(renderPass: RenderPass) {
		const t = performance.now();
		const [w, h] = this.canvasSize();
		if (this.frame.view !== this.frameView)
			this.frame = { ...this.frame, view: this.frameView };
		runScreenPass({
			device: this.device,
			cores: this.cores,
			renderPass,
			camera: camerasFor(this.view, w, h),
			frame: this.frame,
			geometry: this.geometry,
			color: this.color,
		});
		this.stats.screenMs = performance.now() - t;
	}

	private afterRender() {
		this.stats.cpuMs = performance.now() - this.frameStart;
		this.stats.frames++;
		const requested = this.requestedAt;
		const waiters = this.waiters.splice(0);
		const fence = this.device.createFence();
		const submitted = fence.signaled.finally(() => fence.destroy());
		getFrameTimings(this.device)?.endFrame(submitted);
		submitted.then(() => {
			const now = performance.now();
			this.stats.frameMs = now - requested;
			this.stats.firstFrameMs ??= now - this.t0;
			for (const r of waiters) r();
		});
	}

	destroy() {
		// no frame will ever render: settle pending nextFrame() callers (they only await "a frame happened")
		for (const r of this.waiters.splice(0)) r();
		for (const c of this.cores) c.destroy();
		this.cores = [];
		getFrameTimings(this.device)?.destroy();
		this.geometry.destroy();
		this.color.destroy();
		// deck.finalize() (deck 9.4) never destroys the device it created: do it here, or the
		// GPUDevice, its canvas context and the compute adoption (cleared on device.lost) leak.
		// The engine detaches the host before destroying it, so onDeviceLost ignores this loss.
		const device = this.device;
		try {
			this.deck.finalize();
		} finally {
			device.destroy();
		}
	}
}

/** Inverse of camera.poseBasis: yaw / pitch / roll (deg) from forward + up. */
export function poseFromBasis(
	f: readonly number[],
	up: readonly number[],
	vfov: number,
): Pose {
	const D = 180 / Math.PI;
	const yaw = Math.atan2(f[0], f[1]);
	const pitch = Math.asin(Math.max(-1, Math.min(1, f[2])));
	const r0 = [Math.cos(yaw), -Math.sin(yaw), 0];
	const u0 = [
		r0[1] * f[2] - r0[2] * f[1],
		r0[2] * f[0] - r0[0] * f[2],
		r0[0] * f[1] - r0[1] * f[0],
	];
	const sr = up[0] * r0[0] + up[1] * r0[1] + up[2] * r0[2];
	const cr = up[0] * u0[0] + up[1] * u0[1] + up[2] * u0[2];
	return { yaw: yaw * D, pitch: pitch * D, roll: Math.atan2(sr, cr) * D, vfov };
}
