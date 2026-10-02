// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Dev fallback for testing without a phone: `?liveSource=<video url>` plays a recorded clip as the camera and,
// when `<video url>.sensors.json` exists, replays recorded sensors against the video clock.
//
// Sidecar format:
//   { "samples": [{ "t": 0.0, "yaw": 123.4, "pitch": 3.1, "roll": -0.4, "yawAccuracy": 10 }, …],   // t = media seconds
//     "eye": { "lat": 46.7, "lon": 7.8, "alt": 1100 },                                               // optional
//     "eyes": [{ "t": 0, "lat": 46.7, "lon": 7.8, "alt": 1100, "accuracy": 5 }, …],                 // optional moving eye
//     "vfov": 48 }                                                                                    // optional

import type { EyeFix, SensorSample } from "./contract";

export type ReplaySample = {
	t: number;
	yaw: number | null;
	pitch: number;
	roll: number;
	yawAccuracy?: number;
};
export type ReplayEyeSample = {
	t: number;
	lat: number;
	lon: number;
	alt?: number;
	accuracy: number;
};
export type ReplaySidecar = {
	samples: ReplaySample[];
	eye?: { lat: number; lon: number; alt?: number };
	/** A moving eye (media seconds, sorted): the replay then feeds position fixes the way the phone's GPS would. */
	eyes?: ReplayEyeSample[];
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
	const eyes = (Array.isArray(raw.eyes) ? raw.eyes : [])
		.filter(
			(e) =>
				e &&
				Number.isFinite(e.t) &&
				Number.isFinite(e.lat) &&
				Number.isFinite(e.lon),
		)
		.map((e) => ({
			t: e.t,
			lat: e.lat,
			lon: e.lon,
			...(Number.isFinite(e.alt) ? { alt: e.alt } : {}),
			accuracy: Number.isFinite(e.accuracy) ? e.accuracy : 5,
		}))
		.sort((a, b) => a.t - b.t);
	if (!samples.length && !eye && !eyes.length) return null;
	return {
		samples,
		eye:
			eye ??
			(eyes[0]
				? { lat: eyes[0].lat, lon: eyes[0].lon, alt: eyes[0].alt }
				: undefined),
		eyes: eyes.length ? eyes : undefined,
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

/** The eye at media time `t` seconds: linear between track points, held before the first and after the last. */
export function interpolateEye(
	eyes: readonly ReplayEyeSample[],
	t: number,
	time: number,
): EyeFix | null {
	if (!eyes.length) return null;
	let hi = eyes.findIndex((e) => e.t >= t);
	if (hi === -1) hi = eyes.length - 1;
	const b = eyes[hi];
	const a = hi > 0 && b.t > t ? eyes[hi - 1] : b;
	const f =
		a === b || b.t === a.t
			? 0
			: Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t)));
	const fix: EyeFix = {
		lat: lerp(a.lat, b.lat, f),
		lon: lerp(a.lon, b.lon, f),
		accuracy: b.accuracy,
		time,
	};
	if (a.alt != null && b.alt != null) fix.alt = lerp(a.alt, b.alt, f);
	return fix;
}

export type ReplayFeed = {
	sidecar: ReplaySidecar | null;
	/** Sensor sample for the video's current media time. */
	sample(video: HTMLVideoElement, time: number): SensorSample | null;
	/** The eye at the start of the clip (the first track point when there is a track). */
	eye(time: number): EyeFix | null;
	/** The eye for the video's current media time: the track when the sidecar has one, else the fixed eye. */
	eyeAt(video: HTMLVideoElement, time: number): EyeFix | null;
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
			sidecar?.eyes
				? interpolateEye(sidecar.eyes, sidecar.eyes[0].t, time)
				: sidecar?.eye
					? { ...sidecar.eye, accuracy: 5, time }
					: null,
		eyeAt: (video, time) =>
			sidecar?.eyes
				? interpolateEye(sidecar.eyes, video.currentTime, time)
				: sidecar?.eye
					? { ...sidecar.eye, accuracy: 5, time }
					: null,
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
