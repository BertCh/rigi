#!/usr/bin/env node
// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Score the app's auto-alignment against hand-labelled control points (data/control-points.json).
// Needs the dev server (default http://localhost:3100).
// Usage: node scripts/eval-app.mjs [--renderer deck|webgpu|auto] [IMG_xxxx ...]
// --renderer pins the engine (?renderer=; deck = WebGL deck, webgpu = deck on WebGPU, auto = WebGPU where
// available else WebGL deck); without it the app default runs. Either way each row records the engine that
// actually ran (__engine.kind, "deck"; "webgpu" when __engine.backend is "webgpu"; cross-checked against
// the workspace's [data-renderer]) and the summary names it. A pinned engine that did not run fails the
// run (webgpu falling back to WebGL deck included); auto only reports what ran.
// webgpu / auto launch Chromium with the WebGPU flags (scripts/deck-webgpu/gpu-args.mjs).
// --horizon-precision f64|certified-f32 and --align-precision f64|certified-f32 open the pages with
// ?horizonPrecision= / ?alignPrecision= (opt-in certified-f32 stages; scripts/gpu/precision-gate.mjs);
// each row then records the path the stages actually took. --json PATH also writes the rows, the raw
// auto pose and the flags as JSON (stdout is unchanged).
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { GPU_ARGS } from "./deck-webgpu/gpu-args.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const BASE = process.env.APP_URL ?? "http://localhost:3100";
const cps = JSON.parse(
	fs.readFileSync(path.join(ROOT, "data", "control-points.json"), "utf8"),
);
const argv = process.argv.slice(2);
let renderer = null;
let horizonPrecision = null;
let alignPrecision = null;
let jsonOut = null;
const only = [];
for (let i = 0; i < argv.length; i++) {
	const a = argv[i];
	if (a === "--renderer") renderer = argv[++i];
	else if (a.startsWith("--renderer=")) renderer = a.slice(11);
	else if (a === "--horizon-precision") horizonPrecision = argv[++i];
	else if (a === "--align-precision") alignPrecision = argv[++i];
	else if (a === "--json") jsonOut = argv[++i];
	else only.push(a);
}
for (const [name, v] of [
	["--horizon-precision", horizonPrecision],
	["--align-precision", alignPrecision],
])
	if (v != null && !["f64", "certified-f32"].includes(v)) {
		console.error(`${name} must be f64 or certified-f32 (got ${v})`);
		process.exit(2);
	}
const precisionSet = horizonPrecision != null || alignPrecision != null;
if (renderer != null && !["deck", "webgpu", "auto"].includes(renderer)) {
	console.error(
		`--renderer must be deck, webgpu or auto (got ${renderer}; the three.js renderer was removed)`,
	);
	process.exit(2);
}
const params = new URLSearchParams();
if (renderer) params.set("renderer", renderer);
if (horizonPrecision) params.set("horizonPrecision", horizonPrecision);
if (alignPrecision) params.set("alignPrecision", alignPrecision);
const query = params.size ? `?${params}` : "";
const ids = Object.keys(cps).filter((id) => !only.length || only.includes(id));

const browser = await chromium.launch({
	headless: true,
	args:
		renderer == null ||
		renderer === "webgpu" ||
		renderer === "auto" || // unset = the app default (auto)
		// certified-f32 runs on the WebGPU compute device, on the deck renderer too
		horizonPrecision === "certified-f32" ||
		alignPrecision === "certified-f32"
			? GPU_ARGS
			: ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu"],
});
const rows = [];
await Promise.all(
	ids.map(async (id) => {
		const page = await browser.newPage({
			viewport: { width: 1400, height: 900 },
		});
		await page.addInitScript(() => localStorage.clear());
		await page.goto(`${BASE}/photo/${id}${query}`);
		await page.waitForSelector("[data-ready]", {
			state: "attached",
			timeout: 180000,
		});
		// item 05: score the FINAL pose, after the background second opinion (if any) has settled
		await page.waitForFunction(
			() =>
				document.querySelector("[data-ready]")?.getAttribute("data-verify") !==
				"pending",
			null,
			{ timeout: 180000 },
		);
		// with a precision flag: the path the certified stages took on this page's last autoAlign
		const precision = precisionSet
			? await page.evaluate(async () => {
					const a = await import("/src/lib/gpu/align/index.ts").catch(
						() => null,
					);
					const h = await import(
						"/src/lib/integration/horizon-fast-app.ts"
					).catch(() => null);
					const t = a?.lastAlignTiming;
					return {
						align: t
							? {
									requested: t.precision ?? null,
									refine: t.refine ?? null,
									path: t.cert?.path ?? null,
									reason: t.cert?.reason ?? null,
									detail: t.cert?.detail ?? null,
								}
							: null,
						horizon: h?.lastFastHorizonStats?.precision ?? null,
					};
				})
			: undefined;
		const r = await page.evaluate((cp) => {
			const e = window.__engine;
			const pins = e.controlPins(cp);
			const n = pins.length;
			// GT pose: solve from the pins starting at the prior (fov only if the labeller asked for it)
			const gt = e.solvePins(pins, e.prior, cp.solveFocal !== false);
			const auto = e.pose;
			const d = (a, b) => ((((a - b) % 360) + 540) % 360) - 180;
			return {
				engine: e.backend === "webgpu" ? "webgpu" : (e.kind ?? "unknown"),
				dataRenderer:
					document
						.querySelector("[data-renderer]")
						?.getAttribute("data-renderer") ?? null,
				pins: n,
				gtResid: e.pinError(gt, pins, cp.basis).mean,
				priorErr: e.pinError(e.prior, pins, cp.basis).mean,
				autoErr: e.pinError(auto, pins, cp.basis).mean,
				dYawPrior: d(e.prior.yaw, gt.yaw),
				dYawAuto: d(auto.yaw, gt.yaw),
				dPitchAuto: auto.pitch - gt.pitch,
				dRollAuto: auto.roll - gt.roll,
				gtYawFromPrior: d(gt.yaw, e.prior.yaw),
				autoPose: {
					yaw: auto.yaw,
					pitch: auto.pitch,
					roll: auto.roll,
					vfov: auto.vfov,
				},
			};
		}, cps[id]);
		rows.push({ id, ...r, ...(precision ? { precision } : {}) });
		await page.close();
	}),
);
await browser.close();
const engines = [...new Set(rows.map((r) => r.engine))];
const mismatch = rows.filter(
	(r) => r.dataRenderer && r.dataRenderer !== r.engine,
);
if (mismatch.length) {
	console.error(
		`[data-renderer] disagrees with __engine on ${mismatch.map((r) => `${r.id} (${r.dataRenderer} vs ${r.engine})`).join(", ")}`,
	);
	process.exit(1);
}
if (renderer && renderer !== "auto" && engines.some((k) => k !== renderer)) {
	console.error(
		`--renderer ${renderer} asked for, but engines ran: ${engines.join(",")}`,
	);
	process.exit(1);
}
rows.sort((a, b) => a.id.localeCompare(b.id));
const f = (x, n = 2) => (Number.isFinite(x) ? x.toFixed(n) : "∞");
console.log(
	`engine: ${engines.join(",") || "-"}${renderer === "auto" ? " (auto)" : renderer ? " (pinned)" : " (app default)"}`,
);
console.log(
	"photo     pins  gt-resid  prior-px  auto-px  Δyaw(prior) Δyaw(auto) Δpitch Δroll  gt-yaw-vs-prior  engine",
);
for (const r of rows)
	console.log(
		`${r.id}  ${String(r.pins).padStart(3)}  ${f(r.gtResid, 1).padStart(8)}  ${f(r.priorErr, 1).padStart(8)}  ${f(r.autoErr, 1).padStart(7)}  ${f(r.dYawPrior).padStart(10)}  ${f(r.dYawAuto).padStart(9)}  ${f(r.dPitchAuto).padStart(6)} ${f(r.dRollAuto).padStart(6)}  ${f(r.gtYawFromPrior).padStart(8)}  ${r.engine}`,
	);
// photos whose control points didn't resolve can't be scored
const scored = rows.filter((r) => r.pins > 0);
const ok = scored.filter((r) => Math.abs(r.dYawAuto) < 1);
if (jsonOut) {
	fs.mkdirSync(path.dirname(path.resolve(jsonOut)), { recursive: true });
	fs.writeFileSync(
		jsonOut,
		JSON.stringify(
			{
				flags: { renderer, horizonPrecision, alignPrecision },
				engines,
				within1deg: ok.length,
				scored: scored.length,
				rows,
			},
			null,
			1,
		),
	);
}
console.log(
	`\n${ok.length}/${scored.length} within 1° yaw; median auto px error ${f(rows.map((r) => r.autoErr).sort((a, b) => a - b)[rows.length >> 1] ?? Number.NaN, 1)}`,
);
