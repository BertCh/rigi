#!/usr/bin/env node
// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// WAG W1.2 "fewer settle submits" check on the WebGPU engine lab (pinned: ?renderer=webgpu, and
// the run fails unless the engine's device is WebGPU and the look bridge is on):
// - counts GPUQueue.submit calls per settle (pose nudge → geometry fresh → refined masks, band
//   stats and haze landed), split by caller from the call stack: the query geometry render
//   (drawPass), the stats layer render (renderOffscreen), look graphs (ComputeGraph.run: masks,
//   stats, haze, relief), GPU queries (geo-query-gpu), frames and the rest;
// - after one discarded warm-up pass (tiles / imagery still streaming change the stats layer),
//   with engine option settleFusion off, then on, then off again (the second off run shows the
//   scene is stable), over the same absolute pose sequence;
// - BIT: per pose, the refined mask texture bytes and the band stats (JSON) of the fused run must
//   equal the unfused run's;
// - latency per settle, fusion off vs on over the same poses (median, p90; reported, not gated):
//   setPose → geometry fresh (onGeometryFresh entered: the GPU occlusion / skyline queries are
//   done) → labels (onGeometryFresh returned: emit() ran, the label list is current) → masks
//   (refined masks of this generation applied). The pose settles through the engine's own 90 ms
//   debounce (no forced readback), so the numbers include it.
// Style "photo-matched" (refine + harmonize), replace mode, lens blend (no cut: a range / brush
// blend cut keeps the separate masks pass by design).
//   node scripts/gpu/with-render-lock.mjs -- node scripts/deck-webgpu/settle-submits.mjs IMG_7086 [--host deck|direct] [--n 8] [--url http://localhost:3160] [--renderer webgpu]
// --url overrides env APP_URL (default http://localhost:3160). Exit 1 on a failed pin or a BIT
// mismatch. Output: out/deck-webgpu/settle-submits-<id>.json
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { GPU_ARGS } from "./gpu-args.mjs";

const args = process.argv.slice(2);
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : "");
const host = opt("--host") || "deck";
const n = Number(opt("--n") || 8);
const renderer = opt("--renderer") || "webgpu";
if (renderer !== "webgpu") {
	console.error(
		"settle-submits measures the WebGPU engine: --renderer webgpu only",
	);
	process.exit(2);
}
const ids = args.filter(
	(a, i) =>
		!a.startsWith("--") &&
		!["--host", "--n", "--url", "--renderer"].includes(args[i - 1]),
);
if (!ids.length) ids.push("IMG_7086");
const URL0 = opt("--url") || process.env.APP_URL || "http://localhost:3160";
const OUT = resolve(import.meta.dirname, "../../out/deck-webgpu");
mkdirSync(OUT, { recursive: true });

// counts every queue submit while window.__settleCount is on, tagged by the command buffer label
// (graph runs and kernel encoders carry their id) or, for the device's default encoder, by the
// caller on the stack: drawPass = the query geometry render, renderOffscreen = the stats layer
// render, anything else on the default encoder = frames
const COUNTER = () => {
	const q = globalThis.GPUQueue?.prototype;
	if (!q) return;
	const submit = q.submit;
	window.__settleSubmits = [];
	q.submit = function (bufs) {
		if (window.__settleCount) {
			const st = new Error().stack ?? "";
			const label = String(bufs?.[0]?.label ?? "");
			const tag = /drawPass/.test(st)
				? "query-render"
				: /renderOffscreen/.test(st)
					? "stats-render"
					: label.startsWith("look-tex-")
						? `graph:${label.slice(9).split("|")[0]}`
						: /geo-query/.test(label)
							? "geo-query"
							: /relief/.test(label)
								? "relief"
								: label &&
										!/default|unnamed|undefined|commandencoder/i.test(label)
									? `other:${label.slice(0, 40)}`
									: "frame";
			window.__settleSubmits.push(tag);
		}
		return submit.call(this, bufs);
	};
};

const browser = await chromium.launch({ args: GPU_ARGS });
const all = {};
let failed = false;
try {
	for (const id of ids) {
		const page = await browser.newPage({
			viewport: { width: 1280, height: 900 },
		});
		await page.addInitScript(COUNTER);
		const errors = [];
		page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
		page.on("console", (m) => {
			const t = m.text();
			if (m.type() === "error" || /look-bridge|lookgpu|geometry-source/.test(t))
				if (!/Module \w+ not found|Failed to load resource/.test(t))
					errors.push(`${m.type()}: ${t.slice(0, 400)}`);
		});
		const q = new URLSearchParams({
			photo: id,
			host,
			mode: "replace",
			size: "1080x810",
			labels: "false",
			renderer,
		});
		await page.goto(`${URL0}/lab/deck-webgpu?${q}`, { timeout: 240_000 });
		await page.waitForFunction(
			() => document.body.dataset.ready || window.__deckWebgpuLab?.error,
			null,
			{ timeout: 240_000 },
		);
		const r = await page.evaluate(run, n);
		r.errors = errors;
		all[id] = r;
		const ok = r.webgpu && r.bridgeOn && r.bit?.masks && r.bit?.stats;
		if (!ok) failed = true;
		writeFileSync(
			`${OUT}/settle-submits-${id}.json`,
			JSON.stringify(r, null, 1),
		);
		console.log(
			id,
			JSON.stringify({
				webgpu: r.webgpu,
				bridgeOn: r.bridgeOn,
				perSettle: r.perSettle,
				latency: r.latency,
				bit: r.bit,
				stable: r.stable,
				fused: r.fused,
				errors: errors.length,
			}),
		);
		await page.close();
	}
} finally {
	await browser.close();
}
writeFileSync(`${OUT}/settle-submits.json`, JSON.stringify(all, null, 1));
process.exit(failed ? 1 : 0);

async function run(n) {
	const e = window.__engine;
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const { presetStyle } = await import("/src/lib/style/presets.ts");
	const { lookIdle } = await import("/src/lib/gpu/look/opt-in.ts");
	const { readRgba8 } = await import("/src/lib/deck-webgpu/compute-bridge.ts");
	const { gridSize, STATS_LONG_SIDE, trustedRange } = await import(
		"/src/lib/look/composite.ts"
	);
	// band stats A/B in ONE settled state: the separate-submit path (renderLayer → setStats) and the
	// fused one (renderLayer encode → encodeStats), same pose, style, haze fit and inputs. The
	// cross-run comparison below can also differ for timing reasons (whether the haze fit landed
	// before or after a stats render); this one cannot. The bridge's stats key is restored after.
	const statsAB = async () => {
		const b = e.lookBridge;
		const geometry = e.geometryTexture();
		if (!b || !geometry || !e.photoImg) return null;
		const [w, h] = gridSize(e.aspect, STATS_LONG_SIDE);
		const base = {
			img: e.photoImg,
			geometry,
			fg: e.fgMask,
			minRange: trustedRange(e.photo.hAccuracy),
		};
		const key0 = b.statsKey;
		let separate = null;
		let fused = null;
		await e.renderLayer(w, h, async (layer) => {
			separate = await b.setStats({ ...base, key: "ab-separate", layer });
		});
		await e.renderLayer(w, h, null, (layer, encoder) => {
			const r = b.encodeStats({ ...base, key: "ab-fused", layer, encoder });
			return (
				r && {
					after: async () => {
						fused = await r.after();
					},
					cancel: r.cancel,
				}
			);
		});
		b.statsKey = key0;
		return !!separate && JSON.stringify(separate) === JSON.stringify(fused);
	};
	e.setStyle(presetStyle("photo-matched"));
	e.setSettings({ mode: "replace", method: "lens" });
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
		await e.gpu.device.handle.queue.onSubmittedWorkDone();
		await e.nextFrame();
	};
	// the bridge attaches asynchronously
	for (let i = 0; i < 50 && !e.lookBridge; i++) await sleep(100);
	await settle();
	const out = {
		webgpu: e.gpu?.device?.type === "webgpu",
		bridgeOn: !!e.lookBridge,
		runs: {},
	};
	if (!out.bridgeOn || !out.webgpu) return out;
	// latency probes: onGeometryFresh is looked up per call (GeometryGenerations' onFresh arrow)
	let probe = null;
	const masksNow = () =>
		!!e.lookBridge?.masks && e.lookBridge.masks.gen === e.stats.geoBufGen;
	const fresh0 = e.onGeometryFresh;
	e.onGeometryFresh = function (gen) {
		const tIn = performance.now();
		fresh0.call(this, gen);
		if (probe && !probe.labels) {
			probe.fresh = tIn;
			probe.labels = performance.now();
			if (masksNow()) probe.masks = probe.labels;
		}
	};
	const bridge = e.lookBridge;
	const async0 = bridge.onAsync;
	bridge.onAsync = () => {
		async0?.();
		if (probe?.labels && !probe.masks && masksNow())
			probe.masks = performance.now();
	};
	const p0 = { ...e.pose };
	const yaws = Array.from(
		{ length: n },
		(_, k) => (k % 2 ? -0.25 : 0.25) * (1 + (k >> 1)),
	);
	const pass = async (fusion) => {
		e.opts.settleFusion = fusion;
		e.setPose(p0);
		await settle();
		const rows = [];
		for (const dy of yaws) {
			window.__settleSubmits.length = 0;
			window.__settleCount = true;
			probe = { t0: performance.now() };
			e.setPose({ ...p0, yaw: p0.yaw + dy });
			// the engine's own debounced refresh, not a forced readback
			while (!probe.labels && performance.now() - probe.t0 < 5000)
				await sleep(2);
			await settle();
			window.__settleCount = false;
			const lat = probe.labels
				? {
						fresh: probe.fresh - probe.t0,
						labels: probe.labels - probe.t0,
						masks: probe.masks ? probe.masks - probe.t0 : null,
					}
				: null;
			probe = null;
			const tags = {};
			for (const t of window.__settleSubmits) tags[t] = (tags[t] ?? 0) + 1;
			const b = e.lookBridge;
			const masks = b?.masks
				? await readRgba8(b.device, b.masks.texture)
				: null;
			rows.push({
				dy,
				total: window.__settleSubmits.length,
				tags,
				lat,
				masksGen: b?.masks?.gen ?? null,
				geoBufGen: e.stats.geoBufGen,
				masks: masks ? Array.from(masks) : null,
				stats: JSON.stringify(b?.stats ?? null),
				statsAB: fusion ? await statsAB() : null,
			});
		}
		e.setPose(p0);
		await settle();
		return rows;
	};
	// terrain / imagery keep streaming after load (imagery-grow): one discarded warm-up pass over the
	// same poses, so the measured passes see the same scene
	await pass(false);
	const before = { ...(e.lookBridge?.fused ?? {}) };
	const off = await pass(false);
	const on = await pass(true);
	const after = { ...(e.lookBridge?.fused ?? {}) };
	const off2 = await pass(false);
	e.opts.settleFusion = true;
	const same = (a, b) =>
		a === b ||
		(!!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]));
	const cmpRuns = (a, b) => ({
		masks: a.every((r, i) => r.masks && same(r.masks, b[i].masks)),
		stats: a.every((r, i) => r.stats !== "null" && r.stats === b[i].stats),
		masksFresh: a.every((r) => r.masksGen === r.geoBufGen),
	});
	const med = (rows, f) => {
		const v = rows.map(f).sort((x, y) => x - y);
		return v[v.length >> 1];
	};
	const nonFrame = (r) => r.total - (r.tags.frame ?? 0);
	const tagSum = (rows) => {
		const t = {};
		for (const r of rows)
			for (const [k, v] of Object.entries(r.tags)) t[k] = (t[k] ?? 0) + v;
		for (const k of Object.keys(t)) t[k] = +(t[k] / rows.length).toFixed(2);
		return t;
	};
	const pct = (rows, k, q) => {
		const v = rows
			.map((r) => r.lat?.[k])
			.filter((x) => x != null)
			.sort((x, y) => x - y);
		return v.length
			? +v[Math.min(v.length - 1, Math.floor(q * v.length))].toFixed(1)
			: null;
	};
	const latOf = (rows) =>
		Object.fromEntries(
			["fresh", "labels", "masks"].map((k) => [
				k,
				{ median: pct(rows, k, 0.5), p90: pct(rows, k, 0.9) },
			]),
		);
	out.latency = { off: latOf(off), on: latOf(on), off2: latOf(off2) };
	out.perSettle = {
		off: { medianNonFrame: med(off, nonFrame), meanByTag: tagSum(off) },
		on: { medianNonFrame: med(on, nonFrame), meanByTag: tagSum(on) },
		off2: { medianNonFrame: med(off2, nonFrame), meanByTag: tagSum(off2) },
	};
	const bitOn = cmpRuns(on, off);
	out.bit = {
		...bitOn,
		// cross-run stats equality is timing-dependent (see statsAB); the gate is the direct A/B
		statsAcrossRuns: bitOn.stats,
		stats: on.every((r) => r.statsAB === true),
		statsAB: `${on.filter((r) => r.statsAB === true).length}/${on.length}`,
		onFresh: bitOn.masksFresh && cmpRuns(off, on).masksFresh,
	};
	out.stable = cmpRuns(off2, off);
	out.fused = {
		masksPrepared: (after.masksPrepared ?? 0) - (before.masksPrepared ?? 0),
		masksAdopted: (after.masksAdopted ?? 0) - (before.masksAdopted ?? 0),
		statsEncoded: (after.statsEncoded ?? 0) - (before.statsEncoded ?? 0),
	};
	for (const rows of [off, on, off2])
		for (const r of rows) r.masks = r.masks ? r.masks.length : null;
	out.runs = { off, on, off2 };
	return out;
}
