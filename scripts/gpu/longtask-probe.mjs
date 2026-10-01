#!/usr/bin/env node
// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Main-thread long tasks (>50 ms, PerformanceObserver 'longtask') while /photo/<id> opens, per renderer.
// The observer is installed by an init script before any app code runs and is buffered; each task is
// reported relative to navigation start together with the data-ready time. Long tasks are visible
// for the page's main thread only, not for workers (sky, unknown-pose, mesh): the worker share is not
// measured here. --cpuprofile also runs a CDP sampling profile (main thread) and lists each busy
// segment >= 50 ms with its top self-time frames (names the long task). Always under the render lock:
//   node scripts/gpu/with-render-lock.mjs -- node scripts/gpu/longtask-probe.mjs --renderer webgpu [--url http://localhost:3124]
//     [--reps 1] [--cpuprofile] [--out out/baseline/longtask-webgpu.json] [IMG_7086 …]   (no ids = the 19 ground-truth photos)
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	launch,
	makeArg,
	median,
	openPhoto,
	p90Of,
	photoIds,
} from "./probe-common.mjs";

const arg = makeArg();
const BASE = arg("url", process.env.APP_URL ?? "http://localhost:3110");
const RENDERER = arg("renderer", "webgpu");
const REPS = Number(arg("reps", "1"));
const OUT = arg("out", `out/baseline/longtask-${RENDERER}.json`);
const CPUPROFILE = process.argv.includes("--cpuprofile");
const ids = photoIds();

/** Busy segments (gaps < 5 ms merged, >= 50 ms kept) of a V8 cpuprofile with their top self-time frames. */
function busySegments(profile) {
	const byId = new Map(profile.nodes.map((n) => [n.id, n]));
	const t = [];
	let at = profile.startTime;
	for (let i = 0; i < profile.samples.length; i++) {
		at += profile.timeDeltas[i];
		t.push(at);
	}
	const idle = (n) =>
		["(idle)", "(program)"].includes(n.callFrame.functionName);
	const segs = [];
	let cur = null;
	for (let i = 0; i < profile.samples.length; i++) {
		const n = byId.get(profile.samples[i]);
		const dt = (profile.timeDeltas[i + 1] ?? 0) / 1000;
		if (idle(n)) continue;
		const ms = (t[i] - profile.startTime) / 1000;
		if (cur && ms - cur.end < 5) {
			cur.end = ms + dt;
		} else {
			if (cur) segs.push(cur);
			cur = { start: ms, end: ms + dt, self: new Map() };
		}
		const f = n.callFrame;
		const key = `${f.functionName || "(anon)"} ${f.url.replace(/^.*\/\/[^/]+/, "")}:${f.lineNumber}`;
		cur.self.set(key, (cur.self.get(key) ?? 0) + dt);
	}
	if (cur) segs.push(cur);
	return segs
		.filter((x) => x.end - x.start >= 50)
		.map((x) => ({
			startMs: Math.round(x.start),
			durationMs: Math.round(x.end - x.start),
			top: [...x.self.entries()]
				.sort((a, b) => b[1] - a[1])
				.slice(0, 5)
				.map(([k, v]) => `${k} ${Math.round(v)} ms`),
		}));
}

const browser = await launch();
const rows = [];
for (const id of ids)
	for (let rep = 0; rep < REPS; rep++) {
		const ctx = await browser.newContext({
			viewport: { width: 1400, height: 900 },
		});
		await ctx.addInitScript(() => {
			localStorage.clear();
			window.__lt = [];
			try {
				new PerformanceObserver((l) => {
					for (const e of l.getEntries())
						window.__lt.push({ start: e.startTime, duration: e.duration });
				}).observe({ type: "longtask", buffered: true });
			} catch {}
		});
		const page = await ctx.newPage();
		const errors = [];
		page.on("pageerror", (e) => errors.push(e.message));
		const cdp = CPUPROFILE ? await ctx.newCDPSession(page) : null;
		if (cdp) {
			await cdp.send("Profiler.enable");
			await cdp.send("Profiler.setSamplingInterval", { interval: 500 });
			await cdp.send("Profiler.start");
		}
		const o = await openPhoto(page, BASE, id, RENDERER);
		await page.waitForTimeout(2000);
		let segments;
		if (cdp) {
			const { profile } = await cdp.send("Profiler.stop");
			segments = busySegments(profile);
		}
		const lt = await page.evaluate(() => ({
			tasks: window.__lt,
			dataReadyAt: performance.now(),
			renderer: document
				.querySelector("[data-renderer]")
				?.getAttribute("data-renderer"),
		}));
		const d = lt.tasks.map((t) => t.duration);
		const row = {
			id,
			rep,
			renderer: lt.renderer,
			...o,
			errors,
			segments,
			count: d.length,
			totalMs: d.reduce((a, b) => a + b, 0),
			maxMs: d.length ? Math.max(...d) : 0,
			tasks: lt.tasks.map((t) => ({
				start: Math.round(t.start),
				duration: Math.round(t.duration),
			})),
		};
		rows.push(row);
		console.log(
			`${id} ${row.renderer} ready ${o.readyMs} ms: ${row.count} long tasks, total ${Math.round(row.totalMs)} ms, max ${Math.round(row.maxMs)} ms${errors.length ? ` errors ${errors.length}` : ""}`,
		);
		await ctx.close();
	}
await browser.close();
const summary = {
	photos: rows.length,
	renderer: RENDERER,
	countMedian: median(rows.map((r) => r.count)),
	totalMedian: median(rows.map((r) => r.totalMs)),
	totalP90: p90Of(rows.map((r) => r.totalMs)),
	maxMedian: median(rows.map((r) => r.maxMs)),
	maxP90: p90Of(rows.map((r) => r.maxMs)),
	maxOfMax: Math.max(...rows.map((r) => r.maxMs)),
};
console.log(JSON.stringify(summary));
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ url: BASE, summary, rows }, null, 1));
console.log(`wrote ${OUT}`);
