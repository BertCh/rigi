#!/usr/bin/env node
// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// WAG W1.1 gate: photo prep planes resident on the device, CPU map a lazy read, align binding the
// resident planes. Per photo, in headless Chromium on the WebGPU engine:
//  - prep: buildPhotoPrepAsync until the device is qualified (its first results are read eagerly),
//    then one more: it must be resident and unread (no materialized map) after the call; its lazy
//    read must equal align.ts buildEdgeMap bit for bit (coarse, fine, sky, skyCum)
//  - grid: scorePoseGridGpu on the resident map (planes bound from the prep, residentBytes > 0) vs on
//    a copy with fresh arrays (uploaded): 0 differing bits
//  - search: gpu/align autoAlignAsync on the resident map vs align.ts autoAlign on the CPU map: every
//    hypothesis identical (pose and score)
//  - cpuSync: a fresh resident prep read through cpuSync (the CPU reference) gives the same planes,
//    its later cpu() resolves that same object (no second map), and its unread GPU planes leave
//    residency (never pinned)
// Usage (under the render lock, with a dev server on this tree):
//   node scripts/gpu/with-render-lock.mjs -- node scripts/gpu/photoprep-resident.mjs
//     [--url http://localhost:3110] [--out out/gpu/photoprep/resident.json] [IMG_xxxx ...]
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { chromium } from "playwright";

const argv = process.argv.slice(2);
const opt = (k, d) => {
	const i = argv.indexOf(k);
	return i >= 0 ? argv.splice(i, 2)[1] : d;
};
const BASE = opt("--url", process.env.APP_URL ?? "http://localhost:3110");
const OUT = opt("--out", "out/gpu/photoprep/resident.json");
const IDS = argv.length ? argv : ["IMG_6958", "IMG_7018", "IMG_7063"];

const browser = await chromium.launch({
	headless: true,
	args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu"],
});
const rows = [];
try {
	for (const id of IDS) {
		const page = await browser.newPage({
			viewport: { width: 1400, height: 900 },
		});
		const logs = [];
		page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
		page.on(
			"console",
			(m) =>
				(m.type() === "error" || m.text().includes("[gpu]")) &&
				logs.push(`${m.type()}: ${m.text().slice(0, 200)}`),
		);
		await page.addInitScript(() => localStorage.clear());
		await page.goto(`${BASE}/photo/${id}?renderer=webgpu`);
		await page.waitForSelector("[data-ready]", {
			state: "attached",
			timeout: 240000,
		});
		const r = await page.evaluate(async () => {
			const A = await import("/src/lib/align.ts");
			const P = await import("/src/lib/gpu/photoprep/index.ts");
			const G = await import("/src/lib/gpu/align/index.ts");
			const PG = await import("/src/lib/gpu/align/pose-grid.ts");
			const DEV = await import("/src/lib/gpu/core/device.ts");
			const e = window.__engine;
			const out = {
				renderer: document
					.querySelector("[data-renderer]")
					?.getAttribute("data-renderer"),
			};
			const dev = await DEV.getComputeDevice();
			if (!dev) return { ...out, error: "no WebGPU device" };
			const img = e.photoElement;
			const { horizonDirs: dirs, prior, aspect } = e;
			if (!img || !dirs) return { ...out, error: "engine not ready" };
			const diff = (a, b) => {
				for (const k of ["coarse", "fine", "sky", "skyCum"]) {
					const x = a[k];
					const y = b[k];
					if (x.length !== y.length) return `${k} length`;
					const xb = new Uint32Array(x.buffer, x.byteOffset, x.length);
					const yb = new Uint32Array(y.buffer, y.byteOffset, y.length);
					for (let i = 0; i < xb.length; i++)
						if (xb[i] !== yb[i]) return `${k}[${i}]`;
				}
				return "";
			};
			await P.warmPhotoPrep();
			// qualify the device (its first PREP_VERIFY_FIRST results are read and compared eagerly)
			const timings = [];
			let prep;
			for (let i = 0; i <= P.PREP_VERIFY_FIRST + 1; i++) {
				prep = await P.buildPhotoPrepAsync(img, 512, null);
				timings.push({ ...P.lastPhotoPrepTiming });
			}
			out.timings = timings;
			out.disabled = P.gpuPhotoPrepDisabled(dev);
			const last = timings[timings.length - 1];
			out.lazy = {
				resident: prep.resident && last.resident === true,
				unread: prep.materialized === undefined,
			};
			const ref = A.buildEdgeMap(img, 512, null);
			let t = performance.now();
			const map = await prep.cpu();
			out.lazy.readMs = performance.now() - t;
			out.lazy.source = prep.source;
			out.lazy.diff = diff(map, ref);
			out.lazy.memo = (await prep.cpu()) === map && prep.cpuSync() === map;
			// grid: resident planes vs uploaded copies, same prior sky fit on both
			A.fitPriorSky(prior, aspect, dirs, map);
			const copy = {
				...map,
				coarse: map.coarse.slice(),
				fine: map.fine.slice(),
				fg: map.fg.slice(),
			};
			const { poses } = A.coarseGridPoses(prior, 25);
			const sRes = {};
			const sUp = {};
			const gRes = await PG.scorePoseGridGpu(
				dev,
				poses,
				aspect,
				dirs,
				map,
				3,
				sRes,
			);
			const gUp = await PG.scorePoseGridGpu(
				dev,
				poses,
				aspect,
				dirs,
				copy,
				3,
				sUp,
			);
			let bitDiffs = gRes.length === gUp.length ? 0 : -1;
			const a = new Uint32Array(gRes.buffer, gRes.byteOffset, gRes.length);
			const b = new Uint32Array(gUp.buffer, gUp.byteOffset, gUp.length);
			for (let i = 0; bitDiffs >= 0 && i < a.length; i++)
				if (a[i] !== b[i]) bitDiffs++;
			out.grid = {
				cells: a.length,
				bitDiffs,
				resident: sRes,
				uploaded: sUp,
			};
			// search: resident map through autoAlignAsync vs the CPU map through autoAlign
			const prep2 = await P.buildPhotoPrepAsync(img, 512, null);
			const m2 = await prep2.cpu();
			const cpuMap = A.buildEdgeMap(img, 512, null);
			t = performance.now();
			const rg = await G.autoAlignAsync(prior, aspect, dirs, m2, 25);
			const gpuMs = performance.now() - t;
			const timing = G.lastAlignTiming;
			const rc = A.autoAlign(prior, aspect, dirs, cpuMap, 25);
			const same = (x, y) =>
				x.length === y.length &&
				x.every(
					(h, i) =>
						h.score === y[i].score &&
						["yaw", "pitch", "roll", "vfov"].every(
							(k) => h.pose[k] === y[i].pose[k],
						),
				);
			out.search = {
				identical:
					same(rc.alternatives, rg.alternatives) &&
					rc.pose.yaw === rg.pose.yaw &&
					rc.score === rg.score,
				gpuMs,
				path: timing?.path,
				refine: timing?.refine,
				uploadBytes: timing?.uploadBytes,
				residentBytes: timing?.residentBytes,
				boundResidentBytes: timing?.boundStats?.residentBytes,
				error: timing?.error,
			};
			// cpuSync first on a fresh resident prep
			const prep3 = await P.buildPhotoPrepAsync(img, 512, null);
			const wasResident = prep3.resident;
			const s3 = prep3.cpuSync();
			const c3 = await prep3.cpu();
			out.cpuSync = {
				wasResident,
				source: prep3.source,
				sameObject: s3 === c3,
				// the CPU reference won: the unread GPU planes must never be bound
				residentAfter: prep3.resident,
				pinned: !!P.pinResidentPlanes(dev, s3),
				diff: diff(s3, ref),
			};
			return out;
		});
		rows.push({ id, ...r, logs: logs.slice(0, 8) });
		console.log(
			`${id} [${r.renderer}] ${r.error ? `ERROR ${r.error}` : `lazy resident=${r.lazy?.resident} unread=${r.lazy?.unread} source=${r.lazy?.source} diff='${r.lazy?.diff}' read ${r.lazy?.readMs?.toFixed(1)} ms memo=${r.lazy?.memo} | grid bitDiffs ${r.grid?.bitDiffs} resident ${r.grid?.resident?.residentBytes ?? 0} B up ${r.grid?.resident?.uploadBytes} B (copy up ${r.grid?.uploaded?.uploadBytes} B) | search identical=${r.search?.identical} path ${r.search?.path}/${r.search?.refine} residentBytes ${r.search?.residentBytes} bound ${r.search?.boundResidentBytes} | cpuSync ${r.cpuSync?.source} same=${r.cpuSync?.sameObject} resident ${r.cpuSync?.wasResident}→${r.cpuSync?.residentAfter} pinned=${r.cpuSync?.pinned} diff='${r.cpuSync?.diff}'`}`,
		);
		await page.close();
	}
} finally {
	await browser.close();
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
	OUT,
	JSON.stringify({ at: new Date().toISOString(), rows }, null, 1),
);
const pass = rows.every(
	(r) =>
		!r.error &&
		r.renderer === "webgpu" &&
		!r.disabled &&
		r.lazy?.resident &&
		r.lazy?.unread &&
		r.lazy?.source === "gpu-read" &&
		r.lazy?.diff === "" &&
		r.lazy?.memo &&
		r.grid?.bitDiffs === 0 &&
		(r.grid?.resident?.residentBytes ?? 0) > 0 &&
		r.search?.identical &&
		r.search?.path === "gpu" &&
		(r.search?.residentBytes ?? 0) > 0 &&
		r.cpuSync?.sameObject &&
		r.cpuSync?.wasResident &&
		!r.cpuSync?.residentAfter &&
		!r.cpuSync?.pinned &&
		r.cpuSync?.diff === "",
);
console.log(`${pass ? "PASS" : "FAIL"}; wrote ${OUT}`);
process.exit(pass ? 0 : 3);
