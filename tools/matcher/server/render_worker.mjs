#!/usr/bin/env node
// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Long-lived render worker for the matcher service (tools/matcher/server/app.py).
//
// Vendored from ../render.mjs (read-only there): same app-driven render (window.__engine on
// /photo/<ID>, geometry buffer read back explicitly, satellite drape), but
//   - keeps one headless Chromium and the last few /photo pages warm between requests,
//   - writes into a caller-supplied directory (never tools/matcher/out/renders),
//   - renders only the satellite style (hillshade doesn't help, see reports/matcher.md).
//
// Protocol: one JSON object per line on stdin, one JSON reply per line on stdout.
//   {"id":1,"cmd":"render","photoId":"IMG_7155","prior":{yaw,pitch,roll,vfov},"offsets":[-20,..],"outDir":"/tmp/x"}
//   → {"id":1,"ok":true,"meta":{...},"views":[{"tag","pose","W","H","rgb","xyz"}],"timing":{...}}
//   {"id":2,"cmd":"ping"} → {"id":2,"ok":true}
//   {"id":4,"cmd":"release","adhocId":"adhoc-…"} → drops that ad-hoc photo's cached pages
//   {"id":5,"cmd":"reload"} → reloads every cached page (test hook for the Vite-reload case)
//   {"id":3,"cmd":"align","photoId"|"adhoc","priors":[{yaw,pitch,roll,vfov},..],"fullTerrain"?}
//   {"id":6,"cmd":"edges","photoId"|"adhoc","fullTerrain"?,"outDir"} → raw photo evidence for the T6 skyline
//     global search: {w, h, files:{horizon,fine,coarse,fg,rgb}, meta} (horizonDirs float32 ×3, edge maps
//     float32, edge.rgb uint8 RGBA); no autoAlign. Optional "skyGrid":{vfov0,focalKnown,aspect} (T6_GPU_GRID not 0,
//     default off) also writes files.cands (the GPU grid's candidate cells, u32) + reply skyGrid{nYaw,nCombo,…}
//   render also takes "poses":[{tag?,yaw,pitch,roll?,vfov?}] (absolute poses instead of prior+offsets) and
//   "texUpload":true (force the GPU upload of freshly draped textures + gl.finish; policy t6 only)
//   {"id":7,"cmd":"health"} → {browserConnected, ms}: opens and evaluates a throwaway page (/health probe)
//   every reply carries "reopened": pages reopened after losing their engine (HMR reload) since start
//   → {"id":3,"ok":true,"meta":{...},"runs":[{prior, pose, score, confidence, alternatives, ms}],"timing":{...}}
//     (engine.autoAlign(true) once per prior, engine.prior swapped in memory; used by
//      tools/bench/harness for multi-seed / 360° wrappers)
//   align also takes "modes":[{name, horizonPrecision?, alignPrecision?}] and "settleMs"?: every mode runs
//     all priors on the SAME page and terrain, its precision set through the page's live flag overrides
//     (__RIGI_FLAGS__) and the horizon re-traced under it (engine.retraceHorizon); settleMs waits for the
//     terrain stream to be idle that long before each mode. → reply "modes":{name:{runs, horizon:{hash,
//     source, precision}, terrain:{tiles, generation, pending, ids}, terrainAfter, settledMs}}; "runs" =
//     the first mode's (scripts/gpu/precision-gate.mjs)
// Ad-hoc photos (not in public/photos/photos.json), on render and align:
//   "adhoc": {"id":"bench-x","photoFile":"/abs/upright.jpg","meta":{lat,lon,alt,width,height,heading,
//             pitch,roll,vfov,f35},"region":{...RegionData}|null}
//   The page is opened at /photo/<id> with Playwright request interception only (no app code is
//   changed): the photos.json module gets the ad-hoc PhotoMeta appended, /photos/<id>.jpg serves
//   photoFile and /photos/<regionId>.json serves the region (empty if none).
//   "fullTerrain": true refines the terrain all around the eye (engine.loadFullTerrain) and
//   re-traces the 360° horizon, once per page: needed for any yaw search beyond the prior wedge.
// Everything else (logs) goes to stderr.
//
// Engine (2026-10-01): pages open on ?renderer=deck (WebGL, deterministic; the three.js PhotoEngine this
// worker was written for was removed). The views come from the engine's offscreen hooks
// (loadSatellite / renderPoseView / loadFullTerrain, src/lib/renderer.ts; DeckEngine and, since WAG3,
// WebGpuEngine) and keep the three.js output
// contract: <tag>_xyz.f32 = W×H×3 float32 ENU metres in the photo's EnuFrame(lat, lon, 0), row 0 = top,
// 0,0,0 = sky, W×H = 1024 px on the long side; <tag>_sat.jpg = the satellite drape at W×H, canvas JPEG
// q 0.92, haze 0.6, sky #b9cde0.
//
// Page flags (environment; unset = the behaviour above, unchanged). For gates that must run the app under
// an opt-in flag, e.g. the certified-f32 precision gate (scripts/gpu/precision-gate.mjs):
//   MATCHER_RENDERER=deck|webgpu|auto   the ?renderer= the pages open on (default deck). Both engines
//                                       implement renderPoseView / loadFullTerrain / loadSatellite; an
//                                       engine without loadFullTerrain (an older build) keeps the initial
//                                       terrain on "fullTerrain" (meta.fullTerrainUnsupported: true).
//   MATCHER_HORIZON_PRECISION=f64|certified-f32   → ?horizonPrecision= (src/lib/flags)
//   MATCHER_ALIGN_PRECISION=f64|certified-f32     → ?alignPrecision=
//   MATCHER_GPU_COMPUTE=1                         → WebGPU Chromium flags on the deck renderer too
// Every reply's meta carries pageFlags (what the page was opened with, the engine that ran from
// [data-renderer]); with a precision flag set, align runs also carry `precision` (the path each stage
// actually took: lastAlignTiming / the fast horizon's stats), so a run whose certified path fell back
// is visible.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { chromium } from "playwright";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const BASE = process.env.APP_URL ?? "http://localhost:3100";
const MATCHER_PORT = String(process.env.MATCHER_PORT ?? 8765);
const MAX_PAGES = Number(process.env.MATCHER_MAX_PAGES ?? 1); // each draped page holds ~1–1.5 GB in Chromium
const DRAPE_FULL_M = Number(process.env.MATCHER_DRAPE_FULL_M ?? 40000);
const oneOf = (name, allowed, fallback) => {
	const v = process.env[name];
	if (v == null || v === "") return fallback;
	if (!allowed.includes(v))
		throw new Error(`${name}=${v}: expected one of ${allowed.join(", ")}`);
	return v;
};
const PAGE_FLAGS = {
	renderer: oneOf("MATCHER_RENDERER", ["deck", "webgpu", "auto"], "deck"),
	horizonPrecision: oneOf(
		"MATCHER_HORIZON_PRECISION",
		["f64", "certified-f32"],
		null,
	),
	alignPrecision: oneOf(
		"MATCHER_ALIGN_PRECISION",
		["f64", "certified-f32"],
		null,
	),
};
const PRECISION_SET = !!(
	PAGE_FLAGS.horizonPrecision || PAGE_FLAGS.alignPrecision
);
// MATCHER_GPU_COMPUTE=1: launch with the WebGPU flags on the deck renderer too, so the page has the
// WebGPU compute device the certified-f32 stages need (scripts/gpu/precision-gate.mjs, whose modes set
// the precision per call, after launch)
const GPU_COMPUTE = process.env.MATCHER_GPU_COMPUTE === "1";
const pageQuery = () => {
	const q = new URLSearchParams({ renderer: PAGE_FLAGS.renderer });
	if (PAGE_FLAGS.horizonPrecision)
		q.set("horizonPrecision", PAGE_FLAGS.horizonPrecision);
	if (PAGE_FLAGS.alignPrecision)
		q.set("alignPrecision", PAGE_FLAGS.alignPrecision);
	return q.toString();
};
// the engine that ran, as the workspace reports it
const pageFlagsOf = async (page) => ({
	...PAGE_FLAGS,
	engine: await page
		.evaluate(
			() =>
				document
					.querySelector("[data-renderer]")
					?.getAttribute("data-renderer") ?? null,
		)
		.catch(() => null),
});
const log = (...a) => console.error("[render-worker]", ...a);

let browser = null;
let reopened = 0; // pages reopened after an HMR reload swapped their engine (reported on every reply)
const pages = new Map(); // photoId → { page, satReady }

async function getBrowser() {
	if (browser?.isConnected()) return browser;
	browser = await chromium.launch({
		headless: true,
		// WebGPU pages (or a certified-f32 flag, which needs the WebGPU compute device) get the WebGPU flags
		args:
			PAGE_FLAGS.renderer !== "deck" || PRECISION_SET || GPU_COMPUTE
				? (await import("../../../scripts/deck-webgpu/gpu-args.mjs")).GPU_ARGS
				: ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu"],
	});
	return browser;
}

function controlPoints() {
	try {
		return JSON.parse(
			fs.readFileSync(path.join(ROOT, "data", "control-points.json"), "utf8"),
		);
	} catch {
		return {};
	}
}

// /health probe: exercise the browser for real (launch if needed, open a page, evaluate). A browser whose
// Playwright connection died (e.g. after macOS revoked file access) fails here instead of looking alive.
async function browserHealth() {
	const t0 = Date.now();
	const b = await getBrowser();
	const ctx = await b.newContext();
	try {
		const page = await ctx.newPage();
		if ((await page.evaluate(() => 1 + 1)) !== 2)
			throw new Error("page eval returned a wrong value");
	} finally {
		await ctx.close().catch(() => {});
	}
	return { browserConnected: b.isConnected(), ms: Date.now() - t0 };
}

async function dropPage(id) {
	const p = pages.get(id);
	pages.delete(id);
	if (p) await p.page.close().catch(() => {});
}

const PHOTOS_JSON = path.join(ROOT, "public", "photos", "photos.json");

function adhocPhotoMeta(a) {
	const m = a.meta;
	return {
		id: a.id,
		src: `/photos/${a.id}.jpg`,
		width: m.width,
		height: m.height,
		takenAt: m.takenAt ?? "2026-01-01T12:00:00.000Z",
		takenAtUtc: m.takenAt ?? "2026-01-01T12:00:00.000Z",
		tzOffset: null,
		lat: m.lat,
		lon: m.lon,
		alt: m.alt ?? null,
		hAccuracy: m.hAccuracy ?? null,
		heading: m.heading ?? null,
		f35: m.f35 ?? 0,
		vfov: m.vfov,
		gravity: null,
		pitch: m.pitch ?? 0,
		roll: m.roll ?? 0,
		holding: null,
		region: `${a.id}-region`,
	};
}

// page cache key: what changes the loaded page (position, size, fov, and whether a heading exists,
// which sets the initial terrain wedge). pitch/roll/yaw are per-request priors, not page state.
function pageKey(req) {
	if (!req.adhoc) return req.photoId;
	const m = req.adhoc.meta;
	return `adhoc:${req.adhoc.id}:${JSON.stringify([m.lat, m.lon, m.alt ?? null, m.width, m.height, m.vfov, m.heading ?? null])}`;
}

// Every route handler is guarded: a fulfill that fails (page closed/reloading, request aborted) must
// never become an unhandled rejection that takes the whole worker down.
const safe = (fn) => async (r) => {
	try {
		await fn(r);
	} catch (err) {
		log(`route handler: ${String(err?.message ?? err).split("\n")[0]}`);
		await r.abort().catch(() => {});
	}
};

async function routeAdhoc(page, a) {
	if (!/^[\w.-]+$/.test(a.id)) throw new Error(`bad adhoc id ${a.id}`);
	if (!fs.existsSync(a.photoFile))
		throw new Error(`adhoc photoFile missing: ${a.photoFile}`);
	// the caller deletes photoFile's temp dir after its request; a later reload of a still-open page
	// (e.g. Vite full reload) must not read the file again, so the bytes live with the page
	const photoBytes = fs.readFileSync(a.photoFile);
	const meta = adhocPhotoMeta(a);
	const bundled = JSON.parse(fs.readFileSync(PHOTOS_JSON, "utf8")).filter(
		(p) => p.id !== a.id,
	);
	const list = JSON.stringify([...bundled, meta]);
	const region = a.region ?? {
		id: meta.region,
		center: [meta.lat, meta.lon],
		photos: [],
		peaks: [],
		trails: [],
		waterNames: [],
	};
	// photos.ts imports the list as the Vite virtual module `virtual:photos` (served at /@id/__x00__virtual:photos);
	// older builds imported /photos/photos.json?import. Intercept both.
	const isVirtual = (u) =>
		decodeURIComponent(u.pathname).includes("virtual:photos");
	await page.route(
		(u) => u.pathname.endsWith("/photos/photos.json") || isVirtual(u),
		safe((r) => {
			if (isVirtual(new URL(r.request().url())))
				return r.fulfill({
					status: 200,
					contentType: "application/javascript",
					body: `export default ${list}\n`,
				});
			const isModule = new URL(r.request().url()).search.includes("import");
			return isModule
				? r.fulfill({
						status: 200,
						contentType: "application/javascript",
						body: `export default ${list}\n`,
					})
				: r.fulfill({
						status: 200,
						contentType: "application/json",
						body: list,
					});
		}),
	);
	await page.route(
		(u) => u.pathname === `/photos/${a.id}.jpg`,
		safe((r) =>
			r.fulfill({ status: 200, body: photoBytes, contentType: "image/jpeg" }),
		),
	);
	await page.route(
		(u) => u.pathname === `/photos/${meta.region}.json`,
		safe((r) =>
			r.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ ...region, id: meta.region, photos: [a.id] }),
			}),
		),
	);
}

async function openPage(id, adhoc = null, key = id) {
	const hit = pages.get(key);
	if (hit && !hit.page.isClosed()) {
		// an HMR reload swaps the engine; the flag lives on the engine object, so a new one is re-draped
		const alive = await hit.page
			.evaluate(
				() => !!(window.__engine?.terrain && window.__engine.horizonDirs),
			)
			.catch(() => false);
		if (alive) {
			pages.delete(key);
			pages.set(key, hit); // LRU bump
			return { entry: hit, loadMs: 0, warm: true };
		}
		log(`${id}: cached page lost its engine (HMR reload?), reopening`);
		reopened += 1;
		await dropPage(key);
	}
	const b = await getBrowser();
	const t0 = Date.now();
	const page = await b.newPage({ viewport: { width: 1400, height: 900 } });
	page.on("pageerror", (e) => log(`${id} pageerror: ${e.message}`));
	await page.addInitScript(() => localStorage.clear());
	// the headless app must never escalate to this service itself (it would queue behind its own job)
	// the headless app must never escalate to ANY matcher instance (it would queue behind its own job,
	// or load another instance): block the service port range on loopback, whatever our own port is
	await page.route(
		(u) =>
			["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) &&
			(u.port === MATCHER_PORT ||
				(Number(u.port) >= 8765 && Number(u.port) <= 8769)),
		safe((r) => r.abort()),
	);
	if (adhoc) await routeAdhoc(page, adhoc);
	await page.goto(`${BASE}/photo/${id}?${pageQuery()}`); // default pinned: WebGL deck (deterministic, the offscreen hooks); f0 owns this file
	await page.waitForSelector("[data-ready]", {
		state: "attached",
		timeout: 240000,
	});
	const ok = await page
		.evaluate(() => !!window.__engine?.horizonDirs)
		.catch(() => false);
	if (!ok) {
		const err = await page
			.evaluate(() => document.body.innerText.slice(0, 300))
			.catch(() => "");
		await page.close().catch(() => {});
		throw new Error(
			`page for ${id} has no engine/horizon after load: ${err.replace(/\s+/g, " ")}`,
		);
	}
	if (SKY_GPU) await skyGridWarm(page);
	const entry = { page };
	pages.set(key, entry);
	while (pages.size > MAX_PAGES) await dropPage(pages.keys().next().value);
	log(`${id}: page loaded in ${Date.now() - t0} ms`);
	return { entry, loadMs: Date.now() - t0, warm: false };
}

// Load the tiles outside the initial wedge and re-trace the 360° horizon (once per page). null: the engine
// has no loadFullTerrain (an engine build without the hook); the page keeps its initial terrain.
// A failed load (timeout, disposed) closes the page and throws: the caller's retry gets a fresh page, and a
// second failure is an error row, never a row silently computed on the initial terrain.
async function ensureFullTerrain(page, key) {
	try {
		return await page.evaluate(async () => {
			const e = window.__engine;
			if (typeof e.loadFullTerrain !== "function") return null;
			if (e.__benchFullTerrain) return 0;
			// 360° high-detail wedge, query terrain = the complete set, 360° horizon re-traced
			const ms = await e.loadFullTerrain();
			e.__benchFullTerrain = true;
			return ms;
		});
	} catch (err) {
		await dropPage(key);
		throw new Error(`fullTerrain failed: ${String(err?.message ?? err)}`);
	}
}

async function align(req) {
	const id = req.adhoc ? req.adhoc.id : req.photoId;
	if (!/^[\w.-]+$/.test(id)) throw new Error(`bad photoId ${id}`);
	const { entry, loadMs, warm } = await openPage(
		id,
		req.adhoc ?? null,
		pageKey(req),
	);
	const page = entry.page;
	const fullMs = req.fullTerrain
		? await ensureFullTerrain(page, pageKey(req))
		: 0;
	const modes = req.modes ?? null;
	const r = await page.evaluate(
		async ({ priors, precisionSet, modes, settleMs }) => {
			const e = window.__engine;
			const orig = { ...e.prior };
			// with a precision flag or modes: the path each certified stage actually took (fell back or not)
			const alignMod =
				precisionSet || modes
					? await import("/src/lib/gpu/align/index.ts").catch(() => null)
					: null;
			const horizonMod =
				precisionSet || modes
					? await import("/src/lib/integration/horizon-fast-app.ts").catch(
							() => null,
						)
					: null;
			const precisionOf = () => {
				const t = alignMod?.lastAlignTiming;
				return {
					align: t
						? {
								requested: t.precision ?? null,
								refine: t.refine ?? null,
								path: t.cert?.path ?? null,
								reason: t.cert?.reason ?? null,
								detail: t.cert?.detail ?? null,
								forced: t.cert?.stats?.forced ?? null,
								prewarmed: t.cert?.stats?.prewarmed ?? null,
							}
						: null,
					horizon: horizonMod?.lastFastHorizonStats?.precision ?? null,
				};
			};
			const P = (p) =>
				p ? { yaw: p.yaw, pitch: p.pitch, roll: p.roll, vfov: p.vfov } : null;
			// FNV-1a over the bytes: which horizon / terrain a mode's seeds ran on
			const hash = (f) => {
				if (!f) return null;
				const u = new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
				let h = 0x811c9dc5;
				for (let i = 0; i < u.length; i++)
					h = Math.imul(h ^ u[i], 0x01000193) >>> 0;
				return h.toString(16);
			};
			const terrainState = () => {
				const set = e.renderSet;
				return {
					tiles: set?.tiles?.length ?? 0,
					generation: set?.stats?.generation ?? null,
					pending: set?.stats?.pending ?? null,
					ids: hash(
						new TextEncoder().encode(
							(set?.tiles ?? []).map((t) => `${t.id}:${t.seg}`).join(","),
						),
					),
				};
			};
			// streaming idle: the render set unchanged and complete for settleMs (bounded at 60 s)
			const settle = async () => {
				if (!settleMs) return 0;
				const t0 = performance.now();
				let last = e.renderSet;
				let since = t0;
				while (performance.now() - t0 < 60_000) {
					await new Promise((res) => setTimeout(res, 50));
					const cur = e.renderSet;
					if (cur !== last || (cur?.stats?.pending ?? 0) > 0) {
						last = cur;
						since = performance.now();
					} else if (performance.now() - since >= settleMs) break;
				}
				return Math.round(performance.now() - t0);
			};
			const runSeeds = async () => {
				const runs = [];
				for (const pr of priors) {
					e.prior = { ...orig, ...pr };
					const t = performance.now();
					const res = await e.autoAlign(true); // deck: async
					runs.push({
						...(precisionSet || modes
							? { precision: precisionOf(), silTiming: e.silTiming ?? null }
							: {}),
						prior: P(e.prior),
						ms: Math.round(performance.now() - t),
						pose: P(res?.pose),
						score: res?.score ?? null,
						confidence: res?.confidence ?? null,
						alternatives: (res?.alternatives ?? []).map((a) => ({
							pose: P(a.pose),
							score: a.score,
							sil: a.sil ?? null,
							total: a.total ?? a.score,
						})),
					});
				}
				return runs;
			};
			let runs = [];
			const byMode = {};
			globalThis.__RIGI_FLAGS__ ??= {};
			const flags = globalThis.__RIGI_FLAGS__;
			const saved = { ...flags };
			try {
				if (!modes) runs = await runSeeds();
				else
					for (const m of modes) {
						// per-mode precision through the live flag overrides (src/lib/flags getFlag)
						for (const k of ["horizonPrecision", "alignPrecision"])
							if (m[k]) flags[k] = m[k];
							else delete flags[k];
						const settledMs = await settle();
						const t = performance.now();
						const horizonSource = e.retraceHorizon
							? await e.retraceHorizon()
							: "unsupported";
						const retraceMs = Math.round(performance.now() - t);
						const horizonPrecision = precisionOf().horizon;
						const terrain = terrainState();
						const mr = await runSeeds();
						byMode[m.name] = {
							runs: mr,
							horizon: {
								hash: hash(e.horizonDirs),
								source: horizonSource,
								precision: horizonPrecision,
								retraceMs,
							},
							terrain,
							terrainAfter: terrainState(),
							settledMs,
						};
					}
			} finally {
				e.prior = orig;
				for (const k of Object.keys(flags)) delete flags[k];
				Object.assign(flags, saved);
			}
			// the page is cached: leave it with the horizon of its own flags, not the last mode's
			if (modes && e.retraceHorizon) await e.retraceHorizon();
			if (modes) runs = byMode[modes[0].name].runs;
			return {
				runs,
				...(modes ? { modes: byMode } : {}),
				meta: {
					id: e.photo.id,
					width: e.photo.width,
					height: e.photo.height,
					aspect: e.aspect,
					prior: orig,
					eye: [e.eye.x, e.eye.y, e.eye.z],
					demAtCamera: e.demAtCamera,
					frame: { lat: e.frame.lat, lon: e.frame.lon, h: e.frame.h },
					fullTerrain: !!e.__benchFullTerrain,
				},
			};
		},
		{
			priors: req.priors ?? [{}],
			precisionSet: PRECISION_SET,
			modes,
			settleMs: req.settleMs ?? 0,
		},
	);
	r.meta.pageFlags = await pageFlagsOf(page);
	if (req.fullTerrain && fullMs === null) r.meta.fullTerrainUnsupported = true;
	return {
		...r,
		timing: { loadMs, warmPage: warm, fullTerrainMs: fullMs ?? 0 },
	};
}

// T6 (policy t6): raw photo evidence + 360° horizon, no autoAlign. edge.sky is NOT exported: an earlier
// autoAlign on this cached page may have refit it; the caller recomputes a pose-free sky model.
async function edges(req) {
	const id = req.adhoc ? req.adhoc.id : req.photoId;
	if (!/^[\w.-]+$/.test(id)) throw new Error(`bad photoId ${id}`);
	const { entry, loadMs, warm } = await openPage(
		id,
		req.adhoc ?? null,
		pageKey(req),
	);
	const page = entry.page;
	const fullMs = req.fullTerrain
		? await ensureFullTerrain(page, pageKey(req))
		: 0;
	const r = await page.evaluate(() => {
		const e = window.__engine;
		const enc = (f) => {
			const bytes = new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
			let bin = "";
			for (let i = 0; i < bytes.length; i += 0x8000)
				bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
			return btoa(bin);
		};
		return {
			w: e.edge.w,
			h: e.edge.h,
			horizon: enc(e.horizonDirs),
			fine: enc(e.edge.fine),
			coarse: enc(e.edge.coarse),
			fg: enc(e.edge.fg),
			rgb: enc(new Uint8Array(e.edge.rgb)),
			meta: {
				id: e.photo.id,
				width: e.photo.width,
				height: e.photo.height,
				aspect: e.aspect,
				prior: { ...e.prior },
				eye: [e.eye.x, e.eye.y, e.eye.z],
				demAtCamera: e.demAtCamera,
				frame: { lat: e.frame.lat, lon: e.frame.lon, h: e.frame.h },
				fullTerrain: !!e.__benchFullTerrain,
			},
		};
	});
	fs.mkdirSync(req.outDir, { recursive: true });
	const files = {};
	for (const k of ["horizon", "fine", "coarse", "fg", "rgb"]) {
		files[k] = path.join(req.outDir, `edges_${k}.bin`);
		fs.writeFileSync(files[k], Buffer.from(r[k], "base64"));
	}
	r.meta.pageFlags = await pageFlagsOf(page);
	if (req.fullTerrain && fullMs === null) r.meta.fullTerrainUnsupported = true;
	const skyGrid = req.skyGrid ? await edgesSkyGrid(page, req) : null;
	if (skyGrid) {
		files.cands = path.join(req.outDir, "edges_cands.u32");
		fs.writeFileSync(files.cands, Buffer.from(skyGrid.cands, "base64"));
		delete skyGrid.cands;
	}
	return {
		w: r.w,
		h: r.h,
		files,
		meta: r.meta,
		timing: { loadMs, warmPage: warm, fullTerrainMs: fullMs ?? 0 },
		...(skyGrid ? { skyGrid } : {}),
	};
}

// Default on since 2026-10-01 (T6_GPU_GRID=0 in t6.py opts out; added by session mt-image-bc 2026-09-28): the T6 skyline
// grid's certified candidate cells from the WebGPU port (src/lib/gpu/skyglobal), computed in this page on
// the same edge maps + horizonDirs. Python re-scores exactly these cells in numpy (server/sky_gpu.py).
// req.skyGrid = {vfov0, focalKnown, aspect}. → {cands (base64 u32), nYaw, nCombo, nCand, ms, …} or null
// when WebGPU is missing / ?gpu=off / the list overflowed / anything throws (the caller keeps its CPU grid).
async function edgesSkyGrid(page, req) {
	skyGridUsed(page);
	try {
		return await page.evaluate(async (o) => {
			const { getComputeDevice } = await import("/src/lib/gpu/device.ts");
			const device = await getComputeDevice();
			if (!device) return null;
			const { SkyGlobal } = await import("/src/lib/gpu/skyglobal/cpu.ts");
			const { gridGpu } = await import("/src/lib/gpu/skyglobal/index.ts");
			const t0 = performance.now();
			const e = window.__engine;
			const rgba = new Uint8Array(e.edge.rgb);
			const n = e.edge.w * e.edge.h;
			const rgb = new Uint8Array(n * 3);
			for (let i = 0; i < n; i++) {
				rgb[i * 3] = rgba[i * 4];
				rgb[i * 3 + 1] = rgba[i * 4 + 1];
				rgb[i * 3 + 2] = rgba[i * 4 + 2];
			}
			const f32 = (a) => (a instanceof Float32Array ? a : new Float32Array(a));
			const sg = new SkyGlobal(
				{
					w: e.edge.w,
					h: e.edge.h,
					dirs: f32(e.horizonDirs),
					fine: f32(e.edge.fine),
					coarse: f32(e.edge.coarse),
					fg: f32(e.edge.fg),
					rgb,
				},
				o.aspect,
			);
			const g = sg.plan(o.vfov0, o.focalKnown);
			if (!g) return null;
			const r = await gridGpu(device, sg, g);
			if (r.stats.fellBack || !r.cands) return null;
			const bytes = new Uint8Array(
				r.cands.buffer,
				r.cands.byteOffset,
				r.cands.byteLength,
			);
			let bin = "";
			for (let i = 0; i < bytes.length; i += 0x8000)
				bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
			return {
				cands: btoa(bin),
				nYaw: g.nYaw,
				nCombo: g.combos.length,
				nCand: r.cands.length,
				gpuMs: r.stats.gpuMs,
				rescoreMs: r.stats.rescoreMs,
				ms: performance.now() - t0,
			};
		}, req.skyGrid);
	} catch (err) {
		log(`edges skyGrid failed (CPU grid used): ${String(err).slice(0, 300)}`);
		return null;
	}
}

// Skipped with T6_GPU_GRID=0 (session mt-image-bc, 2026-09-30; default on since 2026-10-01): compile
// the grid's pipelines when a page opens (warmSkyGlobalGpuAsync), and free its pooled GPU buffers
// (releaseSkyGlobalGpu, ~32 MB: the cells buffer alone is ~24 MB) once no skyGrid request has used the page
// for SKY_GPU_IDLE_MS. The release runs on the command chain, so never inside a request. Shutdown needs no
// release: closing Chromium frees everything.
const SKY_GPU = !["0", "off", "false"].includes(
	(process.env.T6_GPU_GRID ?? "").trim().toLowerCase(),
);
const SKY_GPU_IDLE_MS = Number(process.env.T6_GPU_IDLE_MS ?? 120000);
const skyGridPages = new Set(); // pages holding the grid's pooled buffers
let skyGridTimer = null;

async function skyGridWarm(page) {
	await page
		.evaluate(async () => {
			const { getComputeDevice } = await import("/src/lib/gpu/device.ts");
			const device = await getComputeDevice();
			if (!device) return;
			const m = await import("/src/lib/gpu/skyglobal/index.ts");
			await m.warmSkyGlobalGpuAsync(device);
		})
		.catch((err) => log(`skyGrid warm failed: ${String(err).slice(0, 200)}`));
}

function skyGridUsed(page) {
	if (!SKY_GPU) return;
	skyGridPages.add(page);
	if (skyGridTimer) clearTimeout(skyGridTimer);
	skyGridTimer = setTimeout(() => {
		skyGridTimer = null;
		chain = chain.then(skyGridRelease);
	}, SKY_GPU_IDLE_MS);
	skyGridTimer.unref();
}

async function skyGridRelease() {
	for (const page of skyGridPages) {
		skyGridPages.delete(page);
		if (page.isClosed()) continue;
		await page
			.evaluate(async () => {
				const { getComputeDevice } = await import("/src/lib/gpu/device.ts");
				const device = await getComputeDevice();
				if (!device) return;
				const m = await import("/src/lib/gpu/skyglobal/index.ts");
				await m.releaseSkyGlobalGpu(device);
			})
			.catch(() => {});
	}
	log("skyGrid: idle, released the grid's GPU buffers");
}

// Skyline cue for fusion, exactly as ../export_skyline.mjs: with engine.prior = the request prior (in
// memory), autoAlign(true) refits the sky colour model from that prior and searches; PhotoWorkspace's
// acceptance rule (as export_skyline applies it) picks the skyline pose. Exports horizonDirs,
// edge.fine / edge.fg and the refit edge.sky as float32 files. engine.prior is restored.
async function exportSkyline(page, prior, outDir) {
	const t0 = Date.now();
	const r = await page.evaluate(async (prior) => {
		const e = window.__engine;
		if (!e.horizonDirs || !e.edge) return null;
		const enc = (f) => {
			const bytes = new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
			let bin = "";
			for (let i = 0; i < bytes.length; i += 0x8000)
				bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
			return btoa(bin);
		};
		const d = (a, b) => ((((a - b) % 360) + 540) % 360) - 180;
		const orig = { ...e.prior };
		try {
			e.prior = { ...prior };
			const t = performance.now();
			const res = await e.autoAlign(true); // deck: async
			const ms = performance.now() - t;
			const near = res?.alternatives?.find(
				(a) => Math.abs(d(a.pose.yaw, e.prior.yaw)) < 4,
			);
			const accepted =
				res && res.confidence > 0.2
					? "confident"
					: near
						? "near-compass"
						: "prior";
			const pose =
				accepted === "confident"
					? res.pose
					: accepted === "near-compass"
						? near.pose
						: e.prior;
			return {
				w: e.edge.w,
				h: e.edge.h,
				horizon: enc(e.horizonDirs),
				fine: enc(e.edge.fine),
				fg: enc(e.edge.fg),
				sky: enc(Float32Array.from(e.edge.sky)),
				app: {
					prior: { ...e.prior },
					pose: { ...pose },
					best: res ? { ...res.pose } : null,
					score: res?.score ?? null,
					confidence: res?.confidence ?? null,
					accepted,
					ms,
				},
			};
		} finally {
			e.prior = orig;
		}
	}, prior);
	if (!r) return null;
	const files = {};
	for (const k of ["horizon", "fine", "fg", "sky"]) {
		files[k] = path.join(outDir, `skyline_${k}.f32`);
		fs.writeFileSync(files[k], Buffer.from(r[k], "base64"));
	}
	return { w: r.w, h: r.h, app: r.app, files, ms: Date.now() - t0 };
}

// One retry of the whole render with a fresh page when a view came back empty because the engine was
// swapped (dev-server reload) or stayed empty after an in-place retry.
async function render(req) {
	try {
		return await renderOnce(req);
	} catch (err) {
		const reload =
			/Execution context was destroyed|Target (page, context or browser )?closed|navigation/i.test(
				String(err?.message),
			);
		if (!err?.retryable && !reload) throw err;
		if (reload) await dropPage(pageKey(req));
		log(
			`${req.adhoc ? req.adhoc.id : req.photoId}: ${err.message}; retrying the render once with a fresh page`,
		);
		const r = await renderOnce(req);
		r.timing.renderRetried = err.message;
		return r;
	}
}

async function renderOnce(req) {
	const id = req.adhoc ? req.adhoc.id : req.photoId;
	if (!/^[\w.-]+$/.test(id)) throw new Error(`bad photoId ${id}`);
	const key = pageKey(req);
	const { entry, loadMs, warm } = await openPage(id, req.adhoc ?? null, key);
	const page = entry.page;
	// tag this engine: a different tag later means the page reloaded (HMR) under us
	const wid = await page.evaluate(
		() => (window.__engine.__wid ??= Math.random().toString(36).slice(2)),
	);
	let emptyRetries = 0;
	const fullTerrainMs = req.fullTerrain
		? await ensureFullTerrain(page, key)
		: 0;
	const cp = req.adhoc ? null : (controlPoints()[id] ?? null);
	const meta = await page.evaluate((cp) => {
		const e = window.__engine;
		const out = {
			id: e.photo.id,
			width: e.photo.width,
			height: e.photo.height,
			aspect: e.aspect,
			prior: { ...e.prior },
			eye: [e.eye.x, e.eye.y, e.eye.z],
			frame: { lat: e.frame.lat, lon: e.frame.lon, h: e.frame.h },
			gt: null,
		};
		if (cp) {
			const pins = e.controlPins(cp);
			const gt = e.solvePins(pins, e.prior, cp.solveFocal !== false);
			out.gt = {
				pose: { yaw: gt.yaw, pitch: gt.pitch, roll: gt.roll, vfov: gt.vfov },
				basis: cp.basis,
				pins: pins.map((p) => ({ world: p.world, u: p.u, v: p.v })),
			};
		}
		return out;
	}, cp);

	const tImg = Date.now();
	// full-terrain (360°) pages drape only tiles within DRAPE_FULL_M: draping every tile out to 120 km
	// costs ~90 s per cold page (all requests go through Playwright interception, no HTTP cache), and
	// far tiles are a few pixels in a 1024-px render. Wedge pages drape everything, as before.
	// Readiness: after the drape, every tile in range must actually carry its imagery (a tile whose
	// fetches failed or were aborted renders as bare shaded DEM). Missing tiles are re-draped (up to 2
	// retries); the count left is reported as timing.imageryMissing.
	const drape = await page.evaluate(
		async ({ limit }) => {
			const e = window.__engine;
			// engine.loadSatellite: fetch the tiles in range, re-fetch failed ones (2 retries). The
			// textures upload when renderPoseView builds its layers (WebGPU: it waits for the imagery
			// array's pending uploads), and its readback waits for the GPU, so texUpload (policy t6's
			// forced upload) has nothing left to do.
			const draped = !e.__matcherSat;
			const r = await e.loadSatellite(limit, 2);
			e.__matcherSat = true;
			return { draped, retries: r.retries, missing: r.missing, tiles: r.tiles };
		},
		{ limit: req.fullTerrain ? (req.drapeMaxM ?? DRAPE_FULL_M) : 0 },
	);
	const draped = drape.draped;
	const imageryMs = Date.now() - tImg;

	const prior = { ...meta.prior, ...(req.prior ?? {}) };
	fs.mkdirSync(req.outDir, { recursive: true });
	const skyline = req.skyline
		? await exportSkyline(page, prior, req.outDir)
		: null;
	const offsets =
		req.views === false ? [] : (req.offsets ?? [-20, -10, 0, 10, 20]);
	const poses = Array.isArray(req.poses)
		? req.poses.map((q, i) => ({
				tag: q.tag ?? `p${i}`,
				yaw: q.yaw,
				pitch: q.pitch,
				roll: q.roll ?? 0,
				vfov: q.vfov ?? prior.vfov,
			}))
		: offsets.map((d) => ({
				tag: `y${d >= 0 ? "+" : ""}${d}`,
				yaw: prior.yaw + d,
				pitch: prior.pitch,
				roll: prior.roll,
				vfov: prior.vfov,
			}));
	const tRender = Date.now();
	const views = [];
	for (const pose of poses) {
		const renderView = (pose) =>
			page.evaluate(async (pose) => {
				const e = window.__engine;
				const r = await e.renderPoseView({
					yaw: pose.yaw,
					pitch: pose.pitch,
					roll: pose.roll,
					vfov: pose.vfov,
				});
				if (!r) throw new Error("renderPoseView returned nothing");
				const W = r.width;
				const H = r.height;
				const bytes = new Uint8Array(r.xyz.buffer);
				let bin = "";
				for (let i = 0; i < bytes.length; i += 0x8000)
					bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
				const xyzB64 = btoa(bin);
				// the same encoder as the three.js version (canvas.toDataURL, JPEG q 0.92)
				const cv = document.createElement("canvas");
				cv.width = W;
				cv.height = H;
				cv.getContext("2d").putImageData(new ImageData(r.rgba, W, H), 0, 0);
				const sat = cv.toDataURL("image/jpeg", 0.92);
				return { W, H, xyzB64, sat };
			}, pose);
		// test hook (MATCHER_DEBUG_HOOKS=1): simulate a dev-server reload right before view N of the first attempt
		if (
			process.env.MATCHER_DEBUG_HOOKS === "1" &&
			req.debugReloadBeforeView === poses.indexOf(pose) &&
			!req.__debugDone
		) {
			req.__debugDone = true;
			await page.reload({ waitUntil: "load" }).catch(() => {});
			await page
				.waitForFunction(() => !!window.__engine?.terrain, null, {
					timeout: 120000,
				})
				.catch(() => {});
		}
		let r = await renderView(pose);
		const countTerrain = (r) => {
			const b = Buffer.from(r.xyzB64, "base64");
			const ff = new Float32Array(b.buffer, b.byteOffset, b.length / 4);
			let n = 0;
			for (let i = 0; i < ff.length; i += 97) if (ff[i] !== 0) n++;
			return { buf: b, nz: n };
		};
		let { buf, nz } = countTerrain(r);
		if (nz === 0 && !req.allowEmpty) {
			// Why is a view empty? Either the engine was swapped under us (a Vite HMR/full reload of the
			// shared dev server mid-render: the page has a new __engine without our drape) or the view has
			// no terrain in it at all. Diagnose, then retry once: in place if the engine is the same, or with
			// a fresh page (whole render) if it was swapped.
			const nowWid = await page
				.evaluate(() => window.__engine?.__wid ?? null)
				.catch(() => null);
			if (nowWid !== wid) {
				await dropPage(key);
				const err = new Error(
					`empty render for ${pose.tag}: engine swapped mid-render (dev-server reload)`,
				);
				err.retryable = true;
				throw err;
			}
			log(
				`${id}: empty render for ${pose.tag} on a live engine; retrying the view once`,
			);
			await new Promise((res) => setTimeout(res, 500));
			r = await renderView(pose);
			({ buf, nz } = countTerrain(r));
			emptyRetries++;
		}
		if (nz === 0 && req.allowEmpty) continue; // narrow fans: a view can be all sky (caller skips it)
		if (nz === 0) {
			await dropPage(key); // dead engine: force a fresh page next time
			const err = new Error(
				`empty render for ${pose.tag} (no terrain in view after a retry)`,
			);
			err.retryable = true;
			throw err;
		}
		const xyzPath = path.join(req.outDir, `${pose.tag}_xyz.f32`);
		const rgbPath = path.join(req.outDir, `${pose.tag}_sat.jpg`);
		fs.writeFileSync(xyzPath, buf);
		fs.writeFileSync(rgbPath, Buffer.from(r.sat.split(",")[1], "base64"));
		const { tag, ...p } = pose;
		views.push({ tag, pose: p, W: r.W, H: r.H, rgb: rgbPath, xyz: xyzPath });
	}
	return {
		meta: {
			...meta,
			pageFlags: await pageFlagsOf(page),
			// as align / edges: an engine without loadFullTerrain rendered on its initial terrain
			...(req.fullTerrain && fullTerrainMs === null
				? { fullTerrainUnsupported: true }
				: {}),
		},
		views,
		skyline,
		timing: {
			loadMs,
			fullTerrainMs: fullTerrainMs ?? 0,
			imageryMs,
			skylineMs: skyline?.ms ?? 0,
			renderMs: Date.now() - tRender,
			warmPage: warm,
			draped,
			emptyViewRetries: emptyRetries,
			imageryRetries: drape.retries,
			imageryMissing: drape.missing,
			imageryTiles: drape.tiles,
		},
	};
}

// Drop the cached pages of an ad-hoc photo (called by app.py when its request finishes).
async function release(req) {
	const id = req.adhoc?.id ?? req.adhocId;
	let n = 0;
	for (const key of [...pages.keys()]) {
		if (key.startsWith(`adhoc:${id}:`)) {
			await dropPage(key);
			n++;
		}
	}
	return n;
}

// Test hook: reload every cached page (what a Vite full reload does to a warm page).
async function reloadPages() {
	const out = [];
	for (const [key, p] of pages) {
		const ok = await p.page
			.reload({ waitUntil: "load", timeout: 60000 })
			.then(() => true)
			.catch((e) => String(e?.message ?? e).split("\n")[0]);
		out.push({ key, ok });
	}
	return { reloaded: out };
}

// Last line of defence: log, never exit, on stray async errors (a dead worker 503s the in-flight request).
process.on("unhandledRejection", (e) =>
	log(`unhandledRejection: ${String(e?.message ?? e).split("\n")[0]}`),
);
process.on("uncaughtException", (e) =>
	log(`uncaughtException: ${String(e?.message ?? e).split("\n")[0]}`),
);

const rl = readline.createInterface({ input: process.stdin });
let chain = Promise.resolve();
rl.on("line", (line) => {
	chain = chain.then(async () => {
		let req;
		try {
			req = JSON.parse(line);
		} catch {
			return;
		}
		let reply;
		try {
			if (req.cmd === "ping") reply = { ok: true };
			else if (req.cmd === "health")
				reply = { ok: true, ...(await browserHealth()) };
			else if (req.cmd === "render")
				reply = { ok: true, ...(await render(req)) };
			else if (req.cmd === "align") reply = { ok: true, ...(await align(req)) };
			else if (req.cmd === "edges") reply = { ok: true, ...(await edges(req)) };
			else if (req.cmd === "release")
				reply = { ok: true, released: await release(req) };
			else if (req.cmd === "reload")
				reply = { ok: true, ...(await reloadPages(req)) };
			else reply = { ok: false, error: `unknown cmd ${req.cmd}` };
		} catch (err) {
			reply = { ok: false, error: String(err?.message ?? err).split("\n")[0] };
		}
		process.stdout.write(
			`${JSON.stringify({ id: req.id, reopened, ...reply })}\n`,
		);
	});
});
// Shut down with the parent: stdin EOF (the Python server died, even by SIGKILL) or SIGTERM/SIGINT
// (a restart). Close Chromium first so no headless browser outlives this worker; don't wait for an
// in-flight command, and exit after 3 s even if the browser won't close.
let shuttingDown = false;
async function shutdown(why) {
	if (shuttingDown) return;
	shuttingDown = true;
	log(`shutting down (${why})`);
	setTimeout(() => process.exit(0), 3000).unref();
	await browser?.close().catch(() => {});
	process.exit(0);
}
rl.on("close", () => shutdown("stdin closed"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
log("ready");
