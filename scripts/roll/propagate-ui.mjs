#!/usr/bin/env node
// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// R5 browser check: /roll pose-propagation panel on the bundled Niederhorn viewpoint (IMG_7059/7063/7068).
// Needs the dev server (default :3100) and tools/nearfield/propagate/run_service.sh (:8769).
// Run under the render lock:
//   node scripts/gpu/with-render-lock.mjs -- node scripts/roll/propagate-ui.mjs [--base http://localhost:3100] [--out out/propagate]
// Checks: flag off = no panel; dev mode (GT anchor 7063) → 7059/7068 suggested, 7053/7086 rejected with reasons;
// target 7068 shows the suggestion with Accept disabled (GT outranks); mode on with a saved 7063 anchor.
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const arg = (k, d) => {
	const i = process.argv.indexOf(`--${k}`);
	return i > 0 ? process.argv[i + 1] : d;
};
const BASE = arg("base", "http://localhost:3100");
const OUT = arg("out", "out/propagate");
mkdirSync(OUT, { recursive: true });

let fails = 0;
const ok = (c, m) => {
	if (!c) fails++;
	console.log(c ? "ok  " : "FAIL", m);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on("pageerror", (e) => console.log("pageerror", e.message));

const rows = () =>
	page.$$eval("[data-testid=propagate-row]", (els) =>
		els.map((e) => ({
			target: e.getAttribute("data-target"),
			status: e.getAttribute("data-status"),
			text: e.innerText.replace(/\s+/g, " ").trim(),
		})),
	);
const waitDone = () =>
	page.waitForFunction(
		() => {
			const b = document.querySelector("[data-testid=propagate-run]");
			return b && !b.textContent?.includes("Working");
		},
		null,
		{ timeout: 240_000 },
	);

// 0. flag off: no panel (default unchanged)
await page.goto(`${BASE}/roll/region-0?photo=IMG_7063`, {
	waitUntil: "domcontentloaded",
});
await page.waitForSelector("[data-testid=roll-detail]", { timeout: 60_000 });
await page.evaluate(() => {
	sessionStorage.clear();
	for (const k of Object.keys(localStorage))
		if (
			k.startsWith("rigi.propagate") ||
			k === "rigi.pose.IMG_7063" ||
			k.startsWith("rigi.rollpose.")
		)
			localStorage.removeItem(k);
});
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector("[data-testid=roll-detail]", { timeout: 60_000 });
ok(
	(await page.$("[data-testid=propagate-panel]")) === null,
	"no panel without ?propagate",
);

// 1. dev mode, GT anchor IMG_7063
await page.goto(`${BASE}/roll/region-0?propagate=dev&photo=IMG_7063`, {
	waitUntil: "domcontentloaded",
});
await page.waitForSelector("[data-testid=propagate-anchor]", {
	timeout: 60_000,
});
await page.waitForFunction(
	() =>
		!document
			.querySelector("[data-testid=propagate-service]")
			?.textContent?.includes("…"),
);
const svc = await page.textContent("[data-testid=propagate-service]");
console.log("service:", svc);
const up = svc?.includes("up");
if (!up) {
	ok(
		await page.$eval("[data-testid=propagate-run]", (b) => b.disabled),
		"service down: run button disabled",
	);
	ok(
		(await page.textContent("[data-testid=propagate-panel]"))?.includes(
			"not reachable",
		),
		"service down: panel says so, poses unchanged",
	);
	await page.screenshot({ path: `${OUT}/service-down.png` });
} else {
	const t0 = Date.now();
	await page.click("[data-testid=propagate-run]");
	await page.waitForSelector("[data-testid=propagate-row]");
	await waitDone();
	const r1 = await rows();
	console.log(`dev run ${(Date.now() - t0) / 1000}s`);
	for (const r of r1) console.log("   ", r.status.padEnd(9), r.text);
	await page.screenshot({ path: `${OUT}/dev-anchor-7063.png` });
	const st = Object.fromEntries(r1.map((r) => [r.target, r.status]));
	if (svc?.includes("up")) {
		ok(
			st.IMG_7059 === "suggested" && st.IMG_7068 === "suggested",
			"7059 and 7068 suggested from 7063",
		);
		ok(
			st.IMG_7053 !== "suggested" && st.IMG_7086 !== "suggested",
			"7053 and 7086 (pointing away) not suggested",
		);
		ok(
			r1
				.filter((r) => r.status === "rejected" || r.status === "skipped")
				.every((r) =>
					/inliers|overlap|baseline|compass|rms|nearest/.test(r.text),
				),
			"every rejected/skipped row shows a reason",
		);
		ok(
			!r1.some((r) => /HIGH|accepted/i.test(r.text)),
			"no row claims HIGH / accepted",
		);

		// 2. the target shows the suggestion; GT outranks → Accept disabled
		await page.click(
			"[data-testid=propagate-row][data-target=IMG_7068] button",
		);
		await page.waitForSelector("[data-testid=propagate-suggestion]", {
			timeout: 10_000,
		});
		const sug = await page.$eval("[data-testid=propagate-suggestion]", (e) =>
			e.innerText.replace(/\s+/g, " "),
		);
		console.log("    target 7068:", sug);
		ok(
			/Suggested pose from IMG_7063/.test(sug),
			"7068 shows 'Suggested pose from IMG_7063'",
		);
		ok(
			await page.$eval("[data-testid=propagate-accept]", (b) => b.disabled),
			"Accept disabled on a GT target",
		);
		await page.screenshot({ path: `${OUT}/dev-target-7068.png` });
		const stored = await page.evaluate(() =>
			JSON.parse(localStorage.getItem("rigi.propagate.v1") || "{}"),
		);
		ok(
			Object.values(stored).every(
				(s) =>
					s.provenance === "propagated-suggestion" &&
					s.status === "pending" &&
					!("confidence" in s),
			),
			`stored suggestions: provenance propagated-suggestion, pending, no confidence (${Object.keys(stored).length})`,
		);
		const rp = await page.evaluate(() =>
			Object.keys(localStorage).filter((k) => k.startsWith("rigi.rollpose.")),
		);
		ok(
			rp.length === 0,
			"nothing written to solved poses without a user accept",
		);
	}

	// 3. mode on: 7063 saved by the user (its GT pose) anchors; targets are prior-only photos
	await page.evaluate(() => {
		localStorage.setItem(
			"rigi.pose.IMG_7063",
			JSON.stringify({
				yaw: 29.553,
				pitch: 1.936,
				roll: -3.377,
				vfov: 52.22019110850652,
			}),
		);
		localStorage.removeItem("rigi.propagate.v1");
	});
	await page.goto(`${BASE}/roll/region-0?propagate=on&photo=IMG_7063`, {
		waitUntil: "domcontentloaded",
	});
	await page.waitForSelector("[data-testid=propagate-anchor]", {
		timeout: 60_000,
	});
	const anchorTxt = await page.textContent("[data-testid=propagate-anchor]");
	ok(/\(saved\)/.test(anchorTxt ?? ""), "mode on: saved 7063 is the anchor");
	await page.click("[data-testid=propagate-run]");
	await waitDone();
	await page.waitForTimeout(300);
	const r2 = await rows();
	for (const r of r2) console.log("   ", r.status.padEnd(9), r.text);
	ok(
		r2.every((r) => r.target !== "IMG_7068" && r.target !== "IMG_7059"),
		"mode on: GT-posed photos are not targets",
	);
	ok(
		r2.every((r) => r.status !== "suggested"),
		"mode on: no suggestion for the far / non-overlapping prior photo",
	);
	await page.screenshot({ path: `${OUT}/on-anchor-7063.png` });
	// the flag survives the route's search rewrite (select another photo)
	await page.click("[data-testid=propagate-row] button").catch(() => {});
	await page.waitForTimeout(500);
	ok(
		(await page.$("[data-testid=propagate-panel]")) !== null,
		"panel stays after navigating within the roll",
	);
	await page.evaluate(() => {
		localStorage.removeItem("rigi.pose.IMG_7063");
		localStorage.removeItem("rigi.propagate.v1");
		sessionStorage.clear();
	});
}
await browser.close();
console.log(fails ? `${fails} FAILED` : "ALL OK");
process.exit(fails ? 1 : 0);
