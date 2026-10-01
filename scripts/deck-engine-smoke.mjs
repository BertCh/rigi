#!/usr/bin/env node
// Smoke test for DeckEngine (src/lib/deck/engine.ts) against the three.js PhotoEngine.
// For each photo:
//   three: /photo/<id>?renderer=three (fresh localStorage), wait for [data-ready] and for the background
//          second opinion to settle ([data-verify] not "pending"), then window.__engine.autoAlign(true)
//          (the same call PhotoWorkspace makes on load, without the second opinion) and its labels
//          at that pose.
//   deck:  the same on /photo/<id>?renderer=<--renderer: deck (WebGL, default) | webgpu | auto>, plus its
//          labels at three's pose. webgpu / auto launch Chromium with the WebGPU flags (gpu-args.mjs).
// Pass: |Δyaw| ≤ 0.5° and label overlap (|A∩B| / |A∪B| at three's pose) ≥ 0.6, where a peak labelled
// by one engine only still counts as agreeing when its occlusion margin (engine.ts peakLabels: terrain
// range below the summit minus range·0.97 − 50) is within max(50 m, 1% of range) of that threshold in
// either engine: the DEMs differ in resolution (z14 vs z17) and far-tile smoothing, so such a verdict
// is a coin toss.
//
// Usage: node scripts/deck-engine-smoke.mjs [--url http://localhost:3100] [--photos IMG_6958,...]
//        [--out out/lead/deck-parity/deck-engine-smoke.json] [--headed] [--renderer deck|webgpu|auto]
// Needs the vite dev server (window.__engine is DEV-only). Exit 0 = all pass, 3 = some fail.
// Both arms pass ?renderer= explicitly (the app default may be either) and each row records the
// engine that actually ran (__engine.kind ?? "three"; "webgpu" when __engine.backend is "webgpu", checked
// against [data-renderer]); a run whose engine is not the one asked for fails (auto: whatever resolved).

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { GPU_ARGS } from "./deck-webgpu/gpu-args.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (k, d) => {
	const i = process.argv.indexOf(`--${k}`);
	return i > 0 ? process.argv[i + 1] : d;
};
const BASE = arg("url", "http://localhost:3100");
const IDS = arg("photos", "IMG_6958,IMG_7018,IMG_7063,IMG_7155").split(",");
const OUT = resolve(
	ROOT,
	arg("out", "out/lead/deck-parity/deck-engine-smoke.json"),
);
const DECK = arg("renderer", "deck");
if (!["deck", "webgpu", "auto"].includes(DECK)) {
	console.error(`--renderer must be deck, webgpu or auto (got ${DECK})`);
	process.exit(2);
}
const YAW_TOL = 0.5;
const OVERLAP_MIN = 0.6;

const angle = (a, b) => ((a - b + 540) % 360) - 180;
const MARGIN_TOL = (range) => Math.max(50, 0.01 * range);
const borderline = (m) =>
	m != null && Math.abs(m.margin) <= MARGIN_TOL(m.range);
const overlap = (a, b, marginsA = {}, marginsB = {}) => {
	const A = new Set(a);
	const B = new Set(b);
	const inter = [...A].filter((x) => B.has(x)).length;
	const union = new Set([...A, ...B]).size;
	const onlyThree = [...A].filter((x) => !B.has(x));
	const onlyDeck = [...B].filter((x) => !A.has(x));
	const tolerated = [...onlyThree, ...onlyDeck].filter(
		(x) => borderline(marginsA[x]) || borderline(marginsB[x]),
	);
	return {
		jaccard: union ? (inter + tolerated.length) / union : 1,
		strictJaccard: union ? inter / union : 1,
		ofMin: Math.min(A.size, B.size) ? inter / Math.min(A.size, B.size) : 1,
		inter,
		onlyThree,
		onlyDeck,
		tolerated: tolerated.map((x) => ({
			name: x,
			three: marginsA[x] ?? null,
			deck: marginsB[x] ?? null,
		})),
	};
};

const browser = await chromium.launch({
	headless: !process.argv.includes("--headed"),
	args:
		DECK === "deck"
			? ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu"]
			: GPU_ARGS,
});

async function run(id, renderer, threePose = null) {
	const page = await browser.newPage({
		viewport: { width: 1400, height: 900 },
	});
	const logs = [];
	page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
	page.on(
		"console",
		(m) =>
			m.type() === "error" && logs.push(`error: ${m.text().slice(0, 300)}`),
	);
	await page.addInitScript(() => localStorage.clear());
	const t0 = Date.now();
	await page.goto(`${BASE}/photo/${id}?renderer=${renderer}`);
	await page.waitForSelector("[data-ready]", { timeout: 240_000 });
	const readyMs = Date.now() - t0;
	// The app's background second opinion lands ~150-300 ms after [data-ready] and calls
	// engine.setPose(its pose). Started before it settles, the setPose(res.pose) below races it and
	// the labels are read at the second opinion's pose (IMG_7086: 162.70° instead of 156.72°, which
	// swaps Finsteraarhorn at the left edge for Balmhorn at the right). Same wait as eval-app.mjs.
	await page.waitForFunction(
		() =>
			document.querySelector("[data-ready]")?.getAttribute("data-verify") !==
			"pending",
		null,
		{ timeout: 180_000 },
	);
	const r = await page.evaluate(async (tp) => {
		const e = window.__engine;
		const engineKind = e.backend === "webgpu" ? "webgpu" : (e.kind ?? "three");
		const dataRenderer =
			document
				.querySelector("[data-renderer]")
				?.getAttribute("data-renderer") ?? null;
		// occlusion margin per in-frame peak (m; > 0 = visible), as peakLabels tests it
		const margins = () => {
			const out = {};
			for (const p of e.peaksInFrame()) {
				if (p.u < 0 || p.u > 1 || p.v < 0 || p.v > 1) continue;
				const range = Math.hypot(
					p.world[0] - e.eye.x,
					p.world[1] - e.eye.y,
					p.world[2] - e.eye.z,
				);
				let margin = Number.NEGATIVE_INFINITY;
				for (const dv of [0.004, 0.009]) {
					const s = e.sampleAt(p.u, p.v + dv);
					margin = Math.max(margin, s ? s.range - (range * 0.97 - 50) : 1e9); // 1e9: sky below the summit
				}
				// duplicate names: keep the one nearest the threshold
				if (!(p.name in out) || Math.abs(margin) < Math.abs(out[p.name].margin))
					out[p.name] = { margin, range };
			}
			return out;
		};
		// setPose + readback, then check nothing else (a late matcher upgrade) moved the pose meanwhile;
		// peakLabels() follows synchronously, so the labels are for exactly this pose
		const same = (a, b) =>
			["yaw", "pitch", "roll", "vfov"].every((k) => a[k] === b[k]);
		let poseRetries = 0;
		const settle = async (p) => {
			for (let i = 0; i < 3; i++) {
				e.setPose(p);
				await e.readback();
				if (same(e.pose, p)) return;
				poseRetries++;
			}
			throw new Error("the app kept moving the pose after setPose");
		};
		const t = performance.now();
		const res = await e.autoAlign(true);
		const alignMs = performance.now() - t;
		if (!res) return null;
		await settle(res.pose);
		const labels = e.peakLabels().map((l) => l.name);
		const ownMargins = margins();
		let atThree = null;
		let atThreeMargins = null;
		if (tp) {
			await settle(tp);
			atThree = e.peakLabels().map((l) => l.name);
			atThreeMargins = margins();
		}
		return {
			engineKind,
			dataRenderer,
			pose: res.pose,
			confidence: res.confidence,
			alignMs,
			eyeZ: e.eye.z,
			labels,
			margins: ownMargins,
			atThree,
			atThreeMargins,
			poseRetries,
			stats: e.stats ?? null,
		};
	}, threePose);
	await page.close();
	if (r?.dataRenderer && r.dataRenderer !== r.engineKind)
		throw new Error(
			`[data-renderer] ${r.dataRenderer} but __engine is ${r.engineKind}`,
		);
	if (r && renderer !== "auto" && r.engineKind !== renderer)
		throw new Error(
			`asked for renderer=${renderer} but __engine.kind is ${r.engineKind}`,
		);
	return { readyMs, ...r, logs };
}

const rows = [];
for (const id of IDS) {
	process.stdout.write(`${id}: three… `);
	const three = await run(id, "three").catch((e) => ({ error: String(e) }));
	process.stdout.write(`${DECK}… `);
	const deck = await run(id, DECK, three?.pose ?? null).catch((e) => ({
		error: String(e),
	}));
	const dPose = deck?.pose;
	const row = { id, three, deck };
	if (three?.pose && dPose) {
		row.dYaw = angle(dPose.yaw, three.pose.yaw);
		row.dPitch = dPose.pitch - three.pose.pitch;
		row.dRoll = dPose.roll - three.pose.roll;
		row.dVfov = dPose.vfov - three.pose.vfov;
		row.labelsAtThreePose = overlap(
			three.labels,
			deck.atThree ?? [],
			three.margins,
			deck.atThreeMargins ?? {},
		);
		row.labelsOwnPose = overlap(
			three.labels,
			deck.labels ?? [],
			three.margins,
			deck.margins,
		);
		row.pass =
			Math.abs(row.dYaw) <= YAW_TOL &&
			row.labelsAtThreePose.jaccard >= OVERLAP_MIN;
	} else row.pass = false;
	rows.push(row);
	console.log(
		row.dYaw != null
			? `Δyaw ${row.dYaw.toFixed(2)}° Δpitch ${row.dPitch.toFixed(2)}° Δroll ${row.dRoll.toFixed(2)}° Δvfov ${row.dVfov.toFixed(2)}° | labels@three J=${row.labelsAtThreePose.jaccard.toFixed(2)} (strict ${row.labelsAtThreePose.strictJaccard.toFixed(2)}, ${row.labelsAtThreePose.tolerated.length} borderline; ${row.labelsAtThreePose.inter}/${three.labels.length}/${deck.atThree.length}) own J=${row.labelsOwnPose.jaccard.toFixed(2)} | deck ready ${deck.readyMs} ms align ${Math.round(deck.alignMs)} ms (three align ${Math.round(three.alignMs)} ms) horizon=${deck.stats?.horizonSource} engines=${three.engineKind}/${deck.engineKind} ${row.pass ? "PASS" : "FAIL"}`
			: `FAIL ${three?.error ?? ""} ${deck?.error ?? ""}`,
	);
}
await browser.close();
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
	OUT,
	JSON.stringify({ at: new Date().toISOString(), base: BASE, rows }, null, 1),
);
console.log(`wrote ${OUT}`);
process.exit(rows.every((r) => r.pass) ? 0 : 3);
