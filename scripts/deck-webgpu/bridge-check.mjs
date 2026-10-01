#!/usr/bin/env node
// Compute bridge (src/lib/deck-webgpu/compute-bridge.ts) check on the WebGPU engine lab:
// - per-pass parity + micro-timings (compute-bridge.check.ts runBridgeCheck): masks, band stats,
//   haze prep, the whole haze fit (+ its stale-prep / geo-size guards), bridged vs readback path on
//   the same geometry buffer;
// - the final look image: engine.setLookBridge(true / false), each settled, one offscreen screen
//   render at the canvas size, compared byte for byte (and against the classic style, to show the
//   look is actually in the image), and the engine's haze fit (JSON) of each path;
// - in-engine latency: pose nudge → geometry fresh → refined masks / band stats / haze fit applied,
//   per path.
// Style "photo-matched" (refine + sky photo + harmonize 0.8), replace mode, range blend (a cut).
//   node scripts/gpu/with-render-lock.mjs -- node scripts/deck-webgpu/bridge-check.mjs IMG_7086 [IMG_…] [--host deck|direct]
// Env APP_URL (default http://localhost:3160). Output: out/deck-webgpu/bridge-check-<id>.json
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { GPU_ARGS } from "./gpu-args.mjs";

const args = process.argv.slice(2);
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : "");
const host = opt("--host") || "deck";
const ids = args.filter(
	(a, i) => !a.startsWith("--") && args[i - 1] !== "--host",
);
if (!ids.length) ids.push("IMG_7086");
const URL0 = process.env.APP_URL ?? "http://localhost:3160";
const OUT = resolve(import.meta.dirname, "../../out/deck-webgpu");
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ args: GPU_ARGS });
const all = {};
try {
	for (const id of ids) {
		const page = await browser.newPage({
			viewport: { width: 1280, height: 900 },
		});
		const errors = [];
		page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
		page.on("console", (m) => {
			const t = m.text();
			if (m.type() === "error" || /look-bridge|lookgpu|\[look\]/.test(t))
				if (!/Module \w+ not found|Failed to load resource/.test(t))
					errors.push(`${m.type()}: ${t.slice(0, 400)}`);
		});
		const q = new URLSearchParams({
			photo: id,
			host,
			mode: "replace",
			size: "1080x810",
			labels: "false",
		});
		// a cold dev server may reload the page once (vite dep optimisation): retry once
		let r;
		for (let attempt = 0; attempt < 3 && !r; attempt++) {
			try {
				r = await runOnce(page, q);
			} catch (err) {
				if (
					attempt === 2 ||
					!/context was destroyed|navigation/i.test(String(err))
				)
					throw err;
				errors.push(`retry after: ${String(err).slice(0, 200)}`);
			}
		}
		r.errors = errors;
		all[id] = r;
		writeFileSync(`${OUT}/bridge-check-${id}.json`, JSON.stringify(r, null, 1));
		console.log(
			id,
			JSON.stringify({
				host: r.host,
				bridgeOn: r.bridgeOn,
				exact: r.check?.exact,
				image: r.image?.bridgeVsReadback,
				hazeFit: r.image?.hazeFit,
				look: r.image?.bridgeVsClassic?.diff,
				ms: r.check?.ms,
				latency: r.latency,
				errors: errors.length,
			}),
		);
		await page.close();
	}
} finally {
	await browser.close();
}
writeFileSync(`${OUT}/bridge-check.json`, JSON.stringify(all, null, 1));

async function runOnce(page, q) {
	// a cold dev server transforms the whole lab on the first load
	await page.goto(`${URL0}/lab/deck-webgpu?${q}`, { timeout: 240_000 });
	await page.waitForFunction(
		() => document.body.dataset.ready || window.__deckWebgpuLab?.error,
		null,
		{ timeout: 240_000 },
	);
	return page.evaluate(async () => {
		const e = window.__engine;
		const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
		const { presetStyle } = await import("/src/lib/style/presets.ts");
		const { lookIdle } = await import("/src/lib/gpu/look/opt-in.ts");
		const { segmentSky } = await import("/src/lib/sky/index.ts");
		const check = await import("/src/lib/deck-webgpu/compute-bridge.check.ts");
		const out = { host: e.stats.host };
		const t = performance.now();
		const sky = await segmentSky(e.photoElement).catch(() => null);
		out.skyMs = Math.round(performance.now() - t);
		out.fg = !!e.fgMask;
		out.skyMask = !!sky;
		e.setStyle(presetStyle("photo-matched"));
		if (sky) e.setSkyMask(sky);
		e.setSettings({ mode: "replace", method: "range", rangeKm: 8 });
		// wait for the bridge (async gate) and every look pass
		const settle = async () => {
			await e.readback();
			for (let i = 0; i < 3; i++) {
				await sleep(350);
				await lookIdle();
			}
			while (e.statsTimer || e.statsBusy) {
				await sleep(20);
				await lookIdle();
			}
			await e.nextFrame();
		};
		await settle();
		out.bridgeOn = !!e.lookBridge;

		// ── final look image, both paths (same pose, style, masks inputs)
		const W = 1080;
		const H = 810;
		const render = () =>
			e.renderOffscreen({ width: W, height: H, view: "photo", screen: true });
		const same = (a, b) =>
			a.length === b.length && a.every((v, i) => v === b[i]);
		// terrain / imagery keep streaming after a pose settles: shoot until two consecutive frames
		// (1 s apart) of the same path are identical, so a path A/B compares like with like
		const shot = async () => {
			await settle();
			let prev = await render();
			for (let i = 0; i < 12; i++) {
				await sleep(1000);
				await settle();
				const cur = await render();
				if (same(prev, cur)) return cur;
				prev = cur;
			}
			stable = false;
			return prev;
		};
		let stable = true;
		const cmp = (a, b) => {
			let n = 0;
			let max = 0;
			for (let i = 0; i < a.length; i++) {
				const d = Math.abs(a[i] - b[i]);
				if (d) {
					n++;
					if (d > max) max = d;
				}
			}
			return { bytes: a.length, diff: n, max };
		};
		const hazeRuns = () => e.lookBridge?.timing.haze.length ?? 0;
		await e.setLookBridge(true);
		const onImg = await shot();
		const fitOn = JSON.stringify(e.hazeFit);
		const bridgeState = {
			on: !!e.lookBridge,
			masksGen: e.lookBridge?.masks?.gen ?? null,
			geoBufGen: e.stats.geoBufGen,
			statsValid: !!e.lookBridge?.stats?.valid,
			hazeBridged: hazeRuns(),
		};
		await e.setLookBridge(false);
		const offImg = await shot();
		const fitOff = JSON.stringify(e.hazeFit);
		const refState = {
			masksGen: e.compLook.masks?.gen ?? null,
			statsValid: !!e.compLook.stats?.valid,
		};
		e.setStyle(presetStyle("classic"));
		const classicImg = await shot();
		e.setStyle(presetStyle("photo-matched"));
		out.image = {
			size: [W, H],
			bridgeVsReadback: cmp(onImg, offImg),
			bridgeVsClassic: cmp(onImg, classicImg),
			bridgeState,
			refState,
			hazeFit: {
				same: fitOn === fitOff && e.hazeFit != null,
				fitted: fitOn !== "null",
				visibility: e.hazeFit?.visibility ?? null,
			},
		};
		// the bridged path once more (stability of the scene between the A/B shots)
		await e.setLookBridge(true);
		out.image.bridgeAgain = cmp(onImg, await shot());
		out.image.stable = stable;

		// ── per-pass parity + micro-timings on the same geometry buffer
		await e.setLookBridge(true);
		await settle();
		out.check = await check.runBridgeCheck(e, 7);
		// the bridged image again after the check (the check must not perturb the engine)
		const afterImg = await shot();
		out.image.afterCheck = cmp(onImg, afterImg);

		// ── in-engine latency: pose nudge → look applied (per path)
		const lat = {};
		for (const path of ["readback", "bridge"]) {
			await e.setLookBridge(path === "bridge");
			await settle();
			const rows = [];
			const p0 = { ...e.pose };
			const queueIdle = () => e.gpu.device.handle.queue.onSubmittedWorkDone();
			let stats0 = path === "bridge" ? e.lookBridge?.stats : e.compLook.stats;
			let fit0 = e.hazeFit;
			for (let k = 0; k < 6; k++) {
				const t0 = performance.now();
				e.setPose({ ...p0, yaw: p0.yaw + (k % 2 ? -0.25 : 0.25) });
				await e.readback();
				const tGeo = performance.now();
				const gen = e.stats.geoBufGen;
				let tMask = 0;
				let tStats = 0;
				let tHaze = 0;
				// landed = a new masks object for this generation / a new stats object; then the GPU
				// work behind it done (the bridged passes resolve at submit)
				const statsOf = () =>
					path === "bridge" ? e.lookBridge?.stats : e.compLook.stats;
				while (
					performance.now() - tGeo < 5000 &&
					(!tMask || !tStats || !tHaze)
				) {
					const b = e.lookBridge;
					const mg = path === "bridge" ? b?.masks?.gen : e.compLook.masks?.gen;
					if (!tMask && mg === gen) {
						await queueIdle();
						tMask = performance.now();
					}
					if (!tStats && statsOf() && statsOf() !== stats0) {
						await queueIdle();
						tStats = performance.now();
					}
					if (!tHaze && e.hazeFit && e.hazeFit !== fit0) {
						await queueIdle();
						tHaze = performance.now();
					}
					await new Promise((r) => setTimeout(r, 0));
				}
				stats0 = statsOf();
				fit0 = e.hazeFit;
				rows.push({
					geo: tGeo - t0,
					masks: tMask ? tMask - tGeo : null,
					stats: tStats ? tStats - tGeo : null,
					haze: tHaze ? tHaze - tGeo : null,
				});
				await settle();
			}
			e.setPose(p0);
			const med = (k) => {
				const v = rows
					.map((r) => r[k])
					.filter((x) => x != null)
					.sort((a, b) => a - b);
				return v.length ? +v[v.length >> 1].toFixed(1) : null;
			};
			lat[path] = {
				geoMs: med("geo"),
				masksAfterGeoMs: med("masks"),
				statsAfterGeoMs: med("stats"),
				hazeAfterGeoMs: med("haze"),
				n: rows.length,
			};
		}
		out.latency = lat;
		await e.setLookBridge(true);
		return out;
	});
}
