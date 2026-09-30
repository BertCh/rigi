#!/usr/bin/env node
// Main-thread cost of the three.js engine's GPU→CPU readbacks (workstream "three-readback", 2026-09-30).
// Instruments WebGL2 readPixels / getBufferSubData / clientWaitSync on the page (performance.now()
// around each call; a readPixels into client memory is the full pipeline stall, one into a
// PIXEL_PACK_BUFFER only queues the copy) and attributes each call to its render target by size:
//   geo   — the geometry buffer (1024 × H RGBA32F: labels, occlusion, sampleAt)
//   stats — the band-stats layer (≤ 256 px RGBA32F, LOOK_HARMONIZE in replace mode)
//   sil   — autoAlign's silhouette re-rank (384 × H RGBA32F, one per finalist)
//   hz    — the GPU horizon fallback (1024 × 1536 RGBA32F × 8)
// Phases per photo: load → [data-ready]; autoAlignAsync + autoAlign (total ms, result); 10 pose
// changes (pose-change → geometryReady latency, stalls); harmonize on (replace) + 5 pose changes
// (stats reads); the geometry buffer hash at the ground-truth pose; engine.readbackParity() if present.
//
// Usage (dev server first, then through the render lock):
//   npx vite dev --config scripts/gpu/vite.gpu.config.ts --port 3161
//   node scripts/gpu/with-render-lock.mjs -- node scripts/gpu/three-readback-bench.mjs \
//     --url http://localhost:3161 --photos IMG_6958,IMG_7018 --out out/gpu/followups/three-readback/before.json
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const argv = process.argv.slice(2);
const opt = {};
for (let i = 0; i < argv.length; i++)
	if (argv[i].startsWith("--")) opt[argv[i].slice(2)] = argv[++i];
const BASE_URL = (opt.url ?? "http://localhost:3161").replace(/\/$/, "");
const photos = (opt.photos ?? "IMG_6958,IMG_7018,IMG_7063,IMG_7155").split(",");
const OUT = opt.out ? resolve(ROOT, opt.out) : null;
const gt = JSON.parse(
	readFileSync(join(ROOT, "data/ground-truth.json"), "utf8"),
);

function instrument() {
	const log = [];
	window.__rbLog = log;
	const P = WebGL2RenderingContext.prototype;
	const wrap = (name, info) => {
		const f = P[name];
		P[name] = function (...a) {
			const t = performance.now();
			const r = f.apply(this, a);
			const ms = performance.now() - t;
			log.push({ fn: name, ms, t, ...info(a, r) });
			return r;
		};
	};
	wrap("readPixels", (a) => ({
		w: a[2],
		h: a[3],
		pbo: typeof a[6] === "number",
	}));
	wrap("getBufferSubData", (a) => ({
		bytes: (a[2]?.byteLength ?? 0) - (a[3] ?? 0) * 4,
	}));
	wrap("clientWaitSync", (_a, r) => ({ status: r }));
	window.__lt = [];
	try {
		new PerformanceObserver((l) => {
			for (const e of l.getEntries())
				window.__lt.push({ t: e.startTime, ms: e.duration });
		}).observe({ entryTypes: ["longtask"] });
	} catch {}
}

/** Group the page's GL log since `since` by site; stall = main-thread ms inside the GL calls. */
async function drain(page) {
	return page.evaluate(() => {
		const e = window.__engine;
		const log = window.__rbLog.splice(0);
		const lt = window.__lt.splice(0);
		const dims = {
			geo: [e.geoRT.width, e.geoRT.height],
			stats: e.statsRT ? [e.statsRT.width, e.statsRT.height] : null,
			sil: e.silRT ? [e.silRT.width, e.silRT.height] : null,
			hz: [1024, 1536],
		};
		const site = (w, h) => {
			for (const [k, d] of Object.entries(dims))
				if (d && d[0] === w && d[1] === h) return k;
			return `${w}x${h}`;
		};
		const bySize = (bytes) => {
			for (const [k, d] of Object.entries(dims))
				if (d && d[0] * d[1] * 16 === bytes) return k;
			return `${bytes}B`;
		};
		const out = {};
		const get = (k) => {
			out[k] ??= {
				reads: 0,
				pboReads: 0,
				stallMs: 0,
				maxCallMs: 0,
				perRead: [],
			};
			return out[k];
		};
		let waits = 0;
		let waitMs = 0;
		for (const r of log) {
			if (r.fn === "readPixels") {
				const s = get(site(r.w, r.h));
				if (r.pbo) s.pboReads++;
				else s.reads++;
				s.stallMs += r.ms;
				s.maxCallMs = Math.max(s.maxCallMs, r.ms);
				s.perRead.push(+r.ms.toFixed(3));
			} else if (r.fn === "getBufferSubData") {
				const s = get(bySize(r.bytes));
				s.stallMs += r.ms;
				s.maxCallMs = Math.max(s.maxCallMs, r.ms);
				s.perRead.push(+r.ms.toFixed(3));
			} else if (r.fn === "clientWaitSync") {
				waits++;
				waitMs += r.ms;
			}
		}
		for (const s of Object.values(out)) {
			s.stallMs = +s.stallMs.toFixed(2);
			s.maxCallMs = +s.maxCallMs.toFixed(2);
			if (s.perRead.length > 12) s.perRead = s.perRead.slice(0, 12);
		}
		return {
			sites: out,
			fencePolls: waits,
			fencePollMs: +waitMs.toFixed(2),
			longTasks: lt.length,
			longTaskMaxMs: +Math.max(0, ...lt.map((x) => x.ms)).toFixed(1),
		};
	});
}

async function run(browser, id) {
	const g = gt[id];
	const gtPose = g
		? {
				yaw: g.yaw,
				pitch: g.pitch,
				roll: g.roll,
				vfov: (2 * Math.atan(g.height / (2 * g.f)) * 180) / Math.PI,
			}
		: null;
	const page = await browser.newPage({
		viewport: { width: 1400, height: 900 },
	});
	page.on("pageerror", (e) => console.warn(`[${id}] pageerror`, e.message));
	await page.addInitScript(() => localStorage.clear());
	await page.addInitScript(instrument);
	const t0 = Date.now();
	await page.goto(`${BASE_URL}/photo/${id}?renderer=three`);
	await page.waitForSelector("[data-ready]", {
		state: "attached",
		timeout: 180000,
	});
	await page.waitForFunction(
		() =>
			document.querySelector("[data-ready]")?.getAttribute("data-verify") !==
			"pending",
		null,
		{ timeout: 180000 },
	);
	const loadMs = Date.now() - t0;
	await page.waitForTimeout(500);
	const load = await drain(page);

	// autoAlign: the async path (PhotoWorkspace) and the sync one (tools)
	const align = await page.evaluate(async () => {
		const e = window.__engine;
		const round = (r) =>
			r && {
				pose: r.pose,
				score: r.score,
				confidence: r.confidence,
				alts: (r.alternatives ?? []).map((a) => ({
					yaw: a.pose.yaw,
					pitch: a.pose.pitch,
					sil: a.sil,
					total: a.total,
				})),
			};
		let t = performance.now();
		const a = await e.autoAlignAsync(true);
		const asyncMs = performance.now() - t;
		t = performance.now();
		const s = e.autoAlign(true);
		const syncMs = performance.now() - t;
		return { asyncMs, syncMs, async: round(a), sync: round(s) };
	});
	const alignStalls = await drain(page);

	// pose changes: setPose → geometryReady (the labels' occlusion buffer for THIS pose)
	const poses = await page.evaluate(async (gtPose) => {
		const e = window.__engine;
		const p0 = gtPose ?? { ...e.pose };
		const lat = [];
		for (let k = 0; k < 10; k++) {
			e.setPose({ ...p0, yaw: p0.yaw + 0.4 * (k + 1) });
			const t = performance.now();
			while (!e.geometryReady()) await new Promise((r) => setTimeout(r, 0));
			lat.push(+(performance.now() - t).toFixed(1));
			e.peakLabels();
			await new Promise((r) => setTimeout(r, 60));
		}
		return lat;
	}, gtPose);
	const poseStalls = await drain(page);

	// band stats: harmonize on in replace mode (hillshade: no imagery streaming into the key), 5 poses
	const stats = await page.evaluate(async (gtPose) => {
		const e = window.__engine;
		const p0 = gtPose ?? { ...e.pose };
		e.setStyle({
			...e.style,
			composite: { ...e.style.composite, harmonize: 0.6 },
		});
		e.setSettings({ mode: "replace", mapStyle: "hillshade" });
		const out = [];
		for (let k = 0; k < 5; k++) {
			e.setPose({ ...p0, yaw: p0.yaw - 0.5 * (k + 1) });
			await e.readback();
			await new Promise((r) => setTimeout(r, 250));
			out.push(JSON.stringify(e.look.stats ?? null));
		}
		return out;
	}, gtPose);
	const statsStalls = await drain(page);
	// the stats that landed through the fenced read vs the same frame's stats read synchronously
	// (after only: renderNowSync; the key is reset so layerStats runs again for the same state)
	const statsSyncCheck = await page.evaluate(() => {
		const e = window.__engine;
		let r = null;
		if (e.renderNowSync) {
			const a = JSON.stringify(e.look.stats ?? null);
			e.look.statsKey = "bench-reset";
			e.renderNowSync();
			const b = JSON.stringify(e.look.stats ?? null);
			r = { equal: a === b && a !== "null", landed: a !== "null" };
		}
		e.setSettings({ mode: "overlay", mapStyle: "satellite" });
		return r;
	});
	await drain(page);

	// GPU-busy readback (after only: needs readbackSync): 4 full frames queued, then the geometry read
	// blocking (readbackSync) vs fenced (readback); main-thread ms from the GL log, same run
	let busy = null;
	if (await page.evaluate(() => !!window.__engine.readbackSync)) {
		const one = async (sync) => {
			await page.evaluate(
				async ({ gtPose, sync }) => {
					const e = window.__engine;
					const p0 = gtPose ?? { ...e.pose };
					for (let k = 0; k < 5; k++) {
						e.setPose({ ...p0, yaw: p0.yaw + 0.7 * (k + 1) });
						for (let f = 0; f < 4; f++) e.renderNow();
						if (sync) e.readbackSync();
						else await e.readback();
						await new Promise((r) => setTimeout(r, 120));
					}
				},
				{ gtPose, sync },
			);
			return (await drain(page)).sites.geo;
		};
		busy = { sync: await one(true), async: await one(false) };
	}

	// the geometry buffer at the GT pose, byte hash; the async-vs-sync parity check if present
	const geo = await page.evaluate(async (gtPose) => {
		const e = window.__engine;
		e.setPose(gtPose ?? { ...e.prior });
		await e.readback();
		const bytes = new Uint8Array(e.geoBuf.buffer.slice(0));
		const h = await crypto.subtle.digest("SHA-256", bytes);
		const hex = [...new Uint8Array(h)]
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("")
			.slice(0, 16);
		const parity = e.readbackParity ? await e.readbackParity() : null;
		const labels = e.peakLabels().map((l) => `${l.name}@${l.u.toFixed(4)}`);
		return { hash: hex, parity, labels };
	}, gtPose);
	await page.close();
	return {
		id,
		loadMs,
		load,
		align,
		alignStalls,
		poseLatencyMs: poses,
		poseStalls,
		statsHashes: stats,
		statsStalls,
		statsSyncCheck,
		busy,
		geo,
	};
}

const browser = await chromium.launch({
	headless: true,
	args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu"],
});
const results = [];
try {
	for (const id of photos) {
		// other sessions edit the shared tree: a vite full reload mid-run destroys the page — retry
		let r;
		for (let attempt = 1; ; attempt++) {
			try {
				r = await run(browser, id);
				break;
			} catch (e) {
				if (
					attempt >= 3 ||
					!/context was destroyed|navigation/i.test(e.message)
				)
					throw e;
				console.warn(
					`[${id}] page reloaded mid-run (attempt ${attempt}), retrying`,
				);
			}
		}
		results.push(r);
		const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
		const s = (o, k) => o.sites[k]?.stallMs ?? 0;
		console.log(
			`${id}: load ${r.loadMs} ms | align async ${r.align.asyncMs.toFixed(0)} ms sync ${r.align.syncMs.toFixed(0)} ms, sil stall ${s(r.alignStalls, "sil")} ms | pose→ready median ${med(r.poseLatencyMs)} ms, geo stall ${s(r.poseStalls, "geo")} ms/10 (max call ${r.poseStalls.sites.geo?.maxCallMs ?? 0}) | stats stall ${s(r.statsStalls, "stats")} ms | busy geo stall sync ${r.busy?.sync?.stallMs ?? "-"} ms / async ${r.busy?.async?.stallMs ?? "-"} ms per 5 | stats async=sync ${r.statsSyncCheck?.equal ?? "-"} | geo ${r.geo.hash} parity ${JSON.stringify(r.geo.parity)}`,
		);
	}
} finally {
	await browser.close();
}
if (OUT) {
	mkdirSync(dirname(OUT), { recursive: true });
	writeFileSync(OUT, `${JSON.stringify(results, null, 1)}\n`);
	console.log(`wrote ${OUT}`);
}
