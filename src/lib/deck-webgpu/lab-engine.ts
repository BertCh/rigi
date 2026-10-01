// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// /lab/deck-webgpu (default mode): the whole WebGPU renderer through WebGpuEngine (engine.ts), i.e.
// every ported layer composed the way PhotoWorkspace would see it:
//   photo view  terrain (batched or per-tile) + terrain styles + trails → the photo compositor
//               (overlay / replace blends, ridges + skyline from layers/ridges.ts, look defines)
//               + DOM peak labels (engine.peakLabels(), CPU projection)
//   world view  orbit camera (three OrbitControls on the canvas) + drape + atmospheric / flat sky
//               + gizmo + trails (+ photo sky / splats / 3D tiles when Step Inside is used)
// The foundation-only lab (terrain + present) is still there with ?core=1 (lab.ts).
//
// Query: ?photo=<id> &host=deck|direct &mode=overlay|replace|world &overlay=contours|bands|slope|none
//        &map=satellite|topo|hillshade|bands &terrain=batched|tiles &debug=geometry|normal|depth
//        &yaw= &pitch= &roll= &vfov= &align=1 &trails=1 &labels=0 &size=<w>x<h> (fixed CSS size)
// Harness: window.__engine (the Renderer, like the app's DEV handle) and
//          window.__deckWebgpuLab { ready, engine: true, host, stats(), frame(), setPose(), … }.
//          document.body gets data-ready once the first geometry readback landed.
import type { Pose } from "#/lib/camera";
import { setFlagOverride } from "#/lib/flags";
import { needsPhotoSky } from "#/lib/look/look-key";
import { getPhoto, loadRegion, loadSavedPose } from "#/lib/photos";
import type { PeakLabel, Settings } from "#/lib/renderer";
import type { WebGpuEngine } from "./engine";
import type { PresentMode } from "./present";

export type EngineLabSearch = {
	photo?: string;
	host?: "deck" | "direct";
	mode?: Settings["mode"];
	overlay?: Settings["overlayStyle"];
	map?: Settings["mapStyle"];
	terrain?: "batched" | "tiles";
	debug?: Exclude<PresentMode, "color">;
	yaw?: number;
	pitch?: number;
	roll?: number;
	vfov?: number;
	align?: boolean;
	trails?: boolean;
	labels?: boolean;
	/** false: skip the people segmentation the app runs on init (and the sky mask) */
	segment?: boolean;
	size?: string;
};

export type EngineLab = {
	engine: WebGpuEngine;
	setSettings(s: Partial<Settings>): void;
	setDebug(v: PresentMode | null): void;
	flyToPhoto(): void;
	dispose(): void;
};

const px = (s: string | undefined) => {
	const m = /^(\d+)x(\d+)$/.exec(s ?? "");
	return m ? { w: +m[1], h: +m[2] } : null;
};

/** Fit a box of `aspect` inside the parent (or use a fixed size); returns the CSS size. */
function fitCanvas(
	canvas: HTMLCanvasElement,
	aspect: number,
	fixed: { w: number; h: number } | null,
) {
	const parent = canvas.parentElement as HTMLElement;
	let w: number;
	let h: number;
	if (fixed) ({ w, h } = fixed);
	else {
		const pw = parent.clientWidth || 1;
		const ph = parent.clientHeight || 1;
		w = Math.min(pw, ph * aspect);
		h = w / aspect;
	}
	w = Math.max(1, Math.round(w));
	h = Math.max(1, Math.round(h));
	Object.assign(canvas.style, {
		inset: "auto",
		left: "50%",
		top: "50%",
		transform: "translate(-50%, -50%)",
		width: `${w}px`,
		height: `${h}px`,
	});
	return { w, h };
}

/** DOM peak labels over the canvas (screen labels are DOM in the app too). */
function drawLabels(layer: HTMLElement, labels: PeakLabel[], show: boolean) {
	layer.replaceChildren();
	if (!show) return;
	for (const l of labels) {
		const el = document.createElement("div");
		el.textContent = `${l.name}${l.ele != null ? ` ${Math.round(l.ele)}` : ""}`;
		el.dataset.peak = l.name;
		Object.assign(el.style, {
			position: "absolute",
			left: `${l.u * 100}%`,
			top: `${l.v * 100}%`,
			transform: "translate(-50%, -100%) translateY(-6px)",
			font: "600 11px system-ui, sans-serif",
			color: "#fff",
			textShadow: "0 1px 2px #000, 0 0 4px #000",
			whiteSpace: "nowrap",
			pointerEvents: "none",
		});
		const tick = document.createElement("div");
		Object.assign(tick.style, {
			position: "absolute",
			left: "50%",
			top: "100%",
			width: "1px",
			height: "6px",
			background: "#fff",
		});
		el.append(tick);
		layer.append(el);
	}
}

export async function startEngineLab(
	canvas: HTMLCanvasElement,
	labelLayer: HTMLElement,
	search: EngineLabSearch,
	setStatus: (s: string) => void,
): Promise<EngineLab> {
	const photo = getPhoto(search.photo ?? "IMG_7086");
	if (!photo) throw new Error(`unknown photo ${search.photo}`);
	// everything set up below is undone by cleanup() (in reverse), both by dispose() and when any
	// step throws (else a failed start would leak the engine / device, the resize listener and the
	// global terrain flag override)
	const cleanups: (() => void)[] = [];
	let cleaned = false;
	const cleanup = () => {
		if (cleaned) return;
		cleaned = true;
		for (const f of cleanups.reverse())
			try {
				f();
			} catch (e) {
				console.warn("[lab] cleanup", e);
			}
	};
	try {
		if (search.terrain) {
			setFlagOverride("terrain", search.terrain);
			cleanups.push(() => setFlagOverride("terrain", undefined));
		}
		const t0 = performance.now();
		const { WebGpuEngine } = await import("./engine");
		const avail = await WebGpuEngine.available();
		if (!avail.ok) {
			setStatus(`WebGPU unavailable: ${avail.reason}`);
			window.__deckWebgpuLab = {
				ready: false,
				host: "none",
				error: avail.reason,
			} as never;
			throw new Error(`WebGPU unavailable: ${avail.reason}`);
		}
		const fixed = px(search.size);
		const aspect = photo.width / photo.height;
		let css = fitCanvas(canvas, aspect, fixed);
		Object.assign(labelLayer.style, {
			position: "absolute",
			left: canvas.style.left,
			top: canvas.style.top,
			transform: canvas.style.transform,
			width: canvas.style.width,
			height: canvas.style.height,
			pointerEvents: "none",
		});
		const engine = new WebGpuEngine(canvas, photo, {
			host: search.host,
			terrain: search.terrain,
		});
		window.__engine = engine;
		cleanups.push(() => {
			engine.dispose();
			if (window.__engine === engine) window.__engine = undefined;
		});
		engine.resize(css.w, css.h);
		const initial: Partial<Settings> = {};
		if (search.overlay) initial.overlayStyle = search.overlay;
		if (search.map) initial.mapStyle = search.map;
		if (search.trails) initial.trails = true;
		if (Object.keys(initial).length) engine.setSettings(initial);
		const saved = loadSavedPose(photo.id);
		const explicit: Partial<Pose> = {};
		for (const k of ["yaw", "pitch", "roll", "vfov"] as const)
			if (search[k] != null) explicit[k] = search[k];
		engine.setPose({ ...(saved ?? engine.prior), ...explicit });

		let firstFrameMs: number | null = null;
		let readyMs: number | null = null;
		let showLabels = search.labels !== false;
		const refreshLabels = () =>
			drawLabels(
				labelLayer,
				engine.settings.mode === "world" ? [] : engine.peakLabels(),
				showLabels,
			);
		let labelRaf = 0;
		const off = engine.onRender(() => {
			if (firstFrameMs == null && engine.stats.terrainTiles > 0)
				firstFrameMs = performance.now() - t0;
			if (!labelRaf)
				labelRaf = requestAnimationFrame(() => {
					labelRaf = 0;
					refreshLabels();
				});
		});
		const onResize = () => {
			css = fitCanvas(canvas, aspect, fixed);
			Object.assign(labelLayer.style, {
				width: canvas.style.width,
				height: canvas.style.height,
			});
			engine.resize(css.w, css.h);
		};
		window.addEventListener("resize", onResize);
		cleanups.push(() => {
			off();
			cancelAnimationFrame(labelRaf);
			window.removeEventListener("resize", onResize);
			showLabels = false;
			labelLayer.replaceChildren();
			delete document.body.dataset.ready;
		});

		const hook = {
			ready: false,
			engine: true,
			host: "pending",
			error: undefined as string | undefined,
			stats: () => ({
				...engine.stats,
				firstFrameMs,
				readyMs,
				pose: engine.pose,
				css,
				metrics: engine.metrics(),
			}),
			frame: async (scope: "all" | "screen" = "all") => {
				const t = performance.now();
				await engine.nextFrame(scope);
				return {
					ms: performance.now() - t,
					...(engine.hostInstance?.stats ?? {}),
				};
			},
			setPose: async (p: Partial<Pose>) => {
				engine.setPose({ ...engine.pose, ...p });
				await engine.nextFrame();
				return engine.pose;
			},
			setView: async (v: PresentMode) => {
				engine.setDebugView(v === "color" ? null : v);
				await engine.nextFrame("screen");
			},
			setSettings: async (s: Partial<Settings>) => {
				engine.setSettings(s);
				await engine.nextFrame();
			},
			labels: () => engine.peakLabels(),
		};
		window.__deckWebgpuLab = hook as never;

		setStatus("loading photo + terrain…");
		// as PhotoWorkspace: people segmentation during init (drape / labels protect people), then the
		// sky mask for the fitted haze
		const seg = search.segment === false ? null : import("#/lib/segment");
		seg?.then((m) => m.preloadSegmenter()).catch(() => {});
		await engine.init(
			loadRegion(photo.region).catch(() => null),
			(msg, frac) => setStatus(`${msg} ${Math.round(frac * 100)}%`),
			seg ? async (img) => (await seg).segmentForeground(img) : undefined,
		);
		const img = engine.photoElement;
		if (seg && img && needsPhotoSky(engine.style))
			import("#/lib/sky")
				.then((m) => m.segmentSky(img))
				.then((mask) => engine.setSkyMask(mask))
				.catch((e) => console.warn("[lab] sky segmentation failed", e));
		if (search.align) {
			setStatus("auto-aligning…");
			const r = await engine.autoAlign(true);
			if (r) engine.setPose(r.pose);
		}
		await engine.readback();
		if (search.mode && search.mode !== "overlay")
			engine.setSettings({ mode: search.mode });
		if (search.debug) engine.setDebugView(search.debug);
		await engine.nextFrame();
		readyMs = performance.now() - t0;
		hook.ready = true;
		hook.host = engine.stats.host ?? "none";
		document.body.dataset.ready = "1";
		refreshLabels();
		setStatus(
			`webgpu engine · ${hook.host} host · ${engine.stats.terrainTiles} tiles · ready ${Math.round(readyMs)} ms`,
		);

		return {
			engine,
			setSettings: (s) => {
				engine.setSettings(s);
				refreshLabels();
			},
			setDebug: (v) => engine.setDebugView(v === "color" ? null : v),
			flyToPhoto: () => engine.flyToPhoto(),
			dispose: cleanup,
		};
	} catch (e) {
		cleanup();
		// the harness polls __deckWebgpuLab.error (the unavailable path set it already)
		const lab = window.__deckWebgpuLab as { error?: string } | undefined;
		if (!lab?.error)
			window.__deckWebgpuLab = {
				ready: false,
				host: "none",
				error: (e as Error)?.message ?? String(e),
			} as never;
		throw e;
	}
}
