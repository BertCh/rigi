#!/usr/bin/env node

// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { chromium } from "playwright";
import { GPU_ARGS } from "../deck-webgpu/gpu-args.mjs";
// GPU splat sort timing (src/lib/gpu/splat-sort, GpuSplatSorter): wall ms from sort() to
// queue.onSubmittedWorkDone() (encode + GPU), the encode-only CPU ms, and the CPU twins' ms in the
// same page for scale (cpu.ts radixOrderTiled, and the worker's counting sort sortSplatsByDepth).
// Synthetic clouds (random positions in front of the camera, 5 cm to 100 m), no near-field service.
// Per-kernel GPU ms: run it under with-gpu-profile.mjs (PROFILE_OUT=… node scripts/gpu/with-gpu-profile.mjs scripts/gpu/splat-sort-bench.mjs).
// Always under the render lock:
//   node scripts/gpu/with-render-lock.mjs -- node scripts/gpu/splat-sort-bench.mjs [--url http://localhost:3100]
//     [--sizes 100000,500000,1000000,2000000] [--reps 15] [--out out/baseline/splat-sort-bench.json]
import { APP_URL } from "../lib/harness.mjs";

const arg = (k, d) => {
	const i = process.argv.indexOf(`--${k}`);
	return i > 0 ? process.argv[i + 1] : d;
};
const BASE = arg("url", APP_URL);
const SIZES = arg("sizes", "100000,500000,1000000,2000000")
	.split(",")
	.map(Number);
const REPS = Number(arg("reps", "15"));
const OUT = arg("out", "out/baseline/splat-sort-bench.json");
// FINDING (8351c5a): SCAN_TOTALS_WGSL never reads the params uniform \`p\`, so the auto-derived
// bind group layout has no binding 0 while the kernel spec binds [p, base]: Chromium rejects the bind
// group ("binding index 0 not present in the bind group layout") and GpuSplatSorter.sort() fails.
// In the app that is the fallback to the worker sort. To time the other kernels anyway this probe
// serves the shader module with \`_ = p;\` added to scan-totals (a route; the repo file is untouched).
// --unpatched serves it as is (expect the error).
const PATCH = !process.argv.includes("--unpatched");

const browser = await chromium.launch({ headless: true, args: GPU_ARGS });
const ctx = await browser.newContext();
await ctx.routeWebSocket(
	(u) => u.origin === new URL(BASE).origin.replace(/^http/, "ws"),
	() => {},
);
if (PATCH)
	await ctx.route(/splat-sort\.wgsl\.ts/, async (route) => {
		const resp = await route.fetch();
		const body = (await resp.text()).replace(
			/(SCAN_TOTALS_WGSL[\s\S]*?)(let s0 = base\[2u \* t\];)/,
			"$1_ = p;\n  $2",
		);
		await route.fulfill({ response: resp, body });
	});
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("pageerror", e.message));
page.on("console", (m) => {
	if (m.type() === "error" || m.type() === "warning")
		console.log(`[page ${m.type()}]`, m.text().slice(0, 600));
});
await page.goto(`${BASE}/photos/IMG_7086.jpg${arg("query", "")}`);
const result = await page.evaluate(
	async ({ sizes, reps }) => {
		const dev = await import("/src/lib/gpu/device.ts");
		const { GpuSplatSorter, gpuSplatSortSupported } = await import(
			"/src/lib/gpu/splat-sort/index.ts"
		);
		const cpu = await import("/src/lib/gpu/splat-sort/cpu.ts");
		const device = await dev.getComputeDevice();
		if (!device) return { error: "no compute device" };
		if (!gpuSplatSortSupported(device)) return { error: "sort unsupported" };
		let worker = null;
		try {
			worker = await import("/src/lib/nearfield/splat-sort.worker.ts");
		} catch (e) {
			worker = { error: String(e) };
		}
		const q = device.handle.queue;
		const med = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
		const p90 = (xs) =>
			[...xs].sort((a, b) => a - b)[
				Math.min(xs.length - 1, Math.floor(xs.length * 0.9))
			];
		const out = { sizes: [], adapter: device.info ?? null };
		let seed = 1;
		const rnd = () => {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			return seed / 4294967296;
		};
		for (const n of sizes) {
			const pos = new Float32Array(n * 3);
			for (let i = 0; i < n; i++) {
				pos[3 * i] = (rnd() - 0.5) * 60;
				pos[3 * i + 1] = (rnd() - 0.5) * 30;
				pos[3 * i + 2] = -(0.05 + rnd() * 100);
			}
			const words = new Uint32Array(n * 12);
			for (let i = 0; i < n; i++) {
				words[12 * i] = new Uint32Array(pos.buffer, 12 * i, 1)[0];
				words[12 * i + 1] = new Uint32Array(pos.buffer, 12 * i + 4, 1)[0];
				words[12 * i + 2] = new Uint32Array(pos.buffer, 12 * i + 8, 1)[0];
			}
			const data = device.createBuffer({
				id: "bench-splats",
				byteLength: n * 48,
				usage: 0x0080 | 0x0008,
				data: words,
			});
			const ident = new Uint32Array(n);
			for (let i = 0; i < n; i++) ident[i] = i;
			const order = device.createBuffer({
				id: "bench-order",
				byteLength: n * 4,
				usage: 0x0080 | 0x0008 | 0x0004,
				data: ident,
			});
			const t0 = performance.now();
			const sorter = new GpuSplatSorter(device, data, order, n);
			await sorter.ready;
			const compileMs = performance.now() - t0;
			const row = [0, 0, 1, 0];
			const wall = [];
			const encode = [];
			// first run pays validation scopes; report it separately
			for (let r = 0; r < reps + 3; r++) {
				const a = performance.now();
				const v = sorter.sort(row);
				encode.push(sorter.stats.lastEncodeMs);
				await q.onSubmittedWorkDone();
				wall.push(performance.now() - a);
				await v;
			}
			const first = wall.shift();
			encode.shift();
			wall.splice(0, 2);
			encode.splice(0, 2);
			// readback once to prove the order is a permutation (not timed)
			const bytes = await order.readAsync();
			const got = new Uint32Array(bytes.buffer, bytes.byteOffset, n);
			const seen = new Uint8Array(n);
			let perm = true;
			for (let i = 0; i < n; i++) {
				if (got[i] >= n || seen[got[i]]) perm = false;
				else seen[got[i]] = 1;
			}
			const cpuMs = [];
			const keys = cpu.splatKeysF32 ? cpu.splatKeysF32(pos, n, row) : null;
			const k = keys?.keys;
			if (k?.length) {
				for (let r = 0; r < 3; r++) {
					const a = performance.now();
					cpu.radixOrderTiled(k, n);
					cpuMs.push(performance.now() - a);
				}
			}
			const workerMs = [];
			if (worker?.sortSplatsByDepth) {
				const outIdx = new Uint32Array(n);
				const scratch = worker.newSortScratch(n);
				for (let r = 0; r < 3; r++) {
					const a = performance.now();
					worker.sortSplatsByDepth(pos, n, row, outIdx, scratch);
					workerMs.push(performance.now() - a);
				}
			}
			out.sizes.push({
				n,
				compileMs,
				firstSortWallMs: first,
				wallMedian: med(wall),
				wallP90: p90(wall),
				wallMin: Math.min(...wall),
				encodeMedian: med(encode),
				reps: wall.length,
				permutation: perm,
				cpuRadixMs: cpuMs.length ? med(cpuMs) : null,
				workerCountingSortMs: workerMs.length ? med(workerMs) : null,
				vramBytes: n * 4 * 5 + n * 48 + 512 * 4 * (Math.ceil(n / 256) + 2),
			});
			sorter.destroy();
			data.destroy();
			order.destroy();
		}
		return out;
	},
	{ sizes: SIZES, reps: REPS },
);
await browser.close();
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
	OUT,
	JSON.stringify({ url: BASE, scanTotalsPatched: PATCH, ...result }, null, 1),
);
if (result.error) {
	console.error("splat-sort-bench:", result.error);
	process.exit(1);
}
for (const s of result.sizes)
	console.log(
		`n=${s.n} wall median ${s.wallMedian.toFixed(2)} p90 ${s.wallP90.toFixed(2)} min ${s.wallMin.toFixed(2)} ms (encode ${s.encodeMedian.toFixed(2)}), first ${s.firstSortWallMs.toFixed(1)}, compile ${s.compileMs.toFixed(0)}, perm=${s.permutation}, cpu radix ${s.cpuRadixMs?.toFixed(1)} worker ${s.workerCountingSortMs?.toFixed(1)}`,
	);
console.log(`wrote ${OUT}`);
