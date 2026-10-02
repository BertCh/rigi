// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Luma-direct host: no deck.gl. Owns a WebGPU device on the canvas, the targets and the frame
// loop (on demand: requestRender() schedules one rAF frame). The fallback when the deck host fails
// to boot.
import type { Device } from "@luma.gl/core";
import { createRenderDevice } from "../device";
import {
	attachFrameTimings,
	getFrameTimings,
	passTimestamps,
} from "../frame-timings";
import type { FrameState, GpuLayerCore } from "../pass";
import { ColorTargets, GeometryTargets, geometrySize } from "../targets";
import { type FrameScope, OffscreenDirty } from "./frame-scope";
import {
	type CameraPose,
	camerasFor,
	type PassTiming,
	runOffscreenPasses,
	runScreenPass,
} from "./passes";

export type HostStats = PassTiming & {
	frames: number;
	/** CPU ms of the last frame (encode + submit). */
	cpuMs: number;
	/** ms from requestRender() to queue.onSubmittedWorkDone for the last frame (GPU included). */
	frameMs: number;
	firstFrameMs: number | null;
};

export interface Host {
	readonly kind: "direct" | "deck";
	readonly device: Device;
	readonly geometry: GeometryTargets;
	readonly color: ColorTargets;
	cores: GpuLayerCore[];
	photo: CameraPose;
	/** The colour pass camera (photo view: same as photo; world view: the orbit camera). */
	view: CameraPose;
	/**
	 * FrameState.view for the colour and screen passes ("world" when `view` is the orbit camera);
	 * the geometry pass always sees "photo". Default "photo".
	 */
	frameView: FrameState["view"];
	stats: HostStats;
	/** Aspect of the photo (geometry target shape). */
	setPhotoAspect(aspect: number): void;
	/**
	 * Schedule a frame. "screen" re-runs only the screen pass on the last offscreen results (a
	 * composite-only change: reveal, brush, blend); "color" re-renders colour on the cached geometry
	 * target (only the view camera or time moved); "all" (default) re-renders geometry + colour.
	 */
	requestRender(scope?: FrameScope): void;
	/**
	 * Interactive quality: the colour pass draws without MSAA until `false`. Switching back only
	 * changes the mode; the caller requests the full-quality "all" frame (it also fires onRender).
	 */
	setInteractive(active: boolean): void;
	/** Cap the canvas device-pixel ratio (the live frame governor); hosts without one ignore it. */
	setPixelRatioCap?(cap: number): void;
	/** Resolves after the next frame's GPU work completes. */
	nextFrame(scope?: FrameScope): Promise<void>;
	destroy(): void;
}

const newStats = (): HostStats => ({
	frames: 0,
	cpuMs: 0,
	frameMs: 0,
	firstFrameMs: null,
	geometryMs: 0,
	colorMs: 0,
	screenMs: 0,
});

export class DirectHost implements Host {
	readonly kind = "direct" as const;
	geometry: GeometryTargets;
	color: ColorTargets;
	cores: GpuLayerCore[] = [];
	photo: CameraPose;
	view: CameraPose;
	frameView: FrameState["view"] = "photo";
	stats = newStats();
	private raf = 0;
	private requestedAt = 0;
	private t0 = performance.now();
	private waiters: (() => void)[] = [];
	private destroyed = false;
	private offscreenDirty = new OffscreenDirty();

	static async create(
		canvas: HTMLCanvasElement,
		pose: CameraPose,
		pixelRatioCap = 2,
	) {
		const device = await createRenderDevice(canvas, {
			useDevicePixels: Math.min(window.devicePixelRatio || 1, pixelRatioCap),
		});
		return new DirectHost(device, pose);
	}

	private constructor(
		readonly device: Device,
		pose: CameraPose,
	) {
		attachFrameTimings(device);
		this.photo = pose;
		this.view = pose;
		const g = geometrySize(4 / 3);
		this.geometry = new GeometryTargets(device, g.width, g.height);
		const [w, h] = this.canvasSize();
		this.color = new ColorTargets(device, w, h);
	}

	private canvasSize(): [number, number] {
		const ctx = this.device.getDefaultCanvasContext();
		const [w, h] = ctx.getDrawingBufferSize();
		return [Math.max(1, w), Math.max(1, h)];
	}

	setPhotoAspect(aspect: number) {
		const g = geometrySize(aspect);
		if (this.geometry.resize(g.width, g.height))
			this.offscreenDirty.markGeometry();
	}

	requestRender(scope: FrameScope = "all") {
		this.offscreenDirty.request(scope);
		if (this.raf || this.destroyed) return;
		this.requestedAt = performance.now();
		this.raf = requestAnimationFrame(() => {
			this.raf = 0;
			this.render();
		});
	}

	setInteractive(active: boolean) {
		if (this.color.setReduced(active)) this.offscreenDirty.markColor();
	}

	nextFrame(scope: FrameScope = "all") {
		return new Promise<void>((r) => {
			if (this.destroyed) return r();
			this.waiters.push(r);
			this.requestRender(scope);
		});
	}

	private render() {
		if (this.destroyed) return;
		const t = performance.now();
		const d = this.device;
		const [w, h] = this.canvasSize();
		if (this.color.resize(w, h)) this.offscreenDirty.markColor();
		const frame: FrameState = {
			frame: this.stats.frames,
			time: t,
			view: this.frameView,
		};
		getFrameTimings(d)?.beginFrame(frame.frame);
		const dirty = this.offscreenDirty.take();
		if (dirty.color)
			runOffscreenPasses({
				device: d,
				cores: this.cores,
				geometry: this.geometry,
				color: this.color,
				photo: this.photo,
				view: this.view,
				frame,
				timing: this.stats,
				geometryPass: dirty.geometry,
			});
		const ts = performance.now();
		const fb = d
			.getDefaultCanvasContext()
			.getCurrentFramebuffer({ depthStencilFormat: false });
		const renderPass = d.beginRenderPass({
			id: "rigi-screen",
			...passTimestamps(d, "screen"),
			framebuffer: fb,
			clearColor: [0, 0, 0, 1],
		});
		runScreenPass({
			device: d,
			cores: this.cores,
			renderPass,
			camera: camerasFor(this.view, w, h),
			frame,
			geometry: this.geometry,
			color: this.color,
		});
		renderPass.end();
		d.submit();
		this.stats.screenMs = performance.now() - ts;
		this.stats.cpuMs = performance.now() - t;
		this.stats.frames++;
		const requested = this.requestedAt;
		const waiters = this.waiters.splice(0);
		const fence = d.createFence();
		const submitted = fence.signaled.finally(() => fence.destroy());
		getFrameTimings(d)?.endFrame(submitted);
		submitted.then(() => {
			const now = performance.now();
			this.stats.frameMs = now - requested;
			this.stats.firstFrameMs ??= now - this.t0;
			for (const r of waiters) r();
		});
	}

	destroy() {
		this.destroyed = true;
		cancelAnimationFrame(this.raf);
		// no frame will ever render: settle pending nextFrame() callers (they only await "a frame happened")
		for (const r of this.waiters.splice(0)) r();
		for (const c of this.cores) c.destroy();
		this.cores = [];
		getFrameTimings(this.device)?.destroy();
		this.geometry.destroy();
		this.color.destroy();
		this.device.destroy();
	}
}
