// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// "Step Inside (beta)" in /live (flag `liveStep`): per-frame depth → splats on the GPU for the camera
// video, drawn by the WebGPU engine (Renderer.setNearFieldLive). Fixed camera: the splats live in ENU and
// are lifted with the pose of each depth run (the tracker's pose), so a moving phone only changes the view.
//
//   every N frames   the video frame → net input (canvas, 14·tokens px) → MogeDepthNet.runCompiled with
//                    DEPTH_LIVE_PRESETS.liveFast (persistent output buffers, nothing is read back) →
//                    LiveNearField.runDepth (lift, compaction, colours) in the same queue order
//   every frame      the video frame → a texture → LiveNearField.refreshColour (between depth runs)
//   once             after the first depth run: read the outputs, solve focal / shift and fit the anchor
//                    against the DEM range grid (LiveNearField.calibrate); depth runs are skipped until then
// WebGL2: unavailable (no setNearFieldLive; the readback bridge exists for the session but is not wired
// here). All of it is browser-only; the pure parts are nearfield/live/video-input.ts and schedule.ts.
import { type Buffer, type Device, Texture } from "@luma.gl/core";
import { getComputeDevice } from "#/lib/gpu/device";
import { intrinsicsFromPose, sampleDemGrid } from "#/lib/nearfield/geom";
import { camToEnuMatrix } from "#/lib/nearfield/lift";
import {
	LiveNearField,
	liveDepthGrid,
	rgbaToPlanes,
} from "#/lib/nearfield/live";
import {
	DEPTH_LIVE_PRESETS,
	type DepthNetOutput,
	FOCAL_GRID,
	MOGE2_WEIGHTS,
	MogeDepthNet,
} from "#/lib/nearfield/local/depth-net";
import type { Nn } from "#/lib/nn";
import type { Renderer } from "#/lib/renderer";

export type LiveStepState = "off" | "loading" | "on" | "unavailable" | "error";

export type LiveStepHost = Pick<
	Renderer,
	| "pose"
	| "eye"
	| "aspect"
	| "onRender"
	| "readback"
	| "geometryReady"
	| "sampleAt"
	| "setNearFieldLive"
> & {
	nearFieldDemRange?(
		width: number,
		height: number,
	): (u: number, v: number) => number | null;
};

export type LiveStepOptions = {
	host: LiveStepHost;
	video: HTMLVideoElement;
	onState: (state: LiveStepState, message: string) => void;
	/** A depth run every N frames (default 4). */
	depthEvery?: number;
};

const PRESET = DEPTH_LIVE_PRESETS.liveFast;

/** Why Step Inside is not available on this backend (null = it is), for the disabled toggle. */
export function liveStepUnavailableReason(
	backend: string,
	host: Pick<LiveStepHost, "onRender"> &
		Partial<Pick<LiveStepHost, "setNearFieldLive">>,
): string | null {
	if (backend !== "webgpu" || !host.setNearFieldLive)
		return "Needs the WebGPU renderer";
	return null;
}

/** Lazily built live Step Inside session; `stop()` releases the GPU objects. */
export class LiveStep {
	private disposed = false;
	private unsubscribe: (() => void) | null = null;
	private live: LiveNearField | null = null;
	private net: MogeDepthNet | null = null;
	private nn: Nn | null = null;
	private device: Device | null = null;
	private videoTexture: Texture | null = null;
	private canvas: OffscreenCanvas | null = null;
	private planes: Float32Array | null = null;
	private lastOut: DepthNetOutput | null = null;
	private grid: ReturnType<typeof liveDepthGrid> | null = null;
	private inFlight = false;
	private ready: { z: Buffer; mask: Buffer; metricScale: Buffer } | null = null;
	/** a depth run finished since the last lift */
	private fresh = false;
	private calibrating = false;
	private calibrated = false;

	constructor(private readonly opts: LiveStepOptions) {}

	async start() {
		const { host, video, onState } = this.opts;
		onState("loading", "Loading the depth model");
		const device = await getComputeDevice();
		if (!device || device.type !== "webgpu") {
			onState("unavailable", "Needs WebGPU compute");
			return;
		}
		const { createNn } = await import("#/lib/nn");
		const nn = await createNn({ device, backend: "gpu" });
		const net = await MogeDepthNet.load(nn, {
			file: MOGE2_WEIGHTS[PRESET.weights],
		});
		if (this.disposed) {
			net.dispose();
			return;
		}
		this.device = device;
		this.nn = nn;
		this.net = net;
		const grid = liveDepthGrid(
			video.videoWidth,
			video.videoHeight,
			PRESET.tokens,
		);
		this.grid = grid;
		this.canvas = new OffscreenCanvas(grid.inputWidth, grid.inputHeight);
		this.planes = new Float32Array(3 * grid.inputWidth * grid.inputHeight);
		this.live = new LiveNearField({
			device,
			width: grid.width,
			height: grid.height,
			schedule: { depthEvery: this.opts.depthEvery ?? 4, refitEvery: 60 },
		});
		host.setNearFieldLive?.(this.live.source);
		this.unsubscribe = host.onRender(() => this.tick());
		onState("on", "Step Inside (beta)");
	}

	stop() {
		this.disposed = true;
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.opts.host.setNearFieldLive?.(null);
		this.live?.dispose();
		this.live = null;
		this.videoTexture?.destroy();
		this.videoTexture = null;
		this.net?.dispose();
		this.net = null;
		this.ready = null;
		this.opts.onState("off", "");
	}

	/** The video frame as an rgba8 texture (re-created when the video size changes). */
	private updateVideoTexture(): Texture | null {
		const { video } = this.opts;
		const device = this.device;
		if (!device || !video.videoWidth || video.readyState < 2) return null;
		const t = this.videoTexture;
		if (!t || t.width !== video.videoWidth || t.height !== video.videoHeight) {
			t?.destroy();
			this.videoTexture = device.createTexture({
				id: "live-step-video",
				width: video.videoWidth,
				height: video.videoHeight,
				format: "rgba8unorm",
				usage: Texture.SAMPLE | Texture.COPY_DST | Texture.RENDER_ATTACHMENT,
			});
		}
		this.videoTexture?.copyExternalImage({
			image: video,
			width: video.videoWidth,
			height: video.videoHeight,
			flipY: false,
			premultipliedAlpha: false,
			colorSpace: "srgb",
		});
		return this.videoTexture;
	}

	private tick() {
		const live = this.live;
		if (this.disposed || !live || !this.net) return;
		const { host } = this.opts;
		const pose = host.pose;
		const eye = host.eye;
		live.setCamera({
			camToEnu: camToEnuMatrix(pose),
			eye: [eye.x, eye.y, eye.z],
			K: intrinsicsFromPose(pose, host.aspect),
		});
		const texture = this.updateVideoTexture();
		// a due depth frame consumes the finished run (the schedule defers it until one is ready)
		if (
			live.schedule.isDepthDue() &&
			!this.inFlight &&
			!this.fresh &&
			!this.calibrating
		)
			void this.depthRun();
		const inputs = this.fresh && live.calibration ? this.ready : null;
		const plan = live.frame(() => inputs, texture);
		if (plan.runDepth) this.fresh = false;
	}

	/** Video frame → net input → compiled forward (outputs stay on the GPU). */
	private async depthRun() {
		const net = this.net;
		const nn = this.nn;
		const grid = this.grid;
		const canvas = this.canvas;
		const planes = this.planes;
		const device = this.device;
		if (!net || !nn || !grid || !canvas || !planes || !device) return;
		const { video, host } = this.opts;
		if (!video.videoWidth || video.readyState < 2) return;
		this.inFlight = true;
		try {
			const ctx = canvas.getContext("2d", { willReadFrequently: true });
			if (!ctx) return;
			ctx.drawImage(video, 0, 0, grid.inputWidth, grid.inputHeight);
			const px = ctx.getImageData(0, 0, grid.inputWidth, grid.inputHeight).data;
			rgbaToPlanes(px, grid.inputWidth * grid.inputHeight, planes);
			const out = await net.runCompiled(
				{ data: planes, shape: [1, 3, grid.inputHeight, grid.inputWidth] },
				video.videoWidth / video.videoHeight,
				[grid.height, grid.width],
				PRESET,
			);
			if (this.disposed) return;
			// persistent outputs are the same tensors every run; a fallback forward hands fresh ones
			if (this.lastOut && this.lastOut !== out && this.lastOut.z !== out.z)
				nn.dispose(Object.values(this.lastOut).filter((t) => t !== null));
			this.lastOut = out;
			const bufferOf = (nn as Nn & { bufferOf?(t: unknown): Buffer }).bufferOf;
			if (!bufferOf) return;
			const buffers = {
				z: bufferOf.call(nn, out.z),
				mask: bufferOf.call(nn, out.mask),
				metricScale: bufferOf.call(nn, out.metricScale),
			};
			if (!this.calibrated) {
				if (!this.calibrating) void this.calibrate(out, host);
				return;
			}
			this.ready = buffers;
			this.fresh = true;
		} catch (e) {
			console.warn("[live step] depth run failed", e);
			this.opts.onState("error", "Depth failed");
		} finally {
			this.inFlight = false;
		}
	}

	/** One-time focal / shift / anchor solve from one read-back of the first outputs. */
	private async calibrate(out: DepthNetOutput, host: LiveStepHost) {
		const live = this.live;
		const nn = this.nn;
		const grid = this.grid;
		if (!live || !nn || !grid) return;
		this.calibrating = true;
		try {
			const [z, mask, points64, mask64, scale] = await Promise.all([
				nn.read(out.z),
				nn.read(out.mask),
				nn.read(out.points64),
				nn.read(out.mask64),
				nn.read(out.metricScale),
			]);
			if (this.disposed) return;
			if ((await host.readback()) && host.geometryReady()) {
				const demAt =
					host.nearFieldDemRange?.(grid.width, grid.height) ??
					((u: number, v: number) => host.sampleAt(u, v)?.range ?? null);
				live.setDemGrid(sampleDemGrid(grid.width, grid.height, demAt));
			}
			live.calibrate({
				width: grid.width,
				height: grid.height,
				z,
				mask,
				normal: null,
				points64,
				mask64,
				focalGrid: FOCAL_GRID,
				metricScale: scale[0],
			});
			this.calibrated = true;
		} catch (e) {
			console.warn("[live step] calibration failed", e);
			this.opts.onState("error", "Calibration failed");
		} finally {
			this.calibrating = false;
		}
	}
}
