// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Dev fallback for testing without a phone: `?liveSource=<video url>` plays a recorded clip as the camera and,
// when `<video url>.sensors.json` exists, replays recorded sensors against the video clock.
//
// Sidecar format:
//   { "samples": [{ "t": 0.0, "yaw": 123.4, "pitch": 3.1, "roll": -0.4, "yawAccuracy": 10 }, …],   // t = media seconds
//     "eye": { "lat": 46.7, "lon": 7.8, "alt": 1100 },                                               // optional
//     "vfov": 48 }                                                                                    // optional

import type { EyeFix, SensorSample } from "./contract";

export type ReplaySample = {
	t: number;
	yaw: number | null;
	pitch: number;
	roll: number;
	yawAccuracy?: number;
};
export type ReplaySidecar = {
	samples: ReplaySample[];
	eye?: { lat: number; lon: number; alt?: number };
	vfov?: number;
};

/** Parse and sanitise a sidecar; returns null when it carries nothing usable. */
export function parseSidecar(json: unknown): ReplaySidecar | null {
	if (!json || typeof json !== "object") return null;
	const raw = json as Partial<ReplaySidecar>;
	const samples = (Array.isArray(raw.samples) ? raw.samples : [])
		.filter(
			(s) =>
				s &&
				Number.isFinite(s.t) &&
				Number.isFinite(s.pitch) &&
				Number.isFinite(s.roll),
		)
		.sort((a, b) => a.t - b.t);
	const eye =
		raw.eye && Number.isFinite(raw.eye.lat) && Number.isFinite(raw.eye.lon)
			? raw.eye
			: undefined;
	if (!samples.length && !eye) return null;
	return {
		samples,
		eye,
		vfov: Number.isFinite(raw.vfov) ? raw.vfov : undefined,
	};
}

const lerp = (a: number, b: number, f: number) => a + (b - a) * f;
const lerpAngle = (a: number, b: number, f: number) =>
	a + (((((b - a) % 360) + 540) % 360) - 180) * f;

/** The sensor sample at media time `t` seconds (linear, shortest way round for angles); `time` is the caller's clock. */
export function interpolateSample(
	samples: readonly ReplaySample[],
	t: number,
	time: number,
): SensorSample | null {
	if (!samples.length) return null;
	let hi = samples.findIndex((s) => s.t >= t);
	if (hi === -1) hi = samples.length - 1;
	const b = samples[hi];
	const a = hi > 0 && b.t > t ? samples[hi - 1] : b;
	const f =
		a === b || b.t === a.t
			? 0
			: Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t)));
	const yaw =
		a.yaw != null && b.yaw != null
			? ((lerpAngle(a.yaw, b.yaw, f) % 360) + 360) % 360
			: null;
	const sample: SensorSample = {
		time,
		yaw,
		pitch: lerp(a.pitch, b.pitch, f),
		roll: lerpAngle(a.roll, b.roll, f),
	};
	if (b.yawAccuracy != null) sample.yawAccuracy = b.yawAccuracy;
	return sample;
}

export type ReplayFeed = {
	sidecar: ReplaySidecar | null;
	/** Sensor sample for the video's current media time. */
	sample(video: HTMLVideoElement, time: number): SensorSample | null;
	eye(time: number): EyeFix | null;
};

/** Load the sidecar next to a clip (missing or malformed is fine: sensors are then absent). */
export async function loadReplay(
	videoUrl: string,
	fetchImpl: typeof fetch = fetch,
): Promise<ReplayFeed> {
	let sidecar: ReplaySidecar | null = null;
	try {
		const response = await fetchImpl(`${videoUrl}.sensors.json`);
		if (response.ok) sidecar = parseSidecar(await response.json());
	} catch {
		sidecar = null;
	}
	return {
		sidecar,
		sample: (video, time) =>
			sidecar
				? interpolateSample(sidecar.samples, video.currentTime, time)
				: null,
		eye: (time) =>
			sidecar?.eye ? { ...sidecar.eye, accuracy: 5, time } : null,
	};
}

/** A looping muted clip as the camera stand-in. Resolves once it plays. */
export async function openReplayVideo(
	video: HTMLVideoElement,
	url: string,
): Promise<void> {
	video.crossOrigin = "anonymous";
	video.muted = true;
	video.loop = true;
	video.playsInline = true;
	video.src = url;
	await video.play();
	if (!video.videoWidth)
		await new Promise<void>((resolve) =>
			video.addEventListener("loadedmetadata", () => resolve(), { once: true }),
		);
}
