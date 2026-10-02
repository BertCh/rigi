// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The Terrarium tile kernel + its GPUReduction statistics (src/lib/gpu/ingest/terrarium-tile.ts
// addTerrariumTile) on a real luma WebGPU device in node (Dawn). An rgba8unorm texture is written
// directly (no ImageBitmap in node) from synthetic Terrarium tiles (random terrain, below-sea
// values, a constant tile, NO_DATA / out-of-range samples), sizes 256 and 512, down 1 and 2. The
// heights, the invalid count and lo / hi / lo7 / hi7 are compared with the CPU twin
// (decodeTerrarium, validateTile's fill count, downsampleHeights2, heightStats): heights bit for bit,
// invalid exactly, the extents exactly up to the sign of zero. Prints max / mean abs error, the
// NaN / Inf count and the warm wall time. Uses only the public addTerrariumTile / decodeTileStats
// API, so it also runs against a tree with the old atomic-stats kernel.
//   DAWN_DIR=/path/with/webgpu@0.3.0 npx tsx scripts/gpu/terrarium-stats-dawn.ts
// Prints SKIP and exits 0 when DAWN_DIR is unset; exit 1 on any mismatch.
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Device } from "@luma.gl/core";
import { heightStats } from "../../src/lib/dem/cpu-heights";
import { decodeTerrarium, validateTile } from "../../src/lib/dem/decode";
import { downsampleHeights2 } from "../../src/lib/dem/grid";
import { ComputeGraph } from "../../src/lib/gpu/core/graph";
import { terrariumInputDescriptor } from "../../src/lib/gpu/ingest/terrarium";
import { decodeTileStats } from "../../src/lib/gpu/ingest/terrarium-f32";
import {
	addTerrariumTile,
	TILE_STATS_WORDS,
} from "../../src/lib/gpu/ingest/terrarium-tile";
import {
	BITMAP_TEXTURE_USAGE,
	releaseResource,
	uploadRaster,
} from "../../src/lib/gpu/ingest/upload";

const ID = "terrarium-stats-dawn";
const dir = process.env.DAWN_DIR;
if (!dir) {
	console.log(`SKIP ${ID}: DAWN_DIR not set`);
	process.exit(0);
}
const { create, globals } = await import(
	pathToFileURL(path.join(dir, "node_modules/webgpu/index.js")).href
);
Object.assign(globalThis, globals);
// keep the instance referenced: Dawn drops pipelines of a collected instance
const gpu = create([]);
Object.defineProperty(globalThis, "navigator", {
	value: { gpu, userAgent: "node" },
	configurable: true,
});
const { luma } = await import("@luma.gl/core");
const { webgpuAdapter } = await import("@luma.gl/webgpu");
const device = (await luma.createDevice({
	type: "webgpu",
	adapters: [webgpuAdapter],
	createCanvasContext: false,
} as never)) as Device;

let seed = 20261002;
const rand = () => {
	seed = (seed * 1664525 + 1013904223) >>> 0;
	return seed / 2 ** 32;
};

/** Terrarium bytes of height `h` (metres), quantised to 1/256. */
const putHeight = (rgba: Uint8Array, i: number, h: number) => {
	const n = Math.min(0xffffff, Math.max(0, Math.round((h + 32768) * 256)));
	rgba[i * 4] = n >> 16;
	rgba[i * 4 + 1] = (n >> 8) & 255;
	rgba[i * 4 + 2] = n & 255;
	rgba[i * 4 + 3] = 255;
};

type Tile = { name: string; S: number; rgba: Uint8Array };
const makeTile = (
	name: string,
	S: number,
	fn: (x: number, y: number) => number,
): Tile => {
	const rgba = new Uint8Array(S * S * 4);
	for (let y = 0; y < S; y++)
		for (let x = 0; x < S; x++) putHeight(rgba, y * S + x, fn(x, y));
	return { name, S, rgba };
};
const terrain = (S: number, amp: number, base: number) => {
	const ph = [rand() * 6, rand() * 6, rand() * 6];
	return (x: number, y: number) =>
		base +
		amp * Math.sin(x / (S / 7) + ph[0]) * Math.cos(y / (S / 5) + ph[1]) +
		(amp / 6) * Math.sin((x + y) / 9 + ph[2]) +
		rand() * 3;
};

const tiles: Tile[] = [];
for (const S of [256, 512]) {
	tiles.push(makeTile(`alps-${S}`, S, terrain(S, 1800, 2200)));
	tiles.push(makeTile(`below-sea-${S}`, S, terrain(S, 300, -200)));
	tiles.push(makeTile(`lake-depress-${S}`, S, terrain(S, 400, -800)));
	tiles.push(makeTile(`flat-${S}`, S, () => 431.5));
	tiles.push(makeTile(`zero-${S}`, S, () => 0));
	const t = makeTile(`holes-${S}`, S, terrain(S, 900, 1200));
	for (let k = 0; k < 40; k++) {
		const i = Math.floor(rand() * S * S);
		putHeight(t.rgba, i, [-32768, -20000, 9500, 20000, 30000][k % 5]);
	}
	tiles.push(t);
	const t1 = makeTile(`one-hole-${S}`, S, terrain(S, 900, 1200));
	putHeight(t1.rgba, S * S - 1, -32768);
	tiles.push(t1);
	// the lone extremes sit on stride-7 and off-stride texels
	const t2 = makeTile(`peak-offstride-${S}`, S, () => 100);
	putHeight(t2.rgba, 3, 8800);
	putHeight(t2.rgba, 7, -900);
	tiles.push(t2);
	tiles.push(
		makeTile(`at-bounds-${S}`, S, (x, y) =>
			(x + y) % 4 === 0 ? -999.99609375 : 8999.99609375,
		),
	);
}

const bits = (a: Float32Array) =>
	new Uint32Array(a.buffer, a.byteOffset, a.length);
let failures = 0;
const fail = (m: string) => {
	failures++;
	console.log(`FAIL ${m}`);
};
let maxErr = 0;
let sumErr = 0;
let errCount = 0;
let nonFinite = 0;
let invalidMismatch = 0;
let heightMismatch = 0;
let extentMismatch = 0;
const times: number[] = [];
let cases = 0;

const graphs = new Map<string, ComputeGraph<undefined>>();
const buildGraph = (S: number, down: 1 | 2) => {
	const key = `${S}/${down}`;
	let g = graphs.get(key);
	if (g) return g;
	g = new ComputeGraph<undefined>(device, `${ID}-${key}`);
	const out = S / down;
	const input = g.importTexture(terrariumInputDescriptor(S, S));
	const heights = g.transientBuffer("heights", out * out * 4);
	const stats = g.transientBuffer("stats", TILE_STATS_WORDS * 4);
	addTerrariumTile(g, { id: "tile", input, heights, stats, size: S, down });
	g.readNode("read", [stats, heights]);
	g.compile();
	graphs.set(key, g);
	return g;
};

for (const tile of tiles)
	for (const down of [1, 2] as const) {
		const { S, rgba } = tile;
		const tex = uploadRaster(device, rgba, {
			width: S,
			height: S,
			bands: 4,
			id: "rgba",
			usage: BITMAP_TEXTURE_USAGE,
		});
		const g = buildGraph(S, down);
		let gpuRead: ArrayBuffer[] = [];
		const runs = 3;
		for (let r = 0; r < runs; r++) {
			const t0 = performance.now();
			const { reads } = await g.run(undefined, {
				textures: { rgba: tex.texture },
			});
			gpuRead = reads.read;
			if (r > 0) times.push(performance.now() - t0);
		}
		releaseResource(tex);
		const words = new Uint32Array(gpuRead[0]);
		const gpuHeights = new Float32Array(gpuRead[1]);
		const st = decodeTileStats(words);
		// CPU twin
		const h = decodeTerrarium(rgba);
		const filled = validateTile(
			Float32Array.from(h),
			S,
			Number.POSITIVE_INFINITY,
		).filled;
		const cpu = down === 2 ? downsampleHeights2(h, S) : h;
		const want = heightStats(cpu);
		cases++;
		const tag = `${tile.name}/down${down}`;
		if (st.invalid !== filled) {
			invalidMismatch++;
			fail(`${tag}: invalid ${st.invalid} vs ${filled}`);
		}
		const a = bits(gpuHeights);
		const b = bits(cpu);
		let diff = a.length !== b.length ? 1 : 0;
		for (let i = 0; i < a.length && !diff; i++) if (a[i] !== b[i]) diff++;
		if (diff) {
			heightMismatch++;
			fail(`${tag}: heights differ`);
		}
		for (const k of ["lo", "hi", "lo7", "hi7"] as const) {
			const v = st[k];
			if (!Number.isFinite(v)) nonFinite++;
			const e = Math.abs(v - want[k]);
			maxErr = Math.max(maxErr, e);
			sumErr += e;
			errCount++;
			// equal up to the sign of zero (!== treats -0 and +0 as equal)
			if (v !== want[k]) {
				extentMismatch++;
				fail(`${tag}: ${k} ${v} vs ${want[k]}`);
			}
		}
		for (const v of gpuHeights) if (!Number.isFinite(v)) nonFinite++;
		console.log(
			`  ${tag}: invalid ${st.invalid} (cpu ${filled}) lo ${st.lo} hi ${st.hi} lo7 ${st.lo7} hi7 ${st.hi7}`,
		);
	}
for (const g of graphs.values()) g.destroy();

times.sort((x, y) => x - y);
const median = times[Math.floor(times.length / 2)] ?? 0;
console.log(
	`summary: ${cases} tile x down cases; invalid mismatches ${invalidMismatch}, height mismatches ${heightMismatch}, extent mismatches ${extentMismatch}`,
);
console.log(
	`extent abs error: max ${maxErr}, mean ${(sumErr / Math.max(1, errCount)).toExponential(2)}; NaN/Inf ${nonFinite}`,
);
console.log(
	`warm GPU run (encode+submit+read) median ${median.toFixed(2)} ms over ${times.length} runs`,
);
if (nonFinite) fail(`${nonFinite} non-finite values`);
void gpu;
if (failures) {
	console.log(`FAIL ${ID}: ${failures} problem(s)`);
	process.exit(1);
}
console.log(`PASS ${ID}`);
process.exit(0);
