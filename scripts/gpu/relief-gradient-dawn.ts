// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The GPU relief field (src/lib/gpu/look/relief.ts reliefPassesGpu, a core ComputeGraph) on a real luma
// WebGPU device in node (Dawn), against the CPU twin (look/relief/field.ts reliefFromHeights, f64
// temporaries) on synthetic terrain with holes: per channel of the packed field (R shadow, G sky view,
// B curvature, A coverage) and gen (R, G normal x / y, B unused, A 255 where valid) the byte-diff
// histogram (count of |d| = 0, 1, 2, > 2), and the median wall time of reliefPassesGpu (several runs,
// same device, heights uploaded: the graph is warm). The generalised normal's gradient is luma's
// GPUFiniteDifference2D (one op per ring-radius phase plane, see relief-graph.ts), so bytes may differ
// by 1 where a value sits on a rounding edge; the gate is: no NaN-looking channel, A and the hole
// pattern identical, and at most 0.5 % of texels off by more than 2 in any channel.
//
//   (mkdir /tmp/dawn && cd /tmp/dawn && npm i webgpu@0.3.0)   # not an app dependency
//   DAWN_DIR=/tmp/dawn npx tsx scripts/gpu/relief-gradient-dawn.ts [reps]
//
// SKIP (exit 0) without DAWN_DIR or an adapter; exit 1 on a failed gate.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Buffer, type Device, Texture } from "@luma.gl/core";
import { attachWebGPUDevice } from "../../src/lib/gpu/core/luma";
import { COMPUTE_FEATURES } from "../../src/lib/gpu/device";
import { reliefPassesGpu, reliefWords } from "../../src/lib/gpu/look/relief";
import { reliefGraphToTextures } from "../../src/lib/gpu/look/relief-graph";
import type { Vec3 } from "../../src/lib/look/atmosphere";
import { reliefFromHeights } from "../../src/lib/look/relief/field";

const dir = process.env.DAWN_DIR;
if (!dir) {
	console.log("SKIP relief-gradient-dawn: DAWN_DIR not set");
	process.exit(0);
}
const REPS = Number(process.argv[2] ?? 9);
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
const adapter = await gpu.requestAdapter();
if (!adapter) {
	console.log("SKIP relief-gradient-dawn: no adapter");
	process.exit(0);
}
const device = (await attachWebGPUDevice(
	await adapter.requestDevice({
		requiredFeatures: COMPUTE_FEATURES.filter((f) => adapter.features.has(f)),
	}),
	{ id: "relief-gradient-dawn" },
	true,
)) as Device;
console.log(`adapter ${JSON.stringify(adapter.info ?? {})}`);

let failed = 0;
const fail = (message: string) => {
	failed++;
	console.log(`FAIL ${message}`);
};

const HOLE = -1e6;

/** Rolling terrain (sines + ridges + noise) with a rectangular void and a ragged void edge. */
function makeHeights(res: number) {
	let s = 12345;
	const random = () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 4294967296;
	};
	const H = new Float32Array(res * res);
	for (let j = 0; j < res; j++)
		for (let i = 0; i < res; i++) {
			const x = i / res;
			const y = j / res;
			let h =
				1200 +
				900 * Math.sin(7 * x + 2) * Math.cos(5 * y) +
				350 * Math.sin(23 * x + 3 * y) +
				90 * Math.sin(61 * x - 47 * y) +
				6 * random();
			if (x > 0.62 && x < 0.7 && y > 0.3 && y < 0.45) h = HOLE;
			if (x < 0.015 + 0.01 * random()) h = HOLE;
			H[j * res + i] = h;
		}
	return H;
}

const SUNS: [string, Vec3][] = [
	["xMajorLow", [0.9, 0.3, 0.2]],
	["yMajorNeg", [-0.2, -0.95, 0.25]],
	["belowHorizon", [0.7, 0.2, -0.3]],
];

type Histogram = [number, number, number, number];
function histogram(a: Uint8Array, b: Uint8Array, channel: number) {
	const h: Histogram = [0, 0, 0, 0];
	for (let q = channel; q < a.length; q += 4) {
		const d = Math.abs(a[q] - b[q]);
		h[Math.min(3, d)]++;
	}
	return h;
}

const median = (xs: number[]) => [...xs].sort((p, q) => p - q)[xs.length >> 1];

for (const res of [512, 1024, 2048]) {
	const px = 40000 / res;
	const ra = Math.max(1, Math.round(60 / px));
	const H = makeHeights(res);
	console.log(`\nres ${res} (px ${px.toFixed(2)} m, ring radius ra ${ra})`);
	for (const [name, sun] of res === 2048 ? SUNS.slice(0, 1) : SUNS) {
		const cpu = reliefFromHeights(H, res, px, sun);
		const gpuOut = await reliefPassesGpu(device, H, res, px, sun);
		const times: number[] = [];
		for (let i = 0; i < REPS; i++) {
			const t0 = performance.now();
			await reliefPassesGpu(device, H, res, px, sun);
			times.push(performance.now() - t0);
		}
		const names = ["R", "G", "B", "A"];
		let bad = 0;
		const parts: string[] = [];
		for (const [label, a, b] of [
			["field", cpu.field, gpuOut.field],
			["gen", cpu.gen, gpuOut.gen],
		] as const)
			for (let c = 0; c < 4; c++) {
				if (label === "gen" && c === 2) continue;
				const h = histogram(a, b, c);
				parts.push(`${label}.${names[c]} [${h.join(",")}]`);
				const n = res * res;
				if (h[3] > 0.005 * n) {
					bad++;
					fail(
						`${res} ${name} ${label}.${names[c]}: ${h[3]} texels off by > 2`,
					);
				}
				if (c === 3 && label === "field" && h[1] + h[2] + h[3] > 0)
					fail(`${res} ${name}: coverage differs`);
			}
		console.log(
			`  ${name.padEnd(12)} median ${median(times).toFixed(2)} ms; byte diffs |d|=0,1,2,>2: ${parts.join("  ")}${bad ? "  BAD" : ""}`,
		);
	}
}
// the texture variant (deck-webgpu compute-bridge): the same bytes land in two rgba8unorm textures
{
	const res = 1024;
	const px = 40000 / res;
	const H = makeHeights(res);
	const sun: Vec3 = [0.9, 0.3, 0.2];
	const bytes = await reliefPassesGpu(device, H, res, px, sun);
	const { words, degenerate } = reliefWords(res, px, sun);
	const make = (id: string) =>
		device.createTexture({
			id,
			format: "rgba8unorm",
			width: res,
			height: res,
			usage: Texture.COPY_DST | Texture.COPY_SRC | Texture.SAMPLE,
		});
	const out = { field: make("field"), gen: make("gen") };
	await reliefGraphToTextures(device, H, res, words, degenerate, out);
	for (const [label, texture, want] of [
		["field", out.field, bytes.field],
		["gen", out.gen, bytes.gen],
	] as const) {
		const buffer = device.createBuffer({
			usage: Buffer.COPY_DST | Buffer.MAP_READ,
			byteLength: res * res * 4,
		});
		texture.readBuffer({}, buffer);
		const got = new Uint8Array(await buffer.readAsync());
		let differ = 0;
		for (let q = 0; q < want.length; q++) if (got[q] !== want[q]) differ++;
		console.log(
			`\ntexture path ${label}: ${differ} of ${want.length} bytes differ from the read path`,
		);
		if (differ) fail(`texture path ${label}: ${differ} bytes differ`);
		buffer.destroy();
	}
}
console.log(
	failed
		? `\nFAIL relief-gradient-dawn: ${failed}`
		: "\nPASS relief-gradient-dawn",
);
process.exit(failed ? 1 : 0);
