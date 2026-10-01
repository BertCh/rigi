#!/usr/bin/env node
// W4 copy of scripts/deck-engine-smoke.mjs: per-tile terrain (?terrain=tiles) vs batched (?terrain=batched,
// see src/lib/deck/terrain-mode.ts) on the WebGL deck, plus terrain draw calls, main-thread mesh build ms and
// the silhouette re-rank time. The reference arm is one WebGL deck run per photo with per-tile terrain (it was
// the three.js PhotoEngine until that renderer was removed, 2026-10-01); each mode in --modes is compared
// with it, so the "tiles" row is a run-to-run self-check. Same pass rule, applied to each deck mode.
// Usage: node scripts/gpu/with-render-lock.mjs -- node scripts/gpu/w4-deck-smoke-batched.mjs \
//          --url http://localhost:3110 --out out/gpu/w4/deck-smoke-batched.json
//
// Original header:
// Smoke test for DeckEngine (src/lib/deck/engine.ts) against the three.js PhotoEngine.
// For each photo:
//   three: /photo/<id> (fresh localStorage), wait for [data-ready], then window.__engine.autoAlign(true)
//          (the same call PhotoWorkspace makes on load, without the second opinion) and its labels
//          at that pose.
//   deck:  the same on /photo/<id>?renderer=deck, plus its labels at three's pose.
// Pass: |Δyaw| ≤ 0.5° and label overlap (|A∩B| / |A∪B| at three's pose) ≥ 0.6, where a peak labelled
// by one engine only still counts as agreeing when its occlusion margin (engine.ts peakLabels: terrain
// range below the summit minus range·0.97 − 50) is within max(50 m, 1% of range) of that threshold in
// either engine: the DEMs differ in resolution (z14 vs z17) and far-tile smoothing, so such a verdict
// is a coin toss.
//
// Usage: node scripts/deck-engine-smoke.mjs [--url http://localhost:3100] [--photos IMG_6958,...]
//        [--out out/lead/deck-parity/deck-engine-smoke.json] [--headed]
// Needs the vite dev server (window.__engine is DEV-only). Exit 0 = all pass, 3 = some fail.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const arg = (k, d) => {
	const i = process.argv.indexOf(`--${k}`);
	return i > 0 ? process.argv[i + 1] : d;
};
const BASE = arg("url", "http://localhost:3100");
const IDS = arg("photos", "IMG_6958,IMG_7018,IMG_7063,IMG_7155").split(",");
const OUT = resolve(ROOT, arg("out", "out/gpu/w4/deck-smoke-batched.json"));
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
	const onlyRef = [...A].filter((x) => !B.has(x));
	const onlyDeck = [...B].filter((x) => !A.has(x));
	const tolerated = [...onlyRef, ...onlyDeck].filter(
		(x) => borderline(marginsA[x]) || borderline(marginsB[x]),
	);
	return {
		jaccard: union ? (inter + tolerated.length) / union : 1,
		strictJaccard: union ? inter / union : 1,
		ofMin: Math.min(A.size, B.size) ? inter / Math.min(A.size, B.size) : 1,
		inter,
		onlyRef,
		onlyDeck,
		tolerated: tolerated.map((x) => ({
			name: x,
			ref: marginsA[x] ?? null,
			deck: marginsB[x] ?? null,
		})),
	};
};

const browser = await chromium.launch({
	headless: !process.argv.includes("--headed"),
	args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu"],
});

async function run(id, renderer, refPose = null, terrain = null) {
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
	await page.goto(
		`${BASE}/photo/${id}${renderer === "deck" ? `?renderer=deck${terrain && terrain !== "default" ? `&terrain=${terrain}` : ""}` : ""}`,
	);
	await page.waitForSelector("[data-ready]", { timeout: 240_000 });
	const readyMs = Date.now() - t0;
	const r = await page.evaluate(async (tp) => {
		const e = window.__engine;
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
		const ds = globalThis.__rigiTerrainStats;
		const d0 = ds?.draws ?? 0;
		const t = performance.now();
		const res = await e.autoAlign(true);
		const alignMs = performance.now() - t;
		const alignDraws = (ds?.draws ?? 0) - d0;
		if (!res) return null;
		e.setPose(res.pose);
		await e.readback();
		const labels = e.peakLabels().map((l) => l.name);
		const ownMargins = margins();
		let atRef = null;
		let atRefMargins = null;
		if (tp) {
			e.setPose(tp);
			await e.readback();
			atRef = e.peakLabels().map((l) => l.name);
			atRefMargins = margins();
		}
		return {
			pose: res.pose,
			confidence: res.confidence,
			alignMs,
			alignDraws,
			terrainStats: e.renderSet?.stats ?? null,
			eyeZ: e.eye.z,
			labels,
			margins: ownMargins,
			atRef,
			atRefMargins,
			stats: e.stats ?? null,
		};
	}, refPose);
	await page.close();
	return { readyMs, ...r, logs };
}

const rows = [];
const MODES = arg("modes", "tiles,batched").split(",");
const refRuns = new Map();
for (const id of IDS)
	for (const mode of MODES) {
		process.stdout.write(`${id} [${mode}]: `);
		// the reference runs once per photo (every mode compares against the same ref pose)
		if (!refRuns.has(id)) {
			process.stdout.write("ref (tiles)… ");
			refRuns.set(
				id,
				await run(id, "deck", null, "tiles").catch((e) => ({
					error: String(e),
				})),
			);
		}
		const ref = refRuns.get(id);
		process.stdout.write("deck… ");
		const deck = await run(id, "deck", ref?.pose ?? null, mode).catch((e) => ({
			error: String(e),
		}));
		const dPose = deck?.pose;
		const row = { id, mode, ref, deck };
		if (ref?.pose && dPose) {
			row.dYaw = angle(dPose.yaw, ref.pose.yaw);
			row.dPitch = dPose.pitch - ref.pose.pitch;
			row.dRoll = dPose.roll - ref.pose.roll;
			row.dVfov = dPose.vfov - ref.pose.vfov;
			row.labelsAtRefPose = overlap(
				ref.labels,
				deck.atRef ?? [],
				ref.margins,
				deck.atRefMargins ?? {},
			);
			row.labelsOwnPose = overlap(
				ref.labels,
				deck.labels ?? [],
				ref.margins,
				deck.margins,
			);
			row.pass =
				Math.abs(row.dYaw) <= YAW_TOL &&
				row.labelsAtRefPose.jaccard >= OVERLAP_MIN;
		} else row.pass = false;
		rows.push(row);
		console.log(
			row.dYaw != null
				? `Δyaw ${row.dYaw.toFixed(2)}° Δpitch ${row.dPitch.toFixed(2)}° Δroll ${row.dRoll.toFixed(2)}° Δvfov ${row.dVfov.toFixed(2)}° | labels@ref J=${row.labelsAtRefPose.jaccard.toFixed(2)} (strict ${row.labelsAtRefPose.strictJaccard.toFixed(2)}, ${row.labelsAtRefPose.tolerated.length} borderline; ${row.labelsAtRefPose.inter}/${ref.labels.length}/${deck.atRef.length}) own J=${row.labelsOwnPose.jaccard.toFixed(2)} | deck ready ${deck.readyMs} ms align ${Math.round(deck.alignMs)} ms (ref align ${Math.round(ref.alignMs)} ms) horizon=${deck.stats?.horizonSource} sil ${Math.round(deck.stats?.silhouette?.ms ?? -1)} ms draws/align ${deck.alignDraws} build ${deck.terrainStats?.buildMs} ms ${row.pass ? "PASS" : "FAIL"}`
				: `FAIL ${ref?.error ?? ""} ${deck?.error ?? ""}`,
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
