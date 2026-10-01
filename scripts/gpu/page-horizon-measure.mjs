#!/usr/bin/env node
// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// WAG W3.1 (device half) measurement: the app horizon in the horizon-fast worker (its own GPU device,
// its own mosaics, its own DEM decode) against what the same job would cost on the page's render
// device. No app code changes: the worker's messages are observed by wrapping `Worker` in an init
// script, and the engine's state through the dev handle window.__engine.
//
//   node scripts/gpu/with-render-lock.mjs -- node scripts/gpu/page-horizon-measure.mjs [IMG_xxxx ...]
//
// Per photo (live app, /photo/<id>?renderer=webgpu):
//  (a) worker path: worker created → spans → tiles posted → build → march (eye known) → dirs back, the
//      worker's own stats (decode, mosaic, march ms, mosaic MB), its GPU pass times (PROFILE=1), and when
//      the engine needs the dirs (photo prep done) vs when they arrived (slack; negative = on the
//      critical path).
//  (b) page path: the page terrain's resident tiles (the batched terrain's height atlas) at the moments
//      the worker builds its mosaics and returns, classified against the ring tiles the march reads
//      (exact key at 512 px / same key downsampled / only finer / only coarser / none). Then the same
//      job replayed on the main thread and the page device: tile bytes (warm cache) → decode → ring
//      mosaics → upload + march → f64 stages, timed per stage (main-thread ms), with the dirs compared
//      bit for bit to the worker's, and frame times (engine.nextFrame) idle vs during the page march.
//  Plus one bare WebGPU device creation in a fresh worker (the worker path's device cost).
//
// Env: APP_URL (default http://localhost:3141), PROFILE=1 (GPU timestamp profiling on; perturbs latency
// slightly, so run once without it for the latency numbers), OUT (default out/gpu/w3/page-horizon.json).
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { GPU_ARGS } from "../deck-webgpu/gpu-args.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const BASE = process.env.APP_URL ?? "http://localhost:3141";
const PROFILE = process.env.PROFILE === "1";
const OUT = process.env.OUT ?? path.join(ROOT, "out/gpu/w3/page-horizon.json");
const ids = process.argv.slice(2).length
	? process.argv.slice(2)
	: ["IMG_6958", "IMG_7018", "IMG_7063", "IMG_7155"];

/** Installed before any page script: observes the horizon worker and polls the engine per frame. */
function initScript(profile) {
	if (profile) globalThis.__RIGI_GPU_PROFILE__ = true;
	const hm = {
		t0: 0,
		events: [],
		tiles: [],
		spans: null,
		snaps: {},
		marks: {},
	};
	window.__hm = hm;
	const snap = (why) => {
		try {
			const e = window.__engine;
			const set = e?.renderSet;
			const rh = e?.gpu?.terrain?.residentHeights?.();
			return {
				why,
				t: performance.now(),
				tiles: (set?.tiles ?? []).map((m) => ({
					z: m.key.z,
					x: m.key.x,
					y: m.key.y,
					size: m.size,
					sourceZ: m.sourceZ,
					focus: m.focus,
					resident: rh ? rh.slotOf(m) != null : null,
				})),
			};
		} catch (err) {
			return { why, t: performance.now(), error: String(err) };
		}
	};
	hm.snap = snap;
	const W = window.Worker;
	window.Worker = class extends W {
		constructor(url, opts) {
			super(url, opts);
			if (!String(url).includes("horizon-fast-app")) return;
			hm.t0 = performance.now();
			hm.events.push(["create", hm.t0]);
			const post = this.postMessage.bind(this);
			this.postMessage = (m, tr) => {
				const t = performance.now();
				if (m.type === "tile")
					hm.tiles.push({
						key: m.key,
						source: m.source,
						bytes: m.buf?.byteLength ?? 0,
						t,
					});
				else hm.events.push([m.type, t, m.eyeH]);
				if (m.type === "spans") hm.spans = m.spans;
				if (m.type === "build") {
					hm.build = { ...m };
					hm.snaps.build = snap("build");
				}
				return post(m, tr);
			};
			// registered before the client's onmessage, so the dirs are copied before anything uses them
			this.addEventListener("message", (e) => {
				const t = performance.now();
				const d = e.data;
				hm.events.push([`out:${d.type}`, t]);
				if (d.type === "dirs" && !hm.result) {
					hm.result = {
						t,
						eyeH: d.eyeH,
						stats: d.stats,
						gpuProfile: d.gpuProfile ?? null,
						dirs: new Float32Array(d.dirs),
					};
					hm.snaps.dirs = snap("dirs");
				}
				if (d.type === "error") hm.error = d.error;
			});
		}
	};
	const poll = () => {
		const e = window.__engine;
		const now = performance.now();
		if (e) {
			hm.marks.engine ??= now;
			if (e.renderSet) hm.marks.firstRenderSet ??= now;
			if (e.terrain) hm.marks.terrain ??= now;
			if (e.photoPrep && hm.marks.photoPrep == null) {
				hm.marks.photoPrep = now;
				hm.snaps.need = snap("need");
			}
			if (e.horizonDirs?.length && hm.marks.horizonDirs == null) {
				hm.marks.horizonDirs = now;
				hm.marks.horizonSource = e.horizonSource;
			}
		}
		if (hm.marks.horizonDirs == null) requestAnimationFrame(poll);
	};
	requestAnimationFrame(poll);
}

/** In the page after load: replays the worker's job on the main thread + page device. */
async function pageReplay() {
	const hm = window.__hm;
	const eng = window.__engine;
	const dem = await import("/src/lib/dem/index.ts");
	const mos = await import("/src/lib/horizon-fast/mosaic.ts");
	const hz = await import("/src/lib/gpu/horizon/index.ts");
	const cert = await import("/src/lib/gpu/horizon/certified.ts");
	const dirsCpu = await import("/src/lib/gpu/horizon/dirs-cpu.ts");
	const devMod = await import("/src/lib/gpu/core/device.ts");
	const device = await devMod.getComputeDevice();
	const sameDevice = !!device && device === eng?.gpu?.device;
	const heap = () => performance.memory?.usedJSHeapSize ?? null;
	const out = { sameDevice, backend: device?.type ?? null };
	const j = hm.build;
	const eyeH = hm.result.eyeH;

	// frame time while idle (the engine renders on demand: nextFrame requests one)
	const frames = async (n) => {
		const ts = [];
		for (let i = 0; i < n; i++) {
			const t = performance.now();
			await eng.nextFrame("all");
			ts.push(performance.now() - t);
		}
		return ts;
	};
	await frames(3);
	out.frameIdleMs = await frames(15);

	// 1. tile bytes through the shared cache (warm: the app just fetched them)
	const heap0 = heap();
	let t = performance.now();
	const bytes = await Promise.all(
		hm.tiles.map((x) => dem.fetchDemBytes(x.key, {})),
	);
	out.fetchMs = performance.now() - t;
	// 2. decode exactly like horizon-fast-app.worker.ts, on the main thread
	const T = dem.MAPTERHORN.tileSize;
	const store = new mos.TileStore(
		{ tileSize: T, maxZoom: 30, load: async () => null },
		false,
	);
	const sources = new Map();
	t = performance.now();
	let syncDecodeMs = 0;
	await Promise.all(
		hm.tiles.map(async (x, i) => {
			const r = bytes[i];
			if (!r) {
				store.tiles.set(dem.tileId(x.key), null);
				return;
			}
			let src = sources.get(dem.tileId(r.source));
			if (!src) {
				src = dem.blobHeights(new Blob([r.buf])).then((h) => {
					const s0 = performance.now();
					dem.validateTile(h, Math.round(Math.sqrt(h.length)));
					syncDecodeMs += performance.now() - s0;
					return h;
				});
				sources.set(dem.tileId(r.source), src);
			}
			const h = await src;
			const s0 = performance.now();
			store.tiles.set(
				dem.tileId(x.key),
				dem.ancestorCrop(h, r.source, x.key, T),
			);
			syncDecodeMs += performance.now() - s0;
		}),
	);
	out.decodeWallMs = performance.now() - t;
	out.decodeSyncMs = syncDecodeMs; // validateTile + ancestorCrop (blobHeights' getImageData + decode loop not included)
	// 3. ring mosaics (synchronous, main thread), plus max-mips (uploadMosaics builds them if missing)
	t = performance.now();
	const mosaics = hm.spans.map((s) =>
		mos.buildMosaic(
			store,
			mos.ringWindow(j.lat, j.lon, s.span, store.tileSize, s.az0, s.az1),
			s.span,
			j.lat,
			true,
		),
	);
	out.mosaicMs = performance.now() - t;
	t = performance.now();
	for (const m of mosaics) m.mip ??= mos.buildMips(m);
	out.mipsMs = performance.now() - t;
	out.mosaicMB = mosaics.reduce((a, m) => a + m.data.byteLength, 0) / 1e6;
	out.heapDeltaMB = heap0 != null ? (heap() - heap0) / 1e6 : null;
	// 4. march on the page device (cold = upload + kernel; warm = kernel only), with frame times during
	const eye = { lat: j.lat, lon: j.lon, h: eyeH };
	const opts = {
		step: j.step,
		k: j.k,
		maxDistance: j.maxDistance,
		minDistance: j.minDistance,
		noRidges: true,
	};
	const during = [];
	let marching = true;
	const frameLoop = (async () => {
		while (marching) {
			const t1 = performance.now();
			await eng.nextFrame("all");
			during.push(performance.now() - t1);
		}
	})();
	t = performance.now();
	const [profCold] = await hz.computeHorizonGpu(device, mosaics, [eye], opts);
	out.marchColdMs = performance.now() - t;
	out.marchColdTiming = { ...hz.lastGpuHorizonTiming };
	marching = false;
	await frameLoop;
	out.frameDuringMarchMs = during;
	const warm = [];
	let prof = profCold;
	for (let i = 0; i < 3; i++) {
		t = performance.now();
		[prof] = await hz.computeHorizonGpu(device, mosaics, [eye], opts);
		warm.push(performance.now() - t);
	}
	out.marchWarmMs = warm;
	// 5. the f64 stages on the main thread (atan is inside the readback above; ENU + resample here)
	t = performance.now();
	const r = await cert.skylineDirs(device, prof, j, eyeH, "f64");
	out.enuF64Ms = performance.now() - t;
	t = performance.now();
	for (let i = 0; i < 3; i++) dirsCpu.skylineDirsF64(prof, j, eyeH);
	out.enuF64WarmMs = (performance.now() - t) / 3;
	// atan stage alone (the f64 part of the march readback)
	const nAz = prof.elevation.length;
	const fake = new Float32Array(nAz);
	for (let i = 0; i < nAz; i++)
		fake[i] = Math.tan(prof.elevation[i] * (Math.PI / 180));
	t = performance.now();
	let sink = 0;
	for (let rep = 0; rep < 10; rep++)
		for (let i = 0; i < nAz; i++) sink += Math.atan(fake[i]) / (Math.PI / 180);
	out.atanF64Ms = (performance.now() - t) / 10;
	out.sink = sink > 0;
	// 6. bit compare with the worker's dirs
	const a = new Uint32Array(r.dirs.buffer);
	const b = new Uint32Array(hm.result.dirs.buffer);
	let diff = 0;
	for (let i = 0; i < Math.max(a.length, b.length); i++)
		if (a[i] !== b[i]) diff++;
	out.dirsLen = [a.length / 3, b.length / 3];
	out.dirsDiffWords = diff;
	hz.releaseHorizonGpu(mosaics);
	return out;
}

/** Bare WebGPU adapter + device creation in a fresh dedicated worker (the worker path's device cost). */
async function workerDeviceCost() {
	const src = `onmessage = async () => {
		const t0 = performance.now();
		const ad = await navigator.gpu.requestAdapter();
		const t1 = performance.now();
		const dev = await ad.requestDevice({ requiredLimits: { maxStorageBufferBindingSize: ad.limits.maxStorageBufferBindingSize, maxBufferSize: ad.limits.maxBufferSize } });
		const t2 = performance.now();
		dev.destroy();
		postMessage({ adapterMs: t1 - t0, deviceMs: t2 - t1 });
	};`;
	const out = [];
	for (let i = 0; i < 3; i++) {
		const t0 = performance.now();
		const w = new Worker(URL.createObjectURL(new Blob([src])));
		const r = await new Promise((res) => {
			w.onmessage = (e) => res(e.data);
			w.postMessage(0);
		});
		w.terminate();
		out.push({ ...r, totalMs: performance.now() - t0 });
	}
	return out;
}

/** Classifies each ring tile the worker marched against the page's resident terrain tiles. */
function coverage(required, snapTiles) {
	if (!snapTiles) return null;
	const byId = new Map(snapTiles.map((t) => [`${t.z}/${t.x}/${t.y}`, t]));
	const res = snapTiles.filter((t) => t.resident !== false);
	const c = {
		required: required.length,
		exact512: 0,
		sameKeyDownsampled: 0,
		onlyFiner: 0,
		onlyCoarser: 0,
		none: 0,
	};
	const byZ = {};
	for (const k of required) {
		const t = byId.get(`${k.z}/${k.x}/${k.y}`);
		let cls;
		if (t && t.resident !== false)
			cls =
				t.size >= 512 && t.sourceZ === k.z ? "exact512" : "sameKeyDownsampled";
		else {
			const finer = res.some(
				(u) =>
					u.z > k.z && u.x >> (u.z - k.z) === k.x && u.y >> (u.z - k.z) === k.y,
			);
			const coarser = res.some(
				(u) =>
					u.z < k.z && k.x >> (k.z - u.z) === u.x && k.y >> (k.z - u.z) === u.y,
			);
			cls = finer ? "onlyFiner" : coarser ? "onlyCoarser" : "none";
		}
		c[cls]++;
		byZ[k.z] ??= { n: 0, exact512: 0 };
		byZ[k.z].n++;
		if (cls === "exact512") byZ[k.z].exact512++;
	}
	const zooms = {};
	for (const t of snapTiles) {
		const k = `z${t.z}@${t.size}`;
		zooms[k] = (zooms[k] ?? 0) + 1;
	}
	return { ...c, byZ, residentTiles: res.length, residentZooms: zooms };
}

const med = (a) => {
	if (!a?.length) return null;
	const s = [...a].sort((x, y) => x - y);
	return s[Math.floor(s.length / 2)];
};

const browser = await chromium.launch({ headless: true, args: GPU_ARGS });
const rows = [];
try {
	const ctx = await browser.newContext({
		viewport: { width: 1400, height: 900 },
	});
	for (const id of ids) {
		const page = await ctx.newPage();
		page.on("console", (m) => {
			if (m.type() === "error")
				console.error(`[${id} page error]`, m.text().slice(0, 300));
		});
		await page.addInitScript(initScript, PROFILE);
		const tNav = Date.now();
		await page.goto(`${BASE}/photo/${id}?renderer=webgpu`);
		await page.waitForSelector("[data-ready]", {
			state: "attached",
			timeout: 180000,
		});
		await page.waitForFunction(
			() => window.__hm?.marks?.horizonDirs != null && window.__hm.result,
			null,
			{
				timeout: 120000,
			},
		);
		const renderer = await page.evaluate(
			() =>
				document
					.querySelector("[data-renderer]")
					?.getAttribute("data-renderer") ?? null,
		);
		const live = await page.evaluate(() => {
			const hm = window.__hm;
			const rel = (t) => (t == null ? null : t - hm.t0);
			const ev = {};
			for (const [k, t] of hm.events) ev[k] ??= rel(t);
			const tileTs = hm.tiles.map((x) => x.t);
			return {
				error: hm.error ?? null,
				events: ev,
				tilesPosted: hm.tiles.length,
				tileBytesMB: hm.tiles.reduce((a, x) => a + x.bytes, 0) / 1e6,
				distinctSources: new Set(
					hm.tiles
						.filter((x) => x.source)
						.map((x) => `${x.source.z}/${x.source.x}/${x.source.y}`),
				).size,
				firstTileMs: tileTs.length ? Math.min(...tileTs) - hm.t0 : null,
				lastTileMs: tileTs.length ? Math.max(...tileTs) - hm.t0 : null,
				dirsMs: rel(hm.result.t),
				stats: hm.result.stats,
				gpuProfile: hm.result.gpuProfile,
				marks: Object.fromEntries(
					Object.entries(hm.marks).map(([k, v]) => [
						k,
						typeof v === "number" ? rel(v) : v,
					]),
				),
				required: hm.tiles.map((x) => x.key),
				snaps: hm.snaps,
				spans: hm.spans,
			};
		});
		const replay = await page.evaluate(pageReplay);
		const dev = await page.evaluate(workerDeviceCost);
		const cov = {
			atBuild: coverage(live.required, live.snaps.build?.tiles),
			atDirs: coverage(live.required, live.snaps.dirs?.tiles),
			atNeed: coverage(live.required, live.snaps.need?.tiles),
		};
		const slackMs =
			live.marks.photoPrep != null ? live.marks.photoPrep - live.dirsMs : null;
		const row = {
			id,
			renderer,
			wallS: (Date.now() - tNav) / 1000,
			worker: {
				events: live.events,
				tilesPosted: live.tilesPosted,
				distinctSources: live.distinctSources,
				tileBytesMB: live.tileBytesMB,
				firstTileMs: live.firstTileMs,
				lastTileMs: live.lastTileMs,
				dirsMs: live.dirsMs,
				stats: live.stats,
				gpuProfile: live.gpuProfile,
				error: live.error,
			},
			engine: live.marks,
			slackMs,
			coverage: cov,
			snapTimes: Object.fromEntries(
				Object.entries(live.snaps).map(([k, v]) => [k, v?.t]),
			),
			page: replay,
			workerDevice: dev,
		};
		rows.push(row);
		const s = live.stats;
		console.log(
			`${id} [${renderer}] worker: spans→dirs ${live.dirsMs?.toFixed(0)} ms (tiles ${live.firstTileMs?.toFixed(0)}–${live.lastTileMs?.toFixed(0)}, build ${live.events.build?.toFixed(0)}, march req ${live.events.march?.toFixed(0)}) ` +
				`decode ${s.decodeMs.toFixed(0)} mosaic ${s.mosaicMs.toFixed(0)} march ${s.marchMs.toFixed(0)} (${s.marchOn}) ${s.mosaicMB.toFixed(0)} MB ${s.tiles} tiles | ` +
				`need at ${live.marks.photoPrep?.toFixed(0)} ms → slack ${slackMs?.toFixed(0)} ms (dirs used at ${live.marks.horizonDirs?.toFixed(0)}, ${live.marks.horizonSource})`,
		);
		for (const [k, c] of Object.entries(cov))
			if (c)
				console.log(
					`   coverage ${k}: ${c.required} ring tiles: exact512 ${c.exact512}, same key downsampled ${c.sameKeyDownsampled}, only finer ${c.onlyFiner}, only coarser ${c.onlyCoarser}, none ${c.none} (resident ${c.residentTiles})`,
				);
		const p = replay;
		console.log(
			`   page: sameDevice ${p.sameDevice} fetch ${p.fetchMs.toFixed(0)} decode wall ${p.decodeWallMs.toFixed(0)} (sync ${p.decodeSyncMs.toFixed(0)}) mosaic ${p.mosaicMs.toFixed(0)} mips ${p.mipsMs.toFixed(0)} (${p.mosaicMB.toFixed(0)} MB, heap +${p.heapDeltaMB?.toFixed(0)} MB) ` +
				`march cold ${p.marchColdMs.toFixed(0)} (upload ${p.marchColdTiming.uploadMs?.toFixed(0)}) warm ${med(p.marchWarmMs)?.toFixed(1)} | enu f64 ${p.enuF64WarmMs.toFixed(1)} atan ${p.atanF64Ms.toFixed(2)} ms | ` +
				`frames idle med ${med(p.frameIdleMs)?.toFixed(1)} during ${med(p.frameDuringMarchMs)?.toFixed(1)} (max ${Math.max(...p.frameDuringMarchMs, 0).toFixed(1)}, n ${p.frameDuringMarchMs.length}) | dirs ≠ ${p.dirsDiffWords} words`,
		);
		console.log(
			`   worker device: ${dev.map((d) => `${d.adapterMs.toFixed(0)}+${d.deviceMs.toFixed(0)}`).join(", ")} ms (adapter+device)`,
		);
		await page.close();
	}
} finally {
	await browser.close();
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(
	OUT,
	JSON.stringify({ base: BASE, profile: PROFILE, rows }, null, 1),
);
console.log(`wrote ${path.relative(ROOT, OUT)}`);
