// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// LF5 bench: luma gpgpu GPUSort (radix / bitonic) against our splat radix sort
// (src/lib/gpu/splat-sort), on a native WebGPU implementation in node (Dawn, `webgpu` npm package).
// Same pattern as sky-prep-dawn.ts:
//   (mkdir /tmp/dawn && cd /tmp/dawn && npm i webgpu@0.3.0)
//   DAWN_DIR=/tmp/dawn npx tsx scripts/gpu/splat-sort-gpgpu-dawn.ts [--sizes 100000,500000] [--reps 21]
// Wall ms = submit to queue.onSubmittedWorkDone(), median of reps (Dawn on the host GPU; absolute
// numbers differ from Chrome). Order identity: GPUSort's payload is compared with the CPU twin of our
// sort (cpu.ts radixOrderTiled) on the keys of splatKeysF32, element for element.
// Exit 1 on an order mismatch, 2 when no adapter/package is available.
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Device, Buffer as LumaBuffer } from "@luma.gl/core";
import { ComputeGraph } from "../../src/lib/gpu/core/graph";
import { attachWebGPUDevice, GPUSort } from "../../src/lib/gpu/core/luma";
import { getGpuProfile, resetGpuProfile } from "../../src/lib/gpu/core/profile";
import {
	radixOrderTiled,
	splatKeysF32,
} from "../../src/lib/gpu/splat-sort/cpu";
import { GpuSplatSorter } from "../../src/lib/gpu/splat-sort/index";

const argv = process.argv.slice(2);
const arg = (k: string, d: string) => {
	const i = argv.indexOf(`--${k}`);
	return i >= 0 ? argv[i + 1] : d;
};
const SIZES = arg("sizes", "100000,500000,1000000,2000000")
	.split(",")
	.map(Number);
const REPS = Number(arg("reps", "21"));
const dir = process.env.DAWN_DIR;
if (!dir) {
	console.error("set DAWN_DIR to a directory with `npm i webgpu@0.3.0`");
	process.exit(2);
}
const { create, globals } = await import(
	pathToFileURL(path.join(dir, "node_modules/webgpu/index.js")).href
);
Object.assign(globalThis, globals);
const gpu = create([]);
Object.defineProperty(globalThis, "navigator", {
	value: { gpu, userAgent: "node" },
	configurable: true,
});
const adapter = await gpu.requestAdapter();
if (!adapter) process.exit(2);
const limits: Record<string, number> = {};
for (const k of [
	"maxStorageBuffersPerShaderStage",
	"maxBufferSize",
	"maxStorageBufferBindingSize",
])
	limits[k] = adapter.limits[k];
const features = ["timestamp-query", "subgroups"].filter((f) =>
	adapter.features.has(f),
);
const handle: GPUDevice = await adapter.requestDevice({
	requiredFeatures: features,
	requiredLimits: limits,
});
console.log(
	"adapter:",
	JSON.stringify(adapter.info ?? {}),
	"features:",
	features.join(","),
);
const device: Device = await attachWebGPUDevice(handle, { id: "bench" }, true);
const q = handle.queue;
const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
const STORAGE = 0x80 | 0x08 | 0x04;

let seed = 1;
const rnd = () => {
	seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
	return seed / 4294967296;
};
let mismatches = 0;
for (const n of SIZES) {
	const pos = new Float32Array(n * 3);
	for (let i = 0; i < n; i++) {
		pos[3 * i] = (rnd() - 0.5) * 60;
		pos[3 * i + 1] = (rnd() - 0.5) * 30;
		pos[3 * i + 2] = -(0.05 + rnd() * 100);
	}
	const words = new Uint32Array(n * 12);
	const posBits = new Uint32Array(pos.buffer);
	for (let i = 0; i < n; i++)
		words.set(posBits.subarray(3 * i, 3 * i + 3), 12 * i);
	const data = device.createBuffer({
		byteLength: n * 48,
		usage: 0x80 | 0x08,
		data: words,
	});
	const ident = new Uint32Array(n);
	for (let i = 0; i < n; i++) ident[i] = i;
	const order = device.createBuffer({
		byteLength: n * 4,
		usage: STORAGE,
		data: ident,
	});
	const ref = splatKeysF32(pos, n, [0, 0, 1, 0]);
	const want = radixOrderTiled(ref.keys, n);
	const row = [0, 0, 1, 0] as const;
	const flags = globalThis as unknown as {
		__RIGI_FLAGS__?: Record<string, string>;
	};
	const sorted: Record<
		string,
		{ wall: number; radix: number; pre: number; same: boolean }
	> = {};
	let oursSame = true;
	for (const mode of ["off", "on"]) {
		flags.__RIGI_FLAGS__ = { splatSortGpgpu: mode };
		const sorter = new GpuSplatSorter(device, data, order, n);
		await sorter.ready;
		const wall: number[] = [];
		for (let r = 0; r < REPS + 3; r++) {
			const a = performance.now();
			await sorter.sort(row);
			await q.onSubmittedWorkDone();
			wall.push(performance.now() - a);
		}
		wall.splice(0, 3);
		const prof0 = globalThis as { __RIGI_GPU_PROFILE__?: boolean };
		prof0.__RIGI_GPU_PROFILE__ = true;
		resetGpuProfile();
		const PR = 11;
		for (let r = 0; r < PR; r++) {
			await sorter.sort(row);
			await q.onSubmittedWorkDone();
		}
		await new Promise((r) => setTimeout(r, 200));
		const prof = await getGpuProfile();
		prof0.__RIGI_GPU_PROFILE__ = false;
		let radix = 0;
		let pre = 0;
		for (const [k, v] of Object.entries(prof)) {
			if (!k.startsWith("splat-sort")) continue;
			const per = v.gpuMs / v.count;
			if (/\/(depth|keys)$/.test(k)) pre += per;
			else if (/\/(tile|scan|scatter|sort)/.test(k)) radix += per;
		}
		const got = new Uint32Array((await order.readAsync()).slice().buffer);
		const same = got.every((v, i) => v === want[i]);
		oursSame &&= same;
		sorted[mode] = { wall: med(wall), radix, pre, same };
		sorter.destroy();
	}
	const res: Record<string, { ms: number; gpu: number; same: boolean }> = {};
	for (const algorithm of ["radix", "bitonic"] as const) {
		if (algorithm === "bitonic" && n > 1 << 20) continue;
		const keysBuf = device.createBuffer({
			byteLength: n * 4,
			usage: STORAGE,
			data: ref.keys,
		});
		const valBuf = device.createBuffer({
			byteLength: n * 4,
			usage: STORAGE,
			data: ident,
		});
		const g = new ComputeGraph(device, `lf5-${algorithm}-${n}`);
		const hk = g.importBuffer("keys", n * 4);
		const hv = g.importBuffer("vals", n * 4);
		const ok = g.importBuffer("outKeys", n * 4);
		const ov = g.importBuffer("outVals", n * 4);
		g.add(
			new GPUSort({
				id: "sort",
				keys: g.view(hk, "uint32", n),
				values: g.view(hv, "uint32", n),
				outputKeys: g.view(ok, "uint32", n),
				outputValues: g.view(ov, "uint32", n),
				algorithm,
				keyBits: 17,
			}),
		);
		g.compile();
		const outK = device.createBuffer({ byteLength: n * 4, usage: STORAGE });
		const outV = device.createBuffer({ byteLength: n * 4, usage: STORAGE });
		const buffers = {
			keys: keysBuf,
			vals: valBuf,
			outKeys: outK,
			outVals: outV,
		};
		const ms: number[] = [];
		for (let r = 0; r < REPS + 3; r++) {
			const a = performance.now();
			const p = g.run(undefined as never, { buffers });
			await p;
			await q.onSubmittedWorkDone();
			ms.push(performance.now() - a);
		}
		ms.splice(0, 3);
		const gms: number[] = [];
		for (let r = 0; r < 7; r++) {
			const rr = await g.run(undefined as never, { buffers, timings: true });
			let t = 0;
			for (const nd of rr.timings?.nodes ?? [])
				t += nd.gpuTimeMilliseconds ?? 0;
			gms.push(t);
		}
		const got = new Uint32Array((await outV.readAsync()).slice().buffer);
		res[algorithm] = {
			ms: med(ms),
			gpu: med(gms),
			same: got.every((v, i) => v === want[i]),
		};
		for (const b of [keysBuf, valBuf, outK, outV] as LumaBuffer[]) b.destroy();
		g.destroy();
	}
	if (!oursSame || Object.values(res).some((r) => !r.same)) mismatches++;
	console.log(
		`n=${n} in-house sorter: wall ${sorted.off.wall.toFixed(2)} ms, GPU radix ${sorted.off.radix.toFixed(3)} + depth/keys ${sorted.off.pre.toFixed(3)} ms | splatSortGpgpu=on sorter: wall ${sorted.on.wall.toFixed(2)} ms, GPU sort ${sorted.on.radix.toFixed(3)} + depth/keys ${sorted.on.pre.toFixed(3)} ms | same order off=${sorted.off.same} on=${sorted.on.same}`,
		Object.entries(res)
			.map(
				([k, v]) =>
					`| GPUSort ${k} (sort only) wall ${v.ms.toFixed(2)} ms gpu ${v.gpu.toFixed(3)} ms same=${v.same}`,
			)
			.join(" "),
	);
	data.destroy();
	order.destroy();
}
process.exit(mismatches ? 1 : 0);
