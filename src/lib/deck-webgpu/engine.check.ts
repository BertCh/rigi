// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// In-browser check for engine.ts (WebGpuEngine) on a real photo, no lab wiring needed. It creates
// the engine on its own canvas, runs init() (terrain streaming, region, horizon), and checks the
// Renderer surface end to end:
//   queries     readback() → geometryReady, sampleAt over a grid, and each sample's ENU point
//               re-projected through the CPU camera (projectToPhoto) lands on its own texel
//               (row order + camera math), skyline, peak labels
//   frames      a composite-only setting (lens) takes a "screen" frame, a style change an "all"
//               frame; replace mode renders
//   world       mode 'world' switches the colour camera to the orbit camera; the world export is a
//               PNG whose top rows are sky (not black)
//   export      exportImage() (photo view) is a JPEG at the photo's size with varied content
//   device loss simulateDeviceLoss() rebuilds host + cores; queries work again, same ranges
//   parity      (opts.parity) the WebGL DeckEngine on a second canvas, same photo and pose:
//               sampleAt ranges, peak label names and the exported overlay image compared
// Run from any page served by vite (the dev server on :3100), e.g.:
//   await page.evaluate(async () =>
//     (await import("/src/lib/deck-webgpu/engine.check.ts")).runEngineCheck({ photo: "IMG_7086" }))
// The engine's canvas stays on the page (top-left, 960×640) until the check ends; pass keep: true
// to leave it (window.__webgpuEngineCheck) for screenshots.
import type { Pose } from "#/lib/camera";
import { getPhoto, loadRegion } from "#/lib/photos";
import type { Renderer } from "#/lib/renderer";
import { WebGpuEngine } from "./engine";

export type EngineCheckOptions = {
	photo?: string;
	host?: "deck" | "direct";
	/** Load the region (peaks, trails). Default true. */
	region?: boolean;
	/** Compare against the WebGL DeckEngine. Default false. */
	parity?: boolean;
	/** Keep the engine + canvas alive afterwards (window.__webgpuEngineCheck). */
	keep?: boolean;
	/** Skip the device-loss step. */
	noLoss?: boolean;
	/** Override the pose (default: the photo prior). */
	pose?: Partial<Pose>;
};

declare global {
	interface Window {
		__webgpuEngineCheck?: WebGpuEngine;
	}
}

const W = 960;
const H = 640;

function mkCanvas(left: number) {
	const c = document.createElement("canvas");
	c.style.cssText = `position:fixed;left:${left}px;top:0;width:${W}px;height:${H}px;z-index:9999`;
	document.body.appendChild(c);
	return c;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function decode(blob: Blob, w: number) {
	const bmp = await createImageBitmap(blob);
	const h = Math.round((w * bmp.height) / bmp.width);
	const c = new OffscreenCanvas(w, h);
	const ctx = c.getContext("2d") as OffscreenCanvasRenderingContext2D;
	ctx.drawImage(bmp, 0, 0, w, h);
	const full = { width: bmp.width, height: bmp.height };
	bmp.close();
	return { ...full, w, h, data: ctx.getImageData(0, 0, w, h).data };
}

function stddev(d: Uint8ClampedArray) {
	let s = 0;
	let s2 = 0;
	const n = d.length / 4;
	for (let i = 0; i < d.length; i += 4) {
		const l = (d[i] + d[i + 1] + d[i + 2]) / 3;
		s += l;
		s2 += l * l;
	}
	return Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2));
}

/** Samples on a grid (normalised coords, v down). */
function grid(nx: number, ny: number) {
	const out: [number, number][] = [];
	for (let j = 0; j < ny; j++)
		for (let i = 0; i < nx; i++) out.push([(i + 0.5) / nx, (j + 0.5) / ny]);
	return out;
}

function ranges(e: Renderer, pts: [number, number][]) {
	return pts.map(([u, v]) => e.sampleAt(u, v)?.range ?? null);
}

export async function runEngineCheck(o: EngineCheckOptions = {}) {
	const fails: string[] = [];
	const expect = (cond: boolean, msg: string) => {
		if (!cond) fails.push(msg);
	};
	const avail = await WebGpuEngine.available();
	if (!avail.ok) return { ok: false, fails: [`webgpu: ${avail.reason}`] };
	const id = o.photo ?? "IMG_7086";
	const photo = getPhoto(id);
	if (!photo) return { ok: false, fails: [`unknown photo ${id}`] };
	const out: Record<string, unknown> = { photo: id, adapter: avail.adapter };
	const errors: string[] = [];
	const onErr = (e: ErrorEvent | PromiseRejectionEvent) =>
		errors.push(String("reason" in e ? e.reason : e.message).slice(0, 300));
	window.addEventListener("error", onErr);
	window.addEventListener("unhandledrejection", onErr);

	const canvas = mkCanvas(0);
	const engine = new WebGpuEngine(canvas, photo, { host: o.host });
	window.__webgpuEngineCheck = engine;
	let emitted = 0;
	engine.onRender(() => emitted++);
	let webgl: (Renderer & { dispose(): void }) | null = null;
	let glCanvas: HTMLCanvasElement | null = null;
	try {
		engine.resize(W, H);
		const region =
			o.region === false ? null : loadRegion(photo.region).catch(() => null);
		const t0 = performance.now();
		await engine.init(region);
		out.initMs = Math.round(performance.now() - t0);
		if (o.pose) engine.setPose({ ...engine.pose, ...o.pose });
		const tr = performance.now();
		const fresh = await engine.readback();
		out.readbackMs = Math.round(performance.now() - tr);
		expect(fresh && engine.geometryReady(), "readback → geometryReady");
		out.host = engine.stats.host;
		out.stats = engine.stats;

		// ---- queries: samples + re-projection of their ENU points
		const pts = grid(24, 16);
		let hits = 0;
		let maxErrPx = 0;
		for (const [u, v] of pts) {
			const s = engine.sampleAt(u, v);
			if (!s) continue;
			hits++;
			const p = engine.projectToPhoto(s.world);
			if (!p) continue;
			// the sample is the texel under (u, v) of the 1024 px geometry buffer: ≤ ~1 texel away
			const err = Math.hypot(p.u - u, p.v - v) * 1024;
			maxErrPx = Math.max(maxErrPx, err);
		}
		out.samples = { hits, of: pts.length, maxErrPx: +maxErrPx.toFixed(3) };
		expect(hits > pts.length * 0.2, `sampleAt hits ${hits}/${pts.length}`);
		expect(maxErrPx <= 1.5, `sample re-projection ${maxErrPx.toFixed(2)} px`);
		const sky = engine.skyline();
		out.skyline = sky
			? { columns: sky.length, mid: sky[sky.length >> 1] }
			: null;
		expect(!!sky && sky.length > 100, "skyline");
		const labels = engine.peakLabels();
		out.labels = labels.slice(0, 12).map((l) => l.name);
		out.peaksInFrame = engine.peaksInFrame().length;
		if (o.region !== false)
			expect(engine.stats.peaks > 0, "region peaks loaded");

		// ---- frames: composite-only vs full
		await engine.nextFrame();
		const m0 = engine.metrics().engine;
		engine.setSettings({ lens: [0.31, 0.37] });
		await wait(50);
		await engine.nextFrame("screen");
		const m1 = engine.metrics().engine;
		out.compositeOnly = {
			screen: m1.framesScreen - m0.framesScreen,
			all: m1.framesAll - m0.framesAll,
		};
		expect(
			m1.framesScreen > m0.framesScreen && m1.framesAll === m0.framesAll,
			"lens change = screen frame only",
		);
		engine.setSettings({ mode: "replace", mapStyle: "hillshade" });
		await engine.nextFrame();
		engine.setSettings({ mode: "overlay" });
		await engine.nextFrame();
		expect(emitted > 0, "onRender listeners fire");

		// ---- photo export
		const te = performance.now();
		const jpg = await engine.exportImage(false);
		out.exportMs = Math.round(performance.now() - te);
		if (jpg) {
			const d = await decode(jpg, 480);
			out.export = {
				bytes: jpg.size,
				size: [d.width, d.height],
				std: +stddev(d.data).toFixed(1),
			};
			expect(
				d.width === photo.width && d.height === photo.height,
				"export at photo size",
			);
			expect(stddev(d.data) > 10, "export has content");
		} else fails.push("exportImage (photo) returned null");

		// ---- world view
		engine.setSettings({ mode: "world" });
		await wait(300);
		await engine.nextFrame();
		const host = engine.hostInstance;
		out.world = {
			view: engine.stats.view,
			viewEye: host?.view.eye,
			photoEye: host?.photo.eye,
		};
		expect(engine.stats.view === "world", "world view on");
		expect(
			!!host && host.view.eye[2] > host.photo.eye[2] + 500,
			"world camera above the photographer",
		);
		const png = await engine.exportImage();
		if (png) {
			const d = await decode(png, 240);
			let top = 0;
			for (let x = 0; x < d.w; x++) {
				const i = x * 4;
				top += d.data[i] + d.data[i + 1] + d.data[i + 2];
			}
			top /= d.w * 3;
			(out.world as Record<string, unknown>).topRowMean = +top.toFixed(1);
			expect(top > 60, `world export top row is sky (${top.toFixed(0)})`);
		} else fails.push("exportImage (world) returned null");
		engine.setSettings({ mode: "overlay" });
		await engine.nextFrame();
		expect(engine.stats.view === "photo", "back to the photo view");

		// ---- device loss
		if (!o.noLoss) {
			const before = ranges(engine, pts);
			engine.simulateDeviceLoss();
			let restored = false;
			for (let i = 0; i < 100 && !restored; i++) {
				await wait(100);
				restored = engine.metrics().engine.contextRestored > 0;
			}
			expect(restored, "device rebuilt after loss");
			const again = restored && (await engine.readback());
			expect(!!again, "readback after device loss");
			const after = ranges(engine, pts);
			let same = 0;
			let n = 0;
			for (let i = 0; i < pts.length; i++) {
				const a = before[i];
				const b = after[i];
				if (a == null && b == null) continue;
				n++;
				if (a != null && b != null && Math.abs(a - b) <= a * 0.001 + 0.5)
					same++;
			}
			out.deviceLoss = { restored, same, of: n };
			expect(n > 0 && same / n > 0.98, `ranges after loss ${same}/${n}`);
		}

		// ---- parity against the WebGL DeckEngine
		if (o.parity) {
			const { DeckEngine } = await import("#/lib/deck/engine");
			glCanvas = mkCanvas(W + 8);
			const gl = new DeckEngine(glCanvas, photo);
			webgl = gl;
			gl.resize(W, H);
			await gl.init(
				o.region === false ? null : loadRegion(photo.region).catch(() => null),
			);
			gl.setPose({ ...engine.pose });
			await gl.readback();
			await engine.readback();
			const a = ranges(engine, pts);
			const b = ranges(gl, pts);
			const rel: number[] = [];
			let skyMismatch = 0;
			for (let i = 0; i < pts.length; i++) {
				if ((a[i] == null) !== (b[i] == null)) skyMismatch++;
				else if (a[i] != null && b[i] != null)
					rel.push(
						Math.abs((a[i] as number) - (b[i] as number)) / (b[i] as number),
					);
			}
			rel.sort((x, y) => x - y);
			const la = new Set(engine.peakLabels().map((l) => l.name));
			const lb = new Set(gl.peakLabels().map((l) => l.name));
			const common = [...la].filter((x) => lb.has(x)).length;
			const ea = await engine.exportImage(false);
			const eb = await gl.exportImage(false);
			let img: Record<string, number> | null = null;
			if (ea && eb) {
				const da = await decode(ea, 480);
				const db = await decode(eb, 480);
				let sum = 0;
				let big = 0;
				const n = Math.min(da.data.length, db.data.length);
				for (let i = 0; i < n; i += 4) {
					const d =
						(Math.abs(da.data[i] - db.data[i]) +
							Math.abs(da.data[i + 1] - db.data[i + 1]) +
							Math.abs(da.data[i + 2] - db.data[i + 2])) /
						3;
					sum += d;
					if (d > 16) big++;
				}
				img = {
					meanAbsDiff: +(sum / (n / 4)).toFixed(2),
					fracOver16: +(big / (n / 4)).toFixed(4),
				};
			}
			out.parity = {
				rangeRelMedian: rel.length ? +rel[rel.length >> 1].toFixed(5) : null,
				rangeRelP90: rel.length
					? +rel[Math.floor(rel.length * 0.9)].toFixed(5)
					: null,
				skyMismatch,
				labels: { webgpu: la.size, webgl: lb.size, common },
				image: img,
			};
			expect(
				!rel.length || rel[rel.length >> 1] < 0.01,
				"parity: median range difference < 1 %",
			);
			expect(skyMismatch <= pts.length * 0.03, "parity: sky / terrain agree");
			if (img) expect(img.meanAbsDiff < 6, "parity: export mean |Δ| < 6");
		}
	} catch (e) {
		fails.push(`threw: ${(e as Error).stack ?? e}`);
	} finally {
		window.removeEventListener("error", onErr);
		window.removeEventListener("unhandledrejection", onErr);
		out.metrics = engine.metrics();
		webgl?.dispose();
		glCanvas?.remove();
		if (!o.keep) {
			engine.dispose();
			canvas.remove();
			window.__webgpuEngineCheck = undefined;
		}
	}
	out.errors = errors;
	return { ok: fails.length === 0, fails, ...out };
}
