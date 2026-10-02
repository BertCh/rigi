// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Live camera input: getUserMedia (rear camera, ideal 1280×720 at 30 fps), a frame pump that hands every
// decoded video frame to the tracker as a TrackFrame with the latest sensor sample, and a camera
// intrinsics estimate. Browsers expose no field of view, so vfov comes from a phone-main-camera default
// (about 69° along the long image side, the 26 mm equivalent), divided by the track's `zoom` setting when
// it reports one, or from an explicit override (?liveVfov=).

import type { SensorSample, TrackFrame } from "./contract";

/** Long-side field of view of a typical phone main camera (26 mm equivalent: 2·atan(18 / 26)). */
export const DEFAULT_LONG_SIDE_FOV_DEG = 69.4;

export type IntrinsicsOptions = {
	/** Frame size in pixels as delivered (portrait phones deliver a portrait frame: height > width). */
	width: number;
	height: number;
	/** Explicit vertical field of view in degrees; wins over everything. */
	vfovOverride?: number | null;
	/** Long-side field of view in degrees when nothing else is known. */
	longSideFovDeg?: number;
	/** MediaStreamTrack zoom setting (1 = none): the field of view narrows as 1 / zoom. */
	zoom?: number | null;
};

export type CameraIntrinsics = {
	vfov: number;
	hfov: number;
	source: "override" | "default" | "zoomed-default";
};

/** Vertical and horizontal field of view for a frame of this shape. */
export function estimateIntrinsics(
	options: IntrinsicsOptions,
): CameraIntrinsics {
	const { width, height } = options;
	const toRad = Math.PI / 180;
	const tanHalf = (deg: number) => Math.tan((deg * toRad) / 2);
	const fromTan = (t: number) => (2 * Math.atan(t)) / toRad;
	const aspect = width / height;
	if (options.vfovOverride != null && Number.isFinite(options.vfovOverride)) {
		const t = tanHalf(options.vfovOverride);
		return {
			vfov: options.vfovOverride,
			hfov: fromTan(t * aspect),
			source: "override",
		};
	}
	const zoom = options.zoom != null && options.zoom > 0 ? options.zoom : 1;
	const longTan =
		tanHalf(options.longSideFovDeg ?? DEFAULT_LONG_SIDE_FOV_DEG) / zoom;
	// cropping a 4:3 sensor to 16:9 trims the short side, so the long side keeps its field of view
	const vTan = height >= width ? longTan : (longTan * height) / width;
	const hTan = width >= height ? longTan : (longTan * width) / height;
	return {
		vfov: fromTan(vTan),
		hfov: fromTan(hTan),
		source: zoom === 1 ? "default" : "zoomed-default",
	};
}

/** Ring of recent sensor samples; `at(t)` is the latest sample at or before t (within `maxAgeMs`). */
export class SensorHistory {
	private readonly samples: SensorSample[] = [];
	constructor(
		private readonly capacity = 64,
		private readonly maxAgeMs = 500,
	) {}

	push(sample: SensorSample) {
		const last = this.samples[this.samples.length - 1];
		if (last && sample.time < last.time) this.samples.length = 0; // clock went backwards (replay seek)
		this.samples.push(sample);
		if (this.samples.length > this.capacity) this.samples.shift();
	}

	at(time: number): SensorSample | undefined {
		for (let i = this.samples.length - 1; i >= 0; i--) {
			const s = this.samples[i];
			if (s.time <= time) return time - s.time <= this.maxAgeMs ? s : undefined;
		}
		return undefined;
	}

	clear() {
		this.samples.length = 0;
	}
}

type VideoFrameMetadataLike = { mediaTime?: number; presentedFrames?: number };
type VideoWithCallback = HTMLVideoElement & {
	requestVideoFrameCallback?: (
		cb: (now: number, metadata: VideoFrameMetadataLike) => void,
	) => number;
	cancelVideoFrameCallback?: (id: number) => void;
};

export interface FramePump {
	readonly framesDelivered: number;
	readonly usesVideoFrameCallback: boolean;
	stop(): void;
}

export type FramePumpOptions = {
	video: HTMLVideoElement;
	onFrame: (frame: TrackFrame) => void;
	/** Latest sensor sample at or before the frame time. */
	sensorAt?: (time: number) => SensorSample | undefined;
	/** Frame gate (the governor's shouldRender); a skipped frame is dropped, not queued. */
	accept?: (time: number) => boolean;
	now?: () => number;
	/** requestAnimationFrame stand-in for tests. */
	requestFrame?: (cb: (time: number) => void) => number;
	cancelFrame?: (id: number) => void;
};

/**
 * One TrackFrame per presented video frame: requestVideoFrameCallback where it exists (exact frame cadence,
 * no duplicates), else requestAnimationFrame deduplicated on `currentTime` so a 60 Hz loop does not feed a
 * 30 fps camera twice.
 */
export function startFramePump(options: FramePumpOptions): FramePump {
	const video = options.video as VideoWithCallback;
	const now = options.now ?? (() => performance.now());
	const raf = options.requestFrame ?? ((cb) => requestAnimationFrame(cb));
	const caf = options.cancelFrame ?? ((id) => cancelAnimationFrame(id));
	const useCallback = typeof video.requestVideoFrameCallback === "function";
	let stopped = false;
	let handle = 0;
	let delivered = 0;
	let lastMediaTime = Number.NaN;

	const deliver = (time: number) => {
		const width = video.videoWidth;
		const height = video.videoHeight;
		if (!width || !height) return;
		if (options.accept && !options.accept(time)) return;
		delivered++;
		options.onFrame({
			time,
			width,
			height,
			source: video,
			sensor: options.sensorAt?.(time),
		});
	};

	const onVideoFrame = (time: number) => {
		if (stopped) return;
		deliver(time);
		handle = video.requestVideoFrameCallback?.(onVideoFrame) ?? 0;
	};
	const onAnimationFrame = () => {
		if (stopped) return;
		const mediaTime = video.currentTime;
		if (mediaTime !== lastMediaTime && video.readyState >= 2) {
			lastMediaTime = mediaTime;
			deliver(now());
		}
		handle = raf(onAnimationFrame);
	};

	if (useCallback)
		handle = video.requestVideoFrameCallback?.(onVideoFrame) ?? 0;
	else handle = raf(onAnimationFrame);

	return {
		get framesDelivered() {
			return delivered;
		},
		usesVideoFrameCallback: useCallback,
		stop() {
			stopped = true;
			if (useCallback) video.cancelVideoFrameCallback?.(handle);
			else caf(handle);
		},
	};
}

export type CameraResult =
	| { ok: true; camera: LiveCamera }
	| {
			ok: false;
			reason: "unsupported" | "denied" | "not-found" | "error";
			message: string;
	  };

export interface LiveCamera {
	readonly video: HTMLVideoElement;
	readonly stream: MediaStream;
	readonly width: number;
	readonly height: number;
	readonly zoom: number | null;
	intrinsics(vfovOverride?: number | null): CameraIntrinsics;
	stop(): void;
}

/** The constraints for the rear camera. Exported so tests and the UI can show what was asked for. */
export function cameraConstraints(): MediaStreamConstraints {
	return {
		audio: false,
		video: {
			facingMode: { ideal: "environment" },
			width: { ideal: 1280 },
			height: { ideal: 720 },
			frameRate: { ideal: 30 },
		},
	};
}

/** Ask for the camera (a user gesture is not required, a permission prompt is) and wait for the first frame. */
export async function openCamera(
	video: HTMLVideoElement,
): Promise<CameraResult> {
	if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia)
		return {
			ok: false,
			reason: "unsupported",
			message: "getUserMedia is not available (needs https)",
		};
	let stream: MediaStream;
	try {
		stream = await navigator.mediaDevices.getUserMedia(cameraConstraints());
	} catch (e) {
		const name = (e as DOMException)?.name;
		const reason =
			name === "NotAllowedError" || name === "SecurityError"
				? "denied"
				: name === "NotFoundError"
					? "not-found"
					: "error";
		return { ok: false, reason, message: (e as Error)?.message ?? String(e) };
	}
	video.muted = true;
	video.playsInline = true;
	video.srcObject = stream;
	try {
		await video.play();
		if (!video.videoWidth)
			await new Promise<void>((resolve) =>
				video.addEventListener("loadedmetadata", () => resolve(), {
					once: true,
				}),
			);
	} catch (e) {
		for (const t of stream.getTracks()) t.stop();
		return {
			ok: false,
			reason: "error",
			message: (e as Error)?.message ?? String(e),
		};
	}
	const track = stream.getVideoTracks()[0];
	const settings = (track?.getSettings?.() ?? {}) as MediaTrackSettings & {
		zoom?: number;
	};
	return {
		ok: true,
		camera: {
			video,
			stream,
			get width() {
				return video.videoWidth;
			},
			get height() {
				return video.videoHeight;
			},
			zoom: typeof settings.zoom === "number" ? settings.zoom : null,
			intrinsics: (vfovOverride) =>
				estimateIntrinsics({
					width: video.videoWidth,
					height: video.videoHeight,
					vfovOverride,
					zoom: settings.zoom,
				}),
			stop() {
				for (const t of stream.getTracks()) t.stop();
				video.srcObject = null;
			},
		},
	};
}
