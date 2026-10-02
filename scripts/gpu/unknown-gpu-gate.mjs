#!/usr/bin/env node
// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Quality gate for the GPU arm (?gpu=on vs ?gpu=off) of (the unknown-pose 360° horizon on the GPU, gpu/horizon/scene-profile.ts
// and the fused horizon → solve chain, gpu/solve/fused.ts) against the CPU sceneHorizon, through the real
// unknown-pose worker (UnknownPoseSolver, src/lib/integration/unknown-pose.ts) in headless Chromium.
// The GPU horizon is not bit-identical to the CPU's (f32 march), so the gate is quality, not identity:
// candidate vs base, with the base run twice to measure its own run-to-run noise.
//
//   run one arm (one render-lock step each):
//     node scripts/gpu/with-render-lock.mjs -- node scripts/gpu/unknown-gpu-gate.mjs run
//         --set gt12|wild --unknown-gpu on|off --out out/gpu/unknown-gate/<set>-<arm>.json [--url URL] [--ids a,b]
//   or the same arm in node, no browser (scripts/gpu/unknown-gpu-node.ts: the worker's own scene + solve code on
//   a Dawn WebGPU device; same rows, so compare reads either):
//     DAWN_DIR=… npx tsx scripts/gpu/unknown-gpu-node.ts --set gt12|wild --unknown-gpu on|off --out …
//   compare arms:
//     node scripts/gpu/unknown-gpu-gate.mjs compare --set gt12|wild --base a.json,b.json --cand c.json[,d.json]
//
// Sets:
//   gt12  tools/bench/harness/out/ablation/manifest.json (the 12 bundled photos with data/ground-truth.json
//         GT and pins), five conditions as scripts/gpu/unknown-horizon.mjs: full, nogravity, noheading,
//         none, none+nofocal. Scoring as reports/bench-ablation.md: accepted at |Δyaw GT| < 1° = true accept,
//         ≥ 1° = FALSE accept.
//   wild  the FROZEN dev split (tools/bench/split.json "dev", read only) ∩ the wild manifest, photos without
//         a heading (17), in their own condition: yaw and gravity unknown, focal as the harness derives it
//         (tools/bench/harness/run.ts condPrior). Photos must be served at /photos/<id>.jpg. Accepted poses
//         are checked against the blind-verified v2 clusters (tools/bench/harness/out/runs/wild/verify_v2/
//         key_v2.json + tools/bench/score/wild_scores_v2.json): within 1° yaw / 1° pitch / 10% vfov of a
//         cluster = that cluster's verdict, else "unverified" (a new accept with no verdict counts as a
//         potential false accept under the frozen 0-false-accept rule).
// The rule: cand passes when it has no false or unverified accept that base lacks, no fewer true accepts
// than base's worse run, and its pose changes vs base stay within base-vs-base noise or 0.1° yaw.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const argv = process.argv.slice(2);
const mode = argv[0];
const opt = (k, d = null) => {
	const i = argv.indexOf(`--${k}`);
	return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};
const set = opt("set", "gt12");
const dang = (a, b) => ((((a - b) % 360) + 540) % 360) - 180;
const readJson = (p) =>
	JSON.parse(fs.readFileSync(path.resolve(ROOT, p), "utf8"));

const GT12_CONDS = [
	["full", { yaw: false, gravity: false, focal: false }],
	["nogravity", { yaw: false, gravity: true, focal: false }],
	["noheading", { yaw: true, gravity: false, focal: false }],
	["none", { yaw: true, gravity: true, focal: false }],
	["none+nofocal", { yaw: true, gravity: true, focal: true }],
];

/** Photos, each with its conditions: [{id, photo meta, gt?, conds: [[name, unknown, prior]]}]. */
export function photos() {
	const ids = opt("ids")?.split(",");
	if (set === "gt12") {
		const m = readJson("tools/bench/harness/out/ablation/manifest.json");
		return m
			.filter((e) => !ids || ids.includes(e.id))
			.map((e) => ({
				id: e.id,
				lat: e.lat,
				lon: e.lon,
				alt: e.altitudeM ?? null,
				hAccuracy: e.gpsErrorM ?? null,
				gt: e.gt ?? null,
				gtPin: e.gtPin ?? null,
				conds: GT12_CONDS.map(([c, u]) => [
					c,
					u,
					{
						yaw: u.yaw ? 0 : e.headingDeg,
						pitch: u.gravity ? 0 : e.pitchDeg,
						roll: u.gravity ? 0 : e.rollDeg,
						vfov: e.vfovDeg,
					},
				]),
			}));
	}
	const raw = readJson("tools/bench/data/manifest.json");
	const entries = Array.isArray(raw) ? raw : raw.photos;
	const dev = new Set(readJson("tools/bench/split.json").dev);
	return entries
		.filter((e) => dev.has(e.id) && e.headingDeg == null)
		.filter((e) => !ids || ids.includes(e.id))
		.map((e) => {
			const W = e.width;
			const H = e.height;
			const vH = (h) =>
				(2 * Math.atan((Math.tan((h * Math.PI) / 360) * H) / W) * 180) /
				Math.PI;
			let vfov;
			let focal = false;
			if (e.vfovDeg) vfov = e.vfovDeg;
			else if (e.hfovDeg) vfov = vH(e.hfovDeg);
			else if (e.focal35mm) {
				// as tools/bench/harness/run.ts (src/lib/upload/exif.ts vfovFromF35)
				const fPx = (e.focal35mm * Math.hypot(W, H)) / 43.2666;
				vfov = (2 * Math.atan(H / 2 / fPx) * 180) / Math.PI;
			} else {
				vfov = vH(50);
				focal = true;
			}
			return {
				id: e.id,
				lat: e.lat,
				lon: e.lon,
				alt: e.altitudeM ?? null,
				hAccuracy: e.gpsErrorM ?? null,
				conds: [
					[
						"given",
						{ yaw: true, gravity: true, focal },
						{ yaw: 0, pitch: 0, roll: 0, vfov },
					],
				],
			};
		});
}

async function run() {
	const { chromium } = await import("playwright");
	const { GPU_ARGS } = await import("../deck-webgpu/gpu-args.mjs");
	const base = opt("url", process.env.APP_URL ?? "http://localhost:3100");
	const gpu = opt("unknown-gpu", "off");
	const out = path.resolve(
		ROOT,
		opt("out", `out/gpu/unknown-gate/${set}-${gpu}.json`),
	);
	const list = photos();
	const browser = await chromium.launch({ headless: true, args: GPU_ARGS });
	const rows = [];
	try {
		const ctx = await browser.newContext();
		await ctx.routeWebSocket(
			(u) => u.origin === new URL(base).origin.replace(/^http/, "ws"),
			() => {},
		);
		const page = await ctx.newPage();
		page.on("console", (m) => {
			if (m.type() === "error" || m.type() === "warning")
				console.error(`[page ${m.type()}]`, m.text().slice(0, 300));
		});
		page.on("pageerror", (e) => console.error("[pageerror]", e.message));
		await page.goto(`${base}/favicon.svg?gpu=${gpu}`);
		for (const e of list) {
			const t0 = Date.now();
			const res = await page.evaluate(
				async ({ e }) => {
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
						alt: e.alt,
						hAccuracy: e.hAccuracy,
						width: img.naturalWidth,
						height: img.naturalHeight,
					};
					const s = new m.UnknownPoseSolver(photo);
					const out = [];
					try {
						for (const [cond, u, prior] of e.conds) {
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
									candidates: r.candidates.map((c) => ({
										pose: c.pose,
										confidence: c.confidence,
										accepted: c.accepted,
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
				{ e },
			);
			for (const r of res) rows.push({ id: e.id, unknownGpu: gpu, ...r });
			console.error(
				`${gpu} ${e.id} [${((Date.now() - t0) / 1000).toFixed(0)} s]: ${res
					.map((r) =>
						r.error
							? `${r.cond} ERR ${r.error.slice(0, 80)}`
							: `${r.cond} ${r.pose.yaw.toFixed(2)} ${r.confidence.toFixed(2)}${r.accepted ? "A" : "r"} (${r.horizonOn} h${r.ms.horizon}/${r.ms.total} ms)`,
					)
					.join(" | ")}`,
			);
		}
	} finally {
		await browser.close();
	}
	fs.mkdirSync(path.dirname(out), { recursive: true });
	fs.writeFileSync(
		out,
		JSON.stringify({ set, unknownGpu: gpu, rows }, null, 1),
	);
	console.error(`wrote ${out}`);
}

// ---------- scoring ----------

/** Wild: the verified v2 clusters per photo, [{pose, verdict}]. */
function wildClusters() {
	const key = readJson(
		"tools/bench/harness/out/runs/wild/verify_v2/key_v2.json",
	);
	const scores = readJson("tools/bench/score/wild_scores_v2.json").rows;
	const out = new Map();
	for (const s of scores) {
		const k = key[s.id];
		if (!k) continue;
		const verdictOf = {};
		for (const m of Object.values(s.methods ?? {}))
			if (m?.cluster) verdictOf[m.cluster] = m.verdict;
		out.set(
			s.id,
			Object.entries(k.clusters ?? {}).map(([c, v]) => ({
				cluster: c,
				pose: v.pose,
				verdict: verdictOf[c] ?? "unjudged",
			})),
		);
	}
	return out;
}

let clusters;
/** "true" | "false" | "unverified" for an accepted row (null: not accepted / error). */
function judge(row, photo) {
	if (row.error || !row.accepted) return null;
	if (set === "gt12") {
		const g = photo.gt ?? photo.gtPin;
		if (!g) return "unverified";
		return Math.abs(dang(row.pose.yaw, g.yaw)) < 1 ? "true" : "false";
	}
	clusters ??= wildClusters();
	const p = row.pose;
	const hit = (clusters.get(row.id) ?? []).find(
		(c) =>
			Math.abs(dang(p.yaw, c.pose.yaw)) <= 1 &&
			Math.abs(p.pitch - c.pose.pitch) <= 1 &&
			Math.abs(p.vfov - c.pose.vfov) <= 0.1 * c.pose.vfov,
	);
	if (!hit) return "unverified";
	return hit.verdict === "correct"
		? "true"
		: hit.verdict === "wrong"
			? "false"
			: "unverified";
}

function compare() {
	const load = (f) => readJson(f).rows;
	const bases = opt("base").split(",").map(load);
	const cands = opt("cand").split(",").map(load);
	const meta = new Map(photos().map((p) => [p.id, p]));
	const key = (r) => `${r.id}|${r.cond}`;
	const index = (rows) => new Map(rows.map((r) => [key(r), r]));
	const B = bases.map(index);
	const C = cands.map(index);
	const keys = [...B[0].keys()];
	const tally = (I) => {
		const t = { accepts: 0, true: 0, false: 0, unverified: 0, errors: 0 };
		for (const k of keys) {
			const r = I.get(k);
			if (!r || r.error) {
				t.errors++;
				continue;
			}
			const j = judge(r, meta.get(r.id));
			if (j) {
				t.accepts++;
				t[j]++;
			}
		}
		return t;
	};
	const poseDelta = (a, b) =>
		a && b && !a.error && !b.error
			? {
					yaw: Math.abs(dang(a.pose.yaw, b.pose.yaw)),
					pitch: Math.abs(a.pose.pitch - b.pose.pitch),
					vfov: Math.abs(a.pose.vfov - b.pose.vfov),
					conf: Math.abs(a.confidence - b.confidence),
				}
			: null;
	const rows = [];
	for (const k of keys) {
		const b = B.map((I) => I.get(k));
		const c = C.map((I) => I.get(k));
		const bj = b.map((r) => r && judge(r, meta.get(r.id)));
		const cj = c.map((r) => r && judge(r, meta.get(r.id)));
		const baseNoise = B.length > 1 ? poseDelta(b[0], b[1]) : null;
		const candVsBase = poseDelta(b[0], c[0]);
		const row = {
			key: k,
			base: b.map((r) => (r?.error ? "err" : r?.accepted ? "A" : "r")),
			cand: c.map((r) => (r?.error ? "err" : r?.accepted ? "A" : "r")),
			baseJudge: bj,
			candJudge: cj,
			baseNoise,
			candVsBase,
			horizonOn: c.map((r) => r?.horizonOn),
			msHorizon: {
				base: b.map((r) => r?.ms?.horizon),
				cand: c.map((r) => r?.ms?.horizon),
			},
			issues: [],
		};
		for (const j of cj)
			if ((j === "false" || j === "unverified") && !bj.includes(j))
				row.issues.push(`NEW ${j} accept`);
		if (cj.some((j) => j === null) && bj.every((j) => j === "true"))
			row.issues.push("lost a true accept");
		const noiseYaw = baseNoise?.yaw ?? 0;
		if (candVsBase && candVsBase.yaw > Math.max(noiseYaw, 0.1))
			row.issues.push(
				`yaw moved ${candVsBase.yaw.toFixed(3)}° (base noise ${noiseYaw.toFixed(3)}°)`,
			);
		rows.push(row);
	}
	const med = (xs) => {
		const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
		return s.length ? s[s.length >> 1] : null;
	};
	const firstMs = (I) =>
		med(
			[...new Set(keys.map((k) => k.split("|")[0]))].map(
				(id) =>
					I.get(`${id}|${set === "gt12" ? "full" : "given"}`)?.ms?.horizon,
			),
		);
	const summary = {
		set,
		rows: keys.length,
		base: B.map(tally),
		cand: C.map(tally),
		candHorizonOn: C.map((I) =>
			[...I.values()].reduce((m, r) => {
				const k = r.horizonOn ?? "err";
				m[k] = (m[k] ?? 0) + 1;
				return m;
			}, {}),
		),
		decisionChanges: {
			baseVsBase:
				B.length > 1
					? keys.filter(
							(k) => !!B[0].get(k)?.accepted !== !!B[1].get(k)?.accepted,
						).length
					: null,
			candVsBase0: keys.filter(
				(k) => !!B[0].get(k)?.accepted !== !!C[0].get(k)?.accepted,
			).length,
		},
		poseChanged: {
			baseVsBase: rows.filter(
				(r) =>
					(r.baseNoise?.yaw ?? 0) > 1e-9 || (r.baseNoise?.pitch ?? 0) > 1e-9,
			).length,
			candVsBase0: rows.filter(
				(r) =>
					(r.candVsBase?.yaw ?? 0) > 1e-9 || (r.candVsBase?.pitch ?? 0) > 1e-9,
			).length,
		},
		maxYawDelta: {
			baseVsBase: Math.max(0, ...rows.map((r) => r.baseNoise?.yaw ?? 0)),
			candVsBase0: Math.max(0, ...rows.map((r) => r.candVsBase?.yaw ?? 0)),
		},
		medianHorizonMsFirstSolve: { base: B.map(firstMs), cand: C.map(firstMs) },
		issues: rows
			.filter((r) => r.issues.length)
			.map((r) => ({
				key: r.key,
				issues: r.issues,
				base: r.base,
				cand: r.cand,
				baseJudge: r.baseJudge,
				candJudge: r.candJudge,
			})),
	};
	const minBaseTrue = Math.min(...summary.base.map((t) => t.true));
	const newBad = rows.filter((r) =>
		r.issues.some((i) => i.startsWith("NEW")),
	).length;
	summary.verdict =
		newBad === 0 && summary.cand.every((t) => t.true >= minBaseTrue)
			? "PASS"
			: "FAIL";
	const out = opt("out");
	if (out)
		fs.writeFileSync(
			path.resolve(ROOT, out),
			JSON.stringify({ summary, rows }, null, 1),
		);
	console.log(JSON.stringify(summary, null, 1));
}

// imported by scripts/gpu/unknown-gpu-node.ts for photos() (same --set / --ids flags): no dispatch then
const isMain =
	process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename;
if (isMain) {
	if (mode === "run") await run();
	else if (mode === "compare") compare();
	else {
		console.error("usage: unknown-gpu-gate.mjs run|compare --set gt12|wild …");
		process.exit(2);
	}
}
