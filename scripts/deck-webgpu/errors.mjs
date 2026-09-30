#!/usr/bin/env node
// Print the full WebGPU / page errors of one lab URL (the smoke truncates them).
//   node scripts/gpu/with-render-lock.mjs -- node scripts/deck-webgpu/errors.mjs "<url>" [maxErrors]
import { chromium } from "playwright";
import { GPU_ARGS } from "./gpu-args.mjs";

const [url, max = "3"] = process.argv.slice(2);
const browser = await chromium.launch({ args: GPU_ARGS });
try {
	const page = await browser.newPage({
		viewport: { width: 1280, height: 800 },
	});
	const errors = [];
	page.on("pageerror", (e) =>
		errors.push(`pageerror: ${e.stack ?? e.message}`),
	);
	page.on("console", (m) => {
		if (
			m.type() === "error" ||
			(m.type() === "warning" && !/Module \w+ not found/.test(m.text()))
		)
			errors.push(`${m.type()}: ${m.text()}`);
	});
	await page.goto(url);
	await page
		.waitForFunction(() => window.__deckWebgpuLab?.ready, null, {
			timeout: 90_000,
		})
		.catch(() => errors.push("(not ready after 90 s)"));
	await page.waitForTimeout(3000);
	console.log(errors.slice(0, Number(max)).join("\n\n---\n\n") || "no errors");
} finally {
	await browser.close();
}
