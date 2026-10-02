// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { Cpu } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Tiles3DCredit } from "#/components/nearfield/Tiles3DCredit";
import type { Pose } from "#/lib/camera";
import type { PhotoMeta } from "#/lib/photos";
import type { Renderer } from "#/lib/renderer";
import { LiveLines } from "./LiveLines";
import { type Lines, viewOfCamera } from "./lineArt";
import { useLiveEmbed } from "./liveSlot";

// Landing-page Step Inside: a photo from the sample trip (IMG_7086, Niederhorn) with its near field
// baked by scripts/demo/bake-step.mjs (the anchored splats and the depth split the Step Inside button
// builds through the near-field service), so the page needs no service. The live engine steps inside
// at the photo camera and sways slowly about the near-field pivot until someone drags; Google
// Photorealistic 3D Tiles (src/lib/tiles3d, display only) fill the view beyond the photo frame.
// Started only once the section scrolls into view; the photo itself is the poster (the step camera
// starts exactly on it).

const BASE = "/demo/step";

type BakedStep = {
	photoId: string;
	photo: PhotoMeta;
	pose: Pose;
	anchor: import("#/lib/nearfield/types").AnchorFit;
	// the class grid (width x height bytes) is the sidecar cls.bin
	split: { width: number; height: number; counts: number[] };
	confidenceRadius: number;
	model?: string;
	medianObjectRange: number | null;
};

type StepEngine = Renderer & {
	enterStepInside(
		o: import("#/lib/nearfield/step-camera").StepInsideOpts,
	): void;
	exitStepInside(): void;
	readonly stepCamera: import("#/lib/nearfield/step-camera").StepCamera | null;
};

/** Landing budget, as LiveRollMap's: sway redraws per second and the device pixel ratio cap. */
const STEP_FPS = 30;
const STEP_PIXEL_RATIO = 1.5;
/** Sway (photo-mode orbit about the pivot): amplitude (deg) and period (s). */
const SWAY_YAW = 22;
const SWAY_PITCH = 3;
const SWAY_S = 16;
/** Seconds after the last drag before the sway resumes. */
const RESUME_S = 8;

const STAGE: Record<string, string> = {
	load: "Loading the scene",
	terrain: "Streaming terrain",
	ready: "Live · drag to look around",
};

export function StepInsideDemo({ className }: { className?: string }) {
	// starts near the viewport (200 px); far away for a few seconds, or off screen while another live
	// embed is showing (liveSlot.ts), the engine is disposed (its GPU context freed) and the photo
	// poster shows again
	const box = useRef<HTMLDivElement>(null);
	const { live: visible } = useLiveEmbed("step", 200, { ref: box });
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const engineRef = useRef<StepEngine | null>(null);
	// a fresh <canvas> per engine: a released canvas keeps its old context type
	const [generation, setGeneration] = useState(0);
	const started = useRef(false);
	const [stage, setStage] = useState<string | null>(null);
	const [stepping, setStepping] = useState(false);

	// the wheel scrolls the page (no dolly); drag still looks around (LiveRollMap's rule). The step
	// camera's keys listen on window: keep them (arrows, space, Esc) for the page unless the demo has
	// focus (a click on it), so keyboard scrolling still works
	useEffect(() => {
		const el = box.current;
		if (!el) return;
		const stop = (e: WheelEvent) => e.stopPropagation();
		const keys = (e: KeyboardEvent) => {
			if (!el.contains(document.activeElement)) e.stopImmediatePropagation();
		};
		el.addEventListener("wheel", stop, { capture: true, passive: true });
		window.addEventListener("keydown", keys, { capture: true });
		window.addEventListener("keyup", keys, { capture: true });
		return () => {
			el.removeEventListener("wheel", stop, { capture: true });
			window.removeEventListener("keydown", keys, { capture: true });
			window.removeEventListener("keyup", keys, { capture: true });
		};
	}, []);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!visible || !canvas) return;
		let live = true;
		let engine: StepEngine | null = null;
		let raf = 0;
		let clearFlag: (() => void) | null = null;
		let releaseSeed: (() => void) | null = null;
		let stopWatch: (() => void) | null = null;
		let lastInput = Number.NEGATIVE_INFINITY;
		const onInput = () => {
			lastInput = performance.now();
		};
		const focus = () => canvas.focus({ preventScroll: true });
		canvas.addEventListener("pointerdown", focus);
		canvas.addEventListener("pointerdown", onInput);
		canvas.addEventListener("keydown", onInput);
		setStage("load");
		(async () => {
			const [baked, splatBuf, clsBuf, demo, flags, select, splatIo, measure] =
				await Promise.all([
					fetch(`${BASE}/scene.json`).then(
						(r) => r.json() as Promise<BakedStep>,
					),
					fetch(`${BASE}/splats.splat`).then((r) => r.arrayBuffer()),
					fetch(`${BASE}/cls.bin`).then((r) => r.arrayBuffer()),
					// the step view draws no trails (settings.trails is off): skip trails.json (~2.7 MB)
					import("#/lib/demo").then((d) => d.loadDemoCore()),
					import("#/lib/flags"),
					import("#/lib/renderer-select"),
					import("#/lib/nearfield/splat-loaders"),
					import("#/lib/nearfield/measure"),
				]);
			if (!live) return;
			const { registerLocalPhoto } = await import("#/lib/photos");
			// the sample trip's region (Niederhorn) carries this photo's peaks too. The photo and the region
			// get their own ids, so neither stands in for the original in this tab: the core manifest's
			// region has no trails, and registering it under the shared id would leave the demo photos
			// trail-less if one is opened later
			const region = { ...demo.region, id: `${demo.region.id}-step` };
			const photo: PhotoMeta = {
				...baked.photo,
				id: "demo-step",
				region: region.id,
			};
			registerLocalPhoto(photo, region);
			// tiles3d is read when the engine is built (tiles3d/config.ts): Google for this engine only,
			// unless the page URL already chose a source. Google tiles are billed per load: automated
			// browsers skip them (useStepInside's webdriver rule) unless ?tiles3d= asks
			if (!flags.flagSet("tiles3d") && !navigator.webdriver) {
				flags.setFlagOverride("tiles3d", "google");
				clearFlag = () => flags.setFlagOverride("tiles3d", undefined);
			}
			const choice = await select.resolveRenderer();
			const Engine =
				choice.renderer === "webgpu"
					? (await import("#/lib/deck-webgpu/engine")).WebGpuEngine
					: (await import("#/lib/deck/engine")).DeckEngine;
			if (!live) return;
			// the same budget as the live map above (LiveRollMap): at most 1.5x device pixels, 30 fps sway
			// far and context DEM tiles from the live map's baked terrain (about half the tiles this pose
			// streams; the near field still needs the full-size tiles): one shared decode, usually from
			// the HTTP cache since the live map sits just above
			const [{ demoTerrainSeed }, { seededTileLoader }] = await Promise.all([
				import("#/lib/demo/roll-map-seed"),
				import("#/lib/deck/seeded-tiles"),
			]);
			if (!live) return;
			const held = demoTerrainSeed.acquire();
			releaseSeed = held.release;
			const seed = held.seed.catch(() => null);
			engine = new Engine(canvas, photo, {
				pixelRatioCap: STEP_PIXEL_RATIO,
				terrainTileWrap: (base) => async (key, seg, o) => {
					const map = await seed;
					return map
						? seededTileLoader(map, base)(key, seg, o)
						: base(key, seg, o);
				},
			}) as unknown as StepEngine;
			engineRef.current = engine;
			engine.resize(canvas.clientWidth, canvas.clientHeight);
			setStage("terrain");
			await engine.init(region);
			if (!live) return;
			engine.setPose(baked.pose);
			if (!(await engine.readback()) || !live) return;
			let splats = splatIo.SplatV1Loader.parseSync(splatBuf);
			// ?nearfield=complete (experiment): close the person into a volume (complete/people.ts). Segments the
			// photo with the people model, so the default landing never downloads it
			if (flags.getFlag("nearfield") === "complete") {
				const [{ segmentForeground }, complete, geom] = await Promise.all([
					import("#/lib/segment"),
					import("#/lib/nearfield/complete"),
					import("#/lib/nearfield/geom"),
				]);
				const img = new Image();
				img.src = baked.photo.src;
				await img.decode();
				const mask = await segmentForeground(img);
				if (!live) return;
				if (mask) {
					const input = {
						cloud: splats,
						pose: baked.pose,
						eye: { ...engine.eye },
						K: geom.intrinsicsFromPose(baked.pose, engine.aspect),
						aspect: engine.aspect,
						peopleMask: mask,
					};
					// ?peopleBody=on: the back comes from a body fit (ViTPose on nn + Anny, src/lib/body); the
					// inflation-only pass gives the person boxes. A failure keeps the inflation
					let backDepth:
						| import("#/lib/nearfield/complete").BackDepthProvider
						| null = null;
					if (flags.getFlag("peopleBody") === "on") {
						try {
							const [body, { getNn }, { imageToRGBA }] = await Promise.all([
								import("#/lib/body/back-depth"),
								import("#/lib/nn"),
								import("#/lib/nearfield/scene"),
							]);
							// GPU only: ViTPose never runs on the page thread's CPU (no WebGPU: keep the inflation)
							const nn = await getNn("body");
							const first = complete.completePeople(input);
							const image = nn && imageToRGBA(img, 2048);
							if (nn && image && first.instances.length)
								backDepth = (
									await body.prepareBodyBackDepth({
										nn,
										image,
										boxes: body.boxesFromInstances(
											first.instances,
											first.gridWidth,
											first.gridHeight,
										),
									})
								).backDepth;
						} catch (err) {
							console.warn("[step demo] body fit failed", err);
						}
						if (!live) return;
					}
					splats = complete.applyPeopleCompletion(input, { backDepth }).splats;
				}
			}
			const cls = new Uint8Array(clsBuf);
			const scene: import("#/lib/nearfield/measure").MeasurableScene = {
				photoId: photo.id,
				anchor: baked.anchor,
				split: { ...baked.split, cls },
				splats,
				confidenceRadius: baked.confidenceRadius,
				model: baked.model,
			};
			const ctx = {
				pose: { ...engine.pose },
				aspect: engine.aspect,
				eye: { ...engine.eye },
				frame: engine.frame,
			};
			scene.measure = { ...measure.buildMeasureGrid(scene, ctx), ...ctx };
			engine.setNearField(scene, { maskDrape: true });
			engine.enterStepInside({
				radius: scene.confidenceRadius,
				pivotDist: baked.medianObjectRange
					? Math.min(Math.max(baked.medianObjectRange, 3), 300)
					: undefined,
				// Esc / back: stay inside (there is no photo view to return to here)
				onBack: () => {},
			});
			setStepping(true);
			setStage("ready");
			const still =
				navigator.webdriver ||
				window.matchMedia("(prefers-reduced-motion: reduce)").matches;
			if (still) return;
			// the sway: a slow figure on the photo-mode orbit, paused while someone drives
			let shown = { a: 0, b: 0 };
			let t0 = performance.now();
			let lastSway = Number.NEGATIVE_INFINITY;
			// the sway is the only thing redrawing: stop it offscreen or in a hidden tab, restart from the
			// camera's current pose (t0 reset, ramped in) on return
			let onScreen = true;
			let running = true;
			const sync = () => {
				const want = onScreen && !document.hidden;
				if (want === running) return;
				running = want;
				if (want) {
					shown = { a: 0, b: 0 };
					t0 = performance.now();
					raf = requestAnimationFrame(tick);
				} else {
					cancelAnimationFrame(raf);
				}
			};
			const tick = (now: number) => {
				if (!running) return;
				raf = requestAnimationFrame(tick);
				const cam = engine?.stepCamera;
				if (!cam || cam.mode !== "photo") return;
				if (now - lastSway < 1000 / STEP_FPS - 2) return;
				lastSway = now;
				if (now - lastInput < RESUME_S * 1000) {
					// someone moved the camera: restart the sway from wherever they left it
					shown = { a: 0, b: 0 };
					t0 = now;
					return;
				}
				const t = ((now - t0) / 1000 / SWAY_S) * 2 * Math.PI;
				// ease in over the first quarter period so a resume does not jump
				const ramp = Math.min(1, (now - t0) / (SWAY_S * 250));
				const want = {
					a: ramp * SWAY_YAW * Math.sin(t),
					b: ramp * SWAY_PITCH * Math.sin(2 * t),
				};
				cam.orbit(want.a - shown.a, want.b - shown.b);
				shown = want;
			};
			raf = requestAnimationFrame(tick);
			if (!live) return;
			const vio = new IntersectionObserver(([e]) => {
				onScreen = e.isIntersecting;
				sync();
			});
			vio.observe(canvas);
			document.addEventListener("visibilitychange", sync);
			stopWatch = () => {
				vio.disconnect();
				document.removeEventListener("visibilitychange", sync);
			};
		})().catch((e) => {
			console.warn("[step demo]", e);
			if (live) setStage(null);
		});
		const ro = new ResizeObserver(() => {
			if (canvas.clientWidth && canvas.clientHeight)
				engine?.resize(canvas.clientWidth, canvas.clientHeight);
		});
		ro.observe(canvas);
		return () => {
			live = false;
			cancelAnimationFrame(raf);
			stopWatch?.();
			ro.disconnect();
			canvas.removeEventListener("pointerdown", focus);
			canvas.removeEventListener("pointerdown", onInput);
			canvas.removeEventListener("keydown", onInput);
			engine?.exitStepInside();
			engine?.dispose();
			engineRef.current = null;
			clearFlag?.();
			releaseSeed?.();
			setStepping(false);
		};
	}, [visible]);

	useEffect(() => {
		if (visible) {
			started.current = true;
		} else if (started.current) {
			started.current = false;
			setGeneration((g) => g + 1);
			setStage(null);
		}
	}, [visible]);

	const ready = stage === "ready";
	// the sides: the photo's ridgelines through the step camera (at the photo's pose until it is up)
	const stepView = (lines: Lines) => {
		const cam = ready ? engineRef.current?.stepCamera?.camera : null;
		return cam
			? viewOfCamera(cam.position, cam.quaternion, cam.fov)
			: (lines.rest ?? null);
	};
	return (
		<div className="relative isolate">
			<LiveLines
				src="/demo/surround/step-lines.bin"
				getView={stepView}
				className="-z-10"
			/>
			<div
				ref={box}
				data-theme="dark"
				className={`relative overflow-hidden bg-[var(--rigi-slate)] ${className ?? ""}`}
				data-testid="step-inside-demo"
				data-stage={stage ?? ""}
			>
				<img
					src={`${BASE}/photo.jpg`}
					loading="lazy"
					decoding="async"
					alt="A hiker on Niederhorn above Lake Thun, the Bernese Alps behind"
					className={`absolute inset-0 size-full object-contain transition-opacity duration-700 ${ready ? "opacity-0" : "opacity-100"}`}
				/>
				<canvas
					key={generation}
					ref={canvasRef}
					tabIndex={-1}
					className={`absolute inset-0 size-full !touch-pan-y outline-none transition-opacity duration-700 ${ready ? "opacity-100" : "opacity-0"}`}
				/>
				<div className="pointer-events-none absolute top-3 left-3 flex items-center gap-2 rounded-lg bg-black/55 px-2.5 py-1.5 text-[11px] text-white/80 backdrop-blur">
					<Cpu className="size-3.5 text-[var(--rigi-glow)]" />
					{stage ? STAGE[stage] : "Live 3D, rendered locally"}
				</div>
				<Tiles3DCredit engineRef={engineRef} stepping={stepping} />
			</div>
		</div>
	);
}
