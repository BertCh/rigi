#!/usr/bin/env node
// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Label-sequence probe: records the visible label set (name, u, v, rank) over a scripted sequence
// (load, settle, nudge the pose, settle, change a label setting) plus time spent in peakLabels and
// the number of sampleAt calls per frame. Usage (via the render lock):
//   node scripts/gpu/with-render-lock.mjs -- node scripts/gpu/labels-seq-probe.mjs --url http://localhost:3181 --photo IMG_7068 --out out/gpu/labels-seq/before.json
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const arg = (k, d) => {
	const i = process.argv.indexOf(`--${k}`);
	return i > 0 ? process.argv[i + 1] : d;
};
const BASE = arg("url", "http://localhost:3181");
const id = arg("photo", "IMG_7068");
const OUT = resolve(ROOT, arg("out", "out/gpu/labels-seq/run.json"));
const renderer = arg("renderer", "deck");
const browser = await chromium.launch({
	headless: true,
	args: [
		"--use-angle=swiftshader",
		"--enable-unsafe-swiftshader",
		"--ignore-gpu-blocklist",
	],
});
const ctx = await browser.newContext({
	viewport: { width: 1120, height: 700 },
	deviceScaleFactor: 1,
});
await ctx.routeWebSocket(
	(u) => u.origin === new URL(BASE).origin.replace(/^http/, "ws"),
	() => {},
);
const page = await ctx.newPage();
await page.goto(`${BASE}/photo/${id}?renderer=${renderer}`, {
	waitUntil: "load",
	timeout: 120000,
});
await page.waitForSelector("[data-ready]", {
	state: "attached",
	timeout: 300000,
});
await page.evaluate(() => {
	const e = window.__engine;
	const s = { calls: 0, ms: 0, sample: 0 };
	window.__probe = s;
	const pl = e.peakLabels.bind(e);
	const sa = e.sampleAt.bind(e);
	e.sampleAt = (u, v) => (s.sample++, sa(u, v));
	e.peakLabels = (...a) => {
		const t = performance.now();
		const r = pl(...a);
		s.ms += performance.now() - t;
		s.calls++;
		performance.measure("peakLabels", { start: t });
		return r;
	};
});
const settle = async (ms = 4000) => {
	await page.waitForTimeout(ms);
	await page.evaluate(async () => {
		for (let i = 0; i < 40 && !window.__engine.geometryReady?.(); i++)
			await new Promise((r) => setTimeout(r, 250));
	});
	await page.waitForTimeout(1000);
};
const snap = (label) =>
	page.evaluate((label) => {
		const e = window.__engine;
		const r = (v) => Math.round(v * 1e6) / 1e6;
		const mk = (a) =>
			a.map((l) => [l.name, l.ele, r(l.u), r(l.v), r(l.rank), r(l.distKm)]);
		const _p = window.__probe;
		const out = {
			label,
			ready: e.geometryReady?.(),
			classic: mk(e.peakLabels()),
			panorama: mk(e.peakLabels(100, { declutter: false })),
			dom: [...document.querySelectorAll(".whitespace-nowrap")].map((el) => {
				const b = el.getBoundingClientRect();
				return [
					el.textContent,
					Math.round(b.left * 100) / 100,
					Math.round(b.top * 100) / 100,
				];
			}),
			// frame cost over 3 s of idle frames after this snapshot
			stats: null,
		};
		return out;
	}, label);
const frames = async (ms) => {
	await page.evaluate(() =>
		Object.assign(window.__probe, { calls: 0, ms: 0, sample: 0 }),
	);
	await page.waitForTimeout(ms);
	return page.evaluate(() => ({ ...window.__probe }));
};
const steps = [];
await settle();
steps.push({ ...(await snap("loaded")), idle: await frames(3000) });
// per-frame cost: the engine frame callback calls peakLabels(maxLabels) once per frame; 200 back-to-back
// calls at a fresh buffer = 200 frames of the unchanged-pose steady state
const micro = await page.evaluate(() => {
	const e = window.__engine;
	const s = window.__probe;
	Object.assign(s, { calls: 0, ms: 0, sample: 0 });
	const t = performance.now();
	for (let i = 0; i < 200; i++) e.peakLabels(e.style.labels.maxLabels);
	return {
		frames: 200,
		wallMs: performance.now() - t,
		inPeakLabelsMs: s.ms,
		sampleAtCalls: s.sample,
		msPerFrame: s.ms / 200,
	};
});
console.log("micro", JSON.stringify(micro));
steps.micro = micro;
await page.evaluate(() => {
	const e = window.__engine;
	e.setPose({ ...e.pose, yaw: e.pose.yaw + 0.4, pitch: e.pose.pitch + 0.1 });
});
steps.push({ ...(await snap("during-drag")) });
await settle();
steps.push({ ...(await snap("after-drag")), idle: await frames(3000) });
await page.evaluate(() => {
	const e = window.__engine;
	e.setPose({ ...e.pose, yaw: e.pose.yaw - 0.4, pitch: e.pose.pitch - 0.1 });
});
await settle();
steps.push({ ...(await snap("back")) });
// label setting: maxLabels 6 (reads through the style object the workspace passes to setStyle)
await page.evaluate(() => {
	const e = window.__engine;
	e.setStyle({ ...e.style, labels: { ...e.style.labels, maxLabels: 6 } });
});
await settle(2000);
steps.push({ ...(await snap("maxLabels=6")), idle: await frames(2000) });
await page.evaluate(() => {
	const e = window.__engine;
	e.setSettings({ protectPeople: !e.settings.protectPeople });
});
await settle(2000);
steps.push({ ...(await snap("protectPeople-toggled")) });
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
	OUT,
	JSON.stringify({ photo: id, renderer, micro, steps }, null, 1),
);
console.log(
	steps
		.map(
			(s) =>
				`${s.label}: ready=${s.ready} classic=${s.classic.length} pano=${s.panorama.length} dom=${s.dom.length}${s.idle ? ` idle: ${s.idle.calls} calls, ${(s.idle.ms / Math.max(1, s.idle.calls)).toFixed(3)} ms/call, ${s.idle.sample} sampleAt` : ""}`,
		)
		.join("\n"),
);
await browser.close();
