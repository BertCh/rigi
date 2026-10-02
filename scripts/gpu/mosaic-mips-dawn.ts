// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Byte-compares the GPU max-mip pyramid (src/lib/gpu/horizon/mosaic-mips.ts, flag mosaicGpu) with the CPU
// pyramid (horizon-fast buildMips) on a native WebGPU device in node (Dawn), on real DEM mosaics, and checks
// that the horizon march gives identical profiles with the flag on and off.
//
//   (mkdir /tmp/dawn && cd /tmp/dawn && npm i webgpu@0.3.0)   # not an app dependency
//   DAWN_DIR=/tmp/dawn npx tsx scripts/gpu/mosaic-mips-dawn.ts [IMG_xxxx ...] [--no-march]
//
// Real mosaics: the app's LITE_RINGS to 120 km around each ground-truth photo (default: the first 4 of
// data/ground-truth.json), tiles from .cache/dem-mapterhorn. Plus synthetic grids with odd sizes. Exit 2 when
// no Dawn device, 1 on any byte difference.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Device } from "@luma.gl/core";
import { MAPTERHORN } from "../../src/lib/dem";
import { setFlagOverride } from "../../src/lib/flags";
import { REFRACTION_K } from "../../src/lib/geodesy";
import { adoptRenderDevice } from "../../src/lib/gpu/device";
import {
	computeHorizonGpu,
	releaseHorizonGpu,
	uploadMosaics,
} from "../../src/lib/gpu/horizon";
import {
	gridMips,
	LITE_RINGS,
	loadMosaics,
	type Mosaic,
	TileStore,
} from "../../src/lib/horizon-fast/mosaic";
import { demTileLoaderNode, ROOT } from "../lib/node-io";

const dir = process.env.DAWN_DIR;
if (!dir) {
	console.error("set DAWN_DIR to a directory with `npm i webgpu@0.3.0`");
	process.exit(2);
}
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
const device = (await luma.createDevice({
	type: "webgpu",
	adapters: [webgpuAdapter],
	createCanvasContext: false,
} as never)) as Device;
adoptRenderDevice(device);

const args = process.argv.slice(2);
const doMarch = !args.includes("--no-march");
const gt = JSON.parse(
	fs.readFileSync(path.join(ROOT, "data/ground-truth.json"), "utf8"),
) as Record<string, { lat?: number; lon?: number; eye?: number }>;
const ids = args.filter((a) => !a.startsWith("--")).length
	? args.filter((a) => !a.startsWith("--"))
	: Object.keys(gt).slice(0, 4);
const load = demTileLoaderNode(MAPTERHORN);
const store = new TileStore({
	tileSize: MAPTERHORN.tileSize,
	maxZoom: MAPTERHORN.maxZoom,
	load: async (k) => (await load(k)) ?? null,
});

let bad = 0;
let levels = 0;

/** Uploads `mosaics` (no CPU mips) on the GPU and compares every level with the CPU pyramid. */
async function compareMips(label: string, mosaics: Mosaic[]) {
	const reference = mosaics.map((m) => gridMips(m.data, m.width, m.height));
	setFlagOverride("mosaicGpu", "on");
	const set = await uploadMosaics(device, mosaics);
	for (let r = 0; r < mosaics.length; r++) {
		const ring = set.rings[r];
		const page = new Float32Array(
			(await set.pages[ring.page].readAsync()).buffer.slice(0),
		);
		const cpu = reference[r];
		let ringBad = 0;
		for (let i = 0; i < cpu.mips.length; i++) {
			levels++;
			const gpu = page.subarray(
				ring.mipOff[i],
				ring.mipOff[i] + cpu.mips[i].length,
			);
			const same =
				ring.mipWidths[i] === cpu.widths[i] &&
				ring.mipHeights[i] === cpu.heights[i] &&
				Buffer.from(gpu.buffer, gpu.byteOffset, gpu.byteLength).equals(
					Buffer.from(
						cpu.mips[i].buffer,
						cpu.mips[i].byteOffset,
						cpu.mips[i].byteLength,
					),
				);
			if (!same) ringBad++;
		}
		const dataSame = Buffer.from(
			page.buffer,
			ring.dataOff * 4,
			mosaics[r].data.byteLength,
		).equals(
			Buffer.from(
				mosaics[r].data.buffer,
				mosaics[r].data.byteOffset,
				mosaics[r].data.byteLength,
			),
		);
		if (ringBad || !dataSame) bad++;
		console.log(
			`${label} ring ${r} ${mosaics[r].width}x${mosaics[r].height}: ${cpu.mips.length} levels, ${
				ringBad ? `${ringBad} DIFFER` : "identical"
			}${dataSame ? "" : ", DATA DIFFERS"}`,
		);
	}
	releaseHorizonGpu(mosaics);
}

// synthetic grids: odd sizes, edge blocks, negative heights and ties
for (const [w, h] of [
	[259, 131],
	[1024, 768],
	[7, 5],
	[513, 1025],
]) {
	const data = new Float32Array(w * h);
	let s = 12345;
	for (let i = 0; i < data.length; i++) {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		data[i] = (s % 4000) - 500 + (i % 7 === 0 ? 0 : 0.25);
	}
	const m = {
		z: 12,
		tileSize: 512,
		worldPx: 2 ** 21,
		x0: 0,
		y0: 0,
		width: w,
		height: h,
		cellMeters: 10,
		maxDistance: 1000,
		data,
	} as unknown as Mosaic;
	await compareMips(`synthetic ${w}x${h}`, [m]);
}

for (const id of ids) {
	const g = gt[id];
	if (g?.lat == null || g.lon == null || g.eye == null) {
		console.log(`skip ${id}: no lat/lon/eye`);
		continue;
	}
	const t0 = performance.now();
	const opts = { rings: LITE_RINGS, maxDistance: 120_000 };
	const mosaics = await loadMosaics(g.lat, g.lon, store, opts);
	console.log(
		`${id}: ${mosaics.length} rings loaded in ${(performance.now() - t0).toFixed(0)} ms`,
	);
	await compareMips(id, mosaics);
	if (!doMarch) continue;
	// march with the flag on (GPU pyramid) and off (CPU pyramid, a fresh copy of the mosaics)
	const eye = { lat: g.lat, lon: g.lon, h: g.eye };
	const mo = {
		step: 0.05,
		k: REFRACTION_K,
		maxDistance: 120_000,
		minDistance: 2,
		noRidges: true,
	};
	const fresh = await loadMosaics(g.lat, g.lon, store, opts);
	setFlagOverride("mosaicGpu", "on");
	const on = (await computeHorizonGpu(device, fresh, [eye], mo))[0];
	releaseHorizonGpu(fresh);
	const cpuMips = await loadMosaics(g.lat, g.lon, store, {
		...opts,
		mips: true,
	});
	setFlagOverride("mosaicGpu", "off");
	const off = (await computeHorizonGpu(device, cpuMips, [eye], mo))[0];
	releaseHorizonGpu(cpuMips);
	const same =
		Buffer.from(
			on.elevation.buffer,
			on.elevation.byteOffset,
			on.elevation.byteLength,
		).equals(
			Buffer.from(
				off.elevation.buffer,
				off.elevation.byteOffset,
				off.elevation.byteLength,
			),
		) &&
		Buffer.from(
			on.distance.buffer,
			on.distance.byteOffset,
			on.distance.byteLength,
		).equals(
			Buffer.from(
				off.distance.buffer,
				off.distance.byteOffset,
				off.distance.byteLength,
			),
		);
	if (!same) bad++;
	console.log(
		`${id}: march profile flag on vs off: ${same ? "identical" : "DIFFER"}`,
	);
}
console.log(`${levels} mip levels compared, ${bad} mismatching rings/profiles`);
process.exit(bad ? 1 : 0);
