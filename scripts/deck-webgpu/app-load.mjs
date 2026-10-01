#!/usr/bin/env node
// Does /photo/<id>?renderer=<r> load (data-ready, data-verify settled) with no page errors, and which engine
// actually ran? One browser, photos one after another. Run under the render lock:
//   node scripts/gpu/with-render-lock.mjs -- node scripts/deck-webgpu/app-load.mjs --renderer auto [--query webgpu=off] [--no-gpu] [IMG_7086 …]
// No ids = every photo in data/control-points.json (the 19 ground-truth photos).
// --renderer auto|webgpu|deck (always explicit; ?renderer=three was removed and falls back to auto). --no-gpu hides navigator.gpu (an init script makes it
// undefined; Chromium's --disable-features=WebGPU does not remove it), the "browser without WebGPU" case.
// Per photo: data-renderer / data-renderer-reason (src/lib/renderer-select.ts), __engine kind/backend,
// whether the compute device is the render device (adoptRenderDevice), ready ms, page / console errors.
// Exit 1 when any photo has page errors, never got ready, or (webgpu / deck) ran another engine.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { GPU_ARGS } from "./gpu-args.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const BASE = process.env.APP_URL ?? "http://localhost:3100";
const argv = process.argv.slice(2);
const opt = (k) => {
	const i = argv.indexOf(`--${k}`);
	return i >= 0 ? argv[i + 1] : undefined;
};
const renderer = opt("renderer");
if (!["auto", "webgpu", "deck"].includes(renderer)) {
	console.error("--renderer auto|webgpu|deck is required");
	process.exit(2);
}
const extra = opt("query") ? `&${opt("query")}` : "";
const noGpu = argv.includes("--no-gpu");
const out = opt("out");
const ids = argv.filter(
	(a, i) => a.startsWith("IMG_") && !argv[i - 1]?.startsWith("--"),
);
const all = Object.keys(
	JSON.parse(
		fs.readFileSync(path.join(ROOT, "data/control-points.json"), "utf8"),
	),
);
const photos = ids.length ? ids : all;

const browser = await chromium.launch({
	headless: true,
	args: GPU_ARGS,
});
const rows = [];
try {
	for (const id of photos) {
		const page = await browser.newPage({
			viewport: { width: 1400, height: 900 },
		});
		const errors = [];
		page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
		page.on("console", (m) => {
			if (m.type() === "error")
				errors.push(`console: ${m.text().slice(0, 300)}`);
		});
		await page.addInitScript(() => localStorage.clear());
		if (noGpu)
			await page.addInitScript(() =>
				Object.defineProperty(Navigator.prototype, "gpu", {
					get: () => undefined,
					configurable: true,
				}),
			);
		const t0 = Date.now();
		await page.goto(`${BASE}/photo/${id}?renderer=${renderer}${extra}`);
		let ready = true;
		await page
			.waitForSelector("[data-ready]", { state: "attached", timeout: 180_000 })
			.catch(() => (ready = false));
		const readyMs = Date.now() - t0;
		if (ready)
			await page
				.waitForFunction(
					() =>
						document
							.querySelector("[data-ready]")
							?.getAttribute("data-verify") !== "pending",
					null,
					{ timeout: 120_000 },
				)
				.catch(() => errors.push("data-verify still pending"));
		const info = await page.evaluate(async () => {
			const e = window.__engine;
			const root = document.querySelector("[data-renderer]");
			let computeIsRender = null;
			try {
				const dev = e?.hostInstance?.device ?? null;
				if (dev) {
					const g = await import("/src/lib/gpu/device.ts");
					computeIsRender =
						g.adoptedRenderDevice() === dev &&
						(await g.getComputeDevice()) === dev;
				}
			} catch (err) {
				computeIsRender = `error: ${err.message}`;
			}
			return {
				dataRenderer: root?.getAttribute("data-renderer") ?? null,
				reason: root?.getAttribute("data-renderer-reason") ?? null,
				engine: e
					? e.backend === "webgpu"
						? "webgpu"
						: (e.kind ?? "unknown")
					: null,
				host: e?.stats?.host ?? null,
				computeIsRender,
				hasGpu: !!navigator.gpu,
				failedBanner: /failed to (load|start)/i.test(document.body.innerText),
			};
		});
		const row = { id, ready, readyMs, ...info, errors };
		row.ok =
			ready &&
			!errors.length &&
			!info.failedBanner &&
			info.dataRenderer === info.engine &&
			(renderer === "auto" || info.engine === renderer);
		rows.push(row);
		console.log(
			`${id} ${row.ok ? "ok  " : "FAIL"} ${info.engine}/${info.host ?? "-"} (${info.reason}) ready ${readyMs} ms compute=render:${info.computeIsRender} gpu:${info.hasGpu}${errors.length ? ` errors: ${errors.slice(0, 3).join(" | ")}` : ""}`,
		);
		await page.close();
	}
} finally {
	await browser.close();
}
const bad = rows.filter((r) => !r.ok);
console.log(
	`${rows.length - bad.length}/${rows.length} ok; engines: ${[...new Set(rows.map((r) => r.engine))].join(",")}`,
);
if (out) fs.writeFileSync(out, JSON.stringify(rows, null, 1));
process.exit(bad.length ? 1 : 0);
