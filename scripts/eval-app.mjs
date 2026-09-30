#!/usr/bin/env node
// Score the app's auto-alignment against hand-labelled control points (data/control-points.json).
// Needs the dev server (default http://localhost:3100).
// Usage: node scripts/eval-app.mjs [--renderer three|deck] [IMG_xxxx ...]
// --renderer pins the engine (?renderer=); without it the app default runs. Either way each row records
// the engine that actually ran (__engine.kind ?? "three") and the summary names it.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = path.resolve(import.meta.dirname, "..");
const BASE = process.env.APP_URL ?? "http://localhost:3100";
const cps = JSON.parse(
	fs.readFileSync(path.join(ROOT, "data", "control-points.json"), "utf8"),
);
const argv = process.argv.slice(2);
let renderer = null;
const only = [];
for (let i = 0; i < argv.length; i++) {
	const a = argv[i];
	if (a === "--renderer") renderer = argv[++i];
	else if (a.startsWith("--renderer=")) renderer = a.slice(11);
	else only.push(a);
}
if (renderer != null && !["three", "deck"].includes(renderer)) {
	console.error(`--renderer must be three or deck (got ${renderer})`);
	process.exit(2);
}
const query = renderer ? `?renderer=${renderer}` : "";
const ids = Object.keys(cps).filter((id) => !only.length || only.includes(id));

const browser = await chromium.launch({
	headless: true,
	args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu"],
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
		const r = await page.evaluate((cp) => {
			const e = window.__engine;
			const pins = e.controlPins(cp);
			const n = pins.length;
			// GT pose: solve from the pins starting at the prior (fov only if the labeller asked for it)
			const gt = e.solvePins(pins, e.prior, cp.solveFocal !== false);
			const auto = e.pose;
			const d = (a, b) => ((((a - b) % 360) + 540) % 360) - 180;
			return {
				engine: e.kind ?? "three",
				pins: n,
				gtResid: e.pinError(gt, pins, cp.basis).mean,
				priorErr: e.pinError(e.prior, pins, cp.basis).mean,
				autoErr: e.pinError(auto, pins, cp.basis).mean,
				dYawPrior: d(e.prior.yaw, gt.yaw),
				dYawAuto: d(auto.yaw, gt.yaw),
				dPitchAuto: auto.pitch - gt.pitch,
				dRollAuto: auto.roll - gt.roll,
				gtYawFromPrior: d(gt.yaw, e.prior.yaw),
			};
		}, cps[id]);
		rows.push({ id, ...r });
		await page.close();
	}),
);
await browser.close();
const engines = [...new Set(rows.map((r) => r.engine))];
if (renderer && engines.some((k) => k !== renderer)) {
	console.error(
		`--renderer ${renderer} asked for, but engines ran: ${engines.join(",")}`,
	);
	process.exit(1);
}
rows.sort((a, b) => a.id.localeCompare(b.id));
const f = (x, n = 2) => (Number.isFinite(x) ? x.toFixed(n) : "∞");
console.log(
	`engine: ${engines.join(",") || "-"}${renderer ? " (pinned)" : " (app default)"}`,
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
console.log(
	`\n${ok.length}/${scored.length} within 1° yaw; median auto px error ${f(rows.map((r) => r.autoErr).sort((a, b) => a - b)[rows.length >> 1] ?? Number.NaN, 1)}`,
);
