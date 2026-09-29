#!/usr/bin/env node
// Headless check of /lab/deck-splats (DeckSplatLayer): screenshots, log-depth occlusion, fps.
// Run under the render lock against the private vite (:3110):
//   node scripts/gpu/with-render-lock.mjs -- node scripts/nearfield/deck-splats-check.mjs [--fps] [--n 300000]
// Occlusion test: a red ball of splats sits behind a hill. With the depth test on, its screen box
// must be (almost) free of red; with depth test off (?nodepth=1) the same box must be red. The rock
// is a splat sphere centred on the ground: its lower half must be hidden by the terrain.
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const URL0 = process.env.APP_URL ?? "http://localhost:3110";
const SHOTS = resolve(import.meta.dirname, "../../tools/nearfield/shots");
mkdirSync(SHOTS, { recursive: true });
const argv = process.argv.slice(2);
const wantFps = argv.includes("--fps");
const ni = argv.indexOf("--n");
const stressN = ni >= 0 ? Number(argv[ni + 1]) : 0;

const browser = await chromium.launch({
	args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu"],
});
const out = {};
try {
	const page = await browser.newPage({
		viewport: { width: 1280, height: 800 },
	});
	const errors = [];
	page.on("pageerror", (e) => errors.push(e.message));
	page.on("console", (m) => {
		if (m.type() === "error" || m.type() === "warning")
			errors.push(`${m.type()}: ${m.text()}`);
	});

	const open = async (q) => {
		await page.goto(`${URL0}/lab/deck-splats${q}`);
		await page.waitForFunction(() => !!window.__splatLab, null, {
			timeout: 60000,
		});
		// the first sort lands async (worker) then redraws
		await page.waitForFunction(
			() => window.__splatLab.stats().sorts > 0,
			null,
			{ timeout: 30000 },
		);
		await page.waitForTimeout(600);
	};
	/** Fraction of "red ball" pixels (r > 170, g,b < 70) in a box around (x, y). */
	const redIn = async (png, x, y, r) =>
		page.evaluate(
			async ({ b64, x, y, r }) => {
				const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
				const bmp = await createImageBitmap(blob);
				const c = new OffscreenCanvas(bmp.width, bmp.height);
				const g = c.getContext("2d");
				g.drawImage(bmp, 0, 0);
				const x0 = Math.max(0, Math.round(x - r));
				const y0 = Math.max(0, Math.round(y - r));
				const w = Math.min(bmp.width - x0, Math.round(2 * r));
				const h = Math.min(bmp.height - y0, Math.round(2 * r));
				if (w <= 0 || h <= 0) return { frac: null };
				const d = g.getImageData(x0, y0, w, h).data;
				let red = 0;
				for (let i = 0; i < d.length; i += 4)
					if (d[i] > 170 && d[i + 1] < 70 && d[i + 2] < 70) red++;
				return { frac: red / (w * h), box: [x0, y0, w, h] };
			},
			{ b64: png.toString("base64"), x, y, r },
		);
	/** Mean colour in a box (to see whether splat or terrain is on top). */
	const meanIn = async (png, x, y, r) =>
		page.evaluate(
			async ({ b64, x, y, r }) => {
				const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
				const bmp = await createImageBitmap(blob);
				const c = new OffscreenCanvas(bmp.width, bmp.height);
				const g = c.getContext("2d");
				g.drawImage(bmp, 0, 0);
				const d = g.getImageData(
					Math.round(x - r),
					Math.round(y - r),
					Math.round(2 * r),
					Math.round(2 * r),
				).data;
				const m = [0, 0, 0];
				for (let i = 0; i < d.length; i += 4)
					for (let k = 0; k < 3; k++) m[k] += d[i + k];
				return m.map((v) => Math.round(v / (d.length / 4)));
			},
			{ b64: png.toString("base64"), x, y, r },
		);

	// 1. first person, depth test on
	await open("?mode=fp");
	const probe = await page.evaluate(() => window.__splatLab.probe());
	out.probe = probe;
	const shotFp = await page.screenshot({ path: `${SHOTS}/deck-fp.png` });
	out.stats = await page.evaluate(() => window.__splatLab.stats());
	const [hx, hy] = probe.hidden;
	out.hiddenDepthOn = await redIn(shotFp, hx, hy, 12);
	out.rockTopDepthOn = await meanIn(
		shotFp,
		probe.rockTop[0],
		probe.rockTop[1],
		4,
	);
	out.rockBottomDepthOn = await meanIn(
		shotFp,
		probe.rockBottom[0],
		probe.rockBottom[1],
		4,
	);

	// 2. depth test off: the hidden ball and the rock's buried half show through
	await open("?mode=fp&nodepth=1");
	const shotNd = await page.screenshot({
		path: `${SHOTS}/deck-fp-nodepth.png`,
	});
	out.hiddenDepthOff = await redIn(shotNd, hx, hy, 12);
	out.rockBottomDepthOff = await meanIn(
		shotNd,
		probe.rockBottom[0],
		probe.rockBottom[1],
		4,
	);

	// 3. truth tint, 4. orbit, 5. step to the side (parallax against the hill)
	await open("?mode=fp&truth=1");
	await page.screenshot({ path: `${SHOTS}/deck-fp-truth.png` });
	await open("?mode=orbit&yaw=35");
	await page.screenshot({ path: `${SHOTS}/deck-orbit.png` });
	await open("?mode=fp&x=-30&y=15&yaw=35&pitch=0");
	await page.screenshot({ path: `${SHOTS}/deck-fp-side.png` });

	if (wantFps) {
		await open("?mode=fp");
		out.fpsBase = await page.evaluate(() => window.__splatLab.measureFps(3000));
		out.fpsBaseStats = await page.evaluate(() => window.__splatLab.stats());
		if (stressN > 0) {
			await open(`?mode=fp&n=${stressN}`);
			await page.screenshot({ path: `${SHOTS}/deck-stress-${stressN}.png` });
			out.fpsStress = await page.evaluate(() =>
				window.__splatLab.measureFps(4000),
			);
			out.fpsStressStats = await page.evaluate(() => window.__splatLab.stats());
		}
	}
	out.gpu = await page.evaluate(() => {
		const c = document.createElement("canvas").getContext("webgl2");
		const e = c?.getExtension("WEBGL_debug_renderer_info");
		return e ? c.getParameter(e.UNMASKED_RENDERER_WEBGL) : "unknown";
	});
	out.errors = errors.slice(0, 10);
	// verdicts (terrain green: g clearly above r and b; rock grey: r ≈ g ≈ b, bright)
	const isGreen = (m) => m[1] > m[0] + 10 && m[1] > m[2] + 20;
	const isGrey = (m) =>
		Math.max(...m) - Math.min(...m) < 25 && Math.min(...m) > 110;
	out.pass = {
		hiddenBallOccluded:
			out.hiddenDepthOn.frac !== null && out.hiddenDepthOn.frac < 0.02,
		hiddenBallShowsWithoutDepth:
			out.hiddenDepthOff.frac !== null && out.hiddenDepthOff.frac > 0.8,
		rockTopVisible: isGrey(out.rockTopDepthOn),
		rockBottomClipped: isGreen(out.rockBottomDepthOn),
		rockBottomShowsWithoutDepth: isGrey(out.rockBottomDepthOff),
		noErrors: out.errors.length === 0,
	};
	out.ok = Object.values(out.pass).every(Boolean);
} finally {
	await browser.close();
}
console.log(JSON.stringify(out, null, 1));
if (!out.ok) process.exitCode = 1;
