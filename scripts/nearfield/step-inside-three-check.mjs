#!/usr/bin/env node
// Step Inside in the three.js workspace, end to end (headless, real GPU): for each photo, inject the GT
// pose as the saved pose (so it counts as accepted), wait for the near-field panel, build the scene,
// step inside, orbit, Truth, back to photo, hover an Object pixel, and the In map drape with splats.
// Screenshots → tools/nearfield/shots/three-<id>-*.png, numbers → tools/nearfield/shots/three-report.json.
// Needs the private vite (:3110) and the near-field service (:8767). Run under the render lock:
//   node scripts/gpu/with-render-lock.mjs -- node scripts/nearfield/step-inside-three-check.mjs IMG_7018 IMG_7130
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const ROOT = resolve(import.meta.dirname, "../..");
const BASE = process.env.APP_URL ?? "http://localhost:3110";
const OUT = join(ROOT, "tools/nearfield/shots");
mkdirSync(OUT, { recursive: true });
const gt = JSON.parse(
	readFileSync(join(ROOT, "data/ground-truth.json"), "utf8"),
);
const ids = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!ids.length) ids.push("IMG_7018", "IMG_7130", "IMG_7086");
const sharp = process.argv.includes("--sharp");

const fixedPose = (id) => {
	const g = gt[id];
	return {
		yaw: g.yaw,
		pitch: g.pitch,
		roll: g.roll,
		vfov: (2 * Math.atan(g.height / (2 * g.f)) * 180) / Math.PI,
	};
};

const browser = await chromium.launch({
	headless: true,
	args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"],
});
const report = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const id of ids) {
	const r = { id };
	report[id] = r;
	const log = (...m) => console.log(`[${id}]`, ...m);
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
		[`mt-image:pose:${id}`, JSON.stringify(fixedPose(id))],
	);
	await ctx.routeWebSocket(
		(u) => u.origin === new URL(BASE).origin.replace(/^http/, "ws"),
		() => {},
	);
	const page = await ctx.newPage();
	const errors = [];
	page.on("pageerror", (e) => errors.push(e.message));
	page.on("console", (m) => {
		if (m.type() === "error" || /nearfield/i.test(m.text()))
			errors.push(`[console.${m.type()}] ${m.text()}`.slice(0, 300));
	});
	const shot = async (name) => {
		const f = join(OUT, `three-${id}-${name}.png`);
		await page.locator("canvas").first().screenshot({ path: f });
		return f;
	};
	const frame = () =>
		page.evaluate(
			() =>
				new Promise((res) =>
					requestAnimationFrame(() => requestAnimationFrame(res)),
				),
		);
	try {
		// webdriver sessions only get the Step Inside UI with ?nearfield (useStepInside.stepInsideAllowed)
		await page.goto(`${BASE}/photo/${id}?nearfield=${sharp ? "sharp" : "on"}`);
		await page.waitForSelector("[data-ready]", {
			state: "attached",
			timeout: 180000,
		});
		r.align = await page.getAttribute("[data-ready]", "data-align");
		r.hasPeople = await page.evaluate(() => window.__engine.hasPeople);
		await page.waitForSelector("[data-nearfield-status]", { timeout: 30000 });
		r.statusBefore = await page.getAttribute(
			"[data-nearfield-status]",
			"data-nearfield-status",
		);
		await sleep(600);
		await shot("0-photo");
		const t0 = Date.now();
		const built = await page.evaluate(async () => {
			const nf = window.__nearfield;
			const s = await nf.build();
			const st = nf.state;
			return s
				? {
						ok: true,
						state: st,
						counts: s.split.counts,
						split: [s.split.width, s.split.height],
						anchor: s.anchor,
						radius: s.confidenceRadius,
					}
				: { ok: false, state: st };
		});
		r.buildMs = Date.now() - t0;
		Object.assign(r, built);
		log("build", r.buildMs, "ms", JSON.stringify(built.state));
		if (!built.ok) {
			await shot("1-not-built");
			continue;
		}
		// hover an Object pixel in the photo view: the readout must say 'object'
		const probe = await page.evaluate(() => {
			const nf = window.__nearfield;
			const s = nf.controller.scene;
			const { width: W, height: H, cls } = s.split;
			// the Object cell nearest the centre of mass of the Object pixels that measures
			let sx = 0;
			let sy = 0;
			let n = 0;
			for (let j = 0; j < H; j++)
				for (let i = 0; i < W; i++)
					if (cls[j * W + i] === 2) {
						sx += i;
						sy += j;
						n++;
					}
			if (!n) return null;
			const cx = sx / n;
			const cy = sy / n;
			let best = null;
			let bd = Infinity;
			for (let j = 0; j < H; j += 2)
				for (let i = 0; i < W; i += 2) {
					if (cls[j * W + i] !== 2) continue;
					const u = (i + 0.5) / W;
					const v = (j + 0.5) / H;
					const m = nf.sampleAt(u, v);
					if (!m) continue;
					const d = (i - cx) ** 2 + (j - cy) ** 2;
					if (d < bd) {
						bd = d;
						best = { u, v, m, terrain: window.__engine.sampleAt(u, v) };
					}
				}
			return best;
		});
		r.probe = probe;
		if (probe) {
			const box = await page.locator("canvas").first().boundingBox();
			await page.mouse.move(
				box.x + probe.u * box.width,
				box.y + probe.v * box.height,
			);
			await sleep(150);
			r.hoverObject =
				(await page.locator("[data-hover-source=object]").count()) > 0;
			await page
				.locator("canvas")
				.first()
				.screenshot({ path: join(OUT, `three-${id}-1-hover.png`) });
			await page.mouse.move(box.x + 5, box.y + 5);
			log(
				"probe",
				JSON.stringify(probe.m),
				"terrain",
				probe.terrain?.range,
				"hover object:",
				r.hoverObject,
			);
		}
		// step inside
		await page.click("[data-nearfield-enter]");
		await page.waitForSelector('[data-nearfield-status="stepping"]', {
			timeout: 60000,
		});
		await sleep(1200);
		await frame();
		await shot("2-step-start");
		r.info = await page.evaluate(() => window.__nearfield.info);
		// orbit + pan, then settle
		await page.evaluate(() => {
			const s = window.__nearfield.step;
			s.orbit(10, 3);
			s.pan(0, 0, 1.5);
			s.snap();
		});
		await sleep(900);
		await frame();
		r.offsetM = await page.evaluate(() => window.__nearfield.step.offsetM);
		await shot("3-step-orbit");
		// frame time while orbiting (the sort runs in a worker)
		r.frameMs = await page.evaluate(async () => {
			const s = window.__nearfield.step;
			const ts = [];
			let last = performance.now();
			for (let k = 0; k < 90; k++) {
				s.orbit(k < 45 ? -0.4 : 0.4, 0);
				await new Promise((res) => requestAnimationFrame(res));
				const t = performance.now();
				ts.push(t - last);
				last = t;
			}
			ts.sort((a, b) => a - b);
			return { median: ts[45], p90: ts[81] };
		});
		await page.click("[data-nearfield-truth]");
		await sleep(700);
		await shot("4-step-truth");
		await page.click("[data-nearfield-truth]");
		// back to photo (eased), then leave
		await page.click("[data-nearfield-back]");
		await page.waitForFunction(
			() => window.__nearfield.step?.atPhoto !== false,
			null,
			{ timeout: 10000 },
		);
		await sleep(500);
		await shot("5-step-back");
		const back = page.locator("[data-nearfield-back]");
		if (await back.count()) await back.click();
		await page.waitForSelector(
			'[data-nearfield-status]:not([data-nearfield-status="stepping"])',
		);
		await sleep(600);
		await shot("6-photo-after");
		// In map: splats + masked drape, seen from the photo camera and from above
		await page.getByRole("button", { name: "In map" }).click();
		await sleep(2500);
		await page.evaluate(() => window.__engine.flyToPhoto(1));
		await sleep(1500);
		await shot("7-world-at-photo");
		r.worldInfo = await page.evaluate(() => window.__nearfield.info);
		await page.evaluate(() => window.__engine.flyOut());
		await sleep(2000);
		await shot("8-world-overview");
		// step inside from the In map view, then back: the camera must end on the photo (flight held)
		await page.click("[data-nearfield-enter]");
		await page.waitForSelector('[data-nearfield-status="stepping"]', {
			timeout: 30000,
		});
		await sleep(1200);
		await shot("9-world-step");
		await page.click("[data-nearfield-back]");
		await page.waitForSelector(
			'[data-nearfield-status]:not([data-nearfield-status="stepping"])',
			{
				timeout: 15000,
			},
		);
		await sleep(800);
		r.worldAfterStep = await page.evaluate(() => ({
			flying: window.__engine.isFlying,
			mode: window.__engine.settings.mode,
		}));
		await shot("10-world-after-step");
	} catch (e) {
		r.error = String(e?.message ?? e).slice(0, 400);
		log("ERROR", r.error);
		await shot("x-error").catch(() => {});
	} finally {
		r.errors = errors.slice(0, 20);
		await ctx.close();
	}
	log(JSON.stringify({ ...r, probe: undefined, errors: r.errors.length }));
}
await browser.close();
writeFileSync(join(OUT, "three-report.json"), JSON.stringify(report, null, 1));
console.log("wrote", join(OUT, "three-report.json"));
