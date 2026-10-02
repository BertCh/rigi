#!/usr/bin/env node
// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Headless screenshot tool for visually verifying WebGL / WebGPU pages.
//
// Usage:
//   node scripts/shot.mjs <url> <out.png> [options]
//
// Options:
//   --wait-for "<css>"   wait until selector is in the DOM (default: network idle + 2s)
//   --timeout <ms>       overall budget for load + wait (default 90000)
//   --width <px> --height <px>   viewport (default 1400x900)
//   --click "<css>"      click this element after ready (before --eval)
//   --eval "<js>"        run JS in the page after ready/click; awaited, result printed
//   --settle <ms>        extra delay after click/eval before the screenshot (default 500)
//   --gl metal|swiftshader   WebGL backend (default metal = real GPU on macOS;
//                        swiftshader = CPU, slower but deterministic)
//   --channel <name>     browser channel, e.g. "chrome" for system Google Chrome
//   --full-page          capture the full scrollable page
//
// Exit codes: 0 ok, 1 usage/launch error, 2 timeout or --click/--eval failure
// (a screenshot of whatever is on screen is still saved in the exit-2 case).

import { chromium } from "playwright";

const argv = process.argv.slice(2);
const positional = [];
const opt = {};
for (let i = 0; i < argv.length; i++) {
	const a = argv[i];
	if (a.startsWith("--")) {
		const key = a.slice(2);
		if (key === "full-page") opt[key] = true;
		else opt[key] = argv[++i];
	} else positional.push(a);
}
const [url, out] = positional;
if (!url || !out) {
	console.error(
		'usage: node scripts/shot.mjs <url> <out.png> [--wait-for "<css>"] [--timeout 90000] [--width 1400 --height 900] [--click "<css>"] [--eval "<js>"] [--settle 500] [--gl metal|swiftshader] [--channel chrome] [--full-page]',
	);
	process.exit(1);
}

const timeout = Number(opt.timeout ?? 90000);
const width = Number(opt.width ?? 1400);
const height = Number(opt.height ?? 900);
const settle = Number(opt.settle ?? 500);
const gl = opt.gl ?? (process.platform === "darwin" ? "metal" : "swiftshader");
const glArgs =
	gl === "swiftshader"
		? [
				"--use-angle=swiftshader",
				"--enable-unsafe-swiftshader",
				"--ignore-gpu-blocklist",
			]
		: ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu"];

const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (...m) => console.log(`[shot ${elapsed()}]`, ...m);
const remaining = () => Math.max(1000, timeout - (Date.now() - t0));

async function launch() {
	const base = { headless: true, args: glArgs };
	if (opt.channel) return chromium.launch({ ...base, channel: opt.channel });
	try {
		return await chromium.launch(base);
	} catch (e) {
		log(
			`bundled chromium failed (${e.message.split("\n")[0]}); trying system Chrome`,
		);
		return chromium.launch({ ...base, channel: "chrome" });
	}
}

let browser;
try {
	browser = await launch();
} catch (e) {
	console.error(`[shot] launch failed: ${e.message}`);
	process.exit(1);
}

const page = await browser.newPage({ viewport: { width, height } });
page.on("console", (m) => console.log(`[console.${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => console.log(`[pageerror] ${e.stack || e.message}`));
page.on("requestfailed", (r) =>
	console.log(`[requestfailed] ${r.url()} ${r.failure()?.errorText ?? ""}`),
);
page.on("crash", () => console.log("[crash] page crashed"));

let exitCode = 0;
try {
	log(`goto ${url} (gl=${gl}, ${width}x${height}, timeout=${timeout}ms)`);
	await page.goto(url, { waitUntil: "load", timeout: remaining() });
	const info = await page
		.evaluate(() => {
			const c = document.createElement("canvas").getContext("webgl2");
			if (!c) return "WebGL2 unavailable";
			const d = c.getExtension("WEBGL_debug_renderer_info");
			const r = d
				? c.getParameter(d.UNMASKED_RENDERER_WEBGL)
				: c.getParameter(c.RENDERER);
			const f = !!c.getExtension("EXT_color_buffer_float");
			c.getExtension("WEBGL_lose_context")?.loseContext();
			return `WebGL2 ok, renderer=${r}, EXT_color_buffer_float=${f}`;
		})
		.catch((e) => `probe failed: ${e.message}`);
	log(info);

	if (opt["wait-for"]) {
		log(`waiting for ${opt["wait-for"]}`);
		await page.waitForSelector(opt["wait-for"], {
			state: "attached",
			timeout: remaining(),
		});
	} else {
		await page.waitForLoadState("networkidle", { timeout: remaining() });
		await page.waitForTimeout(Math.min(2000, remaining()));
	}
	log("ready");

	if (opt.click) {
		log(`click ${opt.click}`);
		await page.click(opt.click, { timeout: remaining() });
	}
	if (opt.eval) {
		log("eval");
		// Wrapped as an async function body-or-expression so `await` works.
		const result = await page.evaluate(async (src) => {
			// biome-ignore lint/security/noGlobalEval: intentional dev tool
			const indirectEval = eval;
			try {
				return await indirectEval(`(async () => (${src}))()`);
			} catch (e) {
				if (!(e instanceof SyntaxError)) throw e;
				return await indirectEval(`(async () => { ${src} })()`);
			}
		}, opt.eval);
		if (result !== undefined) log("eval result:", JSON.stringify(result));
	}
	if ((opt.click || opt.eval) && settle > 0) await page.waitForTimeout(settle);
} catch (e) {
	exitCode = 2;
	log(`ERROR: ${e.message.split("\n")[0]}`);
}

try {
	await page.screenshot({
		path: out,
		fullPage: !!opt["full-page"],
		timeout: 30000,
	});
	log(`saved ${out}${exitCode ? " (partial, after error)" : ""}`);
} catch (e) {
	log(`screenshot failed: ${e.message.split("\n")[0]}`);
	exitCode = exitCode || 1;
}
await browser.close();
process.exit(exitCode);
