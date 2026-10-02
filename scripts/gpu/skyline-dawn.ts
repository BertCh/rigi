// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The GPU skyline cost images (src/lib/gpu/skyline) against the CPU detector (src/lib/geo/skyline.ts)
// in node, on a native WebGPU device (Dawn, the `webgpu` npm package; not an app dependency):
//   (mkdir /tmp/dawn && cd /tmp/dawn && npm i webgpu@0.3.0)
//   DAWN_DIR=/tmp/dawn npx tsx scripts/gpu/skyline-dawn.ts --set gt12|wild [--ids a,b] [--width 800] [--out f.json]
// Per photo: (1) the feature images and the heuristic prior, GPU vs CPU (max / mean abs difference);
// (2) modelSky for the SAME fitted model on both sides; (3) the full detector: row / weight differences of
// detectSkylineGpu vs detectSkyline (columns where finiteness differs, max and median |d row|, max |d weight|).
// --set wild is the dev half of tools/bench/split.json only (photos() of the unknown-pose gate).
// Exit 2 when no adapter / package is available.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Device } from "@luma.gl/core";
import {
	computeFeatures,
	detectSkyline,
	fitSkyModel,
	heuristicSky,
	modelSky,
} from "../../src/lib/geo/skyline";
import { adoptRenderDevice } from "../../src/lib/gpu/device";
import { detectSkylineGpu, openSkylineGpu } from "../../src/lib/gpu/skyline";
import { loadRGBA } from "../lib/node-io";
import { photos } from "./unknown-gpu-gate.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const argv = process.argv.slice(2);
const opt = (k: string, d: string | null = null) => {
	const i = argv.indexOf(`--${k}`);
	return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};
const width = Number(opt("width", "800"));
const out = opt("out");

async function dawnDevice(): Promise<Device | null> {
	const dir = process.env.DAWN_DIR;
	if (!dir) return null;
	const { create, globals } = await import(
		pathToFileURL(path.join(dir, "node_modules/webgpu/index.js")).href
	);
	Object.assign(globalThis, globals);
	Object.defineProperty(globalThis, "navigator", {
		value: { gpu: create([]), userAgent: "node" },
		configurable: true,
	});
	const { luma } = await import("@luma.gl/core");
	const { webgpuAdapter } = await import("@luma.gl/webgpu");
	return luma.createDevice({
		type: "webgpu",
		adapters: [webgpuAdapter],
		createCanvasContext: false,
	} as never);
}

function photoFile(id: string) {
	for (const f of [
		path.join(ROOT, "public/photos", `${id}.jpg`),
		path.join(ROOT, "tools/bench/data/photos", `${id}.jpg`),
	])
		if (fs.existsSync(f)) return f;
	return null;
}

const diff = (a: ArrayLike<number>, b: ArrayLike<number>) => {
	let max = 0;
	let sum = 0;
	for (let i = 0; i < a.length; i++) {
		const d = Math.abs(a[i] - b[i]);
		if (d > max) max = d;
		sum += d;
	}
	return { max, mean: sum / a.length };
};

function rowStats(
	c: { rows: Float32Array; weight: Float32Array },
	g: { rows: Float32Array; weight: Float32Array },
) {
	let finiteMismatch = 0;
	let both = 0;
	let maxRow = 0;
	let maxWeight = 0;
	const dr: number[] = [];
	for (let x = 0; x < c.rows.length; x++) {
		const fc = Number.isFinite(c.rows[x]);
		const fg = Number.isFinite(g.rows[x]);
		if (fc !== fg) finiteMismatch++;
		maxWeight = Math.max(maxWeight, Math.abs(c.weight[x] - g.weight[x]));
		if (fc && fg) {
			both++;
			const d = Math.abs(c.rows[x] - g.rows[x]);
			dr.push(d);
			maxRow = Math.max(maxRow, d);
		}
	}
	dr.sort((a, b) => a - b);
	return {
		cols: c.rows.length,
		finiteCpu: [...c.rows].filter(Number.isFinite).length,
		finiteMismatch,
		both,
		maxRow,
		medianRow: dr.length ? dr[dr.length >> 1] : 0,
		maxWeight,
	};
}

async function main() {
	const device = await dawnDevice();
	if (!device) {
		console.error(
			"no WebGPU device: set DAWN_DIR to a directory with `npm i webgpu@0.3.0`",
		);
		process.exit(2);
	}
	adoptRenderDevice(device);
	const list = photos() as { id: string }[];
	const rows: Record<string, unknown>[] = [];
	for (const e of list) {
		const file = photoFile(e.id);
		if (!file) {
			console.error(`${e.id}: no photo file, skipped`);
			continue;
		}
		const img = await loadRGBA(file, width);
		const { width: w, height: h } = img;
		const n = w * h;
		const t0 = performance.now();
		const cpu = detectSkyline(img);
		const tCpu = performance.now() - t0;
		const t1 = performance.now();
		const gpu = await detectSkylineGpu(img);
		const tGpu = performance.now() - t1;
		if (!gpu) throw new Error("no compute device");
		// cost images, same input
		const f = computeFeatures(img);
		const prior = heuristicSky(f, n);
		const session = await openSkylineGpu(device, img);
		const { f: fg, prior: pg } = await session.stages.features(img);
		const feat = {
			rgb: diff([...f.r, ...f.g, ...f.b], [...fg.r, ...fg.g, ...fg.b]),
			tex: diff(f.tex, fg.tex),
			edge: diff(f.edge, fg.edge),
			step: diff(f.step, fg.step),
			prior: diff(prior, pg),
		};
		const model = fitSkyModel(
			f,
			w,
			h,
			(_x, y, i) => prior[i] * (1 - y / h) ** 6,
		);
		let skyDiff = null;
		if (model) {
			const sc = modelSky(f, w, h, model);
			const sg = await session.stages.modelSky(model);
			skyDiff = diff(sc, sg);
		}
		session.dispose();
		const stats = rowStats(cpu, gpu);
		const rec = {
			id: e.id,
			w,
			h,
			ms: { cpu: Math.round(tCpu), gpu: Math.round(tGpu) },
			feat,
			skyDiff,
			...stats,
		};
		rows.push(rec);
		console.log(
			`${e.id} ${w}x${h} feat max rgb ${feat.rgb.max.toExponential(1)} tex ${feat.tex.max.toExponential(1)} edge ${feat.edge.max.toExponential(1)} prior ${feat.prior.max.toExponential(1)} sky ${skyDiff?.max.toExponential(1)} | rows finite ${stats.finiteCpu}/${stats.cols} mismatch ${stats.finiteMismatch} max ${stats.maxRow.toExponential(2)} med ${stats.medianRow.toExponential(2)} dW ${stats.maxWeight.toExponential(2)} | ${rec.ms.cpu}/${rec.ms.gpu} ms`,
		);
	}
	if (out) {
		fs.mkdirSync(path.dirname(path.resolve(ROOT, out)), { recursive: true });
		fs.writeFileSync(path.resolve(ROOT, out), JSON.stringify(rows, null, 1));
	}
	device.destroy();
	process.exit(0);
}
await main();
