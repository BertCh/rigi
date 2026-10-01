#!/usr/bin/env node
// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// scripts/eval-app.mjs on the deck backend: the same control-point scoring of the app's load-time
// auto-alignment, on /photo/<id>?renderer=deck&terrain=<mode> for each terrain mode (tiles, batched),
// so the two terrain paths can be compared photo by photo. Photos run a few at a time (not all 19 at
// once as eval-app does) to keep GPU / memory contention down; the ready time is recorded too.
// Usage (under the render lock):
//   node scripts/gpu/with-render-lock.mjs -- node scripts/gpu/w4b-eval-app-deck.mjs \
//     [--url http://localhost:3110] [--modes tiles,batched] [--par 3] [--out out/gpu/w4b/eval-app-deck.json] [IMG_xxxx ...]
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = path.resolve(import.meta.dirname, "../..");
const args = process.argv.slice(2);
const opt = {};
const only = [];
for (let i = 0; i < args.length; i++)
	if (args[i].startsWith("--")) opt[args[i].slice(2)] = args[++i];
	else only.push(args[i]);
const BASE = opt.url ?? "http://localhost:3110";
const MODES = (opt.modes ?? "tiles,batched").split(",");
const PAR = Number(opt.par ?? 3);
const OUT = path.resolve(ROOT, opt.out ?? "out/gpu/w4b/eval-app-deck.json");
const cps = JSON.parse(
	fs.readFileSync(path.join(ROOT, "data", "control-points.json"), "utf8"),
);
const ids = Object.keys(cps).filter((id) => !only.length || only.includes(id));

const browser = await chromium.launch({
	headless: true,
	args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu"],
});

async function score(id, mode) {
	const page = await browser.newPage({
		viewport: { width: 1400, height: 900 },
	});
	try {
		await page.addInitScript(() => localStorage.clear());
		const t0 = Date.now();
		await page.goto(
			`${BASE}/photo/${id}?renderer=deck${mode === "default" ? "" : `&terrain=${mode}`}`,
		);
		await page.waitForSelector("[data-ready]", {
			state: "attached",
			timeout: 240000,
		});
		const readyMs = Date.now() - t0;
		await page.waitForFunction(
			() =>
				document.querySelector("[data-ready]")?.getAttribute("data-verify") !==
				"pending",
			null,
			{ timeout: 240000 },
		);
		const r = await page.evaluate((cp) => {
			const e = window.__engine;
			const pins = e.controlPins(cp);
			const gt = e.solvePins(pins, e.prior, cp.solveFocal !== false);
			const auto = e.pose;
			const d = (a, b) => ((((a - b) % 360) + 540) % 360) - 180;
			return {
				pins: pins.length,
				gtResid: e.pinError(gt, pins, cp.basis).mean,
				priorErr: e.pinError(e.prior, pins, cp.basis).mean,
				autoErr: e.pinError(auto, pins, cp.basis).mean,
				dYawAuto: d(auto.yaw, gt.yaw),
				dPitchAuto: auto.pitch - gt.pitch,
				dRollAuto: auto.roll - gt.roll,
				pose: auto,
				draws: globalThis.__rigiTerrainStats?.draws ?? null,
			};
		}, cps[id]);
		return { id, mode, readyMs, ...r };
	} catch (e) {
		return { id, mode, error: String(e).slice(0, 300) };
	} finally {
		await page.close();
	}
}

const rows = [];
for (const mode of MODES) {
	const queue = [...ids];
	await Promise.all(
		Array.from({ length: PAR }, async () => {
			for (let id = queue.shift(); id; id = queue.shift())
				rows.push(await score(id, mode));
		}),
	);
}
await browser.close();

const f = (x, n = 2) => (Number.isFinite(x) ? x.toFixed(n) : "∞");
const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1] ?? Number.NaN;
const summary = {};
for (const mode of MODES) {
	const rs = rows
		.filter((r) => r.mode === mode && !r.error)
		.sort((a, b) => a.id.localeCompare(b.id));
	const scored = rs.filter((r) => r.pins > 0);
	summary[mode] = {
		within1: scored.filter((r) => Math.abs(r.dYawAuto) < 1).length,
		scored: scored.length,
		errors: rows.filter((r) => r.mode === mode && r.error).length,
		medianAutoPx: med(rs.map((r) => r.autoErr)),
		medianReadyMs: med(rs.map((r) => r.readyMs)),
	};
	console.log(`\n[${mode}] photo  pins  auto-px  Δyaw  Δpitch  Δroll  ready`);
	for (const r of rs)
		console.log(
			`${r.id}  ${String(r.pins).padStart(3)}  ${f(r.autoErr, 1).padStart(7)}  ${f(r.dYawAuto).padStart(6)}  ${f(r.dPitchAuto).padStart(6)} ${f(r.dRollAuto).padStart(6)}  ${r.readyMs} ms`,
		);
	const s = summary[mode];
	console.log(
		`[${mode}] ${s.within1}/${s.scored} within 1° yaw; median auto px ${f(s.medianAutoPx, 1)}; median ready ${s.medianReadyMs} ms; ${s.errors} errors`,
	);
}
if (MODES.length === 2) {
	const [a, b] = MODES;
	for (const id of ids) {
		const ra = rows.find((r) => r.id === id && r.mode === a);
		const rb = rows.find((r) => r.id === id && r.mode === b);
		if (!ra?.pose || !rb?.pose) continue;
		const dy = ((((rb.pose.yaw - ra.pose.yaw) % 360) + 540) % 360) - 180;
		if (Math.abs(dy) > 0.02 || Math.abs(rb.autoErr - ra.autoErr) > 1)
			console.log(
				`${id}: ${a}→${b} pose Δyaw ${dy.toFixed(3)}° auto px ${f(ra.autoErr, 1)} → ${f(rb.autoErr, 1)}`,
			);
	}
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(
	OUT,
	JSON.stringify(
		{ at: new Date().toISOString(), base: BASE, summary, rows },
		null,
		1,
	),
);
console.log(`wrote ${OUT}`);
