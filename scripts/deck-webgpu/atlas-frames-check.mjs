#!/usr/bin/env node
// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// WAG W2.2 gate: the TextureArrayAtlas (texture-array-atlas.ts; batched-terrain height arrays and
// ImageryArray grow by copyTextureToTexture instead of re-creating + re-uploading) renders the same
// bytes as the code before it. Two runs of this script, one per tree, then a compare:
//   node scripts/gpu/with-render-lock.mjs -- node scripts/deck-webgpu/atlas-frames-check.mjs \
//     --url http://localhost:3131 --photos IMG_7086,IMG_6958,IMG_3304 --save out/atlas/before.json
//   (switch the tree, restart the dev server)
//   … --save out/atlas/after.json
//   node scripts/deck-webgpu/atlas-frames-check.mjs --compare out/atlas/before.json out/atlas/after.json
// A flag A/B on one tree: --query gpu=off on one run (CPU decode and cull; the GPU decode counters are saved).
// Each run walks a fixed pose sequence per photo (/photo/<id>?renderer=webgpu): base, pans that
// stream new tiles and grow the 256² height array (yaw +30/+60/+90/-60), back to base (the tiles
// resident before the grow must survive it), then world mode with the imagery drape (grows the
// imagery array). At every pose, once the tile set is quiet, it hashes (SHA-256, in page) the raw
// bytes of the geometry targets (xyz+range, normal+class) and the resolved colour target, and
// captures each pose twice as a control (the frame must be deterministic for the compare to mean
// anything). The atlas stats (grows, copied layers) are recorded where they exist.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright";
import { GPU_ARGS } from "./gpu-args.mjs";

const arg = (k, d) => {
	const i = process.argv.indexOf(`--${k}`);
	return i > 0 ? process.argv[i + 1] : d;
};

if (process.argv.includes("--compare")) {
	const i = process.argv.indexOf("--compare");
	const [a, b] = [process.argv[i + 1], process.argv[i + 2]].map((f) =>
		JSON.parse(readFileSync(f, "utf8")),
	);
	let diff = 0;
	let same = 0;
	let unstable = 0;
	for (const pa of a) {
		const pb = b.find((x) => x.id === pa.id);
		if (!pb) {
			console.log(`FAIL ${pa.id}: missing in the second run`);
			diff++;
			continue;
		}
		for (const sa of pa.poses) {
			const sb = pb.poses.find((x) => x.name === sa.name);
			if (!sa.stable || !sb?.stable) {
				unstable++;
				console.log(`SKIP ${pa.id} ${sa.name}: not deterministic within a run`);
				continue;
			}
			const keys = ["geo", "nrm", "col"].filter(
				(k) => sa.hash[k] !== sb.hash[k],
			);
			if (keys.length) diff++;
			else same++;
			console.log(
				`${keys.length ? "FAIL" : "PASS"} ${pa.id} ${sa.name.padEnd(9)} tiles ${sa.tiles}/${sb.tiles} imagery ${sa.imageryLayers}/${sb.imageryLayers}${keys.length ? ` differ: ${keys.join(",")}` : ""}`,
			);
		}
		console.log(`  atlas stats (second run): ${JSON.stringify(pb.atlas)}`);
		if (pb.gpuDecode)
			console.log(`  GPU decode (second run): ${JSON.stringify(pb.gpuDecode)}`);
	}
	console.log(
		`\n${diff ? "FAIL" : "PASS"}: ${same} poses byte-identical, ${diff} differ, ${unstable} non-deterministic (skipped)`,
	);
	process.exit(diff || !same ? 1 : 0);
}

const BASE = arg("url", process.env.APP_URL ?? "http://localhost:3131");
/** extra page flags, e.g. --query gpu=off (the same tree, GPU decode off vs on) */
const QUERY = arg("query", "");
const IDS = arg("photos", "IMG_7086,IMG_6958,IMG_3304").split(",");
const SAVE = resolve(arg("save", "out/deck-webgpu/atlas-frames/run.json"));
mkdirSync(dirname(SAVE), { recursive: true });

const INSTALL = () => {
	const w = window;
	const e = w.__engine;
	const readHash = async (tex) => {
		const device = tex.device;
		const layout = tex.computeMemoryLayout();
		const buf = device.createBuffer({
			byteLength: layout.byteLength,
			usage: 0x0001 | 0x0008, // MAP_READ | COPY_DST
		});
		tex.readBuffer({}, buf);
		const bytes = await buf.readAsync(0, layout.byteLength);
		buf.destroy();
		const d = await crypto.subtle.digest("SHA-256", bytes);
		return Array.from(new Uint8Array(d), (x) =>
			x.toString(16).padStart(2, "0"),
		).join("");
	};
	const quiet = async () => {
		let last = null;
		let since = performance.now();
		const t0 = performance.now();
		while (performance.now() - t0 < 90_000) {
			await e.nextFrame("all");
			const set = e.renderSet;
			const im = e.gpu?.imagery?.stats;
			const key = `${set?.tiles?.length}|${set?.stats?.pending ?? 0}|${e.gpu?.terrain?.stats?.tiles}|${im?.uploads}|${im?.layers}`;
			if (key !== last || (set?.stats?.pending ?? 0) > 0) {
				last = key;
				since = performance.now();
			} else if (performance.now() - since > 2000) return true;
			await new Promise((r) => setTimeout(r, 100));
		}
		return false;
	};
	const capture = async () => {
		await e.nextFrame("all");
		await e.nextFrame("all");
		const host = e.hostInstance;
		return {
			geo: await readHash(host.geometry.geometry),
			nrm: await readHash(host.geometry.normal),
			col: await readHash(host.color.color),
		};
	};
	const atlas = () => {
		const st = e.gpu?.terrain?.store;
		const a = (x) => (x?.stats ? { ...x.stats, capacity: x.capacity } : null);
		return {
			small: a(st?.small),
			big: a(st?.big),
			imagery: a(e.gpu?.imagery?.atlas),
		};
	};
	w.__afc = { quiet, capture, atlas };
};

const POSES = [
	["base", {}],
	["yaw+30", { yaw: 30 }],
	["yaw+60", { yaw: 60 }],
	["yaw+90", { yaw: 90 }],
	["yaw-60", { yaw: -60 }],
	["base-again", {}],
];

const POSE = async ({ d }) => {
	const w = window;
	const e = w.__engine;
	const p0 = w.__p0;
	e.setPose({
		...p0,
		yaw: p0.yaw + (d.yaw ?? 0),
		pitch: p0.pitch + (d.pitch ?? 0),
	});
	const isQuiet = await w.__afc.quiet();
	const a = await w.__afc.capture();
	const b = await w.__afc.capture();
	return {
		isQuiet,
		hash: a,
		stable: a.geo === b.geo && a.nrm === b.nrm && a.col === b.col,
		tiles: e.gpu?.terrain?.stats?.tiles,
		imageryLayers: e.gpu?.imagery?.stats?.layers ?? 0,
	};
};

async function runPhoto(browser, id) {
	const page = await browser.newPage({
		viewport: { width: 1400, height: 900 },
	});
	const errors = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await page.addInitScript(() => {
		try {
			localStorage.clear();
		} catch {}
	});
	await page.goto(
		`${BASE}/photo/${id}?renderer=webgpu${QUERY ? `&${QUERY}` : ""}`,
	);
	await page.waitForSelector("[data-ready]", {
		timeout: 240_000,
		state: "attached",
	});
	const engine = await page.evaluate(() => window.__engine?.backend);
	await page.evaluate(INSTALL);
	await page.evaluate(() => {
		window.__p0 = { ...window.__engine.pose };
	});
	const r = { id, engine, errors, poses: [] };
	for (const [name, d] of POSES) {
		const p = await page.evaluate(POSE, { d });
		r.poses.push({ name, ...p });
		console.log(
			`${id} ${name.padEnd(10)} quiet=${p.isQuiet} stable=${p.stable} tiles ${p.tiles} ${p.hash.col.slice(0, 12)}`,
		);
	}
	await page.evaluate(() => window.__engine.setSettings({ mode: "world" }));
	const p = await page.evaluate(POSE, { d: {} });
	r.poses.push({ name: "world", ...p });
	console.log(
		`${id} world      quiet=${p.isQuiet} stable=${p.stable} tiles ${p.tiles} imagery ${p.imageryLayers} ${p.hash.col.slice(0, 12)}`,
	);
	r.atlas = await page.evaluate(() => window.__afc.atlas());
	// GPU terrain decode diagnostics (deck-webgpu/terrain-gpu-decode.ts), when the module is loaded
	r.gpuDecode = await page.evaluate(() =>
		JSON.parse(JSON.stringify(window.__rigiTerrainGpuDecode ?? null)),
	);
	if (r.gpuDecode)
		console.log(`${id} GPU decode ${JSON.stringify(r.gpuDecode)}`);
	await page.close();
	return r;
}

const browser = await chromium.launch({ headless: true, args: GPU_ARGS });
const results = [];
try {
	for (const id of IDS) results.push(await runPhoto(browser, id));
} finally {
	await browser.close();
}
writeFileSync(SAVE, JSON.stringify(results, null, 2));
console.log(SAVE);
