#!/usr/bin/env node
// Run a playwright script with GPU timestamp profiling on in every page it opens
// (globalThis.__RIGI_GPU_PROFILE__ = true, read by src/lib/gpu/core/profile.ts), and collect each
// page's getGpuProfile() before it navigates or closes. Totals (summed over pages) go to PROFILE_OUT.
// Kernels in the app's GPU workers (horizon-fast-app, unknown-pose, eye suggest) are included: the
// page forwards the switch on the worker messages and merges each worker's report into its own
// profile as "<realm>:<label>" (src/lib/gpu/core/realm.ts). `realms` sums gpuMs / count per realm.
// A worker whose result never came back (terminated early) is missed.
// Usage: PROFILE_OUT=out/gpu/core/profile/horizon.json node scripts/gpu/with-gpu-profile.mjs scripts/gpu/horizon-bench.mjs …
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const [script, ...rest] = process.argv.slice(2);
const OUT = process.env.PROFILE_OUT;
if (!script || !OUT) {
	console.error(
		"usage: PROFILE_OUT=<file.json> with-gpu-profile.mjs <script.mjs> [args…]",
	);
	process.exit(2);
}

const totals = {};
let pages = 0;
const save = () => {
	mkdirSync(dirname(resolve(OUT)), { recursive: true });
	writeFileSync(
		resolve(OUT),
		JSON.stringify(
			{ script, args: rest, pages, realms: byRealm(), kernels: totals },
			null,
			1,
		),
	);
};
const byRealm = () => {
	const r = {};
	for (const [k, v] of Object.entries(totals)) {
		const realm = /^[\w-]+-worker:/.test(k)
			? k.slice(0, k.indexOf(":"))
			: "page";
		const t = r[realm] ?? { gpuMs: 0, count: 0 };
		t.gpuMs += v.gpuMs;
		t.count += v.count;
		r[realm] = t;
	}
	return r;
};
// Read this document's totals. Importing the module in a page that never loaded it just yields {}.
const flush = async (page) => {
	try {
		if (page.isClosed() || !/^https?:/.test(page.url())) return;
		const p = await page.evaluate(async () => {
			const m = await import("/src/lib/gpu/core/profile.ts");
			return m.getGpuProfile();
		});
		pages++;
		for (const [k, v] of Object.entries(p)) {
			const t = totals[k] ?? { gpuMs: 0, count: 0 };
			t.gpuMs += v.gpuMs;
			t.count += v.count;
			totals[k] = t;
		}
		save();
	} catch (e) {
		console.error(`[gpu-profile] flush failed: ${String(e).slice(0, 200)}`);
	}
};
const init = () => {
	globalThis.__RIGI_GPU_PROFILE__ = true;
};
const wrapPage = (page) => {
	const goto = page.goto.bind(page);
	page.goto = async (...a) => {
		await flush(page);
		return goto(...a);
	};
	const close = page.close.bind(page);
	page.close = async (...a) => {
		await flush(page);
		return close(...a);
	};
	return page;
};

const launch = chromium.launch.bind(chromium);
chromium.launch = async (...a) => {
	const browser = await launch(...a);
	const live = new Set();
	const track = (page) => {
		live.add(page);
		page.once("close", () => live.delete(page));
		return wrapPage(page);
	};
	const newContext = browser.newContext.bind(browser);
	browser.newContext = async (...b) => {
		const ctx = await newContext(...b);
		await ctx.addInitScript(init);
		const np = ctx.newPage.bind(ctx);
		ctx.newPage = async (...c) => track(await np(...c));
		const cclose = ctx.close.bind(ctx);
		ctx.close = async (...c) => {
			for (const p of ctx.pages()) if (live.has(p)) await flush(p);
			return cclose(...c);
		};
		return ctx;
	};
	const newPage = browser.newPage.bind(browser);
	browser.newPage = async (...b) => {
		const page = await newPage(...b);
		await page.addInitScript(init);
		return track(page);
	};
	const close = browser.close.bind(browser);
	browser.close = async (...b) => {
		for (const p of [...live]) await flush(p);
		return close(...b);
	};
	return browser;
};
process.on("exit", save);
process.argv = [process.argv[0], resolve(script), ...rest];
await import(pathToFileURL(resolve(script)).href);
