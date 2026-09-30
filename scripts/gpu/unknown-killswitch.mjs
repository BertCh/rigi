#!/usr/bin/env node
// Checks the unknown-pose GPU horizon flag in the page: ?unknownGpu=on → "gpu"; with ?gpu=off → "cpu";
// no flag → "cpu". One photo, full metadata (fast).
//   node scripts/gpu/with-render-lock.mjs -- node scripts/gpu/unknown-killswitch.mjs
import { chromium } from "playwright";

const BASE = process.env.APP_URL ?? "http://localhost:3110";
const browser = await chromium.launch({
	headless: true,
	args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu"],
});
let bad = 0;
try {
	const page = await browser.newPage();
	for (const [qs, want] of [
		["?unknownGpu=on", "gpu"],
		["?unknownGpu=on&gpu=off", "cpu"],
		["", "cpu"],
	]) {
		await page.goto(`${BASE}/favicon.svg${qs}`);
		const on = await page.evaluate(async () => {
			const ce = document.createElement.bind(document);
			document.createElement = (t, o) =>
				t === "canvas"
					? document.createElementNS("http://www.w3.org/1999/xhtml", "canvas")
					: ce(t, o);
			const m = await import("/src/lib/integration/unknown-pose.ts");
			const img = new Image();
			img.src = "/photos/IMG_7155.jpg";
			await img.decode();
			const s = new m.UnknownPoseSolver({
				id: "IMG_7155",
				lat: 46.0073,
				lon: 7.7459,
				alt: null,
				hAccuracy: null,
				width: img.naturalWidth,
				height: img.naturalHeight,
			});
			try {
				const r = await s.solve(
					img,
					{ yaw: 236, pitch: 0, roll: 0, vfov: 50 },
					{ yaw: false, gravity: false, focal: false, any: false },
				);
				return r.horizonOn;
			} finally {
				s.dispose();
			}
		});
		const ok = on === want;
		if (!ok) bad++;
		console.log(
			`${qs || "(no flag)"}: horizonOn ${on} (want ${want}) ${ok ? "OK" : "FAIL"}`,
		);
	}
} finally {
	await browser.close();
}
process.exit(bad ? 1 : 0);
