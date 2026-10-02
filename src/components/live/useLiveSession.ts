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
import {
	createRebuildScheduler,
	type RebuildRequest,
	type RebuildScheduler,
} from "#/lib/live/eye-rebuild";
import {
	createMoveDetector,
	type LocationFeed,
	startLocation,
} from "#/lib/live/geolocation";
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
/** how long a rebuilt engine may take to show its first terrain before the swap goes ahead anyway */
const REBUILD_TERRAIN_TIMEOUT_MS = 8000;

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
				// a moved eye: the tracker re-localises now, the engine is rebuilt by maybeRebuild (below)
				let scheduler: RebuildScheduler | null = null;
				const onMoved = (f: EyeFix) => {
					trackerRef.current?.setEye?.(f);
					trackerRef.current?.reset();
					scheduler?.offer(f);
					patch({
						message: `Moved over 100 m: re-localising at ${f.lat.toFixed(4)}, ${f.lon.toFixed(4)}`,
					});
				};

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
						onMoved: (f) => onMoved(f),
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
				let usedDeck = forceDeck;
				try {
					const made = await createLiveEngine(canvas, meta, {
						pixelRatioCap: maxPixelRatio,
						forceDeck,
					});
					engine = made.engine;
					webgpuEngine = made.backend === "webgpu";
					usedDeck = made.backend === "deck";
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
				let regionData = region
					? loadRegion(region).catch(() => null)
					: Promise.resolve(null);
				await engine.init(regionData, (message) => patch({ message }));
				if (cancelled) return;
				scheduler = createRebuildScheduler(eye, photos);
				const resize = (target: LiveEngine = engine) => {
					const stage = stageRef.current;
					if (stage) target.resize(stage.clientWidth, stage.clientHeight);
				};
				// everything that is attached to one engine, so a rebuilt engine can take it over
				let lastLabels = 0;
				const bindEngine = (target: LiveEngine) => {
					target.setLiveMode(true);
					target.setLiveSource(video);
					resize(target);
					const unsubscribe = target.onRender(() => {
						const now = performance.now();
						if (now - lastLabels < LABEL_INTERVAL_MS) return;
						lastLabels = now;
						setLabels(
							target
								.peakLabels(MAX_LABELS, { declutter: true })
								.filter((l) => l.visible),
						);
					});
					return () => {
						unsubscribe();
						target.setLiveSource(null);
					};
				};
				let unbindEngine = bindEngine(engine);
				cleanups.push(() => unbindEngine());
				const observer = new ResizeObserver(() => resize());
				if (stageRef.current) observer.observe(stageRef.current);
				cleanups.push(() => observer.disconnect());

				// Rebuild at a moved eye: the new engine is built on a second canvas stacked over the old one
				// (a canvas that held a WebGPU context cannot be handed to another engine, and a fresh element
				// has no such history), the old engine keeps rendering until the new one has its first terrain,
				// then the new canvas is shown and the old engine disposed. Live source, mode, pixel-ratio cap,
				// the pose and the Step Inside session move over; Step Inside refits for the new eye.
				const originalCanvas = canvas;
				let activeCanvas = canvas;
				let extraCanvas: HTMLCanvasElement | null = null;
				cleanups.push(() => {
					extraCanvas?.remove();
					originalCanvas.style.opacity = "";
				});
				const rebuildEngine = async (request: RebuildRequest) => {
					const stage = stageRef.current;
					if (!stage) throw new Error("no stage");
					const fresh = document.createElement("canvas");
					fresh.className = activeCanvas.className;
					fresh.style.opacity = "0";
					activeCanvas.after(fresh);
					let next: LiveEngine | null = null;
					try {
						const nextMeta = makeEyePhoto(
							request.eye,
							frameSize,
							vfov,
							request.region ?? "live",
						);
						const made = await createLiveEngine(fresh, nextMeta, {
							pixelRatioCap: governor.state.maxPixelRatio,
							forceDeck: forceDeck || usedDeck,
						});
						next = made.engine;
						if (cancelled) throw new Error("stopped");
						if (request.regionChanged)
							regionData = request.region
								? loadRegion(request.region).catch(() => null)
								: Promise.resolve(null);
						await next.init(regionData, () => {});
						if (cancelled) throw new Error("stopped");
						next.setLiveMode(true);
						next.setLiveSource(video);
						resize(next);
						if (lastPoseRef.current) next.setPose(lastPoseRef.current.pose);
						// first terrain: sampleAt / labels describe the pose, then one painted frame
						await Promise.race([
							next.readback(),
							new Promise((r) => setTimeout(r, REBUILD_TERRAIN_TIMEOUT_MS)),
						]);
						await new Promise<void>((resolve) => {
							const off = next?.onRender(() => {
								off?.();
								resolve();
							});
							setTimeout(resolve, 1000);
						});
						if (cancelled) throw new Error("stopped");
						// swap: from here every closure that reads `engine` talks to the new one
						const old = engine;
						const oldCanvas = activeCanvas;
						unbindEngine();
						engine = next;
						webgpuEngine = made.backend === "webgpu";
						usedDeck = made.backend === "deck";
						unbindEngine = bindEngine(next);
						fresh.style.opacity = "";
						activeCanvas = fresh;
						if (oldCanvas === originalCanvas)
							originalCanvas.style.opacity = "0";
						else oldCanvas.remove();
						extraCanvas = fresh;
						stepContextRef.current = { engine: next, video };
						stepRef.current?.attachHost(next);
						old.dispose();
						patch({ backend: made.backend });
					} catch (e) {
						next?.dispose();
						fresh.remove();
						throw e;
					}
				};
				const maybeRebuild = () => {
					const request = scheduler?.next(performance.now());
					if (!scheduler || !request) return;
					const owner = scheduler;
					patch({ message: "Moved: rebuilding the terrain" });
					rebuildEngine(request)
						.then(() => {
							owner.complete(request, performance.now());
							patch({ message: "" });
						})
						.catch((e) => {
							owner.fail(performance.now());
							if (!cancelled) console.warn("[live] engine rebuild failed", e);
							patch({ message: "" });
						});
				};

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

				let fpsStart = performance.now();
				let fpsFrames = 0;
				// a replay clip with an eye track feeds fixes through the same move detector the GPS uses
				const replayMoves = replay?.sidecar?.eyes ? createMoveDetector() : null;
				const timer = setInterval(() => {
					const now = performance.now();
					if (replay && replayMoves) {
						const f = replay.eyeAt(video, now);
						if (f) {
							fix = f;
							horizonWarmer.offer(f);
							if (replayMoves.update(f)) onMoved(f);
						}
					}
					maybeRebuild();
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
