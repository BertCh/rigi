#!/usr/bin/env node
// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Band stats (LOOK_HARMONIZE) probe for the deck engine: per photo, the settled ColorStats of the
// replace view under a harmonising look preset, hashed, plus (optionally) the settled exportImage
// hash per preset and the main-thread time the stats readback costs per pose settle.
// Written to compare the synchronous band-stats readback (deck/composite.ts readLayer) with the
// fenced async one (readLayerAsync): run it before and after and diff the JSON.
// Needs the dev server (APP_URL, default http://localhost:3100). Run under the render lock:
//   node scripts/gpu/with-render-lock.mjs -- node scripts/gpu/bandstats-probe.mjs --out out/bs.json
// Flags:
//   --photos IMG_a,IMG_b   default: every photo in data/control-points.json
//   --presets a,b          looks to settle (default photo-matched; harmonize > 0: photo-matched,
//                          swiss, berann, topo-ink)
//   --export IMG_a,...     photos whose settled exportImage(false) is hashed per preset
//   --stall N              N pose nudges per photo, timing the stats readback's main-thread cost
//   --poses file.json      pin each photo's pose to a previous run's (pose drift is not the subject)
//   --query k=v&...        extra URL query (e.g. gpu=off for the CPU stats path)
//   --sync                 set engine.syncStats = true (the synchronous readback, patched build)
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = path.resolve(import.meta.dirname, "../..");
const BASE = process.env.APP_URL ?? "http://localhost:3100";
const arg = (k, d) => {
	const i = process.argv.indexOf(`--${k}`);
	return i > 0 ? process.argv[i + 1] : d;
};
const list = (s) => (s ? s.split(",").filter(Boolean) : []);
const cps = JSON.parse(
	fs.readFileSync(path.join(ROOT, "data", "control-points.json"), "utf8"),
);
const photos = list(arg("photos")).length
	? list(arg("photos"))
	: Object.keys(cps);
const presets = list(arg("presets", "photo-matched"));
const exportIds = new Set(list(arg("export")));
const stallN = Number(arg("stall", "0"));
const posesFile = arg("poses");
const pinned = posesFile ? JSON.parse(fs.readFileSync(posesFile, "utf8")) : {};
const extra = arg("query", "");
const sync = process.argv.includes("--sync");
const OUT = arg("out", "out/bandstats-probe.json");

const browser = await chromium.launch({
	headless: true,
	args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu"],
});

async function run(id) {
	const page = await browser.newPage({
		viewport: { width: 1400, height: 900 },
	});
	const logs = [];
	page.on("console", (m) => {
		if (m.type() === "error" || m.type() === "warning")
			logs.push(`${m.type()}: ${m.text().slice(0, 200)}`);
	});
	let inflight = 0;
	page.on("request", () => inflight++);
	page.on("requestfinished", () => inflight--);
	page.on("requestfailed", () => inflight--);
	await page.addInitScript(() => {
		localStorage.clear();
		window.__longTasks = [];
		try {
			new PerformanceObserver((l) => {
				for (const e of l.getEntries())
					window.__longTasks.push({ t: e.startTime, d: e.duration });
			}).observe({ type: "longtask", buffered: true });
		} catch {}
	});
	await page.goto(
		`${BASE}/photo/${id}?renderer=deck${extra ? `&${extra}` : ""}`,
	);
	await page.waitForSelector("[data-ready]", {
		state: "attached",
		timeout: 240_000,
	});
	await page.waitForFunction(
		() =>
			document.querySelector("[data-ready]")?.getAttribute("data-verify") !==
			"pending",
		null,
		{ timeout: 180_000 },
	);
	const setup = await page.evaluate(
		async ({ pose, sync }) => {
			const e = window.__engine;
			if (sync) {
				if (!("syncStats" in e)) throw new Error("no engine.syncStats here");
				e.syncStats = true;
			}
			const own = { ...e.pose };
			e.setPose(pose ?? own);
			await e.readback();
			const { lookGpuOn } = await import("/src/lib/gpu/look/opt-in.ts");
			// instrument the stats readback (main-thread time of each call)
			const c = e.compositor;
			window.__reads = [];
			for (const name of ["readLayer", "readLayerAsync"]) {
				const f = c[name];
				if (typeof f !== "function") continue;
				c[name] = function (...a) {
					const t0 = performance.now();
					const r = f.apply(this, a);
					const t1 = performance.now();
					const rec = { name, t0, syncMs: t1 - t0 };
					window.__reads.push(rec);
					if (r && typeof r.then === "function")
						r.then(() => {
							rec.landMs = performance.now() - t0;
							rec.copyMs = c.lastStatsRead?.copyMs;
							rec.fenceMs = c.lastStatsRead?.fenceMs;
						});
					return r;
				};
			}
			return { own, lookGpu: lookGpuOn() };
		},
		{ pose: pinned[id] ?? null, sync },
	);

	// settled: no network, no stats timer / read pending, look passes idle, stats hash stable
	const statsNow = () =>
		page.evaluate(async () => {
			const e = window.__engine;
			const { lookIdle } = await import("/src/lib/gpu/look/opt-in.ts");
			await lookIdle();
			const s = e.compLook.stats;
			let hash = null;
			if (s) {
				const parts = [
					s.photoMean,
					s.photoStd,
					s.layerMean,
					s.layerStd,
					s.count,
				];
				const n = parts.reduce((a, p) => a + p.byteLength, 0) + 1;
				const all = new Uint8Array(n);
				let o = 0;
				for (const p of parts) {
					all.set(new Uint8Array(p.buffer, p.byteOffset, p.byteLength), o);
					o += p.byteLength;
				}
				all[o] = s.valid ? 1 : 0;
				const d = await crypto.subtle.digest("SHA-1", all);
				hash = [...new Uint8Array(d)]
					.map((x) => x.toString(16).padStart(2, "0"))
					.join("");
			}
			return {
				hash,
				key: e.compLook.statsKey,
				busy: !!e.statsTimer || !!e.statsPending,
			};
		});
	const settle = async () => {
		const deadline = Date.now() + 120_000;
		let last = "";
		let same = 0;
		while (Date.now() < deadline) {
			await page.waitForTimeout(700);
			if (inflight > 0) {
				same = 0;
				continue;
			}
			const s = await statsNow();
			const sig = `${s.hash}|${s.key}|${s.busy}`;
			if (!s.busy && sig === last) {
				if (++same >= 3) return s;
			} else {
				same = 0;
				last = sig;
			}
		}
		return { ...(await statsNow()), unsettled: true };
	};

	const out = {
		id,
		pose: pinned[id] ?? setup.own,
		lookGpu: setup.lookGpu,
		presets: {},
	};
	for (const preset of presets) {
		await page.evaluate(async (preset) => {
			const e = window.__engine;
			const { presetStyle } = await import("/src/lib/style/presets.ts");
			e.setSettings({ mode: "replace", mapStyle: "satellite" });
			e.setStyle(presetStyle(preset));
		}, preset);
		const st = await settle();
		const row = { stats: st.hash, key: st.key, unsettled: !!st.unsettled };
		if (exportIds.has(id)) {
			const b64 = await page.evaluate(async () => {
				const blob = await window.__engine.exportImage(false);
				if (!blob) return null;
				const buf = new Uint8Array(await blob.arrayBuffer());
				let s = "";
				for (let i = 0; i < buf.length; i += 0x8000)
					s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
				return btoa(s);
			});
			row.export = b64
				? createHash("sha1").update(Buffer.from(b64, "base64")).digest("hex")
				: null;
			// and export straight after a fresh settle (stats read still in flight)
			const b64b = await page.evaluate(async () => {
				const e = window.__engine;
				const p = { ...e.pose };
				e.setPose({ ...p, yaw: p.yaw + 0.3 });
				await e.readback();
				e.setPose(p);
				await e.readback();
				await new Promise((r) => setTimeout(r, 130)); // the stats timer fires (120 ms)
				const pending = !!e.statsPending;
				const blob = await e.exportImage(false);
				if (!blob) return null;
				const buf = new Uint8Array(await blob.arrayBuffer());
				let s = "";
				for (let i = 0; i < buf.length; i += 0x8000)
					s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
				return { b64: btoa(s), pending };
			});
			const st2 = await settle();
			row.exportRacing = b64b
				? createHash("sha1")
						.update(Buffer.from(b64b.b64, "base64"))
						.digest("hex")
				: null;
			row.exportRacingPending = b64b?.pending;
			row.statsAfterRace = st2.hash;
		}
		out.presets[preset] = row;
	}

	if (stallN > 0) {
		const r = await page.evaluate(async (n) => {
			const e = window.__engine;
			const p0 = { ...e.pose };
			window.__reads = [];
			window.__longTasks = [];
			const gaps = [];
			for (let i = 0; i < n; i++) {
				e.setPose({ ...p0, yaw: p0.yaw + (i % 2 ? -0.4 : 0.4) });
				await e.readback();
				// a settle reaches scheduleStats through updateLayers (haze refit / relief rebuild); a
				// 0.4° nudge may trigger neither, so ask directly (the key changed with the buffer)
				e.updateLayers();
				// rAF gaps over the stats window (timer 120 ms + read)
				let last = performance.now();
				let max = 0;
				const t0 = last;
				await new Promise((res) => {
					const tick = () => {
						const t = performance.now();
						max = Math.max(max, t - last);
						last = t;
						if (t - t0 < 900) requestAnimationFrame(tick);
						else res();
					};
					requestAnimationFrame(tick);
				});
				gaps.push(max);
			}
			e.setPose(p0);
			await e.readback();
			return {
				reads: window.__reads.map((x) => ({ ...x })),
				longTasks: window.__longTasks.slice(),
				maxRafGapMs: gaps,
			};
		}, stallN);
		out.stall = r;
	}
	out.logs = logs
		.filter((l) => /band stats|readback|stats/i.test(l))
		.slice(0, 10);
	await page.close();
	return out;
}

const rows = [];
for (const id of photos) {
	process.stdout.write(`${id}… `);
	// a hung page (an export that never resolves) fails its photo instead of the whole run
	const timeout = new Promise((_, rej) =>
		setTimeout(() => rej(new Error("photo timed out (8 min)")), 480_000),
	);
	const r = await Promise.race([run(id), timeout]).catch((e) => ({
		id,
		error: String(e).slice(0, 300),
	}));
	rows.push(r);
	if (r.error) console.log(`ERROR ${r.error}`);
	else
		console.log(
			Object.entries(r.presets)
				.map(
					([k, v]) =>
						`${k}: stats ${v.stats?.slice(0, 10)}${v.unsettled ? " UNSETTLED" : ""}${v.export ? ` export ${v.export.slice(0, 10)} race ${v.exportRacing?.slice(0, 10)}${v.exportRacingPending ? "(pending)" : ""}` : ""}`,
				)
				.join(" | ") +
				(r.stall
					? ` | stall sync ms ${r.stall.reads.map((x) => x.syncMs.toFixed(1)).join(",")}`
					: ""),
		);
}
await browser.close();
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(
	OUT,
	JSON.stringify(
		{ at: new Date().toISOString(), base: BASE, extra, sync, rows },
		null,
		1,
	),
);
console.log(`wrote ${OUT}`);
