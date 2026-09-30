#!/usr/bin/env node
// WebGPU engine (/lab/deck-webgpu, WebGpuEngine) vs the WebGL DeckEngine (/photo/<id>?renderer=deck),
// same photo, same pose, same settings, same canvas CSS size, one browser at a time:
//   - time to first frame (navigation → first onRender with terrain tiles) and to ready
//   - photo-view frame cost, GPU included: `idle` (full re-render at the same pose) and `pan`
//     (yaw +0.25° per frame). WebGL: setPose + deck.redraw (synchronous) + a 1 px readPixels
//     (GPU sync); WebGPU: setPose + nextFrame("all") (resolves on queue.onSubmittedWorkDone)
//   - world view orbit: a 2.5 s mouse drag, frames rendered per second and rAF interval stats
//   - GPU memory (luma statsManager "GPU Time and Memory", same instrument on both)
//   - screenshots (overlay, replace, world) and exportImage(false) pixel diffs between the two
// WebGL runs on the same server (default :3111, deck full build; the WebGL path is unaffected).
//   node scripts/gpu/with-render-lock.mjs -- node scripts/deck-webgpu/bench.mjs --photos IMG_7086,IMG_6958,IMG_7018 --out <dir>
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { GPU_ARGS } from "./gpu-args.mjs";

const arg = (k, d) => {
	const i = process.argv.indexOf(`--${k}`);
	return i > 0 ? process.argv[i + 1] : d;
};
const BASE = arg("url", process.env.APP_URL ?? "http://localhost:3111");
const IDS = arg("photos", "IMG_7086,IMG_6958,IMG_7018").split(",");
const OUT = resolve(arg("out", "out/deck-webgpu/bench"));
const HOST = arg("host", "deck");
mkdirSync(OUT, { recursive: true });

// records the first onRender with terrain (both engines expose window.__engine in DEV / the lab)
const FIRST_FRAME_HOOK = () => {
	const w = window;
	w.__bench = { firstFrame: null, renders: 0 };
	const poll = () => {
		const e = w.__engine;
		if (e?.onRender) {
			e.onRender(() => {
				w.__bench.renders++;
				if (w.__bench.firstFrame == null && e.stats?.terrainTiles > 0)
					w.__bench.firstFrame = performance.now();
			});
			return;
		}
		setTimeout(poll, 5);
	};
	poll();
};

async function openPage(browser, url, errors) {
	const page = await browser.newPage({
		viewport: { width: 1400, height: 900 },
	});
	page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
	page.on("console", (m) => {
		if (m.type() === "error" && !/Failed to load resource/.test(m.text()))
			errors.push(`error: ${m.text().slice(0, 300)}`);
	});
	await page.addInitScript(() => {
		try {
			localStorage.clear();
		} catch {}
	});
	await page.addInitScript(FIRST_FRAME_HOOK);
	const t0 = Date.now();
	await page.goto(url);
	await page.waitForSelector("[data-ready]", {
		timeout: 240_000,
		state: "attached",
	});
	const readyWallMs = Date.now() - t0;
	return { page, readyWallMs };
}

/** Frame cost, GPU included (see header). */
const FRAME_COST = async ({ n, dyaw }) => {
	const e = window.__engine;
	const webgpu = e.backend === "webgpu";
	const deck = e.deckInstance;
	const gl = !webgpu ? deck?.device?.gl : null;
	const px = new Uint8Array(4);
	const p0 = { ...e.pose };
	const times = [];
	for (let i = 0; i < n; i++) {
		const t = performance.now();
		e.setPose({ ...p0, yaw: p0.yaw + dyaw * (i + 1) });
		if (webgpu) await e.nextFrame("all");
		else {
			deck.redraw("bench");
			gl?.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
		}
		times.push(performance.now() - t);
		// let the engine's own rAF work run between samples (as in real use)
		await new Promise((r) => setTimeout(r, 0));
	}
	e.setPose(p0);
	await new Promise((r) => setTimeout(r, 400));
	times.sort((a, b) => a - b);
	return {
		n,
		median: times[Math.floor(n / 2)],
		p90: times[Math.floor(n * 0.9)],
		min: times[0],
		mean: times.reduce((a, b) => a + b, 0) / n,
	};
};

/**
 * Pipelined throughput: n pose changes, each drawn synchronously (WebGL: deck.redraw; WebGPU: the
 * deck host's requestRender → deck.redraw), ONE GPU sync at the end → ms per frame with the GPU
 * busy back to back (no per-frame completion latency). Plus the WebGPU host's own CPU split.
 */
const FRAME_THROUGHPUT = async ({ n, dyaw }) => {
	const e = window.__engine;
	const webgpu = e.backend === "webgpu";
	const deck = e.deckInstance;
	const gl = !webgpu ? deck?.device?.gl : null;
	const host = webgpu ? e.hostInstance : null;
	const px = new Uint8Array(4);
	const p0 = { ...e.pose };
	await (webgpu ? e.nextFrame("all") : Promise.resolve());
	const cpu = [];
	const t = performance.now();
	for (let i = 0; i < n; i++) {
		e.setPose({ ...p0, yaw: p0.yaw + dyaw * (i + 1) });
		if (webgpu) {
			host.requestRender("all");
			cpu.push({ ...host.stats });
		} else deck.redraw("bench");
	}
	if (webgpu) await host.nextFrame("screen");
	else gl?.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
	const ms = (performance.now() - t) / n;
	e.setPose(p0);
	await new Promise((r) => setTimeout(r, 400));
	const med = (k) => {
		const a = cpu.map((c) => c[k]).sort((x, y) => x - y);
		return a.length ? a[Math.floor(a.length / 2)] : null;
	};
	return {
		n,
		msPerFrame: ms,
		hostCpuMs: med("cpuMs"),
		geometryEncodeMs: med("geometryMs"),
		colorEncodeMs: med("colorMs"),
		screenEncodeMs: med("screenMs"),
	};
};

/** rAF intervals + renders while the mouse orbits (started from node). */
const START_RAF = () => {
	const w = window;
	w.__raf = { t: [], renders0: w.__bench.renders, on: true };
	const loop = (t) => {
		if (!w.__raf.on) return;
		w.__raf.t.push(t);
		requestAnimationFrame(loop);
	};
	requestAnimationFrame(loop);
};
const STOP_RAF = () => {
	const w = window;
	w.__raf.on = false;
	const t = w.__raf.t;
	const d = t
		.slice(1)
		.map((x, i) => x - t[i])
		.sort((a, b) => a - b);
	const span = (t[t.length - 1] - t[0]) / 1000;
	return {
		seconds: span,
		renders: w.__bench.renders - w.__raf.renders0,
		rendersPerSec: (w.__bench.renders - w.__raf.renders0) / span,
		rafMedian: d[Math.floor(d.length / 2)],
		rafP95: d[Math.floor(d.length * 0.95)],
		rafMax: d[d.length - 1],
		longFrames: d.filter((x) => x > 25).length,
	};
};

const MEMORY = () => {
	const m = window.__engine.metrics?.();
	const mem = m?.luma?.memory ?? null;
	const res = m?.luma?.resources ?? null;
	const pick = (t) =>
		t
			? Object.fromEntries(
					Object.entries(t).map(([k, v]) => [
						k,
						v?.count ?? v?.value ?? v?.total ?? v,
					]),
				)
			: null;
	return { memory: pick(mem), resources: pick(res) };
};

async function exportPng(page) {
	return page.evaluate(async () => {
		const b = await window.__engine.exportImage(false);
		if (!b) return null;
		return await new Promise((r) => {
			const fr = new FileReader();
			fr.onload = () => r(fr.result);
			fr.readAsDataURL(b);
		});
	});
}

async function runArm(browser, id, arm, ref) {
	const errors = [];
	const url =
		arm === "webgl"
			? `${BASE}/photo/${id}?renderer=deck`
			: `${BASE}/lab/deck-webgpu?photo=${id}&host=${HOST}&labels=0${ref ? `&size=${ref.css.w}x${ref.css.h}` : ""}`;
	const { page, readyWallMs } = await openPage(browser, url, errors);
	const r = { arm, url, readyWallMs, errors };
	try {
		r.firstFrameMs = await page.evaluate(() => window.__bench.firstFrame);
		r.readyMs = await page.evaluate(() => performance.now()); // upper bound, page clock
		r.css = await page.evaluate(() => {
			const c = window.__engine.canvas ?? document.querySelector("canvas");
			const rect = c.getBoundingClientRect();
			return {
				w: Math.round(rect.width),
				h: Math.round(rect.height),
				bw: c.width,
				bh: c.height,
			};
		});
		// same pose + settings as the reference arm
		if (ref)
			await page.evaluate(
				async ({ pose, settings }) => {
					const e = window.__engine;
					e.setSettings({ ...settings, mode: "overlay" });
					e.setPose(pose);
					await e.readback();
				},
				{ pose: ref.pose, settings: ref.settings },
			);
		else
			await page.evaluate(async () => {
				const e = window.__engine;
				e.setSettings({ mode: "overlay" });
				await e.readback();
			});
		await page.waitForTimeout(5000); // imagery, horizon, look settle
		r.pose = await page.evaluate(() => window.__engine.pose);
		r.settings = await page.evaluate(() => window.__engine.settings);
		r.labels = await page.evaluate(() =>
			window.__engine.peakLabels().map((l) => l.name),
		);
		// canvas screenshots + export diffs
		const canvas = page.locator("canvas").first();
		await canvas.screenshot({ path: `${OUT}/${id}-${arm}-overlay.png` });
		r.exportOverlay = await exportPng(page);
		r.frameIdle = await page.evaluate(FRAME_COST, { n: 30, dyaw: 0 });
		r.framePan = await page.evaluate(FRAME_COST, { n: 30, dyaw: 0.25 });
		r.throughput = await page.evaluate(FRAME_THROUGHPUT, {
			n: 60,
			dyaw: 0.25,
		});
		r.memPhoto = await page.evaluate(MEMORY);
		await page.evaluate(() =>
			window.__engine.setSettings({ mode: "replace", mapStyle: "satellite" }),
		);
		await page.waitForTimeout(4000);
		await page.evaluate(() => window.__engine.readback());
		await canvas.screenshot({ path: `${OUT}/${id}-${arm}-replace.png` });
		r.exportReplace = await exportPng(page);
		await page.evaluate(() => window.__engine.setSettings({ mode: "world" }));
		await page.waitForTimeout(5000);
		await canvas.screenshot({ path: `${OUT}/${id}-${arm}-world.png` });
		const box = await canvas.boundingBox();
		const cx = box.x + box.width / 2;
		const cy = box.y + box.height / 2;
		await page.evaluate(START_RAF);
		await page.mouse.move(cx, cy);
		await page.mouse.down();
		const t = Date.now();
		let i = 0;
		while (Date.now() - t < 2500) {
			i++;
			await page.mouse.move(
				cx + Math.sin(i / 20) * 200,
				cy + 40 * Math.sin(i / 35),
			);
		}
		await page.mouse.up();
		r.orbit = await page.evaluate(STOP_RAF);
		await page.waitForTimeout(1000);
		await canvas.screenshot({ path: `${OUT}/${id}-${arm}-world-orbit.png` });
		r.memWorld = await page.evaluate(MEMORY);
		r.jsHeapMB = await page.evaluate(
			() => (performance.memory?.usedJSHeapSize ?? 0) / 2 ** 20,
		);
	} catch (e) {
		r.fatal = String(e);
	}
	await page.close();
	return r;
}

/** Pixel diff of two data URLs (same size), in a blank page. */
async function diff(browser, a, b, name) {
	if (!a || !b) return null;
	const page = await browser.newPage();
	const res = await page.evaluate(
		async ({ a, b }) => {
			const load = async (u) => {
				const img = new Image();
				img.src = u;
				await img.decode();
				return img;
			};
			const [A, B] = await Promise.all([load(a), load(b)]);
			const w = Math.min(A.naturalWidth, B.naturalWidth);
			const h = Math.min(A.naturalHeight, B.naturalHeight);
			const px = (img) => {
				const c = new OffscreenCanvas(w, h);
				const x = c.getContext("2d");
				x.drawImage(img, 0, 0, w, h);
				return x.getImageData(0, 0, w, h).data;
			};
			const pa = px(A);
			const pb = px(B);
			let sum = 0;
			let over8 = 0;
			let over16 = 0;
			let over48 = 0;
			const heat = new Uint8ClampedArray(w * h * 4);
			for (let i = 0; i < w * h; i++) {
				const d = Math.max(
					Math.abs(pa[i * 4] - pb[i * 4]),
					Math.abs(pa[i * 4 + 1] - pb[i * 4 + 1]),
					Math.abs(pa[i * 4 + 2] - pb[i * 4 + 2]),
				);
				sum +=
					(Math.abs(pa[i * 4] - pb[i * 4]) +
						Math.abs(pa[i * 4 + 1] - pb[i * 4 + 1]) +
						Math.abs(pa[i * 4 + 2] - pb[i * 4 + 2])) /
					3;
				if (d > 8) over8++;
				if (d > 16) over16++;
				if (d > 48) over48++;
				const v = Math.min(255, d * 4);
				heat[i * 4] = v;
				heat[i * 4 + 1] = v;
				heat[i * 4 + 2] = v;
				heat[i * 4 + 3] = 255;
			}
			const c = new OffscreenCanvas(w, h);
			c.getContext("2d").putImageData(new ImageData(heat, w, h), 0, 0);
			const blob = await c.convertToBlob({ type: "image/png" });
			const heatUrl = await new Promise((r) => {
				const fr = new FileReader();
				fr.onload = () => r(fr.result);
				fr.readAsDataURL(blob);
			});
			return {
				size: [w, h],
				sizes: [
					[A.naturalWidth, A.naturalHeight],
					[B.naturalWidth, B.naturalHeight],
				],
				meanAbs: sum / (w * h),
				pctOver8: (100 * over8) / (w * h),
				pctOver16: (100 * over16) / (w * h),
				pctOver48: (100 * over48) / (w * h),
				heatUrl,
			};
		},
		{ a, b },
	);
	await page.close();
	const save = (u, f) =>
		writeFileSync(f, Buffer.from(u.split(",")[1], "base64"));
	save(
		a,
		`${OUT}/${name}-webgl-export.${a.startsWith("data:image/png") ? "png" : "jpg"}`,
	);
	save(
		b,
		`${OUT}/${name}-webgpu-export.${b.startsWith("data:image/png") ? "png" : "jpg"}`,
	);
	save(res.heatUrl, `${OUT}/${name}-diff.png`);
	delete res.heatUrl;
	return res;
}

const browser = await chromium.launch({ args: GPU_ARGS });
const rows = [];
try {
	for (const id of IDS) {
		process.stdout.write(`${id}: webgl… `);
		const gl = await runArm(browser, id, "webgl", null);
		process.stdout.write("webgpu… ");
		const gpu = await runArm(browser, id, "webgpu", gl);
		const row = {
			id,
			diffOverlay: await diff(
				browser,
				gl.exportOverlay,
				gpu.exportOverlay,
				`${id}-overlay`,
			),
			diffReplace: await diff(
				browser,
				gl.exportReplace,
				gpu.exportReplace,
				`${id}-replace`,
			),
		};
		for (const r of [gl, gpu]) {
			delete r.exportOverlay;
			delete r.exportReplace;
		}
		row.webgl = gl;
		row.webgpu = gpu;
		const inter = gl.labels?.filter((x) => gpu.labels?.includes(x)).length ?? 0;
		row.labels = {
			webgl: gl.labels?.length,
			webgpu: gpu.labels?.length,
			common: inter,
		};
		rows.push(row);
		console.log(
			`ttff ${Math.round(gl.firstFrameMs)} / ${Math.round(gpu.firstFrameMs)} ms · idle ${gl.frameIdle?.median?.toFixed(1)} / ${gpu.frameIdle?.median?.toFixed(1)} ms · pan ${gl.framePan?.median?.toFixed(1)} / ${gpu.framePan?.median?.toFixed(1)} ms · thru ${gl.throughput?.msPerFrame?.toFixed(1)} / ${gpu.throughput?.msPerFrame?.toFixed(1)} ms · orbit raf p95 ${gl.orbit?.rafP95?.toFixed(1)} / ${gpu.orbit?.rafP95?.toFixed(1)} ms · diff overlay ${row.diffOverlay?.meanAbs?.toFixed(2)} replace ${row.diffReplace?.meanAbs?.toFixed(2)} · errors ${gl.errors.length}/${gpu.errors.length}${gl.fatal || gpu.fatal ? ` FATAL ${gl.fatal ?? ""} ${gpu.fatal ?? ""}` : ""}`,
		);
		writeFileSync(
			`${OUT}/bench.json`,
			JSON.stringify(
				{ at: new Date().toISOString(), base: BASE, host: HOST, rows },
				null,
				1,
			),
		);
	}
} finally {
	await browser.close();
}
console.log(`wrote ${OUT}/bench.json`);
