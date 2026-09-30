#!/usr/bin/env node
// Unknown-pose 360° horizon on the GPU (src/lib/gpu/horizon/scene-profile.ts) vs the worker's CPU
// sceneHorizon, in headless Chromium (WebGPU) against the private dev server.
//
//   node scripts/gpu/with-render-lock.mjs -- node scripts/gpu/unknown-horizon.mjs [bench] [ablation] [IMG_xxxx ...]
//
// bench:    per ablation photo, the worker's scene (loadScene, Mapterhorn): DEM load, CPU sceneHorizon,
//           GPU sceneHorizonGpu cold/warm, profile parity (per-azimuth elevation differences).
// ablation: the real worker (UnknownPoseSolver, src/lib/integration/unknown-pose.ts) on each photo under
//           five conditions, once with ?unknownGpu=off (CPU horizon) and once with ?unknownGpu=on (GPU).
//           Scored against the pin GT (11 photos) and data/ground-truth.json (12) as reports/bench-ablation.md:
//           accepted at |Δyaw| < 1° = true accept, accepted at ≥ 1° = FALSE accept.
//
// Photos: tools/bench/harness/out/ablation/manifest.json (read only). Env: APP_URL (default :3110).
// Writes out/gpu/unknown/{bench,ablation}.json (small) and prints tables.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = path.resolve(import.meta.dirname, "../..");
const BASE = process.env.APP_URL ?? "http://localhost:3110";
const OUT = path.join(ROOT, "out/gpu/unknown");
const argv = process.argv.slice(2);
const doBench = argv.includes("bench") || !argv.includes("ablation");
const doAbl = argv.includes("ablation") || !argv.includes("bench");
const only = argv.filter((a) => a.startsWith("IMG_"));
const manifest = JSON.parse(
	fs.readFileSync(
		path.join(ROOT, "tools/bench/harness/out/ablation/manifest.json"),
		"utf8",
	),
).filter((e) => !only.length || only.includes(e.id));

const CONDS = [
	["full", { yaw: false, gravity: false, focal: false }],
	["nogravity", { yaw: false, gravity: true, focal: false }],
	["noheading", { yaw: true, gravity: false, focal: false }],
	["none", { yaw: true, gravity: true, focal: false }],
	["none+nofocal", { yaw: true, gravity: true, focal: true }],
];

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
	headless: true,
	args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu"],
});
const dang = (a, b) => ((((a - b) % 360) + 540) % 360) - 180;
const q = (xs, p) => {
	const s = [...xs].sort((a, b) => a - b);
	return s.length
		? s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]
		: Number.NaN;
};

try {
	const page = await browser.newPage();
	page.on("console", (m) => {
		if (m.type() === "error" || m.type() === "warning")
			console.error(`[page ${m.type()}]`, m.text().slice(0, 300));
	});
	page.on("pageerror", (e) => console.error("[pageerror]", e.message));

	if (doBench) {
		await page.goto(`${BASE}/favicon.svg`);
		const rows = [];
		for (const e of manifest) {
			const r = await page.evaluate(
				async (a) => {
					const m = await import("/src/lib/gpu/horizon/scene-profile-bench.ts");
					return m.benchScene(a);
				},
				{ lat: e.lat, lon: e.lon, alt: e.altitudeM ?? null },
			);
			rows.push({ id: e.id, ...r });
			const p = r.parity;
			console.log(
				`${e.id}: ${r.tiles} tiles load ${r.loadMs.toFixed(0)} ms | cpu ${r.cpuMs.map((x) => x.toFixed(0)).join("/")} ms | ` +
					`gpu ${r.gpuMs.map((t) => `${t.totalMs.toFixed(0)}(mos ${t.mosaicMs.toFixed(0)}+gpu ${t.gpuMs.toFixed(0)})`).join(" / ")} ms | ` +
					`twin bit-diff ${r.twinBitDiff} | ` +
					(p
						? `Δel max ${p.maxDEl.toExponential(2)}° p99 ${p.p99DEl.toExponential(2)}° med ${p.medDEl.toExponential(2)}° >0.01° ${p.over001} empty≠ ${p.emptyMismatch} dist±1% ${(100 * p.dist1pct).toFixed(2)}%`
						: "NO GPU"),
			);
		}
		fs.writeFileSync(
			path.join(OUT, "bench.json"),
			JSON.stringify(rows, null, 1),
		);
	}

	if (doAbl) {
		const rows = [];
		// ABL_MODES=cpu: only the CPU-horizon pass (e.g. A/B of the GPU coarse grid under with-gpu-off.mjs)
		for (const mode of (process.env.ABL_MODES ?? "cpu,gpu").split(",")) {
			await page.goto(
				`${BASE}/favicon.svg?unknownGpu=${mode === "gpu" ? "on" : "off"}`,
			);
			for (const e of manifest) {
				const t0 = Date.now();
				const res = await page.evaluate(
					async ({ e, conds, graph }) => {
						const m = await import("/src/lib/integration/unknown-pose.ts");
						// the host page is an SVG document (no app): make createElement("canvas") an HTML canvas
						if (!(document instanceof HTMLDocument)) {
							const ce = document.createElement.bind(document);
							document.createElement = (t, o) =>
								t === "canvas"
									? document.createElementNS(
											"http://www.w3.org/1999/xhtml",
											"canvas",
										)
									: ce(t, o);
						}
						const img = new Image();
						img.src = `/photos/${e.id}.jpg`;
						await img.decode();
						const photo = {
							id: e.id,
							lat: e.lat,
							lon: e.lon,
							alt: e.altitudeM ?? null,
							hAccuracy: e.gpsErrorM ?? null,
							width: e.width,
							height: e.height,
						};
						// ABL_GRAPH=1: GPU work on core command graphs (plumbing A/B)
						const s = new m.UnknownPoseSolver(photo, { graph });
						const out = [];
						try {
							for (const [cond, u] of conds) {
								const prior = {
									yaw: u.yaw ? 0 : e.headingDeg,
									pitch: u.gravity ? 0 : e.pitchDeg,
									roll: u.gravity ? 0 : e.rollDeg,
									vfov: e.vfovDeg,
								};
								try {
									const r = await s.solve(img, prior, { ...u, any: true });
									out.push({
										cond,
										pose: r.pose,
										confidence: r.confidence,
										accepted: r.accepted,
										stage: r.stage,
										ms: r.ms,
										horizonOn: r.horizonOn,
										solveOn: r.solveOn,
										seeds: r.seeds.map((x) => ({
											yaw: x.yaw,
											c: x.confidence,
											a: x.accepted,
										})),
									});
								} catch (err) {
									out.push({ cond, error: String(err) });
								}
							}
						} finally {
							s.dispose();
						}
						return out;
					},
					{ e, conds: CONDS, graph: process.env.ABL_GRAPH === "1" },
				);
				for (const r of res) {
					const row = { id: e.id, mode, ...r };
					for (const [k, g] of [
						["pin", e.gtPin],
						["gt", e.gt],
					])
						if (g && r.pose) row[`dYaw_${k}`] = dang(r.pose.yaw, g.yaw);
					rows.push(row);
				}
				console.log(
					`${mode} ${e.id} [${((Date.now() - t0) / 1000).toFixed(0)} s]: ` +
						res
							.map((r) =>
								r.error
									? `${r.cond} ERR ${r.error.slice(0, 80)}`
									: `${r.cond} ${r.pose.yaw.toFixed(2)} ${r.confidence.toFixed(2)}${r.accepted ? "A" : "r"} (${r.horizonOn} h${r.ms.horizon}/${r.ms.total} ms)`,
							)
							.join(" | "),
				);
			}
		}
		fs.writeFileSync(
			path.join(OUT, process.env.ABL_OUT ?? "ablation.json"),
			JSON.stringify(rows, null, 1),
		);
		// tables
		for (const k of ["pin", "gt"]) {
			console.log(
				`\n### vs ${k === "pin" ? "pin GT (11)" : "data/ground-truth.json (12)"}\n| condition | horizon | n | accepts | true acc (<1°) | FALSE acc (≥1°) | ≤1° yaw (any) | med |Δyaw| acc | max |Δyaw| acc |`,
			);
			console.log("|---|---|---|---|---|---|---|---|---|");
			for (const [cond] of CONDS)
				for (const mode of ["cpu", "gpu"]) {
					const rs = rows.filter(
						(r) => r.cond === cond && r.mode === mode && r[`dYaw_${k}`] != null,
					);
					const acc = rs.filter((r) => r.accepted);
					const d = acc.map((r) => Math.abs(r[`dYaw_${k}`]));
					console.log(
						`| ${cond} | ${mode} | ${rs.length} | ${acc.length} | ${d.filter((x) => x < 1).length} | ${d.filter((x) => x >= 1).length} | ${rs.filter((r) => Math.abs(r[`dYaw_${k}`]) < 1).length} | ${q(d, 0.5).toFixed(2)} | ${Math.max(0, ...d).toFixed(2)} |`,
					);
				}
		}
		// per-row CPU vs GPU agreement
		let same = 0;
		let flips = 0;
		let maxDy = 0;
		for (const r of rows.filter((x) => x.mode === "cpu" && x.pose)) {
			const g = rows.find(
				(x) => x.mode === "gpu" && x.id === r.id && x.cond === r.cond && x.pose,
			);
			if (!g) continue;
			if (g.accepted !== r.accepted) {
				flips++;
				console.log(
					`accept flip: ${r.id} ${r.cond} cpu ${r.accepted} ${r.confidence.toFixed(3)} gpu ${g.accepted} ${g.confidence.toFixed(3)}`,
				);
			}
			const dy = Math.abs(dang(g.pose.yaw, r.pose.yaw));
			if (dy < 1e-6 && g.accepted === r.accepted) same++;
			if (g.accepted && r.accepted) maxDy = Math.max(maxDy, dy);
		}
		console.log(
			`\nCPU vs GPU horizon: identical yaw+accept ${same}, accept flips ${flips}, max |Δyaw| between accepted pairs ${maxDy.toFixed(4)}°`,
		);
	}
} finally {
	await browser.close();
}
