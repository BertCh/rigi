#!/usr/bin/env node
// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Parity of the matcher's offscreen hooks (src/lib/renderer.ts loadFullTerrain / loadSatellite /
// renderPoseView) between the WebGL DeckEngine (?renderer=deck, the reference) and WebGpuEngine
// (?renderer=webgpu). Per photo and engine, one fresh page, the same calls the in-browser
// matcher (src/lib/matcher) makes for a full-terrain render:
//   loadFullTerrain() → loadSatellite(--drape-m, 2) → renderPoseView(prior + yaw offset) per offset,
// then autoAlign(true) on the 360° terrain. Reported per photo:
//   - the full terrain: ms, query tiles, horizon directions and the max |Δ| of the two horizons
//   - per view: terrain/sky mask agreement (IoU, pixels only one engine draws), |Δxyz| over pixels both
//     draw (median, p95, as a fraction of the range too), RGB mean |Δ| and the share of channels > 16
//   - autoAlign on the full terrain: |Δyaw| (deck-engine-smoke tolerance 0.5°), confidences
//   - luma GPU memory (metrics().luma.memory, both engines) on the photo view before, after the full
//     terrain alone, and after the drape + renders; WebGPU: the terrain / imagery overflow counters
// Always under the render lock:
//   node scripts/gpu/with-render-lock.mjs -- node scripts/deck-webgpu/pose-view-parity.mjs
//     [--url http://localhost:3100] [--photos IMG_7155,IMG_6958] [--offsets -20,0,20]
//     [--drape-m 40000] [--out out/deck-webgpu/pose-view-parity] [--renderers deck,webgpu]
// Writes <out>/parity.json and the views (<id>_<engine>_<tag>_sat.jpg). Exit 0 = every view and the
// alignment within the limits below, 3 = some outside, 2 = an engine failed / was not the one asked for.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { GPU_ARGS } from "./gpu-args.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const arg = (k, d) => {
	const i = process.argv.indexOf(`--${k}`);
	return i > 0 ? process.argv[i + 1] : d;
};
const BASE = arg("url", process.env.APP_URL ?? "http://localhost:3100");
const IDS = arg("photos", "IMG_7155,IMG_6958,IMG_7018").split(",");
const OFFSETS = arg("offsets", "-20,0,20").split(",").map(Number);
const DRAPE_M = Number(arg("drape-m", "40000"));
const OUT = resolve(ROOT, arg("out", "out/deck-webgpu/pose-view-parity"));
const RENDERERS = arg("renderers", "deck,webgpu").split(",");
// limits (a view passes when all hold): the geometry must agree (mask, position); the colour is
// reported, with a loose bound (MSAA / filtering / mip differences between the two backends)
const MASK_IOU_MIN = 0.99;
const XYZ_REL_P95_MAX = 0.01;
const RGB_MEAN_MAX = 8;
const YAW_TOL = 0.5;

const angle = (a, b) => ((a - b + 540) % 360) - 180;
const log = (...a) => console.error("[pose-view-parity]", ...a);

async function runEngine(renderer, id) {
	const browser = await chromium.launch({
		headless: true,
		args:
			renderer === "deck"
				? ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu"]
				: GPU_ARGS,
	});
	try {
		const page = await browser.newPage({
			viewport: { width: 1400, height: 900 },
		});
		const errors = [];
		page.on("pageerror", (e) => errors.push(e.message));
		await page.addInitScript(() => localStorage.clear());
		const t0 = Date.now();
		await page.goto(`${BASE}/photo/${id}?renderer=${renderer}`);
		await page.waitForSelector("[data-ready]", {
			state: "attached",
			timeout: 240_000,
		});
		await page.waitForFunction(() => !!window.__engine?.horizonDirs, null, {
			timeout: 120_000,
		});
		const loadMs = Date.now() - t0;
		const r = await page.evaluate(
			async ({ offsets, drapeM }) => {
				const e = window.__engine;
				const mem = () => {
					const m = e.metrics?.()?.luma?.memory;
					if (!m) return null;
					return Object.fromEntries(
						Object.entries(m).map(([k, v]) => [
							k,
							typeof v === "object" && v
								? (v.count ?? v.value ?? v.total ?? null)
								: v,
						]),
					);
				};
				const engine =
					e.backend === "webgpu" ? "webgpu" : (e.kind ?? "unknown");
				const memBefore = mem();
				const tilesBefore = e.terrain?.tiles?.length ?? null;
				const fullMs = await e.loadFullTerrain();
				// let the on-screen frame redraw on the full set before sampling
				await new Promise((res) => setTimeout(res, 1000));
				const memFull = mem();
				const sat = await e.loadSatellite(drapeM, 2);
				const prior = { ...e.prior };
				const enc = (u8) => {
					let bin = "";
					for (let i = 0; i < u8.length; i += 0x8000)
						bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
					return btoa(bin);
				};
				const views = [];
				for (const d of offsets) {
					const pose = { ...prior, yaw: prior.yaw + d };
					const t = performance.now();
					const v = await e.renderPoseView(pose);
					const ms = performance.now() - t;
					if (!v) {
						views.push({ d, error: "renderPoseView returned null" });
						continue;
					}
					const cv = document.createElement("canvas");
					cv.width = v.width;
					cv.height = v.height;
					cv.getContext("2d").putImageData(
						new ImageData(v.rgba, v.width, v.height),
						0,
						0,
					);
					views.push({
						d,
						ms,
						W: v.width,
						H: v.height,
						xyz: enc(new Uint8Array(v.xyz.buffer)),
						rgba: enc(new Uint8Array(v.rgba.buffer)),
						jpg: cv.toDataURL("image/jpeg", 0.92),
					});
				}
				const memAfter = mem();
				const t = performance.now();
				const res = await e.autoAlign(true);
				const alignMs = performance.now() - t;
				const P = (p) =>
					p ? { yaw: p.yaw, pitch: p.pitch, roll: p.roll, vfov: p.vfov } : null;
				const st = e.backend === "webgpu" ? e.stats : null;
				const met = e.backend === "webgpu" ? e.metrics?.() : null;
				return {
					engine,
					dataRenderer:
						document
							.querySelector("[data-renderer]")
							?.getAttribute("data-renderer") ?? null,
					prior: P(prior),
					eye: [e.eye.x, e.eye.y, e.eye.z],
					fullMs,
					sat,
					tilesBefore,
					tilesFull: e.terrain?.tiles?.length ?? null,
					horizon: enc(new Uint8Array(e.horizonDirs.buffer)),
					views,
					align: {
						ms: alignMs,
						pose: P(res?.pose),
						score: res?.score ?? null,
						confidence: res?.confidence ?? null,
					},
					memBefore,
					memFull,
					memAfter,
					webgpu: st
						? {
								terrainTiles: st.terrainTiles,
								horizonSource: st.horizonSource,
								terrain: met?.terrain ?? null,
								imagery: met?.imagery ?? null,
							}
						: null,
				};
			},
			{ offsets: OFFSETS, drapeM: DRAPE_M },
		);
		return { loadMs, errors, ...r };
	} finally {
		await browser.close().catch(() => {});
	}
}

const f32 = (b64) => {
	const b = Buffer.from(b64, "base64");
	return new Float32Array(b.buffer, b.byteOffset, b.length / 4);
};
const quant = (a, q) => {
	if (!a.length) return null;
	const s = Float64Array.from(a).sort();
	return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

function compareViews(a, b, eye) {
	const xa = f32(a.xyz);
	const xb = f32(b.xyz);
	const ra = Buffer.from(a.rgba, "base64");
	const rb = Buffer.from(b.rgba, "base64");
	const n = a.W * a.H;
	let both = 0;
	let onlyA = 0;
	let onlyB = 0;
	const dist = [];
	const rel = [];
	let rgbSum = 0;
	let rgbBig = 0;
	for (let i = 0; i < n; i++) {
		const ta = xa[i * 3] !== 0 || xa[i * 3 + 1] !== 0 || xa[i * 3 + 2] !== 0;
		const tb = xb[i * 3] !== 0 || xb[i * 3 + 1] !== 0 || xb[i * 3 + 2] !== 0;
		if (ta && tb) {
			both++;
			const d = Math.hypot(
				xa[i * 3] - xb[i * 3],
				xa[i * 3 + 1] - xb[i * 3 + 1],
				xa[i * 3 + 2] - xb[i * 3 + 2],
			);
			const r = Math.hypot(
				xa[i * 3] - eye[0],
				xa[i * 3 + 1] - eye[1],
				xa[i * 3 + 2] - eye[2],
			);
			dist.push(d);
			rel.push(d / Math.max(r, 1));
		} else if (ta) onlyA++;
		else if (tb) onlyB++;
		for (let k = 0; k < 3; k++) {
			const d = Math.abs(ra[i * 4 + k] - rb[i * 4 + k]);
			rgbSum += d;
			if (d > 16) rgbBig++;
		}
	}
	const union = both + onlyA + onlyB;
	return {
		W: a.W,
		H: a.H,
		terrainPx: { both, onlyDeck: onlyA, onlyWebgpu: onlyB },
		maskIoU: union ? both / union : 1,
		xyzM: { median: quant(dist, 0.5), p95: quant(dist, 0.95) },
		xyzRel: { median: quant(rel, 0.5), p95: quant(rel, 0.95) },
		rgb: { meanAbs: rgbSum / (n * 3), over16: rgbBig / (n * 3) },
	};
}

mkdirSync(OUT, { recursive: true });
const rows = [];
let worst = 0;
for (const id of IDS) {
	const runs = {};
	for (const renderer of RENDERERS) {
		log(`${id} ${renderer}…`);
		try {
			const r = await runEngine(renderer, id);
			if (r.engine !== renderer)
				throw new Error(`asked for ${renderer}, ran ${r.engine}`);
			for (const v of r.views)
				if (v.jpg)
					writeFileSync(
						join(
							OUT,
							`${id}_${renderer}_y${v.d >= 0 ? "+" : ""}${v.d}_sat.jpg`,
						),
						Buffer.from(v.jpg.split(",")[1], "base64"),
					);
			runs[renderer] = r;
			log(
				`${id} ${renderer}: load ${r.loadMs} ms, full terrain ${r.fullMs} ms (${r.tilesBefore} → ${r.tilesFull} tiles), align yaw ${r.align.pose?.yaw?.toFixed(3)}`,
			);
		} catch (e) {
			log(`${id} ${renderer} failed: ${e.message}`);
			runs[renderer] = { error: String(e.message ?? e) };
			worst = Math.max(worst, 2);
		}
	}
	const a = runs.deck;
	const b = runs.webgpu;
	const row = {
		id,
		engines: Object.fromEntries(
			Object.entries(runs).map(([k, r]) => [
				k,
				r.error
					? r
					: {
							loadMs: r.loadMs,
							fullMs: r.fullMs,
							sat: r.sat,
							tilesBefore: r.tilesBefore,
							tilesFull: r.tilesFull,
							horizonDirs: f32(r.horizon).length / 3,
							viewMs: r.views.map((v) => v.ms ?? null),
							align: r.align,
							memBefore: r.memBefore,
							memFull: r.memFull,
							memAfter: r.memAfter,
							webgpu: r.webgpu,
							errors: r.errors,
						},
			]),
		),
	};
	if (a && b && !a.error && !b.error) {
		const ha = f32(a.horizon);
		const hb = f32(b.horizon);
		let hMax = 0;
		if (ha.length === hb.length)
			for (let i = 0; i < ha.length; i++)
				hMax = Math.max(hMax, Math.abs(ha[i] - hb[i]));
		row.horizon = {
			deck: ha.length / 3,
			webgpu: hb.length / 3,
			maxAbsDiff: ha.length === hb.length ? hMax : null,
		};
		row.views = a.views.map((va, i) => {
			const vb = b.views[i];
			if (!va.xyz || !vb?.xyz)
				return { d: va.d, error: va.error ?? vb?.error ?? "missing" };
			const c = compareViews(va, vb, a.eye);
			c.d = va.d;
			c.pass =
				c.maskIoU >= MASK_IOU_MIN &&
				(c.xyzRel.p95 ?? 0) <= XYZ_REL_P95_MAX &&
				c.rgb.meanAbs <= RGB_MEAN_MAX;
			return c;
		});
		const dy =
			a.align.pose && b.align.pose
				? Math.abs(angle(a.align.pose.yaw, b.align.pose.yaw))
				: null;
		row.align = {
			dYaw: dy,
			dPitch:
				a.align.pose && b.align.pose
					? Math.abs(a.align.pose.pitch - b.align.pose.pitch)
					: null,
			pass: dy != null && dy <= YAW_TOL,
		};
		row.pass = row.align.pass && row.views.every((v) => v.pass);
		if (!row.pass) worst = Math.max(worst, 3);
	}
	rows.push(row);
	log(JSON.stringify({ id, horizon: row.horizon, align: row.align }));
	for (const v of row.views ?? [])
		log(
			`  y${v.d}: IoU ${v.maskIoU?.toFixed(5)} xyz p50/p95 ${v.xyzM?.median?.toFixed(3)}/${v.xyzM?.p95?.toFixed(3)} m rel p95 ${v.xyzRel?.p95?.toExponential(2)} rgb ${v.rgb?.meanAbs?.toFixed(2)} (>16: ${((v.rgb?.over16 ?? 0) * 100).toFixed(2)}%) ${v.pass ? "PASS" : "FAIL"}`,
		);
}
writeFileSync(
	join(OUT, "parity.json"),
	JSON.stringify(
		{
			base: BASE,
			offsets: OFFSETS,
			drapeM: DRAPE_M,
			limits: {
				MASK_IOU_MIN,
				XYZ_REL_P95_MAX,
				RGB_MEAN_MAX,
				YAW_TOL,
			},
			rows,
		},
		null,
		1,
	),
);
log(`wrote ${join(OUT, "parity.json")}`);
process.exit(worst);
