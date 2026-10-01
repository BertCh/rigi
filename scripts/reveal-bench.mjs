#!/usr/bin/env node
// Reveal (intro animation) frame-time bench: deck (WebGL), same photo, same preset (the three.js arm was
// dropped with the three.js renderer, 2026-10-01).
// For each engine: load /photo/<id>?reveal=off, wait for [data-ready], then run
// window.__reveal.play() and record every rAF interval while it plays.
// deck is run twice: as shipped, and "legacy" (compositor.onChange → updateLayers, i.e. every
// reveal frame rebuilds the terrain layers and re-renders the colour pass) for the before/after.
// Usage: node scripts/gpu/with-render-lock.mjs -- node scripts/reveal-bench.mjs \
//          [--url http://localhost:3100] [--photos IMG_6958] [--preset bloom] [--secs 4]
import { chromium } from "playwright";

const arg = (k, d) => {
	const i = process.argv.indexOf(`--${k}`);
	return i > 0 ? process.argv[i + 1] : d;
};
const BASE = arg("url", "http://localhost:3100");
const IDS = arg("photos", "IMG_6958").split(",");
const PRESET = arg("preset", "bloom");
const SECS = Number(arg("secs", "4"));

const browser = await chromium.launch({
	headless: !process.argv.includes("--headed"),
	args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu"],
});

async function run(id, renderer, legacy) {
	const ctx = await browser.newContext({
		viewport: { width: 1400, height: 900 },
		deviceScaleFactor: 2,
	});
	const page = await ctx.newPage();
	// renderer always explicit: the app default may be either
	const q = new URLSearchParams({ reveal: "off", renderer });
	await page.goto(`${BASE}/photo/${id}?${q}`);
	await page.waitForSelector("[data-ready]", { timeout: 240_000 });
	await page.waitForTimeout(1500);
	const r = await page.evaluate(
		async ({ preset, secs, legacy }) => {
			const e = window.__engine;
			if (legacy && e.compositor)
				e.compositor.onChange = () => e.updateLayers();
			const cfg = { preset, duration: secs };
			const dts = [];
			let last = performance.now();
			let on = true;
			const tick = () => {
				const t = performance.now();
				dts.push(t - last);
				last = t;
				if (on) requestAnimationFrame(tick);
			};
			const colorPasses = { n: 0 };
			const comp = e.compositor;
			let prevKey = null;
			const poll = () => {
				// colour-pass re-renders: the compositor's colorKey is replaced when it re-renders
				if (comp && comp.colorKey !== prevKey) {
					colorPasses.n++;
					prevKey = comp.colorKey;
				}
				if (on) requestAnimationFrame(poll);
			};
			if (comp) prevKey = comp.colorKey;
			requestAnimationFrame(tick);
			requestAnimationFrame(poll);
			const t0 = performance.now();
			await window.__reveal.play({
				onLoad: true,
				duration: secs,
				glow: 1,
				soft: 1,
				grain: 1,
				color: null,
				reverse: false,
				dim: 0.2,
				labels: true,
				...cfg,
			});
			on = false;
			const wall = performance.now() - t0;
			dts.shift();
			const s = [...dts].sort((a, b) => a - b);
			const pct = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
			return {
				frames: dts.length,
				fps: dts.length / (wall / 1000),
				meanMs: dts.reduce((a, b) => a + b, 0) / dts.length,
				p50: pct(0.5),
				p95: pct(0.95),
				max: s[s.length - 1],
				over20ms: dts.filter((d) => d > 20).length,
				colorPasses: comp ? colorPasses.n : null,
			};
		},
		{ preset: PRESET, secs: SECS, legacy },
	);
	await ctx.close();
	return r;
}

for (const id of IDS) {
	for (const [label, renderer, legacy] of [
		["deck (legacy)", "deck", true],
		["deck", "deck", false],
	]) {
		const r = await run(id, renderer, legacy);
		const f = (x) => (x == null ? "-" : x.toFixed(1));
		console.log(
			`${id} ${label.padEnd(14)} fps ${f(r.fps)}  mean ${f(r.meanMs)}ms  p50 ${f(r.p50)}  p95 ${f(r.p95)}  max ${f(r.max)}  >20ms ${r.over20ms}/${r.frames}  colourPasses ${r.colorPasses ?? "-"}`,
		);
	}
}
await browser.close();
