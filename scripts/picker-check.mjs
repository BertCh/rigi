// Browser check of the ?picker=on top-3 picker + tap-a-peak (src/lib/picker/README.md).
// Usage (dev server on :3100, under the render lock):
//   node scripts/gpu/with-render-lock.mjs -- node scripts/picker-check.mjs IMG_6958 out/picker/6958 [deck|webgpu|auto]
// Loads the photo, waits for the candidates, previews a wrong candidate, taps a visible labelled peak at
// its shown position, picks its name, checks the tap re-solve returns to the shown pose, confirms, and
// prints the log event kinds. Screenshots: <prefix>-panel/-preview/-tap/-confirmed.png.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { chromium } from "playwright";

const [id, out, rendererArg] = process.argv.slice(2);
// renderer always explicit (WebGL deck unless another is given): the app default may be either
const renderer = rendererArg ?? "deck";
if (!id || !out) {
	console.error(
		"usage: picker-check.mjs <photoId> <outPrefix> [deck|webgpu|auto]",
	);
	process.exit(1);
}
mkdirSync(dirname(out), { recursive: true });
const base = process.env.BASE ?? "http://localhost:3100";
const url = `${base}/photo/${id}?picker=on&renderer=${renderer}`;
const browser = await chromium.launch({
	headless: true,
	args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu"],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on("console", (m) => {
	const t = m.text();
	if (/picker|error/i.test(t)) console.log("[console]", t.slice(0, 300));
});
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
const t0 = Date.now();
await page.addInitScript(() => localStorage.removeItem("rigi.picker.log.v1"));
await page.goto(url, { waitUntil: "load", timeout: 120000 });
await page.waitForSelector("[data-ready]", { timeout: 180000 });
console.log("ready after", ((Date.now() - t0) / 1000).toFixed(1), "s");
await page
	.waitForFunction(
		() => {
			const v = document
				.querySelector("[data-verify]")
				?.getAttribute("data-verify");
			return v !== "pending";
		},
		null,
		{ timeout: 60000 },
	)
	.catch(() => console.log("verify still pending"));
await page.waitForFunction(
	() => {
		const e = document.querySelector("[data-picker]");
		return (
			e &&
			e.getAttribute("data-picker") !== "finding" &&
			e.getAttribute("data-picker") !== "idle"
		);
	},
	null,
	{ timeout: 120000 },
);
const st = await page.evaluate(() => ({
	align: document.querySelector("[data-align]")?.getAttribute("data-align"),
	verify: document.querySelector("[data-verify]")?.getAttribute("data-verify"),
	picker: document.querySelector("[data-picker]")?.getAttribute("data-picker"),
	count: document
		.querySelector("[data-picker-count]")
		?.getAttribute("data-picker-count"),
	p: window.__picker,
	pose: window.__engine?.pose,
}));
console.log(
	"state",
	JSON.stringify({
		align: st.align,
		verify: st.verify,
		picker: st.picker,
		count: st.count,
		shownIndex: st.p?.shownIndex,
	}),
);
for (const [i, c] of (st.p?.candidates ?? []).entries())
	console.log(
		`  cand ${i}: ${c.source}#${c.sourceRank} score=${c.score?.toFixed?.(3)} yaw=${c.pose.yaw.toFixed(2)} pitch=${c.pose.pitch.toFixed(2)} roll=${c.pose.roll.toFixed(2)} vfov=${c.pose.vfov.toFixed(2)}`,
	);
// open the panel if collapsed
if (!(await page.$("[data-picker-count]"))) await page.click("[data-picker]");
await page.waitForSelector("[data-picker-count]");
await page.screenshot({ path: `${out}-panel.png` });
// tap test: a visible labelled peak under the shown pose
const shown = st.pose;
const peak = await page.evaluate(() => {
	const l = window.__engine
		.peakLabels(12)
		.filter(
			(x) => x.visible && x.u > 0.1 && x.u < 0.9 && x.v > 0.15 && x.v < 0.8,
		);
	return l[0] ?? null;
});
if (!peak) {
	console.log("no visible peak to tap");
	await browser.close();
	process.exit(0);
}
console.log("tap target", peak.name, peak.u.toFixed(3), peak.v.toFixed(3));
// perturb: preview the candidate farthest from shown (or nudge yaw +5 if only one)
const nC = (st.p?.candidates ?? []).length;
const far = nC > 1 ? (st.p.shownIndex === 0 ? 1 : 0) : -1;
if (far >= 0) await page.click(`[data-picker-thumb="cand-${far}"]`);
await page.waitForTimeout(400);
const perturbed = await page.evaluate(() => window.__engine.pose);
console.log(
	"previewing cand",
	far,
	"yaw",
	perturbed.yaw.toFixed(2),
	"(shown",
	`${shown.yaw.toFixed(2)})`,
);
await page.screenshot({ path: `${out}-preview.png` });
await page.click("[data-picker-tap]");
const box = await page.$eval("[data-picker-tap-layer]", (e) => {
	const r = e.getBoundingClientRect();
	return { x: r.left, y: r.top, w: r.width, h: r.height };
});
await page.mouse.click(box.x + peak.u * box.w, box.y + peak.v * box.h);
await page.waitForSelector("[data-picker-peaks]");
const offered = await page.$$eval("[data-picker-peak]", (b) =>
	b.map((x) => x.getAttribute("data-picker-peak")),
);
console.log("offered", offered.slice(0, 8).join(" | "));
await page.screenshot({ path: `${out}-tap.png` });
if (!offered.includes(peak.name)) {
	console.log("tapped peak NOT offered");
	await browser.close();
	process.exit(1);
}
await page.click(`[data-picker-peak="${peak.name.replace(/"/g, '\\"')}"]`);
await page.waitForTimeout(500);
const after = await page.evaluate(() => ({
	pose: window.__engine.pose,
	tap: window.__pickerTap,
}));
for (const [i, r] of after.tap.results.entries())
	console.log(
		`  tap ${i}: from ${r.from}#${r.fromRank} tapPx=${r.tapPx.toFixed(2)} skyline=${r.skyline?.toFixed(3)} yaw=${r.pose.yaw.toFixed(2)} pitch=${r.pose.pitch.toFixed(2)}`,
	);
const d = (a, b) =>
	`dyaw=${(a.yaw - b.yaw).toFixed(3)} dpitch=${(a.pitch - b.pitch).toFixed(3)} droll=${(a.roll - b.roll).toFixed(3)}`;
console.log("tap-solved vs shown:", d(after.pose, shown));
const tapOk =
	Math.abs(after.pose.yaw - shown.yaw) < 0.2 &&
	Math.abs(after.pose.pitch - shown.pitch) < 0.2;
console.log(
	tapOk
		? "PASS tap re-solve returned to the shown pose"
		: "FAIL tap re-solve did not return to the shown pose",
);
await page.click("[data-picker-tap]"); // leave tap mode
await page.click("[data-picker-confirm]");
await page.waitForTimeout(400);
const fin = await page.evaluate(() => ({
	align: document.querySelector("[data-align]")?.getAttribute("data-align"),
	log: JSON.parse(localStorage.getItem("rigi.picker.log.v1") ?? "[]").map(
		(e) => e.kind,
	),
}));
console.log("after confirm: align =", fin.align, "log =", fin.log.join(","));
await page.screenshot({ path: `${out}-confirmed.png` });
await browser.close();
process.exit(tapOk && fin.align === "manual" ? 0 : 1);
