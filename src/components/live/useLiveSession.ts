// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The /live session: permissions, camera (or a recorded clip), sensors, location, engine, tracker and the
// frame loop, owned by one hook so LiveView stays presentational. Everything here is browser-only.

import { useCallback, useEffect, useRef, useState } from "react";
import { getFlag } from "#/lib/flags";
import {
	estimateIntrinsics,
	type FramePump,
	type LiveCamera,
	openCamera,
	SensorHistory,
	startFramePump,
} from "#/lib/live/camera";
import type {
	EyeFix,
	SensorSample,
	TrackedPose,
	Tracker,
	TrackerPhase,
} from "#/lib/live/contract";
import { makeEyePhoto, nearestRegion } from "#/lib/live/eye-photo";
import { type LocationFeed, startLocation } from "#/lib/live/geolocation";
import { FrameGovernor } from "#/lib/live/governor";
import { createHorizonWarmer } from "#/lib/live/horizon-warm";
import {
	loadReplay,
	openReplayVideo,
	type ReplayFeed,
} from "#/lib/live/replay";
import { loadTracker } from "#/lib/live/sensor-tracker";
import {
	requestMotionPermission,
	type SensorFeed,
	type SensorSourceKind,
	startSensors,
} from "#/lib/live/sensors";
import { loadRegion, type PhotoMeta, photos } from "#/lib/photos";
import type { PeakLabel } from "#/lib/settings";
import { createLiveEngine, type LiveEngine } from "./engine";
import {
	LiveStep,
	type LiveStepState,
	liveStepUnavailableReason,
} from "./liveStep";

export type StepState = "idle" | "asking" | "ok" | "denied" | "unavailable";
export type SessionPhase = "idle" | "starting" | "running" | "error";

export type LiveStatus = {
	phase: SessionPhase;
	message: string;
	camera: StepState;
	motion: StepState;
	location: StepState;
	trackerPhase: TrackerPhase;
	realTracker: boolean;
	fps: number;
	compassAccuracy: number | null;
	sensorKind: SensorSourceKind | "replay";
	backend: string;
	thermal: boolean;
	pixelRatio: number;
	locked: boolean;
	calibrating: boolean;
	yawOffset: number;
	frame: { width: number; height: number } | null;
	/** Step Inside (beta, flag liveStep): the toggle's state; `stepReason` is why it is disabled (null = usable) */
	step: LiveStepState;
	stepMessage: string;
	stepReason: string | null;
};

const INITIAL: LiveStatus = {
	phase: "idle",
	message: "",
	camera: "idle",
	motion: "idle",
	location: "idle",
	trackerPhase: "init",
	realTracker: false,
	fps: 0,
	compassAccuracy: null,
	sensorKind: "none",
	backend: "",
	thermal: false,
	pixelRatio: 1,
	locked: false,
	calibrating: false,
	yawOffset: 0,
	frame: null,
	step: "off",
	stepMessage: "",
	stepReason: null,
};

const LABEL_INTERVAL_MS = 200;
const MAX_LABELS = 24;

export function useLiveSession() {
	const [status, setStatus] = useState<LiveStatus>(INITIAL);
	const [labels, setLabels] = useState<PeakLabel[]>([]);
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const videoRef = useRef<HTMLVideoElement | null>(null);
	const stageRef = useRef<HTMLDivElement | null>(null);
	const [canvasKey, setCanvasKey] = useState(0);
	const disposeRef = useRef<(() => void) | null>(null);
	const lockedRef = useRef(false);
	const yawOffsetRef = useRef(0);
	const trackerRef = useRef<
		| (Tracker & {
				setYawOffset?(deg: number): void;
				setEye?(eye: EyeFix): void;
		  })
		| null
	>(null);
	const lastPoseRef = useRef<TrackedPose | null>(null);
	const stepRef = useRef<LiveStep | null>(null);
	const stepContextRef = useRef<{
		engine: LiveEngine;
		video: HTMLVideoElement;
	} | null>(null);
	const patch = useCallback(
		(p: Partial<LiveStatus>) => setStatus((s) => ({ ...s, ...p })),
		[],
	);

	const stop = useCallback(() => {
		stepRef.current?.stop();
		stepRef.current = null;
		stepContextRef.current = null;
		disposeRef.current?.();
		disposeRef.current = null;
	}, []);
	useEffect(() => stop, [stop]);

	const start = useCallback(
		async (forceDeck = false) => {
			stop();
			const video = videoRef.current;
			const canvas = canvasRef.current;
			if (!video || !canvas) return;
			const cleanups: (() => void)[] = [];
			let cancelled = false;
			disposeRef.current = () => {
				cancelled = true;
				for (const c of cleanups.reverse()) c();
			};
			patch({ ...INITIAL, phase: "starting", message: "Starting" });
			const fail = (message: string) => {
				patch({ phase: "error", message });
			};
			try {
				const source = getFlag("liveSource");
				const vfovOverride = getFlag("liveVfov") ?? null;
				let sensors: SensorFeed | null = null;
				let location: LocationFeed | null = null;
				let camera: LiveCamera | null = null;
				let replay: ReplayFeed | null = null;
				const history = new SensorHistory();
				// the DEM horizon starts loading at the first fix, during the camera permission prompt
				const horizonWarmer = createHorizonWarmer();
				cleanups.push(() => horizonWarmer.dispose());
				let fix: EyeFix | null = null;

				if (source) {
					patch({ message: "Loading clip", camera: "asking" });
					await openReplayVideo(video, source);
					replay = await loadReplay(source);
					patch({
						camera: "ok",
						motion: replay.sidecar?.samples.length ? "ok" : "unavailable",
						location: replay.sidecar?.eye ? "ok" : "unavailable",
						sensorKind: "replay",
					});
					fix = replay.eye(performance.now());
					if (fix) horizonWarmer.offer(fix);
					cleanups.push(() => {
						video.pause();
						video.removeAttribute("src");
						video.load();
					});
				} else {
					// motion first: iOS only accepts the permission prompt inside the tap that started us
					patch({ message: "Motion sensors", motion: "asking" });
					const motion = await requestMotionPermission();
					patch({
						motion:
							motion === "granted"
								? "ok"
								: motion === "denied"
									? "denied"
									: "unavailable",
					});
					if (motion === "granted") {
						sensors = startSensors({
							declinationOverride: getFlag("liveDeclination") ?? null,
							onSample: (s) => history.push(s),
						});
						cleanups.push(() => sensors?.dispose());
					}
					patch({ message: "Camera", camera: "asking" });
					const opened = await openCamera(video);
					if (!opened.ok) {
						patch({
							camera: opened.reason === "denied" ? "denied" : "unavailable",
						});
						return fail(`Camera: ${opened.message}`);
					}
					camera = opened.camera;
					cleanups.push(() => camera?.stop());
					patch({ camera: "ok", message: "Location", location: "asking" });
					location = startLocation({
						onFix: (f) => {
							fix = f;
							sensors?.setPosition(f.lat, f.lon);
							horizonWarmer.offer(f);
						},
						onMoved: (f) => {
							trackerRef.current?.setEye?.(f);
							trackerRef.current?.reset();
							patch({
								message: `Moved over 100 m: re-localising at ${f.lat.toFixed(4)}, ${f.lon.toFixed(4)}`,
							});
						},
						onError: () => patch({ location: "denied" }),
					});
					cleanups.push(() => location?.dispose());
					const deadline = performance.now() + 15000;
					while (!fix && performance.now() < deadline && !cancelled)
						await new Promise((r) => setTimeout(r, 100));
					patch({ location: fix ? "ok" : "denied" });
				}
				if (cancelled) return;

				if (!fix) {
					// no position: the first bundled photo's, so the page still works (flagged in the message)
					const demo = photos[0];
					if (!demo)
						return fail(
							"No location fix, and no bundled place to fall back to",
						);
					fix = {
						lat: demo.lat,
						lon: demo.lon,
						accuracy: 1000,
						time: performance.now(),
					};
					patch({ message: "No location: showing a bundled place" });
				}
				const eye: EyeFix = fix;
				sensors?.setPosition(eye.lat, eye.lon);
				const frameSize = {
					width: video.videoWidth,
					height: video.videoHeight,
				};
				const vfov =
					vfovOverride ??
					replay?.sidecar?.vfov ??
					(camera ? camera.intrinsics() : estimateIntrinsics(frameSize)).vfov;
				patch({ frame: frameSize, message: "Terrain" });

				const targetFps = getFlag("liveFps") ?? 30;
				const maxPixelRatio = Math.min(window.devicePixelRatio || 1, 2);
				const governor = new FrameGovernor({ targetFps, maxPixelRatio });
				const region = nearestRegion(eye, photos);
				const meta: PhotoMeta = makeEyePhoto(
					eye,
					frameSize,
					vfov,
					region ?? "live",
				);
				let engine: LiveEngine;
				let webgpuEngine = false;
				try {
					const made = await createLiveEngine(canvas, meta, {
						pixelRatioCap: maxPixelRatio,
						forceDeck,
					});
					engine = made.engine;
					webgpuEngine = made.backend === "webgpu";
					patch({
						backend: made.backend,
						stepReason: liveStepUnavailableReason(made.backend, made.engine),
					});
				} catch (e) {
					if (forceDeck) throw e;
					console.warn("[live] WebGPU start failed; retrying with WebGL", e);
					setCanvasKey((k) => k + 1); // a canvas that held a WebGPU context cannot give WebGL2
					setTimeout(() => void startRef.current(true), 60);
					return;
				}
				stepContextRef.current = { engine, video };
				cleanups.push(() => engine.dispose());
				if (cancelled) return;
				const regionData = region
					? loadRegion(region).catch(() => null)
					: Promise.resolve(null);
				await engine.init(regionData, (message) => patch({ message }));
				if (cancelled) return;
				engine.setLiveMode(true);
				engine.setLiveSource(video);
				cleanups.push(() => engine.setLiveSource(null));
				const resize = () => {
					const stage = stageRef.current;
					if (stage) engine.resize(stage.clientWidth, stage.clientHeight);
				};
				resize();
				const observer = new ResizeObserver(resize);
				if (stageRef.current) observer.observe(stageRef.current);
				cleanups.push(() => observer.disconnect());

				const loaded = await loadTracker({
					eye,
					vfov,
					gpu: webgpuEngine,
					loadHorizon: horizonWarmer.load,
				});
				trackerRef.current = loaded.tracker;
				cleanups.push(() => loaded.tracker.dispose());
				patch({ realTracker: loaded.real });
				cleanups.push(
					loaded.tracker.onPose((p) => {
						lastPoseRef.current = p;
						if (!lockedRef.current) engine.setPose(p.pose);
						if (p.phase !== lastPhase) {
							lastPhase = p.phase;
							patch({ trackerPhase: p.phase });
						}
					}),
				);
				let lastPhase: TrackerPhase = "init";

				let frames = 0;
				let lastSensor: SensorSample | null = null;
				const sensorAt = (time: number): SensorSample | undefined => {
					const raw = replay ? replay.sample(video, time) : history.at(time);
					if (!raw) return undefined;
					lastSensor = raw;
					const offset = yawOffsetRef.current;
					return offset && raw.yaw != null
						? { ...raw, yaw: (((raw.yaw + offset) % 360) + 360) % 360 }
						: raw;
				};
				let lastDelivered = performance.now();
				const pump: FramePump = startFramePump({
					video,
					sensorAt,
					accept: (time) => governor.shouldRender(time),
					onFrame: (frame) => {
						governor.markRendered(frame.time);
						frames++;
						if (governor.record(frame.time - lastDelivered, frame.time)) {
							const g = governor.state;
							engine.setPixelRatioCap(g.maxPixelRatio);
							patch({ thermal: g.thermal, pixelRatio: g.maxPixelRatio });
						}
						lastDelivered = frame.time;
						loaded.tracker.pushFrame(frame);
					},
				});
				cleanups.push(() => pump.stop());

				let lastLabels = 0;
				cleanups.push(
					engine.onRender(() => {
						const now = performance.now();
						if (now - lastLabels < LABEL_INTERVAL_MS) return;
						lastLabels = now;
						setLabels(
							engine
								.peakLabels(MAX_LABELS, { declutter: true })
								.filter((l) => l.visible),
						);
					}),
				);
				let fpsStart = performance.now();
				let fpsFrames = 0;
				const timer = setInterval(() => {
					const now = performance.now();
					const fps = ((frames - fpsFrames) * 1000) / (now - fpsStart);
					fpsStart = now;
					fpsFrames = frames;
					patch({
						fps,
						compassAccuracy: lastSensor?.yawAccuracy ?? null,
						sensorKind: replay ? "replay" : (sensors?.kind ?? "none"),
					});
				}, 1000);
				cleanups.push(() => clearInterval(timer));
				patch({ phase: "running", message: "" });
			} catch (e) {
				if (!cancelled) fail((e as Error)?.message ?? String(e));
			}
		},
		[patch, stop],
	);
	const startRef = useRef(start);
	startRef.current = start;

	const toggleLock = useCallback(() => {
		lockedRef.current = !lockedRef.current;
		patch({ locked: lockedRef.current });
	}, [patch]);
	const setCalibrating = useCallback(
		(on: boolean) => patch({ calibrating: on }),
		[patch],
	);
	/** Add degrees to the compass heading (drag in calibrate mode). */
	const nudgeYaw = useCallback(
		(deg: number) => {
			yawOffsetRef.current += deg;
			trackerRef.current?.setYawOffset?.(yawOffsetRef.current);
			patch({ yawOffset: yawOffsetRef.current });
		},
		[patch],
	);
	const resetCalibration = useCallback(() => {
		yawOffsetRef.current = 0;
		trackerRef.current?.setYawOffset?.(0);
		patch({ yawOffset: 0 });
	}, [patch]);
	/** Turn live Step Inside (depth to splats on the GPU, WebGPU only) on or off. */
	const setStepInside = useCallback(
		async (on: boolean) => {
			if (!on) {
				stepRef.current?.stop();
				stepRef.current = null;
				return;
			}
			const ctx = stepContextRef.current;
			if (!ctx || stepRef.current) return;
			const step = new LiveStep({
				host: ctx.engine,
				video: ctx.video,
				onState: (state, message) =>
					patch({ step: state, stepMessage: message }),
			});
			stepRef.current = step;
			try {
				await step.start();
			} catch (e) {
				console.warn("[live] Step Inside failed to start", e);
				patch({
					step: "error",
					stepMessage: (e as Error)?.message ?? "Failed",
				});
				step.stop();
				if (stepRef.current === step) stepRef.current = null;
			}
		},
		[patch],
	);
	const relocalise = useCallback(() => trackerRef.current?.reset(), []);

	return {
		status,
		labels,
		canvasKey,
		refs: { canvasRef, videoRef, stageRef },
		start: () => start(false),
		stop,
		toggleLock,
		setCalibrating,
		nudgeYaw,
		resetCalibration,
		relocalise,
		setStepInside,
	};
}
