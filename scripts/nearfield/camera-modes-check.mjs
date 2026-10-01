// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Camera modes check (step-camera.ts setMode; CameraModeBar) on the WebGL deck engine: Step Inside →
// Photo / Orbit / Fly / Top-down → Esc back, then In map → Fly / Top-down / Photo. Screenshots go to
// tools/nearfield/shots/cam-<renderer>-<id>-*.png; the report prints camera positions per mode.
// Usage: node scripts/gpu/with-render-lock.mjs -- node scripts/nearfield/camera-modes-check.mjs [id]
// (--deck is accepted and ignored: the three.js arm went with the three.js renderer, 2026-10-01)
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const ROOT = resolve(import.meta.dirname, "../..");
const BASE = process.env.APP_URL ?? "http://localhost:3110";
const OUT = join(ROOT, "tools/nearfield/shots");
mkdirSync(OUT, { recursive: true });
const gt = JSON.parse(
	readFileSync(join(ROOT, "data/ground-truth.json"), "utf8"),
);
const id = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "IMG_7018";
const tag = "deck";
const g = gt[id];
const pose = {
	yaw: g.yaw,
	pitch: g.pitch,
	roll: g.roll,
	vfov: (2 * Math.atan(g.height / (2 * g.f)) * 180) / Math.PI,
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({
	headless: true,
	args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"],
});
const ctx = await browser.newContext({
	viewport: { width: 1400, height: 900 },
	deviceScaleFactor: 1,
});
await ctx.addInitScript(
	([k, v]) => {
		try {
			localStorage.setItem(k, v);
		} catch {}
	},
	[`mt-image:pose:${id}`, JSON.stringify(pose)],
);
await ctx.routeWebSocket(
	(u) => u.origin === new URL(BASE).origin.replace(/^http/, "ws"),
	() => {},
);
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
	if (m.type() === "error") errors.push(`[console] ${m.text()}`.slice(0, 300));
});
const shot = (name) =>
	page
		.locator("canvas")
		.first()
		.screenshot({ path: join(OUT, `cam-${tag}-${id}-${name}.png`) });
const camPos = () =>
	page.evaluate(() => {
		const s = window.__nearfield?.step;
		const c = s?.camera;
		if (!c) return null;
		const f = [0, 0, -1];
		const q = c.quaternion;
		// forward = q · (0,0,-1)
		const x = q.x,
			y = q.y,
			z = q.z,
			w = q.w;
		const fx = -(2 * (x * z + w * y));
		const fy = -(2 * (y * z - w * x));
		const fz = -(1 - 2 * (x * x + y * y));
		void f;
		return {
			mode: s.mode,
			pos: [c.position.x, c.position.y, c.position.z].map((v) => +v.toFixed(1)),
			fwd: [fx, fy, fz].map((v) => +v.toFixed(2)),
			fov: +c.fov.toFixed(1),
		};
	});
const mode = () => page.getAttribute("[data-camera-mode]", "data-camera-mode");
const pick = async (m) => {
	await page.click(`[data-camera-mode-option="${m}"]`);
	await sleep(1300);
};
const report = { id, renderer: tag, steps: [] };
const log = async (name) => {
	await shot(name);
	const r = { name, bar: await mode(), cam: await camPos() };
	report.steps.push(r);
	console.log(name, JSON.stringify(r));
};
try {
	await page.goto(`${BASE}/photo/${id}?nearfield=on&renderer=${tag}`);
	await page.waitForSelector("[data-ready]", {
		state: "attached",
		timeout: 180000,
	});
	await page.waitForSelector("[data-nearfield-status]", { timeout: 30000 });
	const built = await page.evaluate(
		async () => !!(await window.__nearfield.build()),
	);
	console.log("built", built);
	if (built) {
		await page.evaluate(() => window.__nearfield.enter());
		await page.waitForSelector('[data-nearfield-status="stepping"]', {
			timeout: 60000,
		});
		await sleep(800);
		await log("step-photo");
		await pick("orbit");
		const box = await page.locator("canvas").first().boundingBox();
		const cx = box.x + box.width / 2;
		const cy = box.y + box.height / 2;
		await page.mouse.move(cx, cy);
		await page.mouse.down();
		await page.mouse.move(cx + 250, cy - 120, { steps: 10 });
		await page.mouse.up();
		await sleep(800);
		await log("step-orbit");
		await pick("fly");
		await page.keyboard.down("w");
		await sleep(1200);
		await page.keyboard.up("w");
		await sleep(500);
		await log("step-fly");
		await pick("map");
		await page.mouse.move(cx, cy);
		await page.mouse.wheel(0, 600);
		await sleep(900);
		await log("step-map");
		await page.keyboard.press("Escape");
		await sleep(1600);
		report.afterEsc = await page.getAttribute(
			"[data-nearfield-status]",
			"data-nearfield-status",
		);
		console.log("after Esc status", report.afterEsc);
	}
	// In map
	await page.getByText("In map", { exact: true }).click();
	await sleep(2500);
	await log("map-native");
	await pick("map");
	await log("map-topdown-first");
	await pick("orbit");
	await page.keyboard.press("Escape");
	await sleep(1600);
	await page.getByText("Back out to map").click();
	await sleep(3000);
	await pick("fly");
	await log("map-fly");
	await pick("map");
	await log("map-topdown");
	const mbox = await page.locator("canvas").first().boundingBox();
	const [cx, cy] = [mbox.x + mbox.width / 2, mbox.y + mbox.height / 2];
	// map camera input: drag pans, wheel zooms about the pointer, right-drag rotates (deck: and tilts)
	await page.mouse.move(cx, cy);
	await page.mouse.down();
	await page.mouse.move(cx - 200, cy + 120, { steps: 12 });
	await page.mouse.up();
	await sleep(1200);
	await log("map-pan");
	await page.mouse.move(cx + 250, cy - 150);
	await page.mouse.wheel(0, -500);
	await sleep(1200);
	await log("map-zoom");
	await page.mouse.move(cx, cy);
	await page.mouse.down({ button: "right" });
	await page.mouse.move(cx + 150, cy - 160, { steps: 12 });
	await page.mouse.up({ button: "right" });
	await sleep(1500);
	await log("map-tilt");
	await pick("orbit");
	await log("map-orbit");
	await pick("photo");
	await sleep(600);
	await log("map-photo");
} catch (e) {
	errors.push(`script: ${e.message}`);
}
report.errors = errors;
console.log(JSON.stringify({ errors }, null, 1));
await browser.close();
