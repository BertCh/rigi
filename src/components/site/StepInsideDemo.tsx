// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { Cpu } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Tiles3DCredit } from "#/components/nearfield/Tiles3DCredit";
import type { Pose } from "#/lib/camera";
import type { PhotoMeta } from "#/lib/photos";
import type { Renderer } from "#/lib/renderer";

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
	split: { width: number; height: number; counts: number[]; cls: string };
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

function bytesFromBase64(b64: string): Uint8Array {
	const s = atob(b64);
	const out = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
	return out;
}

export function StepInsideDemo({ className }: { className?: string }) {
	const box = useRef<HTMLDivElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const engineRef = useRef<Renderer | null>(null);
	const [visible, setVisible] = useState(false);
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
		const el = box.current;
		if (!el) return;
		const io = new IntersectionObserver(
			([e]) => e.isIntersecting && setVisible(true),
			{ rootMargin: "200px" },
		);
		io.observe(el);
		return () => io.disconnect();
	}, []);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!visible || !canvas) return;
		let live = true;
		let engine: StepEngine | null = null;
		let raf = 0;
		let clearFlag: (() => void) | null = null;
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
			const [baked, splatBuf, demo, flags, select, splatIo, measure] =
				await Promise.all([
					fetch(`${BASE}/scene.json`).then(
						(r) => r.json() as Promise<BakedStep>,
					),
					fetch(`${BASE}/splats.splat`).then((r) => r.arrayBuffer()),
					import("#/lib/demo").then((d) => d.loadDemo()),
					import("#/lib/flags"),
					import("#/lib/renderer-select"),
					import("#/lib/nearfield/splat-io"),
					import("#/lib/nearfield/measure"),
				]);
			if (!live) return;
			const { registerLocalPhoto } = await import("#/lib/photos");
			// the sample trip's region (Niederhorn) carries this photo's peaks too; its own id, so it never
			// stands in for the original in this tab
			const photo: PhotoMeta = {
				...baked.photo,
				id: "demo-step",
				region: demo.region.id,
			};
			registerLocalPhoto(photo, demo.region);
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
			engine = new Engine(canvas, photo) as unknown as StepEngine;
			engineRef.current = engine;
			engine.resize(canvas.clientWidth, canvas.clientHeight);
			setStage("terrain");
			await engine.init(demo.region);
			if (!live) return;
			engine.setPose(baked.pose);
			if (!(await engine.readback()) || !live) return;
			const splats = splatIo.decodeSplatV1(splatBuf);
			const cls = bytesFromBase64(baked.split.cls);
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
			engine.setNearField?.(scene, { maskDrape: true });
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
			const tick = (now: number) => {
				raf = requestAnimationFrame(tick);
				const cam = engine?.stepCamera;
				if (!cam || cam.mode !== "photo") return;
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
			ro.disconnect();
			canvas.removeEventListener("pointerdown", focus);
			canvas.removeEventListener("pointerdown", onInput);
			canvas.removeEventListener("keydown", onInput);
			engine?.exitStepInside();
			engine?.dispose();
			engineRef.current = null;
			clearFlag?.();
			setStepping(false);
		};
	}, [visible]);

	const ready = stage === "ready";
	return (
		<div
			ref={box}
			className={`relative overflow-hidden bg-[var(--rigi-slate)] ${className ?? ""}`}
			data-testid="step-inside-demo"
			data-stage={stage ?? ""}
		>
			<img
				src={`${BASE}/photo.jpg`}
				alt="A hiker on Niederhorn above Lake Thun, the Bernese Alps behind"
				className={`absolute inset-0 size-full object-contain transition-opacity duration-700 ${ready ? "opacity-0" : "opacity-100"}`}
			/>
			<canvas
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
	);
}
